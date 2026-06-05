package transport

import (
	goruntime "runtime"
	"testing"
)

func TestDefaultLocalShell_ReturnsCommand(t *testing.T) {
	cmd, _ := defaultLocalShell()
	if cmd == "" {
		t.Fatal("defaultLocalShell returned empty command")
	}
	// Sanity check the platform-specific defaults.
	switch goruntime.GOOS {
	case "windows":
		// cmd.exe is the universal fallback. pwsh/powershell may be
		// preferred but cmd should always work.
		if cmd != "cmd.exe" && !endsWith(cmd, ".exe") {
			t.Errorf("expected an .exe on Windows, got %q", cmd)
		}
	case "linux":
		// bash or $SHELL on Linux.
		if cmd != "/bin/bash" && !startsWith(cmd, "/") {
			t.Errorf("expected an absolute path on Linux, got %q", cmd)
		}
	case "darwin":
		if cmd != "/bin/zsh" && !startsWith(cmd, "/") {
			t.Errorf("expected an absolute path on macOS, got %q", cmd)
		}
	}
}

func endsWith(s, suffix string) bool {
	return len(s) >= len(suffix) && s[len(s)-len(suffix):] == suffix
}

func startsWith(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
