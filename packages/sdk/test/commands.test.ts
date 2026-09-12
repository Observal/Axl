// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type AxlClient,
  CommandController,
  type CommandListResult,
  mergeCommandDirectory,
  parseSessionId,
} from "../src/index.ts";

const sessionId = parseSessionId("00000000-0000-4000-8000-000000000001");
const catalog: CommandListResult = {
  generation: "builtin-1",
  commands: [
    {
      id: "core.reload",
      name: "reload",
      aliases: [],
      description: "Reload project instructions, prompt, and tools",
      context: "session",
      argument: { required: false },
      requiredCapabilities: ["session.reload"],
      availability: { state: "available" },
    },
    {
      id: "core.thinking",
      name: "thinking",
      aliases: ["effort"],
      description: "Select reasoning effort",
      context: "session",
      argument: { required: false, hint: "level" },
      requiredCapabilities: ["session.configure"],
      availability: { state: "available" },
    },
    {
      id: "core.compact",
      name: "compact",
      aliases: [],
      description: "Summarize older context",
      context: "session",
      argument: { required: false, hint: "instructions" },
      requiredCapabilities: ["session.compact"],
      availability: { state: "available" },
    },
    {
      id: "core.rename",
      name: "rename",
      aliases: [],
      description: "Rename the session",
      context: "session",
      argument: { required: true, hint: "title" },
      requiredCapabilities: ["session.rename"],
      availability: { state: "available" },
    },
    {
      id: "core.import",
      name: "import",
      aliases: [],
      description: "Import a session",
      context: "global",
      argument: { required: false },
      requiredCapabilities: ["session.import"],
      availability: { state: "available" },
    },
  ],
};

test("command controller loads, searches, and invokes typed operations", async () => {
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const client = {
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "command.list") return catalog;
      return method === "session.reload" ? { boundaryEventIds: [] } : {};
    },
  } as unknown as AxlClient;
  const commands = new CommandController(client, [
    {
      id: "web.settings",
      name: "settings",
      description: "Open web settings",
      run: () => undefined,
    },
  ]);

  await commands.refresh(sessionId);
  assert.deepEqual(
    commands.search("relo").map((command) => command.name),
    ["reload"],
  );
  assert.equal((await commands.invoke("/thinking", sessionId)).state, "focus");
  assert.deepEqual(await commands.invoke("/reload", sessionId), {
    state: "completed",
    command: "reload",
  });
  assert.deepEqual(await commands.invoke("/compact keep decisions", sessionId), {
    state: "completed",
    command: "compact",
  });
  assert.deepEqual(await commands.invoke("/rename Focused work", sessionId), {
    state: "completed",
    command: "rename",
  });
  assert.deepEqual(await commands.invoke("/import", sessionId), {
    state: "focus",
    surface: "import",
  });
  assert.deepEqual(requests, [
    { method: "command.list", params: { sessionId } },
    { method: "session.reload", params: { sessionId } },
    {
      method: "session.compact",
      params: { sessionId, instructions: "keep decisions" },
    },
    { method: "session.rename", params: { sessionId, title: "Focused work" } },
  ]);
});

test("command invocation rejects malformed names without ambiguous parsing", async () => {
  const commands = new CommandController({} as AxlClient);
  for (const input of ["/reload\nagain", "/bad--name", "/bad-", "/9bad", "/"]) {
    await assert.rejects(commands.invoke(input, sessionId), /Invalid command syntax/);
  }
});

test("command directory rejects aliases that shadow another command", () => {
  assert.throws(
    () =>
      mergeCommandDirectory(catalog, [
        {
          id: "web.reload",
          name: "settings",
          aliases: ["reload"],
          description: "Conflict",
          run: () => undefined,
        },
      ]),
    /Command name collision: \/reload/,
  );
});
