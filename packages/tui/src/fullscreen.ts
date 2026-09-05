// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  fullscreenAction,
  isMouseReport,
  type MouseInput,
  parseMouseInput,
} from "./fullscreen-input.ts";
import {
  linkAtCell,
  plainTextByCells,
  type CursorPlacement,
  sanitizeTerminalText,
  stripAnsi,
  styleCellRanges,
  truncateToWidth,
  visibleWidth,
} from "./render.ts";
import type { TerminalOutput } from "./terminal.ts";
import type { Palette } from "./transcript.ts";
import type { TranscriptRow } from "./transcript-document.ts";

const ENTER_SCREEN = "\x1b[?1049h\x1b[?7l\x1b[2J\x1b[H\x1b[?25l";
const EXIT_SCREEN = "\x1b[?7h\x1b[?1049l\x1b[?25h";
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const DOUBLE_CLICK_MS = 500;
const AUTO_SCROLL_MS = 50;

export type FullscreenExitOutput = "transcript" | "resume-hint";
export type FullscreenScrollbar = "auto" | "always" | "hidden";
export type FullscreenMouse = "capture" | "native";

export interface FullscreenFrame {
  readonly document: readonly TranscriptRow[];
  readonly dock: readonly string[];
  readonly cursor?: CursorPlacement;
  readonly palette: Palette;
  readonly sessionId: string;
}

export interface FullscreenScreenOptions {
  readonly mouse?: FullscreenMouse;
  readonly requestRender?: () => void;
  readonly copySelection?: (text: string) => Promise<void>;
  readonly openUrl?: (url: string) => void;
  readonly toggleToolGroup?: (sourceId: string) => void;
}

interface SearchMatch {
  readonly row: number;
  readonly start: number;
  readonly end: number;
  readonly key: string;
}

interface SelectionPoint {
  readonly row: number;
  readonly column: number;
  readonly boundary?: boolean;
}

interface SelectionRange {
  readonly start: SelectionPoint;
  readonly end: SelectionPoint;
}

interface ScrollbarGeometry {
  readonly top: number;
  readonly height: number;
  readonly maxScrollTop: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cellRangeAt(value: string, column: number): { start: number; end: number } {
  const plain = stripAnsi(value);
  let at = 0;
  for (const part of graphemeSegmenter.segment(plain)) {
    const width = visibleWidth(part.segment);
    const end = at + width;
    if (column >= at && column < end) return { start: at, end };
    at = end;
  }
  return { start: at, end: at };
}

function wordRangeAt(value: string, column: number): { start: number; end: number } | undefined {
  const plain = stripAnsi(value);
  let at = 0;
  for (const part of wordSegmenter.segment(plain)) {
    const width = visibleWidth(part.segment);
    const end = at + width;
    if (column >= at && column < end) return { start: at, end };
    at = end;
  }
  return undefined;
}

/** Alternate-screen transcript viewport with a fixed, visually separated dock. */
export class FullscreenScreen {
  private readonly output: TerminalOutput;
  private readonly requestRender: () => void;
  private readonly copySelection: ((text: string) => Promise<void>) | undefined;
  private readonly openUrl: ((url: string) => void) | undefined;
  private readonly toggleToolGroup: ((sourceId: string) => void) | undefined;
  private pressedToolGroup:
    | { readonly sourceId: string; readonly row: number; readonly column: number }
    | undefined;
  private width: number;
  private height: number;
  private scrollbar: FullscreenScrollbar;
  private mouse: FullscreenMouse;
  private active = false;
  private following = true;
  private scrollTop = 0;
  private search = "";
  private searchMode = false;
  private searchMatches: SearchMatch[] = [];
  private readonly searchMatchesByRow = new Map<
    number,
    Array<{ match: SearchMatch; index: number }>
  >();
  private currentSearch = -1;
  private currentSearchKey: string | undefined;
  private searchDocument: readonly TranscriptRow[] | undefined;
  private searchQuery = "";
  private previous: string[] = [];
  private forceClear = false;
  private lastDocument: readonly TranscriptRow[] = [];
  private renderedDocument: readonly TranscriptRow[] | undefined;
  private lastViewportHeight = 1;
  private viewportAnchor: { sourceId: string; rowInSource: number } | undefined;
  private selectionAnchor: SelectionPoint | undefined;
  private selectionFocus: SelectionPoint | undefined;
  private selectionPressActive = false;
  private selectionGranularity: "character" | "word" | "line" = "character";
  private selectionInitialRange: SelectionRange | undefined;
  private lastClick:
    | {
        readonly timestamp: number;
        readonly row: number;
        readonly start: number;
        readonly end: number;
        readonly count: number;
      }
    | undefined;
  private selectionPointer: { readonly column: number; readonly row: number } | undefined;
  private selectionAutoScrollDirection: -1 | 0 | 1 = 0;
  private selectionAutoScrollTimer: NodeJS.Timeout | undefined;
  private scrollbarDrag: { readonly grabOffset: number } | undefined;
  private pressedLink:
    | { readonly row: number; readonly column: number; readonly url: string }
    | undefined;
  private scrollbarVisible = false;
  private scrollbarTimer: NodeJS.Timeout | undefined;
  private flash: string | undefined;
  private flashTimer: NodeJS.Timeout | undefined;

