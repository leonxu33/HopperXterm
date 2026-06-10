// Package events centralises Wails event names emitted backend→frontend.
// Each event embeds the paneId in the name (not the payload) so the
// frontend can subscribe per-pane without filtering.
package events

import (
	"context"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"hopperxterm/logbook"
)

// safeEmit forwards to wails runtime only if ctx carries the Wails events
// key (set inside Wails' lifecycle hooks). Tests and other callers using
// a vanilla context.Background() get a silent no-op instead of the
// runtime's log.Fatalf(invalid context).
func safeEmit(ctx context.Context, name string, payload any) {
	if ctx == nil || ctx.Value("events") == nil {
		return
	}
	runtime.EventsEmit(ctx, name, payload)
}

// PaneState mirrors pane.State as a plain string in the wire format.
type PaneState string

// PaneStatePayload is the body of pane:state events.
type PaneStatePayload struct {
	State  PaneState `json:"state"`
	Reason string    `json:"reason,omitempty"`
}

// PaneOutputPayload is the body of pane:output events.
type PaneOutputPayload struct {
	Data string `json:"data"`
}

// ConnectionLogLevel mirrors hopperterm-ftp.jsx's three log levels.
type ConnectionLogLevel string

const (
	LogOK  ConnectionLogLevel = "ok"
	LogErr ConnectionLogLevel = "err"
	LogDim ConnectionLogLevel = "dim"
)

// ConnectionLogPayload is the body of connection:log events.
type ConnectionLogPayload struct {
	TS      int64              `json:"ts"`
	Level   ConnectionLogLevel `json:"level"`
	Message string             `json:"message"`
}

// EmitPaneOutput emits a terminal output chunk for the given pane.
func EmitPaneOutput(ctx context.Context, paneID string, data []byte) {
	safeEmit(ctx, "pane:output:"+paneID, PaneOutputPayload{Data: string(data)})
}

// PaneCwdPayload is the body of pane:cwd events — the remote shell's
// current working directory as detected from OSC 7 sequences in the PTY
// stream.
type PaneCwdPayload struct {
	Cwd  string `json:"cwd"`
	Host string `json:"host,omitempty"`
}

// EmitPaneCwd emits a cwd-change event for the given pane.
func EmitPaneCwd(ctx context.Context, paneID, cwd, host string) {
	safeEmit(ctx, "pane:cwd:"+paneID, PaneCwdPayload{Cwd: cwd, Host: host})
}

// EmitPaneState emits a state transition for the given pane.
func EmitPaneState(ctx context.Context, paneID string, state PaneState, reason string) {
	safeEmit(ctx, "pane:state:"+paneID, PaneStatePayload{State: state, Reason: reason})
}

// EmitConnectionLog emits a structured log entry for the given pane to the
// frontend, and tees it into the persistent log file so connection
// diagnostics survive past the in-app panel: err→Error, dim→Debug, ok→Info.
func EmitConnectionLog(ctx context.Context, paneID string, level ConnectionLogLevel, ts int64, message string) {
	safeEmit(ctx, "connection:log:"+paneID, ConnectionLogPayload{TS: ts, Level: level, Message: message})

	line := "pane " + paneID + ": " + message
	switch level {
	case LogErr:
		logbook.Error(line)
	case LogDim:
		logbook.Debug(line)
	default:
		logbook.Info(line)
	}
}

// SftpTransferPayload mirrors an in-flight upload / download. State
// progresses running → done|error|cancelled. Bytes accumulates;
// TotalBytes is the source file's size (set on the first running
// event for both directions) so the frontend can render a percentage.
type SftpTransferPayload struct {
	ID         uint64 `json:"id"`
	Kind       string `json:"kind"`  // "upload" | "download"
	Path       string `json:"path"`  // remote path
	State      string `json:"state"` // "running" | "done" | "error" | "cancelled"
	Bytes      int64  `json:"bytes"`
	TotalBytes int64  `json:"totalBytes,omitempty"`
	Error      string `json:"error,omitempty"`
	// Transport is the file backend in use ("sftp" | "scp" | "ftp" | "s3").
	// Rides on the first running event so the UI can show / log which
	// protocol a transfer actually used (SCP is a fallback for SFTP-disabled
	// hosts). Empty on the lean terminal events.
	Transport string `json:"transport,omitempty"`
}

