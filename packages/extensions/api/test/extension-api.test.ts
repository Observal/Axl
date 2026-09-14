// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVITY_LIMITS,
  type ActivityContext,
  ActivityContractError,
  type ActivityHostServices,
  type ActivitySafeStatus,
  type ActivityStorage,
  type ActivityStorageAdapter,
  ActivityStorageError,
  type ActivityStorageScope,
  type ActivityStoredValue,
  ExtensionRegistrationError,
  type JsonValue,
  type TerminalExtension,
  TerminalExtensionHost,
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

test("initially inactive extensions perform no activation work until explicitly enabled", async () => {
  let activations = 0;
  let cleanups = 0;
  const extension: TerminalExtension = {
    manifest: {
      id: "test.opt-in",
      name: "Opt-in",
      capabilities: ["terminal.commands", "terminal.activities"],
    },
    activate(api) {
      activations += 1;
      api.registerCommand({ name: "opt-in", description: "Opt-in fixture", run: () => undefined });
      api.registerActivity({
        id: "test.opt-in-activity",
        name: "Opt-in activity",
        description: "Inactive fixture",
        category: "game",
        create: () => ({
          render: () => ({ lines: [] }),
          handleInput: () => undefined,
          pause: () => undefined,
          resume: () => undefined,
          serialize: () => undefined,
          dispose: () => undefined,
        }),
      });
      return () => {
        cleanups += 1;
      };
    },
  };
  const host = new TerminalExtensionHost([extension], {
    initiallyInactiveExtensionIds: ["test.opt-in"],
  });

  await host.activate();
  assert.equal(activations, 0);
  assert.deepEqual(host.commands(), []);
  assert.deepEqual(host.activities(), []);
  await host.setExtensionEnabled("test.opt-in", true);
  assert.equal(activations, 1);
  assert.equal(host.commands().length, 1);
  assert.equal(host.activities().length, 1);
  await host.setExtensionEnabled("test.opt-in", false);
  assert.equal(cleanups, 1);
  assert.deepEqual(host.commands(), []);
  assert.deepEqual(host.activities(), []);
  await host.reload();
  assert.equal(activations, 1);
  await host.dispose();
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

test("a public activity renders, receives structured input, schedules, pauses, resumes, and disposes", async () => {
  let context: Parameters<TerminalExtension["activate"]>[0] | undefined;
  let activityContext: ActivityContext | undefined;
  const inputs: string[] = [];
  const pauses: string[] = [];
  let resumes = 0;
  let presentationChanges = 0;
  let disposals = 0;
  const host = new TerminalExtensionHost([
    {
      manifest: {
        id: "test.activity",
        name: "Activity",
        capabilities: ["terminal.activities"],
      },
      activate(api) {
        context = api;
        api.registerActivity({
          id: "test.game",
          name: "Test Game",
          description: "A deterministic activity fixture",
          category: "game",
          mouse: true,
          create(createdContext) {
            activityContext = createdContext;
            return {
              render: () => ({ lines: [[{ text: "ready", style: "success" }]] }),
              handleInput: (input) => inputs.push(input.type),
              presentationChanged: () => {
                presentationChanges += 1;
              },
              pause: (reason) => pauses.push(reason),
              resume: () => {
                resumes += 1;
              },
              serialize: () => ({ inputs: inputs.length }),
              dispose: () => {
                disposals += 1;
              },
            };
          },
        });
      },
    },
  ]);
  await host.activate();
  assert.ok(context);
  assert.deepEqual(
    host.activities().map(({ id }) => id),
    ["test.game"],
  );

  let now = 10;
  let invalidations = 0;
  const scheduled: Array<{ active: boolean; callback: () => void }> = [];
  const services: ActivityHostServices = {
    now: () => now,
    schedule: (_delay, callback) => {
      const item = { active: true, callback };
      scheduled.push(item);
      return () => {
        item.active = false;
      };
    },
    invalidate: () => {
      invalidations += 1;
    },
    status: () => ({
      operation: "working",
      elapsedMs: 5,
      activeToolCount: 1,
      queuedInput: { steer: 0, followUp: 1, interrupt: 0 },
    }),
    presentation: () => ({ reducedMotion: false, textOnly: false }),
  };
  const instance = host.createActivity("test.game", services);
  const firstEpoch = instance.epoch;
  assert.deepEqual(instance.render(firstEpoch, { width: 40, height: 18 }), {
    lines: [[{ text: "ready", style: "success" }]],
  });
  instance.handleInput(firstEpoch, {
    type: "key",
    key: "a",
    ctrl: false,
    alt: false,
    shift: false,
    repeat: false,
  });
  instance.handleInput(firstEpoch, {
    type: "mouse",
    phase: "press",
    button: "left",
    row: 3,
    column: 7,
    ctrl: false,
    alt: false,
    shift: false,
  });
  assert.throws(
    () =>
      instance.handleInput(firstEpoch, {
        type: "mouse",
        phase: "press",
        button: "left",
        row: -1,
        column: 7,
        ctrl: false,
        alt: false,
        shift: false,
      }),
    /outside host bounds/,
  );
  assert.throws(
    () =>
      instance.handleInput(firstEpoch, {
        type: "mouse",
        phase: "press",
        button: "left",
        row: 18,
        column: 7,
        ctrl: false,
        alt: false,
        shift: false,
      }),
    /outside its rendered viewport/,
  );
  activityContext?.invalidate();
  activityContext?.invalidate();
  assert.equal(invalidations, 1);
  instance.render(firstEpoch, { width: 40, height: 18 });
  activityContext?.invalidate();
  assert.equal(invalidations, 2);
  let elapsed = -1;
  activityContext?.schedule(20, (value) => {
    elapsed = value;
  });
  now = 35;
  scheduled[0]?.callback();
  scheduled[0]?.callback();
  assert.equal(elapsed, 25);

  activityContext?.schedule(20, () => inputs.push("presentation tick"));
  instance.presentationChanged(firstEpoch);
  assert.equal(presentationChanges, 1);
  assert.equal(scheduled[1]?.active, false);
  activityContext?.schedule(20, () => inputs.push("pause tick"));
  const activeSignal = activityContext?.signal;
  instance.pause(firstEpoch, "attention");
  const pausedEpoch = instance.epoch;
  assert.equal(activeSignal?.aborted, true);
  assert.equal(scheduled[2]?.active, false);
  assert.deepEqual(instance.serialize(pausedEpoch), { inputs: 2 });
  assert.throws(() => instance.handleInput(firstEpoch, { type: "unknown" }), /stale epoch/);
  assert.throws(() => activityContext?.invalidate(), /context is stale/);
  instance.resume(pausedEpoch);
  assert.equal(activityContext?.signal.aborted, false);
  assert.equal(resumes, 1);
  assert.deepEqual(pauses, ["attention"]);
  await instance.dispose();
  await instance.dispose();
  assert.equal(disposals, 1);
  await host.dispose();
});

test("failed activity creation invalidates its captured context", async () => {
  let captured: ActivityContext | undefined;
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.create", name: "Create", capabilities: ["terminal.activities"] },
      activate(api) {
        api.registerActivity({
          id: "test.broken-game",
          name: "Broken game",
          description: "Fails during creation",
          category: "game",
          create(context) {
            captured = context;
            throw new Error("creation failed");
          },
        });
      },
    },
  ]);
  await host.activate();
  assert.throws(
    () => host.createActivity("test.broken-game", activityServices()),
    /creation failed/,
  );
  assert.equal(captured?.signal.aborted, true);
  assert.throws(() => captured?.invalidate(), /context is stale/);
  await host.dispose();
});

