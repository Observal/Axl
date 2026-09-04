// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  EVENT_FORMAT_VERSION,
  type JsonObject,
  type ModelStreamEvent,
  parseEvent,
  parseOperationId,
  parseSessionId,
  type SessionActivityFrame,
  type Usage,
} from "@axl/protocol";

import {
  AgentSession,
  type KernelTool,
  type ModelPort,
  type ModelTurnRequest,
  messagesFromLineage,
  OperationConflictError,
  SessionTree,
  ToolRegistry,
  verifyToolCallIntegrity,
} from "../src/index.ts";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
const usage: Usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

interface ScriptedPort extends ModelPort {
  readonly requests: ModelTurnRequest[];
}

function makePort(responses: readonly (readonly ModelStreamEvent[])[]): ScriptedPort {
  const remaining = [...responses];
  const requests: ModelTurnRequest[] = [];
  return {
    requests,
    stream(request) {
      requests.push(request);
      const response = remaining.shift();
      if (response === undefined) throw new Error("scripted port has no response left");
      return (async function* () {
        for (const event of response) {
          if (request.signal?.aborted) {
            yield { type: "aborted" } as const;
            return;
          }
          yield event;
        }
      })();
    },
  };
}

function echoTool(): { tool: KernelTool; calls: JsonObject[] } {
  const calls: JsonObject[] = [];
  return {
    calls,
    tool: {
      name: "echo",
      description: "Echo the input back",
      inputSchema: { type: "object" },
      execute: (input) => {
        calls.push(input);
        return Promise.resolve({
          content: [{ type: "text", text: `echo:${JSON.stringify(input)}` }],
          isError: false,
        });
      },
    },
  };
}

async function makeSession(
  context: TestContext,
  port: ModelPort,
  tools = new ToolRegistry(),
  options: {
    system?: string;
    maxModelCallsPerTurn?: number;
    compaction?: { keepRecentTokens?: number; maxOutputTokens?: number };
    onActivity?: (frame: SessionActivityFrame) => void;
  } = {},
): Promise<{ session: AgentSession; path: string; tools: ToolRegistry }> {
  const directory = await mkdtemp(join(tmpdir(), "axl-agent-session-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.jsonl");
  const session = await AgentSession.open(path, sessionId, {
    model: port,
    tools,
    cwd: "/workspace",
    ...options,
  });
  return { session, path, tools };
}

function say(text: string): readonly ModelStreamEvent[] {
  return [
    { type: "thinking_delta", text: "hm " },
    { type: "thinking_delta", text: "ok" },
    { type: "text_delta", text },
    { type: "completed", stopReason: "stop", usage },
  ];
}

function callTool(callId: string, input: JsonObject): readonly ModelStreamEvent[] {
  return [
    { type: "tool_call", callId, name: "echo", input },
    { type: "completed", stopReason: "tool_use", usage },
  ];
}

test("runs a plain turn and persists the canonical events", async (context) => {
  const port = makePort([say("hello")]);
  const { session } = await makeSession(context, port, new ToolRegistry(), {
    system: "You are Axl.",
  });

  const result = await session.runTurn([{ type: "text", text: "hi" }]);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["user.message", "assistant.message"],
  );
  const assistant = result.events[1];
  if (assistant?.type === "assistant.message") {
    assert.deepEqual(assistant.payload.content, [
      { type: "thinking", text: "hm ok" },
      { type: "text", text: "hello" },
    ]);
    assert.deepEqual(assistant.payload.usage, usage);
  }
  assert.equal(port.requests[0]?.system, "You are Axl.");
  assert.equal(port.requests[0]?.messages.length, 1);

  const reread = await session.log.read();
  const tree = SessionTree.fromEvents(sessionId, reread.events);
  assert.equal(tree.size, 3); // session.created + 2
  assert.equal(reread.events[0]?.type, "session.created");
  await session.dispose();
});

