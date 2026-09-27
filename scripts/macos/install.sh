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
"$NODE" --version
"$NPM" install
"$NPM" run build

echo "Building Nomsod MCP Control..."
/bin/sh "$ROOT/scripts/macos/build-control.sh" "$ROOT"

RUNTIME_DIR="$ROOT/.runtime"
ROLE_APP_DIR="$RUNTIME_DIR/apps"
CONTROL_APP="$HOME/Applications/Nomsod MCP.app"
CONTROL_BIN="$CONTROL_APP/Contents/MacOS/Nomsod MCP Control"
ROLE_ICON="$CONTROL_APP/Contents/Resources/AppIcon.icns"

mkdir -p "$ROLE_APP_DIR"

make_role_app() {
  ROLE_NAME=$1
  BUNDLE_ID=$2
  APP="$ROLE_APP_DIR/$ROLE_NAME.app"
  CONTENTS="$APP/Contents"
  MACOS="$CONTENTS/MacOS"
  RESOURCES="$CONTENTS/Resources"
  BINARY="$MACOS/$ROLE_NAME"

  rm -rf "$APP"
  mkdir -p "$MACOS" "$RESOURCES"

  if cp -c "$NODE" "$BINARY" 2>/dev/null; then
    :
  else
    cp "$NODE" "$BINARY"
  fi
  chmod +x "$BINARY"
  cp "$ROLE_ICON" "$RESOURCES/AppIcon.icns"

  APP_VERSION=$(awk 'NR==1 { gsub(/[[:space:]]/, ""); print; exit }' "$ROOT/VERSION")
  if [ -z "$APP_VERSION" ]; then APP_VERSION="0.0.0"; fi

  cat > "$CONTENTS/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>$ROLE_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleName</key>
  <string>$ROLE_NAME</string>
  <key>CFBundleDisplayName</key>
  <string>$ROLE_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleShortVersionString</key>
  <string>$APP_VERSION</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSBackgroundOnly</key>
  <true/>
</dict>
</plist>
EOF

  /usr/bin/plutil -lint "$CONTENTS/Info.plist" >/dev/null
  /usr/bin/codesign --force --deep --sign - --identifier "$BUNDLE_ID" "$APP" >/dev/null
  printf '%s' "$BINARY"
}

SUPERVISOR_NODE=$(make_role_app "Nomsod MCP Supervisor" "net.nomsod.mcp.supervisor")
GATEWAY_NODE=$(make_role_app "Nomsod MCP Gateway" "net.nomsod.mcp.gateway")
AGENT_NODE=$(make_role_app "Nomsod MCP Agent" "net.nomsod.mcp.agent")
WORKER_NODE=$(make_role_app "Nomsod MCP Worker" "net.nomsod.mcp.worker")

set_env_value() {
  KEY=$1
  VALUE=$2
  FILE="$ROOT/.env"
  TMP="$FILE.tmp"
  awk -F= -v key="$KEY" -v value="$VALUE" '
    BEGIN { found=0 }
    $1==key { print key "=" value; found=1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$FILE" > "$TMP"
  mv "$TMP" "$FILE"
  chmod 600 "$FILE"
}

set_env_value NOMSOD_GATEWAY_EXECUTABLE "$GATEWAY_NODE"
set_env_value NOMSOD_WORKER_EXECUTABLE "$WORKER_NODE"

echo "Supervisor process: $SUPERVISOR_NODE"
echo "Gateway process: $GATEWAY_NODE"
echo "Agent process: $AGENT_NODE"
echo "Worker process: $WORKER_NODE"
echo "Control app: $CONTROL_APP"
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
  EXECUTABLE=$6

  NODE_X=$(xml_escape "$EXECUTABLE")
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

  EXECUTABLE=$4

  write_plist "$LABEL" "$SCRIPT" "$LOG_DIR/launchd-$NAME.out.log" "$LOG_DIR/launchd-$NAME.err.log" "$PLIST" "$EXECUTABLE"
  validate_plist "$PLIST"

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] would install $LABEL from $PLIST"
    return
  fi

  if [ "$NO_START" -eq 0 ]; then
    if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      CURRENT_PROGRAM=$(/bin/launchctl print "$DOMAIN/$LABEL" 2>/dev/null |
        sed -n 's/^[[:space:]]*program = //p' | head -1)

      if [ "$CURRENT_PROGRAM" = "$EXECUTABLE" ]; then
        /bin/launchctl kickstart -k "$DOMAIN/$LABEL"
      else
        echo "Migrating $LABEL program path:"
        echo "  from: $CURRENT_PROGRAM"
        echo "  to:   $EXECUTABLE"

        /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true

        WAIT=0
        while /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; do
          WAIT=$((WAIT + 1))
          if [ "$WAIT" -ge 20 ]; then
            echo "Timed out waiting for $LABEL to unload." >&2
            exit 4
          fi
          sleep 0.25
        done

        ATTEMPT=1
        while :; do
          if /bin/launchctl bootstrap "$DOMAIN" "$PLIST"; then
            break
          fi
          if [ "$ATTEMPT" -ge 3 ]; then
            echo "Failed to bootstrap migrated $LABEL." >&2
            exit 4
          fi
          ATTEMPT=$((ATTEMPT + 1))
          sleep 1
        done
      fi
    else
      sleep 1
      /bin/launchctl bootstrap "$DOMAIN" "$PLIST"
    fi
  fi
}

