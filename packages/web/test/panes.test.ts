// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationState } from "@axl/sdk";
import {
  closePane,
  createPaneLayout,
  MIN_PANE_HEIGHT,
  openPane,
  paneChoices,
  paneFractions,
  parseBrowserTarget,
  parsePaneIds,
  resizePane,
  terminalEntries,
  togglePane,
  toggleZoom,
} from "../src/panes.ts";

test("panes open in canonical tiling order regardless of toggle order", () => {
  let layout = createPaneLayout([]);
  layout = togglePane(layout, "terminal");
  layout = togglePane(layout, "browser");
  layout = togglePane(layout, "changes");
  assert.deepEqual(layout.panes, ["browser", "changes", "terminal"]);
  layout = togglePane(layout, "changes");
  assert.deepEqual(layout.panes, ["browser", "terminal"]);
  assert.equal(openPane(layout, "browser"), layout);
  assert.equal(closePane(layout, "files"), layout);
});

test("default layout tiles the browser above files", () => {
  assert.deepEqual(createPaneLayout().panes, ["browser", "files"]);
  assert.deepEqual(paneFractions(createPaneLayout()), [0.5, 0.5]);
});

test("four open panes partition the complete dock in canonical order", () => {
  const layout = createPaneLayout(["terminal", "changes", "files", "browser"]);
  assert.deepEqual(layout.panes, ["browser", "files", "changes", "terminal"]);
  assert.deepEqual(paneFractions(layout), [0.25, 0.25, 0.25, 0.25]);
  assert.deepEqual(paneFractions(resizePane(layout, 1, 40, 800)), [0.25, 0.3, 0.2, 0.25]);
});

test("pane choices expose open, closed, and unavailable states", () => {
  const choices = paneChoices(["browser", "files"], {
    browser: undefined,
    files: "Workspace access unavailable",
    changes: undefined,
    terminal: "Shell access unavailable",
  });
  assert.deepEqual(
    choices.map(({ id, open, disabled, state }) => ({ id, open, disabled, state })),
    [
      { id: "browser", open: true, disabled: false, state: "Open" },
      { id: "files", open: true, disabled: false, state: "Open · unavailable" },
      { id: "changes", open: false, disabled: false, state: "Closed" },
      { id: "terminal", open: false, disabled: true, state: "Unavailable" },
    ],
  );
});

test("persisted pane lists are validated and normalized", () => {
  assert.deepEqual(parsePaneIds(["terminal", "browser"]), ["browser", "terminal"]);
  assert.deepEqual(parsePaneIds([]), []);
  assert.throws(() => parsePaneIds(["browser", "browser"]));
  assert.throws(() => parsePaneIds(["editor"]));
  assert.throws(() => parsePaneIds("browser"));
  assert.throws(() => parsePaneIds(["browser", "files", "changes", "terminal", "browser"]));
});

test("zoom gives one pane the whole dock and closing it restores tiling", () => {
  let layout = createPaneLayout(["browser", "files", "terminal"]);
  layout = toggleZoom(layout, "files");
  assert.equal(layout.zoomed, "files");
  assert.deepEqual(paneFractions(layout), [0, 1, 0]);
  assert.equal(toggleZoom(layout, "files").zoomed, undefined);
  assert.equal(toggleZoom(layout, "changes"), layout);
  layout = closePane(layout, "files");
  assert.equal(layout.zoomed, undefined);
  assert.deepEqual(layout.panes, ["browser", "terminal"]);
});

test("resizing trades height between neighbours and respects the minimum", () => {
  const layout = createPaneLayout(["browser", "files"]);
  const grown = resizePane(layout, 0, 100, 800);
  const fractions = paneFractions(grown);
  assert.ok(Math.abs((fractions[0] ?? 0) * 800 - 500) < 1e-6);
  assert.ok(Math.abs((fractions[1] ?? 0) * 800 - 300) < 1e-6);
  const clamped = paneFractions(resizePane(layout, 0, 10_000, 800));
  assert.ok(Math.abs((clamped[1] ?? 0) * 800 - MIN_PANE_HEIGHT) < 1e-6);
  assert.equal(resizePane(layout, 1, 50, 800), layout);
  const zoomed = toggleZoom(layout, "files");
  assert.equal(resizePane(zoomed, 0, 50, 800), zoomed);
  assert.equal(resizePane(layout, 0, 50, 0), layout);
});

test("browser targets accept web URLs and default bare hosts sensibly", () => {
  assert.deepEqual(parseBrowserTarget("localhost:5173"), {
    url: "http://localhost:5173/",
    loopback: true,
  });
  assert.deepEqual(parseBrowserTarget(" http://127.0.0.1:3000/app?x=1 "), {
    url: "http://127.0.0.1:3000/app?x=1",
    loopback: true,
  });
  assert.deepEqual(parseBrowserTarget("example.com/docs"), {
    url: "https://example.com/docs",
    loopback: false,
  });
  assert.deepEqual(parseBrowserTarget("http://example.com"), {
    url: "http://example.com/",
    loopback: false,
  });
  assert.equal(parseBrowserTarget("http://[::1]:8080").loopback, true);
  assert.throws(() => parseBrowserTarget(""), /Enter a URL/u);
  assert.throws(() => parseBrowserTarget("javascript:alert(1)"), /Only http and https/u);
  assert.throws(() => parseBrowserTarget("file:///etc/passwd"), /Only http and https/u);
  assert.throws(() => parseBrowserTarget("http://user:pw@localhost:3000"), /credentials/u);
  assert.throws(() => parseBrowserTarget("http://"), /not a valid URL/u);
});

test("terminal entries project direct shell history in order", () => {
  const conversation = {
    records: [
      {
        kind: "event",
        event: {
          id: "s1",
          timestamp: 10,
          type: "user.shell",
          payload: {
            command: "printf hi",
            content: [{ type: "text", text: "hi" }],
            isError: false,
            excluded: false,
          },
        },
      },
      {
        kind: "event",
        event: { id: "m", timestamp: 11, type: "user.message", payload: { content: [] } },
      },
      {
        kind: "event",
        event: {
          id: "s2",
          timestamp: 12,
          type: "user.shell",
          payload: {
            command: "false",
            content: [
              { type: "text", text: "exit 1" },
              {
                type: "blob",
                blob: {
                  sha256: "a".repeat(64),
                  mediaType: "text/plain",
                  sizeBytes: 3,
                  name: "out.txt",
                },
              },
            ],
            isError: true,
            excluded: true,
          },
        },
      },
    ],
  } as unknown as ConversationState;
  assert.deepEqual(terminalEntries(conversation), [
    {
      id: "s1",
      command: "printf hi",
      output: "hi",
      isError: false,
      excluded: false,
      timestamp: 10,
    },
    {
      id: "s2",
      command: "false",
      output: "exit 1\n[out.txt]",
      isError: true,
      excluded: true,
      timestamp: 12,
    },
  ]);
});
