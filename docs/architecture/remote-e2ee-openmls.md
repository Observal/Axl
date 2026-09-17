<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Remote endpoint E2EE with OpenMLS

Status: Session 40B native durable adapter implemented; Session 50 platform reconciliation pending RC review; platform and production release gates remain closed

Reviewed: 2026-09-16

## Decision and scope

Axl reserves one transport-independent Rust endpoint core for remote E2EE. It uses one two-member MLS group per remote device and daemon installation. The daemon is the sole commit creator. A remote device creates its own replacement leaf and sends a self-Update proposal.

This RFC fixes the Axl behavior that Session 40 and later implementation must satisfy. It adds no dependency, does not approve any dependency for production release, and does not enable remote access. It approves the exact Axl-private profile and OpenMLS/libcrux candidate graph to enter Session 40 after this decision receives human approval and merges into `RC`.

The transport and authority boundaries do not change:

```text
remote client
  -> application-level MLS ciphertext
  -> ciphertext-only relay
  -> daemon endpoint
  -> authenticated paired-device identity
  -> daemon authorization and durable acceptance
  -> canonical session behavior
```

TLS protects network hops. MLS protects application content end to end. Successful MLS authentication identifies a paired device. It does not authorize an operation.

## Profile registry

The profile identifier is the ASCII string `axl-e2ee-mls-pq-v1`. Pairing and migration authenticate both that identifier and profile revision `1`. There is no algorithm negotiation within revision 1.

| Property | Revision 1 binding |
| --- | --- |
| Profile ID | `axl-e2ee-mls-pq-v1` |
| Profile revision | `1` |
| MLS base protocol | RFC 9420 as implemented by the pinned OpenMLS source |
| Cipher suite name | `MLS_128_MLKEM768X25519_AES256GCM_SHA384_Ed25519` |
| OpenMLS suite value | `0x004e` |
| OpenMLS KEM implementation | `XWingDraft06` |
| Confidentiality components | ML-KEM-768 plus X25519 in the pinned upstream implementation |
| MLS KDF and transcript hash | HKDF-SHA-384 and SHA-384 in the pinned upstream implementation |
| AEAD | AES-256-GCM |
| Authentication signature | Ed25519 |
| MLS encoding | RFC 9420 TLS Presentation Language encoding produced by the pinned source |
| Credential type | MLS `basic` credential containing the Axl credential described below |
| Library | `openmls` 0.9.0, crates.io checksum `b6b08d90fc020cb5354d5f08ca17711b84c82e2bcc7331753fd94f000d99a8c8` |
| Provider | `openmls_libcrux_crypto` 0.4.0, crates.io checksum `41e6367fb30f91f21e4d30f4f58a8d3b41f96f55c3e4b5acfa1d6d18c9dd4855` |
| Upstream source | OpenMLS tag `openmls-v0.9.0`, commit `3a3e35de3feeca8f6605143c464d5452ae584d43` dated 2026-08-25 |
| Enabled Cargo features | `openmls/draft-ietf-mls-pq-ciphersuites`; `openmls/js` only for browser/WASM; `openmls_libcrux_crypto/draft-ietf-mls-pq-ciphersuites`; default features disabled |
| Toolchain and graph lock | Exact Rust toolchain, Cargo version, target components, and committed `Cargo.lock` selected and recorded by Session 40 |
| OpenMLS storage contract | `openmls_traits` 0.6.0, storage provider version 1 |

Axl is not defining, patching, or assigning a cipher suite. Both endpoints use the same exact pinned upstream OpenMLS implementation. The Axl profile binds its private interoperability contract to those bytes and behaviors.

This profile does not claim to implement or interoperate with `draft-ietf-mls-pq-ciphersuites-06`, any final IETF PQ MLS specification, or any implementation selected only by the same suite name. The draft is research context, not part of revision 1's wire contract.

The cryptographic meaning remains deliberately split:

