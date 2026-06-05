# build_win.ps1 -- produce a local Windows build of HopperXterm (no installer).
#
# Runs `wails build` from app/, compiling the production binary
# (HopperXterm.exe -- no `dev` build tag, so it uses the real
# %AppData%\hopperxterm config dir) and dropping it in build\bin\win\.
# This is the Windows counterpart to scripts/build_mac.sh: a plain runnable
# binary for local testing. For a distributable installer, use
# scripts\build_win_installer.ps1 instead.
#
# Output:  app\build\bin\win\HopperXterm.exe   (gitignored)
# Version: edit "info.productVersion" in app\wails.json before a release.
#
#   .\scripts\build_win.ps1             # build the binary
#   .\scripts\build_win.ps1 -Run        # build, then launch it
#   .\scripts\build_win.ps1 -FullClean  # full `wails build -clean` wipe
#
# Best run with `wails dev` stopped. The targeted clean leaves the locked
# HopperXterm-dev.exe alone so it no longer ERRORS when dev is running, but the
# build regenerates frontend bindings, which disrupts a live dev session.
# -FullClean requires dev stopped (it wipes the locked HopperXterm-dev.exe).
#
# If PowerShell blocks this with "running scripts is disabled on this system",
# run the policy-agnostic wrapper  .\scripts\build_win.cmd , invoke once with
# powershell -ExecutionPolicy Bypass -File <this> , or set the standard dev
# policy  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned .
#
# Prerequisites: Go and the Wails CLI on PATH.

[CmdletBinding()]
param(
    [switch]$FullClean,
    [switch]$Run
)

$ErrorActionPreference = 'Stop'

# scripts\build_win.ps1 -> project root is one level up; app is under it.
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$appDir = Join-Path $projectRoot 'app'
$binDir = Join-Path $appDir 'build\bin'
$winDir = Join-Path $binDir 'win'   # per-platform output (macOS lands in build\bin\mac)

if (-not (Test-Path $appDir)) {
    Write-Error "App directory not found at $appDir."
    exit 1
}

# --- Preflight: required toolchain on PATH -------------------------------
function Require-Tool($name, $hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Write-Error "'$name' not found on PATH. $hint"
        exit 1
    }
}
Require-Tool 'wails' 'Install: go install github.com/wailsapp/wails/v2/cmd/wails@latest'
Require-Tool 'go'    'Install Go 1.26+ and ensure it is on PATH.'

Set-Location $appDir

# --- Build ---------------------------------------------------------------
# Targeted clean: remove only the prior release binary (from the build\bin
# root, where wails writes, and win\, the final home) so a stale exe can't
# masquerade as a fresh build. We deliberately do NOT wipe the whole bin dir
# by default -- a running `wails dev` holds HopperXterm-dev.exe open, and
# `wails build -clean` would fail deleting it ("Access is denied"). Use
# -FullClean (dev stopped) for a wipe.
foreach ($d in @($binDir, $winDir)) {
    $staleExe = Join-Path $d 'HopperXterm.exe'
    if (Test-Path $staleExe) { Remove-Item $staleExe -Force -ErrorAction SilentlyContinue }
}

$wailsArgs = @('build', '-platform', 'windows/amd64', '-trimpath', '-webview2', 'download')
if ($FullClean) { $wailsArgs += '-clean' }  # full bin wipe -- stop `wails dev` first

Write-Host ""
Write-Host "==> Building HopperXterm (local release binary)" -ForegroundColor Cyan
Write-Host "    cwd:  $appDir" -ForegroundColor DarkGray
Write-Host "    args: wails $($wailsArgs -join ' ')" -ForegroundColor DarkGray
Write-Host "    (first build is slow: ~1-3 min)" -ForegroundColor DarkGray
Write-Host ""

& wails @wailsArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "wails build failed (exit $LASTEXITCODE)."
    exit $LASTEXITCODE
}

# --- Collect output into build\bin\win\ ----------------------------------
# wails writes to the build\bin root; move the binary into the per-platform
# subfolder so Windows and macOS outputs live consistently (macOS lands in
# build\bin\mac via build_mac_remote.ps1).
New-Item -ItemType Directory -Force $winDir | Out-Null
$builtExe = Join-Path $binDir 'HopperXterm.exe'
if (Test-Path $builtExe) { Move-Item $builtExe $winDir -Force }

# --- Report --------------------------------------------------------------
$exe = Join-Path $winDir 'HopperXterm.exe'
Write-Host ""
if (Test-Path $exe) {
    $size = [math]::Round((Get-Item $exe).Length / 1MB, 2)
    Write-Host "==> Binary ready: $exe ($size MB)" -ForegroundColor Green
    if ($Run) {
        Write-Host "    Launching..." -ForegroundColor DarkGray
        Start-Process $exe
    }
} else {
    Write-Host "==> Build succeeded but HopperXterm.exe was not found in $winDir." -ForegroundColor Yellow
    exit 1
}
