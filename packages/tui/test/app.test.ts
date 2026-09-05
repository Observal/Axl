// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough as NodePassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { AxlDaemon, type SessionInteractionRequest } from "@axl/daemon";
import type { TerminalExtension } from "@axl/extension-api";
import {
  type CompactionSettings,
  type ModelPort,
  type ModelTurnRequest,
  ToolRegistry,
} from "@axl/kernel";
import type {
  CanonicalEvent,
  EventPayloadMap,
  JsonObject,
  ModelStreamEvent,
  SessionId,
  Usage,
} from "@axl/protocol";
import { subscribeSession } from "@axl/sdk";
import { connectUnixClient } from "@axl/sdk/unix";

import { AxlApp, saveClipboardImage, stripAnsi } from "../src/index.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class PassThrough extends NodePassThrough {
  isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

const usage: Usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

const port: ModelPort = {
  stream() {
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text_delta", text: "the answer" };
      yield { type: "completed", stopReason: "stop", usage };
    })();
  },
};

async function startStack(
  context: TestContext,
  model: ModelPort = port,
  makeTools: (
    interact: (
      request: SessionInteractionRequest,
      signal?: AbortSignal,
    ) => Promise<{
      action: "accept" | "decline" | "cancel";
      content?: JsonObject;
    }>,
  ) => ToolRegistry = () => new ToolRegistry(),
  sandbox?: EventPayloadMap["sandbox.configured"],
  compaction?: Partial<CompactionSettings>,
) {
  const directory = await mkdtemp(join(tmpdir(), "axl-tui-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    runtime: ({ selection, interact }) => ({
      model,
      tools: makeTools(interact),
      system: "You are Axl.",
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(compaction === undefined ? {} : { compaction }),
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
    }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  return { socketPath, directory: await realpath(directory) };
}

function captureOutput(): {
  output: PassThrough & { columns?: number; rows?: number };
  text: () => string;
} {
  const output = new PassThrough() as PassThrough & { columns?: number; rows?: number };
  output.columns = 100;
  output.rows = 24;
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return { output, text: () => text };
}

function until(predicate: () => boolean, label: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolvePromise();
      } else if (Date.now() - started > 5_000) {
        clearInterval(timer);
        rejectPromise(new Error(`timed out waiting for ${label}`));
      }
    }, 5);
  });
}

test("a full round trip: type, send, render the reply, detach, resume", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  let exited = false;

  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    onExit: () => {
      exited = true;
    },
  });

  // Snapshot rendered and the framed live editor shows metrics plus prompt.
  assert.match(text(), /◆ Axl/);
  assert.match(text(), /ready/);
  assert.match(text(), /no model selected/);

  input.write("hello axl\r");
  await until(() => text().includes("↑1 ↓1"), "canonical assistant reply");
  assert.match(text(), /│ hello axl/);
  assert.match(text(), /the answer/);
  assert.match(text(), /↑1 ↓1/);
  assert.match(text(), /tok\/s/);

  // Detach; the session persists in the daemon and resumes with history.
  input.write("\x04");
  await until(() => exited, "detach");

  const resumeInput = new PassThrough();
  const resumed = captureOutput();
  const launchDirectory = join(directory, "different-launch-directory");
  await mkdir(launchDirectory);
  const resumedApp = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input: resumeInput,
    output: resumed.output,
    cwd: launchDirectory,
    sessionId: app.sessionId,
    color: false,
  });
  assert.equal(resumedApp.sessionId, app.sessionId);
  assert.equal((resumedApp as unknown as { cwd: string }).cwd, directory);
  assert.match(resumed.text(), /│ hello axl/);
  assert.match(resumed.text(), /the answer/);
  const resumedReplyCount = (resumed.text().match(/the answer/g) ?? []).length;
  resumeInput.write("prompt after resume\r");
  await until(
    () => (resumed.text().match(/the answer/g) ?? []).length > resumedReplyCount,
    "reply after completed-session resume",
  );
  assert.match(resumed.text(), /prompt after resume/);
  resumedApp.stop();
});

test("/export writes a portable session artifact", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });
  const artifactDirectory = join(directory, "exported-session");

  input.write(`/export ${artifactDirectory}\r`);
  await until(() => text().includes("exported"), "session export");

  const manifest = JSON.parse(await readFile(join(artifactDirectory, "manifest.json"), "utf8")) as {
    sourceSessionId: string;
    sourceSha256: string;
    eventCount: number;
    blobDigests: string[];
  };
  const events = (await readFile(join(artifactDirectory, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CanonicalEvent);
  assert.equal(manifest.sourceSessionId, app.sessionId);
  assert.match(manifest.sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.eventCount, events.length);
  assert.deepEqual(manifest.blobDigests, []);
  assert.equal(events[0]?.type, "session.created");
  app.stop();
});