- Confidentiality uses the pinned upstream hybrid ML-KEM-768 plus X25519 construction. Revision 1 never accepts a classical-only KEM or epoch.
- Authentication is Ed25519 and is classical. Revision 1 does not provide post-quantum signatures.

Every pairing invitation, claim, KeyPackage reservation, Welcome activation, persisted group record, and migration transcript binds the profile ID and revision. Any incompatible source, suite value, KEM construction, algorithm, encoding, credential, AAD, state schema, feature, or behavior-fixture change requires a new authenticated profile revision or profile ID and an authenticated migration or re-pairing. Toolchain and lockfile changes require dependency review and complete compatibility fixtures; they require a new profile revision only when they change wire bytes, persisted state, security behavior, or another profile binding. Stored state is never silently reinterpreted under another binding.

## Pairwise group and identity mapping

A group has exactly two leaves:

```text
daemon installation <-> one remote device
```

Every additional phone or browser gets an independent group. An offline device cannot block another device's epoch progress. Removal or reset affects one pair.

The durable mapping is one-to-one:

```text
(account_id, installation_id, device_id, profile_id, profile_revision)
  -> crypto_session_id
  -> MLS group_id
  -> daemon credential fingerprint
  -> device credential fingerprint
  -> active epoch and epoch authenticator
```

Identifiers have these forms:

- `installation_id`, `device_id`, and `crypto_session_id` are canonical 16-byte UUIDv7 values.
- `group_id` is 32 random bytes generated by the daemon. It is never reused.
- A credential fingerprint is `SHA-384(credential_tls_bytes)`.
- An Axl basic credential is the canonical TLS encoding of version `1`, role (`daemon` or `device`), account UUID, installation UUID, device UUID, profile ID, profile revision, and Ed25519 public verification key. The daemon credential uses the all-zero device UUID; a device credential may not.

The daemon leaf uses the installation's Ed25519 identity. The device leaf uses a new per-pair Ed25519 identity. Private keys remain at their endpoint. Plaintext identifiers cannot override the credential and group mapping.

## QR pairing and possession proof

The QR payload is canonical TLS encoding, not JSON. It contains:

```text
struct {
  uint16 version = 1;
  opaque profile_id<1..255>;
  uint16 profile_revision = 1;
  opaque account_id[16];
  opaque installation_id[16];
  opaque crypto_session_id[16];
  opaque daemon_credential<1..512>;
  uint64 issued_at_ms;
  uint64 expires_at_ms;
  opaque invitation_nonce[32];
  opaque daemon_signature<64>;
} PairingInvitation;
```

`daemon_signature` is Ed25519 over `"Axl pairing invitation v1" || TLS(fields before daemon_signature)`. The invitation expires after 10 minutes, is single-use, and is cancelled after five distinct eligible failed claims under the accounting rules below. `invitation_nonce` is a 256-bit random possession secret. It must not enter URLs, logs, metrics, analytics, or canonical events. A QR image is therefore a short-lived credential and the UI must say so.

The device validates the profile, times, expected signed-in account, installation name shown by the local daemon, daemon credential, and signature. It then generates its credential and KeyPackage. The claim is canonical TLS encoding, not JSON:

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

This completes a previously unspecified, unimplemented revision 1 transcript. No deployed encoding, checked-in claim fixture, or persisted pairing state is being changed. After Session 50 PR 50.1 commits canonical fixtures, an incompatible transcript change requires a new authenticated profile revision.

`device_signature` is excluded from its own signed prefix and is:

```text
device_signature = Ed25519.Sign(
  device_private_key,
  "Axl pairing claim v1" ||
  SHA-384(complete PairingInvitation TLS bytes) ||
  SHA-384(KeyPackage TLS bytes) ||
  SHA-384(device credential TLS bytes)
)
```

The daemon accepts a claim only when it has the original nonce, all hashes match, the device signature validates, the invitation is live and unconsumed, and the user confirms the device name and a 12-digit comparison value. That value is the first 39 bits of `SHA-384("Axl pairing compare v1" || complete PairingInvitation TLS bytes || complete PairingClaimV1 TLS bytes)`, interpreted as an unsigned big-endian integer and rendered with leading zeroes as four three-digit groups. The comparison value is a UX check, not an additional cryptographic primitive or authorization grant.

