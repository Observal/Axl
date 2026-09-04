// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { OwnedTerminalToolRenderer } from "@axl/extension-api";
import type { BlobReference, CanonicalEvent, EventPayloadMap } from "@axl/protocol";

import type { Component } from "./render.ts";
import { sanitizeTerminalText } from "./render.ts";
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

  render(width: number): string[] {
    const palette = this.palette();
    const mode = this.detailMode();
    if (
      this.cachedLines !== undefined &&
      this.cachedWidth === width &&
      this.cachedMode === mode &&
      this.cachedPalette === palette
    ) {
      return this.cachedLines;
    }
    const renderer = this.renderer();
    const toolLines = renderToolTransaction({
      callId: this.callId,
      name: this.name,
      args: this.args,
      ...(this.result === undefined ? {} : { result: this.result }),
      isError: this.isError,
      status: this.status,
      ...(this.durationMs === undefined ? {} : { durationMs: this.durationMs }),
      width,
      mode,
      palette,
      ...(renderer === undefined ? {} : { renderer }),
    });
    this.cachedLines = [
      ...toolLines,
      ...this.blobs.flatMap((blob) => this.renderBlob?.(blob, width, palette) ?? []),
    ];
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

/** Owns ordered live tool transactions while the transcript remains append-only. */
export class ToolTransactionStore {
  private readonly palette: () => Palette;
  private readonly detailMode: () => ToolOutputDisplay;
  private readonly renderer: (name: string) => OwnedTerminalToolRenderer | undefined;
  private readonly renderBlob: BlobRenderer | undefined;
  private readonly transactions = new Map<string, ToolTransactionComponent>();
  private readonly order: string[] = [];

  constructor(
    palette: () => Palette,
    detailMode: () => ToolOutputDisplay,
    renderer: (name: string) => OwnedTerminalToolRenderer | undefined = () => undefined,
    renderBlob?: BlobRenderer,
  ) {
    this.palette = palette;
    this.detailMode = detailMode;
    this.renderer = renderer;
    this.renderBlob = renderBlob;
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
      this.detailMode,
      status,
      () => this.renderer(event.payload.name),
      this.renderBlob,
    );
    this.transactions.set(event.payload.callId, component);
    this.order.push(event.payload.callId);
    return component;
  }

  deny(event: CanonicalEvent<"sandbox.violation">): boolean {
    const component = [...this.transactions.values()]
      .reverse()
      .find((candidate) => candidate.operationId === event.operationId);
    if (component === undefined) return false;
    component.markDenied(event.payload.reason);
    return true;
  }

  settle(event: CanonicalEvent<"tool.result">): ToolTransactionComponent | undefined {
    const component = this.transactions.get(event.payload.callId);
    if (component === undefined) return undefined;
    component.settle(event);
    this.transactions.delete(event.payload.callId);
    const index = this.order.indexOf(event.payload.callId);
    if (index >= 0) this.order.splice(index, 1);
    return component;
  }

  components(): readonly Component[] {
    return this.order.flatMap((callId) => {
      const component = this.transactions.get(callId);
      return component === undefined ? [] : [component];
    });
  }

  rows(width: number): readonly TranscriptRow[] {
    return this.order.flatMap((callId) => {
      const component = this.transactions.get(callId);
      if (component === undefined) return [];
      return component.render(width).map((text, rowInSource) => ({
        text,
        sourceId: component.sourceId,
        prompt: false,
        rowInSource,
      }));
    });
  }

  replace(other: ToolTransactionStore): void {
    this.transactions.clear();
    this.order.length = 0;
    for (const callId of other.order) {
      const component = other.transactions.get(callId);
      if (component !== undefined) {
        this.transactions.set(callId, component);
        this.order.push(callId);
      }
    }
  }
}
