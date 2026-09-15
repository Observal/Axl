<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenMLS dependency decision

Status: OpenMLS/libcrux candidates approved to enter Session 40; Session 50 binding candidates approved for evaluation only; production release approval deferred

Reviewed: 2026-09-16

## Decision

No Rust dependency is added to Axl by this Session 30 change. The repository owner approves the exact OpenMLS/libcrux candidates below to enter Session 40. This is implementation approval, not production-release approval. Session 40 creates the implementation package, pins the exact Rust toolchain and Cargo graph, commits `Cargo.lock`, and runs the required audits.

| Input | Exact candidate |
| --- | --- |
| `openmls` | 0.9.0; crates.io checksum `b6b08d90fc020cb5354d5f08ca17711b84c82e2bcc7331753fd94f000d99a8c8`; MIT |
| `openmls_libcrux_crypto` | 0.4.0; crates.io checksum `41e6367fb30f91f21e4d30f4f58a8d3b41f96f55c3e4b5acfa1d6d18c9dd4855`; MIT |
| `openmls_basic_credential` | 0.6.0; crates.io checksum `dbd3f0c3422e7c7a8496f042b547b0c28d0793f8ba97feb401966e58196a1e40`; MIT; approved direct implementation dependency |
| OpenMLS source | tag `openmls-v0.9.0`, commit `3a3e35de3feeca8f6605143c464d5452ae584d43`, 2026-08-25 |
| Features | `openmls/draft-ietf-mls-pq-ciphersuites`, `openmls/js` for WASM, `openmls_libcrux_crypto/draft-ietf-mls-pq-ciphersuites`; default features disabled |
| Research toolchain | Rust 1.96.0 (`ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96`, 2026-05-25); both direct crates declare MSRV 1.91.0 |
| WASM compile evidence | `wasm32-unknown-unknown` from Rust 1.96.0 passed with the `openmls/js` feature |
| Session 40 pin | Session 40 records the exact Rust and Cargo versions, installed target components, direct dependency declarations, features, checksums, and committed `Cargo.lock` before implementation proceeds |
| OpenMLS storage contract | `openmls_traits` 0.6.0, provider schema version 1 |
| Disposable research lock | Generated 2026-09-14; SHA-256 `c0a6fc287e663ce4ae9fedd6907c5ba4b20eb136318b69337d3be4a7a268f504` |

The research lock under `/tmp` is evidence, not the implementation lockfile. Cargo resolved 264 packages because a lock records optional and target-specific alternatives. After Session 40B, the table below is the complete 156-package normal and build dependency closure selected by `cargo tree --locked --target all --edges normal,build` for the stated features. Development-only dependencies and optional packages not selected by that command are excluded. Session 40A reconciled the implementation graph and received explicit human approval for `openmls_basic_credential` 0.6.0 and its additional normal/build closure. Session 40B adds only `redb` 4.2.0; its sole normal dependency, `libc` 0.2.189, was already selected. Cargo's lockfile also records optional, target-specific, and dependency-development alternatives that are not selected by this command.

## Session 50 evaluation candidates

The following versions are approved only for isolated evaluation and planning. This approval does not permit changing a repository manifest or lockfile. Each dependency-bearing Session 50 PR must present its exact resulting lock, selected normal/build/development graph, licenses, advisories, build scripts, downloaded binaries, and target evidence for separate human approval before insertion.

