<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Browser E2EE storage feasibility protocol

Status: production persistence foundation plus Session 50.5 test artifact. Production browser
pairing remains disabled.

## Scope and security gate

The browser test artifact implements the prepare-and-compare protocol with browser-provided
IndexedDB, Web Locks, WebCrypto, and dedicated workers. It exercises real OpenMLS state loaded from
and written back to an authenticated committed snapshot. The implementation adds no browser storage
library, lock library, cryptography library, or test database mock.

The production artifact does not export the test adapter or its test anchor. It includes a
worker-private production store with Web Lock ownership, strict IndexedDB commits, a non-extractable
AES-KW wrapping key, wrapped state keys, the canonical sealed committed-transition record, exact
witness requests, and certificate continuation. The store accepts only Rust-finalized transitions,
a Rust-owned lineage, and Rust-owned replica trust; see "Production barrier store" below. No page
protocol operation constructs that store. Production `createDaemonEndpoint`, `openDaemonEndpoint`,
`createDeviceEndpoint`, and `openDeviceEndpoint` continue to return `rollback_anchor_unavailable`
until the transient production endpoint, pinned production replica trust, hosted transport, and the
full runtime matrix are complete.

This implementation is feasibility evidence, not production rollback protection. IndexedDB,
WebCrypto non-extractability, persistent-storage permission, and WebAuthn counters are not an
independent monotonic rollback anchor. Browser storage can be deleted, evicted, restored, copied, or
rolled back with the browser profile. Production browser pairing requires a separately reviewed
native or hardware-backed anchor or authenticated peer-witness protocol.

## Worker and lock ownership

One endpoint lives in one same-origin dedicated module worker. Before creation, opening, or any
state-advancing operation, the worker holds an exclusive Web Lock named exactly:

```text
axl-e2ee-v1:<lowercase crypto_session_id hex>
```

The request uses `ifAvailable: true`, does not use `steal`, and keeps the lock callback promise
pending for the endpoint lifetime. A cooperative second worker receives `lifecycle_busy`. Closing or
terminating the worker or its owning document releases the browser-owned lock. A successor always
opens and authenticates committed state. A rejected or unexpectedly completed callback poisons the
endpoint and closes its database connections; the worker is then disposable.

A Web Lock coordinates only cooperative same-origin participants. It is not an authorization
boundary and cannot protect against compromised origin code.

## Databases and stores

Each test crypto session uses two databases. The lowercase session identifier is part of each
name. Version 1 has no migration from an older schema.

The state database contains these versioned object stores:

| Store | Purpose |
| --- | --- |
| `metadata_v1` | Schema, lifecycle, session and profile binding, generation, rollback counter, and current wrapped-DEK identifier |
| `sealed_state_v1` | AES-256-GCM sealed complete OpenMLS provider snapshot and authenticated state header |
| `manifest_v1` | SHA-384 digest copied inside the sealed state and checked against all durable logical records |
| `operations_v1` | Operation identifier, canonical input fingerprint, committed generation, and result kind |
| `outbox_v1` | Exact committed MLS ciphertext |
| `accepted_messages_v1` | Durable accepted-message identity and acknowledgement state |
| `pending_plaintext_v1` | AES-256-GCM sealed plaintext, its authenticated DEK identifier, and retry identity |
| `creation_v1` | Exact bounded test-fixture creation inputs needed to recover committed-but-unacknowledged creation |

The key database contains:

| Store | Purpose |
| --- | --- |
| `wrapping_key_v1` | One origin-bound, non-extractable AES-KW `CryptoKey` |
| `wrapped_deks_v1` | Per-state wrapped AES-256-GCM DEKs in `prepared`, `active`, or pending-result `retained` state |
| `test_anchor_v1` | Explicitly test-only rollback and state-loss evidence |

Neither the wrapping key nor an unwrapped DEK crosses the dedicated worker boundary. Page
JavaScript cannot provide a wrapping key, DEK, or rollback counter. The test anchor is part of the
same browser storage domain and therefore makes no production rollback claim.

The authenticated state header binds schema version, profile ID and revision, crypto session ID,
generation, rollback counter, current key identifier, and manifest digest. The manifest covers the
same metadata plus the creation result and every operation, outbox, accepted-message, and
sealed-pending-plaintext record. Every collection is sorted by its validated durable key before
SHA-384 hashing, independent of append or IndexedDB cursor order.

## Production barrier store

The production worker store (`worker/storage.js`) is database version 2 under the same
`axl-e2ee-production-v1:<session hex>` name. Version 1 databases and unknown newer versions fail
closed with `unsupported_schema`; a failed upgrade aborts and preserves the old database. Its stores:

