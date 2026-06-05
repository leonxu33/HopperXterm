package pane

import (
	"context"
	"path/filepath"
	"testing"

	"hopperxterm/profile"
)

func TestManager_OpenS3(t *testing.T) {
	// DialS3 resolves config without touching the network, so connectS3
	// reaches Connected even with no real bucket behind it.
	m := NewManager(context.Background())
	defer m.CloseAll()
	sess := profile.Session{ID: "s3-1", Type: profile.SessionAWS, Bucket: "my-bucket", Region: "us-east-1"}
	if err := m.Open("pane-s3", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-s3")
	if p.State() != StateConnected {
		t.Errorf("S3 pane state = %s, want Connected", p.State())
	}
}

func TestManager_OpenSFTPOnly(t *testing.T) {
	isolateHome(t)
	srv := startPaneSSHServer(t)
	m := NewManager(context.Background())
	defer m.CloseAll()

	sess := profile.Session{
		ID: "sftp-1", Type: profile.SessionSFTP,
		Host: srv.Host, Port: srv.Port, User: "tester", PemFile: srv.KeyPath,
	}
	if err := m.Open("pane-sftp", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, _ := m.get("pane-sftp")
	if p.State() != StateConnected {
		t.Fatalf("SFTP-only pane state = %s, want Connected", p.State())
	}
	// File client was set eagerly at connect; a listing works.
	if _, err := m.SftpList("pane-sftp", filepath.ToSlash(t.TempDir())); err != nil {
		t.Errorf("SftpList on SFTP-only pane: %v", err)
	}
}

func TestManager_OpenWSL(t *testing.T) {
	// On Windows WSL may or may not be installed; on other platforms the
	// transport errors out. Either way connectWSL runs and the pane ends
	// up Connected or Disconnected — just exercise the path.
	m := NewManager(context.Background())
	defer m.CloseAll()
	sess := profile.Session{ID: "wsl-1", Type: profile.SessionWSL}
	if err := m.Open("pane-wsl", sess); err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, ok := m.get("pane-wsl"); !ok {
		t.Error("WSL pane should be registered")
	}
}

func TestConnect_UnsupportedType(t *testing.T) {
	p := newPane(context.Background(), "p", profile.Session{ID: "x", Type: profile.SessionType("bogus")})
	if err := p.connect(profile.Session{ID: "x", Type: profile.SessionType("bogus")}); err == nil {
		t.Error("connect with an unsupported session type should error")
	}
}
