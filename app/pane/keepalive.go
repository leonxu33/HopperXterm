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

// keepaliveLoop pings the remote every keepaliveInterval. One miss puts
// the pane in Suspect — the UI surfaces a warn indicator, and the next
// successful ping recovers to Connected. Two consecutive misses (~10 s)
// hand off to the reconnect coordinator: a durable pane auto-reconnects,
// any other falls to Disconnected. gen tags the connection this loop
// belongs to so it stops cleanly once a reconnect supersedes it.
//
// Exits when the pane context is cancelled, when its generation is
// superseded, or after declaring the connection ended; the read loop's
// own EOF handling covers the case where the kernel-level TCP error
// fires before keepalive can.
func (p *Pane) keepaliveLoop(gen int) {
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

		// Stop once a reconnect has replaced this connection.
		if !p.genCurrent(gen) {
			return
		}
		sh := p.currentSSH()
		if sh == nil {
			return
		}
		ok := sh.Ping(p.ctx, keepalivePingTimeout)

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
			events.EmitConnectionLog(p.appCtx, p.ID, events.LogErr, nowMillis(), "Keepalive failed twice")
			// Hand off to the coordinator: durable panes auto-reconnect,
			// others go to Disconnected. It tears the dead shell down so
			// the read loop sees EOF and exits.
			p.onConnectionEnded(gen, "keepalive failures")
			return
		}
	}
}
