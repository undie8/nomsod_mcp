#!/bin/sh
set -eu

ROLE=${NOMSOD_ROLE:-agent}
INSTALL_ROOT=${NOMSOD_INSTALL_ROOT:-"$HOME/Library/Application Support/Nomsod MCP"}
GATEWAY_WS=${NOMSOD_GATEWAY_WS:-wss://mcp.nomsod.net/agent}
PUBLIC_BASE=${NOMSOD_PUBLIC_BASE_URL:-https://mcp.nomsod.net}
PAIRING_KEY=${NOMSOD_PAIRING_TOKEN:-}
OWNER_KEY=${NOMSOD_OWNER_KEY:-}
CLUSTER_KEY=${NOMSOD_CLUSTER_KEY:-}
CLUSTER_ID=${NOMSOD_CLUSTER_ID:-nomsod-main-v1}
DEVICE_NAME=${NOMSOD_DEVICE_NAME:-}
ENROLLMENT_TOKEN=${NOMSOD_ENROLLMENT_TOKEN:-}
RECOVERY_MODE=${NOMSOD_RECOVERY_MODE:-0}
GATEWAY_PORT=34100
PEER_PORT=34104
GATEWAY_WS_LIST=$GATEWAY_WS
CLOUDFLARE_TUNNEL_ID=
CLOUDFLARE_CREDENTIALS_B64=
CLOUDFLARE_HEALTH_URL=

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

if [ -z "$ENROLLMENT_TOKEN" ] && [ "$RECOVERY_MODE" != "1" ]; then
  echo "Nomsod MCP has one existing cluster. This installer cannot create a second cluster." >&2
  echo "Use Add new computer on any online Nomsod node. If every node was wiped, use the single-cluster recovery procedure." >&2
  exit 7
fi

if [ "$RECOVERY_MODE" = "1" ]; then
  if [ -z "$PAIRING_KEY" ] || [ -z "$OWNER_KEY" ] || [ -z "$CLUSTER_KEY" ]; then
    echo "Recovery mode requires the existing cluster pairing, owner and cluster keys. It never creates new cluster secrets." >&2
    exit 8
  fi
  ROLE=both
  GATEWAY_WS="ws://127.0.0.1:$GATEWAY_PORT/agent"
  PUBLIC_GATEWAY_WS=$(printf '%s' "$PUBLIC_BASE" | sed -e 's#^https://#wss://#' -e 's#^http://#ws://#' -e 's#/$##')
  GATEWAY_WS_LIST="$GATEWAY_WS,$PUBLIC_GATEWAY_WS/agent"
fi

if [ -n "$ENROLLMENT_TOKEN" ]; then
  echo "Joining Nomsod MCP cluster..."
  ENROLL_JSON=$(mktemp "${TMPDIR:-/tmp}/nomsod-enroll.XXXXXX")
  /usr/bin/curl -fsSL --retry 3 --connect-timeout 10 \
    -H "Authorization: Bearer $ENROLLMENT_TOKEN" \
    -H 'Cache-Control: no-store' \
    "$PUBLIC_BASE/enroll/bootstrap?platform=macos" \
    -o "$ENROLL_JSON"

  enroll_value() {
    /usr/bin/plutil -extract "$1" raw -o - "$ENROLL_JSON" 2>/dev/null || true
  }

  PAIRING_KEY=$(enroll_value pairingToken)
  OWNER_KEY=$(enroll_value ownerKey)
  CLUSTER_KEY=$(enroll_value clusterKey)
  ENROLLMENT_CLUSTER_ID=$(enroll_value clusterId)
  PUBLIC_BASE=$(enroll_value publicBaseUrl)
  GATEWAY_PORT=$(enroll_value gatewayPort)
  PEER_PORT=$(enroll_value peerPort)
  CLOUDFLARE_TUNNEL_ID=$(enroll_value cloudflare.tunnelId)
  CLOUDFLARE_CREDENTIALS_B64=$(enroll_value cloudflare.credentialsBase64)
  CLOUDFLARE_HEALTH_URL=$(enroll_value cloudflare.healthUrl)
  rm -f "$ENROLL_JSON"

  if [ -z "$PAIRING_KEY" ] || [ -z "$OWNER_KEY" ] || [ -z "$CLUSTER_KEY" ] || [ -z "$ENROLLMENT_CLUSTER_ID" ]; then
    echo "Enrollment response is incomplete." >&2
    exit 6
  fi
  if [ "$ENROLLMENT_CLUSTER_ID" != "$CLUSTER_ID" ]; then
    echo "Enrollment cluster mismatch. Expected $CLUSTER_ID, got $ENROLLMENT_CLUSTER_ID." >&2
    exit 9
  fi

  CLUSTER_ID=$ENROLLMENT_CLUSTER_ID
  ROLE=both
  GATEWAY_WS="ws://127.0.0.1:$GATEWAY_PORT/agent"
  PUBLIC_GATEWAY_WS=$(printf '%s' "$PUBLIC_BASE" | sed -e 's#^https://#wss://#' -e 's#^http://#ws://#' -e 's#/$##')
  GATEWAY_WS_LIST="$GATEWAY_WS,$PUBLIC_GATEWAY_WS/agent"
  echo "Enrollment accepted. Installing this computer as Gateway + Agent."
fi

if { [ "$ROLE" = "agent" ] || [ "$ROLE" = "both" ]; } && [ -z "$PAIRING_KEY" ]; then
  PAIRING_KEY=$(read_secret "Nomsod MCP pairing key: ")
fi

if { [ "$ROLE" = "supervisor" ] || [ "$ROLE" = "both" ]; } && [ -z "$OWNER_KEY" ]; then
  OWNER_KEY=$(read_secret "Nomsod MCP owner key: ")
fi

MANIFEST_URL="$PUBLIC_BASE/releases/latest/macos.json"
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
    printf '%s\n' "NOMSOD_CLUSTER_ID=$CLUSTER_ID"
    if [ "$ROLE" = "supervisor" ] || [ "$ROLE" = "both" ]; then
      printf '%s\n' "NOMSOD_GATEWAY_HOST=127.0.0.1"
      printf '%s\n' "NOMSOD_GATEWAY_PORT=$GATEWAY_PORT"
      printf '%s\n' "NOMSOD_PUBLIC_BASE_URL=$PUBLIC_BASE"
      printf '%s\n' "NOMSOD_OWNER_KEY=$OWNER_KEY"
      if [ -n "$CLUSTER_KEY" ]; then printf '%s\n' "NOMSOD_CLUSTER_KEY=$CLUSTER_KEY"; fi
      printf '%s\n' "NOMSOD_RUNTIME_PORT_A=$((GATEWAY_PORT + 1))"
      printf '%s\n' "NOMSOD_CONTROL_PORT=$((GATEWAY_PORT + 2))"
      printf '%s\n' "NOMSOD_RUNTIME_PORT_B=$((GATEWAY_PORT + 3))"
      printf '%s\n' "NOMSOD_PEER_PORT=$PEER_PORT"
      if [ -n "$DEVICE_NAME" ]; then
        printf '%s\n' "NOMSOD_NODE_NAME=$DEVICE_NAME"
      else
        printf '%s\n' "NOMSOD_NODE_NAME=$(hostname)"
      fi
    fi

    if [ "$ROLE" = "agent" ] || [ "$ROLE" = "both" ]; then
      printf '%s\n' "NOMSOD_GATEWAY_WS=$GATEWAY_WS"
      printf '%s\n' "NOMSOD_GATEWAY_WS_LIST=$GATEWAY_WS_LIST"
      printf '%s\n' "NOMSOD_PAIRING_TOKEN=$PAIRING_KEY"
      printf '%s\n' "NOMSOD_IDENTITY_PATH=$INSTALL_ROOT/data/device.json"
      if [ -n "$DEVICE_NAME" ]; then printf '%s\n' "NOMSOD_DEVICE_NAME=$DEVICE_NAME"; fi
      printf '%s\n' "NOMSOD_AGENT_WORKER_PORT_A=34120"
      printf '%s\n' "NOMSOD_AGENT_WORKER_PORT_B=34121"
      printf '%s\n' "NOMSOD_AGENT_GUARDIAN_HEALTH_PORT=34122"
      printf '%s\n' "NOMSOD_AGENT_DRAIN_TIMEOUT_MS=300000"
      printf '%s\n' "NOMSOD_HEARTBEAT_MS=15000"
      printf '%s\n' "NOMSOD_STALE_MS=45000"
      printf '%s\n' "NOMSOD_DNS_SERVERS=1.1.1.1,8.8.8.8"
      printf '%s\n' "NOMSOD_PEER_PORT=$PEER_PORT"
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


set_env_value() {
  KEY=$1
  VALUE=$2
  FILE="$INSTALL_ROOT/.env"
  TMP_ENV="$FILE.tmp"
  awk -F= -v key="$KEY" -v value="$VALUE" '
    BEGIN { found=0 }
    $1==key { print key "=" value; found=1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$FILE" > "$TMP_ENV"
  mv "$TMP_ENV" "$FILE"
  chmod 600 "$FILE"
}

resolve_node_after_install() {
  for candidate in \
    "$INSTALL_ROOT/.runtime/node/bin/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node
  do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return
    fi
  done

  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi

  return 1
}

ensure_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    command -v cloudflared
    return
  fi

  for candidate in \
    /opt/homebrew/bin/cloudflared \
    /usr/local/bin/cloudflared \
    "$INSTALL_ROOT/.runtime/cloudflared/cloudflared"
  do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return
    fi
  done

  NODE_BIN=$(resolve_node_after_install)
  RUNTIME_DIR="$INSTALL_ROOT/.runtime/cloudflared"
  mkdir -p "$RUNTIME_DIR"
  META="$TMP/cloudflared-release.json"
  /usr/bin/curl -fsSL --retry 3 --connect-timeout 10 \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: Nomsod-MCP-Installer' \
    "https://api.github.com/repos/cloudflare/cloudflared/releases/latest" \
    -o "$META"

  case "$(uname -m)" in
    arm64|aarch64) ASSET=cloudflared-darwin-arm64.tgz ;;
    x86_64|amd64) ASSET=cloudflared-darwin-amd64.tgz ;;
    *) echo "Unsupported macOS architecture for cloudflared: $(uname -m)" >&2; return 3 ;;
  esac

  ASSET_META=$("$NODE_BIN" -e '
    const fs=require("fs");
    const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const asset=(data.assets||[]).find(x=>x.name===process.argv[2]);
    if(!asset || !asset.browser_download_url || !asset.digest) process.exit(2);
    process.stdout.write(asset.browser_download_url+"\n"+String(asset.digest).replace(/^sha256:/,"")+"\n");
  ' "$META" "$ASSET")

  URL=$(printf '%s\n' "$ASSET_META" | sed -n '1p')
  EXPECTED=$(printf '%s\n' "$ASSET_META" | sed -n '2p')
  [ -n "$URL" ] && [ -n "$EXPECTED" ] || return 3

  ARCHIVE_CF="$TMP/$ASSET"
  /usr/bin/curl -fsSL --retry 3 --connect-timeout 15 "$URL" -o "$ARCHIVE_CF"
  ACTUAL_CF=$(/usr/bin/shasum -a 256 "$ARCHIVE_CF" | awk '{print $1}')
  if [ "$ACTUAL_CF" != "$EXPECTED" ]; then
    echo "cloudflared checksum mismatch." >&2
    return 3
  fi

  EXTRACT="$TMP/cloudflared-extract"
  mkdir -p "$EXTRACT"
  /usr/bin/tar -xzf "$ARCHIVE_CF" -C "$EXTRACT"
  FOUND=$(find "$EXTRACT" -type f -name cloudflared -perm +111 | head -1)
  if [ -z "$FOUND" ]; then
    FOUND=$(find "$EXTRACT" -type f -name cloudflared | head -1)
  fi
  [ -n "$FOUND" ] || return 3

  cp "$FOUND" "$RUNTIME_DIR/cloudflared"
  chmod 755 "$RUNTIME_DIR/cloudflared"
  printf '%s' "$RUNTIME_DIR/cloudflared"
}

