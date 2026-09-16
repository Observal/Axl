<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Browser E2EE storage feasibility protocol

Status: Session 50.5 test-artifact implementation. Production browser pairing remains disabled.

## Scope and security gate

The browser test artifact implements the prepare-and-compare protocol with browser-provided
IndexedDB, Web Locks, WebCrypto, and dedicated workers. It exercises real OpenMLS state loaded from
and written back to an authenticated committed snapshot. The implementation adds no browser storage
library, lock library, cryptography library, or test database mock.

The production artifact does not export this adapter or its test anchor and does not contain its
persistence worker. Production `createDaemonEndpoint`, `openDaemonEndpoint`,
`createDeviceEndpoint`, and `openDeviceEndpoint` continue to return
`rollback_anchor_unavailable`.

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
