// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { PLAIN_PALETTE, renderInline, renderMarkdown, visibleWidth } from "../src/index.ts";

test("plain paragraphs pass through untouched", () => {
  assert.deepEqual(renderMarkdown("just a sentence.", 80, PLAIN_PALETTE), ["just a sentence."]);
});

test("headings, lists, and quotes get terminal styling", () => {
  const lines = renderMarkdown("# Title\n- item one\n> quoted", 80, PLAIN_PALETTE);
  assert.equal(lines[0]?.includes("Title"), true);
  assert.equal(lines[0]?.includes("\x1b[1m"), true); // bold heading
  assert.equal(lines[1], "• item one");
  assert.equal(lines[2], "▌ quoted");
});

test("fenced code blocks are preserved verbatim behind a gutter", () => {
  const lines = renderMarkdown("```ts\nconst a = 1;\n```", 80, PLAIN_PALETTE);
  assert.deepEqual(lines, ["╭─ ts", "│ const a = 1;", "╰─"]);
  // A dangling fence still closes.
  const dangling = renderMarkdown("```\ncode", 80, PLAIN_PALETTE);
  assert.equal(dangling[dangling.length - 1], "╰─");
});

test("plain-text and Mermaid diagrams avoid code-block rails", () => {
  const diagram = renderMarkdown("```text\nA long diagram label --> B\n```", 12, PLAIN_PALETTE);
  assert.equal(
    diagram.some((line) => line.includes("│") || line.includes("╭─ text")),
    false,
  );
  assert.equal(
    diagram.every((line) => visibleWidth(line) <= 12),
    true,
  );
  assert.equal(diagram.join("").includes("diagram label"), true);

  const mermaid = renderMarkdown("```mermaid\ngraph TD\nA-->B\n```", 40, PLAIN_PALETTE);
  assert.equal(
    mermaid.some((line) => line.includes("Mermaid source")),
    false,
  );
  assert.equal(
    mermaid.some((line) => line.includes("┌") || line.includes("╭")),
    true,
  );
  assert.equal(
    mermaid.some((line) => line.includes("A")),
    true,
  );
  assert.equal(
    mermaid.some((line) => line.includes("B")),
    true,
  );

  const narrow = renderMarkdown("```mermaid\ngraph TD\nA-->B\n```", 4, PLAIN_PALETTE);
  assert.equal(narrow.join("").includes("graph TD"), true);

  const sequence = renderMarkdown(
    [
      "```mermaid",
      "sequenceDiagram",
      "actor U as User",
      "participant C as TUI client",
      "participant D as Daemon",
      "participant K as Kernel",
      "participant L as JSONL log",
      "participant A as AI provider adapter",
      "participant S as Sandbox / tools",
      "U->>C: Submit prompt",
      "K->>L: Append user/configuration events",
      "K->>A: Canonical model request",
      "A-->>K: Canonical stream events",
      "K->>S: Validate and execute",
      "S-->>K: Bounded result",
      "C-->>U: Render transcript and status",
      "```",
    ].join("\n"),
    100,
    PLAIN_PALETTE,
  );
  assert.equal(
    sequence.some((line) => line.includes("Mermaid source")),
    false,
  );
  assert.equal(
    sequence.some((line) => line.includes("Legend")),
    true,
  );
  assert.equal(
    sequence.every((line) => visibleWidth(line) <= 100),
    true,
  );
});

test("inline code, bold, and italic render as spans", () => {
  assert.equal(renderInline("run `ls` now", PLAIN_PALETTE), "run ls now");
  assert.equal(renderInline("**bold** words", PLAIN_PALETTE), "\x1b[1mbold\x1b[22m words");
  assert.equal(renderInline("*soft* words", PLAIN_PALETTE), "\x1b[3msoft\x1b[23m words");
});

test("web links are clickable, visible, and restricted to safe schemes", () => {
  const safe = renderInline("read [the guide](https://example.com/docs)", PLAIN_PALETTE);
  assert.equal(
    safe.includes("\x1b]8;;https://example.com/docs\x1b\\the guide\x1b]8;;\x1b\\"),
    true,
  );
  assert.match(safe, /https:\/\/example\.com\/docs/);
  assert.equal(
    renderInline("[run](javascript:alert(1))", PLAIN_PALETTE).includes("\x1b]8;;"),
    false,
  );
});

test("renders nested task lists, strikethrough, rules, and GFM tables", () => {
  const markdown = [
    "- [x] shipped",
    "  - [ ] follow up",
    "",
    "~~obsolete~~",
    "",
    "---",
    "",
    "| Name | State |",
    "| --- | --- |",
    "| TUI | ready |",
  ].join("\n");
  const lines = renderMarkdown(markdown, 40, PLAIN_PALETTE);
  assert.equal(
    lines.some((line) => line.includes("☑ shipped")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("☐ follow up")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("\x1b[9mobsolete\x1b[29m")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Name") && line.includes("State")),
    true,
  );
  assert.equal(
    lines.every((line) => visibleWidth(line) <= 40),
    true,
  );
});

test("long markdown lines hard-wrap to the viewport", () => {
  const lines = renderMarkdown("x".repeat(25), 10, PLAIN_PALETTE);
  assert.equal(lines.length, 3);
});

test("code fences syntax-highlight known languages", async () => {
  const { highlightLine, THEMES } = await import("../src/index.ts");
  const palette = THEMES.axl as NonNullable<(typeof THEMES)["axl"]>;
  const highlighted = highlightLine('const x = "hi"; // done', "ts", palette);
  assert.equal(highlighted.includes("const"), true);
  assert.notEqual(highlighted, 'const x = "hi"; // done'); // styling applied
  // Unknown languages pass through untouched.
  assert.equal(highlightLine("whatever ???", "brainfuck", palette), "whatever ???");
});

test("themes exist and provide full palettes", async () => {
  const { THEMES, THEME_DEFINITIONS, themeNames, DEFAULT_THEME } = await import("../src/index.ts");
  assert.equal(DEFAULT_THEME, "axl-dark");
  assert.equal(themeNames().includes(DEFAULT_THEME), true);
  assert.equal(themeNames().length >= 4, true);
  assert.deepEqual(
    THEME_DEFINITIONS.filter((theme) =>
      ["dark", "light", "system", "accessible", "plain"].includes(theme.appearance),
    ).map((theme) => theme.version),
    Array(THEME_DEFINITIONS.length).fill(1),
  );
  const gruvbox = THEMES[DEFAULT_THEME] as NonNullable<(typeof THEMES)[string]>;
  assert.match(gruvbox.accent("x"), /38;2;254;128;25m/);
  assert.match(gruvbox.thinking?.("xhigh", "x") ?? "", /38;2;251;73;52m/);
  for (const name of themeNames()) {
    const palette = THEMES[name] as NonNullable<(typeof THEMES)[string]>;
    assert.equal(typeof palette.dim("x"), "string");
    assert.equal(typeof palette.accent("x"), "string");
    assert.equal(typeof palette.error("x"), "string");
  }
});
