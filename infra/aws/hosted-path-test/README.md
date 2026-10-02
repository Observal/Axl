<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hosted-path deployment test

This stack deploys the Axl control-plane and opaque relay containers to AWS Hyderabad
(`ap-south-2`) for integration testing. It is deliberately fail-closed unless every process receives
`AXL_ENVIRONMENT=deployment-test`.

This is not the production witness topology. It uses one DynamoDB-backed control-plane state table,
one relay task, a static test account and installation, and a test-only daemon possession proof.
Phones enroll their own keys through `/v1/devices/*` and sign each relay admission. The stack does not enable
E2EE production constructors or change `productionStorageReady`.

The deployment creates a dedicated VPC, two public subnets, an ALB reachable only from the AWS
CloudFront origin-facing prefix list, one CloudFront HTTPS endpoint, two single-task ECS/Fargate
services, immutable ECR repositories, CloudWatch logs, and least-privilege ECS roles. Runtime
secrets are generated outside Terraform and stored in AWS Secrets Manager. Terraform state is
versioned and encrypted in a dedicated private S3 bucket.

The control plane also serves the rollback witness at `/v1/e2ee/witness` with three in-process
replicas. Their Ed25519 signing keys live in the `axl/hosted-path/witness-keys` secret, which
`deploy.sh` generates once. Replica records live in the `witness` DynamoDB table and each
replica's immutable high-water journal in the separate `witness-journal` table, whose items the
task role can write once but never update or delete. A restarted or redeployed control plane
resumes from them lineage by lineage: the first fresh witness read of a lineage, which endpoints
make before every mutation, has all three replicas check that lineage's head against each other
before it is used again, so paired phones keep working. On an empty table the first endpoint to
register must make one fresh witness read before a second endpoint can register; that read moves
the replicas from bootstrap to ready. Write the public replica trust
for deployment-test client builds with:

```bash
AWS_PROFILE=axl-deploy infra/aws/hosted-path-test/witness-trust.sh /tmp/axl-replica-trust.bin
```

Deploy from a clean tracked checkout:

```bash
AWS_PROFILE=axl-deploy infra/aws/hosted-path-test/deploy.sh
```

The stack answers on `remote.observal.io`. `deploy.sh` passes it as `domain_name`, and Terraform
issues its certificate in us-east-1 (validated in the `observal.io` Route 53 zone), adds the A and
AAAA alias records, and hands clients a relay URL on that host. The bare host redirects to the
phone page, and the CloudFront host name redirects `/remote/` there, keeping the link's fragment.
Set `AXL_TEST_DOMAIN=` (empty) to deploy on the CloudFront host name alone, or another name whose
parent zone is in this account.

Phone sign-in uses a Cognito user pool that federates Google, answered on
`auth.remote.observal.io` (cognito.tf). `deploy.sh` passes the Google OAuth client ID
(`AXL_TEST_GOOGLE_CLIENT_ID`, empty turns sign-in off), and Terraform reads the client secret from
the SSM SecureString `/axl-hosted-test/google-oauth-client-secret`, so it also lands in the
encrypted Terraform state. Register `https://auth.remote.observal.io/oauth2/idpresponse` as an
authorized redirect URI of the Google client. Any Google account may sign in. The control plane
gives the pool's access tokens the phone scope: pairing, enrolling a device, device relay tickets,
and the witness, never the daemon's routes (claim reservation, Welcome and link publication,
device invitation and revocation, daemon relay tickets). `remote-page.sh` publishes `sign-in.json`
beside the page and `remote-config.sh` sets `phoneSignIn`, so pairing links leave out the account
token.

## Production mode

`deploy.sh` runs the stack in production mode (`control_plane_mode`);
`AXL_CONTROL_PLANE_MODE=deployment-test deploy.sh` switches it back to the static test account. The control plane then runs
`production-runtime.js`, which holds no account credential and ignores the static test account,
token, and possession proof:

- People sign in through the user pool: the daemon with `axl remote login` (the `daemon` app
  client, returning to `http://localhost:47813/callback`), the phone on its page. The account is
  the pool's `sub`.
- Remote access is opt-in. Only members of the pool's `remote` group are accepted; anyone else who
  signs in is refused. After a person's first sign-in, add them with
  `aws cognito-idp admin-add-user-to-group --user-pool-id "$(terraform output -raw user_pool_id)" --username <user> --group-name remote`.
- Each daemon installation registers its own P-256 key at `/v1/installations/register`, and a
  daemon relay ticket is admitted only with a signature by that key. Relay tickets of either role
  are issued only for an installation registered to the caller's account.
- The relay reads its service settings without the `AXL_TEST_` prefix. They stay service
  credentials between the relay and the control plane; no client holds them.

`remote-page.sh` also publishes `daemon-sign-in.json`, where `axl remote login` learns the
authority and its client ID.

A daemon in WSL is set up for production remote access with, in its checkout:

1. `packages/e2ee/helpers/dpapi/install-wsl.sh` builds `axl-dpapi-helper.exe` and installs it in
   the Windows user's `%LOCALAPPDATA%\Axl\bin`. Windows DPAPI seals the daemon's keys and
   account through it.
2. `infra/aws/hosted-path-test/daemon-binding.sh` builds the hosted WSL Node binding pinned to
   this stack's witness trust.
3. `axl remote login` signs in with Google in the Windows browser, creates the installation and
   its key, and registers it. Until the account is in the `remote` group it reports the account
   ID to add.
4. `axl daemon restart`, then `/remote` in the terminal. Sign in on the phone with the same Google
   account.

`axl remote logout` revokes the refresh token and forgets the account. The witness keeps its three in-process replicas, which are not
independently administered; see `docs/architecture/remote-production-wsl.md`.

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
AWS_PROFILE=axl-deploy infra/aws/hosted-path-test/remote-config.sh ~/.axl-remote.json \n  /path/to/axl/packages/e2ee/bindings/node/dist/deployment-test/loader/index.js
```

Start the daemon with `AXL_REMOTE_DEPLOYMENT_TEST=~/.axl-remote.json`, run `/remote` in the
terminal, and scan the QR code with the phone camera (or open the printed link on the phone). The
code needs a terminal at least 93 columns wide. The link carries the stack's test account token
and a one-time device enrollment secret in its fragment, which browsers never send to a server;
treat it as a secret. A pairing survives control-plane restarts and redeploys.

A paired phone can list, open, and follow sessions, send and queue prompts, and stop a running
turn. A daemon started with `--unsafe` lets the phone watch sessions but not change them.

Destroy compute and networking resources when testing ends:

```bash
AWS_PROFILE=axl-deploy terraform -chdir=infra/aws/hosted-path-test destroy \
  -var="image_tag=$(git rev-parse --short=12 HEAD)"
```

The ECR repositories, Secrets Manager secret, and Terraform state bucket should be retained until
artifacts and evidence have been reviewed, then removed explicitly if no longer needed.
