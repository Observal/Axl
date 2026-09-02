// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { type ModelPort, ToolRegistry } from "@axl/kernel";
import type {
  CanonicalEvent,
  ModelStreamEvent,
  SessionForkResult,
  SessionSummary,
  Usage,
} from "@axl/protocol";

import {
  DaemonClient,
  AxlDaemon,
  type SessionSnapshot,
  WireClientError,
  type WireEvent,
} from "../src/index.ts";

const usage: Usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

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
): Promise<{ daemon: AxlDaemon; socketPath: string; dataDirectory: string; cwd: string }> {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    securityMode,
    runtime: () => ({ model: port, tools: new ToolRegistry(), system: "You are Axl." }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  return { daemon, socketPath, dataDirectory: join(directory, "data"), cwd: directory };
}

function types(events: readonly CanonicalEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

test("reports the daemon security mode", async (context) => {
  const sandboxed = await startDaemon(context);
  const sandboxedClient = await DaemonClient.connect(sandboxed.socketPath);
  context.after(() => sandboxedClient.close());
  assert.deepEqual(await sandboxedClient.request("daemon.info", {}), {
    securityMode: "sandboxed",
  });

  const unsafe = await startDaemon(context, replyPort(), "unsafe");
  const unsafeClient = await DaemonClient.connect(unsafe.socketPath);
  context.after(() => unsafeClient.close());
  assert.deepEqual(await unsafeClient.request("daemon.info", {}), { securityMode: "unsafe" });
});

test("creates a session, streams the live tail, and answers sends", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  const client = await DaemonClient.connect(socketPath);
  context.after(() => client.close());

  const created = (await client.request("session.create", { cwd })) as SessionSnapshot;
  assert.equal(types(created.events)[0], "session.created");

  const pushed: WireEvent[] = [];
  client.onEvent((event) => pushed.push(event));
  const { snapshot } = (await client.request("session.subscribe", {
    sessionId: created.sessionId,
  })) as { snapshot: CanonicalEvent[] };
  assert.deepEqual(types(snapshot), ["session.created"]);

  const sent = (await client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "hello" }],
  })) as { stopReason: string };
  assert.equal(sent.stopReason, "stop");
  assert.deepEqual(
    pushed.map((event) => event.event.type),
    ["user.message", "assistant.message"],
  );
  assert.equal(pushed[0]?.sessionId, created.sessionId);
});

test("a session survives daemon termination and resumes with full history", async (context) => {
  const first = await startDaemon(context);
  const client = await DaemonClient.connect(first.socketPath);
  const created = (await client.request("session.create", { cwd: first.cwd })) as SessionSnapshot;
  await client.request("session.send", {
    sessionId: created.sessionId,
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

  const reconnected = await DaemonClient.connect(first.socketPath);
  context.after(() => reconnected.close());
  const resumed = (await reconnected.request("session.resume", {
    sessionId: created.sessionId,
  })) as SessionSnapshot;
  assert.deepEqual(types(resumed.events), ["session.created", "user.message", "assistant.message"]);

  const sent = (await reconnected.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "after restart" }],
  })) as { stopReason: string };
  assert.equal(sent.stopReason, "stop");
});

test("lists, forks, clones, and resumes sessions", async (context) => {
  const first = await startDaemon(context);
  const client = await DaemonClient.connect(first.socketPath);
  const created = (await client.request("session.create", { cwd: first.cwd })) as SessionSnapshot;
  await client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "first prompt" }],
  });
  await client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "second prompt" }],
  });

  const listed = (await client.request("session.list", {})) as SessionSummary[];
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.cwd, first.cwd);
  assert.equal(listed[0]?.userMessageCount, 2);
  assert.equal(listed[0]?.firstUserMessage, "first prompt");
  assert.equal(listed[0]?.lastUserMessage, "second prompt");

  const source = (await client.request("session.resume", {
    sessionId: created.sessionId,
  })) as SessionSnapshot;
  const secondMessage = source.events.filter((event) => event.type === "user.message")[1];
  assert.ok(secondMessage);
  const forked = (await client.request("session.fork", {
    sessionId: created.sessionId,
    fromEventId: secondMessage.id,
  })) as SessionForkResult;
  assert.equal(forked.selectedText, "second prompt");
  assert.equal(forked.events[0]?.type, "session.created");
  assert.equal(
    forked.events[0]?.type === "session.created" && forked.events[0].payload.parentSessionId,
    created.sessionId,
  );
  assert.deepEqual(
    forked.events
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
  assert.deepEqual(
    cloned.events
      .filter((event) => event.type === "user.message")
      .map((event) => {
        const content = event.type === "user.message" ? event.payload.content[0] : undefined;
        return content?.type === "text" ? content.text : undefined;
      }),
    ["first prompt", "second prompt"],
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
  const resumedClient = await DaemonClient.connect(first.socketPath);
  context.after(() => resumedClient.close());
  const resumedFork = (await resumedClient.request("session.resume", {
    sessionId: forked.sessionId,
  })) as SessionSnapshot;
  const resumedClone = (await resumedClient.request("session.resume", {
    sessionId: cloned.sessionId,
  })) as SessionSnapshot;
  assert.equal(resumedFork.events[0]?.type, "session.created");
  assert.equal(resumedClone.events[0]?.type, "session.created");
});

