// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { Component } from "./render.ts";
import { truncateToWidth } from "./render.ts";
import type { Palette } from "./transcript.ts";

export interface ActivityState {
  readonly working: boolean;
  readonly label?: string;
  readonly spinner: string;
  readonly elapsedSeconds: number;
  readonly queued: number;
}

/** Prominent activity row kept outside the editor frame. */
export class ActivityComponent implements Component {
  private readonly palette: () => Palette;
  private state: ActivityState = { working: false, spinner: "", elapsedSeconds: 0, queued: 0 };
  private cachedWidth: number | undefined;
  private cachedLine: string | undefined;

  constructor(palette: () => Palette) {
    this.palette = palette;
  }

  update(state: ActivityState): void {
    if (
      state.working === this.state.working &&
      state.label === this.state.label &&
      state.spinner === this.state.spinner &&
      state.elapsedSeconds === this.state.elapsedSeconds &&
      state.queued === this.state.queued
    )
      return;
    this.state = state;
    this.invalidate();
  }

  render(width: number): string[] {
    if (!this.state.working) return [];
    if (this.cachedWidth === width && this.cachedLine !== undefined) return ["", this.cachedLine];
    const palette = this.palette();
    const label = (palette.bold ?? palette.accent)(this.state.label ?? "Working");
    const elapsed = palette.dim(
      `${this.state.elapsedSeconds}s${this.state.queued > 0 ? ` · ${this.state.queued} queued` : ""}`,
    );
    this.cachedLine = truncateToWidth(
      `  ${palette.accent(this.state.spinner)}  ${label}  ${elapsed}`,
      width,
      "",
    );
    this.cachedWidth = width;
    return ["", this.cachedLine];
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLine = undefined;
  }
}
