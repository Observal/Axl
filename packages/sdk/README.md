<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/sdk`

`@axl/sdk` is Axl's transport-independent TypeScript client SDK. It connects presentation clients to the authoritative daemon and projects validated protocol events into deterministic client state.

The package is private and in-tree today. It is the supported boundary for the TUI and future web, desktop, IDE, and headless TypeScript clients.

## Responsibilities

The SDK owns:

- typed RPC requests and results
- protocol initialization and exact version checks
- capability negotiation and pre-dispatch capability checks
- request correlation and structured client errors
- idempotency keys and retry of eligible mutations
- heartbeat and transport reconnection
- paged initial snapshots
- ordered event delivery and acknowledgement
- opaque cursor persistence through an injected store
- cursor expiry, sequence-gap, and daemon-lineage recovery
- transient activity reconciliation
- deterministic conversation projection
- provider-neutral model metadata for presentation

The SDK does not own:

- sessions or canonical history
- the model loop or provider calls
- tools, prompt queues, compaction, or operation ownership
- filesystem, Git, credential, or sandbox policy
- provider-specific authentication
- terminal, browser, desktop, or mobile presentation

Those responsibilities remain in the daemon, kernel, runtime, provider, and client packages.

## Public entry points

```text
@axl/sdk        typed client, subscription, projector, and shared client types
@axl/sdk/unix   Node.js Unix-socket transport adapter
```

`@axl/sdk` re-exports the public protocol types so clients do not need private package imports.

## Connect and subscribe

```ts
import { subscribeSession } from "@axl/sdk";
import { connectUnixClient } from "@axl/sdk/unix";

const client = await connectUnixClient("/path/to/axl.sock");

const session = await client.request("session.create", {
  cwd: process.cwd(),
  profile: "standard",
});

const subscription = await subscribeSession(client, session.sessionId, {
  onChange(projector) {
    render(projector.state);
  },
});

await client.request("session.send", {
  sessionId: session.sessionId,
  delivery: "prompt",
  content: [{ type: "text", text: "Inspect this project" }],
});

await subscription.close();
client.close();
```

`ConversationProjector.state` is a disposable view. Canonical JSONL remains authoritative.

## Connection lifecycle

The client performs this handshake:

1. Connect through the injected transport factory.
2. Validate the daemon hello and exact wire version.
3. Request capabilities with a diagnostic client identity.
4. Validate the initialization result.
5. Start negotiated heartbeats.

Connection states are:

```text
connecting
negotiating
loading_snapshot
connected
reconnecting
disconnected
incompatible
```

`reconnect()` is coalesced. Concurrent callers share one reconnect attempt. Successful reconnect validates that previously granted capabilities remain available, then invokes registered view-restoration callbacks.

A platform adapter may establish Unix sockets, WebSockets, or native IPC. It owns framing and connection establishment only. It must not implement session behavior.

## Requests and capabilities

`AxlClient.request()` is typed by the protocol method map:

```ts
const result = await client.request("session.list", {
  scope: "all_local",
  order: "recent",
  pageSize: 100,
});
```

The SDK validates outgoing requests and incoming results. It rejects a feature request before writing when the daemon did not grant the required capability.

The negotiated connection metadata is available through `client.connection`, including:

- attachment ID
- daemon instance ID
- wire version
- granted capabilities
- authority scope
- heartbeat and presence timeouts

## Mutation retry

Retryable mutations receive an idempotency key before their first write. If a response is lost, the SDK reconnects and repeats the identical request with the same key. The daemon's durable command journal returns the original result instead of repeating the effect.

Retryability is defined by the protocol. Clients do not infer it from error text.

Direct shell execution is deliberately different. `client.shell()` returns either a completed canonical result or an uncertain operation ID. It never automatically repeats a shell command whose side effects cannot be proven safe.

## Subscriptions and snapshots

`subscribeSession()` creates one projected session view. A fresh attachment receives a frozen snapshot boundary, reduces each bounded page in order, acknowledges the boundary, then receives the buffered live tail.

A subscription:

- checks per-subscription sequence numbers
- deduplicates identical canonical event IDs
- rejects altered duplicates
- acknowledges only after successful reduction
- resumes from its latest acknowledged cursor when possible
- replaces its projection from a fresh snapshot when recovery requires it
- clears transient activity on detach, reconnect, or canonical completion

Use `fromNodeId` for a fixed branch-lineage view. It does not mutate the session.

## Cursor storage

Cursor storage is optional and client-local:

```ts
interface CursorStore {
  load(key: string): Promise<string | undefined>;
  save(key: string, cursor: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Each logical view needs its own stored cursor state. A cursor is valid only with its matching projection, daemon lineage, session, and selected node. Cursor storage is disposable and never replaces canonical history.

If storage fails, live delivery continues and the subscription reports cursor persistence as unavailable. A later reconnect uses a fresh authoritative snapshot.

## Projection

`ConversationProjector` reduces canonical events and transient activity into presentation-neutral state, including:

- user and assistant messages
- model, provider, thinking, profile, and sandbox state
- tool calls paired with results
- interactions
- operation state
- daemon-owned prompt queue state
- usage and cost totals
- compaction and session errors
- current transient activity

Clients may format that state for their platform. They must not maintain a second canonical reducer or manufacture canonical events.

## Authentication

The SDK defines a generic credential-provider hook for transports that require authentication. It does not implement Azure OpenAI authentication and never receives model-provider secrets.

For the local product, the CLI gathers provider configuration, `packages/ai` validates and stores it, and `packages/runtime` resolves it inside the daemon process. A future browser gateway can supply its own transport authentication without changing model-provider authentication.

## Specifications and tests

- [Client authority and adapter boundaries](../../docs/architecture/client-boundaries.md)
- [Wire protocol and SDK](../../docs/architecture/web-protocol.md)
- [Mutation and event delivery](../../docs/architecture/web-delivery.md)
- [Canonical protocol fixtures](../protocol/test/fixtures)

Run:

```bash
pnpm --filter @axl/sdk build
pnpm --filter @axl/sdk test
pnpm check:boundaries
```
