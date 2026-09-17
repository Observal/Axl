<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Production E2EE implementation briefs

Status: non-normative implementation aid for draft PR #413

The authoritative requirements are in
[`production-e2ee-storage-and-rollback.md`](production-e2ee-storage-and-rollback.md). These briefs
map those requirements onto the repository as it exists after the shared rollback-witness core. If
a brief conflicts with the RFC, the RFC wins and the conflict must be reported before implementation.

Each phase remains a separate DCO-signed commit. Complete and review one phase before beginning the
next dependency-bearing phase. Production endpoint creation stays fail-closed until the relevant
store, witness, binding, packaging, and runtime-evidence gates pass.

## Phase 2: hosted witness gateway and replica state

### Existing code to reuse

- `packages/e2ee/src/witness.rs` owns the canonical request, receipt, certificate, commitment, and
  decision semantics. Its Rust-produced fixtures are the cross-language contract.
- `packages/e2ee/fixtures/v1/` contains canonical register, read, advance, receipt, and quorum bytes.
- `packages/e2ee/bindings/node/test/witness-fixtures.test.ts` demonstrates independent parsing,
  SHA-384 hashing, and Ed25519 verification with Node built-ins.
- `services/control-plane` already uses injected authentication, authorization, proof-verification,
  clock, and storage interfaces. Production identity and persistence remain unselected.
- `services/control-plane/src/server.ts` already provides bounded request reading and fail-closed
  error handling, but currently assumes JSON request bodies.

### Intended ownership and likely files

- `packages/protocol` owns any public HTTP request and response envelope, stable service error code,
  and trust-boundary validation. It does not construct commitments or own endpoint cryptography.
- `services/control-plane/src/witness.ts` should own gateway orchestration, request admission, and
  exact three-replica result collection.
- `services/control-plane/src/witness-replica.ts` should own replica contracts and the deterministic
  in-memory implementation used by tests.
- `services/control-plane/src/server.ts` may add bounded witness routes without weakening existing
  relay-ticket routes.
- `services/control-plane/src/index.ts` exports only reviewed public service contracts.
- Focused service and protocol tests should consume the Rust fixtures directly.

Names above are recommendations, not a requirement to add speculative abstractions. Keep the
smallest complete vertical slice.

### Required injected boundaries

The production assembly should be expressible through narrow typed interfaces for:

- hosted principal and endpoint admission;
- endpoint credential lookup and binding;
- serializable or linearizable replica compare-and-swap storage;
- append-only immutable high-water journaling;
- typed receipt signing that accepts only a canonical receipt, not arbitrary caller bytes;
- one client for each independently configured replica;
- bounded security-audit emission; and
- a clock used only for receipt metadata and deterministic tests.

Tests may use deterministic in-memory implementations. No production datastore, signing-key
service, immutable journal provider, cloud account, deployment, or recovery credential is approved
in this phase. Production assembly must fail closed while those choices are absent.

### Replica requirements

Each replica must independently:

1. bound and canonically decode the exact request;
2. authenticate the hosted principal and endpoint proof;
3. bind registration to the canonical endpoint credential and immutable lineage;
4. reject later credential replacement;
5. apply the RFC decision table atomically against append-only history;
6. durably append an accepted transition to both authoritative storage and its high-water journal
   before signing;
7. retain exact request and receipt bytes for duplicate and acknowledgement-loss recovery;
8. append revocation and fork events without allowing decrement, deletion, or lineage reuse; and
9. return no vote when either durable write is failed or uncertain.

The in-memory implementation must model the two durability boundaries separately. It must not hide
journal uncertainty behind a successful response.

### Gateway requirements

The gateway has no witness signing key and no authoritative lineage state. It must:

- accept only bounded authenticated requests;
- forward the exact request bytes to three configured replica identities;
- require exactly three valid, distinct, matching signed receipts;
- reject one or two responses, duplicate identities, mixed tuples, malformed receipts, and
  untrusted keys;
- return the canonical quorum certificate without rewriting replica receipts;
- preserve byte-identical duplicate recovery; and
- log only bounded reason codes and lineage hashes, never complete requests, signatures, receipts,
  credentials, or commitments at info level.

### Minimum test matrix

- Canonical Rust fixtures parse and verify independently in TypeScript.
- Malformed, non-canonical, oversized, wrong-profile, wrong-role, wrong-lineage, and bad-signature
  requests fail before storage mutation.
