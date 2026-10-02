<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Production E2EE storage v1 evidence

Status date: 2026-09-17

This record covers the implementation in PR #413. It is not a platform-support declaration. Missing
hardware or runtime evidence is recorded as unavailable rather than inferred from compilation.
Production constructors remain fail-closed and both binding manifests keep
`productionStorageReady: false`.

## Support decision

| Target | Implementation in tree | Evidence available in this change | Production status |
| --- | --- | --- | --- |
| macOS arm64 | Keychain store and serialized lifecycle | Source tests and CI runtime job | Unsupported pending complete signed/unsigned, login-lock, crash, reboot, restore, installer, and notarization evidence |
| macOS x64 | Keychain store and serialized lifecycle | Source tests and CI runtime job | Unsupported pending the same matrix on native Intel hardware |
| Linux glibc x64 | Secret Service store with no-prompt fork | Unit/model tests and native compilation | Unsupported pending GNOME Keyring and KWallet 6 login, lock, owner-change, restart, crash, and installer evidence |
| Linux glibc arm64 | Secret Service store with no-prompt fork | Cross-compilation enforced in CI | Unsupported pending native arm64 runtime and desktop-service evidence |
| Windows MSVC x64 | Nested machine/user DPAPI store and hardened filesystem helpers | Native Windows record/policy test job and cross-compilation | Unsupported pending DPAPI, ACL, reparse, NTFS/ReFS, reboot, restore, signing, addon, and installer evidence |
| Windows MSVC arm64 | Nested machine/user DPAPI store and hardened filesystem helpers | Cross-compilation enforced in CI | Unsupported pending native ARM64 execution and the full Windows matrix |
| Browser | Worker-private Web Lock, IndexedDB, WebCrypto store and Rust certificate verifier | Firefox runtime, production/test artifact separation, ABI and package checks | Unsupported pending private transition finalization, production witness trust/transport, Chrome, Edge, WebKit, actual Safari, private mode, suspension, storage-pressure, profile-migration, restore, update, and device-restart evidence |
| Headless Linux and musl | No approved store | Fail-closed loader behavior | Unsupported |

## Local execution environment

- Linux x86_64 under WSL2, kernel `6.6.87.2-microsoft-standard-WSL2`
- Node `24.15.0`
- pnpm `11.25.0`
- Rust and Cargo `1.96.0`
- No native macOS, Windows, GNOME Keyring, KWallet 6, Chrome, Edge, Safari, signing,
  notarization, installer, reboot, restore, or native ARM64 environment was available locally.
- A checksum-verified Playwright Firefox 155.0 revision 1543 was available and executed.
- The checksum-verified Playwright WebKit 26.6 revision 2359 archive installed, but this WSL host
  lacked its required system libraries. This is unavailable evidence, not a passing result.

## Verified behavior

The focused implementation checks established the following on the available host:

- the macOS, Linux, and Windows stores compile only on their target gates;
- Windows x64 and ARM64 test targets cross-compile;
- the Linux no-prompt store model tests pass on native Linux;
- witness v1 keeps exactly three replicas and unanimous certificate verification;
- Node copies and bounds certificate input, binds continuation to the committed operation ID,
  verifies the certificate in Rust, recovers the byte-identical request, and releases the exact
  committed result only after native barriers report ready;
- production Node packages exclude test constructors, stores, anchors, and witness recovery helpers;
- the production browser artifact contains the storage module and Rust certificate verifier but no
  test anchor, deterministic fixture constructor, fault selector, dynamic code execution, external
  URL, raw-key export call, or public storage constructor;
- Firefox exercises production Web Lock contention, strict IndexedDB commit, non-extractable
  wrapping-key persistence, wrapped state-key recovery, exact request recovery, certificate
  continuation, exact result retry, and restart;
- production endpoint constructors remain fail-closed and support metadata remains false.

## Commands

The final local audit ran the repository-wide and focused commands below. Every available command
passed. `cargo deny check` completed with its pre-existing allowed duplicate-version and unmatched
allowance warnings. Direct `reuse lint` was obstructed only because the checkout contains an
unrelated untracked `axl-remote-control-architecture.md:Zone.Identifier` file with no SPDX metadata;
the clean tracked tree is checked separately. Chrome was unavailable, and WebKit could not launch
because this WSL host lacks its system libraries. Those rows remain unsupported and are delegated
to the existing CI jobs rather than reported as local passes.

```text
pnpm check
pnpm check:boundaries
pnpm check:generated
reuse lint
pnpm audit --audit-level high
cd packages/e2ee && cargo test --locked
cd packages/e2ee && cargo fmt --check
cd packages/e2ee && cargo clippy --locked --all-targets -- -D warnings
cd packages/e2ee && cargo clippy --locked -p axl-e2ee --all-targets --features browser-test-fixtures -- -D warnings
cd packages/e2ee && cargo clippy --locked -p axl-e2ee-node --all-targets --features test-fixtures -- -D warnings
cd packages/e2ee && cargo audit --deny warnings
cd packages/e2ee && cargo deny check
cd packages/e2ee && cargo check --locked -p axl-e2ee --tests --target aarch64-unknown-linux-gnu
cd packages/e2ee && cargo check --locked -p axl-e2ee --tests --target x86_64-pc-windows-msvc
cd packages/e2ee && cargo check --locked -p axl-e2ee --tests --target aarch64-pc-windows-msvc
pnpm --filter @axl/e2ee-node test
pnpm --filter @axl/e2ee-node check:abi
pnpm --filter @axl/e2ee-node pack:local
pnpm --filter @axl/e2ee-browser build
pnpm --filter @axl/e2ee-browser build:test
pnpm --filter @axl/e2ee-browser check:abi
pnpm --filter @axl/e2ee-browser check:types
pnpm --filter @axl/e2ee-browser pack:local
pnpm --filter @axl/e2ee-browser exec playwright test --project=firefox
```

## Fail-closed gate

No unavailable row may be changed to supported based on cross-compilation, a simulated service, a
Playwright engine standing in for the named browser, or another architecture's result. Enabling any
constructor requires the complete row-specific evidence, pinned production witness keys and
transport, signed package provenance, and a separate reviewed change.
