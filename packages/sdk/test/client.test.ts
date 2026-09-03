// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  AxlClient,
  AxlClientError,
  type AxlTransport,
  type AxlTransportFactory,
} from "../src/index.ts";
import {
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
            grantedCapabilities: request.params.requestedCapabilities,
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
        capabilities: WIRE_CAPABILITIES,
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
  async connect(): Promise<AxlTransport> {
    const transport = new FakeTransport();
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

test("coalesces concurrent reconnect attempts onto one new transport", async () => {
  const factory = new Factory();
  const { client } = await connect(factory);
  await Promise.all([client.reconnect(), client.reconnect()]);
  assert.equal(factory.transports.length, 2);
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
