<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Web mutation and event delivery specification

Status: delivery specification supporting [the local web client architecture](web-client.md)

## Scope

This document specifies mutation idempotency, paged initial snapshots, resumable event delivery, cursor persistence, attachment presence, and reconnect behavior.

## Mutation idempotency

### Required methods

Every mutation that may be retried requires a lowercase UUID idempotency key:

- `session.create`
- `session.fork`
- `session.clone`
- `session.send`
- `session.queue.enqueue`
- `session.queue.requeue`
- `session.interrupt`
- `session.reload`
- `session.configure`
- `session.interaction.respond`
- `session.dispose`

Read methods and delivery acknowledgements reject an idempotency key.

### Durable records

The daemon owns idempotency. The gateway and SDK never infer whether a mutation succeeded.

Before starting an effect, the daemon appends and syncs an acceptance record containing:

- idempotency key
- method
- canonical request hash
- target session when known
- intended session ID for `session.create`, `session.fork`, and `session.clone`
- operation ID
- acceptance timestamp

The request hash is SHA-256 over a canonical UTF-8 encoding of `{ method, params }` after full runtime validation and normalization. Object keys use one protocol-defined deterministic ordering, arrays retain order, and normalized identifiers and paths use the values the daemon will execute. Request IDs, idempotency keys, attachment IDs, cursors, and other delivery metadata are excluded. Undefined values, non-finite numbers, unknown fields, and other non-JSON values are rejected before hashing. The dependency-free canonical encoder and cross-process fixtures live in `packages/protocol`.

For `session.create`, the daemon allocates the intended session ID and stores it in the synced acceptance record before creating the log. Every retry uses that ID. Fork and clone likewise persist their intended target session ID before writing the target root.

Terminal records contain the validated success or structured error and completion timestamp. Records contain no credential, protected file body, or full prompt beyond data already required by canonical session history.

The command journal is crash-safe append-only data under the Axl data directory. It is separate from session JSONL because transport deduplication is not conversation history. Session effects still append canonical events before changing derived session state.

Keys remain available for the lifetime of the durable history they affect. Any future pruning policy requires a reviewed compatibility decision.

### Request behavior

For one local authority scope:

1. The first key and canonical request hash creates the durable acceptance record.
2. A concurrent retry with the same key and hash joins the operation.
3. A completed retry returns the same validated result or error.
4. The same key with another method or hash returns `idempotency_conflict` without an effect.
5. Restart recovery reconstructs acceptance and completion before requests are accepted.

The idempotency key becomes, or is durably mapped to, the canonical operation ID. Every supported mutation has a canonical effect marker:

| Mutation | Canonical evidence |
| --- | --- |
| create | created session root carrying the operation ID |
| fork or clone | target session root carrying the operation ID and source identity |
| send | user message and terminal assistant or error events carrying the operation ID |
| queue enqueue | `queue.enqueued` carrying the operation ID |
| queue re-queue | one `queue.requeued` carrying the operation ID |
| interrupt | terminal aborted event for the target operation, or a durable false result when no operation existed |
| reload | configuration boundary events carrying the operation ID |
| configure | configuration events carrying the operation ID |
| interaction response | one `interaction.resolved` event carrying the operation ID |
| dispose | `session.closed` or a durable already-inactive result |

### Restart reconciliation

An accepted operation cannot remain permanently indeterminate.

On restart, the daemon reconciles each accepted record:

- If canonical terminal evidence exists, append the missing terminal journal record and return that result.
- If no canonical effect marker exists, the effect did not start and the same key may execute it.
- If a start marker exists without terminal evidence, append the method-defined aborted terminal event before serving clients, then return the deterministic aborted result.
- If the journal or canonical log is corrupt, fail startup or the affected session with `corrupt_session`. Do not repeat the effect.

This rule is limited to methods whose effects can be proven from the canonical log. A future external-side-effect method must define its own durable reconciliation before it can use the retryable mutation contract.

