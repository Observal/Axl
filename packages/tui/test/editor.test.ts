// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { decodeKeys, LineEditor } from "../src/index.ts";

function type(editor: LineEditor, data: string): string | undefined {
  let submitted: string | undefined;
  for (const key of decodeKeys(data)) {
    const line = editor.apply(key);
    if (line !== undefined) submitted = line;
  }
  return submitted;
}

test("decodes characters, controls, and CSI sequences", () => {
  assert.deepEqual(decodeKeys("a"), [{ kind: "char", char: "a" }]);
  assert.deepEqual(decodeKeys("\x1b[D"), [{ kind: "left" }]);
  assert.deepEqual(decodeKeys("\x1b[1;5D"), [{ kind: "word-left" }]);
  assert.deepEqual(decodeKeys("\x1b[3~"), [{ kind: "delete" }]);
  assert.deepEqual(decodeKeys("\x1b\r"), [{ kind: "newline" }]);
  assert.deepEqual(decodeKeys("\x1b[13;2u"), [{ kind: "newline" }]);
  assert.deepEqual(decodeKeys("\x1b[27;2;13~"), [{ kind: "newline" }]);
  assert.deepEqual(decodeKeys("\x1b[13;2~"), [{ kind: "newline" }]);
  assert.deepEqual(decodeKeys("\x1b[13;3u"), [{ kind: "follow-up" }]);
  assert.deepEqual(decodeKeys("\x01"), [{ kind: "ctrl", char: "a" }]);
  assert.deepEqual(decodeKeys("\x1b[1;2D"), [{ kind: "select-left" }]);
  assert.deepEqual(decodeKeys("\x1b[122;6u"), [{ kind: "redo" }]);
  assert.deepEqual(decodeKeys("\x1b[127;5u"), [{ kind: "ctrl", char: "w" }]);
  assert.deepEqual(decodeKeys("\x1b[27;5;127~"), [{ kind: "ctrl", char: "w" }]);
  assert.deepEqual(decodeKeys("\x1b\x7f"), [{ kind: "ctrl", char: "w" }]);
  assert.deepEqual(decodeKeys("\t"), [{ kind: "tab" }]);
  assert.deepEqual(decodeKeys("\x1b[Z"), [{ kind: "shift-tab" }]);
  assert.deepEqual(decodeKeys("\x1b[200~"), [{ kind: "paste-start" }]);
  assert.deepEqual(decodeKeys("\x03"), [{ kind: "ctrl", char: "c" }]);
  assert.deepEqual(decodeKeys("\x1f"), [{ kind: "ctrl", char: "_" }]);
  assert.deepEqual(decodeKeys("\x00\u009b"), [{ kind: "unknown" }, { kind: "unknown" }]);
  assert.deepEqual(decodeKeys("\x1b"), [{ kind: "escape" }]);
});

test("Kitty release events do not duplicate characters", () => {
  const editor = new LineEditor();
  type(editor, "\x1b[97;1:1u\x1b[97;1:3u");
  assert.equal(editor.text, "a");
});

test("cursor editing: insert mid-line, delete, home and end", () => {
  const editor = new LineEditor();
  type(editor, "helo");
  type(editor, "\x1b[D"); // left, before the o
  type(editor, "l");
  assert.equal(editor.text, "hello");
  type(editor, "\x1b[HX"); // Home + insert
  assert.equal(editor.text, "Xhello");
  type(editor, "\x1b[3~"); // delete at cursor
  assert.equal(editor.text, "Xello");
  type(editor, "\x05!"); // end + insert
  assert.equal(editor.text, "Xello!");
  type(editor, "\x02?\x06!"); // Ctrl+B, insert, Ctrl+F, insert
  assert.equal(editor.text, "Xello?!!");
});

test("Ctrl+A and shifted arrows create replaceable visible selections", () => {
  const editor = new LineEditor();
  type(editor, "hello world\x01");
  assert.equal(editor.selectedText, "hello world");
  assert.equal(editor.render(40).lines.join("").includes("\x1b[7m"), true);
  type(editor, "replacement");
  assert.equal(editor.text, "replacement");

  type(editor, "\x1b[1;2D\x1b[1;2D");
  assert.equal(editor.selectedText, "nt");
  editor.apply({ kind: "backspace" });
  assert.equal(editor.text, "replaceme");
});