| Use | Exact evaluation candidate | Source and integrity | Scope |
| --- | --- | --- | --- |
| Node runtime | `napi` 3.12.5, Node-API 9, default features disabled | MIT; crates.io checksum `f0c007d4a8ead952a81887661d41fd56b7e7a70d3d4d921f445fb37a8f6efa1e`; tag `napi-v3.12.5`, commit `c69066bc9b2fc848aea9fd83f478e815085fbe1e` | Proposed production dependency for the private Node binding only |
| Node macros | `napi-derive` 3.6.6 with `strict` and `type-def` | MIT; checksum `e8872852c2d050fc5859749864119bc5d50e3f6ad5957874d61d1a07c76771cb`; tag commit `718349e1e4c8ec666ce8ba0b6eee59babd7e0dd6` | Proposed build-time macro dependency for the private Node binding |
| Node build | `napi-build` 2.4.2, default features disabled | MIT; checksum `860e7c40864f95cfb83cde99f9ebadd88ef3d9bdccd7dd2cee0cc96a2dd4ffa7`; tag commit `fce13f61caff9b4c0d1d6d093d1ea24dcdd7af31` | Proposed build dependency; no runtime npm package |
| WASM ABI | `wasm-bindgen` 0.2.128 | MIT OR Apache-2.0; checksum `aecb87a33d3b0c5e3b7aa46336eaf486cffafbd281b195e4c8b80d50df2351bf`; tag `0.2.128`, commit `246946fddd62163e778c3a1f6afe7264347adceb` | Already resolved in the current Cargo lock; proposed direct binding dependency |
| WASM build tool | `wasm-bindgen-cli` 0.2.128 | MIT OR Apache-2.0; checksum `2e29140c04e81832902b70e5d37b9ce1bfa811c8fe4563bea08f76df8388cf20`; same upstream tag | Proposed pinned build tool only |
| Legacy RNG bridge | `getrandom` 0.2.17 with `js` | MIT OR Apache-2.0; checksum `ff2abc00be7fca6ebc474524697ae276ad847ad0a6b3faa4bcb027e9a4614ad0` | Already resolved transitively; proposed direct target dependency to enable browser Web Crypto for the credential helper graph |
| WASM time | `web-time` 1.1.0 | MIT OR Apache-2.0; checksum `5a6580f308b1fad9207618087a65c04e7a10bc77e02c8e84e9b00dd4b12fa0bb` | New transitive dependency selected by `openmls/js` |
| Browser tests | `@playwright/test` 1.63.0 | Apache-2.0; npm integrity `sha512-oxMK4vllB9RK5NQ2l1pq1IfOf2AvnEuj/vYGDj0H2nMtmtZpKtCwt/l00GEO6xjGfpBNAvjovvYdCm50dRQkpQ==`; tag `v1.63.0`, commit `1b025d7e20a026371cd5f98ba0cdce48892737c8` | Proposed development dependency; resolves `playwright` and `playwright-core` 1.63.0 and downloads pinned browser builds |

No IndexedDB wrapper, Web Locks package, WebCrypto package, `@napi-rs/cli`, UniFFI, cbindgen, JNI crate, Swift package dependency, Kotlin library, Android Gradle plugin, or mobile SDK is selected. Browser persistence uses standard Web APIs. Swift, Kotlin, C ABI, JNI, generated SDKs, mobile secure storage, and mobile applications remain Phase 13.

A temporary Node candidate graph contained 19 new external package/version pairs beyond the current core graph. Its isolated build passed. Its license evaluation passed the existing allow-list; the temporary path dependency intentionally tripped the repository wildcard-dependency ban. `cargo audit` found no vulnerability and reported only the existing `proc-macro-error2` maintenance warning when the graph was combined with the OpenMLS core.

A direct `openmls/js` check against `wasm32-unknown-unknown` currently fails because the credential helper's `getrandom` 0.2.17 branch lacks its `js` feature. An isolated candidate that enabled `getrandom/js` compiled successfully on the real target, selected 124 normal/build package names, and added only `web-time` 1.1.0 to the lock. This is compile evidence, not browser execution evidence.

An isolated pnpm lock for `@playwright/test` 1.63.0 selected only `@playwright/test`, `playwright`, and `playwright-core` at 1.63.0. `pnpm audit --audit-level high` reported no known vulnerability. The downloaded Chromium, Firefox, and WebKit revisions and their binary checksums must be recorded by the dependency-bearing PR. Playwright WebKit does not count as actual Safari evidence.

