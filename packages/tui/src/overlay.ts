// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { Component, CursorPlacement } from "./render.ts";

export interface Overlay {
  render(width: number): string[];
  handleKey(data: string): void;
  cursor?(): CursorPlacement | undefined;
  dispose?(): void;
}

/** Retained overlay stack with one explicit keyboard-focus owner. */
export class OverlayStack implements Component {
  private readonly entries: Overlay[] = [];

  get active(): Overlay | undefined {
    return this.entries.at(-1);
  }

  get size(): number {
    return this.entries.length;
  }

  current(): Overlay | undefined {
    return this.entries.at(-1);
  }

  push(overlay: Overlay): void {
    this.entries.push(overlay);
  }

  replace(overlay: Overlay): void {
    this.clear();
    this.push(overlay);
  }

  close(): Overlay | undefined {
    const overlay = this.entries.pop();
    overlay?.dispose?.();
    return overlay;
  }

  clear(): void {
    while (this.entries.length > 0) this.close();
  }

  handleInput(data: string): void {
    this.active?.handleKey(data);
  }

  cursorPlacement(): CursorPlacement | undefined {
    return this.active?.cursor?.();
  }

  render(width: number): string[] {
    return this.active?.render(width) ?? [];
  }
}
