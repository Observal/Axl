// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os";

import { highlightLine } from "./highlight.ts";
import { sanitizeTerminalText, truncateToWidth, visibleWidth, wrapLine } from "./render.ts";
import type { Palette, ToolOutputDisplay } from "./transcript.ts";

const HIDDEN_RESULT_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);
const COMPACT_PREVIEW_LINES = 8;
const BASH_PREVIEW_LINES = 10;
const DIFF_PREVIEW_LINES = 24;
const SPLIT_DIFF_MIN_WIDTH = 120;

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

function clipRows(lines: readonly string[], limit: number, palette: Palette): string[] {
  if (lines.length <= limit) return [...lines];
  const head = Math.ceil((limit - 1) / 2);
  const tail = Math.floor((limit - 1) / 2);
  return [
    ...lines.slice(0, head),
    palette.dim(`  … ${lines.length - head - tail} lines hidden`),
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
  if (palette.toolBackground === undefined) return [...lines];
  return lines.map((line) => palette.toolBackground?.(fit(line, width)) ?? line);
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
  return { rows, removed: oldEnd - prefix, added: newEnd - prefix };
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
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

function languageForPath(path: string): string {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  return extension ?? "";
}

function highlighted(line: string, language: string, palette: Palette): string {
  return highlightLine(line || " ", language, palette);
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
  const rendered = change.rows.flatMap((row) => {
    const number = String(rowLineNumber(row) ?? "").padStart(numberWidth);
    const marker = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
    const gutter = `  ${number} ${marker}│ `;
    const available = Math.max(1, width - visibleWidth(gutter));
    return wrapLine(row.text || " ", available).map((part, index) => {
      const prefix =
        index === 0
          ? `${paint(palette, row.kind, `  ${number} ${marker}│`)} `
          : `${paint(palette, row.kind, `  ${"".padStart(numberWidth)}  │`)} `;
      const line = fit(`${prefix}${highlighted(part, language, palette)}`, width);
      return lineBackground(palette, row.kind, line);
    });
  });
  return [
    ...diffSummary(change, "unified", width, palette),
    ...clipRows(rendered, DIFF_PREVIEW_LINES, palette),
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
  language: string,
  palette: Palette,
): string[] {
  if (row === undefined) return [" ".repeat(width)];
  const value = side === "left" ? row.oldLine : row.newLine;
  const number = String(value ?? "").padStart(numberWidth);
  const marker = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
  const gutter = `${number} ${marker}│ `;
  const available = Math.max(1, width - visibleWidth(gutter));
  return wrapLine(row.text || " ", available).map((part, index) => {
    const prefix =
      index === 0
        ? `${paint(palette, row.kind, `${number} ${marker}│`)} `
        : `${paint(palette, row.kind, `${"".padStart(numberWidth)}  │`)} `;
    const line = fit(`${prefix}${highlighted(part, language, palette)}`, width);
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
  const header = `${fit(palette.dim("old"), column)}${separator}${fit(palette.dim("new"), column)}`;
  const rendered = splitPairs(change.rows).flatMap((pair) => {
    const left = splitCell(pair.left, "left", column, numberWidth, language, palette);
    const right = splitCell(pair.right, "right", column, numberWidth, language, palette);
    return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
      const leftLine = left[index] ?? " ".repeat(column);
      const rightLine = right[index] ?? " ".repeat(column);
      return `${leftLine}${separator}${rightLine}`;
    });
  });
  return [
    ...diffSummary(change, "split", width, palette),
    header,
    ...clipRows(rendered, DIFF_PREVIEW_LINES, palette),
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

function changedLineCount(input: Record<string, unknown>): number {
  const text = field(input, "newText") ?? field(input, "content");
  return text === undefined || text === "" ? 0 : text.split("\n").length;
}

/** Rich tool header plus an adaptive edit or write preview. */
export function renderToolCall(
  name: string,
  value: unknown,
  width: number,
  palette: Palette,
): string[] {
  const input = record(value);
  const displayName = sanitizeTerminalText(name);
  switch (name) {
    case "shell":
    case "bash": {
      const command = field(input, "command") ?? "…";
      const cwd = field(input, "cwd");
      return toolSurface(
        wrapLine(
          `${title(palette, "$")} ${palette.accent(command)}${cwd ? palette.dim(`  in ${cwd}`) : ""}`,
          width,
        ),
        width,
        palette,
      );
    }
    case "read": {
      const offset = typeof input.offset === "number" ? input.offset : undefined;
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const range =
        offset === undefined
          ? ""
          : `:${offset}${limit === undefined ? "" : `-${offset + limit - 1}`}`;
      return toolSurface(
        wrapLine(
          `${title(palette, "read")} ${palette.accent(pathLabel(input))}${palette.warning?.(range) ?? range}`,
          width,
        ),
        width,
        palette,
      );
    }
    case "grep":
      return toolSurface(
        wrapLine(
          `${title(palette, "grep")} ${palette.accent(`/${field(input, "pattern") ?? ""}/`)} ${palette.dim(`in ${pathLabel(input)}`)}`,
          width,
        ),
        width,
        palette,
      );
    case "find":
      return toolSurface(
        wrapLine(
          `${title(palette, "find")} ${palette.accent(field(input, "pattern") ?? "")} ${palette.dim(`in ${pathLabel(input)}`)}`,
          width,
        ),
        width,
        palette,
      );
    case "ls":
      return toolSurface(
        wrapLine(`${title(palette, "ls")} ${palette.accent(pathLabel(input))}`, width),
        width,
        palette,
      );
    case "mcp": {
      const server = field(input, "server");
      const action = field(input, "action") ?? "request";
      const target = field(input, "name") ?? field(input, "uri");
      return toolSurface(
        wrapLine(
          `${title(palette, "mcp")} ${palette.accent(
            [server, action, target].filter(Boolean).join(" · "),
          )}`,
          width,
        ),
        width,
        palette,
      );
    }
    case "skill": {
      const action = field(input, "action") ?? "list";
      const target = field(input, "name") ?? field(input, "path");
      return toolSurface(
        wrapLine(
          `${title(palette, "skill")} ${palette.accent(`${action}${target ? ` · ${target}` : ""}`)}`,
          width,
        ),
        width,
        palette,
      );
    }
    case "edit":
    case "write": {
      const count = changedLineCount(input);
      const suffix = count > 0 ? palette.dim(` (${plural(count, "line")})`) : "";
      return toolSurface(
        [
          ...wrapLine(
            `${title(palette, name)} ${palette.accent(pathLabel(input))}${suffix}`,
            width,
          ),
          ...editPreview(input, width, palette),
        ],
        width,
        palette,
      );
    }
    default:
      return toolSurface(
        wrapLine(
          `${title(palette, displayName)} ${palette.dim(sanitizeTerminalText(JSON.stringify(input)))}`,
          width,
        ),
        width,
        palette,
      );
  }
}

function isMcpTool(name: string): boolean {
  return name === "mcp" || name.startsWith("mcp_") || name.includes("__mcp__");
}

/** Result rendering with reads and searches hidden and shell output previewed. */
export function renderToolResult(input: {
  readonly name: string;
  readonly text: string;
  readonly isError: boolean;
  readonly width: number;
  readonly mode: ToolOutputDisplay;
  readonly palette: Palette;
}): string[] {
  const { name, isError, width, mode, palette } = input;
  const text = sanitizeTerminalText(input.text);
  if (!isError && mode === "compact" && (HIDDEN_RESULT_TOOLS.has(name) || isMcpTool(name))) {
    return [];
  }

  const rawLines = text.split("\n");
  const limit =
    mode === "full"
      ? rawLines.length
      : name === "shell" || name === "bash"
        ? BASH_PREVIEW_LINES
        : COMPACT_PREVIEW_LINES;
  const lines = clipRows(rawLines, limit, palette);
  const color = isError ? palette.error : (palette.text ?? palette.dim);
  const rendered = lines.flatMap((line) => wrapLine(line || " ", width).map((part) => color(part)));
  return toolSurface(rendered, width, palette);
}
