<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native E2EE storage schema

Status: Session 40B native schema, version 1

## Database ownership

Each redb file is permanently bound to one `crypto_session_id`, profile
`axl-e2ee-mls-pq-v1`, and profile revision `1`. The filename is the lowercase hexadecimal
encoding of the 16-byte crypto session ID. Relay route IDs are never persisted.

Creation and opening are separate operations. The initial anchor is validated before a durable file
is created. Creation acquires an exclusive operating-system lock on a permanent per-session
`.lifecycle.lock` file before publishing a restrictive external `.initializing` marker. It holds the
claim through the `ready` commit, marker removal, and parent-directory synchronization. The database
lifecycle remains `initializing` until the first encrypted state, operation record, anchor
advancement, and wrapping-key activation complete. Marker presence does not prove the database
lifecycle. `mark_ready` first commits `ready`, then removes the marker and synchronizes the parent
directory. If a crash leaves either complete authenticated `initializing` state or a marker beside a
`ready` database, opening holds the same lifecycle claim while it validates the schema, session and
profile binding, authenticated durable state, current external key, rollback anchor, epoch, and
authenticator. It finishes an interrupted `ready` commit when necessary, removes only the stale
marker, and opens normally. Committed initialization recognizes both daemon group state with a
48-byte epoch authenticator and pre-join phone KeyPackage state at epoch zero with an intentionally
empty authenticator. In both cases final publication still requires AEAD decryption, durable-manifest
validation, typed daemon or phone loading, external-key reconciliation, and rollback reconciliation.

`discard_interrupted_creation` acquires the lifecycle claim before inspecting either path. It removes
a marker with no database or a bound `initializing` database only when generation, rollback, epoch,
authenticator, pending erasure, encrypted state, operations, outbox, and accepted-message tables all
prove that no cryptographic state committed. Complete committed state is recovered by normal open,
not deleted. Cleanup rejects `ready`, committed, malformed, unreadable, unsupported, mismatched,
symlinked, or otherwise unprovable databases without calling session-key destruction or deleting the
database. The claim remains held through key destruction, database and marker deletion, and parent
synchronization. A competing creator, opener, or cleanup receives `LifecycleBusy`. The lock file is
never used as lifecycle evidence and is deliberately retained; the operating system releases its
claim automatically when a process exits. A consumed anchor requires a fresh crypto session ID.
Creation otherwise rejects an existing file, and opening rejects a missing file. Paths are
canonicalized, symlink roots and database files are rejected, and Unix directories and files are
restricted to modes `0700` and `0600` respectively.

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

## Browser transaction equivalence

The transaction order above is normative for synchronous native stores. IndexedDB transactions
cannot safely remain active across arbitrary asynchronous OpenMLS and WebCrypto work because they
become inactive when control returns to the event loop without another queued request. The browser
adapter therefore uses the serialized prepare-and-compare protocol in
[`docs/architecture/e2ee-platform-bindings.md`](../../docs/architecture/e2ee-platform-bindings.md).

While the worker and lock callback remain alive, the reviewed adapter uses an exclusive per-session
Web Lock to prevent another cooperative same-origin endpoint from becoming the writer. One short
strict IndexedDB read-write transaction then compares the generation and rollback evidence and
atomically writes the complete successor state, operation result, and exact outbox or
accepted-message record. Nothing is sent and no plaintext is released before the transaction
completes. Conflict, abort, worker loss, or ambiguous completion destroys transient state and reloads
only committed state. The internal pending mutation is not part of the public platform ABI and is
not a reusable transaction handle. Suspension, freezing, restoration, and termination behavior
must be verified separately in every supported browser.

Session 50.5 implements this sequence in the separate browser test artifact with real IndexedDB,
Web Locks, WebCrypto, and dedicated workers. Its versioned stores, wrapped-DEK lifecycle, recovery
rules, fault evidence, and browser limitations are documented in
[`BROWSER_STORAGE.md`](BROWSER_STORAGE.md). Test-only persistence constructors and rollback evidence
are excluded from the production WASM, JavaScript exports, declarations, and tarball.

