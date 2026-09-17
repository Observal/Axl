<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
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

## Production storage: Linux Secret Service

The Linux-only envelope-key store uses these exact target-specific declarations:

```toml
[target.'cfg(target_os = "linux")'.dependencies]
secret-service = { git = "https://github.com/Observal/secret-service-rs.git", rev = "1721451b21acfc3450be8799d92947653a5656e3", version = "=5.2.0", default-features = false, features = ["rt-async-io-crypto-rust"] }
zbus = { version = "=5.19.0", default-features = false, features = ["async-io", "blocking-api"] }
```

The fork is based directly on upstream `secret-service` tag and commit
`1fe4fbe405b152bc969deb5de417847e1e4e4c7b`. Its DCO-signed patch adds only public item creation and deletion outcomes that return a required
prompt without executing it. The diff from the upstream tag has SHA-256
`b9048014c837a0f7d60143feb2d9fb02030ed8dd8f011b422d17c6e137aefe15`. Direct `zbus` use is limited
to checking the session-bus connection and the stable service owner, UID, PID, and executable. The
fork continues to own Secret Service framing and the
`dh-ietf1024-sha256-aes128-cbc-pkcs7` session implementation. The upstream crates.io checksum does
not authenticate the fork; Cargo pins and fetches the full Git commit instead.

The E2EE lock changed from SHA-256
`71b54b75338347f4d465a0b11bcf207a40e554233db2e8a136f070220b107878` to
`8a74b467d18ea8a6287d244bc76670ffbea62d5a68c73ecf4badce46dec830fb`. The Linux
`axl-e2ee` normal/build selection grows from 123 to 198 external package/version pairs. The
Secret Service subtree contains 101 external pairs; 75 were not selected by the prior Linux build.
The lock adds the following 55 records. Entries already present in the lock but newly selected on
Linux are not repeated in this lock-delta table.

