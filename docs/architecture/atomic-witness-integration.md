<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Atomic witness integration

Status: focused implementation specification. Production constructors remain disabled.

Normative source: [`production-e2ee-storage-and-rollback.md`](production-e2ee-storage-and-rollback.md).
This document maps that RFC to the current endpoint, binding, SDK, and daemon code. It does not
change the witness protocol, quorum rule, commitment calculation, key lifecycle, or recovery
semantics.

## Scope and invariants

The implementation MUST preserve these rules for each endpoint lineage:

- One OS lifecycle claim and one in-process operation owner protect the native endpoint. One
  lifetime exclusive Web Lock and one worker operation queue protect the browser endpoint.
- One logical endpoint operation performs at most one OpenMLS transition.
- At most one locally committed witness operation exists. It blocks every later mutation.
- No candidate ciphertext, plaintext, pairing artifact, or typed state result crosses the Rust or
  private worker boundary before the barrier completes.
- The exact signed witness request, including nonce and signature, survives restart.
- JavaScript transports opaque request and certificate bytes. It cannot select counters,
  commitments, nonces, keys, key lifecycle, or successor state.
- Only a certificate with three distinct, pinned, valid receipts for the exact request and matching
  result may continue an operation.
- The prepared successor key activates immediately after durable local commit and before the exact
  pending witness request is exposed. The continuation verifies that activation remains complete,
  then erases and verifies the obsolete key before making the exact result releasable.
- A repeated operation ID with the identical canonical input fingerprint returns the byte-identical
  pending request or exact result. A repeated ID with another fingerprint is
  `witness_operation_conflict` and quarantines the endpoint.
- No unavailable component has a fallback. Production creation and opening remain disabled in this
  implementation phase.

A state-changing operation is any operation that changes the authenticated endpoint image,
operation history, replay state, retry state, lifecycle state, clock state, or exact-result
retention. It requires a witness advance even when it does not call OpenMLS and even when its public
result is only an acknowledgement or status.

## Complete mutation inventory

The named methods are the current native methods in `persistence.rs` and
`persistence/pairing_lifecycle.rs`. Every state change in these rows uses the barrier. A no-change
branch, such as a rejected malformed claim that is not recorded, remains a read-only result and does
not advance.