if [ -n "$CLOUDFLARE_TUNNEL_ID" ] && [ -n "$CLOUDFLARE_CREDENTIALS_B64" ]; then
  CLOUDFLARED_EXE=$(ensure_cloudflared)
  CLOUDFLARE_DIR="$INSTALL_ROOT/data/cloudflared"
  mkdir -p "$CLOUDFLARE_DIR"
  CLOUDFLARE_CREDENTIALS="$CLOUDFLARE_DIR/$CLOUDFLARE_TUNNEL_ID.json"
  printf '%s' "$CLOUDFLARE_CREDENTIALS_B64" | /usr/bin/base64 -D > "$CLOUDFLARE_CREDENTIALS"
  chmod 600 "$CLOUDFLARE_CREDENTIALS"

  set_env_value NOMSOD_CLOUDFLARED_EXE "$CLOUDFLARED_EXE"
  set_env_value NOMSOD_TUNNEL_ID "$CLOUDFLARE_TUNNEL_ID"
  set_env_value NOMSOD_TUNNEL_CREDENTIALS "$CLOUDFLARE_CREDENTIALS"
  set_env_value NOMSOD_TUNNEL_ORIGIN "http://127.0.0.1:$GATEWAY_PORT"
  set_env_value NOMSOD_TUNNEL_HEALTH_URL "$CLOUDFLARE_HEALTH_URL"

  /bin/sh "$INSTALL_ROOT/scripts/macos/install-cloudflared-background.sh" "$INSTALL_ROOT" 0
fi

echo ""
echo "Nomsod MCP $VERSION installed."
echo "Location: $INSTALL_ROOT"
echo "MCP: https://mcp.nomsod.net/mcp"
