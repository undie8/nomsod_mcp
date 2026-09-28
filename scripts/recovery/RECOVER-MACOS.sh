#!/bin/sh
set -eu

BUNDLE_ROOT=$(cd "$(dirname "$0")" && pwd)
BOOTSTRAP="$BUNDLE_ROOT/distribution/install/macos.sh"

if [ ! -f "$BOOTSTRAP" ]; then
  echo "Recovery kit is incomplete: distribution/install/macos.sh is missing." >&2
  exit 2
fi

echo "Nomsod MCP single-cluster recovery"
echo "Restoring the existing cluster from this recovery kit..."
NOMSOD_RECOVERY_ROOT="$BUNDLE_ROOT" /bin/sh "$BOOTSTRAP"
