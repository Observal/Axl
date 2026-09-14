<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Remote endpoint E2EE with OpenMLS

Status: proposed for architecture and security review

## Purpose

This document selects the provisional endpoint-E2EE direction for Axl remote control. It replaces the earlier PQXDH plus Triple Ratchet proposal. It does not approve production dependencies, enable remote access, or make a release security claim.

The transport and daemon boundaries remain unchanged:

```text
remote client
  -> application-level encrypted envelope
  -> ciphertext-only relay
  -> daemon endpoint
  -> authenticated device identity
  -> daemon authorization and durable acceptance
  -> canonical session behavior
```

TLS protects each network hop. OpenMLS protects application content end to end. Successful decryption authenticates a paired device but never authorizes an operation by itself.

## Proposed profile

The first reviewed implementation should use one Axl-versioned profile:

```text
profile ID:       axl-e2ee-mls-pq-v1
MLS library:      OpenMLS 0.9.0, exactly pinned
crypto provider:  openmls_libcrux_crypto 0.4.0, exactly pinned
cipher suite:     MLS_128_MLKEM768X25519_AES256GCM_SHA384_Ed25519
confidentiality:  hybrid ML-KEM-768 and X25519
signatures:       Ed25519
```

This profile provides hybrid post-quantum confidentiality and classical authentication. It does not provide post-quantum signatures.

The IETF post-quantum MLS suite is draft material. The profile ID binds the exact draft revision, OpenMLS and provider versions, cipher suite, encoding, credential format, AAD format, storage schema, and behavior fixtures. An incompatible change requires a new Axl profile and an authenticated migration or re-pairing. An implementation must not silently reinterpret persisted state or accept a classical-only epoch.

Production dependency addition remains blocked on a focused dependency and license review. The feasibility spike is evidence, not production code.

## Group topology

Axl uses one two-member group for each remote-device and daemon-installation pair:

```text
phone A <-> daemon installation: group A
phone B <-> daemon installation: group B
browser C <-> daemon installation: group C
```

This topology keeps an offline or updating device from blocking another device. Revocation and re-pairing affect one pair. Axl does not initially create one group containing every remote device.

Group membership does not grant daemon scope. Device grants remain independent daemon authority records.

## Endpoint ownership

Each endpoint generates and retains its private identity, signing, leaf, and group secrets. The control plane and relay receive no private cryptographic state.

The remote device owns its replacement leaf private key. It sends a signed MLS self-Update proposal containing only public update material. The daemon must not generate or learn the remote device's replacement private key.

The daemon is the only MLS commit creator. It validates pending proposals, may add its own update, creates one ordered commit, and persists that transition. Remote devices do not independently create competing commits.

This rule prevents two valid successors to one epoch. Any authenticator mismatch or incompatible successor is a fork or corruption and fails closed.

## Pairing and asynchronous establishment

The proposed establishment flow is:

1. The daemon creates a time-bounded pairing invitation containing non-secret identifiers and transcript commitments.
2. The remote device validates the QR invitation and binds it to the expected account, installation, daemon identity, and Axl profile.
3. The remote device creates its credential and one bounded OpenMLS KeyPackage.
4. The control plane stores the KeyPackage as opaque bounded bytes for the intended installation.
5. The daemon consumes the intended KeyPackage once, creates the pairwise group, and produces a Welcome.
6. The Welcome is delivered as opaque ciphertext through the approved rendezvous or relay path.
7. Both endpoints verify the pairing transcript, group identity, peer credential, and profile before activating the pair.
8. The daemon creates the local grant. Hosted state may narrow that grant.

The final RFC must define invitation expiry, possession proof, one-use reservation, simultaneous claims, transcript encoding, device naming, reset, and user-visible comparison or confirmation. Account authentication alone cannot complete pairing.

## Epoch transition

An active pair follows this state machine:

```text
ACTIVE(E)
  -> DRAINING(E)
  -> COMMIT_PERSISTED(E -> E+1)
  -> WAITING_FOR_EPOCH_READY(E+1)
  -> ACTIVE(E+1)
```

Rules:

1. Stop accepting new old-epoch mutations for that pair.
2. Drain old-epoch mutations through daemon acceptance or an explicit terminal state.
3. Commit local MLS state advancement and exact commit bytes in one transaction.
4. Send the exact persisted commit bytes.
5. The remote endpoint applies and persists the commit atomically.
6. The remote endpoint sends an encrypted `epoch-ready` receipt binding the profile, group, commit ID, target epoch, and epoch authenticator.
7. The daemon compares the expected authenticator before enabling new-epoch application sends.