  constructor(
    output: TerminalOutput,
    width: number,
    height: number,
    scrollbar: FullscreenScrollbar,
    options: FullscreenScreenOptions = {},
  ) {
    this.output = output;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.scrollbar = scrollbar;
    this.mouse = options.mouse ?? "capture";
    this.requestRender = options.requestRender ?? (() => undefined);
    this.copySelection = options.copySelection;
    this.openUrl = options.openUrl;
    this.toggleToolGroup = options.toggleToolGroup;
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    this.previous = [];
    this.output.write(`${ENTER_SCREEN}${this.mouse === "capture" ? ENABLE_MOUSE : ""}`);
  }

  pause(): void {
    if (!this.active) return;
    this.active = false;
    this.stopTransientInput();
    this.output.write(`${SYNC_BEGIN}${DISABLE_MOUSE}${EXIT_SCREEN}${SYNC_END}`);
    this.previous = [];
  }

  resume(): void {
    this.enter();
  }

  exit(document: readonly TranscriptRow[], mode: FullscreenExitOutput, sessionId: string): void {
    if (!this.active) return;
    this.active = false;
    this.stopTransientInput();
    const clean = document.map((line) => sanitizeTerminalText(line.text));
    const output =
      mode === "transcript"
        ? clean.join("\r\n")
        : `Axl session ${sessionId.slice(0, 8)} · run axl ${sessionId} to resume`;
    this.output.write(
      `${SYNC_BEGIN}${DISABLE_MOUSE}${EXIT_SCREEN}${output ? `${output}\r\n` : ""}${SYNC_END}`,
    );
    this.previous = [];
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.previous = [];
    this.forceClear = true;
  }

  invalidate(): void {
    this.previous = [];
    this.forceClear = true;
  }

  setScrollbar(scrollbar: FullscreenScrollbar): void {
    this.scrollbar = scrollbar;
  }

  setMouse(mouse: FullscreenMouse): void {
    if (mouse === this.mouse) return;
    this.mouse = mouse;
    if (this.active) this.output.write(mouse === "capture" ? ENABLE_MOUSE : DISABLE_MOUSE);
    if (mouse === "native") this.clearSelection();
  }