test("manual compaction replaces old model context without deleting history", async (context) => {
  const port = makePort([
    say("old answer"),
    say("recent answer"),
    say("## Goal\nContinue the test"),
    say("new answer"),
    say("## Goal\nContinue the updated test"),
  ]);
  const { session, path } = await makeSession(context, port, new ToolRegistry(), {
    compaction: { keepRecentTokens: 7, maxOutputTokens: 123 },
  });
  await session.runTurn([{ type: "text", text: "old prompt" }]);
  await session.runTurn([{ type: "text", text: "recent prompt" }]);

  const compacted = await session.compact("Focus on exact test state");
  assert.equal(compacted.payload.summary, "## Goal\nContinue the test");
  assert.deepEqual(compacted.payload.usage, usage);
  assert.equal(compacted.payload.replacedEventIds.length, 2);
  assert.deepEqual(port.requests[2]?.tools, []);
  assert.equal(port.requests[2]?.toolChoice, "none");
  assert.equal(port.requests[2]?.maxOutputTokens, 123);
  const summaryPrompt = port.requests[2]?.messages[0];
  assert.match(
    summaryPrompt?.role === "user" && summaryPrompt.content[0]?.type === "text"
      ? summaryPrompt.content[0].text
      : "",
    /Focus on exact test state/,
  );

  let stored = (await session.log.read()).events;
  assert.equal(stored.filter((event) => event.type === "user.message").length, 2);
  assert.deepEqual(
    messagesFromLineage(stored).map((message) => message.role),
    ["user", "user", "assistant"],
  );

  await session.runTurn([{ type: "text", text: "new prompt" }]);
  const compactedAgain = await session.compact();
  assert.ok(compactedAgain.payload.replacedEventIds.includes(compacted.id));
  const updatePrompt = port.requests[4]?.messages[0];
  assert.match(
    updatePrompt?.role === "user" && updatePrompt.content[0]?.type === "text"
      ? updatePrompt.content[0].text
      : "",
    /<previous-summary>\n## Goal\nContinue the test/,
  );
  stored = (await session.log.read()).events;
  assert.equal(stored.filter((event) => event.type === "user.message").length, 3);
  await session.dispose();

  const resumedPort = makePort([say("continued")]);
  const resumed = await AgentSession.open(path, sessionId, {
    model: resumedPort,
    tools: new ToolRegistry(),
    cwd: "/workspace",
  });
  await resumed.runTurn([{ type: "text", text: "continue" }]);
  const resumedMessages = resumedPort.requests[0]?.messages ?? [];
  assert.deepEqual(
    resumedMessages.map((message) => message.role),
    ["user", "user", "assistant", "user"],
  );
  const summary = resumedMessages[0];
  assert.match(
    summary?.role === "user" && summary.content[0]?.type === "text" ? summary.content[0].text : "",
    /Continue the updated test/,
  );
  await resumed.dispose();
});

test("failed compaction leaves the original context active", async (context) => {
  const port = makePort([
    say("old answer"),
    say("recent answer"),
    [
      { type: "text_delta", text: "partial summary" },
      { type: "completed", stopReason: "length", usage },
    ],
    say("continued"),
  ]);
  const { session } = await makeSession(context, port, new ToolRegistry(), {
    compaction: { keepRecentTokens: 7 },
  });
  await session.runTurn([{ type: "text", text: "old prompt" }]);
  await session.runTurn([{ type: "text", text: "recent prompt" }]);

  await assert.rejects(session.compact(), /ended with length/);
  assert.equal(
    (await session.log.read()).events.some((event) => event.type === "context.compacted"),
    false,
  );
  await session.runTurn([{ type: "text", text: "continue" }]);
  assert.deepEqual(
    port.requests[3]?.messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant", "user"],
  );
  await session.dispose();
});

test("publishes ordered deltas and clears them after the canonical assistant event", async (context) => {
  const frames: SessionActivityFrame[] = [];
  const port = makePort([say("hello")]);
  const { session } = await makeSession(context, port, new ToolRegistry(), {
    onActivity: (frame) => frames.push(frame),
  });

  await session.runTurn([{ type: "text", text: "stream" }]);
  assert.deepEqual(
    frames.map((frame) => [frame.sequence, frame.type]),
    [
      [1, "thinking_delta"],
      [2, "thinking_delta"],
      [3, "text_delta"],
      [4, "clear"],
    ],
  );
  assert.equal(new Set(frames.map((frame) => frame.operationId)).size, 1);
  await session.dispose();
});

