#!/bin/sh
set -eu

MODE=both
NO_START=0
SYSTEM_SUPERVISOR=0
DRY_RUN=0
SKIP_CONFIG_CHECK=0

if [ "$#" -gt 0 ]; then
  case "$1" in
    both|supervisor|agent)
      MODE=$1
      shift
      ;;
  esac
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-start) NO_START=1 ;;
    --system-supervisor) SYSTEM_SUPERVISOR=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-config-check) SKIP_CONFIG_CHECK=1 ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if [ "$SKIP_CONFIG_CHECK" -eq 1 ] && [ "$DRY_RUN" -ne 1 ]; then
  echo "--skip-config-check is allowed only with --dry-run" >&2
  exit 2
fi

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
UID_NUM=$(id -u)
DOMAIN="gui/$UID_NUM"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
SERVICE_DIR="$ROOT/data/service"
LOG_DIR="$ROOT/data/logs"

mkdir -p "$LAUNCH_DIR" "$SERVICE_DIR" "$LOG_DIR"

if [ "$SKIP_CONFIG_CHECK" -ne 1 ]; then
  if [ ! -f "$ROOT/.env" ]; then
    echo "Missing $ROOT/.env. Copy .env.example to .env and configure Nomsod first." >&2
    exit 2
  fi

  if [ "$MODE" = "both" ] || [ "$MODE" = "supervisor" ]; then
    if grep -q 'change-me-long-random-secret\|change-me-separate-pairing-token' "$ROOT/.env"; then
      echo ".env still contains example secrets." >&2
      exit 2
    fi
  fi
fi

resolve_node() {
  if [ -n "${NOMSOD_NODE_BIN:-}" ] && [ -x "$NOMSOD_NODE_BIN" ]; then
    printf '%s' "$NOMSOD_NODE_BIN"
    return
  fi

  for candidate in     "$ROOT/.runtime/node/bin/node"     /opt/homebrew/bin/node     /usr/local/bin/node
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

  "$ROOT/scripts/macos/ensure-node.sh" >/dev/null
  printf '%s' "$ROOT/.runtime/node/bin/node"
}

NODE=$(resolve_node)
NODE_DIR=$(dirname "$NODE")
PATH="$NODE_DIR:$PATH"
export PATH
NPM=$(command -v npm 2>/dev/null || true)

if [ -z "$NPM" ]; then
  echo "npm was not found next to resolved Node: $NODE" >&2
  exit 3
fi

cd "$ROOT"
echo "Node: $NODE"
"$NODE" --version
"$NPM" install
"$NPM" run build

xml_escape() {
  printf '%s' "$1" |
    sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

write_plist() {
  LABEL=$1
  SCRIPT=$2
  OUT=$3
  ERR=$4
  PLIST=$5

  NODE_X=$(xml_escape "$NODE")
  SCRIPT_X=$(xml_escape "$SCRIPT")
  ROOT_X=$(xml_escape "$ROOT")
  OUT_X=$(xml_escape "$OUT")
  ERR_X=$(xml_escape "$ERR")
  LABEL_X=$(xml_escape "$LABEL")

  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL_X</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_X</string>
    <string>$SCRIPT_X</string>
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
}

validate_plist() {
  PLIST=$1
  /usr/bin/plutil -lint "$PLIST"
}

install_user_agent() {
  LABEL=$1
  SCRIPT=$2
  NAME=$3
  PLIST="$LAUNCH_DIR/$LABEL.plist"

  write_plist "$LABEL" "$SCRIPT" "$LOG_DIR/launchd-$NAME.out.log" "$LOG_DIR/launchd-$NAME.err.log" "$PLIST"
  validate_plist "$PLIST"

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] would install $LABEL from $PLIST"
    return
  fi

  /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  if [ "$NO_START" -eq 0 ]; then
    /bin/launchctl bootstrap "$DOMAIN" "$PLIST"
  fi
}

if [ "$MODE" = "both" ] || [ "$MODE" = "supervisor" ]; then
  if [ "$SYSTEM_SUPERVISOR" -eq 1 ]; then
    LABEL=com.nomsod.mcp.supervisor
    TEMP="$SERVICE_DIR/$LABEL.plist"
    write_plist "$LABEL" "$ROOT/dist/bootstrap/supervisor.js" "$LOG_DIR/launchd-supervisor.out.log" "$LOG_DIR/launchd-supervisor.err.log" "$TEMP"
    validate_plist "$TEMP"

    if [ "$DRY_RUN" -eq 1 ]; then
      echo "[dry-run] would install system LaunchDaemon $LABEL"
    else
      sudo /bin/launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
      sudo cp "$TEMP" "/Library/LaunchDaemons/$LABEL.plist"
      sudo chown root:wheel "/Library/LaunchDaemons/$LABEL.plist"
      sudo chmod 644 "/Library/LaunchDaemons/$LABEL.plist"

      if [ "$NO_START" -eq 0 ]; then
        sudo /bin/launchctl bootstrap system "/Library/LaunchDaemons/$LABEL.plist"
      fi
    fi
  else
    install_user_agent com.nomsod.mcp.supervisor "$ROOT/dist/bootstrap/supervisor.js" supervisor
  fi
fi

if [ "$MODE" = "both" ] || [ "$MODE" = "agent" ]; then
  install_user_agent com.nomsod.mcp.agent "$ROOT/dist/bootstrap/agent.js" agent
fi

WATCHDOG_LABEL=com.nomsod.mcp.watchdog
WATCHDOG_PLIST="$LAUNCH_DIR/$WATCHDOG_LABEL.plist"
WATCHDOG_SCRIPT=$(xml_escape "$ROOT/scripts/macos/watchdog.sh")
ROOT_X=$(xml_escape "$ROOT")
DOMAIN_X=$(xml_escape "$DOMAIN")
OUT_X=$(xml_escape "$LOG_DIR/launchd-watchdog.out.log")
ERR_X=$(xml_escape "$LOG_DIR/launchd-watchdog.err.log")
CHECK_SUPERVISOR=1
if [ "$SYSTEM_SUPERVISOR" -eq 1 ]; then CHECK_SUPERVISOR=0; fi

cat > "$WATCHDOG_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$WATCHDOG_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$WATCHDOG_SCRIPT</string>
    <string>$ROOT_X</string>
    <string>$DOMAIN_X</string>
    <string>$CHECK_SUPERVISOR</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$OUT_X</string>
  <key>StandardErrorPath</key>
  <string>$ERR_X</string>
</dict>
</plist>
EOF

validate_plist "$WATCHDOG_PLIST"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would install $WATCHDOG_LABEL from $WATCHDOG_PLIST"
else
  /bin/launchctl bootout "$DOMAIN/$WATCHDOG_LABEL" >/dev/null 2>&1 || true
  if [ "$NO_START" -eq 0 ]; then
    /bin/launchctl bootstrap "$DOMAIN" "$WATCHDOG_PLIST"
  fi
fi

echo "Nomsod MCP macOS launch services prepared."
echo "Project: $ROOT"
echo "Node: $NODE"