| Operation family | Current entry points | OpenMLS transitions | Barrier result withheld |
| --- | --- | ---: | --- |
| Daemon endpoint creation and invitation issue | `DurablePendingInvitation::issue`; legacy `DurableDaemon::create` | 0 for invitation, 1 for legacy group creation | Exact invitation publication, or legacy creation success |
| Device endpoint creation, KeyPackage, and claim | `DurablePreJoinDevice::prepare`, `prepare_repair`; legacy `DurablePhone::create` | 1 KeyPackage creation | Exact claim, exact KeyPackage, invitation hash, and expiry |
| Open existing endpoint | `open` and `reopen` methods | 0 | No new result. Opening must reconcile and return an existing pending request or make already-confirmed results recoverable. It never creates a successor merely by opening. Interrupted initial publication remains withheld until registration completes. |
| Invitation cancellation | `cancel` | 0 | Final invitation lifecycle |
| Invitation, pre-join, and Welcome expiry | `expire_if_needed`, `expire_welcome_if_needed` | 0 | The triggering call's final typed result. Expiry is a deterministic internal operation with its existing derived operation ID. |
| Claim validation and accounting | `submit_claim` when it records a pending valid claim, an eligible failure, conflict, or fifth-failure cancellation | 0 | `Pending`, recorded rejection, cancellation, or conflict result |
| Claim confirmation and KeyPackage reservation intent | `confirm_claim` | 0 | Exact `ReservationOutcome`, including the exact `ReservationIntent` |
| Reservation release | `release_reservation` | 0 | Exact `ReservationOutcome` |
| Welcome creation and daemon group establishment | `create_welcome`; legacy `consume_key_package` | 1 add-member and merge transition | Exact Welcome publication and group metadata |
| Welcome processing and device join | `join`, `join_published_welcome` | 1 Welcome join | Joined lifecycle result |
| Activation send | `prepare_activation` | 1 MLS application send | Exact activation outbox record and ciphertext |
| Activation receive | `accept_activation` | 1 MLS application receive | Exact `ActivationAcceptance` |
| Protected activation acknowledgement | `acknowledge_activation` | 0 | Active lifecycle result |
| Application send | both `prepare_application` paths | 1 MLS application send | Exact outbox record and ciphertext |
| Application receive | both `receive_application` paths | 1 MLS application receive | Exact `DurablePlaintext` and accepted-message record |
| Self-Update proposal send | `prepare_replacement`, legacy `prepare_self_update` | 1 proposal creation | Exact proposal outbox record and ciphertext |
| Self-Update proposal receive | `receive_replacement_proposal`, legacy `receive_update_proposal` | 1 proposal processing | Exact accepted-message result |
| Daemon update commit | `create_update_commit`, legacy `prepare_commit` | 1 commit and merge transition | Exact commit outbox record and commit metadata |
| Received update commit | current `apply_update_commit` and `apply_received_update_commit` | **currently 2** | Must be split. The first operation withholds the exact applied-commit result. A second operation creates and withholds the epoch-ready outbox record. |
| Epoch-ready send | new split operation corresponding to current inner `prepare_epoch_ready` | 1 MLS application send | Exact epoch-ready outbox record and ciphertext |
| Epoch-ready receive | `accept_epoch_ready` | 1 MLS application receive | Exact `EpochReadyAcceptance` |
| Protected epoch-ready confirmation send | `prepare_epoch_ready_confirmation` | 1 MLS resync-control send | Exact confirmation outbox record and ciphertext |
| Protected epoch-ready confirmation receive | `accept_epoch_ready_confirmation` | 1 MLS resync-control receive | Active lifecycle result |
| Typed epoch-ready acknowledgement | `acknowledge_epoch_ready` | 0 | Active lifecycle result |
| Daemon removal or revocation commit | `remove_device`, `revoke_device` | 1 removal commit and merge transition | Exact commit outbox record |
| Device received removal | `apply_removal` | 1 commit processing | Exact removal result |
| Local revocation | `mark_revoked` | 0 | Exact revoked result |
| Local reset | both `reset` methods | 0 | Exact terminal status or `RePairRequirement` |
| Outbox acknowledgement | both `acknowledge_outbox` methods | 0 | Exact acknowledged `OutboxRecord` |
| Receive acknowledgement | both `acknowledge_receive` methods | 0 | Exact acknowledged `AcceptedMessageRecord` or public acknowledgement |

The following are transport-only or read-only and do not advance witness state:

- `publication`, `invitation`, `recover_welcome`, `status`, `lifecycle`, `pair_status`, and
  `pending_outbox`, provided they expose only results whose barrier already completed;
- `close`;
- transmitting an already released outbox ciphertext, changing a relay route or attempt ID, and
  retrying transport delivery;
- sending an exact pending witness request and receiving certificate bytes;
- parsing or inspecting an invitation or claim;
- malformed, oversized, unknown, expired, cancelled, or otherwise non-counting claim rejection when
  no authenticated record changes; and
- hosted authorization and ordinary daemon command acknowledgement. If either causes an endpoint
  record change or a new MLS message, that endpoint operation is separately covered by the rows
  above.

An outbox transport delivery acknowledgement does not itself advance endpoint state. Calling
`acknowledge_outbox` does. SDK acceptance of plaintext does not itself advance endpoint state.
Calling `acknowledge_receive` does. Activation and epoch-ready acceptance objects are protected
state-changing acknowledgements and therefore also advance.

## Transaction boundary and result representation

### Native operation families

Every **advance** row uses one invocation of a common native transaction runner. The runner holds the
endpoint operation mutex from reconciliation through result release or pending return. It:

1. authenticates the current committed record and manifest;
2. obtains and verifies a fresh unanimous witness head, then consumes the resulting one-operation
   mutation authorization;
3. begins one immediate-durability, two-phase redb write transaction;
4. checks the operation ID and canonical fingerprint before any transition;
5. reconstructs endpoint and signer state from that transaction's authenticated image;
6. performs zero or one OpenMLS transition;
7. constructs the complete successor image, durable records, and exact typed result;
8. prepares a fresh key and uses `witness::prepare_transition` to seal the inner state and result and
   the separate outer request metadata;
9. writes the successor record, operation index, result references, pending marker, and affected
   outbox or accepted-message metadata in the same redb transaction;
10. durably commits, then immediately activates the prepared successor key;
11. exposes only `PendingWitnessOperation` metadata after activation succeeds. If activation fails,
    it retains recoverable pending state but exposes neither request nor result;
12. verifies the matching certificate, verifies that the successor key remains active, erases and
    verifies absence of the obsolete key, marks the operation releasable, and only then decodes and
    releases its exact typed result.

The ordering is fixed:

```text
local durable commit
-> activate successor key
-> expose exact pending witness request
-> verify unanimous certificate
-> verify successor key active
-> erase and verify obsolete key
-> mark result releasable
-> return exact result
```

`continueWitness` does not perform first activation. It verifies that activation completed. If the
original post-commit activation failed or had an uncertain outcome, restart recovery idempotently
finishes or verifies activation before it exposes the request or permits `continueWitness`.

Creation uses the same transaction as step 3 for the first encrypted endpoint state and a counter-1
`register` request. The database remains `initializing`, and invitation, claim, or endpoint success
remains withheld, until registration and key completion succeed. `ready` publication follows the
barrier. A crash before that point is recovered as pending registration, not discarded as pristine.

The exact result is a canonical internal tagged encoding interpreted together with records in the
same sealed inner payload:

- envelope result: a tag and operation reference plus the exact ciphertext; every other
  `OutboxRecord` field is in the referenced authenticated successor record;
- receive result: a tag and operation reference plus exact plaintext; every accepted-message field
  is in the referenced authenticated successor record;
- pairing publication: exact invitation, claim, KeyPackage, or Welcome bytes plus hashes, group ID,
  and expiry as applicable;
- pairing decision: the exact tagged claim or reservation outcome and all returned bounded fields;
- protected acceptance: the complete activation or epoch-ready acceptance fields;
- lifecycle result: the exact lifecycle, removal, revocation, reset, or re-pair fields; and
- acknowledgement result: a tag and reference to the complete updated outbox or accepted-message
  record in the same inner payload.

The tag, reference, and referenced record are authenticated under one sealed inner payload, so no
field can be replaced independently. Empty success is encoded as a versioned tag, never inferred
from an absent result. Result encodings are private persistence formats, not new network formats.
The `exact_result` field remains bounded to 65,497 bytes, including its tag and reference. Envelope
encoding must reserve tag and reference space by storing the exact maximum-size ciphertext as an
inner-state record rather than duplicating it in `exact_result`. Composite pairing results must be
shown by tests to fit the bound. The browser's current 1 MiB result allowance must be reduced to this
RFC bound.

### Browser operation families

The same logical steps apply, with these required differences:

1. The dedicated worker holds the endpoint's exclusive Web Lock for its lifetime.
2. A short read transaction loads the complete authenticated snapshot and pending record.
3. A private WASM endpoint performs zero or one transition and retains the candidate state and
   result. Nothing candidate-derived crosses the worker boundary.
4. WebCrypto seals the inner state. Private WASM finalization calculates the commitment and exact
   signed request. WebCrypto seals outer metadata with the same state key and a distinct nonce.
5. One observed-`strict` IndexedDB `readwrite` transaction covers metadata, sealed state, operation,
   exact result, pending request, and all affected outbox and accepted-message stores. It rechecks
   generation, counter, commitment, lineage, and fingerprint.
