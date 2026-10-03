<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/e2ee-node`

Private Node-API binding for revision 1 of `axl-e2ee-mls-pq-v1`.

This package is not published and is not wired into the daemon or SDK. ABI version 2 exposes the
atomic witness barrier directly on each endpoint. Every state-changing call returns a
`WitnessOutcome`: either the one exact pending request (`operationId`, byte-identical signed
`request`, `requestHash`, `kind`) that JavaScript must transport unchanged to all three replicas, or
an already released exact typed result. `witnessReadRequest` and `reconcileWitness` obtain the fresh
unanimous head that authorizes exactly one mutation; `pendingWitness` reloads the durable pending
request from storage on every call; `continueWitness` verifies the certificate in Rust, rechecks
successor-key activation, erases and verifies the obsolete key, and only then returns the tagged
`NativeResult`. No ciphertext, plaintext, pairing artifact, or typed state crosses the boundary
before that completes, and JavaScript cannot select counters, commitments, nonces, keys, or
verifiers. Received commit application (`applyReceivedUpdateCommit`) and epoch-ready creation
(`prepareEpochReady`) are separate single-transition operations. Expiry is an explicit witnessed
operation (`expireIfNeeded`, `expireWelcomeIfNeeded`).

Production endpoint constructors still fail closed because production replica trust and hosted
witness transport are not enabled, and `productionStorageReady` stays `false`. The test artifact
adds an in-process deterministic three-replica `TestWitness` and test endpoint constructors; both
are excluded from the production artifact, package, and tarball, along with every test-only Rust
symbol. The build and integrity loader support Windows MSVC x64 and ARM64 artifacts in addition to
the existing macOS and glibc Linux targets. The Windows test artifact can exercise the real DPAPI
envelope-key store under an explicitly selected non-built-in account by setting
`AXL_RUN_WINDOWS_DPAPI_TESTS=1`; ordinary hosted CI accounts continue to use test storage rather
than silently weakening the DPAPI identity policy.

The SDK `WitnessedEndpoint` and the daemon `DaemonWitnessBarrier` drive the barrier in production
code; the hosted integration tests hand them the in-process test quorum as their transport.
`test/witness-driver.mjs` drives the same endpoint API directly for the binding lifecycle tests. It
is test scaffolding, not part of the artifact.

Every accepted JavaScript byte input is length-checked and copied before native asynchronous work
is scheduled. Returned byte arrays are new Node-owned values containing the exact committed Rust
bytes. Callers own those returned arrays and may mutate them without changing native state.

`integrity.json` detects accidental packaging corruption. It is not a signature, provenance
attestation, or independent trust anchor. Its source fields identify the Git base commit, state
whether the `packages/e2ee` tree was dirty at build time, and hash the exact tracked and untracked,
non-ignored files in that tree. A dirty artifact therefore does not claim that its base commit
contains the binding source.

## Deployment-test artifact

`node scripts/build.mjs deployment-test` (with `AXL_E2EE_DEPLOYMENT_TEST_TRUST_FILE`, for example
from `infra/aws/hosted-path-test/witness-trust.sh`) builds `dist/deployment-test` for a daemon that
pairs through the hosted deployment-test stack. It adds exactly one export to the production
binding, `deploymentTestDaemonEndpoint(root, accountId, installationId, cryptoSessionId)`, whose
endpoint verifies certificates against the replica trust pinned at build time. Its loader is the
production loader plus that one appended export.

It is not a production artifact. Its envelope keys rest unwrapped in one owner-only file under
`root/keys`, because the hosts it targets (for example WSL) have no supported platform store.
`check-abi.mjs` verifies that production contains none of it and that the deployment-test binary
carries no test identifiers. Without a trust file the Cargo feature still builds for unit tests and
lint, and every endpoint then fails closed with `rollback_anchor_unavailable`.

## Hosted WSL artifact

`node scripts/build.mjs hosted-wsl` (on Linux, with `AXL_E2EE_HOSTED_TRUST_FILE`) builds
`dist/hosted-wsl` for a production daemon in WSL 2. It adds exactly one export to the production
binding, `hostedWslDaemonEndpoint(root, helper, accountId, installationId, cryptoSessionId)`, whose
envelope keys are sealed by Windows DPAPI for the Windows user through `helper`, the path of that
user's `axl-dpapi-helper.exe`, and whose endpoint verifies certificates against the replica trust
pinned at build time. See `docs/architecture/remote-production-wsl.md`.

## Hosted Linux desktop artifact

`node scripts/build.mjs hosted-linux` (on Linux, with `AXL_E2EE_HOSTED_TRUST_FILE`) builds
`dist/hosted-linux` for a production daemon in an unlocked Linux desktop session. It adds three
exports to the production binding:

- `hostedLinuxDaemonEndpoint(root, implementation, accountId, installationId, cryptoSessionId)`,
  whose envelope keys live in the session's Secret Service as served by `implementation`
  (`gnome-keyring` or `kwallet6`, checked again on every connection), and whose endpoint verifies
  certificates against the replica trust pinned at build time;
- `hostedLinuxSecretService()`, the tested implementation serving this session; and
- `hostedLinuxAccountKey(implementation, create)`, the 32-byte key that seals the remote account
  file, kept as one reserved record in the same store.

See `docs/architecture/remote-production-desktop.md`.

## Hosted macOS artifact

`node scripts/build.mjs hosted-macos` (on macOS, with `AXL_E2EE_HOSTED_TRUST_FILE`) builds
`dist/hosted-macos` for a production daemon on a Mac. It adds exactly one export to the production
binding, `hostedMacosDaemonEndpoint(root, helper, accountId, installationId, cryptoSessionId)`,
whose envelope keys rest in owner-only files under `root` sealed under a key in the data-protection
Keychain through `helper`, the user's signed `axl-keychain-helper`, and whose endpoint verifies
certificates against the replica trust pinned at build time. Until that helper carries Axl's
Developer ID signature and Keychain entitlement, the Keychain refuses it and the endpoint fails
closed with `secure_store_access_denied`. See `docs/architecture/remote-production-desktop.md`.
