#!/bin/sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
exec /bin/sh "$HERE/INSTALL-MACOS.sh"