6. After transaction completion, the worker activates the committed successor key. It exposes no
   pending request or result if activation fails or is uncertain. Abort, conflict, lock loss, worker
   loss, and ambiguous completion destroy the transient WASM endpoint and force recovery from
   committed IndexedDB data.
7. Only after activation succeeds may the worker expose the exact pending request. Continuation
   verifies the certificate and that the successor key remains active, deletes and verifies absence
   of the obsolete key, marks the operation releasable, and only then returns the exact result.

Page JavaScript sees only immutable pending metadata and a final typed result. It never receives
`innerState`, `outerMetadata`, AAD, state key handles, wrapped DEKs, snapshots, result ciphertext,
commitment construction inputs, or the `ProductionBrowserStore` object.

## Durable pending operation and schema

### Native owner

The pending operation belongs to the endpoint's redb database, not to the daemon, SDK, Node handle,
or an in-memory `EndpointWitnessState`. A schema migration is required. Keep the redb table layout
versioned, but introduce storage schema version 2 and encrypted state format version 2. Version 2
adds:

- confirmed witness counter, commitment, previous certificate hash, and registration state;
- one optional pending operation ID and its canonical input fingerprint;
- the current and obsolete key IDs needed for continuation;
- the exact `CommittedTransition` produced by `witness.rs`, containing sealed inner state and exact
  result plus sealed outer request metadata; and
- a releasable/completed operation state used only as a cache after successful continuation.

`operations_v1` remains the bounded ID and fingerprint index. Its version-2 value stores result kind,
generation, and pending or completed disposition. Exact result bytes and the exact witness request
remain authenticated inside the encrypted successor; any result index is only a locator. Outbox and
accepted-message tables remain internal durable retry indexes covered by the manifest. They must not
be returned while their creating or acknowledgement operation is pending.

One pending operation is retained without pruning. Completed operation IDs, fingerprints, and exact
results retain the existing 4,096-successor idempotency horizon. Pending outbox and unacknowledged
receive records remain unbounded by age but are capped by the existing 4,096 simultaneous-record
limit. Request, certificate, and result bounds remain 1 KiB, 3 KiB, and 65,497 bytes respectively.
Only one pending witness record is permitted, so total pending witness storage is bounded by one
committed transition whose inner state remains subject to the existing 16 MiB state bound.

Version 1 stores have no witness commitment or registration proof and cannot be made production
state by inference. Production open rejects them with `unsupported_schema`; it does not auto-register
or manufacture a counter-1 successor. Test-only migration fixtures may prove a separately approved
one-way migration later. Production constructors remain disabled, so this compatibility rule does
not strand approved production state.

### Browser owner

The production IndexedDB schema requires a version upgrade. The state database must mirror the same
logical fields and add the operation fingerprint, confirmed head, obsolete key ID, exact sealed
transition, and disposition. The current `witness_operations_v1` record is insufficient because it
has no input fingerprint, confirmed predecessor, or obsolete-key reference. The current
`wrapped_state_keys_v1` record also marks a new key `active` during commit and retains no explicit
obsolete-key continuation.

Use a new database version and new versioned stores or value versions. Upgrade runs only in
`versionchange`, aborts without deleting the old database, and keeps existing connections closed.
Unknown newer versions and version 1 production stores fail closed. No browser production endpoint
exists yet, so no automatic production migration is permitted.

## Idempotency and pending blocking

Schema version 2 defines the fingerprint exactly as:

```text
SHA-384(
  "Axl endpoint operation fingerprint v2" ||
  uint16 operation_kind ||
  repeated(uint32 field_length || exact_field_bytes)
)
```

Integers inside fields are fixed-width unsigned big-endian. Optional values are encoded as a
one-byte presence tag followed, when present, by the fixed-width value. Structured acceptance and
re-pair values use their fixed field order from the profile. Generated randomness and the operation
ID are not fields: randomness is part of the committed result, and the operation ID is the lookup
key. The version-2 operation kinds and ordered fields are:

| Kind | Operation | Ordered fingerprint fields |
| ---: | --- | --- |
| 1 | daemon invitation creation | role, account ID, installation ID, crypto-session ID |
| 2 | device pre-join creation | role, account ID, installation ID, device ID, exact invitation; optional exact re-pair requirement |
| 3 | invitation cancellation | empty |
| 4 | eligible claim submission | exact claim bytes |
| 5 | claim confirmation | claim hash, reservation ID |
| 6 | reservation release | reservation ID |
| 7 | Welcome creation | reservation ID |
| 8 | Welcome join | Welcome bytes, group ID, claim hash, expiry |
| 9 | activation send | logical message ID |
| 10 | activation receive | logical message ID, exact ciphertext |
| 11 | activation acknowledgement | crypto-session ID, group ID, claim hash, activation hash |
| 12 | application send | logical message ID, hosted generation, exact plaintext |
| 13 | application receive | logical message ID, hosted generation, exact ciphertext |
| 14 | self-Update proposal send | logical message ID, hosted generation |
| 15 | self-Update proposal receive | logical message ID, hosted generation, exact ciphertext |
| 16 | daemon commit | logical message ID, hosted generation |
| 17 | received commit apply | commit logical message ID, hosted generation, exact ciphertext; optional expected commit metadata |
| 18 | epoch-ready send | logical message ID, hosted generation, exact commit metadata |
| 19 | epoch-ready receive | logical message ID, hosted generation, exact ciphertext |
| 20 | epoch-ready confirmation send | logical message ID, hosted generation, exact acceptance |
| 21 | epoch-ready confirmation receive | logical message ID, hosted generation, exact ciphertext |
| 22 | typed epoch-ready acknowledgement | crypto-session ID, commit ID |
| 23 | removal commit | logical message ID, hosted generation, revocation Boolean |
| 24 | received removal | logical message ID, hosted generation, exact commit ciphertext and metadata |
| 25 | local revocation | empty |
| 26 | reset | empty |
| 27 | outbox acknowledgement | target operation ID |
| 28 | receive acknowledgement | target operation ID |
| 29 | invitation expiry | invitation hash, expiry |
| 30 | pre-join expiry | invitation hash, expiry |
| 31 | Welcome expiry | invitation hash, Welcome expiry |
| 32 | legacy direct endpoint creation, test-only | role, identity, context |

The current version-1 one-byte discriminator namespaces overlap between `persistence.rs` and
`pairing_lifecycle.rs`; they cannot be reused as one production namespace. Version 1 records retain
their existing interpretation only in test compatibility readers. Version 2 uses the table above.

Lookup occurs before OpenMLS or lifecycle mutation:

- same operation ID and fingerprint, pending: return the same operation ID, exact request bytes,
  request hash, and pending status;
- same operation ID and fingerprint, completed and within retention: return the exact typed result
  without OpenMLS or a new witness advance;
- same operation ID and another fingerprint: persist quarantine if safe to do so, return
  `witness_operation_conflict`, and release no prior or candidate result;
- another operation ID while one operation is pending: return `witness_unavailable` with a
  pending-operation detail, without opening a write transaction or evaluating the later input; and
- read-only recovery calls may inspect the pending descriptor but cannot expose its result.

Automatic expiry cannot bypass the pending operation. If expiry becomes due while another operation
is pending, the endpoint stays frozen. After the pending operation completes and a fresh head is
verified, expiry is the next mutation with its deterministic existing operation ID.

## Restart and continuation

No in-memory prepared handle is recovery authority. Open performs this sequence under exclusive
ownership:

1. Open without creating missing storage and validate schema, lineage, manifest, envelopes, key
   references, generation, counter, commitment, operation binding, exact request hash, and endpoint
   request signature.
2. Reconcile prepared keys. Activate or verify the key named by authenticated committed state before
   exposing or resending any witness request. If activation fails or is uncertain, remain frozen and
   expose neither request nor result. Never erase the authenticated obsolete key yet.