There is no `indeterminate_operation` steady state and no command that asks a user to guess whether an effect happened.

### Interaction races

The first accepted interaction response wins. A retry with the same key returns the original resolution. A different key after resolution returns `interaction_already_resolved` with the canonical resolution event ID. Simultaneous TUI and web decisions cannot both succeed.

### Direct shell operations

`session.shell` is not part of the automatically retryable mutation set. The caller supplies a UUID operation ID, and a completed canonical `user.shell` event carries that ID. After transport loss, the SDK returns the recorded result when present; otherwise it reports an uncertain outcome and never resends the command. `session.interrupt` may request cancellation, but it cannot roll back shell side effects that already occurred.

### Canonical prompt queue

Queued prompts are daemon-owned canonical state shared by every attachment. `session.queue.enqueue` durably appends `queue.enqueued` with the prompt content and its front-or-back priority before acknowledging the request. The event ID is the stable queue item ID. The daemon executes queued items in priority order after the active operation finishes and appends `queue.started` before the corresponding `user.message`.

A queued item is reduced from lifecycle events rather than mutable flags. A terminal `assistant.message` or `session.error` carrying the queue operation ID completes or fails the item. Queue lifecycle consists of `queue.enqueued`, `queue.requeued`, `queue.started`, and `queue.paused`.

A daemon restart never executes a previously pending item implicitly. During session recovery each item whose latest lifecycle is queued becomes `queue.paused` with reason `daemon_restart`. Its content remains visible in canonical history. A user must invoke `session.queue.requeue` to make that item eligible to run again. Re-queueing is itself an idempotent mutation and appends `queue.requeued`. Clients do not maintain private authoritative prompt queues.

## Canonical event size

`packages/protocol` defines `MAX_CANONICAL_EVENT_BYTES` as 768 KiB (786,432 bytes). Size is the byte length of the exact UTF-8 JSON encoding persisted for one canonical event, excluding only the trailing JSONL line-feed byte. It is not JavaScript string length, character count, payload-only size, or a reserialization estimate.

One dependency-free `encodeCanonicalEvent` path validates the event, serializes it once, measures `new TextEncoder().encode(json).byteLength`, and returns those exact bytes. The append path writes those bytes plus `0x0a`. Every producer uses this path before persistence. Log readers check each committed line's raw byte length before parsing, and transports reserve enough envelope headroom to carry any valid event without splitting it.

### Blob externalization

Large content is externalized only by the daemon-side producer and only where the event schema defines an equivalent `BlobReference` representation. The producer durably writes and verifies the blob before appending the referencing event. If the event append fails, the unreferenced blob is eligible for garbage collection. If blob storage fails, no event is appended.

There is no generic gateway, SDK, or log-writer conversion from arbitrary JSON or text into a blob. Model-visible text, prompt sections, context, and other fields without defined blob semantics fail with `content_too_large`. They are never truncated, retyped, or silently moved out of the log. Content larger than the blob limit also fails explicitly.

### Legacy recovery

Before accepting connections after the limit is introduced, the daemon scans existing session logs. A session containing an oversized committed event remains byte-for-byte unchanged and is quarantined with `event_migration_required`. The error identifies the session, event ID, event type, encoded size, limit, and recovery command without including payload content.

Version 8 ships an offline recovery path before enforcing the limit:

1. `axl session export <session-id> --raw` copies the original JSONL and referenced blobs without parsing away unknown data.
2. `axl session migrate-events <session-id>` requires the daemon to be stopped or an exclusive data-directory lock. It first creates a read-only backup and records source hashes.
3. A lossless migration may externalize only fields with schema-defined blob semantics. It writes a new session and migration manifest in a private staging directory, preserves operation relationships, remaps event and parent references deterministically, then validates parsing, tree integrity, blob digests, and replay before publishing the new session ID.
4. The source log is never overwritten or deleted. While the exclusive lock is held, verified output is synced and renamed from staging; the manifest is published last as the completion marker. Incomplete targets are ignored and removed on the next recovery run.
5. If an oversized field has no lossless representation, migration stops without publishing. The command reports the blocking event and offers explicit prefix recovery into a new session ending before that event. The manifest records the raw export hash and the omitted suffix. Prefix recovery is labeled incomplete and requires confirmation.