  handleInput(data: string, document: readonly TranscriptRow[], dockHeight: number): boolean {
    this.lastDocument = document;
    this.lastViewportHeight = this.viewportHeight(dockHeight);
    const mouse = parseMouseInput(data);
    if (mouse !== undefined) {
      if (this.mouse === "capture") this.handleMouse(mouse, document, this.lastViewportHeight);
      return true;
    }
    if (isMouseReport(data)) return true;

    if (this.searchMode) return this.handleSearchInput(data, document);
    const action = fullscreenAction(data);
    if (action === undefined) return false;
    const viewport = this.lastViewportHeight;
    if (action === "search") this.openSearch(document);
    else if (action === "page-up")
      this.scrollBy(-Math.max(1, viewport - 2), document.length, viewport);
    else if (action === "page-down")
      this.scrollBy(Math.max(1, viewport - 2), document.length, viewport);
    else if (action === "half-page-up")
      this.scrollBy(-Math.max(1, Math.floor(viewport / 2)), document.length, viewport);
    else if (action === "half-page-down")
      this.scrollBy(Math.max(1, Math.floor(viewport / 2)), document.length, viewport);
    else if (action === "line-up") this.scrollBy(-1, document.length, viewport);
    else if (action === "line-down") this.scrollBy(1, document.length, viewport);
    else if (action === "top") this.scrollTo(0, document.length, viewport);
    else if (action === "bottom") this.scrollToEnd(document.length, viewport);
    else if (action === "previous-prompt") this.scrollToPrompt(-1, document, viewport);
    else this.scrollToPrompt(1, document, viewport);
    return true;
  }

  render(frame: FullscreenFrame): void {
    if (!this.active) return;
    this.lastDocument = frame.document;
    const maximumDockHeight = Math.max(0, this.height - 4);
    const dockStart = Math.max(0, frame.dock.length - maximumDockHeight);
    const dock = frame.dock.slice(dockStart);
    const viewportHeight = this.viewportHeight(dock.length);
    this.lastViewportHeight = viewportHeight;
    const max = Math.max(0, frame.document.length - viewportHeight);
    if (this.following) this.scrollTop = max;
    else {
      if (this.renderedDocument !== frame.document) this.restoreViewportAnchor(frame.document);
      this.scrollTop = Math.min(this.scrollTop, max);
    }
    this.renderedDocument = frame.document;
    this.updateViewportAnchor(frame.document);
    this.refreshSearch(frame.document, false);

    const visible = frame.document
      .slice(this.scrollTop, this.scrollTop + viewportHeight)
      .map((row, offset) => this.decorateRow(row.text, this.scrollTop + offset, frame.palette));
    const header = this.header(frame.palette, max);
    const boundary = this.boundary(frame.palette);
    const rows = [header, ...visible];
    while (rows.length < viewportHeight + 1) rows.push("");
    rows.push("", boundary, ...dock);
    const screen = rows.slice(0, this.height).map((line) => truncateToWidth(line, this.width, ""));
    this.applyScrollbar(screen, frame.document.length, viewportHeight, frame.palette);

    let output = `${SYNC_BEGIN}\x1b[?7l${this.forceClear ? "\x1b[2J\x1b[H" : ""}`;
    for (let row = 0; row < this.height; row += 1) {
      if (screen[row] === this.previous[row]) continue;
      output += `\x1b[${row + 1};1H\x1b[2K${screen[row] ?? ""}`;
    }
    if (
      frame.cursor !== undefined &&
      !this.searchMode &&
      frame.cursor.row >= dockStart &&
      frame.cursor.row < dockStart + dock.length
    ) {
      const row = Math.min(this.height - 1, viewportHeight + 3 + frame.cursor.row - dockStart);
      output += `\x1b[${row + 1};${Math.min(this.width - 1, frame.cursor.column) + 1}H${frame.cursor.visible === false ? "\x1b[?25l" : "\x1b[?25h"}`;
    } else output += "\x1b[?25l";
    output += SYNC_END;
    this.output.write(output);
    this.previous = screen;
    this.forceClear = false;
  }

  private header(palette: Palette, max: number): string {
    if (this.flash !== undefined)
      return palette.accent(truncateToWidth(this.flash, this.width, ""));
    if (this.searchMode) {
      const count = this.searchMatches.length;
      const index = this.currentSearch < 0 ? 0 : this.currentSearch + 1;
      return palette.accent(
        truncateToWidth(
          `find · ${this.search || "type to search"}${this.search ? ` · ${index}/${count}` : ""}`,
          this.width,
          "",
        ),
      );
    }
    const text = this.following
      ? "Transcript · latest"
      : `Transcript · paused · ${max - this.scrollTop} lines below · End to latest`;
    return palette.dim(truncateToWidth(text, this.width, ""));
  }