A lost commit causes byte-identical retransmission. A lost receipt causes the receiver to recognize the already-applied commit and resend the receipt without applying the commit twice. Application ciphertext for epoch `E+1` must not overtake its commit barrier.

Updates are serialized per pairwise group, not under a global lock.

## Update policy

Application messages use the MLS secret tree. The epoch encryption secret derives a sender-specific leaf secret, which feeds separate handshake and application hash ratchets. Each ratchet generation derives a one-use key and nonce and then advances one way. This chain-like symmetric ratchet is not Signal's Double Ratchet and does not perform X25519 or ML-KEM for each message. ML-KEM runs during pairing and update commits.

The first policy should trigger a hybrid update at the earliest of:

- approximately 24 hours while both endpoints are reachable
- 1,000 application messages
- a significant reconnect
- a membership, credential, or revocation event
- suspected state exposure
- before a sensitive operation when policy requires fresh recovery

Routine updates wait while that device is offline. On reconnect, the pair resumes its existing valid epoch, drains accepted work, and performs a required hybrid update before policy-marked sensitive actions.

Low-power or background operation may defer a routine update. It must not downgrade the suite. A security-required action remains blocked until the update completes.

These thresholds are provisional and require real mobile battery, thermal, and latency measurements.

## Transactional state and exact retries

Every state-advancing send follows one logical transaction:

```text
BEGIN
  persist next OpenMLS state
  insert exact ciphertext and stable logical destination into outbox
COMMIT
```

Network transmission begins only after commit. A rollback invalidates the in-memory group object; the endpoint reloads committed state before another operation.

A retry reuses the exact stored ciphertext and encrypted request identity. It creates a new relay transport attempt ID and resolves the peer's current ephemeral route at attempt time. Durable cryptographic or outbox state must not retain an ephemeral relay route as the destination identity.

Receive-side replay state and durable accepted-message identity advance together before plaintext is released to daemon authorization or client projection.

The committed next state contains the next sender-ratchet generation and must not retain the used message key. The outbox stores ciphertext, not that key. Logical deletion inside the serialized MLS state is insufficient if an older plaintext state remains recoverable from SQLite pages, a write-ahead log, temporary files, crash dumps, backups, or platform snapshots. The storage review must therefore define the exact at-rest encryption and cryptographic-erasure boundary, test rollback and forensic remnants, and state which snapshot or backup attackers are outside the claim. Static full-database encryption alone does not erase an old message secret from stale database pages when the same database key can still decrypt them.

The production adapter must not expose mutable `MlsGroup` internals. It should expose transaction-oriented operations that return immutable prepared envelopes and typed outcomes.

## Delivery meanings

Relay receipts do not prove endpoint or daemon acceptance:

```text
admitted:         relay accepted a bounded frame
forwarded:        relay enqueued it toward the current destination route
daemon_accepted:  daemon decrypted, authenticated, authorized, and durably accepted the request
```

Only `daemon_accepted` permits removal of a mutation from durable retry storage. Non-mutating event delivery continues to use canonical cursor and snapshot recovery after the endpoint synchronizes its epoch.

There is no durable cloud command mailbox. A disconnected remote client retains drafts or its approved local encrypted outbox. The relay stores only bounded in-memory queues.

## Associated data

OpenMLS authenticated data is per message and must be set explicitly before every outgoing message. The exact canonical encoding remains a security-profile decision.

It must bind at least:

- Axl E2EE profile and envelope version
- Pairwise group or crypto-session identifier
- Source and destination device identifiers
- Installation identifier
- Message class
- Stable request, event, proposal, commit, or receipt identifier
- Current hosted authorization generation where applicable

Transport attempt ID and ephemeral route ID must not enter cryptographic message identity because retries and reconnects change them.

## Epoch tolerance and bounds

Initial review targets are:

```text
previous epochs retained receive-only: 2
previous-epoch maximum age:             5 minutes
future epochs buffered:                 1
future messages:                        32
future bytes:                           512 KiB
future wait:                            10 seconds
```

These values are provisional until deterministic failure tests and load measurements approve them. All queues have count, byte, and time bounds.

Past epochs are delivery tolerance only. Current device revocation, grant generation, daemon policy, request replay checks, and idempotency still apply after decryption.

Too-old, too-far-future, missing-commit, suite-mismatch, and authenticator-mismatch cases fail with bounded typed errors. They trigger explicit resynchronization or re-pairing, never a silent reset or downgrade.

## Authorization boundary

After a successful open, the daemon performs:

1. Map authenticated MLS credential and group to one paired device record.
2. Validate the plaintext protocol request.
3. Load current local grant, hosted narrowing generation, and terminal revocation state.
4. Require the RPC's explicit remote scope.
5. Enforce current session, sandbox, and policy constraints.
6. Apply durable command idempotency.
7. Record durable acceptance before the effect.
8. Execute through the existing daemon dispatcher.