test("dispatches tool calls, pairs results, and feeds them back", async (context) => {
  const port = makePort([callTool("call-1", { value: 1 }), say("done")]);
  const registry = new ToolRegistry();
  const { tool, calls } = echoTool();
  registry.register(tool);
  const { session } = await makeSession(context, port, registry);

  const result = await session.runTurn([{ type: "text", text: "use the tool" }]);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["user.message", "assistant.message", "tool.call", "tool.result", "assistant.message"],
  );
  assert.deepEqual(calls, [{ value: 1 }]);

  // The second model call sees the assistant tool call and the tool result.
  const second = port.requests[1];
  assert.equal(second?.messages.length, 3);
  const assistantMessage = second?.messages[1];
  assert.equal(assistantMessage?.role === "assistant" && assistantMessage.toolCalls?.length, 1);
  const toolMessage = second?.messages[2];
  assert.equal(toolMessage?.role === "tool" && toolMessage.callId, "call-1");

  // Pairing holds under the kernel's own integrity check.
  verifyToolCallIntegrity(SessionTree.fromEvents(sessionId, (await session.log.read()).events));
  // The single operation owns every event of the turn.
  const operationIds = new Set(result.events.map((event) => event.operationId));
  assert.equal(operationIds.size, 1);
});

test("steering waits for the complete tool batch and follow-ups run afterward", async (context) => {
  let releaseFirst = (): void => undefined;
  let markFirstStarted = (): void => undefined;
  const firstStarted = new Promise<void>((resolvePromise) => {
    markFirstStarted = resolvePromise;
  });
  const firstGate = new Promise<void>((resolvePromise) => {
    releaseFirst = resolvePromise;
  });
  const executed: string[] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "Echo the input back",
    inputSchema: { type: "object" },
    async execute(input) {
      const value = String(input.value);
      if (value === "first") {
        markFirstStarted();
        await firstGate;
      }
      executed.push(value);
      return { content: [{ type: "text", text: value }], isError: false };
    },
  });
  const port = makePort([
    [
      { type: "tool_call", callId: "call-1", name: "echo", input: { value: "first" } },
      { type: "tool_call", callId: "call-2", name: "echo", input: { value: "second" } },
      { type: "completed", stopReason: "tool_use", usage },
    ],
    say("steered"),
    say("followed once"),
    say("followed twice"),
  ]);
  const { session } = await makeSession(context, port, registry);

  const running = session.runTurn([{ type: "text", text: "start" }]);
  await firstStarted;
  session.steer([{ type: "text", text: "adjust" }]);
  session.followUp([{ type: "text", text: "then summarize" }]);
  session.followUp([{ type: "text", text: "then verify" }]);
  releaseFirst();

  const result = await running;
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(executed, ["first", "second"]);
  assert.deepEqual(
    port.requests.map((request) => {
      const lastUser = request.messages.findLast((message) => message.role === "user");
      return lastUser?.content[0]?.type === "text" ? lastUser.content[0].text : undefined;
    }),
    ["start", "adjust", "then summarize", "then verify"],
  );
  assert.deepEqual(
    result.events
      .filter((event) => event.type === "user.message")
      .map((event) =>
        event.type === "user.message" && event.payload.content[0]?.type === "text"
          ? event.payload.content[0].text
          : undefined,
      ),
    ["start", "adjust", "then summarize", "then verify"],
  );
  assert.throws(() => session.steer([{ type: "text", text: "too late" }]), /No active/);
  assert.throws(() => session.followUp([{ type: "text", text: "too late" }]), /No active/);
  await session.dispose();
});

test("split-turn compaction keeps tool calls paired with their results", async (context) => {
  const port = makePort([callTool("call-1", { value: 1 }), say("done"), say("summary")]);
  const registry = new ToolRegistry();
  registry.register(echoTool().tool);
  const { session } = await makeSession(context, port, registry, {
    compaction: { keepRecentTokens: 1 },
  });

  await session.runTurn([{ type: "text", text: "use the tool" }]);
  const compacted = await session.compact();
  const events = (await session.log.read()).events;
  assert.deepEqual(
    compacted.payload.replacedEventIds.map((id) => events.find((event) => event.id === id)?.type),
    ["user.message", "assistant.message", "tool.call", "tool.result"],
  );
  assert.deepEqual(
    messagesFromLineage(events).map((message) => message.role),
    ["user", "assistant"],
  );
  await session.dispose();
});

