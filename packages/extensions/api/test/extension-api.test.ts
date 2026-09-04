// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionRegistrationError,
  TerminalExtensionHost,
  type TerminalExtension,
} from "../src/index.ts";

function fixture(state: {
  activations: number;
  cleanups: number;
  events: number;
}): TerminalExtension {
  return {
    manifest: {
      id: "test.fixture",
      name: "Fixture",
      capabilities: [
        "terminal.commands",
        "terminal.shortcuts",
        "terminal.status",
        "terminal.widgets",
        "terminal.events",
        "terminal.tool-renderers",
      ],
    },
    activate(api) {
      state.activations += 1;
      api.registerCommand({
        name: "fixture",
        description: "Run fixture",
        run: () => undefined,
      });
      api.registerShortcut({
        key: "\u0010",
        description: "Fixture shortcut",
        run: () => undefined,
      });
      api.registerStatus("state", { text: "fixture ready", tone: "success" });
      api.registerWorkingLabel("Checking fixture");
      api.registerWidget("summary", {
        render: () => [{ text: "fixture widget" }],
        dispose: () => {
          state.cleanups += 1;
        },
      });
      api.registerToolRenderer("fixture", () => ({ label: "FIXTURE" }));
      api.on("working.start", () => {
        state.events += 1;
      });
      api.track(() => {
        state.cleanups += 1;
      });
      return () => {
        state.cleanups += 1;
      };
    },
  };
}

test("reload and disable remove every extension-owned registration and resource", async () => {
  const state = { activations: 0, cleanups: 0, events: 0 };
  const host = new TerminalExtensionHost([fixture(state)]);

  await host.activate();
  assert.equal(host.commands().length, 1);
  assert.equal(host.shortcuts().length, 1);
  assert.equal(host.statuses().length, 1);
  assert.equal(host.widgets("aboveEditor").length, 1);
  assert.equal(host.workingLabel(), "Checking fixture");
  assert.equal(host.toolRenderer("fixture")?.extensionId, "test.fixture");
  assert.deepEqual(await host.emit({ type: "working.start" }), []);
  assert.equal(state.events, 1);

  await host.deactivate("test.fixture");
  assert.equal(state.cleanups, 3);
  assert.equal(host.commands().length, 0);
  assert.deepEqual(host.extensionStates(), [{ id: "test.fixture", active: false }]);

  await host.activateExtension("test.fixture");
  assert.equal(state.activations, 2);
  await host.reload();
  assert.equal(state.activations, 3);
  assert.equal(state.cleanups, 6);
  assert.equal(host.commands().length, 1);
  assert.equal(host.widgets("aboveEditor").length, 1);

  await host.dispose();
  assert.equal(state.cleanups, 9);
  assert.equal(host.commands().length, 0);
  assert.equal(host.shortcuts().length, 0);
  assert.equal(host.statuses().length, 0);
  assert.equal(host.widgets("aboveEditor").length, 0);
  assert.equal(host.toolRenderer("fixture"), undefined);
  assert.equal(host.workingLabel(), undefined);
  assert.equal(state.events, 1);
});

test("disabling one extension preserves sibling registrations", async () => {
  const makeExtension = (id: string, tool: string): TerminalExtension => ({
    manifest: { id, name: id, capabilities: ["terminal.tool-renderers"] },
    activate(api) {
      api.registerToolRenderer(tool, () => ({ label: tool.toUpperCase() }));
    },
  });
  const host = new TerminalExtensionHost([
    makeExtension("test.first", "first"),
    makeExtension("test.second", "second"),
  ]);
  await host.activate();
  await host.deactivate("test.first");
  assert.equal(host.toolRenderer("first"), undefined);
  assert.equal(host.toolRenderer("second")?.extensionId, "test.second");
  await host.dispose();
});

test("disposed extension APIs cannot register new resources", async () => {
  let captured: Parameters<TerminalExtension["activate"]>[0] | undefined;
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.stale", name: "Stale", capabilities: ["terminal.status"] },
      activate(api) {
        captured = api;
      },
    },
  ]);
  await host.activate();
  await host.dispose();
  assert.throws(
    () => captured?.registerStatus("late", { text: "late" }),
    /Extension test\.stale API is stale/,
  );
  assert.equal(host.statuses().length, 0);
});

test("undeclared capabilities fail activation and roll back prior registrations", async () => {
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.invalid", name: "Invalid", capabilities: ["terminal.commands"] },
      activate(api) {
        api.registerCommand({ name: "valid", description: "Valid", run: () => undefined });
        api.registerWidget("invalid", { render: () => [] });
      },
    },
  ]);

  await assert.rejects(() => host.activate(), ExtensionRegistrationError);
  assert.equal(host.commands().length, 0);
  assert.equal(host.widgets("aboveEditor").length, 0);
});

test("dispose aborts and awaits active extension event work", async () => {
  let aborted = false;
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.cancel", name: "Cancel", capabilities: ["terminal.events"] },
      activate(api) {
        api.on("working.start", async (event) => {
          await new Promise<void>((resolvePromise) => {
            event.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolvePromise();
              },
              { once: true },
            );
          });
        });
      },
    },
  ]);
  await host.activate();
  void host.emit({ type: "working.start" });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await host.dispose();
  assert.equal(aborted, true);
});

test("hanging cleanup fails within the configured budget", async () => {
  const host = new TerminalExtensionHost(
    [
      {
        manifest: { id: "test.hanging", name: "Hanging", capabilities: [] },
        activate(api) {
          api.track(() => new Promise<void>(() => undefined));
        },
      },
    ],
    { cleanupTimeoutMs: 10 },
  );
  await host.activate();
  await assert.rejects(
    () => host.deactivate("test.hanging"),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some(
        (item) => item instanceof Error && /cleanup exceeded 10ms/.test(item.message),
      ),
  );
  assert.deepEqual(host.extensionStates(), [{ id: "test.hanging", active: false }]);
});

test("listener failures are surfaced without preventing other listeners", async () => {
  let reached = false;
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.events", name: "Events", capabilities: ["terminal.events"] },
      activate(api) {
        api.on("working.end", () => {
          throw new Error("broken listener");
        });
        api.on("working.end", () => {
          reached = true;
        });
      },
    },
  ]);
  await host.activate();

  const errors = await host.emit({ type: "working.end" });
  assert.equal(reached, true);
  assert.match(errors[0]?.message ?? "", /test\.events.*broken listener/);
  await host.dispose();
});
