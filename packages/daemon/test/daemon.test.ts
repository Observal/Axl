// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { type ModelPort, ToolRegistry } from "@axl/kernel";
import type {
  CanonicalEvent,
  ModelStreamEvent,
  SessionActivityFrame,
  SessionForkResult,
  SessionHistoryResult,
  SessionId,
  SessionSubscribeResult,
  Usage,
  WorkspaceStatusResult,
} from "@axl/protocol";
import {
  encodeWireMessage,
  MAX_CANONICAL_EVENT_BYTES,
  parseOperationId,
  parseServerMessage,
  parseSessionId,
  type ServerMessage,
  WIRE_PROTOCOL_VERSION,
  type WireRequest,
} from "@axl/protocol";

import { AxlDaemon, DaemonError } from "../src/index.ts";
import {
  AxlClient,
  AxlClientError,
  type AxlTransport,
  type AxlTransportFactory,
  subscribeSession,
  type WireEvent,
} from "@axl/sdk";
import { connectUnixClient, nodeIdempotencyKeys, UnixSocketTransportFactory } from "@axl/sdk/unix";
import { decodeGit, GitExecutionError, runGit } from "../src/workspace-git.ts";

const usage: Usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const execute = promisify(execFile);

function replyPort(): ModelPort {
  let calls = 0;
  return {
    stream(request) {
      calls += 1;
      const turn = calls;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (request.signal?.aborted) {
          yield { type: "aborted" };
          return;
        }
        yield { type: "text_delta", text: `reply ${turn}` };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
}

function pausedActivityPort(): { readonly port: ModelPort; readonly finish: () => void } {
  let finish!: () => void;
  const pause = new Promise<void>((resolvePromise) => {
    finish = resolvePromise;
  });
  return {
    finish,
    port: {
      stream() {
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "text_delta", text: "first " };
          yield { type: "text_delta", text: "second" };
          await pause;
          yield { type: "completed", stopReason: "stop", usage };
        })();
      },
    },
  };
}

/** A port that streams nothing until aborted, for interruption tests. */
function hangingPort(): ModelPort {
  return {
    stream(request) {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        await new Promise<void>((resolvePromise) => {
          if (request.signal?.aborted) return resolvePromise();
          request.signal?.addEventListener("abort", () => resolvePromise(), { once: true });
        });
        yield { type: "aborted" };
      })();
    },
  };
}

