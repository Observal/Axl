// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os";

import type {
  OwnedTerminalToolRenderer,
  TerminalLine,
  TerminalTone,
  TerminalToolRenderResult,
} from "@axl/extension-api";

import { highlightCode, languageForPath } from "./highlight.ts";
import { sanitizeTerminalText, truncateToWidth, visibleWidth, wrapLine } from "./render.ts";
import type { Palette, ToolOutputDisplay } from "./transcript.ts";

const HIDDEN_RESULT_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write", "skill"]);
const COMPACT_PREVIEW_LINES = 6;
const BASH_PREVIEW_LINES = 6;
const FULL_RESULT_LINES = 200;
const FULL_RESULT_CHARS = 65_536;
const DIFF_PREVIEW_LINES = FULL_RESULT_LINES;
const SPLIT_DIFF_MIN_WIDTH = 120;
const COMPACT_EXTENSION_LINES = 12;
const FULL_EXTENSION_LINES = 200;
const MAX_EXTENSION_LINE_CHARS = 16_384;
const MAX_TOOL_INPUT_CHARS = 8_192;
const INPUT_PREVIEW_ROWS = 8;
const FULL_INPUT_PREVIEW_ROWS = 40;

function previewText(text: string, limit: number): string {
  const safe = sanitizeTerminalText(text);
  if (safe.length <= limit) return safe;
  const half = Math.floor(limit / 2);
  return `${safe.slice(0, half)}\n…\n${safe.slice(-half)}`;
}

