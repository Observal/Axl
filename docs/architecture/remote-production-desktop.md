<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Production remote access from macOS and Linux desktop daemons

Status: proposed for architecture and security review. It extends [Production remote access from a WSL daemon](remote-production-wsl.md) to two more daemon targets and changes nothing about the WSL path. Remote access stays enabled only through the per-account opt-in, and no public support claim follows from it.

## Purpose

The production path runs today only for a daemon in WSL 2, whose envelope keys and account secrets Windows DPAPI seals through a helper. This document adds the two targets the owner chose next:

- **macOS** (arm64 and x64): built now, and signed later. Until a Developer ID signed helper exists, every macOS build fails closed.
- **Linux desktop** (glibc, x64 and arm64): a daemon running in an unlocked graphical login session, with a tested Secret Service implementation on the user's session bus.

Headless Linux stays unsupported, as the [storage RFC](production-e2ee-storage-and-rollback.md) decides. WSL remains the only headless target, through its own store.

Everything above the key store is shared with WSL and unchanged: accounts and the remote group, the production control plane, the witness and its pinned trust, session sharing, and the phone page.

## Linux desktop

### Envelope keys

The store is the RFC's selected design, already implemented in `packages/e2ee/src/persistence/linux_secret_service.rs` and until now not wired to any endpoint. Each record is one Secret Service item in the user's unlocked collection. The store:

- connects only to the user's session bus and requires the encrypted `dh-ietf1024-sha256-aes128-cbc-pkcs7` session, never the plain one;
- accepts the service only when the bus name `org.freedesktop.secrets` is owned by the selected implementation's executable (`gnome-keyring-daemon` or `kwalletd6` at their packaged paths), checked on every connection; and
- treats any prompt as a locked store. A missing session bus, a locked collection, an unknown service, or a prompt fails closed with `secure_store_unavailable` or `secure_store_locked`.

The change is to make its constructor public behind a `hosted-linux` Node artifact, which exposes `hostedLinuxDaemonEndpoint(root, implementation, ...)` with the build-pinned replica trust, as `hosted-wsl` does.

### Choosing the implementation

`axl remote login` finds the service owner's executable and records the implementation it names, `gnome-keyring` or `kwallet6`, in the account file. Any other owner refuses login. The daemon passes the recorded implementation to the store, which checks it again on every connection, so a service replaced after login fails closed instead of being trusted.

### Non-claims

As the RFC states for Secret Service: no confidentiality against another process running as the same user that can call that user's Secret Service, no hardware backing, and no portable backup. Restored or copied keyrings must still match the hosted witness, and migration is re-pairing.

## macOS

### Why a helper

The RFC selects the data-protection Keychain. That Keychain answers only a process signed with an application identifier and a `keychain-access-groups` entitlement. The daemon runs in the stock `node` executable, which carries neither, and an addon cannot add entitlements to the process that loads it. An in-process store would always fail with `errSecMissingEntitlement`.

So the Keychain work moves into a small signed executable, as DPAPI does for WSL.

### Design