test("interrupt aborts the active operation from another connection", async (context) => {
  const { socketPath, cwd } = await startDaemon(context, hangingPort());
  const sender = await DaemonClient.connect(socketPath);
  const interrupter = await DaemonClient.connect(socketPath);
  context.after(() => {
    sender.close();
    interrupter.close();
  });

  const created = (await sender.request("session.create", { cwd })) as SessionSnapshot;
  const sending = sender.request("session.send", {
    sessionId: created.sessionId,
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

test("concurrent sends conflict loudly instead of interleaving", async (context) => {
  const { socketPath, cwd } = await startDaemon(context, hangingPort());
  const client = await DaemonClient.connect(socketPath);
  context.after(() => client.close());

  const created = (await client.request("session.create", { cwd })) as SessionSnapshot;
  const first = client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "one" }],
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  await assert.rejects(
    client.request("session.send", {
      sessionId: created.sessionId,
      content: [{ type: "text", text: "two" }],
    }),
    (error) => error instanceof WireClientError && error.code === "operation_active",
  );
  await client.request("session.interrupt", { sessionId: created.sessionId });
  await first;
});

test("subscribe supports an afterEventId cursor and multiple attached clients", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  const one = await DaemonClient.connect(socketPath);
  const two = await DaemonClient.connect(socketPath);
  context.after(() => {
    one.close();
    two.close();
  });

  const created = (await one.request("session.create", { cwd })) as SessionSnapshot;
  await one.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "first" }],
  });

  const cursor = created.events[0]?.id;
  const { snapshot } = (await two.request("session.subscribe", {
    sessionId: created.sessionId,
    afterEventId: cursor,
  })) as { snapshot: CanonicalEvent[] };
  assert.deepEqual(types(snapshot), ["user.message", "assistant.message"]);

  const oneEvents: string[] = [];
  const twoEvents: string[] = [];
  one.onEvent((event) => oneEvents.push(event.event.type));
  two.onEvent((event) => twoEvents.push(event.event.type));
  await one.request("session.subscribe", { sessionId: created.sessionId });
  await one.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "second" }],
  });
  assert.deepEqual(oneEvents, ["user.message", "assistant.message"]);
  assert.deepEqual(twoEvents, ["user.message", "assistant.message"]);

  await assert.rejects(
    two.request("session.subscribe", {
      sessionId: created.sessionId,
      afterEventId: "00000000-0000-4000-8000-00000000dead",
    }),
    (error) => error instanceof WireClientError && error.code === "unknown_cursor",
  );
});

test("dispose removes the session and errors surface typed codes", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  const client = await DaemonClient.connect(socketPath);
  context.after(() => client.close());

  const created = (await client.request("session.create", { cwd })) as SessionSnapshot;
  await client.request("session.dispose", { sessionId: created.sessionId });
  await assert.rejects(
    client.request("session.send", { sessionId: created.sessionId, content: [] }),
    (error) => error instanceof WireClientError && error.code === "unknown_session",
  );

  await assert.rejects(
    client.request("session.resume", {
      sessionId: "123e4567-e89b-42d3-a456-42661417ffff",
    }),
    (error) => error instanceof WireClientError && error.code === "unknown_session",
  );

  await assert.rejects(
    client.request("bogus.method" as never, {}),
    (error) => error instanceof WireClientError && error.code === "bad_request",
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
  const client = await DaemonClient.connect(socketPath);
  context.after(() => client.close());
  const created = (await client.request("session.create", { cwd: directory })) as SessionSnapshot;
  const events: CanonicalEvent[] = [];
  client.onEvent((message) => events.push(message.event));
  await client.request("session.subscribe", { sessionId: created.sessionId });
  const sending = client.request("session.send", {
    sessionId: created.sessionId,
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
  await client.request("session.interaction.respond", {
    sessionId: created.sessionId,
    interactionId: interaction.payload.interactionId,
    action: "accept",
  });
  await sending;
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("interaction.")).map((event) => event.type),
    ["interaction.requested", "interaction.resolved"],
  );
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

  const client = await DaemonClient.connect(socketPath);
  context.after(() => client.close());
  const created = (await client.request("session.create", {
    cwd: directory,
    modelId: "gpt-5",
    thinkingLevel: "medium",
  })) as SessionSnapshot;
  const changed = (await client.request("session.configure", {
    sessionId: created.sessionId,
    modelId: "gpt-4.1",
    thinkingLevel: "high",
  })) as { events: CanonicalEvent[] };

  assert.deepEqual(configured, [
    { boundary: "session_start", model: "gpt-5", thinking: "medium" },
    { boundary: "model_switch", model: "gpt-4.1", thinking: "high" },
  ]);
  assert.deepEqual(types(changed.events), ["config.model", "config.thinking"]);
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

  const client = await DaemonClient.connect(socketPath);
  context.after(() => client.close());
  const created = (await client.request("session.create", { cwd: directory })) as SessionSnapshot;
  const pushed: string[] = [];
  client.onEvent((message) => pushed.push(message.event.type));
  await client.request("session.subscribe", { sessionId: created.sessionId });

  const reloaded = (await client.request("session.reload", { sessionId: created.sessionId })) as {
    events: CanonicalEvent[];
  };
  assert.deepEqual(boundaries, ["session_start", "reload"]);
  const dialect = reloaded.events.find((event) => event.type === "config.dialect");
  assert.equal(dialect?.type === "config.dialect" && dialect.payload.reason, "reload");
  assert.equal(pushed.includes("config.dialect"), true); // streamed to subscribers

  // The session still works after the reload, on the same log.
  const sent = (await client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "after reload" }],
  })) as { stopReason: string };
  assert.equal(sent.stopReason, "stop");
});
