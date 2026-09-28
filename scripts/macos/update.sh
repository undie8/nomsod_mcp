#!/bin/sh
set -eu

ROOT=${1:-}
MANIFEST_URL=${2:-https://mcp.nomsod.net/releases/latest/macos.json}

if [ -z "$ROOT" ]; then
  ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fi

PUBLIC_BASE=${MANIFEST_URL%/releases/latest/macos.json}
if [ -z "$PUBLIC_BASE" ] || [ "$PUBLIC_BASE" = "$MANIFEST_URL" ]; then
  PUBLIC_BASE=https://mcp.nomsod.net
fi

LOCK_DIR="$ROOT/data/update.lock"
LOG_DIR="$ROOT/data/logs"
LOG_FILE="$LOG_DIR/updater.log"
TMP=
UPDATE_STARTED=0
UPDATE_COMMITTED=0
HAD_VERSION=0
CURRENT=0.0.0
mkdir -p "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi

cleanup() {
  STATUS=$?
  trap - EXIT HUP INT TERM

  if [ "$UPDATE_STARTED" = "1" ] && [ "$UPDATE_COMMITTED" != "1" ]; then
    if [ "$HAD_VERSION" = "1" ]; then
      printf '%s\n' "$CURRENT" > "$ROOT/VERSION"
    else
      rm -f "$ROOT/VERSION"
    fi
    log "update rolled back version marker to $CURRENT"
  fi

  if [ -n "$TMP" ]; then rm -rf "$TMP"; fi
  rm -rf "$LOCK_DIR"
  exit "$STATUS"
}
trap cleanup EXIT HUP INT TERM

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >> "$LOG_FILE"
}

sync_distribution_best_effort() {
  SCRIPT="$ROOT/scripts/macos/sync-distribution.sh"
  [ -f "$SCRIPT" ] || return 0

  if ! /bin/sh "$SCRIPT" "$ROOT" "$PUBLIC_BASE" >> "$LOG_FILE" 2>&1; then
    log "WARN distribution sync failed"
  fi
}

version_gt() {
  A=$1
  B=$2
  OLD_IFS=$IFS
  IFS=.
  set -- $A
  A1=${1:-0}; A2=${2:-0}; A3=${3:-0}
  set -- $B
  B1=${1:-0}; B2=${2:-0}; B3=${3:-0}
  IFS=$OLD_IFS

  [ "$A1" -gt "$B1" ] && return 0
  [ "$A1" -lt "$B1" ] && return 1
  [ "$A2" -gt "$B2" ] && return 0
  [ "$A2" -lt "$B2" ] && return 1
  [ "$A3" -gt "$B3" ] && return 0
  return 1
}

if [ -f "$ROOT/VERSION" ]; then
  HAD_VERSION=1
  CURRENT=$(tr -d ' \r\n\t' < "$ROOT/VERSION")
fi

TMP=$(mktemp -d "$ROOT/data/update.XXXXXX")

MANIFEST="$TMP/manifest.json"
/usr/bin/curl -fsSL --retry 3 --connect-timeout 10   -H 'Cache-Control: no-cache'   "$MANIFEST_URL?t=$(date +%s)"   -o "$MANIFEST"

read_json() {
  KEY=$1
  /usr/bin/plutil -extract "$KEY" raw -o - "$MANIFEST" 2>/dev/null || true
}

LATEST=$(read_json version)
URL=$(read_json url)
EXPECTED=$(read_json sha256)

if [ -z "$LATEST" ] || [ -z "$URL" ] || [ -z "$EXPECTED" ]; then
  log "ERROR invalid update manifest"
  exit 2
fi

sync_distribution_best_effort

if ! version_gt "$LATEST" "$CURRENT"; then
  exit 0
fi

log "updating $CURRENT -> $LATEST"

ARCHIVE="$TMP/release.tar.gz"
/usr/bin/curl -fsSL --retry 3 --connect-timeout 15 "$URL" -o "$ARCHIVE"
ACTUAL=$(/usr/bin/shasum -a 256 "$ARCHIVE" | awk '{print $1}')
if [ "$ACTUAL" != "$EXPECTED" ]; then
  log "ERROR checksum mismatch expected=$EXPECTED actual=$ACTUAL"
  exit 3
fi

STAGE="$TMP/stage"
mkdir -p "$STAGE"
/usr/bin/tar -xzf "$ARCHIVE" -C "$STAGE"

RELEASE_ROOT="$STAGE"
if [ ! -f "$RELEASE_ROOT/VERSION" ]; then
  FIRST=$(find "$STAGE" -mindepth 1 -maxdepth 1 -type d | head -1)
  if [ -n "$FIRST" ] && [ -f "$FIRST/VERSION" ]; then
    RELEASE_ROOT="$FIRST"
  else
    log "ERROR release package missing VERSION"
    exit 4
  fi
fi

UPDATE_STARTED=1

for item in "$RELEASE_ROOT"/* "$RELEASE_ROOT"/.[!.]* "$RELEASE_ROOT"/..?*; do
  [ -e "$item" ] || continue
  name=$(basename "$item")
  case "$name" in
    .env|data|.runtime|build|node_modules) continue ;;
  esac
  rm -rf "$ROOT/$name"
  cp -R "$item" "$ROOT/$name"
done

# Archives published from Windows do not preserve Unix executable bits.
# Restore them before install.sh invokes helper scripts directly.
chmod +x "$ROOT/scripts/macos/"*.sh

ROLE=agent
if [ -f "$ROOT/data/install-role.txt" ]; then
  ROLE=$(tr '[:upper:]' '[:lower:]' < "$ROOT/data/install-role.txt" | tr -d ' \r\n\t')
fi
case "$ROLE" in
  both|supervisor|agent) ;;
  *) ROLE=agent ;;
esac

NOMSOD_UPDATE_IN_PROGRESS=1 /bin/sh "$ROOT/scripts/macos/install.sh" "$ROLE"

INSTALLED=$(tr -d ' \r\n\t' < "$ROOT/VERSION")
if [ "$INSTALLED" != "$LATEST" ]; then
  log "ERROR installed version mismatch expected=$LATEST actual=$INSTALLED"
  exit 5
fi

UPDATE_COMMITTED=1
log "update complete version=$LATEST"