Account authentication alone cannot complete pairing. The control plane sees only identifiers, expiry, the nonce hash, credentials, signatures, and opaque KeyPackage or Welcome bytes. It never receives the QR nonce or private MLS state.

Before a group exists, the daemon owns an encrypted pending-invitation record in the same per-session transactional store that will own its group. The record contains the original nonce, invitation hash, profile and identity binding, expiry, a bounded set of at most five distinct eligible failed-claim hashes and terminal results, and issued, pending, confirmed, consumed, cancelled, or expired state. It commits before QR bytes are returned. This is endpoint state, not canonical session state or hosted rendezvous state.

Oversized, non-canonical, wrong-version, wrong-profile, wrong-session, unknown, expired, consumed, and cancelled requests do not count. Only a canonically decoded claim matching the invitation identifiers and nonce hash is eligible. The daemon records the hash of the complete canonical claim bytes with its terminal typed result. Repeating that failed claim returns the recorded result without incrementing again. The fifth distinct eligible failed claim commits cancellation. Group creation, the complete successor provider image, exact Welcome bytes, accepted claim hash and result, and invitation consumption commit atomically. Repeating the accepted claim returns the exact stored Welcome. A different claim after confirmation or consumption fails closed without changing the accepted result.

The device owns its pre-join Ed25519 signer, KeyPackage private material, exact KeyPackage and claim bytes, invitation hash, profile binding, expiry, and operation records in its per-session transactional store. It commits that state before publishing the claim. A retry publishes the same bytes. Expiry, cancellation, protected-state loss, or an ambiguous Welcome without a durable exact copy requires a fresh invitation, device ID, crypto session ID, KeyPackage, and group ID. Detailed ownership and transitions are specified in [Endpoint E2EE platform bindings](e2ee-platform-bindings.md).

## KeyPackage and Welcome lifecycle

A device creates exactly one KeyPackage for one invitation. The surrounding signed pairing transcript binds it to `axl-e2ee-mls-pq-v1`, revision `1`, the selected cipher suite, the device basic credential, and capabilities needed by this profile.

Limits and lifecycle:

| Artifact | Limit | Lifetime and consumption |
| --- | ---: | --- |
| Pairing invitation | 2 KiB | 10 minutes, one successful claim |
| Pairing claim | 17,320 bytes | exact-byte retry until accepted, rejected, cancelled, or expired |
| KeyPackage | 16 KiB | 10 minutes, reserved atomically for 60 seconds, consumed once by the daemon |
| Welcome | 16 KiB | 10 minutes, byte-identical retry until device activation acknowledgement |

A KeyPackage reservation binds account, installation, device, crypto session, profile ID, profile revision, credential fingerprint, and KeyPackage hash. One concurrent reservation wins. Failed group creation releases the reservation only while it remains live and no Welcome exists. Successful group creation consumes it permanently. A consumed, expired, malformed, wrong-profile, or wrong-credential KeyPackage is deleted and cannot be retried.

The daemon creates a fresh group ID, adds the reserved KeyPackage, persists the group transition and exact Welcome bytes atomically, and only then publishes the Welcome. The device validates the complete pairing transcript, profile, group ID, daemon credential, member count of two, and its own leaf before persisting the joined state. It returns an MLS-protected activation acknowledgement. The control plane deletes the Welcome after that acknowledgement or expiry. Expiry or ambiguous state requires a new invitation and KeyPackage. KeyPackages and Welcomes never authorize daemon scopes.

## Canonical authenticated data

Every MLS private message sets authenticated data explicitly. The encoding is TLS Presentation Language encoding with fixed field order and minimal integer encodings:

