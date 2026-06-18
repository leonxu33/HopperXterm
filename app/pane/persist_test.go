package pane

import (
	"context"
	"strings"
	"testing"
	"time"

	"hopperxterm/profile"
	"hopperxterm/transport"
)

// tmuxName namespaces by app instance + sanitizes the token; tmuxLaunchCmd
// builds the attach-or-create exec with status off + a generous history limit.
func TestTmuxNameAndLaunch(t *testing.T) {
	if got := tmuxName("inst1", "abc-123_x"); got != "hopperxterm-inst1-abc-123_x" {
		t.Errorf("tmuxName kept safe chars wrong: %q", got)
	}
	// '.' and ':' are special to tmux and must be replaced — in both parts.
	if got := tmuxName("a.b", "c:d e"); got != "hopperxterm-a_b-c_d_e" {
		t.Errorf("tmuxName sanitize = %q", got)
	}
	// Different instances never collide on a session name for the same token.
	if tmuxName("dev", "tok") == tmuxName("prod", "tok") {
		t.Error("tmuxName must namespace by instance")
	}
	cmd := tmuxLaunchCmd("hopperxterm-x")
	for _, want := range []string{
		"exec tmux", "new-session -A -s", "set-option status off", "set-option mouse on",
		"set-clipboard on", "terminal-features", "history-limit 100000", "hopperxterm-x",
	} {
		if !strings.Contains(cmd, want) {
			t.Errorf("tmuxLaunchCmd missing %q: %s", want, cmd)
		}
	}
	// Two different tokens never collide on one session name.
	if mintTmuxID() == mintTmuxID() {
		t.Error("mintTmuxID returned a duplicate")
	}
}