`openmls_basic_credential` 0.6.0 is an approved direct implementation dependency for revision 1. It supplies the OpenMLS `SignatureKeyPair` implementation used to create and retain endpoint signing keys. Its helper graph contains implementations for Ed25519, ECDSA over P-256 and P-384, and ML-DSA, but revision 1 selects only Ed25519 through the fixed suite. Axl exposes no signature-scheme negotiation and does not enable any additional MLS cipher suite, signature scheme, or algorithm negotiation. The presence of unused implementations in the helper graph does not make them part of the revision 1 profile.

Session 40B selected `redb` 4.2.0 after separate human approval. It is a pure-Rust,
MIT-or-Apache-2.0 ACID engine and adds no native database library or external database binary.
Axl uses one database per `crypto_session_id`, explicitly selects immediate durability and two-phase
commit for each security-sensitive transaction, and does not use persistent savepoints. The Axl
adapter, rather than redb, owns encrypted OpenMLS state envelopes, exact-ciphertext records,
idempotency, rollback anchors, and envelope-key lifecycle. Session 50 still owns browser-specific
adapter dependencies. Native and browser engines may differ, but both implement the same atomic
state, exact-ciphertext, rollback, reload, and typed-outcome contract.

## Complete selected dependency and license table

| Package and version | Declared SPDX expression |
| --- | --- |
| `autocfg v1.5.1` | `Apache-2.0 OR MIT` |
| `base16ct v0.2.0` | `Apache-2.0 OR MIT` |
| `base64ct v1.8.3` | `Apache-2.0 OR MIT` |
| `bindgen v0.72.1` | `BSD-3-Clause` |
| `bitflags v2.13.2` | `MIT OR Apache-2.0` |
| `block-buffer v0.10.4` | `MIT OR Apache-2.0` |
| `cc v1.4.6` | `MIT OR Apache-2.0` |
| `cexpr v0.6.0` | `Apache-2.0/MIT` |
| `cfg-if v1.0.4` | `MIT OR Apache-2.0` |
| `chacha20 v0.10.2` | `MIT OR Apache-2.0` |
| `clang-sys v1.9.1` | `Apache-2.0` |
| `cmov v0.5.4` | `Apache-2.0 OR MIT` |
| `const-oid v0.10.2` | `Apache-2.0 OR MIT` |
| `const-oid v0.9.6` | `Apache-2.0 OR MIT` |
| `core-models v0.0.7` | `Apache-2.0` |
| `cpufeatures v0.2.17` | `MIT OR Apache-2.0` |
| `cpufeatures v0.3.1` | `MIT OR Apache-2.0` |
| `crabgrind v0.2.6` | `MIT` |
| `crossbeam-deque v0.8.8` | `MIT OR Apache-2.0` |
| `crossbeam-epoch v0.9.21` | `MIT OR Apache-2.0` |
| `crossbeam-utils v0.8.23` | `MIT OR Apache-2.0` |
| `crypto-bigint v0.5.5` | `Apache-2.0 OR MIT` |
| `crypto-common v0.1.7` | `MIT OR Apache-2.0` |
| `crypto-common v0.2.2` | `MIT OR Apache-2.0` |
| `ctutils v0.4.2` | `Apache-2.0 OR MIT` |
| `curve25519-dalek v4.1.3` | `BSD-3-Clause` |
| `curve25519-dalek-derive v0.1.1` | `MIT/Apache-2.0` |
| `der v0.7.10` | `Apache-2.0 OR MIT` |
| `der v0.8.2` | `Apache-2.0 OR MIT` |
| `digest v0.10.7` | `MIT OR Apache-2.0` |
| `digest v0.11.3` | `MIT OR Apache-2.0` |
| `ecdsa v0.16.9` | `Apache-2.0 OR MIT` |
| `ed25519 v2.2.3` | `Apache-2.0 OR MIT` |
| `ed25519-dalek v2.2.0` | `BSD-3-Clause` |
| `either v1.18.0` | `MIT OR Apache-2.0` |
| `elliptic-curve v0.13.8` | `Apache-2.0 OR MIT` |
| `ff v0.13.1` | `MIT/Apache-2.0` |
| `fiat-crypto v0.2.9` | `MIT OR Apache-2.0 OR BSD-1-Clause` |
| `find-msvc-tools v0.1.12` | `MIT OR Apache-2.0` |
| `generic-array v0.14.7` | `MIT` |
| `getrandom v0.2.17` | `MIT OR Apache-2.0` |
| `getrandom v0.4.3` | `MIT OR Apache-2.0` |
| `glob v0.3.4` | `MIT OR Apache-2.0` |
| `group v0.13.0` | `MIT/Apache-2.0` |
| `hax-lib v0.3.7` | `Apache-2.0` |
| `hax-lib-macros v0.3.7` | `Apache-2.0` |
| `hax-lib-macros-types v0.3.7` | `Apache-2.0` |
| `hkdf v0.12.4` | `MIT OR Apache-2.0` |
| `hmac v0.12.1` | `MIT OR Apache-2.0` |
| `hpke-rs v0.7.0` | `MPL-2.0` |
| `hpke-rs-crypto v0.7.0` | `MPL-2.0` |
| `hpke-rs-libcrux v0.7.0` | `MPL-2.0` |
| `hybrid-array v0.4.15` | `MIT OR Apache-2.0` |
| `itertools v0.13.0` | `MIT OR Apache-2.0` |
| `itoa v1.0.18` | `MIT OR Apache-2.0` |
| `keccak v0.2.2` | `Apache-2.0 OR MIT` |
| `libc v0.2.189` | `MIT OR Apache-2.0` |
| `libcrux-aead v0.0.9` | `Apache-2.0` |
| `libcrux-aes v0.0.9` | `Apache-2.0` |
| `libcrux-chacha20poly1305 v0.0.9` | `Apache-2.0` |
| `libcrux-curve25519 v0.0.8` | `Apache-2.0` |
| `libcrux-ecdh v0.0.8` | `Apache-2.0` |
| `libcrux-ed25519 v0.0.9` | `Apache-2.0` |
| `libcrux-hacl-rs v0.0.5` | `Apache-2.0` |
| `libcrux-hkdf v0.0.8` | `Apache-2.0` |
| `libcrux-hmac v0.0.8` | `Apache-2.0` |
| `libcrux-hmac-drbg v0.0.1` | `Apache-2.0` |
| `libcrux-intrinsics v0.0.8` | `Apache-2.0` |
| `libcrux-kem v0.0.9` | `Apache-2.0` |
| `libcrux-macros v0.0.3` | `Apache-2.0` |
| `libcrux-ml-kem v0.0.10` | `Apache-2.0` |
| `libcrux-p256 v0.0.8` | `Apache-2.0` |
| `libcrux-platform v0.0.3` | `Apache-2.0` |
| `libcrux-poly1305 v0.0.6` | `Apache-2.0` |
| `libcrux-secrets v0.0.6` | `Apache-2.0` |
| `libcrux-sha2 v0.0.8` | `Apache-2.0` |
| `libcrux-sha3 v0.0.10` | `Apache-2.0` |
| `libcrux-traits v0.0.8` | `Apache-2.0` |
| `libloading v0.8.9` | `ISC` |
| `log v0.4.34` | `MIT OR Apache-2.0` |
| `memchr v2.8.3` | `Unlicense OR MIT` |
| `minimal-lexical v0.2.1` | `MIT/Apache-2.0` |
| `ml-dsa v0.1.1` | `Apache-2.0 OR MIT` |
| `module-lattice v0.2.3` | `Apache-2.0 OR MIT` |
| `nom v7.1.3` | `MIT` |
| `num-bigint v0.4.8` | `MIT OR Apache-2.0` |
| `num-integer v0.1.47` | `MIT OR Apache-2.0` |
| `num-traits v0.2.19` | `MIT OR Apache-2.0` |
| `openmls v0.9.0` | `MIT` |
| `openmls_basic_credential v0.6.0` | `MIT` |
| `openmls_libcrux_crypto v0.4.0` | `MIT` |
| `openmls_memory_storage v0.6.0` | `MIT` |
| `openmls_serialization_helpers v0.1.0` | `MIT` |
| `openmls_traits v0.6.0` | `MIT` |
| `p256 v0.13.2` | `Apache-2.0 OR MIT` |
| `p384 v0.13.1` | `Apache-2.0 OR MIT` |
| `pastey v0.2.3` | `MIT OR Apache-2.0` |
| `pem-rfc7468 v0.7.0` | `Apache-2.0 OR MIT` |
| `pkcs8 v0.10.2` | `Apache-2.0 OR MIT` |
| `pkcs8 v0.11.0` | `Apache-2.0 OR MIT` |
| `pkg-config v0.3.34` | `MIT OR Apache-2.0` |
| `ppv-lite86 v0.2.21` | `MIT OR Apache-2.0` |
| `prettyplease v0.2.37` | `MIT OR Apache-2.0` |
| `primeorder v0.13.6` | `Apache-2.0 OR MIT` |
| `proc-macro-error-attr2 v2.0.0` | `MIT OR Apache-2.0` |
| `proc-macro-error2 v2.0.1` | `MIT OR Apache-2.0` |
| `proc-macro2 v1.0.107` | `MIT OR Apache-2.0` |
| `quote v1.0.47` | `MIT OR Apache-2.0` |
| `r-efi v6.0.0` | `MIT OR Apache-2.0 OR LGPL-2.1-or-later` |
| `rand v0.10.2` | `MIT OR Apache-2.0` |
| `rand_chacha v0.10.0` | `MIT OR Apache-2.0` |
| `rand_core v0.10.1` | `MIT OR Apache-2.0` |
| `rand_core v0.6.4` | `MIT OR Apache-2.0` |
| `rayon v1.12.0` | `MIT OR Apache-2.0` |
| `rayon-core v1.13.0` | `MIT OR Apache-2.0` |
| `redb v4.2.0` | `MIT OR Apache-2.0` |
| `regex v1.13.1` | `MIT OR Apache-2.0` |
| `regex-automata v0.4.18` | `MIT OR Apache-2.0` |
| `regex-syntax v0.8.11` | `MIT OR Apache-2.0` |
| `rfc6979 v0.4.0` | `Apache-2.0 OR MIT` |
| `rustc_version v0.4.1` | `MIT OR Apache-2.0` |
| `rustc-hash v2.1.3` | `Apache-2.0 OR MIT` |
| `sec1 v0.7.3` | `Apache-2.0 OR MIT` |
| `semver v1.0.28` | `MIT OR Apache-2.0` |
| `serde v1.0.229` | `MIT OR Apache-2.0` |
| `serde_bytes v0.11.19` | `MIT OR Apache-2.0` |
| `serde_core v1.0.229` | `MIT OR Apache-2.0` |
| `serde_derive v1.0.229` | `MIT OR Apache-2.0` |
| `serde_json v1.0.151` | `MIT OR Apache-2.0` |
| `sha2 v0.10.9` | `MIT OR Apache-2.0` |
| `shake v0.1.0` | `MIT OR Apache-2.0` |
| `shlex v1.3.0` | `MIT OR Apache-2.0` |
| `shlex v2.0.1` | `MIT OR Apache-2.0` |
| `signature v2.2.0` | `Apache-2.0 OR MIT` |
| `signature v3.0.0` | `Apache-2.0 OR MIT` |
| `spki v0.7.3` | `Apache-2.0 OR MIT` |
| `spki v0.8.0` | `Apache-2.0 OR MIT` |
| `sponge-cursor v0.1.0` | `MIT OR Apache-2.0` |
| `subtle v2.6.1` | `BSD-3-Clause` |
| `syn v2.0.119` | `MIT OR Apache-2.0` |
| `syn v3.0.5` | `MIT OR Apache-2.0` |
| `thiserror v2.0.20` | `MIT OR Apache-2.0` |
| `thiserror-impl v2.0.20` | `MIT OR Apache-2.0` |
| `tls_codec v0.5.0` | `Apache-2.0 OR MIT` |
| `tls_codec_derive v0.5.0` | `Apache-2.0 OR MIT` |
| `typenum v1.20.1` | `MIT OR Apache-2.0` |
| `unicode-ident v1.0.24` | `(MIT OR Apache-2.0) AND Unicode-3.0` |
| `uuid v1.26.1` | `Apache-2.0 OR MIT` |
| `version_check v0.9.5` | `MIT/Apache-2.0` |
| `wasi v0.11.1+wasi-snapshot-preview1` | `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT` |
| `windows-link v0.2.1` | `MIT OR Apache-2.0` |
| `zerocopy v0.8.57` | `BSD-2-Clause OR Apache-2.0 OR MIT` |
| `zerocopy-derive v0.8.57` | `BSD-2-Clause OR Apache-2.0 OR MIT` |
| `zeroize v1.9.0` | `Apache-2.0 OR MIT` |
| `zeroize_derive v1.5.0` | `Apache-2.0 OR MIT` |
| `zmij v1.0.23` | `MIT` |

