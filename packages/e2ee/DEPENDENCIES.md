<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Dependency record

## Profile binding

| Item | Pinned value |
| --- | --- |
| Profile | `axl-e2ee-mls-pq-v1`, revision 1 |
| OpenMLS | 0.9.0, crates.io checksum `b6b08d90fc020cb5354d5f08ca17711b84c82e2bcc7331753fd94f000d99a8c8` |
| Upstream source | tag `openmls-v0.9.0`, commit `3a3e35de3feeca8f6605143c464d5452ae584d43` |
| Provider | `openmls_libcrux_crypto` 0.4.0, checksum `41e6367fb30f91f21e4d30f4f58a8d3b41f96f55c3e4b5acfa1d6d18c9dd4855` |
| Suite | value `0x004e`, `MLS_128_MLKEM768X25519_AES256GCM_SHA384_Ed25519` |
| KEM implementation | upstream `XWingDraft06` |
| Features | `openmls/draft-ietf-mls-pq-ciphersuites`, `openmls_libcrux_crypto/draft-ietf-mls-pq-ciphersuites`; default features disabled |
| Toolchain | rustc 1.96.0 commit `ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96`; Cargo 1.96.0 commit `30a34c682`; `rustfmt`, `clippy`, and `wasm32-unknown-unknown` |
| Native transaction engine | `redb` 4.2.0, checksum `de6c3b63e007e90ce536ec2ae4690826136a20ec8dbbbb400daef1bb999d2e36`, `MIT OR Apache-2.0` |
| Implementation lock | SHA-256 `a3727409f1b430200fbdaecd1d7b0779555d8e18be18ce983367dea19b1eabe1` |

The direct dependencies besides the selected implementation and provider are
`openmls_basic_credential` 0.6.0 for OpenMLS signing-key storage, `openmls_memory_storage` 0.6.0 and
`openmls_traits` 0.6.0 for transaction-local provider composition, `tls_codec` 0.5.0 for the
OpenMLS wire encoding API, and `redb` 4.2.0 for native durable transactions. The OpenMLS crates were
already members of the approved candidate graph. `redb` is the approved Session 40B addition.
It is pure Rust and adds only itself to the selected external closure because its sole normal
platform dependency, `libc` 0.2.189, was already selected. It requires no database binary, C/C++
compiler, native database library, `pkg-config`, vcpkg, Clang, Java, or code generator. No binding,
transport, Signal, or libsignal dependency is selected. Cargo's lock resolution records OpenMLS's
optional/development SQLite alternatives, but `cargo tree --locked --target all --edges
normal,build` confirms they are not in this package's selected build graph.

The selected normal/build closure contains 156 external package/version pairs on `--target all`,
a net increase of one from Session 40A and 41 over Session 30's 115-row inventory. Reconciliation adds 54 exact entries, primarily the
signing implementation closure pulled by `openmls_basic_credential` 0.6.0, and removes 14
browser-only entries that are not selected without OpenMLS's Session 50 `js` feature. The Session
30 disposable spike declared the same credential crate, but its inventory table omitted that
branch. `Cargo.lock` is authoritative for this package and also records optional, target-specific,
and dependency-development alternatives that are not selected by the normal/build tree.

## Maintenance exception

| Field | Value |
| --- | --- |
| Package | `proc-macro-error2` 2.0.1 |
| Checksum | `11ec05c52be0a07b08061f7dd003e7d7092e0472bc731b4af7bb1ef876109802` |
| Complete path | `proc-macro-error2 2.0.1 -> hax-lib-macros 0.3.7 -> hax-lib 0.3.7 -> libcrux-sha3 0.0.10 -> hpke-rs 0.7.0 -> openmls_libcrux_crypto 0.4.0` |
| Reason | Unmaintained transitive procedural macro in the exact approved OpenMLS/libcrux graph; no vulnerability is reported |
| Expiry | 2026-12-15, or the next relevant OpenMLS/libcrux release, whichever comes first |
| Scope | Maintenance warning only; no vulnerability suppression |

The exception appears in both `.cargo/audit.toml` and `deny.toml`. Every vulnerability finding
remains fatal. Re-evaluate and remove the exception as soon as upstream removes the dependency.

## License policy

`deny.toml` permits only the reviewed Apache-2.0, MIT, ISC, BSD-2-Clause, BSD-3-Clause, Unlicense,
Unicode-3.0, and MPL-2.0 expressions. MPL-2.0 applies to the unmodified `hpke-rs` family at file
scope and does not relicense Axl. Distribution packaging must retain all applicable third-party
license texts and notices. Final packaging review remains a production-release gate. `redb` is used under Apache-2.0 and its
license text and notices must be retained in source and binary distributions.