- Concurrent compare-and-swap produces one winner.
- Duplicate registration and advance return byte-identical stored receipts.
- Registration conflicts and operation-ID conflicts are deterministic.
- Immediate and historical forks become terminal.
- Revocation races follow append-ledger order.
- Exact accepted operations recover after later revocation, but no new operation does.
- Replica restart rebuilds the same head from append-only history and compares its journal.
- Primary-write or journal-write uncertainty produces no signature.
- A lagging replica cannot vote until a complete valid predecessor chain is reconciled.
- One or two receipts never form a certificate.
- Mixed replica results and receipt tuples never form a certificate.
- Gateway and replica logs contain no forbidden values.

### Verification

Run root TypeScript build, format, lint, type checks, protocol tests, control-plane tests, boundary and
generated-file checks, npm audit, REUSE, and `git diff --check`. If Rust fixtures or their schema are
touched, rerun the complete Rust, WASM, Node, and browser fixture checks. No hosted deployment is
part of this phase.

## Platform dependency preparation

Dependency candidates are preferred starting points only. Every dependency-bearing commit must
regenerate and obtain approval for the exact lockfile produced from its current base.

### macOS, first platform

Candidate declaration:

```toml
security-framework = { version = "=3.7.0", default-features = false, features = ["OSX_10_15"] }
```

The RFC evaluation found six external package/version pairs: `security-framework`,
`security-framework-sys`, `core-foundation`, `core-foundation-sys`, `libc`, and `bitflags`. Recompute
that graph rather than copying the old result. The implementation belongs in a target-gated module
under `packages/e2ee`, behind the existing `EnvelopeKeyStore` trait.

The review packet must include Keychain accessibility, synchronization, UI suppression, item
identity, duplicate handling, prepared/active reconciliation, deletion verification, application
identity behavior, package notices, and arm64/x64 runtime results.

### Linux desktop, second platform

Candidate declaration:

```toml
secret-service = { git = "https://github.com/Observal/secret-service-rs.git", rev = "1721451b21acfc3450be8799d92947653a5656e3", version = "=5.2.0", default-features = false, features = ["rt-async-io-crypto-rust"] }
zbus = { version = "=5.19.0", default-features = false, features = ["async-io", "blocking-api"] }
```

The released 5.2.0 API executed returned prompts internally. The approved exact-commit fork is based
directly on upstream tag `v5.2.0` and adds only no-prompt item creation and deletion outcomes. The
adapter uses the existing unlocked default collection and never requests collection creation or
unlock. Direct `zbus` use is limited to verifying the session connection, service
owner, UID, PID, and executable; Secret Service framing and encrypted-session cryptography remain in
the fork. Recompute all normal, build, and development packages. Confirm that the implementation
requests only `dh-ietf1024-sha256-aes128-cbc-pkcs7`, rejects `plain`, rejects prompts, pins a tested
user-session bus and service owner, and names each supported Secret Service implementation.
Headless Linux and unknown service implementations remain unsupported.

### Windows, third platform

Candidate declaration:

```toml
windows-sys = { version = "=0.61.2", default-features = false, features = [/* exact APIs only */] }
```

Select features only after listing every API needed for nested DPAPI, memory release, SID and ACL
handling, handle-based path validation, reparse-point rejection, write-through behavior, and
`FlushFileBuffers`. This phase must also replace the current non-Unix no-op directory durability and
permission helpers. The loader and production artifact remain unsupported until both Windows
architectures pass their native matrix.

### Dependency approval packet

For every platform record:

- exact direct declarations and features;
- before-and-after lockfile hashes;
- complete selected normal, build, and development graph;
- crate checksums, licenses, source tags, and commits;
- build scripts, procedural macros, native libraries, services, and downloaded tools;
- audit, deny, dependency-review, REUSE, SBOM, and notice outcomes; and
- compile and runtime evidence for every support claim.

## Platform evidence inventory

### Evidence already represented in CI

- macOS arm64 and native Intel Node 22.19 and Node 24 artifact jobs;
- Linux glibc x64 and arm64 Node 22.19 and Node 24 artifact jobs;
- Chrome, Firefox, and Playwright WebKit browser jobs on Linux;
- actual Safari through Safari WebDriver on macOS;
- Rust core, browser WASM, ABI, package, audit, deny, boundary, generated-file, and REUSE checks.

### Evidence available on the current development host

The current host is macOS 26.2 arm64 with Node 24.13.1 and Rust 1.96.0. This can provide local
Apple-Silicon development evidence. It cannot substitute for native Intel hardware or another
operating system.

### Missing evidence and infrastructure