// EmitSftpTransfer emits a transfer progress update for the given pane.
func EmitSftpTransfer(ctx context.Context, paneID string, p SftpTransferPayload) {
	safeEmit(ctx, "sftp:transfer:"+paneID, p)
}

// ResourceSample is one tick of /proc-derived stats. All fields are
// optional — frontend treats missing fields as "no change".
type ResourceSample struct {
	TS          int64   `json:"ts"`
	CPUPct      float64 `json:"cpuPct"`    // 0..100 across all cores
	MemUsedKB   int64   `json:"memUsedKB"` // total - available
	MemTotalKB  int64   `json:"memTotalKB"`
	DiskRdKBs   float64 `json:"diskRdKBs"` // KiB/s aggregate
	DiskWrKBs   float64 `json:"diskWrKBs"`
	NetRxKBs    float64 `json:"netRxKBs"`
	NetTxKBs    float64 `json:"netTxKBs"`
	Uptime      int64   `json:"uptime"` // seconds
	LoadAvg1    float64 `json:"loadAvg1"`
	DiskUsedKB  int64   `json:"diskUsedKB"`  // df -kP / used (KiB)
	DiskTotalKB int64   `json:"diskTotalKB"` // df -kP / total (KiB)
	// Extras refreshed every 10 ticks (along with the disk total/used
	// numbers). All optional — empty when the remote couldn't supply
	// the data (BusyBox-only base64, no /proc/meminfo entry, etc.).
	MemCachedKB  int64  `json:"memCachedKB,omitempty"`
	MemBuffersKB int64  `json:"memBuffersKB,omitempty"`
	DfText       string `json:"dfText,omitempty"`  // raw `df -h` output
	WhoText      string `json:"whoText,omitempty"` // raw `who` output
	User         string `json:"user,omitempty"`    // current user (login)
}

// EmitResourceSample emits a single resource tick for the given pane.
// One event per pane keeps the frontend wiring simple — same payload can
// power the status bar and a resource panel without de-duping.
func EmitResourceSample(ctx context.Context, paneID string, s ResourceSample) {
	safeEmit(ctx, "resource:sample:"+paneID, s)
}

// ProcessSample is one tick of a single monitored process's CPU/memory.
// CPUPct is top-style — the share of one logical core, so it can exceed
// 100 for a multi-threaded process spanning several cores.
//
// Spec identifies which monitor produced the sample ("pid:<n>" or
// "cmd:<name>"); several monitors on one pane share the
// "process:sample:{paneId}" event, so the frontend demuxes on Spec. This
// also lets command-mode monitors keep a stable identity while the resolved
// PID changes across restarts.
//
// Alive semantics depend on the monitor kind: for a PID monitor it drops to
// false on the single final tick after the PID exits (terminal — the stream
// then ends). For a command monitor it reflects whether a matching process
// is running *right now* (false while none matches), and the stream keeps
// polling so it resumes when the command restarts under a new PID.
type ProcessSample struct {
	TS     int64   `json:"ts"`
	PID    int     `json:"pid"`
	CPUPct float64 `json:"cpuPct"` // top-style; may exceed 100 across cores
	MemKB  int64   `json:"memKB"`  // resident set size (RSS)
	Alive  bool    `json:"alive"`
	Spec   string  `json:"spec"`   // "pid:<n>" | "cmd:<name>"
	Uptime int64   `json:"uptime"` // seconds since the process started; 0 when unknown
}

// EmitProcessSample emits one per-process tick for the given pane. All
// monitored PIDs on a pane share the "process:sample:{paneId}" event; the
// frontend filters by ProcessSample.PID.
func EmitProcessSample(ctx context.Context, paneID string, s ProcessSample) {
	safeEmit(ctx, "process:sample:"+paneID, s)
}

// ProcessInfo is one row of the process picker list. CPUPct is a
// best-effort instantaneous percentage on Linux/macOS (from `ps pcpu`)
// and 0 on Windows, where the list is ordered by total CPU time instead.
// MemKB is the resident set size.
type ProcessInfo struct {
	PID    int     `json:"pid"`
	Name   string  `json:"name"`
	User   string  `json:"user"`
	CPUPct float64 `json:"cpuPct"`
	MemKB  int64   `json:"memKB"`
}

