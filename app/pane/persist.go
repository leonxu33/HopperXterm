package pane

// Durable sessions (Phase B): tmux-backed true persistence for SSH/EC2 panes
// that opt in via Session.Persist.
//
// Phase A (reconnect.go) re-dials a dropped connection but lands in a FRESH
// login shell — running processes don't survive. Phase B closes that gap by
// running the shell inside a server-side tmux session: tmux is a daemon that
// outlives the SSH channel, so when the reconnect supervisor re-dials it
// re-attaches the SAME tmux session and the user's processes, environment, and
// scrollback are still there. The session name is derived from a stable
// per-pane token (tmuxID) that the frontend persists in the workspace layout,
// so persistence survives an app restart too: reopening a pane re-attaches to
// exactly its own session, never another pane's.
//
// It's an additive layer on Phase A: the launch command the (re)connect runs
// changes from "the login shell" to "tmux new-session -A -s <name>", and the
// existing reconnect machinery replays it unchanged. When the remote has no
// tmux we fall back silently to the plain Phase-A auto-reconnecting shell.
//
// Lifecycle: a network drop, an app quit, or a workspace teardown only
// *detaches* (closing the SSH channel leaves the tmux session running on the
// remote, so it can be recovered). The session is destroyed only when the user
// **closes the pane/tab** (kill-session, via CloseKill) or ends the shell with
// `exit`.

import (
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"hopperxterm/events"
	"hopperxterm/transport"
)

const (
	// tmuxHistoryLimit is the per-window scrollback tmux keeps. Generous so
	// re-attaching after a drop still shows recent output.
	tmuxHistoryLimit = 100000
	// tmuxDetectMarker is echoed by the detection probe iff tmux is on PATH,
	// so we can tell "tmux present" from "no tmux".
	tmuxDetectMarker = "HOP_TMUX_OK"
	// tmuxHasMarker is echoed when the target session already exists, so we
	// know to re-attach (skip connect-init) rather than treat it as new.
	tmuxHasMarker = "HOP_TMUX_HAS"
)

// sanitizeTmux maps a string to the [A-Za-z0-9_-] set tmux allows in session
// names (tmux treats '.' and ':' specially).
func sanitizeTmux(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}

// instancePrefix is the tmux session-name prefix shared by every durable
// session this app instance owns: hopperxterm-<instanceID>-. The instance ID
// (random, per config dir) namespaces sessions so a dev build and a prod build
// on the same remote never see or reap each other's sessions — the reaper
// only ever touches names under its own prefix.
func instancePrefix(instanceID string) string {
	return "hopperxterm-" + sanitizeTmux(instanceID) + "-"
}

// tmuxName is the full tmux session name for a pane: the instance prefix plus
// the pane's stable token.
func tmuxName(instanceID, tmuxID string) string {
	return instancePrefix(instanceID) + sanitizeTmux(tmuxID)
}

// mintTmuxID generates a fresh unique token for a persistent pane's tmux
// session. Random so two tabs of the same saved session never collide on one
// session; stable once minted because the frontend persists it per-leaf in the
// workspace layout and replays it on restore (and the pane keeps it across a
// reconnect).
func mintTmuxID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(buf[:])
}

// tmuxExtraPath lists directories where tmux commonly lives that a non-login
// SSH exec shell may leave off PATH — notably Homebrew on macOS
// (/opt/homebrew/bin on Apple Silicon, /usr/local/bin on Intel) and common
// /usr/local installs. SSH command execution (`ssh host cmd`) runs the user's
// shell non-login + non-interactive, so it gets the bare /usr/bin:/bin PATH and
// `command -v tmux` / `exec tmux` would miss a Homebrew tmux even though it
// works fine in the user's interactive terminal. We prepend these so detect,
// launch, and kill all find tmux regardless.
const tmuxExtraPath = "/opt/homebrew/bin:/usr/local/bin:/opt/local/bin"

// withTmuxPath prefixes a shell command with a PATH that includes the common
// Homebrew / MacPorts / local-install locations (see tmuxExtraPath), so tmux
// is found over a non-login SSH exec. $PATH is expanded by the remote shell.
func withTmuxPath(cmd string) string {
	return `export PATH="$PATH:` + tmuxExtraPath + `"; ` + cmd
}

