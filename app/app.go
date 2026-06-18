package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	goruntime "runtime"

	"hopperxterm/credentials"
	"hopperxterm/events"
	"hopperxterm/extedit"
	"hopperxterm/logbook"
	"hopperxterm/macro"
	"hopperxterm/pane"
	"hopperxterm/prefs"
	"hopperxterm/profile"
	"hopperxterm/recent"
	"hopperxterm/transport"
	"hopperxterm/workspace"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// wailsJSON is the build config embedded at compile time. It's the single
// source of truth for the product version — the same file drives the installer
// asset name and the git tag — so AppVersion stays in sync with releases
// automatically (bump info.productVersion and every consumer follows).
//
//go:embed wails.json
var wailsJSON []byte

// App is the Wails root. Frontend calls reach the backend through methods
// declared on this struct; Wails generates TypeScript bindings on build.
type App struct {
	ctx        context.Context
	profile    *profile.Store
	panes      *pane.Manager
	workspaces *workspace.Store
	macros     *macro.Store
	recents    *recent.Store
	prefs      *prefs.Store
	extedit    *extedit.Manager
}

func NewApp() *App {
	return &App{}
}

// AppVersion returns the version shown in the About dialog. Under the `dev`
// build tag that `wails dev` compiles with it reports "dev" (see
// version_dev.go); release builds return info.productVersion from the embedded
// wails.json. Returns "" if the field is missing/unparseable.
func (a *App) AppVersion() string {
	if devVersionLabel != "" {
		return devVersionLabel
	}
	var cfg struct {
		Info struct {
			ProductVersion string `json:"productVersion"`
		} `json:"info"`
	}
	if err := json.Unmarshal(wailsJSON, &cfg); err != nil {
		return ""
	}
	return cfg.Info.ProductVersion
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	logbook.Info("startup: HopperXterm " + a.AppVersion() + " on " + goruntime.GOOS)

	store, err := profile.OpenDefault()
	if err != nil {
		wailsruntime.LogErrorf(ctx, "profile: OpenDefault failed, falling back to in-memory: %v", err)
		store = profile.NewInMemory()
	}
	a.profile = store
	a.panes = pane.NewManager(ctx)

	ws, err := workspace.OpenDefault()
	if err != nil {
		wailsruntime.LogErrorf(ctx, "workspace: OpenDefault failed, falling back to in-memory: %v", err)
		ws = workspace.NewInMemory()
	}
	a.workspaces = ws

	mc, err := macro.OpenDefault()
	if err != nil {
		wailsruntime.LogErrorf(ctx, "macro: OpenDefault failed, falling back to in-memory: %v", err)
		mc = macro.NewInMemory()
	}
	a.macros = mc

	rc, err := recent.OpenDefault()
	if err != nil {
		wailsruntime.LogErrorf(ctx, "recent: OpenDefault failed, falling back to in-memory: %v", err)
		rc = recent.NewInMemory()
	}
	a.recents = rc

	pf, err := prefs.OpenDefault()
	if err != nil {
		wailsruntime.LogErrorf(ctx, "prefs: OpenDefault failed, falling back to in-memory: %v", err)
		pf = prefs.NewInMemory()
	}
	a.prefs = pf

	// External-edit manager: reuses the pane manager's synchronous
	// download/upload, and reads the configured editor from prefs (empty =
	// OS default text editor).
	a.extedit = extedit.New(ctx, a.panes, func() string {
		if v, ok := a.prefs.All()["externalEditor"].(string); ok {
			return v
		}
		return ""
	})
}

// shutdown is wired in main.go's options.OnShutdown so panes are closed
// gracefully when the window exits.
func (a *App) shutdown(ctx context.Context) {
	if a.extedit != nil {
		a.extedit.Shutdown()
	}
	if a.panes != nil {
		_ = a.panes.CloseAll()
	}
	logbook.Info("shutdown")
	_ = logbook.Close()
}

