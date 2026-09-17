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

## Session 50.3 Node binding

The private `@axl/e2ee-node` binding adds `napi` 3.12.5 with only `napi9`,
`napi-derive` 3.6.6 with only `strict`, and build dependency `napi-build` 2.4.2. All default
features are disabled. `type-def`, Tokio, `@napi-rs/cli`, node-gyp, CMake, and downloaded build
tools are not selected. Node declarations are reviewed source and are checked against runtime
exports and ABI inventories.

The resulting all-target normal/build closure contains 177 external package/version pairs, 21 more
than the prior 156-pair closure. Of those 21 selected additions, `futures-core` 0.3.34,
`futures-task` 0.3.34, `futures-util` 0.3.34, `pin-project-lite` 0.2.17, and `slab` 0.4.12 were
already present in the lock. The other selected additions are `convert_case` 0.12.0, `ctor`
1.0.13, `futures` 0.3.34, `futures-channel` 0.3.34, `futures-executor` 0.3.34, `futures-io`
0.3.34, `futures-macro` 0.3.34, `futures-sink` 0.3.34, `libloading` 0.9.0, `napi` 3.12.5,
`napi-build` 2.4.2, `napi-derive` 3.6.6, `napi-derive-backend` 6.1.3, `napi-sys` 3.3.1,
`nohash-hasher` 0.2.0, and `unicode-segmentation` 1.13.3. There are no direct development
dependencies.

Lock regeneration also replaces three unselected optional entries: `synstructure` 0.13.2 with
0.14.0, `yoke-derive` 0.8.2 with 0.8.3, and `zerofrom-derive` 0.1.7 with 0.1.8. The resulting
`Cargo.lock` SHA-256 is
`bb5a5a66a60f5ae9a318c2c4a8daac43a5757856c1a183bd91eb2360830555f8`.

All additions use MIT, Apache-2.0 OR MIT, ISC, or Unicode-3.0 terms already accepted by the
allow-list. New procedural macros are `napi-derive` and `futures-macro`; the lock-only replacements
`yoke-derive` and `zerofrom-derive` are also procedural macros. `napi` and the local binding have
Rust build scripts. On the approved macOS and glibc Linux targets, `napi-build` emits linker
configuration and downloads no executable or other tool.

The direct crate provenance is:

| Crate | Checksum | Annotated tag object | Source commit |
| --- | --- | --- | --- |
| `napi` 3.12.5 | `f0c007d4a8ead952a81887661d41fd56b7e7a70d3d4d921f445fb37a8f6efa1e` | `c69066bc9b2fc848aea9fd83f478e815085fbe1e` | `43100baf28a3e5709641e35f892be4da5d62dcb2` |
| `napi-derive` 3.6.6 | `e8872852c2d050fc5859749864119bc5d50e3f6ad5957874d61d1a07c76771cb` | `718349e1e4c8ec666ce8ba0b6eee59babd7e0dd6` | `43100baf28a3e5709641e35f892be4da5d62dcb2` |
| `napi-build` 2.4.2 | `860e7c40864f95cfb83cde99f9ebadd88ef3d9bdccd7dd2cee0cc96a2dd4ffa7` | `fce13f61caff9b4c0d1d6d093d1ea24dcdd7af31` | `31c27a1676a7c4b317f4e144e0a9cb94e8354143` |

Rust 1.96 and Node 24.13.1 on macOS arm64 are locally verified. Node 22.19, macOS x64, and both
glibc Linux architectures require separate runtime evidence. The production package contains no
secure-store implementation and cannot create or open an endpoint.

## Session 50.4 browser/WASM binding

The private `@axl/e2ee-browser` binding adds `wasm-bindgen` 0.2.128, `getrandom` 0.2.17 with
its `js` feature, and `web-time` 1.1.0. OpenMLS's `js` feature is enabled only by the browser
workspace member. The initial artifact is single-threaded and contains no shared WASM memory or
`SharedArrayBuffer` requirement. The resulting E2EE `Cargo.lock` SHA-256 is
`a324986d4ff5a8178219c1836fb5ad9f28c8b49880e286f17927d6327738f0a0`.

Generated `--target web` glue is produced by a repository-owned driver in
`bindings/browser/scripts/wasm-bindgen-driver`. The driver is a standalone Cargo workspace with
its own lock. It uses `wasm-bindgen-cli-support` 0.2.128 with default features disabled; it does not
install, package, or execute `wasm-bindgen-cli`. Its 43-record lock contains the local driver and 42
external package/version pairs and has SHA-256
`19fe623de7a29372a9f899f8130c4194e9b9e2a60969f046c1f4c8b79ad69475`. Its separate license
policy adds only the approved tooling-only Zlib allowance. CI independently formats, lints, audits,
and checks this lock with cargo-deny.

