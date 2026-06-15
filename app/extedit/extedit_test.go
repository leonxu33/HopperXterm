package extedit

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"
)

// fakeTx simulates the pane manager's file transfers against the local temp
// copy: a download writes seeded bytes to the local path; an upload reads the
// local copy back. failUploads forces upload errors to exercise retry.
type fakeTx struct {
	mu          sync.Mutex
	downloadSrc []byte
	uploads     [][]byte // content of each successful upload, in order
	failUploads bool
}

func (f *fakeTx) SftpDownload(_, _, local string) (uint64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := os.WriteFile(local, f.downloadSrc, 0o600); err != nil {
		return 0, err
	}
	return uint64(len(f.downloadSrc)), nil
}

func (f *fakeTx) SftpUpload(_, local, _ string) (uint64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failUploads {
		return 0, errors.New("upload failed (simulated)")
	}
	b, err := os.ReadFile(local)
	if err != nil {
		return 0, err
	}
	f.uploads = append(f.uploads, b)
	return uint64(len(b)), nil
}

func (f *fakeTx) setFail(v bool) { f.mu.Lock(); f.failUploads = v; f.mu.Unlock() }

func (f *fakeTx) lastUpload() []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.uploads) == 0 {
		return nil
	}
	return f.uploads[len(f.uploads)-1]
}

func (f *fakeTx) uploadCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.uploads)
}

// newTestManager builds a Manager with a no-op launcher, an isolated temp
// root, and fast polling so the watcher round-trips quickly.
func newTestManager(t *testing.T, tx Transferer) *Manager {
	t.Helper()
	pollInterval = 10 * time.Millisecond
	uploadRetryCooldown = 30 * time.Millisecond
	m := New(context.Background(), tx, func() string { return "" })
	m.tmpRoot = t.TempDir()
	m.launcher = func(string, bool, string) error { return nil }
	t.Cleanup(m.Shutdown)
	return m
}

// waitFor polls cond until true or the timeout elapses.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return cond()
}

func TestOpenDownloadsAndDoesNotImmediatelyUpload(t *testing.T) {
	tx := &fakeTx{downloadSrc: []byte("v1")}
	m := newTestManager(t, tx)

	id, err := m.Open("pane1", "/remote/file.txt", true)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if id == "" {
		t.Fatal("Open returned empty id")
	}
	// The freshly-downloaded copy is the baseline — no upload should fire.
	time.Sleep(60 * time.Millisecond)
	if n := tx.uploadCount(); n != 0 {
		t.Fatalf("expected no upload for an unmodified copy, got %d", n)
	}
	if got := len(m.List()); got != 1 {
		t.Fatalf("expected 1 active edit, got %d", got)
	}
}