// ---- Profile ---------------------------------------------------------------

// ListProfiles returns the current groups and sessions in their persisted
// render order. Frontend calls this once on boot and after any mutation.
func (a *App) ListProfiles() profile.Snapshot {
	return a.profile.Snapshot()
}

// SaveSession upserts a session by ID. New sessions are appended to their
// bucket (root if GroupID is empty, otherwise the bottom of that group).
func (a *App) SaveSession(s profile.Session) error {
	return a.profile.SaveSession(s)
}

// SaveTransientSession registers an in-memory-only session (quick-connect /
// temporary). It can be opened like any session but never persists to disk
// and never shows in the sidebar; it's discarded when the app closes.
func (a *App) SaveTransientSession(s profile.Session) error {
	return a.profile.SaveTransientSession(s)
}

// RemoveTransient drops a transient session from the registry. Called when a
// temporary tab closes so the in-memory map doesn't grow unbounded.
func (a *App) RemoveTransient(id string) {
	a.profile.RemoveTransient(id)
}

// DeleteSession removes a session by ID. Best-effort cleans up the
// associated keychain entry so a future session with a recycled ID
// (rare but possible) doesn't inherit stale credentials.
func (a *App) DeleteSession(id string) error {
	if err := a.profile.DeleteSession(id); err != nil {
		return err
	}
	_ = credentials.DeletePassword(id)
	return nil
}

// SaveGroup upserts a group by ID. New groups are appended to the end of the
// sidebar.
func (a *App) SaveGroup(g profile.Group) error {
	return a.profile.SaveGroup(g)
}

// DeleteGroup removes a group. If deleteSessionsInside is true, every session
// in that group is also removed; otherwise those sessions are re-parented to
// the sidebar root.
func (a *App) DeleteGroup(id string, deleteSessionsInside bool) error {
	return a.profile.DeleteGroup(id, deleteSessionsInside)
}

// MoveSession re-parents a session and reorders it before beforeSessionID
// inside the target bucket. Pass targetGroupID="" to move to root,
// beforeSessionID="" to move to the end of the bucket.
func (a *App) MoveSession(id, targetGroupID, beforeSessionID string) error {
	return a.profile.MoveSession(id, targetGroupID, beforeSessionID)
}

// ReorderGroup moves a group so it appears just before beforeGroupID.
// Pass beforeGroupID="" to move to the end.
func (a *App) ReorderGroup(id, beforeGroupID string) error {
	return a.profile.ReorderGroup(id, beforeGroupID)
}

// ---- Pane lifecycle --------------------------------------------------------

// OpenPane dials the named session and starts a remote shell in a fresh
// pane. Returns immediately after the goroutines start; progress and
// output stream over Wails events (pane:state:{paneId},
// pane:output:{paneId}, connection:log:{paneId}).
func (a *App) OpenPane(paneID, sessionID string) error {
	return a.openPaneIn(paneID, sessionID, "")
}

// OpenPaneInDir is OpenPane with an initial working directory the shell
// cd's into once ready. Used by workspace restore to reopen each pane in
// its saved cwd; dir == "" behaves exactly like OpenPane.
func (a *App) OpenPaneInDir(paneID, sessionID, dir string) error {
	return a.openPaneIn(paneID, sessionID, dir)
}

func (a *App) openPaneIn(paneID, sessionID, dir string) error {
	if paneID == "" || sessionID == "" {
		return fmt.Errorf("OpenPane: paneId and sessionId required")
	}
	sess, ok := a.profile.Lookup(sessionID)
	if !ok {
		return fmt.Errorf("OpenPane: session %s not found", sessionID)
	}
	return a.panes.OpenInDir(paneID, sess, dir)
}

