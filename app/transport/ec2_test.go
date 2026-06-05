package transport

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDialEC2_Validation(t *testing.T) {
	if _, err := DialEC2(EC2DialConfig{User: "ec2-user"}); err == nil {
		t.Error("DialEC2 without an instance id should error")
	}
	if _, err := DialEC2(EC2DialConfig{InstanceID: "i-123"}); err == nil {
		t.Error("DialEC2 without an ssh user should error")
	}
}

func TestDescribeInstance_Validation(t *testing.T) {
	if _, err := DescribeInstance("", "us-east-1", ""); err == nil {
		t.Error("DescribeInstance without an instance id should error")
	}
}

func TestDialSSHWithPemFile_BadPaths(t *testing.T) {
	// Missing pem file.
	cfg := SSHDialConfig{Host: "127.0.0.1", User: "u"}
	if _, err := dialSSHWithPemFile(cfg, filepath.Join(t.TempDir(), "missing.pem")); err == nil {
		t.Error("dialSSHWithPemFile on a missing pem should error")
	}
	// Garbage pem contents.
	bad := filepath.Join(t.TempDir(), "bad.pem")
	if err := os.WriteFile(bad, []byte("not a key"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := dialSSHWithPemFile(cfg, bad); err == nil {
		t.Error("dialSSHWithPemFile on garbage should error")
	}
}
