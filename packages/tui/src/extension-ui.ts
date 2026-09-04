// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { TerminalExtensionHost, TerminalLine, TerminalWidget } from "@axl/extension-api";

import type { Component } from "./render.ts";
import { sanitizeTerminalText, truncateToWidth, wrapLine } from "./render.ts";
import type { Palette } from "./transcript.ts";

const MAX_WIDGET_ROWS = 10;
const MAX_WIDGET_LINE_CHARS = 8_192;

function style(line: TerminalLine, palette: Palette): string {
  const text = sanitizeTerminalText(line.text).replace(/\s+/gu, " ").trim();
  if (line.tone === "accent") return palette.accent(text);
  if (line.tone === "success") return (palette.success ?? palette.accent)(text);
  if (line.tone === "warning") return (palette.warning ?? palette.accent)(text);
  if (line.tone === "error") return palette.error(text);
  if (line.tone === "text") return (palette.text ?? ((value) => value))(text);
  return palette.dim(text);
}

/** Width-bounds extension widgets and keeps their lifecycle in the public host. */
export class ExtensionWidgetsComponent implements Component {
  private readonly host: TerminalExtensionHost;
  private readonly placement: "aboveEditor" | "belowEditor";
  private readonly palette: () => Palette;
  private cachedWidth: number | undefined;
  private cachedRevision = "";
  private cachedPalette: Palette | undefined;
  private cachedRows: string[] | undefined;

  constructor(
    host: TerminalExtensionHost,
    placement: "aboveEditor" | "belowEditor",
    palette: () => Palette,
  ) {
    this.host = host;
    this.placement = placement;
    this.palette = palette;
  }

  render(width: number): string[] {
    const palette = this.palette();
    const widgets = this.host.widgets(this.placement);
    const revision = `${this.host.widgetRevision}:${widgets
      .map((widget) => widget.revision ?? 0)
      .join(",")}`;
    if (
      this.cachedRows !== undefined &&
      this.cachedWidth === width &&
      this.cachedRevision === revision &&
      this.cachedPalette === palette
    ) {
      return this.cachedRows;
    }
    if (widgets.length === 0) {
      this.cachedRows = [];
      this.cachedWidth = width;
      this.cachedRevision = revision;
      this.cachedPalette = palette;
      return this.cachedRows;
    }
    const rows: string[] = [];
    for (const widget of widgets) {
      rows.push(...this.renderWidget(widget, width));
      if (rows.length >= MAX_WIDGET_ROWS) break;
    }
    if (rows.length > MAX_WIDGET_ROWS) rows.length = MAX_WIDGET_ROWS;
    this.cachedRows = rows.map((line) => truncateToWidth(line, width, ""));
    this.cachedWidth = width;
    this.cachedRevision = revision;
    this.cachedPalette = palette;
    return this.cachedRows;
  }

  private renderWidget(widget: TerminalWidget, width: number): string[] {
    try {
      const source = widget.render(width);
      const rendered = source
        .slice(0, MAX_WIDGET_ROWS + 1)
        .flatMap((line) =>
          wrapLine(
            style({ ...line, text: line.text.slice(0, MAX_WIDGET_LINE_CHARS) }, this.palette()),
            Math.max(1, width),
          ),
        );
      if (source.length > MAX_WIDGET_ROWS || rendered.length > MAX_WIDGET_ROWS) {
        return [
          ...rendered.slice(0, MAX_WIDGET_ROWS - 1),
          this.palette().dim("… extension widget truncated"),
        ];
      }
      return rendered;
    } catch (error) {
      const message = sanitizeTerminalText(
        error instanceof Error ? error.message : "unknown widget failure",
      );
      return [this.palette().error(`✖ extension widget failed · ${message}`)];
    }
  }
}
