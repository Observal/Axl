// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import type { McpConfigListResult, McpServerEntry } from "@axl/protocol";
import {
  describeMcpServerDefinition,
  formatMcpServerSummary,
  MCP_STATUS_LABELS,
  summarizeMcpServers,
} from "@axl/sdk";

import { dialogInnerWidth, renderDialog } from "./dialog.ts";
import { decodeOneKey } from "./editor.ts";
import type { Overlay } from "./overlay.ts";
import { sanitizeTerminalText, truncateToWidth, visibleWidth, wrapLine } from "./render.ts";
import type { Palette } from "./transcript.ts";

export interface McpPanelOptions {
  readonly palette: () => Palette;
  readonly refresh: () => void;
  /** Daemon projection of configured servers and their discovery state. */
  readonly load: () => Promise<McpConfigListResult>;
  /** Capability identities activated in this session, e.g. `mcp:server/tool`. */
  readonly activeIdentities: () => ReadonlySet<string>;
  readonly onAdd: () => void;
  /** Quick import from pasted README JSON, a URL, or a command line. */
  readonly onImport: () => void;
  readonly remove: (name: string) => Promise<void>;
  readonly setEnabled: (name: string, enabled: boolean) => Promise<void>;
  readonly reload: () => Promise<void>;
  readonly close: () => void;
  /** Server to place the cursor on when the panel opens. */
  readonly focus?: string;
}

type Row =
  | { readonly kind: "server"; readonly server: McpServerEntry }
  | { readonly kind: "tool"; readonly server: McpServerEntry; readonly toolIndex: number };

const MAX_VISIBLE_ROWS = 14;

/**
 * Framed, keyboard-driven view of the daemon's MCP configuration. It renders
 * daemon state and submits user intent; it never discovers or connects itself.
 */
export class McpPanelOverlay implements Overlay {
  private readonly options: McpPanelOptions;
  private result: McpConfigListResult | undefined;
  private readonly expanded = new Set<string>();
  private selected = 0;
  private error: string | undefined;
  private busy: string | undefined;
  private confirmRemove: string | undefined;
  private disposed = false;

  constructor(options: McpPanelOptions) {
    this.options = options;
    void this.refreshList(options.focus);
  }

  dispose(): void {
    this.disposed = true;
  }

  render(width: number): string[] {
    const palette = this.options.palette();
    const inner = dialogInnerWidth(width);
    const bold = palette.bold ?? ((text: string) => text);
    const rows: string[] = [];
    if (this.result === undefined) {
      rows.push(palette.dim(this.error ?? "Loading MCP configuration…"));
      return renderDialog({ title: "MCP servers", rows, footer: "Esc to close", width, palette });
    }
    const summary = summarizeMcpServers(this.result.servers);
    rows.push(
      palette.dim(truncateToWidth(`Global config: ${this.result.path}`, inner, "")),
      palette.dim(formatMcpServerSummary(summary)),
      "",
    );
    const visible = this.rows();
    if (visible.length === 0) {
      rows.push(
        "No MCP servers are configured.",
        palette.dim("Press p to paste a server's README config, or a for the guided add flow."),
      );
    } else {
      this.selected = Math.min(this.selected, visible.length - 1);
      const start = Math.max(
        0,
        Math.min(
          this.selected - Math.floor(MAX_VISIBLE_ROWS / 2),
          visible.length - MAX_VISIBLE_ROWS,
        ),
      );
      const end = Math.min(visible.length, start + MAX_VISIBLE_ROWS);
      if (start > 0) rows.push(palette.dim(`… ${start} more above`));
      const nameWidth = Math.min(
        24,
        Math.max(...this.result.servers.map((server) => visibleWidth(server.name)), 4),
      );
      for (let index = start; index < end; index++) {
        const row = visible[index] as Row;
        const selected = index === this.selected;
        if (row.kind === "server") {
          rows.push(this.serverLine(row.server, selected, nameWidth, inner, palette));
          if (selected && row.server.status === "failed" && row.server.error) {
            rows.push(
              ...wrapLine(sanitizeTerminalText(row.server.error), Math.max(8, inner - 6)).map(
                (line) => `      ${palette.error(line)}`,
              ),
            );
          }
        } else {
          const toolWidth = Math.min(
            32,
            Math.max(...row.server.tools.map((tool) => visibleWidth(tool.name)), 4),
          );
          rows.push(this.toolLine(row, selected, toolWidth, inner, palette));
        }
      }
      if (end < visible.length) rows.push(palette.dim(`… ${visible.length - end} more below`));
    }
    rows.push("");
    if (this.confirmRemove !== undefined) {
      rows.push(
        `${(palette.warning ?? palette.accent)(bold(`Remove ${sanitizeTerminalText(this.confirmRemove)}?`))} ${palette.dim(
          "Enter removes it from the global config · Esc keeps it",
        )}`,
      );
    } else if (this.busy !== undefined) {
      rows.push(palette.dim(this.busy));
    }
    if (this.error !== undefined) rows.push(palette.error(`✖ ${this.error}`));
    return renderDialog({
      title: "MCP servers",
      rows,
      footer:
        visible.length === 0
          ? "p paste config · a add · r reload · Esc close"
          : "↑↓ move · ⏎ expand · p paste · a add · e enable/disable · d remove · r reload · Esc close",
      width,
      palette,
    });
  }

