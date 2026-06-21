package pane

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"hopperxterm/events"
	"hopperxterm/logbook"
	"hopperxterm/profile"
	"hopperxterm/transport"
)

// Manager is the registry of live panes. Goroutine-safe.
type Manager struct {
	appCtx context.Context

	mu    sync.RWMutex
	panes map[string]*Pane

	// Durable-session bookkeeping (Phase B). appInstanceID namespaces this
	// app instance's tmux sessions so the reaper only ever touches its own.
	// extraKeepFn yields the tmuxIds referenced by saved workspaces (the App
	// harvests them from the workspace store) so resumable sessions from
	// workspaces that aren't currently open are never reaped. Both are set
	// once at startup, before any pane opens.
	appInstanceID string
	extraKeepFn   func() []string
}

func NewManager(appCtx context.Context) *Manager {
	return &Manager{
		appCtx: appCtx,
		panes:  make(map[string]*Pane),
	}
}

// SetAppInstanceID records the per-config-dir instance id used to namespace
// durable tmux sessions. Call once at startup before opening panes.
func (m *Manager) SetAppInstanceID(id string) { m.appInstanceID = id }

// SetWorkspaceTmuxIDs installs a function returning every durable-session token
// referenced by a saved workspace, so the orphan reaper keeps them. Call once
// at startup.
func (m *Manager) SetWorkspaceTmuxIDs(fn func() []string) { m.extraKeepFn = fn }

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
	return m.OpenInDir(paneID, sess, "", "", false)
}

// OpenInDir is Open with an initial working directory the shell cd's into
// once ready, and a stable tmux token for durable (Persist) sessions — both
// used by workspace restore to land a pane back in its saved cwd and re-attach
// its own tmux session. dir == "" behaves like Open.
//
// restore distinguishes a fresh open (a new tab — false) from a workspace
// restore (reopening a saved leaf — true), and decides whether the pane is
// tmux-backed:
//   - fresh open: mint a durable token iff Session.Persist is on (the live
//     "Persistent session" toggle), so the toggle governs new tabs.
//   - restore: NEVER mint — the pane uses tmux iff a token was saved in the
//     layout (tmuxID != ""), the per-pane snapshot taken when it was opened.
//     This keeps a restored pane on whatever it was (tmux or plain) regardless
//     of later toggle changes, which only take effect for future opens.
func (m *Manager) OpenInDir(paneID string, sess profile.Session, dir, tmuxID string, restore bool) error {
	m.mu.Lock()
	if _, exists := m.panes[paneID]; exists {
		m.mu.Unlock()
		return fmt.Errorf("pane: %s already open", paneID)
	}
	p := newPane(m.appCtx, paneID, sess)
	p.initialDir = dir
	p.tmuxID = tmuxID
	// Mint the durable-session token HERE, under m.mu, for a fresh persistent
	// pane — not later in setupPersistence (which runs on the connect goroutine
	// without the lock), so a sibling pane's reaper reading tmuxID under
	// m.mu.RLock never races the write. On restore we never mint: a persistent
	// leaf already carries its saved token, and a plain leaf must stay plain.
	if sess.Persist && p.tmuxID == "" && !restore {
		p.tmuxID = mintTmuxID()
	}
	p.appInstanceID = m.appInstanceID
	m.panes[paneID] = p
	m.mu.Unlock()

	// Ignore connect errors: the pane has already emitted them via
	// pane:output (red ANSI for terminal panes) and connection:log;
	// keeping the pane in the map lets the user press 'r' to retry.
	_ = p.connect(sess)

	// If this pane came up as a tmux-backed durable session, opportunistically
	// reap this instance's orphaned sessions on the same host (best-effort, off
	// the connect path).
	if p.tmuxLaunch != "" {
		go m.reapOrphans(p)
	}
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

// CloseKill is Close plus ending the pane's persistent tmux session on the
// remote — used for an explicit user close of a pane/tab, so a durable
// session isn't left as an orphan. Drops / app-quit / workspace teardown use
// Close (detach-only) so the session survives to be recovered. No-op for an
// unknown pane.
func (m *Manager) CloseKill(paneID string) error {
	m.mu.Lock()
	p, ok := m.panes[paneID]
	if !ok {
		m.mu.Unlock()
		return nil
	}
	delete(m.panes, paneID)
	m.mu.Unlock()

	p.CloseKill()
	return nil
}

// TmuxID returns the pane's stable durable-session token (the frontend
// persists it in the workspace layout). Empty string + ok means a live pane
// that isn't tmux-backed; !ok means no such pane.
func (m *Manager) TmuxID(paneID string) (string, bool) {
	p, ok := m.get(paneID)
	if !ok {
		return "", false
	}
	return p.TmuxID(), true
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

// HostInfo returns the pane's cached host-identity probe result, or the zero
// value if the pane isn't found or the probe hasn't landed yet.
func (m *Manager) HostInfo(paneID string) (events.HostInfo, error) {
	p, ok := m.get(paneID)
	if !ok {
		return events.HostInfo{}, errors.New("pane: not found")
	}
	return p.cachedHostInfo(), nil
}

// EnableCwdFollow turns on "Follow terminal folder" cwd tracking for the pane,
// routing to the tmux pane_current_path poller or the OSC 7 shell hook.
func (m *Manager) EnableCwdFollow(paneID string) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	return p.EnableCwdFollow()
}

// DisableCwdFollow stops cwd tracking started by EnableCwdFollow.
func (m *Manager) DisableCwdFollow(paneID string) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	p.DisableCwdFollow()
	return nil
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
// into dstDir on the destination pane. Across panes it's a server-to-server
// transfer; within one pane (or two panes on the same host) it's a
// same-host copy. The transfer (progress + cancel) is owned by the
// destination pane. A same-host copy that would land on the source path
// itself is rejected by the relay's self/descendant guard.
func (m *Manager) SftpCopyRemote(srcPaneID, dstPaneID, srcDir string, names []string, dstDir string) (uint64, error) {
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
	// Same physical host → guard against overwriting the source. The same
	// pane is trivially the same host; so are two panes sharing a session.
	sameHost := srcPaneID == dstPaneID ||
		(srcP.SessionID != "" && srcP.SessionID == dstP.SessionID)
	return dstP.SftpRelayFrom(srcClient, srcDir, names, dstDir, sameHost)
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

// ListProcesses returns the remote process list for the pane's picker.
func (m *Manager) ListProcesses(paneID string) ([]events.ProcessInfo, error) {
	p, ok := m.get(paneID)
	if !ok {
		return nil, errors.New("pane: not found")
	}
	return p.ListProcesses()
}

// StartProcessMonitor begins streaming process:sample events for one PID.
func (m *Manager) StartProcessMonitor(paneID string, pid int) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	return p.StartProcessMonitor(pid)
}

// StopProcessMonitor stops the per-process stream for one PID.
func (m *Manager) StopProcessMonitor(paneID string, pid int) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	p.StopProcessMonitor(pid)
	return nil
}

