package pane

import (
	"strings"
	"testing"
)

func TestParseProcessLine_OK(t *testing.T) {
	s, ok := parseProcessLine("p1 1700000000123 4321 175 524288 1")
	if !ok {
		t.Fatalf("parse ok=false for valid line")
	}
	if s.TS != 1700000000123 {
		t.Errorf("TS got %d", s.TS)
	}
	if s.PID != 4321 {
		t.Errorf("PID got %d", s.PID)
	}
	if s.CPUPct != 175 { // top-style, >100 across cores
		t.Errorf("CPUPct got %v", s.CPUPct)
	}
	if s.MemKB != 524288 {
		t.Errorf("MemKB got %d", s.MemKB)
	}
	if !s.Alive {
		t.Errorf("Alive should be true")
	}
}

func TestParseProcessLine_ExitedTick(t *testing.T) {
	s, ok := parseProcessLine("p1 1700000000123 4321 0 0 0")
	if !ok {
		t.Fatalf("exited tick should parse")
	}
	if s.Alive {
		t.Errorf("Alive should be false on the final tick")
	}
}

func TestParseProcessLine_FloatCPU(t *testing.T) {
	// macOS ps emits fractional pcpu.
	s, ok := parseProcessLine("p1 1700000000000 99 12.5 2048 1")
	if !ok {
		t.Fatalf("fractional cpu line should parse")
	}
	if s.CPUPct != 12.5 {
		t.Errorf("CPUPct got %v, want 12.5", s.CPUPct)
	}
}

func TestParseProcessLine_Reject(t *testing.T) {
	cases := []string{
		"",
		"p1",
		"p1 1 2 3 4",         // 5 tokens (want 6)
		"p1 1 2 3 4 5 6",     // 7 tokens
		"v3 1 2 3 4 5",       // wrong prefix
		"p2 1700 1 2 3 1",    // wrong version
	}
	for _, c := range cases {
		if _, ok := parseProcessLine(c); ok {
			t.Errorf("expected reject: %q", c)
		}
	}
}

func TestParseProcessLine_NonNumericZeroes(t *testing.T) {
	// Bad numeric fields zero out rather than rejecting the line.
	s, ok := parseProcessLine("p1 nope bad x y 1")
	if !ok {
		t.Fatalf("non-numeric fields should not reject the line")
	}
	if s.TS != 0 || s.PID != 0 || s.CPUPct != 0 || s.MemKB != 0 {
		t.Errorf("non-numeric fields should zero out, got %+v", s)
	}
}

func TestParseUnixProcessList(t *testing.T) {
	// `ps -eo pid=,user=,pcpu=,rss=,comm=` style output (leading spaces,
	// variable column widths).
	out := strings.Join([]string{
		" 1234 root      12.5  524288 systemd",
		" 5678 alice      3.0   65536 chrome",
		"  900 alice      0.0    1024 my prog with spaces",
		"garbage line",
		"",
	}, "\n")
	list := parseProcessList("linux", out)
	if len(list) != 3 {
		t.Fatalf("got %d rows, want 3 (%#v)", len(list), list)
	}
	if list[0].PID != 1234 || list[0].User != "root" || list[0].CPUPct != 12.5 || list[0].MemKB != 524288 || list[0].Name != "systemd" {
		t.Errorf("row0 mis-parsed: %+v", list[0])
	}
	if list[2].Name != "my prog with spaces" {
		t.Errorf("comm with spaces should be preserved, got %q", list[2].Name)
	}
}

func TestParseWindowsProcessList(t *testing.T) {
	out := "1234|System|524288|42.5\r\n5678|chrome|65536|3\r\nbad\r\n\r\n"
	list := parseProcessList("windows", out)
	if len(list) != 2 {
		t.Fatalf("got %d rows, want 2 (%#v)", len(list), list)
	}
	if list[0].PID != 1234 || list[0].Name != "System" || list[0].MemKB != 524288 {
		t.Errorf("row0 mis-parsed: %+v", list[0])
	}
	if list[0].CPUPct != 42.5 {
		t.Errorf("windows CPUPct should parse field 4, got %v", list[0].CPUPct)
	}
}

func TestParseUnixProcessList_BasenamesMacPath(t *testing.T) {
	// macOS `comm` is a full path; it should reduce to the basename so the
	// display and command-mode matching use the same token.
	out := " 1234 root  2.0  4096 /usr/sbin/sshd\n 99 alice 0.0 2048 bash\n"
	list := parseProcessList("darwin", out)
	if len(list) != 2 {
		t.Fatalf("got %d rows, want 2", len(list))
	}
	if list[0].Name != "sshd" {
		t.Errorf("macOS full-path comm should basename to 'sshd', got %q", list[0].Name)
	}
	if list[1].Name != "bash" {
		t.Errorf("bare name should be unchanged, got %q", list[1].Name)
	}
}