if [ "$MODE" = "both" ] || [ "$MODE" = "supervisor" ]; then
  if [ "$SYSTEM_SUPERVISOR" -eq 1 ]; then
    LABEL=com.nomsod.mcp.supervisor
    TEMP="$SERVICE_DIR/$LABEL.plist"
    write_plist "$LABEL" "$ROOT/dist/bootstrap/supervisor.js" "$LOG_DIR/launchd-supervisor.out.log" "$LOG_DIR/launchd-supervisor.err.log" "$TEMP" "$SUPERVISOR_NODE"
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
    install_user_agent com.nomsod.mcp.supervisor "$ROOT/dist/bootstrap/supervisor.js" supervisor "$SUPERVISOR_NODE"
  fi
fi

if [ "$MODE" = "both" ] || [ "$MODE" = "agent" ]; then
  install_user_agent com.nomsod.mcp.agent "$ROOT/dist/bootstrap/agent.js" agent "$AGENT_NODE"
fi

CONTROL_LABEL=com.nomsod.mcp.control
CONTROL_PLIST="$LAUNCH_DIR/$CONTROL_LABEL.plist"
CONTROL_BIN_X=$(xml_escape "$CONTROL_BIN")
ROOT_X=$(xml_escape "$ROOT")
CONTROL_OUT_X=$(xml_escape "$LOG_DIR/launchd-control.out.log")
CONTROL_ERR_X=$(xml_escape "$LOG_DIR/launchd-control.err.log")

cat > "$CONTROL_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$CONTROL_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CONTROL_BIN_X</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_X</string>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$CONTROL_OUT_X</string>
  <key>StandardErrorPath</key>
  <string>$CONTROL_ERR_X</string>
</dict>
</plist>
EOF

validate_plist "$CONTROL_PLIST"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would install $CONTROL_LABEL from $CONTROL_PLIST"
else
  if [ "$NO_START" -eq 0 ]; then
    if /bin/launchctl print "$DOMAIN/$CONTROL_LABEL" >/dev/null 2>&1; then
      /bin/launchctl kickstart -k "$DOMAIN/$CONTROL_LABEL"
    else
      sleep 1
      /bin/launchctl bootstrap "$DOMAIN" "$CONTROL_PLIST"
    fi
  fi
fi

UPDATER_LABEL=com.nomsod.mcp.updater
UPDATER_PLIST="$LAUNCH_DIR/$UPDATER_LABEL.plist"
UPDATER_SCRIPT_X=$(xml_escape "$ROOT/scripts/macos/update.sh")
ROOT_X=$(xml_escape "$ROOT")
UPDATER_OUT_X=$(xml_escape "$LOG_DIR/launchd-updater.out.log")
UPDATER_ERR_X=$(xml_escape "$LOG_DIR/launchd-updater.err.log")

cat > "$UPDATER_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$UPDATER_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$UPDATER_SCRIPT_X</string>
    <string>$ROOT_X</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$UPDATER_OUT_X</string>
  <key>StandardErrorPath</key>
  <string>$UPDATER_ERR_X</string>
</dict>
</plist>
EOF

validate_plist "$UPDATER_PLIST"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would install $UPDATER_LABEL from $UPDATER_PLIST"
else
  if [ "$NO_START" -eq 0 ]; then
    if /bin/launchctl print "$DOMAIN/$UPDATER_LABEL" >/dev/null 2>&1; then
      if [ "${NOMSOD_UPDATE_IN_PROGRESS:-0}" != "1" ]; then
        /bin/launchctl kickstart -k "$DOMAIN/$UPDATER_LABEL"
      fi
    else
      sleep 1
      /bin/launchctl bootstrap "$DOMAIN" "$UPDATER_PLIST"
    fi
  fi
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
  if [ "$NO_START" -eq 0 ]; then
    if /bin/launchctl print "$DOMAIN/$WATCHDOG_LABEL" >/dev/null 2>&1; then
      /bin/launchctl kickstart -k "$DOMAIN/$WATCHDOG_LABEL"
    else
      sleep 1
      /bin/launchctl bootstrap "$DOMAIN" "$WATCHDOG_PLIST"
    fi
  fi
fi

if [ "$DRY_RUN" -ne 1 ]; then
  printf '%s\n' "$MODE" > "$ROOT/data/install-role.txt"
  chmod 600 "$ROOT/data/install-role.txt"
fi

echo "Nomsod MCP macOS launch services prepared."
echo "Project: $ROOT"
echo "Node runtime: $NODE"
