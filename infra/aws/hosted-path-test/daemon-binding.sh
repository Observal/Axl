#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

# Build the hosted Node binding that a production daemon pairs with, pinned to this stack's witness
# trust: `hosted-wsl` in WSL 2, `hosted-linux` on a Linux desktop, `hosted-macos` on a Mac. Only the
# replicas' public keys leave the secret. Run it in the checkout the daemon runs from;
# `axl remote login` finds packages/e2ee/bindings/node/dist/<kind> there.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
case "$(uname -s)" in
  Linux)
    if grep -qi microsoft /proc/sys/kernel/osrelease; then kind=hosted-wsl; else kind=hosted-linux; fi
    ;;
  Darwin)
    kind=hosted-macos
    ;;
  *)
    echo "Hosted bindings build in WSL 2, on macOS, or on a Linux desktop" >&2
    exit 1
    ;;
esac
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

"$root/infra/aws/hosted-path-test/witness-trust.sh" "$scratch/replica-trust.bin" >/dev/null
AXL_E2EE_HOSTED_TRUST_FILE="$scratch/replica-trust.bin" \
  node "$root/packages/e2ee/bindings/node/scripts/build.mjs" "$kind"
echo "Built $root/packages/e2ee/bindings/node/dist/$kind"