test("/import restores an artifact under fresh session and event IDs", async (context) => {
  const source = await startStack(context);
  const sourceInput = new PassThrough();
  const sourceOutput = captureOutput();
  const image = Buffer.alloc(32);
  image.set([0x89, 0x50, 0x4e, 0x47], 0);
  image.set(Buffer.from("IHDR"), 12);
  image.writeUInt32BE(1, 16);
  image.writeUInt32BE(1, 20);
  const imagePath = join(source.directory, "portable.png");
  await writeFile(imagePath, image);
  const sourceApp = await AxlApp.start({
    client: await connectUnixClient(source.socketPath),
    input: sourceInput,
    output: sourceOutput.output,
    cwd: source.directory,
    color: false,
    imageDisplay: "metadata",
    mediaCapabilities: { images: null },
  });
  const sourceSessionId = sourceApp.sessionId;
  const artifactDirectory = join(source.directory, "round-trip-session");

  sourceInput.write(`/attach ${imagePath}\r`);
  await until(
    () => sourceOutput.text().includes("attached portable.png"),
    "portable image attachment",
  );
  sourceInput.write("portable prompt\r");
  await until(() => sourceOutput.text().includes("↑1 ↓1"), "completed session reply before export");
  sourceInput.write(`/export ${artifactDirectory}\r`);
  await until(() => sourceOutput.text().includes("exported"), "session export before import");
  sourceApp.stop();

  const destination = await startStack(context);
  const importInput = new PassThrough();
  const importOutput = captureOutput();
  const importedApp = await AxlApp.start({
    client: await connectUnixClient(destination.socketPath),
    input: importInput,
    output: importOutput.output,
    cwd: destination.directory,
    color: false,
    imageDisplay: "metadata",
    mediaCapabilities: { images: null },
  });
  const initialSessionId = importedApp.sessionId;
  importInput.write(`/import ${artifactDirectory}\r`);
  await until(() => importedApp.sessionId !== initialSessionId, "imported session switch");

  const manifest = JSON.parse(await readFile(join(artifactDirectory, "manifest.json"), "utf8")) as {
    blobDigests: string[];
  };
  const sourceEvents = (await readFile(join(artifactDirectory, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CanonicalEvent);
  const importedEvents = (
    await readFile(
      join(destination.directory, "data", "sessions", `${importedApp.sessionId}.jsonl`),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CanonicalEvent);
  assert.notEqual(importedApp.sessionId, sourceSessionId);
  assert.equal(manifest.blobDigests.length, 1);
  assert.deepEqual(
    await readFile(join(destination.directory, "data", "blobs", manifest.blobDigests[0] as string)),
    image,
  );
  const importedPrefix = importedEvents.slice(0, sourceEvents.length);
  assert.deepEqual(
    importedPrefix.map((event) => event.type),
    sourceEvents.map((event) => event.type),
  );
  assert.equal(importedEvents[0]?.type, "session.created");
  assert.equal(importedEvents[0]?.payload.cwd, destination.directory);
  const sourceIndexes = new Map(sourceEvents.map((event, index) => [event.id, index]));
  for (const [index, event] of sourceEvents.entries()) {
    const imported = importedPrefix[index];
    assert.ok(imported);
    const parentIndex = event.parentId === null ? undefined : sourceIndexes.get(event.parentId);
    assert.equal(
      imported.parentId,
      parentIndex === undefined ? null : importedPrefix[parentIndex]?.id,
    );
  }
  const sourceEventIds = new Set(sourceEvents.map((event) => event.id));
  const sourceOperationIds = new Set(sourceEvents.flatMap((event) => event.operationId ?? []));
  assert.equal(
    importedPrefix.some((event) => sourceEventIds.has(event.id)),
    false,
  );
  assert.equal(
    importedPrefix.some(
      (event) => event.operationId !== undefined && sourceOperationIds.has(event.operationId),
    ),
    false,
  );
  importedApp.stop();
});

test("detach leaves an accepted turn running for later resume", async (context) => {
  let markStarted!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolvePromise) => {
    markStarted = resolvePromise;
  });
  const pause = new Promise<void>((resolvePromise) => {
    finish = resolvePromise;
  });
  context.after(() => finish());
  let calls = 0;
  const model: ModelPort = {
    stream() {
      calls += 1;
      const call = calls;
      if (call === 1) markStarted();
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (call === 1) await pause;
        yield {
          type: "text_delta",
          text: call === 1 ? "finished while detached" : "received resumed prompt",
        };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const { socketPath, directory } = await startStack(context, model);
  const input = new PassThrough();
  const first = captureOutput();
  let exited = false;
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output: first.output,
    cwd: directory,
    color: false,
    onExit: () => {
      exited = true;
    },
  });

  input.write("background task\r");
  await started;
  input.write("/detach\r");
  await until(() => exited, "active-session detach");

  const resumedInput = new PassThrough();
  const resumed = captureOutput();
  const resumedApp = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input: resumedInput,
    output: resumed.output,
    cwd: directory,
    color: false,
    initialResume: true,
    listResumeSessions: () =>
      Promise.resolve([
        {
          sessionId: app.sessionId,
          resumeKey: `native:${app.sessionId}`,
          cwd: directory,
          createdAt: 1,
          updatedAt: 2,
          userMessageCount: 1,
          runtime: { state: "running" },
          attachmentCount: 0,
          placementLabel: "SANDBOXED · native",
          unsafe: false,
        },
      ]),
    openResumeSession: async () => ({
      client: await connectUnixClient(socketPath),
      reconnectClient: () => connectUnixClient(socketPath),
    }),
  });
  await until(() => resumed.text().includes("Resume Session (All)"), "resume selector");
  resumedInput.write("\r");
  await until(() => resumedApp.sessionId === app.sessionId, "active session resume");
  await until(() => resumed.text().includes("Working"), "resumed working state");
  finish();
  await until(() => resumed.text().includes("finished while detached"), "detached turn result");
  resumedInput.write("continue after reconnect\r");
  await until(() => resumed.text().includes("received resumed prompt"), "resumed prompt result");
  assert.match(resumed.text(), /finished while detached/);
  assert.match(resumed.text(), /background task/);
  assert.match(resumed.text(), /continue after reconnect/);
  resumedApp.stop();
});

test("initial resume opens the all-session picker without creating a throwaway session", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const seed = await connectUnixClient(socketPath);
  const saved = await seed.request("session.create", { cwd: directory });
  seed.close();
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    initialResume: true,
    listResumeSessions: async () => [
      {
        sessionId: saved.sessionId,
        resumeKey: `native:${saved.sessionId}`,
        cwd: directory,
        createdAt: 1,
        updatedAt: 1,
        userMessageCount: 0,
        runtime: { state: "inactive" },
        attachmentCount: 0,
        placementLabel: "SANDBOXED · native",
        unsafe: false,
      },
    ],
    openResumeSession: async () => ({
      client: await connectUnixClient(socketPath),
      reconnectClient: () => connectUnixClient(socketPath),
    }),
  });
  await until(() => text().includes("Resume Session (All)"), "initial resume selector");
  const listingClient = await connectUnixClient(socketPath);
  const before = await listingClient.request("session.list", {
    scope: "all_local",
    order: "recent",
    pageSize: 100,
  });
  assert.equal(before.sessions.length, 1);
  input.write("\r");
  await until(() => app.sessionId === saved.sessionId, "initial resumed session");
  const after = await listingClient.request("session.list", {
    scope: "all_local",
    order: "recent",
    pageSize: 100,
  });
  assert.equal(after.sessions.length, 1);
  listingClient.close();
  app.stop();
});

test("resume selects the most recently updated session first", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const seed = await connectUnixClient(socketPath);
  const older = await seed.request("session.create", { cwd: directory });
  const recent = await seed.request("session.create", { cwd: directory });
  seed.close();
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const entry = (sessionId: SessionId, updatedAt: number, message: string) => ({
    sessionId,
    resumeKey: `native:${sessionId}`,
    cwd: directory,
    createdAt: 1,
    updatedAt,
    userMessageCount: 1,
    firstUserMessage: message,
    lastUserMessage: message,
    runtime: { state: "inactive" as const },
    attachmentCount: 0,
    placementLabel: "SANDBOXED · native",
    unsafe: false,
  });
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    initialResume: true,
    listResumeSessions: () =>
      Promise.resolve([
        entry(older.sessionId, 1, "older session"),
        entry(recent.sessionId, 2, "recent session"),
      ]),
    openResumeSession: async () => ({
      client: await connectUnixClient(socketPath),
      reconnectClient: () => connectUnixClient(socketPath),
    }),
  });

  await until(() => text().includes("Most Recently Updated"), "recent resume selector");
  input.write("\r");
  await until(() => app.sessionId === recent.sessionId, "most recent session resume");
  app.stop();
});

