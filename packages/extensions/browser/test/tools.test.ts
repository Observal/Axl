// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { JsonObject } from "@axl/protocol";
import { ToolInputError } from "@axl/kernel";

import {
  makeBrowserBackTool,
  makeBrowserClickTool,
  makeBrowserEvalTool,
  makeBrowserForwardTool,
  makeBrowserNavigateTool,
  makeBrowserReadTool,
  makeBrowserScreenshotTool,
  makeBrowserScrollTool,
  makeBrowserSelectTool,
  makeBrowserTools,
  makeBrowserTypeTool,
  makeBrowserWaitTool,
} from "../src/tools.ts";
import type { BrowserSession, PageState } from "../src/session.ts";

const noSignal = new AbortController().signal;

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
}

function fakePage(overrides: Partial<PageState> = {}): PageState {
  return {
    url: overrides.url ?? "https://example.com",
    title: overrides.title ?? "Example",
    excerpt: overrides.excerpt ?? "Hello world",
  };
}

function fakeSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  const page = fakePage();
  return {
    navigate: async () => page,
    screenshot: async () => Buffer.from("fake-png-bytes"),
    click: async () => page,
    clickCoordinates: async () => page,
    type: async () => page,
    scroll: async () => page,
    readPage: async () => "Full page text content for testing.",
    back: async () => page,
    forward: async () => page,
    waitForSelector: async () => page,
    evaluate: async () => ({ ok: true }),
    selectOption: async () => page,
    close: async () => {},
    ...overrides,
  };
}

async function workspace(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "axl-browser-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("browser_navigate validates input and returns page state", async () => {
  const navigated: string[] = [];
  const session = fakeSession({
    navigate: async (url) => {
      navigated.push(url);
      return fakePage({ url, title: "Navigated", excerpt: "Page loaded" });
    },
  });
  const tool = makeBrowserNavigateTool({ session });

  const result = await tool.execute({ url: "https://example.com/page" }, noSignal);
  assert.equal(result.isError, false);
  assert.match(text(result), /Navigated/);
  assert.match(text(result), /Page loaded/);
  assert.deepEqual(navigated, ["https://example.com/page"]);
});

test("browser_navigate rejects missing url", async () => {
  const tool = makeBrowserNavigateTool({ session: fakeSession() });
  await assert.rejects(tool.execute({}, noSignal), ToolInputError);
});

test("browser_navigate rejects non-http schemes", async () => {
  const tool = makeBrowserNavigateTool({ session: fakeSession() });
  await assert.rejects(tool.execute({ url: "file:///etc/passwd" }, noSignal), /http or https/);
});

test("browser_navigate rejects credentials in URL", async () => {
  const tool = makeBrowserNavigateTool({ session: fakeSession() });
  await assert.rejects(
    tool.execute({ url: "https://user:pass@example.com" }, noSignal),
    /credentials/,
  );
});

test("browser_navigate rejects unknown fields", async () => {
  const tool = makeBrowserNavigateTool({ session: fakeSession() });
  await assert.rejects(
    tool.execute({ url: "https://example.com", extra: true }, noSignal),
    ToolInputError,
  );
});

test("browser_screenshot returns base64 text content", async () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const session = fakeSession({ screenshot: async () => pngBytes });
  const tool = makeBrowserScreenshotTool({ session });

  const result = await tool.execute({}, noSignal);
  assert.equal(result.isError, false);
  assert.equal(result.content[0]?.type, "text");
  assert.match(text(result), /screenshot captured: 4 bytes/);
  assert.match(text(result), /data:image\/png;base64,/);
  const details = result.details as Record<string, unknown> | undefined;
  assert.equal(details?.bytes, 4);
});

test("browser_screenshot saves to disk when directory is set", async (context) => {
  const dir = await workspace(context);
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const session = fakeSession({ screenshot: async () => pngBytes });
  let openedPath: string | undefined;
  const tool = makeBrowserScreenshotTool({
    session,
    screenshotDirectory: dir,
    onScreenshotSaved: (path) => {
      openedPath = path;
    },
  });

  const result = await tool.execute({}, noSignal);
  assert.equal(result.isError, false);
  assert.match(text(result), /screenshot saved:/);
  // No base64 in the result when saved to disk
  assert.equal(text(result).includes("base64"), false);
  assert.ok(openedPath !== undefined);
  const saved = await readFile(openedPath as string);
  assert.deepEqual(saved, pngBytes);
});

test("browser_screenshot rejects unknown fields", async () => {
  const tool = makeBrowserScreenshotTool({ session: fakeSession() });
  await assert.rejects(tool.execute({ format: "jpeg" }, noSignal), ToolInputError);
});

