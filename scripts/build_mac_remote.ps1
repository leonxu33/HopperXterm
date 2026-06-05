# Build HopperXterm for macOS from this Windows machine, on a remote Mac
# over SSH (key auth - no password stored here).
#
#   scripts\build_mac_remote.ps1              -> HopperXterm.app  (zipped)
#   scripts\build_mac_remote.ps1 -Installer   -> HopperXterm-<ver>-universal.dmg
#   scripts\build_mac_remote.ps1 -RemoteHost user@other-mac
#
# What it does:
#   1. Tars the working tree (git-tracked + untracked-but-not-ignored files,
#      so node_modules / build outputs never cross the wire)
#   2. Pushes it to the Mac at ~/build/hopperxterm-src (wiped each run)
#   3. Runs scripts/build_mac.sh (or build_mac_installer.sh) there -
#      that script self-provisions Go/Node/Wails on a fresh Mac
#   4. Copies the artifact back to app\build\bin\mac\
#
# Requires: Windows OpenSSH (ssh/scp/tar are all in-box on Win10+), and your
# public key in the Mac user's ~/.ssh/authorized_keys.

param(
    [switch]$Installer,
    [string]$RemoteHost = "user@your-mac"
)

$ErrorActionPreference = "Stop"
$RepoRoot  = Split-Path $PSScriptRoot
$RemoteDir = "build/hopperxterm-src"   # relative to $HOME on the Mac
$OutDir    = Join-Path $RepoRoot "app\build\bin\mac"

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# --- 1. pack the working tree (respects .gitignore) -------------------------
Write-Host ">> Packing source tree..." -ForegroundColor Cyan
$listFile = Join-Path $env:TEMP "hx_mac_files.txt"
$tarFile  = Join-Path $env:TEMP "hx_mac_src.tgz"
git -C $RepoRoot ls-files -co --exclude-standard | Out-File $listFile -Encoding ascii
if ($LASTEXITCODE -ne 0) { Fail "git ls-files failed" }
tar -C $RepoRoot -czf $tarFile -T $listFile
if ($LASTEXITCODE -ne 0) { Fail "tar failed" }

# --- 2. push to the Mac ------------------------------------------------------
Write-Host ">> Pushing to $RemoteHost..." -ForegroundColor Cyan
scp -o BatchMode=yes -q $tarFile "${RemoteHost}:/tmp/hx_mac_src.tgz"
if ($LASTEXITCODE -ne 0) { Fail "scp failed - is your SSH key installed on the Mac?" }
ssh -o BatchMode=yes $RemoteHost "rm -rf ~/$RemoteDir; mkdir -p ~/$RemoteDir; tar -xzf /tmp/hx_mac_src.tgz -C ~/$RemoteDir; rm -f /tmp/hx_mac_src.tgz"
if ($LASTEXITCODE -ne 0) { Fail "remote extract failed" }

# --- 3. build remotely -------------------------------------------------------
$script = if ($Installer) { "build_mac_installer.sh" } else { "build_mac.sh" }
Write-Host ">> Running $script on the Mac (first run provisions the toolchain - may take a while)..." -ForegroundColor Cyan
ssh -o BatchMode=yes $RemoteHost "cd ~/$RemoteDir; bash scripts/$script"
if ($LASTEXITCODE -ne 0) { Fail "remote build failed" }

# --- 4. fetch the artifact ---------------------------------------------------
New-Item -ItemType Directory -Force $OutDir | Out-Null
if ($Installer) {
    Write-Host ">> Fetching DMG..." -ForegroundColor Cyan
    scp -o BatchMode=yes -q "${RemoteHost}:~/$RemoteDir/app/build/bin/mac/HopperXterm-*-universal.dmg" $OutDir
    if ($LASTEXITCODE -ne 0) { Fail "fetching DMG failed" }
} else {
    # .app is a directory with symlinks/metadata - zip with ditto (preserves
    # bundle structure), fetch the zip. Unzip ON A MAC to use it.
    Write-Host ">> Zipping + fetching HopperXterm.app..." -ForegroundColor Cyan
    ssh -o BatchMode=yes $RemoteHost "cd ~/$RemoteDir/app/build/bin/mac; ditto -c -k --keepParent HopperXterm.app HopperXterm.app.zip"
    if ($LASTEXITCODE -ne 0) { Fail "remote zip failed" }
    scp -o BatchMode=yes -q "${RemoteHost}:~/$RemoteDir/app/build/bin/mac/HopperXterm.app.zip" $OutDir
    if ($LASTEXITCODE -ne 0) { Fail "fetching app zip failed" }
}

Remove-Item $listFile, $tarFile -Force -ErrorAction SilentlyContinue
Write-Host ">> Done. Artifacts in $OutDir" -ForegroundColor Green
Get-ChildItem $OutDir | Format-Table Name, @{n='Size(MB)';e={[math]::Round($_.Length/1MB,1)}}, LastWriteTime