// resolveTmuxLaunch reports tmux-unavailable when the marker is absent, and
// distinguishes create (session doesn't exist) from re-attach (it does).
func TestResolveTmuxLaunch_CreateVsReattach(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	client, err := transport.DialSSH(transport.SSHDialConfig{
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	p := &Pane{ID: "p", SessionID: "sid", appCtx: context.Background()}
	name := tmuxName("inst", "tok")

	srv.setTmux(false)
	if _, _, ok := p.resolveTmuxLaunch(client, name); ok {
		t.Error("ok=true with no tmux on remote")
	}

	srv.setTmux(true) // installed, no sessions yet
	launch, created, ok := p.resolveTmuxLaunch(client, name)
	if !ok || !created {
		t.Fatalf("fresh session: ok=%v created=%v (want true/true)", ok, created)
	}
	if !strings.Contains(launch, name) {
		t.Errorf("launch %q missing name %q", launch, name)
	}

	srv.tmuxAdd(name) // session now exists → re-attach
	if _, created, ok := p.resolveTmuxLaunch(client, name); !ok || created {
		t.Errorf("existing session: ok=%v created=%v (want true/false)", ok, created)
	}
}

// A persistent SSH pane on a tmux-equipped remote launches its shell inside a
// tmux session named from its stable token (via exec, not a plain shell
// request), and a drop re-attaches the SAME session.
func TestPersist_WrapsAndReattachesOnDrop(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	srv.setTmux(true)
	m := NewManager(context.Background())
	m.SetAppInstanceID("ti")
	defer m.CloseAll()

	sess := profile.Session{
		ID: "ssh-persist", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
		Persist: true,
	}
	if err := m.OpenInDir("pane-persist", sess, "", "tok1", true); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-persist")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })

	wantName := tmuxName("ti", "tok1")
	if p.tmuxLaunch == "" || !strings.Contains(p.tmuxLaunch, wantName) {
		t.Fatalf("pane not tmux-backed: tmuxLaunch=%q", p.tmuxLaunch)
	}
	countLaunch := func() int {
		n := 0
		for _, c := range srv.execs() {
			if strings.Contains(c, "new-session -A -s") && strings.Contains(c, wantName) {
				n++
			}
		}
		return n
	}
	poll(t, 3*time.Second, func() bool { return countLaunch() >= 1 })
	if sc := srv.shellCount(); sc != 0 {
		t.Errorf("persistent pane used a plain shell request %d time(s); want tmux exec only", sc)
	}
	gen0 := p.currentGeneration()

	// A drop must re-attach the same tmux session — a second launch of the
	// identical name, and the session was never destroyed.
	srv.DropConnections()
	poll(t, 15*time.Second, func() bool {
		return p.State() == StateConnected && p.currentGeneration() > gen0
	})
	poll(t, 5*time.Second, func() bool { return countLaunch() >= 2 })
	if !srv.tmuxHas(wantName) {
		t.Error("tmux session was destroyed across a drop; it must survive to re-attach")
	}
}

// Restore is governed by the SAVED token, not the live Persist flag: a pane
// that comes back with a tmuxID from the workspace layout stays tmux-backed
// even though its session's "keep session alive" toggle is now OFF. (Flipping
// the toggle off must not silently downgrade a restored pane to a plain shell
// and orphan its remote tmux session.)
func TestPersist_RestoreUsesSavedTokenWhenPersistOff(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	srv.setTmux(true)
	m := NewManager(context.Background())
	m.SetAppInstanceID("ti")
	defer m.CloseAll()

	sess := profile.Session{
		ID: "ssh-depersisted", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
		Persist: false, // toggle was flipped OFF after this pane was first opened
	}
	// restore=true with a saved token = the workspace-restore path for a pane
	// that was tmux-backed when saved.
	if err := m.OpenInDir("pane-restored", sess, "", "savedtok", true); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-restored")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })

	wantName := tmuxName("ti", "savedtok")
	if p.tmuxLaunch == "" || !strings.Contains(p.tmuxLaunch, wantName) {
		t.Fatalf("restored pane downgraded to plain shell despite saved token: tmuxLaunch=%q", p.tmuxLaunch)
	}
	if sc := srv.shellCount(); sc != 0 {
		t.Errorf("restored pane used a plain shell request %d time(s); want tmux re-attach", sc)
	}
}

// Restore NEVER mints a fresh token: a pane saved as non-persistent (no token
// in the layout) stays a plain shell on restore even though its session's
// Persist toggle is now ON — the toggle only governs future opens, never
// retroactively upgrades a restored pane. (Mirror of the downgrade case.)
func TestPersist_RestoreNeverMintsWhenNoSavedToken(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	srv.setTmux(true) // tmux IS available — so a mint would succeed if attempted
	m := NewManager(context.Background())
	m.SetAppInstanceID("ti")
	defer m.CloseAll()

	sess := profile.Session{
		ID: "ssh-newpersist", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
		Persist: true, // toggle flipped ON after this pane was first opened
	}
	// restore=true with an empty token = restoring a leaf that was plain.
	if err := m.OpenInDir("pane-stayplain", sess, "", "", true); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-stayplain")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })

	if p.tmuxID != "" {
		t.Errorf("restore minted a token %q; want none", p.tmuxID)
	}
	if p.tmuxLaunch != "" {
		t.Errorf("restore upgraded a plain pane to tmux: tmuxLaunch=%q", p.tmuxLaunch)
	}
	poll(t, 3*time.Second, func() bool { return srv.shellCount() >= 1 })
	for _, c := range srv.execs() {
		if strings.Contains(c, "new-session -A -s") {
			t.Errorf("ran a tmux launch on a plain restore: %q", c)
		}
	}
}

// When the remote has no tmux, a persistent pane silently falls back to the
// plain Phase-A shell (still auto-reconnecting): no tmux exec, a real shell
// request, and no recorded tmux launch command.
func TestPersist_FallbackWhenNoTmux(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	srv.setTmux(false)
	m := NewManager(context.Background())
	defer m.CloseAll()

	sess := profile.Session{
		ID: "ssh-notmux", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
		Persist: true,
	}
	if err := m.Open("pane-notmux", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-notmux")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })

	if p.tmuxLaunch != "" {
		t.Errorf("expected Phase-A fallback, got tmuxLaunch=%q", p.tmuxLaunch)
	}
	poll(t, 3*time.Second, func() bool { return srv.shellCount() >= 1 })
	for _, c := range srv.execs() {
		if strings.Contains(c, "new-session -A -s") {
			t.Errorf("ran a tmux launch despite no tmux: %q", c)
		}
	}
}

// Explicitly closing a pane (CloseKill) ends its tmux session on the remote,
// whereas a plain Close (drop/app-quit/teardown) leaves it running.
func TestPersist_CloseKillEndsSession(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	srv.setTmux(true)
	m := NewManager(context.Background())
	m.SetAppInstanceID("ti")
	defer m.CloseAll()

	sess := profile.Session{
		ID: "ssh-kill", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
		Persist: true,
	}
	if err := m.OpenInDir("pane-kill", sess, "", "killtok", true); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-kill")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })
	name := tmuxName("ti", "killtok")
	poll(t, 3*time.Second, func() bool { return srv.tmuxHas(name) })

	if err := m.CloseKill("pane-kill"); err != nil {
		t.Fatalf("CloseKill: %v", err)
	}
	poll(t, 5*time.Second, func() bool { return !srv.tmuxHas(name) })
	sawKill := false
	for _, c := range srv.execs() {
		if strings.Contains(c, "kill-session -t") && strings.Contains(c, name) {
			sawKill = true
		}
	}
	if !sawKill {
		t.Error("CloseKill did not run tmux kill-session")
	}
}

// Killing the tmux session out-of-band (another terminal, or the session
// dying) while a pane is attached must read as a CLEAN close, not a network
// drop: the SSH link is still alive, so the pane goes Disconnected ("press r")
// rather than entering the auto-reconnect loop. Pressing r would create a fresh
// session (new-session -A), but that's the user's call — we don't silently
// respawn.
func TestPersist_ManualKillWhileAttachedDisconnects(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	srv.setTmux(true)
	m := NewManager(context.Background())
	m.SetAppInstanceID("ti")
	defer m.CloseAll()

	sess := profile.Session{
		ID: "ssh-extkill", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
		Persist: true,
	}
	if err := m.OpenInDir("pane-extkill", sess, "", "extkilltok", true); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-extkill")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })
	name := tmuxName("ti", "extkilltok")
	poll(t, 3*time.Second, func() bool { return srv.tmuxHas(name) })
	gen0 := p.currentGeneration()

	// Someone kills the session out-of-band; our attach channel closes but the
	// SSH connection stays up.
	srv.killSessionExternally(name)

	// Clean close → Disconnected, NOT Reconnecting/auto-reconnect.
	poll(t, 8*time.Second, func() bool { return p.State() == StateDisconnected })
	// Give the reconnect backoff window time to fire if it were misclassified.
	time.Sleep(2 * time.Second)
	if p.State() != StateDisconnected {
		t.Errorf("state after external kill = %s, want Disconnected", p.State())
	}
	if g := p.currentGeneration(); g != gen0 {
		t.Errorf("generation advanced (%d → %d): a killed session must not auto-reconnect", gen0, g)
	}
}

// Reopening with the same stable token re-attaches the one existing session
// rather than spawning a duplicate — the binding that keeps the right session
// with the right pane across an app restart.
func TestPersist_StableIdReattaches(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	srv.setTmux(true)
	m := NewManager(context.Background())
	defer m.CloseAll()

	sess := profile.Session{
		ID: "ssh-stable", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
		Persist: true,
	}
	// First pane creates the session, then detaches (plain Close keeps it).
	if err := m.OpenInDir("pane-a", sess, "", "shared", true); err != nil {
		t.Fatalf("Open A: %v", err)
	}
	pa, _ := m.get("pane-a")
	poll(t, 5*time.Second, func() bool { return pa.State() == StateConnected })
	poll(t, 3*time.Second, func() bool { return srv.tmuxCount() == 1 })
	_ = m.Close("pane-a")

	// A different pane with the SAME token re-attaches the existing session.
	if err := m.OpenInDir("pane-b", sess, "", "shared", true); err != nil {
		t.Fatalf("Open B: %v", err)
	}
	pb, _ := m.get("pane-b")
	poll(t, 5*time.Second, func() bool { return pb.State() == StateConnected })
	// Still exactly one matching session: re-attached, not duplicated.
	time.Sleep(200 * time.Millisecond)
	if n := srv.tmuxCount(); n != 1 {
		t.Errorf("tmux session count = %d, want 1 (stable id must re-attach, not duplicate)", n)
	}
}

// On connect, the reaper kills THIS instance's orphaned detached sessions —
// but never a live/attached one, a session referenced by a saved workspace, or
// (critically) another app instance's session on the same host.
func TestPersist_ReapsOrphans(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	srv.setTmux(true)
	m := NewManager(context.Background())
	m.SetAppInstanceID("ti")
	// "keepme" is referenced by a saved workspace → must survive.
	m.SetWorkspaceTmuxIDs(func() []string { return []string{"keepme"} })
	defer m.CloseAll()

	// Pre-seed detached sessions on the fake remote.
	orphan := tmuxName("ti", "orphan")     // ours, unreferenced → reap
	referenced := tmuxName("ti", "keepme") // ours, workspace-referenced → keep
	foreign := "hopperxterm-other-zzz"     // another instance → never touch
	srv.tmuxAdd(orphan)
	srv.tmuxAdd(referenced)
	srv.tmuxAdd(foreign)

	sess := profile.Session{
		ID: "ssh-reap", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
		Persist: true,
	}
	// Opening a persistent pane creates its own (attached) session AND triggers
	// the reaper on the same host.
	if err := m.OpenInDir("pane-reap", sess, "", "live", true); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-reap")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })

	// The unreferenced orphan is reaped…
	poll(t, 5*time.Second, func() bool { return !srv.tmuxHas(orphan) })
	// …while everything protected survives.
	if !srv.tmuxHas(referenced) {
		t.Error("reaped a workspace-referenced session")
	}
	if !srv.tmuxHas(foreign) {
		t.Error("reaped another app instance's session — isolation broken")
	}
	if !srv.tmuxHas(tmuxName("ti", "live")) {
		t.Error("reaped the live attached session")
	}
}
