#!/bin/sh
set -eu

AUTHORITY_ROOT=$(cd "$(dirname "$0")" && pwd)
BUNDLE_ROOT="$AUTHORITY_ROOT/bundle"
BOOTSTRAP="$BUNDLE_ROOT/distribution/install/macos.sh"

if [ ! -f "$BOOTSTRAP" ]; then
  echo "Nomsod NAS bootstrap is incomplete: macOS installer is missing." >&2
  exit 2
fi

if [ -f "$AUTHORITY_ROOT/STATUS.json" ]; then
  VERSION=$(/usr/bin/plutil -extract version raw -o - "$AUTHORITY_ROOT/STATUS.json" 2>/dev/null || true)
  CLUSTER=$(/usr/bin/plutil -extract clusterId raw -o - "$AUTHORITY_ROOT/STATUS.json" 2>/dev/null || true)
  echo "Nomsod MCP NAS bootstrap: cluster=$CLUSTER version=$VERSION"
fi

echo "Installing the existing Nomsod cluster from NAS..."
NOMSOD_RECOVERY_ROOT="$BUNDLE_ROOT" /bin/sh "$BOOTSTRAP"

echo
echo "Nomsod MCP installation from NAS completed."
