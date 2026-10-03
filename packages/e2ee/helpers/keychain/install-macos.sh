#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

# Build axl-keychain-helper and install it for this macOS user as
# ~/Library/Application Support/Axl/AxlKeychainHelper.app, where `axl remote login` looks for it.
#
# The data-protection Keychain answers only a helper signed with Axl's Developer ID, its
# `keychain-access-groups` entitlement, and an embedded provisioning profile. Set all three of
# AXL_CODESIGN_IDENTITY, AXL_TEAM_ID, and AXL_PROVISIONING_PROFILE to sign it that way. Without them
# the helper is signed ad hoc: it installs and starts, the Keychain refuses it, and remote access
# fails closed with `secure_store_access_denied`.

set -euo pipefail

if [ "$(uname -s)" != Darwin ]; then
  echo "Run this on the Mac whose daemon will use remote access." >&2
  exit 1
fi

e2ee="$(cd "$(dirname "$0")/../.." && pwd)"
cargo build --locked --release -p axl-keychain-helper --manifest-path "$e2ee/Cargo.toml"

bundle="$HOME/Library/Application Support/Axl/AxlKeychainHelper.app"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
app="$staging/AxlKeychainHelper.app"
mkdir -p "$app/Contents/MacOS"
cp "$e2ee/target/release/axl-keychain-helper" "$app/Contents/MacOS/"
cat >"$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>ai.observal.axl.keychain-helper</string>
  <key>CFBundleName</key>
  <string>AxlKeychainHelper</string>
  <key>CFBundleExecutable</key>
  <string>axl-keychain-helper</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSBackgroundOnly</key>
  <true/>
</dict>
</plist>
PLIST

if [ -n "${AXL_CODESIGN_IDENTITY:-}" ] && [ -n "${AXL_TEAM_ID:-}" ] && [ -n "${AXL_PROVISIONING_PROFILE:-}" ]; then
  cp "$AXL_PROVISIONING_PROFILE" "$app/Contents/embedded.provisionprofile"
  cat >"$staging/entitlements.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.application-identifier</key>
  <string>${AXL_TEAM_ID}.ai.observal.axl.keychain-helper</string>
  <key>com.apple.developer.team-identifier</key>
  <string>${AXL_TEAM_ID}</string>
  <key>keychain-access-groups</key>
  <array>
    <string>${AXL_TEAM_ID}.ai.observal.axl.keychain-helper</string>
  </array>
</dict>
</plist>
PLIST
  codesign --force --options runtime --timestamp --entitlements "$staging/entitlements.plist" \
    --sign "$AXL_CODESIGN_IDENTITY" "$app"
  echo "Signed with $AXL_CODESIGN_IDENTITY for team $AXL_TEAM_ID"
else
  codesign --force --sign - "$app"
  echo "Signed ad hoc: the Keychain will refuse this helper until it is signed with Axl's Developer ID." >&2
fi

mkdir -p "$(dirname "$bundle")"
rm -rf "$bundle"
mv "$app" "$bundle"
echo "Installed $bundle/Contents/MacOS/axl-keychain-helper"