  handleKey(data: string): void {
    if (this.busy !== undefined) return;
    for (let at = 0; at < data.length; ) {
      const decoded = decodeOneKey(data, at);
      at = decoded.next;
      const key = decoded.key;
      if (this.confirmRemove !== undefined) {
        if (key.kind === "enter") {
          const name = this.confirmRemove;
          this.confirmRemove = undefined;
          void this.mutate(`Removing ${name}…`, () => this.options.remove(name));
        } else if (key.kind === "escape" || (key.kind === "ctrl" && key.char === "c")) {
          this.confirmRemove = undefined;
        }
        this.options.refresh();
        continue;
      }
      if (key.kind === "escape" || (key.kind === "ctrl" && key.char === "c")) {
        this.options.close();
        return;
      }
      const rows = this.rows();
      const current = rows[this.selected];
      if (key.kind === "up")
        this.selected = rows.length === 0 ? 0 : (this.selected - 1 + rows.length) % rows.length;
      else if (key.kind === "down")
        this.selected = rows.length === 0 ? 0 : (this.selected + 1) % rows.length;
      else if (key.kind === "enter" && current !== undefined) {
        const name = current.server.name;
        if (this.expanded.has(name)) this.expanded.delete(name);
        else this.expanded.add(name);
        this.selected = rows.findIndex((row) => row.kind === "server" && row.server.name === name);
      } else if (key.kind === "char" && key.char === "a") {
        this.options.onAdd();
        return;
      } else if (key.kind === "char" && key.char === "p") {
        this.options.onImport();
        return;
      } else if (key.kind === "char" && key.char === "r") {
        void this.mutate("Reloading the session…", () => this.options.reload());
      } else if (key.kind === "char" && key.char === "d" && current !== undefined) {
        this.confirmRemove = current.server.name;
      } else if (key.kind === "char" && key.char === "e" && current !== undefined) {
        const server = current.server;
        const enable = server.status === "disabled";
        void this.mutate(`${enable ? "Enabling" : "Disabling"} ${server.name}…`, () =>
          this.options.setEnabled(server.name, enable),
        );
      }
      this.options.refresh();
    }
  }

  private rows(): Row[] {
    const rows: Row[] = [];
    for (const server of this.result?.servers ?? []) {
      rows.push({ kind: "server", server });
      if (this.expanded.has(server.name)) {
        for (let toolIndex = 0; toolIndex < server.tools.length; toolIndex++) {
          rows.push({ kind: "tool", server, toolIndex });
        }
      }
    }
    return rows;
  }

