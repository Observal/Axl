// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

// Full-width terminal panel used by selectors, approvals, and login flows.

import { wrapLine } from "./render.ts";
import type { Palette } from "./transcript.ts";

export interface DialogInput {
  readonly title: string;
  /** Pre-styled content rows; overlong rows wrap inside the panel. */
  readonly rows: readonly string[];
  readonly footer?: string;
  /** Total terminal width available. */
  readonly width: number;
  readonly palette: Palette;
}

/** Inner content width for a dialog at the given terminal width. */
export function dialogInnerWidth(width: number): number {
  return Math.max(1, width - 4);
}

/** Renders a panel with horizontal rules and open content. */
export function renderDialog(input: DialogInput): string[] {
  const { title, rows, footer, width, palette } = input;
  const inner = dialogInnerWidth(width);
  const border = (palette.border ?? palette.dim)("─".repeat(Math.max(1, width - 2)));
  const content = rows.flatMap((row) =>
    row.length === 0 ? [""] : wrapLine(row, inner).map((line) => `  ${line}`),
  );
  return [
    border,
    "",
    ...(title ? [`  ${palette.accent((palette.bold ?? ((text) => text))(title))}`, ""] : []),
    ...content,
    ...(footer === undefined ? [] : ["", `  ${palette.dim(footer)}`]),
    "",
    border,
  ];
}
