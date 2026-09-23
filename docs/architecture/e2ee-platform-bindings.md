<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Endpoint E2EE platform bindings

Status: proposed Session 50 architecture; pending RC review

Drafted: 2026-09-16

## Scope

Session 50 carries the Axl-private `axl-e2ee-mls-pq-v1` endpoint profile to Node and real browsers. It defines narrow, versioned Node and browser endpoint APIs over the same Rust implementation and canonical fixtures.

Swift, Kotlin, C ABI, JNI, generated SDKs, iOS and Android applications, mobile secure storage, and final mobile stack decisions remain in Phase 13. No Session 50 package connects to the relay, grants daemon authority, or enables remote access.

Browser pairing remains disabled until a separate approved design supplies either an independent monotonic rollback anchor or an authenticated peer-witness protocol with an explicit threat model and recovery contract.

## Session 50 sequence

Session 50 is split into focused RC-targeted changes. Each branch starts from the latest merged `origin/RC`, stops for review, and must merge before the next branch starts:

1. planning reconciliation and dependency evaluation;
2. canonical pairing transcript and failure-state tests;
3. safe endpoint facade plus KeyPackage, Welcome, activation, replacement, removal, reset, and typed lifecycle outcomes;
4. private Node binding and package smoke tests;
5. browser/WASM execution, secure-randomness checks, CSP-compatible artifacts, and real-browser cryptographic fixtures;
6. IndexedDB transaction, Web Locks ownership, close/reopen, abort, quota, storage-loss, and exact-byte retry evidence.

The sequence stops with browser pairing and remote web disabled if the rollback-anchor gate remains unresolved. It does not continue into daemon, SDK, relay, control-plane, account, authorization, attachment, S3, UI, hosted deployment, or Session 60 work.

## Ownership and package boundaries

All profile behavior remains in `packages/e2ee`:

```text
packages/e2ee/
  src/                 Rust profile, pairing, lifecycle, and safe endpoint facade
  bindings/node/       private Node-API addon and package loader
  bindings/browser/    private WASM module, worker, and IndexedDB adapter
  fixtures/v1/         canonical binary fixtures and manifest
```

The bindings may expose only typed endpoint operations. They must not expose mutable `MlsGroup` values, provider storage, signing keys, state data-encryption keys, cryptographic primitives, or transaction handles. Opaque endpoint references may select one owned endpoint, but callers cannot inspect or mutate the underlying group and cannot bypass operation serialization.

This endpoint ABI is distinct from the daemon client protocol in `packages/protocol` and the client behavior in `packages/sdk`. Session 50 does not add a C ABI, JNI, Swift or Kotlin code, generated SDK, or mobile application. It also does not wire the Node binding into `packages/daemon` or `packages/sdk`.

Successful endpoint authentication identifies a paired endpoint. It never grants a daemon capability or authorizes an operation.

## Versioned platform ABI

ABI version 1 uses fixed-width identifiers, bounded byte strings, tagged requests, and tagged outcomes. Every boundary validates the ABI version, profile ID, profile revision, lengths, enum values, identifiers, and operation state before invoking OpenMLS.

The safe operation set is limited to:

- pairing invitation and claim creation and validation;
- KeyPackage creation and validation;
- daemon reservation input and result validation;
- Welcome creation, exact-byte recovery, and device join;
- pair activation acknowledgement;
- application send and receive;
- device self-Update proposal creation;
- daemon proposal acceptance and commit creation;
- device commit application and epoch-ready creation;
- outbox and receive acknowledgement;
- replacement, revocation, member removal, reset, and status;
- explicit close and reload.

The ABI returns immutable byte results. Native byte outputs have one documented owner and one matching release operation. Inputs are borrowed only for the duration of a synchronous call or copied before asynchronous work begins. No caller-owned mutable buffer remains aliased by Rust.

Stable outcomes include:

```text
committed
duplicate_recovered
replay_rejected
stale_epoch
future_epoch_bufferable
future_epoch_too_far
missing_commit
fork_detected
rollback_detected
clock_rollback
state_loss
secure_store_unavailable
rollback_anchor_unavailable
storage_unavailable
lifecycle_busy
retention_exceeded
re_pair_required
profile_mismatch
identity_mismatch
corrupt_state
bound_exceeded
```

A duplicate with the same operation fingerprint returns the committed typed result and exact stored ciphertext. The same operation identifier with different input returns a conflict. Rollback, fork, corruption, profile mismatch, identity mismatch, or unexplained state loss quarantines the pair and never triggers an automatic reset.

## Exact bounds

