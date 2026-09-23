// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { TerminalCustomComponent, TerminalLine } from "@axl/extension-api";

import { dialogInnerWidth, renderDialog } from "./dialog.ts";
import { decodeOneKey, LineEditor } from "./editor.ts";
import type { Overlay } from "./overlay.ts";
import { sanitizeTerminalText, truncateToWidth } from "./render.ts";
import type { Palette } from "./transcript.ts";

const MAX_INPUT_LENGTH = 16_384;

/** Bounded, focus-owning input or multiline editor for extension prompts. */
export class ExtensionTextPrompt implements Overlay {
  private readonly editor = new LineEditor();
  private readonly title: string;
  private readonly placeholder: string;
  private readonly multiline: boolean;
  private readonly palette: () => Palette;
  private readonly finish: (value: string | undefined) => void;
  private readonly refresh: () => void;
  private settled = false;
  private position = { row: 4, column: 4 };

  constructor(options: {
    title: string;
    placeholder?: string;
    prefill?: string;
    multiline: boolean;
    palette: () => Palette;
    finish: (value: string | undefined) => void;
    refresh: () => void;
  }) {
    this.title = options.title;
    this.placeholder = options.placeholder ?? "";
    this.multiline = options.multiline;
    this.palette = options.palette;
    this.finish = options.finish;
    this.refresh = options.refresh;
    this.editor.setText(options.prefill ?? "");
  }

  render(width: number): string[] {
    const inner = dialogInnerWidth(width);
    const view = this.editor.render(Math.max(1, inner - 2));
    const rows = view.lines.map((line) => `> ${line}`);
    if (!this.editor.text && this.placeholder)
      rows[0] = `> ${this.palette().dim(truncateToWidth(sanitizeTerminalText(this.placeholder).replace(/\s+/gu, " "), Math.max(1, inner - 2)))}`;
    this.position = { row: 4 + view.cursorRow, column: 4 + view.cursorColumn };
    return renderDialog({
      title: sanitizeTerminalText(this.title).replace(/\s+/gu, " "),
      rows,
      footer: this.multiline
        ? "Enter accept · Alt+Enter newline · Esc cancel"
        : "Enter accept · Esc cancel",
      width,
      palette: this.palette(),
    });
  }

  cursor(): { row: number; column: number } {
    return this.position;
  }

  handleKey(data: string): void {
    for (let index = 0; index < data.length; ) {
      const { key, next } = decodeOneKey(data, index);
      index = next;
      if (key.kind === "escape" || (key.kind === "ctrl" && key.char === "c")) {
        this.complete(undefined);
        return;
      }
      if (key.kind === "enter") {
        this.complete(this.editor.text);
        return;
      }
      if (key.kind === "follow-up") {
        if (this.multiline && this.editor.text.length < MAX_INPUT_LENGTH)
          this.editor.apply({ kind: "newline" });
        continue;
      }
      if (!this.multiline && key.kind === "newline") continue;
      if (
        this.editor.text.length >= MAX_INPUT_LENGTH &&
        (key.kind === "char" || key.kind === "newline")
      )
        continue;
      this.editor.apply(key);
    }
    this.refresh();
  }

  paste(text: string): void {
    this.editor.insertText(
      sanitizeTerminalText(text)
        .slice(0, Math.max(0, MAX_INPUT_LENGTH - this.editor.text.length))
        .replace(this.multiline ? /\r\n?/gu : /\r?\n/gu, this.multiline ? "\n" : " "),
    );
    this.refresh();
  }

  dispose(): void {
    this.complete(undefined);
  }

  private complete(value: string | undefined): void {
    if (this.settled) return;
    this.settled = true;
    this.finish(value);
  }
}

/** Presents extension-owned content inside the same bounded dialog frame as built-in prompts. */
export class ExtensionCustomPrompt implements Overlay {
  private readonly component: TerminalCustomComponent;
  private readonly title: string;
  private readonly palette: () => Palette;
  private readonly cancel: () => void;
  private disposed = false;
  constructor(
    component: TerminalCustomComponent,
    title: string,
    palette: () => Palette,
    cancel: () => void,
  ) {
    this.component = component;
    this.title = title;
    this.palette = palette;
    this.cancel = cancel;
  }
  render(width: number): string[] {
    const palette = this.palette();
    let output: readonly TerminalLine[];
    try {
      output = this.component.render(dialogInnerWidth(width));
      if (!Array.isArray(output) || output.some((line) => typeof line?.text !== "string"))
        throw new TypeError("Custom component must return terminal lines");
    } catch (error) {
      output = [
        {
          text: `Custom component failed: ${error instanceof Error ? error.message : String(error)}`,
          tone: "error",
        },
      ];
    }
    const rows = output.slice(0, 64).map((line: TerminalLine) => {
      const text = truncateToWidth(
        sanitizeTerminalText(line.text).replace(/\s+/gu, " "),
        Math.max(1, width - 4),
      );
      if (line.tone === "error") return palette.error(text);
      if (line.tone === "accent") return palette.accent(text);
      if (line.tone === "warning") return (palette.warning ?? palette.accent)(text);
      if (line.tone === "success") return (palette.success ?? palette.accent)(text);
      return line.tone === "muted" ? palette.dim(text) : text;
    });
    return renderDialog({
      title: sanitizeTerminalText(this.title).replace(/\s+/gu, " "),
      rows,
      width,
      palette,
      footer: "Esc cancel",
    });
  }
  cursor(): { row: number; column: number } | undefined {
    const position = this.component.cursor?.();
    return position === undefined ||
      !Number.isSafeInteger(position.row) ||
      !Number.isSafeInteger(position.column)
      ? undefined
      : {
          row: 4 + Math.max(0, Math.min(63, position.row)),
          column: 2 + Math.max(0, position.column),
        };
  }
  handleKey(data: string): void {
    this.component.handleKey(data);
    if (!this.disposed && (data === "\x1b" || data === "\x03")) this.cancel();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.component.dispose?.();
    } finally {
      this.cancel();
    }
  }
}
