// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  FullscreenScreen,
  fullscreenAction,
  PLAIN_PALETTE,
  type TranscriptRow,
} from "../src/index.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function output() {
  let text = "";
  return {
    terminal: {
      isTTY: true as const,
      columns: 40,
      rows: 8,
      write(value: string) {
        text += value;
        return true;
      },
      on() {},
      off() {},
    },
    text: () => text,
  };
}

function rows(values: readonly string[], prompts: readonly number[] = []): TranscriptRow[] {
  const promptRows = new Set(prompts);
  return values.map((text, index) => ({
    text,
    sourceId: `source-${index}`,
    prompt: promptRows.has(index),
    rowInSource: 0,
  }));
}

function frame(document: readonly TranscriptRow[]) {
  return {
    document,
    dock: ["prompt", "footer"],
    cursor: { row: 0, column: 2 },
    palette: PLAIN_PALETTE,
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
  };
}

test("decodes Linux and Kitty fullscreen navigation variants", () => {
  assert.equal(fullscreenAction("\x1b[5;1:1~"), "page-up");
  assert.equal(fullscreenAction("\x1b[6;2:1~"), "half-page-down");
  assert.equal(fullscreenAction("\x1b[1;3:1A"), "line-up");
  assert.equal(fullscreenAction("\x1b[1;6:1B"), "next-prompt");
  assert.equal(fullscreenAction("\x1b[1;1:1H"), "top");
  assert.equal(fullscreenAction("\x1b[1;1:1F"), "bottom");
});

test("enters alternate screen and keeps the dock fixed while scrolling", () => {
  const capture = output();
  const screen = new FullscreenScreen(capture.terminal, 40, 8, "always");
  const document = rows(Array.from({ length: 20 }, (_, index) => `line ${index}`));
  screen.enter();
  screen.render(frame(document));
  assert.equal(capture.text().includes("\x1b[?1049h"), true);
  assert.equal(capture.text().includes("\x1b[?1002h"), true);
  assert.match(capture.text(), /line 19/);
  assert.match(capture.text(), /prompt/);

  assert.equal(screen.handleInput("\x1b[5~", document, 2), true);
  screen.render(frame(document));
  assert.match(capture.text(), /paused/);
  assert.equal(screen.handleInput("\x1b[F", document, 2), true);
  screen.render(frame(document));
  assert.match(capture.text(), /Transcript · latest/);
  assert.equal(capture.text().includes(" LIVE "), false);
});

test("resize clears scroll damage and repaints within the current viewport", () => {
  const capture = output();
  const screen = new FullscreenScreen(capture.terminal, 40, 8, "hidden");
  screen.enter();
  screen.render(frame(rows(["before"])));
  const beforeResize = capture.text().length;

  screen.resize(30, 6);
  screen.render({ ...frame(rows(["after"])), dock: ["editor", "status"] });
  const update = capture.text().slice(beforeResize);
  assert.equal(update.includes("\x1b[?2026h\x1b[?7l\x1b[2J\x1b[H"), true);

  const terminal = new VirtualTerminal(30, 6);
  terminal.write(capture.text());
  assert.equal(terminal.rows()[0], "Transcript · latest");
  assert.equal(terminal.rows().includes("editor"), true);
  assert.equal(terminal.rows().includes("status"), true);
});

test("clips an oversized dock from the top while preserving its cursor and tail", () => {
  const capture = output();
  const screen = new FullscreenScreen(capture.terminal, 40, 8, "hidden");
  const document = rows(["latest output"]);
  screen.enter();
  screen.render({
    ...frame(document),
    dock: Array.from({ length: 10 }, (_, index) => `dock ${index}`),
    cursor: { row: 8, column: 2 },
  });

  const terminal = new VirtualTerminal(40, 8);
  terminal.write(capture.text());
  assert.equal(terminal.rows()[0], "Transcript · latest");
  assert.equal(terminal.rows().includes("dock 0"), false);
  assert.equal(terminal.rows().includes("dock 6"), true);
  assert.equal(terminal.rows().includes("dock 9"), true);
  assert.equal(terminal.cursorRow < 8, true);
});

test("search highlights every match and navigates in both directions", () => {
  const capture = output();
  const screen = new FullscreenScreen(capture.terminal, 40, 8, "auto");
  const document = rows(["alpha target", "beta target", "gamma", "target delta"]);
  screen.enter();
  assert.equal(screen.handleInput("\x1b[102;5u", document, 2), true);
  assert.equal(screen.handleInput("target", document, 2), true);
  screen.render(frame(document));
  assert.match(capture.text(), /find · target · 1\/3/);
  assert.equal(capture.text().includes("\x1b[4m"), true);
  assert.equal(capture.text().includes("\x1b[1;7m"), true);

  screen.handleInput("\r", document, 2);
  screen.render(frame(document));
  assert.match(capture.text(), /find · target · 2\/3/);
  screen.handleInput("\x1b[13;2u", document, 2);
  screen.render(frame(document));
  assert.match(capture.text(), /find · target · 1\/3/);
  screen.exit(document, "transcript", "123e4567-e89b-42d3-a456-426614174000");
});

