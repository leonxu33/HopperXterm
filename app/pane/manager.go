package pane

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"hopperxterm/profile"
	"hopperxterm/transport"
)

// Manager is the registry of live panes. Goroutine-safe.
type Manager struct {
	appCtx context.Context

	mu    sync.RWMutex
	panes map[string]*Pane
}

func NewManager(appCtx context.Context) *Manager {
	return &Manager{
		appCtx: appCtx,
		panes:  make(map[string]*Pane),
	}
}

// Open dials the session in a fresh pane. paneID must be unique — opening
// the same paneID twice without closing in between returns an error.
//
// The Pane is registered in the map BEFORE the (potentially long) connect
// step so that SendInput / Resize / Close can find it while the handshake
// is in progress. Interactive auth in particular depends on this:
// the auth callback emits a prompt and blocks waiting for SendInput,
// which is called from the frontend before Open returns.
//
// Connect failures (wrong password, host unreachable, etc.) leave the
// pane in the map in Disconnected state. The frontend's Terminal stays
// subscribed and shows the error from `emitTerminalError` directly on
// the canvas; `ReconnectPane` can look up the sessionID via this same
// map entry and re-dial in place. Open returns nil for connect failures
// so the frontend doesn't double-report the error as a banner — the
// error is already visible in the pane's own output stream.
func (m *Manager) Open(paneID string, sess profile.Session) error {
	return m.OpenInDir(paneID, sess, "")
}

// OpenInDir is Open with an initial working directory the shell cd's into
// once ready — used by workspace restore to land a pane back in its saved
// cwd. dir == "" behaves exactly like Open.
func (m *Manager) OpenInDir(paneID string, sess profile.Session, dir string) error {
	m.mu.Lock()
	if _, exists := m.panes[paneID]; exists {
		m.mu.Unlock()
		return fmt.Errorf("pane: %s already open", paneID)
	}
	p := newPane(m.appCtx, paneID, sess)
	p.initialDir = dir
	m.panes[paneID] = p
	m.mu.Unlock()

	// Ignore connect errors: the pane has already emitted them via
	// pane:output (red ANSI for terminal panes) and connection:log;
	// keeping the pane in the map lets the user press 'r' to retry.
	_ = p.connect(sess)
	return nil
}

// Close terminates the pane if it exists; no-op otherwise so callers can
// treat ClosePane as idempotent.
func (m *Manager) Close(paneID string) error {
	m.mu.Lock()
	p, ok := m.panes[paneID]
	if !ok {
		m.mu.Unlock()
		return nil
	}
	delete(m.panes, paneID)
	m.mu.Unlock()

	p.Close()
	return nil
}

// CloseAll shuts every pane down, e.g. on app exit. Best-effort; logs no
// errors itself but returns the first failure if any pane fails to close.
func (m *Manager) CloseAll() error {
	m.mu.Lock()
	ids := make([]string, 0, len(m.panes))
	for id := range m.panes {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	var firstErr error
	for _, id := range ids {
		if err := m.Close(id); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// SessionIDOf returns the sessionID this pane was opened against.
// Used by ReconnectPane to re-dial the same session after a drop.
func (m *Manager) SessionIDOf(paneID string) (string, bool) {
	p, ok := m.get(paneID)
	if !ok {
		return "", false
	}
	return p.SessionID, true
}

// SendInput forwards keystrokes to the named pane.
func (m *Manager) SendInput(paneID string, data string) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	return p.SendInput([]byte(data))
}

// Resize tells the named pane to send a window-change to the remote.
func (m *Manager) Resize(paneID string, cols, rows int) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	return p.Resize(cols, rows)
}

func (m *Manager) get(paneID string) (*Pane, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.panes[paneID]
	return p, ok
}

// SftpList lists dir on the pane's SFTP subsystem.
func (m *Manager) SftpList(paneID, dir string) ([]transport.Entry, error) {
	p, ok := m.get(paneID)
	if !ok {
		return nil, errors.New("pane: not found")
	}
	return p.SftpList(dir)
}

// SftpCwd returns the SFTP working directory.
func (m *Manager) SftpCwd(paneID string) (string, error) {
	p, ok := m.get(paneID)
	if !ok {
		return "", errors.New("pane: not found")
	}
	return p.SftpCwd()
}

// LastCwd returns the most recent cwd seen on the pane's PTY stream as
// an OSC 7 sequence, or "" if none has been captured yet.
func (m *Manager) LastCwd(paneID string) (string, error) {
	p, ok := m.get(paneID)
	if !ok {
		return "", errors.New("pane: not found")
	}
	return p.LastCwd(), nil
}

// OSFamily returns the pane's probed remote OS family ("linux"/"darwin"/
// "windows"), or "" if not an SSH pane or the probe hasn't landed yet.
func (m *Manager) OSFamily(paneID string) (string, error) {
	p, ok := m.get(paneID)
	if !ok {
		return "", errors.New("pane: not found")
	}
	return p.cachedOSFamily(), nil
}

// InstallOsc7Hook injects an OSC 7 emitter into the pane's shell so
// future prompt redraws emit a cwd that the readLoop can detect.
func (m *Manager) InstallOsc7Hook(paneID string) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	return p.InstallOsc7Hook()
}

