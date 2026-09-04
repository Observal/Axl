// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { graphemeWidth, visibleWidth } from "./render.ts";

export type EditorKey =
  | { readonly kind: "char"; readonly char: string }
  | { readonly kind: "left" | "right" | "up" | "down" | "home" | "end" }
  | { readonly kind: "word-left" | "word-right" }
  | {
      readonly kind: "select-left" | "select-right" | "select-word-left" | "select-word-right";
    }
  | { readonly kind: "backspace" | "delete" }
  | { readonly kind: "enter" | "newline" | "follow-up" | "redo" }
  | { readonly kind: "tab" | "shift-tab" | "escape" }
  | { readonly kind: "paste-start" | "paste-end" }
  | { readonly kind: "ctrl" | "alt"; readonly char: string }
  | { readonly kind: "unknown" };

function kittyKey(code: number, modifier = 1): EditorKey {
  const bits = modifier - 1;
  const shift = (bits & 1) !== 0;
  const alt = (bits & 2) !== 0;
  const ctrl = (bits & 4) !== 0;
  if (code === 13) {
    if (alt) return { kind: "follow-up" };
    if (shift || ctrl) return { kind: "newline" };
    return { kind: "enter" };
  }
  if (ctrl && shift && code === 122) return { kind: "redo" };
  if (code === 9) return { kind: shift ? "shift-tab" : "tab" };
  if (code === 27) return { kind: "escape" };
  if (code === 127 || code === 8) {
    if (ctrl || alt) return { kind: "ctrl", char: "w" };
    return { kind: "backspace" };
  }
  const char = String.fromCodePoint(code);
  if (ctrl) return { kind: "ctrl", char: char.toLowerCase() };
  if (alt) return { kind: "alt", char };
  return { kind: "char", char };
}

