<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Web client protocol and SDK specification

Status: supporting specification for [the local web client RFC](web-client-rfc.md)

## Scope

This document specifies typed RPC, negotiation, errors, package ownership, and the shared conversation projector. Delivery reliability is in [web-delivery.md](web-delivery.md).

## Current baseline

Merged wire version 3 uses newline-delimited JSON over a Unix socket. It adds daemon security reporting, bounded `session.history` pages, direct shell events, transient activity, session-bound blob upload/read/abort, and daemon-owned workspace checkpoint diffs to the prior session lifecycle methods.

Version 3 still returns `result: unknown`, uses untyped string errors, has a version-only hello, and has no initialization, capabilities, idempotency keys, subscription identity, acknowledgement, presence, or opaque cursor contract. The TUI casts results and reduces canonical state locally.

## Versioning

Implement this RFC as wire version 4. Its typed envelopes, initialization, errors, retry metadata, subscriptions, cursors, acknowledgements, and presence are incompatible with version 3. Compatible capability additions after version 4 do not require a bump. Pre-1.0 clients require an exact wire-version match.

The daemon sends `hello` first:

```ts
interface WireHello {
  readonly kind: "hello";
  readonly wireVersion: number;
  readonly daemonInstanceId: string;
  readonly capabilities: readonly CapabilityId[];
  readonly limits: {
    readonly maxMessageBytes: number;
    readonly maxPendingRequests: number;
  };
}
```

A client rejects a mismatched version before sending session requests.

## Base methods and negotiated capabilities

These mandatory base-protocol methods are never capability-negotiated:

```text
daemon.info
connection.initialize
connection.ping
request.cancel
session.ack
session.history
session.unsubscribe
```

A compatible implementation must support them. Feature methods are advertised as stable capability identifiers:

```text
session.create
session.list
session.resume
session.fork
session.clone
session.send.prompt
session.send.steer
session.send.follow_up
session.shell
session.interrupt
session.reload
session.configure
session.interaction.respond
session.dispose
session.subscribe
session.activity
session.presence
session.blob.start
session.blob.chunk
session.blob.commit
session.blob.abort
session.blob.read
session.workspace.list
session.workspace.read
session.workspace.status
session.workspace.diff
session.workspace.checkpoint
```

A capability means the daemon understands and authorizes that contract. Session profile, current operation state, policy, and workspace type may still reject a request with a structured error.

Unknown capabilities are ignored. A required missing capability fails connection or disables the relevant control with an explicit reason. A client never invokes a feature method it was not granted.

## Connection initialization

After hello, the client must initialize:

```ts
type ClientKind = string;

interface ClientIdentity {
  readonly kind: ClientKind;
  readonly version: string;
  readonly instanceId: string;
}

interface ConnectionInitializeParams {
  readonly client: ClientIdentity;
  readonly requestedCapabilities: readonly CapabilityId[];
}

interface ConnectionInitializeResult {
  readonly attachmentId: string;
  readonly daemonInstanceId: string;
  readonly wireVersion: number;
  readonly grantedCapabilities: readonly CapabilityId[];
  readonly scope: "local_control";
  readonly heartbeatIntervalMs: number;
  readonly presenceTimeoutMs: number;
}
```

`ClientKind` is a lowercase protocol identifier of at most 64 UTF-8 bytes, such as `tui`, `web`, `desktop`, `android`, `ios`, `headless`, or `ide`. Unknown valid kinds remain diagnostic and do not require a wire change. The client-generated instance ID is also diagnostic. Neither field grants authority. The daemon generates the attachment ID, and authenticated scope controls access. Remote scopes are deferred.

Before initialization, only `daemon.info`, `connection.initialize`, and `connection.ping` are accepted. Any other method returns `connection_not_initialized`. A second initialization returns `connection_already_initialized`.

## Method map

`packages/protocol` defines one map:

```ts
interface DaemonInfoResult {
  readonly securityMode: "sandboxed" | "unsafe";
}

interface RpcMethodMap {
  readonly "daemon.info": {
    readonly params: Record<string, never>;
    readonly result: DaemonInfoResult;
  };
  readonly "connection.initialize": {
    readonly params: ConnectionInitializeParams;
    readonly result: ConnectionInitializeResult;
  };
  readonly "session.list": {
    readonly params: SessionListParams;
    readonly result: SessionListResult;
  };
  // Every method has one entry.
}

type RpcMethod = keyof RpcMethodMap;
type RpcParams<M extends RpcMethod> = RpcMethodMap[M]["params"];
type RpcResult<M extends RpcMethod> = RpcMethodMap[M]["result"];
```

