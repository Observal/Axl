// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  ActivityStorageError,
  type TerminalExtension,
  TerminalExtensionHost,
} from "@axl/extension-api";

import { LoungeStorage } from "../src/lounge-storage.ts";

const scope = { extensionId: "test.lounge", activityId: "test.fake" } as const;

function assertStorageCode(code: ActivityStorageError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ActivityStorageError && error.code === code;
}

async function fixture(context: TestContext): Promise<{ root: string; store: LoungeStorage }> {
  const parent = await mkdtemp(join(tmpdir(), "axl-lounge-storage-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "lounge");
  return { root, store: new LoungeStorage(root) };
}

test("stores versioned Lounge settings and activity state with owner-only permissions", async (context) => {
  const { root, store } = await fixture(context);
  assert.deepEqual(await store.loadSettings(), {
    version: 1,
    reducedMotion: false,
    textOnly: false,
  });
  assert.deepEqual(
    await store.updateSettings({
      lastActivityId: "test.fake",
      reducedMotion: true,
      textOnly: true,
    }),
    {
      version: 1,
      lastActivityId: "test.fake",
      reducedMotion: true,
      textOnly: true,
    },
  );

  const signal = new AbortController().signal;
  assert.equal(await store.read(scope, signal), undefined);
  assert.deepEqual(await store.write(scope, null, 1, { paused: true, moves: 3 }, signal), {
    revision: 1,
    schemaVersion: 1,
    value: { paused: true, moves: 3 },
  });
  assert.deepEqual(await store.read(scope, signal), {
    revision: 1,
    schemaVersion: 1,
    value: { paused: true, moves: 3 },
  });

  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(store.settingsPath)).mode & 0o777, 0o600);
  assert.equal((await stat(store.statePath)).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(store.statePath, "utf8"))), [
    "version",
    "activities",
  ]);
});

test("enforces compare-and-swap writes and resets", async (context) => {
  const { store } = await fixture(context);
  const signal = new AbortController().signal;
  await store.write(scope, null, 1, { count: 1 }, signal);
  await assert.rejects(
    store.write(scope, null, 1, { count: 2 }, signal),
    assertStorageCode("conflict"),
  );
  await assert.rejects(
    store.write(scope, 2, 1, { count: 2 }, signal),
    assertStorageCode("conflict"),
  );
  const second = await store.write(scope, 1, 1, { count: 2 }, signal);
  assert.equal(second.revision, 2);
  await assert.rejects(store.reset(scope, 1, signal), assertStorageCode("conflict"));
  await store.reset(scope, 2, signal);
  assert.equal(await store.read(scope, signal), undefined);
});

