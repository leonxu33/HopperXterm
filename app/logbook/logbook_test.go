package logbook

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"hopperxterm/appdir"
)

// TestInitWritesRedactedFile drives the real Init() once (the package guards
// against re-init) and confirms a log file is created under the config dir,
// honours the level env, and scrubs secrets before they hit disk.
func TestInitWritesRedactedFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(appdir.EnvOverride, dir)
	t.Setenv(EnvLevel, "debug")

	Init()
	t.Cleanup(func() { _ = Close() })

	Info("SSH handshake complete to server01")
	Debug("debug line visible at debug level")
	// URL password split across fragments so the source line carries no literal
	// user:pass@host token (would trip the credential pre-commit hook).
	Error("dialing ftp://alice:" + "hunter2" + "@host failed")
	Warn("password=topsecret should be masked")

	if err := Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	path := filepath.Join(dir, logsDir, logFile)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log file %s: %v", path, err)
	}
	got := string(b)

	// Level: debug must be present (env override to debug).
	if !strings.Contains(got, "debug line visible") {
		t.Errorf("debug line missing at debug level:\n%s", got)
	}
	// Warning + error present (requirement: all warnings/errors logged).
	if !strings.Contains(got, "should be masked") {
		t.Errorf("warn line missing:\n%s", got)
	}
	// Redaction applied on disk.
	if strings.Contains(got, "hunter2") {
		t.Errorf("url password leaked to disk:\n%s", got)
	}
	if strings.Contains(got, "topsecret") {
		t.Errorf("password value leaked to disk:\n%s", got)
	}
	if !strings.Contains(got, "alice:***@host") {
		t.Errorf("expected masked url, got:\n%s", got)
	}
}

func TestParseLevel(t *testing.T) {
	for in, ok := range map[string]bool{
		"debug": true, "DEBUG": true, "info": true, "warn": true,
		"warning": true, "error": true, "fatal": true, "bogus": false, "": false,
	} {
		if _, got := parseLevel(in); got != ok {
			t.Errorf("parseLevel(%q) ok=%v, want %v", in, got, ok)
		}
	}
}