Requests and successes are mapped unions. This preserves method correlation when the full union is narrowed:

```ts
type RpcRequest = {
  [M in RpcMethod]: {
    readonly kind: "request";
    readonly id: number;
    readonly method: M;
    readonly params: RpcParams<M>;
    readonly idempotencyKey?: string;
  };
}[RpcMethod];

type RpcSuccess = {
  [M in RpcMethod]: {
    readonly kind: "success";
    readonly id: number;
    readonly method: M;
    readonly result: RpcResult<M>;
  };
}[RpcMethod];
```

Runtime parsers validate each complete request and result. Exact-object validation rejects unknown fields unless the schema explicitly permits extension data.

The SDK exposes:

```ts
request<M extends RpcMethod>(
  method: M,
  params: RpcParams<M>,
  options?: RequestOptions,
): Promise<RpcResult<M>>;
```

Clients do not cast results.

## Structured errors

```ts
interface RpcError {
  readonly kind: "error";
  readonly id: number;
  readonly method?: RpcMethod;
  readonly error: {
    readonly code: RpcErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: JsonObject;
  };
}
```

`message` is safe user-facing text. `details` is validated and bounded per error code. It never includes stack traces, credentials, launch tokens, request headers, protected file contents, or raw provider errors.

Common codes are:

```text
bad_request
unsupported_version
unsupported_capability
connection_not_initialized
connection_already_initialized
unauthorized
forbidden
rate_limited
frame_too_large
request_timeout
cancelled
internal_error
invalid_idempotency_key
idempotency_conflict
unknown_session
corrupt_session
event_migration_required
operation_active
invalid_fork_point
unknown_interaction
interaction_already_resolved
unknown_subscription
unknown_cursor
cursor_expired
snapshot_required
workspace_unavailable
workspace_changed
invalid_path
path_denied
symlink_escape
not_found
not_a_file
unsupported_file_type
unsupported_filename_encoding
binary_file
invalid_encoding
content_too_large
not_git_repository
git_unavailable
git_timeout
git_output_too_large
unsupported_git_state
repository_changed
```

Each method documents its narrower set. Unknown codes remain displayable as generic failures, but never imply success.

`event_migration_required` details contain only `sessionId`, `eventId`, `eventType`, `encodedBytes`, `maximumBytes`, and a safe recovery command. They contain no payload excerpt or absolute path. `content_too_large` identifies the bounded field and limit without echoing rejected content.

A validation failure before a request ID can be trusted uses `id: -1`. The server closes the connection when framing or integrity is uncertain.

## Session method shapes

```ts
type SessionProfile = "minimal" | "standard" | "chat";
type SendDelivery = "prompt" | "steer" | "follow_up";

interface SessionModelSelection {
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
}

interface SessionCreateParams extends SessionModelSelection {
  readonly cwd: string;
  readonly profile?: SessionProfile;
}
type SessionCreateResult = SessionOpenResult;

interface SessionResumeParams {
  readonly sessionId: SessionId;
}
type SessionResumeResult = SessionOpenResult;

interface SessionForkParams {
  readonly sessionId: SessionId;
  readonly fromEventId: EventId;
}
interface SessionForkResult extends SessionOpenResult {
  readonly selectedText?: string;
}

interface SessionCloneParams {
  readonly sessionId: SessionId;
}
type SessionCloneResult = SessionOpenResult;

interface SessionSendParams {
  readonly sessionId: SessionId;
  readonly content: readonly UserContent[];
  readonly delivery: SendDelivery;
}
interface SessionSendResult {
  readonly operationId: OperationId;
  readonly stopReason: AssistantStopReason;
}

interface SessionShellParams {
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
  readonly command: string;
  readonly excluded: boolean;
}
interface SessionShellResult {
  readonly operationId: OperationId;
  readonly isError: boolean;
  readonly resultEventId: EventId;
}

interface SessionInterruptParams {
  readonly sessionId: SessionId;
}
interface SessionInterruptResult {
  readonly interrupted: boolean;
  readonly operationId?: OperationId;
}

interface SessionReloadParams {
  readonly sessionId: SessionId;
}
interface SessionReloadResult {
  readonly boundaryEventIds: readonly EventId[];
}

interface SessionConfigureParams extends SessionModelSelection {
  readonly sessionId: SessionId;
  readonly profile?: SessionProfile;
}
interface SessionConfigureResult {
  readonly modelId: string;
  readonly requestedThinkingLevel: ThinkingLevel;
  readonly effectiveThinkingLevel: ThinkingLevel;
  readonly profile: SessionProfile;
  readonly boundaryEventIds: readonly EventId[];
}

interface SessionInteractionRespondParams {
  readonly sessionId: SessionId;
  readonly interactionId: string;
  readonly action: InteractionAction;
  readonly content?: JsonObject;
}
interface SessionInteractionRespondResult {
  readonly interactionId: string;
  readonly resolutionEventId: EventId;
}

interface SessionDisposeParams {
  readonly sessionId: SessionId;
}
interface SessionDisposeResult {
  readonly disposed: boolean;
  readonly historyPreserved: true;
}
```