```text
struct {
  uint16 aad_version = 1;
  opaque profile_id<1..255>;
  uint16 profile_revision = 1;
  opaque crypto_session_id[16];
  opaque group_id[32];
  opaque source_device_id[16];
  opaque destination_device_id[16];
  opaque installation_id[16];
  uint8 message_class;
  opaque logical_message_id[16];
  uint64 hosted_grant_generation;
} AxlMlsAadV1;
```

The maximum encoded AAD is 512 bytes. IDs are raw canonical bytes. Strings are UTF-8 and profile IDs are ASCII. An endpoint reconstructs expected AAD from durable local mapping and compares it byte for byte before releasing plaintext. The sender cannot select identity fields from plaintext.

Relay `attempt_id` and ephemeral route IDs are excluded. Retries retain identical MLS bytes while those transport values change.

## Message classes and bounds

| Value | Class | Direction | Plaintext maximum | Ordering |
| ---: | --- | --- | ---: | --- |
| 1 | `application_request` | device to daemon | 60,000 bytes | durable outbox, daemon acceptance required |
| 2 | `application_delivery` | daemon to device | 60,000 bytes | cursor-resumable, re-encrypt after epoch sync |
| 3 | `update_proposal` | device to daemon | 16 KiB | before commit, exact retry |
| 4 | `commit` | daemon to device | 16 KiB | highest priority, exact retry |
| 5 | `epoch_ready` | device to daemon | 2 KiB | highest priority, exact retry |
| 6 | `pair_activation` | either direction | 2 KiB | pairing only |
| 7 | `resync_control` | either direction | 2 KiB | no application authority |

The complete relay payload remains at most 65,497 bytes. The endpoint rejects an MLS envelope that exceeds this value before allocation or parsing. It also bounds decoded TLS vectors, credentials to 512 bytes, AAD to 512 bytes, and the plaintext limits above. Attachments are not part of this profile and require a later profile and key-schedule review.

Control classes are processed before application delivery, but the relay remains opaque and supplies no semantic priority. The endpoint maintains separate bounded queues. There is no durable cloud mailbox.

## Commit ownership and epoch barrier

Only the daemon creates commits. A device that needs a new leaf generates the private replacement leaf locally and sends a signed MLS self-Update proposal. The daemon validates the proposal, rejects proposals that change identity or profile, optionally adds its own update, and creates the one successor commit.

Each pair follows:

```text
ACTIVE(E)
  -> DRAINING(E)
  -> COMMIT_PERSISTED(E -> E+1)
  -> WAITING_FOR_EPOCH_READY(E+1)
  -> ACTIVE(E+1)
```

The daemon stops accepting new old-epoch mutations, drains accepted mutations to `daemon_accepted` or a typed terminal result, and atomically persists next MLS state plus exact commit bytes. It sends those bytes until acknowledged. The device atomically applies the commit and persists its next state, then sends:

```text
struct {
  uint16 version = 1;
  opaque profile_id<1..255>;
  uint16 profile_revision = 1;
  opaque crypto_session_id[16];
  opaque group_id[32];
  opaque commit_id[48];
  uint64 target_epoch;
  opaque epoch_authenticator[48];
} EpochReadyV1;
```

`commit_id` is `SHA-384(exact_commit_bytes)`. The receipt is an MLS application message with class `epoch_ready`. The daemon compares every field and the expected epoch authenticator in constant time where applicable. A duplicate commit causes a byte-identical receipt retry, not a second apply. A duplicate valid receipt is harmless. New-epoch application ciphertext cannot pass the commit barrier in either direction.

Updates serialize per crypto session. There is no global MLS lock.

## Epoch windows

The fixed initial limits are:

```text
past receive-only epochs: 2
past epoch maximum age:   5 minutes from local commit persistence
future epochs buffered:   only E+1
future message count:     32 per crypto session
future ciphertext bytes:  512 KiB per crypto session
future wait:              10 seconds
```

Past epochs never permit sending. Current revocation, hosted generation, scope, policy, replay, and idempotency checks still run after old-epoch decryption. A future application message triggers one bounded commit retransmission request. Commits and epoch-ready receipts have reserved queue capacity and cannot be displaced by application traffic.

