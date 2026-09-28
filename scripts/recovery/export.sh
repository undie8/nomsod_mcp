#!/bin/sh
set -eu

ROOT=${1:-}
DEST=${2:-}

if [ -z "$ROOT" ]; then
  ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fi
if [ -z "$DEST" ]; then
  DEST="$HOME/Desktop/Nomsod-Recovery-Kit-SENSITIVE.zip"
fi

ENVFILE="$ROOT/.env"
[ -f "$ENVFILE" ] || { echo "Missing $ENVFILE" >&2; exit 2; }

env_value() {
  KEY=$1
  /usr/bin/awk -F= -v key="$KEY" '
    $1==key {
      sub(/^[^=]*=/, "", $0)
      print
      exit
    }
  ' "$ENVFILE"
}

require_value() {
  NAME=$1
  VALUE=$(env_value "$NAME")
  [ -n "$VALUE" ] || { echo "Required recovery value is missing: $NAME" >&2; exit 3; }
  printf '%s' "$VALUE"
}

PUBLIC_BASE=$(require_value NOMSOD_PUBLIC_BASE_URL)
PAIRING_TOKEN=$(require_value NOMSOD_PAIRING_TOKEN)
CLUSTER_ID=$(env_value NOMSOD_CLUSTER_ID); CLUSTER_ID=${CLUSTER_ID:-nomsod-main-v1}
OWNER_KEY=$(env_value NOMSOD_OWNER_KEY); OWNER_KEY=${OWNER_KEY:-$PAIRING_TOKEN}

NODE_BIN=
for candidate in \
  "$ROOT/.runtime/node/bin/node" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node
do
  if [ -x "$candidate" ]; then NODE_BIN=$candidate; break; fi
done
if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then NODE_BIN=$(command -v node); fi
[ -n "$NODE_BIN" ] || { echo "Node runtime is required to export a recovery kit." >&2; exit 3; }

CLUSTER_KEY=$(env_value NOMSOD_CLUSTER_KEY)
if [ -z "$CLUSTER_KEY" ]; then
  CLUSTER_KEY=$("$NODE_BIN" -e 'const c=require("crypto"); const p=process.argv[1]; process.stdout.write(c.createHash("sha256").update("nomsod-cluster-v1\0").update(p).digest("base64url"));' "$PAIRING_TOKEN")
fi
TUNNEL_ID=$(require_value NOMSOD_TUNNEL_ID)
CREDENTIALS=$(require_value NOMSOD_TUNNEL_CREDENTIALS)
GATEWAY_PORT=$(env_value NOMSOD_GATEWAY_PORT); GATEWAY_PORT=${GATEWAY_PORT:-34100}
PEER_PORT=$(env_value NOMSOD_PEER_PORT); PEER_PORT=${PEER_PORT:-34104}
HEALTH_URL=$(env_value NOMSOD_TUNNEL_HEALTH_URL); HEALTH_URL=${HEALTH_URL:-${PUBLIC_BASE%/}/health}

