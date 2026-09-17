<!-- SPDX-FileCopyrightText: 2026 Lokesh -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Remote hosted-path checkpoint

Status: real E2EE integration adapters implemented with local test stores; production startup disabled

## Scope

This checkpoint connects the real TypeScript control plane, Elixir relay, daemon remote-authority boundary, and TypeScript SDK in disposable tests. The Session 60 Windows slice adds the canonical binary E2EE envelope, an SDK adapter for real native device endpoints, a daemon bridge for real native daemon endpoints, and an HTTPS witness continuation client. It proves the integration against real OpenMLS endpoints using test-only key and rollback stores and against a local unanimous three-replica witness gateway.

The deterministic fake E2EE adapter remains under protocol test support for transport fault tests. Production source now consumes only typed native endpoint interfaces and opaque committed envelopes. Production startup remains disabled until Windows release evidence and independently deployed witness infrastructure are approved.

## Stable destination and ephemeral routes

A durable outbox record stores a stable opaque crypto-session identifier. It never stores a relay route. The SDK resolves the currently advertised daemon route immediately before each transport attempt. A reconnect therefore changes the transport attempt ID and route while retaining byte-identical prepared ciphertext, request ID, and daemon idempotency key.

The crypto-session identifier is an integration seam, not an OpenMLS state format. Person 1 owns the final destination identity contract and the transaction that advances cryptographic state and inserts immutable ciphertext. The current `OpaqueOutboxStore` remains fake-E2EE scaffolding and must not be treated as the production OpenMLS transaction.

## SDK delivery boundary

The SDK now provides:

- authenticated HTTP ticket acquisition with a bounded proof interface
- a bounded binary first-frame WebSocket admission
- route snapshot, availability, unavailability, and replacement handling
- bounded exponential reconnect with jitter
- per-attempt route resolution
- relay admitted and forwarded diagnostics
- opaque inbound delivery through an injected authenticated opener
- authenticated daemon acceptance, result, error, and ordinary server-delivery messages
- durable outbox removal only after matching authenticated daemon acceptance
- ephemeral prepared sends for read requests such as subscription resume

The SDK does not encrypt, decrypt, advance epochs, create prepared records, or claim command authority. Relay receipts never remove durable mutations.

## Disposable topology

The explicit hosted-path integration test starts:

1. an in-process real control-plane HTTP server with deterministic injected identity, authorization, proof, clock, and ticket storage,
2. a separately running real Elixir relay using its HTTP control-plane client,
3. a real sandboxed daemon with durable remote authority and command journal,
4. daemon and device relay WebSocket connections,
5. test-only fake E2EE endpoints, and
6. the real SDK outbox and delivery coordinator.

It verifies ticket issuance and consumption, route discovery, fake authenticated opening, daemon authorization, durable command acceptance, response delivery, relay restart, changed-route retry with byte-identical ciphertext, cursor-based subscription resume, daemon restart, duplicate idempotency, revocation, and oversized-payload rejection. The test is opt-in outside the relay CI job because it requires the pinned Elixir toolchain.

## Selected cryptographic direction

The selected endpoint direction is revision 1 of the Axl-private `axl-e2ee-mls-pq-v1` profile with one pairwise group for each daemon-device relationship. Pairing uses an opaque KeyPackage and Welcome rendezvous owned by the control plane. The daemon is the only committer. A phone may submit Update proposals but does not commit group state. Pairing, persistence, and migration authenticate the profile ID and revision; incompatible changes require authenticated migration or re-pairing.

This document defines no OpenMLS fields, algorithms, validation rules, storage representation, or transaction implementation. The approved [OpenMLS RFC](remote-e2ee-openmls.md) owns those decisions. Session 40 supplies the transport-independent core and prepared-envelope transaction. Session 50 supplies mandatory browser/WASM persistence and cross-platform fixtures before real E2EE integration can enable remote web.

## Authority audit gate

The authority store does not yet emit a complete security-audit stream. Before real E2EE or ordinary-session access is enabled, a reviewed daemon-owned audit sink must durably record bounded events for:

- local device registration
- local scope narrowing
- hosted grant installation or narrowing
- local and hosted revocation
- failed authorization by stable reason code

Audit records may contain installation/device identifiers, generations, scope names, timestamps, and reason codes. They must not contain credentials, relay tickets, possession proofs, ciphertext, key material, plaintext request bodies, prompts, or sensitive parameters. Audit persistence and authority mutation ordering must be defined before implementation; this checkpoint does not add a non-atomic best-effort sink.

## Remaining gates

Before production remote control:

- Person 1 must provide the reviewed OpenMLS prepared-envelope transaction and browser/WASM persistence strategy.
- MLS application, Update, commit, and epoch-ready delivery classes need an ordered priority contract.
- Production identity, datastore, workload authentication, quotas, deployment, and TLS termination must be selected.
- The authority audit gate above must be implemented.
- Permission lifecycle, action-digest binding, policy generations, and race resolution must be implemented and reviewed.
- Ordinary-session remote exposure must receive an explicit enablement review.