test("an unregistered tool yields an error result, not a crash", async (context) => {
  const port = makePort([
    [
      { type: "tool_call", callId: "call-1", name: "missing", input: {} },
      { type: "completed", stopReason: "tool_use", usage },
    ],
    say("recovered"),
  ]);
  const { session } = await makeSession(context, port);

  const result = await session.runTurn([{ type: "text", text: "go" }]);
  assert.equal(result.stopReason, "stop");
  const toolResult = result.events.find((event) => event.type === "tool.result");
  if (toolResult?.type === "tool.result") {
    assert.equal(toolResult.payload.isError, true);
    assert.match(
      toolResult.payload.content[0]?.type === "text" ? toolResult.payload.content[0].text : "",
      /not registered/,
    );
  }
});

test("a throwing tool records an error result and the loop continues", async (context) => {
  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "always fails",
    inputSchema: {},
    execute: () => Promise.reject(new Error("disk on fire")),
  });
  const port = makePort([callTool("call-1", {}), say("noted")]);
  const { session } = await makeSession(context, port, registry);

  const result = await session.runTurn([{ type: "text", text: "go" }]);
  const toolResult = result.events.find((event) => event.type === "tool.result");
  assert.equal(toolResult?.type === "tool.result" && toolResult.payload.isError, true);
  assert.equal(result.stopReason, "stop");
});

test("model failures land as an error assistant message without corrupting the log", async (context) => {
  const failing: ModelPort = {
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("connection reset")),
      }),
    }),
  };
  const { session, path } = await makeSession(context, failing);
  const result = await session.runTurn([{ type: "text", text: "hi" }]);
  assert.equal(result.stopReason, "error");
  const assistant = result.events[1];
  if (assistant?.type === "assistant.message") {
    assert.match(assistant.payload.errorMessage ?? "", /connection reset/);
  }
  // Log remains valid and resumable.
  const reopened = await AgentSession.open(path, sessionId, {
    model: failing,
    tools: new ToolRegistry(),
    cwd: "/workspace",
  });
  await reopened.dispose();
});

test("a silently truncated stream becomes a loud error terminal", async (context) => {
  const truncated: ModelPort = {
    stream: async function* () {
      yield { type: "text_delta", text: "cut " } as const;
    },
  };
  const { session } = await makeSession(context, truncated);
  const result = await session.runTurn([{ type: "text", text: "hi" }]);
  assert.equal(result.stopReason, "error");
  const assistant = result.events[1];
  if (assistant?.type === "assistant.message") {
    assert.match(assistant.payload.errorMessage ?? "", /without a terminal event/);
    assert.deepEqual(assistant.payload.content, [{ type: "text", text: "cut " }]);
  }
});

test("tool_use without a tool call stops loudly", async (context) => {
  const port = makePort([[{ type: "completed", stopReason: "tool_use", usage }]]);
  const { session } = await makeSession(context, port);
  const result = await session.runTurn([{ type: "text", text: "broken response" }]);
  assert.equal(result.stopReason, "error");
  assert.equal(result.events.at(-1)?.type, "session.error");
  await session.dispose();
});

test("interrupting during model output records an aborted turn cleanly", async (context) => {
  const controller = new AbortController();
  const port: ModelPort = {
    stream: async function* () {
      yield { type: "text_delta", text: "partial" } as const;
      controller.abort();
      throw new Error("socket closed mid-read");
    },
  };
  const { session, path } = await makeSession(context, port);
  const result = await session.runTurn([{ type: "text", text: "hi" }], controller.signal);
  assert.equal(result.stopReason, "aborted");

  const reread = await session.log.read();
  SessionTree.fromEvents(sessionId, reread.events); // no corruption
  assert.equal(path.length > 0, true);
});

