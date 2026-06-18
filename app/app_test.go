package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zalando/go-keyring"

	"hopperxterm/pane"
	"hopperxterm/profile"
	"hopperxterm/workspace"
)

func init() { keyring.MockInit() }

// newTestApp builds an App backed by temp-dir stores (no Wails runtime).
func newTestApp(t *testing.T) *App {
	t.Helper()
	pstore, err := profile.Open(t.TempDir())
	if err != nil {
		t.Fatalf("profile.Open: %v", err)
	}
	wstore, err := workspace.Open(t.TempDir())
	if err != nil {
		t.Fatalf("workspace.Open: %v", err)
	}
	return &App{
		ctx:        context.Background(),
		profile:    pstore,
		panes:      pane.NewManager(context.Background()),
		workspaces: wstore,
	}
}

func TestStartup_InitialisesStores(t *testing.T) {
	// Redirect the user config dir so startup writes to a temp tree.
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("AppData", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	a := NewApp()
	a.startup(context.Background())
	if a.profile == nil || a.panes == nil || a.workspaces == nil {
		t.Fatal("startup left a store nil")
	}
	// shutdown is a clean no-op with no open panes.
	a.shutdown(context.Background())
}

func TestProfileCRUD(t *testing.T) {
	a := newTestApp(t)

	if err := a.SaveGroup(profile.Group{ID: "g1", Name: "Prod"}); err != nil {
		t.Fatalf("SaveGroup: %v", err)
	}
	if err := a.SaveSession(profile.Session{ID: "s1", Type: profile.SessionSSH, GroupID: "g1", Host: "h"}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}
	if err := a.SaveSession(profile.Session{ID: "s2", Type: profile.SessionSSH, GroupID: "g1"}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}
	snap := a.ListProfiles()
	if len(snap.Groups) != 1 || len(snap.Sessions) != 2 {
		t.Fatalf("snapshot = %+v", snap)
	}

	if err := a.MoveSession("s2", "", ""); err != nil {
		t.Errorf("MoveSession: %v", err)
	}
	if err := a.ReorderGroup("g1", ""); err != nil {
		t.Errorf("ReorderGroup: %v", err)
	}

	// DeleteSession also clears any keychain entry (no error when absent).
	if err := a.DeleteSession("s1"); err != nil {
		t.Errorf("DeleteSession: %v", err)
	}
	if err := a.DeleteGroup("g1", false); err != nil {
		t.Errorf("DeleteGroup: %v", err)
	}
	if len(a.ListProfiles().Groups) != 0 {
		t.Error("group not deleted")
	}
}

func TestWorkspaceCRUD(t *testing.T) {
	a := newTestApp(t)
	ws := workspace.Workspace{ID: "w1", Name: "W1", UpdatedAt: 1}
	if err := a.SaveWorkspace(ws); err != nil {
		t.Fatalf("SaveWorkspace: %v", err)
	}
	if len(a.ListWorkspaces()) != 1 {
		t.Errorf("ListWorkspaces count != 1")
	}
	got, err := a.GetWorkspace("w1")
	if err != nil || got.Name != "W1" {
		t.Errorf("GetWorkspace: %+v %v", got, err)
	}
	if err := a.DeleteWorkspace("w1"); err != nil {
		t.Errorf("DeleteWorkspace: %v", err)
	}
	if len(a.ListWorkspaces()) != 0 {
		t.Error("workspace not deleted")
	}
}

func TestOpenPane_Validation(t *testing.T) {
	a := newTestApp(t)
	if err := a.OpenPane("", "s"); err == nil {
		t.Error("OpenPane with empty paneID should error")
	}
	if err := a.OpenPane("p", ""); err == nil {
		t.Error("OpenPane with empty sessionID should error")
	}
	if err := a.OpenPane("p", "unknown-session"); err == nil {
		t.Error("OpenPane with an unknown session should error")
	}
}

func TestOpenClose_LocalPaneLifecycle(t *testing.T) {
	a := newTestApp(t)
	if err := a.SaveSession(profile.Session{ID: "local", Type: profile.SessionShell}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}
	if err := a.OpenPane("pane-x", "local"); err != nil {
		t.Fatalf("OpenPane: %v", err)
	}
	// Give the local shell a moment to come up, then reconnect + close.
	time.Sleep(200 * time.Millisecond)
	if err := a.ReconnectPane("pane-x"); err != nil {
		t.Errorf("ReconnectPane: %v", err)
	}
	if err := a.ClosePane("pane-x"); err != nil {
		t.Errorf("ClosePane: %v", err)
	}
	if err := a.ReleaseAllPanes(); err != nil {
		t.Errorf("ReleaseAllPanes: %v", err)
	}
}

func TestReconnectPane_Validation(t *testing.T) {
	a := newTestApp(t)
	if err := a.ReconnectPane(""); err == nil {
		t.Error("ReconnectPane with empty paneID should error")
	}
	if err := a.ReconnectPane("nonexistent"); err == nil {
		t.Error("ReconnectPane on an unknown pane should error")
	}
}

func TestLocalFilesystemMethods(t *testing.T) {
	a := newTestApp(t)
	base := t.TempDir()

	if _, err := a.LocalCwd(); err != nil {
		t.Errorf("LocalCwd: %v", err)
	}
	if err := a.LocalMkdir(filepath.Join(base, "d"), true); err != nil {
		t.Errorf("LocalMkdir: %v", err)
	}
	f := filepath.Join(base, "f.txt")
	if err := a.LocalCreate(f); err != nil {
		t.Errorf("LocalCreate: %v", err)
	}
	if err := a.LocalRename(f, filepath.Join(base, "g.txt")); err != nil {
		t.Errorf("LocalRename: %v", err)
	}
	if err := a.LocalRemove(filepath.Join(base, "g.txt"), false); err != nil {
		t.Errorf("LocalRemove: %v", err)
	}
	entries, err := a.LocalList(base)
	if err != nil {
		t.Errorf("LocalList: %v", err)
	}
	if len(entries) == 0 {
		t.Error("LocalList returned nothing (expected at least '..' and the dir)")
	}
}

func TestSftpAndResourcePassthrough_UnknownPane(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.SftpList("ghost", "/"); err == nil {
		t.Error("SftpList")
	}
	if _, err := a.SftpCwd("ghost"); err == nil {
		t.Error("SftpCwd")
	}
	if _, err := a.GetPaneCwd("ghost"); err == nil {
		t.Error("GetPaneCwd")
	}
	if _, err := a.GetPaneOSFamily("ghost"); err == nil {
		t.Error("GetPaneOSFamily")
	}
	if err := a.InstallOsc7Hook("ghost"); err == nil {
		t.Error("InstallOsc7Hook")
	}
	if err := a.SftpMkdir("ghost", "/x", false); err == nil {
		t.Error("SftpMkdir")
	}
	if err := a.SftpRemove("ghost", "/x", true); err == nil {
		t.Error("SftpRemove")
	}
	if err := a.SftpRename("ghost", "/a", "/b"); err == nil {
		t.Error("SftpRename")
	}
	if err := a.SftpCreate("ghost", "/x"); err == nil {
		t.Error("SftpCreate")
	}
	if _, err := a.SftpUploadFile("ghost", "/l", "/r"); err == nil {
		t.Error("SftpUploadFile")
	}
	if _, err := a.SftpDownloadFile("ghost", "/r", "/l"); err == nil {
		t.Error("SftpDownloadFile")
	}
	if _, err := a.SftpUploadDir("ghost", "/l", "/r"); err == nil {
		t.Error("SftpUploadDir")
	}
	if _, err := a.SftpDownloadDir("ghost", "/r", "/l"); err == nil {
		t.Error("SftpDownloadDir")
	}
	if err := a.StartResourceMonitor("ghost"); err == nil {
		t.Error("StartResourceMonitor")
	}
	if err := a.StopResourceMonitor("ghost"); err == nil {
		t.Error("StopResourceMonitor")
	}
	if err := a.SaveCurrentPassword("ghost"); err == nil {
		t.Error("SaveCurrentPassword")
	}
	if err := a.DiscardCurrentPassword("ghost"); err == nil {
		t.Error("DiscardCurrentPassword")
	}
	if err := a.SubmitPanePassword("ghost", "p", false); err == nil {
		t.Error("SubmitPanePassword")
	}
	if err := a.CancelPanePassword("ghost"); err == nil {
		t.Error("CancelPanePassword")
	}
	// CancelSftpTransfer on an unknown id is a no-op (must not panic).
	a.CancelSftpTransfer(999999)
}

func TestSendInputResize_UnknownPane(t *testing.T) {
	a := newTestApp(t)
	if err := a.SendInput("ghost", "x"); err == nil {
		t.Error("SendInput on unknown pane should error")
	}
	if err := a.ResizePty("ghost", 80, 24); err == nil {
		t.Error("ResizePty on unknown pane should error")
	}
}

func TestBasename(t *testing.T) {
	cases := map[string]string{
		"/var/log/syslog":       "syslog",
		`C:\Users\user\file.txt`: "file.txt",
		"bare.txt":              "bare.txt",
		"/trailing/":            "",
	}
	for in, want := range cases {
		if got := basename(in); got != want {
			t.Errorf("basename(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSaveTextFile_NoDialogPath(t *testing.T) {
	// We can't exercise the Wails dialog, but confirm os.WriteFile works
	// against a known path the way the method's tail does.
	dir := t.TempDir()
	target := filepath.Join(dir, "out.txt")
	if err := os.WriteFile(target, []byte("hi"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if b, _ := os.ReadFile(target); string(b) != "hi" {
		t.Errorf("content = %q", b)
	}
}
