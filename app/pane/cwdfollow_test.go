package pane

import (
	"context"
	"strings"
	"testing"
	"time"

	"hopperxterm/profile"
)

// TestCwdFollow_TmuxPollsPaneCurrentPath verifies that EnableCwdFollow on a
// tmux-backed pane starts the side-channel pane_current_path poller (rather
// than injecting the OSC 7 hook), tracks the pane's working directory as it
// changes, and that DisableCwdFollow tears the poller down.
func TestCwdFollow_TmuxPollsPaneCurrentPath(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	srv.setTmux(true)
	srv.setTmuxCwd("/srv/app")
	m := NewManager(context.Background())
	m.SetAppInstanceID("ti")
	defer m.CloseAll()

	sess := profile.Session{
		ID: "ssh-follow", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
		Persist: true,
	}
	if err := m.OpenInDir("pane-follow", sess, "", "ftok", true); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-follow")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })
	if p.tmuxName == "" {
		t.Fatal("pane is not tmux-backed; cwd follow would take the OSC 7 path")
	}

	// Enable following → the poller starts and reports the current cwd.
	if err := m.EnableCwdFollow("pane-follow"); err != nil {
		t.Fatalf("EnableCwdFollow: %v", err)
	}
	poll(t, 5*time.Second, func() bool { return p.LastCwd() == "/srv/app" })

	// The tmux path must poll pane_current_path, not inject a shell hook.
	ranPoller := false
	for _, c := range srv.execs() {
		if strings.Contains(c, "pane_current_path") {
			ranPoller = true
		}
	}
	if !ranPoller {
		t.Error("expected a #{pane_current_path} poll; tmux pane took the wrong path")
	}

	// A cwd change propagates with no further user action.
	srv.setTmuxCwd("/var/log")
	poll(t, 5*time.Second, func() bool { return p.LastCwd() == "/var/log" })

	// Disable tears the poller down.
	m.DisableCwdFollow("pane-follow")
	poll(t, 3*time.Second, func() bool {
		p.cwdFollowMu.Lock()
		defer p.cwdFollowMu.Unlock()
		return p.cwdFollowCancel == nil
	})
}

// TestCwdFollow_PlainShellInstallsOsc7Once verifies that a non-tmux pane routes
// EnableCwdFollow to the OSC 7 hook and that a repeat enable does not re-inject
// (which would type the hook into a possibly-foregrounded full-screen app).
func TestCwdFollow_PlainShellInstallsOsc7Once(t *testing.T) {
	p, f := paneWithPTY("")
	if err := p.EnableCwdFollow(); err != nil {
		t.Fatalf("EnableCwdFollow: %v", err)
	}
	if !strings.Contains(f.written(), "_hop_osc7") {
		t.Fatalf("OSC 7 hook not injected on a plain shell: %q", f.written())
	}
	first := f.written()
	// Second enable must be a no-op — nothing more written to the shell.
	if err := p.EnableCwdFollow(); err != nil {
		t.Fatalf("EnableCwdFollow (repeat): %v", err)
	}
	if f.written() != first {
		t.Errorf("repeat EnableCwdFollow re-injected the hook: %q", f.written())
	}
}