Too-old, too-far-future, missing-commit, wrong-profile, wrong-suite, and authenticator mismatch errors are typed and bounded. They quarantine the pair for explicit resynchronization or re-pairing. There is no silent reset or downgrade.

## Update policy

A hybrid update is due at the earliest of:

- 24 hours since the last successful hybrid commit while both endpoints are reachable;
- 1,000 sent plus received MLS application messages in the current epoch;
- reconnect after at least 15 minutes without an authenticated endpoint exchange;
- device membership, credential, local grant, hosted grant, or revocation change;
- suspected endpoint or state exposure;
- before a policy-marked sensitive action when the last successful hybrid update predates that action's authorization context.

The 24-hour and message-count triggers are routine. Routine work may batch until both endpoints are reachable. Low-power or background state may defer a routine update for at most seven days, after which remote mutation is blocked until update completion. Observation may continue only if current policy allows it and the epoch is otherwise valid.

Reconnect, membership, credential, revocation, suspected-exposure, and sensitive-action triggers are security-required. A security-required action is blocked until the update and epoch-ready barrier complete. Low-power mode never changes the suite, removes ML-KEM, or enables a classical fallback.

The thresholds are profile behavior, not security proofs. Gate D must measure them on representative phones before release. Changing them requires a reviewed profile-policy revision and compatible behavior fixtures.

## Atomic state and ciphertext persistence

Every state-advancing send is one logical storage transaction:

```text
BEGIN IMMEDIATE / strict read-write transaction
  compare stored generation and rollback counter
  write complete next OpenMLS state
  insert exact ciphertext, logical message ID, class, epoch,
    stable crypto_session_id, and retry state
  update receive replay or send generation state
COMMIT DURABLY
```

A synchronous native provider begins its physical write transaction before calling OpenMLS and supplies transaction-local provider state. IndexedDB cannot safely remain active across arbitrary asynchronous browser work. The reviewed browser equivalent therefore holds an exclusive per-session Web Lock, authenticates one committed snapshot, performs one OpenMLS transition in a private worker, and then opens one short strict IndexedDB read-write transaction. That transaction rechecks the generation and rollback evidence and atomically writes the complete successor state, operation result, and exact ciphertext or accepted-message record. The pending mutation is internal to the binding and is never a public transaction handle. Any conflict, abort, worker loss, or ambiguous completion destroys the transient WASM endpoint and reloads only committed state. Full sequencing is specified in [Endpoint E2EE platform bindings](e2ee-platform-bindings.md).

Network transmission begins only after durable commit. A durable record stores `crypto_session_id`, never a relay route. Every attempt resolves the current route and creates a new transport attempt ID. A retry sends byte-identical ciphertext. It never calls MLS encryption again.

Any storage error or rollback invalidates the in-memory `MlsGroup` and all prepared handles. The endpoint closes the provider, reloads committed state, verifies the rollback counter and epoch authenticator, and only then permits another operation. The public core API returns immutable prepared envelopes and typed transaction outcomes. It never exposes mutable `MlsGroup` state.

Receive-side replay advancement and durable accepted-message identity commit before plaintext is released to daemon authorization or a client projection.