`session.configure` includes at least one changed field. It returns event IDs rather than duplicate full events; the canonical events arrive through the subscription.

`delivery: "prompt"` is the existing ordinary prompt behavior. `steer` and `follow_up` are accepted only when their capabilities are granted. Before those semantics land, clients send only `prompt` and do not present ordinary queuing as steering.

`session.send` completes when the turn reaches a canonical terminal assistant event or error. Detaching does not cancel it. `session.interrupt` is the session-operation cancellation path.

`session.shell` is correlated by its caller-supplied operation ID but is never retried automatically. Its SDK wrapper returns either `{ state: "completed", result }` or `{ state: "uncertain", operationId }`. If transport loss prevents the SDK from proving a canonical `user.shell` result, it preserves the command for explicit user review. `session.interrupt` may cancel the active shell operation, but cancellation does not imply that prior shell side effects were rolled back.

A profile is accepted only when the daemon can enforce, persist, log, and restore it. Web chat maps to the zero-tool `chat` profile. Other profiles use the code interface. A reviewed canonical profile event is required before exposing the chat toggle.

## Merged version-3 reconciliation

Version 4 preserves these merged contracts while adding method-specific validation:

- `daemon.info` continues to report `sandboxed` or `unsafe` before session access.
- transient activity retains operation IDs, monotonic per-operation sequences, bounded text/thinking/tool-call frames, snapshots, and clear frames
- blob start, chunk, commit, abort, and read remain session-bound and content-addressed
- `user.shell` remains canonical, including command, content, error, and exclusion state
- session list, fork, clone, runtime assembly, and exact version rejection remain daemon-owned

Version 4 replaces the overlapping version-3 client contracts:

- `session.resume.includeEvents` is removed; resume returns metadata only
- `session.history` becomes the bounded page method for a frozen subscription snapshot and opaque cursors
- subscription and activity deliveries carry subscription identity
- direct shell gains caller-supplied operation correlation and is never automatically retried
- the batch `session.workspace.diff` result is replaced by shared list, read, status, per-entry diff, and checkpoint contracts
- presentation-neutral event and activity reduction moves into `packages/sdk`

No compatibility shim preserves the version-3 wire or private TUI projection behavior.

## Session-open and list shapes

Create, resume, fork, and clone return bounded session metadata. `session.resume` has no `includeEvents` option. The client then calls `session.subscribe`, which atomically fixes a snapshot cursor and returns the first bounded history page. Additional frozen pages use `session.history`; events after the boundary are buffered and then delivered live. Events produced between resume and subscribe are included at the subscription boundary rather than lost.

```ts
interface SessionOpenResult {
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly runtime: {
    readonly state:
      | "inactive"
      | "idle"
      | "running"
      | "waiting_interaction"
      | "disposing";
    readonly activeOperationId?: OperationId;
  };
  readonly profile: SessionProfile;
}

interface SessionListParams {
  readonly scope: "current_workspace" | "all_local";
  readonly cwd?: string;
  readonly query?: string;
  readonly order: "recent" | "threaded";
  readonly pageSize: number;
  readonly pageCursor?: string;
}
```

“All local” means sessions visible to this daemon. It excludes remote machines and cloud placements.

A summary includes session identity, timestamps, excerpts, canonical `cwd`, parent identity, runtime state, and attachment count. The daemon owns search and ordering.

## Cancellation

```ts
interface RequestCancelParams {
  readonly requestId: number;
}
interface RequestCancelResult {
  readonly cancellationRequested: boolean;
}
```

`request.cancel` applies only to an outstanding read-only request on the same attachment, initially workspace and snapshot-page work. It never cancels a session operation. Closing a transport requests cancellation for its read-only requests and leaves accepted mutations under daemon ownership.

## Lifecycle operations

```ts
interface SessionUnsubscribeParams {
  readonly subscriptionId: string;
}
interface SessionUnsubscribeResult {
  readonly unsubscribed: boolean;
}
```

There is no `session.end` alias. The user-facing End action invokes `session.dispose` and explains that the active runtime stops while durable history remains.

