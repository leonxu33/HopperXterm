//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// quitAfterInstall: like Windows, the app must exit so its .app bundle can be
// replaced in place; DownloadAndApplyUpdate quits shortly after the detached
// helper below is spawned.
const quitAfterInstall = true

// launchUpdateInstaller performs an automatic in-place update on macOS — the
// same end-to-end experience as Windows (quit → replace → relaunch), rather
// than the old "open the .dmg and make the user drag it" flow (which failed
// because the running app can't be replaced in /Applications).
//
// Steps:
//  1. Resolve the CURRENT app bundle from os.Executable() (…/Foo.app/Contents/
//     MacOS/Foo → …/Foo.app), so we update wherever the app is actually
//     installed.
//  2. Mount the downloaded .dmg (hdiutil attach) and locate the .app inside.
//  3. Write a detached bash helper that waits for THIS process to exit, ditto-
//     copies the new bundle over the current one (via a temp dir + atomic
//     rename), detaches the dmg, and relaunches the app.
//
// No elevation is needed: an app the user installed in /Applications (or
// ~/Applications) is owned by them, so the replace works without sudo. macOS
// doesn't kill child processes when the parent exits (they reparent to
// launchd), so a plain Setsid-detached helper survives our quit — no
// job-object dance like Windows. Every step is logged to update.log next to
// the installer.
func launchUpdateInstaller(installerPath string) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolving current executable: %w", err)
	}
	appBundle, err := bundlePath(exe)
	if err != nil {
		return err
	}

	mountPoint, err := mountDMG(installerPath)
	if err != nil {
		return err
	}
	srcApp, err := findAppBundle(mountPoint)
	if err != nil {
		// Best-effort detach so we don't leave the volume mounted on failure.
		_ = exec.Command("hdiutil", "detach", mountPoint, "-force", "-quiet").Run()
		return err
	}

	tmpDir := filepath.Dir(installerPath)
	logPath := filepath.Join(tmpDir, "update.log")
	scriptPath := filepath.Join(tmpDir, "apply-update.sh")
	pid := os.Getpid()

	// Bash helper. sh-quote every path (single quotes, embedded quotes escaped).
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
rm -rf "$TMP"
if ditto "$SRC" "$TMP"; then
  rm -rf "$DEST"
  mv "$TMP" "$DEST"
  log "replaced bundle"
else
  log "ditto failed; leaving existing install untouched"
  rm -rf "$TMP"
fi
hdiutil detach %s -quiet 2>/dev/null || hdiutil detach %s -force -quiet 2>/dev/null
log "relaunching $DEST"
open "$DEST" || log "relaunch failed"
rm -f %s
log "helper finished"
`,
		shQuote(logPath),
		pid, pid,
		shQuote(srcApp), shQuote(appBundle),
		shQuote(mountPoint), shQuote(mountPoint),
		shQuote(installerPath),
	)

	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		_ = exec.Command("hdiutil", "detach", mountPoint, "-force", "-quiet").Run()
		return fmt.Errorf("writing updater script: %w", err)
	}

	cmd := exec.Command("/bin/bash", scriptPath)
	// Setsid detaches the helper into its own session so it outlives our exit.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		_ = exec.Command("hdiutil", "detach", mountPoint, "-force", "-quiet").Run()
		return fmt.Errorf("launching updater helper: %w", err)
	}
	return cmd.Process.Release() // must outlive us — never Wait
}

// bundlePath turns …/Foo.app/Contents/MacOS/Foo into …/Foo.app.
func bundlePath(exe string) (string, error) {
	const marker = ".app/"
	if i := strings.Index(exe, marker); i >= 0 {
		return exe[:i+len(".app")], nil
	}
	return "", fmt.Errorf("not running from a .app bundle (%s); can't self-update", exe)
}

// mountDMG attaches the disk image and returns its /Volumes mount point.
func mountDMG(dmg string) (string, error) {
	out, err := exec.Command("hdiutil", "attach", dmg, "-nobrowse", "-noverify", "-noautoopen").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("mounting update image: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	// hdiutil prints a table; the mount point is the /Volumes/... path on the
	// line that has one (volume name has no spaces, set by hdiutil create).
	for _, line := range strings.Split(string(out), "\n") {
		if i := strings.Index(line, "/Volumes/"); i >= 0 {
			return strings.TrimSpace(line[i:]), nil
		}
	}
	return "", fmt.Errorf("could not determine mount point from hdiutil output")
}

// findAppBundle returns the first *.app inside dir.
func findAppBundle(dir string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", fmt.Errorf("reading mounted image: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() && strings.HasSuffix(e.Name(), ".app") {
			return filepath.Join(dir, e.Name()), nil
		}
	}
	return "", fmt.Errorf("no .app found in the update image")
}

// shQuote wraps s in single quotes for safe use in a bash command, escaping
// embedded single quotes the standard way ('\”).
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
