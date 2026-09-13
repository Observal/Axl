<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Remote daemon authority

Status: approved infrastructure behind test-only fake E2EE

## Scope

This slice establishes durable installation-scoped device authority without enabling a network remote transport in the daemon. `packages/daemon/src/remote-authority.ts` owns the local record and effective grant calculation. An internal authenticated attachment connects an explicitly allowlisted subset of existing RPCs to the same daemon dispatcher and command journal. The relay and control plane cannot widen daemon authority.

The processing contract remains:

```text
open through injected endpoint crypto
  -> authenticated device identity
  -> validate typed request
  -> load current grants and revocation
  -> authorize the required remote scope
  -> apply daemon command idempotency
  -> durably accept
  -> execute
```

Tests exercise this ordering with the deterministic fake E2EE adapter, internal authenticated attachment, and daemon command journal. Production code does not import or expose the fake adapter.

## Grant model

A paired device has two independent grants:

- **local grant:** created by the authoritative daemon during pairing
- **hosted grant:** a control-plane restriction delivered with a monotonic generation

Effective scopes are the exact intersection. A hosted grant can never add a scope absent from the local grant. Missing hosted state fails closed for hosted remote access.

Initial scope identifiers are:

```text
observe
steer
approve_within_policy
manage_sessions
```

Scopes are independent. Holding `steer` does not implicitly grant `observe`, approval, or session management.

## Persistence

The daemon stores `remote-authority.json` under its protected data directory with mode `0600`. Writes use a private temporary file, file synchronization, atomic rename, and directory synchronization. Readers reject symlinks, non-regular files, files above 1 MiB before parsing, malformed records, more than 256 devices, duplicate device IDs, unknown scopes, invalid identifiers, and installation-identity mismatch.

The record contains no private key, credential, relay ticket, ratchet state, ciphertext, prompt, or command body.

## Generations and revocation

Local and hosted grants have separate positive generations. A hosted update must have a greater generation, or be a byte-equivalent retry of the current generation. A conflicting equal generation and every lower generation fail.

Revocation is terminal for one device identity. Neither a local re-registration nor a later hosted grant may restore it. Restoring access requires a new pairing and new device identity. This avoids reviving a lost-device key through stale or compromised hosted state.

Every request reloads the current in-memory state after serialized durable updates. Revocation prevents new authorization. Work already durably accepted remains daemon-owned.

## Internal RPC mapping

The internal attachment supports only methods listed in `packages/daemon/src/remote-rpc.ts`. Observation methods require `observe`; send, steering, queued-input, and interrupt methods require `steer`. Direct shell execution, provider authentication, generic MCP interaction responses, session administration, blob upload, configuration changes, and every unknown or future method are denied by default.

Retryable mutations enter the existing daemon command journal while the authority store serializes grant checks through durable acceptance. Revocation may proceed immediately after acceptance without waiting for operation completion. Non-mutating requests recheck authority immediately before dispatch.

## Current non-capabilities

This module is not wired to the relay, runtime, CLI, SDK, or ordinary sessions. It does not:

- authenticate cryptography
- define pairing or key storage
- close a relay route through a production transport
- implement permission interactions
- enable remote control

Those integrations remain behind later review gates.
