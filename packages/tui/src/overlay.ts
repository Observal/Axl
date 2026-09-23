// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { Component, CursorPlacement } from "./render.ts";

export interface Overlay {
  render(width: number): string[];
  handleKey(data: string): void;
  paste?(text: string): void;
  cursor?(): CursorPlacement | undefined;
  dispose?(): void;
}

/** A separate highest-priority slot for daemon-authoritative attention. */
export class AttentionOverlaySlot implements Component {
  private entry: Overlay | undefined;

  get active(): Overlay | undefined {
    return this.entry;
  }

  replace(overlay: Overlay): void {
    this.clear();
    this.entry = overlay;
  }

  clear(): void {
    const previous = this.entry;
    this.entry = undefined;
    previous?.dispose?.();
  }

  handleInput(data: string): void {
    this.entry?.handleKey(data);
  }

  paste(text: string): boolean {
    if (this.entry?.paste === undefined) return false;
    this.entry.paste(text);
    return true;
  }

  cursorPlacement(): CursorPlacement | undefined {
    return this.entry?.cursor?.();
  }

  render(width: number): string[] {
    return this.entry?.render(width) ?? [];
  }
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

  paste(text: string): boolean {
    const overlay = this.active;
    if (overlay?.paste === undefined) return false;
    overlay.paste(text);
    return true;
  }

  cursorPlacement(): CursorPlacement | undefined {
    return this.active?.cursor?.();
  }

  render(width: number): string[] {
    return this.active?.render(width) ?? [];
  }
}
