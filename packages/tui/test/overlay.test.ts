// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { OverlayStack, type Overlay } from "../src/overlay.ts";

function overlay(name: string, events: string[]): Overlay {
  return {
    render: (width) => [`${name}:${width}`],
    handleKey: (data) => events.push(`${name}:${data}`),
    cursor: () => ({ row: 1, column: name.length }),
    dispose: () => events.push(`${name}:disposed`),
  };
}

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
