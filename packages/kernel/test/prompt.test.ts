// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { type ModelStreamEvent, parseSessionId, type Usage } from "@axl/protocol";

import {
  AgentSession,
  buildStablePrompt,
  loadAgentsInstructions,
  loadAgentsResources,
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

  assert.equal(
    prompt.text,
    `You are Axl, a coding agent. You help users inspect repositories, run commands, edit code, and verify changes.

Available tools:
- shell: Run a shell command
- edit: Replace exact text in a file

Guidelines:
- Prefer small, verifiable steps and report what you actually did.
- When a command or edit fails, show the failure rather than working around it silently.
- Never fabricate file contents or command output.

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/workspace/repo/AGENTS.md">
Use pnpm.
</project_instructions>

</project_context>

Current working directory: /workspace/repo`,
  );
  // No subagent instructions, skill bodies, or feature catalogs, ever.
  assert.doesNotMatch(prompt.text, /subagent|delegate|skill|plugin|plan mode/i);
  assert.deepEqual(
    prompt.sections.map((section) => section.name),
    ["identity", "tools", "constraints", "project-context", "workspace"],
  );
});

test("identical input builds a byte-identical prompt", () => {
  const input = {
    cwd: "/repo",
    tools: [{ name: "shell", description: "Run a command" }],
  };
  assert.equal(buildStablePrompt(input).text, buildStablePrompt(input).text);
});

test("capability search covers missing abilities and slash-command requests", () => {
  const prompt = buildStablePrompt({
    cwd: "/repo",
    tools: [{ name: "capability_search", description: "Search optional capabilities" }],
  });
  assert.match(prompt.text, /ability not shown under Available tools/);
  assert.match(prompt.text, /slash commands are not shell commands/i);
  assert.deepEqual(
    prompt.sections.map((section) => section.name),
    ["identity", "tools", "capability-discovery", "constraints", "workspace"],
  );
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
      ["agents-global-0", "Global rules."],
      ["agents-project-1", "Project rules."],
    ],
  );

  const projectOnly = await loadAgentsInstructions({ cwd });
  assert.equal(projectOnly.length, 1);

  await mkdir(join(cwd, "empty-missing-dir"));
  const none = await loadAgentsInstructions({ cwd: join(cwd, "empty-missing-dir") });
  assert.deepEqual(none, []);
});

test("discovers hierarchical instructions and same-directory overrides", async (context) => {
  const outside = await workspace(context);
  const root = join(outside, "repo");
  const cwd = join(root, "packages", "app");
  const global = join(outside, ".axl");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(global);
  await writeFile(join(outside, "AGENTS.md"), "Must not cross the repository root.\n");
  await writeFile(join(global, "AGENTS.md"), "Global default.\n");
  await writeFile(join(global, "AGENTS.override.md"), "Global override.\n");
  await writeFile(join(root, "AGENTS.md"), "Repository rules.\n");
  await writeFile(join(root, "packages", "AGENTS.md"), "Package rules.\n");
  await writeFile(join(cwd, "AGENTS.md"), "App default.\n");
  await writeFile(join(cwd, "AGENTS.override.md"), "App override.\n");

  const resources = await loadAgentsResources({ cwd, globalPath: join(global, "AGENTS.md") });
  assert.deepEqual(
    resources.map(({ scope, path, content }) => [scope, path, content]),
    [
      ["global", join(global, "AGENTS.override.md"), "Global override."],
      ["project", join(root, "AGENTS.md"), "Repository rules."],
      ["project", join(root, "packages", "AGENTS.md"), "Package rules."],
      ["project", join(cwd, "AGENTS.override.md"), "App override."],
    ],
  );
});

test("rejects unsafe AGENTS.md resources", async (context) => {
  const root = await workspace(context);
  const outside = await workspace(context);
  await mkdir(join(root, ".git"));
  await writeFile(join(outside, "rules.md"), "Escaped rules.\n");
  await symlink(join(outside, "rules.md"), join(root, "AGENTS.md"));
  await assert.rejects(
    loadAgentsResources({ cwd: root }),
    /AGENTS\.md path escapes its trusted root/,
  );

  await rm(join(root, "AGENTS.md"));
  await writeFile(join(root, "AGENTS.md"), Buffer.from([0x61, 0x00, 0x62]));
  await assert.rejects(loadAgentsResources({ cwd: root }), /AGENTS\.md file is binary/);

  await writeFile(join(root, "AGENTS.md"), Buffer.alloc(512 * 1024 + 1, 0x61));
  await assert.rejects(loadAgentsResources({ cwd: root }), /must not exceed 524288 bytes/);
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
    ["identity", "tools", "constraints", "workspace"],
  );
  assert.deepEqual(events.find((event) => event.type === "context.resources")?.payload, {
    resources: [],
  });

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
  assert.equal(after.filter((event) => event.type === "context.resources").length, 1);
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
