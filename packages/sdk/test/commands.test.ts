// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type AxlClient,
  CommandController,
  type CommandListResult,
  mergeCommandDirectory,
  parseEventId,
  parseSessionId,
} from "../src/index.ts";

const sessionId = parseSessionId("00000000-0000-4000-8000-000000000001");
const queueItemId = parseEventId("00000000-0000-4000-8000-000000000002");
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
      id: "core.login",
      name: "login",
      aliases: [],
      description: "Authenticate a provider",
      context: "global",
      argument: { required: false, hint: "provider" },
      requiredCapabilities: ["provider.auth.login"],
      availability: { state: "available" },
    },
    {
      id: "core.refresh",
      name: "refresh",
      aliases: [],
      description: "Refresh provider catalogs",
      context: "global",
      argument: { required: false, hint: "provider" },
      requiredCapabilities: ["provider.catalog.refresh"],
      availability: { state: "available" },
    },
    {
      id: "core.logout",
      name: "logout",
      aliases: [],
      description: "Remove provider authentication",
      context: "global",
      argument: { required: false, hint: "provider" },
      requiredCapabilities: ["provider.auth.logout"],
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
      id: "core.request",
      name: "request",
      aliases: [],
      description: "Configure request limits",
      context: "session",
      argument: { required: false, hint: "setting" },
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
      id: "core.requeue",
      name: "requeue",
      aliases: [],
      description: "Re-queue a paused prompt",
      context: "session",
      argument: { required: false, hint: "queue item" },
      requiredCapabilities: ["session.queue.requeue"],
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
    {
      id: "core.attach",
      name: "attach",
      aliases: [],
      description: "Attach an image to the next prompt",
      context: "session",
      argument: { required: false },
      requiredCapabilities: [
        "session.blob.start",
        "session.blob.chunk",
        "session.blob.commit",
        "session.blob.abort",
      ],
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
    refreshProviderCatalogs: async (params: unknown) => {
      requests.push({ method: "provider.catalog.refresh", params });
      return { providers: [] };
    },
    logoutProvider: async (params: unknown) => {
      requests.push({ method: "provider.auth.logout", params });
      return { providerId: "azure", phase: "logged_out" as const };
    },
  } as unknown as AxlClient;
  const commands = new CommandController(client, () => [
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
  assert.deepEqual(await commands.invoke("/refresh azure", sessionId), {
    state: "provider-catalog-refreshed",
    command: "refresh",
    result: { providers: [] },
  });
  assert.deepEqual(await commands.invoke("/logout", sessionId), {
    state: "focus",
    surface: "logout",
  });
  assert.deepEqual(await commands.invoke("/logout azure", sessionId), {
    state: "provider-logged-out",
    command: "logout",
    result: { providerId: "azure", phase: "logged_out" },
  });
  assert.deepEqual(await commands.invoke("/login azure", sessionId), {
    state: "focus",
    surface: "login",
    argument: "azure",
  });
  assert.deepEqual(
    await commands.invoke("/request output 2048", sessionId, {
      requestSettings: { maxOutputTokens: null, httpIdleTimeoutMs: 30_000 },
    }),
    {
      state: "session-configured",
      command: "request",
      update: { requestSettings: { maxOutputTokens: 2048, httpIdleTimeoutMs: 30_000 } },
    },
  );
  assert.deepEqual(await commands.invoke("/compact keep decisions", sessionId), {
    state: "completed",
    command: "compact",
  });
  assert.deepEqual(await commands.invoke("/rename Focused work", sessionId), {
    state: "completed",
    command: "rename",
  });
  assert.deepEqual(await commands.invoke("/requeue", sessionId), {
    state: "focus",
    surface: "requeue",
  });
  assert.deepEqual(await commands.invoke(`/requeue ${queueItemId}`, sessionId), {
    state: "completed",
    command: "requeue",
  });
  assert.deepEqual(await commands.invoke("/import", sessionId), {
    state: "focus",
    surface: "import",
  });
  assert.deepEqual(await commands.invoke("/attach", sessionId), {
    state: "focus",
    surface: "attach",
  });
  assert.deepEqual(requests, [
    { method: "command.list", params: { sessionId } },
    { method: "session.reload", params: { sessionId } },
    { method: "provider.catalog.refresh", params: { providerId: "azure" } },
    { method: "provider.auth.logout", params: { providerId: "azure" } },
    {
      method: "session.configure",
      params: {
        sessionId,
        requestSettings: { maxOutputTokens: 2048, httpIdleTimeoutMs: 30_000 },
      },
    },
    {
      method: "session.compact",
      params: { sessionId, instructions: "keep decisions" },
    },
    { method: "session.rename", params: { sessionId, title: "Focused work" } },
    {
      method: "session.queue.requeue",
      params: { sessionId, queueItemId, priority: "back" },
    },
  ]);
});

test("command invocation rejects malformed names without ambiguous parsing", async () => {
  const commands = new CommandController({} as AxlClient);
  for (const input of ["/reload\nagain", "/bad--name", "/bad-", "/9bad", "/"]) {
    await assert.rejects(commands.invoke(input, sessionId), /Invalid command syntax/);
  }
});

test("command directory sorts daemon and presentation commands by name", () => {
  assert.deepEqual(
    mergeCommandDirectory(catalog, [
      {
        id: "web.settings",
        name: "settings",
        description: "Open settings",
        run: () => undefined,
      },
    ]).map((command) => command.name),
    [
      "attach",
      "compact",
      "import",
      "login",
      "logout",
      "refresh",
      "reload",
      "rename",
      "request",
      "requeue",
      "settings",
      "thinking",
    ],
  );
});

test("command controller reads presentation commands dynamically", async () => {
  let enabled = true;
  let runs = 0;
  const commands = new CommandController({} as AxlClient, () =>
    enabled
      ? [
          {
            id: "web.settings",
            name: "settings",
            description: "Open settings",
            run: () => {
              runs += 1;
            },
          },
        ]
      : [],
  );

  await commands.invoke("/settings");
  assert.equal(runs, 1);
  enabled = false;
  assert.deepEqual(commands.commands, []);
  await assert.rejects(commands.invoke("/settings"), /Unknown command/);
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

test("routes only /adopt and /adopt scan to the adoption surface", async () => {
  const adoptionCatalog: CommandListResult = {
    generation: "builtin-4",
    commands: [
      {
        id: "core.adopt",
        name: "adopt",
        aliases: [],
        description: "Discover resources",
        context: "global",
        argument: { required: false, hint: "scan" },
        requiredCapabilities: ["adoption.discover"],
        availability: { state: "available" },
      },
    ],
  };
  const client = {
    request: async (method: string) => {
      assert.equal(method, "command.list");
      return adoptionCatalog;
    },
  } as unknown as AxlClient;
  const controller = new CommandController(client);
  await controller.refresh();
  assert.deepEqual(await controller.invoke("/adopt"), { state: "focus", surface: "adopt" });
  assert.deepEqual(await controller.invoke("/adopt scan"), {
    state: "focus",
    surface: "adopt",
    argument: "scan",
  });
  await assert.rejects(controller.invoke("/adopt install"), /Use \/adopt or \/adopt scan/u);
});