  private boundary(palette: Palette): string {
    const border = palette.border ?? palette.dim;
    return border("─".repeat(this.width));
  }

  private viewportHeight(dockHeight: number): number {
    return Math.max(1, this.height - dockHeight - 3);
  }

  private scrollBy(delta: number, length: number, viewport: number): void {
    this.scrollTo(this.scrollTop + delta, length, viewport);
  }

  private scrollTo(value: number, length: number, viewport: number): void {
    const max = Math.max(0, length - viewport);
    this.scrollTop = Math.max(0, Math.min(max, value));
    this.following = this.scrollTop === max;
    this.updateViewportAnchor(this.lastDocument);
    this.markScrollbarActivity();
  }

  private scrollToEnd(length: number, viewport: number): void {
    this.scrollTo(Math.max(0, length - viewport), length, viewport);
  }

  private scrollToPrompt(
    direction: -1 | 1,
    document: readonly TranscriptRow[],
    viewport: number,
  ): void {
    for (
      let row = this.scrollTop + direction;
      row >= 0 && row < document.length;
      row += direction
    ) {
      if (!document[row]?.prompt) continue;
      this.scrollTo(row, document.length, viewport);
      return;
    }
  }

  private openSearch(document: readonly TranscriptRow[]): void {
    this.searchMode = true;
    this.refreshSearch(document, true);
  }

  private closeSearch(): void {
    this.searchMode = false;
  }

  private handleSearchInput(data: string, document: readonly TranscriptRow[]): boolean {
    if (data === "\x1b" || data === "\x03") {
      this.closeSearch();
      return true;
    }
    if (data === "\r" || data === "\x07") {
      this.navigateSearch(1, document);
      return true;
    }
    if (data === "\n" || data === "\x1b\r" || data === "\x1b[13;2u" || data === "\x1b[27;2;13~") {
      this.navigateSearch(-1, document);
      return true;
    }
    if (data === "\x7f" || data === "\b") {
      this.search = this.search.slice(0, -1);
      this.refreshSearch(document, true);
      return true;
    }
    if (data.startsWith("\x1b")) return true;
    const text = sanitizeTerminalText(data).replaceAll("\n", "");
    if (text) {
      this.search += text;
      this.refreshSearch(document, true);
    }
    return true;
  }

  private refreshSearch(document: readonly TranscriptRow[], reveal: boolean): void {
    if (this.searchDocument === document && this.searchQuery === this.search) {
      if (reveal) this.revealCurrentSearch(document);
      return;
    }
    this.searchDocument = document;
    this.searchQuery = this.search;
    if (!this.search) {
      this.searchMatches = [];
      this.searchMatchesByRow.clear();
      this.currentSearch = -1;
      this.currentSearchKey = undefined;
      return;
    }
    const expression = new RegExp(escapeRegExp(this.search), "giu");
    const matches: SearchMatch[] = [];
    for (const [row, entry] of document.entries()) {
      const plain = stripAnsi(entry.text);
      for (const match of plain.matchAll(expression)) {
        const startIndex = match.index;
        const start = visibleWidth(plain.slice(0, startIndex));
        const end = start + visibleWidth(match[0]);
        matches.push({
          row,
          start,
          end,
          key: `${entry.sourceId ?? row}:${entry.rowInSource}:${start}:${end}`,
        });
      }
    }
    const retained = this.currentSearchKey
      ? matches.findIndex((match) => match.key === this.currentSearchKey)
      : -1;
    this.searchMatches = matches;
    this.searchMatchesByRow.clear();
    for (const [index, match] of matches.entries()) {
      const rowMatches = this.searchMatchesByRow.get(match.row) ?? [];
      rowMatches.push({ match, index });
      this.searchMatchesByRow.set(match.row, rowMatches);
    }
    if (matches.length === 0) this.currentSearch = -1;
    else if (retained >= 0) this.currentSearch = retained;
    else {
      const after = matches.findIndex((match) => match.row >= this.scrollTop);
      this.currentSearch = after >= 0 ? after : 0;
    }
    this.currentSearchKey = matches[this.currentSearch]?.key;
    if (reveal) this.revealCurrentSearch(document);
  }