test("/compact summarizes older context through the daemon", async (context) => {
  const requests: ModelTurnRequest[] = [];
  const model: ModelPort = {
    stream(request) {
      requests.push(request);
      const text =
        requests.length === 1
          ? "old answer"
          : requests.length === 2
            ? "recent answer"
            : "## Goal\nKeep working";
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text_delta", text };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const { socketPath, directory } = await startStack(context, model, undefined, undefined, {
    keepRecentTokens: 7,
    maxOutputTokens: 123,
  });
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });
  const observer = await connectUnixClient(socketPath);
  const subscription = await subscribeSession(observer, app.sessionId);
  context.after(async () => {
    await subscription.close();
    observer.close();
  });
  const completedResponses = () =>
    subscription.projector.state.records.filter(
      (record) =>
        record.kind === "event" &&
        record.event.type === "assistant.message" &&
        record.event.payload.stopReason !== "tool_use",
    ).length;

  input.write("old prompt\r");
  await until(() => completedResponses() === 1, "old response");
  input.write("recent prompt\r");
  await until(() => completedResponses() === 2, "recent response");
  input.write("/compact Focus on the current task\r");
  await until(() => text().includes("Context compacted"), "compaction");

  assert.equal(requests[2]?.toolChoice, "none");
  assert.match(
    requests[2]?.messages[0]?.content[0]?.type === "text"
      ? requests[2].messages[0].content[0].text
      : "",
    /Focus on the current task/,
  );
  assert.match(text(), /Keep working/);
  app.stop();
});

test("an unenforced session keeps a persistent unsafe warning", async (context) => {
  const { socketPath, directory } = await startStack(context, port, undefined, {
    provider: "none",
    enforced: false,
    controls: [],
  });
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });
  const warning = "UNSAFE: no sandbox; tools have full host access";
  assert.match(text(), new RegExp(warning));
  input.write("/theme\r");
  await until(() => text().includes("Select theme"), "unsafe theme dialog");
  assert.match(text(), new RegExp(warning));
  input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.write("hello\r");
  await until(() => text().includes("the answer"), "unsafe assistant reply");
  assert.match(text(), new RegExp(warning));
  app.stop();
});

test("fork, clone, and resume switch sessions through the daemon", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });
  const sourceSessionId = app.sessionId;
  const observer = await connectUnixClient(socketPath);
  const subscription = await subscribeSession(observer, sourceSessionId);
  context.after(async () => {
    await subscription.close();
    observer.close();
  });
  const completedResponses = () =>
    subscription.projector.state.records.filter(
      (record) =>
        record.kind === "event" &&
        record.event.type === "assistant.message" &&
        record.event.payload.stopReason !== "tool_use",
    ).length;

  input.write("first prompt\r");
  await until(() => completedResponses() === 1, "first reply");
  input.write("second prompt\r");
  await until(() => completedResponses() === 2, "second reply");

  input.write("/fork\r");
  await until(() => text().includes("Fork from Message"), "fork selector");
  assert.match(text(), /Message 2 of 2/);
  input.write("\r");
  await until(() => app.sessionId !== sourceSessionId, "fork switch");
  const forkSessionId = app.sessionId;
  await until(() => text().includes("forked to new session"), "forked to new session");
  assert.match(text(), /forked to new session/);
  assert.match(text(), /second prompt/);

  input.write("\x15/resume\r");
  await until(() => text().includes("Resume Session (Current Folder)"), "resume selector");
  input.write("\x1b[B\r");
  await until(() => app.sessionId === sourceSessionId, "source session resume");

  input.write("/clone\r");
  await until(
    () => app.sessionId !== sourceSessionId && app.sessionId !== forkSessionId,
    "clone switch",
  );
  await until(() => text().includes("cloned to new session"), "cloned to new session");
  assert.match(text(), /cloned to new session/);
  app.stop();
});

test("a failed target subscription leaves the current session fully active", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const seedClient = await connectUnixClient(socketPath);
  const target = await seedClient.request("session.create", { cwd: directory });
  seedClient.close();

  const client = await connectUnixClient(socketPath);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({ client, input, output, cwd: directory, color: false });
  const sourceSessionId = app.sessionId;
  const mutableClient = client as unknown as {
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  const request = mutableClient.request.bind(client);
  mutableClient.request = (method, params) => {
    if (method === "session.subscribe" && params.sessionId === target.sessionId) {
      return Promise.reject(new Error("target subscription failed"));
    }
    return request(method, params);
  };

  await (app as unknown as { resumeSession(sessionId: string): Promise<void> }).resumeSession(
    target.sessionId,
  );

  assert.equal(app.sessionId, sourceSessionId);
  assert.equal((app as unknown as { hydrating: boolean }).hydrating, false);
  assert.equal((app as unknown as { switchingSessionId?: string }).switchingSessionId, undefined);
  await until(() => text().includes("target subscription failed"), "target subscription failed");
  assert.match(text(), /target subscription failed/);
  app.stop();
});

test("renders model deltas before the canonical assistant event", async (context) => {
  let release = (): void => undefined;
  const streaming: ModelPort = {
    stream() {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "thinking_delta", text: "checking" };
        yield { type: "text_delta", text: "section one\n\n" };
        yield { type: "text_delta", text: "section two" };
        await new Promise<void>((resolvePromise) => {
          release = resolvePromise;
        });
        yield { type: "text_delta", text: " complete" };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const { socketPath, directory } = await startStack(context, streaming);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });

  input.write("stream it\r");
  await until(() => text().includes("section two"), "transient assistant text");
  assert.equal(text().includes("section two complete"), false);
  assert.equal(text().includes("\x1b[?25l"), true);
  release();
  await until(
    () =>
      text().includes("section two complete") &&
      text().lastIndexOf("\x1b[?25h") > text().lastIndexOf("\x1b[?25l"),
    "canonical assistant text and cursor restoration",
  );
  const terminal = new VirtualTerminal(100, 24);
  terminal.write(text());
  assert.equal(terminal.rows().filter((row) => row.includes("section one")).length, 1);
  assert.equal(terminal.rows().filter((row) => row.includes("section two complete")).length, 1);
  app.stop();
});

