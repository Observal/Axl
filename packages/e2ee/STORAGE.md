<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native E2EE storage schema

Status: Session 40B native schema, version 1

## Database ownership

Each redb file is permanently bound to one `crypto_session_id`, profile
`axl-e2ee-mls-pq-v1`, and profile revision `1`. The filename is the lowercase hexadecimal
encoding of the 16-byte crypto session ID. Relay route IDs are never persisted.

Creation and opening are separate operations. The initial anchor is validated before a durable file
is created. A restrictive external `.initializing` marker is created before the database file, and
the database lifecycle remains `initializing` until the first encrypted state, operation record,
anchor advancement, and wrapping-key activation complete. Normal opening accepts only `ready`
files after atomic marker removal and parent-directory synchronization. An abandoned initializing file can be removed only through
`discard_interrupted_creation`; ready storage is never reset or removed by that API, and a consumed
anchor requires a fresh crypto session ID. Creation otherwise rejects an existing file, and opening
rejects a missing file. Paths are canonicalized, symlink roots and database files are rejected, and
Unix directories and files are restricted to modes `0700` and `0600` respectively.

Every security-sensitive write transaction explicitly selects `redb::Durability::Immediate` and
enables redb two-phase commit. Persistent savepoints are not used.

## Version 1 tables

| Table | Key | Value |
| --- | --- | --- |
| `metadata_v1` | fixed numeric field ID | schema version, lifecycle, crypto session binding, profile binding, generation, rollback counter, committed epoch, epoch authenticator, and pending obsolete wrapping-record ID |
| `encrypted_state_v1` | fixed current-state key | versioned AES-256-GCM envelope containing the complete OpenMLS provider image, restart clock state, and authenticated durable-record manifest |
| `operations_v1` | 16-byte operation ID | canonical input fingerprint, committed generation, and exact typed result |
| `outbox_v1` | 16-byte operation ID | stable crypto session ID, logical message ID, class, epoch, profile revision, retry state, exact MLS ciphertext, and optional commit ID, target epoch, and epoch authenticator |
| `accepted_messages_v1` | 16-byte operation ID | stable crypto session ID, logical message ID, class, epoch, profile revision, and acknowledgement state |

The encrypted provider image includes OpenMLS group state, signer material, replay state, retained
past-epoch deadlines, the last accepted wall-clock value, endpoint identity binding, the
cryptographically authenticated durable-record manifest, and any unacknowledged receive result. A
receive result is sealed before its plaintext is released. It is deleted from the next encrypted
image after acknowledgement. Consumed MLS message keys are not reconstructed.

The manifest is a SHA-384 digest over domain-separated SHA-384 digests of cryptographic metadata,
operation, outbox, and accepted-message entries. The initialization/ready publication marker is
excluded: changing it can only block opening or reach the ordinary encrypted-state validation; it
cannot make missing or altered cryptographic state valid. The manifest is stored inside the
AES-256-GCM state envelope and checked before any durable record is trusted. Modification of any logical ID, class, profile,
session binding, acknowledgement, retry state, operation mapping, or exact ciphertext quarantines
the group.

## Transaction order

1. Acquire Axl's per-database operation mutex. It covers external-key reconciliation, state load,
   the redb writer transaction, anchor advancement, and obsolete-key erasure.
2. Reconcile prepared external keys, activating the key referenced by committed current state and
   removing unreferenced inactive records.
3. Authenticate the durable-record manifest, reconcile the monotonic anchor, and only then erase
   the obsolete active key referenced by committed metadata.
4. Start a read-write transaction with immediate durability and two-phase commit.
5. Compare the expected generation and rollback counter with both the database and injected anchor.
6. Decrypt and load only the committed provider image, persisted clock state, and retained replay
   identities.
7. Check the operation ID and canonical input fingerprint.
8. Run the state-advancing OpenMLS operation against transaction-local storage.
9. Insert the exact outbox or accepted-message record, operation result, successor generation,
   rollback counter, epoch, authenticator, and obsolete wrapping-record reference.
10. Compact acknowledged operation, outbox, accepted-message, and fingerprint records beyond the
    retry horizon, then calculate their authenticated manifest.
11. Generate a fresh state DEK and nonce with the libcrux provider and prepare its external inactive
    wrapping record.
12. Encrypt the complete successor state and manifest with upstream AES-256-GCM and insert it into
    the same redb transaction.
13. Commit redb durably.
14. Activate the committed current-state key.
15. Advance the external monotonic anchor.
16. Only then erase the obsolete active key.
17. Only then return bytes for transmission or plaintext for processing.

A non-poisoned commit error has an uncertain outcome. Recovery closes and reopens redb, activates
and validates the key referenced by committed current state, authenticates the durable manifest,
advances or verifies the external anchor, and only then erases the obsolete key. It finally reads
the authenticated operation record and returns its exact result when present. `load` accepts active
keys only; prepared-but-inactive keys become loadable solely through idempotent committed-key
activation or prepared-record reconciliation.
Every operation reconstructs `MlsGroup` and its signer from the committed encrypted image after the
transaction starts. Failed, rolled-back, and completed operations retain no reusable in-memory group
or prepared handle.