The migration manifest records tool version, source and target session IDs, source and target hashes, event-ID mappings, externalized blob digests, validation results, and whether recovery is lossless or prefix-only. Automatic startup never performs migration.

## Snapshot model

A client must be able to attach to every valid session, regardless of total history size. Initial transport therefore includes paged snapshots.

### Frozen boundary

`session.subscribe` establishes the snapshot while holding the session append-serialization lock:

1. validate the session, selected node, attachment, and optional acknowledged cursor
2. register the subscription and its bounded live-tail buffer
3. record the canonical append position and issue the boundary cursor
4. freeze the exact ordered event-ID list for the selected lineage through that position
5. create an attachment-owned snapshot ID and page cursors over that immutable list
6. return the descriptor and first page, then release the append lock

Events appended after the recorded position enter only the live-tail buffer. Snapshot pages read only the frozen event-ID list and therefore remain byte-for-byte stable even while the session continues. They never include post-boundary events, change order, or extend `eventCount`.

A valid reconnect cursor skips the snapshot and begins with events strictly after its bound append position. A fresh or replacement snapshot always replaces the prior projection; clients never merge snapshots from different IDs, daemon lineages, selected nodes, or boundaries.

### Descriptor and pages

```ts
interface SnapshotDescriptor {
  readonly snapshotId: string;
  readonly sessionId: SessionId;
  readonly fromNodeId?: EventId;
  readonly boundaryCursor: EventCursor;
  readonly eventCount: number;
  readonly page: SnapshotPage;
}

interface SnapshotPage {
  readonly events: readonly CanonicalEvent[];
  readonly nextPageCursor?: string;
  readonly complete: boolean;
}

interface SessionHistoryParams {
  readonly snapshotId: string;
  readonly pageCursor: string;
}

interface SessionHistoryResult {
  readonly snapshotId: string;
  readonly page: SnapshotPage;
}
```

Version 8 evolves merged `session.history` into the mandatory base-protocol page method. Page cursors are opaque and bind the snapshot identity, session, selected node, event position, and expiry.

Each page fits within the negotiated ordinary-message limit and contains only complete canonical events. The universal canonical-event limit ensures one event can fit with its delivery envelope. Total history is bounded through paging rather than event splitting.

Snapshot IDs and page cursors are scoped to the creating attachment and subscription. They cannot page another snapshot or survive daemon lineage changes. Paging refreshes the negotiated idle lifetime but not the absolute lifetime. Snapshot event lists, page state, and live tails all have negotiated hard byte and count limits.

If the idle or absolute lifetime expires, the attachment disconnects, or the live-tail buffer reaches either limit, the daemon invalidates the snapshot and returns `snapshot_required`. It discards that snapshot state and never drops buffered events while claiming the old boundary is valid.

### Completion

The SDK validates and reduces every page in order. After the final page, it acknowledges the descriptor's boundary cursor. Only that acknowledgement completes snapshot loading. The daemon then releases the buffered tail in canonical append order and continues live delivery.

A disconnect before completion invalidates attachment-owned snapshot state. The new attachment resumes from its last previously acknowledged live cursor when possible; otherwise it requests a fresh snapshot. It never treats a merely downloaded or partially reduced page as acknowledged.

## Subscription

```ts
interface SessionSubscribeParams {
  readonly sessionId: SessionId;
  readonly fromNodeId?: EventId;
  readonly after?: EventCursor;
}

interface SessionSubscribeResult {
  readonly subscriptionId: string;
  readonly sessionId: SessionId;
  readonly fromNodeId?: EventId;
  readonly snapshot?: SnapshotDescriptor;
  readonly resumedFrom?: EventCursor;
}
```