// ClosePane terminates the pane's SSH session and cleans up its goroutines.
// Idempotent: closing an unknown pane is a no-op. Any external-edit sessions
// bound to the pane are stopped too (their temp copies removed). Reconnect
// goes through pane.Manager.Close directly, not here, so edits survive a
// reconnect.
func (a *App) ClosePane(paneID string) error {
	if a.extedit != nil {
		a.extedit.StopForPane(paneID)
	}
	return a.panes.Close(paneID)
}

// ReconnectPane closes the existing pane and re-opens it against the
// same session. Used after a disconnect when the user wants to retry —
// the frontend triggers this when the user presses 'r' in a
// Disconnected terminal pane.
func (a *App) ReconnectPane(paneID string) error {
	if paneID == "" {
		return fmt.Errorf("ReconnectPane: paneId required")
	}
	sessionID, ok := a.panes.SessionIDOf(paneID)
	if !ok {
		return fmt.Errorf("ReconnectPane: pane %s not found", paneID)
	}
	_ = a.panes.Close(paneID)
	return a.OpenPane(paneID, sessionID)
}

// SendInput forwards a keystroke (or paste) to the pane's remote PTY.
func (a *App) SendInput(paneID, data string) error {
	return a.panes.SendInput(paneID, data)
}

// ResizePty tells the pane to send a window-change to the remote so the
// PTY matches the terminal viewport in cells.
func (a *App) ResizePty(paneID string, cols, rows int) error {
	return a.panes.Resize(paneID, cols, rows)
}

// ---- SFTP ------------------------------------------------------------------

// ---- Local filesystem (for the SFTP/FTP dual-pane browser) -----------------

// LocalList returns directory entries of a local path. Empty = home dir.
func (a *App) LocalList(dir string) ([]transport.Entry, error) {
	return transport.LocalList(dir)
}

// LocalCwd returns the user's home directory.
func (a *App) LocalCwd() (string, error) {
	return transport.LocalCwd()
}

// LocalIsDir reports whether a local path is a directory, so the uploader
// can recurse a dropped/selected folder instead of writing it out as a
// single file.
func (a *App) LocalIsDir(path string) (bool, error) {
	return transport.LocalIsDir(path)
}

// LocalMkdir creates a directory locally; parents=true acts like `mkdir -p`.
func (a *App) LocalMkdir(path string, parents bool) error {
	return transport.LocalMkdir(path, parents)
}

// LocalRemove deletes a file or (if recursive) a directory tree.
func (a *App) LocalRemove(path string, recursive bool) error {
	return transport.LocalRemove(path, recursive)
}

// LocalRename moves src → dst on the local filesystem.
func (a *App) LocalRename(src, dst string) error {
	return transport.LocalRename(src, dst)
}

// LocalCreate writes an empty file at the given local path.
func (a *App) LocalCreate(path string) error {
	return transport.LocalCreate(path)
}

// SftpList returns the entries of a remote directory on the pane's SFTP
// subsystem. Pass "" for the user's home directory.
func (a *App) SftpList(paneID, dir string) ([]transport.Entry, error) {
	return a.panes.SftpList(paneID, dir)
}

// SftpCwd returns the SFTP working directory (typically $HOME).
func (a *App) SftpCwd(paneID string) (string, error) {
	return a.panes.SftpCwd(paneID)
}

// GetPaneCwd returns the most recent OSC 7 cwd seen on the pane's PTY
// stream, or "" if the shell hasn't emitted one yet. Used by the SFTP
// panel's "Follow terminal folder" toggle to resync immediately on
// toggle-on without waiting for the next prompt redraw.
func (a *App) GetPaneCwd(paneID string) (string, error) {
	return a.panes.LastCwd(paneID)
}

// GetPaneOSFamily returns the pane's probed remote OS family
// ("linux"/"darwin"/"windows"), or "" if unknown / not yet probed.
// The Remote Files panel uses it to disable "Follow terminal folder"
// on Windows shells, where the OSC 7 hook (bash/zsh) doesn't apply.
func (a *App) GetPaneOSFamily(paneID string) (string, error) {
	return a.panes.OSFamily(paneID)
}

