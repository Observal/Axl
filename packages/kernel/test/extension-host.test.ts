// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  type CanonicalEvent,
  type JsonObject,
  type ModelStreamEvent,
  parseSessionId,
  type Usage,
} from "@axl/protocol";

import {
  AgentSession,
  CommandBlockedError,
  composeExtensionHosts,
  type ExtensionHost,
  interceptCommand,
  type KernelTool,
  type ModelPort,
  ToolRegistry,
} from "../src/index.ts";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
const usage: Usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

function scripted(responses: readonly (readonly ModelStreamEvent[])[]): ModelPort {
  const remaining = [...responses];
  return {
    stream() {
      const response = remaining.shift();
      if (response === undefined) throw new Error("no scripted response left");
      return (async function* () {
        yield* response;
      })();
    },
  };
}

function echo(): { tool: KernelTool; calls: JsonObject[] } {
  const calls: JsonObject[] = [];
  return {
    calls,
    tool: {
      name: "echo",
      description: "Echo",
      inputSchema: { type: "object" },
      execute: async (input) => {
        calls.push(input);
        return { content: [{ type: "text", text: "echoed" }], isError: false };
      },
    },
  };
}

function callEcho(callId: string, input: JsonObject): readonly ModelStreamEvent[] {
  return [
    { type: "tool_call", callId, name: "echo", input },
    { type: "completed", stopReason: "tool_use", usage },
  ];
}

const done: readonly ModelStreamEvent[] = [
  { type: "text_delta", text: "done" },
  { type: "completed", stopReason: "stop", usage },
];

async function open(
  context: TestContext,
  port: ModelPort,
  tools: ToolRegistry,
  extensionHost: ExtensionHost,
): Promise<AgentSession> {
  const directory = await mkdtemp(join(tmpdir(), "axl-extension-host-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return AgentSession.open(join(directory, "session.jsonl"), sessionId, {
    model: port,
    tools,
    cwd: "/workspace",
    extensionHost,
  });
}

test("a blocking decision stops the tool and records an error result", async (context) => {
  const tools = new ToolRegistry();
  const { tool, calls } = echo();
  tools.register(tool);
  const seen: string[] = [];
  const session = await open(context, scripted([callEcho("c1", { value: 1 }), done]), tools, {
    activate: () => undefined,
    dispose: () => undefined,
    beforeToolCall: (call) => {
      seen.push(call.name);
      return { block: true, reason: "policy says no" };
    },
  });
  const result = await session.runTurn([{ type: "text", text: "go" }]);
  assert.deepEqual(seen, ["echo"]);
  assert.deepEqual(calls, []);
  const toolResult = result.events.find((event) => event.type === "tool.result");
  assert.ok(toolResult && toolResult.type === "tool.result");
  assert.equal(toolResult.payload.isError, true);
  assert.match(JSON.stringify(toolResult.payload.content), /blocked: policy says no/);
  await session.dispose();
});

test("a throwing gate fails closed", async (context) => {
  const tools = new ToolRegistry();
  const { tool, calls } = echo();
  tools.register(tool);
  const session = await open(context, scripted([callEcho("c1", { value: 1 }), done]), tools, {
    activate: () => undefined,
    dispose: () => undefined,
    beforeToolCall: async () => {
      throw new Error("gate exploded");
    },
  });
  const result = await session.runTurn([{ type: "text", text: "go" }]);
  assert.deepEqual(calls, []);
  const toolResult = result.events.find((event) => event.type === "tool.result");
  assert.ok(toolResult && toolResult.type === "tool.result");
  assert.equal(toolResult.payload.isError, true);
  assert.match(JSON.stringify(toolResult.payload.content), /gate exploded/);
  await session.dispose();
});

test("an allowing gate lets the tool run and the observer sees durable events", async (context) => {
  const tools = new ToolRegistry();
  const { tool, calls } = echo();
  tools.register(tool);
  const observed: CanonicalEvent[] = [];
  const session = await open(context, scripted([callEcho("c1", { value: 2 }), done]), tools, {
    activate: () => undefined,
    dispose: () => undefined,
    beforeToolCall: () => undefined,
    observe: (event) => observed.push(event),
  });
  await session.runTurn([{ type: "text", text: "go" }]);
  assert.deepEqual(calls, [{ value: 2 }]);
  const types = observed.map((event) => event.type);
  assert.ok(types.includes("tool.call"));
  assert.ok(types.includes("tool.result"));
  assert.ok(types.indexOf("tool.call") < types.indexOf("tool.result"));
  await session.dispose();
});