## Obligations

Axl may select the permissive branch of dual-license expressions where the package offers one. Before distribution, the implementation change must preserve all license texts and copyright notices in the source and binary notices or SBOM required by those licenses.

Specific obligations are:

- **MIT, ISC, BSD-2-Clause, BSD-3-Clause, and Unlicense:** retain the applicable copyright, permission, and disclaimer text in distributions. Do not treat a crates.io SPDX expression as the license text.
- **Apache-2.0:** include the Apache-2.0 license, preserve notices and attribution, mark modified files where required, and respect the patent and trademark terms.
- **Unicode-3.0:** retain the Unicode license and data-file notices. `unicode-ident` requires both a permissive code-license choice and Unicode-3.0.
- **MPL-2.0:** `hpke-rs`, `hpke-rs-crypto`, and `hpke-rs-libcrux` are file-level copyleft. If Axl distributes covered source files or modified versions, it must keep those files under MPL-2.0, make source for the covered files available as required, preserve notices, and document modifications. Linking does not relicense Axl as a whole.
- **`r-efi`:** choose its MIT or Apache-2.0 option. Axl does not select LGPL-2.1-or-later.
- **Procedural and build dependencies:** retain notices when their licensed material is included in generated or distributed artifacts. Confirm this from packaged output rather than assuming build-time use creates no obligation.

