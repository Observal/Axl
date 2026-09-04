// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { PickerOverlay, PLAIN_PALETTE, visibleWidth } from "../src/index.ts";

function fixture() {
  const selected: string[] = [];
  let cancelled = 0;
  const picker = new PickerOverlay({
    title: "Models",
    items: [
      { value: "gpt-5", label: "GPT 5" },
      { value: "claude-sonnet", label: "Claude Sonnet" },
      { value: "gemini-pro", label: "Gemini Pro" },
    ],
    current: "gpt-5",
    palette: () => PLAIN_PALETTE,
    onPick: (value) => selected.push(value),
    onCancel: () => {
      cancelled += 1;
    },
  });
  return { picker, selected, cancelled: () => cancelled };
}

test("filters labels, preserves width, and selects the highlighted result", () => {
  const state = fixture();
  state.picker.handleKey("son");
  const rendered = state.picker.render(50);

  assert.match(rendered.join("\n"), /Claude Sonnet/);
  assert.equal(rendered.join("\n").includes("Gemini Pro"), false);
  assert.equal(
    rendered.every((line) => visibleWidth(line) <= 50),
    true,
  );
  state.picker.handleKey("\r");
  assert.deepEqual(state.selected, ["claude-sonnet"]);
});

test("previews highlighted choices and renders preview content", () => {
  const highlighted: string[] = [];
  const picker = new PickerOverlay({
    title: "Themes",
    items: [
      { value: "dark", label: "Theme", description: "dark" },
      { value: "ocean", label: "Theme", description: "ocean" },
    ],
    current: "dark",
    palette: () => PLAIN_PALETTE,
    onPick: () => undefined,
    onCancel: () => undefined,
    onHighlight: (value) => highlighted.push(value),
    preview: (width) => [`accent success warning error ${width}`],
  });

  picker.handleKey("\x1b[B");
  assert.deepEqual(highlighted, ["ocean"]);
  const rendered = picker.render(60);
  assert.match(rendered.join("\n"), /Theme {2}ocean/);
  assert.match(rendered.join("\n"), /accent success warning error 56/);
  assert.equal(
    rendered.every((line) => visibleWidth(line) <= 60),
    true,
  );
});

test("supports navigation, numeric selection, backspace, and cancellation", () => {
  const state = fixture();
  state.picker.handleKey("\x1b[B\r");
  assert.deepEqual(state.selected, ["claude-sonnet"]);

  const numeric = fixture();
  numeric.picker.handleKey("3");
  assert.deepEqual(numeric.selected, ["gemini-pro"]);

  const filtered = fixture();
  filtered.picker.handleKey("x\x7f\x1b");
  assert.equal(filtered.cancelled(), 1);
});