function inputPreview(
  text: string,
  width: number,
  mode: ToolOutputDisplay,
  palette: Palette,
): string[] {
  const limit = mode === "full" ? FULL_INPUT_PREVIEW_ROWS : INPUT_PREVIEW_ROWS;
  const preview = previewText(text, mode === "full" ? MAX_TOOL_INPUT_CHARS : 1_024);
  const rows = preview.split("\n").flatMap((line) => wrapLine(line, width));
  return [
    ...clipRows(rows, limit, palette, "input rows hidden").map(palette.dim),
    ...wrapLine(
      palette.dim(
        `Input preview · ~${text.length.toLocaleString("en-US")} chars · ${mode === "full" ? "/export for complete input" : "Ctrl+O to expand"}`,
      ),
      width,
    ),
  ];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function field(input: Record<string, unknown>, name: string): string | undefined {
  return typeof input[name] === "string" ? sanitizeTerminalText(input[name]) : undefined;
}

function pathLabel(input: Record<string, unknown>): string {
  const path = field(input, "path") ?? field(input, "cwd") ?? ".";
  const home = homedir();
  return path === home
    ? "~"
    : path.startsWith(`${home}/`)
      ? `~/${path.slice(home.length + 1)}`
      : path;
}

function clipRows(
  lines: readonly string[],
  limit: number,
  palette: Palette,
  hint = "lines hidden · Ctrl+O to expand",
): string[] {
  if (lines.length <= limit) return [...lines];
  const head = Math.ceil((limit - 1) / 2);
  const tail = Math.floor((limit - 1) / 2);
  return [
    ...lines.slice(0, head),
    palette.dim(`  … ${lines.length - head - tail} ${hint}`),
    ...lines.slice(-tail),
  ];
}

function paint(palette: Palette, kind: DiffKind, value: string): string {
  if (kind === "add") return (palette.diffAdded ?? palette.success ?? palette.accent)(value);
  if (kind === "remove") return (palette.diffRemoved ?? palette.error)(value);
  return (palette.diffContext ?? palette.dim)(value);
}

function lineBackground(palette: Palette, kind: DiffKind, value: string): string {
  if (kind === "add") return (palette.diffAddedBackground ?? ((text) => text))(value);
  if (kind === "remove") return (palette.diffRemovedBackground ?? ((text) => text))(value);
  return value;
}

function fit(value: string, width: number): string {
  const clipped = truncateToWidth(value, width, "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function toolSurface(lines: readonly string[], width: number, palette: Palette): string[] {
  if (width < 6) return lines.flatMap((line) => wrapLine(line, Math.max(1, width)));
  const border = palette.border ?? palette.dim;
  const inner = width - 6;
  const body = lines
    .flatMap((line) => wrapLine(line, inner))
    .map((line) => {
      const content = ` ${fit(line, inner)} `;
      const surface = palette.toolBackground?.(content) ?? content;
      return `  ${border("│")}${surface}${border("│")}`;
    });
  return [
    "",
    `  ${border(`╭${"─".repeat(width - 4)}╮`)}`,
    ...body,
    `  ${border(`╰${"─".repeat(width - 4)}╯`)}`,
  ];
}

type DiffKind = "add" | "remove" | "context";

interface DiffRow {
  readonly kind: DiffKind;
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

interface ChangedLines {
  readonly rows: readonly DiffRow[];
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly removed: number;
  readonly added: number;
}

/** Builds the smallest useful hunk around an exact-text replacement. */
function changedLines(oldText: string, newText: string): ChangedLines {
  const sanitizedOld = sanitizeTerminalText(oldText);
  const sanitizedNew = sanitizeTerminalText(newText);
  const oldLines = sanitizedOld ? sanitizedOld.split("\n") : [];
  const newLines = sanitizedNew ? sanitizedNew.split("\n") : [];
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const oldEnd = oldLines.length - suffix;
  const newEnd = newLines.length - suffix;
  const rows: DiffRow[] = [];
  for (let index = Math.max(0, prefix - 2); index < prefix; index += 1) {
    rows.push({
      kind: "context",
      text: oldLines[index] as string,
      oldLine: index + 1,
      newLine: index + 1,
    });
  }
  for (let index = prefix; index < oldEnd; index += 1) {
    rows.push({ kind: "remove", text: oldLines[index] as string, oldLine: index + 1 });
  }
  for (let index = prefix; index < newEnd; index += 1) {
    rows.push({ kind: "add", text: newLines[index] as string, newLine: index + 1 });
  }
  for (let offset = 0; offset < Math.min(2, suffix); offset += 1) {
    rows.push({
      kind: "context",
      text: oldLines[oldEnd + offset] as string,
      oldLine: oldEnd + offset + 1,
      newLine: newEnd + offset + 1,
    });
  }
  return { rows, oldLines, newLines, removed: oldEnd - prefix, added: newEnd - prefix };
}

function diffSummary(
  change: ChangedLines,
  mode: "unified" | "split",
  width: number,
  palette: Palette,
): string[] {
  const total = Math.max(1, change.added + change.removed);
  const slots = Math.min(12, total);
  const addedSlots = Math.round((change.added / total) * slots);
  const removedSlots = slots - addedSlots;
  const bar = `${paint(palette, "add", "━".repeat(addedSlots))}${paint(
    palette,
    "remove",
    "━".repeat(removedSlots),
  )}`;
  const label = `${palette.dim("↳ diff ")}${paint(palette, "add", `+${change.added}`)} ${paint(
    palette,
    "remove",
    `-${change.removed}`,
  )}${palette.dim(` ${mode} [`)}${bar}${palette.dim("]")}`;
  return [truncateToWidth(label, width, ""), (palette.border ?? palette.dim)("─".repeat(width))];
}

function rowLineNumber(row: DiffRow): number | undefined {
  return row.kind === "add" ? row.newLine : row.oldLine;
}

function unifiedDiff(
  change: ChangedLines,
  path: string,
  width: number,
  palette: Palette,
): string[] {
  const numberWidth = Math.max(
    1,
    ...change.rows.map((row) => String(rowLineNumber(row) ?? "").length),
  );
  const language = languageForPath(path);
  const oldLines = highlightCode(change.oldLines.join("\n"), language, palette);
  const newLines = highlightCode(change.newLines.join("\n"), language, palette);
  const rendered = change.rows.flatMap((row) => {
    const number = String(rowLineNumber(row) ?? "").padStart(numberWidth);
    const marker = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
    const gutter = `  ${number} ${marker}│ `;
    const available = Math.max(1, width - visibleWidth(gutter));
    const highlighted =
      row.kind === "add" ? newLines[(row.newLine ?? 1) - 1] : oldLines[(row.oldLine ?? 1) - 1];
    return wrapLine(highlighted || " ", available).map((part, index) => {
      const prefix =
        index === 0
          ? `${paint(palette, row.kind, `  ${number} ${marker}│`)} `
          : `${paint(palette, row.kind, `  ${"".padStart(numberWidth)}  │`)} `;
      const line = fit(`${prefix}${part}`, width);
      return lineBackground(palette, row.kind, line);
    });
  });
  return [
    ...diffSummary(change, "unified", width, palette),
    ...clipRows(
      rendered,
      DIFF_PREVIEW_LINES,
      palette,
      "diff rows hidden · /export for complete input",
    ),
  ];
}

function splitPairs(rows: readonly DiffRow[]): Array<{ left?: DiffRow; right?: DiffRow }> {
  const pairs: Array<{ left?: DiffRow; right?: DiffRow }> = [];
  for (let index = 0; index < rows.length; ) {
    const row = rows[index] as DiffRow;
    if (row.kind === "context") {
      pairs.push({ left: row, right: row });
      index += 1;
      continue;
    }
    const removed: DiffRow[] = [];
    const added: DiffRow[] = [];
    while (rows[index]?.kind === "remove") removed.push(rows[index++] as DiffRow);
    while (rows[index]?.kind === "add") added.push(rows[index++] as DiffRow);
    for (let pair = 0; pair < Math.max(removed.length, added.length); pair += 1) {
      pairs.push({
        ...(removed[pair] === undefined ? {} : { left: removed[pair] }),
        ...(added[pair] === undefined ? {} : { right: added[pair] }),
      });
    }
  }
  return pairs;
}

function splitCell(
  row: DiffRow | undefined,
  side: "left" | "right",
  width: number,
  numberWidth: number,
  highlightedLines: readonly string[],
  palette: Palette,
): string[] {
  if (row === undefined) return [" ".repeat(width)];
  const value = side === "left" ? row.oldLine : row.newLine;
  const number = String(value ?? "").padStart(numberWidth);
  const marker = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
  const gutter = `${number} ${marker}│ `;
  const available = Math.max(1, width - visibleWidth(gutter));
  const highlighted = highlightedLines[(value ?? 1) - 1];
  return wrapLine(highlighted || " ", available).map((part, index) => {
    const prefix =
      index === 0
        ? `${paint(palette, row.kind, `${number} ${marker}│`)} `
        : `${paint(palette, row.kind, `${"".padStart(numberWidth)}  │`)} `;
    const line = fit(`${prefix}${part}`, width);
    return lineBackground(palette, row.kind, line);
  });
}

function splitDiff(change: ChangedLines, path: string, width: number, palette: Palette): string[] {
  const separator = palette.dim(" │ ");
  const column = Math.max(8, Math.floor((width - 3) / 2));
  const numberWidth = Math.max(
    1,
    ...change.rows.map((row) => String(rowLineNumber(row) ?? "").length),
  );
  const language = languageForPath(path);
  const oldLines = highlightCode(change.oldLines.join("\n"), language, palette);
  const newLines = highlightCode(change.newLines.join("\n"), language, palette);
  const header = `${fit(palette.dim("old"), column)}${separator}${fit(palette.dim("new"), column)}`;
  const rendered = splitPairs(change.rows).flatMap((pair) => {
    const left = splitCell(pair.left, "left", column, numberWidth, oldLines, palette);
    const right = splitCell(pair.right, "right", column, numberWidth, newLines, palette);
    return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
      const leftLine = left[index] ?? " ".repeat(column);
      const rightLine = right[index] ?? " ".repeat(column);
      return `${leftLine}${separator}${rightLine}`;
    });
  });
  return [
    ...diffSummary(change, "split", width, palette),
    header,
    ...clipRows(
      rendered,
      DIFF_PREVIEW_LINES,
      palette,
      "diff rows hidden · /export for complete input",
    ),
  ];
}

function editPreview(input: Record<string, unknown>, width: number, palette: Palette): string[] {
  const oldText = field(input, "oldText");
  const newText = field(input, "newText") ?? field(input, "content");
  if (oldText === undefined && newText === undefined) return [];
  const path = pathLabel(input);
  const change = changedLines(oldText ?? "", newText ?? "");
  if (width >= SPLIT_DIFF_MIN_WIDTH) return splitDiff(change, path, width, palette);
  return unifiedDiff(change, path, width, palette);
}

function title(palette: Palette, value: string): string {
  return (palette.bold ?? palette.accent)(value);
}

export type ToolTransactionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "aborted";

function transactionColor(
  status: ToolTransactionStatus,
  palette: Palette,
): (text: string) => string {
  if (status === "pending") return palette.dim;
  if (status === "running" || status === "denied") return palette.warning ?? palette.accent;
  if (status === "succeeded") return palette.success ?? palette.accent;
  return palette.error;
}

function transactionBackground(
  status: ToolTransactionStatus,
  palette: Palette,
): ((text: string) => string) | undefined {
  if (status === "pending" || status === "running" || status === "succeeded")
    return palette.toolBackground;
  if (status === "denied") return palette.toolDeniedBackground ?? palette.toolBackground;
  return palette.toolErrorBackground ?? palette.toolBackground;
}

function transactionStatus(
  status: ToolTransactionStatus,
  durationMs: number | undefined,
  palette: Palette,
): string {
  const label = status === "succeeded" ? "done" : status;
  const duration =
    durationMs === undefined
      ? ""
      : ` | ${durationMs < 1_000 && status !== "running" ? `${durationMs}ms` : `${(durationMs / 1_000).toFixed(1)}s`}`;
  return `${transactionColor(status, palette)(label)}${palette.dim(duration)}`;
}

function shellCommandPreview(
  command: string,
  width: number,
  mode: ToolOutputDisplay,
  palette: Palette,
): string[] {
  const maxChars = mode === "full" ? MAX_TOOL_INPUT_CHARS : 1_024;
  const maxRows = mode === "full" ? FULL_INPUT_PREVIEW_ROWS : BASH_PREVIEW_LINES;
  const preview = previewText(command, maxChars);
  const gutter = width >= 3 ? 2 : 0;
  const rows = highlightCode(preview, "bash", palette).flatMap((line) =>
    wrapLine(line, Math.max(1, width - gutter)),
  );
  const clipped = rows.length > maxRows || sanitizeTerminalText(command).length > maxChars;
  return [
    ...clipRows(rows, maxRows, palette, "command rows hidden").map(
      (line, index) => `${gutter ? (index === 0 ? palette.dim("$ ") : "  ") : ""}${line}`,
    ),
    ...(clipped
      ? wrapLine(
          palette.dim(
            `Command preview · ~${command.length.toLocaleString("en-US")} chars · ${mode === "full" ? "/export for complete input" : "Ctrl+O to expand"}`,
          ),
          width,
        )
      : []),
  ];
}

function transactionTarget(name: string, input: Record<string, unknown>): string {
  if (name === "shell" || name === "bash") return field(input, "command") ?? "";
  if (name === "read") {
    const offset = typeof input.offset === "number" ? input.offset : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    const range =
      offset === undefined
        ? ""
        : `:${offset}${limit === undefined ? "" : `-${offset + limit - 1}`}`;
    return `${pathLabel(input)}${range}`;
  }
  if (name === "grep") return `/${field(input, "pattern") ?? ""}/ · ${pathLabel(input)}`;
  if (name === "find") return `${field(input, "pattern") ?? ""} · ${pathLabel(input)}`;
  if (name === "mcp") {
    return [field(input, "server"), field(input, "name") ?? field(input, "action")]
      .filter(Boolean)
      .join(" · ");
  }
  if (name === "skill") {
    const action = field(input, "action") ?? "load";
    const target = field(input, "name") ?? field(input, "path") ?? "";
    return `${action}${target ? ` · ${target}` : ""}`;
  }
  if (["edit", "write", "ls"].includes(name)) return pathLabel(input);
  return "";
}

function toneColor(palette: Palette, tone: TerminalTone | undefined): (text: string) => string {
  if (tone === "accent") return palette.accent;
  if (tone === "success") return palette.success ?? palette.accent;
  if (tone === "warning") return palette.warning ?? palette.accent;
  if (tone === "error") return palette.error;
  if (tone === "text") return palette.text ?? ((text) => text);
  return palette.dim;
}

function customBody(
  lines: readonly TerminalLine[],
  mode: ToolOutputDisplay,
  palette: Palette,
): string[] {
  const limit = mode === "full" ? FULL_EXTENSION_LINES : COMPACT_EXTENSION_LINES;
  const render = (line: TerminalLine): string =>
    toneColor(
      palette,
      line.tone,
    )(
      sanitizeTerminalText(line.text.slice(0, MAX_EXTENSION_LINE_CHARS))
        .replace(/\s+/gu, " ")
        .trim(),
    );
  if (lines.length <= limit) return lines.map(render);
  const head = Math.ceil((limit - 1) / 2);
  const tail = Math.floor((limit - 1) / 2);
  return [
    ...lines.slice(0, head).map(render),
    palette.dim(`  … ${lines.length - head - tail} extension rows hidden · Ctrl+O to expand`),
    ...lines.slice(-tail).map(render),
  ];
}

function transactionBody(input: {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result?: string;
  readonly isError?: boolean;
  readonly status: ToolTransactionStatus;
  readonly width: number;
  readonly mode: ToolOutputDisplay;
  readonly palette: Palette;
  readonly oversizedInput?: string;
}): string[] {
  const { name, args, result, isError, status, width, mode, palette } = input;
  const bodyWidth = Math.max(1, width - 2);
  const lines: string[] = [];
  if ((name === "bash" || name === "shell") && typeof args.command === "string") {
    lines.push(...shellCommandPreview(args.command, bodyWidth, mode, palette));
    if (typeof args.timeout === "number") lines.push(palette.dim(`timeout ${args.timeout}s`));
  } else if (input.oversizedInput !== undefined) {
    lines.push(...inputPreview(input.oversizedInput, bodyWidth, mode, palette));
  } else {
    if (name === "edit" || name === "write") lines.push(...editPreview(args, bodyWidth, palette));
    if (mode === "full" && name !== "edit" && name !== "write") {
      lines.push(
        ...sanitizeTerminalText(JSON.stringify(args, null, 2))
          .split("\n")
          .map(palette.dim),
      );
    }
  }
  if (status === "denied" && result === undefined)
    lines.push(palette.error("policy denied this operation"));
  if (result === undefined) return lines;
  if (status === "succeeded" && (name === "edit" || name === "write") && lines.length > 0)
    return lines;
  if (mode === "focus" && status === "succeeded") return lines;

  const hidesSuccessfulBody =
    status === "succeeded" &&
    mode === "compact" &&
    (HIDDEN_RESULT_TOOLS.has(name) || isMcpTool(name));
  if (hidesSuccessfulBody && lines.length > 0) return lines;
  if (hidesSuccessfulBody) return [];
  const resultPreview = previewText(
    result,
    mode === "full" ? FULL_RESULT_CHARS : MAX_TOOL_INPUT_CHARS,
  );
  const resultLines = (
    name === "read"
      ? highlightCode(resultPreview, languageForPath(pathLabel(args)), palette)
      : sanitizeTerminalText(resultPreview).split("\n")
  ).flatMap((line) => wrapLine(line, bodyWidth));
  const limit =
    mode === "full"
      ? FULL_RESULT_LINES
      : name === "shell" || name === "bash"
        ? BASH_PREVIEW_LINES
        : COMPACT_PREVIEW_LINES;
  const color = isError ? palette.error : (palette.text ?? palette.dim);
  lines.push(
    ...(lines.length > 0 ? [""] : []),
    ...clipRows(
      resultLines,
      limit,
      palette,
      mode === "full"
        ? "lines hidden · /export for complete result"
        : "lines hidden · Ctrl+O to expand",
    ).map((line) => (name === "read" && !isError ? line || " " : color(line || " "))),
  );
  return lines;
}

/** Renders one complete call/result transaction with a stable status header. */
export function renderToolTransaction(input: {
  readonly callId?: string;
  readonly name: string;
  readonly args: unknown;
  readonly result?: string;
  readonly isError?: boolean;
  readonly status: ToolTransactionStatus;
  readonly durationMs?: number;
  readonly width: number;
  readonly mode: ToolOutputDisplay;
  readonly palette: Palette;
  readonly renderer?: OwnedTerminalToolRenderer;
}): string[] {
  const args = record(input.args);
  const serialized = JSON.stringify(args, null, 2);
  const inputRows = input.mode === "full" ? FULL_INPUT_PREVIEW_ROWS : INPUT_PREVIEW_ROWS;
  const oversizedInput =
    serialized.length > MAX_TOOL_INPUT_CHARS ||
    (input.name !== "edit" &&
      input.name !== "write" &&
      serialized
        .split("\n")
        .reduce(
          (rows, line) =>
            rows + Math.max(1, Math.ceil(visibleWidth(line) / Math.max(1, input.width - 2))),
          0,
        ) > inputRows)
      ? serialized
      : undefined;
  let custom: TerminalToolRenderResult | undefined;
  let rendererError: string | undefined;
  if (input.renderer !== undefined && oversizedInput === undefined) {
    try {
      custom = input.renderer.renderer({
        callId: input.callId ?? "unknown",
        name: input.name,
        arguments: args,
        ...(input.result === undefined ? {} : { result: input.result }),
        isError: input.isError ?? false,
        status: input.status,
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        detail: input.mode,
      });
    } catch (error) {
      rendererError = sanitizeTerminalText(
        error instanceof Error ? error.message : "unknown renderer failure",
      );
    }
  }
  if (
    input.mode === "focus" &&
    input.status === "succeeded" &&
    (custom?.hideWhenSuccessfulInFocus ??
      ["read", "grep", "find", "ls", "mcp", "skill"].includes(input.name))
  )
    return [];
  const target = previewText(
    custom?.target ??
      (input.name === "bash" || input.name === "shell"
        ? (field(args, "cwd") ?? "")
        : transactionTarget(input.name, args)),
    1_024,
  );
  const status = transactionStatus(input.status, input.durationMs, input.palette);
  const compactTarget = target.replace(/\s+/gu, " ").trim();
  const label = previewText(custom?.label ?? input.name, 256)
    .replace(/\s+/gu, " ")
    .trim()
    .toUpperCase();
  const indent = input.width >= 3 ? "  " : "";
  const surfaceWidth = Math.max(1, input.width - indent.length);
  const operation = `${title(input.palette, label)}${compactTarget ? `  ${input.palette.accent(compactTarget)}` : ""}`;
  const available = surfaceWidth - visibleWidth(status) - 2;
  const header =
    available >= visibleWidth(label)
      ? `${fit(truncateToWidth(operation, available, "…"), available)}  ${status}`
      : truncateToWidth(`${title(input.palette, label)} ${status}`, surfaceWidth, "");
  const surface = transactionBackground(input.status, input.palette);
  const bodyPrefix = indent;
  const bodyWidth = Math.max(1, input.width - bodyPrefix.length);
  const renderedBody =
    custom?.lines === undefined
      ? transactionBody({
          ...input,
          args,
          ...(oversizedInput === undefined ? {} : { oversizedInput }),
        })
      : [
          ...(input.mode === "full" && input.name !== "edit" && input.name !== "write"
            ? sanitizeTerminalText(serialized).split("\n").map(input.palette.dim)
            : []),
          ...customBody(custom.lines, input.mode, input.palette),
        ];
  if (rendererError !== undefined) {
    renderedBody.push(
      input.palette.error(
        `renderer ${input.renderer?.extensionId ?? "unknown"} failed · ${truncateToWidth(rendererError, 120, "…")}`,
      ),
    );
  }
  const body = renderedBody.flatMap((line) => wrapLine(line, bodyWidth));
  const block = [header, "", ...body, ...(body.length > 0 ? [""] : [])];
  return [
    "",
    ...block.map((line) => {
      // Restore the enclosing surface after a nested diff cell resets its background.
      const padded = `${indent}${line}`;
      return surface === undefined
        ? padded
        : fit(padded, Math.max(1, input.width)).split("\x1b[49m").map(surface).join("");
    }),
  ];
}

export function renderShellPassthrough(input: {
  readonly command: string;
  readonly text: string;
  readonly isError: boolean;
  readonly excluded: boolean;
  readonly width: number;
  readonly mode: ToolOutputDisplay;
  readonly palette: Palette;
}): string[] {
  const { command, isError, excluded, width, mode, palette } = input;
  const widthInside = Math.max(1, width - 6);
  const output = previewText(input.text, mode === "full" ? FULL_RESULT_CHARS : MAX_TOOL_INPUT_CHARS)
    .split("\n")
    .flatMap((line) => wrapLine(line, widthInside));
  const visible = clipRows(
    output,
    mode === "full" ? FULL_RESULT_LINES : BASH_PREVIEW_LINES,
    palette,
    mode === "full"
      ? "lines hidden · /export for complete result"
      : "lines hidden · Ctrl+O to expand",
  );
  const color = isError ? palette.error : (palette.text ?? ((value: string) => value));
  return toolSurface(
    [
      ...(excluded ? [palette.dim("local only")] : []),
      ...shellCommandPreview(command, widthInside, mode, palette),
      "",
      ...visible.map((line) => color(line || " ")),
    ],
    width,
    palette,
  );
}

function isMcpTool(name: string): boolean {
  return name === "mcp" || name.startsWith("mcp_") || name.includes("__mcp__");
}
