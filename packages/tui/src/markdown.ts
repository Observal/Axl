// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  diagramKind,
  type MermaidArt,
  type Span as MermaidSpan,
  render as renderMermaid,
} from "grok-mermaid";
import { Lexer, marked, type Token, type Tokens } from "marked";

import { highlightCode } from "./highlight.ts";
import {
  sanitizeTerminalText,
  stripAnsi,
  truncateToWidth,
  visibleWidth,
  wrapLine,
} from "./render.ts";
import type { Palette } from "./transcript.ts";

const BOLD = (text: string): string => `\x1b[1m${text}\x1b[22m`;
const ITALIC = (text: string): string => `\x1b[3m${text}\x1b[23m`;
const STRIKE = (text: string): string => `\x1b[9m${text}\x1b[29m`;
const OSC8_END = "\x1b]8;;\x1b\\";
const MAX_TOKEN_CACHE_ENTRIES = 4_096;
const MAX_TOKEN_CACHE_CHARACTERS = 8 * 1024 * 1024;
const tokenCache = new Map<string, readonly Token[]>();
let tokenCacheCharacters = 0;
const MAX_ROW_CACHE_TEXT = 8_192;
const rowCaches = new WeakMap<
  Palette,
  { rows: Map<string, readonly string[]>; characters: number }
>();

function parsedBlocks(text: string): readonly Token[] {
  const cached = tokenCache.get(text);
  if (cached !== undefined) {
    tokenCache.delete(text);
    tokenCache.set(text, cached);
    return cached;
  }
  const parsed = marked.lexer(text, { gfm: true });
  if (text.length <= MAX_TOKEN_CACHE_CHARACTERS) {
    tokenCache.set(text, parsed);
    tokenCacheCharacters += text.length;
    while (
      tokenCache.size > MAX_TOKEN_CACHE_ENTRIES ||
      tokenCacheCharacters > MAX_TOKEN_CACHE_CHARACTERS
    ) {
      const oldest = tokenCache.keys().next().value;
      if (oldest === undefined) break;
      tokenCache.delete(oldest);
      tokenCacheCharacters -= oldest.length;
    }
  }
  return parsed;
}

function renderLink(label: string, target: string, palette: Palette): string | undefined {
  try {
    const url = new URL(target);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      return undefined;
    const visibleTarget =
      label === target ? "" : (palette.dim ?? ((value: string) => value))(` (${target})`);
    const text = (palette.accent ?? ((value: string) => value))(label);
    return `\x1b]8;;${url.href}\x1b\\${text}${OSC8_END}${visibleTarget}`;
  } catch {
    return undefined;
  }
}

function nestedTokens(token: Token): readonly Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function renderInlineTokens(tokens: readonly Token[], palette: Palette): string {
  let output = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        output += text.tokens ? renderInlineTokens(text.tokens, palette) : text.text;
        break;
      }
      case "escape":
        output += token.text;
        break;
      case "codespan":
        output += (palette.mdCode ?? palette.accent)(token.text);
        break;
      case "strong":
        output += BOLD(renderInlineTokens(nestedTokens(token), palette));
        break;
      case "em":
        output += ITALIC(renderInlineTokens(nestedTokens(token), palette));
        break;
      case "del":
        output += STRIKE(renderInlineTokens(nestedTokens(token), palette));
        break;
      case "link": {
        const link = token as Tokens.Link;
        const label = renderInlineTokens(link.tokens, palette);
        output += renderLink(label, link.href, palette) ?? `${label} (${link.href})`;
        break;
      }
      case "image":
        output += `[image: ${token.text || "attachment"}] (${token.href})`;
        break;
      case "br":
        output += "\n";
        break;
      case "html":
        output += token.text;
        break;
      case "checkbox":
        output += token.checked ? "☑" : "☐";
        break;
      default: {
        const children = nestedTokens(token);
        output += children.length > 0 ? renderInlineTokens(children, palette) : token.raw;
        break;
      }
    }
  }
  return output;
}