func TestProcessCommandStreamCmd(t *testing.T) {
	cases := []struct {
		osFamily string
		wantCmd  string
		wantTok  string // resolver token the script must use
	}{
		{"", "sh -s", "pgrep -x"},
		{"linux", "sh -s", "pgrep -x"},
		{"darwin", "sh -s", "pgrep -x"},
	}
	for _, c := range cases {
		cmd, stdin := processCommandStreamCmd(c.osFamily, "test-binary")
		if cmd != c.wantCmd {
			t.Errorf("processCommandStreamCmd(%q) cmd = %q, want %q", c.osFamily, cmd, c.wantCmd)
		}
		if !strings.Contains(stdin, c.wantTok) {
			t.Errorf("processCommandStreamCmd(%q) stdin missing %q", c.osFamily, c.wantTok)
		}
		if !strings.Contains(stdin, "cmdname='test-binary'") {
			t.Errorf("processCommandStreamCmd(%q) should inject the quoted cmdname", c.osFamily)
		}
	}
	// Windows resolves by Get-Process -Name and injects a PS-quoted var.
	wcmd, wstdin := processCommandStreamCmd("windows", "test-binary")
	if !strings.Contains(wcmd, "powershell") {
		t.Errorf("windows cmd should invoke powershell, got %q", wcmd)
	}
	if !strings.Contains(wstdin, "Get-Process -Name $cmdname") {
		t.Errorf("windows command script should resolve via Get-Process -Name")
	}
	if !strings.Contains(wstdin, "$cmdname='test-binary'") {
		t.Errorf("windows script should inject $cmdname")
	}
}

func TestProcessListCmd(t *testing.T) {
	cases := []struct {
		osFamily string
		want     string // token the list command must contain
	}{
		{"", "ps -eo"},        // unknown → linux
		{"linux", "--sort=-pcpu"},
		{"darwin", "ps -axo"},
	}
	for _, c := range cases {
		if got := processListCmd(c.osFamily); !strings.Contains(got, c.want) {
			t.Errorf("processListCmd(%q) = %q, missing %q", c.osFamily, got, c.want)
		}
	}
	if got := processListCmd("windows"); !strings.Contains(got, "powershell") {
		t.Errorf("windows list cmd should invoke powershell, got %q", got)
	}
}

func TestShellQuoteEscaping(t *testing.T) {
	// Embedded single quotes must not break out of the quoting.
	if got := shSingleQuote("a'b"); got != `'a'\''b'` {
		t.Errorf("shSingleQuote = %q", got)
	}
	if got := psSingleQuote("a'b"); got != "'a''b'" {
		t.Errorf("psSingleQuote = %q", got)
	}
}

func TestProcessCmdScriptsEmitP1AndNotRunning(t *testing.T) {
	for name, scr := range map[string]string{
		"linux":   linuxProcCmdScript,
		"darwin":  darwinProcCmdScript,
		"windows": windowsProcCmdScript,
	} {
		if !strings.Contains(scr, "p1 ") {
			t.Errorf("%s command script does not emit a p1 line", name)
		}
		// Must emit a not-running tick (pid 0, alive 0) rather than ending.
		if !strings.Contains(scr, "p1 $ts 0 0 0 0") {
			t.Errorf("%s command script missing the not-running tick", name)
		}
	}
}

func TestProcessStreamCmd(t *testing.T) {
	cases := []struct {
		osFamily string
		wantCmd  string
		wantTok  string // token that must appear in the stdin script
	}{
		{"", "sh -s", "/proc/$pid/stat"},
		{"linux", "sh -s", "/proc/$pid/stat"},
		{"darwin", "sh -s", "ps -p $pid"},
		{"freebsd", "sh -s", "/proc/$pid/stat"}, // unknown → linux
	}
	for _, c := range cases {
		cmd, stdin := processStreamCmd(c.osFamily, 4321)
		if cmd != c.wantCmd {
			t.Errorf("processStreamCmd(%q) cmd = %q, want %q", c.osFamily, cmd, c.wantCmd)
		}
		if !strings.Contains(stdin, c.wantTok) {
			t.Errorf("processStreamCmd(%q) stdin missing %q", c.osFamily, c.wantTok)
		}
		if !strings.Contains(stdin, "pid=4321") {
			t.Errorf("processStreamCmd(%q) stdin should inject pid=4321", c.osFamily)
		}
	}
}

func TestProcessStreamCmd_Windows(t *testing.T) {
	cmd, stdin := processStreamCmd("windows", 4321)
	if !strings.Contains(cmd, "powershell") {
		t.Errorf("windows cmd should invoke powershell, got %q", cmd)
	}
	// Script rides on stdin, so the command line stays tiny regardless of
	// script size (the cmd.exe 8191-char limit must never be at risk).
	if len(cmd) > 1000 {
		t.Errorf("windows start command is %d chars — the script must ride stdin", len(cmd))
	}
	if !strings.Contains(stdin, "$tpid=4321") {
		t.Errorf("windows stdin should inject $tpid=4321")
	}
	// $tpid, never $pid (the PowerShell automatic current-process variable).
	if strings.Contains(windowsProcScript, "$pid") {
		t.Errorf("windows script must not reference $pid (auto var); use $tpid")
	}
}

func TestProcessScriptsEmitP1(t *testing.T) {
	for name, scr := range map[string]string{
		"linux":   linuxProcScript,
		"darwin":  darwinProcScript,
		"windows": windowsProcScript,
	} {
		if !strings.Contains(scr, "p1 ") {
			t.Errorf("%s process script does not emit a p1 line", name)
		}
	}
}
