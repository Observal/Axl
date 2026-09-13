// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  AxlClient,
  AxlClientError,
  type AxlTransport,
  ProviderClientError,
  type AxlTransportFactory,
} from "../src/index.ts";
import {
  type CapabilityId,
  EVENT_FORMAT_VERSION,
  parseEvent,
  parseOperationId,
  parseSessionId,
  WIRE_CAPABILITIES,
  WIRE_PROTOCOL_VERSION,
} from "@axl/protocol";

class FakeTransport implements AxlTransport {
  messages: unknown[] = [];
  messageListener: ((message: unknown) => void) | undefined;
  closeListener: ((cause?: Error) => void) | undefined;
  private readonly capabilities: readonly CapabilityId[];

  constructor(capabilities: readonly CapabilityId[] = WIRE_CAPABILITIES) {
    this.capabilities = capabilities;
  }

  send(message: string): void {
    const request = JSON.parse(message) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
      idempotencyKey?: string;
    };
    this.messages.push(request);
    if (request.method === "connection.initialize") {
      queueMicrotask(() =>
        this.emit({
          kind: "success",
          id: request.id,
          method: request.method,
          result: {
            attachmentId: "attachment-1",
            daemonInstanceId: "daemon-1",
            wireVersion: WIRE_PROTOCOL_VERSION,
            grantedCapabilities: (
              request.params.requestedCapabilities as readonly CapabilityId[]
            ).filter((capability) => this.capabilities.includes(capability)),
            scope: "local_control",
            heartbeatIntervalMs: 60_000,
            presenceTimeoutMs: 120_000,
          },
        }),
      );
    }
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListener = listener;
    queueMicrotask(() =>
      listener({
        kind: "hello",
        wireVersion: WIRE_PROTOCOL_VERSION,
        daemonInstanceId: "daemon-1",
        capabilities: this.capabilities,
        limits: { maxMessageBytes: 1_048_576, maxPendingRequests: 64 },
      }),
    );
    return () => {
      this.messageListener = undefined;
    };
  }

  onClose(listener: (cause?: Error) => void): () => void {
    this.closeListener = listener;
    return () => {
      this.closeListener = undefined;
    };
  }

  close(): void {}

  emit(message: unknown): void {
    this.messageListener?.(message);
  }
}

class Factory implements AxlTransportFactory {
  readonly transports: FakeTransport[] = [];
  private readonly capabilities: readonly (readonly CapabilityId[])[];

  constructor(capabilities: readonly (readonly CapabilityId[])[] = [WIRE_CAPABILITIES]) {
    this.capabilities = capabilities;
  }

  async connect(): Promise<AxlTransport> {
    const transport = new FakeTransport(
      this.capabilities[this.transports.length] ?? this.capabilities.at(-1),
    );
    this.transports.push(transport);
    return transport;
  }
}

async function connect(
  factory = new Factory(),
): Promise<{ client: AxlClient; transport: FakeTransport }> {
  let key = 0;
  const client = await AxlClient.connect({
    transport: factory,
    identity: { kind: "fixture", version: "1", instanceId: "client-1" },
    idempotencyKeys: {
      create: () => `00000000-0000-4000-8000-${(++key).toString().padStart(12, "0")}`,
    },
  });
  const transport = factory.transports.at(-1);
  assert.ok(transport);
  return { client, transport };
}

test("initializes exactly once and creates keys only for retryable mutations", async () => {
  const { client, transport } = await connect();
  const pending = client.request("session.interrupt", {
    sessionId: parseSessionId("123e4567-e89b-42d3-a456-426614174000"),
  });
  const request = transport.messages.at(-1) as {
    id: number;
    method: string;
    idempotencyKey?: string;
  };
  assert.equal(request.method, "session.interrupt");
  assert.match(request.idempotencyKey ?? "", /^[0-9a-f-]{36}$/);
  transport.emit({
    kind: "success",
    id: request.id,
    method: "session.interrupt",
    result: { interrupted: false },
  });
  assert.deepEqual(await pending, { interrupted: false });
  client.close();
});

