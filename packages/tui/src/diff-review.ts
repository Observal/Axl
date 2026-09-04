// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { decodeOneKey } from "./editor.ts";
import type { Overlay } from "./overlay.ts";
import { sanitizeTerminalText, truncateToWidth, visibleWidth } from "./render.ts";
import type { Palette } from "./transcript.ts";

export type DiffLayout = "unified" | "split";
export type WorkspaceReviewScope = "working" | "last-turn";

export interface WorkspaceReviewFile {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
  readonly truncated: boolean;
}

export interface WorkspaceReview {
  readonly scope: WorkspaceReviewScope;
  readonly checkpointId?: string;
  readonly files: readonly WorkspaceReviewFile[];
}

export interface DiffReviewOptions {
  readonly initial: WorkspaceReview;
  readonly layout: DiffLayout;
  readonly palette: () => Palette;
  readonly width: () => number;
  readonly height: () => number;
  readonly load: (scope: WorkspaceReviewScope) => Promise<WorkspaceReview>;
  readonly onLayout: (layout: DiffLayout) => void;
  readonly onClose: () => void;
  readonly refresh: () => void;
}

function fit(value: string, width: number): string {
  const clean = truncateToWidth(sanitizeTerminalText(value), width, "");
  return `${clean}${" ".repeat(Math.max(0, width - visibleWidth(clean)))}`;
}

function colored(line: string, palette: Palette): string {
  if (line.startsWith("+") && !line.startsWith("+++"))
    return palette.success?.(line) ?? palette.accent(line);
  if (line.startsWith("-") && !line.startsWith("---")) return palette.error(line);
  if (line.startsWith("@@")) return palette.accent(line);
  if (line.startsWith("diff ") || line.startsWith("---") || line.startsWith("+++"))
    return palette.dim(line);
  return line;
}

function unifiedRows(file: WorkspaceReviewFile, width: number, palette: Palette): string[] {
  return sanitizeTerminalText(file.patch)
    .split("\n")
    .map((line) => colored(truncateToWidth(line, width, ""), palette));
}

function splitRows(file: WorkspaceReviewFile, width: number, palette: Palette): string[] {
  const gap = " │ ";
  const column = Math.max(8, Math.floor((width - visibleWidth(gap)) / 2));
  return sanitizeTerminalText(file.patch)
    .split("\n")
    .filter((line) => !line.startsWith("diff ") && !line.startsWith("index "))
    .map((line) => {
      const left = line.startsWith("+") && !line.startsWith("+++") ? "" : line;
      const right = line.startsWith("-") && !line.startsWith("---") ? "" : line;
      return `${colored(fit(left, column), palette)}${palette.dim(gap)}${colored(fit(right, column), palette)}`;
    });
}

/** Full-screen keyboard review over a bounded daemon-provided workspace diff. */
export class DiffReviewOverlay implements Overlay {
  private readonly options: DiffReviewOptions;
  private diff: WorkspaceReview;
  private layout: DiffLayout;
  private fileIndex = 0;
  private scroll = 0;
  private loading = false;
  private error: string | undefined;
  private readonly reviewed = new Set<string>();

  constructor(options: DiffReviewOptions) {
    this.options = options;
    this.diff = options.initial;
    this.layout = options.layout;
  }