Session 40B implements this contract for native hosts with one redb database per
`crypto_session_id`. Every security-sensitive write explicitly uses immediate durability and
redb's two-phase commit mode. OpenMLS runs against transaction-local storage only after the write
transaction starts. The complete encrypted provider image and exact outbox or accepted-message
record then commit together. An AEAD-protected manifest authenticates every durable metadata table.
Initializing databases require explicit publication or cleanup, and marker presence alone never
proves that lifecycle. Creation, open recovery, and cleanup hold one exclusive OS-backed per-session
lifecycle claim across their complete filesystem transition; a competing operation fails closed and
a process exit automatically releases the claim. Cleanup is destructive only for a bound
`initializing` database with no committed cryptographic state. Open authenticates and publishes
complete committed `initializing` state instead of deleting it. A stale marker beside authenticated
`ready` state is removed only after current-key activation, durable-state authentication, anchor
reconciliation, and obsolete-key erasure complete in that order. Previous-epoch deadlines and
rollback-safe clock state survive restart.
Acknowledged idempotency and replay records have a 4,096-generation retry horizon; pending records
are never pruned, and outbox acknowledgement is durable. Only the safe durable daemon and phone
operations are public; the native provider, transaction handles, mutation staging, and fault
injector remain crate-private. Operations reconstruct the group from committed storage, and
uncertain commit recovery closes and reopens the database before consulting the authenticated
operation record. The schema and limitations are documented in
[`packages/e2ee/STORAGE.md`](../../packages/e2ee/STORAGE.md).
Browser persistence and secure platform key implementations remain Session 50 gates.

### Erasure boundary

Used message keys must be absent from the committed next state. Serialized state records are encrypted under per-state data-encryption keys. A superseded state's wrapping record is destroyed only after the successor transaction is durable. WAL, rollback journals, temporary files, crash dumps, exported diagnostics, and unencrypted backups must not retain plaintext state or wrapping keys.

This is a required design, not a completed claim. Static whole-database encryption with one long-lived key is insufficient because it leaves stale pages decryptable. Native and browser adapters must pass forensic-remnant and fault-injection tests and document platform backup and snapshot exclusions. Until they do, Axl makes no forward-secrecy claim for persisted-state compromise.

## Loss, fork, reset, migration, and re-pairing

- **Identity or group-state loss:** revoke the old device record when possible, quarantine remaining artifacts, create a new device ID, crypto session, group ID, invitation, KeyPackage, and grant. Never reconstruct missing secrets from hosted data.
- **Rollback:** a lower rollback counter, epoch, or unexpected authenticator quarantines the pair. Reload once from durable state. Persistent mismatch requires re-pairing.
- **Fork:** two valid successors, a commit hash mismatch, or epoch-authenticator mismatch quarantines both branches. No branch is selected automatically. Re-pair with a fresh group ID.
- **Local reset:** requires explicit user confirmation and revocation. It never preserves the old group ID or device credential.
- **Profile migration:** create a second pairwise group under the new profile. Authenticate the migration transcript inside the old group and require activation in the new group before revoking the old pair. If the old group is unavailable or suspect, use QR re-pairing. State is never decoded under a different profile.
- **Hosted artifact loss:** retry from endpoint durable state when exact bytes exist. Otherwise expire the pairing and start again. Hosted state is not a recovery copy of MLS secrets.

## Platform feasibility

| Platform | Evidence as of 2026-09-14 | Decision |
| --- | --- | --- |
| Node daemon | Rust crates support the native target. The external spike exercised two-member groups and SQLite reopen, but it is research only. Node FFI and crash-safe storage are untested. | Feasible in principle; blocked before production. |
| Browser/WASM | With Rust 1.96.0, `openmls` 0.9.0 plus `js`, the libcrux provider, and the required `getrandom` 0.2 `js` feature compile for `wasm32-unknown-unknown`. Web Crypto supplies a CSPRNG. IndexedDB can atomically update multiple records and offers a `strict` durability hint. While the worker and lock callback remain alive, the reviewed adapter uses an exclusive Web Lock to prevent another cooperative same-origin endpoint from becoming the writer. Suspension, freezing, restoration, and termination behavior must be verified separately in every supported browser. No reviewed browser API supplies the independent monotonic rollback anchor required by the native contract. | Session 50 must execute the core and persistence fault matrix in real browsers. Pairing and remote web remain disabled until an independent anchor or reviewed peer-witness design is approved. |
| Swift/iOS | A Rust static library and a reviewed binding are feasible in principle. Keychain can hold a wrapping key, but hardware backing and an independent monotonic rollback anchor are not assumed. | Swift bindings, binding generation, iOS packaging, secure storage, and device tests remain Phase 13. |
| Kotlin/Android | A Rust library can be called through a reviewed Android binding. Android Keystore can hold an AES wrapping key, but hardware properties vary and it is not a generic monotonic counter. | Kotlin bindings, JNI or another selected mechanism, Android packaging, secure storage, and device tests remain Phase 13. |