async function startDaemon(
  context: TestContext,
  port: ModelPort = replyPort(),
  securityMode: "sandboxed" | "unsafe" = "sandboxed",
  sandboxProvider?: string,
  sandboxImage?: string,
): Promise<{ daemon: AxlDaemon; socketPath: string; dataDirectory: string; cwd: string }> {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    securityMode,
    ...(sandboxProvider === undefined ? {} : { sandboxProvider }),
    ...(sandboxImage === undefined ? {} : { sandboxImage }),
    runtime: () => ({ model: port, tools: new ToolRegistry(), system: "You are Axl." }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  return { daemon, socketPath, dataDirectory: join(directory, "data"), cwd: directory };
}

function types(events: readonly CanonicalEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

type TransportFault = {
  readonly incoming?: (message: unknown) => unknown | undefined;
  readonly outgoing?: (message: string) => string;
};

class FaultTransportFactory implements AxlTransportFactory<never> {
  private readonly delegate: UnixSocketTransportFactory;
  private readonly fault: TransportFault;

  constructor(socketPath: string, fault: TransportFault) {
    this.delegate = new UnixSocketTransportFactory(socketPath);
    this.fault = fault;
  }

  async connect(): Promise<AxlTransport> {
    const transport = await this.delegate.connect();
    return {
      send: (message) => transport.send(this.fault.outgoing?.(message) ?? message),
      onMessage: (listener) =>
        transport.onMessage((message) => {
          const delivered =
            this.fault.incoming === undefined ? message : this.fault.incoming(message);
          if (delivered !== undefined) listener(delivered);
        }),
      onClose: (listener) => transport.onClose(listener),
      close: () => transport.close(),
    };
  }
}

function connectFaultClient(
  socketPath: string,
  fault: TransportFault,
  kind = "headless",
): Promise<AxlClient> {
  return AxlClient.connect({
    transport: new FaultTransportFactory(socketPath, fault),
    identity: { kind, version: "0.0.0", instanceId: randomUUID() },
    idempotencyKeys: nodeIdempotencyKeys,
  });
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function subscribeAll(
  client: AxlClient,
  sessionId: SessionId,
  after?: string,
): Promise<{
  readonly subscription: SessionSubscribeResult;
  readonly events: readonly CanonicalEvent[];
}> {
  const subscription = await client.request("session.subscribe", {
    sessionId,
    ...(after === undefined ? {} : { after }),
  });
  const descriptor = subscription.snapshot;
  if (descriptor === undefined) return { subscription, events: [] };
  const events = [...descriptor.page.events];
  let page = descriptor.page;
  while (!page.complete) {
    const pageCursor = page.nextPageCursor;
    assert.ok(pageCursor);
    const result: SessionHistoryResult = await client.request("session.history", {
      snapshotId: descriptor.snapshotId,
      pageCursor,
    });
    assert.equal(result.snapshotId, descriptor.snapshotId);
    page = result.page;
    events.push(...page.events);
  }
  await client.request("session.ack", {
    subscriptionId: subscription.subscriptionId,
    cursor: descriptor.boundaryCursor,
  });
  return { subscription, events };
}

async function removeCommandCompletions(
  dataDirectory: string,
  idempotencyKeys: ReadonlySet<string>,
): Promise<void> {
  const journalPath = join(dataDirectory, "commands.jsonl");
  const records = (await readFile(journalPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (record) =>
        !(
          (record.type === "succeeded" || record.type === "failed") &&
          typeof record.idempotencyKey === "string" &&
          idempotencyKeys.has(record.idempotencyKey)
        ),
    );
  await writeFile(journalPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function rawConnection(socketPath: string): {
  readonly socket: Socket;
  readonly next: () => Promise<ServerMessage>;
  readonly send: (request: WireRequest) => void;
} {
  const socket = createConnection(socketPath);
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const queued: ServerMessage[] = [];
  const waiters: Array<(message: ServerMessage) => void> = [];
  socket.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = parseServerMessage(JSON.parse(line) as unknown);
      const waiter = waiters.shift();
      if (waiter === undefined) queued.push(message);
      else waiter(message);
    }
  });
  return {
    socket,
    next: () => {
      const message = queued.shift();
      return message === undefined
        ? new Promise((resolvePromise) => waiters.push(resolvePromise))
        : Promise.resolve(message);
    },
    send: (request) => socket.write(encodeWireMessage(request)),
  };
}

test("requires version-4 initialization before session access", async (context) => {
  const fixture = await startDaemon(context);
  const raw = rawConnection(fixture.socketPath);
  context.after(() => raw.socket.destroy());

  const hello = await raw.next();
  assert.equal(hello.kind, "hello");
  if (hello.kind !== "hello") return;
  assert.equal(hello.wireVersion, WIRE_PROTOCOL_VERSION);
  assert.equal(hello.limits.maxMessageBytes, 1_048_576);
  assert.equal(hello.limits.maxPendingRequests, 64);

  raw.send({ kind: "request", id: 0, method: "daemon.info", params: {} });
  const info = await raw.next();
  assert.equal(info.kind, "success");
  if (info.kind === "success" && info.method === "daemon.info") {
    assert.equal(info.result.securityMode, "sandboxed");
  }

  raw.send({
    kind: "request",
    id: 1,
    method: "session.list",
    params: { scope: "all_local", order: "recent", pageSize: 50 },
  });
  const beforeInitialization = await raw.next();
  assert.equal(beforeInitialization.kind, "error");
  if (beforeInitialization.kind === "error") {
    assert.equal(beforeInitialization.method, "session.list");
    assert.deepEqual(beforeInitialization.error, {
      code: "connection_not_initialized",
      message: "Initialize the connection before accessing sessions",
      retryable: false,
    });
  }

  raw.send({
    kind: "request",
    id: 2,
    method: "connection.initialize",
    params: {
      client: { kind: "future_client", version: "9.1.0", instanceId: "fixture-client" },
      requestedCapabilities: ["session.create", "future.capability"],
    },
  });
  const initialized = await raw.next();
  assert.equal(initialized.kind, "success");
  if (initialized.kind === "success" && initialized.method === "connection.initialize") {
    assert.equal(initialized.result.daemonInstanceId, hello.daemonInstanceId);
    assert.equal(initialized.result.scope, "local_control");
    assert.deepEqual(initialized.result.grantedCapabilities, ["session.create"]);
  }

  raw.send({
    kind: "request",
    id: 4,
    method: "session.list",
    params: { scope: "all_local", order: "recent", pageSize: 50 },
  });
  const unsupported = await raw.next();
  assert.equal(unsupported.kind, "error");
  if (unsupported.kind === "error") {
    assert.equal(unsupported.error.code, "unsupported_capability");
  }

  raw.send({
    kind: "request",
    id: 3,
    method: "connection.initialize",
    params: {
      client: { kind: "future_client", version: "9.1.0", instanceId: "fixture-client" },
      requestedCapabilities: [],
    },
  });
  const repeated = await raw.next();
  assert.equal(repeated.kind, "error");
  if (repeated.kind === "error") {
    assert.equal(repeated.error.code, "connection_already_initialized");
  }

  raw.send({ kind: "request", id: 5, method: "session.create", params: { cwd: fixture.cwd } });
  const missingKey = await raw.next();
  assert.equal(missingKey.kind, "error");
  if (missingKey.kind === "error") {
    assert.equal(missingKey.id, 5);
    assert.equal(missingKey.error.code, "invalid_idempotency_key");
  }
  raw.send({
    kind: "request",
    id: 6,
    method: "daemon.info",
    params: {},
    idempotencyKey: "00000000-0000-4000-8000-000000000109",
  });
  const keyOnRead = await raw.next();
  assert.equal(keyOnRead.kind, "error");
  if (keyOnRead.kind === "error") {
    assert.equal(keyOnRead.id, 6);
    assert.equal(keyOnRead.error.code, "invalid_idempotency_key");
  }
});

test("cancels attachment-owned read requests without cancelling session operations", async (context) => {
  const fixture = await startDaemon(context);
  const client = await connectUnixClient(fixture.socketPath);
  context.after(() => client.close());
  const created = await client.request("session.create", { cwd: fixture.cwd });

  fixture.daemon.sessions.workspaceStatus = async (_sessionId, _params, signal) =>
    new Promise((_, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(new DaemonError("cancelled", "Workspace request was cancelled")),
        { once: true },
      );
    });
  const pending = client.request("session.workspace.status", {
    sessionId: created.sessionId,
    scope: "working",
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  assert.deepEqual(await client.request("request.cancel", { requestId: 3 }), {
    cancellationRequested: true,
  });
  await assert.rejects(
    pending,
    (error) => error instanceof AxlClientError && error.code === "cancelled",
  );
  assert.deepEqual(await client.request("request.cancel", { requestId: 999 }), {
    cancellationRequested: false,
  });
  assert.equal(
    (await client.request("session.interrupt", { sessionId: created.sessionId })).interrupted,
    false,
  );
});

test("expires incomplete snapshots and requires a replacement boundary", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    snapshotIdleLifetimeMs: 10,
    snapshotAbsoluteLifetimeMs: 50,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());
  const created = await client.request("session.create", { cwd: directory });
  const subscription = await client.request("session.subscribe", { sessionId: created.sessionId });
  assert.ok(subscription.snapshot);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  await assert.rejects(
    client.request("session.ack", {
      subscriptionId: subscription.subscriptionId,
      cursor: subscription.snapshot.boundaryCursor,
    }),
    (error) => error instanceof AxlClientError && error.code === "snapshot_required",
  );
});

test("publishes bounded attachment presence and subscription membership", async (context) => {
  const fixture = await startDaemon(context);
  const first = await connectUnixClient(fixture.socketPath, {
    identity: { kind: "tui", version: "1.0.0", instanceId: "presence-one" },
    requestedCapabilities: ["session.create", "session.subscribe", "session.presence"],
  });
  context.after(() => first.close());
  let stopInitialPresence = (): void => undefined;
  await new Promise<void>((resolvePromise) => {
    stopInitialPresence = first.onPresence(() => resolvePromise());
  });
  stopInitialPresence();
  const firstPresence: Array<
    readonly { attachmentId: string; subscribedSessionIds: readonly string[] }[]
  > = [];
  const stopPresence = first.onPresence((message) => firstPresence.push(message.attachments));
  assert.equal(firstPresence.at(-1)?.length, 1);

  const withoutPresence = await connectUnixClient(fixture.socketPath, {
    identity: { kind: "headless", version: "1.0.0", instanceId: "presence-disabled" },
    requestedCapabilities: [],
  });
  context.after(() => withoutPresence.close());
  let unauthorizedPresence = 0;
  withoutPresence.onPresence(() => {
    unauthorizedPresence += 1;
  });

  const second = await connectUnixClient(fixture.socketPath, {
    identity: { kind: "future_client", version: "2.0.0", instanceId: "presence-two" },
    requestedCapabilities: ["session.presence"],
  });
  const secondPresence: Array<readonly { attachmentId: string; clientKind: string }[]> = [];
  second.onPresence((message) => secondPresence.push(message.attachments));
  for (let attempt = 0; (firstPresence.at(-1)?.length ?? 0) < 3 && attempt < 100; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.equal(firstPresence.at(-1)?.length, 3);
  assert.deepEqual(
    secondPresence
      .at(-1)
      ?.map((attachment) => attachment.clientKind)
      .sort(),
    ["future_client", "headless", "tui"],
  );
  assert.equal(unauthorizedPresence, 0);

  const created = await first.request("session.create", { cwd: fixture.cwd });
  const subscribed = await first.request("session.subscribe", { sessionId: created.sessionId });
  const boundaryCursor = subscribed.snapshot?.boundaryCursor;
  assert.ok(boundaryCursor);
  await first.request("session.ack", {
    subscriptionId: subscribed.subscriptionId,
    cursor: boundaryCursor,
  });
  for (
    let attempt = 0;
    !firstPresence
      .at(-1)
      ?.some((attachment) => attachment.subscribedSessionIds.includes(created.sessionId)) &&
    attempt < 100;
    attempt += 1
  ) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.equal(
    firstPresence
      .at(-1)
      ?.some((attachment) => attachment.subscribedSessionIds.includes(created.sessionId)),
    true,
  );

  second.close();
  withoutPresence.close();
  for (let attempt = 0; (firstPresence.at(-1)?.length ?? 0) !== 1 && attempt < 100; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.equal(firstPresence.at(-1)?.length, 1);

  const updatesBeforeDispose = firstPresence.length;
  stopPresence();
  const third = await connectUnixClient(fixture.socketPath, {
    identity: { kind: "ide", version: "1.0.0", instanceId: "presence-three" },
    requestedCapabilities: ["session.presence"],
  });
  context.after(() => third.close());
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.equal(firstPresence.length, updatesBeforeDispose);
  assert.equal(unauthorizedPresence, 0);
  third.close();
});

test("expires an initialized attachment that stops sending heartbeats", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    heartbeatIntervalMs: 10,
    presenceTimeoutMs: 40,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await daemon.start();
  context.after(() => daemon.stop());

  const observer = await connectUnixClient(socketPath, {
    requestedCapabilities: ["session.presence"],
  });
  context.after(() => observer.close());
  const snapshots: number[] = [];
  observer.onPresence((message) => snapshots.push(message.attachments.length));

  const stale = rawConnection(socketPath);
  context.after(() => stale.socket.destroy());
  assert.equal((await stale.next()).kind, "hello");
  stale.send({
    kind: "request",
    id: 1,
    method: "connection.initialize",
    params: {
      client: { kind: "headless", version: "0.0.0", instanceId: "stale-client" },
      requestedCapabilities: [],
    },
  });
  const initialized = await stale.next();
  assert.equal(initialized.kind, "success");
  await waitFor(() => snapshots.includes(2), "stale attachment presence");
  await waitFor(() => snapshots.at(-1) === 1, "stale attachment expiry");
});

test("reports the daemon security mode", async (context) => {
  const sandboxed = await startDaemon(context);
  const sandboxedClient = await connectUnixClient(sandboxed.socketPath, {
    identity: { kind: "future_client", version: "1.0.0", instanceId: "future-client-1" },
    requestedCapabilities: ["session.create", "future.capability"],
  });
  context.after(() => sandboxedClient.close());
  assert.equal(sandboxedClient.connection.wireVersion, WIRE_PROTOCOL_VERSION);
  assert.equal(sandboxedClient.connection.scope, "local_control");
  assert.deepEqual(sandboxedClient.connection.grantedCapabilities, ["session.create"]);
  assert.deepEqual(await sandboxedClient.request("connection.ping", {}), {});
  await assert.rejects(
    sandboxedClient.request("session.list", {
      scope: "all_local",
      order: "recent",
      pageSize: 50,
    }),
    (error) => error instanceof AxlClientError && error.code === "unsupported_capability",
  );
  assert.deepEqual(await sandboxedClient.request("daemon.info", {}), {
    securityMode: "sandboxed",
    sandboxProvider: "unknown",
  });

  const unsafe = await startDaemon(context, replyPort(), "unsafe");
  const unsafeClient = await connectUnixClient(unsafe.socketPath);
  context.after(() => unsafeClient.close());
  assert.deepEqual(await unsafeClient.request("daemon.info", {}), {
    securityMode: "unsafe",
    sandboxProvider: "unknown",
  });

  const image = `example.invalid/image@sha256:${"a".repeat(64)}`;
  const oci = await startDaemon(context, replyPort(), "sandboxed", "podman", image);
  const ociClient = await connectUnixClient(oci.socketPath);
  context.after(() => ociClient.close());
  assert.deepEqual(await ociClient.request("daemon.info", {}), {
    securityMode: "sandboxed",
    sandboxProvider: "podman",
    sandboxImage: image,
  });
});

test("durably deduplicates retryable mutations and rejects key conflicts", async (context) => {
  const fixture = await startDaemon(context);
  const client = await connectUnixClient(fixture.socketPath);
  context.after(() => client.close());
  const createKey = "00000000-0000-4000-8000-000000000101";
  const sendKey = "00000000-0000-4000-8000-000000000102";

  const created = await client.request(
    "session.create",
    { cwd: fixture.cwd },
    { idempotencyKey: createKey },
  );
  const retriedCreate = await client.request(
    "session.create",
    { cwd: fixture.cwd },
    { idempotencyKey: createKey },
  );
  assert.deepEqual(retriedCreate, created);
  const otherCwd = join(fixture.cwd, "other");
  await mkdir(otherCwd);
  await assert.rejects(
    client.request("session.create", { cwd: otherCwd }, { idempotencyKey: createKey }),
    (error) => error instanceof AxlClientError && error.code === "idempotency_conflict",
  );

  const sent = await client.request(
    "session.send",
    {
      sessionId: created.sessionId,
      delivery: "prompt",
      content: [{ type: "text", text: "exactly once" }],
    },
    { idempotencyKey: sendKey },
  );
  const retriedSend = await client.request(
    "session.send",
    {
      content: [{ text: "exactly once", type: "text" }],
      delivery: "prompt",
      sessionId: created.sessionId,
    },
    { idempotencyKey: sendKey },
  );
  assert.deepEqual(retriedSend, sent);
  const beforeRestart = await subscribeAll(client, created.sessionId);
  assert.equal(beforeRestart.events[0]?.operationId, createKey);
  assert.equal(beforeRestart.events.filter((event) => event.type === "user.message").length, 1);
  assert.equal(
    beforeRestart.events
      .filter((event) => event.type === "user.message" || event.type === "assistant.message")
      .every((event) => event.operationId === sendKey),
    true,
  );
  const sourceMessage = beforeRestart.events.find((event) => event.type === "user.message");
  assert.ok(sourceMessage);
  const forkKey = "00000000-0000-4000-8000-000000000108";
  const forked = await client.request(
    "session.fork",
    { sessionId: created.sessionId, fromEventId: sourceMessage.id },
    { idempotencyKey: forkKey },
  );
  const forkSnapshot = await subscribeAll(client, forked.sessionId);
  assert.equal(forkSnapshot.events[0]?.operationId, forkKey);
  assert.equal(
    forkSnapshot.events[0]?.type === "session.created" &&
      forkSnapshot.events[0].payload.sourceEventId,
    sourceMessage.id,
  );
  const cloneKey = "00000000-0000-4000-8000-000000000109";
  const cloned = await client.request(
    "session.clone",
    { sessionId: created.sessionId },
    { idempotencyKey: cloneKey },
  );
  const cloneSnapshot = await subscribeAll(client, cloned.sessionId);
  assert.equal(cloneSnapshot.events[0]?.operationId, cloneKey);

  client.close();
  await fixture.daemon.stop();
  const journalPath = join(fixture.dataDirectory, "commands.jsonl");
  await removeCommandCompletions(
    fixture.dataDirectory,
    new Set([createKey, sendKey, forkKey, cloneKey]),
  );
  const restarted = new AxlDaemon({
    socketPath: fixture.socketPath,
    dataDirectory: fixture.dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await restarted.start();
  context.after(() => restarted.stop());
  const recoveredBeforeRequests = (await readFile(journalPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const key of [createKey, sendKey, forkKey, cloneKey]) {
    assert.equal(
      recoveredBeforeRequests.some(
        (record) => record.type === "succeeded" && record.idempotencyKey === key,
      ),
      true,
    );
  }
  const reconnected = await connectUnixClient(fixture.socketPath);
  context.after(() => reconnected.close());
  assert.deepEqual(
    await reconnected.request(
      "session.create",
      { cwd: fixture.cwd },
      { idempotencyKey: createKey },
    ),
    created,
  );
  await assert.rejects(
    reconnected.request(
      "session.dispose",
      { sessionId: created.sessionId },
      { idempotencyKey: createKey },
    ),
    (error) => error instanceof AxlClientError && error.code === "idempotency_conflict",
  );
  assert.deepEqual(
    await reconnected.request(
      "session.fork",
      { sessionId: created.sessionId, fromEventId: sourceMessage.id },
      { idempotencyKey: forkKey },
    ),
    forked,
  );
  assert.deepEqual(
    await reconnected.request(
      "session.send",
      {
        sessionId: created.sessionId,
        delivery: "prompt",
        content: [{ type: "text", text: "exactly once" }],
      },
      { idempotencyKey: sendKey },
    ),
    sent,
  );
  assert.deepEqual(
    await reconnected.request(
      "session.clone",
      { sessionId: created.sessionId },
      { idempotencyKey: cloneKey },
    ),
    cloned,
  );
  await reconnected.request("session.resume", { sessionId: created.sessionId });
  const afterRestart = await subscribeAll(reconnected, created.sessionId);
  assert.equal(afterRestart.events.filter((event) => event.type === "user.message").length, 1);

  const journal = (await readFile(journalPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const acceptance = journal.find(
    (record) => record.type === "accepted" && record.idempotencyKey === createKey,
  );
  assert.equal(acceptance?.operationId, createKey);
  assert.equal(typeof acceptance?.intendedSessionId, "string");
});

test("restart reconciliation aborts an accepted non-terminal send", async (context) => {
  const fixture = await startDaemon(context);
  const client = await connectUnixClient(fixture.socketPath);
  const created = await client.request("session.create", { cwd: fixture.cwd });
  const sendKey = "00000000-0000-4000-8000-000000000107";
  await client.request(
    "session.send",
    {
      sessionId: created.sessionId,
      delivery: "prompt",
      content: [{ type: "text", text: "interrupted by restart" }],
    },
    { idempotencyKey: sendKey },
  );
  client.close();
  await fixture.daemon.stop();

  const logPath = join(fixture.dataDirectory, "sessions", `${created.sessionId}.jsonl`);
  const events = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CanonicalEvent)
    .filter((event) => !(event.type === "assistant.message" && event.operationId === sendKey));
  await writeFile(logPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const journalPath = join(fixture.dataDirectory, "commands.jsonl");
  const records = (await readFile(journalPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => !(record.type === "succeeded" && record.idempotencyKey === sendKey));
  await writeFile(journalPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  const restarted = new AxlDaemon({
    socketPath: fixture.socketPath,
    dataDirectory: fixture.dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await restarted.start();
  context.after(() => restarted.stop());
  const reconnected = await connectUnixClient(fixture.socketPath);
  context.after(() => reconnected.close());
  await reconnected.request("session.resume", { sessionId: created.sessionId });
  assert.deepEqual(
    await reconnected.request(
      "session.send",
      {
        sessionId: created.sessionId,
        delivery: "prompt",
        content: [{ type: "text", text: "interrupted by restart" }],
      },
      { idempotencyKey: sendKey },
    ),
    { operationId: sendKey, stopReason: "aborted" },
  );
  const recovered = await subscribeAll(reconnected, created.sessionId);
  const operationEvents = recovered.events.filter((event) => event.operationId === sendKey);
  assert.deepEqual(types(operationEvents), ["user.message", "assistant.message"]);
  assert.equal(
    operationEvents[1]?.type === "assistant.message" && operationEvents[1].payload.stopReason,
    "aborted",
  );
});

test("creates a session, streams the live tail, and answers sends", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());

  const created = await client.request("session.create", { cwd });
  assert.equal(created.cwd, await realpath(cwd));

  const pushed: WireEvent[] = [];
  client.onEvent((event) => pushed.push(event));
  const { events: snapshot } = await subscribeAll(client, created.sessionId);
  assert.deepEqual(types(snapshot), ["session.created"]);

  const sent = (await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "hello" }],
  })) as { stopReason: string };
  assert.equal(sent.stopReason, "stop");
  assert.deepEqual(
    pushed.map((event) => event.event.type),
    ["user.message", "assistant.message"],
  );
  assert.equal(pushed[0]?.sessionId, created.sessionId);
  await assert.rejects(
    client.request("session.send", {
      sessionId: created.sessionId,
      content: [{ type: "text", text: "steer" }],
      delivery: "steer",
    }),
    (error) => error instanceof AxlClientError && error.code === "unsupported_capability",
  );
});

test("freezes paged snapshots and releases the buffered tail only after acknowledgement", async (context) => {
  const largeReply: ModelPort = {
    stream() {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        for (let index = 0; index < 7; index += 1) {
          yield { type: "text_delta", text: "x".repeat(60_000) };
        }
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const { socketPath, cwd } = await startDaemon(context, largeReply);
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());
  const created = await client.request("session.create", { cwd });
  await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "first" }],
  });
  await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "second" }],
  });

  const delivered: WireEvent[] = [];
  client.onEvent((event) => delivered.push(event));
  const subscription = await client.request("session.subscribe", {
    sessionId: created.sessionId,
  });
  const descriptor = subscription.snapshot;
  assert.ok(descriptor);
  assert.equal(descriptor.page.complete, false);
  const firstPageCursor = descriptor.page.nextPageCursor;
  assert.ok(firstPageCursor);
  const other = await connectUnixClient(socketPath);
  context.after(() => other.close());
  await assert.rejects(
    other.request("session.history", {
      snapshotId: descriptor.snapshotId,
      pageCursor: firstPageCursor,
    }),
    (error) => error instanceof AxlClientError && error.code === "snapshot_required",
  );
  const frozenEvents = [...descriptor.page.events];
  await assert.rejects(
    client.request("session.ack", {
      subscriptionId: subscription.subscriptionId,
      cursor: descriptor.boundaryCursor,
    }),
    (error) => error instanceof AxlClientError && error.code === "snapshot_required",
  );

  await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "after boundary" }],
  });
  assert.equal(delivered.length, 0);

  let page = descriptor.page;
  let verifiedStablePage = false;
  while (!page.complete) {
    const pageCursor = page.nextPageCursor;
    assert.ok(pageCursor);
    const next: SessionHistoryResult = await client.request("session.history", {
      snapshotId: descriptor.snapshotId,
      pageCursor,
    });
    if (!verifiedStablePage) {
      assert.deepEqual(
        await client.request("session.history", {
          snapshotId: descriptor.snapshotId,
          pageCursor,
        }),
        next,
      );
      verifiedStablePage = true;
    }
    page = next.page;
    frozenEvents.push(...page.events);
  }
  assert.equal(frozenEvents.length, descriptor.eventCount);
  assert.equal(
    frozenEvents.some(
      (event) =>
        event.type === "user.message" &&
        event.payload.content[0]?.type === "text" &&
        event.payload.content[0].text === "after boundary",
    ),
    false,
  );
  assert.equal(delivered.length, 0);

  await client.request("session.ack", {
    subscriptionId: subscription.subscriptionId,
    cursor: descriptor.boundaryCursor,
  });
  for (let attempt = 0; delivered.length < 2 && attempt < 100; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.deepEqual(types(delivered.map((item) => item.event)), [
    "user.message",
    "assistant.message",
  ]);
  assert.deepEqual(
    delivered.map((item) => item.sequence),
    [1, 2],
  );
});

