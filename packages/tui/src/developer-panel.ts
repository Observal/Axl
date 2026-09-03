// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceReview } from "./diff-review.ts";
import type { Component } from "./render.ts";
import { truncateToWidth, visibleWidth } from "./render.ts";
import type { Palette } from "./transcript.ts";

export interface DeveloperPanelState {
  readonly sessionId: string;
  readonly branch?: string;
  readonly sandbox?: string;
  readonly connection: string;
  readonly phase: string;
  readonly diff?: WorkspaceReview;
  readonly error?: string;
}

/** Optional wide workspace summary. It renders nothing below its safe width. */
export class DeveloperPanelComponent implements Component {
  private state: DeveloperPanelState;
  private readonly palette: () => Palette;

  constructor(initial: DeveloperPanelState, palette: () => Palette) {
    this.state = initial;
    this.palette = palette;
  }

  update(state: DeveloperPanelState): void {
    this.state = state;
  }

  render(width: number): string[] {
    if (width < 100) return [];
    const palette = this.palette();
    const border = palette.border ?? palette.dim;
    const inside = width - 4;
    const diff = this.state.diff;
    const additions = diff?.files.reduce((total, file) => total + file.additions, 0) ?? 0;
    const deletions = diff?.files.reduce((total, file) => total + file.deletions, 0) ?? 0;
    const changed = diff?.files.length ?? 0;
    const body = [
      `session ${this.state.sessionId.slice(0, 8)}  branch ${this.state.branch ?? "?"}  ${this.state.connection}  ${this.state.phase}`,
      this.state.error
        ? `workspace review unavailable: ${this.state.error}`
        : `${changed} changed file${changed === 1 ? "" : "s"}  +${additions} -${deletions}  sandbox ${this.state.sandbox ?? "?"}`,
    ];
    return [
      "",
      `${border("╭")} ${palette.accent("Workspace")} ${border("─".repeat(Math.max(0, width - 13)))}${border("╮")}`,
      ...body.map((value) => {
        const clipped = truncateToWidth(value, inside, "");
        return `${border("│")} ${clipped}${" ".repeat(Math.max(0, inside - visibleWidth(clipped)))} ${border("│")}`;
      }),
      `${border("╰")}${border("─".repeat(Math.max(0, width - 2)))}${border("╯")}`,
    ];
  }
}
