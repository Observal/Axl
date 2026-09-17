<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl endpoint E2EE core

This package is the transport-independent OpenMLS core and native durable adapter for revision 1
of Axl's private `axl-e2ee-mls-pq-v1` profile.

It provides:

- one daemon and one device per group;
- canonical revision 1 pairing invitation and claim encoding, signatures, comparison values, and
  durable encrypted pending-invitation and device pre-join state;
- fixed-lifetime KeyPackage reservation, independently expiring Welcome creation and recovery, and
  activation with a durable daemon-acceptance barrier;
- canonical Axl credential and AAD validation;
- bidirectional private application messages;
- phone-owned self-Update proposals, daemon-only update and removal commits, authenticated
  epoch-ready completion with a durable device acknowledgement barrier, terminal reset and
  revocation state, and enforced fresh-identifier and fresh-KeyPackage re-pair operations;
- immutable prepared envelopes and a platform-neutral transaction contract;
- a native redb adapter with per-pair databases, immediate-durability two-phase commits, exact-byte
  outbox recovery, durable acknowledgement and bounded retry retention, accepted-message-before-
  plaintext behavior, authenticated metadata manifests, restart-stable previous-epoch windows, and
  deterministic fault injection;
- injected active-only envelope-key and legacy test rollback-anchor interfaces with crash
  reconciliation for prepared keys;
- canonical signed rollback-witness register, read, and advance requests, bounded per-replica
  overlap keysets, strict unanimous 3-of-3 certificate verification, append-ordered fork and
  revocation decisions, complete endpoint reconciliation and quarantine, and an output-gating state
  machine;
- an acyclic sealed-inner and sealed-outer format that encrypts and authenticates the exact result
  inside the committed successor, then binds its SHA-384 state commitment to the exact signed
  request while keeping request construction and state material below the public API;
- fail-closed creation recovery serialized across threads and processes by an OS-backed per-session
  lifecycle claim; cleanup requires proof that no cryptographic state committed, while open finishes
  publication of authenticated state and removes only a stale `.initializing` marker.

The public native facade exposes typed endpoint operations and immutable artifacts. Outbox fields
are read-only, and replacement commits and removals accept only those typed artifacts. Mutable
OpenMLS state, transaction handles, providers, signers, private key material, DEKs, rollback
counters, relay routes, and authorization decisions remain internal. The package does not provide
transport, relay routing, accounts, authorization, completed platform bindings, browser persistence,
or presentation behavior. The durable API reloads committed OpenMLS
and signer state inside every native transaction, so rolled-back state and prepared handles cannot
be reused. See [`STORAGE.md`](STORAGE.md) for the schema, transaction order, migrations, rollback
detection, erasure boundary, and explicit exclusions. Session 50's approved platform boundary is in
[`../../docs/architecture/e2ee-platform-bindings.md`](../../docs/architecture/e2ee-platform-bindings.md).
Browser transaction evidence remains required. The approved hosted witness protocol supplies the
independent rollback anchor, but browser pairing stays disabled until its production persistence,
witness integration, artifact isolation, and runtime evidence pass. A target-gated macOS
`EnvelopeKeyStore` now uses the data-protection Keychain, but it is not wired into Node or any
production endpoint constructor and has no enabled support row. Linux and Windows secure stores,
Android Keystore, generated mobile SDKs, and mobile applications remain later work.

Revision 1 uses OpenMLS 0.9.0 and `openmls_libcrux_crypto` 0.4.0 with suite value `0x004e` and the
upstream `XWingDraft06` KEM implementation. It has no classical-only fallback. Axl does not claim
IETF draft-06 interoperability.

## Checks

```sh
cargo test --locked
cargo test --locked persistence_tests
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo audit --deny warnings
cargo deny check
```

The private Node-API binding lives in [`bindings/node`](bindings/node). Its production endpoint
constructors are not wired to a secure store or rollback witness and therefore fail closed during
endpoint creation or opening. The target-gated macOS store is not exported through JavaScript.
Test-only storage is compiled into a separate local fixture artifact and is excluded from production
packaging.

The private browser binding lives in [`bindings/browser`](bindings/browser). It runs single-threaded
WASM in a dedicated same-origin module worker, requires `crypto.getRandomValues()`, and packages no
browser executable. Its separately built test artifact executes a fresh KeyPackage, Welcome,
activation, bidirectional application, update, commit, and epoch-ready lifecycle in each browser.
It also executes negative OpenMLS cases for replay, duplicate ciphertext, mutation, AAD and identity
mismatch, profile mismatch, and competing commits.

The separate test artifact implements browser persistence feasibility with real IndexedDB, Web
Locks, WebCrypto, dedicated workers, strict prepare-and-compare transactions, wrapped-DEK restart
reconciliation, exact ciphertext and sealed-plaintext recovery, and storage fault evidence. The
production artifact, declarations, and tarball contain no test persistence constructor or test
anchor. Production endpoint creation and opening continue to fail with
`rollback_anchor_unavailable`, and remote-web wiring remains out of scope. See
[`BROWSER_STORAGE.md`](BROWSER_STORAGE.md) for the schema, sequencing, failure policy, evidence, and
explicit browser security non-claims.

The exact toolchain is in `rust-toolchain.toml`. The implementation dependency and maintenance
exception record is in `DEPENDENCIES.md`.