| Package | Integrity | License | Special target |
| --- | --- | --- | --- |
| `aes` 0.9.3 | `35f0f96ce78e38c3dc6d8948aa8163d06385be74000f3c7a95bf1eef35d3ea32` | MIT OR Apache-2.0 | none |
| `async-broadcast` 0.7.2 | `435a87a52755b8f27fcf321ac4f04b2802e337c8c4872923137471ec39c37532` | MIT OR Apache-2.0 | none |
| `async-channel` 2.5.0 | `924ed96dd52d1b75e9c1a3e6275715fd320f5f9439fb5a4a11fa51f4221158d2` | Apache-2.0 OR MIT | none |
| `async-executor` 1.14.0 | `c96bf972d85afc50bf5ab8fe2d54d1586b4e0b46c97c50a0c9e71e2f7bcd812a` | Apache-2.0 OR MIT | none |
| `async-io` 2.6.0 | `456b8a8feb6f42d237746d4b3e9a178494627745c3c56c6ea55d92ba50d026fc` | Apache-2.0 OR MIT | build script |
| `async-lock` 3.4.2 | `290f7f2596bd5b78a9fec8088ccd89180d7f9f55b94b0576823bbbdc72ee8311` | Apache-2.0 OR MIT | none |
| `async-process` 2.5.0 | `fc50921ec0055cdd8a16de48773bfeec5c972598674347252c0399676be7da75` | Apache-2.0 OR MIT | none |
| `async-recursion` 1.1.1 | `3b43422f69d8ff38f95f1b2bb76517c91589a924d1559a0e935d7c8ce0274c11` | MIT OR Apache-2.0 | procedural macro |
| `async-signal` 0.2.14 | `52b5aaafa020cf5053a01f2a60e8ff5dccf550f0f77ec54a4e47285ac2bab485` | Apache-2.0 OR MIT | none |
| `async-task` 4.7.1 | `8b75356056920673b02621b35afd0f7dda9306d03c79a30f5c56c44cf256e3de` | Apache-2.0 OR MIT | none |
| `atomic-waker` 1.1.2 | `1505bd5d3d116872e7271a6d4e16d81d0c8570876c8de68093a09ac269d8aac0` | Apache-2.0 OR MIT | none |
| `block-padding` 0.4.2 | `710f1dd022ef4e93f8a438b4ba958de7f64308434fa6a87104481645cc30068b` | MIT OR Apache-2.0 | none |
| `blocking` 1.7.0 | `a70e4329df6cb94385eed412ec92375c3cdd8a6e502493d1229b6414e4036dfa` | Apache-2.0 OR MIT | none |
| `cbc` 0.2.1 | `ce2dc9ee5f88d11e0beb842c88b33c8a5cf0d1329c4b19494af42b07dbfe8896` | MIT OR Apache-2.0 | none |
| `cipher` 0.5.2 | `e8cf2a2c93cd704877c0858356ed03480ff301ee950b43f1cbe4573b088bfa6c` | MIT OR Apache-2.0 | none |
| `concurrent-queue` 2.5.0 | `4ca0197aee26d1ae37445ee532fefce43251d24cc7c166799f4d46817f1d3973` | Apache-2.0 OR MIT | none |
| `cpubits` 0.1.1 | `15b85f9c39137c3a891689859392b1bd49812121d0d61c9caf00d46ed5ce06ae` | MIT OR Apache-2.0 | none |
| `endi` 1.1.1 | `66b7e2430c6dff6a955451e2cfc438f09cea1965a9d6f87f7e3b90decc014099` | MIT | none |
| `enumflags2` 0.7.12 | `1027f7680c853e056ebcec683615fb6fbbc07dbaa13b4d5d9442b146ded4ecef` | MIT OR Apache-2.0 | none |
| `enumflags2_derive` 0.7.12 | `67c78a4d8fdf9953a5c9d458f9efe940fd97a0cab0941c075a813ac594733827` | MIT OR Apache-2.0 | procedural macro |
| `errno` 0.3.14 | `39cab71617ae0d63f51a36d69f866391735b51691dbda63cf6f96d042b63efeb` | MIT OR Apache-2.0 | none |
| `event-listener` 5.4.2 | `5a23add41df1562121a9393cb065eab5146a1242410f23a644851e90cfd669d2` | Apache-2.0 OR MIT | none |
| `event-listener-strategy` 0.5.4 | `8be9f3dfaaffdae2972880079a491a1a8bb7cbed0b8dd7a347f668b4150a3b93` | Apache-2.0 OR MIT | none |
| `fastrand` 2.5.0 | `da7c62ceae207dd37ea5b845da6a0696c799f85e97da1ab5b7910be3c1c80223` | Apache-2.0 OR MIT | none |
| `futures-lite` 2.6.1 | `f78e10609fe0e0b3f4157ffab1876319b5b0db102a2c60dc4626306dc46b44ad` | Apache-2.0 OR MIT | none |
| `hermit-abi` 0.5.3 | `e17592d60ebacc7d5e169f4663c5f84f9161cc90328abcfe8456f41e4dfcb284` | MIT OR Apache-2.0 | none |
| `inout` 0.2.2 | `4250ce6452e92010fdf7268ccc5d14faa80bb12fc741938534c58f16804e03c7` | MIT OR Apache-2.0 | none |
| `linux-raw-sys` 0.12.1 | `32a66949e030da00e8c7d4434b251670a91556f4144941d37452769c25d58a53` | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | none |
| `memoffset` 0.9.1 | `488016bfae457b036d996092f6cb448677611ce4449e970ceaf42695203f218a` | MIT | build script |
| `num` 0.4.3 | `35bd024e8b2ff75562e5f34e7f4905839deb4b22955ef5e73d2fea1b9813cb23` | MIT OR Apache-2.0 | none |
| `num-complex` 0.4.6 | `73f88a1307638156682bada9d7604135552957b7818057dcef22705b4d509495` | MIT OR Apache-2.0 | none |
| `num-iter` 0.1.46 | `c92800bd69a1eac91786bcfe9da64a897eb72911b8dc3095decbd07429e8048b` | MIT OR Apache-2.0 | none |
| `num-rational` 0.4.2 | `f83d14da390562dca69fc84082e73e548e1ad308d24accdedd2720017cb37824` | MIT OR Apache-2.0 | none |
| `ordered-stream` 0.2.0 | `9aa2b01e1d916879f73a53d01d1d6cee68adbb31d6d9177a8cfce093cced1d50` | MIT OR Apache-2.0 | none |
| `parking` 2.2.1 | `f38d5652c16fde515bb1ecef450ab0f6a219d619a7274976324d5e377f7dceba` | Apache-2.0 OR MIT | none |
| `piper` 0.2.5 | `c835479a4443ded371d6c535cbfd8d31ad92c5d23ae9770a61bc155e4992a3c1` | MIT OR Apache-2.0 | none |
| `polling` 3.11.0 | `5d0e4f59085d47d8241c88ead0f274e8a0cb551f3625263c05eb8dd897c34218` | Apache-2.0 OR MIT | none |
| `proc-macro-crate` 3.5.0 | `e67ba7e9b2b56446f1d419b1d807906278ffa1a658a8a5d8a39dcb1f5a78614f` | MIT OR Apache-2.0 | none |
| `rustix` 1.1.5 | `891efababe418670775f199f0d233d84843c227a0949a883ce15b37c78d6629d` | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | build script |
| `secret-service` 5.2.0 | Git commit `1721451b21acfc3450be8799d92947653a5656e3` | MIT OR Apache-2.0 | none |
| `serde_repr` 0.1.21 | `8d3b1629de253c70a0508c3899572da79ca359fdab27c7920ff00406df418906` | MIT OR Apache-2.0 | procedural macro |
| `signal-hook-registry` 1.4.8 | `c4db69cba1110affc0e9f7bcd48bbf87b3f4fc7c61fc9155afd4c469eb3d6c1b` | MIT OR Apache-2.0 | none |
| `tempfile` 3.27.0 | `32497e9a4c7b38532efcdebeef879707aa9f794296a4f0244f6f69e9bc8574bd` | MIT OR Apache-2.0 | none |
| `toml_edit` 0.25.15+spec-1.1.0 | `1340ea94a5856333492c9064b02c778b191dd2c853778d9609debdcdfea3a614` | MIT OR Apache-2.0 | none |
| `tracing` 0.1.44 | `63e71662fa4b2a2c3a26f570f037eb95bb1f85397f3cd8076caed2f026a6d100` | MIT | none |
| `tracing-attributes` 0.1.31 | `7490cfa5ec963746568740651ac6781f701c9c5ea257c58e057f3ba8cf69e8da` | MIT | procedural macro |
| `tracing-core` 0.1.36 | `db97caf9d906fbde555dd62fa95ddba9eecfd14cb388e4f491a66d74cd5fb79a` | MIT | none |
| `uds_windows` 1.2.1 | `f2f6fb2847f6742cd76af783a2a2c49e9375d0a111c7bef6f71cd9e738c72d6e` | MIT | none |
| `zbus` 5.19.0 | `5db4be7c075cb421e4b7ee645541604239bd243ba7c357511f4ff3a74b555907` | MIT | none |
| `zbus_macros` 5.19.0 | `2990635d09ade6df1868f72f8cac69a876a90981e8bd3c40b1be413f8dc88f40` | MIT | procedural macro |
| `zbus_names` 4.3.4 | `d8bf88b4a3ff53e883001e0e0115b297a9d53c31b9c1edd2bfdd853e3428624e` | MIT | none |
| `zcheapstr` 1.1.0 | `d1afec51604565183aeb5c54c20aeab286120d4e4460f7f76e3e8bb8c0d99473` | MIT | none |
| `zvariant` 5.15.0 | `c1d34c27cc6cdd1f458427519dd6b8612f7b7e3f7b9a0b2355d041dda9869147` | MIT | none |
| `zvariant_derive` 5.15.0 | `864155e69b4352db0c7f374917bf45d1e0c8d17659c8b3dbf9795f3673f8c497` | MIT | procedural macro |
| `zvariant_utils` 4.2.0 | `bad0294361a320b694a328460dc73add56c306150f5cb6bfafc44446120008a3` | MIT | none |

