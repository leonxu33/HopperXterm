#!/usr/bin/env bash
# Build distributable Linux packages (.deb + .rpm) for HopperXterm.
#
# Runs ON the Linux box. Builds the binary first (scripts/build_linux.sh),
# then packs a .deb and a .rpm with nfpm. Unlike the AppImage, these are real
# installers an end user can use without any manual steps:
#   - double-click in GNOME Software / `apt install ./hopperxterm_*.deb`
#   - the app lands in the application menu (searchable immediately — a
#     post-install hook refreshes the desktop + icon caches)
#   - gtk3 + webkit2gtk are pulled in as DECLARED runtime dependencies, so the
#     package manager installs them automatically (no bundling needed, unlike
#     the AppImage which assumes those libs are already present).
#
# The runtime webkit dependency (4.0 vs 4.1) is detected from what the built
# binary actually links against, so the declared dep always matches the build.
#
# Dependency package NAMES are distro-family specific:
#   .deb -> libgtk-3-0, libwebkit2gtk-4.{0,1}-*   (Debian/Ubuntu)
#   .rpm -> gtk3, webkit2gtk{3,4.1}               (Fedora/RHEL/openSUSE)
# Users on other families (Arch, etc.) should use the AppImage instead.
#
# Output: app/build/bin/linux/hopperxterm_<version>_<arch>.deb
#         app/build/bin/linux/hopperxterm-<version>.<rpmarch>.rpm
#
# Usage:  scripts/build_linux_packages.sh [--skip-build]
#   --skip-build  reuse an existing app/build/bin/linux/HopperXterm
# (Normally invoked from Windows via scripts/build_linux_remote.ps1 -Packages.)

set -euo pipefail

TOOLCHAIN="$HOME/toolchain"
export PATH="$TOOLCHAIN/go/bin:$TOOLCHAIN/node/bin:$HOME/go/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
LINUX_DIR="$APP_DIR/build/bin/linux"
BIN="$LINUX_DIR/HopperXterm"

log() { printf '\033[1;36m[build_linux_packages]\033[0m %s\n' "$*"; }

# nfpm's `arch` field takes a GOARCH slug and maps it to the deb (amd64/arm64)
# and rpm (x86_64/aarch64) conventions itself, so we only need GOARCH here.
case "$(uname -m)" in
  x86_64|amd64)  PKG_ARCH=amd64 ;;
  aarch64|arm64) PKG_ARCH=arm64 ;;
  *) echo "ERROR: unsupported CPU arch $(uname -m)" >&2; exit 1 ;;
esac

# `bash` explicitly: the exec bit doesn't survive the tar push from Windows.
if [ "${1:-}" != "--skip-build" ]; then
  bash "$REPO_ROOT/scripts/build_linux.sh"
fi
[ -f "$BIN" ] || { echo "ERROR: $BIN missing — build first" >&2; exit 1; }

VERSION="$(sed -n 's/.*"productVersion": *"\([^"]*\)".*/\1/p' "$APP_DIR/wails.json")"
VERSION="${VERSION:-0.0.0}"

# --- runtime webkit dependency: match what the binary actually links ---------
# build_linux.sh builds against whichever webkit2gtk is present on the box, so
# read the real linkage rather than guessing.
if ldd "$BIN" 2>/dev/null | grep -q 'libwebkit2gtk-4\.1'; then
  DEB_WEBKIT="libwebkit2gtk-4.1-0"; RPM_WEBKIT="webkit2gtk4.1"
  log "binary links webkit2gtk-4.1"
else
  DEB_WEBKIT="libwebkit2gtk-4.0-37"; RPM_WEBKIT="webkit2gtk3"
  log "binary links webkit2gtk-4.0"
fi

# --- provision nfpm (user-local, same pattern as the Wails CLI) --------------
if ! command -v nfpm >/dev/null 2>&1; then
  log "nfpm missing — go install…"
  go install github.com/goreleaser/nfpm/v2/cmd/nfpm@latest
fi
log "nfpm: $(nfpm --version 2>/dev/null | head -1)"

# --- stage packaging tree ----------------------------------------------------
STAGE="$(mktemp -d /tmp/hopperxterm-pkg.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

cp "$BIN" "$STAGE/HopperXterm"
chmod +x "$STAGE/HopperXterm"

ICON_SRC="$APP_DIR/build/appicon.png"
[ -f "$ICON_SRC" ] && cp "$ICON_SRC" "$STAGE/appicon.png"

# Exec= is the absolute install path (unlike the AppImage, where it's a bare
# name resolved inside the AppDir). StartupWMClass ties running windows to this
# entry so the taskbar/dock shows the right icon.
cat > "$STAGE/hopperxterm.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=HopperXterm
Comment=Cross-platform SSH/SFTP terminal client
Exec=/usr/bin/HopperXterm
Icon=hopperxterm
Categories=Network;Utility;TerminalEmulator;
Terminal=false
StartupWMClass=HopperXterm
DESKTOP

# Refresh the menu + icon caches so the app is searchable right after install
# (and tidied on removal). Best-effort: missing tools must not fail the package.
cat > "$STAGE/postinstall.sh" <<'POST'
#!/bin/sh
update-desktop-database /usr/share/applications 2>/dev/null || true
gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
exit 0
POST
cp "$STAGE/postinstall.sh" "$STAGE/postremove.sh"

cat > "$STAGE/nfpm.yaml" <<YAML
name: hopperxterm
arch: ${PKG_ARCH}
platform: linux
version: "${VERSION}"
section: net
priority: optional
maintainer: "leonxu33 <hopperxterm@users.noreply.github.com>"
description: |
  A fast, cross-platform SSH/SFTP terminal GUI client for Windows, macOS, and Linux.
vendor: "leonxu33"
homepage: "https://github.com/leonxu33/HopperXterm"
license: "MIT"
depends:
  - libgtk-3-0
  - ${DEB_WEBKIT}
overrides:
  rpm:
    depends:
      - gtk3
      - ${RPM_WEBKIT}
scripts:
  postinstall: postinstall.sh
  postremove: postremove.sh
contents:
  - src: ./HopperXterm
    dst: /usr/bin/HopperXterm
  - src: ./hopperxterm.desktop
    dst: /usr/share/applications/hopperxterm.desktop
  - src: ./appicon.png
    dst: /usr/share/icons/hicolor/256x256/apps/hopperxterm.png
YAML

# --- pack --------------------------------------------------------------------
# nfpm names the file conventionally when --target is a directory.
mkdir -p "$LINUX_DIR"
rm -f "$LINUX_DIR"/hopperxterm_*.deb "$LINUX_DIR"/hopperxterm-*.rpm
( cd "$STAGE" && nfpm pkg --config nfpm.yaml --packager deb --target "$LINUX_DIR/" )
( cd "$STAGE" && nfpm pkg --config nfpm.yaml --packager rpm --target "$LINUX_DIR/" )

log "done:"
du -sh "$LINUX_DIR"/*.deb "$LINUX_DIR"/*.rpm 2>/dev/null || true
