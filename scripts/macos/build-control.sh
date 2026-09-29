#!/bin/sh
set -eu

ROOT=${1:-}
if [ -z "$ROOT" ]; then
  ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fi

APP_NAME="Nomsod MCP"
APP_BUNDLE="$ROOT/build/macos/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
SOURCE="$ROOT/scripts/macos/NomsodMcpMenuBar.swift"
BINARY="$MACOS_DIR/Nomsod MCP Control"
ICON_SOURCE="$ROOT/assets/nomsod-mcp-transparent.png"
ICONSET="$ROOT/build/macos/NomsodMCP.iconset"
ICNS="$RESOURCES/AppIcon.icns"
APP_VERSION=$(tr -d ' \r\n\t' < "$ROOT/VERSION")
if [ -z "$APP_VERSION" ]; then APP_VERSION="0.0.0"; fi

rm -rf "$APP_BUNDLE" "$ICONSET"
mkdir -p "$MACOS_DIR" "$RESOURCES" "$ICONSET"

if [ ! -f "$ICON_SOURCE" ]; then
  echo "Missing icon asset: $ICON_SOURCE" >&2
  exit 3
fi

cp "$ICON_SOURCE" "$RESOURCES/nomsod-mcp.png"

make_icon() {
  SIZE=$1
  OUT=$2
  /usr/bin/sips -z "$SIZE" "$SIZE" "$ICON_SOURCE" --out "$OUT" >/dev/null
}

make_icon 16   "$ICONSET/icon_16x16.png"
make_icon 32   "$ICONSET/icon_16x16@2x.png"
make_icon 32   "$ICONSET/icon_32x32.png"
make_icon 64   "$ICONSET/icon_32x32@2x.png"
make_icon 128  "$ICONSET/icon_128x128.png"
make_icon 256  "$ICONSET/icon_128x128@2x.png"
make_icon 256  "$ICONSET/icon_256x256.png"
make_icon 512  "$ICONSET/icon_256x256@2x.png"
make_icon 512  "$ICONSET/icon_512x512.png"
make_icon 1024 "$ICONSET/icon_512x512@2x.png"
/usr/bin/iconutil -c icns "$ICONSET" -o "$ICNS"

ROOT_XML=$(printf '%s' "$ROOT" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g')

cat > "$CONTENTS/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Nomsod MCP Control</string>
  <key>CFBundleIdentifier</key>
  <string>net.nomsod.mcp.control</string>
  <key>CFBundleName</key>
  <string>Nomsod MCP</string>
  <key>CFBundleDisplayName</key>
  <string>Nomsod MCP</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$APP_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$APP_VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NomsodProjectRoot</key>
  <string>$ROOT_XML</string>
</dict>
</plist>
EOF

/usr/bin/plutil -lint "$CONTENTS/Info.plist"

echo "Compiling Nomsod MCP Control..."
/usr/bin/swiftc -parse-as-library -O "$SOURCE" -o "$BINARY" -framework Cocoa
chmod +x "$BINARY"

/usr/bin/codesign --force --deep --sign -   --identifier "net.nomsod.mcp.control"   --requirements '=designated => identifier "net.nomsod.mcp.control"'   "$APP_BUNDLE"

INSTALL_DIR="$HOME/Applications"
INSTALL_APP="$INSTALL_DIR/$APP_NAME.app"
mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_APP"
cp -R "$APP_BUNDLE" "$INSTALL_APP"

/usr/bin/codesign --force --deep --sign -   --identifier "net.nomsod.mcp.control"   --requirements '=designated => identifier "net.nomsod.mcp.control"'   "$INSTALL_APP"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then "$LSREGISTER" -f "$INSTALL_APP" >/dev/null 2>&1 || true; fi

rm -rf "$ICONSET"
echo "Built: $APP_BUNDLE"
echo "Installed: $INSTALL_APP"
