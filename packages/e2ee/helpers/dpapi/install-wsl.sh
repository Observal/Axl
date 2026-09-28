#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

# Build axl-dpapi-helper.exe and install it for the signed-in Windows user at
# %LOCALAPPDATA%\Axl\bin, where `axl remote login` looks for it. Run it from WSL. It needs the
# x86_64-pc-windows-gnu Rust target (added here) and a MinGW-w64 linker: `apt install mingw-w64`,
# or set AXL_MINGW_BIN to a directory that holds x86_64-w64-mingw32-gcc.

set -euo pipefail

e2ee="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -n "${AXL_MINGW_BIN:-}" ]; then
  export PATH="$AXL_MINGW_BIN:$PATH"
fi
linker="$(command -v x86_64-w64-mingw32-gcc || command -v x86_64-w64-mingw32-gcc-posix || true)"
if [ -z "$linker" ]; then
  echo "No MinGW-w64 linker found. Install mingw-w64, or set AXL_MINGW_BIN." >&2
  exit 1
fi
if ! command -v cmd.exe >/dev/null || ! command -v wslpath >/dev/null; then
  echo "Run this from WSL with Windows interop enabled." >&2
  exit 1
fi

rustup target add x86_64-pc-windows-gnu >/dev/null
CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER="$linker" \
  cargo build --locked --release -p axl-dpapi-helper --target x86_64-pc-windows-gnu \
  --manifest-path "$e2ee/Cargo.toml"

# cmd.exe refuses a WSL working directory, so ask it from the Windows drive.
local_app_data="$(cd /mnt/c && cmd.exe /d /c 'echo %LOCALAPPDATA%' | tr -d '\r')"
target="$(wslpath -u "$local_app_data")/Axl/bin"
mkdir -p "$target"
cp "$e2ee/target/x86_64-pc-windows-gnu/release/axl-dpapi-helper.exe" "$target/"
echo "Installed $target/axl-dpapi-helper.exe"