test("interrupting during a tool stops after the paired result", async (context) => {
  const controller = new AbortController();
  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "aborts the session mid-flight",
    inputSchema: {},
    execute: () => {
      controller.abort();
      return Promise.resolve({ content: [{ type: "text", text: "done" }], isError: false });
    },
  });
  const port = makePort([callTool("call-1", {})]); // a second model call would throw
  const { session } = await makeSession(context, port, registry);

  const result = await session.runTurn([{ type: "text", text: "go" }], controller.signal);
  assert.equal(result.stopReason, "aborted");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["user.message", "assistant.message", "tool.call", "tool.result"],
  );
  verifyToolCallIntegrity(SessionTree.fromEvents(sessionId, (await session.log.read()).events));
});

test("only one operation may mutate the branch at a time", async (context) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const port: ModelPort = {
    stream: async function* () {
      await gate;
      yield { type: "completed", stopReason: "stop", usage } as const;
    },
  };
  const { session } = await makeSession(context, port);

  const first = session.runTurn([{ type: "text", text: "one" }]);
  await assert.rejects(session.runTurn([{ type: "text", text: "two" }]), OperationConflictError);
  release?.();
  assert.equal((await first).stopReason, "stop");
});

test("reconstructs interleaved results from one multi-tool assistant turn", () => {
  const operationId = parseOperationId("00000000-0000-4000-8000-000000000020");
  const events = [
    parseEvent({
      version: EVENT_FORMAT_VERSION,
      id: "00000000-0000-4000-8000-000000000021",
      sessionId,
      operationId,
      parentId: null,
      timestamp: 1,
      type: "assistant.message",
      payload: { content: [], stopReason: "tool_use" },
    }),
    parseEvent({
      version: EVENT_FORMAT_VERSION,
      id: "00000000-0000-4000-8000-000000000022",
      sessionId,
      operationId,
      parentId: "00000000-0000-4000-8000-000000000021",
      timestamp: 2,
      type: "tool.call",
      payload: { callId: "first", name: "echo", input: { text: "one" } },
    }),
    parseEvent({
      version: EVENT_FORMAT_VERSION,
      id: "00000000-0000-4000-8000-000000000023",
      sessionId,
      operationId,
      parentId: "00000000-0000-4000-8000-000000000022",
      timestamp: 3,
      type: "tool.result",
      payload: {
        callId: "first",
        name: "echo",
        content: [{ type: "text", text: "one" }],
        isError: false,
      },
    }),
    parseEvent({
      version: EVENT_FORMAT_VERSION,
      id: "00000000-0000-4000-8000-000000000024",
      sessionId,
      operationId,
      parentId: "00000000-0000-4000-8000-000000000023",
      timestamp: 4,
      type: "tool.call",
      payload: { callId: "second", name: "echo", input: { text: "two" } },
    }),
    parseEvent({
      version: EVENT_FORMAT_VERSION,
      id: "00000000-0000-4000-8000-000000000025",
      sessionId,
      operationId,
      parentId: "00000000-0000-4000-8000-000000000024",
      timestamp: 5,
      type: "tool.result",
      payload: {
        callId: "second",
        name: "echo",
        content: [{ type: "text", text: "two" }],
        isError: false,
      },
    }),
  ];
  const messages = messagesFromLineage(events);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["assistant", "tool", "tool"],
  );
  const assistant = messages[0];
  assert.equal(assistant?.role, "assistant");
  if (assistant?.role === "assistant") assert.equal(assistant.toolCalls?.length, 2);
});

