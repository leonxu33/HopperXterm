package pane

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"strings"

	"hopperxterm/events"
	"hopperxterm/logbook"
	"hopperxterm/transport"
)

// "Follow terminal folder" has two backends, picked by EnableCwdFollow:
//
//   - Plain shells: the OSC 7 PROMPT_COMMAND hook (installOsc7Hook). The
//     readLoop scans the PTY stream for the emitted escape.
//   - tmux-backed panes: the side-channel poller in this file. The OSC 7
//     inject can't be used inside tmux — tmux maintains its own screen model,
//     so swallowing the inject's echo desyncs the client (a blank gap, leaked
//     command text on the next redraw). Instead we poll tmux's
//     #{pane_current_path}, which tmux derives from the pane process's real cwd
//     (via /proc on Linux, a syscall on macOS) and so tracks `cd` with no
//     shell hook at all.

// EnableCwdFollow turns on cwd tracking for the pane's "Follow terminal folder"
// toggle, routing to the tmux poller or the OSC 7 hook as appropriate. Both
// paths are idempotent, so a repeat call while already following is a no-op.
func (p *Pane) EnableCwdFollow() error {
	if p.tmuxName != "" {
		return p.startCwdFollow()
	}
	// Plain shell: inject the OSC 7 hook, but only once. Re-injecting on a
	// repeat toggle would type the hook command into whatever holds the prompt
	// (a foregrounded vim / REPL), so skip if it's already in place from the
	// connect-time auto-install or an earlier toggle.
	p.swallowMu.Lock()
	installed := p.osc7Installed
	p.swallowMu.Unlock()
	if installed {
		return nil
	}
	return p.installOsc7Hook("Follow terminal folder")
}

// DisableCwdFollow stops cwd tracking started by EnableCwdFollow. Only the tmux
// poller — which holds an open exec channel — needs tearing down; the OSC 7
// hook is left in place (harmless, and re-injecting to remove it would type
// into a possibly-foregrounded full-screen app).
func (p *Pane) DisableCwdFollow() {
	p.stopCwdFollow()
}

// startCwdFollow opens a dedicated exec channel that prints the pane's tmux
// working directory once per second and emits pane:cwd on change. The session
// name is the poller's target; tmux resolves it to the pane and reports its
// real cwd. Already-following is a no-op.
func (p *Pane) startCwdFollow() error {
	sh := p.currentSSH()
	if sh == nil || sh.Client == nil {
		return errors.New("pane: cwd follow requires an SSH-backed session")
	}
	name := p.tmuxName
	if name == "" {
		return errors.New("pane: cwd follow is only for tmux-backed panes")
	}

	p.cwdFollowMu.Lock()
	defer p.cwdFollowMu.Unlock()
	if p.cwdFollowCancel != nil {
		return nil // already following
	}

	sess, err := sh.Client.NewSession()
	if err != nil {
		return fmt.Errorf("cwd follow: open session: %w", err)
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		sess.Close()
		return fmt.Errorf("cwd follow: stdout pipe: %w", err)
	}
	// `|| break` ends the loop (and the stream) cleanly if the tmux session is
	// gone, so the reader goroutine exits instead of spinning on errors.
	cmd := withTmuxPath("while :; do tmux display-message -p -t " +
		transport.ShQuote(name) + " '#{pane_current_path}' 2>/dev/null || break; sleep 1; done")
	if err := sess.Start(cmd); err != nil {
		sess.Close()
		return fmt.Errorf("cwd follow: start poller: %w", err)
	}

	ctx, cancel := context.WithCancel(p.ctx)
	p.cwdFollowGen++
	gen := p.cwdFollowGen
	p.cwdFollowCancel = cancel

	go func() {
		defer logbook.Recover("pane.cwdFollow")
		// Closing the session ends the remote loop and unblocks the next Read.
		// On an explicit stop (cancel) the reader notices ctx within one tick
		// (≤1 s, the poll interval) and falls through to here — the same
		// teardown the process-monitor poller relies on, so no extra watcher
		// goroutine is needed.
		defer func() {
			_ = sess.Close()
			// Self-cleanup if the stream ended on its own (tmux session gone /
			// link dropped). Guard by generation so we never clear a newer
			// poller a later Enable installed.
			p.cwdFollowMu.Lock()
			if p.cwdFollowGen == gen {
				p.cwdFollowCancel = nil
			}
			p.cwdFollowMu.Unlock()
		}()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 4096), 16384)
		var last string
		for scanner.Scan() {
			if ctx.Err() != nil {
				return
			}
			path := strings.TrimSpace(scanner.Text())
			if path == "" || path == last {
				continue
			}
			last = path
			p.cwdMu.Lock()
			p.lastCwd = path
			p.cwdMu.Unlock()
			// host is left empty: tmux reports only the path, and the sole
			// pane:cwd consumer (the Remote Files panel) reads cwd only. The
			// OSC 7 path fills host from $HOSTNAME; if a future consumer needs
			// it here, derive it from the pane's probed host info.
			events.EmitPaneCwd(p.appCtx, p.ID, path, "")
		}
		p.logScanErr("cwd follow", scanner.Err())
	}()
	return nil
}

// stopCwdFollow tears down the tmux cwd poller if one is running. Safe to call
// when not following (no-op) and from pane teardown.
func (p *Pane) stopCwdFollow() {
	p.cwdFollowMu.Lock()
	defer p.cwdFollowMu.Unlock()
	if p.cwdFollowCancel != nil {
		p.cwdFollowCancel()
		p.cwdFollowCancel = nil
	}
}