- Windows x64 and Windows ARM CI and physical runtime hosts;
- Windows NTFS/ReFS, VSS, antivirus, service-account, installer, and reboot tests;
- Linux desktop sessions with named GNOME Keyring and KWallet implementations on both architectures;
- Linux login, logout, lock, prompt, D-Bus owner, and secret-service-upgrade tests;
- automated macOS login, logout, keychain-lock, Time Machine, signing-identity, and restore tests;
- hard reboot and power-loss testing at every durable boundary;
- production artifact signing, notarization, installer, and offline-install evidence; and
- three independently administered witness replica environments and disaster-recovery exercises.

Missing physical evidence does not block merging code that remains fail-closed. It blocks changing
support metadata to `supported`, shipping an enabled artifact for that target, or enabling endpoint
creation. Playwright WebKit is not Safari evidence, Rosetta is not Intel evidence, and emulation does
not replace physical hardware where the RFC requires it.

## Phase 6: production Node binding and packaging

### Current state

- Production create and open functions intentionally fail with secure-store or rollback-anchor
  errors.
- Test constructors and stores are feature-gated into a separate artifact.
- The loader supports macOS arm64/x64 and Linux glibc arm64/x64. Windows and musl fail closed.
- ABI checks compare native exports, ESM exports, TypeScript declarations, discriminants, bigint
  fields, and readonly fields.
- Package checks verify source provenance, artifact hashes, reproducibility, tarball contents, and
  exclusion of known test symbols and paths.

### Required narrow continuation API

Every state-advancing operation must produce either a terminal typed result or a pending-witness
value containing only its operation ID, immutable witness request bytes, request hash, and bounded
status. A continuation accepts only the matching operation ID and bounded quorum-certificate bytes.
It returns the exact committed output only after Rust verifies the certificate, current-key
activation, and obsolete-key erasure.

Open and restart must recover either the byte-identical pending request or the exact committed result
after renewed witness confirmation. JavaScript must not select a counter, commitment, lineage,
request nonce, signing input, state branch, or key-lifecycle result.

### Required package hardening

- Copy and bound all input buffers before asynchronous work.
- Preserve one serialized operation owner per endpoint.
- Add stable witness errors to Rust, native exports, declarations, loader mapping, and ABI tests.
- Keep every returned field immutable and every `u64` represented as `bigint`.
- Scan production binaries, generated glue, staging directories, and tarballs for test stores,
  anchors, signers, fixture keys, snapshots, mutable state, fault controls, and generic signing APIs.
- Keep `productionStorageReady` false until both an approved store and hosted witness continuation
  are present for the selected target.
- Do not add daemon, SDK, relay, or UI integration in this phase.

## Phase 7: production browser persistence and witness path

### Current production boundary

The production browser package currently exports metadata, secure-randomness validation, pairing
inspection, close, and fail-closed endpoint constructors. Its worker does not contain IndexedDB
persistence or endpoint mutations. The production package checks intentionally reject those test
symbols and paths.

### Reusable test evidence

The separate test artifact already exercises IndexedDB stores, strict transactions, Web Locks,
non-extractable AES-KW wrapping, wrapped-DEK lifecycle, operation records, exact output, rollback
simulation, aborts, ambiguous completion, storage loss, and writer contention. Treat this as evidence
and source material for review, not code that may be copied wholesale into production.

### Required production implementation

- Move only reviewed persistence behavior into production-owned worker modules.
- Remove `test_anchor_v1`, deterministic controls, fixture constructors, and fault-selection APIs.
- Generate one origin-bound non-extractable AES-KW wrapping key in the dedicated worker.
- Keep wrapping keys, state-key handles, plaintext snapshots, and transient results in the worker.
- Use WebCrypto AES-256-GCM for separately domain-bound inner and outer envelopes.
- Add a private WASM finalization operation that consumes exact sealed-inner bytes and returns only
  the witness metadata needed by the worker.
- Commit the wrapped state key, both envelopes, operation record, exact result, and exact witness
  request in one short strict IndexedDB transaction across all affected stores.
- Expose only the bounded immutable request and matching-certificate continuation to page code.
- Destroy the transient WASM endpoint and overwrite worker-owned staging buffers after success,
  abort, conflict, lock loss, worker loss, or ambiguous completion.
- Retain one exclusive per-session Web Lock for the endpoint lifetime.
- Keep production pairing disabled until hosted witness transport, artifact isolation, and the full
  browser runtime matrix pass.

### Required evidence and package checks

Exercise Chrome, Edge, Firefox, actual Safari, private browsing, profile migration, profile restore,
storage pressure, browser update, worker suspension, process discard, lock loss, device sleep, and
OS restart. Continue scanning production artifacts for test anchors, test constructors, raw key
exports, snapshots, mutable endpoint state, transaction handles, dynamic code execution, unexpected
URLs, and test paths.
