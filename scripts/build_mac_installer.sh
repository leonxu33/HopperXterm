#!/usr/bin/env bash
# Build the macOS installer (.dmg) for HopperXterm.
#
# Runs ON the Mac. Builds the app first (scripts/build_mac.sh), then packs a
# drag-to-Applications disk image with hdiutil — no third-party packaging
# tools needed.
#
# Output: app/build/bin/mac/HopperXterm-<version>-universal.dmg
#   (<version> = info.productVersion from app/wails.json)
#
# Usage:  scripts/build_mac_installer.sh [--skip-build]
#   --skip-build  reuse an existing app/build/bin/mac/HopperXterm.app
# (Normally invoked from Windows via scripts/build_mac_remote.ps1 -Installer.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
APP_BUNDLE="$APP_DIR/build/bin/mac/HopperXterm.app"

log() { printf '\033[1;36m[build_mac_installer]\033[0m %s\n' "$*"; }

# `bash` explicitly: the exec bit doesn't survive the tar push from Windows.
if [ "${1:-}" != "--skip-build" ]; then
  bash "$REPO_ROOT/scripts/build_mac.sh"
fi
[ -d "$APP_BUNDLE" ] || { echo "ERROR: $APP_BUNDLE missing — build first" >&2; exit 1; }

VERSION="$(sed -n 's/.*"productVersion": *"\([^"]*\)".*/\1/p' "$APP_DIR/wails.json")"
DMG="$APP_DIR/build/bin/mac/HopperXterm-${VERSION:-0.0.0}-universal.dmg"

# Stage: app bundle + /Applications symlink = the standard drag-install layout.
STAGE="$(mktemp -d /tmp/hopperxterm-dmg.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP_BUNDLE" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

log "hdiutil create…"
rm -f "$DMG"
hdiutil create -volname "HopperXterm" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

log "done: $DMG"
du -sh "$DMG"
