package pane

import (
	"bufio"
	"context"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"hopperxterm/profile"
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

// TestLinuxResourceScript_TornProcLineSurvives runs the poller's real
// /proc/diskstats loop against records that are SHORT — the torn reads that
// killed the monitor in production.
//
// /proc/diskstats is a seq_file and bash's `read` lseeks back after each line,
// so the kernel re-renders the file on every read; when a column changes width
// the resumed offset can land mid-line. The old loop fed such a record's empty
// ${6} straight into $((dr+${6})), leaving the malformed expression "$((dr+))"
// — fatal in a POSIX-mode shell, which is exactly what `sh -s` gets when
// /bin/sh is bash. The whole poller died mid-loop and never came back.
//
// Runs under a real `sh` because the failure is a shell-semantics bug: nothing
// short of executing it proves the guards hold.
func TestLinuxResourceScript_TornProcLineSurvives(t *testing.T) {
	shPath, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not on PATH: %v", err)
	}

	// Lift the diskstats loop verbatim out of the production script, anchored
	// on code (not comments) so this keeps testing the real thing.
	const startMark = "dr=0; dw=0"
	const endMark = "done < /proc/diskstats"
	i := strings.Index(resourceScript, startMark)
	j := strings.Index(resourceScript, endMark)
	if i < 0 || j < 0 {
		t.Fatal("diskstats loop markers not found — did the poller script change shape?")
	}
	loop := resourceScript[i : j+len(endMark)]

	// Two complete records, a loop device that must be filtered, and two torn
	// records (7 fields and 4 fields) of the kind a mid-line read produces.
	script := strings.Replace(loop, "< /proc/diskstats", `<<'STATS'
   8       0 sda 100 0 500 40 200 0 900 80 0 60 120
   7       0 loop0 1 0 999999 1 1 0 999999 1 0 1 1
   8      16 sdb 100 0 600 40 200 0 1000 80 0 60 120
   8      32 sdc 10 0 7
   8      48 sd
   8      64 sdd 100 0 800 40 200 0 1100 80 0 60 120
STATS`, 1) + "\necho \"SURVIVED $dr $dw\"\n"

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, shPath)
	cmd.Stdin = strings.NewReader(script)
	out, err := cmd.CombinedOutput()
	got := strings.TrimSpace(string(out))
	if err != nil {
		t.Fatalf("poller loop died on a torn /proc line (this is the bug): %v\noutput: %s", err, got)
	}
	// Only the three well-formed physical-disk records contribute:
	// reads 500+600+800, writes 900+1000+1100. The loop device is filtered by
	// name and the two torn records are skipped.
	if want := "SURVIVED 1900 3000"; got != want {
		t.Errorf("diskstats sums = %q, want %q", got, want)
	}
}

