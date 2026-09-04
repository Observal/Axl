// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { dialogInnerWidth, renderDialog } from "./dialog.ts";
import { decodeOneKey } from "./editor.ts";
import type { Overlay } from "./overlay.ts";
import { truncateToWidth, visibleWidth } from "./render.ts";
import type { Palette } from "./transcript.ts";

const DEFAULT_WINDOW = 10;

export interface PickerItem {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface PickerOptions {
  readonly title: string;
  readonly items: readonly PickerItem[];
  readonly current: string;
  readonly palette: () => Palette;
  readonly onPick: (value: string) => void;
  readonly onCancel: () => void;
  readonly onHighlight?: (value: string) => void;
  readonly preview?: (width: number) => readonly string[];
  readonly windowSize?: number;
}

/** Shared searchable selector for model, thinking, theme, and future command lists. */
export class PickerOverlay implements Overlay {
  private readonly options: PickerOptions;
  private readonly windowSize: number;
  private filter = "";
  private index: number;

  constructor(options: PickerOptions) {
    this.options = options;
    this.windowSize = Math.max(1, options.windowSize ?? DEFAULT_WINDOW);
    this.index = Math.max(
      0,
      options.items.findIndex((item) => item.value === options.current),
    );
  }

  render(width: number): string[] {
    const palette = this.options.palette();
    const list = this.filtered();
    this.index = Math.min(this.index, Math.max(0, list.length - 1));
    const start = Math.max(
      0,
      Math.min(this.index - Math.floor(this.windowSize / 2), list.length - this.windowSize),
    );
    const visible = list.slice(start, start + this.windowSize);
    const innerWidth = dialogInnerWidth(width);
    const labelWidth = Math.min(
      22,
      Math.max(1, ...visible.map((item) => visibleWidth(item.label))),
    );
    const itemLine = (item: PickerItem, selected: boolean): string => {
      const label = truncateToWidth(item.label, labelWidth, "");
      const paddedLabel = `${label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)))}`;
      const description = item.description ? `  ${palette.dim(item.description)}` : "";
      const marker = selected ? "›" : " ";
      const line = truncateToWidth(`${marker} ${paddedLabel}${description}`, innerWidth, "");
      const padded = `${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))}`;
      return selected ? (palette.selection ?? palette.accent)(padded) : padded;
    };
    return renderDialog({
      title: this.options.title,
      rows: [
        `${palette.accent(">")} ${this.filter}`,
        "",
        ...(start > 0 ? [palette.dim(`  ↑ ${start} more`)] : []),
        ...visible.map((item, position) => itemLine(item, start + position === this.index)),
        ...(list.length === 0 ? [palette.dim("  no matches")] : []),
        ...(this.options.preview === undefined ? [] : ["", ...this.options.preview(innerWidth)]),
        ...(start + this.windowSize < list.length
          ? [palette.dim(`  ↓ ${list.length - start - this.windowSize} more`)]
          : []),
      ],
      footer: `${list.length}/${this.options.items.length} · ↑↓ move · Enter select · Esc close`,
      width,
      palette,
    });
  }

  cursor(): { row: number; column: number } {
    return { row: 1, column: 4 + visibleWidth(this.filter) };
  }

  handleKey(data: string): void {
    for (let at = 0; at < data.length; ) {
      const decoded = decodeOneKey(data, at);
      at = decoded.next;
      const key = decoded.key;
      const list = this.filtered();
      if (key.kind === "up") {
        this.index = (this.index - 1 + Math.max(1, list.length)) % Math.max(1, list.length);
        this.previewSelection();
      } else if (key.kind === "down") {
        this.index = (this.index + 1) % Math.max(1, list.length);
        this.previewSelection();
      } else if (key.kind === "enter") {
        const selected = list[this.index];
        if (selected) this.options.onPick(selected.value);
      } else if (key.kind === "escape" || (key.kind === "ctrl" && key.char === "c")) {
        this.options.onCancel();
      } else if (key.kind === "backspace") {
        this.filter = this.filter.slice(0, -1);
        this.index = 0;
        this.previewSelection();
      } else if (key.kind === "char") {
        if (/^[1-9]$/.test(key.char) && !this.filter && Number(key.char) <= list.length) {
          this.options.onPick((list[Number(key.char) - 1] as PickerItem).value);
        } else {
          this.filter += key.char;
          this.index = 0;
          this.previewSelection();
        }
      }
    }
  }

  private previewSelection(): void {
    const selected = this.filtered()[this.index];
    if (selected !== undefined) this.options.onHighlight?.(selected.value);
  }

  private filtered(): readonly PickerItem[] {
    if (!this.filter) return this.options.items;
    const query = this.filter.toLowerCase();
    return this.options.items.filter(
      (item) =>
        item.value.toLowerCase().includes(query) || item.label.toLowerCase().includes(query),
    );
  }
}