Every binding rejects oversized input before copying into an owned buffer, growing WASM memory, decoding TLS, or invoking OpenMLS.

| Value | Maximum bytes |
| --- | ---: |
| Complete relay payload or MLS envelope | 65,497 |
| Application plaintext | 60,000 |
| KeyPackage | 16,384 |
| Welcome | 16,384 |
| Update proposal | 16,384 |
| Commit | 16,384 |
| Pairing invitation | 2,048 |
| Pairing claim | 17,320 |
| Epoch-ready, pair-activation, or resync plaintext | 2,048 |
| Axl credential | 512 |
| AAD | 512 |

The PairingClaimV1 maximum is `2 + (1 + 255) + 2 + 48 + 48 + (2 + 512) + (2 + 16,384) + 64 = 17,320` bytes. PR 50.1 must derive or assert this bound in tests against the canonical encoder so the documented limit and implementation cannot diverge.

The binding framing must fit inside the 65,497-byte relay payload rather than treating that value as additional capacity. Node checks `Buffer.byteLength` before making its owned copy. Browser JavaScript checks `Uint8Array.byteLength` before copying into WASM, and Rust checks the length again.

## Pairing transcript

The invitation remains the canonical TLS structure in `remote-e2ee-openmls.md`. The complete encoded invitation, including its signature, is the value hashed by the claim and comparison transcript.

Revision 1 fixes the previously implicit claim encoding as:

```text
struct {
  uint16 version = 1;
  opaque profile_id<1..255>;
  uint16 profile_revision = 1;
  opaque account_id[16];
  opaque installation_id[16];
  opaque crypto_session_id[16];
  opaque invitation_nonce_hash[48];
  opaque device_credential<1..512>;
  opaque key_package<1..16384>;
  opaque device_signature<64>;
} PairingClaimV1;
```

This completes a previously unspecified, unimplemented revision 1 transcript. No deployed encoding, checked-in claim fixture, or persisted pairing state is being changed. After PR 50.1 commits canonical fixtures, an incompatible transcript change requires a new authenticated profile revision.

`device_signature` is excluded from the signed prefix and is calculated exactly as:

```text
Ed25519.Sign(
  device_private_key,
  "Axl pairing claim v1" ||
  SHA-384(complete PairingInvitation TLS bytes) ||
  SHA-384(KeyPackage TLS bytes) ||
  SHA-384(device credential TLS bytes)
)
```

The comparison value is the first 39 bits of:

```text
SHA-384(
  "Axl pairing compare v1" ||
  complete PairingInvitation TLS bytes ||
  complete PairingClaimV1 TLS bytes
)
```

It is interpreted as an unsigned big-endian integer and rendered as exactly 12 decimal digits with leading zeroes, grouped as `ddd ddd ddd ddd`.

The daemon creates a cryptographically random 32-byte invitation nonce. The invitation expires ten minutes after issuance and is consumed once. Oversized, non-canonical, wrong-version, wrong-profile, wrong-session, unknown, expired, consumed, and cancelled requests do not increment failed-claim state. Only a canonically decoded claim matching the invitation identifiers and nonce hash is eligible to count. The daemon hashes the complete canonical claim bytes, records that hash with the terminal typed result, and returns the same result without another increment when the same failed claim is repeated after an ambiguous response. Five distinct eligible failed claims commit cancellation. These updates are atomic and do not echo rejected secret material.

Repeating the accepted claim returns the exact stored Welcome. A different claim after confirmation or consumption fails closed without changing the accepted result. The nonce may appear only in the QR payload and the daemon's encrypted pending-invitation state. It must not enter URLs, hosted storage, logs, analytics, metrics, canonical events, crash reports, or fixture diagnostics.

## Pre-pair durable-state ownership

Pairing uses two different durable owners before the MLS group exists.

### Daemon pending invitation

The daemon endpoint owns an encrypted pending-invitation record keyed by `crypto_session_id`. It contains the account and installation binding, profile ID and revision, issue and expiry times, invitation hash, nonce, a bounded set of at most five distinct eligible failed-claim hashes and terminal results, state, and accepted claim hash and exact result when present. It lives in the same per-session transactional store that will own the daemon group, not in a second application database. The invitation record commits before QR bytes are returned. It is not canonical session state and is not stored by the relay or hosted rendezvous service.

Its state transitions are:

```text
issued -- eligible claim begins --> claim_pending
claim_pending -- first through fourth distinct eligible failure --> issued
issued or claim_pending -- fifth distinct eligible failure --> cancelled
issued or claim_pending -- explicit user cancellation --> cancelled
claim_pending -- user confirmation and reservation intent --> confirmed
confirmed -- atomic group state and exact Welcome commit --> consumed
issued, claim_pending, or confirmed -- lifetime expires --> expired
```