test("browser_click by selector returns page state", async () => {
  let clickedSelector: string | undefined;
  const session = fakeSession({
    click: async (selector) => {
      clickedSelector = selector;
      return fakePage({ excerpt: "Clicked" });
    },
  });
  const tool = makeBrowserClickTool({ session });

  const result = await tool.execute({ selector: "#submit" }, noSignal);
  assert.equal(result.isError, false);
  assert.match(text(result), /Clicked/);
  assert.equal(clickedSelector, "#submit");
});

test("browser_click by coordinates returns page state", async () => {
  let clickedCoords: { x: number; y: number } | undefined;
  const session = fakeSession({
    clickCoordinates: async (x, y) => {
      clickedCoords = { x, y };
      return fakePage({ excerpt: "Coord click" });
    },
  });
  const tool = makeBrowserClickTool({ session });

  const result = await tool.execute({ x: 100, y: 200 }, noSignal);
  assert.equal(result.isError, false);
  assert.match(text(result), /Coord click/);
  assert.deepEqual(clickedCoords, { x: 100, y: 200 });
});

test("browser_click rejects both selector and coordinates", async () => {
  const tool = makeBrowserClickTool({ session: fakeSession() });
  await assert.rejects(
    tool.execute({ selector: "#btn", x: 10, y: 20 }, noSignal),
    /selector or coordinates, not both/,
  );
});

test("browser_click rejects neither selector nor coordinates", async () => {
  const tool = makeBrowserClickTool({ session: fakeSession() });
  await assert.rejects(tool.execute({}, noSignal), /selector or both x and y/);
});

test("browser_click rejects partial coordinates", async () => {
  const tool = makeBrowserClickTool({ session: fakeSession() });
  await assert.rejects(tool.execute({ x: 10 }, noSignal), /selector or both x and y/);
  await assert.rejects(tool.execute({ y: 20 }, noSignal), /selector or both x and y/);
});

test("browser_type validates required fields and types text", async () => {
  let typed: { selector: string; text: string } | undefined;
  const session = fakeSession({
    type: async (selector, text) => {
      typed = { selector, text };
      return fakePage({ excerpt: "Typed" });
    },
  });
  const tool = makeBrowserTypeTool({ session });

  const result = await tool.execute({ selector: "#input", text: "hello" }, noSignal);
  assert.equal(result.isError, false);
  assert.match(text(result), /Typed/);
  assert.deepEqual(typed, { selector: "#input", text: "hello" });
});

test("browser_type rejects missing fields", async () => {
  const tool = makeBrowserTypeTool({ session: fakeSession() });
  await assert.rejects(tool.execute({ selector: "#input" }, noSignal), ToolInputError);
  await assert.rejects(tool.execute({ text: "hello" }, noSignal), ToolInputError);
  await assert.rejects(tool.execute({}, noSignal), ToolInputError);
});

test("browser_scroll validates direction and scrolls", async () => {
  let scrolled: { direction: string; amount: number } | undefined;
  const session = fakeSession({
    scroll: async (direction, amount) => {
      scrolled = { direction, amount };
      return fakePage({ excerpt: "Scrolled" });
    },
  });
  const tool = makeBrowserScrollTool({ session });

  const result = await tool.execute({ direction: "down" }, noSignal);
  assert.equal(result.isError, false);
  assert.match(text(result), /Scrolled/);
  assert.deepEqual(scrolled, { direction: "down", amount: 600 });
});

test("browser_scroll uses custom amount", async () => {
  let scrolled: { direction: string; amount: number } | undefined;
  const session = fakeSession({
    scroll: async (direction, amount) => {
      scrolled = { direction, amount };
      return fakePage();
    },
  });
  const tool = makeBrowserScrollTool({ session });

  await tool.execute({ direction: "up", amount: 300 }, noSignal);
  assert.deepEqual(scrolled, { direction: "up", amount: 300 });
});

test("browser_scroll rejects invalid direction", async () => {
  const tool = makeBrowserScrollTool({ session: fakeSession() });
  await assert.rejects(tool.execute({ direction: "left" }, noSignal), /up or down/);
});

test("browser_read returns page text with truncation", async () => {
  const longText = "a".repeat(50_000);
  const session = fakeSession({ readPage: async () => longText });
  const tool = makeBrowserReadTool({ session });

  const full = await tool.execute({}, noSignal);
  assert.equal(full.isError, false);
  assert.match(text(full), /truncated at 40000 characters/);

  const custom = await tool.execute({ maxCharacters: 10 }, noSignal);
  assert.match(text(custom), /truncated at 10 characters/);
});

test("browser_read passes selector to session", async () => {
  let readSelector: string | undefined;
  const session = fakeSession({
    readPage: async (selector) => {
      readSelector = selector ?? "none";
      return "content";
    },
  });
  const tool = makeBrowserReadTool({ session });

  await tool.execute({ selector: "#main" }, noSignal);
  assert.equal(readSelector, "#main");
});

