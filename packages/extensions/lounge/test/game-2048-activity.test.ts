// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type ActivityContext,
  type ActivityFrame,
  type ActivityInput,
  type ActivityStorage,
  ActivityStorageError,
  type ActivityStoredValue,
  type JsonValue,
} from "@axl/extension-api";

import {
  game2048Activity,
  game2048SaveJson,
  parseGame2048Save,
  restoreGame2048,
  updateGame2048Save,
} from "../src/index.ts";

class MemoryStorage implements ActivityStorage {
  stored: ActivityStoredValue | undefined;

  read(): Promise<ActivityStoredValue | undefined> {
    return Promise.resolve(this.stored);
  }

  write(expectedRevision: number | null, schemaVersion: number, value: JsonValue) {
    if ((this.stored?.revision ?? null) !== expectedRevision) {
      throw new ActivityStorageError("conflict", "stale revision");
    }
    this.stored = Object.freeze({
      revision: (this.stored?.revision ?? 0) + 1,
      schemaVersion,
      value,
    });
    return Promise.resolve(this.stored);
  }

  reset(expectedRevision: number): Promise<void> {
    if (this.stored?.revision !== expectedRevision) {
      throw new ActivityStorageError("conflict", "stale revision");
    }
    this.stored = undefined;
    return Promise.resolve();
  }
}

function context(
  storage?: ActivityStorage,
  options: {
    readonly reducedMotion?: boolean;
    readonly textOnly?: boolean;
    readonly schedule?: ActivityContext["schedule"];
  } = {},
): ActivityContext {
  return {
    signal: new AbortController().signal,
    now: () => 0,
    status: () => ({
      operation: "idle",
      activeToolCount: 0,
      queuedInput: { steer: 0, followUp: 0, interrupt: 0 },
    }),
    presentation: () => ({
      reducedMotion: options.reducedMotion ?? true,
      textOnly: options.textOnly ?? false,
    }),
    invalidate: () => undefined,
    schedule: options.schedule ?? (() => () => undefined),
    ...(storage === undefined ? {} : { storage }),
  };
}

function key(value: string): Extract<ActivityInput, { readonly type: "key" }> {
  return { type: "key", key: value, ctrl: false, alt: false, shift: false, repeat: false };
}

function text(frame: ActivityFrame): string {
  return frame.lines.map((row) => row.map((item) => item.text).join("")).join("\n");
}

async function settle(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}

test("2048 renders bounded accessible frames at compact, standard, and wide widths", () => {
  const instance = game2048Activity({ seed: () => 42 }).create(context());
  for (const viewport of [
    { width: 40, height: 15 },
    { width: 80, height: 24 },
    { width: 120, height: 30 },
  ]) {
    const frame = instance.render(viewport);
    assert.ok(frame.lines.length <= viewport.height);
    assert.ok(
      frame.lines.every(
        (row) => row.map(({ text: value }) => value).join("").length <= viewport.width,
      ),
    );
    const rendered = text(frame);
    assert.match(rendered, /SCORE {2}0 {5}BEST {2}0/);
    assert.match(rendered, /╭─+╮/);
    assert.equal(rendered.match(/╭/gu)?.length, 16);
    assert.equal(rendered.match(/╰/gu)?.length, 16);
  }
});

test("2048 tile classes use distinct labels, border patterns, and semantic roles", async () => {
  const storage = new MemoryStorage();
  const themed = restoreGame2048({
    board: [0, 2, 16, 256, 2048, 4096, 131072, 0, ...Array<number>(8).fill(0)],
    score: 0,
    status: "active",
    continued: true,
    randomState: 1,
  });
  storage.stored = {
    revision: 1,
    schemaVersion: 1,
    value: game2048SaveJson(updateGame2048Save(themed)),
  };
  const instance = game2048Activity().create(context(storage));
  await settle();
  const frame = instance.render({ width: 80, height: 24 });
  const spans = frame.lines.flat();
  assert.ok(spans.some((item) => item.text === "2" && item.style === "text"));
  assert.ok(spans.some((item) => item.text === "16" && item.style === "accent"));
  assert.ok(spans.some((item) => item.text === "256" && item.style === "warning"));
  assert.ok(spans.some((item) => item.text === "2048" && item.style === "success"));
  assert.ok(spans.some((item) => item.text === "4096" && item.style === "error"));
  assert.ok(spans.some((item) => item.text === "131072" && item.style === "error"));
  const rendered = text(frame);
  for (const pattern of ["╭", "┌", "╔", "┏", "─", "═", "━"]) {
    assert.match(rendered, new RegExp(pattern));
  }
  assert.ok(frame.lines.every((row) => row.map((item) => item.text).join("").length <= 80));
  await instance.dispose();
});