The selected 101-pair Linux closure is:

```text
aes 0.9.3; async-broadcast 0.7.2; async-channel 2.5.0; async-executor 1.14.0;
async-io 2.6.0; async-lock 3.4.2; async-process 2.5.0; async-recursion 1.1.1;
async-signal 0.2.14; async-task 4.7.1; async-trait 0.1.92; atomic-waker 1.1.2;
autocfg 1.5.1; bitflags 2.13.2; block-buffer 0.12.1; block-padding 0.4.2;
blocking 1.7.0; cbc 0.2.1; cfg-if 1.0.4; cipher 0.5.2; cmov 0.5.4;
concurrent-queue 2.5.0; const-oid 0.10.2; cpubits 0.1.1; cpufeatures 0.3.1;
crossbeam-utils 0.8.23; crypto-common 0.2.2; ctutils 0.4.2; digest 0.11.3;
endi 1.1.1; enumflags2 0.7.12; enumflags2_derive 0.7.12; equivalent 1.0.2;
errno 0.3.14; event-listener 5.4.2; event-listener-strategy 0.5.4; fastrand 2.5.0;
futures-channel 0.3.34; futures-core 0.3.34; futures-io 0.3.34; futures-lite 2.6.1;
futures-macro 0.3.34; futures-sink 0.3.34; futures-task 0.3.34;
futures-util 0.3.34; getrandom 0.4.3; hashbrown 0.17.1; hex 0.4.3; hkdf 0.13.0;
hmac 0.13.0; hybrid-array 0.4.15; indexmap 2.14.2; inout 0.2.2; libc 0.2.189;
linux-raw-sys 0.12.1; memchr 2.8.3; num 0.4.3; num-bigint 0.4.8;
num-complex 0.4.6; num-integer 0.1.47; num-iter 0.1.46; num-rational 0.4.2;
num-traits 0.2.19; once_cell 1.21.4; ordered-stream 0.2.0; parking 2.2.1;
pin-project-lite 0.2.17; piper 0.2.5; polling 3.11.0; proc-macro-crate 3.5.0;
proc-macro2 1.0.107; quote 1.0.47; rand_core 0.10.1; rustix 1.1.5;
secret-service 5.2.0 (Git 1721451b21acfc3450be8799d92947653a5656e3);
serde 1.0.229; serde_core 1.0.229; serde_derive 1.0.229; serde_repr 0.1.21;
sha2 0.11.0; signal-hook-registry 1.4.8; slab 0.4.12; syn 2.0.119; syn 3.0.5;
toml_datetime 1.1.1+spec-1.1.0; toml_edit 0.25.15+spec-1.1.0;
toml_parser 1.1.3+spec-1.1.0; tracing 0.1.44; tracing-attributes 0.1.31;
tracing-core 0.1.36; typenum 1.20.1; unicode-ident 1.0.24; uuid 1.26.1;
winnow 1.0.4; zbus 5.19.0; zbus_macros 5.19.0; zbus_names 4.3.4;
zcheapstr 1.1.0; zvariant 5.15.0; zvariant_derive 5.15.0; zvariant_utils 4.2.0
```