/** Renders inline Markdown without producing or interpreting HTML. */
export function renderInline(text: string, palette: Palette): string {
  try {
    return renderInlineTokens(Lexer.lexInline(text, { gfm: true }), palette);
  } catch {
    return text;
  }
}

function wrappedInline(tokens: readonly Token[], width: number, palette: Palette): string[] {
  const rendered = renderInlineTokens(tokens, palette);
  return rendered.split("\n").flatMap((line) => wrapLine(line, Math.max(1, width)));
}

function fitCell(value: string, width: number): string {
  const clipped = truncateToWidth(value.replaceAll("\n", " "), width, "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function tableWidths(table: Tokens.Table, width: number, palette: Palette): number[] {
  const columns = Math.max(1, table.header.length);
  const chrome = columns * 3 + 1;
  const available = Math.max(columns, width - chrome);
  const desired = table.header.map((cell, index) =>
    Math.max(
      1,
      visibleWidth(renderInlineTokens(cell.tokens, palette)),
      ...table.rows.map((row) =>
        visibleWidth(renderInlineTokens(row[index]?.tokens ?? [], palette)),
      ),
    ),
  );
  const result = Array(columns).fill(1) as number[];
  let remaining = Math.max(0, available - columns);
  while (remaining > 0) {
    let candidate = -1;
    let need = 0;
    for (let index = 0; index < columns; index += 1) {
      const currentNeed = (desired[index] ?? 1) - (result[index] ?? 1);
      if (currentNeed > need) {
        need = currentNeed;
        candidate = index;
      }
    }
    if (candidate < 0) candidate = result.indexOf(Math.min(...result));
    result[candidate] = (result[candidate] ?? 1) + 1;
    remaining -= 1;
  }
  return result;
}

function renderTable(table: Tokens.Table, width: number, palette: Palette): string[] {
  const border = palette.border ?? palette.dim;
  const widths = tableWidths(table, width, palette);
  const divider = (left: string, middle: string, right: string): string =>
    border(`${left}${widths.map((value) => "─".repeat(value + 2)).join(middle)}${right}`);
  const row = (cells: readonly Tokens.TableCell[], heading: boolean): string => {
    const values = widths.map((columnWidth, index) => {
      const rendered = renderInlineTokens(cells[index]?.tokens ?? [], palette);
      const fitted = fitCell(rendered, columnWidth);
      return heading ? BOLD(fitted) : fitted;
    });
    return `${border("│")} ${values.join(` ${border("│")} `)} ${border("│")}`;
  };
  return [
    divider("┌", "┬", "┐"),
    row(table.header, true),
    divider("├", "┼", "┤"),
    ...table.rows.map((cells) => row(cells, false)),
    divider("└", "┴", "┘"),
  ].map((line) => truncateToWidth(line, width, ""));
}

function renderList(list: Tokens.List, width: number, palette: Palette, depth: number): string[] {
  const lines: string[] = [];
  const start = typeof list.start === "number" ? list.start : 1;
  for (const [index, item] of list.items.entries()) {
    const task = item.task ? (item.checked ? "☑" : "☐") : undefined;
    const marker = task ?? (list.ordered ? `${start + index}.` : "•");
    const prefix = `${"  ".repeat(depth)}${(palette.mdListBullet ?? palette.accent)(marker)} `;
    const continuation = " ".repeat(visibleWidth(prefix));
    const nested = item.tokens.filter((token): token is Tokens.List => token.type === "list");
    const content = item.tokens.filter(
      (token) => token.type !== "list" && token.type !== "checkbox",
    );
    const rendered = renderBlocks(
      content,
      Math.max(1, width - visibleWidth(prefix)),
      palette,
      depth,
    );
    const visible = rendered.length > 0 ? rendered : [""];
    lines.push(
      ...visible.map((line, row) => `${row === 0 ? prefix : continuation}${line}`),
      ...nested.flatMap((child) => renderList(child, width, palette, depth + 1)),
    );
  }
  return lines;
}

function styleMermaidSpan(span: MermaidSpan, palette: Palette): string {
  const text = sanitizeTerminalText(span.text);
  if (span.cls === "border") return (palette.border ?? palette.dim)(text);
  if (span.cls === "edge") return palette.accent(text);
  if (span.cls === "edgeLabel") return palette.dim(text);
  if (span.cls === "title") return (palette.bold ?? palette.accent)(text);
  if (span.cls === "text") return (palette.text ?? ((value: string) => value))(text);
  return text;
}

function shortenLabel(value: string, limit: number): string {
  const characters = [...value.trim()];
  if (characters.length <= limit) return characters.join("");
  return `${characters.slice(0, Math.max(1, limit - 1)).join("")}…`;
}

function compactSequenceSource(
  source: string,
  labelLimit: number,
): { source: string; legend: readonly string[] } {
  const legend: string[] = [];
  const lines = source.split("\n").map((line) => {
    const participant = /^(\s*(?:actor|participant)\s+(\S+))(?:\s+as\s+(.+))?\s*$/i.exec(line);
    if (participant !== null) {
      const declaration = participant[1] as string;
      const id = participant[2] as string;
      const label = participant[3]?.trim();
      if (label && label !== id) legend.push(`${id} ${label}`);
      return `${declaration} as ${id}`;
    }
    const message = /^(\s*[^:\n]+:\s*)(.+)$/.exec(line);
    if (message !== null) return `${message[1]}${shortenLabel(message[2] as string, labelLimit)}`;
    const section = /^(\s*(?:alt|else|opt|loop|par|critical|break)\s+)(.+)$/i.exec(line);
    if (section !== null) return `${section[1]}${shortenLabel(section[2] as string, labelLimit)}`;
    return line;
  });
  return { source: lines.join("\n"), legend };
}

function styledMermaid(art: MermaidArt, palette: Palette): string[] {
  return art.styled.map((row) => row.map((span) => styleMermaidSpan(span, palette)).join(""));
}

function renderMermaidBlock(source: string, width: number, palette: Palette): string[] {
  const art = renderMermaid(source);
  if (art !== null && art.width <= width) return styledMermaid(art, palette);

  if (diagramKind(source) === "sequence") {
    for (const labelLimit of [24, 18, 12, 8, 4]) {
      const compact = compactSequenceSource(source, labelLimit);
      const compactArt = renderMermaid(compact.source);
      if (compactArt === null || compactArt.width > width) continue;
      const legend = compact.legend.join(" · ");
      return [
        ...styledMermaid(compactArt, palette),
        ...(legend
          ? ["", ...wrapLine(`Legend · ${legend}`, width).map((line) => palette.dim(line))]
          : []),
        palette.dim("Labels shortened to fit the terminal"),
      ];
    }
  }

  const label =
    art === null
      ? "◇ Mermaid source · unsupported"
      : `◇ Mermaid source · needs ${art.width} columns`;
  return [
    palette.dim(truncateToWidth(label, width, "")),
    ...source.split("\n").flatMap((line) => wrapLine(line || " ", width)),
  ];
}

function renderCode(code: Tokens.Code, width: number, palette: Palette): string[] {
  const language = code.lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const sourceLines = code.text.split("\n");
  if (sourceLines.at(-1) === "") sourceLines.pop();
  if (language === "text" || language === "plaintext" || language === "txt") {
    return sourceLines.flatMap((line) => wrapLine(line || " ", width));
  }
  if (language === "mermaid") return renderMermaidBlock(code.text, width, palette);
  const border = palette.mdCodeBlockBorder ?? palette.dim;
  const gutter = border("│");
  const available = Math.max(1, width - 2);
  const lines = highlightCode(sourceLines.join("\n"), language, palette);
  return [
    border(language ? `╭─ ${language}` : "╭─"),
    ...lines.flatMap((line) => wrapLine(line || " ", available).map((part) => `${gutter} ${part}`)),
    border("╰─"),
  ];
}

function renderBlocks(
  tokens: readonly Token[],
  width: number,
  palette: Palette,
  listDepth = 0,
): string[] {
  const output: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        if (output.length > 0 && output.at(-1) !== "") output.push("");
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        output.push(
          ...wrappedInline(heading.tokens, width, palette).map((line) =>
            BOLD((palette.mdHeading ?? palette.accent)(line)),
          ),
        );
        break;
      }
      case "paragraph":
      case "text": {
        const text = token as Tokens.Paragraph | Tokens.Text;
        output.push(...wrappedInline(text.tokens ?? Lexer.lexInline(text.text), width, palette));
        break;
      }
      case "code":
        output.push(...renderCode(token as Tokens.Code, width, palette));
        break;
      case "blockquote": {
        const border = palette.mdQuoteBorder ?? palette.accent;
        const quote = palette.mdQuote ?? palette.dim;
        output.push(
          ...renderBlocks(nestedTokens(token), Math.max(1, width - 2), palette, listDepth).map(
            (line) => `${border("▌")} ${quote(line)}`,
          ),
        );
        break;
      }
      case "list":
        output.push(...renderList(token as Tokens.List, width, palette, listDepth));
        break;
      case "table":
        output.push(...renderTable(token as Tokens.Table, width, palette));
        break;
      case "hr":
        output.push((palette.border ?? palette.dim)("─".repeat(Math.max(1, width))));
        break;
      case "html": {
        const html = token as Tokens.HTML;
        output.push(...html.text.split("\n").flatMap((line) => wrapLine(line, width)));
        break;
      }
      case "def":
        break;
      default:
        output.push(...wrapLine(stripAnsi(token.raw), width));
        break;
    }
  }
  while (output.at(-1) === "") output.pop();
  return output;
}

