// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type { ProjectedActivity } from "@axl/sdk";

import { renderMarkdown } from "./markdown.ts";
import type { Component } from "./render.ts";
import { sanitizeTerminalText, truncateToWidth } from "./render.ts";
import type { Palette, ThinkingDisplay } from "./transcript.ts";

const MAX_VISIBLE_CHARACTERS = 131_072;

export class LiveAssistantComponent implements Component {
  private operationId: string | undefined;
  private sequence = -1;
  private readonly textChunks: string[] = [];
  private readonly thinkingChunks: string[] = [];
  private textCharacters = 0;
  private thinkingCharacters = 0;
  private textStart = 0;
  private thinkingStart = 0;
  private readonly tools: Array<{ callId: string; name: string }> = [];
  private cache:
    | {
        readonly width: number;
        readonly thinkingDisplay: ThinkingDisplay;
        readonly maxRows?: number;
        readonly rows: readonly string[];
      }
    | undefined;

  private maxRows: number | undefined;
  private readonly palette: () => Palette;
  private readonly thinkingDisplay: () => ThinkingDisplay;

  constructor(palette: () => Palette, thinkingDisplay: () => ThinkingDisplay) {
    this.palette = palette;
    this.thinkingDisplay = thinkingDisplay;
  }

  get active(): boolean {
    return this.operationId !== undefined;
  }

  replace(activity: ProjectedActivity | undefined): boolean {
    if (activity === undefined) {
      if (!this.active) return false;
      this.clear();
      return true;
    }
    if (
      this.operationId === activity.operationId &&
      this.sequence === activity.sequence &&
      this.textChunks.slice(this.textStart).join("") === activity.text &&
      this.thinkingChunks.slice(this.thinkingStart).join("") === activity.thinking &&
      this.tools.length === activity.toolCalls.length &&
      this.tools.every((tool, index) => tool.callId === activity.toolCalls[index]?.callId)
    ) {
      return false;
    }
    this.operationId = activity.operationId;
    this.sequence = activity.sequence;
    this.setChunks(this.textChunks, activity.text, "text");
    this.setChunks(this.thinkingChunks, activity.thinking, "thinking");
    this.tools.splice(0, this.tools.length, ...activity.toolCalls);
    this.cache = undefined;
    return true;
  }

  reset(): void {
    this.operationId = undefined;
    this.sequence = -1;
    this.resetContent();
    this.tools.length = 0;
    this.cache = undefined;
  }

  clear(): void {
    this.operationId = undefined;
    this.resetContent();
    this.tools.length = 0;
    this.cache = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  setMaxRows(maxRows: number | undefined): void {
    const next = maxRows === undefined ? undefined : Math.max(0, Math.floor(maxRows));
    if (next === this.maxRows) return;
    this.maxRows = next;
    this.cache = undefined;
  }

  render(width: number): string[] {
    if (!this.active) return [];
    const thinkingDisplay = this.thinkingDisplay();
    if (
      this.cache?.width === width &&
      this.cache.thinkingDisplay === thinkingDisplay &&
      this.cache.maxRows === this.maxRows
    ) {
      return [...this.cache.rows];
    }
    const palette = this.palette();
    const contentWidth = Math.max(1, width - 2);
    const rows: string[] = [""];
    const thought = sanitizeTerminalText(this.thinkingChunks.slice(this.thinkingStart).join(""));
    if (thought && thinkingDisplay !== "hide") {
      if (thinkingDisplay === "show") {
        rows.push(
          palette.dim("  ∴ Thinking"),
          ...renderMarkdown(thought, contentWidth, palette).map(
            (row) => `  ${truncateToWidth(row, contentWidth, "")}`,
          ),
        );
      } else {
        const lines = thought.split("\n").length;
        rows.push(palette.dim(`  ∴ Thinking · ${lines} line${lines === 1 ? "" : "s"}`));
      }
    }
    const text = sanitizeTerminalText(this.textChunks.slice(this.textStart).join(""));
    if (text) {
      rows.push(
        ...renderMarkdown(text, contentWidth, palette).map(
          (row) => `  ${truncateToWidth(row, contentWidth, "")}`,
        ),
      );
      const tail = rows.length - 1;
      rows[tail] = `${rows[tail] ?? ""}${palette.accent("▌")}`;
    }
    if (rows.length === 1 && this.tools.length === 0) {
      rows.push(palette.dim("  ◌ Waiting for model output"));
    }
    if (rows.length === 1) rows.length = 0;
    let visible = rows;
    if (this.maxRows !== undefined && rows.length > this.maxRows) {
      visible =
        this.maxRows === 0
          ? []
          : this.maxRows === 1
            ? rows.slice(-1)
            : [
                palette.dim("  … earlier streaming output hidden"),
                ...rows.slice(-(this.maxRows - 1)),
              ];
    }
    this.cache = {
      width,
      thinkingDisplay,
      ...(this.maxRows === undefined ? {} : { maxRows: this.maxRows }),
      rows: visible,
    };
    return [...visible];
  }

  private resetContent(): void {
    this.textChunks.length = 0;
    this.thinkingChunks.length = 0;
    this.textCharacters = 0;
    this.thinkingCharacters = 0;
    this.textStart = 0;
    this.thinkingStart = 0;
  }

  private setChunks(chunks: string[], value: string, kind: "text" | "thinking"): void {
    chunks.length = 0;
    if (kind === "text") {
      this.textCharacters = 0;
      this.textStart = 0;
    } else {
      this.thinkingCharacters = 0;
      this.thinkingStart = 0;
    }
    this.appendChunk(chunks, value, kind);
  }

  private appendChunk(chunks: string[], value: string, kind: "text" | "thinking"): void {
    if (!value) return;
    chunks.push(value);
    let count = (kind === "text" ? this.textCharacters : this.thinkingCharacters) + value.length;
    let start = kind === "text" ? this.textStart : this.thinkingStart;
    while (count > MAX_VISIBLE_CHARACTERS && start < chunks.length) {
      const first = chunks[start] as string;
      const excess = count - MAX_VISIBLE_CHARACTERS;
      if (first.length <= excess) {
        start += 1;
        count -= first.length;
      } else {
        chunks[start] = first.slice(excess);
        count -= excess;
      }
    }
    if (start > 1024) {
      chunks.splice(0, start);
      start = 0;
    }
    if (kind === "text") {
      this.textCharacters = count;
      this.textStart = start;
    } else {
      this.thinkingCharacters = count;
      this.thinkingStart = start;
    }
  }
}
