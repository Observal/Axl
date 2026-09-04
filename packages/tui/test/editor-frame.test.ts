// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  ActivityComponent,
  EditorFrameComponent,
  LineEditor,
  PLAIN_PALETTE,
  SessionView,
  visibleWidth,
} from "../src/index.ts";

function fixture(width: number) {
  const editor = new LineEditor();
  editor.setText("hello world");
  const view = new SessionView(width, PLAIN_PALETTE);
  view.model = "gpt-5";
  view.thinking = "medium";
  view.sandbox = "bubblewrap";
  const frame = new EditorFrameComponent(editor, () => view);
  frame.update({ location: "~/project  git:main" });
  return { editor, view, frame };
}

test("renders one width-safe rounded Axl editor frame", () => {
  const { frame } = fixture(80);
  const rendered = frame.render(80);

  assert.equal(rendered[0], "");
  assert.match(rendered[1] ?? "", /^╭/);
  assert.match(rendered[2] ?? "", /^│ hello world/);
  assert.match(rendered[3] ?? "", /^╰/);
  assert.equal(
    rendered.every((line) => visibleWidth(line) <= 80),
    true,
  );
  assert.deepEqual(frame.cursorPlacement(), { row: 2, column: 13 });
  assert.equal(frame.render(80), rendered);
});

test("uses a compact borderless layout on narrow terminals", () => {
  const { view, frame } = fixture(40);
  view.working = true;
  view.elapsedSeconds = 7;
  frame.update({
    location: "~/project  git:main",
    notice: "queued follow-up",
    completion: ["Suggestions", "> /model  select a model"],
  });
  const rendered = frame.render(40);

  assert.equal(
    rendered.some((line) => line.includes("╭") || line.includes("╰")),
    false,
  );
  assert.match(rendered.join("\n"), /hello world/);
  assert.equal(
    rendered.indexOf("Suggestions") > rendered.findIndex((line) => line.includes("hello world")),
    true,
  );
  assert.equal(
    rendered.every((line) => visibleWidth(line) <= 40),
    true,
  );
  assert.deepEqual(frame.cursorPlacement(), { row: 2, column: 11 });
});

test("renders prominent activity outside the composer", () => {
  const activity = new ActivityComponent(() => PLAIN_PALETTE);
  activity.update({ working: true, spinner: "◐", elapsedSeconds: 7, queued: 2 });
  assert.deepEqual(activity.render(80), ["", "  ◐  Working  7s · 2 queued"]);
  activity.update({ working: false, spinner: "", elapsedSeconds: 0, queued: 0 });
  assert.deepEqual(activity.render(80), []);
});

test("invalidates cached rows when editor state changes", () => {
  const { editor, frame } = fixture(80);
  const before = frame.render(80);
  editor.setText("changed");
  frame.update({ location: "~/project  git:main" });
  const after = frame.render(80);

  assert.notEqual(after, before);
  assert.match(after.join("\n"), /changed/);
});
