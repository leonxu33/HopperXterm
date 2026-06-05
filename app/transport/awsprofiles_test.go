package transport

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListAWSProfiles_MergesAndSorts(t *testing.T) {
	dir := t.TempDir()
	credPath := filepath.Join(dir, "credentials")
	cfgPath := filepath.Join(dir, "config")

	// credentials uses bare names; config prefixes non-default with "profile".
	if err := os.WriteFile(credPath, []byte(
		"[default]\nkey=1\n\n[work]\nkey=2\n# a comment\n[personal]\nkey=3\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPath, []byte(
		"[default]\nregion=us-east-1\n\n[profile work]\nregion=eu-west-1\n\n[profile staging]\nregion=us-west-2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", credPath)
	t.Setenv("AWS_CONFIG_FILE", cfgPath)

	got := ListAWSProfiles()
	// default first, then alphabetical; "work" appears in both files but dedups.
	want := []string{"default", "personal", "staging", "work"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("at %d got %q want %q (full %v)", i, got[i], want[i], got)
		}
	}
}

func TestListAWSProfiles_MissingFiles(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", filepath.Join(dir, "nope-credentials"))
	t.Setenv("AWS_CONFIG_FILE", filepath.Join(dir, "nope-config"))
	if got := ListAWSProfiles(); len(got) != 0 {
		t.Errorf("missing files should yield no profiles, got %v", got)
	}
}

func TestParseINISections_StripPrefix(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(p, []byte(
		"[default]\n[profile work]\n  [profile  spaced ]\nnot a section\n; comment\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := parseINISections(p, "profile ")
	want := []string{"default", "work", "spaced"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("at %d got %q want %q", i, got[i], want[i])
		}
	}
}
