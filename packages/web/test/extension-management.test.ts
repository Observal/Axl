// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { WebExtensionApi } from "@axl/extension-api";
import type { AxlClient, ExtensionListResult, SessionId } from "@axl/sdk";
import { extensionManagement } from "../src/extension-management.ts";

const inventory: ExtensionListResult = {
  configPath: "/tmp/extensions.json",
  project: { root: "/tmp", trusted: true },
  commands: [],
  extensions: [
    {
      id: "example",
      path: "/tmp/example/web.mjs",
      source: "project",
      enabled: true,
      error: "last activation failed",
    },
  ],
};

test("first-party web management uses the public browser UI and typed SDK mutations", async () => {
  const calls: string[] = [];
  const client = {
    listExtensions: async () => inventory,
    disableExtension: async (params: { extensionId: string }) => {
      calls.push(`disable ${params.extensionId}`);
      return inventory;
    },
  } as unknown as AxlClient;
  const selected = ["example · enabled · project · last activation failed", "Disable"];
  let run: ((argument: string, signal: AbortSignal) => void | Promise<void>) | undefined;
  const extension = extensionManagement(client, "session" as SessionId);
  await extension.activate({
    registerCommand: (command) => {
      run = command.run;
      return () => undefined;
    },
    ui: {
      select: async () => selected.shift(),
      notify: (message: string) => {
        calls.push(message);
      },
    },
  } as unknown as WebExtensionApi);
  assert.equal(extension.manifest.id, "axl-web-management");
  await run?.("", new AbortController().signal);
  assert.deepEqual(calls, ["disable example", "example disabled"]);
});