test("events appended between resume and subscribe enter the frozen snapshot", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  const owner = await connectUnixClient(socketPath);
  const attaching = await connectUnixClient(socketPath);
  context.after(() => {
    owner.close();
    attaching.close();
  });
  const created = await owner.request("session.create", { cwd });
  await attaching.request("session.resume", { sessionId: created.sessionId });
  await owner.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "between" }],
  });

  const { events } = await subscribeAll(attaching, created.sessionId);
  assert.deepEqual(types(events), ["session.created", "user.message", "assistant.message"]);
});

test("streams transient deltas and resumes the latest accumulated activity", async (context) => {
  let release = (): void => undefined;
  const streaming: ModelPort = {
    stream() {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "thinking_delta", text: "checking " };
        yield { type: "text_delta", text: "x".repeat(65_535) };
        yield { type: "text_delta", text: "partial" };
        await new Promise<void>((resolvePromise) => {
          release = resolvePromise;
        });
        yield { type: "text_delta", text: " answer" };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const { socketPath, cwd } = await startDaemon(context, streaming);
  const first = await connectUnixClient(socketPath);
  const second = await connectUnixClient(socketPath);
  context.after(() => {
    first.close();
    second.close();
  });
  const created = await first.request("session.create", { cwd });
  const frames: string[] = [];
  first.onActivity((message) => frames.push(message.frame.type));
  await subscribeAll(first, created.sessionId);
  const sending = first.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "go" }],
  });
  for (let attempt = 0; frames.length < 3 && attempt < 100; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.deepEqual(frames, ["thinking_delta", "text_delta", "text_delta"]);
  const resumedFrames: SessionActivityFrame[] = [];
  second.onActivity((message) => resumedFrames.push(message.frame));
  await subscribeAll(second, created.sessionId);
  for (let attempt = 0; resumedFrames.length === 0 && attempt < 100; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  const resumed = resumedFrames.at(-1);
  assert.equal(resumed?.type, "snapshot");
  assert.ok(resumed?.operationId);
  assert.equal(resumed?.sequence, 3);
  if (resumed?.type === "snapshot") {
    assert.equal(resumed.text.length, 65_536);
    assert.equal(resumed.text.endsWith("partial"), true);
    assert.equal(resumed.thinking, "checking ");
    assert.deepEqual(resumed.toolCalls, []);
  }
  release();
  await sending;
  assert.equal(frames.at(-1), "clear");
});

test("uploads image blobs in chunks without persisting bytes in JSONL", async (context) => {
  const { socketPath, cwd, dataDirectory } = await startDaemon(context);
  const orphanDirectory = join(dataDirectory, "blobs", "uploads");
  const orphan = join(orphanDirectory, "orphaned-upload");
  await mkdir(orphanDirectory, { recursive: true });
  await writeFile(orphan, "partial");
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());
  const created = await client.request("session.create", { cwd });
  const bytes = Buffer.alloc(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
  bytes.set(Buffer.from("IHDR"), 12);
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  const started = (await client.request("session.blob.start", {
    sessionId: created.sessionId,
    mediaType: "image/png",
    sizeBytes: bytes.length,
    name: "pixel.png",
  })) as { uploadId: string };
  await assert.rejects(readFile(orphan), { code: "ENOENT" });
  await client.request("session.blob.chunk", {
    sessionId: created.sessionId,
    uploadId: started.uploadId,
    offset: 0,
    data: bytes.toString("base64"),
  });
  const blob = (await client.request("session.blob.commit", {
    sessionId: created.sessionId,
    uploadId: started.uploadId,
  })) as { sha256: string; mediaType: string; sizeBytes: number; name: string };
  assert.equal(blob.mediaType, "image/png");
  await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "blob", blob }],
  });
  const range = (await client.request("session.blob.read", {
    sessionId: created.sessionId,
    sha256: blob.sha256,
    offset: 0,
    length: bytes.length,
  })) as { data: string; eof: boolean };
  assert.deepEqual(Buffer.from(range.data, "base64"), bytes);
  assert.equal(range.eof, true);
  const log = await readFile(join(dataDirectory, "sessions", `${created.sessionId}.jsonl`), "utf8");
  assert.equal(log.includes(bytes.toString("base64")), false);
  assert.match(log, new RegExp(blob.sha256));

  const other = await client.request("session.create", { cwd });
  await assert.rejects(
    client.request("session.blob.read", {
      sessionId: other.sessionId,
      sha256: blob.sha256,
      offset: 0,
      length: bytes.length,
    }),
    (error) => error instanceof AxlClientError && error.code === "blob_not_owned",
  );

  const invalid = Buffer.from("not an image");
  const rejected = (await client.request("session.blob.start", {
    sessionId: created.sessionId,
    mediaType: "image/png",
    sizeBytes: invalid.length,
  })) as { uploadId: string };
  await assert.rejects(
    client.request("session.blob.chunk", {
      sessionId: created.sessionId,
      uploadId: rejected.uploadId,
      offset: 1,
      data: invalid.toString("base64"),
    }),
    (error) => error instanceof AxlClientError && error.code === "blob_offset_mismatch",
  );
  await client.request("session.blob.chunk", {
    sessionId: created.sessionId,
    uploadId: rejected.uploadId,
    offset: 0,
    data: invalid.toString("base64"),
  });
  await assert.rejects(
    client.request("session.blob.commit", {
      sessionId: created.sessionId,
      uploadId: rejected.uploadId,
    }),
    (error) => error instanceof AxlClientError && error.code === "invalid_image",
  );

  const concurrent = (await client.request("session.blob.start", {
    sessionId: created.sessionId,
    mediaType: "application/octet-stream",
    sizeBytes: 6,
  })) as { uploadId: string };
  const writes = await Promise.allSettled([
    client.request("session.blob.chunk", {
      sessionId: created.sessionId,
      uploadId: concurrent.uploadId,
      offset: 0,
      data: Buffer.from("abc").toString("base64"),
    }),
    client.request("session.blob.chunk", {
      sessionId: created.sessionId,
      uploadId: concurrent.uploadId,
      offset: 0,
      data: Buffer.from("def").toString("base64"),
    }),
  ]);
  assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
  const rejectedWrite = writes.find((result) => result.status === "rejected");
  assert.ok(rejectedWrite?.status === "rejected");
  assert.equal(rejectedWrite.reason instanceof AxlClientError, true);
  assert.equal((rejectedWrite.reason as AxlClientError).code, "blob_offset_mismatch");
  await client.request("session.blob.chunk", {
    sessionId: created.sessionId,
    uploadId: concurrent.uploadId,
    offset: 3,
    data: Buffer.from("ghi").toString("base64"),
  });
  await client.request("session.blob.commit", {
    sessionId: created.sessionId,
    uploadId: concurrent.uploadId,
  });

  const starts = await Promise.allSettled(
    Array.from({ length: 17 }, () =>
      client.request("session.blob.start", {
        sessionId: created.sessionId,
        mediaType: "application/octet-stream",
        sizeBytes: 1,
      }),
    ),
  );
  assert.equal(starts.filter((result) => result.status === "fulfilled").length, 16);
  const rejectedStart = starts.find((result) => result.status === "rejected");
  assert.ok(rejectedStart?.status === "rejected");
  assert.equal(rejectedStart.reason instanceof AxlClientError, true);
  assert.equal((rejectedStart.reason as AxlClientError).code, "too_many_uploads");

  const active = starts.find(
    (result): result is PromiseFulfilledResult<{ uploadId: string; chunkBytes: number }> =>
      result.status === "fulfilled",
  );
  assert.ok(active);
  assert.deepEqual(
    await client.request("session.blob.abort", {
      sessionId: created.sessionId,
      uploadId: active.value.uploadId,
    }),
    { aborted: true },
  );
  assert.deepEqual(
    await client.request("session.blob.abort", {
      sessionId: created.sessionId,
      uploadId: active.value.uploadId,
    }),
    { aborted: false },
  );
  await client.request("session.blob.start", {
    sessionId: created.sessionId,
    mediaType: "application/octet-stream",
    sizeBytes: 1,
  });
});

