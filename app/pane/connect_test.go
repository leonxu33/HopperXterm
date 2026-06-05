package pane

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"hopperxterm/profile"
)

func poll(t *testing.T, budget time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met within budget")
}

func TestManager_OpenLocalShell(t *testing.T) {
	m := NewManager(context.Background())
	defer m.CloseAll()

	sess := profile.Session{ID: "local-1", Type: profile.SessionShell, Label: "local"}
	if err := m.Open("pane-local", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, ok := m.get("pane-local")
	if !ok {
		t.Fatal("pane not registered")
	}
	poll(t, 3*time.Second, func() bool { return p.State() == StateConnected })

	// Manager delegation surfaces.
	if sid, ok := m.SessionIDOf("pane-local"); !ok || sid != "local-1" {
		t.Errorf("SessionIDOf = %q,%v", sid, ok)
	}
	if err := m.Resize("pane-local", 100, 30); err != nil {
		t.Errorf("Resize: %v", err)
	}
	if err := m.SendInput("pane-local", "echo hi\n"); err != nil {
		t.Errorf("SendInput: %v", err)
	}
	// Duplicate open is rejected.
	if err := m.Open("pane-local", sess); err == nil {
		t.Error("re-opening the same paneID should error")
	}
	if err := m.Close("pane-local"); err != nil {
		t.Errorf("Close: %v", err)
	}
	poll(t, 2*time.Second, func() bool { return p.State() == StateDisconnected })
}

func TestManager_NotFoundBranches(t *testing.T) {
	m := NewManager(context.Background())
	if err := m.SendInput("ghost", "x"); err == nil {
		t.Error("SendInput on unknown pane")
	}
	if err := m.Resize("ghost", 1, 1); err == nil {
		t.Error("Resize on unknown pane")
	}
	if _, err := m.SftpList("ghost", "/"); err == nil {
		t.Error("SftpList on unknown pane")
	}
	if _, err := m.SftpCwd("ghost"); err == nil {
		t.Error("SftpCwd on unknown pane")
	}
	if _, err := m.LastCwd("ghost"); err == nil {
		t.Error("LastCwd on unknown pane")
	}
	if err := m.InstallOsc7Hook("ghost"); err == nil {
		t.Error("InstallOsc7Hook on unknown pane")
	}
	if err := m.SftpMkdir("ghost", "/x", false); err == nil {
		t.Error("SftpMkdir on unknown pane")
	}
	if err := m.SftpCreate("ghost", "/x"); err == nil {
		t.Error("SftpCreate on unknown pane")
	}
	if err := m.SftpRemove("ghost", "/x", false); err == nil {
		t.Error("SftpRemove on unknown pane")
	}
	if err := m.SftpRename("ghost", "/a", "/b"); err == nil {
		t.Error("SftpRename on unknown pane")
	}
	if _, err := m.SftpDownload("ghost", "/r", "/l"); err == nil {
		t.Error("SftpDownload on unknown pane")
	}
	if _, err := m.SftpUpload("ghost", "/l", "/r"); err == nil {
		t.Error("SftpUpload on unknown pane")
	}
	if _, err := m.SftpUploadDir("ghost", "/l", "/r"); err == nil {
		t.Error("SftpUploadDir on unknown pane")
	}
	if _, err := m.SftpDownloadDir("ghost", "/r", "/l"); err == nil {
		t.Error("SftpDownloadDir on unknown pane")
	}
	if err := m.StartResourceMonitor("ghost"); err == nil {
		t.Error("StartResourceMonitor on unknown pane")
	}
	if err := m.StopResourceMonitor("ghost"); err == nil {
		t.Error("StopResourceMonitor on unknown pane")
	}
	if err := m.SaveCurrentPassword("ghost"); err == nil {
		t.Error("SaveCurrentPassword on unknown pane")
	}
	if err := m.DiscardCurrentPassword("ghost"); err == nil {
		t.Error("DiscardCurrentPassword on unknown pane")
	}
	if err := m.SubmitPanePassword("ghost", "p", false); err == nil {
		t.Error("SubmitPanePassword on unknown pane")
	}
	if err := m.CancelPanePassword("ghost"); err == nil {
		t.Error("CancelPanePassword on unknown pane")
	}
	if _, ok := m.SessionIDOf("ghost"); ok {
		t.Error("SessionIDOf should report not-found")
	}
	// Close of an unknown pane is a no-op (idempotent).
	if err := m.Close("ghost"); err != nil {
		t.Errorf("Close unknown pane should be nil: %v", err)
	}
}

func TestManager_OpenSSH_FullPath(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	m := NewManager(context.Background())
	defer m.CloseAll()

	sess := profile.Session{
		ID: "ssh-1", Type: profile.SessionSSH, Label: "ssh",
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
	}
	if err := m.Open("pane-ssh", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-ssh")
	poll(t, 5*time.Second, func() bool { return p.State() == StateConnected })

	// Lazy SFTP open through the pane's existing SSH client.
	base := filepath.ToSlash(t.TempDir())
	if err := m.SftpMkdir("pane-ssh", base+"/made", false); err != nil {
		t.Fatalf("SftpMkdir over SSH: %v", err)
	}
	entries, err := m.SftpList("pane-ssh", base)
	if err != nil {
		t.Fatalf("SftpList over SSH: %v", err)
	}
	found := false
	for _, e := range entries {
		if e.Name == "made" {
			found = true
		}
	}
	if !found {
		t.Errorf("created dir not in listing: %v", entries)
	}
	if _, err := m.SftpCwd("pane-ssh"); err != nil {
		t.Errorf("SftpCwd: %v", err)
	}

	// Resource monitor: the harness streams v3 lines; Start should succeed
	// and the refcount toggles cleanly.
	if err := m.StartResourceMonitor("pane-ssh"); err != nil {
		t.Fatalf("StartResourceMonitor: %v", err)
	}
	poll(t, 2*time.Second, func() bool {
		p.resMu.Lock()
		defer p.resMu.Unlock()
		return p.resOn
	})
	// Second Start just bumps the refcount.
	if err := m.StartResourceMonitor("pane-ssh"); err != nil {
		t.Fatalf("StartResourceMonitor x2: %v", err)
	}
	_ = m.StopResourceMonitor("pane-ssh") // still one consumer left
	_ = m.StopResourceMonitor("pane-ssh") // now zero → poller stops

	// InstallOsc7Hook writes into the (echoing) shell.
	if err := m.InstallOsc7Hook("pane-ssh"); err != nil {
		t.Errorf("InstallOsc7Hook: %v", err)
	}

	if err := m.Close("pane-ssh"); err != nil {
		t.Errorf("Close: %v", err)
	}
}

func TestManager_OpenSSH_DialFailure(t *testing.T) {
	isolateHome(t)
	m := NewManager(context.Background())
	defer m.CloseAll()

	// Point at a port nothing is listening on.
	sess := profile.Session{
		ID: "ssh-bad", Type: profile.SessionSSH,
		Host: "127.0.0.1", Port: 1, User: "tester",
	}
	if err := m.Open("pane-bad", sess); err != nil {
		t.Fatalf("Open returns nil even on dial failure: %v", err)
	}
	p, _ := m.get("pane-bad")
	poll(t, 5*time.Second, func() bool { return p.State() == StateDisconnected })
}

func TestStartResourceMonitor_RequiresSSH(t *testing.T) {
	// A pane with no SSH client can't start the /proc poller.
	p := newPane(context.Background(), "p", profile.Session{Type: profile.SessionShell})
	if err := p.StartResourceMonitor(); err == nil {
		t.Error("StartResourceMonitor without an SSH client should error")
	}
}
