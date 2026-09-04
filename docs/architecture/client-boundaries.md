<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Client authority and adapter boundaries

Status: architecture invariant

## Purpose

Axl supports terminal, web, desktop, mobile, IDE, headless, and SDK consumers without creating a separate agent implementation for each client. One daemon owns each session. Clients submit user intent and present daemon-owned state.

This document defines which behavior is shared, which code remains platform-specific, and what an individual client may own.

## Authority model

| Layer | Responsibilities |
| --- | --- |
| `packages/protocol` | RPC schemas, event schemas, capability names, versioning, and trust-boundary validation |
| `packages/kernel` and `packages/daemon` | Agent execution, business rules, operation ownership, tools, queues, compaction, policy, persistence, canonical events, and concurrency |
| `packages/sdk` | Connection mechanics, capability checks, retries, subscriptions, acknowledgements, synchronization, and deterministic derived projections |
| Presentation clients | Render SDK state, collect user intent, and invoke supported SDK or protocol operations |

The daemon is the sole authority for session state and effects. The SDK contains reusable client behavior, but it is not an alternate authority. SDK projections and caches are disposable views of daemon-owned canonical events.

## Consumer-only clients

A presentation client may own:

- drafts and editor state
- layout, navigation, and dialogs
- themes and accessibility preferences
- notifications and focus state
- platform adapters for transport, credentials, and local cursor persistence
- presentation of capabilities granted by the daemon

A presentation client must not:

- append or manufacture canonical events
- run an agent loop, model request, or model-selected tool
- implement local prompt queues, compaction, operation ownership, or concurrency rules
- decide filesystem, Git, network, model, credential, or sandbox policy
- simulate an unavailable daemon capability
- maintain authoritative session state
- resolve canonical ordering or conflicts locally
- implement another canonical-event reducer instead of using `packages/sdk`

Clients submit commands and user responses. The daemon validates them, applies policy, performs effects, and appends resulting events before derived state changes.

## Capabilities

`packages/protocol` defines capability identifiers and their request and response contracts. The daemon advertises and enforces capabilities. Every daemon capability has typed public SDK support. The SDK negotiates capabilities and rejects unsupported calls before dispatch when possible. Every first-party client supports every capability granted on its current connection.

Platform and authorization limits narrow the capabilities granted by the daemon. A client must not silently omit a granted capability or provide a local fallback that changes the meaning of a missing capability. A missing capability is unavailable until the daemon implements and grants it.

## Transport, authentication, and cursor storage

Unify contracts and behavior. Keep platform mechanisms in small adapters.

| Concern | Shared contract | Platform-specific implementation |
| --- | --- | --- |
| Transport | `AxlTransport` and `AxlTransportFactory` in the SDK | Unix socket, WebSocket, Tauri IPC, Electron IPC, or a future native transport |
| Authentication | Credential acquisition contract, protocol scopes, and typed errors | Operating-system socket access, HttpOnly browser cookies, OAuth, bearer tokens, or platform keychains |
| Cursor storage | `CursorStore` and SDK resume semantics | Memory, IndexedDB, browser storage, desktop files, or platform databases |

Do not combine transport, authentication, and persistence into one platform-neutral connection object. Compose their existing contracts through `AxlClientOptions` and subscription options.

### Transport rules

A transport adapter owns only connection establishment, framing, bounded message decoding, writes, closure, and platform errors. It does not interpret RPC methods or session behavior.

The SDK owns handshake state, protocol compatibility, capability negotiation, heartbeat behavior, request correlation, retry rules, and reconnect coordination.

### Authentication rules

Authentication mechanisms follow the transport boundary. Unix sockets may rely on operating-system access controls. A browser gateway may use a secure HttpOnly cookie. Remote services may use OAuth or bearer credentials.

The SDK may acquire and pass credentials. It never decides whether a principal is authorized. The authenticated gateway or daemon grants a protocol scope and capabilities. Credentials must not enter canonical events, logs, cursor stores, or client projections.

### Cursor rules

The daemon creates and validates cursors. The SDK controls acknowledgement, gap recovery, and snapshot replacement.

Each logical client view owns its cursor state. Simultaneous attachments must not share one mutable cursor record. A persisted cursor is useful only with the matching projected state. If that state is absent, stale, corrupt, or from another daemon lineage, the SDK requests a fresh authoritative snapshot.

Cursor storage is optional and disposable. Storage failure may reduce resume efficiency, but it must not stop delivery or change session truth. Cursors never replace canonical JSONL history.

## Multiple clients and detachment

Each client attaches independently and subscribes to a session or selected lineage. A prompt accepted from one client becomes a canonical event and is delivered to every matching subscription. Transient activity is distributed to active subscriptions, while final outcomes are canonical events.

Snapshot boundaries, buffered live tails, ordered sequence numbers, acknowledgements, stable event IDs, and gap recovery keep projections synchronized. Reconnection resumes from an acknowledged cursor when safe and replaces the projection from a fresh snapshot otherwise.

Detaching a client releases only that attachment and its subscriptions. It does not dispose the session or cancel an accepted session operation. Another client may remain attached, and a later client may resume the session. Explicit interruption, session disposal, and daemon shutdown remain distinct operations.

Client-local state such as drafts, dialogs, and themes is not synchronized unless a future canonical protocol feature explicitly makes it session state.

## Package boundaries

A presentation package should depend at runtime on:

- `packages/sdk`
- `packages/extension-api` when it renders extension contributions
- presentation libraries required by its platform

A presentation package must not add runtime dependencies on:

- `packages/kernel`
- `packages/daemon`
- `packages/runtime`
- `packages/ai`
- `packages/sandbox`

A process-host package may assemble or launch the daemon and then hand a public SDK client to the presentation layer. That exception does not permit daemon business logic in the presentation layer.

Add dependency-boundary checks when each new web, desktop, mobile, or IDE package is introduced. Tests may use daemon and kernel fixtures as development dependencies without creating a runtime dependency.

## Verification

Every new client transport must pass shared protocol and SDK conformance tests. Multi-client tests must prove that:

- two clients subscribing to one session converge on the same canonical projection
- a mutation from one client is visible to every matching subscription
- disconnect and reconnect do not lose or duplicate canonical events
- stale cursors and sequence gaps trigger authoritative recovery
- detaching one client does not interrupt daemon-owned work
- unavailable capabilities remain unavailable in every client

## Current gaps

The shared SDK currently includes the transport-independent client, subscription manager, projector, provider-neutral model metadata, and Unix socket transport. The CLI process host supplies provider-specific login behavior to the TUI through a neutral dialog contract. Browser WebSocket and desktop IPC adapters are not implemented yet.