`fromNodeId` selects the fixed tree lineage projected by the view. It is optional until branch navigation lands and never mutates history. A selected-node subscription does not receive later events from descendants, siblings, or the unrelated active tip; selecting a newer node creates a replacement subscription.

A new subscription atomically fixes its boundary and returns a snapshot descriptor with the first history page. Create, resume, fork, and clone return bounded session metadata, after which the client subscribes. Additional frozen pages use `session.history`. Events appended between those calls are included in the snapshot or buffered tail. A valid reconnect cursor returns only the missing tail and live subscription.

## Cursors

`EventCursor` is an opaque validated string. Clients do not parse it or construct it from event IDs. It binds:

- daemon lineage
- session
- selected node when applicable
- canonical append position

It contains no authority credential and may be persisted.

The SDK accepts an injected cursor store. The web client initially uses `sessionStorage`, keyed by daemon instance, session, and selected node. Cursor-store failure is visible in connection details and disables resumable reconnect for that subscription. Live delivery continues. Reconnect then requests a fresh snapshot.

An unknown, expired, evicted, wrong-lineage, wrong-session, or wrong-node cursor returns `snapshot_required`. Event cursors have a daemon-defined absolute lifetime, and the daemon enforces a hard global cursor count. Cumulative acknowledgement and subscription cleanup discard superseded and unacknowledged cursor records while retaining at most the latest acknowledged reconnect point until expiry. The client discards the affected derived projection and requests a replacement snapshot. It never combines incompatible state.

## Event delivery

```ts
interface EventDelivery {
  readonly kind: "event";
  readonly subscriptionId: string;
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly cursor: EventCursor;
  readonly event: CanonicalEvent;
}
```

`sequence` starts at 1 per live subscription and increases by exactly one. Canonical event order is append order, not timestamp or UUID order.

Delivery is at least once:

- an event may be repeated after reconnect
- the SDK deduplicates by event ID within a session
- an identical duplicate is ignored
- a duplicate ID with different canonical bytes is a protocol integrity error
- a sequence gap or unseen lower sequence closes the subscription and triggers explicit resync
- the SDK never sorts events to hide transport reordering

## Activity reset and replacement

Transient activity is scoped by subscription and operation ID. It is never persisted, cursor-acknowledged, or carried across attachments as client-owned truth.

The SDK clears all activity for the affected view before applying:

- the first page of a fresh or replacement snapshot
- a reconnect or daemon-lineage change
- a selected-node or session change
- unsubscribe, detach, or transport loss

After reconnect, only an activity snapshot returned by the new subscription may restore transient state. A frame for a new operation ID replaces all prior-operation activity in that subscription. A frame with a sequence at or below the last applied sequence is ignored. A sequence gap discards that operation's transient state and requests a fresh activity snapshot without changing canonical projection state.

A `clear` frame clears only its matching operation when its sequence is newer. A canonical assistant terminal event, canonical operation error or abort, or session closure clears matching activity regardless of whether a clear frame arrived. A canonical tool call removes its matching transient tool-call preview; canonical events always win over transient content. Unsubscribing or expiring a subscription clears every activity record owned by it.

Delayed frames from an old subscription, operation, daemon lineage, or selected node are rejected. Activity reset never removes canonical messages or tool state.

## Acknowledgement

The SDK validates and reduces a page or event before acknowledging it.

```ts
interface SessionAckParams {
  readonly subscriptionId: string;
  readonly cursor: EventCursor;
}

interface SessionAckResult {
  readonly cursor: EventCursor;
}
```

Acknowledgements are cumulative. The daemon may coalesce them and discard acknowledged delivery buffers. An acknowledgement changes no session behavior. If expiry or bounded eviction removes a cursor before acknowledgement, `unknown_cursor` or `snapshot_required` triggers the same replacement-snapshot recovery as a failed reconnect cursor; the SDK does not leave the view silently unbound.

