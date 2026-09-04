<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Local web client architecture

Status: planned; protocol and SDK foundation implemented

Scope: web client delivery slice 1 only

## Problem

Axl needs a localhost web client without creating a second agent runtime or weakening the daemon boundary. The current wire protocol is sufficient for one local TUI, but it is not ready for a browser-facing client:

- successful RPC results are `unknown` and clients cast them
- reconnect has no acknowledged cursor contract
- retried mutations can be ambiguous after a lost response
- attachments have no identity or presence
- the daemon has no bounded workspace and Git read API
- browser authentication, transport limits, and asset compatibility are undefined
- event projection currently has no shared client owner

These contracts are expensive to change after the web interface ships. They require review before implementation.

## Decision

Build the web client as a projection of the authoritative daemon:

```text
Browser
  -> @axl/sdk
  -> authenticated WebSocket
  -> loopback-only web gateway
  -> Unix socket
  -> authoritative daemon
  -> kernel, canonical JSONL, tools, providers, and sandbox
```

The gateway serves assets and bridges one daemon connection per browser attachment. It owns browser authentication and transport limits. It owns no session, agent, workspace, Git, or model behavior.

The web client work may proceed as the Phase 9 exception recorded in `ROADMAP.md`. This exception does not advance unrelated Phase 9 features.

## Goals

1. Keep the daemon as the sole owner of sessions, loops, operations, logs, and workspace access.
2. Give the TUI and web app one typed, runtime-validated TypeScript SDK.
3. Make eligible mutations safe to retry and event streams safe to resume.
4. Authenticate the browser across a narrow loopback boundary.
5. Expose files and Git changes through bounded daemon RPCs.
6. Keep conversation reduction deterministic and framework-neutral.
7. Package web assets with explicit compatibility metadata.
8. Fail loudly when a version, capability, cursor, path, repository state, or asset is unsupported.

## Non-goals

This work does not add:

- a browser-owned agent loop
- remote access, device pairing, or a hosted relay
- public SDK publication or non-TypeScript SDK generation
- browser file editing or arbitrary filesystem access
- arbitrary shell or Git execution from the browser
- extension-provided panels, nodes, or renderers
- the full session viewer or cross-session transcript search
- new web media UI, OCR, voice, or cloud placement; the SDK still types the merged shared blob RPCs
- a global web state framework
- compatibility shims for temporary TUI contracts

## Package boundaries

- `packages/protocol` remains dependency-free and owns RPC, wire, capability, delivery, cursor, presence, and runtime-validation schemas. Mapped unions replace `result: unknown`.
- `packages/sdk` becomes the private in-tree TypeScript SDK. It owns the typed client, reconnect behavior, idempotency and cursor interfaces, delivery reduction, and the conversation projector. It contains no agent loop, policy, Git, React, or credential value.
- `packages/daemon` remains authoritative for mutations, operation ownership, idempotency decisions, snapshots, subscriptions, presence, path policy, and Git execution.
- The gateway binds to loopback, authenticates browsers, enforces transport limits, serves or proxies assets, and opens one daemon connection per attachment. It implements no session behavior.
- `packages/web` contains the React application after transport approval. React and Vite are the only approved initial production dependencies. Any other production dependency requires approval.

The SDK remains unpublished until an external consumer exists.

## Client portability

`packages/protocol`, not one language runtime, is the universal client contract. The initial `packages/sdk` implementation serves TypeScript clients:

- the TUI through a Unix-socket adapter
- the local web app through an authenticated WebSocket adapter
- a future Tauri desktop app through the same TypeScript core and a reviewed WebSocket or Tauri IPC adapter

Future native Android and iOS SDKs implement or generate the same protocol and must pass shared JSON conformance fixtures. No mobile package or generator is added in this slice.

Mobile has two product modes. Chat uses a tool-free daemon-owned session through an authenticated remote service. Code mode requires remote control of an authoritative coding session and never runs workspace, tool, or agent authority on the phone. Pairing, remote credentials, relay trust, revocation, push delivery, and mobile protocol compatibility require a separate reviewed specification.

Transport and authentication are adapters. RPC typing, canonical projection, cursors, idempotency, and capability behavior do not depend on Unix sockets, browser cookies, Tauri, Swift, or Kotlin. Client identity is diagnostic and extensible; authenticated scope alone grants authority.

## Protocol decisions

The detailed protocol is specified in [web-protocol.md](web-protocol.md) and [web-delivery.md](web-delivery.md).

The approved direction is:

- treat merged wire version 7 as the baseline for activity, blobs, bounded history, shell, workspace review, daemon security mode, session profiles, web-tool selection, manual compaction, steering, and follow-ups
- advance to wire version 8 because typed response envelopes, initialization, idempotency keys, subscription identities, opaque cursors, acknowledgements, presence, and structured errors are incompatible wire changes
- validate method-specific requests, successes, and errors at runtime
- represent requests and successes as mapped discriminated unions
- keep mandatory connection-control methods in the base protocol rather than the negotiated feature catalog
- negotiate feature methods through stable capability identifiers
- require UUID idempotency keys for retryable mutations and hash normalized, validated method parameters deterministically
- reserve target session IDs in the durable acceptance record before creating, forking, or cloning sessions
- record mutation acceptance before effects and make effects discoverable through canonical operation IDs
- never automatically retry direct shell operations; expose an uncertain outcome when no canonical result can be proven
- reconcile interrupted accepted operations deterministically after restart
- deliver events at least once in canonical append order
- deduplicate by stable event ID and reject altered duplicates
- use opaque acknowledged cursors
- remove `session.resume.includeEvents`, return bounded resume metadata, and evolve merged `session.history` into paged snapshot/cursor delivery from one atomic subscription boundary
- page initial snapshots so every valid long-running session can attach without an event-loss race
- measure the universal canonical-event limit over the exact persisted UTF-8 JSON bytes
- externalize large content only through schema-defined daemon-owned blob references
- quarantine oversized legacy events and provide non-destructive offline migration or explicit prefix recovery
- identify each live attachment and expose bounded presence

`session.send` uses:

```ts
readonly delivery: "prompt" | "steer" | "follow_up";
```

`prompt` is ordinary input. Version 8 retains the version-7 `session.steer` and `session.followUp` methods. The unified `steer` and `follow_up` delivery values remain unavailable until their capabilities exist. Unsupported modes fail and are never simulated.

The initial paged-snapshot protocol freezes a snapshot boundary, buffers the live tail, returns bounded pages, and begins live delivery only after the client completes that snapshot. It does not reject a session merely because its history exceeds one frame.

## Browser security boundary

The detailed threat model is specified in [web-gateway-security.md](web-gateway-security.md).

The gateway must:

- bind to an operating-system loopback address
- use one canonical IP-literal origin
- validate `Host` exactly against DNS rebinding
- validate `Origin` exactly for authenticated requests and WebSocket upgrades
- create a one-use, 256-bit launch token with a 60-second lifetime
- keep credentials out of query strings and persistent browser storage
- exchange the fragment-delivered launch token for an HttpOnly, SameSite Strict browser cookie
- scope authenticated endpoints and the cookie to a random process path
- set strict CSP, frame denial, nosniff, no-referrer, and no-store headers
- bound handshakes, frames, messages, queues, request rates, and attachment counts
- evict slow clients without dropping events for other clients
- reject binary frames and disable compression; existing blob RPCs use bounded protocol messages
- sanitize logs so tokens, cookies, prompts, events, files, and diffs are absent

Development keeps the same browser origin. The gateway reverse-proxies Vite assets and Vite development traffic. The browser never connects to a separate Vite origin.

## Workspace boundary

The detailed contract is specified in [workspace-rpc.md](workspace-rpc.md).

The browser uses the shared session-scoped workspace methods:

```text
session.workspace.list
session.workspace.read
session.workspace.status
session.workspace.diff
session.workspace.checkpoint
```

The first four are read-only. Checkpoint configuration is daemon-owned and supports the shared last-turn review contract.

The daemon binds each request to the selected session's canonical workspace. It accepts normalized workspace-relative paths only, canonicalizes before policy checks, rejects symlink escapes, and protects Axl data and configured secret paths.

The initial Explorer lists one directory level per request. Reads are byte- and line-bounded with strict UTF-8 and binary detection. Git status represents staged and unstaged entries separately. Diffs return structured hunks; side-by-side layout is an SDK or UI projection, not an RPC format.

Git runs without a shell, with structured arguments, a sanitized environment, disabled external helpers, and explicit output and time limits. Invalid-byte filenames fail with `unsupported_filename_encoding`; they are never silently replaced.

Workspace and repository generations detect stale views, replacement, and deletion.

## Shared conversation projection

The framework-neutral projector belongs in `packages/sdk`.

It consumes validated snapshots, ordered canonical event deliveries, and transient activity frames. It owns:

- branch selection
- user and assistant messages
- thinking visibility
- tool call/result pairing by `callId`
- interaction state
- interruption, error, and compaction state
- usage, cost, model, provider, thinking, and sandbox state supplied by events
- safe generic records for unknown tools
- reconciliation of transient activity with canonical terminal events

React and TUI presentation code must not independently reduce canonical events. Canonical fixtures verify that both clients derive the same state.

Extension renderers remain unsupported until the native extension runtime provides the public lifecycle.