  render(width: number): string[] {
    const palette = this.options.palette();
    const height = Math.max(12, this.options.height());
    const contentWidth = Math.max(20, width - 4);
    const file = this.diff.files[this.fileIndex];
    const title = `Review · ${this.diff.scope === "working" ? "working tree" : "last turn"}`;
    const summary = this.diff.files.reduce(
      (total, item) => ({
        additions: total.additions + item.additions,
        deletions: total.deletions + item.deletions,
      }),
      { additions: 0, deletions: 0 },
    );
    const maxFileRows = Math.max(1, Math.min(6, height - 8));
    const fileStart = Math.max(
      0,
      Math.min(this.fileIndex - 2, Math.max(0, this.diff.files.length - maxFileRows)),
    );
    const fileRows = this.diff.files
      .slice(fileStart, fileStart + maxFileRows)
      .map((item, offset) => {
        const index = fileStart + offset;
        const selected = index === this.fileIndex ? ">" : " ";
        const reviewed = this.reviewed.has(item.path) ? "✓" : "·";
        const stats = `${palette.success?.(`+${item.additions}`) ?? `+${item.additions}`} ${palette.error(`-${item.deletions}`)}`;
        return truncateToWidth(`${selected} ${reviewed} ${item.path}  ${stats}`, contentWidth, "");
      });
    const patchRows = file
      ? this.layout === "split" && contentWidth >= 76
        ? splitRows(file, contentWidth, palette)
        : unifiedRows(file, contentWidth, palette)
      : [palette.dim("No workspace changes")];
    const statusRows =
      Number(file?.truncated ?? false) + Number(this.loading) + Number(!!this.error);
    const available = Math.max(1, height - fileRows.length - statusRows - 5);
    this.scroll = Math.min(this.scroll, Math.max(0, patchRows.length - available));
    const body = patchRows.slice(this.scroll, this.scroll + available);
    const border = palette.border ?? palette.dim;
    const line = border("─".repeat(Math.max(1, width - 2)));
    return [
      `${border("╭")}${line}${border("╮")}`,
      `  ${palette.accent(title)}  ${palette.dim(`${this.diff.files.length} files`)}  ${palette.success?.(`+${summary.additions}`) ?? `+${summary.additions}`} ${palette.error(`-${summary.deletions}`)}`,
      ...fileRows.map((row) => `  ${row}`),
      `  ${border("─".repeat(contentWidth))}`,
      ...body.map((row) => `  ${row}`),
      ...(file?.truncated
        ? [`  ${palette.warning?.("Patch truncated") ?? palette.error("Patch truncated")}`]
        : []),
      ...(this.loading ? [`  ${palette.dim("Loading review…")}`] : []),
      ...(this.error ? [`  ${palette.error(`✖ ${this.error}`)}`] : []),
      `  ${palette.dim("↑↓ scroll · n/p file · [/] hunk · Space reviewed · s scope · v layout · Esc close")}`,
      `${border("╰")}${line}${border("╯")}`,
    ].slice(0, height);
  }

  handleKey(data: string): void {
    for (let at = 0; at < data.length; ) {
      const decoded = decodeOneKey(data, at);
      const key = decoded.key;
      at = decoded.next;
      if (key.kind === "escape" || (key.kind === "ctrl" && key.char === "c")) {
        this.options.onClose();
        return;
      }
      if (key.kind === "up") this.scroll = Math.max(0, this.scroll - 1);
      else if (key.kind === "down") this.scroll += 1;
      else if (key.kind === "char") this.handleCharacter(key.char);
    }
    this.options.refresh();
  }

  private handleCharacter(char: string): void {
    if (char === "j") this.scroll += 1;
    else if (char === "k") this.scroll = Math.max(0, this.scroll - 1);
    else if (char === "n") this.moveFile(1);
    else if (char === "p") this.moveFile(-1);
    else if (char === "]") this.moveHunk(1);
    else if (char === "[") this.moveHunk(-1);
    else if (char === " ") {
      const file = this.diff.files[this.fileIndex];
      if (file) {
        if (this.reviewed.has(file.path)) this.reviewed.delete(file.path);
        else this.reviewed.add(file.path);
      }
    } else if (char === "v") {
      this.layout = this.layout === "unified" ? "split" : "unified";
      this.options.onLayout(this.layout);
      this.scroll = 0;
    } else if (char === "s") void this.changeScope();
  }

  private moveFile(delta: number): void {
    if (this.diff.files.length === 0) return;
    this.fileIndex = (this.fileIndex + delta + this.diff.files.length) % this.diff.files.length;
    this.scroll = 0;
  }

  private moveHunk(direction: 1 | -1): void {
    const file = this.diff.files[this.fileIndex];
    if (!file) return;
    const lines = sanitizeTerminalText(file.patch).split("\n");
    const hunks = lines.flatMap((line, index) => (line.startsWith("@@") ? [index] : []));
    if (hunks.length === 0) return;
    const next =
      direction === 1
        ? hunks.find((index) => index > this.scroll)
        : hunks.toReversed().find((index) => index < this.scroll);
    this.scroll = next ?? (direction === 1 ? (hunks[0] as number) : (hunks.at(-1) as number));
  }

  private async changeScope(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = undefined;
    this.options.refresh();
    const scope: WorkspaceReviewScope = this.diff.scope === "working" ? "last-turn" : "working";
    try {
      this.diff = await this.options.load(scope);
      this.fileIndex = 0;
      this.scroll = 0;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Workspace review failed";
    } finally {
      this.loading = false;
      this.options.refresh();
    }
  }
}