// HostInfo is a snapshot of the remote (or local) host's OS identity.
// All fields are optional — the frontend renders whichever ones land.
type HostInfo struct {
	Name     string `json:"name,omitempty"`     // e.g. "Ubuntu"
	Version  string `json:"version,omitempty"`  // e.g. "24.04.3 LTS"
	Kernel   string `json:"kernel,omitempty"`   // `uname -r` (e.g. "6.17.0-29")
	Arch     string `json:"arch,omitempty"`     // `uname -m` (e.g. "x86_64")
	Hostname string `json:"hostname,omitempty"` // `hostname` command output
	// Family is the OS classification ("linux" / "darwin" / "windows"),
	// decided up front from `uname -s` and reliable even when the cosmetic
	// Name probe (CIM on Windows) hangs or returns nothing. The frontend uses
	// it to pick line-editing key sequences (readline vs PSReadLine/cmd).
	Family string `json:"family,omitempty"`
}

// EmitHostInfo emits the one-shot OS identity probe result for the
// given pane. Fired once shortly after a pane finishes connecting.
func EmitHostInfo(ctx context.Context, paneID string, info HostInfo) {
	safeEmit(ctx, "pane:hostinfo:"+paneID, info)
}

// AskSavePasswordPayload accompanies pane:asksavepassword events.
// The frontend uses Host / User to label the modal; SessionID is
// echoed back to the SaveCurrentPassword RPC.
type AskSavePasswordPayload struct {
	SessionID string `json:"sessionId"`
	Host      string `json:"host,omitempty"`
	User      string `json:"user,omitempty"`
}

// EmitAskSavePassword fires once per pane right after a successful
// password-based handshake — only when the user typed the password
// (i.e., it wasn't already in the keychain). The frontend asks
// "save?" and either calls SaveCurrentPassword or just lets the
// pane drop the in-memory copy.
func EmitAskSavePassword(ctx context.Context, paneID, sessionID, host, user string) {
	safeEmit(ctx, "pane:asksavepassword:"+paneID, AskSavePasswordPayload{
		SessionID: sessionID,
		Host:      host,
		User:      user,
	})
}

// AskPasswordPayload accompanies pane:askpassword events. Used by
// non-terminal panes (SFTP / FTP) which have no in-app shell where the
// user could type a password — the frontend shows a modal instead and
// returns the answer via App.SubmitPanePassword.
type AskPasswordPayload struct {
	SessionID string `json:"sessionId"`
	Host      string `json:"host"`
	User      string `json:"user"`
	Question  string `json:"question"`
}

// EmitAskPassword fires once per modal-prompt cycle for SFTP / FTP
// panes. The frontend's SubmitPanePassword call delivers the answer
// to the waiting prompter.
func EmitAskPassword(ctx context.Context, paneID, sessionID, host, user, question string) {
	safeEmit(ctx, "pane:askpassword:"+paneID, AskPasswordPayload{
		SessionID: sessionID,
		Host:      host,
		User:      user,
		Question:  question,
	})
}

// HostKeyChangedPayload accompanies pane:hostkeychanged events. Fired
// mid-handshake when the server's host key no longer matches the stored
// known_hosts entry. The frontend shows a warning dialog with both
// fingerprints and calls App.ResolveHostKeyChange(accept) to either
// record the new key (accept) or abort the connection (reject).
type HostKeyChangedPayload struct {
	SessionID      string `json:"sessionId"`
	Host           string `json:"host"`
	OldFingerprint string `json:"oldFingerprint"`
	NewFingerprint string `json:"newFingerprint"`
}

// EmitHostKeyChanged fires when a host's key has changed and the user
// must decide whether to trust the new one.
func EmitHostKeyChanged(ctx context.Context, paneID, sessionID, host, oldFP, newFP string) {
	safeEmit(ctx, "pane:hostkeychanged:"+paneID, HostKeyChangedPayload{
		SessionID:      sessionID,
		Host:           host,
		OldFingerprint: oldFP,
		NewFingerprint: newFP,
	})
}

// UpdateProgressPayload reports an in-flight self-update. State progresses
// downloading → installing → error. Bytes accumulates as the installer
// downloads; Total is the asset's size (0 if the server omitted it). This is
// an app-global event (no paneId) — there's only ever one update in flight.
type UpdateProgressPayload struct {
	State string `json:"state"` // "downloading" | "installing" | "error"
	Bytes int64  `json:"bytes"`
	Total int64  `json:"total"`
	Error string `json:"error,omitempty"`
}

// EmitUpdateProgress emits a self-update progress tick on the global
// "update:progress" event.
func EmitUpdateProgress(ctx context.Context, p UpdateProgressPayload) {
	safeEmit(ctx, "update:progress", p)
}
