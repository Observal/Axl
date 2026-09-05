// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { OwnedTerminalToolRenderer } from "@axl/extension-api";
import type { BlobReference, CanonicalEvent, EventPayloadMap } from "@axl/protocol";

import type { Component } from "./render.ts";
import { sanitizeTerminalText, truncateToWidth } from "./render.ts";
import { renderToolTransaction, type ToolTransactionStatus } from "./tool-display.ts";
import type { BlobRenderer, Palette, ToolOutputDisplay } from "./transcript.ts";
import type { TranscriptRow } from "./transcript-document.ts";

function textOf(content: EventPayloadMap["tool.result"]["content"]): string {
  return sanitizeTerminalText(
    content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(""),
  );
}

function resultEndedBy(details: EventPayloadMap["tool.result"]["details"]): string | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const record = details as { readonly [key: string]: unknown };
  return typeof record.endedBy === "string" ? record.endedBy : undefined;
}

/** One retained presentation object for a canonical tool call and its eventual result. */
export class ToolTransactionComponent implements Component {
  readonly callId: string;
  readonly sourceId: string;
  readonly operationId: string | undefined;
  private readonly name: string;
  private readonly args: EventPayloadMap["tool.call"]["input"];
  private readonly startedAt: number;
  private readonly palette: () => Palette;
  private readonly detailMode: () => ToolOutputDisplay;
  private readonly renderer: () => OwnedTerminalToolRenderer | undefined;
  private readonly renderBlob: BlobRenderer | undefined;
  private status: ToolTransactionStatus;
  private result: string | undefined;
  private isError = false;
  private durationMs: number | undefined;
  private blobs: readonly BlobReference[] = [];
  private cachedWidth: number | undefined;
  private cachedMode: ToolOutputDisplay | undefined;
  private cachedPalette: Palette | undefined;
  private cachedLines: string[] | undefined;
  private cachedSummary = false;
  private cachedDurationMs: number | undefined;

  constructor(
    event: CanonicalEvent<"tool.call">,
    palette: () => Palette,
    detailMode: () => ToolOutputDisplay,
    status: "pending" | "running" = "running",
    renderer: () => OwnedTerminalToolRenderer | undefined = () => undefined,
    renderBlob?: BlobRenderer,
  ) {
    this.callId = event.payload.callId;
    this.sourceId = event.id;
    this.operationId = event.operationId;
    this.name = event.payload.name;
    this.args = event.payload.input;
    this.startedAt = event.timestamp;
    this.palette = palette;
    this.detailMode = detailMode;
    this.renderer = renderer;
    this.renderBlob = renderBlob;
    this.status = status;
  }

  markDenied(reason: string): void {
    this.status = "denied";
    this.result = sanitizeTerminalText(reason);
    this.isError = true;
    this.invalidate();
  }

  settle(event: CanonicalEvent<"tool.result">): void {
    const endedBy = resultEndedBy(event.payload.details);
    this.status =
      this.status === "denied"
        ? "denied"
        : endedBy === "abort"
          ? "aborted"
          : event.payload.isError
            ? "failed"
            : "succeeded";
    this.result = textOf(event.payload.content);
    this.blobs = event.payload.content.flatMap((item) => (item.type === "blob" ? [item.blob] : []));
    this.isError = this.status === "denied" || event.payload.isError;
    this.durationMs = Math.max(0, event.timestamp - this.startedAt);
    this.invalidate();
  }

  get state(): ToolTransactionStatus {
    return this.status;
  }

  render(width: number, summaryOnly = false): string[] {
    const palette = this.palette();
    const mode = this.detailMode();
    const durationMs =
      this.durationMs ??
      (this.status === "running"
        ? Math.max(0, Math.floor((Date.now() - this.startedAt) / 1_000) * 1_000)
        : undefined);
    if (
      this.cachedLines !== undefined &&
      this.cachedWidth === width &&
      this.cachedMode === mode &&
      this.cachedPalette === palette &&
      this.cachedSummary === summaryOnly &&
      this.cachedDurationMs === durationMs
    ) {
      return this.cachedLines;
    }
    const renderer = this.renderer();
    const toolLines = renderToolTransaction({
      callId: this.callId,
      summaryOnly,
      name: this.name,
      args: this.args,
      ...(this.result === undefined ? {} : { result: this.result }),
      isError: this.isError,
      status: this.status,
      ...(durationMs === undefined ? {} : { durationMs }),
      width,
      mode,
      palette,
      ...(renderer === undefined ? {} : { renderer }),
    });
    this.cachedLines = [
      ...toolLines,
      ...(summaryOnly
        ? []
        : this.blobs.flatMap((blob) => this.renderBlob?.(blob, width, palette) ?? [])),
    ];
    this.cachedDurationMs = durationMs;
    this.cachedSummary = summaryOnly;
    this.cachedWidth = width;
    this.cachedMode = mode;
    this.cachedPalette = palette;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedMode = undefined;
    this.cachedPalette = undefined;
    this.cachedLines = undefined;
  }
}

