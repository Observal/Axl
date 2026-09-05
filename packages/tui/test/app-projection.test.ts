// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { AxlClient, WireEvent } from "@axl/sdk";
import {
  type CanonicalEvent,
  EVENT_FORMAT_VERSION,
  type EventPayloadMap,
  type EventType,
  parseEvent,
  parseSessionId,
} from "@axl/protocol";

import {
  AxlApp,
  DifferentialScreen,
  EditorFrameComponent,
  FullscreenScreen,
} from "../src/index.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
let eventCounter = 0;

function event<Type extends EventType>(
  type: Type,
  payload: EventPayloadMap[Type],
  operationId?: string,
): CanonicalEvent<Type> {
  eventCounter += 1;
  return parseEvent({
    version: EVENT_FORMAT_VERSION,
    id: `00000000-0000-4000-8000-${eventCounter.toString(16).padStart(12, "0")}`,
    sessionId,
    ...(operationId === undefined ? {} : { operationId }),
    parentId: null,
    timestamp: eventCounter * 1_000,
    type,
    payload,
  }) as CanonicalEvent<Type>;
}

class Input extends PassThrough {
  isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

class Output extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 16;
  text = "";

  write(value: string): boolean {
    this.text += value;
    return true;
  }
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function openResult(events: readonly CanonicalEvent[]) {
  const created = events.find((event) => event.type === "session.created");
  return {
    sessionId,
    cwd: created?.type === "session.created" ? created.payload.cwd : process.cwd(),
    runtime: { state: "idle" },
    profile: "minimal",
  } as const;
}

function subscription(events: readonly CanonicalEvent[]) {
  return {
    subscriptionId: "00000000-0000-4000-8000-000000000100",
    sessionId,
    snapshot: {
      snapshotId: "00000000-0000-4000-8000-000000000101",
      sessionId,
      boundaryCursor: "00000000-0000-4000-8000-000000000102",
      eventCount: events.length,
      page: { events, complete: true },
    },
  } as const;
}

function client(
  events: readonly CanonicalEvent[],
  requests: unknown[] = [],
  sendError?: Error,
): AxlClient {
  return {
    connection: { daemonInstanceId: "fixture-daemon" },
    async request(method: string, params: unknown) {
      requests.push({ method, params });
      if (method === "session.create") return openResult(events);
      if (method === "session.subscribe") return subscription(events);
      if (method === "session.ack") {
        return { cursor: "00000000-0000-4000-8000-000000000102" };
      }
      if (method === "session.queue.enqueue") {
        return {
          queueItemId: "00000000-0000-4000-8000-000000000105",
          state: "queued",
        };
      }
      if (method === "session.queue.requeue") {
        return {
          queueItemId: (params as { queueItemId: string }).queueItemId,
          state: "queued",
        };
      }
      if (method === "session.send" || method === "session.shell") {
        if (sendError !== undefined) throw sendError;
        return method === "session.send"
          ? { stopReason: "stop" }
          : {
              operationId: "00000000-0000-4000-8000-000000000103",
              isError: false,
              resultEventId: "00000000-0000-4000-8000-000000000104",
            };
      }
      if (method === "session.interrupt") return { interrupted: false };
      if (method === "session.workspace.checkpoint") return { enabled: true };
      if (method === "session.workspace.status") {
        const scope = (params as { scope: "working" | "last-turn" }).scope;
        return {
          workspaceGeneration: "workspace-1",
          repositoryGeneration: `repository-${scope}`,
          repositoryRoot: "",
          branch: { state: "branch", name: "main", head: "a".repeat(40) },
          sparseCheckout: false,
          entries: [
            {
              entryId: `entry-${scope}`,
              path: "src/example.ts",
              area: scope === "working" ? "unstaged" : "last-turn",
              kind: "modified",
              binary: false,
              submodule: false,
            },
          ],
        };
      }
      if (method === "session.workspace.diff") {
        const request = params as { entryId: string; repositoryGeneration: string };
        return {
          workspaceGeneration: "workspace-1",
          repositoryGeneration: request.repositoryGeneration,
          entry: {
            entryId: request.entryId,
            path: "src/example.ts",
            area: request.entryId.endsWith("last-turn") ? "last-turn" : "unstaged",
            kind: "modified",
            binary: false,
            submodule: false,
          },
          hunks: [
            {
              header: "@@ -1 +1 @@",
              lines: [
                { kind: "deletion", oldLine: 1, text: "old" },
                { kind: "addition", newLine: 1, text: "new" },
              ],
            },
          ],
          binary: false,
        };
      }
      if (method === "session.interaction.respond") throw new Error("interaction response failed");
      throw new Error(`Unexpected request ${method}`);
    },
    async shell(params: { operationId: string; command: string }) {
      requests.push({ method: "session.shell", params });
      if (sendError !== undefined) {
        return { state: "uncertain", operationId: params.operationId } as const;
      }
      return {
        state: "completed",
        result: {
          operationId: params.operationId,
          isError: false,
          resultEventId: "00000000-0000-4000-8000-000000000104",
        },
      } as const;
    },
    loadingSnapshot<Result>(load: () => Promise<Result>) {
      return load();
    },
    onEvent() {
      return () => undefined;
    },
    onActivity() {
      return () => undefined;
    },
    onDisconnect() {
      return () => undefined;
    },
    onReconnect() {
      return () => undefined;
    },
    close() {},
  } as unknown as AxlClient;
}

class ReconnectClient {
  readonly connection = { daemonInstanceId: "fixture-daemon" };
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private readonly reconnectListeners = new Set<() => void | Promise<void>>();
  private eventListener: ((message: WireEvent) => void) | undefined;
  readonly requests: string[] = [];
  private eventSequence = 0;
  private readonly events: readonly CanonicalEvent[];
  private readonly reconnectFails: boolean;

