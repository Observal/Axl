#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

# Write the public replica trust configuration of the deployment-test witness to the given file,
# for AXL_E2EE_DEPLOYMENT_TEST_TRUST_FILE. Only public keys leave the secret.

set -euo pipefail

output="${1:?usage: witness-trust.sh <output-file>}"
profile="${AWS_PROFILE:-axl-deploy}"
region="ap-south-2"
root="$(git rev-parse --show-toplevel)"

pnpm --dir "$root" --filter @axl/aws-control-plane... build >/dev/null
aws secretsmanager get-secret-value \
  --profile "$profile" --region "$region" \
  --secret-id axl/hosted-path/witness-keys \
  --query SecretString --output text |
  AXL_TRUST_OUTPUT="$output" node --input-type=module -e "
    import { readFileSync, writeFileSync } from 'node:fs';
    const witness = await import('$root/services/aws-control-plane/dist/witness-deployment-test.js');
    const keys = witness.parseDeploymentTestWitnessKeys(readFileSync(0, 'utf8'));
    const config = witness.encodeReplicaTrustConfig(witness.deploymentTestWitnessTrust(keys));
    writeFileSync(process.env.AXL_TRUST_OUTPUT, config);
  "
echo "Wrote deployment-test replica trust to $output"