// Independently implements Pi-style collapsed details; consecutive-call grouping is Axl-specific.
// Reference: https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/0.85.0
/** Retains a consecutive tool group until it can be committed before the next message. */
export class ToolTransactionStore implements Component {
  private readonly palette: () => Palette;
  private readonly detailMode: () => ToolOutputDisplay;
  private readonly renderer: (name: string) => OwnedTerminalToolRenderer | undefined;
  private readonly renderBlob: BlobRenderer | undefined;
  private readonly transactions = new Map<string, ToolTransactionComponent>();
  private readonly pending = new Set<string>();
  private readonly detailOverrides: ReadonlyMap<string, ToolOutputDisplay>;

  constructor(
    palette: () => Palette,
    detailMode: () => ToolOutputDisplay,
    renderer: (name: string) => OwnedTerminalToolRenderer | undefined = () => undefined,
    renderBlob?: BlobRenderer,
    detailOverrides: ReadonlyMap<string, ToolOutputDisplay> = new Map(),
  ) {
    this.palette = palette;
    this.detailMode = detailMode;
    this.renderer = renderer;
    this.renderBlob = renderBlob;
    this.detailOverrides = detailOverrides;
  }

  private mode(): ToolOutputDisplay {
    const sourceId = this.transactions.values().next().value?.sourceId;
    return (
      (sourceId === undefined ? undefined : this.detailOverrides.get(sourceId)) ?? this.detailMode()
    );
  }

  start(
    event: CanonicalEvent<"tool.call">,
    status: "pending" | "running" = "running",
  ): ToolTransactionComponent {
    if (this.transactions.has(event.payload.callId)) {
      throw new Error(`Duplicate live tool call ${event.payload.callId}`);
    }
    const component = new ToolTransactionComponent(
      event,
      this.palette,
      () => this.mode(),
      status,
      () => this.renderer(event.payload.name),
      this.renderBlob,
    );
    this.transactions.set(event.payload.callId, component);
    this.pending.add(event.payload.callId);
    return component;
  }

  deny(event: CanonicalEvent<"sandbox.violation">): boolean {
    const component = [...this.transactions.values()]
      .reverse()
      .find(
        (candidate) =>
          this.pending.has(candidate.callId) && candidate.operationId === event.operationId,
      );
    if (component === undefined) return false;
    component.markDenied(event.payload.reason);
    return true;
  }

  settle(event: CanonicalEvent<"tool.result">): ToolTransactionComponent | undefined {
    const component = this.transactions.get(event.payload.callId);
    if (component === undefined || !this.pending.has(event.payload.callId)) return undefined;
    component.settle(event);
    this.pending.delete(event.payload.callId);
    return component;
  }

  components(): readonly ToolTransactionComponent[] {
    return [...this.transactions.values()];
  }

  render(width: number): string[] {
    return this.rows(width).map((row) => row.text);
  }

  /** Bound the mutable regular-mode tail without losing the active tool's header. */
  renderWindow(width: number, height: number): string[] {
    if (height <= 0) return [];
    const lines = this.render(width);
    if (lines.length <= height) return lines;
    const components = this.components();
    const active =
      components.findLast((component) => this.pending.has(component.callId)) ?? components.at(-1);
    if (active === undefined) return [];
    const preview = active.render(width);
    const start = Math.max(
      0,
      preview.findIndex((line) => line.trim().length > 0),
    );
    if (height === 1) return preview.slice(start, start + 1);
    return [
      ...preview.slice(start, start + height - 1),
      this.palette().dim(
        truncateToWidth("  … tool preview · fullscreen or /export for more", width, ""),
      ),
    ];
  }

  rows(width: number): readonly TranscriptRow[] {
    const components = this.components();
    const groupId = components[0]?.sourceId;
    if (groupId === undefined) return [];
    const palette = this.palette();
    const rows: TranscriptRow[] = [];
    const append = (lines: readonly string[], sourceId: string): void => {
      for (const [rowInSource, text] of lines.entries())
        rows.push({ text, sourceId, toolGroupId: groupId, prompt: false, rowInSource });
    };
    const compact = this.mode() === "compact";
    if (compact && components.length > 1) {
      const counts = new Map<ToolTransactionStatus, number>();
      for (const component of components)
        counts.set(component.state, (counts.get(component.state) ?? 0) + 1);
      const status = [...counts]
        .map(([state, count]) => `${count} ${state === "succeeded" ? "done" : state}`)
        .join(" · ");
      append(
        [
          "",
          palette.dim(
            truncateToWidth(`  Tools · ${components.length} calls · ${status}`, width, "…"),
          ),
          ...(components.length > 3
            ? [palette.dim(`  … ${components.length - 3} earlier calls`)]
            : []),
        ],
        `${groupId}:header`,
      );
    }
    for (const component of compact ? components.slice(-3) : components)
      append(component.render(width, compact && components.length > 1), component.sourceId);
    append(
      [
        palette.dim(
          truncateToWidth(
            compact
              ? "  Ctrl+O to expand tool inputs and results · click in fullscreen to toggle"
              : "  Ctrl+O for tool details · click in fullscreen to toggle",
            width,
            "",
          ),
        ),
      ],
      `${groupId}:hint`,
    );
    return rows;
  }

  drain(width: number): readonly TranscriptRow[] {
    if (this.pending.size > 0) return [];
    const rows = this.rows(width);
    this.transactions.clear();
    return rows;
  }

  replace(other: ToolTransactionStore): void {
    this.transactions.clear();
    this.pending.clear();
    for (const callId of other.pending) this.pending.add(callId);
    for (const [callId, component] of other.transactions) this.transactions.set(callId, component);
  }
}
