// Package extedit implements the "open a remote file in an external app and
// edit it in place" round-trip: a remote file is downloaded to a local temp
// copy, handed to an external program (a forced text editor, or the OS "open
// with" association / chooser), then watched — every time the local copy is
// saved, it's re-uploaded to the same remote path.
//
// The lifetime of an edit session is owned by HopperXterm, not the editor: we
// launch the app detached and can't reliably learn when it closes (the real
// editor is often a pre-existing process the launcher hands off to), so a
// session runs until the user stops it, the pane is closed, or the app exits.
//
// Resilience is deliberate: a failed upload (a dropped/suspect connection)
// keeps the temp copy and retries on the next stable change, so the user's
// edits are never lost — matching HopperXterm's flaky-connection focus.
package extedit

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"hopperxterm/events"
	"hopperxterm/logbook"
)

// Transferer is the subset of the pane manager the watcher needs. Both
// methods are synchronous (block until the transfer finishes or errors), so
// the download completes before we launch the editor and an upload's outcome
// is known immediately. *pane.Manager satisfies this directly.
type Transferer interface {
	SftpDownload(paneID, remote, local string) (uint64, error)
	SftpUpload(paneID, local, remote string) (uint64, error)
}

// Info is one active edit session, surfaced to the frontend's active-edits UI.
type Info struct {
	ID         string `json:"id"`
	PaneID     string `json:"paneId"`
	RemotePath string `json:"remotePath"`
	LocalPath  string `json:"localPath"`
}

// session is one live edit: a remote file mirrored to a local temp copy,
// watched by a goroutine that uploads on save. cancel stops the watcher.
type session struct {
	id         string
	paneID     string
	remotePath string
	localPath  string
	baseSig    string // signature of the downloaded copy — the watcher's starting point
	cancel     context.CancelFunc
}

// Manager owns every active edit session. Goroutine-safe.
type Manager struct {
	ctx        context.Context
	tx         Transferer
	editorPref func() string // configured external editor command, "" = OS default

	tmpRoot string
	seq     atomic.Uint64

	// launcher runs the external program. A field so tests can inject a
	// no-op instead of really launching notepad / open / xdg-open.
	launcher func(local string, useEditor bool, editor string) error

	mu       sync.Mutex
	sessions map[string]*session
}

// pollInterval is how often the watcher restats the local copy. A save is
// only acted on once the file's signature is stable across two ticks
// (debounce), so an editor mid-write doesn't trigger a partial upload.
// A var (not const) so tests can shorten it.
var pollInterval = 750 * time.Millisecond

// uploadRetryCooldown throttles re-attempts after a failed upload so a dead
// connection isn't hammered every tick — the edit just keeps retrying slowly.
var uploadRetryCooldown = 5 * time.Second

// New builds a manager. editorPref returns the user's configured external
// editor command (empty for the OS default). tmpRoot is wiped on startup to
// clear temp copies orphaned by a previous crash.
func New(ctx context.Context, tx Transferer, editorPref func() string) *Manager {
	root := filepath.Join(os.TempDir(), "hopperxterm-edit")
	_ = os.RemoveAll(root)
	return &Manager{
		ctx:        ctx,
		tx:         tx,
		editorPref: editorPref,
		tmpRoot:    root,
		launcher:   launch,
		sessions:   make(map[string]*session),
	}
}