test("streaming into a tool call preserves the prompt and tool transaction", async (context) => {
  let call = 0;
  const model: ModelPort = {
    stream() {
      call += 1;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (call === 1) {
          yield { type: "text_delta", text: "I will inspect the fixture." };
          yield { type: "tool_call", callId: "echo-1", name: "echo", input: { value: "ok" } };
          yield { type: "completed", stopReason: "tool_use", usage };
          return;
        }
        yield { type: "text_delta", text: "Inspection complete." };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const { socketPath, directory } = await startStack(context, model, () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "Echo a value",
      inputSchema: { type: "object" },
      execute: async () => ({
        content: [{ type: "text", text: "tool output retained" }],
        isError: false,
      }),
    });
    return tools;
  });
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });

  input.write("keep my prompt\r");
  await until(() => text().includes("Inspection complete."), "post-tool response");
  const terminal = new VirtualTerminal(100, 24);
  terminal.write(text());
  const rows = terminal.rows();
  assert.equal(
    rows.some((row) => row.includes("keep my prompt")),
    true,
  );
  assert.equal(
    rows.some((row) => row.includes("ECHO")),
    true,
  );
  assert.equal(
    rows.some((row) => row.includes("tool output retained")),
    true,
  );
  assert.equal(
    rows.some((row) => row.includes("Inspection complete.")),
    true,
  );
  app.stop();
});

test("uploads image files and sends blob references with the next prompt", async (context) => {
  const requests: Array<readonly unknown[]> = [];
  const recording: ModelPort = {
    stream(request) {
      requests.push(request.messages);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text_delta", text: "image received" };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const { socketPath, directory } = await startStack(context, recording);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const bytes = Buffer.alloc(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
  bytes.set(Buffer.from("IHDR"), 12);
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  const imagePath = join(directory, "pixel.png");
  await writeFile(imagePath, bytes);
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    imageDisplay: "metadata",
    mediaCapabilities: { images: null },
  });

  input.write(`/attach ${imagePath}\r`);
  await until(() => text().includes("attached pixel.png"), "image file upload");
  assert.match(text(), /\/attach clear to remove attachments/);
  input.write("/attach clear\r");
  await until(() => text().includes("attachments cleared"), "attachment removal");
  const cleared = new VirtualTerminal(100, 24);
  cleared.write(text());
  assert.ok(!cleared.rows().some((row) => row.includes("attached pixel.png")));
  const beforeReattach = text().length;
  input.write(`/attach ${imagePath}\r`);
  await until(() => text().slice(beforeReattach).includes("attached pixel.png"), "reattach image");
  input.write("inspect this\r");
  await until(() => requests.length === 1, "image prompt delivery");
  const user = requests[0]?.at(-1) as
    | { role?: string; content?: Array<{ type: string; text?: string; blob?: { name?: string } }> }
    | undefined;
  assert.equal(user?.role, "user");
  assert.deepEqual(
    user?.content?.map((item) => [item.type, item.text ?? item.blob?.name]),
    [
      ["text", "inspect this"],
      ["blob", "pixel.png"],
    ],
  );
  await until(() => text().includes("[Image · pixel.png"), "image metadata rendering");
  app.stop();
});

test("terminal resize coalesces bursts and leaves one live frame", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });

  input.write("keep this\r");
  await until(() => text().includes("↑1 ↓1"), "canonical assistant reply");
  const beforeWidth = text().length;
  for (const width of [60, 72, 60]) {
    output.columns = width;
    output.emit("resize");
  }
  await until(() => text().length > beforeWidth, "coalesced width render");
  const widthRender = text().slice(beforeWidth);
  assert.equal(widthRender.includes("\x1b[3J"), false);
  const resizedTerminal = new VirtualTerminal(60, 30);
  resizedTerminal.write(widthRender);
  assert.equal(resizedTerminal.rows().filter((line) => line.includes("keep this")).length, 1);
  assert.equal(resizedTerminal.rows().filter((line) => line.includes("the answer")).length, 1);
  assert.equal(
    resizedTerminal.rows().filter((line) => line.includes("no model selected")).length,
    1,
  );

  const beforeHeight = text().length;
  output.rows = 30;
  output.emit("resize");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const heightRender = text().slice(beforeHeight);
  assert.equal(heightRender.includes("\x1b[3J"), false);
  const resizedHeightTerminal = new VirtualTerminal(60, 30);
  resizedHeightTerminal.write(heightRender);
  assert.equal(
    resizedHeightTerminal.rows().filter((line) => line.includes("no model selected")).length,
    1,
  );

  let latestResizeOutput = "";
  for (const width of [120, 48, 100]) {
    const before = text().length;
    output.columns = width;
    output.emit("resize");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resizeOutput = text().slice(before);
    latestResizeOutput = resizeOutput;
    assert.equal(resizeOutput.includes("\x1b[3J"), false);
    const resized = new VirtualTerminal(width, 30);
    resized.write(resizeOutput);
    assert.equal(resized.rows().filter((line) => line.includes("no model selected")).length, 1);
  }

  const beforeNextTurn = text().length;
  input.write("after resize\r");
  await until(() => text().includes("↑2 ↓2"), "canonical post-resize reply");
  assert.match(text().slice(beforeNextTurn), /after resize/);
  const terminal = new VirtualTerminal(100, 30);
  terminal.write(`${latestResizeOutput}${text().slice(beforeNextTurn)}`);
  assert.equal(terminal.rows().filter((line) => line.includes("no model selected")).length, 1);
  app.stop();
});

test("fullscreen mode switches live without losing the session", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const preferences: Array<Record<string, unknown>> = [];
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    tuiMode: "fullscreen",
    onPreferenceChange: (update) => {
      preferences.push(update);
    },
  });

  assert.equal(text().includes("\x1b[?1049h"), true);
  const beforeRepair = text().length;
  input.write("/fullscreen\r");
  await until(
    () => text().slice(beforeRepair).includes("\x1b[2J\x1b[H"),
    "same-mode fullscreen repair",
  );
  input.write("hello fullscreen\r");
  await until(() => text().includes("↑1 ↓1"), "canonical fullscreen reply");
  input.write("/regular\r");
  await until(() => text().includes("\x1b[?1049l"), "regular mode restoration");
  assert.deepEqual(preferences.at(-1), { tuiMode: "regular" });
  app.stop();
});

test("fullscreen redraw observes the current terminal size before a delayed resize event", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    tuiMode: "fullscreen",
  });

  const beforeResize = text().length;
  output.rows = 12;
  input.write("x");
  await until(() => text().length > beforeResize, "fullscreen resize-safe repaint");
  const repaint = text().slice(beforeResize);
  assert.equal(repaint.includes("\x1b[?2026h\x1b[?7l\x1b[2J\x1b[H"), true);
  const terminal = new VirtualTerminal(100, 12);
  terminal.write(repaint);
  assert.equal(terminal.rows()[0], "Transcript · latest");
  assert.equal(
    terminal.rows().some((row) => row.includes("x")),
    true,
  );
  assert.equal(terminal.cursorRow < 12, true);
  app.stop();
});

test("idle assembled app performs no periodic repaint", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 250));
  const settledLength = text().length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(text().length, settledLength);
  app.stop();
});

