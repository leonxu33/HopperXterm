package pane

// Durable sessions (Phase A): auto-reconnect for SSH/EC2 panes.
//
// When a connection drops unexpectedly, a durable pane re-dials in place
// — same Pane object, same paneID, so the frontend Terminal keeps its
// subscription and client-side scrollback — with exponential backoff,
// instead of parking at "Press r to reconnect." A clean remote shell
// exit (the user typed `exit`) and a user-initiated Close are NOT drops
// and never trigger a reconnect. Auto-reconnect dials with keys + the
// saved password only (no interactive prompt), and gives up on an auth
// failure (which won't fix itself) but retries network failures forever
// while the pane is open, so the session comes back when the link does.
//
// Phase A does NOT preserve remote shell state (running processes,
// environment, server-side scrollback) — a dropped SSH channel SIGHUPs
// the remote shell, so each reconnect is a fresh login. It does restore
// the working directory via the OSC 7 cwd we already track. True shell
// persistence would need a server-side multiplexer (tmux) — that's a
// possible Phase B, and this reconnect machinery is what it would
// re-attach through.

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"hopperxterm/events"
	"hopperxterm/logbook"
	"hopperxterm/transport"
)

const (
	reconnectInitialBackoff = 1 * time.Second
	reconnectMaxBackoff     = 30 * time.Second
)

// setConn atomically swaps the pane's transport pointers. pty is the
// generic I/O channel; shell is the SSH-specific handle (nil for
// local / WSL). Pass (nil, nil) to mark the pane unplugged.
func (p *Pane) setConn(shell *transport.Shell, pty transport.PtyChannel) {
	p.connMu.Lock()
	p.ssh = shell
	p.pty = pty
	p.connMu.Unlock()
}

// currentSSH returns the live SSH shell handle, or nil if the pane is
// not SSH-backed or is mid-reconnect.
func (p *Pane) currentSSH() *transport.Shell {
	p.connMu.RLock()
	defer p.connMu.RUnlock()
	return p.ssh
}

// currentPTY returns the live PTY channel, or nil if the pane is
// unplugged (closed or mid-reconnect).
func (p *Pane) currentPTY() transport.PtyChannel {
	p.connMu.RLock()
	defer p.connMu.RUnlock()
	return p.pty
}

// nextGen bumps the connection generation and returns it. Every
// (re)connect tags its read/keepalive goroutines with the value so a
// goroutine from a superseded connection can tell it's stale.
func (p *Pane) nextGen() int {
	p.reconnMu.Lock()
	defer p.reconnMu.Unlock()
	p.gen++
	return p.gen
}

// genCurrent reports whether gen is still the live connection generation.
func (p *Pane) genCurrent(gen int) bool {
	p.reconnMu.Lock()
	defer p.reconnMu.Unlock()
	return gen == p.gen
}

// currentGeneration returns the live connection generation under lock.
func (p *Pane) currentGeneration() int {
	p.reconnMu.Lock()
	defer p.reconnMu.Unlock()
	return p.gen
}

// teardownShell closes the file client and the live transport, then
// unplugs the pointers so any concurrent reader sees "not connected"
// rather than a dead handle. Idempotent.
func (p *Pane) teardownShell() {
	p.fileMu.Lock()
	if p.file != nil {
		_ = p.file.Close()
		p.file = nil
	}
	p.fileMu.Unlock()

	p.connMu.Lock()
	sh, pty := p.ssh, p.pty
	p.ssh, p.pty = nil, nil
	p.connMu.Unlock()

	// For SSH panes ssh == pty (the same *Shell); close it once.
	if sh != nil {
		_ = sh.Close()
	} else if pty != nil {
		_ = pty.Close()
	}
}

// onConnectionEnded is the single coordinator for a connection ending.
// It's called by whichever goroutine notices first — the readLoop on
// stream EOF/error or the keepaliveLoop on repeated misses — and dedups
// via the connection generation + the handling flag so the two don't
// both act. gen is the caller's connection generation; reason is empty
// for a bare EOF and set for a transport error.
//
// Decision: a clean remote exit or a user close ends the pane (graceful
// "Press r"); an unexpected drop on a durable pane starts the reconnect
// loop. Clean vs. drop for an empty-reason EOF is settled by a keepalive
// ping — if the SSH link still answers, the remote shell exited on its
// own; if not, the connection dropped. A transport error is a drop. A
// local/WSL pane (no SSH client) treats any EOF as a clean exit.
func (p *Pane) onConnectionEnded(gen int, reason string) {
	p.reconnMu.Lock()
	if p.closing || gen != p.gen || p.handling {
		p.reconnMu.Unlock()
		return
	}
	p.handling = true
	durable := p.durable
	p.reconnMu.Unlock()

	clean := false
	if sh := p.currentSSH(); sh != nil {
		clean = reason == "" && sh.Ping(p.ctx, keepalivePingTimeout)
	} else {
		clean = reason == ""
	}

	if !clean && durable {
		go p.reconnectLoop(reason)
		return
	}

	if clean {
		p.emitTerminalClosed()
		p.transition(StateDisconnected, "")
	} else {
		p.emitTerminalError(reason)
		p.transition(StateDisconnected, reason)
	}
	p.teardownShell()
}

