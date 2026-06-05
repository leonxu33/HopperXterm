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
	"os"
	"path/filepath"
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