## Presence

An attachment is one initialized client connection. The daemon publishes a complete presence snapshot after initialization and bounded updates afterward.

```ts
interface AttachmentPresence {
  readonly attachmentId: string;
  readonly clientKind: ClientKind;
  readonly connectedAt: number;
  readonly lastSeenAt: number;
  readonly subscribedSessionIds: readonly SessionId[];
  readonly scope: "local_control";
}
```

Presence exposes no username, token, IP address, prompt, file, or cwd. `clientKind` is diagnostic and never grants scope. Presence is ephemeral and is not written to canonical session JSONL.

Heartbeats update `lastSeenAt`. A clean disconnect removes presence immediately. An unclean connection disappears after the negotiated timeout. Presence is informational and does not elect an operation owner.

## Reconnect state machine

The SDK exposes these connection states:

```text
connecting
negotiating
loading_snapshot
connected
reconnecting
disconnected
incompatible
```

Reconnect behavior:

1. authenticate a new transport
2. validate hello and exact wire version
3. initialize a new attachment
4. compare daemon instance lineage and capabilities
5. resume each view from its last acknowledged cursor when compatible
6. request a fresh paged snapshot when a cursor cannot resume
7. replace, never merge, state after a lineage or selected-node mismatch

A capability removed during reconnect makes the affected control unavailable with a visible reason. It never falls back to client-local behavior.

Gateway restart detaches browser connections but leaves daemon sessions running. Daemon restart reconstructs canonical sessions, idempotency state, and reconnect behavior before accepting requests.

## Backpressure interaction

The daemon and gateway maintain bounded per-attachment queues. A slow browser does not cause event drops. The gateway pauses reads for that attachment and evicts it if the queue does not recover within the security specification's grace period. The client reconnects from its acknowledged cursor.

A snapshot tail buffer that fills expires that snapshot and forces a new boundary. It does not block the daemon's append path indefinitely.

## Reliability tests

Required deterministic tests prove:

- a lost response and retry do not duplicate each eligible mutation
- canonical request hashes are stable across key ordering and exclude delivery metadata
- session creation retries use the intended session ID reserved before execution
- shell transport loss returns a recorded result or an explicit uncertain outcome and never reruns the command
- same-key, different-request reuse fails without an effect
- restart recovery resolves accepted operations from canonical evidence
- an accepted operation with no effect marker can execute safely
- a started non-terminal turn becomes canonically aborted after restart
- simultaneous interaction responses have one winner
- sessions larger than one frame attach through multiple immutable pages
- snapshot pages never include post-boundary appends or change `eventCount`
- snapshot IDs and page cursors cannot cross attachments, subscriptions, selected nodes, or daemon lineages
- the buffered tail is not released before final-page reduction and boundary acknowledgement
- every event producer and log reader measures the exact persisted UTF-8 bytes against the same limit
- supported oversized content is externalized only after durable blob verification; unsupported content fails before append
- oversized legacy events fail with safe `event_migration_required` details without modifying their logs
- lossless migration publishes only after replay validation, unsupported migration publishes nothing, and prefix recovery requires confirmation
- events appended between resume and subscribe are included without loss
- appends during paging arrive after the frozen snapshot in order
- paging timeout, detach, and tail-buffer overflow require a fresh snapshot
- duplicate delivery reduces once
- altered duplicates and sequence gaps fail explicitly
- activity resets on reconnect, replacement snapshots, session or node switches, unsubscribe, detach, canonical completion, and newer operation IDs
- stale or gapped activity never alters canonical projection
- a valid cursor resumes without loss
- cursor-store failure is visible and falls back to a snapshot
- wrong-lineage and expired cursors replace projection state
- daemon and gateway restart independently
- version or capability changes during reconnect fail loudly
- simultaneous TUI and web attachments see the same canonical events
- stale presence clears after timeout
- closing a browser detaches without interrupting or disposing a session