func TestSaveTriggersUpload(t *testing.T) {
	tx := &fakeTx{downloadSrc: []byte("v1")}
	m := newTestManager(t, tx)

	id, err := m.Open("pane1", "/remote/file.txt", true)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	local := m.List()[0].LocalPath

	// Simulate the external editor saving new content.
	if err := os.WriteFile(local, []byte("edited!"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if !waitFor(t, time.Second, func() bool { return tx.uploadCount() == 1 }) {
		t.Fatalf("expected 1 upload after save, got %d", tx.uploadCount())
	}
	if got := string(tx.lastUpload()); got != "edited!" {
		t.Fatalf("uploaded content = %q, want %q", got, "edited!")
	}
	_ = m.Stop(id)
}

func TestUploadRetriesAfterFailure(t *testing.T) {
	tx := &fakeTx{downloadSrc: []byte("v1"), failUploads: true}
	m := newTestManager(t, tx)

	if _, err := m.Open("pane1", "/remote/file.txt", true); err != nil {
		t.Fatalf("Open: %v", err)
	}
	local := m.List()[0].LocalPath
	if err := os.WriteFile(local, []byte("v2"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	// While uploads fail, nothing is recorded.
	time.Sleep(80 * time.Millisecond)
	if n := tx.uploadCount(); n != 0 {
		t.Fatalf("expected no successful upload while failing, got %d", n)
	}
	// Connection recovers — the watcher must retry and eventually succeed
	// without the user re-saving (edits are never lost).
	tx.setFail(false)
	if !waitFor(t, time.Second, func() bool { return tx.uploadCount() >= 1 }) {
		t.Fatal("expected upload to succeed after recovery")
	}
	if got := string(tx.lastUpload()); got != "v2" {
		t.Fatalf("uploaded content = %q, want %q", got, "v2")
	}
}

func TestStopRemovesTempCopyAndSession(t *testing.T) {
	tx := &fakeTx{downloadSrc: []byte("v1")}
	m := newTestManager(t, tx)

	id, err := m.Open("pane1", "/remote/file.txt", true)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	local := m.List()[0].LocalPath
	if _, err := os.Stat(local); err != nil {
		t.Fatalf("temp copy should exist: %v", err)
	}
	if err := m.Stop(id); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if got := len(m.List()); got != 0 {
		t.Fatalf("expected 0 active edits after Stop, got %d", got)
	}
	if !waitFor(t, time.Second, func() bool { _, err := os.Stat(local); return os.IsNotExist(err) }) {
		t.Fatal("temp copy should be removed after Stop")
	}
}

func TestOpenSameFileReusesSession(t *testing.T) {
	tx := &fakeTx{downloadSrc: []byte("v1")}
	m := newTestManager(t, tx)

	id1, err := m.Open("pane1", "/remote/file.txt", true)
	if err != nil {
		t.Fatalf("Open #1: %v", err)
	}
	id2, err := m.Open("pane1", "/remote/file.txt", false)
	if err != nil {
		t.Fatalf("Open #2: %v", err)
	}
	if id1 != id2 {
		t.Fatalf("reopening same file should reuse the session: %q vs %q", id1, id2)
	}
	if got := len(m.List()); got != 1 {
		t.Fatalf("expected 1 session for a re-opened file, got %d", got)
	}
}

func TestOpenLocalLaunchesWithoutSession(t *testing.T) {
	m := newTestManager(t, &fakeTx{})
	var gotPath string
	var gotEditor bool
	calls := 0
	m.launcher = func(path string, useEditor bool, _ string) error {
		calls++
		gotPath = path
		gotEditor = useEditor
		return nil
	}
	if err := m.OpenLocal("/tmp/foo.txt", true); err != nil {
		t.Fatalf("OpenLocal: %v", err)
	}
	// It must launch exactly once, with the path and useEditor=true passed through.
	if calls != 1 || gotPath != "/tmp/foo.txt" || !gotEditor {
		t.Fatalf("launcher not invoked as expected: calls=%d path=%q editor=%v", calls, gotPath, gotEditor)
	}
	// OpenLocal edits in place — it must not register a session or temp copy.
	if got := len(m.List()); got != 0 {
		t.Fatalf("OpenLocal should not register a session, got %d", got)
	}
}

func TestOpenLocalRequiresPath(t *testing.T) {
	m := newTestManager(t, &fakeTx{})
	if err := m.OpenLocal("", true); err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestStopForPaneStopsOnlyThatPane(t *testing.T) {
	tx := &fakeTx{downloadSrc: []byte("v1")}
	m := newTestManager(t, tx)

	if _, err := m.Open("pane1", "/a.txt", true); err != nil {
		t.Fatalf("Open a: %v", err)
	}
	if _, err := m.Open("pane2", "/b.txt", true); err != nil {
		t.Fatalf("Open b: %v", err)
	}
	m.StopForPane("pane1")
	list := m.List()
	if len(list) != 1 || list[0].PaneID != "pane2" {
		t.Fatalf("StopForPane('pane1') should leave only pane2, got %+v", list)
	}
}