/** Decode one terminal key, including Kitty/xterm modified-key sequences. */
export function decodeOneKey(data: string, index: number): { key: EditorKey; next: number } {
  const char = data[index] as string;
  if (char === "\x1b") {
    const rest = data.slice(index);
    if (rest.startsWith("\x1b\r") || rest.startsWith("\x1b\n")) {
      return { key: { kind: "newline" }, next: index + 2 };
    }
    if (rest.startsWith("\x1b\x7f") || rest.startsWith("\x1b\b")) {
      return { key: { kind: "ctrl", char: "w" }, next: index + 2 };
    }
    if (rest.startsWith("\x1bb")) return { key: { kind: "word-left" }, next: index + 2 };
    if (rest.startsWith("\x1bf")) return { key: { kind: "word-right" }, next: index + 2 };
    if (rest.startsWith("\x1bd")) return { key: { kind: "alt", char: "d" }, next: index + 2 };
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol parsing requires ESC
    const kitty = /^\x1b\[(\d+)(?::\d+){0,2}(?:;(\d+)(?::(\d+))?)?(?:;[\d:]+)?u/.exec(rest);
    if (kitty) {
      const sequence = kitty[0];
      const eventType = Number(kitty[3] ?? 1);
      return {
        key:
          eventType === 1 || eventType === 2
            ? kittyKey(Number(kitty[1]), Number(kitty[2] ?? 1))
            : { kind: "unknown" },
        next: index + sequence.length,
      };
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol parsing requires ESC
    const modifyOtherKeys = /^\x1b\[27;(\d+);(\d+)~/.exec(rest);
    if (modifyOtherKeys) {
      return {
        key: kittyKey(Number(modifyOtherKeys[2]), Number(modifyOtherKeys[1])),
        next: index + modifyOtherKeys[0].length,
      };
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol parsing requires ESC
    const csi = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest);
    if (csi) {
      const [sequence, argument, final] = csi as unknown as [string, string, string];
      const next = index + sequence.length;
      const modifier = Number(argument.split(";").at(-1) ?? 1);
      const shift = modifier === 2 || modifier === 4 || modifier === 6 || modifier === 8;
      const ctrl = modifier === 5 || modifier === 6 || modifier === 7 || modifier === 8;
      if (final === "A") return { key: { kind: "up" }, next };
      if (final === "B") return { key: { kind: "down" }, next };
      if (final === "C") {
        return {
          key: {
            kind: shift
              ? ctrl
                ? "select-word-right"
                : "select-right"
              : ctrl
                ? "word-right"
                : "right",
          },
          next,
        };
      }
      if (final === "D") {
        return {
          key: {
            kind: shift ? (ctrl ? "select-word-left" : "select-left") : ctrl ? "word-left" : "left",
          },
          next,
        };
      }
      if (final === "H" || (final === "~" && argument === "1")) {
        return { key: { kind: "home" }, next };
      }
      if (final === "F" || (final === "~" && argument === "4")) {
        return { key: { kind: "end" }, next };
      }
      if (final === "Z") return { key: { kind: "shift-tab" }, next };
      if (final === "~" && argument === "13;2") return { key: { kind: "newline" }, next };
      if (final === "~" && argument === "3") return { key: { kind: "delete" }, next };
      if (final === "~" && argument === "200") return { key: { kind: "paste-start" }, next };
      if (final === "~" && argument === "201") return { key: { kind: "paste-end" }, next };
      return { key: { kind: "unknown" }, next };
    }
    if (rest.length === 1) return { key: { kind: "escape" }, next: index + 1 };
    const code = rest.codePointAt(1);
    if (code !== undefined) {
      const value = String.fromCodePoint(code);
      return { key: { kind: "alt", char: value }, next: index + 1 + value.length };
    }
    return { key: { kind: "unknown" }, next: data.length };
  }
  if (char === "\r") return { key: { kind: "enter" }, next: index + 1 };
  if (char === "\n") return { key: { kind: "newline" }, next: index + 1 };
  if (char === "\x7f") return { key: { kind: "backspace" }, next: index + 1 };
  if (char === "\b") {
    const windowsTerminal =
      process.env.WT_SESSION !== undefined &&
      process.env.SSH_CONNECTION === undefined &&
      process.env.SSH_TTY === undefined;
    return {
      key: windowsTerminal ? { kind: "ctrl", char: "w" } : { kind: "backspace" },
      next: index + 1,
    };
  }
  if (char === "\t") return { key: { kind: "tab" }, next: index + 1 };
  if (char === "\x05") return { key: { kind: "end" }, next: index + 1 };
  const control = char.charCodeAt(0);
  if (control > 0 && control <= 0x1a) {
    return {
      key: { kind: "ctrl", char: String.fromCharCode(control + 96) },
      next: index + 1,
    };
  }
  if (control >= 0x1c && control <= 0x1f) {
    return {
      key: { kind: "ctrl", char: String.fromCharCode(control + 64).toLowerCase() },
      next: index + 1,
    };
  }
  if (control === 0 || (control >= 0x7f && control <= 0x9f)) {
    return { key: { kind: "unknown" }, next: index + 1 };
  }
  const code = data.codePointAt(index) as number;
  const value = String.fromCodePoint(code);
  return { key: { kind: "char", char: value }, next: index + value.length };
}

export function decodeKeys(data: string): EditorKey[] {
  const keys: EditorKey[] = [];
  for (let index = 0; index < data.length; ) {
    const decoded = decodeOneKey(data, index);
    keys.push(decoded.key);
    index = decoded.next;
  }
  return keys;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordCharacter = /[\p{L}\p{N}_]/u;

function boundaries(value: string): number[] {
  const result = [0];
  for (const part of segmenter.segment(value)) result.push(part.index + part.segment.length);
  return [...new Set(result)];
}

function previousBoundary(value: string, at: number): number {
  const points = boundaries(value);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index] as number;
    if (point < at) return point;
  }
  return 0;
}

function nextBoundary(value: string, at: number): number {
  for (const point of boundaries(value)) if (point > at) return point;
  return value.length;
}

function graphemeBefore(value: string, at: number): string {
  const from = previousBoundary(value, at);
  return value.slice(from, at);
}

function graphemeAt(value: string, at: number): string {
  return value.slice(at, nextBoundary(value, at));
}

export interface EditorView {
  readonly lines: readonly string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
}

interface EditorState {
  readonly buffer: string;
  readonly cursor: number;
}

/** Multi-line, Unicode-safe editor with history, undo, kill-ring, and soft wrapping. */
export class LineEditor {
  private buffer = "";
  private cursor = 0;
  private selectionAnchor: number | undefined;
  private readonly history: string[] = [];
  private historyIndex = -1;
  private pendingDraft = "";
  private pasting = false;
  private pasteSnapshot = false;
  private readonly undo: EditorState[] = [];
  private readonly redo: EditorState[] = [];
  private readonly killRing: string[] = [];
  private lastYank: { start: number; end: number; ringIndex: number } | undefined;
  private preferredVisualColumn: number | undefined;

  get text(): string {
    return this.buffer;
  }

  get isPasting(): boolean {
    return this.pasting;
  }

  get historyEntries(): readonly string[] {
    return [...this.history].reverse();
  }

  get isBrowsingHistory(): boolean {
    return this.historyIndex !== -1;
  }

  get selectedText(): string {
    const selection = this.selection();
    return selection === undefined ? "" : this.buffer.slice(selection.from, selection.to);
  }

  selectAll(): void {
    if (!this.buffer) return;
    this.selectionAnchor = 0;
    this.cursor = this.buffer.length;
  }

  insertText(text: string): void {
    this.insert(text);
  }

  deleteSelection(): void {
    const selection = this.selection();
    if (selection !== undefined) this.remove(selection.from, selection.to);
  }

  moveVerticalOnly(delta: -1 | 1): void {
    this.moveVertical(delta);
  }

  moveToNextCharacter(character: string): void {
    const { lineEnd } = this.position();
    const found = this.buffer.indexOf(character, nextBoundary(this.buffer, this.cursor));
    if (found >= 0 && found < lineEnd) {
      this.cursor = found;
      this.selectionAnchor = undefined;
      this.preferredVisualColumn = undefined;
    }
  }

  deleteWordForward(): void {
    let to = this.wordRight();
    while (to < this.buffer.length && !wordCharacter.test(graphemeAt(this.buffer, to))) {
      to = nextBoundary(this.buffer, to);
    }
    this.kill(this.cursor, to);
  }

  deleteCurrentLine(): void {
    const { lineStart, lineEnd } = this.position();
    if (lineEnd < this.buffer.length) this.kill(lineStart, lineEnd + 1);
    else if (lineStart > 0) this.kill(lineStart - 1, lineEnd);
    else this.kill(0, lineEnd);
  }

  openLine(direction: "above" | "below"): void {
    const { lineStart, lineEnd } = this.position();
    this.snapshot();
    const at = direction === "above" ? lineStart : lineEnd;
    this.buffer = `${this.buffer.slice(0, at)}\n${this.buffer.slice(at)}`;
    this.cursor = direction === "above" ? at : at + 1;
    this.selectionAnchor = undefined;
  }

  private selection(): { from: number; to: number } | undefined {
    if (this.selectionAnchor === undefined || this.selectionAnchor === this.cursor)
      return undefined;
    return {
      from: Math.min(this.selectionAnchor, this.cursor),
      to: Math.max(this.selectionAnchor, this.cursor),
    };
  }

  clear(): void {
    if (!this.buffer) return;
    this.snapshot();
    this.buffer = "";
    this.cursor = 0;
    this.selectionAnchor = undefined;
    this.historyIndex = -1;
  }

  private snapshot(): void {
    this.redo.length = 0;
    const previous = this.undo.at(-1);
    if (!previous || previous.buffer !== this.buffer || previous.cursor !== this.cursor) {
      this.undo.push({ buffer: this.buffer, cursor: this.cursor });
      if (this.undo.length > 100) this.undo.shift();
    }
    this.lastYank = undefined;
  }

  private insert(text: string, record = true): void {
    if (record) this.snapshot();
    const selection = this.selection();
    if (selection !== undefined) {
      this.buffer = this.buffer.slice(0, selection.from) + this.buffer.slice(selection.to);
      this.cursor = selection.from;
    }
    this.selectionAnchor = undefined;
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
  }

  private collapseSelection(direction: "left" | "right"): boolean {
    const selection = this.selection();
    if (selection === undefined) return false;
    this.cursor = direction === "left" ? selection.from : selection.to;
    this.selectionAnchor = undefined;
    return true;
  }

  private extendSelection(target: number): void {
    this.selectionAnchor ??= this.cursor;
    this.cursor = target;
    if (this.selectionAnchor === this.cursor) this.selectionAnchor = undefined;
  }

  private position(): { row: number; lineStart: number; lineEnd: number; cellColumn: number } {
    const before = this.buffer.slice(0, this.cursor);
    const row = (before.match(/\n/g) ?? []).length;
    const lineStart = before.lastIndexOf("\n") + 1;
    const nextBreak = this.buffer.indexOf("\n", this.cursor);
    const lineEnd = nextBreak === -1 ? this.buffer.length : nextBreak;
    return {
      row,
      lineStart,
      lineEnd,
      cellColumn: visibleWidth(this.buffer.slice(lineStart, this.cursor)),
    };
  }

  private offsetAtCell(line: string, target: number): number {
    let cells = 0;
    for (const part of segmenter.segment(line)) {
      const width = graphemeWidth(part.segment);
      if (cells + width > target) return part.index;
      cells += width;
    }
    return line.length;
  }

  private moveVertical(delta: -1 | 1): boolean {
    const lines = this.buffer.split("\n");
    const { row, cellColumn } = this.position();
    const preferred = this.preferredVisualColumn ?? cellColumn;
    const target = row + delta;
    if (target < 0 || target >= lines.length) return false;
    let absolute = 0;
    for (let index = 0; index < target; index += 1) absolute += (lines[index] as string).length + 1;
    this.cursor = absolute + this.offsetAtCell(lines[target] as string, preferred);
    this.preferredVisualColumn = preferred;
    return true;
  }

  private wordLeft(): number {
    let at = this.cursor;
    while (at > 0 && !wordCharacter.test(graphemeBefore(this.buffer, at)))
      at = previousBoundary(this.buffer, at);
    while (at > 0 && wordCharacter.test(graphemeBefore(this.buffer, at)))
      at = previousBoundary(this.buffer, at);
    return at;
  }

  private wordRight(): number {
    let at = this.cursor;
    while (at < this.buffer.length && !wordCharacter.test(graphemeAt(this.buffer, at)))
      at = nextBoundary(this.buffer, at);
    while (at < this.buffer.length && wordCharacter.test(graphemeAt(this.buffer, at)))
      at = nextBoundary(this.buffer, at);
    return at;
  }

  private remove(from: number, to: number): void {
    if (from === to) return;
    this.snapshot();
    this.buffer = this.buffer.slice(0, from) + this.buffer.slice(to);
    this.cursor = from;
    this.selectionAnchor = undefined;
  }

  private kill(from: number, to: number): void {
    if (from === to) return;
    this.snapshot();
    const removed = this.buffer.slice(from, to);
    this.killRing.unshift(removed);
    if (this.killRing.length > 20) this.killRing.pop();
    this.buffer = this.buffer.slice(0, from) + this.buffer.slice(to);
    this.cursor = from;
    this.selectionAnchor = undefined;
  }

  private undoOnce(): void {
    const state = this.undo.pop();
    if (!state) return;
    this.redo.push({ buffer: this.buffer, cursor: this.cursor });
    this.buffer = state.buffer;
    this.cursor = state.cursor;
    this.selectionAnchor = undefined;
    this.lastYank = undefined;
  }

  private redoOnce(): void {
    const state = this.redo.pop();
    if (!state) return;
    this.undo.push({ buffer: this.buffer, cursor: this.cursor });
    this.buffer = state.buffer;
    this.cursor = state.cursor;
    this.selectionAnchor = undefined;
    this.lastYank = undefined;
  }

  private yank(): void {
    const value = this.killRing[0];
    if (!value) return;
    const start = this.cursor;
    this.insert(value);
    this.lastYank = { start, end: this.cursor, ringIndex: 0 };
  }

  private yankPop(): void {
    const yank = this.lastYank;
    if (!yank || this.killRing.length < 2) return;
    const ringIndex = (yank.ringIndex + 1) % this.killRing.length;
    const value = this.killRing[ringIndex] as string;
    this.buffer = this.buffer.slice(0, yank.start) + value + this.buffer.slice(yank.end);
    this.cursor = yank.start + value.length;
    this.lastYank = { start: yank.start, end: this.cursor, ringIndex };
  }

  apply(key: EditorKey): string | undefined {
    if (key.kind === "paste-start") {
      this.pasting = true;
      this.pasteSnapshot = false;
      return undefined;
    }
    if (key.kind === "paste-end") {
      this.pasting = false;
      this.pasteSnapshot = false;
      return undefined;
    }
    if (this.pasting) {
      if (!this.pasteSnapshot) {
        this.snapshot();
        this.pasteSnapshot = true;
      }
      if (key.kind === "char") this.insert(key.char, false);
      else if (key.kind === "enter" || key.kind === "newline") this.insert("\n", false);
      else if (key.kind === "tab") this.insert("  ", false);
      return undefined;
    }

    if (key.kind !== "up" && key.kind !== "down") this.preferredVisualColumn = undefined;

    switch (key.kind) {
      case "char":
        this.insert(key.char);
        break;
      case "newline":
        this.insert("\n");
        break;
      case "backspace": {
        const selection = this.selection();
        if (selection !== undefined) this.remove(selection.from, selection.to);
        else this.remove(previousBoundary(this.buffer, this.cursor), this.cursor);
        break;
      }
      case "delete": {
        const selection = this.selection();
        if (selection !== undefined) this.remove(selection.from, selection.to);
        else this.remove(this.cursor, nextBoundary(this.buffer, this.cursor));
        break;
      }
      case "left":
        if (!this.collapseSelection("left"))
          this.cursor = previousBoundary(this.buffer, this.cursor);
        break;
      case "right":
        if (!this.collapseSelection("right")) this.cursor = nextBoundary(this.buffer, this.cursor);
        break;
      case "word-left":
        if (!this.collapseSelection("left")) this.cursor = this.wordLeft();
        break;
      case "word-right":
        if (!this.collapseSelection("right")) this.cursor = this.wordRight();
        break;
      case "select-left":
        this.extendSelection(previousBoundary(this.buffer, this.cursor));
        break;
      case "select-right":
        this.extendSelection(nextBoundary(this.buffer, this.cursor));
        break;
      case "select-word-left":
        this.extendSelection(this.wordLeft());
        break;
      case "select-word-right":
        this.extendSelection(this.wordRight());
        break;
      case "home":
        this.selectionAnchor = undefined;
        this.cursor = this.position().lineStart;
        break;
      case "end":
        this.selectionAnchor = undefined;
        this.cursor = this.position().lineEnd;
        break;
      case "ctrl":
        if (key.char === "a") this.selectAll();
        else if (key.char === "b") this.cursor = previousBoundary(this.buffer, this.cursor);
        else if (key.char === "f") this.cursor = nextBoundary(this.buffer, this.cursor);
        else if (key.char === "w") this.kill(this.wordLeft(), this.cursor);
        else if (key.char === "u") this.kill(this.position().lineStart, this.cursor);
        else if (key.char === "k") this.kill(this.cursor, this.position().lineEnd);
        else if (key.char === "y") this.yank();
        else if (key.char === "-" || key.char === "_") this.undoOnce();
        break;
      case "alt":
        if (key.char === "d") this.kill(this.cursor, this.wordRight());
        else if (key.char === "y") this.yankPop();
        break;
      case "redo":
        this.redoOnce();
        break;
      case "up":
        if (!this.moveVertical(-1)) this.previousHistory();
        break;
      case "down":
        if (!this.moveVertical(1)) this.nextHistory();
        break;
      case "enter": {
        if (this.cursor === this.buffer.length && this.buffer.endsWith("\\")) {
          this.snapshot();
          this.buffer = `${this.buffer.slice(0, -1)}\n`;
          this.cursor = this.buffer.length;
          this.selectionAnchor = undefined;
          break;
        }
        const submitted = this.buffer;
        if (submitted.trim()) this.history.push(submitted);
        this.buffer = "";
        this.cursor = 0;
        this.selectionAnchor = undefined;
        this.historyIndex = -1;
        this.pendingDraft = "";
        this.undo.length = 0;
        this.redo.length = 0;
        this.lastYank = undefined;
        return submitted;
      }
    }
    return undefined;
  }

  private previousHistory(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.pendingDraft = this.buffer;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    }
    this.buffer = this.history[this.historyIndex] as string;
    this.cursor = this.buffer.length;
  }

  private nextHistory(): void {
    if (this.historyIndex === -1) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.buffer = this.history[this.historyIndex] as string;
    } else {
      this.historyIndex = -1;
      this.buffer = this.pendingDraft;
    }
    this.cursor = this.buffer.length;
  }

  setText(text: string): void {
    if (text !== this.buffer) this.snapshot();
    this.buffer = text;
    this.cursor = text.length;
    this.selectionAnchor = undefined;
    this.historyIndex = -1;
  }

  render(width: number): EditorView {
    const contentWidth = Math.max(1, width);
    const logical = this.buffer.split("\n");
    const position = this.position();
    const selection = this.selection();
    const lines: string[] = [];
    let logicalStart = 0;
    let cursorRow = 0;
    let cursorColumn = 0;

    for (const [logicalRow, line] of logical.entries()) {
      let current = "";
      let cells = 0;
      let selectionActive = false;
      const cursorOffset = logicalRow === position.row ? this.cursor - position.lineStart : -1;
      let foundCursor = false;
      for (const part of segmenter.segment(line)) {
        if (part.index === cursorOffset) {
          cursorRow = lines.length;
          cursorColumn = cells;
          foundCursor = true;
        }
        const cellWidth = graphemeWidth(part.segment);
        if (cells > 0 && cells + cellWidth > contentWidth) {
          if (selectionActive) current += "\x1b[27m";
          lines.push(current);
          current = "";
          cells = 0;
          selectionActive = false;
          if (part.index === cursorOffset) {
            cursorRow = lines.length;
            cursorColumn = 0;
            foundCursor = true;
          }
        }
        const absoluteOffset = logicalStart + part.index;
        const selected =
          selection !== undefined &&
          absoluteOffset >= selection.from &&
          absoluteOffset < selection.to;
        if (selected && !selectionActive) current += "\x1b[7m";
        else if (!selected && selectionActive) current += "\x1b[27m";
        selectionActive = selected;
        current += part.segment;
        cells += cellWidth;
      }
      if (cursorOffset === line.length) {
        if (cells >= contentWidth && line.length > 0) {
          lines.push(current);
          current = "";
          cells = 0;
        }
        cursorRow = lines.length;
        cursorColumn = cells;
        foundCursor = true;
      }
      if (selectionActive) current += "\x1b[27m";
      lines.push(current);
      if (logicalRow === position.row && !foundCursor) {
        cursorRow = lines.length - 1;
        cursorColumn = cells;
      }
      logicalStart += line.length + 1;
    }
    return { lines: lines.length ? lines : [""], cursorRow, cursorColumn };
  }
}