test("Backspace removes one grapheme and Ctrl+Backspace removes one word", () => {
  const editor = new LineEditor();
  type(editor, "one two🙂");
  type(editor, "\x7f");
  assert.equal(editor.text, "one two");
  type(editor, "\x1b[127;5u");
  assert.equal(editor.text, "one ");
});

test("word operations: word-left/right, Ctrl+W, Ctrl+U, Ctrl+K", () => {
  const editor = new LineEditor();
  type(editor, "one two three");
  type(editor, "\x1b[1;5D"); // word-left → before three
  type(editor, "\x17"); // Ctrl+W deletes "two "
  assert.equal(editor.text, "one three");
  type(editor, "\x0b"); // Ctrl+K kills to end
  assert.equal(editor.text, "one ");
  type(editor, "\x15"); // Ctrl+U kills to start
  assert.equal(editor.text, "");
});

test("kill-ring yank and undo restore editor content", () => {
  const editor = new LineEditor();
  type(editor, "one two");
  type(editor, "\x17");
  assert.equal(editor.text, "one ");
  type(editor, "\x19");
  assert.equal(editor.text, "one two");
  type(editor, "!");
  editor.apply({ kind: "ctrl", char: "-" });
  assert.equal(editor.text, "one two");
  editor.apply({ kind: "redo" });
  assert.equal(editor.text, "one two!");
});

test("Alt+Enter and pasted newlines insert; Enter submits the whole text", () => {
  const editor = new LineEditor();
  type(editor, "first");
  type(editor, "\x1b\r"); // Alt+Enter
  type(editor, "second");
  assert.equal(editor.text, "first\nsecond");
  const view = editor.render(40);
  assert.deepEqual(view.lines, ["first", "second"]);
  assert.equal(view.cursorRow, 1);

  assert.equal(type(editor, "\r"), "first\nsecond");
  assert.equal(editor.text, "");

  type(editor, "\x1b[200~a\rb\x1b[201~"); // bracketed paste with a newline
  assert.equal(editor.text, "a\nb");
  assert.equal(type(editor, "\r"), "a\nb"); // enter after paste submits
});

test("backslash plus Enter inserts a portable newline", () => {
  const editor = new LineEditor();
  type(editor, "first\\\rsecond");
  assert.equal(editor.text, "first\nsecond");
  assert.equal(type(editor, "\r"), "first\nsecond");
});

test("up and down move between lines before touching history", () => {
  const editor = new LineEditor();
  type(editor, "old line\r"); // history entry
  type(editor, "top");
  type(editor, "\x1b\r");
  type(editor, "bottom");
  type(editor, "\x1b[A"); // up → into the top line, not history
  assert.equal(editor.render(40).cursorRow, 0);
  type(editor, "\x1b[A"); // up at top → history
  assert.equal(editor.text, "old line");
  type(editor, "\x1b[B\x1b[B"); // back down through history to the draft
  assert.equal(editor.text, "top\nbottom");
});

test("rendering soft-wraps long lines and keeps the cursor visible", () => {
  const editor = new LineEditor();
  type(editor, "abcdefghij");
  const view = editor.render(5);
  assert.deepEqual(view.lines, ["abcde", "fghij", ""]);
  assert.equal(view.cursorRow, 2);
  assert.equal(view.cursorColumn, 0);
  type(editor, "\x1b[H");
  const start = editor.render(5);
  assert.deepEqual(start.lines, ["abcde", "fghij"]);
  assert.equal(start.cursorRow, 0);
  assert.equal(start.cursorColumn, 0);
});

test("editing and rendering preserve Unicode grapheme clusters", () => {
  const editor = new LineEditor();
  type(editor, "a👩‍💻界");
  editor.apply({ kind: "left" });
  editor.apply({ kind: "backspace" });
  assert.equal(editor.text, "a界");
  assert.deepEqual(editor.render(3).lines, ["a界"]);
});