// InstallOsc7Hook writes a bash/zsh-aware OSC 7 emitter into the
// pane's PTY so future prompt redraws emit OSC 7. Called by the SFTP
// panel's "Follow terminal folder" toggle on activation so the
// feature works even on shells whose default config doesn't emit
// OSC 7 (minimal bash, alpine, busybox sh).
func (a *App) InstallOsc7Hook(paneID string) error {
	return a.panes.InstallOsc7Hook(paneID)
}

// SftpMkdir creates a directory on the remote. parents=true acts like mkdir -p.
func (a *App) SftpMkdir(paneID, path string, parents bool) error {
	return a.panes.SftpMkdir(paneID, path, parents)
}

// SftpRemove deletes a remote file or directory. recursive=true also
// removes non-empty directories.
func (a *App) SftpRemove(paneID, path string, recursive bool) error {
	return a.panes.SftpRemove(paneID, path, recursive)
}

// SftpRename moves a remote path. Cross-filesystem moves typically fail
// per server policy.
func (a *App) SftpRename(paneID, src, dst string) error {
	return a.panes.SftpRename(paneID, src, dst)
}

// SftpCreate writes an empty file at the given remote path on the
// pane's file transport.
func (a *App) SftpCreate(paneID, path string) error {
	return a.panes.SftpCreate(paneID, path)
}

// SftpUploadFile uploads a known local file to a known remote path —
// no OS dialogs. The dual-pane file browser uses this for the Upload
// button: it knows the local selection and target remote dir already.
func (a *App) SftpUploadFile(paneID, localPath, remotePath string) (uint64, error) {
	return a.panes.SftpUpload(paneID, localPath, remotePath)
}

// SftpDownloadFile downloads a known remote file to a known local
// path — no OS dialogs. Used by the dual-pane Download button.
func (a *App) SftpDownloadFile(paneID, remotePath, localPath string) (uint64, error) {
	return a.panes.SftpDownload(paneID, remotePath, localPath)
}

// CancelSftpTransfer signals a running upload/download to abort. The
// transfer event stream will land on the "cancelled" state shortly
// after the in-flight network read returns.
func (a *App) CancelSftpTransfer(id uint64) {
	a.panes.CancelTransfer(id)
}

// SftpUploadDir recursively copies a local directory tree to a remote
// path. Same event channel as SftpUploadFile — one transfer ID for
// the whole tree, with TotalBytes pre-computed by walking the local
// side.
func (a *App) SftpUploadDir(paneID, localPath, remotePath string) (uint64, error) {
	return a.panes.SftpUploadDir(paneID, localPath, remotePath)
}

// SftpDownloadDir recursively copies a remote directory tree to a
// local path.
func (a *App) SftpDownloadDir(paneID, remotePath, localPath string) (uint64, error) {
	return a.panes.SftpDownloadDir(paneID, remotePath, localPath)
}

// SftpCopyRemote copies the named entries from srcDir on the source pane
// to dstDir on the destination pane — the backend for cross-pane Remote
// Files drag-and-drop. Bytes stream server-to-server (no disk) for
// SFTP↔SFTP, with a temp-file fallback for other backend pairs. Progress
// rides the destination pane's sftp:transfer:{paneID} event channel.
func (a *App) SftpCopyRemote(srcPaneID, dstPaneID, srcDir string, names []string, dstDir string) (uint64, error) {
	return a.panes.SftpCopyRemote(srcPaneID, dstPaneID, srcDir, names, dstDir)
}

// SftpUpload prompts for a local file (via Wails OpenFileDialog) and
// uploads it to remoteDir. The frontend tracks progress via
// sftp:transfer:{paneId} events.
func (a *App) SftpUpload(paneID, remoteDir string) (uint64, error) {
	local, err := wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title: "Upload to " + remoteDir,
	})
	if err != nil {
		return 0, err
	}
	if local == "" {
		return 0, nil // user cancelled
	}
	remote := transport.SuggestRemotePath(remoteDir, local)
	return a.panes.SftpUpload(paneID, local, remote)
}