This equivalence does not relax rollback detection. IndexedDB, persistent-storage permission,
WebAuthn counters, and a non-extractable WebCrypto key do not supply an independent monotonic anchor.
The approved hosted witness protocol supplies that anchor, but browser pairing remains disabled
until its production adapter, witness integration, artifact isolation, and runtime evidence pass.

## Rollback-witness transition format

The shared core now defines the transport-independent witness protocol and the acyclic successor
format selected by the production storage RFC. The inner payload contains the complete successor
state and the exact committed operation result. The core seals that payload first, calculates its
SHA-384 commitment from the exact sealed bytes and authenticated clear header, signs one canonical
register or advance request with the endpoint credential, and seals that exact request and its hash
in a separate outer envelope. The envelopes use the same fresh state DEK with distinct
random nonces and domain-separated associated data. Swapping or modifying either envelope fails
authentication or commitment reconstruction.

A prepared transition has no witness-request accessor. Only the storage adapter may convert it to a
pending witness operation after atomically committing the sealed successor record. The exact result
has no independently replaceable encoding outside the authenticated inner envelope. The pending
operation exposes only the immutable signed request. It releases the exact
result only after current-key activation, validation of a unanimous certificate from the three
pinned distinct replicas, and obsolete-key erasure. Recovery decrypts the committed envelopes and
returns the same result, request bytes, nonce, signature, and request hash.

Endpoint reconciliation compares the authenticated local committed and last-confirmed heads with a
fresh unanimous witness state. It distinguishes clean state, exact pending resend, accepted-response
loss, stale local state, commitment conflicts, impossible local advancement, witness rollback,
missing lineages, revocation, immediate and historical forks, and mixed or inconsistent replicas.
Terminal outcomes persist as quarantine or revocation, leave pending operations blocked, and never
fast-forward private state from witness metadata. A matching fresh reconciliation produces one
private mutation authorization bound to the confirmed head, while a fresh confirmed absent lineage
produces one initial-registration authorization. Preparation consumes it. Restart, witness
unavailability, resend, accepted-operation recovery, conflict, revocation, and quarantine hold no
mutation authority.

The current native and browser test adapters still use their pre-production injected anchor paths.
The shared witness state machine does not make those constructors production-ready. Focused later
changes must wire this format into each platform transaction and remove every legacy test anchor
from production artifacts before enabling endpoint creation.

## Session 50.2 pairing records

The redb table schema remains version 1. Pairing state is stored as separately versioned records
inside the encrypted provider image, so no nonce, claim, KeyPackage, Welcome, signer, or private
KeyPackage material is added to an unencrypted redb table. The existing durable manifest
authenticates the encrypted image and the pairing operation records added to `operations_v1`.
Older active-group databases remain readable. A pairing operation requires its corresponding strict
version 1 encrypted record; missing, malformed, unknown-version, or inconsistent state fails closed.
An older reader cannot interpret the new pairing operation discriminator and fails closed rather
than silently treating the state as an older form.

The daemon record contains the canonical invitation and hash, original nonce, identity and profile
binding, issue and exclusive expiry times, rollback-safe last observed time, lifecycle state, up to
five distinct failed-claim hashes and terminal results, pending and accepted claim binding,
reservation intent, fresh group ID, exact Welcome, activation state, and active-pair lifecycle. The
device record contains the complete invitation binding, per-pair signer and KeyPackage private state
through the provider image, exact KeyPackage and claim bytes, the independently observed invitation
and Welcome deadlines, exact Welcome and activation state, group ID, re-pair exclusions, and
active-pair lifecycle. Neither record contains a relay route. Device pre-join creation samples its
clock once and uses that observation for invitation validation, KeyPackage lifetime, claim creation,
endpoint metadata, and the rollback baseline. Local invitation expiry records the actual observation
time. A subsequently received Welcome may revive that local state only when the Welcome is still
within its independent authenticated deadline and passes the complete join validation.