test("2048 handles movement aliases, undo, help, and restart confirmation", () => {
  let seed = 1;
  const instance = game2048Activity({ seed: () => seed++ }).create(context());
  instance.render({ width: 80, height: 24 });
  const before = parseGame2048Save(instance.serialize() as JsonValue).game;
  instance.handleInput(key("left"));
  instance.handleInput(key("a"));
  instance.handleInput(key("h"));
  instance.handleInput(key("u"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /Move undone/);
  instance.handleInput(key("?"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /HOW TO PLAY/);
  instance.handleInput(key("?"));
  instance.handleInput(key("right"));
  instance.handleInput(key("r"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /RESTART 2048/);
  instance.handleInput(key("n"));
  assert.doesNotMatch(text(instance.render({ width: 80, height: 24 })), /RESTART 2048/);
  instance.handleInput(key("r"));
  instance.handleInput(key("y"));
  const after = parseGame2048Save(instance.serialize() as JsonValue).game;
  assert.notEqual(after.randomState, before.randomState);
  assert.equal(after.undo, undefined);
});

test("2048 movement emphasis is bounded and disabled by reduced motion", () => {
  let callback: (() => void) | undefined;
  let cancellations = 0;
  const animated = game2048Activity({ seed: () => 42 }).create(
    context(undefined, {
      reducedMotion: false,
      schedule: (_delay, scheduled) => {
        callback = () => scheduled(120);
        return () => {
          cancellations += 1;
          callback = undefined;
        };
      },
    }),
  );
  animated.render({ width: 80, height: 24 });
  animated.handleInput(key("left"));
  assert.match(text(animated.render({ width: 80, height: 24 })), /← LEFT {2}· {2}MERGE \+4/);
  callback?.();
  assert.match(text(animated.render({ width: 80, height: 24 })), /NEW [24] {2}· {2}U UNDO/);
  animated.handleInput(key("down"));
  assert.ok(callback);
  animated.pause("hidden");
  assert.equal(cancellations, 1);
  assert.equal(callback, undefined);

  const reduced = game2048Activity({ seed: () => 42 }).create(context());
  reduced.render({ width: 80, height: 24 });
  reduced.handleInput(key("left"));
  assert.doesNotMatch(text(reduced.render({ width: 80, height: 24 })), /moved/);
});

test("2048 queues one movement and settles phases without a catch-up burst", async () => {
  const storage = new MemoryStorage();
  const initial = restoreGame2048({
    board: [0, 0, 2, 2, ...Array<number>(12).fill(0)],
    score: 0,
    status: "active",
    continued: false,
    randomState: 1,
  });
  storage.stored = {
    revision: 1,
    schemaVersion: 1,
    value: game2048SaveJson(updateGame2048Save(initial)),
  };
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const instance = game2048Activity().create(
    context(storage, {
      reducedMotion: false,
      schedule: (delay, scheduled) => {
        delays.push(delay);
        let active = true;
        callbacks.push(() => {
          if (!active) return;
          active = false;
          scheduled(delay);
        });
        return () => {
          active = false;
        };
      },
    }),
  );
  await settle();
  instance.render({ width: 80, height: 24 });
  instance.handleInput(key("left"));
  const afterFirst = parseGame2048Save(instance.serialize() as JsonValue).game;
  instance.handleInput(key("down"));
  instance.handleInput(key("right"));
  const motion = text(instance.render({ width: 80, height: 24 }));
  assert.match(motion, /↓ DOWN NEXT/);
  assert.doesNotMatch(motion, /NEW [24]/);
  assert.equal(callbacks.length, 1);

  callbacks.shift()?.();
  const settled = text(instance.render({ width: 80, height: 24 }));
  assert.match(settled, /NEW [24]/);
  assert.match(settled, /┈/);
  assert.equal(callbacks.length, 1);
  assert.deepEqual(parseGame2048Save(instance.serialize() as JsonValue).game, afterFirst);

  callbacks.shift()?.();
  const afterQueued = parseGame2048Save(instance.serialize() as JsonValue).game;
  assert.notDeepEqual(afterQueued.board, afterFirst.board);
  assert.deepEqual(delays, [67, 67, 67]);
  assert.equal(callbacks.length, 1);
  await instance.dispose();
});

test("2048 focus loss cancels animation and drops its queued move", async () => {
  const storage = new MemoryStorage();
  const initial = restoreGame2048({
    board: [0, 0, 2, 2, ...Array<number>(12).fill(0)],
    score: 0,
    status: "active",
    continued: false,
    randomState: 1,
  });
  storage.stored = {
    revision: 1,
    schemaVersion: 1,
    value: game2048SaveJson(updateGame2048Save(initial)),
  };
  const callbacks: Array<() => void> = [];
  const instance = game2048Activity().create(
    context(storage, {
      reducedMotion: false,
      schedule: (delay, scheduled) => {
        let active = true;
        callbacks.push(() => {
          if (active) scheduled(delay);
        });
        return () => {
          active = false;
        };
      },
    }),
  );
  await settle();
  instance.render({ width: 80, height: 24 });
  instance.handleInput(key("left"));
  instance.handleInput(key("down"));
  const settled = instance.serialize();
  instance.handleInput({ type: "focus", focused: false });
  for (const callback of callbacks) callback();
  assert.deepEqual(instance.serialize(), settled);
  instance.handleInput(key("right"));
  assert.deepEqual(instance.serialize(), settled);
  instance.handleInput({ type: "focus", focused: true });
  instance.handleInput(key("down"));
  assert.notDeepEqual(instance.serialize(), settled);
  await instance.dispose();
});

test("2048 reports directional no-op feedback and keeps reverse styling off padding", async () => {
  const storage = new MemoryStorage();
  const initial = restoreGame2048({
    board: [2, 4, 8, 16, ...Array<number>(12).fill(0)],
    score: 0,
    status: "active",
    continued: false,
    randomState: 1,
  });
  storage.stored = {
    revision: 1,
    schemaVersion: 1,
    value: game2048SaveJson(updateGame2048Save(initial)),
  };
  const instance = game2048Activity().create(context(storage));
  await settle();
  instance.render({ width: 40, height: 15 });
  instance.handleInput(key("left"));
  const frame = instance.render({ width: 40, height: 15 });
  assert.match(text(frame), /No move left/);
  assert.equal(
    frame.lines.flat().some((item) => item.emphasis === "reverse" && /^\s|\s$/u.test(item.text)),
    false,
  );
  await instance.dispose();
});

test("2048 reports every directional no-op in the reserved status row", async () => {
  const cases = [
    { direction: "left", index: 0 },
    { direction: "right", index: 3 },
    { direction: "up", index: 0 },
    { direction: "down", index: 12 },
  ] as const;
  for (const fixture of cases) {
    const storage = new MemoryStorage();
    const board = Array<number>(16).fill(0);
    board[fixture.index] = 2;
    const initial = restoreGame2048({
      board,
      score: 0,
      status: "active",
      continued: false,
      randomState: 1,
    });
    storage.stored = {
      revision: 1,
      schemaVersion: 1,
      value: game2048SaveJson(updateGame2048Save(initial)),
    };
    const instance = game2048Activity().create(context(storage));
    await settle();
    instance.render({ width: 40, height: 15 });
    instance.handleInput(key(fixture.direction));
    assert.match(
      text(instance.render({ width: 40, height: 15 })),
      new RegExp(`No move ${fixture.direction}`),
    );
    await instance.dispose();
  }
});

test("2048 text-only movement is immediate and schedules no decorative callback", () => {
  let schedules = 0;
  const instance = game2048Activity({ seed: () => 42 }).create(
    context(undefined, {
      reducedMotion: false,
      textOnly: true,
      schedule: () => {
        schedules += 1;
        return () => undefined;
      },
    }),
  );
  instance.render({ width: 80, height: 24 });
  instance.handleInput(key("left"));
  assert.equal(schedules, 0);
  assert.match(text(instance.render({ width: 80, height: 24 })), /NEW [24]/);
});

test("2048 persists and resumes its exact reducer state", async () => {
  const storage = new MemoryStorage();
  const first = game2048Activity({ seed: () => 42 }).create(context(storage));
  assert.match(text(first.render({ width: 80, height: 24 })), /Loading 2048/);
  await settle();
  first.render({ width: 80, height: 24 });
  first.handleInput(key("left"));
  await first.dispose();
  assert.ok(storage.stored);
  const saved = parseGame2048Save(storage.stored?.value as JsonValue);

  const second = game2048Activity({ seed: () => 99 }).create(context(storage));
  await settle();
  assert.deepEqual(parseGame2048Save(second.serialize() as JsonValue).game, saved.game);
  assert.match(text(second.render({ width: 40, height: 15 })), /SCORE/);
  await second.dispose();
});

test("2048 renders win continuation and game-over actions", async () => {
  const wonStorage = new MemoryStorage();
  const won = restoreGame2048({
    board: [2048, 2, 0, 0, ...Array<number>(12).fill(0)],
    score: 2048,
    status: "won",
    continued: false,
    randomState: 1,
  });
  wonStorage.stored = {
    revision: 1,
    schemaVersion: 1,
    value: game2048SaveJson(updateGame2048Save(won)),
  };
  const winner = game2048Activity().create(context(wonStorage));
  await settle();
  const wonFrame = text(winner.render({ width: 80, height: 24 }));
  assert.match(wonFrame, /2048 REACHED · KEEP GOING/);
  assert.match(wonFrame, /Enter\/C Continue · R New · Ctrl\+P Games/);
  winner.handleInput(key("c"));
  assert.equal(parseGame2048Save(winner.serialize() as JsonValue).game.continued, true);

  const lostStorage = new MemoryStorage();
  const lost = restoreGame2048({
    board: [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2],
    score: 0,
    status: "lost",
    continued: false,
    randomState: 1,
  });
  lostStorage.stored = {
    revision: 1,
    schemaVersion: 1,
    value: game2048SaveJson(updateGame2048Save(lost)),
  };
  const loser = game2048Activity().create(context(lostStorage));
  await settle();
  const lostFrame = text(loser.render({ width: 80, height: 24 }));
  assert.match(lostFrame, /GAME OVER · NO MOVES LEFT/);
  assert.match(lostFrame, /Enter\/R New game · \? Help · Ctrl\+P Games/);
  loser.handleInput(key("enter"));
  assert.equal(parseGame2048Save(loser.serialize() as JsonValue).game.status, "active");
  await winner.dispose();
  await loser.dispose();
});

test("2048 reports a revision conflict without replacing the newer board", async () => {
  const storage = new MemoryStorage();
  const instance = game2048Activity({ seed: () => 42 }).create(context(storage));
  instance.render({ width: 80, height: 24 });
  await settle();
  const newer = storage.stored as ActivityStoredValue;
  storage.stored = { ...newer, revision: newer.revision + 1 };
  instance.handleInput(key("left"));
  await settle();
  assert.equal(storage.stored.revision, 2);
  assert.match(text(instance.render({ width: 80, height: 24 })), /stale revision/);
  await instance.dispose();
});

test("2048 reports future saves and resets them explicitly", async () => {
  const storage = new MemoryStorage();
  storage.stored = { revision: 3, schemaVersion: 2, value: { version: 2 } };
  const instance = game2048Activity({ seed: () => 42 }).create(context(storage));
  instance.render({ width: 80, height: 24 });
  await settle();
  assert.match(
    text(instance.render({ width: 80, height: 24 })),
    /Unsupported 2048 storage schema 2/,
  );
  instance.handleInput(key("r"));
  await settle();
  await instance.dispose();
  assert.equal(storage.stored?.schemaVersion, 1);
  assert.equal(parseGame2048Save(storage.stored?.value as JsonValue).game.score, 0);
});

test("2048 ignores input while paused and resumes without duplicate state", () => {
  const instance = game2048Activity({ seed: () => 42 }).create(context());
  instance.render({ width: 80, height: 24 });
  instance.pause("attention");
  const paused = instance.serialize();
  instance.handleInput(key("left"));
  assert.deepEqual(instance.serialize(), paused);
  instance.resume();
  instance.handleInput(key("left"));
  assert.notDeepEqual(instance.serialize(), paused);
});