3. After activation succeeds, construct a fresh Rust-owned `PendingWitnessOperation` from the
   committed transition and verified key state.
4. Construct and send a fresh signed `read` request to all three replicas. For a pending register,
   an absent lineage means resend the exact register. For a pending advance, a predecessor head
   means resend the exact advance. A matching successor means recover the accepted receipts.
5. Apply the RFC recovery table exactly. Never fast-forward private state and never generate a new
   pending nonce or signature.
6. For resend or accepted recovery, expose the byte-identical stored request only after successor
   activation succeeds. After a matching certificate arrives, verify it in Rust or private WASM,
   verify that the successor key remains active, erase and verify absence of the obsolete key, mark
   the exact result releasable, update the confirmed head and certificate hash, and return that exact
   result.
7. Before any later mutation, obtain another fresh unanimous read and consume exactly one mutation
   authorization.

A completed marker or cached certificate is not authoritative after restart. A fresh unanimous head
is required. A cache may avoid transport only within the still-owned live continuation after the
certificate has been verified and key erasure has completed.

## API effects

### Rust and Node

`PendingWitnessOperation` must become the result of every state-changing production endpoint call.
The current `NativePendingWitness` test helper is not sufficient because it is detached from the
endpoint store and cannot activate or erase real keys. The production continuation must retain only
an endpoint reference and operation ID in memory, reload the durable record on every call, and
return a tagged native result decoded from the authenticated exact-result bytes.

Add endpoint-owned operations equivalent to:

- `reconcileWitness(readCertificate)` for open and pre-mutation fresh-head authorization;
- `pendingWitness()` to recover the one durable pending request; and
- `continueWitness(operationId, certificate)` to verify the certificate, verify successor-key
  activation, finish obsolete-key erasure, and return the exact tagged result.

The binding may wrap these in an immutable continuation object, but closing or losing that object
must not lose recovery. Every existing mutator changes from returning `NativeOutbox`,
`NativePlaintext`, publication, acceptance, or status directly to returning a pending continuation
or an already-completed exact typed result. Every input buffer is copied and bounded before async
work. Every `u64` remains `bigint`. Production trust is build-pinned. Production constructors and
`productionStorageReady` remain disabled or false.

### Browser

The page-facing worker protocol gains only opaque reconciliation, pending, and continuation
messages. It does not export `ProductionBrowserStore`, `BrowserWitnessVerifier`, private WASM
finalization, keys, or transition fields. Current `storage.js` is a foundation, not a conforming
barrier: `commit` accepts caller-selected inner state, outer metadata, request, hash, and exact
result; its verifier is injected from JavaScript; and `continueWitness` releases decrypted output
before obsolete-key deletion. All three paths remain unreachable in production until replaced by the
private endpoint flow.

### SDK and daemon

`HostedWitnessClient` remains the sole shared HTTP transport helper. Extend it to support fresh read
reconciliation and pending-operation completion while keeping request bytes opaque. It must preserve
byte identity, bounds, HTTPS policy, timeout behavior, and certificate zeroing. It must not decide
whether a result is accepted.

`RemoteDeviceE2ee` and `WindowsRemoteE2eeBridge` must await the witness completion before framing or
sending ciphertext, parsing plaintext, invoking daemon authorization, producing `daemon_accepted`,
or calling any state-changing acknowledgement. They must recover a pending operation before
accepting later work. Each acknowledgement is completed through its own barrier. The existing
serialized promise tail remains useful transport ordering but is not endpoint mutation authority.

The daemon owns authenticated witness transport, retry scheduling, and surfacing a blocked or
quarantined endpoint. It never receives candidate plaintext. A receive continuation completes in the
native binding before the daemon parses or authorizes the plaintext. The SDK follows the same rule
before decoding or projecting a delivery.

## Current RFC-to-code gaps

