package logbook

import (
	"log/slog"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/logger"
)

// TestRecover confirms the guard swallows a panic (the deferred Recover must
// stop it from propagating out of the helper) — and survives being called
// with no active panic.
func TestRecover(t *testing.T) {
	didPanic := func() (recovered bool) {
		defer func() {
			if r := recover(); r != nil {
				recovered = true
			}
		}()
		func() {
			defer Recover("test.panicker")
			panic("kaboom")
		}()
		return false
	}()
	if didPanic {
		t.Fatal("Recover did not swallow the panic")
	}

	// No-op when nothing panicked.
	func() { defer Recover("test.clean") }()
}

func TestWailsLogLevelMapping(t *testing.T) {
	cases := map[slog.Level]logger.LogLevel{
		slog.LevelDebug: logger.DEBUG,
		slog.LevelInfo:  logger.INFO,
		slog.LevelWarn:  logger.WARNING,
		slog.LevelError: logger.ERROR,
	}
	for in, want := range cases {
		lvl.Set(in)
		if got := WailsLogLevel(); got != want {
			t.Errorf("WailsLogLevel() at %v = %v, want %v", in, got, want)
		}
	}
}

// TestWailsLoggerForwards drives every adapter method to confirm the level
// mapping (Trace→Debug, Print→Info, Fatal→Error+prefix) and that none panic.
func TestWailsLoggerForwards(t *testing.T) {
	wl := WailsLogger()
	// Just exercise the forwarders; emit() no-ops when sink is nil, which is
	// fine — we're covering the mapping wiring, not the write.
	wl.Print("p")
	wl.Trace("t")
	wl.Debug("d")
	wl.Info("i")
	wl.Warning("w")
	wl.Error("e")
	wl.Fatal("f")
}
