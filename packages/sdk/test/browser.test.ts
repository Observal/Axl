// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { BrowserWebSocketTransportFactory } from "../src/browser.ts";

type Listener = (event: unknown) => void;

class FakeSocket {
  static readonly OPEN = 1;
  static instance: FakeSocket;

  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instance = this;
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 3;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

test("browser transport decodes JSON and reports close details", async () => {
  const connecting = new BrowserWebSocketTransportFactory(
    "ws://127.0.0.1/socket",
    FakeSocket as never,
  ).connect();
  const socket = FakeSocket.instance;
  socket.readyState = FakeSocket.OPEN;
  socket.emit("open", {});
  const transport = await connecting;

  const received: unknown[] = [];
  let closed: Error | undefined;
  transport.onMessage((message) => {
    received.push(message);
  });
  transport.onClose((cause) => {
    closed = cause;
  });

  transport.send("request\n");
  socket.emit("message", { data: '{"type":"response"}' });
  socket.emit("message", { data: "invalid" });
  socket.emit("close", { code: 1008, reason: "rejected" });

  assert.deepEqual(socket.sent, ["request\n"]);
  assert.deepEqual(received, [{ type: "response" }, "invalid"]);
  assert.equal(closed?.message, "rejected");
  assert.deepEqual((closed as { details?: unknown }).details, { code: 1008 });
});
