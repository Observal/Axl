// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { trapDialogFocus } from "../src/dialog-focus.ts";

function focusable(name: string, focused: string[]): { focus(): void } {
  return { focus: () => focused.push(name) };
}

test("dialog focus wraps in both keyboard directions", () => {
  const focused: string[] = [];
  const first = focusable("first", focused);
  const middle = focusable("middle", focused);
  const last = focusable("last", focused);
  let selector = "";
  const root = {
    querySelectorAll: (value: string) => {
      selector = value;
      return [first, middle, last];
    },
  };
  let prevented = 0;

  trapDialogFocus({ key: "Tab", shiftKey: false, preventDefault: () => prevented++ }, root, last);
  trapDialogFocus({ key: "Tab", shiftKey: true, preventDefault: () => prevented++ }, root, first);
  trapDialogFocus({ key: "Tab", shiftKey: false, preventDefault: () => prevented++ }, root, middle);

  assert.deepEqual(focused, ["first", "last"]);
  assert.equal(prevented, 2);
  assert.match(selector, /\[tabindex\]/u);
  assert.match(selector, /type="hidden"/u);
});
