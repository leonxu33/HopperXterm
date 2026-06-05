package transport

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestExpandPath_Tilde(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir on this system")
	}
	cases := []struct{ in, want string }{
		{"~", home},
		{"~/foo/bar.pem", filepath.Join(home, "foo/bar.pem")},
		{`~\foo\bar.pem`, filepath.Join(home, "foo", "bar.pem")},
	}
	for _, c := range cases {
		got := expandPath(c.in)
		// On Windows filepath.Join normalises separators; match what the
		// runtime produces.
		if filepath.Clean(got) != filepath.Clean(c.want) {
			t.Errorf("expandPath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestExpandPath_PercentVars(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("percent-var expansion is Windows-only")
	}
	os.Setenv("HOPPERTERM_TEST_KEY", "C:\\keys")
	defer os.Unsetenv("HOPPERTERM_TEST_KEY")
	got := expandPath("%HOPPERTERM_TEST_KEY%\\ec2.pem")
	want := "C:\\keys\\ec2.pem"
	if got != want {
		t.Errorf("expandPath = %q, want %q", got, want)
	}
}

func TestExpandPath_LeavesAbsoluteAlone(t *testing.T) {
	in := `E:\keys\private\ec2.pem`
	got := expandPath(in)
	if !strings.EqualFold(got, in) {
		t.Errorf("expandPath modified absolute path: %q -> %q", in, got)
	}
}

func TestExpandPath_Empty(t *testing.T) {
	if got := expandPath(""); got != "" {
		t.Errorf("empty input should round-trip, got %q", got)
	}
	if got := expandPath("   "); got != "" {
		t.Errorf("whitespace-only input should trim to empty, got %q", got)
	}
}
