<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Production remote access from a WSL daemon

Status: proposed for architecture and security review. It amends [Production E2EE storage and rollback](production-e2ee-storage-and-rollback.md) for one target and is enabled only through an explicit per-account opt-in. No public support claim follows from it.

## Purpose

Remote access today runs only in deployment-test mode: one shared account token, envelope keys in an owner-only file, and a witness whose three replicas share one process. This document describes the first production path, which replaces each of those, for the owner's own setup: an Axl daemon in WSL 2 on a Windows x64 machine, paired with a phone browser.

WSL was chosen because Axl's daemon cannot run natively on Windows. Its sandbox backends are Bubblewrap and Seatbelt, and there is no unsandboxed fallback. WSL is also the headless Linux case the storage RFC leaves without a v1 store. This document adds a store for that case instead of weakening the RFC's rules for other targets.

## Scope

In scope:

- a WSL envelope-key store whose records are sealed by Windows DPAPI;
- per-person accounts (Google through the Cognito user pool) for the daemon and the phone, replacing the shared deployment-test token;
- a production mode for the hosted stack that authorizes by account, installation, and device, with no static credentials;
- the production daemon host and browser page, enabled by an opt-in; and
- the evidence each of these needs before the opt-in is widened.

Out of scope: native Windows, macOS, and Linux desktop daemons (their RFC rows are unchanged), remote permission approvals (see [Remote permission authorization](remote-permission-authorization.md)), and enabling remote access for anyone but opted-in accounts.

## Envelope keys in WSL

### Design

The store in `packages/e2ee/src/persistence/wsl_dpapi.rs` keeps the record model of the native Windows store:

- one record file per key and lifecycle state (`prepared`, `active`) under the daemon's data directory;
- each record binds a format version, a platform tag, an identity hash, the crypto session, the key ID, the hash of the authenticated context, the lifecycle, and the 32-byte data key;
- writes go to an exclusive temporary file created with mode `0600` and `O_NOFOLLOW`, are synced, renamed into place, and followed by a directory sync;
- the directory must belong to the daemon's Linux user with no group or other access, and every record file is checked the same way before it is read; and
- activation, reconciliation, erasure, and session destruction follow the Windows store exactly, so an interrupted activation resolves to one active record.

Only the sealing crosses to Windows. `axl-dpapi-helper.exe` (`packages/e2ee/helpers/dpapi`) is started through WSL interop, so it runs as the signed-in Windows user. It seals each encoded record with nested machine-scope then user-scope DPAPI, the same nesting as the native Windows store, and reports that user's SID. It is stateless: it never receives a path, a file, or a record identity, only one value of at most 64 KiB per request, over framed stdin and stdout. Every lifecycle and crash-ordering decision stays in the Rust store.

The identity hash binds both the Windows SID the helper reports and the Linux user ID that owns the store. The store refuses to run as root, and a record whose identity, session, key, or lifecycle does not match its file name is rejected.

### Why this differs from the rejected substitutes

The RFC rejects `systemd-creds` as a subprocess because "dynamic per-operation key records and exact crash reconciliation would cross a command boundary and depend on external mutable files". Here nothing but a pure seal or unseal of one value crosses the boundary. Record files, their lifecycle, and their crash ordering stay in the store, which is what the objection asks for. The helper keeps no state that a crash could leave half-written.

It is not a plaintext or statically encrypted file: the data key rests sealed by a key the Windows user's logon credentials protect, bound to this machine.

### What it protects and what it does not

Protected:

- the WSL virtual disk (`ext4.vhdx`) or a backup of it, copied to another machine or opened by another Windows user: records do not unseal;
- a record moved between keys, sessions, or lifecycle states, or edited on disk: it is rejected; and
- a helper that is missing, replaced by a non-Windows binary, or not answering the protocol: the store fails closed with `secure_store_unavailable`.

Not protected, stated explicitly as the RFC does for Secret Service:

