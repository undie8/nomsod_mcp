#!/bin/sh
set -eu

ROOT=${1:-/volume1/docker/nomsod-bootstrap}
TAILSCALE_IP=${2:-100.111.178.74}
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
RUNTIME="$ROOT/runtime"
CURRENT="$ROOT/current"
PUBLIC="$CURRENT/public"
CREDENTIALS="$RUNTIME/bootstrap-tunnel-credentials.json"

[ -x "$DOCKER" ] || { echo "Container Manager docker binary is missing." >&2; exit 2; }
[ -d "$PUBLIC" ] || { echo "Missing NAS public bootstrap directory." >&2; exit 3; }
[ -f "$CREDENTIALS" ] || { echo "Missing dedicated bootstrap tunnel credential." >&2; exit 4; }

mkdir -p "$RUNTIME"
chmod 750 "$ROOT" "$CURRENT" "$RUNTIME"
chmod 600 "$CREDENTIALS"
find "$PUBLIC" -type d -exec chmod 711 {} \;
find "$PUBLIC" -type f -exec chmod 644 {} \;

TUNNEL_ID=$(python3 - "$CREDENTIALS" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    data=json.load(f)
for key in ("TunnelID","tunnelID","TunnelId","tunnelId"):
    value=str(data.get(key) or "").strip()
    if value:
        print(value)
        raise SystemExit(0)
raise SystemExit("Bootstrap tunnel credential has no tunnel ID.")
PY
)

cp "$CURRENT/runtime-config/nginx.conf" "$RUNTIME/nginx.conf"
sed "s/__TUNNEL_ID__/$TUNNEL_ID/g" "$CURRENT/runtime-config/cloudflared.yml.template" > "$RUNTIME/cloudflared.yml"
chmod 640 "$RUNTIME/nginx.conf" "$RUNTIME/cloudflared.yml"

sudo -n "$DOCKER" network inspect nomsod-bootstrap-net >/dev/null 2>&1 || \
  sudo -n "$DOCKER" network create nomsod-bootstrap-net >/dev/null

sudo -n "$DOCKER" pull nginx:alpine >/dev/null
sudo -n "$DOCKER" pull cloudflare/cloudflared:latest >/dev/null

for name in nomsod-bootstrap-edge nomsod-bootstrap-tunnel; do
  if sudo -n "$DOCKER" inspect "$name" >/dev/null 2>&1; then
    sudo -n "$DOCKER" rm -f "$name" >/dev/null
  fi
done

sudo -n "$DOCKER" run -d \
  --name nomsod-bootstrap-edge \
  --restart unless-stopped \
  --network nomsod-bootstrap-net \
  -p "$TAILSCALE_IP:34150:8080" \
  -v "$PUBLIC:/srv/public:ro" \
  -v "$RUNTIME/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:alpine >/dev/null

sudo -n "$DOCKER" run -d \
  --name nomsod-bootstrap-tunnel \
  --restart unless-stopped \
  --network nomsod-bootstrap-net \
  --user 0:0 \
  -v "$RUNTIME/cloudflared.yml:/etc/cloudflared/config.yml:ro" \
  -v "$CREDENTIALS:/etc/cloudflared/credentials.json:ro" \
  cloudflare/cloudflared:latest \
  tunnel --no-autoupdate --config /etc/cloudflared/config.yml run >/dev/null

sleep 2
sudo -n "$DOCKER" inspect nomsod-bootstrap-edge >/dev/null
sudo -n "$DOCKER" inspect nomsod-bootstrap-tunnel >/dev/null

echo "Nomsod NAS public bootstrap edge is running."
