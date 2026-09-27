#!/bin/sh
set -u

MODE=both
if [ "$#" -gt 0 ]; then MODE=$1; fi

UID_NUM=$(id -u)
DOMAIN="gui/$UID_NUM"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
SYSTEM_LABEL=com.nomsod.mcp.supervisor
SYSTEM_PLIST="/Library/LaunchDaemons/$SYSTEM_LABEL.plist"

remove_user() {
  LABEL=$1
  /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  rm -f "$LAUNCH_DIR/$LABEL.plist"
}

remove_system_supervisor_if_present() {
  if [ -f "$SYSTEM_PLIST" ] || /bin/launchctl print "system/$SYSTEM_LABEL" >/dev/null 2>&1; then
    sudo /bin/launchctl bootout "system/$SYSTEM_LABEL" >/dev/null 2>&1 || true
    sudo rm -f "$SYSTEM_PLIST"
  fi
}

if [ "$MODE" = "both" ] || [ "$MODE" = "supervisor" ]; then
  remove_user com.nomsod.mcp.supervisor
  remove_system_supervisor_if_present
fi

if [ "$MODE" = "both" ] || [ "$MODE" = "agent" ]; then
  remove_user com.nomsod.mcp.agent
fi

remove_user com.nomsod.mcp.control
remove_user com.nomsod.mcp.updater
remove_user com.nomsod.mcp.watchdog

echo "Nomsod data, releases, .env and device identity were preserved."
