#!/usr/bin/env bash
# Build the HopperXterm binary for Linux.
#
# Runs ON the Linux box. Self-provisions a user-local toolchain on first run:
#   - Go (latest stable)        -> ~/toolchain/go
#   - Node.js (latest LTS)      -> ~/toolchain/node
#   - Wails CLI                 -> ~/go/bin/wails
# Plus the system GTK/WebKit dev packages Wails needs to compile (gtk3 +
# webkit2gtk) via the host's package manager — that part needs sudo once.
# Removing the user-local toolchain is just `rm -rf ~/toolchain ~/go`.
#
# Output: app/build/bin/linux/HopperXterm  (plain binary; for a distributable
# AppImage use scripts/build_linux_installer.sh instead).
#
# Usage:  scripts/build_linux.sh
# (Normally invoked from Windows via scripts/build_linux_remote.ps1.)

set -euo pipefail

TOOLCHAIN="$HOME/toolchain"
export PATH="$TOOLCHAIN/go/bin:$TOOLCHAIN/node/bin:$HOME/go/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$REPO_ROOT/app"

log() { printf '\033[1;36m[build_linux]\033[0m %s\n' "$*"; }

# Map `uname -m` to Go's GOARCH / the Node + Go download arch slugs.
case "$(uname -m)" in
  x86_64|amd64)  GOARCH=amd64;  GO_SLUG=amd64; NODE_SLUG=x64 ;;
  aarch64|arm64) GOARCH=arm64;  GO_SLUG=arm64; NODE_SLUG=arm64 ;;
  *) echo "ERROR: unsupported CPU arch $(uname -m)" >&2; exit 1 ;;
esac
log "target: linux/$GOARCH"

# ---------------------------------------------------------------- bootstrap

# 1. System build deps (gcc/pkg-config + gtk3 + webkit2gtk dev headers).
#    Wails compiles against whichever webkit2gtk is available; we install the
#    4.1 dev package where the distro has it, else fall back to 4.0.
need_pkgs() {
  command -v gcc >/dev/null 2>&1 || return 0
  command -v pkg-config >/dev/null 2>&1 || return 0
  pkg-config --exists gtk+-3.0 || return 0
  pkg-config --exists webkit2gtk-4.1 || pkg-config --exists webkit2gtk-4.0 || return 0
  return 1   # everything present → no install needed
}

install_sys_deps() {
  local SUDO=""
  [ "$(id -u)" -ne 0 ] && SUDO="sudo"
  if   command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -y
    # Prefer 4.1 (Ubuntu 24.04+/Debian 12+); fall back to 4.0 on older releases.
    $SUDO apt-get install -y build-essential pkg-config libgtk-3-dev \
      libwebkit2gtk-4.1-dev 2>/dev/null \
      || $SUDO apt-get install -y build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.0-dev
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y gcc pkg-config gtk3-devel \
      webkit2gtk4.1-devel 2>/dev/null \
      || $SUDO dnf install -y gcc pkg-config gtk3-devel webkit2gtk3-devel
  elif command -v pacman >/dev/null 2>&1; then
    $SUDO pacman -Sy --needed --noconfirm base-devel pkgconf gtk3 webkit2gtk-4.1 \
      || $SUDO pacman -Sy --needed --noconfirm base-devel pkgconf gtk3 webkit2gtk
  elif command -v zypper >/dev/null 2>&1; then
    $SUDO zypper install -y gcc pkg-config gtk3-devel \
      webkit2gtk4.1-devel 2>/dev/null \
      || $SUDO zypper install -y gcc pkg-config gtk3-devel webkit2gtk3-devel
  else
    echo "ERROR: no supported package manager (apt/dnf/pacman/zypper) found." >&2
    echo "Install gtk3 + webkit2gtk dev packages manually, then re-run." >&2
    exit 1
  fi
}

if need_pkgs; then
  log "Installing system build deps (gtk3 + webkit2gtk — needs sudo)…"
  install_sys_deps
fi

# 2. Go (user-local)
if ! command -v go >/dev/null 2>&1; then
  log "Go missing — installing latest stable to ~/toolchain/go…"
  GOV="$(curl -sL --retry 3 'https://go.dev/VERSION?m=text' | head -1)"
  curl -sLo /tmp/go.tgz --retry 3 "https://go.dev/dl/${GOV}.linux-${GO_SLUG}.tar.gz"
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
  curl -sLo /tmp/node.txz --retry 3 "https://nodejs.org/dist/${NV}/node-${NV}-linux-${NODE_SLUG}.tar.xz"
  mkdir -p "$TOOLCHAIN"
  rm -rf "$TOOLCHAIN/node" "$TOOLCHAIN/node-${NV}-linux-${NODE_SLUG}"
  tar -xJf /tmp/node.txz -C "$TOOLCHAIN"
  mv "$TOOLCHAIN/node-${NV}-linux-${NODE_SLUG}" "$TOOLCHAIN/node"
  rm -f /tmp/node.txz
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

# Wails defaults its cgo pkg-config to webkit2gtk-4.0. Newer distros
# (Ubuntu 24.04+, Fedora 39+, …) dropped 4.0 and ship only 4.1, where Wails
# needs the `webkit2_41` build tag. Pick the tag based on what's actually
# installed so the build works on both old and new releases.
WAILS_TAGS=()
if ! pkg-config --exists webkit2gtk-4.0 && pkg-config --exists webkit2gtk-4.1; then
  log "webkit2gtk-4.0 absent, 4.1 present — building with -tags webkit2_41"
  WAILS_TAGS=(-tags webkit2_41)
fi

log "wails build -platform linux/$GOARCH ${WAILS_TAGS[*]}…"
wails build -platform "linux/$GOARCH" -trimpath -clean "${WAILS_TAGS[@]}"

BUILT="$APP_DIR/build/bin/HopperXterm"
[ -f "$BUILT" ] || { echo "ERROR: $BUILT not produced" >&2; exit 1; }

# Collect into build/bin/linux/ so the macOS (build/bin/mac/) and Windows
# (build/bin/win/) outputs all live in consistent per-platform subfolders.
LINUX_DIR="$APP_DIR/build/bin/linux"
OUT="$LINUX_DIR/HopperXterm"
mkdir -p "$LINUX_DIR"
mv -f "$BUILT" "$OUT"
chmod +x "$OUT"

log "done: $OUT"
du -sh "$OUT" || true