function isPlainParagraph(text: string): boolean {
  return (
    !text.includes("\n") &&
    !/[*_`[\]<>#~\\&]/u.test(text) &&
    !/^\s*(?:[-+>]|\d+[.)])\s/u.test(text) &&
    !/(?:https?:\/\/|www\.)/iu.test(text)
  );
}

/** Renders GFM tokens into deterministic, width-bounded terminal rows. */
export function renderMarkdown(text: string, width: number, palette: Palette): string[] {
  const safeWidth = Math.max(1, width);
  if (isPlainParagraph(text)) return wrapLine(text, safeWidth);
  const state = rowCaches.get(palette) ?? {
    rows: new Map<string, readonly string[]>(),
    characters: 0,
  };
  if (!rowCaches.has(palette)) rowCaches.set(palette, state);
  const key = `${safeWidth}\u0000${text}`;
  const cached = text.length <= MAX_ROW_CACHE_TEXT ? state.rows.get(key) : undefined;
  if (cached !== undefined) {
    state.rows.delete(key);
    state.rows.set(key, cached);
    return [...cached];
  }
  try {
    const rows = renderBlocks(parsedBlocks(text), safeWidth, palette).map((line) =>
      truncateToWidth(line, safeWidth, ""),
    );
    if (text.length <= MAX_ROW_CACHE_TEXT) {
      state.rows.set(key, rows);
      state.characters += key.length;
      while (
        state.rows.size > MAX_TOKEN_CACHE_ENTRIES ||
        state.characters > MAX_TOKEN_CACHE_CHARACTERS
      ) {
        const oldest = state.rows.keys().next().value;
        if (oldest === undefined) break;
        state.rows.delete(oldest);
        state.characters -= oldest.length;
      }
    }
    return rows;
  } catch {
    return text.split("\n").flatMap((line) => wrapLine(line, safeWidth));
  }
}
