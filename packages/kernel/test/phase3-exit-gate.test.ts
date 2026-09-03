// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

// Phase 3 exit gate: a deterministic fake-model session can inspect a fixture
// repository, edit one file, run one command, record valid tool results, and
// stop or abort without corrupting the log.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { type ModelStreamEvent, parseSessionId, type Usage } from "@axl/protocol";

import {
  AgentSession,
  makeEditTool,
  makeReadTool,
  makeShellTool,
  type ModelPort,
  replaySessionLog,
  SessionTree,
  ToolRegistry,
  verifyToolCallIntegrity,
} from "../src/index.ts";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
const usage: Usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

function scriptedPort(responses: readonly (readonly ModelStreamEvent[])[]): ModelPort {
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

function toolTurn(callId: string, name: string, input: object): readonly ModelStreamEvent[] {
  return [
    { type: "tool_call", callId, name, input: input as never },
    { type: "completed", stopReason: "tool_use", usage },
  ];
}

async function makeFixtureRepo(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "axl-phase3-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "greeting.ts"), 'export const greeting = "hello";\n');
  await writeFile(join(repo, "check.sh"), "grep -q '\"hi\"' greeting.ts && echo CHECK-PASSED\n");
  return directory;
}

test("phase 3 exit gate: inspect, edit, run, and stop over a fixture repository", async (context) => {
  const directory = await makeFixtureRepo(context);
  const repo = join(directory, "repo");
  const port = scriptedPort([
    toolTurn("call-read", "read", { path: "greeting.ts" }),
    toolTurn("call-edit", "edit", {
      path: "greeting.ts",
      oldText: '"hello"',
      newText: '"hi"',
    }),
    toolTurn("call-shell", "bash", { command: "bash check.sh" }),
    [
      { type: "text_delta", text: "Edited and verified." },
      { type: "completed", stopReason: "stop", usage },
    ],
  ]);
  const tools = new ToolRegistry();
  tools.register(makeReadTool({ cwd: repo }));
  tools.register(makeEditTool({ cwd: repo }));
  tools.register(makeShellTool({ cwd: repo, overflowDirectory: join(directory, "overflow") }));

  const session = await AgentSession.open(join(directory, "session.jsonl"), sessionId, {
    model: port,
    tools,
    cwd: repo,
    system: "You are Axl.",
  });
  const result = await session.runTurn([
    { type: "text", text: "Change the greeting to hi and verify it." },
  ]);
  await session.dispose();

  // The turn ran to a clean stop with all three tools recorded and paired.
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(
    result.events.map((event) => event.type),
    [
      "user.message",
      "assistant.message",
      "tool.call",
      "tool.result",
      "assistant.message",
      "tool.call",
      "tool.result",
      "assistant.message",
      "tool.call",
      "tool.result",
      "assistant.message",
    ],
  );
  const toolResults = result.events.filter((event) => event.type === "tool.result");
  assert.equal(toolResults.length, 3);
  for (const event of toolResults) {
    assert.equal(event.type === "tool.result" && event.payload.isError, false);
  }
  const shellResult = toolResults[2];
  if (shellResult?.type === "tool.result") {
    assert.match(
      shellResult.payload.content[0]?.type === "text" ? shellResult.payload.content[0].text : "",
      /CHECK-PASSED/,
    );
  }

  // The repository was actually edited.
  assert.equal(
    await readFile(join(repo, "greeting.ts"), "utf8"),
    'export const greeting = "hi";\n',
  );

  // The log is uncorrupted, integrity-clean, and deterministically replayable.
  const events = (
    await AgentSession.open(join(directory, "session.jsonl"), sessionId, {
      model: port,
      tools,
      cwd: repo,
    }).then(async (reopened) => {
      const read = await reopened.log.read();
      await reopened.dispose();
      return read;
    })
  ).events;
  const tree = SessionTree.fromEvents(sessionId, events);
  verifyToolCallIntegrity(tree);
  const replayed = await replaySessionLog(
    join(directory, "session.jsonl"),
    join(directory, "replay.jsonl"),
    sessionId,
  );
  assert.equal(replayed.tree.size, tree.size);
});

test("phase 3 exit gate: aborting mid-work leaves the log valid", async (context) => {
  const directory = await makeFixtureRepo(context);
  const repo = join(directory, "repo");
  const controller = new AbortController();
  const port: ModelPort = {
    stream: () =>
      (async function* () {
        yield { type: "text_delta", text: "starting" } as const;
        controller.abort();
        yield { type: "aborted" } as const;
      })(),
  };
  const session = await AgentSession.open(join(directory, "session.jsonl"), sessionId, {
    model: port,
    tools: new ToolRegistry(),
    cwd: repo,
  });
  const result = await session.runTurn([{ type: "text", text: "go" }], controller.signal);
  await session.dispose();

  assert.equal(result.stopReason, "aborted");
  const events = (await session.log.read()).events;
  verifyToolCallIntegrity(SessionTree.fromEvents(sessionId, events));
  const last = events[events.length - 1];
  assert.equal(last?.type === "assistant.message" && last.payload.stopReason, "aborted");
});
