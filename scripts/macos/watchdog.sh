#!/bin/sh
set -u

ROOT=$1
DOMAIN=$2
CHECK_SUPERVISOR=$3

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

healthy() {
  URL=$1
  /usr/bin/curl -fsS --max-time 5 "$URL" >/dev/null 2>&1
}

GATEWAY_HOST=$(health_host)
GATEWAY_PORT=$(env_value NOMSOD_GATEWAY_PORT 3219)
AGENT_PORT=$(env_value NOMSOD_AGENT_GUARDIAN_HEALTH_PORT 3232)

if [ "$CHECK_SUPERVISOR" = "1" ]; then
  if ! healthy "http://$GATEWAY_HOST:$GATEWAY_PORT/health"; then
    /bin/launchctl kickstart -k "$DOMAIN/com.nomsod.mcp.supervisor" >/dev/null 2>&1 || true
  fi
fi

if ! healthy "http://127.0.0.1:$AGENT_PORT/health"; then
  /bin/launchctl kickstart -k "$DOMAIN/com.nomsod.mcp.agent" >/dev/null 2>&1 || true
fi
