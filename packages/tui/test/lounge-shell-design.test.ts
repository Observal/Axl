// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { PLAIN_PALETTE, stripAnsi, THEME_DEFINITIONS, visibleWidth } from "../src/index.ts";
import type { Palette } from "../src/transcript.ts";

type Style = "text" | "muted" | "accent" | "success" | "warning" | "error" | "selection";
type Layout = "unsupported" | "compact" | "standard" | "wide";

interface Span {
  readonly text: string;
  readonly style: Style;
}

interface PrototypeFrame {
  readonly layout: Layout;
  readonly lines: readonly (readonly Span[])[];
  readonly activityWidth: number;
  readonly monitorWidth: number;
  readonly boardRow: number;
}

function layoutFor(width: number, height: number): Layout {
  if (width < 40 || height < 12) return "unsupported";
  if (width < 60 || height < 18) return "compact";
  if (width < 100) return "standard";
  return "wide";
}

function line(text: string, style: Style = "text"): readonly Span[] {
  return [{ text, style }];
}

function fit(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

/** Test-only shell prototype. Production rendering begins after design approval. */
function prototypeFrame(
  width: number,
  height: number,
  status = "Axl ◐ bash · pnpm test · 00:42",
): PrototypeFrame {
  const layout = layoutFor(width, height);
  if (layout === "unsupported") {
    return {
      layout,
      lines: [
        line(fit("Axl Lounge · terminal too small", width), "warning"),
        line(fit(`Need 40×12 · current ${width}×${height}`, width), "text"),
        line(fit("Axl status remains visible", width), "muted"),
        line(fit("Esc return", width), "accent"),
      ],
      activityWidth: width,
      monitorWidth: width,
      boardRow: -1,
    };
  }

  const activityWidth =
    layout === "wide" ? Math.max(40, Math.min(64, Math.round(width * 0.45))) : width - 2;
  const monitorWidth = layout === "wide" ? width - activityWidth - 3 : width - 2;
  const title = fit("Wordle", activityWidth);
  const board = fit("          [C] [O] [D] [E] [ ]", activityWidth);
  const keyboard = fit("       Q W E R T Y U I O P", activityWidth);
  const footer = fit("Esc return · ? help · Tab work", width);

  if (layout === "wide") {
    const rail = fit("Axl is working", monitorWidth);
    const railStatus = fit(status, monitorWidth);
    return {
      layout,
      lines: [
        [...line(rail, "accent"), ...line(" │ ", "muted"), ...line(title, "accent")],
        [
          ...line(railStatus, "text"),
          ...line(" │ ", "muted"),
          ...line(fit("Daily · Normal", activityWidth), "muted"),
        ],
        [
          ...line(fit("Recent: ✓ read parser.ts", monitorWidth), "success"),
          ...line(" │ ", "muted"),
          ...line(fit("", activityWidth)),
        ],
        [
          ...line(fit("Observed edits: 2", monitorWidth), "muted"),
          ...line(" │ ", "muted"),
          ...line(board, "selection"),
        ],
        [
          ...line(fit("1 follow-up queued", monitorWidth), "warning"),
          ...line(" │ ", "muted"),
          ...line(keyboard, "text"),
        ],
        line(footer, "muted"),
      ],
      activityWidth,
      monitorWidth,
      boardRow: 3,
    };
  }

  return {
    layout,
    lines: [
      line(fit(title, width), "accent"),
      line(fit("Daily · Normal", width), "muted"),
      line(fit("", width)),
      line(fit(board, width), "selection"),
      line(fit(keyboard, width), "text"),
      line(fit(status, width), "muted"),
      line(footer, "muted"),
    ],
    activityWidth,
    monitorWidth,
    boardRow: 3,
  };
}

function styleSpan(span: Span, palette: Palette): string {
  switch (span.style) {
    case "muted":
      return palette.dim(span.text);
    case "accent":
      return palette.accent(span.text);
    case "success":
      return (palette.success ?? palette.accent)(span.text);
    case "warning":
      return (palette.warning ?? palette.accent)(span.text);
    case "error":
      return palette.error(span.text);
    case "selection":
      return (palette.selection ?? palette.bold ?? palette.accent)(span.text);
    case "text":
      return (palette.text ?? ((value: string) => value))(span.text);
  }
}

function render(frame: PrototypeFrame, palette: Palette): readonly string[] {
  return frame.lines.map((row) => row.map((span) => styleSpan(span, palette)).join(""));
}

test("prototype selects the fixed responsive breakpoints", () => {
  assert.equal(layoutFor(39, 30), "unsupported");
  assert.equal(layoutFor(40, 11), "unsupported");
  assert.equal(layoutFor(40, 18), "compact");
  assert.equal(layoutFor(80, 24), "standard");
  assert.equal(layoutFor(120, 30), "wide");
});

test("40, 80, and 120 column prototypes stay bounded", () => {
  for (const [width, height] of [
    [40, 18],
    [80, 24],
    [120, 30],
  ] as const) {
    const frame = prototypeFrame(width, height);
    const rows = render(frame, PLAIN_PALETTE);
    assert.ok(rows.length <= height);
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
  }
});

test("wide allocation reserves a transcript pane before the game viewport", () => {
  assert.deepEqual(
    [100, 120, 160].map((width) => {
      const frame = prototypeFrame(width, 30);
      return [frame.activityWidth, frame.monitorWidth];
    }),
    [
      [45, 52],
      [54, 63],
      [64, 93],
    ],
  );
});

test("monitor updates do not move the board", () => {
  for (const [width, height] of [
    [40, 18],
    [80, 24],
    [120, 30],
  ] as const) {
    const before = prototypeFrame(width, height, "Axl ◐ bash · pnpm test · 00:42");
    const after = prototypeFrame(width, height, "Axl ✓ read · src/parser.ts · 00:43");
    assert.equal(before.boardRow, after.boardRow);
    const beforeRow = stripAnsi(render(before, PLAIN_PALETTE)[before.boardRow] ?? "");
    const afterRow = stripAnsi(render(after, PLAIN_PALETTE)[after.boardRow] ?? "");
    assert.equal(
      before.layout === "wide" ? beforeRow.split(" │ ")[1] : beforeRow,
      after.layout === "wide" ? afterRow.split(" │ ")[1] : afterRow,
    );
  }
});

test("dark, light, system, high-contrast, monochrome, and custom themes preserve semantics", () => {
  assert.deepEqual(
    THEME_DEFINITIONS.filter(({ id }) =>
      ["axl-dark", "axl-light", "system", "high-contrast", "plain"].includes(id),
    ).map(({ id }) => id),
    ["axl-dark", "axl-light", "system", "high-contrast", "plain"],
  );
  const frame = prototypeFrame(120, 30);
  const expected = render(frame, PLAIN_PALETTE).map(stripAnsi);
  for (const theme of THEME_DEFINITIONS) {
    assert.deepEqual(render(frame, theme.palette).map(stripAnsi), expected, theme.id);
  }
});

test("optional custom-theme roles have deterministic fallbacks", () => {
  const minimal: Palette = {
    dim: (text) => `<muted>${text}</muted>`,
    accent: (text) => `<accent>${text}</accent>`,
    error: (text) => `<error>${text}</error>`,
  };
  const rendered = render(
    {
      layout: "compact",
      lines: [
        [
          { text: "ok", style: "success" },
          { text: " wait", style: "warning" },
          { text: " selected", style: "selection" },
        ],
      ],
      activityWidth: 38,
      monitorWidth: 38,
      boardRow: 0,
    },
    minimal,
  );
  assert.deepEqual(rendered, [
    "<accent>ok</accent><accent> wait</accent><accent> selected</accent>",
  ]);
});