  private navigateSearch(direction: -1 | 1, document: readonly TranscriptRow[]): void {
    this.refreshSearch(document, false);
    if (this.searchMatches.length === 0) return;
    this.currentSearch =
      (this.currentSearch + direction + this.searchMatches.length) % this.searchMatches.length;
    this.currentSearchKey = this.searchMatches[this.currentSearch]?.key;
    this.revealCurrentSearch(document);
  }

  private revealCurrentSearch(document: readonly TranscriptRow[]): void {
    const match = this.searchMatches[this.currentSearch];
    if (match === undefined) return;
    const top = Math.max(0, match.row - Math.floor(this.lastViewportHeight / 3));
    this.scrollTo(top, document.length, this.lastViewportHeight);
    this.following = false;
  }

  private decorateRow(text: string, row: number, palette: Palette): string {
    const ranges = this.searchMode
      ? (this.searchMatchesByRow.get(row) ?? []).map(({ match, index }) => ({
          start: match.start,
          end: match.end,
          priority: index === this.currentSearch ? 2 : 1,
          style:
            index === this.currentSearch
              ? (palette.searchCurrent ?? ((value: string) => `\x1b[1;7m${value}\x1b[22;27m`))
              : (palette.searchMatch ?? ((value: string) => `\x1b[4m${value}\x1b[24m`)),
        }))
      : [];
    const selection = this.selectionRange();
    if (selection !== undefined && row >= selection.start.row && row <= selection.end.row) {
      const start = row === selection.start.row ? selection.start.column : 0;
      const end = row === selection.end.row ? selection.end.column : visibleWidth(text);
      if (end > start) {
        ranges.push({
          start,
          end,
          priority: 3,
          style: palette.selection ?? ((value: string) => `\x1b[7m${value}\x1b[27m`),
        });
      }
    }
    return styleCellRanges(text, ranges);
  }

