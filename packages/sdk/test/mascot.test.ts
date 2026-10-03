// SPDX-FileCopyrightText: 2026 Dheirav
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalEvent } from "@axl/protocol";
import {
  MascotActor,
  MascotDirector,
  MascotManifestError,
  MascotPlayer,
  parseMascotManifest,
} from "../src/index.ts";

const MANIFEST = parseMascotManifest({
  frame_size: [32, 32],
  atlas_columns: 12,
  atlas: "atlas-{colour}.png",
  colours: ["Pink", "Blue"],
  states: {
    waiting: {
      kind: "loop",
      next: null,
      segments: { loop: { frames: [10, 11], durations: [100, 100] } },
    },
    idle: { kind: "loop", next: null, segments: { loop: { frames: [20], durations: [100] } } },
    typing: {
      kind: "loop",
      next: null,
      segments: { loop: { frames: [30, 31], durations: [100, 100] } },
    },
    working: {
      kind: "loop",
      next: null,
      segments: {
        in: { frames: [40], durations: [100] },
        loop: { frames: [41, 42], durations: [100, 100] },
      },
    },
    compact: {
      kind: "loop",
      next: null,
      segments: {
        in: { frames: [50], durations: [100] },
        loop: { frames: [51], durations: [100] },
        out: { frames: [52], durations: [100] },
      },
    },
    waking: {
      kind: "transition",
      next: "waiting",
      segments: { in: { frames: [60], durations: [100] } },
    },
    success: {
      kind: "oneshot",
      next: "waiting",
      segments: { in: { frames: [70], durations: [100] } },
    },
    file_change: {
      kind: "oneshot",
      next: "working",
      segments: { in: { frames: [80], durations: [100] } },
    },
    error: {
      kind: "transition",
      next: "severed",
      segments: { in: { frames: [90], durations: [100] } },
    },
    severed: { kind: "loop", next: null, segments: { loop: { frames: [91], durations: [100] } } },
    dead: { kind: "loop", next: null, segments: { loop: { frames: [92], durations: [100] } } },
    ask: {
      kind: "loop",
      next: null,
      segments: {
        in: { frames: [100], durations: [100] },
        loop: { frames: [101], durations: [100] },
      },
    },
    blocked: {
      kind: "oneshot",
      next: "waiting",
      segments: { in: { frames: [110], durations: [100] } },
    },
    nod: {
      kind: "oneshot",
      next: "working",
      segments: { in: { frames: [120], durations: [100] } },
    },
  },
});

function player(): MascotPlayer {
  return new MascotPlayer(MANIFEST);
}

function event<Type extends CanonicalEvent["type"]>(type: Type, payload: unknown): CanonicalEvent {
  return { type, payload } as unknown as CanonicalEvent;
}

test("plays in once and then holds the loop", () => {
  const mascot = player();
  mascot.play("working");
  assert.equal(mascot.frameId(), 40);
  assert.equal(mascot.segment, "in");

  assert.equal(mascot.tick(0), false, "the first tick starts the frame");
  assert.equal(mascot.tick(100), true);
  assert.equal(mascot.segment, "loop");
  assert.equal(mascot.frameId(), 41);

  mascot.tick(200);
  assert.equal(mascot.frameId(), 42);
  mascot.tick(300);
  assert.equal(mascot.frameId(), 41, "loop repeats rather than ending");
});

test("a graceful switch finishes the loop, plays out, then enters the pending state", () => {
  const mascot = player();
  mascot.play("compact");
  mascot.tick(0);
  mascot.tick(100);
  assert.equal(mascot.segment, "loop");

  mascot.play("waiting", { graceful: true });
  assert.equal(mascot.state, "compact", "the switch waits for the loop to finish");
  assert.equal(mascot.queued, "waiting");

  mascot.tick(200);
  assert.equal(mascot.segment, "out", "out plays before leaving");
  assert.equal(mascot.frameId(), 52);

  mascot.tick(300);
  assert.equal(mascot.state, "waiting");
  assert.equal(mascot.queued, null);
});

test("an interrupt cuts immediately instead of waiting for the loop", () => {
  const mascot = player();
  mascot.play("working");
  mascot.tick(0);
  mascot.tick(100);
  mascot.play("error");
  assert.equal(mascot.state, "error", "a hard cut does not wait for the loop cycle");
  assert.equal(mascot.frameId(), 90);
});

test("a transition hands off to its next state", () => {
  const mascot = player();
  mascot.play("waking");
  assert.equal(mascot.frameId(), 60);
  mascot.tick(0);
  mascot.tick(100);
  assert.equal(mascot.state, "waiting");
});

test("a oneshot hands off to its next state", () => {
  const mascot = player();
  mascot.play("success");
  mascot.tick(0);
  mascot.tick(100);
  assert.equal(mascot.state, "waiting");
});