// StartProcessMonitorByCommand begins a name-following process stream.
func (m *Manager) StartProcessMonitorByCommand(paneID, command string) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	return p.StartProcessMonitorByCommand(command)
}

// StopProcessMonitorByCommand stops a name-following process stream.
func (m *Manager) StopProcessMonitorByCommand(paneID, command string) error {
	p, ok := m.get(paneID)
	if !ok {
		return errors.New("pane: not found")
	}
	p.StopProcessMonitorByCommand(command)
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

// reapOrphans removes THIS instance's stale durable tmux sessions on the host
// pane p is connected to. It only considers sessions under our own
// hopperxterm-<appInstanceID>- prefix (so a dev build never reaps a prod
// build's sessions on a shared remote — and vice versa), kills only DETACHED
// ones, and skips any whose token is still referenced by an open pane (covers
// live panes, including ones mid-reconnect) or by a saved workspace (covers
// resumable sessions from workspaces that aren't currently open). Best-effort,
// silent on failure, runs on its own goroutine off the connect path.
func (m *Manager) reapOrphans(p *Pane) {
	defer logbook.Recover("pane.reapOrphans")
	sh := p.currentSSH()
	if sh == nil || sh.Client == nil || p.appInstanceID == "" {
		return
	}
	out, ok := transport.RunWithTimeout(sh.Client,
		withTmuxPath("tmux list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null"),
		6*time.Second)
	if !ok {
		return
	}

	prefix := instancePrefix(p.appInstanceID)
	keep := m.keepSet()
	var orphans []string
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) < 2 || !strings.HasPrefix(f[0], prefix) {
			continue
		}
		if f[1] != "0" { // attached — never reap
			continue
		}
		if keep[strings.TrimPrefix(f[0], prefix)] {
			continue
		}
		orphans = append(orphans, f[0])
	}
	if len(orphans) == 0 {
		return
	}

	var cmd strings.Builder
	for _, name := range orphans {
		cmd.WriteString("tmux kill-session -t " + transport.ShQuote(name) + " 2>/dev/null; ")
	}
	_, _ = transport.RunWithTimeout(sh.Client, withTmuxPath(cmd.String()), 6*time.Second)
	events.EmitConnectionLog(m.appCtx, p.ID, events.LogDim, nowMillis(),
		fmt.Sprintf("Cleaned up %d orphaned tmux session(s)", len(orphans)))
}

// keepSet is the set of durable-session tokens that must NOT be reaped: every
// open pane's token plus every tmuxId referenced by a saved workspace. Tokens
// are sanitized to the form used in tmux session names so they match the suffix
// parsed out of a live session name.
func (m *Manager) keepSet() map[string]bool {
	s := map[string]bool{}
	m.mu.RLock()
	for _, p := range m.panes {
		if p.tmuxID != "" {
			s[sanitizeTmux(p.tmuxID)] = true
		}
	}
	m.mu.RUnlock()
	if m.extraKeepFn != nil {
		for _, id := range m.extraKeepFn() {
			s[sanitizeTmux(id)] = true
		}
	}
	return s
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}
