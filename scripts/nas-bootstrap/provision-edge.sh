#!/bin/sh
set -eu

ROOT=${1:-/volume1/docker/nomsod-bootstrap}
TAILSCALE_IP=${2:-100.111.178.74}
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
RUNTIME="$ROOT/runtime"
CURRENT="$ROOT/current"
PUBLIC="$CURRENT/public"
RECOVERY="$CURRENT/bundle/recovery.json"

[ -f "$RECOVERY" ] || { echo "Missing NAS recovery bundle." >&2; exit 2; }
[ -x "$DOCKER" ] || { echo "Container Manager docker binary is missing." >&2; exit 3; }

mkdir -p "$RUNTIME"
chmod 750 "$ROOT" "$CURRENT" "$RUNTIME"
[ -d "$PUBLIC" ] || { echo "Missing NAS public bootstrap directory." >&2; exit 4; }
find "$PUBLIC" -type d -exec chmod 711 {} \;
find "$PUBLIC" -type f -exec chmod 644 {} \;

python3 - "$RECOVERY" "$RUNTIME/credentials.json" "$RUNTIME/tunnel-id.txt" <<'PY'
import base64, json, os, sys
src, credentials_path, tunnel_path = sys.argv[1:4]
with open(src, "r", encoding="utf-8") as f:
    data = json.load(f)
cf = data.get("cloudflare") or {}
tunnel_id = str(cf.get("tunnelId") or "").strip()
encoded = str(cf.get("credentialsBase64") or "").strip()
if not tunnel_id or not encoded:
    raise SystemExit("Recovery bundle has no Cloudflare tunnel credential.")
raw = base64.b64decode(encoded, validate=True)
with open(credentials_path, "wb") as f:
    f.write(raw)
os.chmod(credentials_path, 0o600)
with open(tunnel_path, "w", encoding="utf-8") as f:
    f.write(tunnel_id + "\n")
os.chmod(tunnel_path, 0o600)
PY

TUNNEL_ID=$(cat "$RUNTIME/tunnel-id.txt")
cp "$CURRENT/runtime-config/nginx.conf" "$RUNTIME/nginx.conf"
sed "s/__TUNNEL_ID__/$TUNNEL_ID/g" "$CURRENT/runtime-config/cloudflared.yml.template" > "$RUNTIME/cloudflared.yml"
chmod 640 "$RUNTIME/nginx.conf" "$RUNTIME/cloudflared.yml"

sudo -n "$DOCKER" network inspect nomsod-bootstrap-net >/dev/null 2>&1 ||   sudo -n "$DOCKER" network create nomsod-bootstrap-net >/dev/null

sudo -n "$DOCKER" pull nginx:alpine >/dev/null
sudo -n "$DOCKER" pull cloudflare/cloudflared:latest >/dev/null

for name in nomsod-bootstrap-edge nomsod-bootstrap-tunnel; do
  if sudo -n "$DOCKER" inspect "$name" >/dev/null 2>&1; then
    sudo -n "$DOCKER" rm -f "$name" >/dev/null
  fi
done

sudo -n "$DOCKER" run -d   --name nomsod-bootstrap-edge   --restart unless-stopped   --network nomsod-bootstrap-net   -p "$TAILSCALE_IP:34150:8080"   -v "$PUBLIC:/srv/public:ro"   -v "$RUNTIME/nginx.conf:/etc/nginx/conf.d/default.conf:ro"   nginx:alpine >/dev/null

sudo -n "$DOCKER" run -d   --name nomsod-bootstrap-tunnel   --restart unless-stopped   --network nomsod-bootstrap-net   --user 0:0   -v "$RUNTIME/cloudflared.yml:/etc/cloudflared/config.yml:ro"   -v "$RUNTIME/credentials.json:/etc/cloudflared/credentials.json:ro"   cloudflare/cloudflared:latest   tunnel --no-autoupdate --config /etc/cloudflared/config.yml run >/dev/null

sleep 2
sudo -n "$DOCKER" inspect nomsod-bootstrap-edge >/dev/null
sudo -n "$DOCKER" inspect nomsod-bootstrap-tunnel >/dev/null

echo "Nomsod NAS public bootstrap edge is running."
