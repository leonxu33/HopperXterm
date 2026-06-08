// Package logbook is HopperXterm's single logging sink. Both the Go backend
// (every wailsruntime.Log* call) and the React frontend (every
// @wailsapp/runtime Log* call) are routed here by registering WailsLogger()
// as the Wails options.App.Logger, so one timestamped, rotated, redacted file
// captures the whole picture:
//
//	<appdir.Base()>/logs/hopperxterm.log
//
// Lines are scrubbed by redact() before they hit disk (see redact.go), the
// file is size-rotated by lumberjack, and the level is controlled by the
// HOPPERTERM_LOG_LEVEL env var (default Debug under the `dev` build tag, Info
// in release). Under `dev` the log also tees to stdout so `wails dev` stays
// convenient.
package logbook

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/logger"
	"gopkg.in/natefinch/lumberjack.v2"

	"hopperxterm/appdir"
)

// EnvLevel overrides the log level (debug|info|warn|error). Mirrors the
// HOPPERTERM_CONFIG_DIR convention used by appdir.
const EnvLevel = "HOPPERTERM_LOG_LEVEL"

const (
	logsDir = "logs"
	logFile = "hopperxterm.log"

	maxSizeMB  = 5  // rotate at 5 MB
	maxBackups = 5  // keep 5 rotated files
	maxAgeDays = 30 // and at most 30 days
)

var (
	mu     sync.Mutex
	lvl    = new(slog.LevelVar)
	sink   *slog.Logger
	rotor  *lumberjack.Logger
	inited bool
)

// Init opens (or creates) the log file under appdir.Base()/logs, wires up the
// slog handler + lumberjack rotation, and resolves the level. Safe to call
// once at startup; subsequent calls are no-ops. If the config dir cannot be
// resolved the logger degrades to stderr so startup failures are still seen.
func Init() {
	mu.Lock()
	defer mu.Unlock()
	if inited {
		return
	}
	inited = true

	lvl.Set(defaultLevel())
	if env := strings.TrimSpace(os.Getenv(EnvLevel)); env != "" {
		if l, ok := parseLevel(env); ok {
			lvl.Set(l)
		}
	}

	var w io.Writer
	if base, err := appdir.Base(); err == nil {
		dir := filepath.Join(base, logsDir)
		if mkErr := os.MkdirAll(dir, 0o755); mkErr == nil {
			rotor = &lumberjack.Logger{
				Filename:   filepath.Join(dir, logFile),
				MaxSize:    maxSizeMB,
				MaxBackups: maxBackups,
				MaxAge:     maxAgeDays,
				Compress:   true,
			}
			w = rotor
		}
	}
	if w == nil {
		// Could not resolve/create the log dir — fall back to stderr so a
		// broken config dir is still diagnosable.
		w = os.Stderr
	} else if devBuild {
		// In dev, mirror to stdout for live `wails dev` feedback.
		w = io.MultiWriter(w, os.Stdout)
	}

	sink = slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: lvl}))
}

// Close flushes and closes the underlying log file. Wired to app shutdown.
// It nils the sink under the lock so any in-flight emit() from a still-winding-
// down pane goroutine becomes a clean no-op rather than racing a closed file.
func Close() error {
	mu.Lock()
	defer mu.Unlock()
	var err error
	if rotor != nil {
		err = rotor.Close()
	}
	sink = nil
	rotor = nil
	return err
}

func defaultLevel() slog.Level {
	if devBuild {
		return slog.LevelDebug
	}
	return slog.LevelInfo
}

func parseLevel(s string) (slog.Level, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug", "trace":
		return slog.LevelDebug, true
	case "info":
		return slog.LevelInfo, true
	case "warn", "warning":
		return slog.LevelWarn, true
	case "error", "fatal":
		return slog.LevelError, true
	}
	return 0, false
}

// emit is the single chokepoint: redact, then log at the given level. Safe
// before Init() (no-op) so early callers never panic. The Enabled() gate skips
// redaction (6 regex sweeps) for lines the level would discard anyway — e.g.
// high-volume Debug in a release build.
func emit(level slog.Level, msg string) {
	// Held through the write so Close() can't shut the file mid-emit; logging
	// is low-volume (level-gated; never per terminal byte) so the contention
	// is immaterial.
	mu.Lock()
	defer mu.Unlock()
	if sink == nil || !sink.Enabled(context.Background(), level) {
		return
	}
	sink.Log(context.Background(), level, redact(msg))
}

// Package-level helpers for code paths without a Wails ctx (goroutines, main).

// Debug logs at debug level.
func Debug(msg string) { emit(slog.LevelDebug, msg) }

// Info logs at info level.
func Info(msg string) { emit(slog.LevelInfo, msg) }

// Warn logs at warning level.
func Warn(msg string) { emit(slog.LevelWarn, msg) }

// Error logs at error level.
func Error(msg string) { emit(slog.LevelError, msg) }

// ---- Wails logger adapter --------------------------------------------------

// wailsLogger satisfies wails logger.Logger so that both wailsruntime.Log*
// (backend) and @wailsapp/runtime Log* (frontend) funnel into the same file.
type wailsLogger struct{}

func (wailsLogger) Print(message string)   { emit(slog.LevelInfo, message) }
func (wailsLogger) Trace(message string)   { emit(slog.LevelDebug, message) }
func (wailsLogger) Debug(message string)   { emit(slog.LevelDebug, message) }
func (wailsLogger) Info(message string)    { emit(slog.LevelInfo, message) }
func (wailsLogger) Warning(message string) { emit(slog.LevelWarn, message) }
func (wailsLogger) Error(message string)   { emit(slog.LevelError, message) }

// Fatal logs at error level but does NOT exit: killing a GUI process on a log
// call would be worse than a logged error. Marked so it stands out.
func (wailsLogger) Fatal(message string) { emit(slog.LevelError, "FATAL: "+message) }

// WailsLogger returns the adapter to register as options.App.Logger.
func WailsLogger() logger.Logger { return wailsLogger{} }

// WailsLogLevel is the level to pass for both options.App.LogLevel and
// LogLevelProduction. We let Wails forward everything at our resolved level
// (default Info in release) and do the real filtering in the slog handler.
// Returning Info — not Wails' production default of ERROR — guarantees
// requirement: all warnings AND errors reach the file, including frontend ones.
func WailsLogLevel() logger.LogLevel {
	switch lvl.Level() {
	case slog.LevelDebug:
		return logger.DEBUG
	case slog.LevelWarn:
		return logger.WARNING
	case slog.LevelError:
		return logger.ERROR
	default:
		return logger.INFO
	}
}
