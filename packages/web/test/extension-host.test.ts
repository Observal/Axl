// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { WebExtensionApi } from "@axl/extension-api";
import type { ConversationState, ExtensionListResult } from "@axl/sdk";

import { WebExtensionHost, webShortcutKey } from "../src/extension-host.ts";

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
  assert.deepEqual(
    host.commands().map((command) => command.name),
    ["hello-web", "note-web"],
  );
  assert.deepEqual(host.statuses(), ["Browser extension ready"]);
  assert.equal(host.widgetEntries().length, 1);
  assert.equal(host.shortcut("Ctrl+Shift+Y") instanceof Function, true);
  assert.equal(
    host.renderMessage("example-browser", "sample", { payload: { content: "hello" } }),
    "Example context: hello",
  );
  assert.equal(
    host.renderEntry("example-browser", "sample", { payload: { value: { text: "hello" } } }),
    'Example event: {"text":"hello"}',
  );
  assert.equal(host.renderTool("browser_echo", { result: undefined }), "Example tool running");
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

test("browser registrations render bounded derived text and own shortcuts, widgets, and events", async () => {
  const events: string[] = [];
  let api: WebExtensionApi | undefined;
  let widgetSignal: AbortSignal | undefined;
  let widgetDisposed = 0;
  const host = await WebExtensionHost.load(
    inventory,
    "session",
    "http://localhost/",
    () => undefined,
    async () => ({
      default: {
        manifest: { id: "example", name: "Example", apiVersion: 1 },
        activate(value: WebExtensionApi) {
          api = value;
          value.registerShortcut({
            key: "Ctrl+Shift+Y",
            description: "Test",
            run: () => {
              events.push("shortcut");
            },
          });
          value.registerToolRenderer(
            "bash",
            (tool) => `Tool: ${String((tool as { name: string }).name)}`,
          );
          value.registerMessageRenderer("notice", () => "Extension message");
          value.registerEntryRenderer("notice", () => "Extension event");
          value.onEvent((event) => {
            events.push(event.type);
          });
          value.registerWidget("rich", {
            mount: (_root, signal) => {
              widgetSignal = signal;
              return () => {
                widgetDisposed += 1;
              };
            },
          });
        },
      },
    }),
  );
  let changed = 0;
  const unsubscribe = host.subscribe(() => {
    changed += 1;
  });
  const removeStatus = api?.registerStatus("dynamic", "Dynamic");
  assert.equal(changed, 1);
  removeStatus?.();
  assert.equal(changed, 2);
  assert.deepEqual(host.widgets(), []);
  const cleanup = host.mountWidget("example/rich", {} as HTMLElement);
  assert.equal(widgetSignal?.aborted, false);
  await cleanup();
  await cleanup();
  assert.equal(widgetDisposed, 1);
  assert.equal(widgetSignal?.aborted, true);
  assert.equal(host.renderTool("bash", { name: "bash" }), "Tool: bash");
  assert.equal(host.renderMessage("example", "notice", {}), "Extension message");
  assert.equal(host.renderEntry("example", "notice", {}), "Extension event");
  assert.equal(host.renderEntry("other", "notice", {}), undefined);
  await host.shortcut("Ctrl+Shift+Y")?.();
  await host.dispatch("session.event", { type: "assistant.message" });
  assert.deepEqual(events, ["shortcut", "session.event"]);
  assert.throws(
    () => api?.registerShortcut({ key: "Ctrl+K", description: "Reserved", run: () => undefined }),
    /reserved/,
  );
  assert.throws(
    () =>
      api?.registerShortcut({
        key: "Ctrl+Shift+Y",
        description: "Duplicate",
        run: () => undefined,
      }),
    /duplicate/,
  );
  assert.throws(() => api?.registerToolRenderer("bash", () => "duplicate"), /Duplicate/);
  api?.registerEntryRenderer("bad", () => "x".repeat(100_001));
  assert.match(host.renderEntry("example", "bad", {}) ?? "", /invalid text/);
  unsubscribe();
  await host.dispose();
  assert.equal(host.shortcut("Ctrl+Shift+Y"), undefined);
  assert.throws(() => api?.registerStatus("late", "Too late"), /disposed/);
});