test("fullscreen coalesces inertial scroll redraws before accepting typed input", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    tuiMode: "fullscreen",
  });

  const beforeScroll = text().length;
  input.write("\x1b[<64;10;5M".repeat(20));
  await until(() => text().length > beforeScroll, "coalesced fullscreen scroll repaint");
  const scrollOutput = text().slice(beforeScroll);
  assert.equal(scrollOutput.split("\x1b[?2026h").length - 1, 1);

  const beforeTyping = text().length;
  input.write("abc");
  await until(() => text().length > beforeTyping, "typed input after fullscreen scroll");
  assert.equal(text().slice(beforeTyping).includes("abc"), true);
  app.stop();
});

test("Ctrl+V paste, Shift+Enter, and searchable hotkeys behave", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    readClipboard: async () => "pasted first\npasted second",
  });

  input.write("\x16");
  await until(() => text().includes("pasted second"), "clipboard insertion");
  input.write("\r");
  await until(() => text().includes("↑1 ↓1"), "clipboard prompt reply");
  assert.match(text(), /│ pasted first/);
  input.write("line one\x1b[13;2uline two\r");
  await until(() => text().includes("↑2 ↓2"), "shift enter prompt reply");
  assert.match(text(), /line two/);
  input.write("/hotkeys\r");
  await until(() => text().includes("Keyboard shortcuts"), "hotkeys dialog");
  assert.match(text(), /Ctrl\+A/);
  assert.match(text(), /Select the entire prompt/);
  input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.write("\x0f");
  await until(() => text().includes("tool details full"), "expanded tool details");
  app.stop();
});

test("Escape interrupts a running operation", async (context) => {
  let operationAborted = false;
  const blockingPort: ModelPort = {
    stream(request) {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        operationAborted = request.signal?.aborted ?? false;
        yield { type: "completed", stopReason: "aborted", usage };
      })();
    },
  };
  const { socketPath, directory } = await startStack(context, blockingPort);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });

  await until(() => text().includes("\x1b[>4;2m"), "keyboard negotiation");
  input.write("start work\r");
  await until(() => text().includes("Working"), "working state");
  input.write("\x1b[27u");
  await until(() => operationAborted, "escape interruption");
  app.stop();
});

test("terminal extensions cannot replace encoded safety shortcuts", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output } = captureOutput();
  const extension: TerminalExtension = {
    manifest: {
      id: "test.reserved-shortcut",
      name: "Reserved shortcut",
      capabilities: ["terminal.shortcuts"],
    },
    activate(api) {
      api.registerShortcut({
        key: "\x1b[99;5u",
        description: "Encoded Ctrl+C",
        run: () => undefined,
      });
    },
  };
  await assert.rejects(
    AxlApp.start({
      client: await connectUnixClient(socketPath),
      input,
      output,
      cwd: directory,
      color: false,
      extensions: [extension],
    }),
    /conflicts with a reserved terminal shortcut/,
  );
});

test("terminal extensions contribute UI and reload without leaking owned resources", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  let activations = 0;
  let cleanups = 0;
  const extension: TerminalExtension = {
    manifest: {
      id: "test.terminal",
      name: "Terminal fixture",
      capabilities: [
        "terminal.commands",
        "terminal.shortcuts",
        "terminal.status",
        "terminal.widgets",
      ],
    },
    activate(api) {
      activations += 1;
      api.registerCommand({
        name: "hello",
        description: "Show extension greeting",
        complete: (prefix) => (prefix ? [] : ["safe\n\x1b]0;owned\x07value"]),
        run: (arguments_, command) => command.notify(`hello ${arguments_}`, "success"),
      });
      api.registerShortcut({
        key: "\u0010",
        description: "Show shortcut greeting",
        run: (command) => command.notify("shortcut ready", "accent"),
      });
      api.registerStatus("ready", { text: "extension ready", tone: "success" });
      api.registerWidget("summary", {
        placement: "aboveEditor",
        render: () => [{ text: "Extension widget", tone: "accent" }],
        dispose: () => {
          cleanups += 1;
        },
      });
      return () => {
        cleanups += 1;
      };
    },
  };
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    extensions: [extension],
  });

  assert.match(text(), /Extension widget/);
  assert.match(text(), /extension ready/);
  input.write("/hello \t");
  await until(() => text().includes("/hello safe value"), "sanitized extension completion");
  assert.equal(text().includes("\x1b]0;owned"), false);
  input.write("\x03/hello world\r");
  await until(() => text().includes("hello world"), "extension command");
  input.write("\u0010");
  await until(() => text().includes("shortcut ready"), "extension shortcut");
  input.write("/reload\r");
  await until(() => activations === 2, "extension reload");
  assert.equal(cleanups, 2);
  assert.match(text(), /Extension widget/);

  app.stop();
  await until(() => cleanups === 4, "extension shutdown cleanup");
});

test("command discovery, history, autocomplete, and external editing behave", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const edited: string[] = [];
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    models: ["gpt-5", "gpt-4.1"],
    editPrompt: async (content) => {
      edited.push(content);
      return `${content} from editor`;
    },
  });

  input.write("draft\x07");
  await until(() => text().includes("external editor closed"), "external editor");
  assert.deepEqual(edited, ["draft"]);
  input.write("\r");
  await until(() => text().includes("draft from editor"), "edited prompt submission");

  input.write("\x12");
  await until(() => text().includes("Prompt history"), "history search");
  assert.match(text(), /draft from editor/);
  input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 20));

  input.write("/m");
  await until(() => text().includes("Commands"), "command suggestions");
  assert.match(text(), /select a model/);
  input.write("\x15/model g\t");
  await until(() => text().includes("/model gpt-5"), "argument completion");
  input.write("\x15/commands\r");
  await until(() => text().includes("Commands"), "command palette");
  input.write("detach");
  await until(() => text().includes("/detach"), "detach command search");
  app.stop();
});

test("history navigation passes through slash-command entries without trapping arrows", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    models: ["gpt-5"],
  });

  input.write("first prompt\r");
  await until(() => text().includes("↑1 ↓1"), "canonical first prompt reply");
  input.write("/model\r");
  await until(() => text().includes("Select model"), "model picker");
  input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.write("last prompt\r");
  await until(() => text().includes("↑2 ↓2"), "canonical last prompt reply");

  input.write("\x1b[A\x1b[A\x1b[A");
  await new Promise((resolve) => setImmediate(resolve));
  const terminal = new VirtualTerminal(100, 24);
  terminal.write(text());
  assert.equal(
    terminal.rows().some((row) => row.includes("│ first prompt")),
    true,
  );

  input.write("\x1b[B\x1b[B\x1b[B");
  await new Promise((resolve) => setImmediate(resolve));
  const returned = new VirtualTerminal(100, 24);
  returned.write(text());
  assert.equal(
    returned.rows().some((row) => /^│\s+│$/.test(row)),
    true,
  );
  app.stop();
});

