// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type { BlobReference, CanonicalEvent } from "@axl/protocol";
import { type ClientModelInfo, ConversationProjector } from "@axl/sdk";

import { renderMarkdown } from "./markdown.ts";
import { sanitizeTerminalText, truncateToWidth, visibleWidth, wrapLine } from "./render.ts";
import { renderShellPassthrough } from "./tool-display.ts";

export interface Palette {
  dim(text: string): string;
  accent(text: string): string;
  error(text: string): string;
  bold?(text: string): string;
  border?(text: string): string;
  success?(text: string): string;
  warning?(text: string): string;
  text?(text: string): string;
  userMessage?(text: string): string;
  selection?(text: string): string;
  searchMatch?(text: string): string;
  searchCurrent?(text: string): string;
  toolBackground?(text: string): string;
  toolPendingBackground?(text: string): string;
  toolSuccessBackground?(text: string): string;
  toolErrorBackground?(text: string): string;
  toolDeniedBackground?(text: string): string;
  diffAdded?(text: string): string;
  diffRemoved?(text: string): string;
  diffContext?(text: string): string;
  diffAddedBackground?(text: string): string;
  diffRemovedBackground?(text: string): string;
  thinking?(level: string, text: string): string;
  mdHeading?(text: string): string;
  mdCode?(text: string): string;
  mdCodeBlockBorder?(text: string): string;
  mdQuote?(text: string): string;
  mdQuoteBorder?(text: string): string;
  mdListBullet?(text: string): string;
  syntaxComment?(text: string): string;
  syntaxKeyword?(text: string): string;
  syntaxFunction?(text: string): string;
  syntaxVariable?(text: string): string;
  syntaxString?(text: string): string;
  syntaxNumber?(text: string): string;
  syntaxType?(text: string): string;
  syntaxOperator?(text: string): string;
  syntaxPunctuation?(text: string): string;
  keyword?(text: string): string;
  literal?(text: string): string;
}

export const PLAIN_PALETTE: Palette = {
  dim: (text) => text,
  accent: (text) => text,
  error: (text) => text,
  bold: (text) => text,
};

const EMPTY_ROWS: readonly string[] = Object.freeze([]);

