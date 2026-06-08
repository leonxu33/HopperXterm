//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// quitAfterInstall: on Windows the running HopperXterm.exe is locked, so the
// app must exit for the installer to overwrite it. DownloadAndApplyUpdate quits
// shortly after launchUpdateInstaller registers + triggers the update task.
const quitAfterInstall = true

// selfUpdateContext: the Windows NSIS installer always applies in place, and
// there's no system-package concept here. (Twin of the unix/darwin versions —
// see update_unix.go for the Linux classification that motivates this.)
func selfUpdateContext() (canSelfUpdate, packaged bool) { return true, false }

const flagCreateNoWindow = 0x08000000

const updateTaskName = "HopperXtermSelfUpdate"

// launchUpdateInstaller drives the update via a one-shot Windows Scheduled
// Task rather than a child process. Why: a child we spawn lives inside the
// job object Wails/WebView2 runs the app under, and is KILLED the instant we
// quit (before PowerShell even finishes starting) — which is why earlier
// detached/breakaway attempts left the helper dead and the installer never
// running. A scheduled task runs under the Task Scheduler service, fully
// outside our job and our lifetime, in the user's interactive session.
//
// The task runs apply-update.ps1, which:
//  1. waits for THIS process to exit (unlocking the exe),
//  2. runs the NSIS installer silently (/S) into the CURRENT install dir
//     (/D=<installDir>, so it overwrites in place regardless of the
//     installer's default), elevating only if the task itself isn't already
//     elevated, then
//  3. relaunches the upgraded exe (de-elevating via explorer when the task ran
//     elevated, so the app doesn't inherit admin), and
//  4. removes itself (Unregister-ScheduledTask).
//
// Registration is attempted with RunLevel Highest first: for an admin user the
// task then runs elevated with NO UAC prompt (truly silent). If that
// registration is refused, it falls back to a normal-level task and the script
// elevates the installer via -Verb RunAs (one UAC prompt). Every step is
// logged to update.log next to the installer for post-hoc diagnosis.
func launchUpdateInstaller(installerPath string) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolving current executable: %w", err)
	}
	installDir := filepath.Dir(exe)
	pid := os.Getpid()

	tmpDir := filepath.Dir(installerPath)
	logPath := filepath.Join(tmpDir, "update.log")
	scriptPath := filepath.Join(tmpDir, "apply-update.ps1")

	// The task action. Path values are single-quoted (psQuote); the installer
	// arg list is one string so NSIS sees an UNQUOTED /D path (NSIS quirk: /D
	// must be last and unquoted even with spaces).
	script := fmt.Sprintf(`$ErrorActionPreference = 'Continue'
$log = %s
function Log($m) { ("[{0}] {1}" -f (Get-Date -Format o), $m) | Out-File -FilePath $log -Append -Encoding utf8 }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Log "helper started (elevated=$admin); waiting for pid %d to exit"
try { Wait-Process -Id %d -Timeout 120 -ErrorAction SilentlyContinue } catch { Log "wait error: $_" }
Start-Sleep -Milliseconds 500
Log "running installer with args '/S /D=%s'"
try {
  if ($admin) {
    $proc = Start-Process -FilePath %s -ArgumentList '/S /D=%s' -PassThru -Wait -ErrorAction Stop
  } else {
    $proc = Start-Process -FilePath %s -ArgumentList '/S /D=%s' -Verb RunAs -PassThru -Wait -ErrorAction Stop
  }
  Log ("installer exited with code {0}" -f $proc.ExitCode)
} catch { Log "installer launch failed: $_" }
Log "relaunching app"
try {
  if ($admin) { Start-Process explorer.exe -ArgumentList %s } else { Start-Process -FilePath %s }
} catch { Log "relaunch failed: $_" }
try { Unregister-ScheduledTask -TaskName '%s' -Confirm:$false -ErrorAction SilentlyContinue } catch {}
Log "helper finished"
`,
		psQuote(logPath),
		pid, pid,
		psBare(installDir),
		psQuote(installerPath), psLit(installDir),
		psQuote(installerPath), psLit(installDir),
		psQuote(exe), psQuote(exe),
		updateTaskName,
	)

	if err := os.WriteFile(scriptPath, []byte(script), 0o644); err != nil {
		return fmt.Errorf("writing updater script: %w", err)
	}

	// Register + start the task synchronously (while we're still alive), so by
	// the time we quit the task is already running outside our job. The task
	// runs at normal level (a non-elevated process can't register a
	// -RunLevel Highest task — "Access is denied"); apply-update.ps1 then
	// elevates the installer itself via -Verb RunAs. If the app ever runs
	// elevated, the script detects that and skips the prompt.
	if err := registerAndRunUpdateTask(scriptPath); err != nil {
		return fmt.Errorf("scheduling update task: %w", err)
	}
	return nil
}

// registerAndRunUpdateTask registers the one-shot update task to run
// apply-update.ps1 in the user's interactive session and triggers it now.
func registerAndRunUpdateTask(scriptPath string) error {
	// [char]34 = double-quote, wrapping the script path inside the -Argument
	// string without nested-quote escaping headaches.
	cmd := fmt.Sprintf(
		"$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + [char]34 + %s + [char]34); "+
			"$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive; "+
			"$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10); "+
			"Register-ScheduledTask -TaskName %s -Action $a -Principal $p -Settings $s -Force -ErrorAction Stop | Out-Null; "+
			"Start-ScheduledTask -TaskName %s -ErrorAction Stop",
		psQuote(scriptPath), psQuote(updateTaskName), psQuote(updateTaskName),
	)

	c := exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", cmd)
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flagCreateNoWindow}
	if out, err := c.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// psQuote single-quotes a string for PowerShell, doubling embedded quotes.
func psQuote(s string) string { return "'" + psLit(s) + "'" }

// psLit escapes a string for placement INSIDE an existing single-quoted
// PowerShell literal (doubles single quotes, no surrounding quotes).
func psLit(s string) string { return strings.ReplaceAll(s, "'", "''") }

// psBare escapes a string for a double-quoted PowerShell log message
// (backtick, $, "). Used only for human-readable log lines.
func psBare(s string) string {
	return strings.NewReplacer("`", "``", "\"", "`\"", "$", "`$").Replace(s)
}
