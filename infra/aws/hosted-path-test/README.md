<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hosted-path deployment test

This stack deploys the Axl control-plane and opaque relay containers to AWS Hyderabad
(`ap-south-2`) for integration testing. It is deliberately fail-closed unless every process receives
`AXL_ENVIRONMENT=deployment-test`.

This is not the production witness topology. It uses one DynamoDB-backed control-plane state table,
one relay task, static test principals, and test-only possession proof. The stack does not enable
E2EE production constructors or change `productionStorageReady`.

The deployment creates a dedicated VPC, two public subnets, an ALB reachable only from the AWS
CloudFront origin-facing prefix list, one CloudFront HTTPS endpoint, two single-task ECS/Fargate
services, immutable ECR repositories, CloudWatch logs, and least-privilege ECS roles. Runtime
secrets are generated outside Terraform and stored in AWS Secrets Manager. Terraform state is
versioned and encrypted in a dedicated private S3 bucket.

The control plane also serves the rollback witness at `/v1/e2ee/witness` with three in-process
replicas. Their Ed25519 signing keys live in the `axl/hosted-path/witness-keys` secret, which
`deploy.sh` generates once. Replica state is process memory: a control-plane restart or redeploy
starts every replica empty, so endpoints registered before it fail closed and must pair again. The
first endpoint to register after a start must make one fresh witness read before a second endpoint
can register; that read moves the replicas from bootstrap to ready. Write the public replica trust
for deployment-test client builds with:

```bash
AWS_PROFILE=axl-deploy infra/aws/hosted-path-test/witness-trust.sh /tmp/axl-replica-trust.bin
```

Deploy from a clean tracked checkout:

```bash
AWS_PROFILE=axl-deploy infra/aws/hosted-path-test/deploy.sh
```

Run the HTTPS and WebSocket opaque-delivery smoke test again:

```bash
AWS_PROFILE=axl-deploy infra/aws/hosted-path-test/smoke-test.sh
```

## Phone remote access

The distribution also serves a deployment-test phone page under `/remote/` from a private S3
bucket, with a strict Content-Security-Policy. The page and the browser binding's worker reach the
control plane, witness, and relay on the same origin. Publish the page from an Axl checkout that
carries it (the browser binding build needs the Rust and wasm-bindgen toolchain):

```bash
AWS_PROFILE=axl-deploy infra/aws/hosted-path-test/remote-page.sh /path/to/axl
```

Give a local daemon the stack's remote configuration. Build the deployment-test Node binding with
this stack's witness trust first (`AXL_E2EE_DEPLOYMENT_TEST_TRUST_FILE`), then:

```bash
AWS_PROFILE=axl-deploy infra/aws/hosted-path-test/remote-config.sh ~/.axl-remote.json   /path/to/axl/packages/e2ee/bindings/node/dist/deployment-test/loader/index.js
```

Start the daemon with `AXL_REMOTE_DEPLOYMENT_TEST=~/.axl-remote.json`, run `/remote` in the
terminal, and open the printed link on the phone. The link carries the stack's shared test
credentials in its fragment, which browsers never send to a server; treat it as a secret. The
witness keeps its state in memory, so a control-plane restart requires pairing again.

Destroy compute and networking resources when testing ends:

```bash
AWS_PROFILE=axl-deploy terraform -chdir=infra/aws/hosted-path-test destroy \
  -var="image_tag=$(git rev-parse --short=12 HEAD)"
```

The ECR repositories, Secrets Manager secret, and Terraform state bucket should be retained until
artifacts and evidence have been reviewed, then removed explicitly if no longer needed.