No AGPL dependency appears in the selected graph. No Signal or libsignal source was inspected or used.

## Maintenance exception

Session 30 accepts one narrow maintenance exception:

| Field | Decision |
| --- | --- |
| Package | `proc-macro-error2` 2.0.1 |
| Crates.io checksum | `11ec05c52be0a07b08061f7dd003e7d7092e0472bc731b4af7bb1ef876109802` |
| Advisory | `RUSTSEC-2026-0173`, unmaintained; no vulnerability is reported |
| Complete dependency path | `proc-macro-error2 2.0.1 -> hax-lib-macros 0.3.7 -> hax-lib 0.3.7 -> libcrux-sha3 0.0.10 -> hpke-rs 0.7.0 -> openmls_libcrux_crypto 0.4.0` |
| Scope | Transitive procedural-macro/build dependency in the exact approved candidate graph only |
| Expiry | 2026-12-15 or the next relevant OpenMLS/libcrux release, whichever comes first |

The path above is one complete traced route from the procedural macro to the provider. The same `hax-lib` dependency also reaches the provider through libcrux crates including `libcrux-intrinsics` 0.0.8, `libcrux-ml-kem` 0.0.10, and `libcrux-secrets` 0.0.6. The exception does not suppress vulnerabilities, permit another version or path, or waive ordinary source and license review. Re-evaluate it on every OpenMLS or libcrux update and remove it immediately when upstream removes the dependency.

