// AWS EC2 transport — looks up the public DNS / IP of an EC2 instance
// via the AWS SDK, then dials SSH to it using the existing DialSSH
// path. PEM-only auth is supported via the PemFile field; if empty,
// falls back to the standard ssh-agent / ~/.ssh chain.
package transport

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"golang.org/x/crypto/ssh"
)

// EC2DialConfig points at one instance.
type EC2DialConfig struct {
	InstanceID string
	Region     string // empty → AWS_REGION env
	User       string // SSH user — ec2-user / ubuntu / etc.
	PemFile    string // optional path to a private key
	Port       int    // 0 → 22
	Timeout    time.Duration
	Prompter   AuthPrompter

	// Profile selects a named section in the AWS shared config files for
	// the EC2 API call (DescribeInstances). Empty uses the SDK default
	// chain.
	Profile string

	// SavedPassword is forwarded to SSHDialConfig for the SSH dial that
	// follows DescribeInstances.
	SavedPassword string
	// HostKeyChanged is forwarded to the SSH dial (same semantics as
	// SSHDialConfig.HostKeyChanged).
	HostKeyChanged HostKeyPrompter
}

// DialEC2 resolves the instance's public DNS via the EC2 API and dials
// SSH to it. Returns the SSH client.
func DialEC2(cfg EC2DialConfig) (*ssh.Client, error) {
	if cfg.InstanceID == "" {
		return nil, errors.New("transport: ec2 instance id required")
	}
	if cfg.User == "" {
		return nil, errors.New("transport: ec2 ssh user required")
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 15 * time.Second
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.Timeout)
	defer cancel()
	awsCfg, err := loadAWSConfig(ctx, cfg.Region, cfg.Profile)
	if err != nil {
		return nil, fmt.Errorf("transport: aws config: %w", err)
	}
	cl := ec2.NewFromConfig(awsCfg)
	out, err := cl.DescribeInstances(ctx, &ec2.DescribeInstancesInput{
		InstanceIds: []string{cfg.InstanceID},
	})
	if err != nil {
		return nil, fmt.Errorf("transport: describe %s: %w", cfg.InstanceID, err)
	}
	if len(out.Reservations) == 0 || len(out.Reservations[0].Instances) == 0 {
		return nil, fmt.Errorf("transport: instance %s not found", cfg.InstanceID)
	}
	inst := out.Reservations[0].Instances[0]

	host := ""
	if inst.PublicDnsName != nil && *inst.PublicDnsName != "" {
		host = *inst.PublicDnsName
	} else if inst.PublicIpAddress != nil && *inst.PublicIpAddress != "" {
		host = *inst.PublicIpAddress
	} else if inst.PrivateIpAddress != nil && *inst.PrivateIpAddress != "" {
		host = *inst.PrivateIpAddress
	}
	if host == "" {
		return nil, fmt.Errorf("transport: instance %s has no reachable address", cfg.InstanceID)
	}

	dial := SSHDialConfig{
		Host:           host,
		User:           cfg.User,
		Port:           cfg.Port,
		Timeout:        cfg.Timeout,
		Prompter:       cfg.Prompter,
		SavedPassword:  cfg.SavedPassword,
		HostKeyChanged: cfg.HostKeyChanged,
	}
	if cfg.PemFile != "" {
		// Inject the PEM key into the auth chain. DialSSH already pulls
		// ~/.ssh keys, but an EC2 user typically has a one-off .pem
		// from the instance launch; honor that path explicitly.
		return dialSSHWithPemFile(dial, cfg.PemFile)
	}
	return DialSSH(dial)
}

// DescribeInstance returns the resolved address + extra fields useful
// for the frontend (so the New Session modal can preview before save).
type EC2InstanceInfo struct {
	InstanceID   string `json:"instanceId"`
	Name         string `json:"name"` // value of the "Name" tag, if any
	State        string `json:"state"`
	PublicDNS    string `json:"publicDns"`
	PublicIP     string `json:"publicIp"`
	PrivateIP    string `json:"privateIp"`
	InstanceType string `json:"instanceType"`
	Region       string `json:"region"`
}