test("browser extension activation errors abort and release owned registrations", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(
    WebExtensionHost.load(
      inventory,
      "session",
      "http://localhost/",
      () => undefined,
      async () => ({
        default: {
          manifest: { id: "example", name: "Example", apiVersion: 1 },
          activate(api: WebExtensionApi) {
            signal = api.signal;
            api.registerEntryRenderer("notice", () => "ready");
            throw new Error("activation failed");
          },
        },
      }),
    ),
    /activation failed/,
  );
  assert.equal(signal?.aborted, true);
});

const SESSION = "123e4567-e89b-42d3-a456-426614174000";

function builtin(id: string, activate: (api: WebExtensionApi) => void) {
  return { manifest: { id, name: id, apiVersion: 1 as const }, activate };
}

test("browser extension host rejects a built-in and installed extension with one identity", async () => {
  let imported = 0;
  await assert.rejects(
    WebExtensionHost.load(
      inventory,
      SESSION,
      "http://localhost/a/",
      () => undefined,
      async () => {
        imported++;
        return { default: builtin("example", () => undefined) };
      },
      undefined,
      [builtin("example", () => undefined)],
    ),
    /Duplicate web extension example/u,
  );
  assert.equal(imported, 0);
});

test("browser shortcuts use canonical modifier order and physical key codes", async () => {
  const modifiers = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  assert.equal(
    webShortcutKey({ ...modifiers, code: "Digit1", shiftKey: true, altKey: true }),
    "Alt+Shift+1",
  );
  assert.equal(webShortcutKey({ ...modifiers, code: "KeyS", altKey: true }), "Alt+S");
  assert.equal(webShortcutKey({ ...modifiers, code: "ArrowUp", altKey: true }), undefined);
  const host = await WebExtensionHost.load(
    { ...inventory, extensions: [] },
    SESSION,
    "http://localhost/a/",
    () => undefined,
    undefined,
    undefined,
    [
      builtin("keys", (api) => {
        for (const key of ["Shift+Alt+X", "Alt+Alt+X", "X", "Ctrl+K", "Meta+Shift+R"])
          assert.throws(
            () => api.registerShortcut({ key, description: key, run: () => undefined }),
            /Invalid, reserved, or duplicate web shortcut/u,
          );
        api.registerShortcut({ key: "Alt+Shift+1", description: "digit", run: () => undefined });
      }),
    ],
  );
  assert.equal(host.shortcut("Alt+Shift+1") instanceof Function, true);
  await host.dispose();
});

test("browser widget cleanup runs once when the host is disposed before unmount", async () => {
  let cleaned = 0;
  let signal: AbortSignal | undefined;
  const host = await WebExtensionHost.load(
    { ...inventory, extensions: [] },
    SESSION,
    "http://localhost/a/",
    () => undefined,
    undefined,
    undefined,
    [
      builtin("widgets", (api) => {
        api.registerWidget("panel", {
          mount(_root, mounted) {
            signal = mounted;
            return () => {
              cleaned++;
            };
          },
        });
      }),
    ],
  );
  const [entry] = host.widgetEntries();
  assert.ok(entry);
  const unmount = host.mountWidget(entry.key, {} as HTMLElement);
  await host.dispose();
  assert.equal(signal?.aborted, true);
  assert.equal(cleaned, 1);
  await unmount();
  assert.equal(cleaned, 1);
});

test("browser event dispatch isolates handler failures and stops after disposal", async () => {
  const seen: string[] = [];
  let host: WebExtensionHost | undefined;
  host = await WebExtensionHost.load(
    { ...inventory, extensions: [] },
    SESSION,
    "http://localhost/a/",
    () => undefined,
    undefined,
    undefined,
    [
      builtin("events", (api) => {
        api.onEvent(() => {
          seen.push("first");
          throw new Error("observer failed");
        });
        api.onEvent(async () => {
          seen.push("second");
          await host?.dispose();
        });
        api.onEvent(() => {
          seen.push("third");
        });
      }),
    ],
  );
  await assert.rejects(host.dispatch("working.start"), /Web extension event handler failed/u);
  assert.deepEqual(seen, ["first", "second"]);
});