test("concurrent local writers cannot silently lose an activity update", async (context) => {
  const { root, store } = await fixture(context);
  const other = new LoungeStorage(root);
  const signal = new AbortController().signal;
  await store.write(scope, null, 1, { writer: "initial" }, signal);
  const results = await Promise.allSettled([
    store.write(scope, 1, 1, { writer: "first" }, signal),
    other.write(scope, 1, 1, { writer: "second" }, signal),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(
    rejected?.status === "rejected" &&
      rejected.reason instanceof ActivityStorageError &&
      rejected.reason.code === "conflict",
    true,
  );
  assert.equal((await store.read(scope, signal))?.revision, 2);
});

test("rejects corruption, future versions, oversized reads, and unsafe permissions", async (context) => {
  const { root, store } = await fixture(context);
  await mkdir(root, { mode: 0o700 });
  await writeFile(store.statePath, "{broken\n", { mode: 0o600 });
  await assert.rejects(
    store.read(scope, new AbortController().signal),
    assertStorageCode("corrupt"),
  );

  await writeFile(store.statePath, '{"version":2,"activities":{}}\n', { mode: 0o600 });
  await assert.rejects(
    store.read(scope, new AbortController().signal),
    assertStorageCode("future-version"),
  );

  await writeFile(store.statePath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x20), { mode: 0o600 });
  await assert.rejects(
    store.read(scope, new AbortController().signal),
    assertStorageCode("oversized"),
  );

  await writeFile(store.statePath, '{"version":1,"activities":{}}\n');
  await chmod(store.statePath, 0o644);
  await assert.rejects(
    store.read(scope, new AbortController().signal),
    assertStorageCode("permission"),
  );
  await chmod(store.statePath, 0o600);
});

test("recovers dead stale locks and reports malformed or aborted locks visibly", async (context) => {
  const { root, store } = await fixture(context);
  await mkdir(root, { mode: 0o700 });
  const lockPath = `${store.statePath}.lock`;
  await writeFile(
    lockPath,
    `${JSON.stringify({ pid: 999_999_999, createdAt: Date.now() - 60_000, token: "stale" })}\n`,
    { mode: 0o600 },
  );
  const signal = new AbortController().signal;
  assert.equal((await store.write(scope, null, 1, { restored: true }, signal)).revision, 1);

  await writeFile(lockPath, "not-json\n", { mode: 0o600 });
  await assert.rejects(
    store.write(scope, 1, 1, { restored: false }, signal),
    assertStorageCode("locked"),
  );

  await writeFile(
    lockPath,
    `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "live" })}\n`,
    { mode: 0o600 },
  );
  const controller = new AbortController();
  const pending = store.write(scope, 1, 1, { restored: false }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, assertStorageCode("aborted"));
});

test("a paused fake activity restores after host restart through the public API", async (context) => {
  const { store } = await fixture(context);
  let saved: Promise<unknown> = Promise.resolve();
  let restored: Promise<void> = Promise.resolve();
  let moves = 0;
  const extension = (): TerminalExtension => ({
    manifest: {
      id: "test.lounge",
      name: "Lounge storage fixture",
      capabilities: ["terminal.activities", "terminal.activity-storage"],
    },
    activate(api) {
      api.registerActivity({
        id: "test.fake",
        name: "Fake",
        description: "Persistence fixture",
        category: "game",
        create(activity) {
          const storage = activity.storage;
          assert.ok(storage);
          restored = storage.read().then((stored) => {
            moves = (stored?.value as { moves?: number } | undefined)?.moves ?? 0;
            activity.invalidate();
          });
          return {
            render: () => ({ lines: [[{ text: `moves ${moves}`, style: "text" }]] }),
            handleInput: (input) => {
              if (input.type !== "key") return;
              moves += 1;
              saved = storage
                .read()
                .then((current) => storage.write(current?.revision ?? null, 1, { moves }));
            },
            pause: () => undefined,
            resume: () => undefined,
            serialize: () => ({ moves }),
            dispose: () => undefined,
          };
        },
      });
    },
  });
  const services = {
    now: () => performance.now(),
    schedule: () => () => undefined,
    invalidate: () => undefined,
    status: () => ({
      operation: "idle" as const,
      activeToolCount: 0,
      queuedInput: { steer: 0, followUp: 0, interrupt: 0 },
    }),
    presentation: () => ({ reducedMotion: false, textOnly: false }),
    storage: store,
  };

  const firstHost = new TerminalExtensionHost([extension()]);
  await firstHost.activate();
  const first = firstHost.createActivity("test.fake", services);
  await restored;
  first.handleInput(first.epoch, {
    type: "key",
    key: "x",
    ctrl: false,
    alt: false,
    shift: false,
    repeat: false,
  });
  await saved;
  first.pause(first.epoch, "hidden");
  assert.deepEqual(first.serialize(first.epoch), { moves: 1 });
  await firstHost.dispose();

  moves = 0;
  const secondHost = new TerminalExtensionHost([extension()]);
  await secondHost.activate();
  const second = secondHost.createActivity("test.fake", services);
  await restored;
  assert.deepEqual(second.serialize(second.epoch), { moves: 1 });
  assert.equal(
    second.render(second.epoch, { width: 40, height: 18 }).lines[0]?.[0]?.text,
    "moves 1",
  );
  await secondHost.dispose();
});

test("rejects oversized activity values before replacing prior state", async (context) => {
  const { store } = await fixture(context);
  const signal = new AbortController().signal;
  await store.write(scope, null, 1, { safe: true }, signal);
  assert.throws(
    () => store.write(scope, 1, 1, { payload: "x".repeat(256 * 1024) }, signal),
    assertStorageCode("oversized"),
  );
  assert.deepEqual((await store.read(scope, signal))?.value, { safe: true });
});