// DescribeInstance fetches one instance's basic info. Used by the
// frontend to populate read-only fields on the New Session modal.
func DescribeInstance(instanceID, region, profile string) (EC2InstanceInfo, error) {
	if instanceID == "" {
		return EC2InstanceInfo{}, errors.New("transport: instance id required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	awsCfg, err := loadAWSConfig(ctx, region, profile)
	if err != nil {
		return EC2InstanceInfo{}, fmt.Errorf("transport: aws config: %w", err)
	}
	region = effectiveRegion(awsCfg, region)
	cl := ec2.NewFromConfig(awsCfg)
	out, err := cl.DescribeInstances(ctx, &ec2.DescribeInstancesInput{
		InstanceIds: []string{instanceID},
	})
	if err != nil {
		return EC2InstanceInfo{}, err
	}
	if len(out.Reservations) == 0 || len(out.Reservations[0].Instances) == 0 {
		return EC2InstanceInfo{}, fmt.Errorf("instance %s not found", instanceID)
	}
	i := out.Reservations[0].Instances[0]
	info := EC2InstanceInfo{
		InstanceID: instanceID,
		Region:     region,
	}
	for _, t := range i.Tags {
		if t.Key != nil && *t.Key == "Name" && t.Value != nil {
			info.Name = *t.Value
			break
		}
	}
	if i.State != nil {
		info.State = string(i.State.Name)
	}
	if i.InstanceType != "" {
		info.InstanceType = string(i.InstanceType)
	}
	if i.PublicDnsName != nil {
		info.PublicDNS = *i.PublicDnsName
	}
	if i.PublicIpAddress != nil {
		info.PublicIP = *i.PublicIpAddress
	}
	if i.PrivateIpAddress != nil {
		info.PrivateIP = *i.PrivateIpAddress
	}
	return info, nil
}

// ListInstances returns instances in a region. Used to populate the
// instance picker in the New Session modal. Limited to first 100
// instances (typical use case is a small admin fleet; pagination can
// land if a user has a real complaint).
func ListInstances(region, profile string) ([]EC2InstanceInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	awsCfg, err := loadAWSConfig(ctx, region, profile)
	if err != nil {
		return nil, fmt.Errorf("transport: aws config: %w", err)
	}
	region = effectiveRegion(awsCfg, region)
	cl := ec2.NewFromConfig(awsCfg)
	out, err := cl.DescribeInstances(ctx, &ec2.DescribeInstancesInput{
		MaxResults: aws.Int32(100),
	})
	if err != nil {
		return nil, err
	}
	var result []EC2InstanceInfo
	for _, r := range out.Reservations {
		for _, i := range r.Instances {
			info := EC2InstanceInfo{Region: region}
			if i.InstanceId != nil {
				info.InstanceID = *i.InstanceId
			}
			for _, t := range i.Tags {
				if t.Key != nil && *t.Key == "Name" && t.Value != nil {
					info.Name = *t.Value
					break
				}
			}
			if i.State != nil {
				info.State = string(i.State.Name)
			}
			if i.InstanceType != "" {
				info.InstanceType = string(i.InstanceType)
			}
			if i.PublicDnsName != nil {
				info.PublicDNS = *i.PublicDnsName
			}
			if i.PublicIpAddress != nil {
				info.PublicIP = *i.PublicIpAddress
			}
			if i.PrivateIpAddress != nil {
				info.PrivateIP = *i.PrivateIpAddress
			}
			result = append(result, info)
		}
	}
	return result, nil
}

// dialSSHWithPemFile wires a one-off PEM auth method in front of the
// standard chain. The PEM file is read once at dial time; passphrase
// keys are not supported here.
func dialSSHWithPemFile(cfg SSHDialConfig, pemFile string) (*ssh.Client, error) {
	pemFile = expandPath(pemFile)
	b, err := os.ReadFile(pemFile)
	if err != nil {
		return nil, fmt.Errorf("transport: read pem %s: %w", pemFile, err)
	}
	signer, err := ssh.ParsePrivateKey(b)
	if err != nil {
		return nil, fmt.Errorf("transport: parse pem %s: %w", pemFile, err)
	}
	// We can't easily inject into DialSSH's collectAuthMethods without
	// refactoring; instead we replicate the connection here. Acceptable
	// duplication — EC2 dialing diverges in only this one detail.
	auths := []ssh.AuthMethod{ssh.PublicKeys(signer)}
	if cfg.SavedPassword != "" {
		auths = append(auths, ssh.Password(cfg.SavedPassword))
	}
	if cfg.Prompter != nil {
		auths = append(auths,
			ssh.PasswordCallback(func() (string, error) {
				return cfg.Prompter("Password: ", false)
			}),
		)
	}
	cb, err := tofuHostKeyCallback(cfg.HostKeyChanged)
	if err != nil {
		return nil, err
	}
	if cfg.Port == 0 {
		cfg.Port = 22
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 10 * time.Second
	}
	clientCfg := &ssh.ClientConfig{
		User:            cfg.User,
		Auth:            auths,
		HostKeyCallback: cb,
		Timeout:         cfg.Timeout,
	}
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	return ssh.Dial("tcp", addr, clientCfg)
}
