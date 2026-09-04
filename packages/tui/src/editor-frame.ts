// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type { LineEditor } from "./editor.ts";
import type { Component, CursorPlacement } from "./render.ts";
import { truncateToWidth, visibleWidth } from "./render.ts";
import type { SessionView } from "./transcript.ts";

const COMPACT_WIDTH = 50;

export interface EditorFrameState {
  readonly notice?: string;
  readonly location: string;
  readonly completion?: readonly string[];
  readonly mode?: string;
}

/** Retained, responsive editor and status frame for the live terminal tail. */
export class EditorFrameComponent implements Component {
  private readonly editor: LineEditor;
  private readonly view: () => SessionView;
  private state: EditorFrameState = { location: "" };
  private cursor: CursorPlacement = { row: 0, column: 0 };
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(editor: LineEditor, view: () => SessionView) {
    this.editor = editor;
    this.view = view;
  }

  update(state: EditorFrameState): void {
    this.state = state;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  cursorPlacement(): CursorPlacement {
    return this.cursor;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines !== undefined) return this.cachedLines;
    const lines = width < COMPACT_WIDTH ? this.renderCompact(width) : this.renderFramed(width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderCompact(width: number): string[] {
    const view = this.view();
    const prefix = this.state.mode ? `${this.state.mode.slice(0, 1)} ` : "";
    const editorWidth = Math.max(1, width - visibleWidth(prefix));
    const rendered = this.editor.render(editorWidth);
    const model = view.modelLabel();
    const separator = " · ";
    const locationWidth = width - visibleWidth(separator) - visibleWidth(model);
    const footer = view.palette.dim(
      locationWidth > 0
        ? `${truncateToWidth(this.state.location, locationWidth, "")}${separator}${model}`
        : truncateToWidth(model, width, ""),
    );
    const lines = [
      "",
      ...(this.state.notice === undefined ? [] : [truncateToWidth(this.state.notice, width, "")]),
      ...rendered.lines.map(
        (line, row) => `${row === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${line}`,
      ),
      footer,
      ...(this.state.completion ?? []).map((line) => truncateToWidth(line, width, "")),
    ];
    const editorStart = 1 + (this.state.notice === undefined ? 0 : 1);
    this.cursor = {
      row: editorStart + rendered.cursorRow,
      column: visibleWidth(prefix) + rendered.cursorColumn,
    };
    return lines;
  }

  private renderFramed(width: number): string[] {
    const view = this.view();
    const contentWidth = width - 4;
    const prefix = "";
    const editorWidth = Math.max(1, contentWidth - visibleWidth(prefix));
    const rendered = this.editor.render(editorWidth);
    const body = rendered.lines.map((line, row) =>
      this.bodyLine(width, row === 0 ? prefix : " ".repeat(visibleWidth(prefix)), line),
    );
    const topLeft = [view.usageLabel(), this.state.mode].filter(Boolean).join(" · ");
    const lines = [
      "",
      ...(this.state.notice === undefined ? [] : [truncateToWidth(this.state.notice, width, "")]),
      this.borderLine(width, topLeft, view.modelLabel(), "╭", "╮"),
      ...body,
      this.borderLine(width, this.state.location, view.tpsLabel(), "╰", "╯"),
      ...(this.state.completion ?? []).map((line) => truncateToWidth(line, width, "")),
    ];
    const editorStart = 1 + (this.state.notice === undefined ? 0 : 1) + 1;
    this.cursor = {
      row: editorStart + rendered.cursorRow,
      column: 2 + visibleWidth(prefix) + rendered.cursorColumn,
    };
    return lines;
  }

  private bodyLine(width: number, prefix: string, text: string): string {
    const view = this.view();
    const inside = width - 4;
    const content = `${prefix}${text}`;
    const clipped = truncateToWidth(content, inside, "");
    const padding = " ".repeat(Math.max(0, inside - visibleWidth(clipped)));
    return `${view.frameBorder("│")} ${clipped}${padding} ${view.frameBorder("│")}`;
  }

  private borderLine(
    width: number,
    left: string,
    right: string,
    start: string,
    end: string,
  ): string {
    const view = this.view();
    const inside = width - 2;
    const rightLabel = truncateToWidth(right ? ` ${right} ` : "", inside, "");
    const leftLabel = truncateToWidth(
      left ? ` ${left} ` : "",
      Math.max(0, inside - visibleWidth(rightLabel)),
      "",
    );
    const fill = "─".repeat(
      Math.max(0, inside - visibleWidth(leftLabel) - visibleWidth(rightLabel)),
    );
    return `${view.frameBorder(start)}${view.palette.dim(leftLabel)}${view.frameBorder(fill)}${view.palette.dim(rightLabel)}${view.frameBorder(end)}`;
  }
}