test("leaves synchronous mouse repaint ownership to the app", () => {
  const capture = output();
  let requested = 0;
  const screen = new FullscreenScreen(capture.terminal, 40, 8, "hidden", {
    requestRender: () => {
      requested += 1;
    },
  });
  const document = rows(Array.from({ length: 20 }, (_, index) => `line ${index}`));
  screen.enter();
  screen.render(frame(document));
  assert.equal(screen.handleInput("\x1b[<64;10;5M", document, 2), true);
  assert.equal(requested, 0);
});

test("consumes mouse reports and copies a drag selection only after success", async () => {
  const capture = output();
  const copied: string[] = [];
  const screen = new FullscreenScreen(capture.terminal, 40, 8, "hidden", {
    copySelection: async (text) => {
      copied.push(text);
    },
  });
  const document = rows(["alpha", "beta", "gamma", "delta"]);
  screen.enter();
  screen.render(frame(document));

  assert.equal(screen.handleInput("\x1b[<0;1;2M", document, 2), true);
  assert.equal(screen.handleInput("\x1b[<32;5;2M", document, 2), true);
  assert.equal(screen.handleInput("\x1b[<0;5;2m", document, 2), true);
  assert.equal(screen.handleInput("\x1b[<35;9;4M", document, 2), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(copied, ["beta"]);
  screen.exit(document, "transcript", "123e4567-e89b-42d3-a456-426614174000");
});

test("opens only a clicked OSC 8 destination without copying text", () => {
  const capture = output();
  const opened: string[] = [];
  const copied: string[] = [];
  const screen = new FullscreenScreen(capture.terminal, 40, 8, "hidden", {
    openUrl: (url) => opened.push(url),
    copySelection: async (text) => {
      copied.push(text);
    },
  });
  const document = rows(["\x1b]8;;https://example.com\x07link\x1b]8;;\x07"]);
  screen.enter();
  screen.render(frame(document));
  screen.handleInput("\x1b[<0;1;2M", document, 2);
  screen.handleInput("\x1b[<0;1;2m", document, 2);
  assert.deepEqual(opened, ["https://example.com"]);
  assert.deepEqual(copied, []);
  screen.exit(document, "resume-hint", "123e4567-e89b-42d3-a456-426614174000");
});

test("prompt jumps, line movement, scrollbar dragging, and native mouse mode behave", () => {
  const capture = output();
  const screen = new FullscreenScreen(capture.terminal, 24, 8, "always");
  const document = rows(
    Array.from({ length: 16 }, (_, index) => `line ${index}`),
    [1, 7, 13],
  );
  screen.enter();
  screen.render(frame(document));
  assert.equal(screen.handleInput("\x1b[1;6A", document, 2), true);
  screen.render(frame(document));
  assert.match(capture.text(), /line 7/);
  assert.equal(screen.handleInput("\x1b[1;3A", document, 2), true);
  assert.equal(screen.handleInput("\x1b[<0;24;2M", document, 2), true);
  assert.equal(screen.handleInput("\x1b[<32;24;4M", document, 2), true);
  assert.equal(screen.handleInput("\x1b[<0;24;4m", document, 2), true);

  screen.setMouse("native");
  assert.equal(capture.text().includes("\x1b[?1002l"), true);
  assert.equal(screen.handleInput("\x1b[<0;2;2M", document, 2), true);
  screen.exit(document, "transcript", "123e4567-e89b-42d3-a456-426614174000");
});

test("pause and exit disable every mouse mode before restoring the screen", () => {
  const capture = output();
  const screen = new FullscreenScreen(capture.terminal, 40, 8, "hidden");
  const document = rows(["private transcript"]);
  screen.enter();
  screen.pause();
  assert.equal(capture.text().includes("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l"), true);
  assert.equal(capture.text().includes("\x1b[?1049l"), true);
  screen.resume();
  screen.exit(document, "resume-hint", "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(capture.text().includes("private transcript"), false);
  assert.match(capture.text(), /axl 123e4567/);

  const terminal = new VirtualTerminal(40, 8);
  terminal.write(capture.text());
  assert.equal(terminal.alternateScreen, false);
  assert.equal(terminal.autowrap, true);
  assert.deepEqual([...terminal.mouseModes], []);
  assert.equal(terminal.cursorVisible, true);
});

test("clicking a tool toggles detail while dragging still selects text", async () => {
  const capture = output();
  const toggled: string[] = [];
  const copied: string[] = [];
  const screen = new FullscreenScreen(capture.terminal, 40, 8, "hidden", {
    toggleToolGroup: (id) => {
      toggled.push(id);
    },
    copySelection: async (text) => {
      copied.push(text);
    },
  });
  const document = rows(["tool result"]).map((row) => ({ ...row, toolGroupId: "tool-group" }));
  screen.enter();
  screen.render(frame(document));
  screen.handleInput("\x1b[<0;2;2M", document, 2);
  screen.handleInput("\x1b[<0;2;2m", document, 2);
  assert.deepEqual(toggled, ["tool-group"]);
  screen.handleInput("\x1b[<0;1;2M", document, 2);
  screen.handleInput("\x1b[<32;8;2M", document, 2);
  screen.handleInput("\x1b[<0;8;2m", document, 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(copied.length, 1);
  assert.deepEqual(toggled, ["tool-group"]);
  screen.exit(document, "resume-hint", "123e4567-e89b-42d3-a456-426614174000");
});