test("activity status is immutable and excludes unbounded host details", async () => {
  let received: ActivitySafeStatus | undefined;
  let presentation: ReturnType<ActivityContext["presentation"]> | undefined;
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.status", name: "Status", capabilities: ["terminal.activities"] },
      activate(api) {
        api.registerActivity({
          id: "test.status-game",
          name: "Status game",
          description: "Reads safe status",
          category: "game",
          create(context) {
            received = context.status();
            presentation = context.presentation();
            return {
              render: () => ({ lines: [] }),
              handleInput: () => undefined,
              pause: () => undefined,
              resume: () => undefined,
              serialize: () => undefined,
              dispose: () => undefined,
            };
          },
        });
      },
    },
  ]);
  await host.activate();
  const status: ActivitySafeStatus = {
    operation: "working",
    activeToolCount: 2,
    queuedInput: { steer: 1, followUp: 2, interrupt: 3 },
  };
  const services: ActivityHostServices = {
    now: () => 1,
    schedule: () => () => undefined,
    invalidate: () => undefined,
    status: () => status,
    presentation: () => ({ reducedMotion: true, textOnly: false }),
  };
  host.createActivity("test.status-game", services);
  assert.deepEqual(received, status);
  assert.equal(Object.isFrozen(received), true);
  assert.equal(Object.isFrozen(received?.queuedInput), true);
  assert.deepEqual(presentation, { reducedMotion: true, textOnly: false });
  assert.equal(Object.isFrozen(presentation), true);
  await host.dispose();
});

class MemoryStorage implements ActivityStorageAdapter {
  private stored: ActivityStoredValue | undefined;

  read(
    _scope: ActivityStorageScope,
    _signal: AbortSignal,
  ): Promise<ActivityStoredValue | undefined> {
    return Promise.resolve(this.stored);
  }

