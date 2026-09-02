// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { AZURE_OPENAI_MODELS } from "@axl/ai";
import { DaemonClient, AxlDaemon, type SessionInteractionRequest } from "@axl/daemon";
import { type ModelPort, ToolRegistry } from "@axl/kernel";
import type { EventPayloadMap, JsonObject, ModelStreamEvent, Usage } from "@axl/protocol";

import { AxlApp } from "../src/index.ts";

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
  return { socketPath, directory };
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
    client: await DaemonClient.connect(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    onExit: () => {
      exited = true;
    },
  });

  // Snapshot rendered and the framed live editor shows metrics plus prompt.
  assert.match(text(), /session started in/);
  assert.match(text(), /\?\/\? \(auto\)/);
  assert.match(text(), /no-model/);

  input.write("hello axl\r");
  await until(() => text().includes("the answer"), "assistant reply");
  assert.match(text(), /│ hello axl/);
  assert.match(text(), /↑1 ↓1/);
  assert.match(text(), /tok\/s/);

  // Detach; the session persists in the daemon and resumes with history.
  input.write("\x04");
  await until(() => exited, "detach");

  const resumeInput = new PassThrough();
  const resumed = captureOutput();
  const resumedApp = await AxlApp.start({
    client: await DaemonClient.connect(socketPath),
    input: resumeInput,
    output: resumed.output,
    cwd: directory,
    sessionId: app.sessionId,
    color: false,
  });
  assert.equal(resumedApp.sessionId, app.sessionId);
  assert.match(resumed.text(), /│ hello axl/);
  assert.match(resumed.text(), /the answer/);
  resumedApp.stop();
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
    client: await DaemonClient.connect(socketPath),
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
    client: await DaemonClient.connect(socketPath),
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

test("terminal resize clears and rebuilds the complete view", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await DaemonClient.connect(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });

  input.write("keep this\r");
  await until(() => text().includes("the answer"), "assistant reply");
  const beforeWidth = text().length;
  output.columns = 60;
  output.emit("resize");
  const widthRender = text().slice(beforeWidth);
  assert.equal(widthRender.includes("\x1b[2J\x1b[H\x1b[3J"), true);
  assert.match(widthRender, /keep this/);
  assert.match(widthRender, /the answer/);

  const beforeHeight = text().length;
  output.rows = 30;
  output.emit("resize");
  assert.equal(text().slice(beforeHeight).includes("\x1b[2J\x1b[H\x1b[3J"), true);
  app.stop();
});

test("editing, /quit, and busy notices behave", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  let exited = false;

  await AxlApp.start({
    client: await DaemonClient.connect(socketPath),
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

test("command completion shows the selected command and description", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await DaemonClient.connect(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });

  input.write("/log");
  await until(() => text().includes("configure Azure OpenAI credentials"), "command completion");
  assert.match(text(), /→ \/login/);
  app.stop();
});

test("prompts entered while working queue in order", async (context) => {
  let releaseFirst = (): void => undefined;
  let calls = 0;
  const prompts: string[] = [];
  const queuedPort: ModelPort = {
    stream(request) {
      calls += 1;
      const turn = calls;
      const last = request.messages.at(-1);
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
    client: await DaemonClient.connect(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });

  input.write("one\r");
  await until(() => calls === 1, "first model call");
  input.write("two\rthree\r");
  await until(() => text().includes("queued follow-up"), "queue notice");
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
    client: await DaemonClient.connect(socketPath),
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
    client: await DaemonClient.connect(socketPath),
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

  await AxlApp.start({
    client: await DaemonClient.connect(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    models: ["gpt-5", "gpt-4.1", "gpt-4o-mini"],
    modelCatalog: AZURE_OPENAI_MODELS,
    currentModel: "gpt-5",
    onModelChange: (modelId) => {
      switched.push(modelId);
    },
  });

  input.write("/model\r");
  await until(() => text().includes("Only showing models"), "selector open");
  assert.match(text(), /→ gpt-5 \[azure-openai\] ✓/);
  assert.match(text(), /Model Name: GPT-5/);
  assert.match(text(), /Azure OpenAI catalog · 3 models/);
  assert.match(text(), /gpt-4\.1/);

  input.write("\x1b[B"); // down
  input.write("\r"); // choose
  await until(() => switched.length > 0, "selection applied");
  assert.deepEqual(switched, ["gpt-4.1"]);
  await until(() => text().includes("· model gpt-4.1"), "committed line");
  assert.match(text(), /model gpt-4\.1/);
});

test("/model digit selection and Esc cancel behave", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const switched: string[] = [];

  await AxlApp.start({
    client: await DaemonClient.connect(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
    models: ["gpt-5", "gpt-4o-mini"],
    onModelChange: (modelId) => {
      switched.push(modelId);
    },
  });

  input.write("/model\r");
  await until(() => text().includes("Only showing models"), "selector open");
  input.write("\x1b"); // cancel
  input.write("/model\r");
  await until(() => (text().match(/Only showing models/g) ?? []).length >= 2, "reopened");
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
    client: await DaemonClient.connect(socketPath),
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

test("/login reuses a global stored key in another workspace", async (context) => {
  const { socketPath, directory } = await startStack(context);
  const { FileCredentialStore } = await import("@axl/ai");
  const store = new FileCredentialStore(join(directory, "credentials.json"));
  await store.modify("azure-openai", () =>
    Promise.resolve({
      type: "api_key",
      key: "stored-key",
      env: {
        AZURE_OPENAI_BASE_URL: "https://myres.openai.azure.com/openai/v1",
        AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5.6-sol=production",
      },
    }),
  );
  const workspace = join(directory, "other-workspace");
  await mkdir(workspace);
  const input = new PassThrough();
  const { output, text } = captureOutput();
  const app = await AxlApp.start({
    client: await DaemonClient.connect(socketPath),
    input,
    output,
    cwd: workspace,
    color: false,
    credentials: {
      store,
      context: { env: () => undefined, fileExists: () => Promise.resolve(false) },
      fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    },
  });

  input.write("/login\r");
  await until(() => text().includes("leave blank to keep the stored key"), "stored login");
  input.write("\r");
  await until(() => text().includes("https://myres.openai.azure.com/openai/v1"), "stored endpoint");
  input.write("\r");
  await until(() => text().includes("gpt-5.6-sol=production"), "stored deployment map");
  input.write("\r");
  await until(() => text().includes("credentials verified with Azure"), "verification");
  const stored = await store.read("azure-openai");
  assert.equal(stored?.type, "api_key");
  assert.equal(stored?.type === "api_key" ? stored.key : undefined, "stored-key");
  app.stop();
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
    client: await DaemonClient.connect(socketPath),
    input,
    output,
    cwd: directory,
    color: false,
  });
  assert.match(text(), /· tools generic @a1b2c3d4 \(session_start\)/);

  input.write("/reload\r");
  await until(() => text().includes("(reload)"), "reload boundary rendered");
  assert.match(text(), /· tools generic @a1b2c3d4 \(reload\)/);
});