test("a session survives daemon termination and resumes with full history", async (context) => {
  const first = await startDaemon(context);
  const client = await connectUnixClient(first.socketPath);
  const created = await client.request("session.create", { cwd: first.cwd });
  await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "before restart" }],
  });
  client.close();
  await first.daemon.stop();

  // A new daemon over the same data directory owns the same sessions.
  const daemon = new AxlDaemon({
    socketPath: first.socketPath,
    dataDirectory: first.dataDirectory,
    runtime: ({ cwd }) => {
      assert.equal(cwd, first.cwd);
      return { model: replyPort(), tools: new ToolRegistry() };
    },
  });
  await daemon.start();
  context.after(() => daemon.stop());

  const reconnected = await connectUnixClient(first.socketPath);
  context.after(() => reconnected.close());
  const resumed = await reconnected.request("session.resume", {
    sessionId: created.sessionId,
  });
  assert.equal(resumed.sessionId, created.sessionId);
  const { events: paged } = await subscribeAll(reconnected, created.sessionId);
  assert.deepEqual(types(paged), ["session.created", "user.message", "assistant.message"]);

  const sent = (await reconnected.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "after restart" }],
  })) as { stopReason: string };
  assert.equal(sent.stopReason, "stop");
});

test("lists and reads only bounded policy-checked workspace paths", async (context) => {
  const fixture = await startDaemon(context);
  const workspace = join(fixture.cwd, "explorer");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, ".axl"));
  await writeFile(join(workspace, "a.txt"), "one\ntwo\nthree\n");
  await writeFile(join(workspace, "src", "b.txt"), "bee\n");
  await writeFile(join(workspace, ".env"), "SECRET=hidden\n");
  await writeFile(join(workspace, ".axl", "credentials.json"), "hidden\n");
  await writeFile(join(workspace, "binary.bin"), Buffer.from([1, 0, 2]));
  await writeFile(join(workspace, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  await symlink(fixture.cwd, join(workspace, "escape"));
  if (process.platform !== "win32") await execute("mkfifo", [join(workspace, "named-pipe")]);

  const client = await connectUnixClient(fixture.socketPath);
  context.after(() => client.close());
  const created = await client.request("session.create", { cwd: workspace });
  const first = await client.request("session.workspace.list", {
    sessionId: created.sessionId,
    path: "",
    pageSize: 2,
  });
  assert.equal(first.entries.length, 2);
  assert.ok(first.nextPageCursor);
  assert.deepEqual(
    first.entries.map((entry) => entry.name),
    [".axl", ".env"],
  );
  const otherClient = await connectUnixClient(fixture.socketPath);
  context.after(() => otherClient.close());
  await assert.rejects(
    otherClient.request("session.workspace.list", {
      sessionId: created.sessionId,
      path: "",
      pageSize: 2,
      pageCursor: first.nextPageCursor,
    }),
    (error) => error instanceof AxlClientError && error.code === "workspace_changed",
  );
  const complete = await client.request("session.workspace.list", {
    sessionId: created.sessionId,
    path: "",
    pageSize: 200,
    ifWorkspaceGeneration: first.workspaceGeneration,
  });
  assert.equal(
    complete.entries.find((entry) => entry.name === "escape")?.linkTargetType,
    "outside_workspace",
  );
  if (process.platform !== "win32") {
    assert.equal(complete.entries.find((entry) => entry.name === "named-pipe")?.type, "other");
  }

  const read = await client.request("session.workspace.read", {
    sessionId: created.sessionId,
    path: "a.txt",
    startLine: 2,
    maxLines: 1,
    maxBytes: 32,
    ifWorkspaceGeneration: first.workspaceGeneration,
  });
  assert.equal(read.text, "two\n");
  assert.equal(read.truncationReason, "line_limit");
  const byteLimited = await client.request("session.workspace.read", {
    sessionId: created.sessionId,
    path: "a.txt",
    maxLines: 20,
    maxBytes: 3,
  });
  assert.equal(byteLimited.text, "");
  assert.equal(byteLimited.truncationReason, "byte_limit");

  for (const [path, code] of [
    ["../outside", "bad_request"],
    ["escape/file", "symlink_escape"],
    [".env", "path_denied"],
    [".axl/credentials.json", "path_denied"],
    ["binary.bin", "binary_file"],
    ["invalid.txt", "invalid_encoding"],
    ...(process.platform === "win32" ? [] : ([["named-pipe", "unsupported_file_type"]] as const)),
  ] as const) {
    await assert.rejects(
      client.request("session.workspace.read", {
        sessionId: created.sessionId,
        path,
        maxLines: 20,
        maxBytes: 1024,
      }),
      (error) => error instanceof AxlClientError && error.code === code,
    );
  }

  await writeFile(join(workspace, "new-page-entry"), "new\n");
  await assert.rejects(
    client.request("session.workspace.list", {
      sessionId: created.sessionId,
      path: "",
      pageSize: 2,
      pageCursor: first.nextPageCursor,
    }),
    (error) => error instanceof AxlClientError && error.code === "workspace_changed",
  );
  await writeFile(join(workspace, "a.txt"), "changed\n");
  await assert.rejects(
    client.request("session.workspace.read", {
      sessionId: created.sessionId,
      path: "a.txt",
      maxLines: 20,
      maxBytes: 1024,
      ifFileRevision: read.fileRevision,
    }),
    (error) => error instanceof AxlClientError && error.code === "workspace_changed",
  );
});