Explicit user cancellation after `confirmed` is not a revision 1 transition. The confirmed operation must recover to `consumed` or expire. A conflicting claim after `confirmed` or `consumed` is a rejected operation, not a lifecycle transition, and cannot change the accepted record. Group creation, the complete successor provider image, exact Welcome bytes, and the transition to `consumed` commit atomically in the same store. Repeating the accepted claim recovers that operation and returns the exact Welcome.

### Device pre-join state

The device endpoint owns the per-pair Ed25519 signer, KeyPackage private material, exact KeyPackage bytes, invitation hash, claim bytes, profile binding, expiry, and operation records before it uploads the claim. They live in the device's per-session transactional store and must commit before claim publication. The store is bound to the invitation's `crypto_session_id` but has no relay route and no MLS group ID before Welcome validation.

A failed or ambiguous claim upload retries the exact claim and KeyPackage bytes. Expiry, cancellation, loss of protected state, or an ambiguous Welcome without a durable exact copy requires a new invitation, device ID, crypto session ID, KeyPackage, and later group ID.

### Hosted handoff

Session 50 defines typed reservation and publication values only. The later control-plane implementation owns atomic reservation, opaque artifact storage, and expiry. It never owns the nonce, device private key, KeyPackage private material, Welcome plaintext, or MLS group state.

## KeyPackage and Welcome lifecycle

The endpoint API supports:

1. device creation and durable one-invitation KeyPackage creation;
2. complete credential, profile, suite, capability, lifetime, transcript, and size validation;
3. a reservation request and typed reserved, busy, expired, consumed, rejected, or unavailable result;
4. daemon group creation with a fresh random group ID after user confirmation;
5. atomic daemon state advancement and exact Welcome persistence before publication;
6. byte-identical Welcome retry until activation acknowledgement or expiry;
7. device validation of the transcript, group ID, daemon identity, own leaf, suite, profile, and exactly two members before durable join;
8. an MLS-protected activation acknowledgement committed before transmission;
9. replacement and revocation without reusing a KeyPackage or Welcome;
10. daemon-only removal commits and device self-Update proposals;
11. explicit local reset and re-pairing with fresh device, crypto-session, and group identifiers.

KeyPackage reservation is 60 seconds. Invitation, KeyPackage, and Welcome lifetime is ten minutes. No lifecycle operation grants a daemon scope.

## Native transaction rule and asynchronous browser rule

The native rule remains unchanged: the durable read-write transaction starts before a state-advancing OpenMLS call and supplies transaction-local provider storage.

IndexedDB transactions cannot safely span arbitrary asynchronous work. They become inactive when control returns to the event loop without another queued request. Browser storage therefore uses an equivalent serialized prepare-and-compare protocol rather than pretending to implement the synchronous native trait:

1. Acquire and retain the exclusive per-session Web Lock.
2. In a short read transaction, load the complete committed snapshot and operation record.
3. Authenticate the snapshot and verify its generation and rollback evidence. A production browser stops with `rollback_anchor_unavailable` here; persistence tests may inject an explicitly test-only anchor.
4. Instantiate a private WASM endpoint from that snapshot.
5. Perform one OpenMLS transition entirely inside the worker and create an internal pending mutation containing the complete successor state, exact ciphertext or accepted-message identity, operation fingerprint, and expected generation.
6. Open one short IndexedDB `readwrite` transaction over every affected object store with `durability: "strict"`.
7. Recheck the stored session, profile, generation, rollback counter, and operation fingerprint inside that transaction.
8. Write the successor state, metadata, operation result, outbox or accepted-message record, and manifest in that same transaction.
9. Wait for the transaction's `complete` event.
10. Only after completion may the binding return ciphertext for transport or plaintext for authorization or presentation.

The internal pending mutation never crosses the public platform ABI and cannot be transmitted. A generation conflict, abort, callback exception, worker loss, or ambiguous transaction completion destroys the transient WASM endpoint. Recovery opens a new database connection, reloads only committed state, authenticates it, and checks the operation record. A committed operation returns its exact stored result; an absent operation starts again from the old committed state. No state produced before the failed transaction is reused.

This preserves the atomic advanced-state plus exact-ciphertext guarantee while acknowledging that the browser cannot hold an IndexedDB transaction open across the OpenMLS computation.

## Browser database