The device cannot supply or override its authenticated identity in plaintext. A hosted grant can only narrow local authority. Revocation overrides previous-epoch decryptability.

## Platform boundary

One independent Rust core is proposed for protocol state transitions and shared behavior. It must remain transport-independent and expose thin adapters for:

- Node on the daemon
- Browser/WASM for hosted remote web
- Swift on iOS
- Kotlin/JNI on Android

Node, browser, Swift, and Kotlin code must not independently implement MLS rules. Shared cross-platform fixtures must prove compatible messages, persistence, errors, and update behavior.

Browser/WASM is a pre-implementation feasibility gate. The review must prove a secure random source, supported libcrux/OpenMLS target, protected device identity, and a durable transaction spanning MLS state plus exact ciphertext. A browser implementation must not be assumed from native compilation results. If this gate fails, remote web remains disabled while the architecture is reconsidered.

Native endpoints should use platform secure storage for identity-wrapping keys and an approved transactional local database for group state and outbox data. Loss or rollback of protected identity or unrecoverable group state requires explicit re-pairing.

## Security claims and non-claims

The proposed profile is intended to provide:

- End-to-end confidentiality and integrity against the relay and control plane
- Unique MLS application-message keys and deletion of used secrets
- Forward secrecy for past message keys that are erased from live and recoverable persisted state under the approved storage threat model
- Classical post-compromise recovery after a successful X25519-bearing update when the attacker has lost endpoint access
- Post-quantum confidentiality recovery after a successful ML-KEM-bearing update when the attacker has lost endpoint access
- Replay rejection and explicit fork detection

It does not claim:

- Signal wire compatibility
- Triple Ratchet or SPQR behavior
- Per-message public-key ratcheting
- Post-quantum authentication
- Recovery while malware still controls an endpoint
- Recovery of a stolen durable device identity without revocation and re-pairing
- Protection from plaintext endpoints
- Production security before review and independent assurance

## Dependency and provenance gates

Before production adoption:

1. Pin every Rust dependency and toolchain input.
2. Review complete transitive licenses and MPL obligations.
3. Run `cargo audit` and `cargo deny` under CI.
4. Produce an SBOM and preserve notices.
5. Confirm PQ path and provider maintenance expectations with upstream maintainers.
6. Review side-channel posture for target platforms.
7. Record the upstream audit commit and excluded provider/storage scope.
8. Add fuzzing, known-answer fixtures, negative fixtures, and storage fault injection.
9. Obtain independent review of this profile and the Axl wrapper.

AGPL-only libsignal and SPQR implementations must not be linked, copied, translated, vendored, or added to the lockfile. Public specifications may inform an independently reviewed implementation only under the repository's provenance rules.

## Implementation gates

### Gate A: profile approval

Approve exact dependencies, profile, AAD, identity, pairing, storage, browser, migration, and security claims.

### Gate B: transport-independent core

Two fixture endpoints pair, exchange messages, reject replays, perform a daemon-created hybrid update, detect a fork, and survive deterministic loss and duplication.

### Gate C: crash-safe persistence

Fault injection around every write proves no state/ciphertext split, no key reuse, exact retries, and mandatory reload after rollback.

### Gate D: platform interoperability

Node, browser/WASM, Swift, and Kotlin run the same positive and negative fixtures. Representative phones pass latency, battery, thermal, background, and secure-storage tests.

### Gate E: hosted integration

The reviewed adapter replaces fake E2EE through the real control plane and relay. Pairing, route replacement, restart, revocation, commits, receipts, and daemon idempotency pass end to end.

### Gate F: safety and assurance

Observer access, steering, and then remote `allow_once` approval pass separate authorization gates and independent security review. No earlier gate authorizes user release.

## Open review decisions

The security-profile review must resolve:

- Exact draft revision and code-point binding
- Credential encoding and identity proof
- QR transcript and confirmation UX
- KeyPackage reservation, expiry, and deletion
- Welcome transport and expiry
- Canonical AAD encoding
- Commit ID construction
- Epoch-ready receipt schema
- Storage schema, rollback detection, and cryptographic erasure of stale state pages and logs
- Browser/WASM transactional storage
- Secure-storage APIs, crash-dump behavior, snapshot exclusions, and backup policy
- Profile migration versus mandatory re-pairing
- Final epoch-retention limits
- Mobile update thresholds
- Attachment key schedule and chunk format

Until those decisions are approved, the implementation remains behind fake E2EE and ordinary sessions remain unavailable remotely.
