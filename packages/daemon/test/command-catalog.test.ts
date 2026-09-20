// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { parseSessionId } from "@axl/protocol";

import { commandCatalog } from "../src/command-catalog.ts";

test("command catalog narrows descriptors to granted capabilities and session context", () => {
  const capabilities = new Set([
    "command.list",
    "provider.list",
    "session.blob.abort",
    "session.blob.chunk",
    "session.blob.commit",
    "session.blob.start",
    "session.queue.requeue",
    "session.reload",
  ]);
  const global = commandCatalog(capabilities);
  assert.deepEqual(
    global.commands.map((command) => [command.name, command.availability.state]),
    [
      ["providers", "available"],
      ["reload", "unavailable"],
      ["requeue", "unavailable"],
      ["attach", "unavailable"],
    ],
  );

  const session = commandCatalog(
    capabilities,
    parseSessionId("00000000-0000-4000-8000-000000000001"),
  );
  assert.deepEqual(
    session.commands
      .filter((command) => command.context === "session")
      .map((command) => [command.name, command.availability.state]),
    [
      ["reload", "available"],
      ["requeue", "available"],
      ["attach", "available"],
    ],
  );
});

test("command catalog publishes the complete built-in shared directory", () => {
  const capabilities = new Set([
    "provider.auth.login",
    "provider.catalog.refresh",
    "provider.list",
    "provider.auth.logout",
    "mcp.config.list",
    "mcp.config.upsert",
    "mcp.config.remove",
    "mcp.config.probe",
    "session.blob.abort",
    "session.blob.chunk",
    "session.blob.commit",
    "session.blob.start",
    "session.clone",
    "session.compact",
    "session.configure",
    "session.delete",
    "session.dispose",
    "session.export",
    "session.fork",
    "session.import",
    "session.list",
    "session.queue.requeue",
    "session.reload",
    "session.rename",
    "session.resume",
    "session.workspace.diff",
    "session.workspace.status",
  ]);
  const catalog = commandCatalog(
    capabilities,
    parseSessionId("00000000-0000-4000-8000-000000000001"),
  );

  assert.equal(catalog.generation, "builtin-5");
  assert.deepEqual(
    catalog.commands.map((command) => command.name),
    [
      "model",
      "thinking",
      "providers",
      "login",
      "refresh",
      "logout",
      "mcp",
      "reload",
      "compact",
      "request",
      "requeue",
      "resume",
      "fork",
      "clone",
      "rename",
      "export",
      "import",
      "dispose",
      "delete",
      "review",
      "attach",
    ],
  );
  assert.deepEqual(
    catalog.commands.find((command) => command.name === "request"),
    {
      id: "core.request",
      name: "request",
      aliases: [],
      description: "show or configure model request limits",
      context: "session",
      argument: {
        required: false,
        hint: "output <tokens|model> | idle <ms|disabled>",
      },
      requiredCapabilities: ["session.configure"],
      availability: { state: "available" },
    },
  );
});