| Store | Purpose |
| --- | --- |
| `metadata_v2` | Profile and session binding, generation, confirmed witness counter and commitment, previous certificate hash, current key ID, one optional pending operation ID, and a fail-closed `ready`, `quarantined`, or `revoked` lifecycle |
| `wrapping_key_v2` | One origin-bound, non-extractable AES-KW `CryptoKey` |
| `wrapped_state_keys_v2` | Wrapped AES-256-GCM state keys in `prepared` or `active` lifecycle |
| `sealed_transitions_v2` | The one canonical committed-transition record: clear header, both nonces, exact sealed inner state and result, exact sealed outer metadata with the signed request |
| `witness_operations_v2` | Operation ID, input fingerprint, counter, generation, confirmed predecessor, successor and obsolete key IDs, exact request, request hash, and `pending` or `completed` disposition |

The store verifies nothing cryptographic. The Rust `BrowserEndpoint` (`witness::browser::endpoint`)
owns lineage, the authenticated committed image, duplicate lookup, the exact-result index,
certificate verification against Rust-owned replica trust, and the output gate. The worker-private
driver `worker/endpoint.js` sequences the two.

A mutation asks Rust for one outcome: the exact pending duplicate, the exact released duplicate, or a
fresh `BrowserTransition`. For a fresh transition the store generates and wraps the state key, seals
the inner payload Rust hands over once with the Rust-chosen nonce and AAD, returns the exact sealed
bytes to `finalize`, seals the outer metadata Rust returns, and stores the record Rust assembles from
both. JavaScript never selects a counter, commitment, nonce, key ID, or request. One strict
transaction rechecks the confirmed head, generation, current key, and absence of a pending operation,
then writes the `prepared` key, the record, the operation, and the metadata. After it completes, a
second strict transaction marks the key `active`; only then does Rust adopt the successor image and
expose the exact pending request. Any failure or uncertainty once the strict transaction may have
started destroys the transient Rust endpoint; later calls fail with `recovery_required`, and
recovery reopens from committed IndexedDB data.

Open activates or verifies the key named by the committed record's clear header, decrypts both
envelopes, and hands the plaintexts and record to Rust, which rechecks lineage, image, commitment,
request hash, signature, heads, and generation and compares the stored request row with the signed
request inside the record; a mismatch is `corrupt_state` and nothing is exposed for resend. A failed
`create()` or `open()` releases the Web Lock before rejecting.

Continuation verifies the certificate in Rust against the exact pending request, then, in one strict
transaction, rechecks the successor key, deletes the obsolete key and observes it absent, marks the
operation completed, and advances the confirmed head. Rust releases the exact typed result only after
the store reports that erasure. A witness decision against the lineage or an invalid certificate
persists a terminal lifecycle marker; a reused operation ID with another fingerprint does the same
and returns `witness_operation_conflict`. If that marker's write does not complete, the call fails
with the storage error and both the live endpoint and the store refuse every later call. After a
restart the whole restored image is a cache, not witness authority: a duplicate of any retained
operation returns `fresh_witness_required` until a fresh unanimous head confirms the confirmed head
or a verified certificate advances it, after which the exact result is released from the image index
without a transition.

The sealed inner state is the browser device image: identity, signer, joined-group metadata, the
complete OpenMLS provider storage, the applied commit awaiting its epoch-ready message, and the
completed operations with exact results inside the shared 4,096-successor idempotency horizon. Every
supported mutation decodes a transient phone from that image, runs exactly one OpenMLS transition,
and encodes the successor image; the transient phone is discarded whether or not the commit succeeds.

The test artifact drives the byte-identical driver and store from the dedicated test worker with an
in-WASM peer daemon and the in-WASM deterministic three-replica witness. Its evidence covers every
supported mutation, duplicates before and after completion, restart with a pending and with a
completed operation including an older retained result, an epoch-ready that names another commit or
repeats an announced one, an activation whose payload differs under a reused ID, an aborted commit
transaction, a durable commit whose key activation failed,
witness unavailability, Web Lock loss to another owner, real worker termination between commit and
completion, an unpersisted quarantine write, a corrupted stored request, a forged certificate, and
schema handling. Production replica trust is not pinned yet, so no production path constructs the
endpoint or the store.

## Prepare-and-compare order

A state-advancing test operation follows this order:

1. Retain the endpoint's exclusive Web Lock.
2. Read all committed metadata, state, manifest, creation, operations, outbox, accepted-message,
   and pending plaintext records with bounded cursors in one short read-only IndexedDB transaction.
   Validate exact record shapes, keys, counts, field sizes, byte types, and cross-record references
   before recursive normalization, hashing, or allocation from durable lengths.
3. Load the referenced wrapped DEK, decrypt the state, authenticate its header and manifest, verify
   the profile and session identity, and compare the test rollback evidence.
4. Instantiate a disposable private WASM endpoint from the complete committed OpenMLS provider
   snapshot.
5. Perform exactly one send or receive transition.
6. Keep the successor snapshot, expected generation, canonical operation fingerprint, result kind,
   and exact result bytes in an internal worker-only pending mutation.
