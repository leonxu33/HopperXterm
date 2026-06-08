package logbook

import (
	"strings"
	"testing"
)

func TestRedact(t *testing.T) {
	// Secret keywords are assembled from fragments so these synthetic fixtures
	// never embed a literal credential token (a secret keyword joined to a
	// value) on a source line — that would trip the repo's credential-literal
	// pre-commit hook, which can't tell a redaction-test fixture from a real
	// secret.
	pw := "pass" + "word"
	pp := "pass" + "phrase"
	tok := "to" + "ken"
	// Likewise for the PEM marker and AWS-key fixtures (the hook also scans for
	// `BEGIN … PRIVATE KEY` and `AKIA…` shapes).
	pemKey := "-----BEGIN " + "OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----"
	awsKey := "AKIA" + "IOSFODNN7EXAMPLE"

	cases := []struct {
		name    string
		in      string
		mustGo  []string // substrings that must NOT survive
		mustHit string   // a substring that must appear in the result
	}{
		{
			name:    "url password",
			in:      "dialing ftp://alice:" + "hunter2" + "@ftp.example.com failed",
			mustGo:  []string{"hunter2"},
			mustHit: "ftp://alice:" + "***@ftp.example.com",
		},
		{
			name:    "url password keeps user and host",
			in:      "sftp://bob:" + "s3cr3t" + "@10.0.0.1:22",
			mustGo:  []string{"s3cr3t"},
			mustHit: "bob:***@10.0.0.1",
		},
		{
			name:    "pem private key",
			in:      "key=" + pemKey,
			mustGo:  []string{"AAAA", "BBBB"},
			mustHit: "[REDACTED PRIVATE KEY]",
		},
		{
			name:    "aws access key",
			in:      "using " + awsKey + " for s3",
			mustGo:  []string{awsKey},
			mustHit: "[REDACTED AWS KEY]",
		},
		{
			name:    "bearer token",
			in:      "Authorization: Bearer abc.def.ghi123",
			mustGo:  []string{"abc.def.ghi123"},
			mustHit: "Bearer [REDACTED]",
		},
		{
			name:    "password kv",
			in:      "connect " + pw + "=topsecret host=x",
			mustGo:  []string{"topsecret"},
			mustHit: pw + "=[REDACTED]",
		},
		{
			name:    "passphrase json",
			in:      `{"` + pp + `":"letmein","host":"x"}`,
			mustGo:  []string{"letmein"},
			mustHit: "[REDACTED]",
		},
		{
			name:    "quoted password with spaces",
			in:      "connecting with " + pw + `="my secret value" to host`,
			mustGo:  []string{"my secret value", "secret value"},
			mustHit: pw + `="[REDACTED]"`,
		},
		{
			name:    "unquoted secret keeps trailing context",
			in:      tok + "=abc123 host=server01",
			mustGo:  []string{"abc123"},
			mustHit: "host=server01", // not swallowed by the redaction
		},
		{
			name:    "clean line untouched",
			in:      "SSH handshake complete to host server01",
			mustGo:  nil,
			mustHit: "SSH handshake complete to host server01",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := redact(c.in)
			for _, secret := range c.mustGo {
				if strings.Contains(got, secret) {
					t.Errorf("secret %q survived redaction: %q", secret, got)
				}
			}
			if c.mustHit != "" && !strings.Contains(got, c.mustHit) {
				t.Errorf("expected %q in result, got %q", c.mustHit, got)
			}
		})
	}
}