// PickFile opens a native file-picker dialog. Used by the New Session
// modal so users can browse for a .pem key file (or anything else)
// instead of typing the full path by hand. Returns "" if the user
// cancels. `filterPattern` is a semicolon-separated globs list — e.g.
// "*.pem;*.key" — empty means "show all files".
func (a *App) PickFile(title, filterPattern string) (string, error) {
	opts := wailsruntime.OpenDialogOptions{Title: title}
	if filterPattern != "" {
		opts.Filters = []wailsruntime.FileFilter{
			{DisplayName: "Key files", Pattern: filterPattern},
			{DisplayName: "All files", Pattern: "*.*"},
		}
	}
	return wailsruntime.OpenFileDialog(a.ctx, opts)
}

// PickDirectory opens a native folder-picker dialog. Returns "" if
// the user cancels. Used by the sidebar's batch-download flow so a
// multi-file selection prompts once for a target directory instead
// of opening a save dialog per file.
func (a *App) PickDirectory(title string) (string, error) {
	return wailsruntime.OpenDirectoryDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title: title,
	})
}

// PickFiles opens a native multi-file picker dialog. Returns the
// selected paths; nil/empty if the user cancels. Used by the
// sidebar's batch-upload flow so the user can select multiple files
// from a single dialog instead of being prompted per file.
func (a *App) PickFiles(title string) ([]string, error) {
	return wailsruntime.OpenMultipleFilesDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title: title,
	})
}

// SftpDownload prompts for a local save target and downloads remotePath
// onto it.
func (a *App) SftpDownload(paneID, remotePath string) (uint64, error) {
	suggested := basename(remotePath)
	local, err := wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{
		Title:           "Save " + suggested,
		DefaultFilename: suggested,
	})
	if err != nil {
		return 0, err
	}
	if local == "" {
		return 0, nil // user cancelled
	}
	return a.panes.SftpDownload(paneID, remotePath, local)
}

// ReleaseAllPanes closes every backend pane — used by the frontend
// on mount to clean up after a WebView refresh (HMR or hard reload).
// Without this, every dev-mode refresh would leak the previous
// frontend's SSH/SFTP/FTP connections (you'd see them piling up in
// the remote's `who` output).
func (a *App) ReleaseAllPanes() error {
	if a.extedit != nil {
		a.extedit.StopAll()
	}
	return a.panes.CloseAll()
}

// ---- External edit ("open with" / edit remote file) -----------------------

// FileEditOpen downloads the remote file to a local temp copy, opens it in a
// text editor, and watches the copy — saving re-uploads it to the remote.
// Returns an edit-session ID; progress / save / error ride the global
// "extedit:event" channel.
func (a *App) FileEditOpen(paneID, remotePath string) (string, error) {
	return a.extedit.Open(paneID, remotePath, true)
}

// FileOpenWith is FileEditOpen via the OS "open with" path instead of a forced
// text editor — Windows shows its native chooser; macOS / Linux use the file's
// default association. The same download → watch → re-upload round-trip runs.
func (a *App) FileOpenWith(paneID, remotePath string) (string, error) {
	return a.extedit.Open(paneID, remotePath, false)
}

// LocalEditOpen opens a local file in a text editor. No temp copy / watcher —
// the editor edits the file in place. For the dual-pane browser's local side.
func (a *App) LocalEditOpen(path string) error {
	return a.extedit.OpenLocal(path, true)
}

// LocalOpenWith opens a local file via the OS "open with" path (Windows
// chooser / default association elsewhere), editing in place.
func (a *App) LocalOpenWith(path string) error {
	return a.extedit.OpenLocal(path, false)
}

