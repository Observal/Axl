// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type ActivityInput,
  type TerminalExtension,
  TerminalExtensionHost,
} from "@axl/extension-api";

import { type ActivityMonitorSnapshot, ActivitySurfaceHost } from "../src/activity-surface.ts";
import { decodeOneKey } from "../src/editor.ts";
import { AttentionOverlaySlot, type Overlay, OverlayStack } from "../src/overlay.ts";
import { stripAnsi, visibleWidth } from "../src/render.ts";
import { PLAIN_PALETTE } from "../src/transcript.ts";

function overlay(name: string, events: string[]): Overlay {
  return {
    render: (width) => [`${name}:${width}`],
    handleKey: (data) => events.push(`${name}:${data}`),
    cursor: () => ({ row: 1, column: name.length }),
    dispose: () => events.push(`${name}:disposed`),
  };
}

function monitor(): ActivityMonitorSnapshot {
  return {
    status: {
      operation: "working" as const,
      elapsedMs: 42_000,
      activeToolCount: 1,
      queuedInput: { steer: 0, followUp: 1, interrupt: 0 },
    },
    connection: "connected" as const,
    sandbox: "bubblewrap",
    current: { label: "bash · pnpm test", status: "running" as const, preview: [] },
    recent: [
      {
        label: "read · src/parser.ts",
        status: "succeeded" as const,
        preview: ["bounded output"],
      },
    ],
    changes: ["M src/parser.ts"],
    changesAuthoritative: true,
  };
}

test("attention overlay replacement does not dispose an ordinary dialog", () => {
  const events: string[] = [];
  const ordinary = new OverlayStack();
  const attention = new AttentionOverlaySlot();
  ordinary.push(overlay("ordinary", events));
  attention.replace(overlay("attention", events));

  attention.handleInput("y");
  assert.deepEqual(attention.render(80), ["attention:80"]);
  attention.clear();
  assert.deepEqual(ordinary.render(80), ["ordinary:80"]);
  assert.deepEqual(events, ["attention:y", "attention:disposed"]);
  ordinary.clear();
});

test("routes render, cursor, and input to the top overlay", () => {
  const events: string[] = [];
  const stack = new OverlayStack();
  stack.push(overlay("first", events));
  stack.push(overlay("second", events));

  assert.deepEqual(stack.render(80), ["second:80"]);
  assert.deepEqual(stack.cursorPlacement(), { row: 1, column: 6 });
  stack.handleInput("x");
  assert.deepEqual(events, ["second:x"]);

  stack.close();
  assert.deepEqual(stack.render(40), ["first:40"]);
  assert.deepEqual(events, ["second:x", "second:disposed"]);
});

test("replace and clear dispose every removed overlay exactly once", () => {
  const events: string[] = [];
  const stack = new OverlayStack();
  stack.push(overlay("first", events));
  stack.replace(overlay("second", events));
  stack.clear();
  stack.clear();

  assert.deepEqual(events, ["first:disposed", "second:disposed"]);
  assert.equal(stack.size, 0);
  assert.deepEqual(stack.render(80), []);
});

