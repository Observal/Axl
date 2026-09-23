<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-FileCopyrightText: 2026 Shaan Narendran -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Web client protocol and SDK specification

Status: protocol specification supporting [the local web client architecture](web-client.md)

## Scope

This document specifies typed RPC, negotiation, errors, package ownership, and the shared conversation projector. Delivery reliability is in [web-delivery.md](web-delivery.md).

## Current baseline

Wire version 30 uses newline-delimited JSON over a Unix socket. It includes typed request and result envelopes, initialization, capability negotiation, structured errors, idempotency keys, subscription identities, paged snapshots, acknowledged opaque cursors, presence, session-catalog invalidation, daemon security reporting, direct shell events, transient activity, session-bound blobs, workspace review, session profiles, web-tool and user-question selection, manual compaction, steering, follow-ups, durable queue restoration, atomic interrupt-and-deliver, canonical model-retry attempts, provider management, model-request configuration, bounded command and capability discovery, loaded context-resource snapshots, dynamic tools, and daemon-owned MCP configuration with projected discovery status and probing.

The TUI and web client consume these contracts through `packages/sdk`. The two former branch tips both used version 11 for incompatible additions: provider management on the feature branch and daemon-owned request settings on `main`. Version 12 combines both surfaces. Version 13 adds atomic interrupt-and-deliver. Version 14 adds the capability-filtered `command.list` catalog. Version 15 adds canonical session titles, typed rename and permanent deletion, and session-catalog invalidation notifications. Version 16 adds atomic queue restoration with optional interruption. Version 17 adds daemon-owned user questionnaires and durable session eligibility for them. Version 18 adds canonical compaction configuration and lifecycle events plus queued manual compaction. Version 19 adds canonical loaded context-resource snapshots. Version 21 adds progressive capability discovery and dynamic tool activation. Version 22 adds daemon-owned MCP configuration. Version 23 projects per-server discovery status and tools through `mcp.config.list` and adds `mcp.config.probe`. Version 24 adds the `command_blocked` error for built-in commands refused by a daemon extension. Version 25 adds the `extension_failed` error for actionable extension loading and lifecycle failures. Version 26 adds atomic MCP batch upserts. Version 27 adds daemon extension discovery, trust, package management, and lifecycle controls. Version 28 adds installable terminal entries to extension inventory. Version 29 adds built-in terminal entries to the same inventory. Version 30 advertises browser-safe extension entry paths in that inventory. Host-control version 1 remains separate from session wire negotiation and is available only to trusted process hosts.

## Versioning

The current wire version is 30. Version 8 introduced typed envelopes, initialization, errors, retry metadata, subscriptions, cursors, acknowledgements, and presence. Version 9 adds the canonical `model.retry_scheduled` event. Version 10 adds `daemon_stopping` as a pre-RPC and universal RPC error. The two incompatible version-11 development surfaces are superseded. Version 12 combines provider-management RPCs with `config.request`, `model.request_configured`, and request settings in session create and configure RPCs. Version 13 adds atomic interrupt-and-deliver events and RPC. Version 14 adds the bounded command catalog used by first-party command interfaces. Version 15 adds canonical session titles, rename and permanent-delete RPCs, and session-catalog invalidation. Version 16 adds atomic queue restoration with optional interruption. Version 17 adds daemon-owned user questionnaires and the `userQuestions` session tool setting. Version 18 adds `config.compaction`, compaction queue/start/failure events, and completed-or-queued `session.compact` results. Version 19 adds `context.resources` snapshots for daemon-owned loaded context. Version 21 adds capability discovery, activation, denial, resource reads, and dynamic tool schemas. Version 22 adds typed global MCP configuration list, upsert, and remove methods. Version 23 extends list entries with `status`, `tools`, `discoveredAt`, and `error`, and adds `mcp.config.probe`, whose result may carry `authorization: "required"`, with the `mcp_probe_failed` error. Version 24 adds `command_blocked` for extension-refused built-in commands. Version 25 adds `extension_failed` for actionable extension loading and lifecycle failures. Version 26 adds atomic `mcp.config.batch` upserts. Version 27 adds typed extension inventory, trust, installation, update, removal, enable, disable, and reload methods. Version 28 includes validated terminal package paths in extension inventory. Version 29 adds inventory records for built-in terminal entries. Version 30 adds validated browser entry paths. Compatible capability additions that do not alter accepted wire data do not require a bump. Pre-1.0 clients require an exact wire-version match.

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
command.list
provider.list
provider.catalog.refresh
provider.auth.status
provider.auth.login
provider.auth.logout
mcp.config.list
mcp.config.upsert
mcp.config.remove
mcp.config.probe
session.create
session.list
session.resume
session.fork
session.clone
session.rename
session.delete
session.export
session.import
session.send.prompt
session.steer
session.follow_up
session.interrupt_deliver
session.queue.enqueue
session.queue.requeue
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