test("the manifest rejects malformed input rather than drawing the wrong frame", () => {
  assert.throws(
    () =>
      parseMascotManifest({
        ...MANIFEST,
        states: { bad: { kind: "spin", next: null, segments: {} } },
      }),
    MascotManifestError,
  );
  assert.throws(
    () =>
      parseMascotManifest({
        frame_size: [32, 32],
        atlas_columns: 12,
        atlas: "a.png",
        colours: ["Pink"],
        states: {
          a: { kind: "loop", next: null, segments: { loop: { frames: [1, 2], durations: [100] } } },
        },
      }),
    MascotManifestError,
    "a duration per frame is required",
  );
  assert.throws(
    () =>
      parseMascotManifest({
        frame_size: [32, 32],
        atlas_columns: 12,
        atlas: "a.png",
        colours: ["Pink"],
        states: {
          a: {
            kind: "oneshot",
            next: "nowhere",
            segments: { in: { frames: [1], durations: [100] } },
          },
        },
      }),
    MascotManifestError,
    "next must name a real state",
  );
});

test("typing takes over an idle mascot but never takes over running work", () => {
  const mascot = player();
  const director = new MascotDirector(mascot);
  mascot.play("waiting");
  director.keystroke(0);
  assert.equal(mascot.state, "typing");

  mascot.play("working");
  director.keystroke(100);
  assert.equal(
    mascot.state,
    "working",
    "what the harness is doing outranks what the user is doing",
  );
});

test("typing releases after the last keystroke", () => {
  const mascot = player();
  const director = new MascotDirector(mascot);
  mascot.play("waiting");
  director.keystroke(0);

  assert.equal(director.tick(500), false);
  assert.equal(mascot.state, "typing");
  assert.equal(director.tick(600), true);
  assert.equal(mascot.state, "waiting");
});

test("a burst of edits fires one file_change", () => {
  const mascot = player();
  const director = new MascotDirector(mascot);
  const write = event("tool.call", { callId: "1", name: "write", input: {} });

  director.handleEvent(write, 0);
  assert.equal(mascot.state, "file_change");
  mascot.play("working");

  director.handleEvent(write, 300);
  assert.equal(mascot.state, "working", "edits inside the burst window are coalesced");
  director.handleEvent(write, 800);
  assert.equal(mascot.state, "file_change", "a later edit starts a new burst");
});

test("assistant stop reasons choose the ending", () => {
  const cases: readonly [string, string][] = [
    ["stop", "success"],
    ["error", "error"],
    ["aborted", "dead"],
    ["tool_use", "working"],
  ];
  for (const [stopReason, expected] of cases) {
    const mascot = player();
    const director = new MascotDirector(mascot);
    mascot.play("waiting");
    director.handleEvent(event("assistant.message", { content: [], stopReason }), 0);
    assert.equal(mascot.state, expected, `${stopReason} should show ${expected}`);
  }
});

test("a request for the user holds ask until it is answered", () => {
  for (const [requested, resolved] of [
    ["permission.requested", "permission.resolved"],
    ["interaction.requested", "interaction.resolved"],
  ] as const) {
    const mascot = player();
    const director = new MascotDirector(mascot);
    mascot.play("working");
    director.handleEvent(event(requested, {}), 0);
    assert.equal(mascot.state, "ask");
    mascot.tick(0);
    mascot.tick(1000);
    assert.equal(mascot.state, "ask", `${requested} holds until answered`);
    director.handleEvent(event(resolved, {}), 1000);
    assert.equal(mascot.state, "working", `${resolved} goes back to the work`);
  }
});

test("compaction ending late leaves a state that took over in the meantime", () => {
  const mascot = player();
  const director = new MascotDirector(mascot);
  director.compactionStarted();
  assert.equal(mascot.state, "compact");
  director.handleEvent(event("session.error", {}), 0);
  const during = mascot.state;
  assert.notEqual(during, "compact");
  director.compactionFinished();
  assert.equal(mascot.state, during, "the error is not replaced by waiting");

  director.compactionStarted();
  director.compactionFinished();
  for (let now = 0; now <= 5_000; now += 50) mascot.tick(now);
  assert.equal(mascot.state, "waiting", "a compaction still showing leaves to waiting");
});

test("an answer only ends ask, it does not interrupt anything else", () => {
  const mascot = player();
  const director = new MascotDirector(mascot);
  mascot.play("file_change");
  director.handleEvent(event("permission.resolved", {}), 0);
  assert.equal(mascot.state, "file_change");
});

