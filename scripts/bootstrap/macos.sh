#!/bin/sh
set -eu

ROLE=${NOMSOD_ROLE:-agent}
INSTALL_ROOT=${NOMSOD_INSTALL_ROOT:-"$HOME/Library/Application Support/Nomsod MCP"}
GATEWAY_WS=${NOMSOD_GATEWAY_WS:-wss://mcp.nomsod.net/agent}
PUBLIC_BASE=${NOMSOD_PUBLIC_BASE_URL:-https://mcp.nomsod.net}
PAIRING_KEY=${NOMSOD_PAIRING_TOKEN:-}
OWNER_KEY=${NOMSOD_OWNER_KEY:-}
DEVICE_NAME=${NOMSOD_DEVICE_NAME:-}

case "$ROLE" in
  agent|supervisor|both) ;;
  *)
    echo "NOMSOD_ROLE must be agent, supervisor, or both." >&2
    exit 2
    ;;
esac

read_secret() {
  PROMPT=$1
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '%s' "$PROMPT" > /dev/tty
    stty -echo < /dev/tty
    IFS= read -r VALUE < /dev/tty
    stty echo < /dev/tty
    printf '\n' > /dev/tty
  else
    printf '%s' "$PROMPT" >&2
    IFS= read -r VALUE
  fi
  printf '%s' "$VALUE"
}

if { [ "$ROLE" = "agent" ] || [ "$ROLE" = "both" ]; } && [ -z "$PAIRING_KEY" ]; then
  PAIRING_KEY=$(read_secret "Nomsod MCP pairing key: ")
fi

if { [ "$ROLE" = "supervisor" ] || [ "$ROLE" = "both" ]; } && [ -z "$OWNER_KEY" ]; then
  OWNER_KEY=$(read_secret "Nomsod MCP owner key: ")
fi

MANIFEST_URL="https://mcp.nomsod.net/releases/latest/macos.json"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/nomsod-mcp-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

MANIFEST="$TMP/manifest.json"
/usr/bin/curl -fsSL --retry 3 --connect-timeout 10   -H 'Cache-Control: no-cache'   "$MANIFEST_URL?t=$(date +%s)"   -o "$MANIFEST"

manifest_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$MANIFEST" 2>/dev/null || true
}

VERSION=$(manifest_value version)
URL=$(manifest_value url)
EXPECTED=$(manifest_value sha256)

if [ -z "$VERSION" ] || [ -z "$URL" ] || [ -z "$EXPECTED" ]; then
  echo "Invalid Nomsod MCP release manifest." >&2
  exit 3
fi

ARCHIVE="$TMP/release.tar.gz"
/usr/bin/curl -fsSL --retry 3 --connect-timeout 15 "$URL" -o "$ARCHIVE"
ACTUAL=$(/usr/bin/shasum -a 256 "$ARCHIVE" | awk '{print $1}')
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "Release checksum mismatch." >&2
  echo "Expected: $EXPECTED" >&2
  echo "Actual:   $ACTUAL" >&2
  exit 4
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
    echo "Release package does not contain VERSION." >&2
    exit 5
  fi
fi

mkdir -p "$INSTALL_ROOT"

for item in "$RELEASE_ROOT"/* "$RELEASE_ROOT"/.[!.]* "$RELEASE_ROOT"/..?*; do
  [ -e "$item" ] || continue
  name=$(basename "$item")
  case "$name" in
    .env|data|.runtime|build|node_modules) continue ;;
  esac
  rm -rf "$INSTALL_ROOT/$name"
  cp -R "$item" "$INSTALL_ROOT/$name"
done

ENVFILE="$INSTALL_ROOT/.env"
if [ ! -f "$ENVFILE" ]; then
  mkdir -p "$INSTALL_ROOT/data"
  {
    if [ "$ROLE" = "supervisor" ] || [ "$ROLE" = "both" ]; then
      printf '%s\n' "NOMSOD_GATEWAY_HOST=127.0.0.1"
      printf '%s\n' "NOMSOD_GATEWAY_PORT=3219"
      printf '%s\n' "NOMSOD_PUBLIC_BASE_URL=$PUBLIC_BASE"
      printf '%s\n' "NOMSOD_OWNER_KEY=$OWNER_KEY"
      printf '%s\n' "NOMSOD_RUNTIME_PORT_A=3220"
      printf '%s\n' "NOMSOD_CONTROL_PORT=3221"
      printf '%s\n' "NOMSOD_RUNTIME_PORT_B=3222"
    fi

    if [ "$ROLE" = "agent" ] || [ "$ROLE" = "both" ]; then
      printf '%s\n' "NOMSOD_GATEWAY_WS=$GATEWAY_WS"
      printf '%s\n' "NOMSOD_PAIRING_TOKEN=$PAIRING_KEY"
      printf '%s\n' "NOMSOD_IDENTITY_PATH=$INSTALL_ROOT/data/device.json"
      if [ -n "$DEVICE_NAME" ]; then printf '%s\n' "NOMSOD_DEVICE_NAME=$DEVICE_NAME"; fi
      printf '%s\n' "NOMSOD_AGENT_WORKER_PORT_A=3230"
      printf '%s\n' "NOMSOD_AGENT_WORKER_PORT_B=3231"
      printf '%s\n' "NOMSOD_AGENT_GUARDIAN_HEALTH_PORT=3232"
      printf '%s\n' "NOMSOD_AGENT_DRAIN_TIMEOUT_MS=300000"
      printf '%s\n' "NOMSOD_HEARTBEAT_MS=15000"
      printf '%s\n' "NOMSOD_STALE_MS=45000"
      printf '%s\n' "NOMSOD_DNS_SERVERS=1.1.1.1,8.8.8.8"
    fi

    if [ "$ROLE" = "supervisor" ] && [ -n "$PAIRING_KEY" ]; then
      printf '%s\n' "NOMSOD_PAIRING_TOKEN=$PAIRING_KEY"
    fi
    printf '%s\n' "NOMSOD_LOG_DIR=$INSTALL_ROOT/data/logs"
  } > "$ENVFILE"
  chmod 600 "$ENVFILE"
fi

chmod +x "$INSTALL_ROOT/scripts/macos/"*.sh
/bin/sh "$INSTALL_ROOT/scripts/macos/install.sh" "$ROLE"

echo ""
echo "Nomsod MCP $VERSION installed."
echo "Location: $INSTALL_ROOT"
echo "MCP: https://mcp.nomsod.net/mcp"
