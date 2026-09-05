// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOWRAP_OFF,
  AUTOWRAP_ON,
  DifferentialScreen,
  clipFrame,
  linkAtCell,
  plainTextByCells,
  SYNC_BEGIN,
  SYNC_END,
  sanitizeTerminalText,
  stripAnsi,
  styleCellRanges,
  truncateToWidth,
  visibleLength,
  visibleWidth,
  wrapLine,
} from "../src/index.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const FRAME_START = `${SYNC_BEGIN}${AUTOWRAP_OFF}`;
const FRAME_END = `${AUTOWRAP_ON}${SYNC_END}`;

function lines(...values: string[]): { render: () => string[] }[] {
  return [{ render: () => values }];
}

test("the first frame paints every line inside one synchronized block", () => {
  const screen = new DifferentialScreen(80);
  const frame = screen.frame(lines("status", "> "));
  assert.equal(frame, `${FRAME_START}\r\x1b[2Kstatus\r\n\x1b[2K> ${FRAME_END}`);
  assert.equal(screen.liveHeight, 2);
});

test("repeated live updates do not grow terminal scrollback", () => {
  const screen = new DifferentialScreen(20);
  const terminal = new VirtualTerminal(20, 4);
  for (let index = 0; index < 50; index += 1) {
    terminal.write(screen.frame(lines(`status ${index}`, "> ")));
  }
  assert.equal(terminal.cursorRow, 1);
  assert.deepEqual(terminal.rows(), ["status 49", ">"]);
});

test("growing live output preserves submitted prompts and tool rows", () => {
  const screen = new DifferentialScreen(40);
  const terminal = new VirtualTerminal(40, 8);
  terminal.write("submitted prompt\r\nfinished tool\r\n");
  terminal.write(screen.frame(lines("working", "editor")));
  terminal.write(screen.frame(lines("working", "stream one", "stream two", "editor")));
  const rows = terminal.rows();
  assert.equal(rows.filter((row) => row.includes("submitted prompt")).length, 1);
  assert.equal(rows.filter((row) => row.includes("finished tool")).length, 1);
  assert.equal(rows.filter((row) => row.includes("stream one")).length, 1);
  assert.equal(rows.filter((row) => row.includes("stream two")).length, 1);
});

test("cursor visibility changes without repainting unchanged rows", () => {
  const screen = new DifferentialScreen(20);
  screen.frame(lines("editor"), { row: 0, column: 2, visible: true });
  const hidden = screen.frame(lines("editor"), { row: 0, column: 2, visible: false });
  assert.equal(hidden, `${FRAME_START}\x1b[?25l${FRAME_END}`);
  const shown = screen.frame(lines("editor"), { row: 0, column: 2, visible: true });
  assert.equal(shown, `${FRAME_START}\x1b[?25h${FRAME_END}`);
});

test("an unchanged frame writes nothing", () => {
  const screen = new DifferentialScreen(80);
  screen.frame(lines("status", "> "));
  assert.equal(screen.frame(lines("status", "> ")), "");
});

test("a changed tail repaints only from the first changed line", () => {
  const screen = new DifferentialScreen(80);
  screen.frame(lines("status", "> "));
  const frame = screen.frame(lines("status", "> h"));
  // Only the input line repaints in place.
  assert.equal(frame, `${FRAME_START}\r\x1b[2K> h${FRAME_END}`);
});

test("growth anchors upward and shrink clears the leftover rows", () => {
  const screen = new DifferentialScreen(80);
  screen.frame(lines("a", "b"));
  const grown = screen.frame(lines("a", "b", "c"));
  assert.equal(grown, `${FRAME_START}\r\n\x1b[2F\x1b[2Ka\r\n\x1b[2Kb\r\n\x1b[2Kc${FRAME_END}`);

  const shrunk = screen.frame(lines("a"));
  assert.equal(shrunk, `${FRAME_START}\x1b[1F\x1b[0J\x1b[1F${FRAME_END}`);
  assert.equal(screen.liveHeight, 1);

  const cleared = screen.clear();
  assert.equal(cleared, `${FRAME_START}\r\x1b[0J${FRAME_END}`);
  assert.equal(screen.liveHeight, 0);
});

test("a width change forces a full repaint", () => {
  const screen = new DifferentialScreen(80);
  screen.frame(lines("same"));
  screen.setWidth(40);
  const frame = screen.frame(lines("same"));
  assert.equal(frame, `${FRAME_START}\r\x1b[2Ksame${FRAME_END}`);
});