The local browser attachment intentionally does not request `provider.auth.login`. Interactive credential acquisition is a typed trusted-host operation advertised separately by bootstrap only when the `axl web` process has an attached terminal. The browser sends provider ID and login method to that authenticated host operation and receives only validated authentication status. Other provider RPCs, including status, logout, and catalog refresh, remain ordinary daemon capabilities.

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

Before initialization, only `daemon.info`, `connection.initialize`, and `connection.ping` are accepted. Any other method returns `not_initialized`. A second initialization returns `connection_already_initialized`.

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

### Command discovery

`command.list` returns a bounded, capability-filtered catalog for the current attachment and optional session. Descriptors contain names, aliases, descriptions, context, argument hints, required capabilities, and current availability. They contain no dynamic model, session, file, or queue data.

The SDK command controller validates and searches this catalog, merges presentation-only commands with collision checks, and maps supported shared commands to their existing typed RPCs or focused client surfaces. Slash commands and command-palette selections use this same controller. Built-in effects do not use a generic `command.invoke` method.

The initial built-in catalog is static for one daemon version, so clients refresh it on connection, reconnection, session replacement, explicit opening of the command palette, and configuration changes. A catalog-invalidated delivery remains deferred until dynamic daemon command registration has a concrete runtime consumer.

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

### Allowed-error matrix

The universal method errors are `bad_request`, `not_initialized`, `unsupported_capability`, `rate_limited`, `internal_error`, and `cancelled`. The pre-RPC errors are `bad_request` and `frame_too_large`; they use `id: -1` and omit `method` when malformed input prevents the daemon from establishing a valid RPC. `bad_request` is both pre-RPC-capable and universal because validation can fail before or after request correlation.

The following table lists the additional errors each method may return. The exported `UNIVERSAL_RPC_ERROR_CODES` and `RPC_METHOD_ERROR_CODES` values are the machine-readable authority.