test("bang commands run through daemon shell authority", async (context) => {
  const commands: string[] = [];
  const requests: string[] = [];
  const recordingPort: ModelPort = {
    stream(request) {
      requests.push(JSON.stringify(request.messages));
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text_delta", text: "done" };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const { socketPath, directory } = await startStack(context, recordingPort, () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "bash",
      description: "Run shell",
      inputSchema: { type: "object" },
      async execute(input) {
        commands.push(String(input.command));
        return {
          content: [{ type: "text", text: `output:${String(input.command)}` }],
          isError: false,
        };
      },
    });
    return tools;
  });
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });

  input.write("!pwd\r");
  await until(() => text().includes("output:pwd"), "included shell command");
  input.write("!!secret\r");
  await until(() => text().includes("output:secret"), "excluded shell command");
  input.write("continue\r");
  await until(() => requests.length === 1, "model turn after shell");
  assert.deepEqual(commands, ["pwd", "secret"]);
  assert.match(requests[0] ?? "", /output:pwd/);
  assert.equal((requests[0] ?? "").includes("output:secret"), false);
  app.stop();
});

test("Escape interrupts shell passthrough and preserves queued prompts", async (context) => {
  let shellAborted = false;
  const prompts: string[] = [];
  const recordingPort: ModelPort = {
    stream(request) {
      const last = request.messages.at(-1);
      if (last?.role === "user") {
        prompts.push(last.content.map((item) => (item.type === "text" ? item.text : "")).join(""));
      }
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text_delta", text: "after shell" };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const { socketPath, directory } = await startStack(context, recordingPort, () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "bash",
      description: "Blocking shell",
      inputSchema: { type: "object" },
      async execute(_input, signal) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        shellAborted = signal.aborted;
        return { content: [{ type: "text", text: "shell interrupted" }], isError: true };
      },
    });
    return tools;
  });
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });

  await until(() => text().includes("\x1b[>4;2m"), "keyboard negotiation");
  input.write("!sleep 30\r");
  await until(() => text().includes("Working"), "shell working state");
  input.write("keep this prompt\r");
  await until(() => text().includes("queued follow-up"), "queued shell follow-up");
  input.write("\x1b[27u");
  await until(() => shellAborted, "shell interruption");
  await until(() => prompts.length === 1, "queued prompt delivery");
  assert.deepEqual(prompts, ["keep this prompt"]);
  app.stop();
});

test("editing, /quit, and busy notices behave", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  let exited = false;

  await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    onExit: () => {
      exited = true;
    },
  });

  input.write("helXX\x7f\x7flo\r"); // backspace editing before submit
  await until(() => text().includes("│ hello"), "edited send");

  input.write("/quit\r");
  await until(() => exited, "quit");
});

test("Ctrl+Z suspends and resumes without detaching the session", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  let suspends = 0;
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    suspendProcess: () => {
      suspends += 1;
    },
  });

  input.write("\x1a");
  await until(() => suspends === 1, "terminal suspension");
  assert.match(text(), /terminal resumed/);
  assert.equal(input.isRaw, true);
  app.stop();
});

test("Enter steers and Alt+Enter queues a follow-up while working", async (context) => {
  let releaseFirst = (): void => undefined;
  let calls = 0;
  const prompts: string[] = [];
  const queuedPort: ModelPort = {
    stream(request) {
      calls += 1;
      const turn = calls;
      const last = request.messages.findLast((message) => message.role === "user");
      if (last?.role === "user") {
        prompts.push(last.content.map((item) => (item.type === "text" ? item.text : "")).join(""));
      }
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (turn === 1) {
          await new Promise<void>((resolvePromise) => {
            releaseFirst = resolvePromise;
          });
        }
        yield { type: "text_delta", text: `reply ${turn}` };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const { socketPath, directory } = await startStack(context, queuedPort);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });

  input.write("one\r");
  await until(() => calls === 1, "first model call");
  input.write("two\rthree\x1b[13;3u");
  await until(() => text().includes("follow-up queued"), "queue notice");
  assert.match(text(), /STEER/);
  assert.equal(calls, 1);
  releaseFirst();
  await until(() => calls === 3, "queued model calls");
  assert.deepEqual(prompts, ["one", "two", "three"]);
  await until(() => {
    const terminal = new VirtualTerminal(100, 24);
    terminal.write(text());
    return !terminal
      .rows()
      .some((row) => row.includes("steering queued") || row.includes("follow-up queued"));
  }, "consumed queue notices to clear");
  app.stop();
});

test("MCP interactions block the operation until the user responds", async (context) => {
  let call = 0;
  const interactiveModel: ModelPort = {
    stream() {
      call += 1;
      const turn = call;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (turn === 1) {
          yield { type: "tool_call", callId: "approval", name: "approval", input: {} };
          yield { type: "completed", stopReason: "tool_use", usage };
        } else if (turn === 2) {
          yield { type: "tool_call", callId: "form", name: "form", input: {} };
          yield { type: "completed", stopReason: "tool_use", usage };
        } else {
          yield { type: "text_delta", text: "continued after approval" };
          yield { type: "completed", stopReason: "stop", usage };
        }
      })();
    },
  };
  const { socketPath, directory } = await startStack(context, interactiveModel, (interact) => {
    const tools = new ToolRegistry();
    tools.register({
      name: "approval",
      description: "Request approval",
      inputSchema: { type: "object" },
      async execute(_input, signal) {
        const response = await interact(
          { kind: "mcp_tool", source: "mcp:fixture", message: "Allow fixture tool?" },
          signal,
        );
        return {
          content: [{ type: "text", text: response.action }],
          isError: response.action !== "accept",
        };
      },
    });
    tools.register({
      name: "form",
      description: "Request form input",
      inputSchema: { type: "object" },
      async execute(_input, signal) {
        const response = await interact(
          {
            kind: "mcp_elicitation_form",
            source: "mcp:fixture",
            message: "Provide profile data",
            data: {
              request: {
                requestedSchema: {
                  type: "object",
                  properties: { confirm: { type: "boolean", description: "Confirm action" } },
                  required: ["confirm"],
                },
              },
            },
          },
          signal,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(response.content ?? {}) }],
          isError: response.action !== "accept",
        };
      },
    });
    return tools;
  });
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });

  input.write("run it\r");
  await until(() => text().includes("Allow fixture tool?"), "MCP approval dialog");
  app.stop();

  const resumedInput = new PassThrough();
  const resumed = captureOutput();
  const resumedApp = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input: resumedInput,
    output: resumed.output,
    cwd: directory,
    sessionId: app.sessionId,
    color: false,
  });
  assert.match(resumed.text(), /Allow fixture tool/);
  resumedInput.write("y");
  await until(() => resumed.text().includes("Provide profile data"), "MCP form dialog");
  resumedInput.write("yes\r\r");
  await until(() => resumed.text().includes("continued after approval"), "approved continuation");
  resumedApp.stop();
});