// Open downloads remotePath to a local temp copy, launches it, and starts
// watching for saves. useEditor true forces a text editor; false uses the OS
// "open with" path (native chooser on Windows, default association elsewhere).
// Opening a file already being edited reuses the existing session (and just
// re-launches the app), so a double-open doesn't race two watchers.
func (m *Manager) Open(paneID, remotePath string, useEditor bool) (string, error) {
	if paneID == "" || remotePath == "" {
		return "", errors.New("extedit: paneID and remotePath required")
	}

	// Reuse an existing session for the same (pane, path): re-launch and return.
	m.mu.Lock()
	if id, local, ok := m.findSessionLocked(paneID, remotePath); ok {
		m.mu.Unlock()
		// Surface a relaunch failure (e.g. the editor binary went missing)
		// rather than silently reporting success.
		return id, m.launcher(local, useEditor, m.editorPref())
	}
	m.mu.Unlock()

	id := fmt.Sprintf("edit-%d", m.seq.Add(1))
	dir := filepath.Join(m.tmpRoot, id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("extedit: temp dir: %w", err)
	}
	local := filepath.Join(dir, sanitizeName(path.Base(remotePath)))

	// Synchronous download — the temp copy is fully written before we launch.
	if _, err := m.tx.SftpDownload(paneID, remotePath, local); err != nil {
		_ = os.RemoveAll(dir)
		return "", err
	}
	_ = os.Chmod(local, 0o600) // remote content at rest — owner-only

	if err := m.launcher(local, useEditor, m.editorPref()); err != nil {
		_ = os.RemoveAll(dir)
		return "", fmt.Errorf("extedit: launch: %w", err)
	}

	// Seed the change baseline from the freshly-downloaded copy *now*, before
	// the watcher starts, so a save that lands between launch and the first
	// poll isn't mistaken for the baseline (and silently dropped).
	ctx, cancel := context.WithCancel(context.Background())
	s := &session{
		id: id, paneID: paneID, remotePath: remotePath, localPath: local,
		baseSig: fileSig(local), cancel: cancel,
	}
	m.mu.Lock()
	// Re-check under the lock: a concurrent Open for the same (pane, path)
	// may have inserted while we were downloading. If so, keep the winner and
	// discard this one — so a double-open never leaves two watchers running.
	if winner, _, ok := m.findSessionLocked(paneID, remotePath); ok {
		m.mu.Unlock()
		cancel()
		_ = os.RemoveAll(dir)
		return winner, nil
	}
	m.sessions[id] = s
	m.mu.Unlock()

	logbook.Info("extedit: started " + id + " for " + remotePath)
	m.emit(s, "started", "")
	go m.watch(ctx, s)
	return id, nil
}

// watch polls the local copy and uploads on a stable change. It runs until
// the session's context is cancelled (Stop / pane close / shutdown).
func (m *Manager) watch(ctx context.Context, s *session) {
	// baseSig (the downloaded copy) is the starting point, captured in Open
	// before this goroutine started so an early save isn't lost.
	uploaded := s.baseSig
	prev := uploaded
	var cooldownUntil time.Time
	sr := &sigReader{}

	t := time.NewTicker(pollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}

		sig := sr.read(s.localPath)
		if sig == "" {
			continue // stat failed — editor may be mid atomic-save (write+rename)
		}
		if sig == uploaded {
			prev = sig
			continue // unchanged since last successful upload
		}
		if sig != prev {
			prev = sig
			continue // changed but not yet stable — wait one more tick
		}
		// Stable change: upload (unless we're cooling down after a failure).
		if time.Now().Before(cooldownUntil) {
			continue
		}
		_, err := m.tx.SftpUpload(s.paneID, s.localPath, s.remotePath)
		// If the session was stopped while the (synchronous) upload was in
		// flight, don't emit — a late saved/error would resurrect a row the
		// UI already removed.
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			logbook.Error("extedit: upload failed " + s.id + ": " + err.Error())
			m.emit(s, "error", err.Error())
			cooldownUntil = time.Now().Add(uploadRetryCooldown)
			continue
		}
		uploaded = sig
		logbook.Info("extedit: saved " + s.remotePath)
		m.emit(s, "saved", "")
	}
}

// Stop ends one edit session: stops the watcher and removes the temp copy.
// Unknown IDs are a no-op so the frontend can call it idempotently.
func (m *Manager) Stop(id string) error {
	m.mu.Lock()
	s, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if !ok {
		return nil
	}
	m.teardown(s)
	return nil
}

