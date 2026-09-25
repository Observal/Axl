#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

profile="${AWS_PROFILE:-axl-deploy}"
region="ap-south-2"
root="$(git rev-parse --show-toplevel)"
stack="$root/infra/aws/hosted-path-test"
secret_name="axl/hosted-path/deployment-test"

if ! git -C "$root" diff-index --quiet HEAD --; then
  echo "Refusing to deploy with tracked changes that are not committed." >&2
  exit 1
fi

account="$(aws sts get-caller-identity --profile "$profile" --query Account --output text)"
state_bucket="axl-terraform-state-${account}-${region}"
lock_table="axl-terraform-locks-${region}"

if ! aws s3api head-bucket --profile "$profile" --bucket "$state_bucket" >/dev/null 2>&1; then
  aws s3api create-bucket \
    --profile "$profile" \
    --region "$region" \
    --bucket "$state_bucket" \
    --create-bucket-configuration "LocationConstraint=$region" >/dev/null
  aws s3api put-public-access-block \
    --profile "$profile" \
    --bucket "$state_bucket" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption \
    --profile "$profile" \
    --bucket "$state_bucket" \
    --server-side-encryption-configuration \
      '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
  aws s3api put-bucket-versioning \
    --profile "$profile" \
    --bucket "$state_bucket" \
    --versioning-configuration Status=Enabled
fi

if ! aws dynamodb describe-table \
  --profile "$profile" --region "$region" --table-name "$lock_table" >/dev/null 2>&1; then
  aws dynamodb create-table \
    --profile "$profile" \
    --region "$region" \
    --table-name "$lock_table" \
    --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH >/dev/null
  aws dynamodb wait table-exists \
    --profile "$profile" --region "$region" --table-name "$lock_table"
fi

if ! aws secretsmanager describe-secret \
  --profile "$profile" --region "$region" --secret-id "$secret_name" >/dev/null 2>&1; then
  python3 - <<'PY' | aws secretsmanager create-secret \
    --profile "$profile" \
    --region "$region" \
    --name "$secret_name" \
    --description "Axl hosted-path deployment-test credentials" \
    --secret-string file:///dev/stdin >/dev/null
import base64
import json
import secrets
import time
import uuid


def uuid7() -> str:
    # E2EE pairing accepts only UUIDv7 installation, session, and device identities.
    value = bytearray((time.time_ns() // 1_000_000).to_bytes(6, "big") + secrets.token_bytes(10))
    value[6] = 0x70 | (value[6] & 0x0F)
    value[8] = 0x80 | (value[8] & 0x3F)
    return str(uuid.UUID(bytes=bytes(value)))


print(json.dumps({
    "accountId": str(uuid.uuid4()),
    "installationId": uuid7(),
    "deviceId": uuid7(),
    "relayInstanceId": str(uuid.uuid4()),
    "publicToken": secrets.token_urlsafe(48),
    "relayToken": secrets.token_urlsafe(48),
    "controlToken": secrets.token_urlsafe(48),
    "possessionProof": base64.b64encode(secrets.token_bytes(48)).decode("ascii"),
}))
PY
fi

witness_secret_name="axl/hosted-path/witness-keys"
if ! aws secretsmanager describe-secret   --profile "$profile" --region "$region" --secret-id "$witness_secret_name" >/dev/null 2>&1; then
  node --input-type=module <<'NODE' | aws secretsmanager create-secret     --profile "$profile"     --region "$region"     --name "$witness_secret_name"     --description "Axl hosted-path deployment-test witness signing keys"     --secret-string file:///dev/stdin >/dev/null
import { generateKeyPairSync, randomBytes } from "node:crypto";

const replicas = [0, 1, 2].map(() => ({
  replicaId: randomBytes(16).toString("hex"),
  keyId: randomBytes(16).toString("hex"),
  privateKey: generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64"),
}));
process.stdout.write(JSON.stringify({ replicas }));
NODE
fi

export AWS_PROFILE="$profile"
export AWS_REGION="$region"
image_tag="$(git -C "$root" rev-parse --short=12 HEAD)"

terraform -chdir="$stack" init -reconfigure \
  -backend-config="bucket=$state_bucket" \
  -backend-config="key=hosted-path/deployment-test.tfstate" \
  -backend-config="region=$region" \
  -backend-config="dynamodb_table=$lock_table"
terraform -chdir="$stack" apply -auto-approve \
  -target=aws_ecr_repository.control_plane \
  -target=aws_ecr_repository.relay \
  -var="image_tag=$image_tag"

registry="${account}.dkr.ecr.${region}.amazonaws.com"
aws ecr get-login-password --profile "$profile" --region "$region" |
  docker login --username AWS --password-stdin "$registry" >/dev/null
trap 'docker logout "$registry" >/dev/null 2>&1 || true' EXIT

control_image="${registry}/axl-hosted-test-control-plane:${image_tag}"
relay_image="${registry}/axl-hosted-test-relay:${image_tag}"
docker build --platform linux/amd64 -f "$root/services/aws-control-plane/Dockerfile" -t "$control_image" "$root"
docker build --platform linux/amd64 -f "$root/services/relay/Dockerfile" -t "$relay_image" "$root"
docker push "$control_image"
docker push "$relay_image"

terraform -chdir="$stack" apply -auto-approve -var="image_tag=$image_tag"
cluster="$(terraform -chdir="$stack" output -raw cluster_name)"
aws ecs wait services-stable \
  --profile "$profile" \
  --region "$region" \
  --cluster "$cluster" \
  --services control-plane relay

"$stack/smoke-test.sh"