  private serverLine(
    server: McpServerEntry,
    selected: boolean,
    nameWidth: number,
    width: number,
    palette: Palette,
  ): string {
    const bold = palette.bold ?? ((text: string) => text);
    const caret = server.tools.length === 0 ? " " : this.expanded.has(server.name) ? "▾" : "▸";
    const pointer = selected ? palette.accent("›") : " ";
    const name = truncateToWidth(sanitizeTerminalText(server.name), nameWidth, "…").padEnd(
      nameWidth,
    );
    const status = this.statusText(server, palette);
    const tools =
      server.status === "discovered"
        ? palette.dim(`${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`)
        : "";
    const trailing = [tools, status].filter((part) => part !== "").join("  ");
    const trailingWidth = visibleWidth(trailing);
    const prefix = `${pointer} ${caret} ${selected ? bold(palette.accent(name)) : name}  `;
    const available = Math.max(8, width - visibleWidth(prefix) - trailingWidth - 2);
    const location = palette.dim(
      truncateToWidth(
        sanitizeTerminalText(describeMcpServerDefinition(server.definition)),
        available,
        "…",
      ),
    );
    const gap = Math.max(1, width - visibleWidth(prefix) - visibleWidth(location) - trailingWidth);
    return `${prefix}${location}${" ".repeat(gap)}${trailing}`;
  }

  private statusText(server: McpServerEntry, palette: Palette): string {
    const label = MCP_STATUS_LABELS[server.status];
    switch (server.status) {
      case "discovered":
        return (palette.success ?? palette.accent)(label);
      case "failed":
        return palette.error(label);
      case "disabled":
        return palette.dim(label);
      case "pending":
        return (palette.warning ?? palette.dim)(label);
    }
  }

  private toolLine(
    row: Extract<Row, { kind: "tool" }>,
    selected: boolean,
    nameWidth: number,
    width: number,
    palette: Palette,
  ): string {
    const tool = row.server.tools[row.toolIndex];
    if (tool === undefined) return "";
    const active = this.options.activeIdentities().has(`mcp:${row.server.name}/${tool.name}`);
    const marker = active ? palette.accent("●") : palette.dim("○");
    const pointer = selected ? palette.accent("›") : " ";
    const name = truncateToWidth(sanitizeTerminalText(tool.name), nameWidth, "…").padEnd(nameWidth);
    const prefix = `    ${pointer} ${marker} ${selected ? (palette.bold ?? ((text: string) => text))(name) : name}`;
    const description = sanitizeTerminalText(tool.description).split("\n")[0] ?? "";
    const available = width - visibleWidth(prefix) - 3;
    return available > 8 && description
      ? `${prefix}  ${palette.dim(truncateToWidth(description, available, "…"))}`
      : prefix;
  }

  private async refreshList(focus?: string): Promise<void> {
    try {
      const result = await this.options.load();
      if (this.disposed) return;
      this.result = result;
      this.error = undefined;
      if (focus !== undefined) {
        const index = this.rows().findIndex(
          (row) => row.kind === "server" && row.server.name === focus,
        );
        if (index >= 0) this.selected = index;
      }
    } catch (error) {
      if (this.disposed) return;
      this.error = error instanceof Error ? error.message : "Could not load MCP configuration";
    }
    this.options.refresh();
  }

  private async mutate(label: string, action: () => Promise<void>): Promise<void> {
    this.busy = label;
    this.error = undefined;
    this.options.refresh();
    try {
      await action();
      await this.refreshList();
    } catch (error) {
      if (this.disposed) return;
      this.error = error instanceof Error ? error.message : "MCP configuration failed";
    } finally {
      this.busy = undefined;
      if (!this.disposed) this.options.refresh();
    }
  }
}
