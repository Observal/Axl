// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  type AuthContext,
  type CredentialStore,
  type ModelInfo,
  supportedThinkingLevels,
  THINKING_LEVELS,
} from "@axl/ai";
import type { DaemonClient, SessionSnapshot } from "@axl/daemon";
import type {
  CanonicalEvent,
  EventPayloadMap,
  JsonObject,
  JsonValue,
  SessionForkResult,
  SessionSummary,
  ThinkingLevel,
} from "@axl/protocol";

import { renderDialog } from "./dialog.ts";
import { decodeOneKey, LineEditor } from "./editor.ts";
import { LoginDialog } from "./login-dialog.ts";
import {
  type Component,
  type CursorPlacement,
  DifferentialScreen,
  SYNC_BEGIN,
  SYNC_END,
  truncateToWidth,
  visibleWidth,
  wrapLine,
} from "./render.ts";
import { DEFAULT_THEME, THEMES, themeNames } from "./themes.ts";
import { PLAIN_PALETTE, SessionView } from "./transcript.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SELECTOR_WINDOW = 10;
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";
const KITTY_KEYS_ON = "\x1b[>1u";
const KITTY_KEYS_OFF = "\x1b[<u";

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function relativeAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function messageText(event: CanonicalEvent): string | undefined {
  if (event.type !== "user.message") return undefined;
  const text = event.payload.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

function orderSessions(
  sessions: readonly SessionSummary[],
  mode: "threaded" | "recent",
): SessionSummary[] {
  const recent = [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
  if (mode === "recent") return recent;
  const ids = new Set(recent.map((session) => session.sessionId));
  const children = new Map<string, SessionSummary[]>();
  for (const session of recent) {
    const parent = session.parentSessionId;
    if (parent === undefined || !ids.has(parent)) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(session);
    children.set(parent, siblings);
  }
  const ordered: SessionSummary[] = [];
  const visited = new Set<string>();
  const visit = (session: SessionSummary): void => {
    if (visited.has(session.sessionId)) return;
    visited.add(session.sessionId);
    ordered.push(session);
    for (const child of children.get(session.sessionId) ?? []) visit(child);
  };
  for (const session of recent) {
    if (session.parentSessionId === undefined || !ids.has(session.parentSessionId)) visit(session);
  }
  for (const session of recent) visit(session);
  return ordered;
}

function formatPath(cwd: string): string {
  const home = resolve(homedir());
  const path = resolve(cwd);
  const fromHome = relative(home, path);
  if (!fromHome) return "~";
  return !fromHome.startsWith(`..${sep}`) && fromHome !== ".." ? `~${sep}${fromHome}` : cwd;
}

async function readGitBranch(cwd: string): Promise<string | undefined> {
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const dotGit = join(directory, ".git");
    let gitDirectory = dotGit;
    try {
      const pointer = await readFile(dotGit, "utf8");
      const match = /^gitdir:\s*(.+)\s*$/m.exec(pointer);
      if (!match) return undefined;
      const target = match[1] as string;
      gitDirectory = isAbsolute(target) ? target : resolve(directory, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EISDIR" && code !== "EACCES" && code !== "EPERM") {
        if (directory === dirname(directory)) return undefined;
        continue;
      }
    }
    try {
      const head = (await readFile(join(gitDirectory, "HEAD"), "utf8")).trim();
      return head.startsWith("ref: refs/heads/")
        ? head.slice("ref: refs/heads/".length)
        : head.slice(0, 8);
    } catch {
      return undefined;
    }
  }
}

function jsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function interactionUrl(data: JsonObject | undefined): string | undefined {
  if (typeof data?.url === "string") return data.url;
  const request = jsonObject(data?.request);
  return typeof request?.url === "string" ? request.url : undefined;
}

function formValue(
  name: string,
  schema: JsonObject,
  raw: string,
  required: boolean,
): JsonValue | undefined {
  if (!raw && schema.default !== undefined) return schema.default;
  if (!raw && !required) return undefined;
  if (!raw) throw new Error(`${name} is required`);
  if (schema.type === "boolean") {
    if (["true", "yes", "y", "1"].includes(raw.toLowerCase())) return true;
    if (["false", "no", "n", "0"].includes(raw.toLowerCase())) return false;
    throw new Error(`${name} must be true or false`);
  }
  if (schema.type === "number" || schema.type === "integer") {
    const value = Number(raw);
    if (!Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
      throw new Error(`${name} must be a valid ${schema.type}`);
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      throw new Error(`${name} must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      throw new Error(`${name} must be at most ${schema.maximum}`);
    }
    return value;
  }
  if (schema.type === "array") {
    const items = jsonObject(schema.items);
    const choices = Array.isArray(items?.enum)
      ? items.enum
      : Array.isArray(items?.anyOf)
        ? items.anyOf.map((item) => jsonObject(item)?.const)
        : undefined;
    const values = raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (choices && values.some((value) => !choices.includes(value))) {
      throw new Error(`${name} contains a value outside its allowed choices`);
    }
    if (typeof schema.minItems === "number" && values.length < schema.minItems) {
      throw new Error(`${name} needs at least ${schema.minItems} choices`);
    }
    if (typeof schema.maxItems === "number" && values.length > schema.maxItems) {
      throw new Error(`${name} allows at most ${schema.maxItems} choices`);
    }
    return values;
  }
  const choices = Array.isArray(schema.enum)
    ? schema.enum
    : Array.isArray(schema.oneOf)
      ? schema.oneOf.map((item) => jsonObject(item)?.const)
      : undefined;
  if (choices && !choices.includes(raw)) throw new Error(`${name} must match an allowed choice`);
  if (typeof schema.minLength === "number" && [...raw].length < schema.minLength) {
    throw new Error(`${name} is too short`);
  }
  if (typeof schema.maxLength === "number" && [...raw].length > schema.maxLength) {
    throw new Error(`${name} is too long`);
  }
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(raw)) {
    throw new Error(`${name} has an invalid format`);
  }
  if (schema.format === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
    throw new Error(`${name} must be an email address`);
  }
  if (schema.format === "uri") new URL(raw);
  if (schema.format === "date" && Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw new Error(`${name} must be a date`);
  }
  if (schema.format === "date-time" && Number.isNaN(Date.parse(raw))) {
    throw new Error(`${name} must be a date-time`);
  }
  return raw;
}

function openExternalUrl(url: string, onError: (error: Error) => void): void {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
  ) {
    throw new Error("Refusing to open a non-HTTPS, non-loopback URL");
  }
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
        : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
  child.once("error", onError);
  child.unref();
}

const COMMANDS: readonly { readonly name: string; readonly summary: string }[] = [
  { name: "/resume", summary: "open another saved session" },
  { name: "/fork", summary: "fork from an earlier user message" },
  { name: "/clone", summary: "clone the complete current session" },
  { name: "/model", summary: "select a model, or /model <id>" },
  { name: "/thinking", summary: "select reasoning effort" },
  { name: "/theme", summary: "select a color theme" },
  { name: "/login", summary: "configure Azure OpenAI credentials" },
  { name: "/reload", summary: "reload AGENTS.md, prompt, and tools" },
  { name: "/status", summary: "show session, display, and queue state" },
  { name: "/help", summary: "show commands and keys" },
  { name: "/quit", summary: "detach from the daemon" },
];

const KEY_HELP: readonly string[] = [
  "Enter send/queue · Shift+Enter newline · Alt+Enter prioritize follow-up",
  "Shift+Tab thinking · Ctrl+T thoughts · Ctrl+O tool output · Tab complete",
  "Ctrl+W/U/K delete · Ctrl+Y yank · Ctrl+- undo · Alt+B/F words",
  "Ctrl+C interrupt/clear · Ctrl+D detach when empty · Ctrl+L repaint",
];

interface OutputStream {
  write(data: string): unknown;
  columns?: number;
  rows?: number;
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
}

interface InputStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off?(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  setRawMode?(mode: boolean): unknown;
  isTTY?: boolean;
}

export interface AxlAppOptions {
  readonly client: DaemonClient;
  readonly input: InputStream;
  readonly output: OutputStream;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly color?: boolean;
  readonly theme?: string;
  readonly models?: readonly string[];
  readonly modelCatalog?: readonly ModelInfo[];
  readonly currentModel?: string;
  readonly currentThinking?: ThinkingLevel;
  /** Called after the daemon accepts a model switch. */
  readonly onModelChange?: (modelId: string) => void | Promise<void>;
  readonly onThinkingChange?: (level: ThinkingLevel) => void | Promise<void>;
  readonly onThemeChange?: (theme: string) => void | Promise<void>;
  readonly credentials?: {
    readonly store: CredentialStore;
    readonly context: AuthContext;
    readonly fetch?: typeof fetch;
  };
  readonly onExit?: () => void;
}

interface Modal {
  render(width: number): string[];
  handleKey(data: string): void;
  cursor?(): CursorPlacement | undefined;
}

type TranscriptEntry =
  | { readonly kind: "event"; readonly event: CanonicalEvent }
  | { readonly kind: "lines"; readonly lines: readonly string[] };

/** A terminal projection over one daemon-owned Axl session. */
export class AxlApp {
  sessionId: string;
  private readonly options: AxlAppOptions;
  private readonly screen: DifferentialScreen;
  private view: SessionView;
  private readonly editor = new LineEditor();
  private width: number;
  private height: number;
  private cwd: string;
  private readonly transcript: TranscriptEntry[] = [];
  private notice: string | undefined;
  private modal: Modal | null = null;
  private stopped = false;
  private spinnerIndex = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private readonly unsubscribeEvents: () => void;
  private readonly queued: string[] = [];
  private sending = false;
  private configuring = false;
  private lastInterrupt = 0;
  private branch: string | undefined;
  private currentTheme: string;
  private readonly seenEventIds = new Set<string>();
  private bufferedEvents: CanonicalEvent[] | undefined = [];
  private readonly interactionQueue: EventPayloadMap["interaction.requested"][] = [];
  private activeInteractionId: string | undefined;

  private readonly inputListener = (chunk: Buffer | string): void => {
    this.handleInput(chunk.toString("utf8"));
  };

  private readonly resizeListener = (): void => {
    const width = this.detectWidth();
    const height = this.detectHeight();
    const widthChanged = width !== this.width;
    const heightChanged = height !== this.height;
    if (!widthChanged && !heightChanged) return;
    this.width = width;
    this.height = height;
    if (widthChanged || (heightChanged && process.env.TERMUX_VERSION === undefined)) {
      this.rebuildAfterResize();
    } else {
      this.screen.setWidth(width);
      this.view.setWidth(width);
      this.redraw();
    }
  };

  private constructor(
    options: AxlAppOptions,
    sessionId: string,
    width: number,
    height: number,
    branch: string | undefined,
  ) {
    this.options = options;
    this.sessionId = sessionId;
    this.width = width;
    this.height = height;
    this.cwd = options.cwd;
    this.screen = new DifferentialScreen(width);
    this.branch = branch;
    this.currentTheme = options.color === false ? "plain" : (options.theme ?? DEFAULT_THEME);
    const palette =
      options.color === false
        ? PLAIN_PALETTE
        : (THEMES[this.currentTheme] ?? (THEMES[DEFAULT_THEME] as never));
    this.view = new SessionView(width, palette, options.modelCatalog);
    this.unsubscribeEvents = options.client.onEvent((message) => {
      if (message.sessionId !== this.sessionId) return;
      if (this.bufferedEvents) this.bufferedEvents.push(message.event);
      else this.commitEvent(message.event);
    });
  }

  static async start(options: AxlAppOptions): Promise<AxlApp> {
    const snapshot = (await (options.sessionId === undefined
      ? options.client.request("session.create", {
          cwd: options.cwd,
          ...(options.currentModel === undefined ? {} : { modelId: options.currentModel }),
          ...(options.currentThinking === undefined
            ? {}
            : { thinkingLevel: options.currentThinking }),
        })
      : options.client.request("session.resume", {
          sessionId: options.sessionId,
        }))) as SessionSnapshot;

    const width =
      options.output.columns && options.output.columns > 0 ? options.output.columns : 80;
    const height = options.output.rows && options.output.rows > 0 ? options.output.rows : 24;
    const app = new AxlApp(
      options,
      snapshot.sessionId,
      width,
      height,
      await readGitBranch(options.cwd),
    );
    app.commitLines(app.welcomeLines(options.cwd, options.sessionId !== undefined), false);
    for (const event of snapshot.events) app.commitEvent(event, false);
    const lastEventId = snapshot.events.at(-1)?.id;
    const subscription = (await options.client.request("session.subscribe", {
      sessionId: snapshot.sessionId,
      ...(lastEventId === undefined ? {} : { afterEventId: lastEventId }),
    })) as { snapshot: readonly CanonicalEvent[] };
    for (const event of subscription.snapshot) app.commitEvent(event, false);
    for (const event of app.bufferedEvents ?? []) app.commitEvent(event, false);
    app.bufferedEvents = undefined;
    app.openNextInteraction();

    options.input.setRawMode?.(true);
    options.output.write(`${PASTE_ON}${KITTY_KEYS_ON}`);
    options.input.on("data", app.inputListener);
    options.output.on?.("resize", app.resizeListener);
    app.redraw();
    return app;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.setWorking(false);
    this.unsubscribeEvents();
    this.options.input.off?.("data", this.inputListener);
    this.options.output.off?.("resize", this.resizeListener);
    this.options.output.write(this.screen.clear());
    this.options.output.write(`${PASTE_OFF}${KITTY_KEYS_OFF}`);
    this.options.input.setRawMode?.(false);
    this.options.client.close();
    this.options.onExit?.();
  }

  private detectWidth(): number {
    return this.options.output.columns && this.options.output.columns > 0
      ? this.options.output.columns
      : 80;
  }

  private detectHeight(): number {
    return this.options.output.rows && this.options.output.rows > 0 ? this.options.output.rows : 24;
  }

  private welcomeLines(cwd: string, resumed: boolean): string[] {
    const { accent, dim } = this.view.palette;
    return [
      `${accent("◆ Axl")}  ${dim(resumed ? "resuming session" : "new session")}`,
      dim(`  ${cwd}`),
      dim("  /help for commands · Shift+Enter for a new line"),
      "",
    ];
  }

  private liveFrame(): { components: readonly Component[]; cursor?: CursorPlacement } {
    const unsafeWarning = this.view.unsafe
      ? (this.view.palette.warning ?? this.view.palette.error)(
          "⚠ UNSAFE: no sandbox; tools have full host access",
        )
      : undefined;
    if (this.modal !== null) {
      const lines = [
        ...(unsafeWarning === undefined ? [] : [unsafeWarning]),
        ...this.modal.render(this.width),
      ];
      const cursor = this.modal.cursor?.();
      return {
        components: [{ render: () => lines }],
        ...(cursor === undefined
          ? {}
          : {
              cursor: {
                row: cursor.row + (unsafeWarning === undefined ? 0 : 1),
                column: cursor.column,
              },
            }),
      };
    }

    if (this.width < 8) {
      const rendered = this.editor.render(Math.max(1, this.width - 2));
      return {
        components: [
          {
            render: () => [
              ...(unsafeWarning === undefined ? [] : [truncateToWidth(unsafeWarning, this.width)]),
              ...rendered.lines.map((line) => `❯ ${line}`),
            ],
          },
        ],
        cursor: {
          row: rendered.cursorRow + (unsafeWarning === undefined ? 0 : 1),
          column: 2 + rendered.cursorColumn,
        },
      };
    }

    const spinner = SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length] as string;
    const contentWidth = this.width - 4;
    const editorWidth = Math.max(1, contentWidth - 2);
    const rendered = this.editor.render(editorWidth);
    const boxLine = (gutter: string, text: string): string => {
      const content = `${gutter}${text}`;
      const padded = content + " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
      return `${this.view.frameBorder("│")} ${padded} ${this.view.frameBorder("│")}`;
    };
    const gutter = this.view.working ? `${spinner} ` : "❯ ";
    const contentLines = rendered.lines.map((line, row) =>
      boxLine(row === 0 ? gutter : "  ", line),
    );
    const completionHints = this.completions();
    const location = `${formatPath(this.cwd)}${this.branch ? `   ${this.branch}` : ""}`;
    const lines = [
      ...(unsafeWarning === undefined ? [] : [unsafeWarning]),
      ...(this.notice === undefined ? [] : [this.notice]),
      this.frameLine(this.view.usageLabel(), this.view.modelLabel(), "┌", "┐"),
      ...contentLines,
      this.frameLine(location, this.view.tpsLabel(), "└", "┘"),
      ...(completionHints ?? []),
    ];
    const contentStart =
      (unsafeWarning === undefined ? 0 : 1) + (this.notice === undefined ? 0 : 1) + 1;
    return {
      components: [{ render: () => lines }],
      cursor: { row: contentStart + rendered.cursorRow, column: 4 + rendered.cursorColumn },
    };
  }

  private frameLine(left: string, right: string, start: string, end: string): string {
    const inside = this.width - 2;
    const rightLabel = truncateToWidth(right ? ` ${right} ` : "", inside, "");
    const leftLabel = truncateToWidth(
      left ? ` ${left} ` : "",
      Math.max(0, inside - visibleWidth(rightLabel)),
      "",
    );
    const fill = "─".repeat(
      Math.max(0, inside - visibleWidth(leftLabel) - visibleWidth(rightLabel)),
    );
    return `${this.view.frameBorder(start)}${this.view.palette.dim(leftLabel)}${this.view.frameBorder(fill)}${this.view.palette.dim(rightLabel)}${this.view.frameBorder(end)}`;
  }

  private completions(): string[] | undefined {
    const text = this.editor.text;
    if (!/^\/[a-z]*$/.test(text)) return undefined;
    const matches = COMMANDS.filter((command) => command.name.startsWith(text)).slice(0, 6);
    if (matches.length === 0) return undefined;
    return matches.map(
      (command, index) =>
        `${index === 0 ? this.view.palette.accent("→") : " "} ${this.view.palette.accent(
          command.name.padEnd(12),
        )}${this.view.palette.dim(command.summary)}`,
    );
  }

  private redraw(): void {
    if (this.stopped) return;
    const { components, cursor } = this.liveFrame();
    this.options.output.write(this.screen.frame(components, cursor));
  }

  private setWorking(working: boolean): void {
    this.view.working = working;
    if (working && this.spinnerTimer === null) {
      const started = Date.now();
      this.view.elapsedSeconds = 0;
      this.spinnerTimer = setInterval(() => {
        this.spinnerIndex += 1;
        this.view.elapsedSeconds = Math.floor((Date.now() - started) / 1000);
        this.redraw();
      }, 120);
      this.spinnerTimer.unref?.();
    } else if (!working && this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      this.view.elapsedSeconds = 0;
    }
  }

  private commitEvent(event: CanonicalEvent, redraw = true): void {
    if (this.seenEventIds.has(event.id)) return;
    this.seenEventIds.add(event.id);
    this.transcript.push({ kind: "event", event });
    const lines = this.view.apply(event);
    if (event.type === "tool.result") void this.refreshBranch();
    if (event.type === "interaction.requested") {
      this.interactionQueue.push(event.payload);
      if (redraw) this.openNextInteraction();
    } else if (event.type === "interaction.resolved") {
      const queued = this.interactionQueue.findIndex(
        (request) => request.interactionId === event.payload.interactionId,
      );
      if (queued >= 0) this.interactionQueue.splice(queued, 1);
      if (this.activeInteractionId === event.payload.interactionId) {
        this.activeInteractionId = undefined;
        this.modal = null;
        this.openNextInteraction();
      }
    }
    if (lines.length > 0) this.commitLines(lines, false, false);
    if (redraw) this.redraw();
  }

  private handleInput(data: string): void {
    if (this.stopped) return;
    if (this.modal !== null) {
      this.modal.handleKey(data);
      if (!this.stopped) this.redraw();
      return;
    }

    for (let index = 0; index < data.length; ) {
      const modal = this.modal as Modal | null;
      if (modal !== null) {
        modal.handleKey(data.slice(index));
        break;
      }
      const decoded = decodeOneKey(data, index);
      const key = decoded.key;
      index = decoded.next;

      if (key.kind === "ctrl" && key.char === "c") this.handleInterruptKey();
      else if (key.kind === "ctrl" && key.char === "d") {
        if (this.editor.text.length === 0) this.stop();
        else this.editor.apply({ kind: "delete" });
      } else if (key.kind === "ctrl" && key.char === "l") {
        this.screen.invalidate();
      } else if (key.kind === "ctrl" && key.char === "o") {
        const mode = this.view.toggleToolOutput();
        this.notice = this.view.palette.dim(`· tool output ${mode}`);
      } else if (key.kind === "ctrl" && key.char === "t") {
        const mode = this.view.cycleThinkingDisplay();
        this.notice = this.view.palette.dim(`· thoughts ${mode}`);
      } else if (key.kind === "shift-tab") {
        void this.cycleThinkingLevel();
      } else if (key.kind === "tab") {
        const matches = COMMANDS.filter((command) => command.name.startsWith(this.editor.text));
        if (/^\/[a-z]*$/.test(this.editor.text) && matches.length > 0) {
          this.editor.setText((matches[0] as (typeof COMMANDS)[number]).name);
        } else this.editor.apply(key);
      } else if (key.kind === "escape") {
        this.editor.clear();
        this.notice = undefined;
      } else if (key.kind === "enter" || key.kind === "follow-up") {
        const line = this.editor.apply({ kind: "enter" });
        if (line !== undefined) this.submit(line.trim(), key.kind === "follow-up");
      } else {
        this.editor.apply(key);
      }
      if (this.stopped) return;
    }
    this.redraw();
  }

  private handleInterruptKey(): void {
    if (this.view.working) {
      void this.interrupt();
      return;
    }
    if (this.editor.text.length > 0) {
      this.editor.clear();
      this.notice = undefined;
      return;
    }
    const now = Date.now();
    if (now - this.lastInterrupt < 1_000) this.stop();
    else {
      this.lastInterrupt = now;
      this.notice = this.view.palette.dim("· Ctrl+C again to detach");
    }
  }

  private submit(line: string, prioritize = false): void {
    this.notice = undefined;
    if (!line) return;
    const [command, ...arguments_] = line.split(/\s+/);
    const argument = arguments_.join(" ");

    if (command === "/quit" || command === "/detach") {
      this.stop();
      return;
    }
    if (command === "/resume") {
      if (this.view.working)
        this.notice = this.view.palette.dim("· finish or interrupt the turn first");
      else void this.openResume();
      return;
    }
    if (command === "/fork") {
      if (this.view.working)
        this.notice = this.view.palette.dim("· finish or interrupt the turn first");
      else this.openFork();
      return;
    }
    if (command === "/clone") {
      if (this.view.working)
        this.notice = this.view.palette.dim("· finish or interrupt the turn first");
      else void this.cloneSession();
      return;
    }
    if (command === "/help") {
      const { dim, accent } = this.view.palette;
      this.commitLines([
        accent("Commands"),
        ...COMMANDS.map((item) => `  ${accent(item.name.padEnd(11))} ${dim(item.summary)}`),
        "",
        accent("Keys"),
        ...KEY_HELP.map((row) => `  ${dim(row)}`),
      ]);
      return;
    }
    if (command === "/status") {
      this.commitLines([
        this.view.palette.accent("Session"),
        `  id        ${this.sessionId}`,
        `  model     ${this.view.model ?? "?"}`,
        `  thinking  ${this.view.thinking ?? "?"}`,
        `  sandbox   ${this.view.sandbox ?? "?"}`,
        `  usage     ${this.view.usageLabel()}`,
        `  speed     ${this.view.tpsLabel() || "?"}`,
        `  queued    ${this.queued.length}`,
      ]);
      return;
    }
    if (command === "/theme") {
      this.selectTheme(argument);
      return;
    }
    if (command === "/model") {
      this.selectModel(argument);
      return;
    }
    if (command === "/thinking") {
      this.selectThinking(argument);
      return;
    }
    if (command === "/login" || command === "/reload") {
      if (this.view.working)
        this.notice = this.view.palette.dim("· finish or interrupt the turn first");
      else if (command === "/login") void this.openLogin();
      else void this.reload();
      return;
    }
    if (line.startsWith("/")) {
      this.notice = this.view.palette.error(`✖ unknown command ${command}`);
      return;
    }

    if (prioritize) this.queued.unshift(line);
    else this.queued.push(line);
    this.notice = this.view.working
      ? this.view.palette.dim(`· queued follow-up (${this.queued.length})`)
      : undefined;
    void this.drainQueue();
  }

  private commitLines(lines: readonly string[], redraw = true, remember = true): void {
    if (lines.length > 0) {
      if (remember) this.transcript.push({ kind: "lines", lines: [...lines] });
      this.options.output.write(this.screen.clear());
      this.options.output.write(`${lines.join("\n")}\n`);
    }
    if (redraw) this.redraw();
  }

  private rebuildAfterResize(): void {
    const previous = this.view;
    const next = new SessionView(this.width, previous.palette, this.options.modelCatalog);
    next.thinkingDisplay = previous.thinkingDisplay;
    next.toolOutputDisplay = previous.toolOutputDisplay;
    const lines: string[] = [];
    for (const entry of this.transcript) {
      if (entry.kind === "event") lines.push(...next.apply(entry.event));
      else lines.push(...entry.lines.flatMap((line) => wrapLine(line, this.width)));
    }
    next.working = previous.working;
    next.elapsedSeconds = previous.elapsedSeconds;
    next.tokensPerSecond = previous.tokensPerSecond;
    this.view = next;
    this.screen.reset(this.width);
    const history = lines.length === 0 ? "" : `${lines.join("\r\n")}\r\n`;
    this.options.output.write(`${SYNC_BEGIN}\x1b[2J\x1b[H\x1b[3J${history}${SYNC_END}`);
    this.redraw();
  }

  private async openResume(): Promise<void> {
    try {
      const sessions = (await this.options.client.request("session.list", {})) as SessionSummary[];
      if (sessions.length === 0) {
        this.notice = this.view.palette.dim("· no saved sessions");
        this.redraw();
        return;
      }
      let scope: "current" | "all" = "current";
      let sort: "threaded" | "recent" = "threaded";
      let filter = "";
      let index = 0;
      const visibleSessions = (): SessionSummary[] => {
        const query = filter.toLowerCase();
        return orderSessions(
          sessions.filter(
            (session) =>
              (scope === "all" || session.cwd === this.cwd) &&
              (!query ||
                session.sessionId.toLowerCase().includes(query) ||
                session.cwd.toLowerCase().includes(query) ||
                session.firstUserMessage?.toLowerCase().includes(query) ||
                session.lastUserMessage?.toLowerCase().includes(query)),
          ),
          sort,
        );
      };
      const modal: Modal = {
        render: () => {
          const filtered = visibleSessions();
          index = Math.min(index, Math.max(0, filtered.length - 1));
          const start = Math.max(
            0,
            Math.min(index - Math.floor(SELECTOR_WINDOW / 2), filtered.length - SELECTOR_WINDOW),
          );
          const shown = filtered.slice(start, start + SELECTOR_WINDOW);
          const scopeLabel = `${scope === "current" ? "●" : "○"} Current Folder  |  ${
            scope === "all" ? "●" : "○"
          } All  ·  Sort: ${sort === "threaded" ? "Threaded" : "Recent"}`;
          const rows = [
            this.view.palette.dim(scopeLabel),
            this.view.palette.dim("tab scope · ctrl+s sort · enter resume · escape/ctrl+c cancel"),
            `> ${filter}`,
            "",
            ...shown.flatMap((session, position) => {
              const selected = start + position === index;
              const message =
                session.lastUserMessage ?? session.firstUserMessage ?? "Session without a prompt";
              const line = truncateToWidth(
                `${selected ? this.view.palette.accent("›") : " "} ${
                  selected && this.view.palette.bold ? this.view.palette.bold(message) : message
                }`,
                this.width - 4,
                "…",
              );
              const current = session.sessionId === this.sessionId ? " · current" : "";
              const location = scope === "all" ? ` · ${formatPath(session.cwd)}` : "";
              return [
                line,
                this.view.palette.dim(
                  `  ${plural(session.userMessageCount, "message")} · ${relativeAge(session.updatedAt)}${current}${location}`,
                ),
                "",
              ];
            }),
            ...(filtered.length === 0 ? [this.view.palette.dim("No matching sessions")] : []),
            ...(filtered.length > SELECTOR_WINDOW
              ? [this.view.palette.dim(`(${index + 1}/${filtered.length})`)]
              : []),
          ];
          return renderDialog({
            title: `Resume Session (${scope === "current" ? "Current Folder" : "All"})`,
            rows,
            width: this.width,
            palette: this.view.palette,
          });
        },
        cursor: () => ({ row: 6, column: 4 + visibleWidth(filter) }),
        handleKey: (data) => {
          for (let at = 0; at < data.length; ) {
            const decoded = decodeOneKey(data, at);
            const key = decoded.key;
            at = decoded.next;
            const filtered = visibleSessions();
            if (key.kind === "tab") {
              scope = scope === "current" ? "all" : "current";
              index = 0;
            } else if (key.kind === "ctrl" && key.char === "s") {
              sort = sort === "threaded" ? "recent" : "threaded";
              index = 0;
            } else if (key.kind === "up" && filtered.length > 0) {
              index = (index - 1 + filtered.length) % filtered.length;
            } else if (key.kind === "down" && filtered.length > 0) {
              index = (index + 1) % filtered.length;
            } else if (key.kind === "enter") {
              const selected = filtered[index];
              if (selected) {
                this.modal = null;
                void this.resumeSession(selected.sessionId);
                return;
              }
            } else if (key.kind === "escape" || (key.kind === "ctrl" && key.char === "c")) {
              this.modal = null;
              return;
            } else if (key.kind === "backspace") {
              filter = filter.slice(0, -1);
              index = 0;
            } else if (key.kind === "char") {
              filter += key.char;
              index = 0;
            }
          }
        },
      };
      this.modal = modal;
      this.redraw();
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "could not list sessions"}`,
      );
      this.redraw();
    }
  }

  private openFork(): void {
    const messages = this.transcript.flatMap((entry) => {
      if (entry.kind !== "event") return [];
      const text = messageText(entry.event);
      return text === undefined ? [] : [{ id: entry.event.id, text }];
    });
    if (messages.length === 0) {
      this.notice = this.view.palette.dim("· no user messages to fork from");
      return;
    }
    let index = messages.length - 1;
    const modal: Modal = {
      render: () => {
        const start = Math.max(
          0,
          Math.min(index - Math.floor(SELECTOR_WINDOW / 2), messages.length - SELECTOR_WINDOW),
        );
        const shown = messages.slice(start, start + SELECTOR_WINDOW);
        return renderDialog({
          title: "Fork from Message",
          rows: [
            this.view.palette.dim(
              "Select a user message to copy the active path before it into a new session.",
            ),
            "",
            ...shown.flatMap((message, position) => [
              truncateToWidth(
                `${start + position === index ? this.view.palette.accent("›") : " "} ${
                  start + position === index && this.view.palette.bold
                    ? this.view.palette.bold(message.text)
                    : message.text
                }`,
                this.width - 4,
                "…",
              ),
              this.view.palette.dim(`  Message ${start + position + 1} of ${messages.length}`),
              "",
            ]),
            ...(messages.length > SELECTOR_WINDOW
              ? [this.view.palette.dim(`(${index + 1}/${messages.length})`)]
              : []),
          ],
          footer: "↑↓ navigate · enter fork · escape/ctrl+c cancel",
          width: this.width,
          palette: this.view.palette,
        });
      },
      handleKey: (data) => {
        for (let at = 0; at < data.length; ) {
          const decoded = decodeOneKey(data, at);
          const key = decoded.key;
          at = decoded.next;
          if (key.kind === "up") index = (index - 1 + messages.length) % messages.length;
          else if (key.kind === "down") index = (index + 1) % messages.length;
          else if (key.kind === "enter") {
            this.modal = null;
            void this.forkSession(messages[index]?.id);
            return;
          } else if (key.kind === "escape" || (key.kind === "ctrl" && key.char === "c")) {
            this.modal = null;
            return;
          }
        }
      },
    };
    this.modal = modal;
  }

  private async resumeSession(sessionId: string): Promise<void> {
    try {
      const snapshot = (await this.options.client.request("session.resume", {
        sessionId,
      })) as SessionSnapshot;
      await this.switchSession(snapshot, "", "· resumed session");
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "could not resume session"}`,
      );
      this.redraw();
    }
  }

  private async forkSession(fromEventId: string | undefined): Promise<void> {
    if (fromEventId === undefined) return;
    try {
      const forked = (await this.options.client.request("session.fork", {
        sessionId: this.sessionId,
        fromEventId,
      })) as SessionForkResult;
      await this.switchSession(forked, forked.selectedText ?? "", "· forked to new session");
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "could not fork session"}`,
      );
      this.redraw();
    }
  }

  private async cloneSession(): Promise<void> {
    try {
      const cloned = (await this.options.client.request("session.clone", {
        sessionId: this.sessionId,
      })) as SessionForkResult;
      await this.switchSession(cloned, "", "· cloned to new session");
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "could not clone session"}`,
      );
      this.redraw();
    }
  }

  private async switchSession(
    snapshot: SessionSnapshot,
    draft: string,
    notice: string,
  ): Promise<void> {
    const created = snapshot.events[0];
    if (created?.type !== "session.created") throw new Error("Session has no creation event");
    const palette = this.view.palette;
    const thinkingDisplay = this.view.thinkingDisplay;
    const toolOutputDisplay = this.view.toolOutputDisplay;
    this.sessionId = snapshot.sessionId;
    this.cwd = created.payload.cwd;
    this.branch = await readGitBranch(this.cwd);
    this.seenEventIds.clear();
    this.transcript.length = 0;
    this.interactionQueue.length = 0;
    this.activeInteractionId = undefined;
    this.bufferedEvents = [];
    this.view = new SessionView(this.width, palette, this.options.modelCatalog);
    this.view.thinkingDisplay = thinkingDisplay;
    this.view.toolOutputDisplay = toolOutputDisplay;
    this.transcript.push({ kind: "lines", lines: this.welcomeLines(this.cwd, true) });
    for (const event of snapshot.events) this.commitEvent(event, false);
    const lastEventId = snapshot.events.at(-1)?.id;
    const subscription = (await this.options.client.request("session.subscribe", {
      sessionId: snapshot.sessionId,
      ...(lastEventId === undefined ? {} : { afterEventId: lastEventId }),
    })) as { snapshot: readonly CanonicalEvent[] };
    for (const event of subscription.snapshot) this.commitEvent(event, false);
    for (const event of this.bufferedEvents ?? []) this.commitEvent(event, false);
    this.bufferedEvents = undefined;
    this.editor.setText(draft);
    this.notice = this.view.palette.dim(notice);
    this.openNextInteraction();
    this.rebuildAfterResize();
  }

  private selectTheme(name: string): void {
    if (name) {
      const palette = THEMES[name];
      if (!palette) {
        this.notice = this.view.palette.error(`✖ unknown theme ${name}`);
        return;
      }
      this.currentTheme = name;
      this.view.palette = palette;
      this.screen.invalidate();
      this.notice = palette.dim(`· theme ${name}`);
      void Promise.resolve(this.options.onThemeChange?.(name)).catch((error: unknown) => {
        this.notice = this.view.palette.error(
          `✖ ${error instanceof Error ? error.message : "could not save theme"}`,
        );
        this.redraw();
      });
      return;
    }
    this.openPicker({
      title: "Select theme",
      items: themeNames().map((value) => ({ value, label: value })),
      current: this.currentTheme,
      footer: "↑↓ navigate · enter select and save as default · escape/ctrl+c cancel",
      onPick: (value) => this.selectTheme(value),
    });
  }

  private selectModel(modelId: string): void {
    if (this.view.working) {
      this.notice = this.view.palette.dim("· finish or interrupt the turn first");
      return;
    }
    const models = this.options.models;
    if (!models?.length) {
      this.notice = this.view.palette.dim("· model selection is unavailable over this attachment");
      return;
    }
    if (modelId) {
      if (!models.includes(modelId)) {
        this.notice = this.view.palette.error(`✖ unknown model ${modelId}`);
        return;
      }
      void this.configure({ modelId });
      return;
    }
    const current = this.view.model ?? this.options.currentModel ?? "";
    const ordered = [...models].sort((left, right) => {
      if (left === current) return -1;
      if (right === current) return 1;
      return 0;
    });
    this.openPicker({
      title: "",
      intro: "Only showing models from configured providers. Use /login to update credentials.",
      items: ordered.map((id) => ({
        value: id,
        label: `${id} ${this.view.palette.dim("[azure-openai]")}`,
      })),
      current,
      detail: (value) => {
        const model = this.options.modelCatalog?.find((candidate) => candidate.modelId === value);
        if (!model) return [];
        return [
          this.view.palette.dim(`Model Name: ${model.displayName}`),
          this.view.palette.dim(
            `Context: ${compactCount(model.contextWindow)} · Max output: ${compactCount(model.maxOutputTokens)}`,
          ),
        ];
      },
      status: `Azure OpenAI catalog · ${models.length} models`,
      footer: "↑↓ navigate · enter select and save as default · escape/ctrl+c cancel",
      onPick: (value) => void this.configure({ modelId: value }),
    });
  }

  private selectThinking(level: string): void {
    if (this.view.working) {
      this.notice = this.view.palette.dim("· finish or interrupt the turn first");
      return;
    }
    const levels = this.thinkingLevels();
    if (level) {
      if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
        this.notice = this.view.palette.error(`✖ unknown thinking level ${level}`);
        return;
      }
      void this.configure({ thinkingLevel: level as ThinkingLevel });
      return;
    }
    this.openPicker({
      title: "Select thinking level",
      items: levels.map((value) => ({ value, label: value })),
      current: this.view.thinking ?? this.options.currentThinking ?? "medium",
      footer: "↑↓ navigate · enter select and save as default · escape/ctrl+c cancel",
      onPick: (value) => void this.configure({ thinkingLevel: value as ThinkingLevel }),
    });
  }

  private thinkingLevels(): readonly ThinkingLevel[] {
    const model = this.options.modelCatalog?.find(
      (candidate) => candidate.modelId === this.view.model,
    );
    return model ? supportedThinkingLevels(model) : THINKING_LEVELS;
  }

  private async cycleThinkingLevel(): Promise<void> {
    if (this.view.working) {
      this.notice = this.view.palette.dim(
        "· finish or interrupt the turn before changing thinking",
      );
      this.redraw();
      return;
    }
    const levels = this.thinkingLevels();
    const current = levels.indexOf(
      (this.view.thinking ?? this.options.currentThinking ?? "medium") as ThinkingLevel,
    );
    const next = levels[(current + 1 + levels.length) % levels.length] as ThinkingLevel;
    await this.configure({ thinkingLevel: next });
  }

  private openPicker(input: {
    readonly title: string;
    readonly intro?: string;
    readonly items: readonly { readonly value: string; readonly label: string }[];
    readonly current: string;
    readonly detail?: (value: string) => readonly string[];
    readonly status?: string;
    readonly footer?: string;
    readonly onPick: (value: string) => void;
  }): void {
    const { title, intro, items, current, detail, status, footer, onPick } = input;
    const { dim, accent } = this.view.palette;
    let filter = "";
    let index = Math.max(
      0,
      items.findIndex((item) => item.value === current),
    );
    const filtered = (): readonly { value: string; label: string }[] =>
      filter
        ? items.filter((item) => item.value.toLowerCase().includes(filter.toLowerCase()))
        : items;
    const pick = (item: { value: string }): void => {
      this.modal = null;
      onPick(item.value);
      this.openNextInteraction();
    };
    const modal: Modal = {
      render: () => {
        const list = filtered();
        index = Math.min(index, Math.max(0, list.length - 1));
        const windowStart = Math.max(
          0,
          Math.min(index - Math.floor(SELECTOR_WINDOW / 2), list.length - SELECTOR_WINDOW),
        );
        const visible = list.slice(windowStart, windowStart + SELECTOR_WINDOW);
        const selected = list[index];
        const rows = [
          ...(intro === undefined ? [] : [(this.view.palette.warning ?? accent)(intro), ""]),
          `> ${filter}`,
          "",
          ...(windowStart > 0 ? [dim(`↑ ${windowStart} more`)] : []),
          ...visible.map((item, position) => {
            const selectedRow = windowStart + position === index;
            const currentMark =
              item.value === current ? (this.view.palette.success ?? accent)(" ✓") : "";
            return `${selectedRow ? accent("→") : " "} ${item.label}${currentMark}`;
          }),
          ...(list.length === 0 ? [dim("No matches")] : []),
          ...(windowStart + SELECTOR_WINDOW < list.length
            ? [dim(`↓ ${list.length - windowStart - SELECTOR_WINDOW} more`)]
            : []),
          ...(list.length > 0 ? [dim(`(${index + 1}/${list.length})`)] : []),
          ...(selected === undefined || detail === undefined
            ? []
            : ["", ...detail(selected.value)]),
          ...(status === undefined ? [] : ["", (this.view.palette.success ?? accent)(status)]),
        ];
        return renderDialog({
          title,
          rows,
          footer: footer ?? "↑↓ navigate · enter select · escape/ctrl+c cancel",
          width: this.width,
          palette: this.view.palette,
        });
      },
      cursor: () => ({ row: 4, column: 4 + visibleWidth(filter) }),
      handleKey: (data) => {
        const keys = [];
        for (let at = 0; at < data.length; ) {
          const decoded = decodeOneKey(data, at);
          keys.push(decoded.key);
          at = decoded.next;
        }
        for (const key of keys) {
          const list = filtered();
          if (key.kind === "up")
            index = (index - 1 + Math.max(1, list.length)) % Math.max(1, list.length);
          else if (key.kind === "down") index = (index + 1) % Math.max(1, list.length);
          else if (key.kind === "enter") {
            const chosen = list[index];
            if (chosen) pick(chosen);
          } else if (key.kind === "escape" || (key.kind === "ctrl" && key.char === "c")) {
            this.modal = null;
            this.openNextInteraction();
          } else if (key.kind === "backspace") {
            filter = filter.slice(0, -1);
            index = 0;
          } else if (key.kind === "char") {
            if (/^[1-9]$/.test(key.char) && !filter && Number(key.char) <= list.length) {
              pick(list[Number(key.char) - 1] as { value: string });
            } else {
              filter += key.char;
              index = 0;
            }
          }
        }
      },
    };
    this.modal = modal;
  }

  private openNextInteraction(): void {
    if (this.modal || this.interactionQueue.length === 0) return;
    const request = this.interactionQueue.shift() as EventPayloadMap["interaction.requested"];
    this.activeInteractionId = request.interactionId;
    if (request.kind === "mcp_elicitation_form") this.openInteractionForm(request);
    else this.openInteractionApproval(request);
  }

  private openInteractionApproval(request: EventPayloadMap["interaction.requested"]): void {
    const { dim, accent } = this.view.palette;
    const url = interactionUrl(request.data);
    const detail = JSON.stringify(request.data ?? {}, null, 2)
      .split("\n")
      .slice(0, 12);
    const finish = (action: "accept" | "decline" | "cancel"): void => {
      if (action === "accept" && url) {
        try {
          openExternalUrl(url, (error) => {
            this.notice = this.view.palette.error(`✖ Cannot open browser: ${error.message}`);
            this.redraw();
          });
        } catch (error) {
          this.notice = this.view.palette.error(
            `✖ ${error instanceof Error ? error.message : "Cannot open URL"}`,
          );
          return;
        }
      }
      this.modal = null;
      void this.respondToInteraction(request.interactionId, action);
    };
    const modal: Modal = {
      render: () =>
        renderDialog({
          title: "MCP approval",
          rows: [
            accent(request.source),
            request.message,
            ...(url ? ["", accent(url)] : []),
            "",
            ...detail.map((line) => dim(line)),
          ],
          footer: "Y accept · N decline · Esc cancel",
          width: this.width,
          palette: this.view.palette,
        }),
      handleKey: (data) => {
        for (let at = 0; at < data.length; ) {
          const decoded = decodeOneKey(data, at);
          at = decoded.next;
          if (
            decoded.key.kind === "escape" ||
            (decoded.key.kind === "ctrl" && decoded.key.char === "c")
          ) {
            finish("cancel");
            return;
          }
          if (decoded.key.kind === "char" && decoded.key.char.toLowerCase() === "y") {
            finish("accept");
            return;
          }
          if (decoded.key.kind === "char" && decoded.key.char.toLowerCase() === "n") {
            finish("decline");
            return;
          }
        }
      },
    };
    this.modal = modal;
  }

  private openInteractionForm(request: EventPayloadMap["interaction.requested"]): void {
    const requestData = jsonObject(request.data?.request);
    const schema = jsonObject(requestData?.requestedSchema);
    const properties = jsonObject(schema?.properties);
    if (!schema || !properties) {
      void this.respondToInteraction(request.interactionId, "decline");
      return;
    }
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === "string")
        : [],
    );
    const fields = Object.entries(properties).flatMap(([name, value]) => {
      const field = jsonObject(value);
      return field ? [{ name, schema: field }] : [];
    });
    let index = 0;
    let draft = "";
    let error: string | undefined;
    let confirming = fields.length === 0;
    const values: Record<string, JsonValue> = {};
    const finish = (action: "accept" | "decline" | "cancel", content?: JsonObject): void => {
      this.modal = null;
      void this.respondToInteraction(request.interactionId, action, content);
    };
    const modal: Modal = {
      render: () => {
        const field = fields[index];
        const rows = [
          this.view.palette.accent(request.source),
          request.message,
          "",
          ...fields.map((item, fieldIndex) => {
            const marker =
              fieldIndex === index && !confirming
                ? "❯"
                : Object.hasOwn(values, item.name)
                  ? "✓"
                  : " ";
            const value = values[item.name];
            return `${marker} ${item.name}${value === undefined ? "" : `: ${JSON.stringify(value)}`}`;
          }),
          ...(confirming
            ? ["", this.view.palette.accent("Submit these values?"), JSON.stringify(values)]
            : [
                "",
                `${field?.name ?? "value"}: ${draft}`,
                ...(typeof field?.schema.description === "string"
                  ? [this.view.palette.dim(field.schema.description)]
                  : []),
              ]),
          ...(error ? [this.view.palette.error(`✖ ${error}`)] : []),
        ];
        return renderDialog({
          title: "MCP input",
          rows,
          footer: confirming
            ? "Enter/Y submit · N edit · Esc cancel"
            : "Enter next · Ctrl+D decline · Esc cancel",
          width: this.width,
          palette: this.view.palette,
        });
      },
      cursor: () => {
        if (confirming) return undefined;
        const name = fields[index]?.name ?? "value";
        return { row: fields.length + 8, column: 2 + visibleWidth(`${name}: ${draft}`) };
      },
      handleKey: (data) => {
        for (let at = 0; at < data.length; ) {
          const decoded = decodeOneKey(data, at);
          const key = decoded.key;
          at = decoded.next;
          if (key.kind === "escape" || (key.kind === "ctrl" && key.char === "c")) {
            finish("cancel");
            return;
          }
          if (key.kind === "ctrl" && key.char === "d") {
            finish("decline");
            return;
          }
          if (confirming) {
            if (key.kind === "enter" || (key.kind === "char" && key.char.toLowerCase() === "y")) {
              finish("accept", values);
              return;
            }
            if (key.kind === "char" && key.char.toLowerCase() === "n") {
              confirming = false;
              index = Math.max(0, fields.length - 1);
              draft = "";
            }
            continue;
          }
          if (key.kind === "backspace") draft = draft.slice(0, -1);
          else if (key.kind === "char") draft += key.char;
          else if (key.kind === "enter") {
            const field = fields[index];
            if (!field) {
              confirming = true;
              continue;
            }
            try {
              const value = formValue(
                field.name,
                field.schema,
                draft.trim(),
                required.has(field.name),
              );
              if (value === undefined) delete values[field.name];
              else values[field.name] = value;
              error = undefined;
              draft = "";
              index += 1;
              confirming = index >= fields.length;
            } catch (caught) {
              error = caught instanceof Error ? caught.message : "Invalid value";
            }
          }
        }
      },
    };
    this.modal = modal;
  }

  private async respondToInteraction(
    interactionId: string,
    action: "accept" | "decline" | "cancel",
    content?: JsonObject,
  ): Promise<void> {
    try {
      await this.options.client.request("session.interaction.respond", {
        sessionId: this.sessionId,
        interactionId,
        action,
        ...(content === undefined ? {} : { content }),
      });
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "interaction response failed"}`,
      );
    } finally {
      if (this.activeInteractionId === interactionId) this.activeInteractionId = undefined;
      this.openNextInteraction();
      this.redraw();
    }
  }

  private async openLogin(): Promise<void> {
    const credentials = this.options.credentials;
    if (!credentials) {
      this.notice = this.view.palette.dim("· login is unavailable over this attachment");
      return;
    }
    try {
      const stored = await credentials.store.read("azure-openai");
      this.modal = new LoginDialog({
        store: credentials.store,
        context: credentials.context,
        ...(credentials.fetch === undefined ? {} : { fetch: credentials.fetch }),
        ...(stored?.type === "api_key" ? { currentCredential: stored } : {}),
        palette: this.view.palette,
        width: this.width,
        refresh: () => this.redraw(),
        close: (summary) => {
          this.modal = null;
          this.commitLines([this.view.palette.dim(summary)]);
          this.openNextInteraction();
        },
      });
      this.redraw();
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "could not read credentials"}`,
      );
      this.redraw();
    }
  }

  private async configure(update: {
    modelId?: string;
    thinkingLevel?: ThinkingLevel;
  }): Promise<void> {
    if (this.configuring) {
      this.notice = this.view.palette.dim("· configuration change already in progress");
      this.redraw();
      return;
    }
    this.configuring = true;
    try {
      await this.options.client.request("session.configure", {
        sessionId: this.sessionId,
        ...update,
      });
      if (update.modelId) await this.options.onModelChange?.(update.modelId);
      if (update.thinkingLevel) await this.options.onThinkingChange?.(update.thinkingLevel);
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "configuration failed"}`,
      );
    } finally {
      this.configuring = false;
    }
    this.redraw();
  }

  private async drainQueue(): Promise<void> {
    if (this.sending || this.stopped) return;
    this.sending = true;
    try {
      while (this.queued.length > 0 && !this.stopped) {
        const text = this.queued.shift() as string;
        this.setWorking(true);
        this.view.beginResponse();
        this.redraw();
        try {
          await this.options.client.request("session.send", {
            sessionId: this.sessionId,
            content: [{ type: "text", text }],
          });
        } catch (error) {
          this.notice = this.view.palette.error(
            `✖ ${error instanceof Error ? error.message : "send failed"}`,
          );
          break;
        }
      }
    } finally {
      this.sending = false;
      this.setWorking(false);
      this.redraw();
    }
  }

  private async refreshBranch(): Promise<void> {
    const branch = await readGitBranch(this.cwd);
    if (branch !== this.branch) {
      this.branch = branch;
      this.redraw();
    }
  }

  private async reload(): Promise<void> {
    try {
      await this.options.client.request("session.reload", { sessionId: this.sessionId });
      await this.refreshBranch();
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "reload failed"}`,
      );
      this.redraw();
    }
  }

  private async interrupt(): Promise<void> {
    try {
      await this.options.client.request("session.interrupt", { sessionId: this.sessionId });
    } catch {
      this.notice = this.view.palette.dim("· turn already finished");
      this.redraw();
    }
  }
}
