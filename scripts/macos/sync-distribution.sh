#!/bin/sh
set -eu

ROOT=${1:-}
PUBLIC_BASE=${2:-${NOMSOD_PUBLIC_BASE_URL:-https://mcp.nomsod.net}}

if [ -z "$ROOT" ]; then
  ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fi
PUBLIC_BASE=${PUBLIC_BASE%/}

DIST="$ROOT/data/distribution"
TMP=$(mktemp -d "$ROOT/data/distribution-sync.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

read_json() {
  FILE=$1
  KEY=$2
  /usr/bin/plutil -extract "$KEY" raw -o - "$FILE" 2>/dev/null || true
}

sync_platform() {
  PLATFORM=$1
  INSTALLER=$2
  STAMP=$(date +%s)
  MANIFEST_TMP="$TMP/$PLATFORM.json"

  /usr/bin/curl -fsSL --retry 3 --connect-timeout 10 \
    -H 'Cache-Control: no-cache' \
    "$PUBLIC_BASE/releases/latest/$PLATFORM.json?t=$STAMP" \
    -o "$MANIFEST_TMP"

  VERSION=$(read_json "$MANIFEST_TMP" version)
  ARTIFACT_URL=$(read_json "$MANIFEST_TMP" url)
  EXPECTED=$(read_json "$MANIFEST_TMP" sha256 | tr '[:upper:]' '[:lower:]')

  case "$VERSION" in
    ''|*[!0-9.]*|.*|*.) echo "Invalid $PLATFORM release version: $VERSION" >&2; return 2 ;;
  esac
  case "$ARTIFACT_URL" in
    http://*/releases/"$VERSION"/*|https://*/releases/"$VERSION"/*) ;;
    *) echo "Invalid $PLATFORM artifact URL: $ARTIFACT_URL" >&2; return 2 ;;
  esac
  if ! printf '%s\n' "$EXPECTED" | /usr/bin/grep -Eq '^[0-9a-f]{64}$'; then
    echo "Invalid $PLATFORM checksum." >&2
    return 2
  fi

  ARTIFACT_NAME=$(basename "${ARTIFACT_URL%%\?*}")
  RELEASE_DIR="$DIST/releases/$VERSION"
  TARGET_ARTIFACT="$RELEASE_DIR/$ARTIFACT_NAME"
  TARGET_INSTALLER="$DIST/install/$INSTALLER"
  TARGET_MANIFEST="$DIST/releases/latest/$PLATFORM.json"

  LOCAL_VERSION=
  if [ -f "$TARGET_MANIFEST" ]; then
    LOCAL_VERSION=$(read_json "$TARGET_MANIFEST" version)
  fi

  if [ "$LOCAL_VERSION" = "$VERSION" ] && [ -f "$TARGET_ARTIFACT" ] && [ -f "$TARGET_INSTALLER" ]; then
    LOCAL_SHA=$(/usr/bin/shasum -a 256 "$TARGET_ARTIFACT" | awk '{print $1}')
    if [ "$LOCAL_SHA" = "$EXPECTED" ]; then
      return 0
    fi
  fi

  ARTIFACT_TMP="$TMP/$ARTIFACT_NAME"
  /usr/bin/curl -fsSL --retry 3 --connect-timeout 15 "$ARTIFACT_URL" -o "$ARTIFACT_TMP"
  ACTUAL=$(/usr/bin/shasum -a 256 "$ARTIFACT_TMP" | awk '{print $1}')
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "$PLATFORM artifact checksum mismatch. Expected $EXPECTED, got $ACTUAL" >&2
    return 3
  fi

  INSTALLER_TMP="$TMP/$INSTALLER"
  /usr/bin/curl -fsSL --retry 3 --connect-timeout 10 \
    -H 'Cache-Control: no-cache' \
    "$PUBLIC_BASE/install/$INSTALLER?t=$STAMP" \
    -o "$INSTALLER_TMP"

  mkdir -p "$RELEASE_DIR" "$DIST/install" "$DIST/releases/latest"

  if [ -f "$TARGET_ARTIFACT" ]; then
    EXISTING=$(/usr/bin/shasum -a 256 "$TARGET_ARTIFACT" | awk '{print $1}')
    if [ "$EXISTING" != "$EXPECTED" ]; then
      echo "Refusing to replace immutable release artifact with different content: $TARGET_ARTIFACT" >&2
      return 4
    fi
  else
    mv "$ARTIFACT_TMP" "$TARGET_ARTIFACT"
  fi

  mv "$INSTALLER_TMP" "$TARGET_INSTALLER"
  mv "$MANIFEST_TMP" "$TARGET_MANIFEST"
}

sync_platform windows windows.ps1
sync_platform macos macos.sh

echo "Nomsod MCP distribution mirror synchronized."