test("browser_read without selector reads full page", async () => {
  let readSelector: string | undefined;
  const session = fakeSession({
    readPage: async (selector) => {
      readSelector = selector;
      return "full page";
    },
  });
  const tool = makeBrowserReadTool({ session });

  await tool.execute({}, noSignal);
  assert.equal(readSelector, undefined);
});

test("browser_back returns updated page state", async () => {
  let called = false;
  const session = fakeSession({
    back: async () => {
      called = true;
      return fakePage({ excerpt: "Went back" });
    },
  });
  const result = await makeBrowserBackTool({ session }).execute({}, noSignal);
  assert.equal(result.isError, false);
  assert.match(text(result), /Went back/);
  assert.equal(called, true);
});

test("browser_back rejects unknown fields", async () => {
  await assert.rejects(
    makeBrowserBackTool({ session: fakeSession() }).execute({ steps: 2 }, noSignal),
    ToolInputError,
  );
});

test("browser_forward returns updated page state", async () => {
  const session = fakeSession({ forward: async () => fakePage({ excerpt: "Went forward" }) });
  const result = await makeBrowserForwardTool({ session }).execute({}, noSignal);
  assert.match(text(result), /Went forward/);
});

test("browser_wait validates selector and waits", async () => {
  let waited: { selector: string; timeoutMs: number } | undefined;
  const session = fakeSession({
    waitForSelector: async (selector, timeoutMs) => {
      waited = { selector, timeoutMs };
      return fakePage({ excerpt: "Appeared" });
    },
  });
  const tool = makeBrowserWaitTool({ session });
  const result = await tool.execute({ selector: "#loaded" }, noSignal);
  assert.match(text(result), /Appeared/);
  assert.deepEqual(waited, { selector: "#loaded", timeoutMs: 10_000 });
});

test("browser_wait clamps timeout and honors custom value", async () => {
  let timeout: number | undefined;
  const session = fakeSession({
    waitForSelector: async (_s, timeoutMs) => {
      timeout = timeoutMs;
      return fakePage();
    },
  });
  const tool = makeBrowserWaitTool({ session });
  await tool.execute({ selector: "#x", timeoutMs: 3000 }, noSignal);
  assert.equal(timeout, 3000);
  await tool.execute({ selector: "#x", timeoutMs: 999_999 }, noSignal);
  assert.equal(timeout, 30_000);
});

test("browser_wait rejects missing selector", async () => {
  await assert.rejects(
    makeBrowserWaitTool({ session: fakeSession() }).execute({}, noSignal),
    ToolInputError,
  );
});

test("browser_eval returns serialized result", async () => {
  const session = fakeSession({ evaluate: async () => ({ count: 42, items: ["a", "b"] }) });
  const result = await makeBrowserEvalTool({ session }).execute(
    { expression: "({count: 42})" },
    noSignal,
  );
  assert.equal(result.isError, false);
  assert.match(text(result), /"count": 42/);
  assert.match(text(result), /browser eval result/);
});

test("browser_eval handles undefined result", async () => {
  const session = fakeSession({ evaluate: async () => undefined });
  const result = await makeBrowserEvalTool({ session }).execute({ expression: "void 0" }, noSignal);
  assert.match(text(result), /undefined/);
});

test("browser_eval rejects missing expression", async () => {
  await assert.rejects(
    makeBrowserEvalTool({ session: fakeSession() }).execute({}, noSignal),
    ToolInputError,
  );
});

test("browser_select validates fields and selects", async () => {
  let selected: { selector: string; value: string } | undefined;
  const session = fakeSession({
    selectOption: async (selector, value) => {
      selected = { selector, value };
      return fakePage({ excerpt: "Selected" });
    },
  });
  const tool = makeBrowserSelectTool({ session });
  const result = await tool.execute({ selector: "#country", value: "US" }, noSignal);
  assert.match(text(result), /Selected/);
  assert.deepEqual(selected, { selector: "#country", value: "US" });
});

test("browser_select rejects missing fields", async () => {
  const tool = makeBrowserSelectTool({ session: fakeSession() });
  await assert.rejects(tool.execute({ selector: "#x" }, noSignal), ToolInputError);
  await assert.rejects(tool.execute({ value: "y" }, noSignal), ToolInputError);
});

test("makeBrowserTools creates all eleven tools", () => {
  const tools = makeBrowserTools({ session: fakeSession() });
  assert.equal(tools.length, 11);
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, [
    "browser_navigate",
    "browser_screenshot",
    "browser_click",
    "browser_type",
    "browser_scroll",
    "browser_read",
    "browser_back",
    "browser_forward",
    "browser_wait",
    "browser_eval",
    "browser_select",
  ]);
});

test("all browser tools reject unknown input fields", async () => {
  const tools = makeBrowserTools({ session: fakeSession() });
  for (const tool of tools) {
    await assert.rejects(
      tool.execute({ __injected: "bad" } as JsonObject, noSignal),
      ToolInputError,
      `${tool.name} should reject unknown fields`,
    );
  }
});