Session 40 must configure `cargo-audit` and `cargo-deny` so this exact exception, reason, path, owner decision, and expiry are explicit. Actual vulnerability findings remain fatal and may not be ignored under this maintenance exception.

## Audit and assurance

`cargo-audit` 0.22.2 scanned the disposable candidate lock against 1,246 RustSec advisories on 2026-09-14. It found no reported vulnerability and emitted only the accepted `RUSTSEC-2026-0173` maintenance warning. `cargo-deny` 0.20.2 reported the same warning. Its bans and sources checks passed; its license check failed because the disposable project deliberately had no allow-list configuration. Session 40 must add the reviewed policy for the committed graph. The selected libcrux versions are newer than the affected versions identified in `GHSA-435g-fcv3-8j26`, but the provider still requires focused review before production release.

The 2026 SRLabs OpenMLS assessment covered `openmls`, `traits`, and `basic_credential` through commit `a3402f2` from 2025-10-22. It excluded crypto and storage providers. OpenMLS 0.9.0, its PQ feature, `openmls_libcrux_crypto` 0.4.0, and every Axl adapter require review before production release. That release gate does not block the approved Session 40 implementation work.

## Sequenced gates

Before Session 40:

- exact Axl-private profile definition and security claims;
- exact dependency candidates and license inventory;
- the maintenance exception above;
- the platform-neutral transactional storage contract;
- human approval and merge of the Session 30 decision.

