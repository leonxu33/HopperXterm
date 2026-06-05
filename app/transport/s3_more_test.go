package transport

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDialS3_BucketRequired(t *testing.T) {
	if _, err := DialS3(S3DialConfig{}); err == nil {
		t.Error("DialS3 without a bucket should error")
	}
}

func TestDialS3_RegionDefaulting(t *testing.T) {
	t.Setenv("AWS_REGION", "")
	s, err := DialS3(S3DialConfig{Bucket: "b"})
	if err != nil {
		t.Fatalf("DialS3: %v", err)
	}
	if s.Region != "us-east-1" {
		t.Errorf("default region = %q, want us-east-1", s.Region)
	}
	if cwd, _ := s.Cwd(); cwd != "/" {
		t.Errorf("S3 Cwd = %q, want /", cwd)
	}
	if err := s.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
}

func TestDialS3_ExplicitRegionAndProfile(t *testing.T) {
	// Point the SDK at a temp credentials file holding one named profile,
	// then dial with it. Credentials are resolved lazily on first API
	// call, so the dial succeeds and the explicit region wins.
	credFile := filepath.Join(t.TempDir(), "credentials")
	if err := os.WriteFile(credFile, []byte(
		"[test]\naws_access_key_id = AKIA\naws_secret_access_key = secret\n"), 0o600); err != nil {
		t.Fatalf("write creds: %v", err)
	}
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", credFile)

	s, err := DialS3(S3DialConfig{
		Bucket:  "b",
		Region:  "eu-west-1",
		Profile: "test",
	})
	if err != nil {
		t.Fatalf("DialS3: %v", err)
	}
	if s.Region != "eu-west-1" {
		t.Errorf("region = %q, want eu-west-1", s.Region)
	}
}

func TestS3_NotConnectedGuards(t *testing.T) {
	s := &S3{} // client == nil
	if _, err := s.List("p"); err == nil {
		t.Error("List")
	}
	if err := s.Mkdir("p", false); err == nil {
		t.Error("Mkdir")
	}
	if err := s.Remove("p"); err == nil {
		t.Error("Remove")
	}
	if err := s.RemoveAll("p"); err == nil {
		t.Error("RemoveAll")
	}
	if err := s.Create("p"); err == nil {
		t.Error("Create")
	}
	if err := s.Rename("a", "b"); err == nil {
		t.Error("Rename")
	}
	if _, err := s.Download("r", "l", nil, nil); err == nil {
		t.Error("Download")
	}
	if _, err := s.Upload("l", "r", nil, nil); err == nil {
		t.Error("Upload")
	}
}

func TestS3_DirTransfersUnsupported(t *testing.T) {
	s := &S3{}
	if _, err := s.UploadDir("/a", "/b", nil, nil); err == nil || !strings.Contains(err.Error(), "not yet supported") {
		t.Errorf("UploadDir: %v", err)
	}
	if _, err := s.DownloadDir("/a", "/b", nil, nil); err == nil || !strings.Contains(err.Error(), "not yet supported") {
		t.Errorf("DownloadDir: %v", err)
	}
}