test("represents staged, unstaged, rename, delete, binary, submodule, and branch states", async (context) => {
  const fixture = await startDaemon(context);
  const workspace = join(fixture.cwd, "git-states");
  await mkdir(workspace);
  await execute("git", ["init", "--quiet"], { cwd: workspace });
  await execute("git", ["config", "user.name", "Axl Test"], { cwd: workspace });
  await execute("git", ["config", "user.email", "axl@example.invalid"], { cwd: workspace });
  const trackedFiles: readonly (readonly [string, string])[] = [
    ["both.txt", "base\n"],
    ["rename.txt", "rename\n"],
    ["delete.txt", "delete\n"],
  ];
  for (const [name, content] of trackedFiles) await writeFile(join(workspace, name), content);
  await writeFile(join(workspace, "binary.bin"), Buffer.from([1, 0, 2]));
  await execute("git", ["add", "."], { cwd: workspace });
  await execute("git", ["commit", "--quiet", "-m", "base"], { cwd: workspace });
  const head = (await execute("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
  await execute("git", ["update-index", "--add", "--cacheinfo", "160000", head, "vendor"], {
    cwd: workspace,
  });
  await execute("git", ["commit", "--quiet", "-m", "gitlink"], { cwd: workspace });

  await writeFile(join(workspace, "both.txt"), "staged\n");
  await execute("git", ["add", "both.txt"], { cwd: workspace });
  await writeFile(join(workspace, "both.txt"), "unstaged\n");
  await execute("git", ["mv", "rename.txt", "renamed.txt"], { cwd: workspace });
  await rm(join(workspace, "delete.txt"));
  await writeFile(join(workspace, "binary.bin"), Buffer.from([3, 0, 4]));
  await writeFile(join(workspace, "untracked.txt"), "new\n");
  await writeFile(join(workspace, "-option.txt"), "option\n");
  await writeFile(join(workspace, "tab\tnewline\nname.txt"), "odd name\n");
  await writeFile(join(workspace, "日本語.txt"), "unicode\n");

  const client = await connectUnixClient(fixture.socketPath);
  context.after(() => client.close());
  const created = await client.request("session.create", { cwd: workspace });
  const status = await client.request("session.workspace.status", {
    sessionId: created.sessionId,
    scope: "working",
  });
  assert.equal(
    status.entries.some((entry) => entry.path === "both.txt" && entry.area === "staged"),
    true,
  );
  assert.equal(
    status.entries.some((entry) => entry.path === "both.txt" && entry.area === "unstaged"),
    true,
  );
  assert.equal(
    status.entries.some(
      (entry) =>
        entry.path === "renamed.txt" &&
        entry.kind === "renamed" &&
        entry.previousPath === "rename.txt",
    ),
    true,
  );
  assert.equal(
    status.entries.some((entry) => entry.path === "delete.txt" && entry.kind === "deleted"),
    true,
  );
  assert.equal(
    status.entries.some((entry) => entry.path === "untracked.txt" && entry.kind === "untracked"),
    true,
  );
  assert.equal(
    status.entries.some((entry) => entry.path === "-option.txt"),
    true,
  );
  assert.equal(
    status.entries.some((entry) => entry.path === "tab\tnewline\nname.txt"),
    true,
  );
  assert.equal(
    status.entries.some((entry) => entry.path === "日本語.txt"),
    true,
  );
  assert.equal(
    status.entries.some((entry) => entry.path === "binary.bin" && entry.binary),
    true,
  );
  const submodule = status.entries.find((entry) => entry.path === "vendor" && entry.submodule);
  assert.ok(submodule);
  const submoduleDiff = await client.request("session.workspace.diff", {
    sessionId: created.sessionId,
    entryId: submodule.entryId,
    contextLines: 1,
    repositoryGeneration: status.repositoryGeneration,
    maxBytes: 65_536,
  });
  assert.equal(submoduleDiff.oldRevision, head);
  assert.equal(submoduleDiff.hunks.length, 0);

  const untracked = status.entries.find((entry) => entry.path === "untracked.txt");
  assert.ok(untracked);
  const untrackedDiff = await client.request("session.workspace.diff", {
    sessionId: created.sessionId,
    entryId: untracked.entryId,
    contextLines: 1,
    repositoryGeneration: status.repositoryGeneration,
    maxBytes: 65_536,
  });
  assert.equal(
    untrackedDiff.hunks.some((hunk) => hunk.lines.some((line) => line.text === "new")),
    true,
  );
  await assert.rejects(
    client.request("session.workspace.diff", {
      sessionId: created.sessionId,
      entryId: untracked.entryId,
      contextLines: 1,
      repositoryGeneration: status.repositoryGeneration,
      maxBytes: 8,
    }),
    (error) => error instanceof AxlClientError && error.code === "git_output_too_large",
  );

  await execute("git", ["config", "core.sparseCheckout", "true"], { cwd: workspace });
  await execute("git", ["checkout", "--detach"], { cwd: workspace });
  const detached = await client.request("session.workspace.status", {
    sessionId: created.sessionId,
    scope: "working",
  });
  assert.equal(detached.branch.state, "detached");
  assert.equal(detached.sparseCheckout, true);

  await rename(join(workspace, ".git"), join(workspace, ".git-replaced"));
  await execute("git", ["init", "--quiet"], { cwd: workspace });
  await assert.rejects(
    client.request("session.workspace.diff", {
      sessionId: created.sessionId,
      entryId: untracked.entryId,
      contextLines: 1,
      repositoryGeneration: status.repositoryGeneration,
      maxBytes: 65_536,
    }),
    (error) => error instanceof AxlClientError && error.code === "repository_changed",
  );
});

test("bounds Git execution time and output without invoking a shell", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-fake-git-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "git");
  await writeFile(
    executable,
    '#!/bin/sh\ncase " $* " in *" config --local "*) exit 1;; esac\nsleep 2\n',
  );
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = directory;
  try {
    await assert.rejects(
      runGit(directory, ["status"], { timeoutMs: 10 }),
      (error) => error instanceof GitExecutionError && error.code === "git_timeout",
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("rejects invalid-byte Git output without lossy filename replacement", () => {
  assert.throws(
    () => decodeGit(Buffer.from([0x4d, 0, 0xff, 0])),
    (error) => error instanceof GitExecutionError && error.code === "unsupported_filename_encoding",
  );
});

test("represents conflicts and unborn repositories and rejects invalid-byte filenames", async (context) => {
  const fixture = await startDaemon(context);
  const conflict = join(fixture.cwd, "conflict");
  await mkdir(conflict);
  await execute("git", ["init", "--quiet"], { cwd: conflict });
  await execute("git", ["config", "user.name", "Axl Test"], { cwd: conflict });
  await execute("git", ["config", "user.email", "axl@example.invalid"], { cwd: conflict });
  await writeFile(join(conflict, "file.txt"), "base\n");
  await execute("git", ["add", "."], { cwd: conflict });
  await execute("git", ["commit", "--quiet", "-m", "base"], { cwd: conflict });
  const main = (
    await execute("git", ["branch", "--show-current"], { cwd: conflict })
  ).stdout.trim();
  await execute("git", ["checkout", "-q", "-b", "other"], { cwd: conflict });
  await writeFile(join(conflict, "file.txt"), "other\n");
  await execute("git", ["commit", "-qam", "other"], { cwd: conflict });
  await execute("git", ["checkout", "-q", main], { cwd: conflict });
  await writeFile(join(conflict, "file.txt"), "main\n");
  await execute("git", ["commit", "-qam", "main"], { cwd: conflict });
  await execute("git", ["merge", "other"], { cwd: conflict }).catch(() => undefined);

  const client = await connectUnixClient(fixture.socketPath);
  context.after(() => client.close());
  const conflictedSession = await client.request("session.create", { cwd: conflict });
  const conflicted = await client.request("session.workspace.status", {
    sessionId: conflictedSession.sessionId,
    scope: "working",
  });
  assert.equal(
    conflicted.entries.some((entry) => entry.area === "conflict" && entry.kind === "conflicted"),
    true,
  );

  const unborn = join(fixture.cwd, "unborn");
  await mkdir(unborn);
  await execute("git", ["init", "--quiet"], { cwd: unborn });
  await writeFile(join(unborn, "new.txt"), "new\n");
  const unbornSession = await client.request("session.create", { cwd: unborn });
  const unbornStatus = await client.request("session.workspace.status", {
    sessionId: unbornSession.sessionId,
    scope: "working",
  });
  assert.equal(unbornStatus.branch.state, "unborn");
  assert.equal(unbornStatus.entries[0]?.kind, "untracked");

  if (process.platform !== "win32") {
    const invalidPath = Buffer.concat([Buffer.from(`${unborn}/invalid-`), Buffer.from([0xff])]);
    let invalidNameSupported = true;
    try {
      await writeFile(invalidPath, "bad\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EILSEQ") invalidNameSupported = false;
      else throw error;
    }
    if (invalidNameSupported) {
      await assert.rejects(
        client.request("session.workspace.status", {
          sessionId: unbornSession.sessionId,
          scope: "working",
        }),
        (error) =>
          error instanceof AxlClientError && error.code === "unsupported_filename_encoding",
      );
    }
  }
});

test("serves generation-checked working and last-turn workspace status and diffs", async (context) => {
  const fixture = await startDaemon(context);
  const workspace = join(fixture.cwd, "workspace");
  await mkdir(workspace);
  await execute("git", ["init", "--quiet"], { cwd: workspace });
  await execute("git", ["config", "user.name", "Axl Test"], { cwd: workspace });
  await execute("git", ["config", "user.email", "axl@example.invalid"], { cwd: workspace });
  const textconvMarker = join(fixture.cwd, "textconv-ran");
  const textconvHelper = join(fixture.cwd, "textconv.cjs");
  await writeFile(
    textconvHelper,
    `require("node:fs").writeFileSync(${JSON.stringify(textconvMarker)}, "ran");\n`,
  );
  const textconvCommand = `"${process.execPath.replaceAll("\\", "/")}" "${textconvHelper.replaceAll("\\", "/")}"`;
  await execute("git", ["config", "diff.axl.textconv", textconvCommand], { cwd: workspace });
  await writeFile(join(workspace, ".gitattributes"), "tracked.txt diff=axl\n");
  await writeFile(join(workspace, "tracked.txt"), "before\n");
  await execute("git", ["add", ".gitattributes", "tracked.txt"], { cwd: workspace });
  await execute("git", ["commit", "--quiet", "-m", "fixture"], { cwd: workspace });
  const filterMarker = join(fixture.cwd, "filter-ran");
  const hostileFilter = `${process.execPath} -e 'require("node:fs").writeFileSync(${JSON.stringify(filterMarker)},"ran")'`;
  await execute("git", ["config", "filter.axlfilter.clean", hostileFilter], { cwd: workspace });
  await execute("git", ["config", "filter.axlfilter.smudge", hostileFilter], { cwd: workspace });
  await writeFile(join(workspace, ".gitattributes"), "tracked.txt diff=axl filter=axlfilter\n");

  const client = await connectUnixClient(fixture.socketPath);
  context.after(() => client.close());
  const created = await client.request("session.create", { cwd: workspace });
  await assert.rejects(
    client.request("session.workspace.status", {
      sessionId: created.sessionId,
      scope: "last-turn",
    }),
    (error) => error instanceof AxlClientError && error.code === "checkpoint_unavailable",
  );
  const checkpoint = await client.request("session.workspace.checkpoint", {
    sessionId: created.sessionId,
    enabled: true,
  });
  assert.ok(checkpoint.checkpointId);
  await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "checkpoint" }],
  });
  await writeFile(join(workspace, "tracked.txt"), "after\n");
  await writeFile(join(workspace, "new.txt"), "new\n");

  const lastTurn = await client.request("session.workspace.status", {
    sessionId: created.sessionId,
    scope: "last-turn",
  });
  assert.deepEqual(
    lastTurn.entries.map((entry) => [entry.path, entry.area, entry.kind]),
    [
      ["new.txt", "last-turn", "added"],
      ["tracked.txt", "last-turn", "modified"],
    ],
  );
  const trackedEntry = lastTurn.entries.find((entry) => entry.path === "tracked.txt");
  assert.ok(trackedEntry);
  const trackedDiff = await client.request("session.workspace.diff", {
    sessionId: created.sessionId,
    entryId: trackedEntry.entryId,
    contextLines: 3,
    repositoryGeneration: lastTurn.repositoryGeneration,
    maxBytes: 65_536,
  });
  assert.equal(
    trackedDiff.hunks[0]?.lines.some((line) => line.text === "after"),
    true,
  );

  const previousGitDirectory = process.env.GIT_DIR;
  process.env.GIT_DIR = join(workspace, "attacker-controlled-git-directory");
  let working: WorkspaceStatusResult;
  try {
    working = await client.request("session.workspace.status", {
      sessionId: created.sessionId,
      scope: "working",
    });
  } finally {
    if (previousGitDirectory === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDirectory;
  }
  assert.deepEqual(
    working.entries.map((entry) => entry.path),
    [".gitattributes", "new.txt", "tracked.txt"],
  );
  await assert.rejects(readFile(textconvMarker), { code: "ENOENT" });
  await assert.rejects(readFile(filterMarker), { code: "ENOENT" });
  await writeFile(join(workspace, "later.txt"), "changed generation\n");
  await assert.rejects(
    client.request("session.workspace.diff", {
      sessionId: created.sessionId,
      entryId: working.entries[0]?.entryId ?? "missing",
      contextLines: 3,
      repositoryGeneration: working.repositoryGeneration,
      maxBytes: 65_536,
    }),
    (error) => error instanceof AxlClientError && error.code === "repository_changed",
  );

  const oversized = join(workspace, "too-large.bin");
  await writeFile(oversized, "");
  await truncate(oversized, 256 * 1024 * 1024 + 1);
  await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "bounded checkpoint" }],
  });
  await assert.rejects(
    client.request("session.workspace.status", {
      sessionId: created.sessionId,
      scope: "last-turn",
    }),
    (error) => error instanceof AxlClientError && error.code === "checkpoint_too_large",
  );
});

test("lists, forks, clones, and resumes sessions", async (context) => {
  const first = await startDaemon(context);
  const client = await connectUnixClient(first.socketPath);
  const created = await client.request("session.create", { cwd: first.cwd });
  await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "first prompt" }],
  });
  await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "second prompt" }],
  });

  const listed = await client.request("session.list", {
    scope: "all_local",
    order: "recent",
    pageSize: 50,
  });
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0]?.cwd, first.cwd);
  assert.equal(listed.sessions[0]?.userMessageCount, 2);
  assert.equal(listed.sessions[0]?.firstUserMessage, "first prompt");
  assert.equal(listed.sessions[0]?.lastUserMessage, "second prompt");
  assert.deepEqual(listed.sessions[0]?.runtime, { state: "idle" });
  assert.equal(listed.sessions[0]?.attachmentCount, 0);

  await client.request("session.resume", {
    sessionId: created.sessionId,
  });
  const { events: sourceEvents } = await subscribeAll(client, created.sessionId);
  const secondMessage = sourceEvents.filter((event) => event.type === "user.message")[1];
  assert.ok(secondMessage);
  const forked = (await client.request("session.fork", {
    sessionId: created.sessionId,
    fromEventId: secondMessage.id,
  })) as SessionForkResult;
  assert.equal(forked.selectedText, "second prompt");
  const { events: forkedEvents } = await subscribeAll(client, forked.sessionId);
  assert.equal(forkedEvents[0]?.type, "session.created");
  assert.equal(
    forkedEvents[0]?.type === "session.created" && forkedEvents[0].payload.parentSessionId,
    created.sessionId,
  );
  assert.deepEqual(
    forkedEvents
      .filter((event) => event.type === "user.message")
      .map((event) => {
        const content = event.type === "user.message" ? event.payload.content[0] : undefined;
        return content?.type === "text" ? content.text : undefined;
      }),
    ["first prompt"],
  );

  const cloned = (await client.request("session.clone", {
    sessionId: created.sessionId,
  })) as SessionForkResult;
  const { events: clonedEvents } = await subscribeAll(client, cloned.sessionId);
  assert.deepEqual(
    clonedEvents
      .filter((event) => event.type === "user.message")
      .map((event) => {
        const content = event.type === "user.message" ? event.payload.content[0] : undefined;
        return content?.type === "text" ? content.text : undefined;
      }),
    ["first prompt", "second prompt"],
  );

  const firstPage = await client.request("session.list", {
    scope: "current_workspace",
    cwd: first.cwd,
    query: "first prompt",
    order: "threaded",
    pageSize: 1,
  });
  assert.equal(firstPage.sessions.length, 1);
  assert.ok(firstPage.nextPageCursor);
  const secondPage = await client.request("session.list", {
    scope: "current_workspace",
    cwd: first.cwd,
    query: "first prompt",
    order: "threaded",
    pageSize: 1,
    pageCursor: firstPage.nextPageCursor,
  });
  assert.equal(secondPage.sessions.length, 1);
  assert.notEqual(secondPage.sessions[0]?.sessionId, firstPage.sessions[0]?.sessionId);
  await assert.rejects(
    client.request("session.list", {
      scope: "all_local",
      order: "recent",
      pageSize: 1,
      pageCursor: firstPage.nextPageCursor,
    }),
    (error) => error instanceof AxlClientError && error.code === "unknown_cursor",
  );

  client.close();
  await first.daemon.stop();
  const daemon = new AxlDaemon({
    socketPath: first.socketPath,
    dataDirectory: first.dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const resumedClient = await connectUnixClient(first.socketPath);
  context.after(() => resumedClient.close());
  await resumedClient.request("session.resume", {
    sessionId: forked.sessionId,
  });
  await resumedClient.request("session.resume", {
    sessionId: cloned.sessionId,
  });
  const resumedFork = await subscribeAll(resumedClient, forked.sessionId);
  const resumedClone = await subscribeAll(resumedClient, cloned.sessionId);
  assert.equal(resumedFork.events[0]?.type, "session.created");
  assert.equal(resumedClone.events[0]?.type, "session.created");
});

test("pages and filters daemon-owned session summaries", async (context) => {
  const fixture = await startDaemon(context);
  const client = await connectUnixClient(fixture.socketPath);
  context.after(() => client.close());
  const canonicalCwd = await realpath(fixture.cwd);
  const first = await client.request("session.create", { cwd: fixture.cwd });
  await client.request("session.send", {
    sessionId: first.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "searchable root" }],
  });
  const second = await client.request("session.clone", { sessionId: first.sessionId });
  const firstPage = await client.request("session.list", {
    scope: "current_workspace",
    cwd: fixture.cwd,
    query: "searchable root",
    order: "threaded",
    pageSize: 1,
  });
  assert.equal(firstPage.sessions.length, 1);
  assert.equal(firstPage.sessions[0]?.cwd, canonicalCwd);
  assert.deepEqual(firstPage.sessions[0]?.runtime, { state: "idle" });
  assert.ok(firstPage.nextPageCursor);
  const secondPage = await client.request("session.list", {
    scope: "current_workspace",
    cwd: fixture.cwd,
    query: "searchable root",
    order: "threaded",
    pageSize: 1,
    pageCursor: firstPage.nextPageCursor,
  });
  assert.equal(secondPage.sessions.length, 1);
  assert.deepEqual(
    new Set([firstPage.sessions[0]?.sessionId, secondPage.sessions[0]?.sessionId]),
    new Set([first.sessionId, second.sessionId]),
  );
  await assert.rejects(
    client.request("session.list", {
      scope: "all_local",
      order: "recent",
      pageSize: 1,
      pageCursor: firstPage.nextPageCursor,
    }),
    (error) => error instanceof AxlClientError && error.code === "unknown_cursor",
  );
});