A daemon invitation and a device pre-join state are valid committed initialization forms at epoch
zero with an empty epoch authenticator. Their creation operation, encrypted state, generation,
rollback counter, wrapping-key activation, and anchor advancement must all commit before invitation
or claim bytes are returned. Open authenticates and strictly decodes the record before completing an
interrupted `ready` publication. Cleanup never converts an ambiguous pre-join database into a
reusable empty store.

Claim failure, confirmation, reservation, group creation, Welcome publication, join, activation,
replacement, epoch-ready, removal, revocation, and reset use the ordinary immediate-durability,
two-phase transaction path. Every OpenMLS call occurs after the transaction starts. Exact outbound
bytes and the complete successor provider image commit together. Welcome-sensitive operations check
the exclusive Welcome deadline in their transaction before disclosing bytes or accepting activation.
A joined device remains in `AwaitingActivation` after preparing exact activation ciphertext. It
becomes active only after durably applying typed evidence that the daemon accepted the authenticated
activation before the Welcome deadline. A device remains behind the `WaitingForEpochReady` barrier
until it durably applies typed evidence of the daemon's accepted epoch-ready message. Revocation may
preempt a pending replacement. Expiry and terminal state are persisted, and the typed re-pair
operation enforces a fresh device ID, crypto
session ID, KeyPackage, and group ID. Hosted services may later store only reviewed opaque artifacts
and typed reservation values.

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
| After marker creation but before a provable schema | Reopen and cleanup reject the malformed database without deleting its file or external keys |
| After schema commit but before any cryptographic state commits | Reopen reports `InitializationIncomplete`; explicit cleanup verifies the binding, `initializing` lifecycle, and absence of committed state before removing the marker, file, and session key records |
| After cryptographic state commits but before the `ready` lifecycle commit | Cleanup refuses destruction; open authenticates and reconciles the committed state, commits `ready`, and finishes publication |
| After the `ready` lifecycle commit but before marker removal | Open authenticates and reconciles committed state, removes only the stale marker, synchronizes the parent directory, and preserves exact operation results, epoch state, database contents, and external keys |
| While another creator, opener, or cleanup holds the lifecycle claim | The competing operation fails closed with `LifecycleBusy`; no path or external key record is changed |

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
database. On macOS, `macos_keychain::MacOsKeychainEnvelopeKeyStore` implements this contract with
non-synchronizable, `AccessibleWhenUnlockedThisDeviceOnly` generic-password items in the
data-protection Keychain. Its fixed secret record stores format and platform versions, session and
key IDs, the SHA-384 authenticated-context hash, lifecycle, and the exact 32-byte DEK. Public
service, account, and label attributes contain only the Axl service identifier plus format version,
session ID, key ID, and lifecycle. It disables authentication UI, rejects root and processes outside
the active console login, verifies deletion by an exact read, reports no hardware backing, and has
no fallback. The injected `RollbackAnchor` keeps monotonic state outside the database snapshot
domain. Both dependencies must report availability or the adapter fails closed.

The implementation uses the pinned libcrux provider's CSPRNG and AES-256-GCM. It defines no KDF or
new cryptographic primitive. A fresh 256-bit DEK protects each successor state image. AAD binds the
schema, profile revision, crypto session, generation, rollback counter, and epoch.

Deletion of an obsolete wrapping record makes the old encrypted image unusable only within the
security properties of the future platform key implementation. This implementation does not claim
forensic erasure from redb page reuse, file deletion, checkpointing, compaction, or filesystem
operations. Filesystem snapshots, backups, crash dumps, storage-controller caches, and physical
media are excluded. Session 50 evaluates browser WebCrypto and IndexedDB behavior without claiming
that they supply an independent rollback anchor. The macOS Keychain store is implemented but remains
unwired and unsupported pending the required signed, unsigned, lock, login, backup, installer,
arm64, and native x64 runtime evidence. Linux and
Windows stores, Android Keystore, generated mobile SDKs, and production mobile applications remain
later work.

The monotonic anchor detects a database older than the last anchored commit. The peer epoch
authenticator detects a divergent epoch once authenticated peer evidence is available. Rollback of
the database and anchor together, rollback before anchor advancement becomes durable, and loss of
all peer evidence are not claimed to be detectable.