  write(
    _scope: ActivityStorageScope,
    expectedRevision: number | null,
    schemaVersion: number,
    value: JsonValue,
    _signal: AbortSignal,
  ): Promise<ActivityStoredValue> {
    const revision = this.stored?.revision;
    if ((revision ?? null) !== expectedRevision) {
      throw new ActivityStorageError("conflict", "stale revision");
    }
    this.stored = { revision: (revision ?? 0) + 1, schemaVersion, value };
    return Promise.resolve(this.stored);
  }

  reset(
    _scope: ActivityStorageScope,
    expectedRevision: number,
    _signal: AbortSignal,
  ): Promise<void> {
    if (this.stored?.revision !== expectedRevision) {
      throw new ActivityStorageError("conflict", "stale revision");
    }
    this.stored = undefined;
    return Promise.resolve();
  }
}

function activityServices(storage?: ActivityStorageAdapter): ActivityHostServices {
  return {
    now: () => 1,
    schedule: () => () => undefined,
    invalidate: () => undefined,
    status: () => ({
      operation: "idle",
      activeToolCount: 0,
      queuedInput: { steer: 0, followUp: 0, interrupt: 0 },
    }),
    presentation: () => ({ reducedMotion: false, textOnly: false }),
    ...(storage === undefined ? {} : { storage }),
  };
}

test("activity storage enforces bounded JSON compare-and-swap writes", async () => {
  let storage: ActivityStorage | undefined;
  const host = new TerminalExtensionHost([
    {
      manifest: {
        id: "test.storage",
        name: "Storage",
        capabilities: ["terminal.activities", "terminal.activity-storage"],
      },
      activate(api) {
        api.registerActivity({
          id: "test.saved-game",
          name: "Saved game",
          description: "Uses bounded storage",
          category: "game",
          create(context) {
            storage = context.storage;
            return {
              render: () => ({ lines: [] }),
              handleInput: () => undefined,
              pause: () => undefined,
              resume: () => undefined,
              serialize: () => null,
              dispose: () => undefined,
            };
          },
        });
      },
    },
  ]);
  await host.activate();
  const instance = host.createActivity("test.saved-game", activityServices(new MemoryStorage()));
  if (storage === undefined) throw new Error("Activity storage was not injected");
  const activityStorage = storage;
  const first = await activityStorage.write(null, 1, { board: [1, 2, 3] });
  assert.equal(first.revision, 1);
  await assert.rejects(
    () => activityStorage.write(null, 1, { board: [] }),
    (error: unknown) => error instanceof ActivityStorageError && error.code === "conflict",
  );
  const second = await activityStorage.write(1, 1, { board: [3, 2, 1] });
  assert.equal(second.revision, 2);
  assert.deepEqual(await activityStorage.read(), second);
  assert.throws(
    () => activityStorage.write(2, 1, { value: Number.NaN } as unknown as JsonValue),
    (error: unknown) => error instanceof ActivityStorageError && error.code === "invalid",
  );
  assert.throws(
    () => activityStorage.write(2, 1, "x".repeat(ACTIVITY_LIMITS.maxStoredBytes + 1)),
    (error: unknown) => error instanceof ActivityStorageError && error.code === "oversized",
  );
  await activityStorage.reset(2);
  assert.equal(await activityStorage.read(), undefined);
  await instance.dispose();
  await host.dispose();
});

test("late storage completion and stale activity epochs are rejected", async () => {
  let resolveRead: ((value: ActivityStoredValue | undefined) => void) | undefined;
  let storage: Parameters<ActivityStorageAdapter["write"]>[3] | undefined;
  let publicStorage: ActivityStorage | undefined;
  const adapter: ActivityStorageAdapter = {
    read: () =>
      new Promise((resolvePromise) => {
        resolveRead = resolvePromise;
      }),
    write: (_scope, _revision, schemaVersion, value) => {
      storage = value;
      return Promise.resolve({ revision: 1, schemaVersion, value });
    },
    reset: () => Promise.resolve(),
  };
  const host = new TerminalExtensionHost([
    {
      manifest: {
        id: "test.late",
        name: "Late",
        capabilities: ["terminal.activities", "terminal.activity-storage"],
      },
      activate(api) {
        api.registerActivity({
          id: "test.late-game",
          name: "Late game",
          description: "Tests stale async work",
          category: "game",
          create(context) {
            publicStorage = context.storage;
            return {
              render: () => ({ lines: [] }),
              handleInput: () => undefined,
              pause: () => undefined,
              resume: () => undefined,
              serialize: () => storage as JsonValue | undefined,
              dispose: () => undefined,
            };
          },
        });
      },
    },
  ]);
  await host.activate();
  const instance = host.createActivity("test.late-game", activityServices(adapter));
  if (publicStorage === undefined) throw new Error("Activity storage was not injected");
  const pending = publicStorage.read();
  instance.pause(instance.epoch, "attention");
  resolveRead?.({ revision: 1, schemaVersion: 1, value: null });
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof ActivityStorageError && error.code === "aborted",
  );
  await instance.dispose();
  await host.dispose();
});