- any process running as the same Linux user in the same WSL instance, or as the same Windows user, can ask the helper to unseal. This matches the Secret Service non-claim against malicious same-user processes;
- no hardware backing is claimed. DPAPI keys derive from the user's logon secret and the machine's LSA secrets, not from a TPM; and
- the helper binary is trusted as found at its configured absolute path. Replacing it requires the same Windows user's write access.

The hosted witness remains mandatory. DPAPI sealing is not a rollback anchor.

### Helper protocol

```text
request:  op u8 | length u32 (big-endian) | payload
response: status u8 | length u32 (big-endian) | payload

op 0 hello     -> "axl-dpapi-helper-v1"
op 1 identity  -> the Windows user SID, UTF-8
op 2 protect   -> nested machine-scope then user-scope DPAPI blob
op 3 unprotect -> the sealed value

status 0 ok, 1 unavailable, 2 access denied, 3 bad request
```

A helper that stops answering is restarted once per request; DPAPI's own refusals are final. A frame longer than 64 KiB ends the helper.

## Accounts

The Cognito user pool that signs the phone in (`auth.remote.observal.io`, Google as the identity provider) becomes the account system for remote access. The account ID is the pool's `sub`.

- **Phone**: the page's app client, authorization code flow with PKCE, as today. Its access tokens carry the phone scope: pairing, device enrollment, device relay tickets, and the witness.
- **Daemon**: `axl remote login` runs the same flow with a second public app client whose redirect is a loopback address, opening the Windows browser from WSL. The refresh token is sealed through the helper like an envelope key and stored beside the daemon's remote state. Its access tokens carry the daemon scope.

The control plane never accepts a static account token in production.

## Production control plane

A production runtime replaces the deployment-test runtime's single configured account:

- accounts and installations come from tokens and registration, not from environment variables;
- a daemon registers its installation with its own relay-possession key, which replaces the static possession proof. Each device already proves possession with its own key;
- relay tickets, pairing, device enrollment, and witness admission are authorized per account, installation, and device;
- remote access is refused unless the account is on the opt-in list; and
- quotas bound pairing attempts, link publication, and witness requests per account.

It replaces the deployment-test runtime on the existing stack (`infra/aws/hosted-path-test`, `remote.observal.io`) rather than running beside it. In production mode the stack holds no shared account token, so none can be accepted. Deployment-test mode remains only in the local end-to-end harness.

## Witness

The witness keeps its current shape: three replicas inside the control plane, each with its own Ed25519 signing key and its own DynamoDB records and high-water journal, recovering lineage by lineage after a restart. The gateway requires all three receipts.

This does not meet the RFC's "independently administered" requirement. One account's credentials can reach all three replicas, so they protect against a lost or rolled-back table, not against a compromised operator account. Spreading the replicas over regions of the same account was considered and rejected for now: it would add two cross-region round trips to every message and make any one region an outage for all of remote access, while buying no independence. Three replicas in separately administered accounts, each its own service, are a prerequisite for widening the opt-in beyond the owner.

Replica trust (the three public verification keys) is pinned into the production daemon and browser builds, never taken from a link or a server response.

## Enablement

Production endpoint constructors stay fail-closed in every build except the WSL target, where the daemon uses them only when all of the following hold:

1. the daemon's remote configuration sets `production: true`;
2. `axl remote login` has stored a session for an account on the opt-in list;
3. the helper answers and its identity matches the store's records; and
4. the build carries production replica trust.

`productionStorageReady` in the artifact metadata stays `false`. The browser page follows the same rule with its own production build.

## Evidence before widening the opt-in

Run on this target and recorded in `docs/evidence/`:

- store: record lifecycle, crash between every write and rename step, restart after `wsl --shutdown`, Windows sign-out and sign-in, Windows reboot, a copied `ext4.vhdx` opened by another Windows user, and a helper removed or replaced;
- daemon: pairing, messaging, and daemon restarts against the production stack, with the opt-in checked at each step;
- witness: loss and restore of each replica, and rollback of any two, with endpoints failing closed;
- browser: the production page on Chrome and Safari on phones, including suspension and storage pressure; and
- the independent security review the RFCs require, covering this store, the helper, the account flows, and the witness services.