During Sessions 40 and 50:

- exact committed Rust toolchain and `Cargo.lock`;
- configured `cargo audit` and `cargo deny`;
- native persistence and fault injection;
- Node and browser/WASM bindings;
- Swift, Kotlin, C ABI, JNI, generated SDKs, and mobile work deferred to Phase 13;
- positive and negative native Rust, Node, and browser fixtures;
- browser persistence tests with pairing disabled until the rollback-anchor gate is resolved;
- packaging and license notices.

Before production release:

- complete platform interoperability and runtime measurements;
- provider, wrapper, binding, storage, operational, and recovery review;
- independent implementation review;
- final MPL-2.0 and third-party notice verification;
- all native, browser, fault-injection, and release gates.

OpenMLS/libcrux are approved implementation candidates for Session 40. Session 50 binding versions above are evaluation candidates only and require dependency-specific approval before any manifest or lockfile change. Production release remains fail-closed until the later gates pass.

## Primary sources

- [`openmls` 0.9.0 metadata](https://crates.io/api/v1/crates/openmls/0.9.0)
- [`openmls_libcrux_crypto` 0.4.0 metadata](https://crates.io/api/v1/crates/openmls_libcrux_crypto/0.4.0)
- [OpenMLS 0.9.0 release](https://blog.openmls.tech/posts/2026-08-25-0.9.0-release/)
- [OpenMLS source tag](https://github.com/openmls/openmls/tree/openmls-v0.9.0)
- [OpenMLS persistence requirements](https://book.openmls.tech/user_manual/persistence.html)
- [SRLabs OpenMLS assessment](https://blog.openmls.tech/SRL-OpenMLS_security_assurance_assessment.pdf)
- [libcrux advisory `GHSA-435g-fcv3-8j26`](https://github.com/cryspen/libcrux/security/advisories/GHSA-435g-fcv3-8j26)
- [`RUSTSEC-2026-0173`](https://rustsec.org/advisories/RUSTSEC-2026-0173.html)
- [RustSec advisory database](https://rustsec.org/advisories/)
- [MPL 2.0](https://www.mozilla.org/MPL/2.0/)
