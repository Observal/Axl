// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AxlDaemon, type SessionRuntimeFactory } from "@axl/daemon";
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

async function startDaemon(
  context: TestContext,
  runtime: SessionRuntimeFactory = () => ({
    model,
    tools: new ToolRegistry(),
    system: "You are Axl.",
  }),
) {
  const directory = await mkdtemp(join(tmpdir(), "axl-web-shell-"));
  const socketPath = join(directory, "axl.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    runtime,
  });
  await daemon.start();
  context.after(async () => {
    await daemon.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    daemon,
    socketPath,
    dataDirectory: join(directory, "data"),
    cwd: await realpath(directory),
  };
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
  await shell.listWorkspace("");
  assert.ok(shell.state.workspace.directories[""]?.entries.length !== undefined);
  await shell.createSession({ cwd });
  assert.notEqual(shell.state.selected?.sessionId, firstSessionId);
  assert.equal(shell.state.workspace.sessionId, shell.state.selected?.sessionId);
  assert.deepEqual(shell.state.workspace.directories, {});
  assert.deepEqual(shell.state.workspace.previews, {});
  assert.deepEqual(shell.state.workspace.statuses, {});
  assert.deepEqual(shell.state.workspace.diffs, {});
  assert.ok(
    shell.state.conversation.records.every(
      (record) => record.event.sessionId === shell.state.selected?.sessionId,
    ),
  );
});

test("forks a completed conversation from its latest user message", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  const shell = new ApplicationShell(connector(socketPath, []), unavailableCursorStore());
  context.after(() => shell.detach());
  await shell.start();
  await shell.createSession({ cwd });
  const sourceSessionId = shell.state.selected?.sessionId;
  shell.setDraft("fork this turn");
  await shell.send();
  const latestUser = shell.state.conversation.records.findLast(
    (record) => record.kind === "event" && record.event.type === "user.message",
  );
  assert.ok(latestUser);
  assert.notEqual(shell.state.conversation.records.at(-1)?.event.type, "user.message");

  await shell.fork();
  assert.notEqual(shell.state.selected?.sessionId, sourceSessionId);
  const forkRoot = shell.state.conversation.records[0]?.event;
  assert.equal(forkRoot?.type, "session.created");
  if (forkRoot?.type === "session.created") {
    assert.equal(forkRoot.payload.sourceEventId, latestUser.event.id);
  }
});

test("configures model, thinking, profile, and web features through daemon state", async (context) => {
  const knownModels = new Set(["model-a", "model-b"]);
  const configured: string[] = [];
  const runtime: SessionRuntimeFactory = ({ selection }) => {
    const modelId = selection.modelId ?? "model-a";
    if (!knownModels.has(modelId)) throw new Error(`Unknown model ${modelId}`);
    configured.push(modelId);
    const thinkingLevel = selection.thinkingLevel ?? "off";
    return {
      model,
      tools: new ToolRegistry(),
      system: "You are Axl.",
      configModel: { modelId },
      configThinking: {
        requested: thinkingLevel,
        effective: thinkingLevel,
        clamped: false,
      },
      configProfile: { profile: selection.profile ?? "standard" },
      configTools: {
        webFetch: selection.webFetch ?? false,
        webSearch: selection.webSearch ?? false,
      },
    };
  };
  const { socketPath, cwd } = await startDaemon(context, runtime);
  const shell = new ApplicationShell(connector(socketPath, []), unavailableCursorStore());
  context.after(() => shell.detach());
  await shell.start();
  await shell.createSession({ cwd, modelId: "model-a", thinkingLevel: "medium" });
  await shell.configure({
    modelId: "model-b",
    thinkingLevel: "high",
    profile: "minimal",
    webFetch: true,
    webSearch: true,
  });
  await until(() => shell.state.conversation.model === "model-b", "model configuration");
  assert.deepEqual(configured, ["model-a", "model-b"]);
  assert.equal(shell.state.conversation.thinking, "high");
  assert.equal(shell.state.conversation.profile, "minimal");
  assert.equal(shell.state.conversation.webFetch, true);
  assert.equal(shell.state.conversation.webSearch, true);
});