// FileEditStop ends an external-edit session (stops watching, removes the temp
// copy). Idempotent.
func (a *App) FileEditStop(id string) error {
	return a.extedit.Stop(id)
}

// FileEditList returns the currently active external-edit sessions, for the
// frontend's active-edits UI.
func (a *App) FileEditList() []extedit.Info {
	return a.extedit.List()
}

// SaveTextFile prompts the user for a save location via the native
// dialog and writes the given content there. Returns the absolute
// path on success, or "" if the user cancelled.
func (a *App) SaveTextFile(suggestedName, content string) (string, error) {
	target, err := wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{
		Title:           "Save " + suggestedName,
		DefaultFilename: suggestedName,
	})
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", nil
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return "", err
	}
	return target, nil
}

// ---- Resource monitor ------------------------------------------------------

// StartResourceMonitor begins the 1Hz /proc poller for the pane.
func (a *App) StartResourceMonitor(paneID string) error {
	return a.panes.StartResourceMonitor(paneID)
}

// StopResourceMonitor stops the /proc poller for the pane.
func (a *App) StopResourceMonitor(paneID string) error {
	return a.panes.StopResourceMonitor(paneID)
}

// ListProcesses returns the pane remote's process list for the picker.
func (a *App) ListProcesses(paneID string) ([]events.ProcessInfo, error) {
	return a.panes.ListProcesses(paneID)
}

// StartProcessMonitor begins streaming process:sample events for one PID.
func (a *App) StartProcessMonitor(paneID string, pid int) error {
	return a.panes.StartProcessMonitor(paneID, pid)
}

// StopProcessMonitor stops the per-process stream for one PID.
func (a *App) StopProcessMonitor(paneID string, pid int) error {
	return a.panes.StopProcessMonitor(paneID, pid)
}

// StartProcessMonitorByCommand follows a process by name (survives restarts
// under a new PID; first match wins).
func (a *App) StartProcessMonitorByCommand(paneID, command string) error {
	return a.panes.StartProcessMonitorByCommand(paneID, command)
}

// StopProcessMonitorByCommand stops a name-following process stream.
func (a *App) StopProcessMonitorByCommand(paneID, command string) error {
	return a.panes.StopProcessMonitorByCommand(paneID, command)
}

// SaveCurrentPassword persists the typed-during-auth password for the
// pane's session to the OS keychain, so future connects auto-login.
func (a *App) SaveCurrentPassword(paneID string) error {
	return a.panes.SaveCurrentPassword(paneID)
}

// DiscardCurrentPassword drops the in-memory typed password — the user
// chose not to save it. Future connects will prompt again.
func (a *App) DiscardCurrentPassword(paneID string) error {
	return a.panes.DiscardCurrentPassword(paneID)
}

// SubmitPanePassword delivers a password the user typed into the
// frontend's modal dialog back to a waiting pane prompter (used by
// SFTP / FTP panes which lack a terminal). `save` records whether the
// dialog's "save password" checkbox was checked — if so, the keychain
// is updated after the connect succeeds.
func (a *App) SubmitPanePassword(paneID, password string, save bool) error {
	return a.panes.SubmitPanePassword(paneID, password, save)
}

// CancelPanePassword aborts a waiting modal-password prompt; the
// connect attempt fails. Called when the user dismisses the dialog.
func (a *App) CancelPanePassword(paneID string) error {
	return a.panes.CancelPanePassword(paneID)
}

// ResolveHostKeyChange delivers the user's decision from the "host key
// changed" dialog. accept=true records the new key and continues the
// connect; accept=false (or dismissing) refuses and the dial fails.
func (a *App) ResolveHostKeyChange(paneID string, accept bool) error {
	return a.panes.ResolveHostKeyChange(paneID, accept)
}

// ---- AWS EC2 ---------------------------------------------------------------

