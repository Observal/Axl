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
| `packages/ui` | Shared presentation tokens and reusable React renderers without daemon or process authority |
| Presentation clients | Render SDK state, collect user intent, and invoke supported SDK or protocol operations |

The daemon is the sole authority for session state and effects. The SDK contains reusable client behavior, but it is not an alternate authority. SDK projections and caches are disposable views of daemon-owned canonical events.

## Daemon launch and session placement

A protocol client and a daemon process host are distinct roles. `packages/sdk` connects to a daemon but never launches one. A trusted process host may connect to an existing daemon or launch the daemon before handing an SDK client to its presentation layer.

| Consumer | Daemon launch owner |
| --- | --- |
| Terminal | `packages/cli` launches a local daemon; the TUI only uses the SDK client |
| Local web | The planned `axl web` gateway host launches a local daemon; browser code never does |
| Desktop | A trusted native, Tauri, or Electron main process may launch a local daemon; renderer code never does |
| IDE | A trusted extension host may launch a local daemon; an embedded webview never does |
| Headless | The command or automation runner may launch a local daemon |
| Mobile or remote web | An authenticated remote control plane allocates a cloud worker or locates a reachable daemon; client code never launches a daemon process on the device |

With future cloud sandbox support, mobile and remote web clients may request creation of a session on a cloud placement. This is a daemon or control-plane operation, not local process authority. The cloud worker starts the sandboxed daemon, and the client attaches through the authenticated protocol. Mobile devices and browsers never run the agent loop, tools, or workspace authority.

A host that bundles a daemon and client still performs the normal wire-version handshake. An already-running daemon may survive a host upgrade, so an incompatible daemon fails loudly and requires an explicit lifecycle action. A host must not automatically replace a daemon while it owns active work.

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

## Human commands

Shared human commands follow [the human command plane](human-command-plane.md). Commands that affect shared or durable state are published and executed by the daemon through protocol and SDK contracts. Clients collect intent and render command-specific interfaces without reimplementing the effect.

Built-in and custom presentation commands run through the owning client's extension host. They may change layout, editor, draft, or other client-local state but cannot manufacture canonical events or access daemon internals. An extension command that needs a shared effect must register through the daemon extension API and remains subject to ordinary capability and policy enforcement.

The SDK merges daemon and client-extension descriptors into one validated directory and attaches reusable workflows for collection and typed invocation. Command names and aliases may not silently shadow one another.

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

### Explicit host shutdown

The CLI injects a typed SDK host-control surface into the TUI. The TUI renders the daemon's shutdown preview and submits confirmation; it never launches, signals, or selects daemon processes. Resume across placements switches this host surface together with the session connection. A host without this authority reports quit as unavailable rather than silently detaching.

Host-control version 1 uses a separate connection and distinct validated messages on the existing owner-only Unix socket. Its version is independent of session-wire versioning. It offers status, generation-bound shutdown, and explicit self-termination after failed or stalled shutdown. It does not initialize a session connection or accept session RPCs. Remote presentation gateways must not forward these host messages or grant raw local socket access to renderers.

Shutdown closes admission synchronously, interrupts active operations, prevents queued continuation, waits for accepted request outcomes and runtime cleanup, drains canonical history, then releases ownership. Durable pending queue entries remain in history and become paused on resume. Cleanup failure retains the control listener and reports failure rather than pretending shutdown completed. A `daemon_stopping` notification prevents attached SDK consumers and TUIs from automatically reconnecting or launching a replacement. Explicit reconnection remains possible.

A single-session `/quit` authorizes interruption. Other attached clients or work require confirmation against the daemon's current preview. CLI stop and restart require `--interrupt` for busy daemons and `--yes` for affected clients. Version mismatch alone never authorizes termination. Forced termination requires a prior shutdown and the exact instance identity, and invokes the process host's termination callback rather than signaling a stored PID.

For legacy daemons without host control, the CLI process host may perform explicit Linux OS recovery. It verifies the executable, entry point, owner, placement, lock, and listening socket against a non-reusable pidfs identity. Unknown activity always requires both `--interrupt` and `--yes`. It rechecks identity, sends SIGTERM only through PID:inode-aware utilities, and waits for exit before restart. Missing verification support fails closed. This recovery does not bypass the session handshake, add PID signaling to the SDK or TUI, enable legacy `--force`, or replace incompatible daemons during ordinary startup.


## Package boundaries

A presentation package should depend at runtime on:

- `packages/sdk`
- `packages/ui` when it can reuse shared visual tokens or React renderers
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

The shared SDK includes the transport-independent client, subscription manager, projector, provider-neutral model metadata, Unix socket transport, and browser WebSocket transport. The CLI process host supplies provider-specific login behavior to the TUI and local browser gateway through `TrustedProviderHost`; credential prompts remain in the terminal. Desktop IPC adapters are not implemented yet.