Browser/WASM compilation is sufficient to begin the shared Rust core in Session 40. Session 40 must keep persistence behind an Axl-owned platform-neutral transaction abstraction. The core must not depend exclusively on native SQLite. The abstraction must atomically persist advanced OpenMLS state with exact ciphertext, require discard and reload after rollback, and support native and browser adapters with the same typed outcomes.

Browser execution and persistence remain mandatory implementation and shipping gates assigned to Session 50. Session 50 must run OpenMLS in real browsers and prove the reviewed IndexedDB adapter across atomic state-plus-ciphertext commit, abort, crash, reload, exact-byte retry, rollback and epoch mismatch, storage loss and eviction, and Web Locks single-writer ownership. It must test Chrome, Firefox, Playwright WebKit, and actual Safari. Compile-only WASM and Playwright WebKit alone are not Safari evidence.

A non-extractable WebCrypto key stored through IndexedDB does not provide an independent monotonic rollback anchor. IndexedDB transactions and persistent-storage permission do not add that property. No supported pure-browser configuration currently satisfies the native `RollbackAnchor` guarantee. Browser pairing therefore remains disabled with `rollback_anchor_unavailable`, even after transaction feasibility tests pass, until an independent platform anchor or a separately reviewed authenticated peer-witness protocol is approved. Storage loss, eviction, or protected-key loss requires fail-closed re-pairing.

Browser revision 1 explicitly makes no forensic-deletion claim for browser profiles, backups, snapshots, caches, crash dumps, WASM linear memory after termination, or physical media. That non-claim does not relax live-state key deletion, transaction, rollback, or re-pairing requirements.

## Security claims and non-claims

After all implementation and review gates pass, this profile is intended to provide:

- end-to-end confidentiality and integrity against the relay and control plane;
- hybrid confidentiality when either ML-KEM-768 or X25519 retains its applicable security property, subject to the reviewed combiner and implementation;
- classical device authentication through Ed25519;
- unique MLS application keys and deletion of used live secrets;
- forward secrecy for message keys erased from live and recoverable persisted state, only within the approved storage threat model;
- classical post-compromise confidentiality recovery after a successful X25519-bearing update and epoch-ready barrier, after the attacker loses endpoint access;
- post-quantum confidentiality recovery after a successful ML-KEM-bearing update and epoch-ready barrier, after the attacker loses endpoint access;
- bounded replay rejection and explicit fork detection.

Axl does not claim:

- post-quantum authentication or signatures;
- final IETF interoperability or stable IANA code points;
- production security from an Internet-Draft or a successful compile;
- Signal compatibility, Double Ratchet, Triple Ratchet, or SPQR behavior;
- public-key ratcheting on every application message;
- recovery while malware still controls an endpoint;
- recovery of a stolen durable identity without revocation and re-pairing;
- protection from a compromised plaintext endpoint;
- deletion from device snapshots, backups, crash dumps, or forensic media until each platform threat model says so;
- security of the libcrux provider or Axl storage wrapper from the 2025 OpenMLS audit, because both were outside that audit's scope.

## Dependency and assurance decision

The candidate graph and obligations are recorded in [OpenMLS dependency decision](openmls-dependency-decision.md). The candidates are approved for implementation in Session 40, not for production release.

The SRLabs report version 1.2, dated 2026-03-11, reviewed OpenMLS through commit `a3402f2` from 2025-10-22. It excluded crypto and storage providers. It recorded one acknowledged low-severity state/storage desynchronization risk and accepted an informational unbounded-allocation risk. OpenMLS 0.9.0 commit `3a3e35d` and the libcrux provider are therefore outside that assurance scope. An independent review must cover the exact pinned source, enabled PQ feature, provider, Axl wrapper, parsers, bounds, and storage adapters.