// reconnectLoop re-dials a dropped durable pane with exponential backoff
// until it succeeds, the user closes the pane, or a permanent (auth)
// failure makes further attempts pointless. Runs on its own goroutine;
// onConnectionEnded guarantees exactly one is live per drop.
func (p *Pane) reconnectLoop(reason string) {
	defer logbook.Recover("pane.reconnectLoop")
	if strings.TrimSpace(reason) == "" {
		reason = "connection lost"
	}
	p.transition(StateReconnecting, reason)
	events.EmitConnectionLog(p.appCtx, p.ID, events.LogErr, nowMillis(), "Connection lost — reconnecting…")
	events.EmitPaneOutput(p.appCtx, p.ID, []byte("\r\n\x1b[1;33m⟳ Connection lost — reconnecting…\x1b[0m\r\n"))

	// Drop the dead shell so the old read/keepalive loops unwind and the
	// stale file client is dropped (it reopens against the new client).
	// The resource/process monitor *intent* (refcounts + map entries)
	// deliberately survives this so rearmMonitors can restore them.
	p.teardownShell()

	backoff := reconnectInitialBackoff
	for attempt := 1; ; attempt++ {
		select {
		case <-p.ctx.Done():
			return
		case <-time.After(backoff):
		}
		p.reconnMu.Lock()
		closing := p.closing
		p.reconnMu.Unlock()
		if closing {
			return
		}

		client, err := p.dialSSH(p.sess, false)
		if err == nil {
			if p.resumeSSHSession(client) {
				p.rearmMonitors()
				return
			}
			err = errors.New("shell allocation failed")
		}
		// An auth failure won't fix itself — stop and fall back to the
		// manual "Press r" path so the user can re-enter credentials.
		if dialIsPermanent(err) {
			events.EmitConnectionLog(p.appCtx, p.ID, events.LogErr, nowMillis(),
				"Auto-reconnect stopped: "+err.Error())
			p.emitTerminalError("Auto-reconnect failed: " + err.Error())
			p.transition(StateDisconnected, err.Error())
			return
		}
		events.EmitConnectionLog(p.appCtx, p.ID, events.LogDim, nowMillis(),
			fmt.Sprintf("Reconnect attempt %d failed: %s", attempt, err.Error()))
		if backoff *= 2; backoff > reconnectMaxBackoff {
			backoff = reconnectMaxBackoff
		}
	}
}

// resumeSSHSession brings a freshly dialed client up as the pane's live
// session: allocates a PTY, restores the last-known cwd, swaps the
// transport pointers, clears the handling flag, and restarts the
// read/keepalive/probe/connect-init goroutines under a new generation.
// Returns false (closing the client) if the PTY allocation fails so the
// caller keeps retrying.
func (p *Pane) resumeSSHSession(client *ssh.Client) bool {
	// Persistent (tmux-backed) panes replay the attach-or-create command, so
	// the re-dial lands back in the SAME tmux session — running processes,
	// environment, and scrollback intact. Plain panes get a fresh login shell.
	shell, err := transport.StartShellCmd(client, p.tmuxLaunch)
	if err != nil {
		_ = client.Close()
		return false
	}

	persistent := p.tmuxLaunch != ""
	if !persistent {
		// Phase A: a fresh shell can't keep running processes, but it can land
		// back in the last-known directory. (tmux preserves its own cwd, so
		// persistent panes skip this.)
		p.cwdMu.RLock()
		cwd := p.lastCwd
		p.cwdMu.RUnlock()
		p.initialDir = cwd
	}

	p.setConn(shell, shell)
	p.reconnMu.Lock()
	p.handling = false
	p.gen++
	gen := p.gen
	p.reconnMu.Unlock()

	events.EmitConnectionLog(p.appCtx, p.ID, events.LogOK, nowMillis(), "Reconnected")
	events.EmitPaneOutput(p.appCtx, p.ID, []byte("\x1b[1;32m✓ Reconnected.\x1b[0m\r\n"))
	p.transition(StateConnected, "")

	go p.readLoop(gen)
	go p.keepaliveLoop(gen)
	go p.probeHostInfo(client)
	// Re-attaching a live tmux session needs no init — it's already set up,
	// and injecting cwd/startup commands could corrupt a running command.
	if !persistent {
		p.runConnectInit(p.sess, true)
	}
	return true
}

// rearmMonitors restarts the resource + process monitors against the
// freshly reconnected session. Their exec channels died with the old
// client, but the *intent* survived the drop — resRefs for the host
// poller, the map entries for process monitors — so this relaunches each
// with its pre-drop refcount intact, keeping the frontend's later Stop
// calls balanced. Failures are logged, not fatal — the terminal is back.
func (p *Pane) rearmMonitors() {
	if err := p.restartResourceMonitor(); err != nil {
		events.EmitConnectionLog(p.appCtx, p.ID, events.LogDim, nowMillis(),
			"resource monitor not restarted after reconnect: "+err.Error())
	}
	for spec, refs := range p.activeProcessSpecs() {
		if err := p.restartProcessMonitor(spec, refs); err != nil {
			events.EmitConnectionLog(p.appCtx, p.ID, events.LogDim, nowMillis(),
				"process monitor "+spec+" not restarted after reconnect: "+err.Error())
		}
	}
}

// dialIsPermanent reports whether a dial error is a credential problem
// rather than a transient network one. Permanent errors stop the
// reconnect loop (retrying won't help); everything else — including a
// network failure during the SSH handshake — is treated as recoverable
// and worth retrying.
//
// It deliberately keys off *auth-specific* markers, NOT the generic
// "ssh handshake" wrapper: transport.DialSSH wraps every ssh.NewClientConn
// failure (the whole protocol/key-exchange phase, not just auth) as
// "transport: ssh handshake to <addr>: …", so a mid-handshake network
// blip (server closes during key exchange, EOF/RST before auth) would be
// misread as permanent and abort the reconnect — exactly the recoverable
// case the loop must retry. A real auth failure always carries one of
// the auth markers below.
func dialIsPermanent(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	for _, marker := range []string{
		"unable to authenticate",
		"no usable auth",
		"no supported methods",
		"password rejected",
	} {
		if strings.Contains(s, marker) {
			return true
		}
	}
	return false
}