test("reopening after daemon loss closes an unanswered tool call", async (context) => {
  const { session, path } = await makeSession(context, makePort([]));
  const before = (await session.log.read()).events;
  const parent = before.at(-1)?.id ?? null;
  const operationId = parseOperationId("00000000-0000-4000-8000-000000000010");
  const assistant = parseEvent({
    version: EVENT_FORMAT_VERSION,
    id: "00000000-0000-4000-8000-000000000011",
    sessionId,
    operationId,
    parentId: parent,
    timestamp: 10,
    type: "assistant.message",
    payload: { content: [], stopReason: "tool_use" },
  });
  const call = parseEvent({
    version: EVENT_FORMAT_VERSION,
    id: "00000000-0000-4000-8000-000000000012",
    sessionId,
    operationId,
    parentId: assistant.id,
    timestamp: 11,
    type: "tool.call",
    payload: { callId: "interrupted-call", name: "echo", input: { text: "hello" } },
  });
  const interaction = parseEvent({
    version: EVENT_FORMAT_VERSION,
    id: "00000000-0000-4000-8000-000000000013",
    sessionId,
    operationId,
    parentId: call.id,
    timestamp: 12,
    type: "interaction.requested",
    payload: {
      interactionId: "interrupted-interaction",
      kind: "mcp_tool",
      source: "fixture",
      message: "Approve?",
    },
  });
  await session.log.append(assistant);
  await session.log.append(call);
  await session.log.append(interaction);
  await session.dispose();

  const port = makePort([say("continued")]);
  const reopened = await AgentSession.open(path, sessionId, {
    model: port,
    tools: new ToolRegistry(),
    cwd: "/workspace",
  });
  const recoveredEvents = (await reopened.log.read()).events;
  const resolvedInteraction = recoveredEvents.find(
    (event) =>
      event.type === "interaction.resolved" &&
      event.payload.interactionId === "interrupted-interaction",
  );
  assert.ok(resolvedInteraction);
  if (resolvedInteraction.type === "interaction.resolved") {
    assert.equal(resolvedInteraction.payload.action, "cancel");
  }
  const recovered = recoveredEvents.find(
    (event) => event.type === "tool.result" && event.payload.callId === "interrupted-call",
  );
  assert.ok(recovered);
  if (recovered.type === "tool.result") {
    assert.equal(recovered.payload.isError, true);
    assert.deepEqual(recovered.payload.details, {
      endedBy: "abort",
      reason: "daemon_restart",
    });
  }
  await reopened.runTurn([{ type: "text", text: "continue" }]);
  assert.equal(port.requests.length, 1);
  await reopened.dispose();
});

test("reopening a session projects history and appends no duplicate root", async (context) => {
  const port = makePort([say("first"), say("second")]);
  const { session, path } = await makeSession(context, port);
  await session.runTurn([{ type: "text", text: "one" }]);
  await session.dispose();

  const reopened = await AgentSession.open(path, sessionId, {
    model: port,
    tools: new ToolRegistry(),
    cwd: "/workspace",
  });
  await reopened.runTurn([{ type: "text", text: "two" }]);
  const events = (await reopened.log.read()).events;
  assert.equal(events.filter((event) => event.type === "session.created").length, 1);

  // The second turn's model call saw the first turn's history.
  const request = port.requests[1];
  assert.equal(request?.messages.length, 3);
  await reopened.dispose();
});

test("the turn model-call limit fails loudly", async (context) => {
  const registry = new ToolRegistry();
  const { tool } = echoTool();
  registry.register(tool);
  const endless = makePort([
    callTool("call-1", {}),
    callTool("call-2", {}),
    callTool("call-3", {}),
  ]);
  const { session } = await makeSession(context, endless, registry, { maxModelCallsPerTurn: 2 });

  const result = await session.runTurn([{ type: "text", text: "loop forever" }]);
  assert.equal(result.stopReason, "error");
  const last = result.events[result.events.length - 1];
  assert.equal(last?.type, "session.error");
  if (last?.type === "session.error") {
    assert.equal(last.payload.code, "turn_model_call_limit");
  }
});

test("the extension host seam activates and disposes with the session", async (context) => {
  const lifecycle: string[] = [];
  const port = makePort([]);
  const directory = await mkdtemp(join(tmpdir(), "axl-agent-session-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const session = await AgentSession.open(join(directory, "session.jsonl"), sessionId, {
    model: port,
    tools: new ToolRegistry(),
    cwd: "/workspace",
    extensionHost: {
      activate: () => {
        lifecycle.push("activate");
      },
      dispose: () => {
        lifecycle.push("dispose");
      },
    },
  });
  await session.dispose();
  assert.deepEqual(lifecycle, ["activate", "dispose"]);
});
