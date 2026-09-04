// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { type Component, ComponentStack } from "../src/index.ts";

function component(lines: string[], invalidations: string[], name: string): Component {
  return {
    render: () => lines,
    invalidate: () => invalidations.push(name),
  };
}

test("renders retained children in stable vertical order", () => {
  const invalidations: string[] = [];
  const stack = new ComponentStack();
  const first = component(["one", "two"], invalidations, "first");
  const second = component(["three"], invalidations, "second");
  stack.replace([first, second]);

  assert.deepEqual(stack.render(80), ["one", "two", "three"]);
  assert.equal(stack.offsetOf(first), 0);
  assert.equal(stack.offsetOf(second), 2);
  stack.invalidate();
  assert.deepEqual(invalidations, ["first", "second"]);
});

test("replaces the live child set without retaining stale components", () => {
  const stack = new ComponentStack();
  stack.replace([{ render: () => ["old"] }]);
  stack.replace([{ render: () => ["new"] }]);
  assert.deepEqual(stack.render(80), ["new"]);
});