test("a sandbox violation plays blocked and a queued message plays nod", () => {
  const mascot = player();
  const director = new MascotDirector(mascot);
  mascot.play("working");
  director.handleEvent(event("sandbox.violation", { capability: "fs.write", reason: "denied" }), 0);
  assert.equal(mascot.state, "blocked");
  director.handleEvent(event("queue.enqueued", {}), 0);
  assert.equal(mascot.state, "nod");
});

test("a state's opening frame survives the first tick", () => {
  // The player takes its time only from tick(), so a play() from an event
  // handler cannot start a segment on a different clock and skip it.
  const mascot = player();
  mascot.play("success");
  assert.equal(mascot.frameId(), 70);
  assert.equal(
    mascot.tick(Date.now()),
    false,
    "the first tick starts the frame, it does not end it",
  );
  assert.equal(mascot.frameId(), 70);
  assert.equal(mascot.state, "success", "a oneshot is not skipped before it is seen");
});

test("typing dives under the bar, crosses hidden, and surfaces at the cursor", () => {
  const actor = new MascotActor();
  const context = { width: 80, spriteWidth: 8, stripHeight: 3, cursorColumn: 40, segment: "loop" };
  const start = actor.placement().column;

  // It goes under before it moves: crossing in view cannot keep up with typing.
  let hidden = false;
  let movedWhileVisible = false;
  let previous = start;
  for (let step = 0; step < 40; step += 1) {
    actor.step(50, { ...context, state: "typing" });
    const { column, sink } = actor.placement();
    if (sink >= context.stripHeight) hidden = true;
    else if (column !== previous && !hidden) movedWhileVisible = true;
    previous = column;
  }
  assert.ok(hidden, "it submerges completely at some point");
  assert.equal(movedWhileVisible, false, "it never travels in view");

  const settled = actor.placement();
  assert.ok(settled.column > start, "it surfaces beside the cursor");
  assert.equal(settled.sink, 0, "it surfaces fully, so the typing arms show above the bar");
});

test("the actor patrols during working and turns at the edges", () => {
  const actor = new MascotActor();
  const context = {
    state: "working",
    segment: "loop",
    width: 40,
    spriteWidth: 8,
    stripHeight: 4,
    cursorColumn: 0,
  };
  const columns = new Set<number>();
  for (let step = 0; step < 200; step += 1) {
    actor.step(50, context);
    columns.add(actor.placement().column);
  }
  assert.ok(columns.size > 4, "the sprite moves across the strip");
  assert.ok(Math.max(...columns) <= 40 - 8 - 2, "it never runs past the right edge");
  assert.ok(Math.min(...columns) >= 2, "it never runs past the left edge");
});

test("working coils in place and only travels once it swims", () => {
  const actor = new MascotActor();
  const context = { width: 40, spriteWidth: 8, stripHeight: 4, cursorColumn: 0 };
  const start = actor.placement().column;
  for (let step = 0; step < 20; step += 1) {
    actor.step(50, { ...context, state: "working", segment: "in" });
  }
  assert.equal(actor.placement().column, start, "the coil wind-up is drawn in place");
  for (let step = 0; step < 20; step += 1) {
    actor.step(50, { ...context, state: "working", segment: "loop" });
  }
  assert.ok(actor.placement().column > start, "the swim stroke carries it along");
  const swimming = actor.placement().column;
  actor.step(500, { ...context, state: "swim", segment: "loop" });
  assert.ok(actor.placement().column > swimming, "swim on its own patrols too");
});

test("the mascot faces the way it swims", () => {
  const actor = new MascotActor();
  const context = {
    state: "working",
    segment: "loop",
    width: 40,
    spriteWidth: 8,
    stripHeight: 3,
    cursorColumn: 0,
  };
  const seen = new Set<string>();
  let previous = actor.placement().column;
  let reversed = false;
  for (let step = 0; step < 300; step += 1) {
    actor.step(50, context);
    const { column, mirrored } = actor.placement();
    if (column !== previous) {
      seen.add(`${column > previous ? "right" : "left"}:${mirrored}`);
      if (column < previous) reversed = true;
      previous = column;
    }
  }
  assert.ok(reversed, "the patrol turns around");
  assert.ok(seen.has("right:true"), "swimming right mirrors the art");
  assert.ok(seen.has("left:false"), "swimming left uses the art as drawn");
});

test("a failed session plays dead, a completed one does not", () => {
  const cases: readonly [string, string][] = [
    ["failed", "dead"],
    ["completed", "waiting"],
    ["disposed", "waiting"],
  ];
  for (const [reason, expected] of cases) {
    const mascot = player();
    const director = new MascotDirector(mascot);
    mascot.play("waiting");
    director.handleEvent(event("session.closed", { reason }), 0);
    assert.equal(mascot.state, expected, `${reason} should leave the mascot in ${expected}`);
  }
});
