#!/usr/bin/env bash
# Build the Linux installer (.AppImage) for HopperXterm.
#
# Runs ON the Linux box. Builds the binary first (scripts/build_linux.sh),
# then assembles a standard AppDir and packs it with appimagetool — a single
# self-contained executable that runs on most desktop distros.
#
# The AppImage bundles the HopperXterm binary but NOT gtk3/webkit2gtk — those
# are large, tightly coupled to the user's graphics stack, and expected to be
# present on any desktop Linux (same spirit as the ad-hoc-signed macOS .app:
# it runs where the platform libraries already live). A target missing
# libwebkit2gtk needs its distro's webkit2gtk runtime package installed.
#
# Output: app/build/bin/linux/HopperXterm-<version>-linux-<arch>.AppImage
#   (<version> = info.productVersion from app/wails.json)
#
# Usage:  scripts/build_linux_installer.sh [--skip-build]
#   --skip-build  reuse an existing app/build/bin/linux/HopperXterm
# (Normally invoked from Windows via scripts/build_linux_remote.ps1 -Installer.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
LINUX_DIR="$APP_DIR/build/bin/linux"
BIN="$LINUX_DIR/HopperXterm"

log() { printf '\033[1;36m[build_linux_installer]\033[0m %s\n' "$*"; }

# appimagetool needs the runtime arch slug; map it from the host CPU. PKG_ARCH
# is the asset-name slug — "aarch64" for arm64 so it can't be misread as amd64.
case "$(uname -m)" in
  x86_64|amd64)  APPIMG_ARCH=x86_64; PKG_ARCH=amd64 ;;
  aarch64|arm64) APPIMG_ARCH=aarch64; PKG_ARCH=aarch64 ;;
  *) echo "ERROR: unsupported CPU arch $(uname -m)" >&2; exit 1 ;;
esac

# `bash` explicitly: the exec bit doesn't survive the tar push from Windows.
if [ "${1:-}" != "--skip-build" ]; then
  bash "$REPO_ROOT/scripts/build_linux.sh"
fi
[ -f "$BIN" ] || { echo "ERROR: $BIN missing — build first" >&2; exit 1; }

VERSION="$(sed -n 's/.*"productVersion": *"\([^"]*\)".*/\1/p' "$APP_DIR/wails.json")"
APPIMAGE="$LINUX_DIR/HopperXterm-${VERSION:-0.0.0}-linux-${PKG_ARCH}.AppImage"

# --- assemble the AppDir -----------------------------------------------------
APPDIR="$(mktemp -d /tmp/hopperxterm-appdir.XXXXXX)"
trap 'rm -rf "$APPDIR"' EXIT

mkdir -p "$APPDIR/usr/bin" \
         "$APPDIR/usr/share/applications" \
         "$APPDIR/usr/share/icons/hicolor/256x256/apps"

cp "$BIN" "$APPDIR/usr/bin/HopperXterm"
chmod +x "$APPDIR/usr/bin/HopperXterm"

# Icon (top-level name must match the desktop file's Icon= key).
ICON_SRC="$APP_DIR/build/appicon.png"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$APPDIR/hopperxterm.png"
  cp "$ICON_SRC" "$APPDIR/usr/share/icons/hicolor/256x256/apps/hopperxterm.png"
fi

# Desktop entry (top-level + the freedesktop location).
cat > "$APPDIR/hopperxterm.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=HopperXterm
Comment=Cross-platform SSH/SFTP terminal client
Exec=HopperXterm
Icon=hopperxterm
Categories=Network;Utility;TerminalEmulator;
Terminal=false
DESKTOP
cp "$APPDIR/hopperxterm.desktop" "$APPDIR/usr/share/applications/hopperxterm.desktop"

# AppRun — resolves its own dir then execs the bundled binary.
cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/HopperXterm" "$@"
APPRUN
chmod +x "$APPDIR/AppRun"

# --- fetch appimagetool (cached under ~/toolchain) ---------------------------
TOOL="$HOME/toolchain/appimagetool-${APPIMG_ARCH}.AppImage"
if [ ! -x "$TOOL" ]; then
  log "downloading appimagetool ($APPIMG_ARCH)…"
  mkdir -p "$HOME/toolchain"
  curl -sLo "$TOOL" --retry 3 \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${APPIMG_ARCH}.AppImage"
  chmod +x "$TOOL"
fi

# --- pack --------------------------------------------------------------------
# APPIMAGE_EXTRACT_AND_RUN: run appimagetool without FUSE (build hosts/CI often
# lack /dev/fuse). ARCH: tells appimagetool which runtime to embed.
log "appimagetool → $(basename "$APPIMAGE")…"
rm -f "$APPIMAGE"
APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$APPIMG_ARCH" "$TOOL" "$APPDIR" "$APPIMAGE"

[ -f "$APPIMAGE" ] || { echo "ERROR: $APPIMAGE not produced" >&2; exit 1; }
chmod +x "$APPIMAGE"

log "done: $APPIMAGE"
du -sh "$APPIMAGE"
