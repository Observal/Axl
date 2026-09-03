// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { type ModelStreamEvent, parseSessionId, type Usage } from "@axl/protocol";

import {
  AgentSession,
  buildStablePrompt,
  loadAgentsInstructions,
  makeMinimalProfileTools,
  type ModelPort,
  type ModelTurnRequest,
  OperationConflictError,
  ToolRegistry,
} from "../src/index.ts";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
const usage: Usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

async function workspace(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "axl-prompt-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function scriptedPort(count: number): { port: ModelPort; requests: ModelTurnRequest[] } {
  const requests: ModelTurnRequest[] = [];
  let remaining = count;
  return {
    requests,
    port: {
      stream(request) {
        if (remaining === 0) throw new Error("no scripted response left");
        remaining -= 1;
        requests.push({ ...request, messages: [...request.messages] });
        return (async function* () {
          yield { type: "text_delta", text: "ok" } as ModelStreamEvent;
          yield { type: "completed", stopReason: "stop", usage } as ModelStreamEvent;
        })();
      },
    },
  };
}

test("the stable prompt contains exactly the specified base and nothing more", () => {
  const prompt = buildStablePrompt({
    cwd: "/workspace/repo",
    tools: [
      { name: "shell", description: "Run a shell command" },
      { name: "edit", description: "Replace exact text in a file" },
    ],
    instructions: [
      { name: "agents-project", source: "/workspace/repo/AGENTS.md", content: "Use pnpm." },
    ],
  });

  assert.match(prompt.text, /You are Axl/);
  assert.match(prompt.text, /Working directory: \/workspace\/repo/);
  assert.match(prompt.text, /- shell: Run a shell command/);
  assert.match(prompt.text, /Use pnpm\./);
  assert.match(prompt.text, /Never fabricate/);
  // No subagent instructions, skill bodies, or feature catalogs, ever.
  assert.doesNotMatch(prompt.text, /subagent|delegate|skill|plugin|plan mode/i);
  assert.deepEqual(
    prompt.sections.map((section) => section.name),
    ["identity", "workspace", "tools", "constraints", "agents-project"],
  );
});

test("identical input builds a byte-identical prompt", () => {
  const input = {
    cwd: "/repo",
    tools: [{ name: "shell", description: "Run a command" }],
  };
  assert.equal(buildStablePrompt(input).text, buildStablePrompt(input).text);
});

test("loadAgentsInstructions reads applicable files and skips missing ones", async (context) => {
  const cwd = await workspace(context);
  const globalPath = join(cwd, "global-agents.md");
  await writeFile(join(cwd, "AGENTS.md"), "Project rules.\n");
  await writeFile(globalPath, "Global rules.\n");

  const both = await loadAgentsInstructions({ cwd, globalPath });
  assert.deepEqual(
    both.map((section) => [section.name, section.content]),
    [
      ["agents-global", "Global rules."],
      ["agents-project", "Project rules."],
    ],
  );

  const projectOnly = await loadAgentsInstructions({ cwd });
  assert.equal(projectOnly.length, 1);

  const none = await loadAgentsInstructions({ cwd: join(cwd, "empty-missing-dir") });
  assert.deepEqual(none, []);
});

test("a fresh session logs prompt sections once and freezes the prefix", async (context) => {
  const cwd = await workspace(context);
  const prompt = buildStablePrompt({ cwd, tools: [] });
  const { port, requests } = scriptedPort(2);
  const path = join(cwd, "session.jsonl");

  const session = await AgentSession.open(path, sessionId, {
    model: port,
    tools: new ToolRegistry(),
    cwd,
    prompt,
  });
  await session.runTurn([{ type: "text", text: "one" }]);
  await session.dispose();

  const events = (await session.log.read()).events;
  const sections = events.filter((event) => event.type === "prompt.section");
  assert.deepEqual(
    sections.map((event) => (event.type === "prompt.section" ? event.payload.name : "")),
    ["identity", "workspace", "tools", "constraints"],
  );

  // Reopening logs no duplicate sections; the system prefix is byte-identical.
  const reopened = await AgentSession.open(path, sessionId, {
    model: port,
    tools: new ToolRegistry(),
    cwd,
    prompt,
  });
  await reopened.runTurn([{ type: "text", text: "two" }]);
  await reopened.dispose();
  const after = (await reopened.log.read()).events;
  assert.equal(after.filter((event) => event.type === "prompt.section").length, 4);
  assert.equal(requests[0]?.system, prompt.text);
  assert.equal(requests[1]?.system, prompt.text);
});

test("context injection appends without rewriting anything already sent", async (context) => {
  const cwd = await workspace(context);
  const { port, requests } = scriptedPort(2);
  const session = await AgentSession.open(join(cwd, "session.jsonl"), sessionId, {
    model: port,
    tools: new ToolRegistry(),
    cwd,
    system: "You are Axl.",
  });

  await session.runTurn([{ type: "text", text: "first" }]);
  await session.injectContext("skill:release-checklist", "1. Run the tests.\n2. Tag.");
  await session.runTurn([{ type: "text", text: "second" }]);
  await session.dispose();

  const first = requests[0]?.messages ?? [];
  const second = requests[1]?.messages ?? [];
  // Append-only: the second request begins with the first request's messages, unchanged.
  assert.deepEqual(second.slice(0, first.length), first);
  assert.equal(second.length, first.length + 3); // assistant reply, injected context, new user turn
  const injected = second[first.length + 1];
  assert.equal(injected?.role, "user");
  if (injected?.role === "user") {
    assert.match(
      injected.content[0]?.type === "text" ? injected.content[0].text : "",
      /^\[skill:release-checklist\]\n1\. Run the tests\./,
    );
  }

  // The injection survives resume through the same projection.
  const resumed = await AgentSession.open(join(cwd, "session.jsonl"), sessionId, {
    model: scriptedPort(0).port,
    tools: new ToolRegistry(),
    cwd,
  });
  await resumed.dispose();
  const events = (await resumed.log.read()).events;
  assert.equal(
    events.some((event) => event.type === "context.injected"),
    true,
  );
});

test("context injection is refused while an operation owns the branch", async (context) => {
  const cwd = await workspace(context);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const port: ModelPort = {
    stream: () =>
      (async function* () {
        await gate;
        yield { type: "completed", stopReason: "stop", usage } as const;
      })(),
  };
  const session = await AgentSession.open(join(cwd, "session.jsonl"), sessionId, {
    model: port,
    tools: new ToolRegistry(),
    cwd,
  });
  const turn = session.runTurn([{ type: "text", text: "go" }]);
  await assert.rejects(session.injectContext("steer", "stop that"), OperationConflictError);
  release?.();
  await turn;
  await session.dispose();
});

test("the minimal profile is exactly bash and edit", async (context) => {
  const cwd = await workspace(context);
  const tools = makeMinimalProfileTools({ cwd, overflowDirectory: join(cwd, ".overflow") });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["bash", "edit"],
  );

  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  assert.deepEqual(
    registry.declarations().map((declaration) => declaration.name),
    ["bash", "edit"],
  );
  assert.equal(registry.get("read"), undefined);
});
