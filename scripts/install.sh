#!/bin/sh
# SPDX-FileCopyrightText: 2026 Hari Srinivasan
# SPDX-License-Identifier: Apache-2.0

set -eu

repository=Observal/Axl

command -v curl >/dev/null 2>&1 || {
  echo "axl installer: curl is required" >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "axl installer: Node.js ^22.19.0 or >=24.0.0 is required" >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "axl installer: npm is required" >&2
  exit 1
}

node_version=$(node -p 'process.versions.node')
node_major=${node_version%%.*}
node_rest=${node_version#*.}
node_minor=${node_rest%%.*}
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 19 ]; } || [ "$node_major" -eq 23 ]; then
  echo "axl installer: Node.js $node_version is unsupported; install ^22.19.0 or >=24.0.0" >&2
  exit 1
fi

if [ -n "${AXL_VERSION:-}" ]; then
  version=$AXL_VERSION
else
  version=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repository/releases/latest")
  version=${version##*/}
fi
case "$version" in
  v*) ;;
  *) version="v$version" ;;
esac

number=${version#v}
artifact="observal-axl-$number.tgz"
base="https://github.com/$repository/releases/download/$version"
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

curl -fsSL "$base/$artifact" -o "$temporary/$artifact"
curl -fsSL "$base/checksums.txt" -o "$temporary/checksums.txt"

expected=$(awk -v artifact="$artifact" '$2 == artifact { print $1 }' "$temporary/checksums.txt")
[ -n "$expected" ] || {
  echo "axl installer: $artifact is absent from checksums.txt" >&2
  exit 1
}
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/$artifact" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$temporary/$artifact" | awk '{ print $1 }')
else
  echo "axl installer: sha256sum or shasum is required" >&2
  exit 1
fi
[ "$actual" = "$expected" ] || {
  echo "axl installer: checksum verification failed for $artifact" >&2
  exit 1
}

npm install --global --ignore-scripts "$temporary/$artifact"
axl --version