| Methods | Additional allowed errors |
| --- | --- |
| `daemon.info`, `connection.ping`, `request.cancel` | none |
| `connection.initialize` | `unsupported_version`, `connection_already_initialized`, `unauthorized`, `forbidden` |
| `extension.list` | `unknown_session`, `extension_failed` |
| `extension.enable`, `extension.disable`, `extension.reload`, `extension.install`, `extension.update`, `extension.remove`, `extension.trust` | `unknown_session`, `operation_active`, `extension_failed` |
| `extension.command.invoke` | `unknown_session`, `operation_active`, `extension_failed` |
| `session.create` | `invalid_cwd`, `invalid_idempotency_key`, `idempotency_conflict`, `corrupt_session`, `content_too_large`, provider/model/authentication errors, `extension_failed` |
| `session.resume` | `unknown_session`, `corrupt_session`, `event_migration_required`, provider/model/authentication errors, `extension_failed` |
| `session.list` | `invalid_cwd`, `unknown_cursor` |
| `session.history` | `unknown_cursor`, `snapshot_required`, `event_migration_required` |
| `session.ack` | `unknown_subscription`, `unknown_cursor`, `snapshot_required` |
| `session.unsubscribe` | `unknown_subscription` |
| `session.fork` | `unknown_session`, `event_migration_required`, `corrupt_session`, `operation_active`, `invalid_fork_point`, `invalid_idempotency_key`, `idempotency_conflict`, `content_too_large`, `command_blocked`, `extension_failed` |
| `session.clone` | `unknown_session`, `event_migration_required`, `corrupt_session`, `operation_active`, `empty_session`, `invalid_idempotency_key`, `idempotency_conflict`, `content_too_large`, `command_blocked`, `extension_failed` |
| `session.rename` | `unknown_session`, `event_migration_required`, `operation_active`, `invalid_idempotency_key`, `idempotency_conflict`, `content_too_large`, `command_blocked` |
| `session.delete` | `unknown_session`, `event_migration_required`, `operation_active`, `invalid_idempotency_key`, `idempotency_conflict` |
| `session.export` | `unknown_session`, `event_migration_required`, `operation_active`, `invalid_path`, `artifact_exists`, `blob_missing`, `blob_corrupt` |
| `session.import` | `invalid_cwd`, `invalid_path`, `not_found`, `invalid_artifact`, `corrupt_session`, `blob_missing`, `blob_corrupt`, `content_too_large`, `invalid_idempotency_key`, `idempotency_conflict` |
| `session.send` | `unknown_session`, `event_migration_required`, `operation_active`, `invalid_idempotency_key`, `idempotency_conflict`, `blob_not_owned`, `blob_missing`, `blob_corrupt`, `content_too_large`, `extension_failed` |
| `session.interruptAndDeliver` | `unknown_session`, `event_migration_required`, `operation_active`, `invalid_idempotency_key`, `idempotency_conflict`, `blob_not_owned`, `blob_missing`, `blob_corrupt`, `content_too_large`, `extension_failed` |
| `session.queue.enqueue` | `unknown_session`, `event_migration_required`, `invalid_idempotency_key`, `idempotency_conflict`, `blob_not_owned`, `blob_missing`, `blob_corrupt`, `content_too_large` |
| `session.queue.requeue` | `unknown_session`, `event_migration_required`, `unknown_queue_item`, `queue_not_paused`, `invalid_idempotency_key`, `idempotency_conflict`, `content_too_large` |
| `session.shell` | `unknown_session`, `event_migration_required`, `operation_active`, `idempotency_conflict`, `command_blocked`, `content_too_large` |
| `session.interrupt` | `unknown_session`, `event_migration_required`, `invalid_idempotency_key`, `idempotency_conflict` |
| `session.reload`, `session.configure` | `unknown_session`, `event_migration_required`, `corrupt_session`, `operation_active`, `invalid_idempotency_key`, `idempotency_conflict`, `content_too_large`, provider/model/authentication errors, `command_blocked`, `extension_failed` |
| `session.interaction.respond` | `unknown_session`, `event_migration_required`, `unknown_interaction`, `interaction_already_resolved`, `invalid_interaction_response`, `invalid_idempotency_key`, `idempotency_conflict`, `content_too_large` |
| `session.dispose` | `unknown_session`, `event_migration_required`, `invalid_idempotency_key`, `idempotency_conflict` |
| `session.subscribe` | `unknown_session`, `event_migration_required`, `snapshot_required` |
| `session.workspace.list` | `unknown_session`, `event_migration_required`, `workspace_unavailable`, `workspace_changed`, `invalid_path`, `path_denied`, `symlink_escape`, `not_found`, `unsupported_file_type`, `unsupported_filename_encoding` |
| `session.workspace.read` | all `session.workspace.list` errors plus `not_a_file`, `binary_file`, `invalid_encoding`, `content_too_large` |
| `session.workspace.status` | `unknown_session`, `event_migration_required`, `workspace_unavailable`, `workspace_changed`, `not_git_repository`, `git_unavailable`, `git_timeout`, `git_output_too_large`, `unsupported_git_state`, `unsupported_filename_encoding`, `checkpoint_unavailable`, `checkpoint_too_large`, `checkpoint_corrupt`, `path_denied` |
| `session.workspace.diff` | all `session.workspace.status` errors plus `repository_changed` |
| `session.workspace.checkpoint` | `unknown_session`, `event_migration_required`, `operation_active`, `not_git_repository`, `git_unavailable`, `git_timeout`, `git_output_too_large`, `unsupported_git_state`, `unsupported_filename_encoding`, `checkpoint_unavailable`, `checkpoint_too_large`, `checkpoint_corrupt` |
| `session.blob.start` | `unknown_session`, `event_migration_required`, `invalid_media_type`, `invalid_blob_name`, `blob_too_large`, `too_many_uploads` |
| `session.blob.chunk` | `unknown_session`, `event_migration_required`, `unknown_blob_upload`, `invalid_blob_chunk`, `blob_offset_mismatch`, `blob_size_mismatch`, `blob_write_failed` |
| `session.blob.commit` | `unknown_session`, `event_migration_required`, `unknown_blob_upload`, `blob_size_mismatch`, `invalid_image`, `blob_corrupt` |
| `session.blob.abort` | `unknown_session`, `event_migration_required`, `unknown_blob_upload` |
| `session.blob.read` | `unknown_session`, `event_migration_required`, `blob_not_owned`, `blob_missing`, `blob_corrupt`, `invalid_blob_range`, `blob_read_failed` |
| `session.dispose` | `unknown_session`, `event_migration_required`, `invalid_idempotency_key`, `idempotency_conflict` |

