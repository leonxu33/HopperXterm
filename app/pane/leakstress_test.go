package pane

// Regression test for the "CPU climbs with uptime" bug: golang.org/x/crypto
// ≤ v0.52.0 left one keepalive-probe goroutine BUSY-SPINNING per dropped SSH
// connection — SendRequest's internal drain loop looped forever on a closed
// globalResponses channel — so on a flaky link they accumulated and pegged the
// CPU, clearing only on restart. v0.53.0 fixes the drain loop; this test drives
// many real connect → drop → auto-reconnect cycles through the in-process SSH
// harness and asserts the probe goroutines don't pile up.
//
// Run:  go test ./pane -run TestReconnectChurn_NoGoroutineLeak -v

import (
	"bytes"
	"context"
	"regexp"
	"runtime"
	"runtime/pprof"
	"strconv"
	"strings"
	"testing"
	"time"

	"hopperxterm/profile"
)

func TestReconnectChurn_NoGoroutineLeak(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	m := NewManager(context.Background())
	defer m.CloseAll()

	sess := profile.Session{
		ID: "ssh-churn", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
	}
	if err := m.Open("pane-churn", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-churn")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })

	// Exercise the resource monitor too — its exec channel dies on every drop
	// and is re-armed by rearmMonitors, another per-reconnect path.
	if err := m.StartResourceMonitor("pane-churn"); err != nil {
		t.Fatalf("StartResourceMonitor: %v", err)
	}
	poll(t, 3*time.Second, func() bool {
		p.resMu.Lock()
		defer p.resMu.Unlock()
		return p.resOn
	})

	settle(200 * time.Millisecond)
	t.Logf("baseline: total goroutines=%d, keepalive probes=%d",
		runtime.NumGoroutine(), pingGoroutineCount(goroutineProfile()))

	const cycles = 12
	for i := 1; i <= cycles; i++ {
		gen := p.currentGeneration()
		srv.DropConnections()
		ok := false
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			if p.State() == StateConnected && p.currentGeneration() > gen {
				ok = true
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if !ok {
			t.Fatalf("cycle %d: did not reconnect (state=%s gen=%d→%d)", i, p.State(), gen, p.currentGeneration())
		}
	}

	// Settle + GC so anything that was going to exit has, then measure.
	settle(500 * time.Millisecond)
	profileText := goroutineProfile()
	probes := pingGoroutineCount(profileText)
	t.Logf("RESULT after %d reconnects: total goroutines=%d, keepalive probes=%d",
		cycles, runtime.NumGoroutine(), probes)

	// The pre-v0.53.0 bug left ~1 spinning probe per reconnect (→ ~12 here).
	// A healthy build keeps at most one legitimately in-flight probe.
	if probes > 2 {
		t.Logf("goroutine profile:\n%s", profileText)
		t.Errorf("%d keepalive probe goroutines still live after %d reconnects (want ≤2): "+
			"the x/crypto SendRequest spin has regressed — require golang.org/x/crypto v0.53.0+", probes, cycles)
	}
}

var goroutineHeaderRe = regexp.MustCompile(`^([0-9]+) @`)

// pingGoroutineCount sums, from an aggregated (debug=1) goroutine profile, the
// goroutines whose stack runs transport.(*Shell).Ping's probe closure — the
// ones that spun forever under the pre-v0.53.0 x/crypto bug.
func pingGoroutineCount(profileText string) int {
	total, count := 0, 0
	for _, line := range strings.Split(profileText, "\n") {
		line = strings.TrimSpace(line)
		if mm := goroutineHeaderRe.FindStringSubmatch(line); mm != nil {
			count, _ = strconv.Atoi(mm[1])
			continue
		}
		if strings.Contains(line, "(*Shell).Ping.func1") {
			total += count
		}
	}
	return total
}

func goroutineProfile() string {
	var buf bytes.Buffer
	if p := pprof.Lookup("goroutine"); p != nil {
		_ = p.WriteTo(&buf, 1)
	}
	return buf.String()
}

// settle runs a couple of GC + yield rounds over the given window so goroutines
// that are unwinding get scheduled and finalized before we count.
func settle(d time.Duration) {
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		runtime.GC()
		runtime.Gosched()
		time.Sleep(10 * time.Millisecond)
	}
	runtime.GC()
}