test("/model opens a selector and switches the model live", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const switched: string[] = [];
  const preferences: Array<Record<string, unknown>> = [];

  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    models: ["gpt-5", "gpt-4.1", "gpt-4o-mini"],
    currentModel: "gpt-5",
    onModelChange: (modelId) => switched.push(modelId),
    onPreferenceChange: (update) => {
      preferences.push(update);
    },
  });

  input.write("/mo\r");
  await until(() => text().includes("Select model"), "unique command prefix");
  assert.match(text(), /› gpt-5/);
  assert.match(text(), /gpt-4\.1/);

  input.write("\x1b["); // fragmented down
  input.write("B");
  input.write("\r"); // choose
  await until(() => switched.length > 0, "selection applied");
  assert.deepEqual(switched, ["gpt-4.1"]);
  assert.deepEqual(preferences, [{ modelId: "gpt-4.1" }]);
  await until(() => text().includes("→ gpt-4.1"), "committed line");
  app.stop();
});

test("/theme previews message and tool surfaces live", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const preferences: Array<Record<string, unknown>> = [];
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    onPreferenceChange: (update) => {
      preferences.push(update);
    },
  });

  input.write("/theme\r");
  await until(() => text().includes("Select theme"), "theme selector");
  assert.match(text(), /dark/);
  assert.equal(text().includes("❯"), false);
  assert.match(text(), /accent/);
  assert.match(text(), /muted metadata/);
  assert.match(text(), /read.*packages\/tui\/src\/app\.ts/);
  input.write("\x1b[B");
  await until(() => text().includes("Axl Light"), "theme preview navigation");
  input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(preferences, []);
  input.write("/settings\r");
  await until(() => text().includes("Terminal settings"), "settings selector");
  assert.match(stripAnsi(text()), /Tool details\s+compact/);
  assert.match(stripAnsi(text()), /Thoughts\s+compact/);
  app.stop();
});

test("active user themes hot-reload from disk", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const themes = join(directory, "themes");
  const path = join(themes, "custom.json");
  await mkdir(themes);
  const theme = (accent: string) =>
    `${JSON.stringify({
      version: 1,
      id: "custom",
      label: "Custom",
      appearance: "dark",
      inherits: "axl-dark",
      foregrounds: { accent },
    })}\n`;
  await writeFile(path, theme("#123456"));
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    theme: "custom",
    globalThemeDirectory: themes,
  });

  assert.equal(text().includes("\x1b[38;2;18;52;86m"), true);
  await writeFile(path, theme("#abcdef"));
  await until(() => text().includes("theme custom reloaded"), "custom theme reload");
  assert.equal(text().includes("\x1b[38;2;171;205;239m"), true);

  await writeFile(path, "{\n");
  await until(() => text().includes("theme reload failed"), "invalid theme warning");
  await writeFile(path, theme("#fedcba"));
  await until(
    () => (text().match(/theme custom reloaded/g) ?? []).length === 2,
    "theme watcher recovery",
  );
  assert.equal(text().includes("\x1b[38;2;254;220;186m"), true);
  app.stop();
});

test("/model digit selection and Esc cancel behave", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const switched: string[] = [];

  await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    models: ["gpt-5", "gpt-4o-mini"],
    onModelChange: (modelId) => switched.push(modelId),
  });

  input.write("/model\r");
  await until(() => text().includes("Select model"), "selector open");
  input.write("\x1b"); // cancel
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.write("/model\r");
  await until(() => (text().match(/Select model/g) ?? []).length >= 2, "reopened");
  input.write("2");
  await until(() => switched.length > 0, "digit selection");
  assert.deepEqual(switched, ["gpt-4o-mini"]);
});

test("/login renders a provider-neutral injected dialog", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  let submitted: Readonly<Record<string, string>> | undefined;

  await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    loadLogin: () =>
      Promise.resolve({
        title: "Login to test provider",
        fields: [
          {
            id: "key",
            label: "API key",
            prompt: "Enter API key",
            mask: true,
          },
          {
            id: "endpoint",
            label: "Endpoint",
            prompt: "Enter endpoint",
          },
        ],
        submit: (values) => {
          submitted = values;
          return Promise.resolve({ ok: true, summary: "credentials verified" });
        },
      }),
  });

  await until(() => text().includes("\x1b[>4;2m"), "keyboard negotiation");
  input.write("/login\r");
  await until(() => text().includes("Login to test provider"), "login dialog");
  input.write("dialog-test-key");
  await until(() => /\*{5,}/.test(text()), "masked key");
  input.write("\r");
  await until(() => text().includes("Enter endpoint"), "endpoint field");
  input.write("https://example.invalid/\r");
  await until(() => text().includes("credentials verified"), "verified");

  assert.equal(text().includes("dialog-test-key"), false);
  assert.deepEqual(submitted, {
    key: "dialog-test-key",
    endpoint: "https://example.invalid/",
  });
});

test("/reload requests a runtime rebuild and renders the boundary", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-tui-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    runtime: ({ boundary }) => ({
      model: port,
      tools: new ToolRegistry(),
      ...(boundary === "config_change"
        ? {}
        : {
            configDialect: {
              dialectId: "generic" as const,
              rosterFingerprint: "a1b2c3d4".padEnd(64, "0"),
              reason: boundary,
            },
          }),
    }),
  });
  await daemon.start();
  context.after(() => daemon.stop());

  const input = new PassThrough();
  const { output, text } = captureOutput();
  await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });
  assert.equal(text().includes("tools reloaded"), false);

  input.write("/reload\r");
  await until(() => text().includes("· tools reloaded · generic"), "reload boundary rendered");
});

