//go:build !windows && !darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

// quitAfterInstall: the Linux AppImage update replaces the running .AppImage in
// place, so the app must quit to let the detached helper swap + relaunch it.
// On non-AppImage builds (and other unix-likes), launchUpdateInstaller returns
// an error before the quit branch in DownloadAndApplyUpdate runs, so the app
// stays put — this const is only acted on when the launch actually succeeds.
const quitAfterInstall = true

// launchUpdateInstaller performs an automatic in-place update on Linux when the
// app is running as an AppImage — the same end-to-end experience as Windows and
// macOS (quit → replace → relaunch).
//
// AppImage specifics:
//   - A running AppImage is FUSE-mounted read-only under /tmp/.mount_*, so
//     os.Executable() points INTO the mount, not at the .AppImage file. The
//     AppImage runtime exports $APPIMAGE with the real path of the .AppImage on
//     disk — that's what we replace.
//   - The new AppImage is a single executable file, so the swap is a copy to a
//     sibling temp path (same filesystem) + atomic rename over $APPIMAGE, then
//     a chmod +x and relaunch. No elevation (the user owns the file), and no
//     job-object problem (the Setsid-detached helper reparents to init).
//
// If the app isn't running from an AppImage ($APPIMAGE unset — e.g. a bare
// `go build` binary or a non-Linux unix), there's nothing to replace in place,
// so we return an error and the frontend routes the user to the manual
// "View release" download. Every step is logged to update.log next to the
// download.
func launchUpdateInstaller(installerPath string) error {
	if runtime.GOOS != "linux" {
		return fmt.Errorf("automatic update isn't supported on this platform — download the new version manually")
	}
	target := strings.TrimSpace(os.Getenv("APPIMAGE"))
	if target == "" {
		return fmt.Errorf("automatic update is only supported for the AppImage build — download the new version manually")
	}

	// Make the freshly downloaded AppImage runnable before we hand it over.
	_ = os.Chmod(installerPath, 0o755)

	tmpDir := filepath.Dir(installerPath)
	logPath := filepath.Join(tmpDir, "update.log")
	scriptPath := filepath.Join(tmpDir, "apply-update.sh")
	pid := os.Getpid()

	// Bash helper. sh-quote every path (single quotes, embedded quotes escaped).
	// TMP sits next to the target so the final mv is an atomic same-filesystem
	// rename rather than a cross-device copy.
	script := fmt.Sprintf(`#!/bin/bash
LOG=%s
log(){ echo "[$(date -u +%%FT%%TZ)] $1" >> "$LOG"; }
log "helper started; waiting for pid %d to exit"
for i in $(seq 1 240); do kill -0 %d 2>/dev/null || break; sleep 0.5; done
sleep 0.5
SRC=%s
DEST=%s
TMP="${DEST}.update-tmp"
log "installing $SRC -> $DEST"
rm -f "$TMP"
if cp -f "$SRC" "$TMP"; then
  chmod +x "$TMP"
  if mv -f "$TMP" "$DEST"; then
    log "replaced AppImage"
  else
    log "rename failed; leaving existing install untouched"
    rm -f "$TMP"
  fi
else
  log "copy failed; leaving existing install untouched"
  rm -f "$TMP"
fi
log "relaunching $DEST"
setsid "$DEST" >/dev/null 2>&1 < /dev/null &
rm -f %s
log "helper finished"
`,
		shQuote(logPath),
		pid, pid,
		shQuote(installerPath), shQuote(target),
		shQuote(installerPath),
	)

	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		return fmt.Errorf("writing updater script: %w", err)
	}

	cmd := exec.Command("/bin/bash", scriptPath)
	// Setsid detaches the helper into its own session so it outlives our exit.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("launching updater helper: %w", err)
	}
	return cmd.Process.Release() // must outlive us — never Wait
}

// shQuote wraps s in single quotes for safe use in a bash command, escaping
// embedded single quotes the standard way ('\''). This is the build-tagged twin
// of update_darwin.go's shQuote — the two files are never compiled together, so
// the shared name is fine and mirrors how quitAfterInstall / launchUpdateInstaller
// are each redefined per platform file.
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
