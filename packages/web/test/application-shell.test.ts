// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AxlDaemon } from "@axl/daemon";
import { type ModelPort, ToolRegistry } from "@axl/kernel";
import {
  type AxlClient,
  type ConnectionState,
  type CursorStore,
  type ModelStreamEvent,
  subscribeSession,
} from "@axl/sdk";
import { connectUnixClient } from "@axl/sdk/unix";

import { gatewayRpcPath, SessionStorageCursorStore } from "../src/browser.ts";
import { ApplicationShell, BROWSER_CAPABILITIES, type WebClientConnector } from "../src/shell.ts";

const model: ModelPort = {
  stream() {
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield { type: "text_delta", text: "the answer" };
      yield {
        type: "completed",
        stopReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    })();
  },
};

async function startDaemon(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "axl-web-shell-"));
  const socketPath = join(directory, "axl.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    runtime: () => ({ model, tools: new ToolRegistry(), system: "You are Axl." }),
  });
  await daemon.start();
  context.after(async () => {
    await daemon.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, cwd: await realpath(directory) };
}

function unavailableCursorStore(): CursorStore {
  return {
    async load() {
      throw new Error("storage denied");
    },
    async save() {
      throw new Error("storage denied");
    },
    async delete() {
      throw new Error("storage denied");
    },
  };
}

function connector(socketPath: string, clients: AxlClient[]): WebClientConnector {
  return {
    async connect(onStateChange: (state: ConnectionState) => void) {
      const client = await connectUnixClient(socketPath, {
        identity: {
          kind: "web",
          version: "test",
          instanceId: globalThis.crypto.randomUUID(),
        },
        requestedCapabilities: BROWSER_CAPABILITIES,
        onStateChange,
      });
      clients.push(client);
      return client;
    },
  };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 5_000) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function eventIds(client: {
  readonly state: {
    readonly conversation: {
      readonly records: readonly { readonly event: { readonly id: string } }[];
    };
  };
}): string[] {
  return client.state.conversation.records.map((record) => record.event.id);
}

test("browser and TUI projections converge, reconnect exactly, and detach leaves work running", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  const browserClients: AxlClient[] = [];
  const shell = new ApplicationShell(
    connector(socketPath, browserClients),
    unavailableCursorStore(),
  );
  context.after(() => shell.detach());
  await shell.start();
  assert.equal(shell.state.connection, "connected");
  assert.deepEqual(shell.state.grantedCapabilities, BROWSER_CAPABILITIES);

  await shell.createSession({ cwd });
  assert.deepEqual(shell.state.cursorPersistence, {
    state: "unavailable",
    reason: "cursor_store_failed",
  });
  const sessionId = shell.state.selected?.sessionId;
  assert.ok(sessionId);

  const tui = await connectUnixClient(socketPath, {
    identity: { kind: "tui", version: "test", instanceId: "tui-fixture" },
    requestedCapabilities: ["session.send.prompt", "session.subscribe"],
  });
  context.after(() => tui.close());
  const tuiSubscription = await subscribeSession(tui, sessionId);
  context.after(() => tuiSubscription.close());

  shell.setDraft("from browser");
  await shell.send();
  await until(
    () =>
      tuiSubscription.projector.state.records.length === shell.state.conversation.records.length,
    "TUI browser mutation",
  );
  assert.deepEqual(tuiSubscription.projector.state.records, shell.state.conversation.records);

  await tui.request("session.send", {
    sessionId,
    content: [{ type: "text", text: "from terminal" }],
    delivery: "prompt",
  });
  await until(
    () =>
      tuiSubscription.projector.state.records.length === shell.state.conversation.records.length,
    "browser terminal mutation",
  );
  assert.deepEqual(tuiSubscription.projector.state.records, shell.state.conversation.records);

  shell.setDraft("finish after detach");
  const inFlight = shell.send().catch(() => undefined);
  await until(
    () =>
      tuiSubscription.projector.state.records.some((record) => {
        if (record.kind !== "event" || record.event.type !== "user.message") return false;
        return record.event.payload.content.some(
          (part) => part.type === "text" && part.text === "finish after detach",
        );
      }),
    "accepted prompt",
  );
  shell.detach();
  await inFlight;
  await until(
    () => tuiSubscription.projector.state.activeOperationId === undefined,
    "daemon-owned turn after browser detach",
  );

  await shell.reconnect();
  await until(() => shell.state.connection === "connected", "browser reconnect");
  assert.deepEqual(
    eventIds(shell),
    tuiSubscription.projector.state.records.map((item) => item.event.id),
  );
  assert.equal(new Set(eventIds(shell)).size, eventIds(shell).length);

  const firstSessionId = sessionId;
  await shell.createSession({ cwd });
  assert.notEqual(shell.state.selected?.sessionId, firstSessionId);
  assert.ok(
    shell.state.conversation.records.every(
      (record) => record.event.sessionId === shell.state.selected?.sessionId,
    ),
  );
});

test("browser adapters keep cursors disposable and derive only authenticated RPC paths", async () => {
  const values = new Map<string, string>();
  const store = new SessionStorageCursorStore({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  });
  await store.save("daemon:session:tip", "cursor");
  assert.equal(await store.load("daemon:session:tip"), "cursor");
  await store.delete("daemon:session:tip");
  assert.equal(await store.load("daemon:session:tip"), undefined);

  assert.equal(
    gatewayRpcPath("/_axl/0123456789abcdef0123456789abcdef/dev/"),
    "/_axl/0123456789abcdef0123456789abcdef/rpc",
  );
  assert.throws(() => gatewayRpcPath("/dev/"), /authenticated gateway path/);
});