test("consecutive tools group, expand, and resume with complete canonical inputs", async (context) => {
  let turn = 0;
  const model: ModelPort = {
    stream() {
      turn += 1;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (turn <= 4) {
          yield {
            type: "tool_call",
            callId: `read-${turn}`,
            name: "read",
            input: { path: `file-${turn}.txt` },
          };
          yield { type: "completed", stopReason: "tool_use", usage };
          return;
        }
        yield { type: "text_delta", text: "GROUP_COMPLETE" };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const { socketPath, directory } = await startStack(context, model, () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "read",
      description: "Read a fixture",
      inputSchema: { type: "object" },
      execute: async () => ({
        content: [{ type: "text", text: "COMPLETE_TOOL_RESULT" }],
        isError: false,
      }),
    });
    return tools;
  });
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });
  context.after(() => app.stop());
  input.write("inspect fixtures\r");
  await until(() => text().includes("GROUP_COMPLETE"), "group completion");
  const terminal = new VirtualTerminal(100, 24);
  terminal.write(text());
  assert.equal(terminal.rows().filter((row) => row.includes("Tools · 4 calls · 4 done")).length, 1);
  assert.match(terminal.rows().join("\n"), /Ctrl\+O to expand/);
  assert.ok(!terminal.rows().some((row) => row.includes("COMPLETE_TOOL_RESULT")));

  const beforeExpand = text().length;
  input.write("\x0f");
  await until(
    () => text().slice(beforeExpand).includes("COMPLETE_TOOL_RESULT"),
    "expanded results",
  );
  const expanded = new VirtualTerminal(100, 24);
  expanded.write(text().slice(beforeExpand));
  assert.equal(expanded.rows().filter((row) => row.includes("COMPLETE_TOOL_RESULT")).length, 4);
  assert.match(expanded.rows().join("\n"), /"path": "file-1.txt"/);

  const sessionId = app.sessionId;
  app.stop();
  const resumed = captureOutput();
  const resumedApp = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input: new PassThrough(),
    output: resumed.output,
    cwd: directory,
    sessionId,
    color: false,
  });
  context.after(() => resumedApp.stop());
  assert.match(resumed.text(), /Tools · 4 calls · 4 done/);
});

test("clipboard paths stay editable and upload images only when submitted", async (context) => {
  const requests: ModelTurnRequest[] = [];
  const model: ModelPort = {
    stream(request) {
      requests.push(request);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text_delta", text: `clipboard-reply-${requests.length}` };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const imagePath = await saveClipboardImage(image);
  context.after(() => rm(imagePath, { force: true }));
  const { socketPath, directory } = await startStack(context, model);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    readClipboard: async () => ({ imagePath }),
  });
  context.after(() => app.stop());
  input.write("\x16");
  await until(() => text().includes("pasted image path"), "clipboard path insertion");
  assert.match(text(), /axl-clipboard-/);
  assert.deepEqual(await readFile(imagePath), image);
  assert.equal(requests.length, 0);
  input.write("\x15without screenshot\r");
  await until(() => text().includes("clipboard-reply-1"), "text-only prompt");
  assert.deepEqual(requests[0]?.messages.at(-1)?.content, [
    { type: "text", text: "without screenshot" },
  ]);

  // A path-only draft is an image prompt, not an unknown slash command.
  input.write(`${imagePath}\r`);
  await until(() => text().includes("clipboard-reply-2"), "clipboard image prompt");
  const content = requests[1]?.messages.at(-1)?.content;
  assert.equal(content?.[0]?.type, "text");
  assert.equal(content?.[0]?.type === "text" ? content[0].text : undefined, imagePath);
  const blob = content?.find((part) => part.type === "blob");
  assert.ok(blob?.type === "blob");
  assert.deepEqual(await readFile(join(directory, "data", "blobs", blob.blob.sha256)), image);
  assert.deepEqual(await readFile(imagePath), image, "temp image remains reusable");

  await rm(imagePath);
  input.write(`inspect ${imagePath}\r`);
  await until(() => text().includes("prompt restored"), "failed image import restores draft");
  assert.equal(requests.length, 2);
});

test("submitting during clipboard acquisition preserves the draft instead of sending early", async (context) => {
  let finish!: (value: string) => void;
  const clipboard = new Promise<string>((resolve) => {
    finish = resolve;
  });
  context.after(() => finish(""));
  let requests = 0;
  const model: ModelPort = {
    stream(request) {
      requests += 1;
      return port.stream(request);
    },
  };
  const { socketPath, directory } = await startStack(context, model);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    readClipboard: () => clipboard,
  });
  context.after(() => app.stop());
  input.write("keep this\x16\r");
  await until(() => text().includes("wait for the current clipboard"), "pending clipboard guard");
  assert.equal(requests, 0);
  finish(" pasted text");
  await until(() => text().includes("pasted text"), "clipboard acquisition");
  input.write("\r");
  await until(() => text().includes("the answer"), "preserved prompt submission");
  assert.equal(requests, 1);
  assert.match(text(), /keep this pasted text/);
});

test("fullscreen clicks toggle one tool group without expanding the others", async (context) => {
  let step = 0;
  const model: ModelPort = {
    stream() {
      const current = step++;
      const name = current < 2 ? "first" : "second";
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (current % 2 === 0) {
          yield { type: "tool_call", callId: name, name: "read", input: { path: `${name}.txt` } };
          yield { type: "completed", stopReason: "tool_use", usage };
        } else {
          yield { type: "text_delta", text: `${name} complete` };
          yield { type: "completed", stopReason: "stop", usage };
        }
      })();
    },
  };
  const { socketPath, directory } = await startStack(context, model, () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "read",
      description: "Read fixture",
      inputSchema: { type: "object" },
      execute: async (input) => ({
        content: [{ type: "text", text: `RESULT:${(input as { path: string }).path}` }],
        isError: false,
      }),
    });
    return tools;
  });
  const input = new PassThrough();
  const { output } = captureOutput();
  output.rows = 50;
  const terminal = new VirtualTerminal(100, 50);
  output.on("data", (chunk: Buffer) => terminal.write(chunk.toString("utf8")));
  const app = await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    tuiMode: "fullscreen",
    fullscreenScrollbar: "hidden",
  });
  context.after(() => app.stop());
  input.write("first prompt\r");
  await until(() => terminal.rows().some((row) => row.includes("first complete")), "first group");
  input.write("second prompt\r");
  await until(() => terminal.rows().some((row) => row.includes("second complete")), "second group");
  const clickFirst = () => {
    const row = terminal
      .rows()
      .findIndex((line) => line.includes("READ") && line.includes("first.txt"));
    assert.ok(row >= 0);
    input.write(`\x1b[<0;4;${row + 1}M\x1b[<0;4;${row + 1}m`);
  };
  clickFirst();
  await until(
    () => terminal.rows().some((row) => row.includes("RESULT:first.txt")),
    "expanded first group",
  );
  assert.ok(terminal.rows().some((row) => row.includes("RESULT:first.txt")));
  assert.ok(!terminal.rows().some((row) => row.includes("RESULT:second.txt")));
  clickFirst();
  await until(
    () => !terminal.rows().some((row) => row.includes("RESULT:")),
    "collapsed first group",
  );
  assert.ok(!terminal.rows().some((row) => row.includes("RESULT:")));
  input.write("\x0f");
  await until(
    () => terminal.rows().some((row) => row.includes("RESULT:second.txt")),
    "globally expanded groups",
  );
  assert.ok(terminal.rows().some((row) => row.includes("RESULT:first.txt")));
  assert.ok(terminal.rows().some((row) => row.includes("RESULT:second.txt")));
});
