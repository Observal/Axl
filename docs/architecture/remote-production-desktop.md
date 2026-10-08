<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Production remote access from macOS and Linux desktop daemons

Status: implemented in RC behind the per-account opt-in, awaiting independent security review and release approval. The Linux desktop path passes the full phone E2E against GNOME Keyring in CI. The macOS path is built and fails closed until a verified Developer ID signed and notarized helper is installed and independently tested on both native architectures. It extends [Production remote access from a WSL daemon](remote-production-wsl.md) to two more daemon targets and changes nothing about the WSL record format. No public support claim follows from it.

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

- **Helper.** `axl-keychain-helper` (`packages/e2ee/helpers/keychain`, Rust, `security-framework` 3.7.0, the RFC's selected binding, with AES-256-GCM from the `openmls_libcrux_crypto` the core already uses) speaks the WSL helper's framed protocol with the hello string `axl-keychain-helper-v1`. It is stateless toward the store: it never receives a path, a file, or a record identity, only one value of at most 64 KiB per request.
- **Wrapping key.** The helper keeps one wrapping key as a single generic-password item in the data-protection Keychain: service `ai.observal.axl.e2ee.sealing-key.v1`, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, never synchronized, authentication UI disabled. Its value is a random 16-byte key identifier followed by the 32-byte AES-256 key. The helper creates the item on first use and reads it again for every request, so a Keychain locked since the last request is noticed. It runs only for the console user, never as root.
- **Operations.** `protect` returns `version | key identifier | nonce | AES-256-GCM(value)` under a fresh 96-bit random nonce, with the protocol name and the key identifier as associated data. `unprotect` reverses it and refuses a value sealed under another key. `identity` reports the key identifier in hex. A locked Keychain answers `unavailable`. A missing entitlement, a denied access, a duplicate or malformed item, or a value sealed under another key answers `access denied`. None of them falls back to the login keychain.
- **Records.** Envelope-key records use the WSL store's file model unchanged: one owner-only file per key and lifecycle state under the daemon's data directory, written through an exclusive temporary file, synced, renamed, and followed by a directory sync. Only the seal crosses the process boundary; lifecycle and crash ordering stay in the Rust store. The file store (`sealed_file.rs`) is generic over a sealing profile and builds for Linux (DPAPI, whose record bytes, file names, and identity domain are unchanged) and macOS (Keychain: record platform byte 5, files ending `.keychainseal`, identity domain `axl-macos-keychain-seal-v1`). Records of one profile are never read under the other. The identity hash binds the helper's reported identity and the store owner's UID, so records written under a replaced or recreated wrapping key are refused rather than misread.

This differs from the RFC's macOS row, which stores each record as its own Keychain item. The difference is the one the WSL amendment already argues: a seal-only helper keeps every lifecycle decision in the store, which is what the RFC's objection to subprocess stores asks for. The Keychain still holds the only key that opens the records, under the same accessibility and synchronization rules the RFC selects. The existing in-process `macos_keychain.rs` store stays for a future signed runtime that can carry the entitlement itself.

### Signing

The helper ships as `AxlKeychainHelper.app/Contents/MacOS/axl-keychain-helper` with an embedded provisioning profile, because a command-line tool cannot carry a Developer ID provisioning profile on its own. It is signed with the Developer ID certificate, the hardened runtime, and the `keychain-access-groups` entitlement for Axl's team identifier, then notarized. `packages/e2ee/helpers/keychain/install-macos.sh` requires a Developer ID identity, team ID, provisioning profile, and a preconfigured notarytool Keychain profile. It builds, signs, submits a ZIP to Apple, staples the accepted ticket to the app, verifies the bundle and a re-extracted stapled release ZIP, and publishes it under an immutable versioned path. After verification it atomically switches the canonical helper path to that version. A failed post-switch verification restores the old version (or removes the pointer on first install); old versions and Keychain data are retained. Upgrades require the daemon to be stopped and explicit acknowledgment; the script does not stop it. Legacy installations with a real app directory at the canonical path require a separately reviewed migration. It prints artifact hashes. Distribution through an independent channel still requires a separate reviewed procedure. Do not run it without authorization to use signing assets, submit to Apple, and install locally. `verify-macos.py` checks the exact app identity, team, signed entitlements, embedded profile, Developer ID chain, timestamp, hardened runtime, stapled ticket, and Gatekeeper assessment. A successful installer run alone does not prove a supported release or independent witnesses.

An unentitled locally built helper is only a negative-test artifact. The Keychain refuses it with `errSecMissingEntitlement`, the helper answers `access denied`, and login and the daemon's endpoint fail closed with `secure_store_access_denied`. CI asserts exactly this.

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

In CI, on every change (all passing):

- **Linux:** against `gnome-keyring` on the user's session bus, unlocked with a throwaway password (`E2EE Linux Secret Service`):
  - the store: record lifecycle, restart, the account sealer;
  - failing closed when the collection is locked, when another implementation is named, and when no session bus exists;
  - the hosted binding and the account sealing in TypeScript.

  `Remote phone E2E (Linux desktop keyring)` runs all 14 phone scenarios with the daemon's keys in that keyring: pairing, turns, dropped and stalled connections, daemon, relay, and control-plane restarts, questions, sharing, a second tab, and re-pairing.
- **macOS:** on arm64 and x64 runners (`E2EE macOS Keychain`):
  - the helper's and the generic file store's tests;
  - a locally built, unsigned helper is refused by the Keychain, in three places: the store (`secure_store_access_denied`), the `hosted-macos` binding, and account sealing.

  The darwin Node legs build `hosted-macos` for the ABI check.
- **WSL:** the WSL profile's record bytes, file names, and identity domain are pinned by a test. The real `axl-dpapi-helper.exe` round-trips records through the generic store.

The Secret Service store reuses one validated connection and its encrypted session while the same service process owns the bus name and the collection stays unlocked, checking both on every operation. Each key rotation still writes the keyring through GNOME Keyring's own item creation and deletion.

Before the opt-in is widened, on each target, recorded in `docs/evidence/`:

- **Linux desktop:** pairing, messaging, and daemon restarts against the production stack on GNOME and KDE; logout and login; screen lock; and a keyring password change.
- **macOS:** the signed helper on arm64 and native x64 hardware: lock, sleep, fast user switching, a Keychain password change, a copied data directory on another Mac, and a replaced helper.
- The independent security review the RFCs require, covering the Keychain helper, the generic file store, and both sealers.

## Out of scope

Headless Linux, native Windows, the signing and notarization pipeline itself, and package installers. Remote permission approvals stay disabled, as in [Remote permission authorization](remote-permission-authorization.md).