  constructor(events: readonly CanonicalEvent[], reconnectFails = false) {
    this.events = events;
    this.reconnectFails = reconnectFails;
  }

  async request(method: string): Promise<unknown> {
    this.requests.push(method);
    if (method === "session.create" || method === "session.resume") {
      return openResult(this.events);
    }
    if (method === "session.subscribe") return subscription(this.events);
    if (method === "session.ack") {
      return { cursor: "00000000-0000-4000-8000-000000000102" };
    }
    if (method === "session.workspace.checkpoint") return { enabled: false };
    if (method === "session.unsubscribe") return { unsubscribed: true };
    throw new Error(`Unexpected request ${method}`);
  }

  loadingSnapshot<Result>(load: () => Promise<Result>): Promise<Result> {
    return load();
  }

  onEvent(listener: (message: WireEvent) => void): () => void {
    this.eventListener = listener;
    return () => {
      this.eventListener = undefined;
    };
  }

  onActivity(): () => void {
    return () => undefined;
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  onReconnect(listener: () => void | Promise<void>): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  async reconnect(): Promise<void> {
    this.requests.push("connection.reconnect");
    if (this.reconnectFails) throw new Error("fixture daemon unavailable");
    for (const listener of [...this.reconnectListeners]) await listener();
  }

  disconnect(): void {
    for (const listener of this.disconnectListeners) listener(new Error("fixture disconnected"));
  }

  emit(value: CanonicalEvent): void {
    this.eventSequence += 1;
    this.eventListener?.({
      kind: "event",
      subscriptionId: "00000000-0000-4000-8000-000000000100",
      sessionId,
      sequence: this.eventSequence,
      cursor: `cursor-${this.eventSequence}`,
      event: value,
    });
  }

  close(): void {}

  daemonClient(): AxlClient {
    return this as unknown as AxlClient;
  }
}

test("projects a call and result as one settled transaction", async () => {
  const operationId = "00000000-0000-4000-8000-000000000010";
  const snapshot = [
    event("session.created", { cwd: process.cwd() }),
    event(
      "tool.call",
      { callId: "call-1", name: "shell", input: { command: "pnpm test" } },
      operationId,
    ),
    event(
      "tool.result",
      {
        callId: "call-1",
        name: "shell",
        content: [{ type: "text", text: "passed" }],
        isError: false,
        details: { durationMs: 250, endedBy: "exit" },
      },
      operationId,
    ),
  ];
  const input = new Input();
  const output = new Output();
  const app = await AxlApp.start({
    client: client(snapshot),
    input,
    output,
    cwd: process.cwd(),
    color: false,
  });

  assert.equal(output.text.split("pnpm test").length - 1, 1);
  assert.equal(output.text.split("passed").length - 1, 1);
  assert.match(output.text, /SHELL\s+done \| 1\.0s/);
  assert.doesNotThrow(() => (app as unknown as { rebuildTranscript(): void }).rebuildTranscript());
  app.stop();
});

test("slash completion arrows select and execute the highlighted command", async () => {
  const input = new Input();
  const output = new Output();
  const app = await AxlApp.start({
    client: client([event("session.created", { cwd: process.cwd() })]),
    input,
    output,
    cwd: process.cwd(),
    color: false,
  });

  input.write("/");
  input.write("\x1b[B");
  input.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(output.text, /Select thinking level/);
  app.stop();
});

test("restores prompts instead of retrying uncertain daemon delivery", async () => {
  const input = new Input();
  const output = new Output();
  const disconnect = Object.assign(new Error("connection lost"), { code: "disconnected" });
  const app = await AxlApp.start({
    client: client([event("session.created", { cwd: process.cwd() })], [], disconnect),
    input,
    output,
    cwd: process.cwd(),
    color: false,
  });

  input.write("preserve me\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(output.text, /delivery unknown · prompts restored for review/);
  assert.match(output.text, /preserve me/);
  app.stop();
});

test("reports an uncertain shell outcome without automatically repeating the command", async () => {
  const requests: Array<{ method?: string; params?: { command?: string } }> = [];
  const input = new Input();
  const output = new Output();
  const disconnect = Object.assign(new Error("connection lost"), { code: "disconnected" });
  const app = await AxlApp.start({
    client: client(
      [event("session.created", { cwd: process.cwd() })],
      requests as unknown[],
      disconnect,
    ),
    input,
    output,
    cwd: process.cwd(),
    color: false,
  });

  input.write("!printf once\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(output.text, /shell delivery unknown · command restored/);
  assert.match(output.text, /!printf once/);
  assert.equal(requests.filter((request) => request.method === "session.shell").length, 1);
  assert.equal(
    requests.find((request) => request.method === "session.shell")?.params?.command,
    "printf once",
  );
  app.stop();
});

test("keeps an interaction recoverable when its daemon response fails", async () => {
  const requests: unknown[] = [];
  const input = new Input();
  const output = new Output();
  const app = await AxlApp.start({
    client: client(
      [
        event("session.created", { cwd: process.cwd() }),
        event("interaction.requested", {
          interactionId: "approval-1",
          kind: "mcp_tool",
          source: "fixture",
          message: "Allow the fixture action?",
        }),
      ],
      requests,
    ),
    input,
    output,
    cwd: process.cwd(),
    color: false,
  });

  input.write("y");
  await new Promise((resolve) => setTimeout(resolve, 0));
  input.write("x\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    requests.some(
      (request) =>
        typeof request === "object" &&
        request !== null &&
        (request as { method?: string }).method === "session.send",
    ),
    false,
  );
  assert.match(output.text, /interaction response failed/);
  app.stop();
});

test("reconnects, resumes, and resubscribes after daemon loss", async () => {
  const events = [event("session.created", { cwd: process.cwd() })];
  const initial = new ReconnectClient(events, true);
  const replacement = new ReconnectClient(events);
  const input = new Input();
  const output = new Output();
  const app = await AxlApp.start({
    client: initial.daemonClient(),
    reconnectClient: async () => replacement.daemonClient(),
    input,
    output,
    cwd: process.cwd(),
    color: false,
    tuiMode: "fullscreen",
  });

  initial.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reconnectingTerminal = new VirtualTerminal(80, 16);
  reconnectingTerminal.write(output.text);
  assert.equal(
    reconnectingTerminal.cursorRow >= 10,
    true,
    `reconnecting cursor row ${reconnectingTerminal.cursorRow}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(replacement.requests, [
    "session.resume",
    "session.workspace.checkpoint",
    "session.subscribe",
    "session.ack",
  ]);
  assert.match(output.text, /daemon reconnected/);
  const connectedTerminal = new VirtualTerminal(80, 16);
  connectedTerminal.write(output.text);
  assert.equal(
    connectedTerminal.cursorRow >= 10,
    true,
    `connected cursor row ${connectedTerminal.cursorRow}`,
  );
  app.stop();
});

test("coalesces TUI recovery through the SDK client before replacing it", async (context) => {
  const events = [event("session.created", { cwd: process.cwd() })];
  const daemon = new ReconnectClient(events);
  const input = new Input();
  const output = new Output();
  const app = await AxlApp.start({
    client: daemon.daemonClient(),
    input,
    output,
    cwd: process.cwd(),
    color: false,
  });
  context.after(() => app.stop());
  daemon.requests.length = 0;

  daemon.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(daemon.requests, [
    "connection.reconnect",
    "session.subscribe",
    "session.ack",
    "session.workspace.checkpoint",
  ]);
  assert.match(output.text, /daemon reconnected/);
  app.stop();
});

test("rings once for an unfocused error when attention is enabled", async () => {
  const events = [event("session.created", { cwd: process.cwd() })];
  const daemon = new ReconnectClient(events);
  const input = new Input();
  const output = new Output();
  const app = await AxlApp.start({
    client: daemon.daemonClient(),
    input,
    output,
    cwd: process.cwd(),
    color: false,
    attention: "bell",
  });

  input.write("\x1b[O");
  daemon.emit(event("session.error", { code: "failed", message: "boom", retryable: false }));
  daemon.emit(event("session.error", { code: "failed", message: "again", retryable: false }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(output.text.split("\x07").length - 1, 1);
  app.stop();
});

test("prompt stash, favorites, and refocus recap stay client-local", async () => {
  const events = [event("session.created", { cwd: process.cwd() })];
  const daemon = new ReconnectClient(events);
  const preferences: unknown[] = [];
  const input = new Input();
  const output = new Output();
  const app = await AxlApp.start({
    client: daemon.daemonClient(),
    input,
    output,
    cwd: process.cwd(),
    color: false,
    models: ["gpt-5", "gpt-4.1"],
    currentModel: "gpt-5",
    refocusRecap: true,
    onPreferenceChange: (update) => {
      preferences.push(update);
    },
  });

  input.write("draft\x1bs");
  await until(() => output.text.includes("prompt stashed"), "prompt stashed");
  assert.match(output.text, /prompt stashed/);
  input.write("replacement\x1bs");
  await until(() => output.text.includes("prompt swapped with stash"), "prompt swapped with stash");
  assert.match(output.text, /prompt swapped with stash/);
  assert.match(output.text, /draft/);

  input.write("\x15/favorite gpt-5\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(preferences.at(-1), { modelFavorites: ["gpt-5"] });

  input.write("\x1b[O");
  daemon.emit(
    event("assistant.message", { content: [{ type: "text", text: "done" }], stopReason: "stop" }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  input.write("\x1b[I");
  await until(
    () => output.text.includes("while away: 1 turn completed"),
    "while away: 1 turn completed",
  );
  assert.match(output.text, /while away: 1 turn completed/);
  app.stop();
});

test("workspace review opens from daemon data and the developer panel is opt-in", async () => {
  const requests: unknown[] = [];
  const input = new Input();
  const output = new Output();
  output.columns = 120;
  const app = await AxlApp.start({
    client: client(
      [
        event("session.created", { cwd: process.cwd() }),
        event("tool.call", {
          callId: "pending-review",
          name: "read",
          input: { path: "src/app.ts" },
        }),
      ],
      requests,
    ),
    input,
    output,
    cwd: process.cwd(),
    color: false,
    developerPanel: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(output.text, /Workspace/);
  const terminal = new VirtualTerminal(120, 16);
  terminal.write(output.text);
  const rows = terminal.rows();
  const promptRow = rows.findIndex((row) => /^│\s+│$/.test(row));
  assert.equal(promptRow >= 0, true);
  assert.equal(terminal.cursorRow, promptRow);
  const workspaceRow = rows.findIndex((row) => row.includes("Workspace"));
  assert.equal(workspaceRow > 0 && rows[workspaceRow - 1]?.trim() === "", true);
  input.write("/review working\r");
  await new Promise((resolve) => setImmediate(resolve));
  await until(() => output.text.includes("Review · working tree"), "Review · working tree");
  assert.match(output.text, /Review · working tree/);
  assert.equal(
    requests.some(
      (request) =>
        typeof request === "object" &&
        request !== null &&
        (request as { method?: string }).method === "session.workspace.checkpoint",
    ),
    true,
  );
  app.stop();
});

test("fullscreen consumes mouse reports before editor input", async () => {
  const requests: unknown[] = [];
  const input = new Input();
  const output = new Output();
  const app = await AxlApp.start({
    client: client([event("session.created", { cwd: process.cwd() })], requests),
    input,
    output,
    cwd: process.cwd(),
    color: false,
    tuiMode: "fullscreen",
  });

  input.write("/settings\r");
  await until(() => output.text.includes("Terminal settings"), "Terminal settings");
  assert.match(output.text, /Terminal settings/);
  input.write("\x1b[<0;4;4M");
  input.write("\x1b[<0;4;4m");
  await until(() => output.text.includes("Terminal settings"), "Terminal settings");
  assert.match(output.text, /Terminal settings/);
  input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.write("ok\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const send = requests.find(
    (request): request is { method: string; params: { content: Array<{ text: string }> } } =>
      typeof request === "object" &&
      request !== null &&
      (request as { method?: string }).method === "session.send",
  );
  assert.equal(send?.params.content[0]?.text, "ok");
  app.stop();
});

test("one scheduler coalesces wheel and resize bursts, while typing preempts pending paint", async (context) => {
  const input = new Input();
  const output = new Output();
  const paints = context.mock.method(FullscreenScreen.prototype, "render");
  const layouts = context.mock.method(EditorFrameComponent.prototype, "render");
  const app = await AxlApp.start({
    client: client([
      event("session.created", { cwd: process.cwd() }),
      event("assistant.message", {
        content: [{ type: "text", text: "history paragraph\n\n".repeat(100) }],
        stopReason: "stop",
      }),
    ]),
    input,
    output,
    cwd: process.cwd(),
    color: false,
    tuiMode: "fullscreen",
  });
  context.after(() => app.stop());
  // Settle terminal negotiation before taking ownership of render timers.
  input.write("\x1b[?1u");
  context.mock.timers.enable({ apis: ["setTimeout"] });
  paints.mock.resetCalls();
  layouts.mock.resetCalls();
  for (let i = 0; i < 20; i++) input.write("\x1b[<64;2;2M");
  for (const width of [60, 90, 50]) {
    output.columns = width;
    output.emit("resize");
  }
  assert.equal(layouts.mock.callCount(), 0, "input must not lay out the dock");
  assert.equal(paints.mock.callCount(), 0);
  input.write("a");
  input.write("b");
  assert.equal(paints.mock.callCount(), 0, "synchronous keyboard bursts coalesce too");
  await Promise.resolve();
  assert.equal(paints.mock.callCount(), 1);
  assert.equal(layouts.mock.callCount(), 1, "the dock is measured only once per paint");
  assert.ok(paints.mock.calls[0]?.arguments[0].dock.some((line) => line.includes("ab")));
  context.mock.timers.tick(20);
  assert.equal(paints.mock.callCount(), 1, "keyboard cancels the delayed mouse paint");

  // Missing resize notifications still converge on the terminal's current dimensions.
  output.columns = 29;
  output.rows = 7;
  const offset = output.text.length;
  input.write("c");
  await Promise.resolve();
  const terminal = new VirtualTerminal(29, 7);
  terminal.write(output.text.slice(offset));
  assert.ok(terminal.cursorRow < 7);
  assert.ok(terminal.rows()[terminal.cursorRow]?.includes("abc"));
  assert.ok(output.text.slice(offset).includes("\x1b[2J\x1b[H"));
  assert.ok(paints.mock.calls.at(-1)?.arguments[0].dock.length === 3);

  for (let i = 0; i < 20; i++) input.write("\x1b[<65;2;2M");
  context.mock.timers.tick(20);
  assert.equal(paints.mock.callCount(), 3, "ordinary wheel bursts share the same queue");
  input.write("\x1b[<64;2;2M");
  app.stop();
  const stopped = output.text;
  context.mock.timers.tick(2_000);
  assert.equal(output.text, stopped, "no paints survive terminal shutdown");
});

test("regular mutable output stays inside the physical viewport with large tool groups", async (context) => {
  const input = new Input();
  const output = new Output();
  output.rows = 12;
  const frames = context.mock.method(DifferentialScreen.prototype, "frame");
  const snapshot: CanonicalEvent[] = [event("session.created", { cwd: process.cwd() })];
  for (let index = 0; index < 40; index++) {
    snapshot.push(
      event("tool.call", {
        callId: `bounded-${index}`,
        name: "bash",
        input: { command: `printf ${index}` },
      }),
    );
    if (index < 39)
      snapshot.push(
        event("tool.result", {
          callId: `bounded-${index}`,
          name: "bash",
          content: [{ type: "text", text: "long result\n".repeat(100) }],
          isError: false,
        }),
      );
  }
  const app = await AxlApp.start({
    client: client(snapshot),
    input,
    output,
    cwd: process.cwd(),
    color: false,
    toolOutputDisplay: "full",
  });
  context.after(() => app.stop());
  input.write("draft");
  await Promise.resolve();
  for (const call of frames.mock.calls) {
    const [components, cursor] = call.arguments;
    const lines = components.flatMap((component) => component.render(output.columns));
    assert.ok(lines.length <= output.rows);
    assert.ok(lines.some((line) => /BASH\s+pending/.test(line)));
    assert.ok(lines.some((line) => line.includes("fullscreen or /export")));
    assert.ok(cursor !== undefined && cursor.row < output.rows);
  }
  assert.match(output.text, /draft/);
  assert.ok(!output.text.includes("\x1b[3J"));
});

test("regular resize redraws a bounded viewport instead of replaying all history", async (context) => {
  const input = new Input();
  const output = new Output();
  const app = await AxlApp.start({
    client: client([
      event("session.created", { cwd: process.cwd() }),
      event("assistant.message", {
        content: [
          {
            type: "text",
            text: Array.from({ length: 500 }, (_, i) => `history-${i}`).join("\n\n"),
          },
        ],
        stopReason: "stop",
      }),
    ]),
    input,
    output,
    cwd: process.cwd(),
    color: false,
  });
  context.after(() => app.stop());
  const offset = output.text.length;
  output.rows = 8;
  output.columns = 60;
  input.write("resized draft");
  await Promise.resolve();
  const repair = output.text.slice(offset);
  assert.ok(
    repair.startsWith("\r\n".repeat(8)),
    "preserve the old physical viewport in scrollback",
  );
  assert.ok(!repair.includes("\x1b[3J"));
  assert.ok(!repair.includes("history-0"));
  assert.ok(repair.includes("history-499"));
  assert.ok(repair.includes("resized draft"));
  assert.ok(repair.length < 2_000, "resize output is bounded by the viewport, not session length");
});
