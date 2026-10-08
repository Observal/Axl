#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

# Release-only installer. Signing and notarization use locally configured identities and a
# notarytool Keychain profile name. Never install a development or ad-hoc helper here.
# Requires explicit human authorization before use of team assets, Apple submission, or install.
set -euo pipefail

if [ "$(uname -s)" != Darwin ]; then
  echo "Requires macOS." >&2
  exit 1
fi
if [ -z "${AXL_CODESIGN_IDENTITY:-}" ] || [ -z "${AXL_TEAM_ID:-}" ] || \
   [ -z "${AXL_PROVISIONING_PROFILE:-}" ] || [ -z "${AXL_NOTARY_KEYCHAIN_PROFILE:-}" ]; then
  echo "Release signing identity, team, provisioning profile and notary Keychain profile are all required." >&2
  exit 1
fi
if [[ ! "$AXL_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || [ ! -f "$AXL_PROVISIONING_PROFILE" ]; then
  echo "Invalid team identifier or missing provisioning profile." >&2
  exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
e2ee="$(cd "$here/../.." && pwd)"
parent="$HOME/Library/Application Support/Axl"
mkdir -p "$parent"
lock="$parent/.axl-keychain-install.lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo "Another installer is active or a stale installer lock needs review." >&2
  exit 1
fi
trap 'rmdir "$lock"' EXIT
bundle="$parent/AxlKeychainHelper.app"
# A directory at the public path is a legacy installation, not an upgradeable version pointer.
if [ -e "$bundle" ] && [ ! -L "$bundle" ]; then
  echo "Legacy helper found; it needs a separately reviewed migration." >&2
  exit 1
fi
if [ -L "$bundle" ] && [ "${AXL_DAEMON_STOPPED:-}" != 1 ]; then
  echo "For upgrades, stop the Axl daemon and confirm with AXL_DAEMON_STOPPED=1." >&2
  exit 1
fi
staging="$(mktemp -d "$parent/.axl-keychain-release.XXXXXXXX")"
trap 'rm -rf "$staging"; rmdir "$lock"' EXIT
app="$staging/AxlKeychainHelper.app"

cargo build --locked --release -p axl-keychain-helper --manifest-path "$e2ee/Cargo.toml"
mkdir -p "$app/Contents/MacOS"
cp "$e2ee/target/release/axl-keychain-helper" "$app/Contents/MacOS/"
cat >"$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>ai.observal.axl.keychain-helper</string>
  <key>CFBundleName</key><string>AxlKeychainHelper</string>
  <key>CFBundleExecutable</key><string>axl-keychain-helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSBackgroundOnly</key><true/>
</dict></plist>
PLIST
cp "$AXL_PROVISIONING_PROFILE" "$app/Contents/embedded.provisionprofile"
/usr/bin/python3 - "$staging/entitlements.plist" "$AXL_TEAM_ID" <<'PY'
import plistlib
import sys
identity = f"{sys.argv[2]}.ai.observal.axl.keychain-helper"
with open(sys.argv[1], "wb") as output:
    plistlib.dump({
        "com.apple.application-identifier": identity,
        "com.apple.developer.team-identifier": sys.argv[2],
        "keychain-access-groups": [identity],
    }, output)
PY
codesign --force --options runtime --timestamp --entitlements "$staging/entitlements.plist" \
  --sign "$AXL_CODESIGN_IDENTITY" "$app"
# ZIP preserves the bundle for the notary service; staple the accepted ticket to the app itself.
ditto -c -k --keepParent "$app" "$staging/AxlKeychainHelper.zip"
xcrun notarytool submit "$staging/AxlKeychainHelper.zip" \
  --keychain-profile "$AXL_NOTARY_KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$app"
/usr/bin/python3 "$here/verify-macos.py" "$app" "$AXL_TEAM_ID"
# Package the *stapled* app, not the pre-staple submission ZIP. Verify the contents again after
# unpacking, so the archived release artifact is subject to the same gate as the install.
ditto -c -k --keepParent "$app" "$staging/AxlKeychainHelper-notarized.zip"
mkdir "$staging/unpacked"
ditto -x -k "$staging/AxlKeychainHelper-notarized.zip" "$staging/unpacked"
/usr/bin/python3 "$here/verify-macos.py" "$staging/unpacked/AxlKeychainHelper.app" "$AXL_TEAM_ID"
chmod 600 "$staging/AxlKeychainHelper-notarized.zip"
# Stop the daemon before a planned upgrade and restart it after publication. The previous
# signed bundle is retained; this script never removes local E2EE state or the Keychain key.
/usr/bin/python3 "$here/publish-macos.py" "$app" \
  "$staging/AxlKeychainHelper-notarized.zip" "$parent" "$AXL_TEAM_ID"
installed="$(readlink "$bundle")"
shasum -a 256 "$parent/$installed/Contents/MacOS/axl-keychain-helper" \
  "${parent}/${installed%.app}.zip"
echo "Installed verified Keychain helper and packaged stapled app. Native runtime evidence is still required."