The daemon converts an unrecognized or disallowed implementation error to `internal_error`; it does not leak arbitrary subsystem codes. Model and provider failures during a turn are canonical `session.error` events, not `session.send` RPC failures.

`retryable` is code-defined, not call-site-defined. It is `true` only for `rate_limited`, `git_timeout`, `too_many_uploads`, `blob_write_failed`, and `blob_read_failed`. It is `false` for every other named code. In particular, `checkpoint_unavailable` can mean that no checkpoint was created, so repeating the same request cannot repair it. A retryable mutation still reuses its original idempotency key.

Clients must accept unknown future string codes. They display the safe `message`, retain the unknown code and bounded details for diagnostics, obey the supplied `retryable` value, and never crash or infer success.

`event_migration_required` details contain only `sessionId`, `eventId`, `eventType`, `encodedBytes`, `maximumBytes`, and a safe recovery command. They contain no payload excerpt or absolute path. `content_too_large` identifies the bounded field and limit without echoing rejected content.

A validation failure before a request ID can be trusted uses `id: -1`. Once a valid request ID and known method are decoded, validation and overload errors include both and pass through the method-specific allowed-error matrix. The server closes the connection when framing or integrity is uncertain.

## Session method shapes

```ts
type SessionProfile = "minimal" | "standard" | "chat" | "exec";
type SendDelivery = "prompt" | "steer" | "follow_up";

interface SessionModelSelection {
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly webFetch?: boolean;
  readonly webSearch?: boolean;
  readonly userQuestions?: boolean;
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

interface SessionSteerParams {
  readonly sessionId: SessionId;
  readonly content: readonly UserContent[];
}
type SessionSteerResult = { readonly queued: true };
type SessionFollowUpParams = SessionSteerParams;
type SessionFollowUpResult = SessionSteerResult;

interface SessionCompactParams {
  readonly sessionId: SessionId;
  readonly instructions?: string;
}
type SessionCompactResult = { readonly eventId: EventId };

interface SessionQueueEnqueueParams {
  readonly sessionId: SessionId;
  readonly content: readonly UserContent[];
  readonly priority: "front" | "back";
}
interface SessionQueueEnqueueResult {
  readonly queueItemId: EventId;
  readonly state: "queued" | "paused";
}
interface SessionQueueRequeueParams {
  readonly sessionId: SessionId;
  readonly queueItemId: EventId;
  readonly priority: "front" | "back";
}
interface SessionQueueRequeueResult {
  readonly queueItemId: EventId;
  readonly state: "queued";
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
  readonly webFetch: boolean;
  readonly webSearch: boolean;
  readonly userQuestions: boolean;
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

`session.interaction.respond` resolves daemon-owned user questionnaires, MCP approvals, URL elicitation, sampling review, and structured form elicitation. Clients submit only the actions and schema-conforming content supported by the canonical request. User questionnaires are enabled explicitly with the durable `userQuestions` session setting, so non-interactive sessions receive no corresponding tool schema or prompt text. Permission history is separate and has no client response RPC.

`delivery: "prompt"` is ordinary prompt behavior. The version-7 `session.steer` and `session.followUp` methods remain available in version 8. The `session.send` delivery variants `steer` and `follow_up` remain unavailable until their separate capabilities are implemented, and clients must not simulate them.

`session.send` completes when the turn reaches a canonical terminal assistant event or error. Detaching does not cancel it. `session.interrupt` is the session-operation cancellation path. `session.interruptAndDeliver` atomically stops active work at a safe boundary and delivers its replacement content exactly once; when no operation is active, it behaves as an ordinary send.

Queued prompts use `session.queue.enqueue` and `session.queue.requeue`. Enqueue records prompt content and priority in canonical history before returning. The daemon appends lifecycle events as an item is queued, started, paused after restart, and explicitly re-queued. Pending items are never executed automatically after restart. Every attachment derives the same queue from those events.

The SDK `deliverPrompt` workflow maps explicit prompt, steer, follow-up, interrupt-and-deliver, queue-next, and queue-last intent to those typed methods. A steer or follow-up that loses its active operation is queued with the documented priority instead of being dropped. Transport ambiguity is returned as an explicit uncertain outcome so clients preserve the draft for review rather than silently retrying a potentially accepted delivery.

`session.shell` is correlated by its caller-supplied operation ID but is never retried automatically. Its SDK wrapper returns either `{ state: "completed", result }` or `{ state: "uncertain", operationId }`. If transport loss prevents the SDK from proving a canonical `user.shell` result, it preserves the command for explicit user review. `session.interrupt` may cancel the active shell operation, but cancellation does not imply that prior shell side effects were rolled back.

The web client invokes manual compaction through the shared `/compact [instructions]` command. If an agent response is active, the daemon records the compaction as queued and runs it after that response. The web client renders canonical queued, in-progress, cancellation, failure, and `context.compacted` state. Direct shell input uses `!command` to include output in model context and `!!command` to exclude it. Both operations remain daemon-owned and are cancelled only through `session.interrupt`.

A profile is accepted only when the daemon can enforce, persist, log, and restore it. Web chat maps to the zero-tool `chat` profile. `minimal` provides Bash and editing, `standard` provides the normal tool set, and `exec` is Bash-only. The non-chat profiles use the code interface.

## Merged version-7 reconciliation

Version 8 preserves these merged contracts while adding method-specific validation:

- `daemon.info` continues to report `sandboxed` or `unsafe` before session access.
- transient activity retains operation IDs, monotonic per-operation sequences, bounded text/thinking/tool-call frames, snapshots, and clear frames
- blob start, chunk, commit, abort, and read remain session-bound and content-addressed
- `user.shell` remains canonical, including command, content, error, and exclusion state
- session list, fork, clone, runtime assembly, profiles, web-tool selection, manual compaction, steering, follow-ups, and exact version rejection remain daemon-owned

Version 8 replaces the overlapping version-7 client contracts:

- `session.resume.includeEvents` is removed; resume returns metadata only
- `session.history` becomes the bounded page method for a frozen subscription snapshot and opaque cursors
- subscription and activity deliveries carry subscription identity
- direct shell gains caller-supplied operation correlation and is never automatically retried
- the batch `session.workspace.diff` result is replaced by shared list, read, status, per-entry diff, and checkpoint contracts
- presentation-neutral event and activity reduction moves into `packages/sdk`

No compatibility shim preserves the version-7 wire or private TUI projection behavior.

## Session-open and list shapes

Create, resume, fork, and clone return bounded session metadata. `session.resume` has no `includeEvents` option. The client then calls `session.subscribe`, which atomically fixes a snapshot cursor and returns the first bounded history page. Additional frozen pages use `session.history`; events after the boundary are buffered and then delivered live. Events produced between resume and subscribe are included at the subscription boundary rather than lost.

```ts
interface SessionOpenResult {
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly title?: string;
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

`session.rename` appends a canonical `session.renamed` event and returns its event ID. The latest rename is the durable title returned by open and list results. `session.delete` is an idempotent mutation that disposes the runtime, removes canonical history and workspace checkpoints, and returns `{ deleted: true, historyPreserved: false }`.

There is no `session.end` alias. The user-facing End action invokes `session.dispose` and explains that the active runtime stops while durable history remains. Permanent Delete invokes `session.delete` only after explicit confirmation.

A daemon sends `{ kind: "sessions_changed", generation }` to initialized attachments granted `session.list` whenever list-visible metadata or runtime state changes. The generation increases monotonically for that daemon process. Clients treat it as invalidation, coalesce refreshes, and fetch a fresh typed `session.list`; the notification does not contain session metadata or grant authority.

Unsubscribe, detach, gateway stop, interrupt, session disposal, permanent deletion, and daemon stop are distinct. Closing a tab only detaches that attachment.

## Transient activity and blobs

The merged activity frame remains non-canonical and uses strictly increasing per-operation sequence numbers with bounded text, thinking, tool-call, snapshot, and clear variants. Version 8 wraps it in the owning subscription:

```ts
interface ActivityDelivery {
  readonly kind: "activity";
  readonly subscriptionId: string;
  readonly sessionId: SessionId;
  readonly frame: SessionActivityFrame;
}
```

The SDK follows the reset and replacement rules in [web-delivery.md](web-delivery.md): transport loss and replacement snapshots clear client activity, only the new subscription may restore an activity snapshot, operation changes replace prior transient state, and matching canonical events win. Activity is not acknowledged with canonical event cursors.

The method map includes the merged `session.blob.start`, `session.blob.chunk`, `session.blob.commit`, `session.blob.abort`, and `session.blob.read` contracts. Blob transfer remains session-bound, bounded, content-addressed, and runtime-validated. The SDK reads and uploads blobs in bounded chunks. The web composer supports selection, progress, cancellation, retry, and attachment-only prompts. Failed delivery restores committed references without retaining bytes or object URLs in durable browser storage.

When canonical shell output is truncated, the daemon moves the complete output into its session-owned blob store before persistence and records the reference as `tool.result.payload.details.overflowBlob`. Browser clients retrieve that blob on demand. New canonical events never expose the daemon host path. Legacy records containing `overflowPath` remain visible as unavailable historical metadata.

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
- operation and daemon-owned queue state supplied by canonical lifecycle events
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

It contains no global state framework, agent loop, policy, Git execution, React component, or credential value. TUI and web migrate to this surface in the version-8 slice. A future Tauri app may reuse it directly; native Android and iOS clients use later language-specific implementations of the same protocol.

## Protocol tests

Required tests cover:

- every method request, success, and allowed error
- unknown and extra fields
- method-to-params discrimination
- exact version-7 versus version-8 mismatch
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
