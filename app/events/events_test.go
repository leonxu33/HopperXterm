package events

import (
	"context"
	"testing"
)

// All EmitX helpers funnel through safeEmit, which is a no-op unless the
// context carries Wails' "events" key. With a vanilla background context
// (and a nil context) every wrapper must run cleanly without reaching the
// real runtime — this is exactly the path tests and non-Wails callers hit.
func TestEmitters_NoopWithoutWailsContext(t *testing.T) {
	ctx := context.Background()

	// Must not panic and must not call into the Wails runtime.
	EmitPaneOutput(ctx, "p", []byte("hello"))
	EmitPaneCwd(ctx, "p", "/home", "host")
	EmitPaneState(ctx, "p", PaneState("Connected"), "ok")
	EmitConnectionLog(ctx, "p", LogOK, 123, "msg")
	EmitConnectionLog(ctx, "p", LogErr, 124, "bad")
	EmitConnectionLog(ctx, "p", LogDim, 125, "dim")
	EmitSftpTransfer(ctx, "p", SftpTransferPayload{ID: 1, Kind: "upload", State: "running"})
	EmitResourceSample(ctx, "p", ResourceSample{TS: 1, CPUPct: 5})
	EmitHostInfo(ctx, "p", HostInfo{Name: "Ubuntu", Version: "24.04"})
	EmitAskSavePassword(ctx, "p", "s", "host", "user")
	EmitAskPassword(ctx, "p", "s", "host", "user", "Password:")

	// nil context also takes the guard's early return.
	EmitPaneOutput(nil, "p", []byte("x"))
	EmitPaneState(nil, "p", PaneState("X"), "")
}