The implementation and release gates are sequenced as follows.

Before Session 40:

1. Approve and merge this exact Axl-private profile definition.
2. Approve the candidate versions, complete license inventory, and narrow maintenance exception in the dependency decision.
3. Approve the platform-neutral transactional persistence contract above.
4. Preserve the security claims and non-claims in this RFC.

During Sessions 40 and 50:

1. Build the shared Rust core and commit its exact Rust toolchain and `Cargo.lock`.
2. Configure and run `cargo audit` and `cargo deny`, including the explicit time-bounded maintenance exception.
3. Implement native persistence and transaction fault injection in Session 40.
4. Implement Node and browser/WASM bindings and positive and negative fixtures in Session 50. Swift, Kotlin, C ABI, JNI, generated SDKs, mobile secure storage, and mobile applications remain Phase 13.
5. Complete browser persistence tests, keep browser pairing disabled while the rollback-anchor gate is unresolved, and package all required license texts and notices.
6. Propose the smallest native storage adapter and obtain approval before adding any production storage dependency beyond the approved OpenMLS/libcrux graph. Select browser-specific dependencies separately in Session 50.

Before production release:

1. Complete the platform interoperability matrix and mobile and browser runtime measurements.
2. Review the provider, wrapper, bindings, native and browser storage, operational recovery, and side-channel posture.
3. Obtain independent implementation review.
4. Verify final MPL-2.0 and all third-party packaging and notice obligations.
5. Pass every native, browser, interoperability, fault-injection, recovery, and release gate.

Completed platform bindings are not prerequisites for Session 40. Session 40 creates the shared core those bindings consume.

AGPL libsignal and SPQR implementations must not be linked, copied, translated, vendored, or added to the lockfile.

## Gate result

Session 30 approves revision 1 of the exact Axl-private OpenMLS profile for implementation. It makes no IETF draft-06 interoperability claim. OpenMLS 0.9.0 and `openmls_libcrux_crypto` 0.4.0 are approved to enter Session 40 under exact pinning, committed-lock, audit, and maintenance-exception requirements. This session adds no production dependency or production E2EE.

Browser/WASM remains mandatory and is assigned to Session 50. Remote web stays disabled until its browser execution and persistence tests pass. Production release remains fail-closed until all browser, native, interoperability, packaging, recovery, and independent-review gates pass.

Session 40 may begin after this RFC and the dependency decision receive human approval and merge into `RC`.

## Primary sources

- [RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html)
- [`draft-ietf-mls-pq-ciphersuites-06`, non-binding research context, 2026-07-21](https://datatracker.ietf.org/doc/html/draft-ietf-mls-pq-ciphersuites-06)
- [OpenMLS 0.9.0 release](https://blog.openmls.tech/posts/2026-08-25-0.9.0-release/)
- [`openmls` 0.9.0 crates.io metadata](https://crates.io/api/v1/crates/openmls/0.9.0)
- [`openmls_libcrux_crypto` 0.4.0 crates.io metadata](https://crates.io/api/v1/crates/openmls_libcrux_crypto/0.4.0)
- [OpenMLS persistence requirements](https://book.openmls.tech/user_manual/persistence.html)
- [SRLabs OpenMLS security assessment v1.2](https://blog.openmls.tech/SRL-OpenMLS_security_assurance_assessment.pdf)
- [Indexed Database API 3.0](https://www.w3.org/TR/IndexedDB-3/)
- [MDN `IDBTransaction`](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction)
- [MDN `Crypto.getRandomValues`](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues)
- [Rust `wasm32-unknown-unknown` support](https://doc.rust-lang.org/nightly/rustc/platform-support/wasm32-unknown-unknown.html)
- [SQLite WASM persistence](https://sqlite.org/wasm/doc/trunk/persistence.md)
- [Apple Keychain key storage](https://developer.apple.com/documentation/cryptokit/storing-cryptokit-keys-in-the-keychain)
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore)