test("duplicate activity registration rolls back the failing activation", async () => {
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.duplicate", name: "Duplicate", capabilities: ["terminal.activities"] },
      activate(api) {
        const activity = {
          id: "test.same",
          name: "Same",
          description: "Duplicate fixture",
          category: "game" as const,
          create: () => ({
            render: () => ({ lines: [] }),
            handleInput: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
            serialize: () => undefined,
            dispose: () => undefined,
          }),
        };
        api.registerActivity(activity);
        api.registerActivity(activity);
      },
    },
  ]);
  await assert.rejects(() => host.activate(), /Activity test\.same is already registered/);
  assert.deepEqual(host.activities(), []);
});

test("a duplicate activity activation preserves the existing owner", async () => {
  let registerDuplicate = false;
  const activity = {
    id: "test.shared-game",
    name: "Shared game",
    description: "Owned by the first extension",
    category: "game" as const,
    create: () => ({
      render: () => ({ lines: [] }),
      handleInput: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      serialize: () => undefined,
      dispose: () => undefined,
    }),
  };
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.owner", name: "Owner", capabilities: ["terminal.activities"] },
      activate: (api) => {
        api.registerActivity(activity);
      },
    },
    {
      manifest: { id: "test.contender", name: "Contender", capabilities: ["terminal.activities"] },
      activate: (api) => {
        if (registerDuplicate) api.registerActivity(activity);
      },
    },
  ]);
  await host.activate();
  await host.deactivate("test.contender");
  registerDuplicate = true;
  await assert.rejects(() => host.activateExtension("test.contender"), /already registered/);
  assert.equal(host.activities()[0]?.extensionId, "test.owner");
  await host.dispose();
});

test("activity frame bounds fail visibly", async () => {
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.frame", name: "Frame", capabilities: ["terminal.activities"] },
      activate(api) {
        api.registerActivity({
          id: "test.large-frame",
          name: "Large frame",
          description: "Exceeds frame bounds",
          category: "game",
          create: () => ({
            render: () => ({
              lines: Array.from({ length: 19 }, () => [{ text: "line", style: "text" as const }]),
            }),
            handleInput: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
            serialize: () => undefined,
            dispose: () => undefined,
          }),
        });
      },
    },
  ]);
  await host.activate();
  const instance = host.createActivity("test.large-frame", activityServices());
  assert.throws(
    () => instance.render(instance.epoch, { width: 40, height: 18 }),
    ActivityContractError,
  );
  await host.dispose();
});

test("activity disposal stays one-shot when instance cleanup throws", async () => {
  let attempts = 0;
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.throwing", name: "Throwing", capabilities: ["terminal.activities"] },
      activate(api) {
        api.registerActivity({
          id: "test.throwing-game",
          name: "Throwing game",
          description: "Throws during cleanup",
          category: "game",
          create: () => ({
            render: () => ({ lines: [] }),
            handleInput: () => undefined,
            pause: () => undefined,
            resume: () => undefined,
            serialize: () => undefined,
            dispose: () => {
              attempts += 1;
              throw new Error("cleanup failed");
            },
          }),
        });
      },
    },
  ]);
  await host.activate();
  const instance = host.createActivity("test.throwing-game", activityServices());
  await assert.rejects(() => instance.dispose(), /cleanup failed/);
  await assert.rejects(() => instance.dispose(), /cleanup failed/);
  assert.equal(attempts, 1);
  await host.dispose();
});

test("activity instances join extension rollback and cleanup timeout", async () => {
  const host = new TerminalExtensionHost(
    [
      {
        manifest: {
          id: "test.activity-cleanup",
          name: "Cleanup",
          capabilities: ["terminal.activities"],
        },
        activate(api) {
          api.registerActivity({
            id: "test.hanging-game",
            name: "Hanging game",
            description: "Never finishes disposal",
            category: "game",
            create: () => ({
              render: () => ({ lines: [] }),
              handleInput: () => undefined,
              pause: () => undefined,
              resume: () => undefined,
              serialize: () => undefined,
              dispose: () => new Promise<void>(() => undefined),
            }),
          });
        },
      },
    ],
    { cleanupTimeoutMs: 10 },
  );
  await host.activate();
  host.createActivity("test.hanging-game", activityServices());
  await assert.rejects(
    () => host.deactivate("test.activity-cleanup"),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some(
        (item) => item instanceof Error && /cleanup exceeded 10ms/.test(item.message),
      ),
  );
  assert.deepEqual(host.activities(), []);
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