7. Generate a fresh DEK, wrap it with the non-extractable wrapping key, and commit its record as
   `prepared` in the key database.
8. Open one IndexedDB `readwrite` transaction over every state store with requested durability
   `strict`, verify that the resulting transaction reports `durability === "strict"`, and fail with
   `strict_durability_unavailable` if the browser cannot demonstrate it.
9. Re-read and compare generation, rollback counter, profile, session identity, and operation
   fingerprint inside that transaction.
10. Atomically write the successor metadata, sealed state, manifest, operation, and affected outbox,
    accepted-message, or sealed-pending-plaintext records.
11. Wait for the transaction `complete` event.
12. Activate the referenced prepared DEK, reconcile the test anchor, retain old wrapped DEKs still
    referenced by authenticated pending plaintext, and remove only unreferenced keys after
    reconciliation.
13. Only then copy ciphertext or plaintext into the worker response.

No timer, network request, WebCrypto operation, or page callback runs inside the state write
transaction. All encryption, hashing, and key preparation finish before it starts. IndexedDB request
handlers perform only the required compares and writes.

## Recovery and exact-byte behavior

Every operation ID has a SHA-384 fingerprint over its canonical operation kind and exact inputs. A
committed retry with the same fingerprint reads the result from the authenticated outbox or sealed
pending-plaintext record. Each pending record identifies its retained wrapped DEK, so an older
plaintext remains recoverable after later state and key rotations. The retry does not invoke OpenMLS
again. Reusing an operation ID with different input returns `operation_conflict`.

An abort before commit leaves no operation or result record. Retrying reloads the old snapshot and
performs a fresh transition. Candidate bytes from the aborted attempt are never returned. A worker
termination before commit has the same recovery path.

If the state transaction completed but completion became ambiguous to the caller, the successor
loads the committed operation. It may activate the still-`prepared` key only after the committed
state decrypts and authenticates with that key. It then returns the exact stored result. Worker
termination after commit follows this path.

The fixed creation operation is also recoverable. A retry authenticates generation 1 and returns its
exact committed fixture inputs without generating replacement OpenMLS state. Pre-commit creation
termination may start fresh because no state was committed.

Generation-conflict evidence injects a stale expected generation into the compare without changing
storage. After rejection, reopen authenticates the prior generation and retry safely performs the
transition. Generation conflict, transaction abort, callback failure, quota failure, forced database
closure, or ambiguous completion discards the transient WASM endpoint. No candidate endpoint is
cached or reused.

## Failure policy

The adapter fails closed for:

- unavailable IndexedDB or Web Locks;
- `QuotaExceededError` and transaction abort;
- a blocked upgrade or failed upgrade;
- an unknown newer schema;
- a missing wrapping record or unusable wrapping key;
- inability to verify strict transaction durability;
- malformed, cyclic, oversized, excessive, or unexpected durable records;
- profile, identity, generation, or rollback mismatch;
- sealed-state authentication failure or manifest mismatch;
- missing or evicted committed state;
- operation ID conflicts; and
- unexpected lock loss.

Corruption, rollback, and state loss never create a replacement database automatically. The first
observed loss returns `state_loss`; a later open returns `re_pair_required`. Re-pairing must use fresh
identity, crypto-session, KeyPackage, and group identifiers.

## Browser evidence and limitations

The real-browser suite uses each browser's IndexedDB, Web Locks, WebCrypto, and workers. It covers
create/commit/close/reopen, pre-commit and post-commit creation termination, ambiguous creation
recovery, exact send and receive recovery, recovery of receive A after receive B and restart,
non-monotonic operation-ID ordering, duplicate and conflicting operation IDs, 60,000-byte plaintext
and 65,497-byte ciphertext input bounds, closed fault/tamper unions, abort and quota paths, ambiguous
completion, worker termination on both sides of commit, callback failure, non-mutating generation
conflict, two-worker contention, worker and embedded-page termination, strict-durability reporting,
forced close, malformed/cyclic/oversized/unexpected records, corruption, manifest failure, missing
state, unknown schema, blocked and failed upgrades, and fail-closed state loss.

The harness cannot portably force a browser tab into operating-system suspension or reproduce every
browser eviction policy. It reports page suspension, freezing, and restoration as unavailable when
the automation interface cannot expose those lifecycle controls. That absence is not positive
security evidence. Browser support decisions must separately evaluate background suspension,
freezing, restoration, private browsing, storage pressure, backups, profile migration, and browser
upgrade behavior on each supported release.

Axl makes no claim of reliable deletion from browser profiles, backups, snapshots, caches, swap,
crash dumps, JIT state, WASM linear memory after termination, or physical media. Non-extractable
WebCrypto keys prevent API-level export only; they do not prove hardware backing or prevent a
compromised origin from invoking the key.
