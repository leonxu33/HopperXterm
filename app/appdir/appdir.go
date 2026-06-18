// Package appdir resolves the single directory under which HopperXterm
// keeps its JSON records (sessions, groups, workspaces, macros, recents).
// It is the one source of truth for that location so every store agrees.
//
// Resolution order:
//  1. $HOPPERTERM_CONFIG_DIR — an absolute override (tests, portable
//     installs, or pinning dev data somewhere specific).
//  2. os.UserConfigDir()/<subdir>, where subdir is "hopperxterm" in
//     release builds and "hopperxterm-dev" under the `dev` build tag that
//     `wails dev` compiles with — so development never reads or writes
//     real user data.
package appdir

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// EnvOverride is the env var that, when set, is used verbatim as the base
// directory (highest precedence).
const EnvOverride = "HOPPERTERM_CONFIG_DIR"

// Base returns the directory the stores should persist into.
func Base() (string, error) {
	if override := os.Getenv(EnvOverride); override != "" {
		return override, nil
	}
	cfg, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cfg, subdir), nil
}

var (
	instOnce sync.Once
	instID   string
)

// InstanceID returns a stable random identifier for THIS config directory,
// created on first use and persisted in <Base>/instance-id. Because dev and
// release builds resolve to different config dirs (see subdir), each gets its
// own ID — which is what isolates their durable tmux sessions on a shared
// remote: a session named hopperxterm-<instanceID>-… is only ever listed or
// reaped by the instance that owns that ID, so a dev build can't touch a prod
// build's sessions (or vice versa). Best-effort and cached for the process: if
// the dir/file can't be read or written it returns a fresh value so naming
// still works (just not stable across restarts).
func InstanceID() string {
	instOnce.Do(func() { instID = loadOrCreateInstanceID() })
	return instID
}

func loadOrCreateInstanceID() string {
	base, err := Base()
	if err != nil {
		return randomID()
	}
	path := filepath.Join(base, "instance-id")
	if b, err := os.ReadFile(path); err == nil {
		if s := strings.TrimSpace(string(b)); s != "" {
			return s
		}
	}
	id := randomID()
	if err := os.MkdirAll(base, 0o700); err == nil {
		_ = os.WriteFile(path, []byte(id+"\n"), 0o600)
	}
	return id
}

func randomID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(buf[:])
}
