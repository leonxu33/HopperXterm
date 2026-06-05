package pane

import (
	"bufio"
	"context"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestParseResourceLine_OK(t *testing.T) {
	line := "v1 1700000000123 45 8192000 16384000 12.5 3.4 88.1 12.2 9876 0.55"
	s, ok := parseResourceLine(line)
	if !ok {
		t.Fatalf("parse ok=false for valid line")
	}
	if s.TS != 1700000000123 {
		t.Errorf("TS got %d", s.TS)
	}
	if s.CPUPct != 45 {
		t.Errorf("CPUPct got %v", s.CPUPct)
	}
	if s.MemUsedKB != 8192000 || s.MemTotalKB != 16384000 {
		t.Errorf("mem got used=%d total=%d", s.MemUsedKB, s.MemTotalKB)
	}
	if s.DiskRdKBs != 12.5 || s.DiskWrKBs != 3.4 {
		t.Errorf("disk got rd=%v wr=%v", s.DiskRdKBs, s.DiskWrKBs)
	}
	if s.NetRxKBs != 88.1 || s.NetTxKBs != 12.2 {
		t.Errorf("net got rx=%v tx=%v", s.NetRxKBs, s.NetTxKBs)
	}
	if s.Uptime != 9876 {
		t.Errorf("uptime got %v", s.Uptime)
	}
	if s.LoadAvg1 != 0.55 {
		t.Errorf("load got %v", s.LoadAvg1)
	}
}

func TestParseResourceLine_V2_DiskUsage(t *testing.T) {
	line := "v2 1700000000123 45 8192000 16384000 12.5 3.4 88.1 12.2 9876 0.55 25000000 100000000"
	s, ok := parseResourceLine(line)
	if !ok {
		t.Fatalf("parse ok=false for valid v2 line")
	}
	if s.DiskUsedKB != 25000000 || s.DiskTotalKB != 100000000 {
		t.Errorf("disk usage got used=%d total=%d", s.DiskUsedKB, s.DiskTotalKB)
	}
	// v1 fields still parsed correctly
	if s.CPUPct != 45 || s.MemUsedKB != 8192000 {
		t.Errorf("v1 fields mis-parsed in v2 line: cpu=%v mem=%d", s.CPUPct, s.MemUsedKB)
	}
}

func TestParseResourceLine_V1_NoDiskUsage(t *testing.T) {
	// v1 lines (older format) should still parse but leave disk usage 0.
	line := "v1 1700000000123 45 8192000 16384000 12.5 3.4 88.1 12.2 9876 0.55"
	s, ok := parseResourceLine(line)
	if !ok {
		t.Fatalf("v1 line should still parse")
	}
	if s.DiskUsedKB != 0 || s.DiskTotalKB != 0 {
		t.Errorf("v1 line should leave disk usage 0, got used=%d total=%d", s.DiskUsedKB, s.DiskTotalKB)
	}
}

func TestParseResourceLine_WrongVersion(t *testing.T) {
	if _, ok := parseResourceLine("v3 1 2 3 4 5 6 7 8 9 10"); ok {
		t.Errorf("unknown version prefix should be rejected")
	}
}

func TestParseResourceLine_WrongFieldCount(t *testing.T) {
	cases := []string{
		"v1",
		"v1 1 2 3",
		"v1 1 2 3 4 5 6 7 8 9",                // missing one (v1 expects 11)
		"v1 1 2 3 4 5 6 7 8 9 10 11",          // one extra (v1 expects 11)
		"v2 1 2 3 4 5 6 7 8 9 10 11",          // missing 2 (v2 expects 13)
		"v2 1 2 3 4 5 6 7 8 9 10 11 12 13 14", // one extra (v2 expects 13)
	}
	for _, c := range cases {
		if _, ok := parseResourceLine(c); ok {
			t.Errorf("expected reject: %q", c)
		}
	}
}

func TestParseResourceLine_NonNumericFieldsZero(t *testing.T) {
	// ParseInt/ParseFloat return 0 on error; we accept the line but the
	// bad field zeroes. Better than panicking.
	line := "v1 nope 45 8192000 16384000 12.5 3.4 88.1 12.2 9876 0.55"
	s, ok := parseResourceLine(line)
	if !ok {
		t.Fatalf("non-numeric TS should not reject the whole line")
	}
	if s.TS != 0 {
		t.Errorf("non-numeric TS should zero out, got %d", s.TS)
	}
}

func TestParseResourceLine_LeadingTrailingSpace(t *testing.T) {
	// strings.Fields collapses spaces; the function is only called after
	// strings.TrimSpace at the caller. Direct call still works on tidy
	// input.
	line := "v1 100 0 0 0 0 0 0 0 0 0"
	if _, ok := parseResourceLine(line); !ok {
		t.Errorf("clean v1 line rejected")
	}
}

func TestResourceStreamCmd_Unix(t *testing.T) {
	cases := []struct {
		osFamily string
		wantScr  string // token that must appear in the stdin script
	}{
		// Empty (classification failed/timed out) and "linux" both use the
		// POSIX /proc poller — preserves pre-existing behavior.
		{"", "/proc/stat"},
		{"linux", "/proc/stat"},
		{"darwin", "vm_stat"},
		{"freebsd", "/proc/stat"}, // unknown family falls back to Linux
	}
	for _, c := range cases {
		cmd, stdin := resourceStreamCmd(c.osFamily)
		if cmd != "sh -s" {
			t.Errorf("resourceStreamCmd(%q) cmd = %q, want sh -s", c.osFamily, cmd)
		}
		if !strings.Contains(stdin, c.wantScr) {
			t.Errorf("resourceStreamCmd(%q) stdin script missing token %q", c.osFamily, c.wantScr)
		}
	}
}

func TestResourceStreamCmd_Windows(t *testing.T) {
	// Windows pipes its script via `powershell -Command -` on stdin (NOT
	// -EncodedCommand): the encoded form exceeds cmd.exe's 8191-char limit
	// and Windows OpenSSH rejects it with "The command line is too long."
	cmd, stdin := resourceStreamCmd("windows")
	if !strings.Contains(cmd, "powershell") {
		t.Errorf("windows cmd should invoke powershell, got %q", cmd)
	}
	if stdin != windowsResourceScript {
		t.Errorf("windows stdin should carry the full poller script")
	}
	// Guard the regression that broke the monitor: the command line the
	// remote cmd.exe receives must stay far under its 8191-char ceiling,
	// regardless of how large the poller script grows (the script rides on
	// stdin, only the fixed stub is encoded onto the command line).
	if len(cmd) > 1000 {
		t.Errorf("windows start command is %d chars — the script must ride stdin, not the command line", len(cmd))
	}
}

// TestWindowsResourceScript_LiveParses runs the actual Windows poller
// through the real powershell invocation (the same -EncodedCommand the
// remote would receive) and asserts every v3 line it emits parses back
// into a sample. This is the regression guard for the empty-base64-field
// bug: if $df_b64/$who_b64/$user_b64 ever collapse to "", the line drops
// below 18 tokens and parseResourceLine rejects it. Skips off Windows or
// when powershell isn't on PATH, so it stays a no-op in CI/Unix.
func TestWindowsResourceScript_LiveParses(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows poller test only runs on windows")
	}
	// Exercise the exact production invocation: the command + stdin script
	// chosen by resourceStreamCmd, with the script piped on stdin (NOT
	// -EncodedCommand, which would exceed cmd.exe's command-line limit).
	startCmd, stdinScript := resourceStreamCmd("windows")
	fields := strings.Fields(startCmd) // "powershell -NoProfile -NonInteractive -Command -"
	if _, err := exec.LookPath(fields[0]); err != nil {
		t.Skipf("%s not on PATH: %v", fields[0], err)
	}

	// Generous deadline: a cold powershell.exe start (JIT + assembly load)
	// plus the first CIM iteration can take several seconds before the
	// first line lands. This mirrors why a freshly-connected Windows
	// remote's resource panel stays blank for a moment.
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, fields[0], fields[1:]...)
	cmd.Stdin = strings.NewReader(stdinScript)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start powershell: %v", err)
	}
	defer func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() }()

	seen := 0
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 4096), 1<<16)
	for scanner.Scan() && seen < 3 {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "v3 ") {
			continue
		}
		seen++
		s, ok := parseResourceLine(line)
		if !ok {
			t.Errorf("emitted v3 line did not parse (%d tokens): %q",
				len(strings.Fields(line)), line)
			continue
		}
		if s.MemTotalKB <= 0 {
			t.Errorf("expected a real MemTotalKB from the live poller, line: %q", line)
		}
	}
	if seen == 0 {
		t.Fatalf("windows poller emitted no v3 lines within the deadline; stderr: %q", stderr.String())
	}
}

// All three scripts must emit the v3 line so the shared parser keeps
// working across platforms.
func TestResourceScriptsEmitV3(t *testing.T) {
	for name, scr := range map[string]string{
		"linux":   resourceScript,
		"darwin":  darwinResourceScript,
		"windows": windowsResourceScript,
	} {
		if scr == "" {
			t.Errorf("%s script is empty", name)
		}
		if !strings.Contains(scr, "v3 ") {
			t.Errorf("%s script does not emit a v3 line", name)
		}
	}
}