test("queues a second draft during active work and requeues it after restart", async (context) => {
  let releaseFirst: () => void = () => undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let turn = 0;
  const blockedModel: ModelPort = {
    stream() {
      turn += 1;
      const current = turn;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (current === 1) await firstBlocked;
        yield { type: "text_delta", text: "done" };
        yield {
          type: "completed",
          stopReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      })();
    },
  };
  const fixture = await startDaemon(context, () => ({
    model: blockedModel,
    tools: new ToolRegistry(),
    system: "You are Axl.",
  }));
  const shell = new ApplicationShell(connector(fixture.socketPath, []), unavailableCursorStore());
  context.after(() => shell.detach());
  await shell.start();
  await shell.createSession({ cwd: fixture.cwd });
  shell.setDraft("active prompt");
  const active = shell.send().catch(() => undefined);
  await until(() => shell.state.conversation.activeOperationId !== undefined, "active operation");

  shell.setDraft("queued prompt");
  await shell.send("back");
  const queued = shell.state.conversation.queue.find((item) => item.status === "queued");
  assert.ok(queued);
  assert.deepEqual(queued.content, [{ type: "text", text: "queued prompt" }]);
  assert.equal(shell.state.draft, "");

  const stopping = fixture.daemon.stop();
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseFirst();
  await Promise.allSettled([active, stopping]);

  const restarted = new AxlDaemon({
    socketPath: fixture.socketPath,
    dataDirectory: fixture.dataDirectory,
    runtime: () => ({ model, tools: new ToolRegistry(), system: "You are Axl." }),
  });
  await restarted.start();
  context.after(() => restarted.stop());
  await shell.reconnect();
  await until(
    () =>
      shell.state.conversation.queue.some(
        (item) => item.queueItemId === queued.queueItemId && item.status === "paused",
      ),
    "paused queue item",
  );
  await shell.requeue(queued.queueItemId, "back");
  await until(
    () =>
      shell.state.conversation.queue.some(
        (item) => item.queueItemId === queued.queueItemId && item.status === "completed",
      ),
    "requeued prompt completion",
  );
});

test("loads more than one page of all-local sessions", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  const seed = await connectUnixClient(socketPath);
  context.after(() => seed.close());
  for (let index = 0; index < 31; index += 1) {
    await seed.request("session.create", { cwd });
  }
  const shell = new ApplicationShell(connector(socketPath, []), unavailableCursorStore());
  context.after(() => shell.detach());
  await shell.start();
  assert.equal(shell.state.sessions.length, 30);
  assert.ok(shell.state.nextPageCursor);
  await shell.loadMoreSessions();
  assert.equal(shell.state.sessions.length, 31);
  assert.equal(shell.state.nextPageCursor, undefined);
});

test("responds to daemon-owned interactions through the typed control", async (context) => {
  let turn = 0;
  const interactiveModel: ModelPort = {
    stream() {
      turn += 1;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (turn === 1) {
          yield { type: "tool_call", callId: "approval", name: "approval", input: {} };
          yield {
            type: "completed",
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        } else {
          yield { type: "text_delta", text: "approved" };
          yield {
            type: "completed",
            stopReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        }
      })();
    },
  };
  const { socketPath, cwd } = await startDaemon(context, ({ interact }) => {
    const tools = new ToolRegistry();
    tools.register({
      name: "approval",
      description: "Request approval",
      inputSchema: { type: "object" },
      async execute(_input, signal) {
        const response = await interact(
          { kind: "mcp_tool", source: "mcp:test", message: "Allow test tool?" },
          signal,
        );
        return {
          content: [{ type: "text", text: response.action }],
          isError: response.action !== "accept",
        };
      },
    });
    return { model: interactiveModel, tools, system: "You are Axl." };
  });
  const shell = new ApplicationShell(connector(socketPath, []), unavailableCursorStore());
  context.after(() => shell.detach());
  await shell.start();
  await shell.createSession({ cwd });
  shell.setDraft("request approval");
  const sending = shell.send();
  await until(
    () => shell.state.conversation.interactions.some((item) => item.resolution === undefined),
    "interaction request",
  );
  const interaction = shell.state.conversation.interactions.find(
    (item) => item.resolution === undefined,
  );
  assert.ok(interaction);
  assert.equal(shell.state.busy, true);
  await shell.respondToInteraction(interaction.interactionId, "accept");
  await sending;
  await until(
    () => shell.state.conversation.interactions.some((item) => item.resolution !== undefined),
    "interaction resolution",
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
