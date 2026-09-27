#!/bin/sh
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
VERSION=${NOMSOD_NODE_VERSION:-24.13.0}
OS=darwin

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *)
    echo "Unsupported macOS architecture: $(uname -m)" >&2
    exit 2
    ;;
esac

RUNTIME_DIR="$ROOT/.runtime"
TARGET="$RUNTIME_DIR/node-v$VERSION-$OS-$ARCH"
LINK="$RUNTIME_DIR/node"

if [ -x "$LINK/bin/node" ]; then
  "$LINK/bin/node" --version
  exit 0
fi

mkdir -p "$RUNTIME_DIR"
TMP=$(mktemp -d "$RUNTIME_DIR/node-download.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

BASE="https://nodejs.org/dist/v$VERSION"
ARCHIVE="node-v$VERSION-$OS-$ARCH.tar.gz"

echo "Downloading Node.js v$VERSION for $OS-$ARCH..."
/usr/bin/curl -fL --retry 3 --connect-timeout 15   "$BASE/$ARCHIVE"   -o "$TMP/$ARCHIVE"
/usr/bin/curl -fL --retry 3 --connect-timeout 15   "$BASE/SHASUMS256.txt"   -o "$TMP/SHASUMS256.txt"

EXPECTED=$(awk -v file="$ARCHIVE" '$2 == file { print $1; exit }' "$TMP/SHASUMS256.txt")
if [ -z "$EXPECTED" ]; then
  echo "Unable to find checksum for $ARCHIVE" >&2
  exit 3
fi

ACTUAL=$(/usr/bin/shasum -a 256 "$TMP/$ARCHIVE" | awk '{ print $1 }')
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Node.js checksum verification failed" >&2
  echo "Expected: $EXPECTED" >&2
  echo "Actual:   $ACTUAL" >&2
  exit 4
fi

/bin/rm -rf "$TARGET"
/usr/bin/tar -xzf "$TMP/$ARCHIVE" -C "$TMP"
/bin/mv "$TMP/node-v$VERSION-$OS-$ARCH" "$TARGET"
/bin/rm -f "$LINK"
/bin/ln -s "$TARGET" "$LINK"

echo "Portable Node installed: $LINK/bin/node"
"$LINK/bin/node" --version
