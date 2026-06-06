# build_win_installer.ps1 -- produce a distributable Windows installer for HopperXterm.
#
# Runs `wails build -nsis` from app/, which compiles the production binary
# (HopperXterm.exe -- no `dev` build tag, so it uses the real %AppData%\hopperxterm
# config dir) and wraps it in an NSIS installer. The installer bundles the
# Edge WebView2 bootstrapper, so target machines need nothing pre-installed.
#
# Output:  app\build\bin\win\HopperXterm-<version>-windows-amd64.exe   (gitignored)
#          (<version> = info.productVersion from app\wails.json; the script
#           renames Wails' default HopperXterm-amd64-installer.exe to this
#           scheme so Windows + macOS release assets match.)
# Version: edit "info.productVersion" in app\wails.json before a release.
#
#   .\scripts\build_win_installer.ps1            # build installer
#   .\scripts\build_win_installer.ps1 -Open      # reveal the installer in Explorer when done
#   .\scripts\build_win_installer.ps1 -FullClean # full `wails build -clean` wipe
#
# Best run with `wails dev` stopped. The targeted clean means it no longer
# ERRORS when dev is running, but the build regenerates frontend bindings,
# which disrupts a live dev session (its window may close). -FullClean
# requires dev stopped (it wipes the locked HopperXterm-dev.exe).
#
# If PowerShell blocks this with "running scripts is disabled on this system",
# either run the policy-agnostic wrapper  .\scripts\build_win_installer.cmd ,
# invoke once with  powershell -ExecutionPolicy Bypass -File <this> , or set
# the standard dev policy  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned .
#
# Prerequisites: Go and the Wails CLI on PATH; NSIS installed (the script
# finds makensis in its default install dir if it isn't on PATH).

[CmdletBinding()]
param(
    [switch]$FullClean,
    [switch]$Open
)

$ErrorActionPreference = 'Stop'

# scripts\build_win_installer.ps1 -> project root is one level up; app is under it.
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

# NSIS (makensis) is needed for -nsis but its installer doesn't add itself
# to PATH, so fall back to the standard install location for this session.
if (-not (Get-Command 'makensis' -ErrorAction SilentlyContinue)) {
    $nsisCandidates = @(
        "${env:ProgramFiles(x86)}\NSIS",
        "$env:ProgramFiles\NSIS"
    )
    $nsisDir = $nsisCandidates | Where-Object { Test-Path (Join-Path $_ 'makensis.exe') } | Select-Object -First 1
    if ($nsisDir) {
        Write-Host "    Using NSIS from $nsisDir (not on PATH)" -ForegroundColor DarkGray
        $env:PATH = "$nsisDir;$env:PATH"
    } else {
        Write-Error "'makensis' not found. Install NSIS (winget install NSIS.NSIS) or add its folder to PATH."
        exit 1
    }
}

Set-Location $appDir

# --- Build ---------------------------------------------------------------
# Targeted clean: remove only the prior release outputs so a stale exe /
# installer can't masquerade as a fresh build. We deliberately do NOT wipe
# the whole bin dir by default -- a running `wails dev` holds
# HopperXterm-dev.exe open, and `wails build -clean` would fail deleting it
# ("Access is denied"). Leaving the dev binary alone lets you build the
# installer without stopping dev. Use -FullClean (dev stopped) for a wipe.
# Clean both the root build dir (where wails writes) and win\ (the final home)
# so a stale exe / installer can't masquerade as a fresh build.
foreach ($d in @($binDir, $winDir)) {
    $staleExe = Join-Path $d 'HopperXterm.exe'
    if (Test-Path $staleExe) { Remove-Item $staleExe -Force -ErrorAction SilentlyContinue }
    # Both Wails' default name (*-installer.exe) and our renamed scheme
    # (HopperXterm-*-windows-amd64.exe) so a stale build can't linger.
    Get-ChildItem -Path (Join-Path $d '*') -Include '*-installer.exe', 'HopperXterm-*-windows-amd64.exe' -File -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

$wailsArgs = @('build', '-platform', 'windows/amd64', '-nsis', '-trimpath', '-webview2', 'download')
if ($FullClean) { $wailsArgs += '-clean' }  # full bin wipe -- stop `wails dev` first

Write-Host ""
Write-Host "==> Building HopperXterm installer (release)" -ForegroundColor Cyan
Write-Host "    cwd:  $appDir" -ForegroundColor DarkGray
Write-Host "    args: wails $($wailsArgs -join ' ')" -ForegroundColor DarkGray
Write-Host "    (first build is slow: ~1-3 min)" -ForegroundColor DarkGray
Write-Host ""

& wails @wailsArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "wails build failed (exit $LASTEXITCODE)."
    exit $LASTEXITCODE
}

# --- Collect outputs into build\bin\win\ ---------------------------------
# wails writes to the build\bin root; move the release artifacts into the
# per-platform subfolder so Windows and macOS outputs live consistently
# (macOS lands in build\bin\mac via build_mac_remote.ps1).
New-Item -ItemType Directory -Force $winDir | Out-Null
$builtExe = Join-Path $binDir 'HopperXterm.exe'
if (Test-Path $builtExe) { Move-Item $builtExe $winDir -Force }
Get-ChildItem -Path $binDir -Filter '*-installer.exe' -ErrorAction SilentlyContinue |
    Move-Item -Destination $winDir -Force

# Rename Wails' default HopperXterm-amd64-installer.exe to the versioned,
# OS-tagged scheme (HopperXterm-<version>-windows-amd64.exe) so the Windows
# and macOS release assets share one naming convention.
$version = (Select-String -Path (Join-Path $appDir 'wails.json') -Pattern '"productVersion"\s*:\s*"([^"]+)"' |
    Select-Object -First 1).Matches.Groups[1].Value
$default = Get-ChildItem -Path $winDir -Filter '*-installer.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($default -and $version) {
    $finalName = "HopperXterm-$version-windows-amd64.exe"
    Move-Item $default.FullName (Join-Path $winDir $finalName) -Force
}

# --- Report --------------------------------------------------------------
$installer = Get-ChildItem -Path (Join-Path $winDir '*') -Include '*-installer.exe', 'HopperXterm-*-windows-amd64.exe' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

Write-Host ""
if ($installer) {
    $size = [math]::Round($installer.Length / 1MB, 2)
    Write-Host "==> Installer ready: $($installer.FullName) ($size MB)" -ForegroundColor Green
    Write-Host "    Send this .exe to the target machine and run it." -ForegroundColor DarkGray
    Write-Host "    (Unsigned -> SmartScreen shows 'More info -> Run anyway' on first launch.)" -ForegroundColor DarkGray
    if ($Open) { Start-Process explorer.exe "/select,`"$($installer.FullName)`"" }
} else {
    Write-Host "==> Build succeeded but no *-installer.exe found in $winDir." -ForegroundColor Yellow
    Write-Host "    Check that NSIS (makensis) is installed and the -nsis step ran." -ForegroundColor Yellow
    exit 1
}