  private handleMouse(
    event: MouseInput,
    document: readonly TranscriptRow[],
    viewport: number,
  ): void {
    if (event.motion || event.wheel !== 0) this.pressedToolGroup = undefined;
    if (event.wheel !== 0) {
      this.scrollBy(event.wheel * 3, document.length, viewport);
      return;
    }
    if (this.handleScrollbar(event, document.length, viewport)) return;
    const point = this.documentPoint(event.column, event.row, document, viewport);
    if (point === undefined) {
      if (event.motion && this.selectionPressActive) {
        const edgeRow = event.row <= 1 ? 1 : viewport;
        const edge = this.documentPoint(event.column, edgeRow, document, viewport);
        if (edge !== undefined) this.updateSelectionFocus(edge, document);
        this.updateSelectionAutoScroll(event.column, event.row);
      } else if (event.release) this.finishSelection(document);
      return;
    }
    const button = event.button & 3;
    if (event.release) {
      if (!this.selectionPressActive) return;
      const pressedLink = this.pressedLink;
      const pressedToolGroup = this.pressedToolGroup;
      this.pressedToolGroup = undefined;
      this.pressedLink = undefined;
      this.selectionPressActive = false;
      this.stopSelectionAutoScroll();
      if (
        pressedLink !== undefined &&
        pressedLink.row === point.row &&
        pressedLink.column === point.column &&
        this.openUrl !== undefined
      ) {
        this.clearSelection();
        try {
          this.openUrl(pressedLink.url);
        } catch (error) {
          this.showFlash(
            error instanceof Error ? `Cannot open link: ${error.message}` : "Cannot open link",
          );
        }
        return;
      }
      if (
        pressedToolGroup !== undefined &&
        this.toggleToolGroup !== undefined &&
        pressedToolGroup.row === point.row &&
        pressedToolGroup.column === point.column &&
        document[point.row]?.toolGroupId === pressedToolGroup.sourceId
      ) {
        this.clearSelection();
        try {
          this.toggleToolGroup(pressedToolGroup.sourceId);
        } catch (error) {
          this.showFlash(
            error instanceof Error
              ? `Cannot expand tools: ${error.message}`
              : "Cannot expand tools",
          );
        }
        this.requestRender();
        return;
      }
      this.updateSelectionFocus(point, document);
      void this.copySelectedText(document);
      return;
    }
    if (event.motion) {
      if (!this.selectionPressActive) return;
      this.pressedLink = undefined;
      this.updateSelectionFocus(point, document);
      this.updateSelectionAutoScroll(event.column, event.row);
      return;
    }
    if (button !== 0) return;
    this.stopSelectionAutoScroll();
    this.selectionPressActive = true;
    const source = document[point.row]?.text ?? "";
    const toolGroupId = document[point.row]?.toolGroupId;
    this.pressedToolGroup =
      toolGroupId === undefined || !source.trim() ? undefined : { ...point, sourceId: toolGroupId };
    const target = linkAtCell(source, point.column);
    this.pressedLink = target === undefined ? undefined : { ...point, url: target };
    const word = wordRangeAt(source, point.column);
    const now = Date.now();
    const repeated =
      word !== undefined &&
      this.lastClick !== undefined &&
      now - this.lastClick.timestamp <= DOUBLE_CLICK_MS &&
      this.lastClick.row === point.row &&
      this.lastClick.start === word.start &&
      this.lastClick.end === word.end;
    const count = repeated ? ((this.lastClick?.count ?? 0) % 3) + 1 : 1;
    this.lastClick = word
      ? { timestamp: now, row: point.row, start: word.start, end: word.end, count }
      : undefined;
    const range =
      count === 2 && word !== undefined
        ? {
            start: { row: point.row, column: word.start },
            end: { row: point.row, column: word.end, boundary: true },
          }
        : count === 3
          ? {
              start: { row: point.row, column: 0 },
              end: {
                row: point.row,
                column: visibleWidth(document[point.row]?.text ?? ""),
                boundary: true,
              },
            }
          : undefined;
    this.selectionGranularity = count === 2 ? "word" : count === 3 ? "line" : "character";
    this.selectionInitialRange = range;
    this.selectionAnchor = range?.start ?? point;
    this.selectionFocus = range?.end ?? point;
  }

  private documentPoint(
    column: number,
    screenRow: number,
    document: readonly TranscriptRow[],
    viewport: number,
  ): SelectionPoint | undefined {
    if (screenRow < 1 || screenRow > viewport) return undefined;
    const row = this.scrollTop + screenRow - 1;
    if (row < 0 || row >= document.length) return undefined;
    return { row, column: Math.min(column, visibleWidth(document[row]?.text ?? "")) };
  }

  private updateSelectionFocus(point: SelectionPoint, document: readonly TranscriptRow[]): void {
    const initial = this.selectionInitialRange;
    if (this.selectionGranularity === "character" || initial === undefined) {
      this.selectionFocus = point;
      return;
    }
    const text = document[point.row]?.text ?? "";
    const selected =
      this.selectionGranularity === "word"
        ? wordRangeAt(text, point.column)
        : { start: 0, end: visibleWidth(text) };
    if (selected === undefined) return;
    const range: SelectionRange = {
      start: { row: point.row, column: selected.start },
      end: { row: point.row, column: selected.end, boundary: true },
    };
    const before =
      range.start.row < initial.start.row ||
      (range.start.row === initial.start.row && range.start.column < initial.start.column);
    this.selectionAnchor = before ? initial.end : initial.start;
    this.selectionFocus = before ? range.start : range.end;
  }

  private selectionRange(): SelectionRange | undefined {
    const anchor = this.selectionAnchor;
    const focus = this.selectionFocus;
    if (anchor === undefined || focus === undefined) return undefined;
    if (anchor.row === focus.row && anchor.column === focus.column && !focus.boundary)
      return undefined;
    const anchorFirst =
      anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column);
    const start = anchorFirst ? anchor : focus;
    const rawEnd = anchorFirst ? focus : anchor;
    const line = this.lastDocument[rawEnd.row]?.text ?? "";
    const end = rawEnd.boundary
      ? rawEnd
      : { ...rawEnd, column: cellRangeAt(line, rawEnd.column).end, boundary: true };
    return { start, end };
  }

