#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

# Build the hosted WSL Node binding that a production daemon pairs with, pinned to this stack's
# witness trust. Only the replicas' public keys leave the secret. Run it in WSL in the checkout the
# daemon runs from; `axl remote login` finds packages/e2ee/bindings/node/dist/hosted-wsl there.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

"$root/infra/aws/hosted-path-test/witness-trust.sh" "$scratch/replica-trust.bin" >/dev/null
AXL_E2EE_HOSTED_TRUST_FILE="$scratch/replica-trust.bin" \
  node "$root/packages/e2ee/bindings/node/scripts/build.mjs" hosted-wsl
echo "Built $root/packages/e2ee/bindings/node/dist/hosted-wsl"