- `witness.rs` implements the protocol, sealed transition, reconciliation, and output gate, but
  `persistence.rs` does not use them. Native storage still calls the test-style `RollbackAnchor`.
- Every current mutator returns its result after the local anchor path and therefore exposes it too
  early for the hosted barrier.
- `EndpointWitnessState` and `PendingWitnessOperation` are in memory only. Native restart cannot
  reconstruct them from the endpoint database.
- Native schema version 1 stores one AES-GCM state envelope, not the RFC's acyclic sealed inner and
  outer transition. It does not persist confirmed commitments or an exclusive pending witness row.
- Current native operation records authenticate fingerprints, but pairing records often retain only
  an artifact hash as their result. A canonical exact typed result is not uniformly recoverable from
  one place.
- `apply_update_commit_inner` applies a received commit and creates epoch-ready ciphertext in one
  endpoint operation. This violates the one-OpenMLS-transition invariant and must be split.
- `begin_current` retries generation conflict in a loop and uses a local anchor. It has no fresh
  witness authorization and no pending-operation check.
- Native creation and opening release the OS lifecycle claim after publication. The production
  endpoint needs an OS-backed exclusive writer claim for its full open lifetime, not only its
  filesystem creation transition; the in-process mutex alone does not exclude another process.
- Browser `commit` accepts JavaScript-selected transition internals and request metadata, uses a
  1 MiB result bound, marks the new key active in the commit, and does not track or erase the obsolete
  key before release.
- Browser `continueWitness` persists `committed` before returning but does not bind that marker to
  verified key erasure. Its injected JavaScript verifier is not a production trust boundary.
- Node's `NativePendingWitness` is constructed only by `testWitnessPending`; its key activation and
  erasure flags are test-selected, and it is not connected to durable endpoints.
- SDK and daemon endpoint interfaces expect direct ciphertext or plaintext. They do not model
  reconciliation, pending witness recovery, or continuation.
- `pendingOutbox`, `recoverWelcome`, and duplicate mutation paths can expose locally committed exact
  results without proving that their witness barrier completed.
- Current acknowledgements advance generation, rollback counter, encrypted state, operation history,
  and key lifecycle. They are not transport-only and currently bypass the hosted witness.

## Errors and quarantine

Map malformed or non-canonical certificates, bad signatures, unpinned keys, mixed receipts, tuple
mismatch, request mismatch, and result mismatch to `witness_receipt_invalid`, then quarantine and
emit a bounded audit event. Map duplicate ID with different input to
`witness_operation_conflict` and quarantine. Map registration conflict, fork, invalid expected head,
stale local state, inconsistent witness state, revocation, and unavailable quorum exactly to the RFC
codes and recovery classes.

Local corruption, manifest failure, commitment mismatch, rollback, unknown schema, missing current
key, and state loss never become a new endpoint. They map to `corrupt_state`, `rollback_detected`,
`state_loss`, or `re_pair_required` as specified and enter durable terminal quarantine where the RFC
requires it. Timeouts and one or two receipts are `witness_unavailable`; they leave the exact pending
request retryable. Raw paths, backend messages, keys, requests, receipts, commitments, ciphertext,
or plaintext never enter public error details or info logs.

A witness-declared terminal result releases no application result and cannot authorize another
mutation. A local quarantine cache must not rewrite the committed witness-bound inner state. It may
be stored as a separate fail-closed lifecycle marker, and every open must rediscover the terminal
state from a fresh quorum read. Clearing or losing that cache therefore cannot restore mutation
authority. Endpoint revocation or reset initiated while the lineage is still live is an ordinary
witnessed mutation; a revocation that already won at the witness is terminal reconciliation, not a
new endpoint successor.

## Crash and recovery tests

Add focused native and browser tests at these boundaries:

- before and after inner serialization, key preparation, inner sealing, commitment calculation,
  request signing, outer sealing, operation/result insertion, and local durable commit;