  private async copySelectedText(document: readonly TranscriptRow[]): Promise<void> {
    const selection = this.selectionRange();
    if (selection === undefined) return;
    const lines: string[] = [];
    for (let row = selection.start.row; row <= selection.end.row; row += 1) {
      const text = document[row]?.text ?? "";
      const start = row === selection.start.row ? selection.start.column : 0;
      const end = row === selection.end.row ? selection.end.column : visibleWidth(text);
      lines.push(plainTextByCells(text, start, end).trimEnd());
    }
    const text = lines.join("\n");
    if (!text) return;
    if (this.copySelection === undefined) {
      this.showFlash("Copy unavailable");
      return;
    }
    try {
      await this.copySelection(text);
      this.showFlash("Copied selection");
    } catch (error) {
      this.showFlash(error instanceof Error ? `Copy failed: ${error.message}` : "Copy failed");
    }
  }

  private finishSelection(document: readonly TranscriptRow[]): void {
    if (!this.selectionPressActive) return;
    this.selectionPressActive = false;
    this.stopSelectionAutoScroll();
    void this.copySelectedText(document);
  }

  private clearSelection(): void {
    this.selectionAnchor = undefined;
    this.selectionFocus = undefined;
    this.selectionInitialRange = undefined;
    this.pressedToolGroup = undefined;
    this.selectionPressActive = false;
    this.pressedLink = undefined;
    this.stopSelectionAutoScroll();
  }

  private updateSelectionAutoScroll(column: number, row: number): void {
    this.selectionPointer = { column, row };
    this.selectionAutoScrollDirection = row <= 1 ? -1 : row >= this.lastViewportHeight ? 1 : 0;
    if (this.selectionAutoScrollDirection === 0) {
      this.stopSelectionAutoScroll();
      return;
    }
    if (this.selectionAutoScrollTimer !== undefined) return;
    this.selectionAutoScrollTimer = setInterval(() => {
      const direction = this.selectionAutoScrollDirection;
      const pointer = this.selectionPointer;
      if (direction === 0 || pointer === undefined) return;
      const before = this.scrollTop;
      this.scrollBy(direction, this.lastDocument.length, this.lastViewportHeight);
      const point = this.documentPoint(
        pointer.column,
        pointer.row,
        this.lastDocument,
        this.lastViewportHeight,
      );
      if (point !== undefined) this.updateSelectionFocus(point, this.lastDocument);
      if (this.scrollTop === before) this.stopSelectionAutoScroll();
      this.requestRender();
    }, AUTO_SCROLL_MS);
    this.selectionAutoScrollTimer.unref?.();
  }

  private stopSelectionAutoScroll(): void {
    if (this.selectionAutoScrollTimer !== undefined) clearInterval(this.selectionAutoScrollTimer);
    this.selectionAutoScrollTimer = undefined;
    this.selectionAutoScrollDirection = 0;
    this.selectionPointer = undefined;
  }

  private markScrollbarActivity(): void {
    if (this.scrollbar !== "auto") return;
    this.scrollbarVisible = true;
    if (this.scrollbarTimer !== undefined) clearTimeout(this.scrollbarTimer);
    this.scrollbarTimer = setTimeout(() => {
      this.scrollbarTimer = undefined;
      this.scrollbarVisible = false;
      this.requestRender();
    }, 1_000);
    this.scrollbarTimer.unref?.();
  }

  private scrollbarGeometry(documentHeight: number, viewportHeight: number): ScrollbarGeometry {
    const height = Math.max(1, viewportHeight);
    const thumb = Math.max(1, Math.floor((viewportHeight / Math.max(1, documentHeight)) * height));
    const maxScrollTop = Math.max(0, documentHeight - viewportHeight);
    const offset =
      maxScrollTop === 0
        ? 0
        : Math.floor((this.scrollTop / maxScrollTop) * Math.max(0, height - thumb));
    return { top: 1 + offset, height: thumb, maxScrollTop };
  }

