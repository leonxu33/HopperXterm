// AWS shared-config helpers: discover the named profiles defined in the
// user's ~/.aws/credentials and ~/.aws/config, and build the SDK load
// options that select one. Credentials themselves are never read or
// stored by HopperXterm — the SDK resolves them from these files (or the
// default chain) at dial time.
package transport

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
)

// loadAWSConfig loads the SDK config for a region + named profile and
// guarantees a usable region. Precedence: an explicit region wins, else the
// selected profile's own configured region, else AWS_REGION, else us-east-1.
//
// The floor must be applied *after* the load, not in awsConfigOpts: when a
// profile is selected with no explicit region we deliberately omit WithRegion
// so the profile's own region can resolve — but a profile that declares no
// region then leaves cfg.Region empty, and every region-required call (S3,
// EC2) fails with a missing-region error. This backfills that case without
// overriding a profile that does set a region.
func loadAWSConfig(ctx context.Context, region, profile string) (aws.Config, error) {
	cfg, err := config.LoadDefaultConfig(ctx, awsConfigOpts(region, profile)...)
	if err != nil {
		return cfg, err
	}
	if cfg.Region == "" {
		if r := os.Getenv("AWS_REGION"); r != "" {
			cfg.Region = r
		} else {
			cfg.Region = "us-east-1"
		}
	}
	return cfg, nil
}

// awsConfigOpts builds the LoadDefaultConfig options for a region +
// named profile. An explicit region wins; when region is empty and a
// profile is set, the region is left to the profile's own config (or the
// SDK default chain). When neither is set, AWS_REGION / us-east-1 is the
// floor so region-required services (S3, EC2) still have one.
func awsConfigOpts(region, profile string) []func(*config.LoadOptions) error {
	if region == "" && profile == "" {
		region = os.Getenv("AWS_REGION")
		if region == "" {
			region = "us-east-1"
		}
	}
	var opts []func(*config.LoadOptions) error
	if region != "" {
		opts = append(opts, config.WithRegion(region))
	}
	if profile != "" {
		opts = append(opts, config.WithSharedConfigProfile(profile))
	}
	return opts
}

// effectiveRegion resolves what region a loaded config ended up using,
// preferring the SDK's resolved value (which may come from the profile)
// and falling back to the requested region.
func effectiveRegion(cfg aws.Config, requested string) string {
	if cfg.Region != "" {
		return cfg.Region
	}
	return requested
}

// ListAWSProfiles returns the distinct profile names declared in the
// user's AWS shared credentials and config files, sorted with "default"
// first (if present) then alphabetically. Missing files are not an
// error — they just contribute no names. The frontend offers these as a
// dropdown; a user may still type a profile that isn't listed.
func ListAWSProfiles() []string {
	seen := map[string]bool{}

	// ~/.aws/credentials — sections are bare profile names: [work].
	for _, name := range parseINISections(sharedCredentialsPath(), "") {
		seen[name] = true
	}
	// ~/.aws/config — non-default sections are prefixed: [profile work];
	// the default profile is just [default].
	for _, name := range parseINISections(sharedConfigPath(), "profile ") {
		seen[name] = true
	}

	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i] == "default" {
			return true
		}
		if out[j] == "default" {
			return false
		}
		return out[i] < out[j]
	})
	return out
}

func sharedCredentialsPath() string {
	if p := os.Getenv("AWS_SHARED_CREDENTIALS_FILE"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".aws", "credentials")
}

func sharedConfigPath() string {
	if p := os.Getenv("AWS_CONFIG_FILE"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".aws", "config")
}

// parseINISections returns the section names from an INI file. Names
// that begin with stripPrefix have it removed ("profile work" → "work")
// so config-file and credentials-file naming align. Lines that are
// blank, comments (# or ;), or not section headers are ignored.
func parseINISections(path, stripPrefix string) []string {
	if path == "" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	var names []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if len(line) < 2 || line[0] != '[' || line[len(line)-1] != ']' {
			continue
		}
		name := strings.TrimSpace(line[1 : len(line)-1])
		if stripPrefix != "" && strings.HasPrefix(name, stripPrefix) {
			name = strings.TrimSpace(strings.TrimPrefix(name, stripPrefix))
		}
		if name != "" {
			names = append(names, name)
		}
	}
	return names
}
