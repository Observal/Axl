<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Axl endpoint E2EE core

This package is the transport-independent, in-memory OpenMLS core for revision 1 of
Axl's private `axl-e2ee-mls-pq-v1` profile.

It provides:

- one daemon and one device per group;
- bounded KeyPackage and Welcome handling;
- canonical Axl credential and AAD validation;
- bidirectional private application messages;
- phone-owned self-Update proposals and daemon-only commits;
- immutable prepared envelopes and a platform-neutral transaction contract.

The package does not provide durable persistence, transport, relay routing, accounts,
authorization, platform bindings, or presentation behavior. In-memory tests do not make a
durability claim. A rollback invalidates the in-memory group and requires a future durable adapter
to reload committed state before use.

Revision 1 uses OpenMLS 0.9.0 and `openmls_libcrux_crypto` 0.4.0 with suite value `0x004e` and the
upstream `XWingDraft06` KEM implementation. It has no classical-only fallback. Axl does not claim
IETF draft-06 interoperability.

## Checks

```sh
cargo test --locked
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo audit --deny warnings
cargo deny check
```

The exact toolchain is in `rust-toolchain.toml`. The implementation dependency and maintenance
exception record is in `DEPENDENCIES.md`.