test("delivers session catalog invalidation notifications", async () => {
  const { client, transport } = await connect();
  const generations: number[] = [];
  const remove = client.onSessionsChanged((delivery) => generations.push(delivery.generation));
  transport.emit({ kind: "sessions_changed", generation: 3 });
  assert.deepEqual(generations, [3]);
  remove();
  transport.emit({ kind: "sessions_changed", generation: 4 });
  assert.deepEqual(generations, [3]);
  client.close();
});

test("reads and validates a session blob across bounded chunks", async () => {
  const { client, transport } = await connect();
  const pending = client.readBlob(parseSessionId("123e4567-e89b-42d3-a456-426614174000"), {
    sha256: "a".repeat(64),
    mediaType: "text/plain",
    sizeBytes: 3,
  });
  const first = transport.messages.at(-1) as {
    id: number;
    method: string;
    params: Record<string, unknown>;
  };
  assert.equal(first.method, "session.blob.read");
  transport.emit({
    kind: "success",
    id: first.id,
    method: first.method,
    result: { data: "aGk=", offset: 0, nextOffset: 2, eof: false },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = transport.messages.at(-1) as {
    id: number;
    method: string;
    params: Record<string, unknown>;
  };
  assert.deepEqual(second.params, {
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    sha256: "a".repeat(64),
    offset: 2,
    length: 1,
  });
  transport.emit({
    kind: "success",
    id: second.id,
    method: second.method,
    result: { data: "IQ==", offset: 2, nextOffset: 3, eof: true },
  });
  assert.equal(new TextDecoder().decode(await pending), "hi!");
  await assert.rejects(
    client.readBlob(parseSessionId("123e4567-e89b-42d3-a456-426614174000"), {
      sha256: "b".repeat(64),
      mediaType: "application/octet-stream",
      sizeBytes: 20 * 1024 * 1024 + 1,
    }),
    (error) => error instanceof AxlClientError && error.code === "invalid_blob_read",
  );
  client.close();
});

test("exposes typed provider methods through negotiated capabilities", async () => {
  const { client, transport } = await connect();
  const pending = client.listProviders({ providerId: "openrouter" });
  const request = transport.messages.at(-1) as {
    id: number;
    method: string;
    params: Record<string, unknown>;
  };
  assert.equal(request.method, "provider.list");
  assert.deepEqual(request.params, { providerId: "openrouter" });
  transport.emit({
    kind: "success",
    id: request.id,
    method: "provider.list",
    result: { providers: [] },
  });
  assert.deepEqual(await pending, { providers: [] });
  client.close();
});

test("does not replay provider actions after reconnect", async () => {
  const factory = new Factory();
  const { client, transport } = await connect(factory);
  const pending = client.refreshProviderCatalogs({ providerId: "openrouter" });
  transport.closeListener?.(new Error("lost response"));
  await assert.rejects(
    pending,
    (error) => error instanceof AxlClientError && error.code === "disconnected",
  );
  assert.equal(factory.transports.length, 1);
  client.close();
});

test("returns provider failures as typed actionable SDK errors", async () => {
  const { client, transport } = await connect();
  const pending = client.providerAuthenticationStatus({ providerId: "openrouter" });
  const request = transport.messages.at(-1) as { id: number };
  transport.emit({
    kind: "error",
    id: request.id,
    method: "provider.auth.status",
    error: {
      code: "authentication_failed",
      message: "Provider authentication failed",
      retryable: false,
      details: { category: "authentication", action: "login", providerId: "openrouter" },
    },
  });
  await assert.rejects(
    pending,
    (error) =>
      error instanceof ProviderClientError &&
      error.code === "authentication_failed" &&
      error.details.providerId === "openrouter" &&
      error.details.action === "login",
  );
  client.close();
});

test("preserves unknown future structured errors without crashing", async () => {
  const { client, transport } = await connect();
  const pending = client.request("daemon.info", {});
  const request = transport.messages.at(-1) as { id: number; method: "daemon.info" };
  transport.emit({
    kind: "error",
    id: request.id,
    method: request.method,
    error: {
      code: "future_policy_failure",
      message: "A future daemon rejected the request",
      retryable: true,
      details: { safe: true },
    },
  });
  await assert.rejects(
    pending,
    (error) =>
      error instanceof AxlClientError &&
      error.code === "future_policy_failure" &&
      error.message === "A future daemon rejected the request" &&
      error.retryable === true &&
      error.details?.safe === true,
  );
  client.close();
});

test("rejects request-correlated errors without the matching method", async () => {
  for (const method of [undefined, "connection.ping"] as const) {
    const { client, transport } = await connect();
    const pending = client.request("daemon.info", {});
    const request = transport.messages.at(-1) as { id: number };
    transport.emit({
      kind: "error",
      id: request.id,
      ...(method === undefined ? {} : { method }),
      error: { code: "bad_request", message: "Invalid request", retryable: false },
    });
    await assert.rejects(
      pending,
      (error) => error instanceof AxlClientError && error.code === "protocol_error",
    );
    assert.equal(client.state, "disconnected");
  }
});

test("rejects known errors outside the pending method's allowed matrix", async () => {
  const { client, transport } = await connect();
  const pending = client.request("daemon.info", {});
  const request = transport.messages.at(-1) as { id: number };
  transport.emit({
    kind: "error",
    id: request.id,
    method: "daemon.info",
    error: {
      code: "invalid_idempotency_key",
      message: "Unexpected idempotency key",
      retryable: false,
    },
  });
  await assert.rejects(
    pending,
    (error) => error instanceof AxlClientError && error.code === "protocol_error",
  );
  assert.equal(client.state, "disconnected");
});

test("fails capability checks before writing a request", async () => {
  const factory = new Factory();
  const client = await AxlClient.connect({
    transport: factory,
    identity: { kind: "fixture", version: "1", instanceId: "client-1" },
    requestedCapabilities: ["session.list"],
    idempotencyKeys: { create: () => "00000000-0000-4000-8000-000000000001" },
  });
  await assert.rejects(
    client.request("session.interrupt", {
      sessionId: parseSessionId("123e4567-e89b-42d3-a456-426614174000"),
    }),
    (error) => error instanceof AxlClientError && error.code === "unsupported_capability",
  );
  client.close();
});

test("retries a mutation after reconnect with the same idempotency key", async () => {
  const factory = new Factory();
  const { client, transport: first } = await connect(factory);
  const result = client.request("session.interrupt", {
    sessionId: parseSessionId("123e4567-e89b-42d3-a456-426614174000"),
  });
  const initial = first.messages.at(-1) as { idempotencyKey: string };
  first.closeListener?.(new Error("lost response"));
  for (let count = 0; factory.transports.length < 2 && count < 20; count += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const replacement = factory.transports[1];
  assert.ok(replacement);
  await new Promise((resolve) => setImmediate(resolve));
  const retry = replacement.messages.find(
    (message) => (message as { method?: string }).method === "session.interrupt",
  ) as { id: number; idempotencyKey: string };
  assert.equal(retry.idempotencyKey, initial.idempotencyKey);
  replacement.emit({
    kind: "success",
    id: retry.id,
    method: "session.interrupt",
    result: { interrupted: false },
  });
  assert.deepEqual(await result, { interrupted: false });
  client.close();
});

test("coalesces reconnects and restores registered views once", async () => {
  const factory = new Factory();
  const { client } = await connect(factory);
  let restorations = 0;
  client.onReconnect(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    restorations += 1;
  });
  await Promise.all([client.reconnect(), client.reconnect()]);
  assert.equal(factory.transports.length, 2);
  assert.equal(restorations, 1);
  client.close();
});

test("fails reconnect explicitly when a previously granted capability disappears", async () => {
  const reducedCapabilities = WIRE_CAPABILITIES.filter(
    (capability) => capability !== "session.subscribe",
  );
  const factory = new Factory([WIRE_CAPABILITIES, reducedCapabilities]);
  const { client } = await connect(factory);

  await assert.rejects(
    client.reconnect(),
    (error) =>
      error instanceof AxlClientError &&
      error.code === "capability_mismatch" &&
      Array.isArray(error.details?.removedCapabilities) &&
      error.details.removedCapabilities.includes("session.subscribe"),
  );
  assert.equal(client.state, "incompatible");
  await assert.rejects(
    client.request("session.list", {
      scope: "all_local",
      order: "recent",
      pageSize: 10,
    }),
    (error) => error instanceof AxlClientError && error.code === "not_initialized",
  );
  client.close();
});

test("exposes typed child-session creation with idempotent delivery", async () => {
  const { client, transport } = await connect();
  const parentSessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
  const result = client.startChild({
    parentSessionId,
    name: "researcher",
    task: "Research tmux",
    authority: "user",
    historyMode: "fresh",
  });
  const request = transport.messages.find(
    (message) => (message as { method?: string }).method === "child.start",
  ) as { id: number; idempotencyKey?: string };
  assert.ok(request.idempotencyKey);
  transport.emit({
    kind: "success",
    id: request.id,
    method: "child.start",
    result: {
      child: {
        sessionId: "123e4567-e89b-42d3-a456-426614174001",
        cwd: "/repo",
        runtime: { state: "running" },
        profile: "standard",
      },
      name: "researcher",
      parentSessionId,
      authority: "user",
      historyMode: "fresh",
    },
  });
  assert.equal((await result).name, "researcher");
  client.close();
});

test("exposes typed child messaging", async () => {
  const { client, transport } = await connect();
  const parentSessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
  const result = client.sendToChild({
    parentSessionId,
    child: "researcher",
    content: [{ type: "text", text: "Also inspect layouts" }],
  });
  const request = transport.messages.find(
    (message) => (message as { method?: string }).method === "child.send",
  ) as { id: number; idempotencyKey?: string };
  assert.ok(request.idempotencyKey);
  transport.emit({
    kind: "success",
    id: request.id,
    method: "child.send",
    result: {
      queued: true,
      childSessionId: "123e4567-e89b-42d3-a456-426614174001",
    },
  });
  assert.equal((await result).queued, true);
  client.close();
});

test("direct shell response loss returns an observed canonical result", async () => {
  const { client, transport } = await connect();
  const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
  const operationId = parseOperationId("00000000-0000-4000-8000-000000000009");
  const result = client.shell({ sessionId, operationId, command: "printf once", excluded: false });
  transport.emit({
    kind: "event",
    subscriptionId: "subscription-1",
    sessionId,
    sequence: 1,
    cursor: "cursor-1",
    event: parseEvent({
      version: EVENT_FORMAT_VERSION,
      id: "00000000-0000-4000-8000-000000000019",
      sessionId,
      parentId: null,
      operationId,
      timestamp: 1,
      type: "user.shell",
      payload: {
        command: "printf once",
        content: [{ type: "text", text: "once" }],
        isError: false,
        excluded: false,
      },
    }),
  });
  transport.closeListener?.(new Error("lost response"));
  assert.deepEqual(await result, {
    state: "completed",
    result: {
      operationId,
      isError: false,
      resultEventId: "00000000-0000-4000-8000-000000000019",
    },
  });
  assert.equal(
    transport.messages.filter(
      (message) => (message as { method?: string }).method === "session.shell",
    ).length,
    1,
  );
});

test("direct shell transport loss is uncertain and never resent", async () => {
  const { client, transport } = await connect();
  const operationId = parseOperationId("00000000-0000-4000-8000-000000000010");
  const result = client.shell({
    sessionId: parseSessionId("123e4567-e89b-42d3-a456-426614174000"),
    operationId,
    command: "printf once",
    excluded: false,
  });
  transport.closeListener?.(new Error("lost"));
  assert.deepEqual(await result, { state: "uncertain", operationId });
  assert.equal(
    transport.messages.filter(
      (message) => (message as { method?: string }).method === "session.shell",
    ).length,
    1,
  );
});
