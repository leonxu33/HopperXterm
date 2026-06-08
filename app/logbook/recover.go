package logbook

import (
	"fmt"
	"runtime/debug"
)

// Recover is a deferred panic guard for long-lived goroutines. The codebase
// spawns per-pane reader/keepalive/monitor goroutines that, without this,
// would die silently on a panic — leaving "the pane just stopped working"
// with nothing in the log. Use as:
//
//	go func() {
//	    defer logbook.Recover("pane.readLoop")
//	    ...
//	}()
//
// The panic is logged at Error with its stack and then swallowed: one pane's
// crash must not take down the whole app.
func Recover(label string) {
	if r := recover(); r != nil {
		Error(fmt.Sprintf("panic in %s: %v\n%s", label, r, debug.Stack()))
	}
}