// SftpMkdir creates a directory.
func (m *Manager) SftpMkdir(paneID, path string, parents bool) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	return p.SftpMkdir(path, parents)
}

// SftpCreate writes an empty file at the given remote path.
func (m *Manager) SftpCreate(paneID, path string) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	return p.SftpCreate(path)
}

// SftpRemove deletes a file or empty directory.
func (m *Manager) SftpRemove(paneID, path string, recursive bool) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	if recursive {
		return p.SftpRemoveAll(path)
	}
	return p.SftpRemove(path)
}

// SftpRename moves src to dst.
func (m *Manager) SftpRename(paneID, src, dst string) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	return p.SftpRename(src, dst)
}

// SftpDownload streams a remote file to disk; returns the transfer ID.
func (m *Manager) SftpDownload(paneID, remote, local string) (uint64, error) {
	p, ok := m.get(paneID)
	if !ok {
		return 0, errors.New("pane: not found")
	}
	return p.SftpDownload(remote, local)
}

// CancelTransfer signals a running upload/download by ID. Cooperative;
// in-flight reads may take a moment to surface the error.
func (m *Manager) CancelTransfer(id uint64) {
	CancelTransfer(id)
}

// SftpUploadDir recursively copies a local directory tree to remote.
func (m *Manager) SftpUploadDir(paneID, local, remote string) (uint64, error) {
	p, ok := m.get(paneID)
	if !ok {
		return 0, errors.New("pane: not found")
	}
	return p.SftpUploadDir(local, remote)
}

// SftpDownloadDir recursively copies a remote directory tree to local.
func (m *Manager) SftpDownloadDir(paneID, remote, local string) (uint64, error) {
	p, ok := m.get(paneID)
	if !ok {
		return 0, errors.New("pane: not found")
	}
	return p.SftpDownloadDir(remote, local)
}

// SftpUpload streams a local file to the remote.
func (m *Manager) SftpUpload(paneID, local, remote string) (uint64, error) {
	p, ok := m.get(paneID)
	if !ok {
		return 0, errors.New("pane: not found")
	}
	return p.SftpUpload(local, remote)
}

// SftpCopyRemote copies the named entries from srcDir on the source pane
// into dstDir on the destination pane — a server-to-server transfer for
// cross-pane drag-and-drop. The transfer (progress + cancel) is owned by
// the destination pane. Rejects a same-pane copy; the frontend also
// blocks same-session drops, so this is a defensive backstop.
func (m *Manager) SftpCopyRemote(srcPaneID, dstPaneID, srcDir string, names []string, dstDir string) (uint64, error) {
	if srcPaneID == dstPaneID {
		return 0, errors.New("pane: cannot copy to the same pane")
	}
	srcP, ok := m.get(srcPaneID)
	if !ok {
		return 0, errors.New("pane: source not found")
	}
	dstP, ok := m.get(dstPaneID)
	if !ok {
		return 0, errors.New("pane: destination not found")
	}
	srcClient, err := srcP.fileClient()
	if err != nil {
		return 0, err
	}
	return dstP.SftpRelayFrom(srcClient, srcDir, names, dstDir)
}

// StartResourceMonitor begins streaming resource:sample events for the pane.
func (m *Manager) StartResourceMonitor(paneID string) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	return p.StartResourceMonitor()
}

// StopResourceMonitor stops the resource poller for the pane.
func (m *Manager) StopResourceMonitor(paneID string) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	p.StopResourceMonitor()
	return nil
}

// SaveCurrentPassword persists the user-typed password from a recent
// interactive auth into the OS keychain. No-op if no password was
// captured (e.g. the pane logged in via SSH key).
func (m *Manager) SaveCurrentPassword(paneID string) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	return p.SaveCurrentPassword()
}

// DiscardCurrentPassword clears the in-memory typed password without
// persisting it. Used when the user picks "Don't save".
func (m *Manager) DiscardCurrentPassword(paneID string) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	p.DiscardCurrentPassword()
	return nil
}

// SubmitPanePassword delivers the user's typed password from the
// frontend modal back into the waiting pane prompter. `save` flags
// whether the keychain should persist it after a successful connect.
func (m *Manager) SubmitPanePassword(paneID, password string, save bool) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	return p.SubmitPanePassword(password, save)
}

// CancelPanePassword aborts a waiting modal prompt — the user
// dismissed the dialog. The connect attempt fails.
func (m *Manager) CancelPanePassword(paneID string) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	return p.CancelPanePassword()
}

// ResolveHostKeyChange delivers the user's accept/reject decision for a
// changed host key back to the waiting pane.
func (m *Manager) ResolveHostKeyChange(paneID string, accept bool) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	return p.ResolveHostKeyChange(accept)
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}
