// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { renderDialog } from "./dialog.ts";
import { decodeOneKey } from "./editor.ts";
import type { CursorPlacement } from "./render.ts";
import type { Palette } from "./transcript.ts";

export interface LoginDialogField {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
  readonly example?: string;
  readonly mask?: boolean;
  readonly optional?: boolean;
  readonly initialValue?: string;
  readonly validate?: (value: string) => string | undefined;
}

export type LoginDialogResult =
  | { readonly ok: true; readonly summary: string }
  | {
      readonly ok: false;
      readonly message: string;
      readonly fieldId?: string;
      readonly clearField?: boolean;
    };

export interface LoginDialogDefinition {
  readonly title: string;
  readonly fields: readonly LoginDialogField[];
  readonly verifyingMessage?: string;
  readonly submit: (values: Readonly<Record<string, string>>) => Promise<LoginDialogResult>;
}

export interface LoginDialogOptions {
  readonly definition: LoginDialogDefinition;
  readonly palette: Palette;
  readonly width: number;
  readonly refresh: () => void;
  readonly close: (summary: string) => void;
}

type FieldState = LoginDialogField & { value: string };

/** Provider-neutral credential dialog supplied by a process-host adapter. */
export class LoginDialog {
  private readonly options: LoginDialogOptions;
  private readonly fields: FieldState[];
  private active = 0;
  private message: string | undefined;
  private verifying = false;

  constructor(options: LoginDialogOptions) {
    if (options.definition.fields.length === 0) {
      throw new Error("Login dialog requires at least one field");
    }
    this.options = options;
    this.fields = options.definition.fields.map((field) => ({
      ...field,
      value: field.initialValue ?? "",
    }));
  }

  render(width = this.options.width): string[] {
    const { palette } = this.options;
    const { dim, accent, error } = palette;
    const field = this.fields[this.active] as FieldState;
    const shown = field.mask ? "*".repeat(field.value.length) : field.value;
    const rows = this.verifying
      ? [dim(this.options.definition.verifyingMessage ?? "Verifying credentials…")]
      : [
          field.prompt,
          `${accent(">")} ${shown}`,
          ...(field.example === undefined ? [] : [dim(field.example)]),
          ...(this.message === undefined ? [] : [error(this.message)]),
        ];
    return renderDialog({
      title: this.options.definition.title,
      rows,
      footer: this.verifying ? "verifying…" : "escape/ctrl+c cancel · enter continue",
      width,
      palette,
    });
  }

  cursor(): CursorPlacement | undefined {
    if (this.verifying) return undefined;
    const field = this.fields[this.active] as FieldState;
    return { row: 5, column: 4 + field.value.length };
  }

  handleKey(data: string): void {
    if (this.verifying) return;
    const field = this.fields[this.active] as FieldState;
    let index = 0;
    while (index < data.length) {
      const { key, next } = decodeOneKey(data, index);
      index = next;
      if (
        key.kind === "escape" ||
        (key.kind === "ctrl" && (key.char === "c" || key.char === "d"))
      ) {
        this.options.close("· login cancelled");
        return;
      }
      if (key.kind === "backspace") {
        field.value = field.value.slice(0, -1);
      } else if (key.kind === "char") {
        field.value += key.char;
      } else if (key.kind === "up") {
        this.active = Math.max(0, this.active - 1);
        return;
      } else if (key.kind === "enter") {
        this.advance();
        return;
      }
    }
  }

  private advance(): void {
    const field = this.fields[this.active] as FieldState;
    this.message = undefined;
    if (field.value.trim().length === 0 && !field.optional) {
      this.message = `${field.label.trim()} is required`;
      return;
    }
    const validationError = field.validate?.(field.value);
    if (validationError !== undefined) {
      this.message = validationError;
      return;
    }
    if (this.active < this.fields.length - 1) {
      this.active += 1;
      return;
    }
    void this.finish();
  }

  private async finish(): Promise<void> {
    this.verifying = true;
    this.options.refresh();
    const values = Object.fromEntries(this.fields.map((field) => [field.id, field.value]));
    try {
      const result = await this.options.definition.submit(values);
      if (result.ok) {
        this.options.close(result.summary);
        return;
      }
      this.verifying = false;
      this.message = result.message;
      if (result.fieldId !== undefined) {
        const index = this.fields.findIndex((field) => field.id === result.fieldId);
        if (index >= 0) {
          this.active = index;
          if (result.clearField) (this.fields[index] as FieldState).value = "";
        }
      }
      this.options.refresh();
    } catch (cause) {
      this.verifying = false;
      this.message = cause instanceof Error ? cause.message : "login failed";
      this.options.refresh();
    }
  }
}
