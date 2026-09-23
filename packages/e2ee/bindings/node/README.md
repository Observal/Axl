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

The SDK and daemon adapters do not yet drive the barrier themselves. Until that integration lands,
`test/witness-driver.mjs` runs the complete barrier against the test witness and adapts released
results to the shape those adapters still expect. It is test scaffolding, not part of the artifact.

Every accepted JavaScript byte input is length-checked and copied before native asynchronous work
is scheduled. Returned byte arrays are new Node-owned values containing the exact committed Rust
bytes. Callers own those returned arrays and may mutate them without changing native state.

`integrity.json` detects accidental packaging corruption. It is not a signature, provenance
attestation, or independent trust anchor. Its source fields identify the Git base commit, state
whether the `packages/e2ee` tree was dirty at build time, and hash the exact tracked and untracked,
non-ignored files in that tree. A dirty artifact therefore does not claim that its base commit
contains the binding source.