test("activity surface owns picker, input, monitor focus, and suspension", async () => {
  const inputs: string[] = [];
  const pauses: string[] = [];
  let resumes = 0;
  let creations = 0;
  let disposals = 0;
  const extension: TerminalExtension = {
    manifest: { id: "test.surface", name: "Surface", capabilities: ["terminal.activities"] },
    activate(api) {
      api.registerActivity({
        id: "test.board",
        name: "Test Board",
        description: "Activity host fixture",
        category: "game",
        create: () => {
          creations += 1;
          return {
            render: () => ({ lines: [[{ text: "BOARD", style: "accent" }]] }),
            handleInput: (input) => {
              if (input.type === "key") inputs.push(input.key);
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
  };
  const host = new TerminalExtensionHost([extension]);
  await host.activate();
  let invalidations = 0;
  const surface = new ActivitySurfaceHost({
    host,
    palette: () => PLAIN_PALETTE,
    invalidate: () => {
      invalidations += 1;
    },
    monitor,
    presentation: () => ({ reducedMotion: false, textOnly: false }),
    returnToTranscript: () => undefined,
    returnToEditor: () => undefined,
    openWorkspaceReview: () => undefined,
    reportError: (error) => {
      throw error;
    },
  });

  assert.equal(surface.openPicker(), true);
  assert.match(surface.render(80, 24).lines.map(stripAnsi).join("\n"), /Test Board/);
  surface.handleInput("\r", decodeOneKey);
  assert.equal(surface.state, "active");
  assert.equal(surface.openPrimary(), true);
  assert.equal(creations, 1);
  for (const [width, height] of [
    [40, 18],
    [80, 24],
    [120, 30],
  ] as const) {
    const rendered = surface.render(width, height).lines.map(stripAnsi);
    assert.ok(rendered.some((line) => line.includes("BOARD")));
    assert.ok(rendered.every((line) => line.length <= width));
  }

  surface.handleInput("x", decodeOneKey);
  assert.deepEqual(inputs, ["x"]);
  surface.suspend("unfocused");
  assert.equal(surface.state, "suspended");
  surface.restoreTerminalFocus();
  assert.equal(surface.state, "active");
  surface.handleInput("\t", decodeOneKey);
  surface.handleInput("y", decodeOneKey);
  assert.deepEqual(inputs, ["x"]);
  assert.match(surface.render(80, 24).lines.map(stripAnsi).join("\n"), /read · src\/parser\.ts/);
  surface.handleInput("\t", decodeOneKey);
  assert.equal(resumes, 1);
  surface.suspend("attention");
  assert.equal(surface.state, "suspended");
  assert.deepEqual(surface.snapshot, { inputs: 1 });
  surface.handleInput("r", decodeOneKey);
  assert.equal(surface.state, "active");
  assert.equal(resumes, 2);
  surface.handleInput("\x1b", decodeOneKey);
  assert.equal(surface.state, "closed");
  surface.restoreTerminalFocus();
  assert.equal(surface.state, "closed");
  assert.equal(resumes, 2);
  assert.equal(surface.resume(), true);
  assert.deepEqual(pauses, ["unfocused", "attention", "hidden"]);
  assert.ok(invalidations > 0);
  await surface.dispose();
  await surface.dispose();
  assert.equal(disposals, 1);
  await host.dispose();
});

test("activity surface translates mouse coordinates and owns capture lifecycle", async () => {
  const inputs: ActivityInput[] = [];
  const capture: boolean[] = [];
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.mouse", name: "Mouse", capabilities: ["terminal.activities"] },
      activate(api) {
        api.registerActivity({
          id: "test.mouse-game",
          name: "Mouse Game",
          description: "Mouse translation fixture",
          category: "game",
          mouse: true,
          create: () => ({
            render: () => ({ lines: [[{ text: "MOUSE BOARD", style: "text" }]] }),
            handleInput: (input) => inputs.push(input),
            pause: () => undefined,
            resume: () => undefined,
            serialize: () => undefined,
            dispose: () => undefined,
          }),
        });
        api.registerActivity({
          id: "test.keyboard-game",
          name: "Keyboard Game",
          description: "No mouse capture fixture",
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
      },
    },
  ]);
  await host.activate();
  const surface = new ActivitySurfaceHost({
    host,
    palette: () => PLAIN_PALETTE,
    invalidate: () => undefined,
    monitor,
    agentFrame: (_width, height) => ({ lines: Array<string>(height).fill("AGENT") }),
    presentation: () => ({ reducedMotion: false, textOnly: false }),
    returnToTranscript: () => undefined,
    returnToEditor: () => undefined,
    openWorkspaceReview: () => undefined,
    reportError: (error) => assert.fail(error.message),
    setMouseCapture: (enabled) => capture.push(enabled),
  });
  surface.open("test.mouse-game");
  surface.render(80, 24);
  surface.handleInput("\x1b[<0;1;12M", decodeOneKey);
  assert.deepEqual(inputs.at(-1), {
    type: "mouse",
    phase: "press",
    button: "left",
    row: 0,
    column: 0,
    ctrl: false,
    alt: false,
    shift: false,
  });
  surface.handleInput("\x1b[<2;1;12M", decodeOneKey);
  assert.equal((inputs.at(-1) as Extract<ActivityInput, { type: "mouse" }>).button, "right");

  surface.suspend("attention");
  assert.deepEqual(capture, [true, false]);
  assert.equal(surface.resume(), true);
  assert.deepEqual(capture, [true, false, true]);

  surface.render(120, 30);
  surface.handleInput("\x1b[<0;1;1M", decodeOneKey);
  assert.equal(surface.agentFocused, true);
  surface.handleInput("\x1b[<0;119;15M", decodeOneKey);
  assert.equal(surface.agentFocused, false);
  assert.equal((inputs.at(-1) as Extract<ActivityInput, { type: "mouse" }>).button, "left");

  const standard = surface.render(80, 24).lines.map(stripAnsi);
  const menuColumn = (standard.at(-1) ?? "").indexOf("Ctrl+P menu");
  surface.handleInput(`\x1b[<0;${menuColumn + 1};24M`, decodeOneKey);
  assert.equal(surface.state, "picker");
  surface.render(80, 24);
  surface.handleInput("\x1b[<0;2;2M", decodeOneKey);
  assert.equal(surface.state, "active");

  surface.open("test.keyboard-game");
  assert.deepEqual(capture, [true, false, true, false]);
  surface.close();
  assert.deepEqual(capture, [true, false, true, false]);
  await surface.dispose();
  await host.dispose();
});

test("wide game library stays in the right pane and preserves the current instance", async () => {
  const creations = new Map<string, number>();
  const disposals = new Map<string, number>();
  const focusEvents: boolean[] = [];
  const host = new TerminalExtensionHost([
    {
      manifest: {
        id: "test.library",
        name: "Library",
        capabilities: ["terminal.activities"],
      },
      activate(api) {
        for (const [id, name] of [
          ["test.first", "First Game"],
          ["test.second", "Second Game"],
        ] as const) {
          api.registerActivity({
            id,
            name,
            description: `${name} fixture`,
            category: "game",
            create: () => {
              creations.set(id, (creations.get(id) ?? 0) + 1);
              return {
                render: () => ({ lines: [[{ text: `${name} board`, style: "text" }]] }),
                handleInput: (input) => {
                  if (input.type === "focus") focusEvents.push(input.focused);
                },
                pause: () => undefined,
                resume: () => undefined,
                serialize: () => ({ id }),
                dispose: () => {
                  disposals.set(id, (disposals.get(id) ?? 0) + 1);
                },
              };
            },
          });
        }
      },
    },
  ]);
  await host.activate();
  const agentInputs: string[] = [];
  const surface = new ActivitySurfaceHost({
    host,
    palette: () => PLAIN_PALETTE,
    invalidate: () => undefined,
    monitor,
    agentFrame: (width, height, focused) => ({
      lines: [fitTestRow("LIVE AGENT TRANSCRIPT", width), ...Array<string>(height - 1).fill("")],
      cursor: { row: 0, column: 2, visible: focused },
    }),
    handleAgentInput: (data) => {
      agentInputs.push(data);
      return false;
    },
    presentation: () => ({ reducedMotion: false, textOnly: false }),
    returnToTranscript: () => undefined,
    returnToEditor: () => undefined,
    openWorkspaceReview: () => undefined,
    reportError: (error) => {
      throw error;
    },
  });

  surface.open("test.first");
  surface.handleInput("\x10", decodeOneKey);
  const picker = surface.render(120, 30).lines.map(stripAnsi).join("\n");
  assert.match(picker, /LIVE AGENT TRANSCRIPT/);
  assert.match(picker, /Axl Lounge · Games/);
  assert.match(picker, /First Game · current/);
  assert.equal(creations.get("test.first"), 1);

  surface.handleInput("\t", decodeOneKey);
  assert.equal(surface.agentFocused, true);
  surface.handleInput("draft", decodeOneKey);
  assert.equal(agentInputs.join(""), "draft");
  surface.handleInput("\x10", decodeOneKey);
  assert.equal(surface.state, "active");
  assert.equal(surface.agentFocused, false);
  assert.equal(creations.get("test.first"), 1);

  surface.handleInput("\x10\r", decodeOneKey);
  assert.equal(surface.state, "active");
  assert.equal(creations.get("test.first"), 1);
  assert.equal(disposals.get("test.first") ?? 0, 0);

  surface.handleInput("\t\x1b[Z", decodeOneKey);
  assert.deepEqual(focusEvents, [false, true]);
  surface.handleInput("\x10\x1b[B\r", decodeOneKey);
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(creations.get("test.second"), 1);
  assert.equal(disposals.get("test.first"), 1);
  await surface.dispose();
  await host.dispose();
});

function fitTestRow(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - value.length))}`;
}

test("activity Agent pane preserves styled rows, navigation, details, and completion chrome", async () => {
  const agentInputs: string[] = [];
  const host = new TerminalExtensionHost([
    {
      manifest: {
        id: "test.agent-pane",
        name: "Agent pane",
        capabilities: ["terminal.activities"],
      },
      activate(api) {
        api.registerActivity({
          id: "test.centered-game",
          name: "Centered game",
          description: "Agent pane fixture",
          category: "game",
          create: () => ({
            render: () => ({ lines: [[{ text: "CENTERED BOARD", style: "accent" }]] }),
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
  const styledRow = "\u001b[45m tool card \u001b[49m";
  const surface = new ActivitySurfaceHost({
    host,
    palette: () => PLAIN_PALETTE,
    invalidate: () => undefined,
    monitor,
    agentFrame: (_width, height, focused) => ({
      lines: [
        ...Array.from({ length: Math.max(0, height - 2) }, (_, row) => `assistant row ${row}`),
        styledRow,
        "╭─ prompt ─╮",
      ].slice(0, height),
      cursor: { row: Math.max(0, height - 1), column: 4, visible: focused },
    }),
    handleAgentInput: (data) => {
      agentInputs.push(data);
      return data === "\t";
    },
    presentation: () => ({ reducedMotion: false, textOnly: false }),
    returnToTranscript: () => undefined,
    returnToEditor: () => undefined,
    openWorkspaceReview: () => undefined,
    reportError: (error) => {
      throw error;
    },
  });
  surface.open("test.centered-game");
  const initialWide = surface.render(120, 30);
  const wide = initialWide.lines;
  assert.equal(initialWide.cursor, undefined);
  assert.ok(wide.some((row) => row.includes("\u001b[45m tool card \u001b[49m")));
  assert.match(wide.map(stripAnsi).join("\n"), /Agent ◐ working 42s · live/);
  assert.doesNotMatch(wide.map(stripAnsi).join("\n"), /Agent · ·/);
  const boardRow = wide.findIndex((row) => stripAnsi(row).includes("CENTERED BOARD"));
  assert.ok(boardRow > 10 && boardRow < 20);

  const compactGame = surface.render(40, 18).lines.map(stripAnsi);
  assert.match(compactGame.at(-1) ?? "", /^Esc close · Tab agent · Ctrl\+P games/);

  surface.handleInput("\t", decodeOneKey);
  const focused = surface.render(80, 24);
  assert.doesNotMatch(focused.lines.map(stripAnsi).join("\n"), /\? help/);
  assert.equal(focused.cursor?.column, 4);
  assert.equal(focused.cursor?.visible, true);
  const compactAgent = surface.render(40, 18).lines.map(stripAnsi);
  assert.match(compactAgent.at(-1) ?? "", /^Esc close · Tab game · Enter send/);
  surface.handleInput("draft", decodeOneKey);
  assert.equal(agentInputs.join(""), "draft");
  surface.handleInput("\t", decodeOneKey);
  assert.equal(surface.agentFocused, true);
  surface.handleInput("\x1b[Z", decodeOneKey);
  assert.equal(surface.agentFocused, false);
  assert.equal(surface.render(120, 30).cursor, undefined);
  surface.handleInput("\t", decodeOneKey);
  const refocused = surface.render(120, 30);
  assert.equal(surface.agentFocused, true);
  assert.equal(refocused.cursor?.column, 4);
  assert.equal(refocused.cursor?.visible, true);
  surface.handleInput("\x1b[Z", decodeOneKey);

  surface.notifyCompletion();
  const completed = surface.render(120, 30).lines.map(stripAnsi).join("\n");
  assert.match(completed, /╭─ ✓ Axl finished/);
  assert.match(completed, /Ctrl\+T leave Wordle/);
  await surface.dispose();
  await host.dispose();
});

test("hostile monitor text cannot move or escape the activity board", async () => {
  let snapshot = monitor();
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.hostile", name: "Hostile", capabilities: ["terminal.activities"] },
      activate(api) {
        api.registerActivity({
          id: "test.stable-board",
          name: "Stable board",
          description: "Hostile monitor fixture",
          category: "game",
          create: () => ({
            render: () => ({ lines: [[{ text: "[B] [O] [A] [R] [D]", style: "text" }]] }),
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
  const surface = new ActivitySurfaceHost({
    host,
    palette: () => PLAIN_PALETTE,
    invalidate: () => undefined,
    monitor: () => snapshot,
    presentation: () => ({ reducedMotion: false, textOnly: false }),
    returnToTranscript: () => undefined,
    returnToEditor: () => undefined,
    openWorkspaceReview: () => undefined,
    reportError: (error) => {
      throw error;
    },
  });
  surface.open("test.stable-board");
  const before = surface.render(120, 30).lines.map(stripAnsi);
  const boardRow = before.findIndex((line) => line.includes("[B] [O] [A] [R] [D]"));
  const hostile = "🛰️漢字e\u0301\u202eMOVE\u202c\u001b[2J\u0007";
  snapshot = {
    ...snapshot,
    current: { label: hostile, status: "running", preview: [hostile] },
    recent: [{ label: hostile, status: "failed", preview: [hostile] }],
    changes: [hostile],
  };
  const after = surface.render(120, 30).lines.map(stripAnsi);
  assert.equal(
    after.findIndex((line) => line.includes("[B] [O] [A] [R] [D]")),
    boardRow,
  );
  assert.ok(after.every((line) => visibleWidth(line) <= 120));
  assert.equal(
    after.some((line) => /[\u202a-\u202e\u2066-\u2069]/u.test(line)),
    false,
  );
  assert.equal(
    after.some((line) => line.includes("\u001b") || line.includes("\u0007")),
    false,
  );
  await surface.dispose();
  await host.dispose();
});

test("one thousand activity open and close cycles release instances and timers", async () => {
  let creations = 0;
  let disposals = 0;
  let activeTimers = 0;
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.stress", name: "Stress", capabilities: ["terminal.activities"] },
      activate(api) {
        api.registerActivity({
          id: "test.stress-board",
          name: "Stress board",
          description: "Repeated lifecycle fixture",
          category: "game",
          create(activity) {
            creations += 1;
            activity.schedule(10_000, () => undefined);
            return {
              render: () => ({ lines: [] }),
              handleInput: () => undefined,
              pause: () => undefined,
              resume: () => undefined,
              serialize: () => undefined,
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
  const surface = new ActivitySurfaceHost({
    host,
    palette: () => PLAIN_PALETTE,
    invalidate: () => undefined,
    monitor,
    presentation: () => ({ reducedMotion: false, textOnly: false }),
    now: () => 0,
    schedule: () => {
      activeTimers += 1;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        activeTimers -= 1;
      };
    },
    returnToTranscript: () => undefined,
    returnToEditor: () => undefined,
    openWorkspaceReview: () => undefined,
    reportError: (error) => {
      throw error;
    },
  });
  for (let index = 0; index < 1_000; index += 1) {
    surface.open("test.stress-board");
    surface.close();
  }
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  await surface.reset();
  assert.equal(creations, 1_000);
  assert.equal(disposals, 1_000);
  assert.equal(activeTimers, 0);
  await surface.dispose();
  await host.dispose();
});

test("activity-specific minimum size pauses work before rendering invisible input", async () => {
  let renders = 0;
  const pauses: string[] = [];
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.minimum", name: "Minimum", capabilities: ["terminal.activities"] },
      activate(api) {
        api.registerActivity({
          id: "test.minimum-game",
          name: "Minimum game",
          description: "Minimum viewport fixture",
          category: "game",
          minimumViewport: { width: 40, height: 15 },
          create: () => ({
            render: () => {
              renders += 1;
              return { lines: [] };
            },
            handleInput: () => undefined,
            pause: (reason) => pauses.push(reason),
            resume: () => undefined,
            serialize: () => undefined,
            dispose: () => undefined,
          }),
        });
      },
    },
  ]);
  await host.activate();
  const surface = new ActivitySurfaceHost({
    host,
    palette: () => PLAIN_PALETTE,
    invalidate: () => undefined,
    monitor,
    presentation: () => ({ reducedMotion: false, textOnly: false }),
    returnToTranscript: () => undefined,
    returnToEditor: () => undefined,
    openWorkspaceReview: () => undefined,
    reportError: (error) => {
      throw error;
    },
  });
  surface.open("test.minimum-game");
  const frame = surface.render(40, 16).lines.map(stripAnsi).join("\n");
  assert.match(frame, /Activity needs 40×15 · available 40×14/);
  assert.equal(renders, 0);
  assert.deepEqual(pauses, ["unsupported-size"]);
  surface.handleInput("x", decodeOneKey);
  assert.equal(renders, 0);
  await surface.dispose();
  await host.dispose();
});

test("activity surface reports unsupported size without rendering the activity", async () => {
  let renders = 0;
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.size", name: "Size", capabilities: ["terminal.activities"] },
      activate(api) {
        api.registerActivity({
          id: "test.size-game",
          name: "Size game",
          description: "Size fixture",
          category: "game",
          create: () => ({
            render: () => {
              renders += 1;
              return { lines: [] };
            },
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
  const surface = new ActivitySurfaceHost({
    host,
    palette: () => PLAIN_PALETTE,
    invalidate: () => undefined,
    monitor,
    presentation: () => ({ reducedMotion: false, textOnly: false }),
    returnToTranscript: () => undefined,
    returnToEditor: () => undefined,
    openWorkspaceReview: () => undefined,
    reportError: (error) => {
      throw error;
    },
  });
  surface.open("test.size-game");
  assert.match(surface.render(39, 11).lines.map(stripAnsi).join("\n"), /terminal too small/);
  assert.equal(renders, 0);
  await surface.dispose();
  await host.dispose();
});