// TestResourceMonitor_RelaunchesAfterUnexpectedExit covers the other half of
// the production stall: even once the script stops dying, a poller that exits
// for ANY reason while the SSH connection stays healthy used to stay dead.
// resRefs remained >0 and resOn went false, but the only caller of
// restartResourceMonitor was reconnect's rearmMonitors — which never fires when
// the link never dropped. The monitor froze until the user reopened the panel.
func TestResourceMonitor_RelaunchesAfterUnexpectedExit(t *testing.T) {
	isolateHome(t)
	// Collapse the backoff so the test doesn't wait out the real schedule.
	old := resourceRetryDelays
	resourceRetryDelays = []time.Duration{20 * time.Millisecond, 20 * time.Millisecond}
	t.Cleanup(func() { resourceRetryDelays = old })

	srv := startPaneSSHServer(t)
	// Every poller launch dies after two samples — the remote script quitting
	// under a live connection.
	srv.setResourceDieAfter(2)

	m := NewManager(context.Background())
	defer m.CloseAll()
	sess := profile.Session{
		ID: "ssh-res", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
	}
	if err := m.Open("pane-res", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-res")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })

	if err := m.StartResourceMonitor("pane-res"); err != nil {
		t.Fatalf("StartResourceMonitor: %v", err)
	}
	// The supervisor should relaunch the dead poller on its own.
	poll(t, 10*time.Second, func() bool { return srv.resourceExecCount() >= 2 })

	// The subscription must survive the death — that's what a relaunch reads.
	p.resMu.Lock()
	refs := p.resRefs
	p.resMu.Unlock()
	if refs != 1 {
		t.Errorf("resRefs = %d after an unexpected poller death, want 1", refs)
	}
	p.stopResourceMonitor()
}

// TestStopResourceMonitor_ClearsResOnImmediately pins the invariant that makes
// a panel reload a reliable recovery. resOn used to be cleared only by the
// reader goroutine's defer — so if the remote poller WEDGED instead of exiting,
// that defer never ran, resOn stayed true, and every later Start hit the
// "already running" early-return. The panel could then never be revived, not
// even by closing and reopening it.
func TestStopResourceMonitor_ClearsResOnImmediately(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	m := NewManager(context.Background())
	defer m.CloseAll()
	sess := profile.Session{
		ID: "ssh-stop", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
	}
	if err := m.Open("pane-stop", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-stop")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })

	if err := m.StartResourceMonitor("pane-stop"); err != nil {
		t.Fatalf("StartResourceMonitor: %v", err)
	}
	poll(t, 5*time.Second, func() bool {
		p.resMu.Lock()
		defer p.resMu.Unlock()
		return p.resOn
	})

	p.stopResourceMonitor()
	// Synchronous, not "eventually": it must not depend on the reader goroutine
	// having unwound, because a wedged reader never does.
	p.resMu.Lock()
	on := p.resOn
	p.resMu.Unlock()
	if on {
		t.Fatal("resOn still true right after stopResourceMonitor — a wedged poller would block every future Start")
	}

	// And the pane is genuinely re-armable afterwards.
	if err := m.StartResourceMonitor("pane-stop"); err != nil {
		t.Fatalf("StartResourceMonitor after stop: %v", err)
	}
	poll(t, 5*time.Second, func() bool {
		p.resMu.Lock()
		defer p.resMu.Unlock()
		return p.resOn
	})
}

// TestResourceMonitor_NeverStopsRetrying pins the boundary of the backoff: it
// may slow down without bound, but it must never stop. An earlier revision gave
// up after a fixed number of consecutive failures and logged "reopen the panel
// to retry" — which left resRefs>0 with no poller and no one left to relaunch
// it. That is bit-for-bit the frozen-monitor state this supervisor exists to
// prevent, just reached through a different door, so the give-up was removed in
// favour of reusing the longest delay forever.
func TestResourceMonitor_NeverStopsRetrying(t *testing.T) {
	isolateHome(t)
	oldDelays, oldHealthy := resourceRetryDelays, resourceHealthyFor
	// Three short delays; attempts past the third must reuse the last one
	// rather than falling off the end of the schedule.
	resourceRetryDelays = []time.Duration{
		5 * time.Millisecond, 5 * time.Millisecond, 5 * time.Millisecond,
	}
	// Nothing can ever qualify as healthy, so every death costs a retry slot —
	// the worst case for a scheme with a fixed budget.
	resourceHealthyFor = time.Hour
	t.Cleanup(func() { resourceRetryDelays, resourceHealthyFor = oldDelays, oldHealthy })

	srv := startPaneSSHServer(t)
	srv.setResourceDieAfter(1) // dies immediately, every time

	m := NewManager(context.Background())
	defer m.CloseAll()
	sess := profile.Session{
		ID: "ssh-retry", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
	}
	if err := m.Open("pane-retry", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-retry")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })

	if err := m.StartResourceMonitor("pane-retry"); err != nil {
		t.Fatalf("StartResourceMonitor: %v", err)
	}
	// Well past the length of the schedule — a budget-based supervisor would
	// have stopped at 4 (initial + 3).
	poll(t, 20*time.Second, func() bool { return srv.resourceExecCount() >= 8 })

	// Stop explicitly before the deferred CloseAll so the supervisor observes a
	// bumped generation and unwinds while the test still controls the globals.
	p.stopResourceMonitor()
}

// TestResourceMonitor_HealthyRunResetsBackoff guards recovery over the long
// haul, which is the shape of the bug this whole change came from: the poller
// streamed fine for a stretch, died, and had to come back — again and again,
// for days. Without the healthy-run reset the give-up budget would be consumed
// a death at a time and the monitor would eventually stay dead for good, which
// is indistinguishable from the original bug from the user's side.
func TestResourceMonitor_HealthyRunResetsBackoff(t *testing.T) {
	isolateHome(t)
	oldDelays, oldHealthy := resourceRetryDelays, resourceHealthyFor
	// One retry in the budget, so an un-reset counter would give up after the
	// first death and the extra relaunches below could never happen.
	resourceRetryDelays = []time.Duration{10 * time.Millisecond}
	// The harness emits a sample every 50ms; 20ms of streaming counts as a
	// healthy run without making the test wait out the production 30s.
	resourceHealthyFor = 20 * time.Millisecond
	t.Cleanup(func() { resourceRetryDelays, resourceHealthyFor = oldDelays, oldHealthy })

	srv := startPaneSSHServer(t)
	// Three samples ≈ 150ms of streaming per launch — comfortably "healthy",
	// then death. Repeatedly.
	srv.setResourceDieAfter(3)

	m := NewManager(context.Background())
	defer m.CloseAll()
	sess := profile.Session{
		ID: "ssh-healthy", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
	}
	if err := m.Open("pane-healthy", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-healthy")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })

	if err := m.StartResourceMonitor("pane-healthy"); err != nil {
		t.Fatalf("StartResourceMonitor: %v", err)
	}
	// Four launches is already two more than the one-retry budget would allow
	// if healthy runs didn't reset it.
	poll(t, 15*time.Second, func() bool { return srv.resourceExecCount() >= 4 })

	p.resMu.Lock()
	fails := p.resFails
	p.resMu.Unlock()
	if fails > 1 {
		t.Errorf("resFails = %d after healthy runs; a healthy run must reset the budget", fails)
	}
	p.stopResourceMonitor()
}

// TestLinuxResourceScript_TornTickDoesNotSpikeRates covers the second-order
// damage a torn /proc read does once it can no longer kill the poller.
//
// dr/dw/nr/nt are cumulative since-boot counters and the emitted rate is a
// delta against the previous read. A torn read's sum is missing an entire
// device's row — that device's whole lifetime total — so folding it into the
// baseline makes the NEXT tick's delta that lifetime total, emitted as one
// second of I/O. On a server that has read terabytes since boot the panel gets
// a multi-GB/s spike that rescales the y-axis and flattens every real sample.
// The fix holds the baseline across a torn tick; this drives the real delta
// block through torn and clean ticks to prove it.
func TestLinuxResourceScript_TornTickDoesNotSpikeRates(t *testing.T) {
	shPath, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not on PATH: %v", err)
	}

	const startMark = `if [ "$dtorn" = "1" ]; then`
	const endMark = "prev_netr=$nr; prev_nett=$nt\n  fi"
	i := strings.Index(resourceScript, startMark)
	j := strings.Index(resourceScript, endMark)
	if i < 0 || j < 0 {
		t.Fatal("rate-delta block markers not found — did the poller script change shape?")
	}
	block := resourceScript[i : j+len(endMark)]

	// Lifetime-scale counters, as on any host that has been up a while.
	script := `
d_base=0; prev_diskr=0; prev_diskw=0
n_base=0; prev_netr=0; prev_nett=0

dr=1000000; dw=2000000; dtorn=0; nr=500000; nt=600000; ntorn=0
` + block + `
echo "tick1 $drk $dwk $nrk $ntk"

# Torn read: a whole disk's and iface's row missing, so the sums collapse.
dr=10; dw=20; dtorn=1; nr=5; nt=6; ntorn=1
` + block + `
echo "tick2 $drk $dwk $nrk $ntk"

# Clean read again, one tick of real traffic on from tick 1.
dr=1000050; dw=2000100; dtorn=0; nr=500030; nt=600040; ntorn=0
` + block + `
echo "tick3 $drk $dwk $nrk $ntk"
`

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, shPath)
	cmd.Stdin = strings.NewReader(script)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("rate block failed: %v\noutput: %s", err, out)
	}
	got := strings.Fields(strings.TrimSpace(string(out)))
	want := []string{
		// First clean read only seeds the baseline — no delta to report yet.
		"tick1", "0", "0", "0", "0",
		// Torn read reports nothing rather than a bogus negative/huge delta.
		"tick2", "0", "0", "0", "0",
		// Baseline survived the torn tick, so this is the real one-tick delta.
		// Before the fix it was 1000050-10 = 1000040 — the spike.
		"tick3", "50", "100", "30", "40",
	}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("rates after a torn tick:\n got: %s\nwant: %s",
			strings.Join(got, " "), strings.Join(want, " "))
	}
}
