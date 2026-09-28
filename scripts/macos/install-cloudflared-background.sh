#!/bin/sh
set -eu

ROOT=${1:-}
NO_START=${2:-0}

if [ -z "$ROOT" ]; then
  ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fi

ENVFILE="$ROOT/.env"
[ -f "$ENVFILE" ] || exit 0

env_value() {
  KEY=$1
  awk -F= -v key="$KEY" '
    $1==key {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$ENVFILE"
}

CLOUDFLARED=$(env_value NOMSOD_CLOUDFLARED_EXE)
TUNNEL_ID=$(env_value NOMSOD_TUNNEL_ID)
CREDENTIALS=$(env_value NOMSOD_TUNNEL_CREDENTIALS)
ORIGIN=$(env_value NOMSOD_TUNNEL_ORIGIN)

if [ -z "$TUNNEL_ID" ] || [ -z "$CREDENTIALS" ] || [ -z "$ORIGIN" ]; then
  exit 0
fi

if [ -z "$CLOUDFLARED" ] || [ ! -x "$CLOUDFLARED" ]; then
  echo "Configured cloudflared executable is unavailable: $CLOUDFLARED" >&2
  exit 3
fi

if [ ! -f "$CREDENTIALS" ]; then
  echo "Cloudflare tunnel credentials are unavailable: $CREDENTIALS" >&2
  exit 3
fi

UID_NUM=$(id -u)
DOMAIN="gui/$UID_NUM"
LABEL=com.nomsod.mcp.cloudflared
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$ROOT/data/logs"
PLIST="$LAUNCH_DIR/$LABEL.plist"

mkdir -p "$LAUNCH_DIR" "$LOG_DIR"

xml_escape() {
  printf '%s' "$1" |
    sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

EXE_X=$(xml_escape "$CLOUDFLARED")
CREDS_X=$(xml_escape "$CREDENTIALS")
ORIGIN_X=$(xml_escape "$ORIGIN")
TUNNEL_X=$(xml_escape "$TUNNEL_ID")
ROOT_X=$(xml_escape "$ROOT")
OUT_X=$(xml_escape "$LOG_DIR/cloudflared.out.log")
ERR_X=$(xml_escape "$LOG_DIR/cloudflared.err.log")

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$EXE_X</string>
    <string>tunnel</string>
    <string>--no-autoupdate</string>
    <string>run</string>
    <string>--credentials-file</string>
    <string>$CREDS_X</string>
    <string>--url</string>
    <string>$ORIGIN_X</string>
    <string>$TUNNEL_X</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_X</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$OUT_X</string>
  <key>StandardErrorPath</key>
  <string>$ERR_X</string>
</dict>
</plist>
EOF

/usr/bin/plutil -lint "$PLIST" >/dev/null

if [ "$NO_START" = "1" ]; then
  exit 0
fi

/bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
sleep 0.5
/bin/launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Nomsod MCP Cloudflare connector installed."