Unsubscribe, detach, gateway stop, interrupt, session disposal, and daemon stop are distinct. Closing a tab only detaches that attachment.

## Transient activity and blobs

The merged activity frame remains non-canonical and uses strictly increasing per-operation sequence numbers with bounded text, thinking, tool-call, snapshot, and clear variants. Version 4 wraps it in the owning subscription:

```ts
interface ActivityDelivery {
  readonly kind: "activity";
  readonly subscriptionId: string;
  readonly sessionId: SessionId;
  readonly frame: SessionActivityFrame;
}
```

The SDK follows the reset and replacement rules in [web-delivery.md](web-delivery.md): transport loss and replacement snapshots clear client activity, only the new subscription may restore an activity snapshot, operation changes replace prior transient state, and matching canonical events win. Activity is not acknowledged with canonical event cursors.

The method map includes the merged `session.blob.start`, `session.blob.chunk`, `session.blob.commit`, `session.blob.abort`, and `session.blob.read` contracts. Blob transfer remains session-bound, bounded, content-addressed, and runtime-validated. The initial web UI does not expose media controls.

## Shared conversation projection

The deterministic projector belongs in `packages/sdk`. It imports only public protocol types and has no React, TUI, DOM, terminal, daemon, kernel, or provider dependency.

It consumes validated snapshot pages, ordered canonical deliveries, and transient activity frames. It derives immutable state for:

- selected branch lineage
- user and assistant messages
- thinking blocks
- tool calls paired with results by `callId`
- unresolved and resolved interactions
- errors, interruptions, and compaction
- model, provider, thinking, sandbox, usage, and cost supplied by events
- operation and queue state supplied by protocol
- transient activity reconciled by operation ID and replaced by canonical terminal events
- canonical `user.shell` records and uncertain local shell outcomes
- unknown events and tools through safe generic records

It never starts operations, reads files, repairs malformed events, or invents canonical state.

Built-in render intents for shell, read, edit, search, web, MCP, and workflow are added only when their canonical data exists. Unknown tools always use a bounded generic intent. Extension render registration remains unsupported.

Given the same snapshot, selected node, and ordered deliveries, the projector produces deeply equal state. It rejects:

- duplicate event IDs with different content
- mismatched session IDs
- missing required parents
- conflicting tool call/result identities
- out-of-order sequences

An identical at-least-once duplicate is ignored.

## SDK portability and exports

`packages/protocol` is the language-neutral contract. The TypeScript SDK is the first implementation, not the universal runtime for native clients. Public wire values remain JSON-compatible and avoid Node.js, browser, Tauri, Swift, or Kotlin types.

The SDK core receives transport and credential adapters. Unix sockets, browser WebSockets, future Tauri IPC, and future authenticated remote WebSockets do not change RPC, projection, cursor, or idempotency semantics. Canonical JSON fixtures cover every message and event shape so future Swift and Kotlin implementations can run the same conformance corpus. Schema generation is deferred until the first native client.

The first private in-tree TypeScript SDK surface is limited to:

- protocol method and result types
- a thin transport-independent `AxlClient`
- connection and reconnect state
- idempotency-key and cursor-store interfaces
- the deterministic conversation projector
- injected transport and credential interfaces
- Node Unix-socket and browser WebSocket adapters outside browser-neutral code

It contains no global state framework, agent loop, policy, Git execution, React component, or credential value. TUI and web migrate to this surface in the version-4 slice. A future Tauri app may reuse it directly; native Android and iOS clients use later language-specific implementations of the same protocol.

## Protocol tests

Required tests cover:

- every method request, success, and allowed error
- unknown and extra fields
- method-to-params discrimination
- exact version-3 versus version-4 mismatch
- missing capability behavior
- calls before initialization
- valid unknown diagnostic client kinds without authority changes
- malformed server messages
- safe error serialization
- session switching across different `cwd` values
- profile capability enforcement
- unsupported steer and follow-up behavior
- shell result correlation, interruption, and uncertain transport outcomes without automatic retry
- frozen `session.history` paging, attachment ownership, expiry, and events appended between resume and subscribe
- activity reset on reconnect, replacement snapshot, operation change, canonical completion, unsubscribe, and detach
- all merged blob methods, including abort
- exact persisted UTF-8 event-size measurement and schema-defined blob externalization
- lossless migration, unsupported migration, and confirmed prefix recovery fixtures
- `daemon.info` before initialization
- projector determinism and canonical fixtures
- unknown tools through the generic projector
- language-neutral JSON fixtures for future native SDK conformance