export const ANSI_PALETTE: Palette = {
  dim: (text) => `\x1b[2m${text}\x1b[22m`,
  accent: (text) => `\x1b[36m${text}\x1b[39m`,
  error: (text) => `\x1b[31m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  border: (text) => `\x1b[90m${text}\x1b[39m`,
  success: (text) => `\x1b[32m${text}\x1b[39m`,
  warning: (text) => `\x1b[33m${text}\x1b[39m`,
  diffAdded: (text) => `\x1b[32m${text}\x1b[39m`,
  diffRemoved: (text) => `\x1b[31m${text}\x1b[39m`,
  diffContext: (text) => `\x1b[2m${text}\x1b[22m`,
};

function textOf(content: readonly { type: string; text?: string }[]): string {
  return sanitizeTerminalText(
    content
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join(""),
  );
}

function compactNumber(value: number): string {
  if (value >= 10_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export type ThinkingDisplay = "show" | "compact" | "hide";
export type ToolOutputDisplay = "compact" | "full" | "focus";

export type BlobRenderer = (
  reference: BlobReference,
  width: number,
  palette: Palette,
) => readonly string[];

/** Pure event-to-terminal projection. The daemon remains the source of truth. */
export class SessionView {
  palette: Palette;
  private width: number;
  private readonly models: readonly ClientModelInfo[];
  private readonly renderBlob: BlobRenderer | undefined;
  model: string | undefined;
  thinking: string | undefined;
  profile: string | undefined;
  sandbox: string | undefined;
  working = false;
  thinkingDisplay: ThinkingDisplay = "compact";
  toolOutputDisplay: ToolOutputDisplay = "compact";
  totalTokens = 0;
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  contextTokens: number | undefined = 0;
  cacheHitPercent: number | undefined;
  totalCostUsd = 0;
  tokensPerSecond: number | undefined;
  elapsedSeconds = 0;
  private responseStartedAt: number | undefined;
  private readonly projection: ConversationProjector;

  constructor(
    width: number,
    palette: Palette = PLAIN_PALETTE,
    models: readonly ClientModelInfo[] = [],
    renderBlob?: BlobRenderer,
    projection: ConversationProjector = new ConversationProjector(),
  ) {
    this.width = width;
    this.palette = palette;
    this.models = models;
    this.renderBlob = renderBlob;
    this.projection = projection;
  }

  setWidth(width: number): void {
    this.width = Math.max(1, width);
  }

  cycleThinkingDisplay(): ThinkingDisplay {
    this.thinkingDisplay =
      this.thinkingDisplay === "compact"
        ? "show"
        : this.thinkingDisplay === "show"
          ? "hide"
          : "compact";
    return this.thinkingDisplay;
  }

  toggleToolOutput(): ToolOutputDisplay {
    this.toolOutputDisplay = this.toolOutputDisplay === "full" ? "compact" : "full";
    return this.toolOutputDisplay;
  }

  beginResponse(): void {
    this.responseStartedAt = performance.now();
    this.tokensPerSecond = undefined;
  }

  frameBorder(text: string): string {
    return (
      this.palette.thinking?.(this.thinking ?? "off", text) ??
      this.palette.border?.(text) ??
      this.palette.dim(text)
    );
  }

  usageLabel(): string {
    const parts: string[] = [];
    if (this.inputTokens) parts.push(`↑${compactNumber(this.inputTokens)}`);
    if (this.outputTokens) parts.push(`↓${compactNumber(this.outputTokens)}`);
    if (this.cacheReadTokens) parts.push(`R${compactNumber(this.cacheReadTokens)}`);
    if (this.cacheWriteTokens) parts.push(`W${compactNumber(this.cacheWriteTokens)}`);
    if ((this.cacheReadTokens || this.cacheWriteTokens) && this.cacheHitPercent !== undefined) {
      parts.push(`CH${this.cacheHitPercent.toFixed(1)}%`);
    }
    if (this.totalCostUsd) parts.push(`$${this.totalCostUsd.toFixed(3)}`);

    const model = this.models.find((candidate) => candidate.modelId === this.model);
    if (model === undefined) {
      if (parts.length === 0) parts.push("ready");
    } else {
      const percent =
        this.contextTokens === undefined
          ? "?"
          : this.contextTokens === 0
            ? "0.0%"
            : `${((this.contextTokens / model.contextWindow) * 100).toFixed(1)}%`;
      parts.push(`${percent}/${compactNumber(model.contextWindow)} context`);
    }
    return parts.join(" ");
  }

  modelLabel(): string {
    const model = this.model ?? "no model selected";
    const info = this.models.find((candidate) => candidate.modelId === model);
    if (this.thinking === undefined || (info && !info.reasoning)) return model;
    return `${model} • ${this.thinking === "off" ? "thinking off" : this.thinking}`;
  }

  tpsLabel(): string {
    return this.tokensPerSecond === undefined ? "" : `${this.tokensPerSecond.toFixed(1)} tok/s`;
  }

  get unsafe(): boolean {
    return this.sandbox === "unenforced";
  }

  apply(event: CanonicalEvent): readonly string[] {
    if (!this.projection.applyEvent(event)) return EMPTY_ROWS;
    return this.present(event);
  }

  /** Renders an event already reduced by the shared SDK subscription projector. */
  present(event: CanonicalEvent): readonly string[] {
    const previousModel = this.model;
    const previousThinking = this.thinking;
    const previousSandbox = this.sandbox;
    const projected = this.projection.state;
    this.model = projected.model;
    this.thinking = projected.thinking;
    this.profile = projected.profile;
    this.sandbox =
      projected.sandbox === undefined
        ? undefined
        : projected.sandbox.enforced
          ? projected.sandbox.provider
          : "unenforced";
    this.inputTokens = projected.usage.inputTokens;
    this.outputTokens = projected.usage.outputTokens;
    this.cacheReadTokens = projected.usage.cacheReadTokens;
    this.cacheWriteTokens = projected.usage.cacheWriteTokens;
    this.totalTokens = projected.usage.inputTokens + projected.usage.outputTokens;
    this.totalCostUsd = projected.usage.costUsd;
    const { dim, error } = this.palette;
    switch (event.type) {
      case "session.created":
      case "session.resumed":
        return EMPTY_ROWS;
      case "user.message":
        return [
          ...this.userMessage(textOf(event.payload.content)),
          ...event.payload.content.flatMap((item) =>
            item.type === "blob" ? this.blobRows(item.blob) : [],
          ),
        ];
      case "queue.enqueued":
        return [dim(`· queued · ${sanitizeTerminalText(textOf(event.payload.content))}`)];
      case "queue.requeued":
        return [dim(`· re-queued ${event.payload.queueItemId}`)];
      case "queue.started":
        return [dim(`· running queued prompt ${event.payload.queueItemId}`)];
      case "queue.paused":
        return [dim(`· queued prompt paused · use re-queue to run ${event.payload.queueItemId}`)];
      case "user.shell":
        return renderShellPassthrough({
          command: event.payload.command,
          text: textOf(event.payload.content),
          isError: event.payload.isError,
          excluded: event.payload.excluded,
          width: this.width,
          mode: this.toolOutputDisplay,
          palette: this.palette,
        });
      case "assistant.message": {
        const usage = event.payload.usage;
        if (usage !== undefined) {
          const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
          this.contextTokens = promptTokens;
          this.cacheHitPercent =
            promptTokens > 0 ? (usage.cacheReadTokens / promptTokens) * 100 : undefined;
          const cost = this.models.find((candidate) => candidate.modelId === this.model)?.cost;
          if (usage.costUsd === undefined && cost !== undefined) {
            this.totalCostUsd +=
              (cost.inputUsdPerMTok * usage.inputTokens +
                cost.outputUsdPerMTok * usage.outputTokens +
                (cost.cacheReadUsdPerMTok ?? 0) * usage.cacheReadTokens +
                (cost.cacheWriteUsdPerMTok ?? 0) * usage.cacheWriteTokens) /
              1_000_000;
          }
          if (this.responseStartedAt !== undefined && usage.outputTokens > 0) {
            const elapsedMs = performance.now() - this.responseStartedAt;
            this.tokensPerSecond =
              elapsedMs > 0 ? (usage.outputTokens * 1_000) / elapsedMs : undefined;
          }
          this.responseStartedAt = undefined;
        }
        const lines: string[] = [];
        for (const item of event.payload.content) {
          if (item.type === "thinking") {
            const thought = sanitizeTerminalText(item.text);
            if (this.thinkingDisplay === "show") {
              lines.push(this.frameBorder("∴ Thinking"), ...this.wrap(dim(thought)));
            } else if (this.thinkingDisplay === "compact") {
              const count = thought.split("\n").length;
              lines.push(this.frameBorder(`∴ Thinking · ${count} line${count === 1 ? "" : "s"}`));
            }
          } else if (item.type === "text") {
            lines.push(
              ...renderMarkdown(
                sanitizeTerminalText(item.text),
                Math.max(1, this.width - 2),
                this.palette,
              ),
            );
          } else {
            lines.push(...this.blobRows(item.blob));
          }
        }
        if (event.payload.stopReason === "error") {
          lines.push(
            ...this.errorLines(sanitizeTerminalText(event.payload.errorMessage ?? "model error")),
          );
        } else if (event.payload.stopReason === "aborted") {
          lines.push(...this.wrap(dim("■ interrupted")));
        }
        if (lines.length === 0) return EMPTY_ROWS;
        return [
          "",
          ...lines.map((line) => `  ${truncateToWidth(line, Math.max(1, this.width - 2), "")}`),
        ];
      }
      case "tool.call":
        return EMPTY_ROWS;
      case "tool.result":
        if (this.working) this.beginResponse();
        return EMPTY_ROWS;
      case "session.error":
        return this.errorLines(
          sanitizeTerminalText(event.payload.message),
          sanitizeTerminalText(event.payload.code),
        );
      case "config.model":
        return previousModel === undefined || previousModel === this.model
          ? []
          : this.wrap(dim(`· model ${previousModel} → ${this.model}`));
      case "config.thinking": {
        const { requested, effective, clamped } = event.payload;
        if (clamped) {
          return this.wrap(dim(`· thinking ${effective} (clamped from ${requested})`));
        }
        return previousThinking === undefined || previousThinking === effective
          ? []
          : this.wrap(dim(`· thinking ${previousThinking} → ${effective}`));
      }
      case "config.dialect":
        return event.payload.reason === "reload"
          ? this.wrap(dim(`· tools reloaded · ${event.payload.dialectId}`))
          : [];
      case "permission.requested":
        return this.wrap(
          (this.palette.warning ?? this.palette.accent)(
            `? permission · ${sanitizeTerminalText(event.payload.capability)} · ${sanitizeTerminalText(event.payload.description)}`,
          ),
        );
      case "permission.resolved":
        return this.wrap(
          dim(
            `· permission ${event.payload.decision}${event.payload.reason ? ` · ${sanitizeTerminalText(event.payload.reason)}` : ""}`,
          ),
        );
      case "sandbox.configured":
        if (!event.payload.enforced) {
          return this.wrap((this.palette.warning ?? error)("! sandbox is not enforced"));
        }
        return previousSandbox === undefined || previousSandbox === this.sandbox
          ? []
          : this.wrap(dim(`· sandbox ${previousSandbox} → ${this.sandbox}`));
      case "sandbox.violation":
        return this.wrap(
          (this.palette.warning ?? error)(
            `⊘ sandbox denied ${sanitizeTerminalText(event.payload.capability)}: ${sanitizeTerminalText(event.payload.reason)}`,
          ),
        );
      case "context.injected":
        return this.wrap(dim(`+ context [${sanitizeTerminalText(event.payload.source)}]`));
      case "context.compacted":
        this.contextTokens = undefined;
        this.cacheHitPercent = undefined;
        return [
          "",
          this.palette.accent("◇ Context compacted"),
          ...(this.toolOutputDisplay === "full"
            ? renderMarkdown(
                sanitizeTerminalText(event.payload.summary),
                Math.max(1, this.width - 2),
                this.palette,
              ).map((line) => `  ${line}`)
            : this.wrap(dim("  Summary hidden · Ctrl+O to expand · /export for original history"))),
        ];
      case "session.closed":
        return this.wrap(dim(`· session ${event.payload.reason}`));
      default:
        return EMPTY_ROWS;
    }
  }

  statusLine(sessionId: string, spinner?: string, queued = 0): string {
    const activity = this.working
      ? `${spinner ?? "⠿"} working… ${this.elapsedSeconds}s${queued ? ` +${queued}` : ""}`
      : queued
        ? `idle +${queued}`
        : "idle";
    const full = `${activity} · session ${sessionId.slice(0, 8)} · profile ${this.profile ?? "?"} · model ${this.model ?? "?"} · thinking ${this.thinking ?? "?"} · sandbox ${this.sandbox ?? "none"}`;
    return this.palette.dim(truncateToWidth(full, this.width, ""));
  }

  private errorLines(message: string, code?: string): string[] {
    if (message.includes("DeploymentNotFound")) {
      return [
        ...this.wrap(
          this.palette.error(`✖ deployment not found for ${this.model ?? "the selected model"}`),
        ),
        ...this.wrap(
          this.palette.dim(
            `  Use /login to update provider configuration, or choose another model with /model.`,
          ),
        ),
      ];
    }
    return this.wrap(this.palette.error(`✖ ${code ? `${code}: ` : ""}${message}`));
  }

  private blobRows(reference: BlobReference): string[] {
    if (this.renderBlob !== undefined) {
      return [...this.renderBlob(reference, this.width, this.palette)];
    }
    const label = sanitizeTerminalText(reference.name ?? reference.mediaType);
    return [this.palette.dim(`[Attachment · ${label} · ${reference.sizeBytes} bytes]`)];
  }

  private userMessage(text: string): string[] {
    if (this.width < 8) return this.wrap(text);
    const border = this.palette.border ?? this.palette.dim;
    const background = this.palette.userMessage ?? ((value: string) => value);
    const contentWidth = Math.max(1, this.width - 4);
    const body = text
      .split("\n")
      .flatMap((line) => wrapLine(line, contentWidth))
      .map((line) => {
        const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
        return background(
          `${border("│")} ${(this.palette.text ?? ((value: string) => value))(line)}${padding} ${border("│")}`,
        );
      });
    const top = border(`╭${"─".repeat(this.width - 2)}╮`);
    return ["", background(top), ...body, background(border(`╰${"─".repeat(this.width - 2)}╯`))];
  }

  private wrap(line: string): string[] {
    return line.split("\n").flatMap((part) => wrapLine(part, this.width));
  }
}