// tmuxLaunchCmd is the command the PTY runs to attach-or-create the named
// tmux session. `exec` replaces the login shell so exiting tmux closes the SSH
// channel cleanly. new-session -A attaches if the session already exists, else
// creates it.
//
// Option scoping matters:
//   - history-limit is set GLOBALLY before new-session, because it's read when
//     a window is created — setting it afterwards wouldn't apply to the first
//     window. The global default is benign (just bigger scrollback).
//   - status, mouse, set-clipboard are set SESSION-scoped AFTER new-session, so
//     we only touch OUR session, not the user's other tmux sessions on that
//     host.
//
// mouse + clipboard, the careful bit (so scroll AND copy both work):
//   - `mouse on` so the wheel scrolls tmux's scrollback. (With mouse off, tmux
//     is on the alternate screen and the terminal turns the wheel into arrow
//     keys — which cycles shell history instead of scrolling.)
//   - `set-clipboard on` so a mouse selection (and any copy) makes tmux emit an
//     OSC 52 sequence; the frontend's OSC 52 handler writes it to the system
//     clipboard, so a mouse drag auto-copies.
//   - `set -as terminal-features …:clipboard` — REQUIRED, or set-clipboard is a
//     no-op: tmux only emits OSC 52 when it believes the outer terminal
//     advertises clipboard support (the `Ms` capability). Our PTY is
//     xterm-256color, whose terminfo often lacks `Ms`, so we declare the
//     feature explicitly. (Native xterm.js selection via Shift+drag also works
//     — it bypasses tmux mouse reporting — as a config-independent fallback.)
//
// Graceful fallback: the `command -v tmux && exec tmux …` guard means that if
// tmux is missing or unrunnable at launch (a rare detect-vs-launch race, or a
// remote that lost tmux between connects), the `exec tmux` never happens and we
// fall through to `exec $SHELL -l` — so the user always gets a working login
// shell instead of a dead pane, just without persistence. (terminal-features is
// last so an "unknown option" on an ancient tmux can't abort the rest.)
func tmuxLaunchCmd(name string) string {
	return withTmuxPath("command -v tmux >/dev/null 2>&1 && exec tmux set-option -g history-limit " + strconv.Itoa(tmuxHistoryLimit) +
		` \; new-session -A -s ` + transport.ShQuote(name) +
		` \; set-option status off \; set-option mouse on \; set-option set-clipboard on` +
		` \; set-option -as terminal-features ',xterm*:clipboard'` +
		` ; exec "${SHELL:-/bin/sh}" -l`)
}

// resolveTmuxLaunch probes the remote for tmux and whether the named session
// already exists. ok=false means tmux isn't available (caller falls back to a
// plain auto-reconnecting shell). created reports whether the session is NEW
// (caller runs connect-init) vs an existing one being re-attached (init
// skipped — it's already set up and may be mid-command).
func (p *Pane) resolveTmuxLaunch(client *ssh.Client, name string) (launch string, created, ok bool) {
	q := transport.ShQuote(name)
	detect := withTmuxPath("if command -v tmux >/dev/null 2>&1; then echo " + tmuxDetectMarker +
		"; tmux has-session -t " + q + " 2>/dev/null && echo " + tmuxHasMarker + "; fi")
	out, _ := transport.RunWithTimeout(client, detect, 6*time.Second)
	if !strings.Contains(out, tmuxDetectMarker) {
		return "", false, false
	}
	exists := strings.Contains(out, tmuxHasMarker)
	return tmuxLaunchCmd(name), !exists, true
}

// setupPersistence resolves the tmux launch command for a pane at connect
// time and records it (with the session name) so the reconnect supervisor can
// replay it and CloseKill can later kill it. It returns the launch command
// ("" = plain login shell) and whether the caller should run connect-time init
// (true for a non-persistent or freshly-created session; false when
// re-attaching an existing tmux session). Logs the outcome — including the
// silent fall back to Phase A when there's no tmux.
//
// Whether the pane is tmux-backed is decided solely by p.tmuxID — the per-pane
// durable token set in Manager.OpenInDir (minted for a fresh Persist open, or
// restored from the workspace layout). It is deliberately NOT re-gated on the
// live Session.Persist flag: a pane that came up on tmux stays on tmux across
// reconnects and restarts even if the "Persistent session" toggle was flipped
// off afterwards, so flipping it never silently downgrades a running pane (or
// orphans its remote session) — the toggle only governs future opens.
func (p *Pane) setupPersistence(client *ssh.Client) (launch string, runInit bool) {
	if p.tmuxID == "" {
		return "", true
	}
	// p.tmuxID is set under m.mu in Manager.OpenInDir before connect, so it's
	// already set here (and reading it needs no lock — the reaper reads other
	// panes' tmuxID, never this one's, while this pane connects).
	name := tmuxName(p.appInstanceID, p.tmuxID)
	l, created, ok := p.resolveTmuxLaunch(client, name)
	if !ok {
		p.logDim("tmux not found on remote — session persistence off (auto-reconnect still active)")
		return "", true
	}
	p.tmuxName = name
	p.tmuxLaunch = l
	events.EmitPaneTmux(p.appCtx, p.ID, true)
	verb := "re-attaching"
	if created {
		verb = "starting"
	}
	p.logDim("Persistent session: " + verb + " tmux session " + name)
	return l, created
}

// killPersistentSession ends the pane's tmux session on the remote (used when
// the user explicitly closes the pane/tab — see CloseKill). No-op for a
// non-persistent pane. Best-effort: if the pane isn't connected there's no
// channel to run kill-session over, so the session is left running and a note
// is logged. Must be called while the connection is still live (before Close
// tears the shell down).
func (p *Pane) killPersistentSession() {
	name := p.tmuxName
	if name == "" {
		return
	}
	sh := p.currentSSH()
	if sh == nil || sh.Client == nil {
		p.logDim("Persistent session " + name + " left running (no live connection to end it)")
		return
	}
	_, _ = transport.RunWithTimeout(sh.Client, withTmuxPath("tmux kill-session -t "+transport.ShQuote(name)+" 2>/dev/null"), 5*time.Second)
	p.logDim("Ended persistent session " + name)
}

// logDim emits a dim connection-log line — the audit trail for the otherwise
// invisible shell substitution (tmux wrap), the Phase-A fallback, and the
// kill-on-close.
func (p *Pane) logDim(msg string) {
	events.EmitConnectionLog(p.appCtx, p.ID, events.LogDim, nowMillis(), msg)
}