case "$CREDENTIALS" in
  /*) ;;
  *) CREDENTIALS="$ROOT/$CREDENTIALS" ;;
esac
[ -f "$CREDENTIALS" ] || { echo "Cloudflare tunnel credential file is missing." >&2; exit 4; }
CREDENTIALS_B64=$(/usr/bin/base64 < "$CREDENTIALS" | tr -d '\r\n')

DIST="$ROOT/data/distribution"
WM="$DIST/releases/latest/windows.json"
MM="$DIST/releases/latest/macos.json"
WI="$DIST/install/windows.ps1"
MI="$DIST/install/macos.sh"
for f in "$WM" "$MM" "$WI" "$MI"; do
  [ -f "$f" ] || { echo "Distribution mirror is incomplete: $f" >&2; exit 5; }
done

json_value() {
  FILE=$1
  KEY=$2
  /usr/bin/plutil -extract "$KEY" raw -o - "$FILE" 2>/dev/null || true
}

WV=$(json_value "$WM" version)
WU=$(json_value "$WM" url)
WS=$(json_value "$WM" sha256 | tr '[:upper:]' '[:lower:]')
MV=$(json_value "$MM" version)
MU=$(json_value "$MM" url)
MS=$(json_value "$MM" sha256 | tr '[:upper:]' '[:lower:]')

WF="$DIST/releases/$WV/$(basename "${WU%%\?*}")"
MF="$DIST/releases/$MV/$(basename "${MU%%\?*}")"
[ -f "$WF" ] && [ -f "$MF" ] || { echo "Recovery release artifact is missing." >&2; exit 6; }

WA=$(/usr/bin/shasum -a 256 "$WF" | awk '{print $1}')
MA=$(/usr/bin/shasum -a 256 "$MF" | awk '{print $1}')
[ "$WA" = "$WS" ] || { echo "Windows recovery artifact checksum mismatch." >&2; exit 7; }
[ "$MA" = "$MS" ] || { echo "macOS recovery artifact checksum mismatch." >&2; exit 8; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/nomsod-recovery-export.XXXXXX")
KIT="$WORK/Nomsod-Recovery-Kit"
KIT_DIST="$KIT/distribution"
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

mkdir -p \
  "$KIT_DIST/install" \
  "$KIT_DIST/releases/latest" \
  "$KIT_DIST/releases/$WV" \
  "$KIT_DIST/releases/$MV"

cp "$WI" "$KIT_DIST/install/windows.ps1"
cp "$MI" "$KIT_DIST/install/macos.sh"
cp "$WM" "$KIT_DIST/releases/latest/windows.json"
cp "$MM" "$KIT_DIST/releases/latest/macos.json"
cp "$WF" "$KIT_DIST/releases/$WV/$(basename "$WF")"
cp "$MF" "$KIT_DIST/releases/$MV/$(basename "$MF")"
cp "$(dirname "$0")/RECOVER-WINDOWS.ps1" "$KIT/RECOVER-WINDOWS.ps1"
cp "$(dirname "$0")/RECOVER-MACOS.sh" "$KIT/RECOVER-MACOS.sh"
cp "$(dirname "$0")/README-SENSITIVE.txt" "$KIT/README-SENSITIVE.txt"
chmod 700 "$KIT/RECOVER-MACOS.sh"

RECOVERY="$KIT/recovery.json"
REC_CLUSTER_ID="$CLUSTER_ID" \
REC_PUBLIC_BASE="${PUBLIC_BASE%/}" \
REC_GATEWAY_PORT="$GATEWAY_PORT" \
REC_PEER_PORT="$PEER_PORT" \
REC_PAIRING_TOKEN="$PAIRING_TOKEN" \
REC_OWNER_KEY="$OWNER_KEY" \
REC_CLUSTER_KEY="$CLUSTER_KEY" \
REC_TUNNEL_ID="$TUNNEL_ID" \
REC_TUNNEL_CREDENTIALS_B64="$CREDENTIALS_B64" \
REC_TUNNEL_HEALTH_URL="$HEALTH_URL" \
REC_WINDOWS_VERSION="$WV" \
REC_MACOS_VERSION="$MV" \
REC_CREATED_AT="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" \
"$NODE_BIN" -e '
  const fs=require("fs");
  const output=process.argv[1];
  const bundle={
    version:1,
    kind:"nomsod-single-cluster-recovery",
    clusterId:process.env.REC_CLUSTER_ID,
    publicBaseUrl:process.env.REC_PUBLIC_BASE,
    gatewayPort:Number(process.env.REC_GATEWAY_PORT),
    peerPort:Number(process.env.REC_PEER_PORT),
    pairingToken:process.env.REC_PAIRING_TOKEN,
    ownerKey:process.env.REC_OWNER_KEY,
    clusterKey:process.env.REC_CLUSTER_KEY,
    cloudflare:{
      tunnelId:process.env.REC_TUNNEL_ID,
      credentialsBase64:process.env.REC_TUNNEL_CREDENTIALS_B64,
      healthUrl:process.env.REC_TUNNEL_HEALTH_URL
    },
    distribution:{
      windowsVersion:process.env.REC_WINDOWS_VERSION,
      macosVersion:process.env.REC_MACOS_VERSION
    },
    createdAt:process.env.REC_CREATED_AT
  };
  fs.writeFileSync(output, JSON.stringify(bundle,null,2)+"\n",{mode:0o600});
' "$RECOVERY"
chmod 600 "$RECOVERY"

mkdir -p "$(dirname "$DEST")"
rm -f "$DEST"
(
  cd "$WORK"
  /usr/bin/zip -qry "$DEST" "Nomsod-Recovery-Kit"
)

echo "Nomsod MCP recovery kit created."
echo "Store this ZIP outside Nomsod computers and protect it as a sensitive credential backup."
echo "Path: $DEST"