Browser tests use `@playwright/test` 1.63.0, which selects `playwright` 1.63.0 and
`playwright-core` 1.63.0. Browser executables are downloaded only in test jobs and are absent from
production packages. Linux CI is pinned to Ubuntu 24.04 x64. Its repository-owned installer checks
Firefox 155.0 revision 1543 against SHA-256
`b0905e84427cc162b9a6e4392be14e5e54e0ade911c83639962c8078b273565e` and WebKit 26.6 revision
2359 against SHA-256 `8c129d989a1c48d826ca11b45acbba919039de811623dc3819ccbd95b69eeb62`
before extraction. The resulting `pnpm-lock.yaml` SHA-256 is
`a26537aea0418e8f36690eb2868df4d581d5961678e57b7f9028ce0ea1f81c78`.

Production endpoint creation and opening remain closed with `rollback_anchor_unavailable`. The
production package contains no test-only randomness probe, in-memory endpoint capability,
IndexedDB adapter, Web Locks code, persistence implementation, or rollback anchor.

## Production storage: macOS Keychain

The macOS-only envelope-key store adds this exact target-specific declaration:

```toml
[target.'cfg(target_os = "macos")'.dependencies]
core-foundation = { version = "=0.10.1", default-features = false }
security-framework = { version = "=3.7.0", default-features = false, features = ["OSX_10_15"] }
security-framework-sys = { version = "=2.17.0", default-features = false, features = ["OSX_10_15"] }
```

`core-foundation` and `security-framework-sys` are direct declarations only because the
`security-framework` 3.7.0 add builder does not expose every required policy dictionary field. They
were already members of the approved six-package candidate closure and add no package or feature to
the selected graph.

The E2EE lock changed from SHA-256
`a324986d4ff5a8178219c1836fb5ad9f28c8b49880e286f17927d6327738f0a0` to
`71b54b75338347f4d465a0b11bcf207a40e554233db2e8a136f070220b107878`.
The selected dependency closure has six normal package/version pairs and no build or development
dependency edge:

| Package | Crates.io SHA-256 | License |
| --- | --- | --- |
| `security-framework` 3.7.0 | `b7f4bc775c73d9a02cde8bf7b2ec4c9d12743edf609006c7facc23998404cd1d` | MIT OR Apache-2.0 |
| `security-framework-sys` 2.17.0 | `6ce2691df843ecc5d231c0b14ece2acc3efb62c0a398c7e1d875f3983ce020e3` | MIT OR Apache-2.0 |
| `core-foundation` 0.10.1 | `b2a6cd9ae233e7f62ba4e9353e81a88df7fc8a5987b8d445b4d90c879bd156f6` | MIT OR Apache-2.0 |
| `core-foundation-sys` 0.8.7 | `773648b94d0e5d620f64f280777445740e61fe701025087ec8b57f45c791888b` | MIT OR Apache-2.0 |
| `libc` 0.2.189 | `3eaf3ede3fee6db1a4c2ee091bf8a8b4dccdc6d17f656fb07896ee72867612f2` | MIT OR Apache-2.0 |
| `bitflags` 2.13.2 | `3ded4057c258ba199e2d26386d3af3780957ecaee6c4ef4041c6b4b8b97c0b06` | MIT OR Apache-2.0 |

`libc` is the only package in this closure with a build script. It was already selected by the
prior lock. This closure adds no procedural macro, downloaded executable, C or C++ build, package
manager probe, or development dependency. It links the operating-system Security and
CoreFoundation frameworks and requires macOS 10.15 or newer. The direct source is annotated tag
`v3.7.0`, tag object `4efde9cf6495e2ac366a98134c1f98f9eced627b`, source commit
`5f6e65114b77d5bc161d2b099cad09f2a67609d2` from
`https://github.com/kornelski/rust-security-framework`.

The implementation uses only the data-protection Keychain, disables synchronization and
interactive authentication, applies `AccessibleWhenUnlockedThisDeviceOnly`, and reports
`hardware_backing = false`. The Node binding does not construct this store, and production endpoint
creation and opening remain fail-closed. Local unsigned Apple-Silicon execution reports the missing
Keychain entitlement as access denied. Signed/notarized arm64, native Intel, lock/logout, backup,
installer, and reboot evidence remains required before either macOS row can be enabled.

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