The version 1 IndexedDB state database uses one key space bound to the origin and stores records under `crypto_session_id`. Its stores mirror the native logical schema:

- metadata and lifecycle;
- sealed current state and authenticated manifest;
- operations and input fingerprints;
- exact outbox ciphertext;
- accepted-message identities and sealed pending plaintext.

A separate key database holds the non-extractable WebCrypto wrapping key and prepared, active, or obsolete wrapped-DEK records for feasibility testing. It is not an independent rollback domain. Key preparation happens before the state transaction, activation happens after its completion, and restart reconciliation activates only the key referenced by authenticated committed state and removes only unreferenced inactive records. Obsolete active keys are removed only after anchor reconciliation.

A single `readwrite` transaction covers all state, operation, outbox, and accepted-message stores affected by an operation. No unrelated promise, WebCrypto request, network request, timer, or UI callback occurs inside it.

Schema upgrades run only in `versionchange`. Existing connections close on `versionchange`; a blocked upgrade reports `storage_unavailable`. A failed upgrade aborts and retains the old version. Unknown newer versions fail closed. The implementation never deletes and recreates a database as migration recovery.

`QuotaExceededError`, forced close, unavailable storage, failed persistence request, or transaction abort returns a typed storage outcome and releases no ciphertext or plaintext. Missing or evicted committed state returns `state_loss` followed by `re_pair_required`. Private browsing is not guessed from browser heuristics. Pairing remains unavailable whenever required durability cannot be demonstrated.

## Browser single-writer ownership

Each endpoint runs in a dedicated worker and requests an exclusive Web Lock named:

```text
axl-e2ee-v1:<lowercase crypto_session_id hex>
```

The request uses `ifAvailable: true`, never `steal`, and holds the lock by keeping its callback promise pending for the endpoint lifetime.

A second tab receives `lifecycle_busy` and cannot create or load a second writer. While the worker context and lock callback remain alive, the browser-owned lock prevents another cooperative same-origin endpoint from becoming the writer. Worker or page termination releases the lock. Suspension, freezing, restoration, and termination behavior must be verified separately in every supported browser. Every successor must acquire the lock, reload committed state, and authenticate it before use. If the lock callback resolves or rejects unexpectedly while the worker remains alive, the binding marks the endpoint unusable and terminates the worker.

## Browser key protection and rollback

A non-extractable WebCrypto key stored through IndexedDB can prevent API-level export. It does not prove hardware backing, prevent an origin from invoking the key, survive storage loss, provide forensic erasure, or detect rollback of the browser profile. IndexedDB atomicity and persistent-storage permission do not create an independent monotonic anchor. WebAuthn signature counters are optional and are not a portable application-controlled monotonic store.

The browser adapter may use a non-extractable AES wrapping key for at-rest feasibility tests, but it must report its properties accurately. It must not claim that this satisfies the native `EnvelopeKeyStore` and `RollbackAnchor` threat model.

No supported pure-browser configuration currently satisfies the required independent rollback anchor. Production browser pairing therefore returns `rollback_anchor_unavailable`. Enabling it requires a separate RFC decision for either:

- a trusted native or hardware-backed companion that supplies the existing anchor contract; or
- an authenticated peer-witness protocol revision that defines online requirements, fork handling, witness rollback, recovery, privacy, and availability.

The latter would change the current storage contract and requires separate security review. Session 50 does not implement it.

## Node binding

The Node binding uses Node-API through napi-rs. Node-API is preferred over a generic C ABI because a C ABI would still need a Node addon shim and would add a second unsafe ownership boundary.

