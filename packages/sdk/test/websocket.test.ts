// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { WIRE_PROTOCOL_VERSION } from "@axl/protocol";

import {
  BrowserWebSocketTransportFactory,
  connectBrowserClient,
  type BrowserWebSocketLike,
} from "../src/websocket.ts";

type Listener = (...arguments_: never[]) => void;

class FakeWebSocket implements BrowserWebSocketLike {
  static instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  readonly sent: string[] = [];
  readonly url: string;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(data: string): void {
    this.sent.push(data);
    const request = JSON.parse(data) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    if (request.method === "connection.initialize") {
      queueMicrotask(() =>
        this.message({
          kind: "success",
          id: request.id,
          method: request.method,
          result: {
            attachmentId: "web-attachment",
            daemonInstanceId: "daemon-fixture",
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

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }

  message(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }
}

test("browser WebSocket transport uses a same-origin cookie-authenticated URL and decodes text", async () => {
  FakeWebSocket.instances = [];
  const factory = new BrowserWebSocketTransportFactory("/_axl/prefix/rpc", {
    origin: "http://127.0.0.1:43127",
    WebSocket: FakeWebSocket,
  });
  const transport = await factory.connect();
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  assert.equal(socket.url, "ws://127.0.0.1:43127/_axl/prefix/rpc");
  const messages: unknown[] = [];
  transport.onMessage((message) => messages.push(message));
  socket.message({ kind: "fixture" });
  assert.deepEqual(messages, [{ kind: "fixture" }]);
  transport.close();
});

test("browser client requests no unimplemented capabilities by default", async () => {
  FakeWebSocket.instances = [];
  const connecting = connectBrowserClient("/_axl/prefix/rpc", {
    origin: "http://127.0.0.1:43127",
    WebSocket: FakeWebSocket,
    identity: { kind: "web", version: "test", instanceId: "browser-fixture" },
  });
  while (FakeWebSocket.instances.length === 0)
    await new Promise((resolve) => setImmediate(resolve));
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  await new Promise((resolve) => setImmediate(resolve));
  socket.message({
    kind: "hello",
    wireVersion: WIRE_PROTOCOL_VERSION,
    daemonInstanceId: "daemon-fixture",
    capabilities: ["session.list"],
    limits: { maxMessageBytes: 1_048_576, maxPendingRequests: 64 },
  });
  const client = await connecting;
  assert.deepEqual(client.connection.grantedCapabilities, []);
  const initialize = socket.sent
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
    .find((request) => request.method === "connection.initialize");
  assert.deepEqual(initialize?.params.requestedCapabilities, []);
  client.close();
});

test("browser transport rejects binary and oversized gateway messages", async () => {
  FakeWebSocket.instances = [];
  const transport = await new BrowserWebSocketTransportFactory("/_axl/prefix/rpc", {
    origin: "http://127.0.0.1:43127",
    WebSocket: FakeWebSocket,
    maximumMessageBytes: 32,
  }).connect();
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  const closed = new Promise<Error | undefined>((resolve) => transport.onClose(resolve));
  socket.emit("message", { data: new Uint8Array([1, 2, 3]) });
  assert.match((await closed)?.message ?? "", /binary/);
});