- **Helper.** `axl-keychain-helper` (`packages/e2ee/helpers/keychain`, Rust, `security-framework` 3.7.0, the RFC's selected binding) speaks the WSL helper's framed protocol with the hello string `axl-keychain-helper-v1`. It is stateless toward the store: it never receives a path, a file, or a record identity, only one value of at most 64 KiB per request.
- **Wrapping key.** The helper keeps one 32-byte AES-256 key as a single generic-password item in the data-protection Keychain: service `ai.observal.axl.e2ee.sealing-key.v1`, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, never synchronized, authentication UI disabled. It creates the item on first use. The item also holds a random 16-byte key identifier.
- **Operations.** `protect` returns `version | nonce | AES-256-GCM(value)` under a fresh 96-bit random nonce. `unprotect` reverses it. `identity` reports the user's UID and the key identifier. A locked Keychain answers `unavailable`. A missing entitlement, a denied access, or a duplicate item answers `access denied`. None of them falls back to the login keychain.
- **Records.** Envelope-key records use the WSL store's file model unchanged: one owner-only file per key and lifecycle state under the daemon's data directory, written through an exclusive temporary file, synced, renamed, and followed by a directory sync. Only the seal crosses the process boundary; lifecycle and crash ordering stay in the Rust store. The file store becomes generic over its sealing helper and builds for Linux (DPAPI) and macOS (Keychain). The identity hash binds the helper's reported identity and the store owner's UID, so records written under a replaced or recreated wrapping key are refused rather than misread.

This differs from the RFC's macOS row, which stores each record as its own Keychain item. The difference is the one the WSL amendment already argues: a seal-only helper keeps every lifecycle decision in the store, which is what the RFC's objection to subprocess stores asks for. The Keychain still holds the only key that opens the records, under the same accessibility and synchronization rules the RFC selects. The existing in-process `macos_keychain.rs` store stays for a future signed runtime that can carry the entitlement itself.

### Signing

The helper ships as `AxlKeychainHelper.app/Contents/MacOS/axl-keychain-helper` with an embedded provisioning profile, because a command-line tool cannot carry a Developer ID provisioning profile on its own. It is signed with the Developer ID certificate, the hardened runtime, and the `keychain-access-groups` entitlement for Axl's team identifier, then notarized.

Until that signing exists, a locally built helper is unsigned or ad-hoc signed. The Keychain refuses it with `errSecMissingEntitlement`, the helper answers `access denied`, and login and the daemon's endpoint fail closed with `secure_store_access_denied`. CI asserts exactly this.

### What it protects and what it does not

Protected: the daemon's data directory copied to another user or another Mac (the wrapping key is `ThisDeviceOnly` and never synchronized); a record moved, edited, or written under another wrapping key; and a missing, unsigned, or replaced helper, which fails closed.

Not protected: any process running as the same macOS user that can start the signed helper can ask it to unseal. This is the same non-claim the RFC makes for Secret Service and the WSL amendment makes for DPAPI, and it is narrower than per-item Keychain access control. No hardware backing is claimed. The hosted witness remains mandatory: the Keychain is not a rollback anchor.

## Account secrets

`axl remote login` seals the refresh token and the installation's PKCS#8 key into `~/.axl/remote/account.json`, each value prefixed with its purpose and account, as today. Sealing gains one interface with three implementations:

| Target | Sealer | Account file |
| --- | --- | --- |
| WSL | DPAPI helper, as today | `sealer: { kind: "dpapi", helper }` |
| macOS | Keychain helper, same protocol | `sealer: { kind: "keychain", helper }` |
| Linux desktop | Secret Service, in process | `sealer: { kind: "secret-service", implementation }` |

On Linux, the `hosted-linux` artifact exposes a sealer that keeps one 32-byte AES-256-GCM key as a reserved record in the same Secret Service store, created on first use. An account file without a `sealer` field is a WSL file and reads as DPAPI, so existing sign-ins keep working.

Login opens the system browser with `open` on macOS and `xdg-open` on Linux. The loopback redirect and the daemon's app client are unchanged.

## Builds

`scripts/build.mjs` gains `hosted-macos` and `hosted-linux`, each pinning the stack's replica trust from `AXL_E2EE_HOSTED_TRUST_FILE` like `hosted-wsl`. `productionStorageReady` stays `false` in every artifact. `daemon-binding.sh` builds the artifact for the host it runs on.

## Evidence

In CI, before merge:

- **Linux:** the Secret Service store and the hosted endpoint against `gnome-keyring` started under `dbus-run-session` and unlocked with a throwaway password: record lifecycle, restart, the account sealer, and failing closed when the collection is locked, when another executable owns the bus name, and when no session bus exists.
- **macOS:** the helper and the `hosted-macos` artifact build on arm64 and x64 runners. The unsigned helper is refused by the Keychain and the endpoint fails with `secure_store_access_denied`. The generic file store's lifecycle and crash tests run against a test sealer.

Before the opt-in is widened, on each target, recorded in `docs/evidence/`:

- **Linux desktop:** pairing, messaging, and daemon restarts against the production stack on GNOME and KDE; logout and login; screen lock; and a keyring password change.
- **macOS:** the signed helper on arm64 and native x64 hardware: lock, sleep, fast user switching, a Keychain password change, a copied data directory on another Mac, and a replaced helper.
- The independent security review the RFCs require, covering the Keychain helper, the generic file store, and both sealers.

## Out of scope

Headless Linux, native Windows, the signing and notarization pipeline itself, and package installers. Remote permission approvals stay disabled, as in [Remote permission authorization](remote-permission-authorization.md).
