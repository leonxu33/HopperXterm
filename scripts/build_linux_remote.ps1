# Build HopperXterm for Linux from this Windows machine, on a remote Linux box
# over SSH (key auth - no password stored here).
#
#   scripts\build_linux_remote.ps1              -> HopperXterm  (binary, zipped? no - raw)
#   scripts\build_linux_remote.ps1 -AppImage     -> HopperXterm-<ver>-linux-<arch>.AppImage
#   scripts\build_linux_remote.ps1 -Packages     -> hopperxterm_<ver>_<arch>.deb + .rpm
#   scripts\build_linux_remote.ps1 -RemoteHost user@other-box
#
# What it does:
#   1. Tars the working tree (git-tracked + untracked-but-not-ignored files,
#      so node_modules / build outputs never cross the wire)
#   2. Pushes it to the box at ~/build/hopperxterm-src (wiped each run)
#   3. Runs scripts/build_linux.sh (or build_linux_appimage.sh) there -
#      that script self-provisions Go/Node/Wails + the gtk3/webkit2gtk dev
#      packages (the deps step needs passwordless sudo on the box)
#   4. Copies the artifact back to app\build\bin\linux\
#
# Requires: Windows OpenSSH (ssh/scp/tar are all in-box on Win10+), and your
# public key in the box user's ~/.ssh/authorized_keys.

param(
    [switch]$AppImage,
    [switch]$Packages,
    [string]$RemoteHost = "user@your-linux-box"
)

if ($AppImage -and $Packages) { Write-Host "ERROR: use only one of -AppImage / -Packages" -ForegroundColor Red; exit 1 }

$ErrorActionPreference = "Stop"
$RepoRoot  = Split-Path $PSScriptRoot
$RemoteDir = "build/hopperxterm-src"   # relative to $HOME on the box
$OutDir    = Join-Path $RepoRoot "app\build\bin\linux"

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# --- 1. pack the working tree (respects .gitignore) -------------------------
Write-Host ">> Packing source tree..." -ForegroundColor Cyan
$listFile = Join-Path $env:TEMP "hx_linux_files.txt"
$tarFile  = Join-Path $env:TEMP "hx_linux_src.tgz"
git -C $RepoRoot ls-files -co --exclude-standard | Out-File $listFile -Encoding ascii
if ($LASTEXITCODE -ne 0) { Fail "git ls-files failed" }
tar -C $RepoRoot -czf $tarFile -T $listFile
if ($LASTEXITCODE -ne 0) { Fail "tar failed" }

# --- 2. push to the box ------------------------------------------------------
Write-Host ">> Pushing to $RemoteHost..." -ForegroundColor Cyan
scp -o BatchMode=yes -q $tarFile "${RemoteHost}:/tmp/hx_linux_src.tgz"
if ($LASTEXITCODE -ne 0) { Fail "scp failed - is your SSH key installed on the box?" }
ssh -o BatchMode=yes $RemoteHost "rm -rf ~/$RemoteDir; mkdir -p ~/$RemoteDir; tar -xzf /tmp/hx_linux_src.tgz -C ~/$RemoteDir; rm -f /tmp/hx_linux_src.tgz"
if ($LASTEXITCODE -ne 0) { Fail "remote extract failed" }

# --- 3. build remotely -------------------------------------------------------
$script = if ($AppImage) { "build_linux_appimage.sh" } elseif ($Packages) { "build_linux_packages.sh" } else { "build_linux.sh" }
Write-Host ">> Running $script on the box (first run provisions the toolchain - may take a while)..." -ForegroundColor Cyan
ssh -o BatchMode=yes $RemoteHost "cd ~/$RemoteDir; bash scripts/$script"
if ($LASTEXITCODE -ne 0) { Fail "remote build failed" }

# --- 4. fetch the artifact ---------------------------------------------------
New-Item -ItemType Directory -Force $OutDir | Out-Null
if ($AppImage) {
    Write-Host ">> Fetching AppImage..." -ForegroundColor Cyan
    scp -o BatchMode=yes -q "${RemoteHost}:~/$RemoteDir/app/build/bin/linux/HopperXterm-*-linux-*.AppImage" $OutDir
    if ($LASTEXITCODE -ne 0) { Fail "fetching AppImage failed" }
} elseif ($Packages) {
    Write-Host ">> Fetching .deb + .rpm..." -ForegroundColor Cyan
    scp -o BatchMode=yes -q "${RemoteHost}:~/$RemoteDir/app/build/bin/linux/hopperxterm_*.deb" $OutDir
    if ($LASTEXITCODE -ne 0) { Fail "fetching .deb failed" }
    scp -o BatchMode=yes -q "${RemoteHost}:~/$RemoteDir/app/build/bin/linux/hopperxterm-*.rpm" $OutDir
    if ($LASTEXITCODE -ne 0) { Fail "fetching .rpm failed" }
} else {
    Write-Host ">> Fetching binary..." -ForegroundColor Cyan
    scp -o BatchMode=yes -q "${RemoteHost}:~/$RemoteDir/app/build/bin/linux/HopperXterm" $OutDir
    if ($LASTEXITCODE -ne 0) { Fail "fetching binary failed" }
}

Remove-Item $listFile, $tarFile -Force -ErrorAction SilentlyContinue
Write-Host ">> Done. Artifacts in $OutDir" -ForegroundColor Green
Get-ChildItem $OutDir | Format-Table Name, @{n='Size(MB)';e={[math]::Round($_.Length/1MB,1)}}, LastWriteTime