The private artifact is `@axl/e2ee-node`. It contains an ESM loader, TypeScript declarations, one platform `.node` binary, license notices, and a manifest with ABI, profile, source, and artifact hashes. Initial build and fixture targets are Node 22.19 and Node 24 on `darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, and `linux-arm64-gnu`. An artifact target means build and fixture support, not production storage readiness. Windows and musl fail with `unsupported_platform` until their storage behavior is reviewed.

Operations that touch storage or OpenMLS run as Node-API asynchronous work. Incoming buffers are copied before leaving the JavaScript call because JavaScript may retain and mutate their backing stores. Returned buffers own their allocations. Stable Axl codes and bounded safe details are attached to one `AxlE2eeError`; raw Rust, redb, or OpenMLS errors do not cross the boundary.

The Node-API surface never accepts raw wrapping keys, DEKs, rollback counters, witness counters, commitments, nonces, certificate verifiers, or JavaScript key-management callbacks. Every state-changing call returns either the exact pending witness request or a released exact typed result, and only endpoint-owned `witnessReadRequest`, `reconcileWitness`, `pendingWitness`, and `continueWitness` move the barrier. Tests may inject a clearly test-only `EnvelopeKeyStore` and an in-process deterministic replica witness below the public binding boundary. Without approved native implementations, the artifact cannot create or open a production endpoint and fails with `secure_store_unavailable` or `rollback_anchor_unavailable`. Selecting production macOS and Linux implementations is a separate architecture, dependency, and platform-evidence gate before daemon consumption.

Prebuilt artifacts are intended before daemon consumption so installed users do not need Rust or a native compiler. Session 50 builds and smoke-tests private artifacts but does not publish them or connect them to the daemon.

## Browser/WASM binding

The private artifact is `@axl/e2ee-browser`. It contains an ES module loader, generated JavaScript glue, the `.wasm` module, a dedicated worker, TypeScript declarations, license notices, and an integrity manifest. Generated files are produced from source and checked by their generator; they are never edited manually.

The binding enables OpenMLS's `js` feature and obtains randomness only from `crypto.getRandomValues()`. Missing secure randomness fails with `secure_random_unavailable`; no deterministic, classical-only, or non-cryptographic fallback exists.

The initial implementation is single-threaded. It does not require shared WASM memory or `SharedArrayBuffer`. The serving policy permits WebAssembly narrowly with `script-src 'self' 'wasm-unsafe-eval'` and permits only same-origin workers with `worker-src 'self'`. General `unsafe-eval`, inline scripts, cross-origin workers, and runtime code downloads remain forbidden.

Rust-owned secret buffers are zeroed where practical. JavaScript temporary buffers are overwritten after use and the worker is terminated after fatal state errors. Axl does not claim reliable zeroization of browser copies, WASM linear memory after process termination, JIT state, caches, profile storage, swap, crash dumps, backups, snapshots, or physical media.

## Deferred native mobile work

Session 50 adds no Swift, Kotlin, C ABI, JNI, generated binding, mobile secure-storage adapter, or mobile application code. Phase 13 will select the mobile stacks and binding mechanism from concrete client requirements, then evaluate its complete dependency and toolchain graph separately.

No UniFFI, cbindgen, JNI crate, Android Gradle plugin, Android NDK project, Xcode project, XCFramework, AAR, Keychain adapter, Android Keystore adapter, iOS application, or Android application is introduced in Session 50.

## Cross-platform fixtures

Native Rust is the sole producer of checked-in revision 1 fixtures. Fixture generation uses production CSPRNG for cryptographic material and marks private fixture state as test-only. Deterministic randomness is never compiled into production code.

Fixtures cover credentials, invitation and claim transcripts, KeyPackage, Welcome, pair activation, application messages, self-Update proposals, daemon commits, AAD, epoch-ready evidence, corruption, replay, identity mismatch, profile mismatch, and exact-byte retry. Native Rust validates every fixture. Node and browser consumers validate the same bytes and expected typed outcomes. Each executable target also runs a fresh-randomness local round trip. Phase 13 Swift and Kotlin bindings must consume this same corpus.

## Browser and platform test gates

Required evidence is:

- native Rust tests on Linux and macOS;
- Node 22.19 and Node 24 import and fixture tests for every produced native artifact;
- branded Chrome, Playwright Firefox, and Playwright WebKit execution;
- actual Safari execution through Safari WebDriver on macOS, reported separately from WebKit;
- browser transaction abort, ambiguous completion, close/reopen, worker termination, multi-tab contention, quota failure, storage loss, schema upgrade, and exact-byte retry;
- packaging and import smoke tests for every produced Node and browser artifact.

Compile-only WASM, Playwright WebKit alone, mocked IndexedDB, or an in-memory anchor does not count as browser interoperability or production-pairing evidence.

## Dependency decision

Session 50 evaluates the exact candidates recorded in `openmls-dependency-decision.md`. A dependency-bearing PR requires a separately approved complete locked normal, build, development, and downloaded-binary graph. Standard browser APIs are preferred over an IndexedDB wrapper or lock package.

The current `proc-macro-error2` 2.0.1 exception remains limited to the existing OpenMLS/libcrux path. It expires on 2026-12-15 or the next relevant OpenMLS/libcrux release, whichever comes first. Each dependency-bearing PR must re-run the advisory-path check and may not suppress a vulnerability.

## Exclusions

Session 50 does not implement control-plane storage, relay changes, account behavior, daemon authorization, daemon or SDK wiring, ordinary-session steering, remote approval, attachments, S3, hosted deployment, or user interface behavior. Browser remote access stays disabled throughout this work.
