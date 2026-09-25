#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

# Write the daemon's remote deployment-test configuration (owner-only) for
# AXL_REMOTE_DEPLOYMENT_TEST. It holds the stack's shared test credentials; keep it out of
# repositories. The binding path names the deployment-test Node loader built with this stack's
# witness trust (packages/e2ee/bindings/node/dist/deployment-test/loader/index.js).

set -euo pipefail

output="${1:?usage: remote-config.sh <output-file> <deployment-test-node-loader>}"
binding="$(realpath "${2:?usage: remote-config.sh <output-file> <deployment-test-node-loader>}")"
profile="${AWS_PROFILE:-axl-deploy}"
region="ap-south-2"
root="$(git rev-parse --show-toplevel)"
stack="$root/infra/aws/hosted-path-test"

export AWS_PROFILE="$profile"
export AWS_REGION="$region"
account="$(aws sts get-caller-identity --query Account --output text)"
terraform -chdir="$stack" init -reconfigure \
  -backend-config="bucket=axl-terraform-state-${account}-${region}" \
  -backend-config="key=hosted-path/deployment-test.tfstate" \
  -backend-config="region=$region" \
  -backend-config="dynamodb_table=axl-terraform-locks-${region}" >/dev/null
origin="$(terraform -chdir="$stack" output -raw control_plane_url)"

umask 077
aws secretsmanager get-secret-value \
  --secret-id axl/hosted-path/deployment-test \
  --query SecretString --output text |
  AXL_ORIGIN="$origin" AXL_BINDING="$binding" AXL_OUTPUT="$output" python3 -c '
import json, os, sys
secret = json.load(sys.stdin)
config = {
    "version": 1,
    "origin": os.environ["AXL_ORIGIN"],
    "pagePath": "/remote/",
    "accountId": secret["accountId"],
    "installationId": secret["installationId"],
    "deviceId": secret["deviceId"],
    "accessToken": secret["publicToken"],
    "possessionProof": secret["possessionProof"],
    "binding": os.environ["AXL_BINDING"],
}
with open(os.environ["AXL_OUTPUT"], "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
'
echo "Wrote the remote deployment-test configuration to $output"
