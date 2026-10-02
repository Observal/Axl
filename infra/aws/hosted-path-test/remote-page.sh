#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

# Build and publish the deployment-test phone page: the web remote entry and the deployment-test
# browser binding, pinned to this stack's witness trust, uploaded under /remote/ of the private
# page bucket. Pass the Axl checkout that carries the phone page (defaults to this one); it needs
# the Rust and wasm-bindgen toolchain the browser binding build uses.

set -euo pipefail

profile="${AWS_PROFILE:-axl-deploy}"
region="ap-south-2"
root="$(git rev-parse --show-toplevel)"
stack="$root/infra/aws/hosted-path-test"
source_root="$(cd "${1:-$root}" && pwd)"

export AWS_PROFILE="$profile"
export AWS_REGION="$region"
account="$(aws sts get-caller-identity --query Account --output text)"
terraform -chdir="$stack" init -reconfigure \
  -backend-config="bucket=axl-terraform-state-${account}-${region}" \
  -backend-config="key=hosted-path/deployment-test.tfstate" \
  -backend-config="region=$region" \
  -backend-config="dynamodb_table=axl-terraform-locks-${region}" >/dev/null
bucket="$(terraform -chdir="$stack" output -raw remote_page_bucket)"
page_url="$(terraform -chdir="$stack" output -raw remote_page_url)"
sign_in="$(terraform -chdir="$stack" output -raw phone_sign_in)"
daemon_sign_in="$(terraform -chdir="$stack" output -raw daemon_sign_in)"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
"$stack/witness-trust.sh" "$scratch/replica-trust.bin" >/dev/null

browser="$source_root/packages/e2ee/bindings/browser"
AXL_E2EE_DEPLOYMENT_TEST_TRUST_FILE="$scratch/replica-trust.bin" \
  node "$browser/scripts/build.mjs" deployment-test
pnpm --dir "$source_root" --filter @axl/web build:remote

stage="$scratch/remote"
mkdir -p "$stage/e2ee"
cp "$source_root/packages/web/dist/remote/remote.html" "$stage/index.html"
cp -R "$source_root/packages/web/dist/remote/assets" "$stage/assets"
cp -R "$browser/dist/deployment-test/." "$stage/e2ee/"
# The page signs in only when this file says where; without it the link's token is used.
if [ -n "$sign_in" ]; then
  printf '%s\n' "$sign_in" >"$stage/sign-in.json"
fi
# `axl remote login` reads where the daemon signs in from here.
if [ -n "$daemon_sign_in" ]; then
  printf '%s\n' "$daemon_sign_in" >"$stage/daemon-sign-in.json"
fi

content_type() {
  case "$1" in
    *.html) echo "text/html; charset=utf-8" ;;
    *.js) echo "text/javascript; charset=utf-8" ;;
    *.css) echo "text/css; charset=utf-8" ;;
    *.json) echo "application/json; charset=utf-8" ;;
    *.wasm) echo "application/wasm" ;;
    *) echo "application/octet-stream" ;;
  esac
}

# Vite names every file under assets/ by its content hash, so a browser keeps those for good. The
# rest keep their names across builds and are revalidated on every load, which costs a 304 when
# they have not changed.
cache_control() {
  case "$1" in
    assets/*) echo "public, max-age=31536000, immutable" ;;
    *) echo "no-cache" ;;
  esac
}

aws s3 rm "s3://$bucket/remote/" --recursive >/dev/null
(cd "$stage" && find . -type f | sed 's|^\./||') | while read -r path; do
  aws s3 cp "$stage/$path" "s3://$bucket/remote/$path" \
    --content-type "$(content_type "$path")" \
    --cache-control "$(cache_control "$path")" >/dev/null
done
echo "Published the phone page at $page_url"