## Retry, replay, and clock retention

Pending outbox and unacknowledged receive operations are never pruned. Public acknowledgement APIs
durably transition outbox retry state to `Acknowledged` and remove sealed receive plaintext.
Acknowledged idempotency, replay-identity, and fingerprint records remain available for 4,096
successor generations, then compact atomically with the next encrypted manifest. Network and SDK
layers must not retry an already acknowledged operation after that horizon and must never reuse an
operation ID. More than 4,096 simultaneous unacknowledged operations fails closed with
`RetentionExceeded` until acknowledgements make progress. Close/reopen tests pass beyond the
configured test retry horizon for both outbox and receive identities.

Previous-epoch deadlines are absolute milliseconds from the injected wall clock and remain bounded
to the profile's two retained epochs. The last observed wall-clock value is encrypted with endpoint
state. A clock value lower than that committed value fails closed with `ClockRollback`; it never
extends the five-minute grace window. Tests cover allowed previous-epoch receive after restart,
expiry after five minutes, and clock rollback.

## Fault-injection coverage

The native close/reopen suite injects deterministic failures at every Session 40B boundary:

| Boundary | Required recovery evidence |
| --- | --- |
| Before OpenMLS writes; during provider writes | Reopen sees the old generation and retry performs one fresh operation |
| Before exact-ciphertext insertion; after insertion; before commit | Transaction abort leaves neither successor state nor outbox record |
| After durable commit before success; after commit before network send | Operation lookup returns the committed byte-identical ciphertext without MLS encryption |
| During receive/replay writes | Plaintext is not returned; reopen sees old replay state and a retry commits once |
| Before receiver acknowledgement; after acknowledgement loss | Reopen returns the sealed committed plaintext once; acknowledgement retry is idempotent |
| During restart/reload | Opening fails closed; a later explicit reopen deterministically loads committed state |
| During current-key activation, prepared-key reconciliation, anchor recovery, wrapping-record replacement, or erasure | Recovery activates and authenticates current state, advances the anchor, and only then erases the obsolete key |
| During duplicate operation IDs | Matching input recovers the prior exact result; conflicting input is rejected |
| During generation conflicts | A queued real operation reloads the committed generation and succeeds exactly once |
| After marker/file creation, after schema commit, and throughout initial cryptographic commit/publication | Reopen reports `InitializationIncomplete`; explicit cleanup removes the marker, file, and all session key records |

Additional real temporary-database tests close and reopen after application sends, receives, update
proposals, commits, and epoch changes. They verify per-group writer serialization, parallel progress
for separate group databases, schema and rollback quarantine, exact-byte retry, and absence of test
plaintext and exposed DEKs from the database file. Tests also tamper each durable metadata table,
exercise active-only key loading, reconcile orphan prepared keys, and run real concurrent committing
operations against one group.

## Migrations and failure policy

Schema and encrypted-state formats have independent explicit version fields. Version 1 has no
predecessor and therefore no migration. Future migrations must be one-way transactions with fixture
coverage. A newer schema, downgrade, malformed record, AEAD failure, missing wrapping record,
crypto-session/profile mismatch, generation mismatch, rollback, or epoch-authenticator mismatch
quarantines the group or fails opening. None triggers automatic reset.

## At-rest boundary

redb stores encrypted MLS state and opaque wrapping-record identifiers. It never stores a DEK or
wrapping key. The injected `EnvelopeKeyStore` keeps wrapping records outside the redb snapshot
domain and must support enumeration and reconciliation of inactive prepared records per crypto
session. `load` rejects inactive records; `activate`, `erase`, reconciliation, and session destruction
are idempotent. Session destruction is available only for explicit cleanup of an initializing
database. The injected `RollbackAnchor` keeps monotonic state outside the database snapshot domain.
Both dependencies must report availability or the adapter fails closed.

The implementation uses the pinned libcrux provider's CSPRNG and AES-256-GCM. It defines no KDF or
new cryptographic primitive. A fresh 256-bit DEK protects each successor state image. AAD binds the
schema, profile revision, crypto session, generation, rollback counter, and epoch.

Deletion of an obsolete wrapping record makes the old encrypted image unusable only within the
security properties of the future platform key implementation. This implementation does not claim
forensic erasure from redb page reuse, file deletion, checkpointing, compaction, or filesystem
operations. Filesystem snapshots, backups, crash dumps, storage-controller caches, and physical
media are excluded. Keychain, Android Keystore, and browser implementations remain Session 50 work.

The monotonic anchor detects a database older than the last anchored commit. The peer epoch
authenticator detects a divergent epoch once authenticated peer evidence is available. Rollback of
the database and anchor together, rollback before anchor advancement becomes durable, and loss of
all peer evidence are not claimed to be detectable.
