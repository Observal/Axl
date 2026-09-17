// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { dialogInnerWidth, renderDialog } from "./dialog.ts";
import { decodeOneKey } from "./editor.ts";
import { type PickerItem, PickerOverlay } from "./picker.ts";
import { sanitizeTerminalText, visibleWidth, wrapLine } from "./render.ts";
import type { Palette } from "./transcript.ts";

export interface ProviderLoginPrompt {
  readonly message: string;
  readonly placeholder?: string;
  readonly mask?: boolean;
  readonly allowEmpty?: boolean;
  readonly options?: readonly PickerItem[];
  readonly signal?: AbortSignal;
}

/** Presentation callbacks only, supplied to the trusted host. Never sent over RPC. */
export interface ProviderLoginPresentation {
  prompt(prompt: ProviderLoginPrompt): Promise<string>;
  notify(message: string): void;
}

export class ProviderLoginOverlay implements ProviderLoginPresentation {
  private value = "";
  private disposed = false;
  private pending: ProviderLoginPrompt | undefined;
  private settle: ((value?: string) => void) | undefined;
  private picker: PickerOverlay | undefined;
  private message = "Waiting for provider…";
  private position: { row: number; column: number } | undefined;

  private readonly options: {
    readonly title: string;
    readonly palette: () => Palette;
    readonly signal: AbortSignal;
    readonly cancel: () => void;
    readonly refresh: () => void;
  };

  constructor(options: ProviderLoginOverlay["options"]) {
    this.options = options;
  }

  prompt(prompt: ProviderLoginPrompt): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("Login dialog is closed"));
    if (this.pending) return Promise.reject(new Error("A login prompt is already active"));
    const signal =
      prompt.signal === undefined
        ? this.options.signal
        : AbortSignal.any([this.options.signal, prompt.signal]);
    signal.throwIfAborted();
    this.pending = prompt;
    this.value = "";
    return new Promise((resolve, reject) => {
      const abort = () => this.settle?.();
      this.settle = (value) => {
        signal.removeEventListener("abort", abort);
        this.pending = undefined;
        this.picker = undefined;
        this.value = "";
        this.settle = undefined;
        if (value === undefined) reject(new DOMException("Login cancelled", "AbortError"));
        else resolve(value);
        this.options.refresh();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (prompt.options) {
        this.picker = new PickerOverlay({
          title: sanitizeTerminalText(prompt.message),
          items: prompt.options.map((item) => ({
            ...item,
            label: sanitizeTerminalText(item.label),
            ...(item.description === undefined
              ? {}
              : { description: sanitizeTerminalText(item.description) }),
          })),
          current: prompt.options[0]?.value ?? "",
          palette: this.options.palette,
          onPick: (value) => this.settle?.(value),
          onCancel: this.options.cancel,
        });
      }
      this.options.refresh();
    });
  }

  notify(message: string): void {
    if (this.disposed) return;
    this.message = sanitizeTerminalText(message);
    this.options.refresh();
  }

  render(width: number): string[] {
    if (this.picker) return this.picker.render(width);
    const palette = this.options.palette();
    const prompt = this.pending;
    const inner = dialogInnerWidth(width);
    const rows = prompt
      ? [
          ...(this.message === "Waiting for provider…"
            ? []
            : this.message.split("\n").flatMap((line) => wrapLine(line, inner))),
          ...wrapLine(sanitizeTerminalText(prompt.message), inner),
          ...(prompt.placeholder === undefined
            ? []
            : wrapLine(palette.dim(sanitizeTerminalText(prompt.placeholder)), inner)),
          ...wrapLine(`> ${prompt.mask ? "*".repeat([...this.value].length) : this.value}`, inner),
        ]
      : this.message.split("\n").flatMap((line) => wrapLine(line, inner));
    this.position = prompt
      ? {
          row: 4 + rows.length - 1,
          column: Math.min(width - 1, 2 + visibleWidth(rows.at(-1) ?? "")),
        }
      : undefined;
    return renderDialog({
      title: this.options.title,
      rows,
      footer: prompt ? "escape/ctrl+c cancel · enter submit" : "escape/ctrl+c cancel",
      width,
      palette,
    });
  }

  cursor(): { row: number; column: number } | undefined {
    return this.picker?.cursor() ?? this.position;
  }

  paste(text: string): void {
    if (!this.pending || this.picker) return;
    this.value += sanitizeTerminalText(text).slice(0, Math.max(0, 16_384 - this.value.length));
    this.options.refresh();
  }

  handleKey(data: string): void {
    if (this.picker) {
      this.picker.handleKey(data);
      return;
    }
    for (let at = 0; at < data.length; ) {
      const { key, next } = decodeOneKey(data, at);
      at = next;
      if (
        key.kind === "escape" ||
        (key.kind === "ctrl" && (key.char === "c" || key.char === "d"))
      ) {
        this.options.cancel();
        return;
      }
      if (!this.pending) continue;
      if (key.kind === "enter") {
        const value = this.value.trim();
        if (value || this.pending.allowEmpty) this.settle?.(value);
        return;
      }
      if (key.kind === "backspace") {
        const segments = [...new Intl.Segmenter().segment(this.value)];
        this.value = this.value.slice(0, segments.at(-1)?.index ?? 0);
      } else if (key.kind === "char" && this.value.length < 16_384) {
        this.value += sanitizeTerminalText(key.char);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.options.cancel();
    this.settle?.();
    this.message = "";
    this.value = "";
  }
}