## Session and attachment lifecycle

These actions remain distinct:

- unsubscribe one view from a session or branch
- detach one client attachment
- stop the local gateway without stopping sessions
- interrupt the active operation while preserving the session
- dispose a runtime while preserving durable history
- stop the daemon after durable operation handling

Closing or reloading a browser tab detaches only that attachment. It never interrupts or disposes a session.

Switching sessions replaces the conversation snapshot and clears all prior Explorer, Changes, branch, file, diff, queue, interaction, cursor, and status state before loading the selected session's recorded `cwd`.

## Web assets

The detailed build and release contract is specified in [web-packaging.md](web-packaging.md).

Production assets are:

- built by Vite
- content-hashed
- described by signed-release-compatible metadata containing package, source, asset, and wire versions
- verified before the gateway listens
- included in the CLI release artifact
- served locally without a CDN or runtime download

Missing, corrupt, or incompatible assets fail startup. Production never falls back to development assets or starts a package manager.

## Compatibility impact

Merged protocol version 7 is the compatibility baseline. This specification advances the shared protocol to version 8 because it changes request and response envelopes, hello and initialization, errors, subscriptions, cursors, acknowledgements, and retryable mutations incompatibly. Before 1.0, clients and daemons accept only an exact version, and mismatches fail before session access.

The browser transport does not replace Unix sockets. Existing canonical JSONL remains authoritative. New profile or shell events require explicit event-catalog review and tests rather than client-local state.

The web branch is rebased onto the merged TUI foundation. Version 8 preserves and types the working version-7 behavior for `daemon.info`, session list, resume, history, fork, clone, activity, blob start/chunk/commit/abort/read, direct shell, workspace checkpoints, session profiles, web-tool selection, manual compaction, steering, follow-ups, and runtime assembly.

Version 8 deliberately evolves the overlapping contracts:

- `session.resume` returns metadata only; `session.history` and `session.subscribe` provide race-free paged snapshot/cursor delivery
- activity is associated with a subscription and reduced by the shared SDK projector
- `session.shell` gains caller correlation and explicit uncertain outcomes without automatic retry
- both clients move from the version-7 batch workspace diff to shared `session.workspace.*` list, read, status, per-entry diff, and checkpoint methods
- presentation-neutral TUI projection moves into `packages/sdk`; terminal layout and rendering remain in `packages/tui`
- `packages/cli` keeps process startup and daemon assembly

No compatibility shim preserves the version-7 wire or private TUI projection behavior.

## Alternatives considered

- Put HTTP in the daemon: rejected because it expands the authoritative daemon's network-facing responsibilities.
- Add a separate REST API: rejected because Unix and browser clients would diverge.
- Keep `result: unknown`: rejected because type assertions do not validate untrusted data.
- Use event IDs as cursors: rejected because cursors also bind daemon lineage, append position, and selected node.
- Keep idempotency in memory: rejected because restart after a lost response could duplicate a mutation.
- Keep version-7 `includeEvents` plus event-ID paging unchanged: rejected because version 8 needs one typed snapshot/cursor and acknowledgement contract for every client.
- Give the browser filesystem or Git arguments: rejected in favor of bounded session-scoped workspace RPCs.
- Reduce events in React: rejected because TUI and web projections would drift.
- Load Vite from another browser origin: rejected in favor of a same-origin gateway proxy.

## Delivery gates

1. **Protocol and SDK:** mapped unions, runtime parsers, structured errors, capabilities, deterministic idempotency recovery, canonical-event limits, race-free snapshot/cursor resume, transient activity, presence, transport-independent SDK interfaces, cross-language fixtures, and TUI SDK migration.
2. **Secure transport:** loopback gateway, Host and Origin enforcement, launch exchange, cookie controls, resource limits, backpressure, fault tests, and independent restart tests.
3. **Application shell:** local session list and switching, conversation, composer, reconnect state, model and thinking controls, and daemon-enforced profiles when supported.
4. **Workspace and packaging:** policy-checked Explorer and Changes, structured diffs, hostile Git configuration tests, asset verification, and installed-artifact browser tests.

No gate may silently substitute an unavailable later feature.

## Supporting specifications

- [Typed RPC and SDK](web-protocol.md)
- [Idempotency, snapshots, delivery, and presence](web-delivery.md)
- [Gateway security](web-gateway-security.md)
- [Workspace and Git RPC](workspace-rpc.md)
- [Web build and packaging](web-packaging.md)

## Change control

The linked specifications are normative implementation contracts. Frozen snapshot boundaries, activity reset, exact UTF-8 event-size measurement, schema-defined blob externalization, and non-destructive `event_migration_required` recovery are required acceptance criteria. Changes to those guarantees require a new protocol review.
