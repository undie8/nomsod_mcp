#!/bin/sh
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
UID_NUM=$(id -u)
DOMAIN="gui/$UID_NUM"

strip_outer_quotes() {
  VALUE=$1
  case "$VALUE" in
    \"*\")
      VALUE=${VALUE#\"}
      VALUE=${VALUE%\"}
      ;;
    \'*\')
      VALUE=${VALUE#\'}
      VALUE=${VALUE%\'}
      ;;
  esac
  printf '%s' "$VALUE"
}

env_value() {
  KEY=$1
  DEFAULT=$2
  FILE="$ROOT/.env"

  if [ ! -f "$FILE" ]; then
    printf '%s' "$DEFAULT"
    return
  fi

  VALUE=$(grep -E "^$KEY=" "$FILE" 2>/dev/null | tail -n 1 | cut -d= -f2-)
  if [ -z "$VALUE" ]; then
    printf '%s' "$DEFAULT"
    return
  fi

  strip_outer_quotes "$VALUE"
}

health_host() {
  VALUE=$(env_value NOMSOD_GATEWAY_HOST 127.0.0.1)
  case "$VALUE" in
    ""|0.0.0.0|::|"[::]")
      VALUE=127.0.0.1
      ;;
  esac
  printf '%s' "$VALUE"
}

for LABEL in com.nomsod.mcp.supervisor com.nomsod.mcp.agent com.nomsod.mcp.control com.nomsod.mcp.updater com.nomsod.mcp.watchdog; do
  echo ""
  echo "=== $LABEL ==="
  /bin/launchctl print "$DOMAIN/$LABEL" 2>/dev/null |
    grep -E 'state =|pid =|last exit code =' ||
    echo "Not loaded in user domain"
done

echo ""
echo "=== System Supervisor ==="
/bin/launchctl print system/com.nomsod.mcp.supervisor 2>/dev/null |
  grep -E 'state =|pid =|last exit code =' ||
  echo "Not loaded in system domain"

GATEWAY_HOST=$(health_host)
GATEWAY_PORT=$(env_value NOMSOD_GATEWAY_PORT 3219)
AGENT_PORT=$(env_value NOMSOD_AGENT_GUARDIAN_HEALTH_PORT 3232)

echo ""
echo "=== Health ==="
/usr/bin/curl -fsS --max-time 3 "http://$GATEWAY_HOST:$GATEWAY_PORT/health" 2>/dev/null ||
  echo "Supervisor unavailable"
echo ""
/usr/bin/curl -fsS --max-time 3 "http://127.0.0.1:$AGENT_PORT/health" 2>/dev/null ||
  echo "Agent Guardian unavailable"
echo ""