test("tool input and result mutations chain before canonical persistence", async (context) => {
  const tools = new ToolRegistry();
  const { tool, calls } = echo();
  tools.register(tool);
  const session = await open(context, scripted([callEcho("c1", { value: 1 }), done]), tools, {
    activate: () => undefined,
    dispose: () => undefined,
    beforeToolCall: (call) => ({ input: { ...call.input, value: 2 } }),
    afterToolCall: () => ({
      content: [{ type: "text", text: "rewritten" }],
      isError: false,
    }),
  });
  const result = await session.runTurn([{ type: "text", text: "go" }]);
  assert.deepEqual(calls, [{ value: 2 }]);
  const call = result.events.find((event) => event.type === "tool.call");
  const toolResult = result.events.find((event) => event.type === "tool.result");
  assert.deepEqual(call?.type === "tool.call" ? call.payload.input : undefined, { value: 2 });
  assert.deepEqual(toolResult?.type === "tool.result" ? toolResult.payload.content : undefined, [
    { type: "text", text: "rewritten" },
  ]);
  await session.dispose();
});

test("extension tools publish bounded progress to lifecycle observers", async (context) => {
  const tools = new ToolRegistry();
  tools.register({
    name: "progress",
    description: "Progress",
    inputSchema: { type: "object" },
    execute: async (_input, _signal, execution) => {
      execution?.reportProgress?.({ percent: 50 });
      return { content: [], isError: false };
    },
  });
  const progress: unknown[] = [];
  const session = await open(
    context,
    scripted([
      [
        { type: "tool_call", callId: "c1", name: "progress", input: {} },
        { type: "completed", stopReason: "tool_use", usage },
      ],
      done,
    ]),
    tools,
    {
      activate: () => undefined,
      dispose: () => undefined,
      observeActivity: (frame) => {
        if (frame.type === "tool_progress") progress.push(frame.progress);
      },
    },
  );
  await session.runTurn([{ type: "text", text: "go" }]);
  assert.deepEqual(progress, [{ percent: 50 }]);
  await session.dispose();
});

test("extension context is canonical and restored for provider requests", async (context) => {
  const tools = new ToolRegistry();
  let system: string | undefined;
  const port: ModelPort = {
    stream(request) {
      system = request.system;
      return (async function* () {
        yield* done;
      })();
    },
  };
  const session = await open(context, port, tools, {
    activate: () => undefined,
    dispose: () => undefined,
    contributeContext: (input) => [
      {
        extensionId: "context",
        source: input.phase,
        content: `${input.phase} context`,
        ...(input.phase === "request" ? { target: "system" as const } : {}),
      },
    ],
  });
  const result = await session.runTurn([{ type: "text", text: "go" }]);
  assert.deepEqual(
    result.events
      .filter((event) => event.type === "context.extension")
      .map((event) => (event.type === "context.extension" ? event.payload.source : "")),
    ["agent", "request"],
  );
  assert.equal(system, "request context");
  await session.dispose();
});

test("composeExtensionHosts orders lifecycle and returns the first block", async () => {
  const trace: string[] = [];
  const host = (name: string, decision?: { block: true; reason: string }): ExtensionHost => ({
    activate: () => {
      trace.push(`${name}:activate`);
    },
    dispose: () => {
      trace.push(`${name}:dispose`);
    },
    beforeToolCall: () => {
      trace.push(`${name}:gate`);
      return decision;
    },
    observe: () => {
      trace.push(`${name}:observe`);
    },
  });
  const composed = composeExtensionHosts([
    host("a"),
    host("b", { block: true, reason: "b" }),
    host("c"),
  ]);
  await composed.activate();
  const decision = await composed.beforeToolCall?.(
    { callId: "1", name: "echo", input: {} },
    new AbortController().signal,
  );
  assert.deepEqual(decision, { block: true, reason: "b" });
  composed.observe?.({} as CanonicalEvent);
  await composed.dispose();
  assert.deepEqual(trace, [
    "a:activate",
    "b:activate",
    "c:activate",
    "a:gate",
    "b:gate",
    "a:observe",
    "b:observe",
    "c:observe",
    "c:dispose",
    "b:dispose",
    "a:dispose",
  ]);
});

function say(text: string): readonly ModelStreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "completed", stopReason: "stop", usage },
  ];
}

async function openWithCompaction(
  context: TestContext,
  port: ModelPort,
  extensionHost: ExtensionHost,
  options: {
    compaction?: { reserveTokens: number; keepRecentTokens: number; enabled?: boolean };
    modelContextWindow?: number;
  } = {},
): Promise<AgentSession> {
  const directory = await mkdtemp(join(tmpdir(), "axl-extension-command-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return AgentSession.open(join(directory, "session.jsonl"), sessionId, {
    model: port,
    tools: new ToolRegistry(),
    cwd: "/workspace",
    extensionHost,
    ...options,
  });
}

