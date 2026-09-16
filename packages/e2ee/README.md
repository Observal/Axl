<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl endpoint E2EE core

This package is the transport-independent OpenMLS core and native durable adapter for revision 1
of Axl's private `axl-e2ee-mls-pq-v1` profile.

It provides:

- one daemon and one device per group;
- canonical revision 1 pairing invitation and claim encoding, signatures, comparison values, and
  crate-private in-memory failed-claim accounting for known invitations; durable unknown-invitation
  lookup remains Session 50.2 work;
- bounded KeyPackage and Welcome handling;
- canonical Axl credential and AAD validation;
- bidirectional private application messages;
- phone-owned self-Update proposals and daemon-only commits;
- immutable prepared envelopes and a platform-neutral transaction contract;
- a native redb adapter with per-pair databases, immediate-durability two-phase commits, exact-byte
  outbox recovery, durable acknowledgement and bounded retry retention, accepted-message-before-
  plaintext behavior, authenticated metadata manifests, restart-stable previous-epoch windows, and
  deterministic fault injection;
- injected active-only envelope-key and monotonic rollback-anchor interfaces with crash
  reconciliation for prepared keys;
- fail-closed creation recovery serialized across threads and processes by an OS-backed per-session
  lifecycle claim; cleanup requires proof that no cryptographic state committed, while open finishes
  publication of authenticated state and removes only a stale `.initializing` marker.

The package does not provide transport, relay routing, accounts, authorization, completed platform
bindings, browser persistence, or presentation behavior. The durable API reloads committed OpenMLS
and signer state inside every native transaction, so rolled-back state and prepared handles cannot
be reused. See [`STORAGE.md`](STORAGE.md) for the schema, transaction order, migrations, rollback
detection, erasure boundary, and explicit exclusions. Session 50's approved platform boundary is in
[`../../docs/architecture/e2ee-platform-bindings.md`](../../docs/architecture/e2ee-platform-bindings.md).
Browser transaction evidence remains required, but browser pairing stays disabled until an
independent rollback anchor or reviewed peer-witness design is approved. Keychain, Android Keystore,
generated mobile SDKs, and mobile applications remain Phase 13 work.

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

The exact toolchain is in `rust-toolchain.toml`. The implementation dependency and maintenance
exception record is in `DEPENDENCIES.md`.