test("interrupt aborts the active operation from another connection", async (context) => {
  const { socketPath, cwd } = await startDaemon(context, hangingPort());
  const sender = await connectUnixClient(socketPath);
  const interrupter = await connectUnixClient(socketPath);
  context.after(() => {
    sender.close();
    interrupter.close();
  });

  const created = await sender.request("session.create", { cwd });
  const sending = sender.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "hang" }],
  });

  // Wait until the operation is active, then interrupt from the other client.
  for (;;) {
    const { interrupted } = (await interrupter.request("session.interrupt", {
      sessionId: created.sessionId,
    })) as { interrupted: boolean };
    if (interrupted) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  const result = (await sending) as { stopReason: string };
  assert.equal(result.stopReason, "aborted");

  const idle = (await interrupter.request("session.interrupt", {
    sessionId: created.sessionId,
  })) as { interrupted: boolean };
  assert.equal(idle.interrupted, false);
});

test("restart recovery preserves exact interrupt results", async (context) => {
  const fixture = await startDaemon(context, hangingPort());
  const client = await connectUnixClient(fixture.socketPath);
  const created = await client.request("session.create", { cwd: fixture.cwd });
  const sendKey = "00000000-0000-4000-8000-000000000122";
  const interruptKey = "00000000-0000-4000-8000-000000000123";
  const sending = client.request(
    "session.send",
    {
      sessionId: created.sessionId,
      delivery: "prompt",
      content: [{ type: "text", text: "interrupt once" }],
    },
    { idempotencyKey: sendKey },
  );
  for (
    let attempt = 0;
    fixture.daemon.sessions.activeOperationId(created.sessionId) === undefined && attempt < 100;
    attempt += 1
  ) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  const interrupted = await client.request(
    "session.interrupt",
    { sessionId: created.sessionId },
    { idempotencyKey: interruptKey },
  );
  assert.deepEqual(interrupted, { interrupted: true, operationId: sendKey });
  await sending;

  client.close();
  await fixture.daemon.stop();
  await removeCommandCompletions(fixture.dataDirectory, new Set([interruptKey]));
  const restarted = new AxlDaemon({
    socketPath: fixture.socketPath,
    dataDirectory: fixture.dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await restarted.start();
  const recoveredClient = await connectUnixClient(fixture.socketPath);
  assert.deepEqual(
    await recoveredClient.request(
      "session.interrupt",
      { sessionId: created.sessionId },
      { idempotencyKey: interruptKey },
    ),
    interrupted,
  );
  await recoveredClient.request("session.resume", { sessionId: created.sessionId });

  const idleKey = "00000000-0000-4000-8000-000000000124";
  const idle = await recoveredClient.request(
    "session.interrupt",
    { sessionId: created.sessionId },
    { idempotencyKey: idleKey },
  );
  assert.deepEqual(idle, { interrupted: false });
  recoveredClient.close();
  await restarted.stop();
  await removeCommandCompletions(fixture.dataDirectory, new Set([idleKey]));
  const restartedAgain = new AxlDaemon({
    socketPath: fixture.socketPath,
    dataDirectory: fixture.dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await restartedAgain.start();
  context.after(() => restartedAgain.stop());
  const finalClient = await connectUnixClient(fixture.socketPath);
  context.after(() => finalClient.close());
  assert.deepEqual(
    await finalClient.request(
      "session.interrupt",
      { sessionId: created.sessionId },
      { idempotencyKey: idleKey },
    ),
    idle,
  );
  await finalClient.request("session.resume", { sessionId: created.sessionId });

  const completedSend = await finalClient.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "already complete" }],
  });
  assert.deepEqual(
    await restartedAgain.sessions.reconcileAcceptedMutation({
      method: "session.interrupt",
      operationId: "00000000-0000-4000-8000-000000000125",
      targetSessionId: created.sessionId,
      affectedOperationId: completedSend.operationId,
    }),
    { interrupted: false },
  );
});

test("direct shell recovery returns canonical results without repeating effects", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = {
    socketPath: join(directory, "axl.sock"),
    dataDirectory: join(directory, "data"),
    cwd: directory,
  };
  let executions = 0;
  const runtime = () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "shell",
      description: "Record one test shell effect",
      inputSchema: { type: "object" },
      async execute() {
        executions += 1;
        return { content: [{ type: "text" as const, text: "effect" }], isError: false };
      },
    });
    return { model: replyPort(), tools };
  };
  const daemon = new AxlDaemon({ ...fixture, runtime });
  await daemon.start();
  const client = await connectUnixClient(fixture.socketPath);
  const created = await client.request("session.create", { cwd: fixture.cwd });
  const operationId = parseOperationId("00000000-0000-4000-8000-000000000126");
  const command = "record effect";
  const result = await client.request("session.shell", {
    sessionId: created.sessionId,
    operationId,
    command,
    excluded: false,
  });
  assert.deepEqual(
    await client.request("session.shell", {
      sessionId: created.sessionId,
      operationId,
      command,
      excluded: false,
    }),
    result,
  );
  assert.equal(executions, 1);

  client.close();
  await daemon.stop();
  const restarted = new AxlDaemon({
    socketPath: fixture.socketPath,
    dataDirectory: fixture.dataDirectory,
    runtime,
  });
  await restarted.start();
  context.after(() => restarted.stop());
  const recoveredClient = await connectUnixClient(fixture.socketPath);
  context.after(() => recoveredClient.close());
  await recoveredClient.request("session.resume", { sessionId: created.sessionId });
  assert.deepEqual(
    await recoveredClient.request("session.shell", {
      sessionId: created.sessionId,
      operationId,
      command,
      excluded: false,
    }),
    result,
  );
  assert.equal(executions, 1);
  await assert.rejects(
    recoveredClient.request("session.shell", {
      sessionId: created.sessionId,
      operationId,
      command: "printf 'different effect\\n'",
      excluded: false,
    }),
    (error) => error instanceof AxlClientError && error.code === "idempotency_conflict",
  );
});

test("concurrent sends conflict loudly instead of interleaving", async (context) => {
  const { socketPath, cwd } = await startDaemon(context, hangingPort());
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());

  const created = await client.request("session.create", { cwd });
  const first = client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "one" }],
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  const conflictKey = "00000000-0000-4000-8000-000000000120";
  const conflictingRequest = () =>
    client.request(
      "session.send",
      {
        sessionId: created.sessionId,
        delivery: "prompt",
        content: [{ type: "text", text: "two" }],
      },
      { idempotencyKey: conflictKey },
    );
  await assert.rejects(
    conflictingRequest(),
    (error) => error instanceof AxlClientError && error.code === "operation_active",
  );
  await client.request("session.interrupt", { sessionId: created.sessionId });
  await first;
  await assert.rejects(
    conflictingRequest(),
    (error) =>
      error instanceof AxlClientError &&
      error.code === "operation_active" &&
      error.retryable === false,
  );
  const snapshot = await subscribeAll(client, created.sessionId);
  assert.equal(snapshot.events.filter((event) => event.type === "user.message").length, 1);
});

test("daemon-owned queued prompts are canonical and execute in priority order", async (context) => {
  const paused = pausedActivityPort();
  const { socketPath, cwd } = await startDaemon(context, paused.port);
  const client = await connectUnixClient(socketPath);
  const observer = await connectUnixClient(socketPath, {
    identity: { kind: "headless", version: "0.0.0", instanceId: randomUUID() },
  });
  context.after(() => {
    client.close();
    observer.close();
  });
  const created = await client.request("session.create", { cwd });
  const subscription = await subscribeSession(client, created.sessionId);
  const observedSubscription = await subscribeSession(observer, created.sessionId);
  context.after(() => Promise.all([subscription.close(), observedSubscription.close()]));

  const active = client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "first" }],
  });
  await waitFor(() => subscription.projector.state.activeOperationId !== undefined, "active turn");
  const queueKey = "00000000-0000-4000-8000-000000000130";
  const queueRequest = {
    sessionId: created.sessionId,
    content: [{ type: "text" as const, text: "second" }],
    priority: "back" as const,
  };
  const queued = await client.request("session.queue.enqueue", queueRequest, {
    idempotencyKey: queueKey,
  });
  assert.deepEqual(
    await client.request("session.queue.enqueue", queueRequest, { idempotencyKey: queueKey }),
    queued,
  );
  await waitFor(
    () =>
      subscription.projector.state.queue.some((item) => item.queueItemId === queued.queueItemId),
    "canonical queued prompt",
  );
  await waitFor(
    () =>
      observedSubscription.projector.state.queue.some(
        (item) => item.queueItemId === queued.queueItemId,
      ),
    "shared canonical queue",
  );
  assert.deepEqual(subscription.projector.state.queue, observedSubscription.projector.state.queue);
  assert.equal(
    subscription.projector.state.queue.find((item) => item.queueItemId === queued.queueItemId)
      ?.status,
    "queued",
  );

  paused.finish();
  await active;
  await waitFor(
    () =>
      subscription.projector.state.queue.find((item) => item.queueItemId === queued.queueItemId)
        ?.status === "completed",
    "queued prompt completion",
  );
  assert.equal(
    subscription.projector.state.records.filter((record) => record.event.type === "user.message")
      .length,
    2,
  );
});

test("queued prompts become paused after restart and require explicit re-queueing", async (context) => {
  const paused = pausedActivityPort();
  const fixture = await startDaemon(context, paused.port);
  const client = await connectUnixClient(fixture.socketPath);
  const created = await client.request("session.create", { cwd: fixture.cwd });
  const active = client
    .request("session.send", {
      sessionId: created.sessionId,
      delivery: "prompt",
      content: [{ type: "text", text: "active" }],
    })
    .catch(() => undefined);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  const queued = await client.request("session.queue.enqueue", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "survive restart" }],
    priority: "back",
  });

  const stopping = fixture.daemon.stop();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  paused.finish();
  await Promise.allSettled([active, stopping]);
  client.close();

  const restarted = new AxlDaemon({
    socketPath: fixture.socketPath,
    dataDirectory: fixture.dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry(), system: "You are Axl." }),
  });
  await restarted.start();
  context.after(() => restarted.stop());
  const recovered = await connectUnixClient(fixture.socketPath);
  context.after(() => recovered.close());
  await recovered.request("session.resume", { sessionId: created.sessionId });
  const subscription = await subscribeSession(recovered, created.sessionId);
  context.after(() => subscription.close());
  const pausedItem = subscription.projector.state.queue.find(
    (item) => item.queueItemId === queued.queueItemId,
  );
  assert.equal(pausedItem?.status, "paused");

  await recovered.request("session.queue.requeue", {
    sessionId: created.sessionId,
    queueItemId: queued.queueItemId,
    priority: "back",
  });
  await waitFor(
    () =>
      subscription.projector.state.queue.find((item) => item.queueItemId === queued.queueItemId)
        ?.status === "completed",
    "re-queued prompt completion",
  );
});