test("an extension can supply the compaction summary and the model is not asked", async (context) => {
  const seen: { name: string; source: string; args: JsonObject }[] = [];
  const port = scripted([say("old answer"), say("recent answer"), say("after")]);
  const session = await openWithCompaction(
    context,
    port,
    {
      activate: () => undefined,
      dispose: () => undefined,
      beforeCommand: (command) => {
        seen.push({ name: command.name, source: command.source, args: command.args });
        return { args: { summary: "## Goal\nExtension summary" } };
      },
    },
    { compaction: { keepRecentTokens: 7, reserveTokens: 154 } },
  );
  await session.runTurn([{ type: "text", text: "old prompt" }]);
  await session.runTurn([{ type: "text", text: "recent prompt" }]);
  const compacted = await session.compact("focus", undefined, undefined, "model");
  assert.equal(compacted.payload.summary, "## Goal\nExtension summary");
  assert.deepEqual(compacted.payload.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.name, "compact");
  assert.equal(seen[0]?.source, "model");
  assert.equal(seen[0]?.args.reason, "manual");
  assert.equal(seen[0]?.args.instructions, "focus");
  assert.match(String(seen[0]?.args.transcript), /old prompt/);
  // Only the two conversational turns hit the model; no summariser request followed.
  await session.runTurn([{ type: "text", text: "next" }]);
  await session.dispose();
});

test("a blocked manual compaction throws CommandBlockedError before any compaction event", async (context) => {
  const port = scripted([say("old answer"), say("recent answer")]);
  const session = await openWithCompaction(
    context,
    port,
    {
      activate: () => undefined,
      dispose: () => undefined,
      beforeCommand: (command) =>
        command.name === "compact" ? { block: true, reason: "not now" } : undefined,
    },
    { compaction: { keepRecentTokens: 7, reserveTokens: 154 } },
  );
  await session.runTurn([{ type: "text", text: "old prompt" }]);
  await session.runTurn([{ type: "text", text: "recent prompt" }]);
  await assert.rejects(
    session.compact(),
    (error: unknown) =>
      error instanceof CommandBlockedError &&
      error.command === "compact" &&
      error.reason === "not now",
  );
  const events = (await session.log.read()).events;
  assert.equal(
    events.some((event) => event.type === "compaction.started"),
    false,
  );
  await session.dispose();
});

test("automatic compaction reaches the hook with source automatic", async (context) => {
  const sources: string[] = [];
  const port = scripted([say("old answer"), say("recent answer")]);
  const session = await openWithCompaction(
    context,
    port,
    {
      activate: () => undefined,
      dispose: () => undefined,
      beforeCommand: (command) => {
        sources.push(command.source);
        return { args: { summary: "## Goal\nKept by extension" } };
      },
    },
    {
      compaction: { enabled: true, reserveTokens: 8, keepRecentTokens: 1 },
      modelContextWindow: 32,
    },
  );
  await session.runTurn([{ type: "text", text: "old prompt" }]);
  await session.runTurn([{ type: "text", text: "x".repeat(80) }]);
  assert.deepEqual(sources, ["automatic"]);
  const events = (await session.log.read()).events;
  const compacted = events.find((event) => event.type === "context.compacted");
  assert.ok(compacted && compacted.type === "context.compacted");
  assert.equal(compacted.payload.reason, "threshold");
  assert.match(compacted.payload.summary, /Kept by extension/);
  await session.dispose();
});

test("interceptCommand chains argument replacements across hosts and fails closed", async () => {
  const host = (name: string, transform?: (args: JsonObject) => JsonObject): ExtensionHost => ({
    activate: () => undefined,
    dispose: () => undefined,
    beforeCommand: (command) =>
      transform === undefined ? undefined : { args: { ...transform(command.args), via: name } },
  });
  const composed = composeExtensionHosts([
    host("a", (args) => ({ ...args, title: `${String(args.title)}-a` })),
    host("b"),
    host("c", (args) => ({ ...args, title: `${String(args.title)}-c` })),
  ]);
  const signal = new AbortController().signal;
  assert.deepEqual(
    await interceptCommand(
      composed,
      { name: "rename", source: "client", args: { title: "t" } },
      signal,
    ),
    { title: "t-a-c", via: "c" },
  );
  const untouched = { title: "t" };
  assert.equal(
    await interceptCommand(
      composeExtensionHosts([host("a"), host("b")]),
      { name: "rename", source: "client", args: untouched },
      signal,
    ),
    untouched,
  );
  await assert.rejects(
    interceptCommand(
      {
        activate: () => undefined,
        dispose: () => undefined,
        beforeCommand: () => {
          throw new Error("gate crashed");
        },
      },
      { name: "reload", source: "client", args: {} },
      signal,
    ),
    (error: unknown) => error instanceof CommandBlockedError && /gate crashed/.test(error.reason),
  );
});