// ListEC2Instances queries the EC2 API in the given region under an
// optional named AWS profile. Used by the New Session modal to populate
// an instance picker. Region "" uses the profile/env/us-east-1.
func (a *App) ListEC2Instances(region, profile string) ([]transport.EC2InstanceInfo, error) {
	return transport.ListInstances(region, profile)
}

// DescribeEC2Instance fetches one instance's metadata under an optional
// named AWS profile.
func (a *App) DescribeEC2Instance(instanceID, region, profile string) (transport.EC2InstanceInfo, error) {
	return transport.DescribeInstance(instanceID, region, profile)
}

// ---- AWS S3 ----------------------------------------------------------------

// ListBuckets returns the bucket names visible under an optional named AWS
// profile, for the New Session modal's S3 bucket picker. Region "" uses the
// profile/env/us-east-1 endpoint; results span all regions either way.
func (a *App) ListBuckets(region, profile string) ([]string, error) {
	return transport.ListBuckets(region, profile)
}

// ListAWSProfiles returns the named profiles found in the user's AWS
// shared config files, for the New Session modal's profile dropdown.
func (a *App) ListAWSProfiles() []string {
	return transport.ListAWSProfiles()
}

// ListWSLDistros returns the WSL distributions installed on this machine
// (default first), for the New Session modal's WSL distro picker. Off
// Windows it returns an empty list.
func (a *App) ListWSLDistros() ([]string, error) {
	return transport.ListWSLDistros()
}

// ---- Workspaces ------------------------------------------------------------

// ListWorkspaces returns the persisted workspace snapshots in display
// order (case-insensitive name).
func (a *App) ListWorkspaces() []workspace.Workspace {
	return a.workspaces.List()
}

// SaveWorkspace upserts a workspace by ID. The frontend supplies the
// current tab layout in the wire format.
func (a *App) SaveWorkspace(w workspace.Workspace) error {
	return a.workspaces.Save(w)
}

// DeleteWorkspace removes a workspace by ID.
func (a *App) DeleteWorkspace(id string) error {
	return a.workspaces.Delete(id)
}

// GetWorkspace returns one workspace by ID. Used by the frontend when
// switching — the snapshot drives tab re-creation.
func (a *App) GetWorkspace(id string) (workspace.Workspace, error) {
	return a.workspaces.Get(id)
}

// ---- Macros ----------------------------------------------------------------

// ListMacros returns the persisted keystroke macros in display order
// (case-insensitive name).
func (a *App) ListMacros() []macro.Macro {
	return a.macros.List()
}

// SaveMacro upserts a recorded macro by ID. The frontend supplies the
// raw captured keystrokes; replay is purely frontend (it feeds the bytes
// back through SendInput), so there's no RunMacro method here.
func (a *App) SaveMacro(m macro.Macro) error {
	return a.macros.Save(m)
}

// DeleteMacro removes a macro by ID.
func (a *App) DeleteMacro(id string) error {
	return a.macros.Delete(id)
}

// ---- Recents ---------------------------------------------------------------

// ListRecents returns the recently-opened MRU newest-first. The frontend
// resolves each ref against the live session/workspace lists and drops
// any that no longer exist, so stale refs here are harmless.
func (a *App) ListRecents() []recent.Ref {
	return a.recents.List()
}

// PushRecent records a freshly-opened session/workspace at the front of
// the MRU and returns the updated list.
func (a *App) PushRecent(ref recent.Ref) ([]recent.Ref, error) {
	return a.recents.Push(ref)
}

// ---- UI preferences --------------------------------------------------------

// GetUIPrefs returns every stored UI preference. Keys never set are absent —
// the frontend owns the defaults (see lib/uiprefs.ts).
func (a *App) GetUIPrefs() map[string]any {
	return a.prefs.All()
}

// SetUIPref stores one UI preference (arbitrary JSON value) and persists it.
func (a *App) SetUIPref(key string, value any) error {
	return a.prefs.Set(key, value)
}

func basename(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' || p[i] == '\\' {
			return p[i+1:]
		}
	}
	return p
}
