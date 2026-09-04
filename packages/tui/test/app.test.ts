// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
import type { EventPayloadMap, JsonObject, ModelStreamEvent, Usage } from "@axl/protocol";
import { connectUnixClient } from "@axl/sdk/unix";

import { AxlApp, stripAnsi } from "../src/index.ts";
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

  input.write("old prompt\r");
  await until(() => text().includes("old answer"), "old response");
  input.write("recent prompt\r");
  await until(() => text().includes("recent answer"), "recent response");
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

  input.write("first prompt\r");
  await until(() => text().includes("the answer"), "first reply");
  const firstReplyCount = (text().match(/the answer/g) ?? []).length;
  input.write("second prompt\r");
  await until(() => (text().match(/the answer/g) ?? []).length > firstReplyCount, "second reply");
  await new Promise((resolve) => setTimeout(resolve, 50));

  input.write("/fork\r");
  await until(() => text().includes("Fork from Message"), "fork selector");
  assert.match(text(), /Message 2 of 2/);
  input.write("\r");
  await until(() => app.sessionId !== sourceSessionId, "fork switch");
  const forkSessionId = app.sessionId;
  assert.match(text(), /forked to new session/);
  assert.match(text(), /second prompt/);

  input.write("\x15/resume\r");
  await until(() => text().includes("Resume Session (Current Folder)"), "resume selector");
  input.write("\r");
  await until(() => app.sessionId === sourceSessionId, "source session resume");

  input.write("/clone\r");
  await until(
    () => app.sessionId !== sourceSessionId && app.sessionId !== forkSessionId,
    "clone switch",
  );
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
  assert.equal(widthRender.includes("\x1b[2J\x1b[H\x1b[3J"), true);
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
  assert.equal(heightRender.includes("\x1b[2J\x1b[H\x1b[3J"), true);
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
    assert.equal(resizeOutput.includes("\x1b[2J\x1b[H\x1b[3J"), true);
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
  input.write("hello fullscreen\r");
  await until(() => text().includes("↑1 ↓1"), "canonical fullscreen reply");
  input.write("/regular\r");
  await until(() => text().includes("\x1b[?1049l"), "regular mode restoration");
  assert.deepEqual(preferences.at(-1), { tuiMode: "regular" });
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
  await until(() => text().includes("│ pasted first"), "clipboard prompt submission");
  input.write("line one\x1b[13;2uline two\r");
  await until(() => text().includes("line two"), "shift enter prompt submission");
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
  input.write("history");
  await until(() => text().includes("/history"), "history command search");
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
    terminal.rows().some((row) => row.includes("│ > first prompt")),
    true,
  );

  input.write("\x1b[B\x1b[B\x1b[B");
  await new Promise((resolve) => setImmediate(resolve));
  const returned = new VirtualTerminal(100, 24);
  returned.write(text());
  assert.equal(
    returned.rows().some((row) => /│ >\s+│/.test(row)),
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

test("/login is a dialog: fields, masked key, live Azure verification", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const { FileCredentialStore } = await import("@axl/ai");
  const store = new FileCredentialStore(join(directory, "credentials.json"));
  const input = new PassThrough();
  const { output, text } = captureOutput();

  await AxlApp.start({
    client: await connectUnixClient(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    credentials: {
      store,
      context: { env: () => undefined, fileExists: () => Promise.resolve(false) },
      fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    },
  });

  await until(() => text().includes("\x1b[>4;2m"), "keyboard negotiation");
  input.write("/login\r");
  await until(() => text().includes("Login to Azure OpenAI"), "login dialog");
  assert.match(text(), /API key/);
  input.write("dialog-test-key");
  await until(() => /\*{5,}/.test(text()), "masked key");
  input.write("\r");
  await until(() => text().includes("Enter Azure OpenAI endpoint"), "endpoint field");
  input.write("https://myres.openai.azure.com/\r");
  input.write("\r"); // skip the optional map
  await until(() => text().includes("credentials verified with Azure"), "verified");

  assert.equal(text().includes("dialog-test-key"), false); // masked
  assert.match(text(), /\*{5,}/);
  const stored = await store.read("azure-openai");
  assert.equal(stored?.type === "api_key" && stored.key, "dialog-test-key");
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
