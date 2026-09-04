// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { Component } from "./render.ts";

/** Retained vertical component stack used as the regular-mode live root. */
export class ComponentStack implements Component {
  private children: readonly Component[] = [];
  private readonly offsets = new Map<Component, number>();

  replace(children: readonly Component[]): void {
    this.children = [...children];
  }

  render(width: number): string[] {
    const lines: string[] = [];
    this.offsets.clear();
    for (const child of this.children) {
      this.offsets.set(child, lines.length);
      for (const line of child.render(width)) lines.push(line);
    }
    return lines;
  }

  offsetOf(child: Component): number {
    const offset = this.offsets.get(child);
    if (offset === undefined) throw new Error("Component has not been rendered in this stack");
    return offset;
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate?.();
  }
}
