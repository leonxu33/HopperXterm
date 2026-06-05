package appdir

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestBase_EnvOverrideWins(t *testing.T) {
	want := filepath.Join(t.TempDir(), "custom")
	t.Setenv(EnvOverride, want)
	got, err := Base()
	if err != nil {
		t.Fatalf("Base: %v", err)
	}
	if got != want {
		t.Errorf("Base = %q, want override %q", got, want)
	}
}

func TestBase_DefaultUsesSubdir(t *testing.T) {
	t.Setenv(EnvOverride, "")
	// Pin UserConfigDir to a temp tree across platforms.
	tmp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmp) // linux
	t.Setenv("AppData", tmp)         // windows
	t.Setenv("HOME", tmp)            // macOS fallback

	got, err := Base()
	if err != nil {
		t.Fatalf("Base: %v", err)
	}
	// The leaf is the compiled-in subdir, and it must sit under the pinned
	// config root.
	if filepath.Base(got) != subdir {
		t.Errorf("Base leaf = %q, want %q", filepath.Base(got), subdir)
	}
	if !strings.HasPrefix(got, tmp) {
		t.Errorf("Base = %q, want under %q", got, tmp)
	}
}

func TestSubdir_MatchesBuildTagContract(t *testing.T) {
	// Release builds use "hopperxterm"; the `dev` build tag (set by
	// `wails dev`) uses "hopperxterm-dev". Whichever tag compiled this
	// binary, subdir is one of them.
	if subdir != "hopperxterm" && subdir != "hopperxterm-dev" {
		t.Errorf("subdir = %q, want hopperxterm or hopperxterm-dev", subdir)
	}
}
