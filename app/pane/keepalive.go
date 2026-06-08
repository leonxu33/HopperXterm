package pane

import (
	"time"

	"hopperxterm/events"
	"hopperxterm/logbook"
)

const (
	keepaliveInterval       = 5 * time.Second
	keepalivePingTimeout    = 4 * time.Second
	missesUntilSuspect      = 1
	missesUntilDisconnected = 2
)

// keepaliveLoop pings the remote every keepaliveInterval. Two consecutive
// misses (~10 s) demote the pane to Disconnected and tear the shell down
// so the read loop exits and the UI stops waiting on a dead socket. One
// miss puts the pane in Suspect — the UI surfaces a warn indicator, and
// the next successful ping recovers to Connected.
//
// Exits when the pane context is cancelled or after declaring
// Disconnected; the read loop's own EOF handling covers the case where
// the kernel-level TCP error fires before keepalive can.
func (p *Pane) keepaliveLoop() {
	defer logbook.Recover("pane.keepaliveLoop")
	ticker := time.NewTicker(keepaliveInterval)
	defer ticker.Stop()

	misses := 0
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
		}

		if p.ssh == nil {
			return
		}
		ok := p.ssh.Ping(p.ctx, keepalivePingTimeout)

		if ok {
			if misses > 0 {
				misses = 0
				if p.State() == StateSuspect {
					p.transition(StateConnected, "")
					events.EmitConnectionLog(p.appCtx, p.ID, events.LogOK, nowMillis(), "Keepalive recovered")
				}
			}
			continue
		}

		misses++
		switch {
		case misses == missesUntilSuspect:
			p.transition(StateSuspect, "keepalive missed")
			events.EmitConnectionLog(p.appCtx, p.ID, events.LogDim, nowMillis(), "Keepalive missed (suspect)")
		case misses >= missesUntilDisconnected:
			events.EmitConnectionLog(p.appCtx, p.ID, events.LogErr, nowMillis(), "Keepalive failed twice — disconnecting")
			p.transition(StateDisconnected, "keepalive failures")
			// Close the shell so the read loop sees EOF and exits.
			// The Pane stays in Manager until the frontend asks to close
			// it (responding to the pane:state:Disconnected event).
			if p.ssh != nil {
				_ = p.ssh.Close()
			}
			return
		}
	}
}
