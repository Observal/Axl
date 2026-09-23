// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { WebExtensionApi } from "@axl/extension-api";
import type { ConversationState, ExtensionListResult } from "@axl/sdk";

import { WebExtensionHost } from "../src/extension-host.ts";

const inventory: ExtensionListResult = {
  configPath: "/tmp/extensions.json",
  project: { root: "/tmp", trusted: true },
  commands: [],
  extensions: [
    {
      id: "example",
      path: "/tmp/example/web.mjs",
      webPath: "/tmp/example/web.mjs",
      source: "project",
      enabled: true,
    },
  ],
};

test("public browser example loads from its self-contained module", async () => {
  const module = await import(
    new URL("../../../examples/extensions/browser.mjs", import.meta.url).href
  );
  const listed = {
    ...inventory,
    extensions: inventory.extensions.map((entry) => ({ ...entry, id: "example-browser" })),
  };
  const host = await WebExtensionHost.load(
    listed,
    "123e4567-e89b-42d3-a456-426614174000",
    "http://localhost/a/",
    () => undefined,
    async () => module,
  );
  assert.equal(host.commands()[0]?.name, "hello-web");
  assert.deepEqual(host.statuses(), ["Browser extension ready"]);
  await host.dispose();
});

test("browser extension host loads approved entries, owns registrations, and rolls back failures", async () => {
  const messages: string[] = [];
  let signal: AbortSignal | undefined;
  let disposed = 0;
  const module = {
    default: {
      manifest: { id: "example", name: "Example", apiVersion: 1 },
      activate(api: WebExtensionApi) {
        signal = api.signal;
        api.registerCommand({
          name: "hello",
          description: "hello",
          run: () => api.ui.notify("hi"),
        });
        api.registerStatus("ready", "Ready");
        api.registerWidget("view", "Widget");
        api.registerMarkdownTransformer((text) => `rendered ${text}`);
        return () => {
          disposed += 1;
        };
      },
    },
  };
  const host = await WebExtensionHost.load(
    inventory,
    "123e4567-e89b-42d3-a456-426614174000",
    "http://localhost/a/",
    (text) => messages.push(text),
    async () => module,
  );
  assert.equal(host.commands()[0]?.name, "hello");
  assert.deepEqual(host.statuses(), ["Ready"]);
  assert.deepEqual(host.widgets(), ["Widget"]);
  assert.equal(host.transform("plain", "assistant"), "rendered plain");
  const original = {
    records: [
      {
        kind: "event",
        event: {
          type: "assistant.message",
          payload: { content: [{ type: "text", text: "canonical" }] },
        },
      },
    ],
  } as unknown as ConversationState;
  const rendered = host.display(original);
  assert.equal(JSON.stringify(rendered.records).includes("rendered canonical"), true);
  assert.equal(JSON.stringify(original.records).includes("rendered canonical"), false);
  await host.commands()[0]?.run("");
  assert.deepEqual(messages, ["hi"]);
  await host.dispose();
  assert.equal(signal?.aborted, true);
  assert.equal(disposed, 1);
  assert.deepEqual(host.commands(), []);
  let imported = false;
  const disabled = {
    ...inventory,
    extensions: inventory.extensions.map((entry) => ({ ...entry, enabled: false })),
  };
  const empty = await WebExtensionHost.load(
    disabled,
    "123e4567-e89b-42d3-a456-426614174000",
    "http://localhost/a/",
    () => undefined,
    async () => {
      imported = true;
      return module;
    },
  );
  assert.equal(imported, false);
  await empty.dispose();
  await assert.rejects(
    WebExtensionHost.load(
      inventory,
      "123e4567-e89b-42d3-a456-426614174000",
      "http://localhost/a/",
      () => undefined,
      async () => ({ default: { ...module.default, manifest: { id: "wrong", apiVersion: 1 } } }),
    ),
    /matching version-1 extension/,
  );
  let rollbackSignal: AbortSignal | undefined;
  await assert.rejects(
    WebExtensionHost.load(
      inventory,
      "123e4567-e89b-42d3-a456-426614174000",
      "http://localhost/a/",
      () => undefined,
      async () => ({
        default: {
          ...module.default,
          activate(api: WebExtensionApi) {
            rollbackSignal = api.signal;
            api.registerStatus("ready", "Ready");
            api.registerStatus("ready", "Duplicate");
          },
        },
      }),
    ),
    /duplicate web extension slot/,
  );
  assert.equal(rollbackSignal?.aborted, true);
});
