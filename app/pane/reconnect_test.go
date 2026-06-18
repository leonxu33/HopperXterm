package pane

import (
	"context"
	"errors"
	"testing"
	"time"

	"hopperxterm/profile"
)

// dialIsPermanent classifies auth/handshake failures (stop retrying) vs.
// transient network failures (keep retrying).
func TestDialIsPermanent(t *testing.T) {
	cases := []struct {
		err  error
		want bool
	}{
		{nil, false},
		{errors.New("transport: ssh handshake to host:22: ssh: unable to authenticate"), true},
		{errors.New("transport: no usable auth methods"), true},
		{errors.New("ssh: no supported methods remain"), true},
		{errors.New("transport: password rejected and no prompter available"), true},
		{errors.New("transport: dial 10.0.0.1:22: connect: connection refused"), false},
		{errors.New("dial tcp: i/o timeout"), false},
		// A network failure DURING the handshake is recoverable, not
		// permanent — the generic "ssh handshake" wrapper must not by
		// itself stop the reconnect loop.
		{errors.New("transport: ssh handshake to host:22: EOF"), false},
		{errors.New("transport: ssh handshake to host:22: read: connection reset by peer"), false},
	}
	for _, c := range cases {
		if got := dialIsPermanent(c.err); got != c.want {
			t.Errorf("dialIsPermanent(%v) = %v, want %v", c.err, got, c.want)
		}
	}
}

// A durable (SSH) pane whose connection drops unexpectedly should
// auto-reconnect: pass through Reconnecting and land back in Connected
// on a new connection generation, without the user pressing 'r'.
func TestReconnect_DropAutoReconnects(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	m := NewManager(context.Background())
	defer m.CloseAll()

	sess := profile.Session{
		ID: "ssh-drop", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
	}
	if err := m.Open("pane-drop", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-drop")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })
	gen0 := p.currentGeneration()

	// Simulate a network drop: server closes the connection, listener stays up.
	srv.DropConnections()

	// The supervisor re-dials with backoff (1s) and reconnects in place —
	// a new generation, back in Connected.
	poll(t, 15*time.Second, func() bool {
		return p.State() == StateConnected && p.currentGeneration() > gen0
	})
}

// A resource monitor running before a drop must be re-armed against the
// new connection after auto-reconnect (its exec channel dies with the old
// client), preserving the consumer refcount.
func TestReconnect_RearmsResourceMonitor(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	m := NewManager(context.Background())
	defer m.CloseAll()

	sess := profile.Session{
		ID: "ssh-rm", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
	}
	if err := m.Open("pane-rm", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-rm")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })

	if err := m.StartResourceMonitor("pane-rm"); err != nil {
		t.Fatalf("StartResourceMonitor: %v", err)
	}
	resOn := func() bool {
		p.resMu.Lock()
		defer p.resMu.Unlock()
		return p.resOn && p.resRefs == 1
	}
	poll(t, 3*time.Second, resOn)
	gen0 := p.currentGeneration()

	srv.DropConnections()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if p.State() == StateConnected && p.currentGeneration() > gen0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if p.State() != StateConnected || p.currentGeneration() <= gen0 {
		t.Fatalf("did not reconnect: state=%s gen=%d (was %d)", p.State(), p.currentGeneration(), gen0)
	}

	// The poller must come back on its own (frontend never re-subscribed),
	// with the same refcount.
	poll(t, 5*time.Second, resOn)
}

// A clean remote shell exit (the user types `exit`) must NOT auto-reconnect
// even on a durable pane — the SSH link is still alive, so it's a deliberate
// logout, not a drop. The pane goes Disconnected and stays there.
func TestReconnect_CleanExitNoReconnect(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	m := NewManager(context.Background())
	defer m.CloseAll()

	sess := profile.Session{
		ID: "ssh-exit", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
	}
	if err := m.Open("pane-exit", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-exit")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })
	gen0 := p.currentGeneration()

	// `exit` makes the harness close the shell channel but keep the
	// connection alive — the clean-exit signal.
	if err := m.SendInput("pane-exit", "exit\n"); err != nil {
		t.Fatalf("SendInput: %v", err)
	}
	poll(t, 5*time.Second, func() bool { return p.State() == StateDisconnected })

	// Give the (initial 1s) backoff window time to fire a reconnect if the
	// clean exit were misclassified, then confirm nothing reconnected.
	time.Sleep(2 * time.Second)
	if p.State() != StateDisconnected {
		t.Errorf("state after clean exit = %s, want Disconnected", p.State())
	}
	if g := p.currentGeneration(); g != gen0 {
		t.Errorf("generation advanced (%d → %d): a clean exit must not reconnect", gen0, g)
	}
}

// Closing a durable pane must not trigger an auto-reconnect.
func TestReconnect_UserCloseNoReconnect(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	m := NewManager(context.Background())
	defer m.CloseAll()

	sess := profile.Session{
		ID: "ssh-close", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
	}
	if err := m.Open("pane-close", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-close")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })
	gen0 := p.currentGeneration()

	if err := m.Close("pane-close"); err != nil {
		t.Fatalf("Close: %v", err)
	}
	time.Sleep(2 * time.Second)
	if p.State() != StateDisconnected {
		t.Errorf("state after close = %s, want Disconnected", p.State())
	}
	if g := p.currentGeneration(); g != gen0 {
		t.Errorf("generation advanced (%d → %d): a user close must not reconnect", gen0, g)
	}
}