The new lock entries with build scripts are `async-io`, `memoffset`, and `rustix`. The new lock
entries that are procedural macros are `async-recursion`, `enumflags2_derive`, `serde_repr`,
`tracing-attributes`, `zbus_macros`, and `zvariant_derive`; the existing lock entries `async-trait`
and `futures-macro` also become selected by the Linux graph. None downloads or builds an executable or invokes a C or C++ compiler. The
runtime native dependency is the same-user D-Bus session and an explicitly selected GNOME Keyring
or KWallet 6 process. No OpenSSL, `pkg-config`, native cryptographic library, development dependency,
or downloaded tool is selected. `zbus` 5.19.0 has crates.io checksum
`5db4be7c075cb421e4b7ee645541604239bd243ba7c357511f4ff3a74b555907`, annotated tag object
`0d2f4c84e1cdfdbfae3353fb267c104b0abc16b4`, and source commit
`7518d73db4dbf830ec1c9c43865bf8aeae9a8ffd`.

The adapter accepts only an interactive non-root desktop login, canonical `/run/user/<uid>`, the
matching user bus, and a same-UID stable owner whose executable matches the selected GNOME Keyring
or KWallet 6 policy. It uses the selected service's existing unlocked default collection under the
RFC's explicit default-collection policy, never requests collection creation or unlock, negotiates
only `EncryptionType::Dh`, rejects locked items and every returned prompt,
validates exact public attributes and protected record bindings, loads active records only,
reconciles prepared records, and verifies deletion. It reports `hardware_backing = false` and has no
fallback. Headless Linux and unknown implementations remain unsupported. The Node binding does not
construct this store and both Linux support rows remain disabled pending real GNOME Keyring and
KWallet version, login, lock, restart, crash, installer, glibc x64, and glibc arm64 evidence.

## Production storage: Windows DPAPI

The Windows-only store adds this exact declaration:

```toml
[target.'cfg(target_os = "windows")'.dependencies]
windows-sys = { version = "=0.61.2", default-features = false, features = ["Win32_Foundation", "Win32_Security", "Win32_Security_Authorization", "Win32_Security_Cryptography", "Win32_Storage_FileSystem", "Win32_System_Memory", "Win32_System_Threading"] }
```

`windows-sys` 0.61.2 and `windows-link` 0.2.1 were already present in the E2EE lock. This declaration
adds no package, checksum, build script, procedural macro, native library, development dependency,
or downloaded tool. `windows-sys` has crates.io checksum
`ae137229bcbd6cdf0f7b80a31df61766145077ddf49416a728b02cb3921ff3fc`, license
MIT OR Apache-2.0, and source commit `32c3144490c016fe496a0aed769bce60987a2e9d`.
`windows-link` 0.2.1 has checksum
`f0805222e57f7521d6a62e36fa9163bc891acd422f971205e6fbbf078b7d9b7c` and license
MIT OR Apache-2.0. The E2EE lock changes only the `axl-e2ee` dependency edge and has SHA-256
`97baca6640f5c1760d12749cbab2baee01bc25d452dd13e6dbf1624caf87c606`.

The selected Win32 APIs cover DPAPI, process-token SID lookup, security descriptor conversion and
verification, file and directory handles, reparse metadata, final handle paths, write-through
replacement, and `FlushFileBuffers`. The store applies machine-scope DPAPI before user-scope DPAPI,
forbids UI in both directions, binds the protected plaintext to the expected daemon SID, session,
key, context hash, lifecycle, format, and platform, and reports `hardware_backing = false`. Built-in
service identities are rejected. The production factory and loader remain disabled until a dedicated
non-roaming account and the complete x64 and ARM64 runtime, filesystem, addon, signing, and installer
matrices pass.

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