test("subscribe supports opaque acknowledged cursors and multiple attachments", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  const one = await connectUnixClient(socketPath);
  const two = await connectUnixClient(socketPath);
  context.after(() => {
    one.close();
    two.close();
  });

  const created = await one.request("session.create", { cwd });
  await one.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "first" }],
  });

  const oneDeliveries: WireEvent[] = [];
  one.onEvent((event) => oneDeliveries.push(event));
  await subscribeAll(one, created.sessionId);
  await one.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "cursor source" }],
  });
  const cursor = oneDeliveries.at(-1)?.cursor;
  assert.ok(cursor);
  await assert.rejects(
    two.request("session.subscribe", { sessionId: created.sessionId, after: cursor }),
    (error) => error instanceof AxlClientError && error.code === "snapshot_required",
  );
  await one.request("session.ack", {
    subscriptionId: oneDeliveries.at(-1)?.subscriptionId ?? "missing",
    cursor,
  });
  const resumed = await subscribeAll(two, created.sessionId, cursor);
  assert.equal(resumed.subscription.resumedFrom, cursor);
  assert.deepEqual(resumed.events, []);

  const oneEvents: string[] = [];
  const twoEvents: string[] = [];
  one.onEvent((event) => oneEvents.push(event.event.type));
  two.onEvent((event) => twoEvents.push(event.event.type));
  await one.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "second" }],
  });
  for (let attempt = 0; twoEvents.length < 2 && attempt < 100; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.deepEqual(oneEvents, ["user.message", "assistant.message"]);
  assert.deepEqual(twoEvents, ["user.message", "assistant.message"]);

  assert.deepEqual(
    await two.request("session.unsubscribe", {
      subscriptionId: resumed.subscription.subscriptionId,
    }),
    { unsubscribed: true },
  );
  await assert.rejects(
    two.request("session.unsubscribe", {
      subscriptionId: resumed.subscription.subscriptionId,
    }),
    (error) => error instanceof AxlClientError && error.code === "unknown_subscription",
  );

  await assert.rejects(
    two.request("session.subscribe", {
      sessionId: created.sessionId,
      after: "unknown-cursor",
    }),
    (error) => error instanceof AxlClientError && error.code === "snapshot_required",
  );
});

test("SDK automatically recovers a canonical sequence gap from the daemon", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  let dropNextEvent = false;
  const client = await connectFaultClient(socketPath, {
    incoming(message) {
      if (
        dropNextEvent &&
        typeof message === "object" &&
        message !== null &&
        (message as { kind?: string }).kind === "event"
      ) {
        dropNextEvent = false;
        return undefined;
      }
      return message;
    },
  });
  context.after(() => client.close());
  const created = await client.request("session.create", { cwd });
  const recoveries: Error[] = [];
  const subscription = await subscribeSession(client, created.sessionId, {
    onResyncRequired: (error) => recoveries.push(error),
  });
  context.after(() => subscription.close());

  dropNextEvent = true;
  await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "recover the canonical gap" }],
  });
  await waitFor(
    () =>
      subscription.projector.state.records.some(
        (record) => record.event.type === "assistant.message",
      ),
    "canonical gap recovery",
  );

  assert.match(recoveries[0]?.message ?? "", /out of order/);
  assert.deepEqual(
    subscription.projector.state.records.map((record) => record.event.type),
    ["session.created", "user.message", "assistant.message"],
  );
});

test("SDK automatically replaces gapped activity from the daemon snapshot", async (context) => {
  const paused = pausedActivityPort();
  const { socketPath, cwd } = await startDaemon(context, paused.port);
  let dropNextActivity = false;
  const observedActivity: Array<{ readonly sequence?: number; readonly type?: string }> = [];
  const client = await connectFaultClient(socketPath, {
    incoming(message) {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { kind?: string }).kind === "activity"
      ) {
        const frame = (message as { frame: { sequence?: number; type?: string } }).frame;
        observedActivity.push(frame);
        if (dropNextActivity) {
          dropNextActivity = false;
          return undefined;
        }
      }
      return message;
    },
  });
  context.after(() => client.close());
  const created = await client.request("session.create", { cwd });
  const recoveries: Error[] = [];
  const subscription = await subscribeSession(client, created.sessionId, {
    onResyncRequired: (error) => recoveries.push(error),
  });
  context.after(() => subscription.close());

  dropNextActivity = true;
  const send = client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "recover activity" }],
  });
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (subscription.projector.state.activity?.text === "first second") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    assert.equal(
      subscription.projector.state.activity?.text,
      "first second",
      JSON.stringify({
        observedActivity,
        recoveries: recoveries.map((error) => error.message),
        state: subscription.projector.state.activity,
      }),
    );
    assert.match(recoveries[0]?.message ?? "", /sequence/);
  } finally {
    paused.finish();
    await send;
  }
  await waitFor(
    () => subscription.projector.state.activity === undefined,
    "canonical activity completion",
  );
});

test("SDK replaces an expired reconnect cursor with an authoritative snapshot", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  let expireNextResume = false;
  let resumedRequests = 0;
  let freshRequests = 0;
  const client = await connectFaultClient(socketPath, {
    outgoing(message) {
      const parsed = JSON.parse(message) as {
        method?: string;
        params?: { sessionId?: string; after?: string };
      };
      if (parsed.method !== "session.subscribe") return message;
      if (parsed.params?.after === undefined) {
        freshRequests += 1;
        return message;
      }
      resumedRequests += 1;
      if (!expireNextResume) return message;
      expireNextResume = false;
      return `${JSON.stringify({
        ...parsed,
        params: { ...parsed.params, after: "expired-cursor" },
      })}\n`;
    },
  });
  context.after(() => client.close());
  const created = await client.request("session.create", { cwd });
  const subscription = await subscribeSession(client, created.sessionId);
  context.after(() => subscription.close());
  await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "authoritative replacement" }],
  });
  await waitFor(() => subscription.projector.state.records.length === 3, "initial live delivery");
  const expected = subscription.projector.state;

  expireNextResume = true;
  await client.reconnect();

  assert.equal(resumedRequests, 1);
  assert.equal(freshRequests, 2);
  assert.deepEqual(subscription.projector.state, expected);
});

test("SDK preserves the selected node while rebinding to another attachment", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  const creator = await connectUnixClient(socketPath);
  const first = await connectUnixClient(socketPath);
  const replacement = await connectUnixClient(socketPath);
  context.after(() => {
    creator.close();
    first.close();
    replacement.close();
  });
  const created = await creator.request("session.create", { cwd });
  await creator.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "selected branch" }],
  });
  const authoritative = await subscribeAll(creator, created.sessionId);
  const selectedNodeId = authoritative.events.at(-1)?.id;
  assert.ok(selectedNodeId);

  const subscription = await subscribeSession(first, created.sessionId, {
    fromNodeId: selectedNodeId,
  });
  context.after(() => subscription.close());
  const expected = subscription.projector.state;
  await subscription.reconnect(replacement);

  assert.equal(subscription.projector.state.selectedNodeId, selectedNodeId);
  assert.deepEqual(subscription.projector.state, expected);
});

test("TUI-style and SDK attachments observe identical canonical state", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  const tui = await connectUnixClient(socketPath, {
    identity: { kind: "tui", version: "0.0.0", instanceId: randomUUID() },
  });
  const sdk = await connectUnixClient(socketPath, {
    identity: { kind: "headless", version: "0.0.0", instanceId: randomUUID() },
  });
  context.after(() => {
    tui.close();
    sdk.close();
  });
  const created = await tui.request("session.create", { cwd });
  const tuiSubscription = await subscribeSession(tui, created.sessionId);
  const sdkSubscription = await subscribeSession(sdk, created.sessionId);
  context.after(() => Promise.all([tuiSubscription.close(), sdkSubscription.close()]));

  await tui.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "same canonical view" }],
  });
  await waitFor(
    () =>
      tuiSubscription.projector.state.records.length === 3 &&
      sdkSubscription.projector.state.records.length === 3,
    "both attachment projections",
  );

  assert.deepEqual(tuiSubscription.projector.state, sdkSubscription.projector.state);
});

test("dispose removes the session and errors surface typed codes", async (context) => {
  const fixture = await startDaemon(context);
  const { socketPath, cwd, dataDirectory } = fixture;
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());

  const created = await client.request("session.create", { cwd });
  const disposeKey = "00000000-0000-4000-8000-000000000103";
  const disposed = await client.request(
    "session.dispose",
    { sessionId: created.sessionId },
    { idempotencyKey: disposeKey },
  );
  const persisted = (
    await readFile(join(dataDirectory, "sessions", `${created.sessionId}.jsonl`), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CanonicalEvent);
  assert.equal(persisted.at(-1)?.type, "session.closed");
  assert.equal(persisted.at(-1)?.operationId, disposeKey);

  client.close();
  await fixture.daemon.stop();
  await removeCommandCompletions(dataDirectory, new Set([disposeKey]));
  const restarted = new AxlDaemon({
    socketPath,
    dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await restarted.start();
  context.after(() => restarted.stop());
  const recoveredClient = await connectUnixClient(socketPath);
  context.after(() => recoveredClient.close());
  assert.deepEqual(
    await recoveredClient.request(
      "session.dispose",
      { sessionId: created.sessionId },
      { idempotencyKey: disposeKey },
    ),
    disposed,
  );
  const recoveredEvents = (
    await readFile(join(dataDirectory, "sessions", `${created.sessionId}.jsonl`), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CanonicalEvent);
  assert.equal(
    recoveredEvents.filter(
      (event) => event.type === "session.closed" && event.operationId === disposeKey,
    ).length,
    1,
  );
  await assert.rejects(
    recoveredClient.request("session.send", {
      sessionId: created.sessionId,
      content: [],
      delivery: "prompt",
    }),
    (error) => error instanceof AxlClientError && error.code === "unknown_session",
  );

  await assert.rejects(
    recoveredClient.request("session.resume", {
      sessionId: parseSessionId("123e4567-e89b-42d3-a456-42661417ffff"),
    }),
    (error) => error instanceof AxlClientError && error.code === "unknown_session",
  );

  await assert.rejects(
    (
      recoveredClient.request as unknown as (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>
    )("bogus.method", {}),
    (error) => error instanceof AxlClientError && error.code === "bad_request",
  );
});

test("refuses to unlink a live daemon socket or a regular file", async (context) => {
  const first = await startDaemon(context);
  const competing = new AxlDaemon({
    socketPath: first.socketPath,
    dataDirectory: first.dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await assert.rejects(competing.start(), /already listening/);

  const regularPath = join(first.cwd, "not-a-socket");
  await writeFile(regularPath, "keep me");
  const regular = new AxlDaemon({
    socketPath: regularPath,
    dataDirectory: first.dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await assert.rejects(regular.start(), /Refusing to remove non-socket/);
});

test("routes runtime interaction requests to an attached client", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  let call = 0;
  const model: ModelPort = {
    stream() {
      call += 1;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (call === 1) {
          yield { type: "tool_call", callId: "approval-1", name: "approve", input: {} };
          yield { type: "completed", stopReason: "tool_use", usage };
        } else {
          yield { type: "text_delta", text: "approved" };
          yield { type: "completed", stopReason: "stop", usage };
        }
      })();
    },
  };
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    runtime: ({ interact }) => {
      const tools = new ToolRegistry();
      tools.register({
        name: "approve",
        description: "Ask for approval",
        inputSchema: { type: "object" },
        async execute(_input, signal) {
          const response = await interact(
            {
              kind: "mcp_tool",
              source: "mcp:test",
              message: "Allow test tool?",
            },
            signal,
          );
          return {
            content: [{ type: "text", text: response.action }],
            isError: response.action !== "accept",
          };
        },
      });
      return { model, tools };
    },
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());
  const created = await client.request("session.create", { cwd: directory });
  const events: CanonicalEvent[] = [];
  client.onEvent((message) => events.push(message.event));
  await subscribeAll(client, created.sessionId);
  const sending = client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "ask" }],
  });

  let interaction: Extract<CanonicalEvent, { type: "interaction.requested" }> | undefined;
  for (let attempt = 0; attempt < 100 && !interaction; attempt += 1) {
    interaction = events.find(
      (event): event is Extract<CanonicalEvent, { type: "interaction.requested" }> =>
        event.type === "interaction.requested",
    );
    if (!interaction) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.ok(interaction);
  const responseKey = "00000000-0000-4000-8000-000000000104";
  const responseParams = {
    sessionId: created.sessionId,
    interactionId: interaction.payload.interactionId,
    action: "accept" as const,
  };
  const responseRequest = client.request("session.interaction.respond", responseParams, {
    idempotencyKey: responseKey,
  });
  const losingKey = "00000000-0000-4000-8000-000000000121";
  const losingRequest = client.request("session.interaction.respond", responseParams, {
    idempotencyKey: losingKey,
  });
  const response = await responseRequest;
  await assert.rejects(losingRequest, (error) => {
    assert.ok(error instanceof AxlClientError);
    assert.equal(error.code, "interaction_already_resolved");
    assert.deepEqual(error.details, { resolutionEventId: response.resolutionEventId });
    return true;
  });
  await sending;
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("interaction.")).map((event) => event.type),
    ["interaction.requested", "interaction.resolved"],
  );
  assert.equal(
    events.find((event) => event.type === "interaction.resolved")?.operationId,
    responseKey,
  );

  await assert.rejects(
    client.request("session.interaction.respond", responseParams, {
      idempotencyKey: losingKey,
    }),
    (error) => {
      assert.ok(error instanceof AxlClientError);
      assert.equal(error.code, "interaction_already_resolved");
      assert.deepEqual(error.details, { resolutionEventId: response.resolutionEventId });
      return true;
    },
  );
  assert.equal(events.filter((event) => event.type === "interaction.resolved").length, 1);

  client.close();
  await daemon.stop();
  await removeCommandCompletions(join(directory, "data"), new Set([responseKey]));
  const restarted = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await restarted.start();
  context.after(() => restarted.stop());
  const recoveredClient = await connectUnixClient(socketPath);
  context.after(() => recoveredClient.close());
  assert.deepEqual(
    await recoveredClient.request("session.interaction.respond", responseParams, {
      idempotencyKey: responseKey,
    }),
    response,
  );
  await assert.rejects(
    recoveredClient.request("session.interaction.respond", responseParams, {
      idempotencyKey: losingKey,
    }),
    (error) =>
      error instanceof AxlClientError &&
      error.code === "interaction_already_resolved" &&
      error.details?.resolutionEventId === response.resolutionEventId,
  );
  await recoveredClient.request("session.resume", { sessionId: created.sessionId });
  const recovered = await subscribeAll(recoveredClient, created.sessionId);
  assert.equal(
    recovered.events.filter(
      (event) => event.type === "interaction.resolved" && event.operationId === responseKey,
    ).length,
    1,
  );
});