// StopForPane ends every edit session bound to a pane — called when the user
// closes that pane. (A reconnect closes the pane at the manager level, not via
// App.ClosePane, so edits survive a reconnect and resume uploading.)
func (m *Manager) StopForPane(paneID string) {
	m.mu.Lock()
	var doomed []*session
	for id, s := range m.sessions {
		if s.paneID == paneID {
			doomed = append(doomed, s)
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()
	for _, s := range doomed {
		m.teardown(s)
	}
}

// StopAll ends every edit session — used on a frontend reload and on shutdown.
func (m *Manager) StopAll() {
	m.mu.Lock()
	doomed := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		doomed = append(doomed, s)
	}
	m.sessions = make(map[string]*session)
	m.mu.Unlock()
	for _, s := range doomed {
		m.teardown(s)
	}
}

// Shutdown stops everything and removes the whole temp root.
func (m *Manager) Shutdown() {
	m.StopAll()
	_ = os.RemoveAll(m.tmpRoot)
}

// OpenLocal launches a local file directly in an external app — no temp copy
// and no watcher, since the app edits the real file in place. useEditor true
// forces a text editor; false uses the OS "open with" path (Windows chooser /
// default association elsewhere). Used by the dual-pane browser's local side.
func (m *Manager) OpenLocal(path string, useEditor bool) error {
	if path == "" {
		return errors.New("extedit: path required")
	}
	if err := m.launcher(path, useEditor, m.editorPref()); err != nil {
		return fmt.Errorf("extedit: launch: %w", err)
	}
	return nil
}

// List returns the active edit sessions (order unspecified).
func (m *Manager) List() []Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Info, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, Info{ID: s.id, PaneID: s.paneID, RemotePath: s.remotePath, LocalPath: s.localPath})
	}
	return out
}

func (m *Manager) teardown(s *session) {
	s.cancel()
	_ = os.RemoveAll(filepath.Dir(s.localPath))
	m.emit(s, "stopped", "")
}

func (m *Manager) emit(s *session, state, errMsg string) {
	events.EmitExtEdit(m.ctx, events.ExtEditPayload{
		ID: s.id, PaneID: s.paneID, RemotePath: s.remotePath, State: state, Error: errMsg,
	})
}

// launch runs the external program detached, reaping it in the background so
// it doesn't linger as a zombie.
func launch(local string, useEditor bool, editor string) error {
	var cmd *exec.Cmd
	if useEditor {
		cmd = openInEditor(local, editor)
	} else {
		cmd = openWith(local)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// findSessionLocked returns the id + local path of an active session for the
// given (pane, remotePath), if one exists. Callers must hold m.mu.
func (m *Manager) findSessionLocked(paneID, remotePath string) (id, local string, ok bool) {
	for _, s := range m.sessions {
		if s.paneID == paneID && s.remotePath == remotePath {
			return s.id, s.localPath, true
		}
	}
	return "", "", false
}

// fileSig is the one-shot content-hash signature used to seed a session's
// baseline. Returns "" if the file can't be read. The watcher uses sigReader
// (a stat-gated variant) for its hot poll loop.
func fileSig(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// sigReader computes a content-hash change signature with a size+mtime fast
// path: it re-hashes only when the file's size or mtime changed since the last
// read, so a large unmodified file isn't re-hashed on every 750ms poll. A
// content hash (not size+mtime alone) is what's compared, so a same-size edit
// is still detected — and because polls are ≥750ms apart while the OS clock's
// mtime resolution is far finer, any real save between two polls always shows a
// new mtime and triggers a re-hash. Returns "" if the file is unreadable (e.g.
// mid atomic-save). One per watcher; not safe for concurrent use.
type sigReader struct {
	size  int64
	mtime int64
	hash  string
}

func (r *sigReader) read(p string) string {
	st, err := os.Stat(p)
	if err != nil {
		return ""
	}
	size, mtime := st.Size(), st.ModTime().UnixNano()
	if r.hash != "" && size == r.size && mtime == r.mtime {
		return r.hash // unchanged since last read — skip the hash
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	h := hex.EncodeToString(sum[:])
	r.size, r.mtime, r.hash = size, mtime, h
	return h
}

// sanitizeName makes a remote basename safe to use as a local filename while
// preserving the extension (so the editor picks the right syntax/association).
// Falls back to "file" for empty / dot-only names.
func sanitizeName(name string) string {
	name = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|', 0:
			return '_'
		}
		return r
	}, name)
	if name == "" || name == "." || name == ".." {
		return "file"
	}
	return name
}