test("differential frames converge on semantic terminal state", () => {
  const screen = new DifferentialScreen(20);
  const terminal = new VirtualTerminal(20, 6);

  terminal.write(screen.frame(lines("alpha", "beta")));
  assert.deepEqual(terminal.rows(), ["alpha", "beta"]);

  terminal.write(screen.frame(lines("alpha", "βeta", "界")));
  assert.deepEqual(terminal.rows(), ["alpha", "βeta", "界"]);

  terminal.write(screen.frame(lines("final")));
  assert.deepEqual(terminal.rows(), ["final"]);
  assert.equal(terminal.synchronized, false);
});

test("reset forgets stale terminal geometry after an external clear", () => {
  const screen = new DifferentialScreen(80);
  screen.frame(lines("old", "content"));
  screen.reset(40);
  assert.equal(screen.liveHeight, 0);
  assert.equal(screen.frame(lines("new")), `${FRAME_START}\r\x1b[2Knew${FRAME_END}`);
});

test("wrapLine hard-wraps ANSI and Unicode text by terminal-cell width", () => {
  assert.deepEqual(wrapLine("abcdef", 3), ["abc", "def"]);
  assert.deepEqual(wrapLine("abc", 3), ["abc"]);
  const styled = "\x1b[36mabcd\x1b[39m";
  assert.equal(visibleLength(styled), 4);
  const wrapped = wrapLine(styled, 2);
  assert.equal(wrapped.length, 2);
  assert.equal(visibleLength(wrapped[0] ?? ""), 2);
  assert.equal(visibleLength("a界👩‍💻"), 5);
  assert.equal(visibleLength("🇮🇳1️⃣क्ष"), 5);
  assert.deepEqual(wrapLine("a界👩‍💻", 3).map(visibleLength), [3, 2]);
});

test("common-text fast paths preserve complex grapheme widths", () => {
  assert.equal(visibleWidth("👍🏽"), 2);
  assert.equal(visibleWidth("가"), 2);
  assert.deepEqual(wrapLine("a👍🏽b", 3), ["a👍🏽", "b"]);
  assert.equal(stripAnsi(truncateToWidth("a👍🏽b", 3, "")), "a👍🏽");
});

test("cell ranges preserve graphemes and expose OSC 8 destinations", () => {
  const linked = "\x1b]8;;https://example.com\x07a界\x1b]8;;\x07";
  assert.equal(linkAtCell(linked, 0), "https://example.com");
  assert.equal(linkAtCell(linked, 2), "https://example.com");
  assert.equal(plainTextByCells(linked, 1, 3), "界");
  const styled = styleCellRanges(linked, [{ start: 1, end: 3, style: (text) => `<${text}>` }]);
  assert.match(styled, /a<界>/);
});

test("terminal sanitization removes complete DCS, C1, and bidi override controls", () => {
  assert.equal(sanitizeTerminalText("before\x1bPprivate payload\x1b\\after"), "beforeafter");
  assert.equal(sanitizeTerminalText("safe\u009bunsafe"), "safeunsafe");
  assert.equal(sanitizeTerminalText("safe\u202eevil\u202ctext"), "safeeviltext");
  const natural = "English العربية עברית क्ष 👩‍💻";
  assert.equal(sanitizeTerminalText(natural), natural);
  assert.equal(
    wrapLine(natural, 12).every((line) => visibleLength(line) <= 12),
    true,
  );
});

test("cursor clipping retains pinned safety rows and hides a cursor outside the allocation", () => {
  const lines = [
    "UNSAFE: full host access",
    ...Array.from({ length: 20 }, (_, i) => `editor ${i}`),
  ];
  for (const row of [1, 20]) {
    const clipped = clipFrame(lines, 4, { row, column: 2 }, 1);
    assert.equal(clipped.lines.length, 4);
    assert.equal(clipped.lines[0], lines[0]);
    assert.ok(clipped.cursor !== undefined);
    assert.equal(clipped.lines[clipped.cursor.row], lines[row]);
  }
  const tiny = clipFrame(lines, 1, { row: 20, column: 2 }, 1);
  assert.deepEqual(tiny.lines, [lines[0]]);
  assert.equal(tiny.cursor, undefined);
  assert.deepEqual(clipFrame(lines, 0, { row: 1, column: 2 }).lines, []);
});