test("externalizes oversized schema-supported content before persistence", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const dataDirectory = join(directory, "data");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());
  const created = await client.request("session.create", { cwd: directory });
  const text = "é".repeat(393_100);
  await client.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text }],
  });

  const raw = await readFile(join(dataDirectory, "sessions", `${created.sessionId}.jsonl`), "utf8");
  assert.equal(raw.includes("é"), false);
  for (const line of raw.trimEnd().split("\n")) {
    assert.ok(Buffer.byteLength(line) <= MAX_CANONICAL_EVENT_BYTES);
  }
  const events = raw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as CanonicalEvent);
  const message = events.find((event) => event.type === "user.message");
  assert.equal(message?.type, "user.message");
  if (message?.type !== "user.message") return;
  const content = message.payload.content[0];
  assert.equal(content?.type, "blob");
  if (content?.type !== "blob") return;
  assert.equal(
    (await readFile(join(dataDirectory, "blobs", content.blob.sha256))).toString("utf8"),
    text,
  );
});

test("rejects oversized fields without schema-defined blob semantics", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    runtime: () => ({
      model: replyPort(),
      tools: new ToolRegistry(),
      prompt: {
        text: "oversized",
        sections: [
          {
            name: "unsupported",
            source: "test",
            content: "é".repeat(MAX_CANONICAL_EVENT_BYTES),
          },
        ],
      },
    }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());

  await assert.rejects(client.request("session.create", { cwd: directory }), (error: unknown) => {
    assert.ok(error instanceof AxlClientError);
    assert.equal(error.code, "content_too_large");
    assert.equal(error.details?.field, "canonicalEvent");
    assert.equal(error.details?.maximumBytes, MAX_CANONICAL_EVENT_BYTES);
    return true;
  });
});

test("quarantines oversized legacy events with safe recovery details", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const dataDirectory = join(directory, "data");
  const sessionsDirectory = join(dataDirectory, "sessions");
  const sessionId = parseSessionId("00000000-0000-4000-8000-000000000201");
  const oversizedEventId = "00000000-0000-4000-8000-000000000203";
  const root = {
    version: 1,
    id: "00000000-0000-4000-8000-000000000202",
    sessionId,
    parentId: null,
    timestamp: 1,
    type: "session.created",
    payload: { cwd: directory },
  };
  const oversized = {
    version: 1,
    id: oversizedEventId,
    sessionId,
    parentId: root.id,
    timestamp: 2,
    type: "user.message",
    payload: { content: [{ type: "text", text: "é".repeat(MAX_CANONICAL_EVENT_BYTES) }] },
  };
  await mkdir(sessionsDirectory, { recursive: true });
  const logPath = join(sessionsDirectory, `${sessionId}.jsonl`);
  await writeFile(logPath, `${JSON.stringify(root)}\n${JSON.stringify(oversized)}\n`);
  const original = await readFile(logPath);

  const daemon = new AxlDaemon({
    socketPath: join(directory, "axl.sock"),
    dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const client = await connectUnixClient(join(directory, "axl.sock"));
  context.after(() => client.close());

  await assert.rejects(client.request("session.resume", { sessionId }), (error: unknown) => {
    assert.ok(error instanceof AxlClientError);
    assert.equal(error.code, "event_migration_required");
    assert.deepEqual(error.details, {
      sessionId,
      eventId: oversizedEventId,
      eventType: "user.message",
      encodedBytes: Buffer.byteLength(JSON.stringify(oversized)),
      maximumBytes: MAX_CANONICAL_EVENT_BYTES,
      recoveryCommand: `axl session migrate-events ${sessionId}`,
    });
    return true;
  });
  assert.deepEqual(await readFile(logPath), original);
});

test("ignores incomplete migration targets until their manifest is published", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const dataDirectory = join(directory, "data");
  const sessionsDirectory = join(dataDirectory, "sessions");
  const pendingDirectory = join(dataDirectory, "migrations", "pending");
  const sessionId = parseSessionId("00000000-0000-4000-8000-000000000205");
  const root = {
    version: 1,
    id: "00000000-0000-4000-8000-000000000206",
    sessionId,
    parentId: null,
    timestamp: 1,
    type: "session.created",
    payload: { cwd: directory },
  };
  await mkdir(sessionsDirectory, { recursive: true });
  await mkdir(pendingDirectory, { recursive: true });
  await writeFile(join(sessionsDirectory, `${sessionId}.jsonl`), `${JSON.stringify(root)}\n`);
  await writeFile(
    join(pendingDirectory, `${sessionId}.json`),
    `${JSON.stringify({ version: 1, sourceSessionId: sessionId, targetSessionId: sessionId })}\n`,
  );

  const daemon = new AxlDaemon({
    socketPath: join(directory, "axl.sock"),
    dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const client = await connectUnixClient(join(directory, "axl.sock"));
  context.after(() => client.close());
  assert.deepEqual(
    await client.request("session.list", {
      scope: "all_local",
      order: "recent",
      pageSize: 50,
    }),
    { sessions: [] },
  );
  await assert.rejects(client.request("session.resume", { sessionId }), (error: unknown) => {
    assert.ok(error instanceof AxlClientError);
    assert.equal(error.code, "unknown_session");
    return true;
  });
});

test("configuration changes rebuild and log the selected model and thinking", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const configured: Array<{ boundary: string; model?: string; thinking?: string }> = [];
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    runtime: ({ boundary, selection }) => {
      configured.push({
        boundary,
        ...(selection.modelId === undefined ? {} : { model: selection.modelId }),
        ...(selection.thinkingLevel === undefined ? {} : { thinking: selection.thinkingLevel }),
      });
      return {
        model: replyPort(),
        tools: new ToolRegistry(),
        ...(selection.modelId === undefined ? {} : { configModel: { modelId: selection.modelId } }),
        ...(selection.thinkingLevel === undefined
          ? {}
          : {
              configThinking: {
                requested: selection.thinkingLevel,
                effective: selection.thinkingLevel,
                clamped: false,
              },
            }),
      };
    },
  });
  await daemon.start();
  context.after(() => daemon.stop());

  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());
  const created = await client.request("session.create", {
    cwd: directory,
    modelId: "gpt-5",
    thinkingLevel: "medium",
  });
  const configureKey = "00000000-0000-4000-8000-000000000105";
  const changed = await client.request(
    "session.configure",
    {
      sessionId: created.sessionId,
      modelId: "gpt-4.1",
      thinkingLevel: "high",
    },
    { idempotencyKey: configureKey },
  );

  assert.deepEqual(configured, [
    { boundary: "session_start", model: "gpt-5", thinking: "medium" },
    { boundary: "model_switch", model: "gpt-4.1", thinking: "high" },
  ]);
  assert.equal(changed.modelId, "gpt-4.1");
  assert.equal(changed.requestedThinkingLevel, "high");
  assert.equal(changed.effectiveThinkingLevel, "high");
  assert.equal(changed.profile, "minimal");
  assert.equal(changed.boundaryEventIds.length, 2);

  client.close();
  await daemon.stop();
  await removeCommandCompletions(join(directory, "data"), new Set([configureKey]));
  const restarted = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    runtime: ({ selection }) => ({
      model: replyPort(),
      tools: new ToolRegistry(),
      ...(selection.modelId === undefined ? {} : { configModel: { modelId: selection.modelId } }),
      ...(selection.thinkingLevel === undefined
        ? {}
        : {
            configThinking: {
              requested: selection.thinkingLevel,
              effective: selection.thinkingLevel,
              clamped: false,
            },
          }),
    }),
  });
  await restarted.start();
  context.after(() => restarted.stop());
  const recoveredClient = await connectUnixClient(socketPath);
  context.after(() => recoveredClient.close());
  assert.deepEqual(
    await recoveredClient.request(
      "session.configure",
      {
        sessionId: created.sessionId,
        modelId: "gpt-4.1",
        thinkingLevel: "high",
      },
      { idempotencyKey: configureKey },
    ),
    changed,
  );
  const recovered = await subscribeAll(recoveredClient, created.sessionId);
  assert.deepEqual(
    recovered.events.filter((event) => event.operationId === configureKey).map((event) => event.id),
    changed.boundaryEventIds,
  );
});

test("reload rebuilds the runtime as a logged boundary with live subscriptions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const boundaries: string[] = [];
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    runtime: ({ boundary }) => {
      boundaries.push(boundary);
      return {
        model: replyPort(),
        tools: new ToolRegistry(),
        ...(boundary === "config_change"
          ? {}
          : {
              configDialect: {
                dialectId: "generic" as const,
                rosterFingerprint: "f".repeat(64),
                reason: boundary,
              },
            }),
      };
    },
  });
  await daemon.start();
  context.after(() => daemon.stop());

  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());
  const created = await client.request("session.create", { cwd: directory });
  const pushed: CanonicalEvent[] = [];
  client.onEvent((message) => pushed.push(message.event));
  await subscribeAll(client, created.sessionId);

  const reloadKey = "00000000-0000-4000-8000-000000000106";
  const reloaded = await client.request(
    "session.reload",
    { sessionId: created.sessionId },
    { idempotencyKey: reloadKey },
  );
  assert.deepEqual(boundaries, ["session_start", "reload"]);
  const dialect = pushed.find(
    (event) => event.type === "config.dialect" && reloaded.boundaryEventIds.includes(event.id),
  );
  assert.equal(dialect?.type === "config.dialect" && dialect.payload.reason, "reload");
  assert.equal(
    pushed
      .filter((event) => reloaded.boundaryEventIds.includes(event.id))
      .every((event) => event.operationId === reloadKey),
    true,
  );

  client.close();
  await daemon.stop();
  await removeCommandCompletions(join(directory, "data"), new Set([reloadKey]));
  const restarted = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    runtime: ({ boundary }) => ({
      model: replyPort(),
      tools: new ToolRegistry(),
      ...(boundary === "config_change"
        ? {}
        : {
            configDialect: {
              dialectId: "generic" as const,
              rosterFingerprint: "f".repeat(64),
              reason: boundary,
            },
          }),
    }),
  });
  await restarted.start();
  context.after(() => restarted.stop());
  const recoveredClient = await connectUnixClient(socketPath);
  context.after(() => recoveredClient.close());
  assert.deepEqual(
    await recoveredClient.request(
      "session.reload",
      { sessionId: created.sessionId },
      { idempotencyKey: reloadKey },
    ),
    reloaded,
  );
  const recovered = await subscribeAll(recoveredClient, created.sessionId);
  assert.deepEqual(
    recovered.events.filter((event) => event.operationId === reloadKey).map((event) => event.id),
    reloaded.boundaryEventIds,
  );

  // The session still works after recovery, on the same log.
  const sent = await recoveredClient.request("session.send", {
    sessionId: created.sessionId,
    delivery: "prompt",
    content: [{ type: "text", text: "after reload" }],
  });
  assert.equal(sent.stopReason, "stop");
});
