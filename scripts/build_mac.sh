#!/usr/bin/env bash
# Build HopperXterm.app for macOS (universal: arm64 + x86_64).
#
# Runs ON the Mac. Self-provisions a user-local toolchain on first run:
#   - Xcode Command Line Tools  (system; needs sudo once)
#   - Go (latest stable)        -> ~/toolchain/go
#   - Node.js (latest LTS)      -> ~/toolchain/node
#   - Wails CLI                 -> ~/go/bin/wails
# Nothing is installed system-wide except the CLT, so removal is just
# `rm -rf ~/toolchain ~/go`.
#
# Output: app/build/bin/mac/HopperXterm.app  (ad-hoc signed — runs locally;
# distribution to other Macs needs a Developer ID + notarization, or the
# recipient must run `xattr -cr HopperXterm.app`).
#
# Usage:  scripts/build_mac.sh
# (Normally invoked from Windows via scripts/build_mac_remote.ps1.)

set -euo pipefail

TOOLCHAIN="$HOME/toolchain"
export PATH="$TOOLCHAIN/go/bin:$TOOLCHAIN/node/bin:$HOME/go/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$REPO_ROOT/app"

log() { printf '\033[1;36m[build_mac]\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------- bootstrap

# 1. Xcode Command Line Tools (compiler + macOS SDK; required by CGO/Wails)
if ! xcode-select -p >/dev/null 2>&1; then
  log "Xcode Command Line Tools missing — installing (needs sudo)…"
  touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  PROD="$(softwareupdate -l 2>/dev/null | grep -o 'Label: Command Line Tools[^,]*' | tail -1 | sed 's/^Label: //')"
  if [ -z "$PROD" ]; then
    echo "ERROR: no Command Line Tools product found via softwareupdate." >&2
    echo "Install manually with: xcode-select --install" >&2
    exit 1
  fi
  sudo softwareupdate -i "$PROD" --verbose
  rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  xcode-select -p >/dev/null
fi

# 2. Go (user-local)
if ! command -v go >/dev/null 2>&1; then
  log "Go missing — installing latest stable to ~/toolchain/go…"
  GOV="$(curl -sL --retry 3 'https://go.dev/VERSION?m=text' | head -1)"
  curl -sLo /tmp/go.tgz --retry 3 "https://go.dev/dl/${GOV}.darwin-arm64.tar.gz"
  mkdir -p "$TOOLCHAIN"
  rm -rf "$TOOLCHAIN/go"
  tar -xzf /tmp/go.tgz -C "$TOOLCHAIN"
  rm -f /tmp/go.tgz
fi
log "go: $(go version)"

# Module proxy fallback for networks where proxy.golang.org is unreachable.
if [ "$(curl -s -o /dev/null -m 8 -w '%{http_code}' https://proxy.golang.org/ || true)" != "200" ]; then
  log "proxy.golang.org unreachable — using goproxy.cn"
  export GOPROXY="https://goproxy.cn,direct"
fi

# 3. Node.js (user-local; wails build runs `npm install` / `npm run build`)
if ! command -v node >/dev/null 2>&1; then
  log "Node missing — installing latest LTS to ~/toolchain/node…"
  NV="$(curl -sL --retry 3 https://nodejs.org/dist/index.tab | awk -F'\t' 'NR>1 && $10 != "-" {print $1; exit}')"
  curl -sLo /tmp/node.tgz --retry 3 "https://nodejs.org/dist/${NV}/node-${NV}-darwin-arm64.tar.gz"
  mkdir -p "$TOOLCHAIN"
  rm -rf "$TOOLCHAIN/node" "$TOOLCHAIN/node-${NV}-darwin-arm64"
  tar -xzf /tmp/node.tgz -C "$TOOLCHAIN"
  mv "$TOOLCHAIN/node-${NV}-darwin-arm64" "$TOOLCHAIN/node"
  rm -f /tmp/node.tgz
fi
log "node: $(node --version)"

# 4. Wails CLI
if ! command -v wails >/dev/null 2>&1; then
  log "Wails CLI missing — go install…"
  go install github.com/wailsapp/wails/v2/cmd/wails@latest
fi
log "wails: $(wails version)"

# -------------------------------------------------------------------- build

cd "$APP_DIR"
log "wails build -platform darwin/universal…"
wails build -platform darwin/universal -clean

BUILT="$APP_DIR/build/bin/HopperXterm.app"
[ -d "$BUILT" ] || { echo "ERROR: $BUILT not produced" >&2; exit 1; }

# Collect into build/bin/mac/ so macOS and Windows (build/bin/win/) outputs
# live in consistent per-platform subfolders.
MAC_DIR="$APP_DIR/build/bin/mac"
APP_BUNDLE="$MAC_DIR/HopperXterm.app"
mkdir -p "$MAC_DIR"
rm -rf "$APP_BUNDLE"
mv "$BUILT" "$APP_BUNDLE"

# Ad-hoc sign so the bundle runs on this machine without Gatekeeper fuss.
log "codesign (ad-hoc)…"
codesign --force --deep -s - "$APP_BUNDLE"

log "done: $APP_BUNDLE"
lipo -archs "$APP_BUNDLE/Contents/MacOS/HopperXterm" 2>/dev/null \
  && du -sh "$APP_BUNDLE" || true