- uncertain local commit, followed by close, reopen, operation lookup, and exact-request recovery;
- after commit but before key activation; after activation but before witness send; after one or two
  votes; after quorum acceptance but before response; after certificate verification; during
  obsolete-key erasure; and after erasure but before result return;
- restart in clean, resend-pending, accepted-response-loss, stale-local, conflicting-commitment,
  local-ahead, witness-behind, missing-lineage, revoked, and forked states;
- duplicate ID with identical input before and after restart, and duplicate ID with every differing
  input field;
- a later operation and automatic expiry blocked while pending;
- every row in the mutation inventory, including no-OpenMLS acknowledgements and lifecycle changes;
- exactly one OpenMLS transition per operation, with separate received-commit and epoch-ready
  operations;
- exact ciphertext and plaintext never visible before completion, including binding exceptions,
  callback exceptions, worker termination, and ambiguous IndexedDB completion;
- successor activation before obsolete deletion, deletion failure blocking output, and idempotent
  completion after restart;
- native mutex and lifecycle-lock contention, browser Web Lock contention and loss, and parallel
  progress for different endpoints; and
- schema version 1 rejection, failed version upgrade rollback, unknown newer versions, and no
  delete-and-recreate recovery.

## Production artifact and secret-exposure checks

Keep production constructors disabled and `productionStorageReady: false`. Extend Node and browser
ABI, package, symbol, and tarball checks to reject:

- `testWitnessPending`, `test_pending_witness_operation`, `TestAnchor`, `test_anchor_v1`, test stores,
  fixture replica keys, deterministic signers, fault controls, snapshot import/export, and all test
  constructors;
- public signing, counter, commitment, nonce, key-ID selection, key activation, key erasure,
  transition finalization, raw result decryption, and generic certificate-verifier APIs;
- plaintext state, DEKs, wrapping keys, invitation nonces, private fixture state, candidate outputs,
  witness requests, or certificates in logs, crash diagnostics, environment variables, process
  arguments, generated glue, staging directories, source snapshots, native symbols, integrity
  manifests, or package archives; and
- dynamic code, unexpected URLs, runtime downloads, mutable endpoint state, or transaction handles
  in the browser package.

Positive checks must prove exact artifact hashes, source and lock provenance, only build-pinned
replica trust, production/test artifact separation, immutable byte results, `bigint` for every
`u64`, and no local native compilation during install.

## Resolved sequencing and confirmation cache

The authoritative RFC fixes activation order. Durable local commit precedes successor-key
activation. Activation precedes request exposure and witness transmission. Certificate verification
then precedes the active-key recheck, obsolete-key erasure, and exact-result release. A failed or
uncertain first activation leaves recoverable committed pending state but no externally available
request or result.

The RFC permits `WITNESS_CONFIRMED` to avoid a second security-sensitive database commit while asking
that a result be marked releasable. The releasable marker is therefore a recovery cache, not witness
authority. Restart always obtains a fresh unanimous head and revalidates key state before using it.
The marker may be persisted with immediate or strict durability after erasure, but loss of that write
causes safe re-verification, not result loss or a second mutation.

No new dependency is required by this specification.

## Expected implementation commits

1. Add storage schema version 2, exact result codecs, durable pending witness state, migration
   rejection, and native crash fixtures while constructors remain disabled.
2. Integrate the native transaction runner with every mutation and split received-commit application
   from epoch-ready creation.
3. Add endpoint-owned Node reconciliation, pending recovery, continuation, typed result mapping, and
   production artifact exclusions.
4. Add private browser WASM finalization and promote the strict IndexedDB key lifecycle without a
   page-visible storage or verifier API.
5. Integrate every browser mutation and add restart, lock-loss, abort, and exact-result evidence.
6. Extend SDK witness reconciliation and update device and daemon adapters so no ciphertext or
   plaintext bypasses completion.
7. Add daemon recovery scheduling, quarantine reporting, and end-to-end crash and restart tests.
8. Complete native and browser artifact-isolation and secret-exposure checks. Keep all production
   constructors disabled pending later production gates.