  private handleScrollbar(
    event: MouseInput,
    documentHeight: number,
    viewportHeight: number,
  ): boolean {
    if (
      this.scrollbar === "hidden" ||
      (this.scrollbar === "auto" && !this.scrollbarVisible) ||
      event.column !== this.width - 1
    )
      return false;
    const geometry = this.scrollbarGeometry(documentHeight, viewportHeight);
    if (this.scrollbarDrag !== undefined) {
      if (event.release) {
        this.scrollbarDrag = undefined;
        return true;
      }
      if (!event.motion) return true;
      const maxOffset = Math.max(0, viewportHeight - geometry.height);
      const offset = Math.max(
        0,
        Math.min(maxOffset, event.row - 1 - this.scrollbarDrag.grabOffset),
      );
      const target = maxOffset === 0 ? 0 : Math.round((offset / maxOffset) * geometry.maxScrollTop);
      this.scrollTo(target, documentHeight, viewportHeight);
      return true;
    }
    if (event.release || event.motion || (event.button & 3) !== 0) return false;
    if (event.row >= geometry.top && event.row < geometry.top + geometry.height) {
      this.scrollbarDrag = { grabOffset: event.row - geometry.top };
    } else {
      const maxOffset = Math.max(1, viewportHeight - geometry.height);
      const offset = Math.max(0, Math.min(maxOffset, event.row - 1));
      this.scrollTo(
        Math.round((offset / maxOffset) * geometry.maxScrollTop),
        documentHeight,
        viewportHeight,
      );
    }
    this.clearSelection();
    return true;
  }

  private showFlash(message: string): void {
    this.flash = sanitizeTerminalText(message);
    if (this.flashTimer !== undefined) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashTimer = undefined;
      this.flash = undefined;
      this.requestRender();
    }, 1_500);
    this.flashTimer.unref?.();
    this.requestRender();
  }

  private stopTransientInput(): void {
    this.stopSelectionAutoScroll();
    this.scrollbarDrag = undefined;
    this.pressedToolGroup = undefined;
    this.selectionPressActive = false;
    this.pressedLink = undefined;
    if (this.flashTimer !== undefined) clearTimeout(this.flashTimer);
    this.flashTimer = undefined;
    this.flash = undefined;
    if (this.scrollbarTimer !== undefined) clearTimeout(this.scrollbarTimer);
    this.scrollbarTimer = undefined;
    this.scrollbarVisible = false;
  }

  private updateViewportAnchor(document: readonly TranscriptRow[]): void {
    if (this.following) {
      this.viewportAnchor = undefined;
      return;
    }
    const row = document[this.scrollTop];
    this.viewportAnchor = row?.sourceId
      ? { sourceId: row.sourceId, rowInSource: row.rowInSource }
      : undefined;
  }

  private restoreViewportAnchor(document: readonly TranscriptRow[]): void {
    const anchor = this.viewportAnchor;
    if (anchor === undefined) return;
    const row = document.findIndex(
      (candidate) =>
        candidate.sourceId === anchor.sourceId && candidate.rowInSource === anchor.rowInSource,
    );
    if (row >= 0) this.scrollTop = row;
  }

  private applyScrollbar(
    screen: string[],
    documentHeight: number,
    viewportHeight: number,
    palette: Palette,
  ): void {
    if (
      this.scrollbar === "hidden" ||
      (this.scrollbar === "auto" && (documentHeight <= viewportHeight || !this.scrollbarVisible))
    )
      return;
    const geometry = this.scrollbarGeometry(documentHeight, viewportHeight);
    for (let row = 0; row < viewportHeight; row += 1) {
      const marker =
        row + 1 >= geometry.top && row + 1 < geometry.top + geometry.height ? "█" : "│";
      const line = truncateToWidth(screen[row + 1] ?? "", Math.max(1, this.width - 1), "");
      const padding = " ".repeat(Math.max(0, this.width - 1 - visibleWidth(line)));
      screen[row + 1] = `${line}${padding}${palette.dim(marker)}`;
    }
  }
}
