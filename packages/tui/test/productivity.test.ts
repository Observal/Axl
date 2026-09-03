// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  DeveloperPanelComponent,
  DiffReviewOverlay,
  LineEditor,
  PLAIN_PALETTE,
  VimModeController,
  type WorkspaceReview,
} from "../src/index.ts";

const diff: WorkspaceReview = {
  scope: "working",
  files: [
    {
      path: "src/example.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
      truncated: false,
    },
  ],
};

test("Vim mode edits through the standard grapheme-safe editor", () => {
  const editor = new LineEditor();
  const vim = new VimModeController();
  editor.setText("one two");

  assert.equal(vim.handle({ kind: "escape" }, editor), true);
  assert.equal(vim.mode, "normal");
  vim.handle({ kind: "char", char: "0" }, editor);
  vim.handle({ kind: "char", char: "d" }, editor);
  vim.handle({ kind: "char", char: "w" }, editor);
  assert.equal(editor.text, "two");
  vim.handle({ kind: "char", char: "o" }, editor);
  assert.equal(vim.mode, "insert");
  editor.apply({ kind: "char", char: "x" });
  assert.equal(editor.text, "two\nx");
  vim.handle({ kind: "escape" }, editor);
  editor.setText("abcx");
  vim.handle({ kind: "char", char: "0" }, editor);
  vim.handle({ kind: "char", char: "f" }, editor);
  vim.handle({ kind: "char", char: "x" }, editor);
  assert.equal(editor.render(40).cursorColumn, 3);
});

test("vertical movement preserves the preferred visual column", () => {
  const editor = new LineEditor();
  editor.setText("abcdef\nx\nabcdef");
  editor.apply({ kind: "up" });
  assert.equal(editor.render(40).cursorColumn, 1);
  editor.apply({ kind: "up" });
  assert.equal(editor.render(40).cursorColumn, 6);
});

test("developer panel is quiet when narrow and summarizes bounded workspace data", () => {
  const panel = new DeveloperPanelComponent(
    {
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      branch: "main",
      sandbox: "bubblewrap",
      connection: "connected",
      phase: "idle",
      diff,
    },
    () => PLAIN_PALETTE,
  );
  assert.deepEqual(panel.render(80), []);
  const rows = panel.render(120);
  assert.equal(rows[0], "");
  assert.match(rows.join("\n"), /Workspace/);
  assert.match(rows.join("\n"), /1 changed file {2}\+1 -1/);
  assert.equal(
    rows.every((row) => row.length <= 120),
    true,
  );
});

test("diff review switches scope and layout without mutating workspace", async () => {
  let layout = "unified";
  let refreshed = 0;
  const overlay = new DiffReviewOverlay({
    initial: diff,
    layout: "unified",
    palette: () => PLAIN_PALETTE,
    width: () => 120,
    height: () => 30,
    load: async (scope) => ({ ...diff, scope }),
    onLayout: (next) => {
      layout = next;
    },
    onClose: () => undefined,
    refresh: () => {
      refreshed += 1;
    },
  });
  assert.match(overlay.render(120).join("\n"), /working tree/);
  overlay.handleKey("v");
  assert.equal(layout, "split");
  overlay.handleKey("s");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(overlay.render(120).join("\n"), /last turn/);
  assert.equal(refreshed > 0, true);
});
