// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  type TerminalCommandContext,
  type TerminalExtension,
  TerminalExtensionHost,
  type TerminalLine,
} from "@axl/extension-api";
import type {
  BlobReference,
  CanonicalEvent,
  EventPayloadMap,
  JsonObject,
  JsonValue,
  SessionId,
  SessionOpenResult,
  SessionProfile,
  SessionSummary,
  ThinkingLevel,
} from "@axl/protocol";
import { parseEventId, parseOperationId, parseSessionId } from "@axl/protocol";
import {
  type AxlClient,
  type ClientModelInfo,
  ConversationProjector,
  type SessionSubscription,
  subscribeSession,
  supportedThinkingLevels,
  THINKING_LEVELS,
} from "@axl/sdk";

import { ActivityComponent } from "./activity.ts";
import { droppedImages, type LocalAttachment, readImageFile } from "./attachments.ts";
import { readClipboardText, writeClipboardText } from "./clipboard.ts";
import { DeveloperPanelComponent } from "./developer-panel.ts";
import { renderDialog } from "./dialog.ts";
import {
  type DiffLayout,
  DiffReviewOverlay,
  type WorkspaceReview,
  type WorkspaceReviewScope,
} from "./diff-review.ts";
import { decodeOneKey, LineEditor } from "./editor.ts";
import { EditorFrameComponent } from "./editor-frame.ts";
import { ExtensionWidgetsComponent } from "./extension-ui.ts";
import { editPromptExternally } from "./external-editor.ts";
import { type FullscreenMouse, FullscreenScreen } from "./fullscreen.ts";
import { isMouseReport } from "./fullscreen-input.ts";
import { LiveAssistantComponent } from "./live-assistant.ts";
import type { LoginDialogDefinition } from "./login-dialog.ts";
import {
  AttachmentBarComponent,
  detectTerminalMedia,
  type ImageDisplay,
  MediaCache,
  type TerminalMediaCapabilities,
  uploadBlob,
} from "./media.ts";
import { type Overlay, OverlayStack } from "./overlay.ts";
import { PickerOverlay } from "./picker.ts";
import {
  AUTOWRAP_OFF,
  AUTOWRAP_ON,
  type Component,
  type CursorPlacement,
  DifferentialScreen,
  SYNC_BEGIN,
  SYNC_END,
  sanitizeTerminalText,
  truncateToWidth,
  visibleWidth,
  wrapLine,
} from "./render.ts";
import { ComponentStack } from "./stack.ts";
import {
  assertInteractiveTerminal,
  type TerminalInput,
  type TerminalOutput,
  TerminalSession,
} from "./terminal.ts";
import { DEFAULT_THEME, THEME_DEFINITIONS, THEMES, themeNames } from "./themes.ts";
import { ToolTransactionStore } from "./tool-transaction.ts";
import { type Palette, PLAIN_PALETTE, SessionView, type ToolOutputDisplay } from "./transcript.ts";
import {
  type TranscriptAppendOptions,
  TranscriptDocument,
  type TranscriptRow,
} from "./transcript-document.ts";
import { VimModeController } from "./vim-mode.ts";

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const RESIZE_DEBOUNCE_MS = 25;
const SESSION_SELECTOR_WINDOW = 10;
const MAX_EXTENSION_COMPLETIONS = 100;
const MAX_EXTENSION_SELECTOR_ITEMS = 1_000;
const MAX_EXTENSION_TEXT_CHARACTERS = 512;

async function resumeSessionMetadata(
  client: AxlClient,
  sessionId: string,
): Promise<SessionOpenResult> {
  const resumed = await client.request("session.resume", { sessionId: parseSessionId(sessionId) });
  if (resumed.sessionId !== sessionId) throw new Error("Daemon resumed the wrong session");
  return resumed;
}

function extensionSingleLine(value: string): string {
  return sanitizeTerminalText(value)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_EXTENSION_TEXT_CHARACTERS);
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
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
    .replace(/\s+/gu, " ")
    .trim();
  return text || undefined;
}

function orderSessions<T extends SessionSummary>(sessions: readonly T[]): T[] {
  return [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
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
  // Patterns originate in an MCP server and JavaScript regex evaluation has no timeout.
  // Leave pattern enforcement to the server rather than allowing a schema to block the TUI.
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
  { name: "/model", summary: "select a model, or /model <id>" },
  { name: "/thinking", summary: "select reasoning effort" },
  { name: "/theme", summary: "select a color theme" },
  { name: "/settings", summary: "change persistent terminal preferences" },
  { name: "/details", summary: "set transcript detail: compact, full, or focus" },
  { name: "/fullscreen", summary: "switch to fullscreen transcript mode" },
  { name: "/regular", summary: "return to terminal scrollback mode" },
  { name: "/login", summary: "configure provider credentials" },
  { name: "/reload", summary: "reload AGENTS.md, prompt, and tools" },
  { name: "/compact", summary: "summarize older context, optionally with instructions" },
  { name: "/status", summary: "show session, display, and queue state" },
  { name: "/requeue", summary: "re-queue a paused prompt by queue item ID" },
  { name: "/resume", summary: "open another saved session" },
  { name: "/fork", summary: "fork from an earlier user message" },
  { name: "/clone", summary: "clone the complete current session" },
  { name: "/export", summary: "export the current session artifact" },
  { name: "/stash", summary: "stash, restore, swap, or clear the prompt" },
  { name: "/favorite", summary: "toggle a model in the favorites list" },
  { name: "/developer", summary: "toggle the optional developer panel" },
  { name: "/review", summary: "review working-tree or last-turn changes" },
  { name: "/attach", summary: "attach an image file to the next prompt" },
  { name: "/vim", summary: "toggle optional Vim editing" },
  { name: "/commands", summary: "browse and search available commands" },
  { name: "/history", summary: "search prompt history" },
  { name: "/edit", summary: "open the prompt in VISUAL or EDITOR" },
  { name: "/hotkeys", summary: "browse and search keyboard shortcuts" },
  { name: "/help", summary: "show commands and keys" },
  { name: "/detach", summary: "leave the session running in the daemon" },
  { name: "/quit", summary: "alias for /detach" },
];

const RESERVED_EXTENSION_INPUTS = new Set(["\r", "\n", "\x1b", "\x03", "\x04", "\x0f", "\x1a"]);

function isReservedExtensionShortcut(value: string): boolean {
  if (RESERVED_EXTENSION_INPUTS.has(value)) return true;
  const decoded = decodeOneKey(value, 0);
  if (decoded.next !== value.length) return true;
  if (
    decoded.key.kind === "enter" ||
    decoded.key.kind === "newline" ||
    decoded.key.kind === "follow-up" ||
    decoded.key.kind === "escape"
  ) {
    return true;
  }
  return (
    decoded.key.kind === "ctrl" && ["c", "d", "o", "z"].includes(decoded.key.char.toLowerCase())
  );
}

const HOTKEYS: readonly { readonly key: string; readonly action: string }[] = [
  { key: "Enter", action: "Send, or steer the active turn" },
  { key: "Shift+Enter / Ctrl+J", action: "Insert a newline" },
  { key: "\\ then Enter", action: "Insert a newline in every terminal" },
  { key: "Alt+Enter", action: "Queue a follow-up after the active turn" },
  { key: "Ctrl+A", action: "Select the entire prompt" },
  { key: "Ctrl+C", action: "Copy selection, interrupt, or clear" },
  { key: "Ctrl+X", action: "Cut the selection" },
  { key: "Ctrl+V", action: "Paste text from the clipboard" },
  { key: "Shift+Left/Right", action: "Extend the selection" },
  { key: "Ctrl+Shift+Left/Right", action: "Extend selection by word" },
  { key: "Ctrl+Backspace / Ctrl+W", action: "Delete the previous word" },
  { key: "Ctrl+U", action: "Delete to the start of the line" },
  { key: "Ctrl+K", action: "Delete to the end of the line" },
  { key: "Ctrl+Y", action: "Yank the last deleted text" },
  { key: "Ctrl+Shift+_", action: "Undo the last edit" },
  { key: "Ctrl+Shift+Z", action: "Redo the last undone edit" },
  { key: "Ctrl+B/F", action: "Move backward or forward by character" },
  { key: "Alt+B/F", action: "Move backward or forward by word" },
  { key: "Esc", action: "Interrupt the operation or clear the prompt" },
  { key: "Ctrl+G", action: "Open the prompt in an external editor" },
  { key: "Alt+S", action: "Stash or restore the prompt" },
  { key: "Ctrl+R", action: "Search prompt history" },
  { key: "Ctrl+O", action: "Expand or collapse tool details" },
  { key: "Ctrl+T", action: "Change thought visibility" },
  { key: "Shift+Tab", action: "Change reasoning effort" },
  { key: "Tab", action: "Complete a slash command" },
  { key: "Ctrl+D", action: "Detach when the prompt is empty" },
  { key: "Ctrl+L", action: "Repaint the terminal" },
  { key: "Ctrl+F", action: "Search the fullscreen transcript" },
  { key: "PageUp/PageDown", action: "Navigate the fullscreen transcript" },
  { key: "Shift+PageUp/PageDown", action: "Navigate by half a page" },
  { key: "Alt+Up/Down", action: "Navigate the transcript by line" },
  { key: "Ctrl+Shift+Up/Down", action: "Jump between user prompts" },
  { key: "Ctrl+Z", action: "Suspend the terminal" },
  { key: "!command", action: "Run shell and include output in context" },
  { key: "!!command", action: "Run shell without adding model context" },
];

const KEY_HELP: readonly string[] = [
  "Enter send/steer · Alt+Enter follow-up · Shift+Enter/Ctrl+J newline",
  "Esc/Ctrl+C interrupt · Ctrl+O tool details · /hotkeys for every shortcut",
];

function themePreview(width: number, palette: Palette): readonly string[] {
  if (width < 12) return [palette.accent("Preview"), palette.dim("compact")];
  const border = palette.border ?? palette.dim;
  const contentWidth = Math.max(1, width - 6);
  const fit = (value: string): string => {
    const clipped = truncateToWidth(value, contentWidth, "");
    return `${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}`;
  };
  const toolRow = (value: string): string => {
    const content = ` ${fit(value)} `;
    return `  ${border("│")}${palette.toolBackground?.(content) ?? content}${border("│")}`;
  };
  return [
    (palette.bold ?? palette.accent)("Theme preview"),
    `${palette.accent("accent")}  ${palette.success?.("success") ?? palette.accent("success")}  ${palette.warning?.("warning") ?? palette.accent("warning")}  ${palette.error("error")}`,
    palette.dim("muted metadata and secondary text"),
    "",
    `  ${border(`╭${"─".repeat(Math.max(1, width - 4))}╮`)}`,
    toolRow(`${palette.accent("read")} packages/tui/src/app.ts`),
    toolRow(`${palette.success?.("done") ?? palette.accent("done")} · 42 lines`),
    `  ${border(`╰${"─".repeat(Math.max(1, width - 4))}╯`)}`,
  ];
}

export interface ResumeSessionEntry extends SessionSummary {
  readonly resumeKey: string;
  readonly placementLabel: string;
  readonly unsafe: boolean;
}

export interface ResumeSessionConnection {
  readonly client: AxlClient;
  readonly reconnectClient: () => Promise<AxlClient>;
}

export interface AxlAppOptions {
  readonly client: AxlClient;
  readonly reconnectClient?: () => Promise<AxlClient>;
  readonly listResumeSessions?: () => Promise<readonly ResumeSessionEntry[]>;
  readonly openResumeSession?: (session: ResumeSessionEntry) => Promise<ResumeSessionConnection>;
  readonly initialResume?: boolean;
  readonly input: TerminalInput;
  readonly output: TerminalOutput;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly color?: boolean;
  readonly theme?: string;
  readonly models?: readonly string[];
  readonly modelCatalog?: readonly ClientModelInfo[];
  readonly currentModel?: string;
  readonly currentThinking?: ThinkingLevel;
  readonly profile?: SessionProfile;
  readonly webFetch?: boolean;
  readonly webSearch?: boolean;
  readonly toolOutputDisplay?: ToolOutputDisplay;
  readonly thinkingDisplay?: "show" | "compact" | "hide";
  readonly tuiMode?: "regular" | "fullscreen";
  readonly fullscreenExitOutput?: "transcript" | "resume-hint";
  readonly fullscreenScrollbar?: "auto" | "always" | "hidden";
  readonly fullscreenMouse?: FullscreenMouse;
  readonly attention?: "off" | "bell";
  readonly editorMode?: "standard" | "vim";
  readonly modelFavorites?: readonly string[];
  readonly refocusRecap?: boolean;
  readonly developerPanel?: boolean;
  readonly diffLayout?: DiffLayout;
  readonly workspaceReview?: boolean;
  readonly imageDisplay?: ImageDisplay;
  readonly mediaCapabilities?: TerminalMediaCapabilities;
  readonly extensions?: readonly TerminalExtension[];
  readonly onPreferenceChange?: (update: {
    modelId?: string;
    thinkingLevel?: ThinkingLevel;
    webFetch?: boolean;
    webSearch?: boolean;
    theme?: string;
    toolOutputDisplay?: ToolOutputDisplay;
    thinkingDisplay?: "show" | "compact" | "hide";
    tuiMode?: "regular" | "fullscreen";
    fullscreenExitOutput?: "transcript" | "resume-hint";
    fullscreenScrollbar?: "auto" | "always" | "hidden";
    fullscreenMouse?: FullscreenMouse;
    attention?: "off" | "bell";
    editorMode?: "standard" | "vim";
    modelFavorites?: readonly string[];
    refocusRecap?: boolean;
    developerPanel?: boolean;
    diffLayout?: DiffLayout;
    workspaceReview?: boolean;
    imageDisplay?: ImageDisplay;
  }) => void | Promise<void>;
  /** Compatibility hook called after the daemon accepts a model switch. */
  readonly onModelChange?: (modelId: string) => void;
  readonly suspendProcess?: () => void;
  readonly loadLogin?: () => Promise<LoginDialogDefinition>;
  readonly onExit?: () => void;
  readonly clearStartupLine?: boolean;
  readonly readClipboard?: () => Promise<string>;
  readonly writeClipboard?: (text: string) => Promise<void>;
  readonly editPrompt?: (content: string) => Promise<string>;
}

type TranscriptEntry =
  | { readonly kind: "event"; readonly event: CanonicalEvent }
  | { readonly kind: "lines"; readonly lines: readonly string[] };

/** A terminal projection over one daemon-owned Axl session. */
export class AxlApp {
  sessionId: SessionId;
  private cwd: string;
  private readonly options: AxlAppOptions;
  private client: AxlClient;
  private reconnectClient: (() => Promise<AxlClient>) | undefined;
  private readonly screen: DifferentialScreen;
  private view: SessionView;
  private readonly editor = new LineEditor();
  private readonly editorFrame: EditorFrameComponent;
  private readonly activity: ActivityComponent;
  private readonly liveAssistant: LiveAssistantComponent;
  private readonly attachmentBar: AttachmentBarComponent;
  private readonly mediaCache: MediaCache;
  private readonly liveRoot = new ComponentStack();
  private readonly extensionHost: TerminalExtensionHost;
  private readonly extensionWidgetsAbove: ExtensionWidgetsComponent;
  private readonly extensionWidgetsBelow: ExtensionWidgetsComponent;
  private readonly extensionCommandControllers = new Set<AbortController>();
  private readonly fullscreen: FullscreenScreen;
  private tuiMode: "regular" | "fullscreen";
  private fullscreenExitOutput: "transcript" | "resume-hint";
  private fullscreenScrollbar: "auto" | "always" | "hidden";
  private fullscreenMouse: FullscreenMouse;
  private attention: "off" | "bell";
  private editorMode: "standard" | "vim";
  private readonly vim = new VimModeController();
  private modelFavorites: string[];
  private refocusRecap: boolean;
  private developerPanelEnabled: boolean;
  private diffLayout: DiffLayout;
  private workspaceReviewEnabled: boolean;
  private imageDisplay: ImageDisplay;
  private readonly pendingAttachments: BlobReference[] = [];
  private attachmentBusy = false;
  private stashedPrompt: string | undefined;
  private workspaceDiff: WorkspaceReview | undefined;
  private workspaceDiffError: string | undefined;
  private workspaceDiffGeneration = 0;
  private readonly developerPanel: DeveloperPanelComponent;
  private awayCompletedTurns = 0;
  private readonly awayChangedFiles = new Set<string>();
  private readonly document = new TranscriptDocument();
  private fullscreenRowsCache: readonly TranscriptRow[] | undefined;
  private width: number;
  private height: number;
  private readonly transcript: TranscriptEntry[] = [];
  private notice: string | undefined;
  private readonly overlays = new OverlayStack();
  private stopped = false;
  private spinnerIndex = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private completionIndex = 0;
  private completionText = "";
  private unsubscribeDisconnect: () => void = () => undefined;
  private sessionSubscription: SessionSubscription | undefined;
  private readonly queued: Array<{
    readonly text: string;
    readonly attachments: readonly BlobReference[];
  }> = [];
  private readonly pendingTurnInputs: Array<{
    readonly mode: "steer" | "followUp";
    readonly contentKey: string;
  }> = [];
  private sending = false;
  private activeRequest: "turn" | "shell" | "compaction" | undefined;
  private configuring = false;
  private webFetchEnabled: boolean;
  private webSearchEnabled: boolean;
  private initialResumePending: boolean;
  private lastInterrupt = 0;
  private branch: string | undefined;
  private currentTheme: string;
  private readonly seenEventIds = new Set<string>();
  private hydrating = true;
  private readonly interactionQueue: EventPayloadMap["interaction.requested"][] = [];
  private activeInteractionId: string | undefined;
  private interactionResponding = false;
  private interactionError: string | undefined;
  private readonly toolTransactions: ToolTransactionStore;
  private readonly terminal: TerminalSession;
  private connectionState: "connected" | "reconnecting" | "detached" = "connected";
  private reconnectGeneration = 0;
  private reconnectAttempts = 0;
  private lastReconnectError: string | undefined;
  private focused = true;
  private lastAttentionAt = 0;

  private resizeTimer: NodeJS.Timeout | undefined;
  private activityRenderTimer: NodeJS.Timeout | undefined;

  private readonly resizeListener = (): void => {
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      this.applyResize();
    }, RESIZE_DEBOUNCE_MS);
    this.resizeTimer.unref?.();
  };

  private constructor(
    options: AxlAppOptions,
    sessionId: SessionId,
    cwd: string,
    width: number,
    height: number,
    branch: string | undefined,
  ) {
    this.options = options;
    this.client = options.client;
    this.reconnectClient = options.reconnectClient;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.width = width;
    this.height = height;
    this.screen = new DifferentialScreen(width);
    this.tuiMode = options.tuiMode ?? "regular";
    this.fullscreenExitOutput = options.fullscreenExitOutput ?? "transcript";
    this.fullscreenScrollbar = options.fullscreenScrollbar ?? "auto";
    this.fullscreenMouse = options.fullscreenMouse ?? "capture";
    this.attention = options.attention ?? "off";
    this.editorMode = options.editorMode ?? "standard";
    this.modelFavorites = [...(options.modelFavorites ?? [])];
    this.refocusRecap = options.refocusRecap ?? false;
    this.developerPanelEnabled = options.developerPanel ?? false;
    this.diffLayout = options.diffLayout ?? "unified";
    this.workspaceReviewEnabled = options.workspaceReview ?? false;
    this.imageDisplay = options.imageDisplay ?? "auto";
    this.webFetchEnabled = options.webFetch ?? true;
    this.webSearchEnabled = options.webSearch ?? true;
    this.initialResumePending = options.initialResume ?? false;
    this.mediaCache = new MediaCache(
      () => this.client,
      sessionId,
      options.mediaCapabilities ?? detectTerminalMedia(),
      () => this.imageDisplay,
      () => {
        if (!this.stopped && !this.hydrating) this.redraw();
      },
    );
    this.fullscreen = new FullscreenScreen(
      options.output,
      width,
      height,
      this.fullscreenScrollbar,
      {
        mouse: this.fullscreenMouse,
        requestRender: () => this.redraw(),
        copySelection: (text) => (this.options.writeClipboard ?? writeClipboardText)(text),
        openUrl: (url) =>
          openExternalUrl(url, (error) => {
            this.notice = this.view.palette.error(`✖ Cannot open link: ${error.message}`);
            this.redraw();
          }),
      },
    );
    this.branch = branch;
    this.currentTheme = options.color === false ? "plain" : (options.theme ?? DEFAULT_THEME);
    const palette =
      options.color === false
        ? PLAIN_PALETTE
        : (THEMES[this.currentTheme] ?? (THEMES[DEFAULT_THEME] as never));
    this.view = new SessionView(
      width,
      palette,
      options.modelCatalog,
      (reference, mediaWidth, mediaPalette) =>
        this.mediaCache.rows(reference, mediaWidth, this.tuiMode === "fullscreen", mediaPalette),
    );
    this.view.toolOutputDisplay = options.toolOutputDisplay ?? "compact";
    this.extensionHost = new TerminalExtensionHost(options.extensions);
    this.extensionWidgetsAbove = new ExtensionWidgetsComponent(
      this.extensionHost,
      "aboveEditor",
      () => this.view.palette,
    );
    this.extensionWidgetsBelow = new ExtensionWidgetsComponent(
      this.extensionHost,
      "belowEditor",
      () => this.view.palette,
    );
    this.toolTransactions = new ToolTransactionStore(
      () => this.view.palette,
      () => this.view.toolOutputDisplay,
      (name) => this.extensionHost.toolRenderer(name),
      (reference, mediaWidth, mediaPalette) =>
        this.mediaCache.rows(reference, mediaWidth, this.tuiMode === "fullscreen", mediaPalette),
    );
    this.view.thinkingDisplay = options.thinkingDisplay ?? "compact";
    this.editorFrame = new EditorFrameComponent(this.editor, () => this.view);
    this.activity = new ActivityComponent(() => this.view.palette);
    this.liveAssistant = new LiveAssistantComponent(
      () => this.view.palette,
      () => this.view.thinkingDisplay,
    );
    this.attachmentBar = new AttachmentBarComponent(() => this.view.palette);
    this.developerPanel = new DeveloperPanelComponent(
      {
        sessionId,
        ...(branch === undefined ? {} : { branch }),
        connection: this.connectionState,
        phase: "idle",
      },
      () => this.view.palette,
    );
    this.terminal = new TerminalSession({
      input: options.input,
      output: options.output,
      onInput: (sequence) => this.handleInput(sequence),
      onInputError: (error) => {
        this.notice = this.view.palette.error(`✖ ${error.message}`);
        this.redraw();
      },
      onResize: this.resizeListener,
      ...(options.suspendProcess === undefined ? {} : { suspendProcess: options.suspendProcess }),
    });
    this.bindClient(options.client);
  }

  private bindClient(client: AxlClient): void {
    const previous = this.client;
    this.unsubscribeDisconnect();
    this.client = client;
    this.unsubscribeDisconnect = client.onDisconnect((error) => {
      if (!this.stopped) void this.reconnect(error);
    });
    if (previous !== client) previous.close();
  }

  private subscriptionOptions(projector?: ConversationProjector) {
    return {
      ...(projector === undefined ? {} : { projector }),
      onEvent: async (event: CanonicalEvent) => {
        await this.prepareEventMedia(event);
        if (!this.stopped) this.commitEvent(event, !this.hydrating);
      },
      onChange: (projection: ConversationProjector) => {
        if (this.liveAssistant.replace(projection.state.activity)) this.scheduleActivityRender();
      },
      onResyncRequired: (error: Error) => {
        if (this.stopped) return;
        this.notice = this.view.palette.error(`✖ event resync: ${error.message}`);
        this.redraw();
      },
    };
  }

  private async reconnect(error: Error): Promise<void> {
    if (this.connectionState === "reconnecting" || this.stopped) return;
    const disconnectedClient = this.client;
    const reconnectClient = this.reconnectClient;
    this.connectionState = "reconnecting";
    this.liveAssistant.reset();
    this.cancelActivityRender();
    this.reconnectAttempts = 0;
    this.lastReconnectError = undefined;
    const generation = ++this.reconnectGeneration;
    this.notice =
      this.view.palette.warning?.("· reconnecting to daemon") ??
      this.view.palette.dim("· reconnecting to daemon");
    this.invalidateFullscreenRows();
    this.invalidateScreens();
    this.redraw();

    let delay = 100;
    let reconnectExisting = true;
    while (!this.stopped && generation === this.reconnectGeneration) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
      let candidate: AxlClient | undefined;
      try {
        if (reconnectExisting) {
          reconnectExisting = false;
          if (disconnectedClient.state !== "connected") await disconnectedClient.reconnect();
          if (this.stopped || generation !== this.reconnectGeneration) return;
          let workspaceReconnectError: string | undefined;
          try {
            await disconnectedClient.request("session.workspace.checkpoint", {
              sessionId: this.sessionId,
              enabled: this.workspaceReviewEnabled,
            });
          } catch (workspaceError) {
            workspaceReconnectError =
              workspaceError instanceof Error
                ? workspaceError.message
                : "workspace review restoration failed";
            this.workspaceDiffError = workspaceReconnectError;
          }
          this.connectionState = "connected";
          this.notice =
            workspaceReconnectError === undefined
              ? this.view.palette.dim("· daemon reconnected")
              : (this.view.palette.warning ?? this.view.palette.accent)(
                  `· daemon reconnected · workspace review unavailable: ${sanitizeTerminalText(workspaceReconnectError)}`,
                );
          this.invalidateFullscreenRows();
          this.invalidateScreens();
          this.redraw();
          return;
        }
        if (reconnectClient === undefined) {
          this.connectionState = "detached";
          this.notice = this.view.palette.error(`✖ disconnected: ${error.message}`);
          this.attend();
          this.invalidateScreens();
          this.redraw();
          return;
        }
        candidate = await reconnectClient();
        if (this.stopped || generation !== this.reconnectGeneration) {
          candidate.close();
          return;
        }
        this.bindClient(candidate);
        this.mediaCache.retryFailures();
        await candidate.request("session.resume", {
          sessionId: this.sessionId,
        });
        let workspaceReconnectError: string | undefined;
        try {
          await candidate.request("session.workspace.checkpoint", {
            sessionId: this.sessionId,
            enabled: this.workspaceReviewEnabled,
          });
        } catch (workspaceError) {
          workspaceReconnectError =
            workspaceError instanceof Error
              ? workspaceError.message
              : "workspace review restoration failed";
          this.workspaceDiffError = workspaceReconnectError;
        }
        const subscription = this.sessionSubscription;
        if (subscription === undefined) throw new Error("Session subscription is unavailable");
        await subscription.reconnect(candidate);
        this.connectionState = "connected";
        this.notice =
          workspaceReconnectError === undefined
            ? this.view.palette.dim("· daemon reconnected")
            : (this.view.palette.warning ?? this.view.palette.accent)(
                `· daemon reconnected · workspace review unavailable: ${sanitizeTerminalText(workspaceReconnectError)}`,
              );
        this.invalidateFullscreenRows();
        this.invalidateScreens();
        this.redraw();
        return;
      } catch (reconnectError) {
        candidate?.close();
        this.reconnectAttempts += 1;
        this.lastReconnectError =
          reconnectError instanceof Error ? reconnectError.message : "unknown error";
        this.notice = this.view.palette.dim(
          `· reconnecting · attempt ${this.reconnectAttempts} · retrying`,
        );
        this.invalidateScreens();
        this.redraw();
        delay = Math.min(2_000, delay * 2);
      }
    }
  }

  static async start(options: AxlAppOptions): Promise<AxlApp> {
    assertInteractiveTerminal(options.input, options.output);
    const initialResume = options.initialResume === true && options.sessionId === undefined;
    const opened = initialResume
      ? undefined
      : options.sessionId === undefined
        ? await options.client.request("session.create", {
            cwd: options.cwd,
            ...(options.currentModel === undefined ? {} : { modelId: options.currentModel }),
            ...(options.currentThinking === undefined
              ? {}
              : { thinkingLevel: options.currentThinking }),
            ...(options.profile === undefined ? {} : { profile: options.profile }),
            ...(options.webFetch === undefined ? {} : { webFetch: options.webFetch }),
            ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
          })
        : await resumeSessionMetadata(options.client, options.sessionId);
    const cwd = opened?.cwd ?? options.cwd;

    const width =
      options.output.columns && options.output.columns > 0 ? options.output.columns : 80;
    const height = options.output.rows && options.output.rows > 0 ? options.output.rows : 24;
    const app = new AxlApp(
      options,
      opened?.sessionId ?? parseSessionId("00000000-0000-4000-8000-000000000000"),
      cwd,
      width,
      height,
      await readGitBranch(cwd),
    );
    try {
      await app.extensionHost.activate();
      const builtIns = new Set(COMMANDS.map((command) => command.name.slice(1)));
      const conflictingCommand = app.extensionHost
        .commands()
        .find((command) => builtIns.has(command.name));
      if (conflictingCommand !== undefined) {
        throw new Error(
          `Extension ${conflictingCommand.extensionId} conflicts with built-in command /${conflictingCommand.name}`,
        );
      }
      const conflictingShortcut = app.extensionHost
        .shortcuts()
        .find((shortcut) => isReservedExtensionShortcut(shortcut.key));
      if (conflictingShortcut !== undefined) {
        throw new Error(
          `Extension ${conflictingShortcut.extensionId} conflicts with a reserved terminal shortcut`,
        );
      }
    } catch (error) {
      try {
        await app.extensionHost.dispose();
      } catch (cleanupError) {
        options.client.close();
        throw new AggregateError([error, cleanupError], "Extension startup and cleanup failed");
      }
      options.client.close();
      throw error;
    }
    if (options.clearStartupLine) options.output.write("\r\x1b[2K");
    if (opened !== undefined) {
      app.commitLines(app.welcomeLines(cwd, options.sessionId !== undefined), false);
      app.sessionSubscription = await subscribeSession(
        options.client,
        opened.sessionId,
        app.subscriptionOptions(),
      );
      if (options.workspaceReview !== undefined) {
        await app.configureWorkspaceReview(options.workspaceReview, false);
      }
      if (app.developerPanelEnabled) void app.refreshWorkspaceDiff();
    }
    app.hydrating = false;
    app.setWorking(app.sessionSubscription?.projector.state.activeOperationId !== undefined);
    app.openNextInteraction();

    try {
      app.terminal.start();
      if (app.tuiMode === "fullscreen") app.fullscreen.enter();
      app.redraw();
      if (initialResume) void app.openResume();
      return app;
    } catch (error) {
      try {
        app.close(false);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "TUI startup and cleanup both failed");
      }
      throw error;
    }
  }

  stop(): void {
    this.close(true);
  }

  showLocalNotice(message: string): void {
    this.commitLines([this.view.palette.dim(`· ${sanitizeTerminalText(message)}`)]);
  }

  private close(notifyExit: boolean): void {
    if (this.stopped) return;
    this.stopped = true;
    this.setWorking(false);
    this.cancelResize();
    this.cancelActivityRender();
    for (const controller of this.extensionCommandControllers) controller.abort();
    this.extensionCommandControllers.clear();

    const failures: unknown[] = [];
    const extensionCleanup = this.extensionHost.dispose();
    try {
      this.overlays.clear();
    } catch (error) {
      failures.push(error);
    }
    this.reconnectGeneration += 1;
    try {
      this.unsubscribeDisconnect();
      this.sessionSubscription?.detach();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (this.tuiMode === "fullscreen") {
        this.fullscreen.exit(
          this.fullscreenDocumentRows(),
          this.initialResumePending ? "transcript" : this.fullscreenExitOutput,
          this.sessionId,
        );
      } else this.options.output.write(this.screen.clear());
    } catch (error) {
      failures.push(error);
    }
    try {
      this.terminal.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.client.close();
    } catch (error) {
      failures.push(error);
    }
    if (notifyExit) {
      void extensionCleanup.then(
        () => {
          try {
            this.options.onExit?.();
          } catch (error) {
            this.options.output.write(
              `\r\nexit callback failed: ${error instanceof Error ? error.message : String(error)}\r\n`,
            );
          }
        },
        (error: unknown) => {
          this.options.output.write(
            `\r\nextension cleanup failed: ${error instanceof Error ? error.message : String(error)}\r\n`,
          );
          try {
            this.options.onExit?.();
          } catch (exitError) {
            this.options.output.write(
              `\r\nexit callback failed: ${exitError instanceof Error ? exitError.message : String(exitError)}\r\n`,
            );
          }
        },
      );
    } else {
      void extensionCleanup.catch((error: unknown) => {
        this.options.output.write(
          `\r\nextension cleanup failed: ${error instanceof Error ? error.message : String(error)}\r\n`,
        );
      });
    }
    if (failures.length > 0) throw new AggregateError(failures, "Failed to stop Axl TUI");
  }

  private applyResize(): void {
    const width = this.detectWidth();
    const height = this.detectHeight();
    const widthChanged = width !== this.width;
    const heightChanged = height !== this.height;
    if (!widthChanged && !heightChanged) return;
    this.width = width;
    this.height = height;
    this.fullscreen.resize(width, height);
    if (widthChanged) {
      this.rebuildTranscript(true);
    } else {
      this.screen.setWidth(width);
      this.view.setWidth(width);
      if (this.tuiMode === "regular") this.repaintRegularAfterResize();
      else this.redraw();
    }
  }

  private cancelResize(): void {
    if (this.resizeTimer === undefined) return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = undefined;
  }

  private detectWidth(): number {
    return this.options.output.columns && this.options.output.columns > 0
      ? this.options.output.columns
      : 80;
  }

  private detectHeight(): number {
    return this.options.output.rows && this.options.output.rows > 0 ? this.options.output.rows : 24;
  }

  private availableCommands(): readonly { readonly name: string; readonly summary: string }[] {
    return [
      ...COMMANDS,
      ...this.extensionHost.commands().map((command) => ({
        name: `/${command.name}`,
        summary: extensionSingleLine(`${command.description} · ${command.extensionId}`),
      })),
    ];
  }

  private availableHotkeys(): readonly { readonly key: string; readonly action: string }[] {
    return [
      ...HOTKEYS,
      ...this.extensionHost.shortcuts().map((shortcut) => ({
        key: extensionSingleLine(shortcut.key) || "Custom",
        action: extensionSingleLine(`${shortcut.description} · ${shortcut.extensionId}`),
      })),
    ];
  }

  private welcomeLines(cwd: string, resumed: boolean): string[] {
    const { accent, dim } = this.view.palette;
    return [
      `${accent("◆ Axl")} ${dim(resumed ? "· resumed session" : "· new session")}`,
      dim(`  ${formatPath(cwd)}`),
      dim("  /help commands · /hotkeys shortcuts · Shift+Enter newline"),
      "",
    ];
  }

  private styledExtensionLine(line: TerminalLine): string {
    const text = extensionSingleLine(line.text);
    if (line.tone === "accent") return this.view.palette.accent(text);
    if (line.tone === "success")
      return (this.view.palette.success ?? this.view.palette.accent)(text);
    if (line.tone === "warning")
      return (this.view.palette.warning ?? this.view.palette.accent)(text);
    if (line.tone === "error") return this.view.palette.error(text);
    if (line.tone === "text") return (this.view.palette.text ?? ((value) => value))(text);
    return this.view.palette.dim(text);
  }

  private liveFrame(includePendingTools = true): {
    components: readonly Component[];
    cursor?: CursorPlacement;
  } {
    const unsafeComponents: Component[] = this.view.unsafe
      ? [
          {
            render: (width) => [
              truncateToWidth(
                (this.view.palette.warning ?? this.view.palette.error)(
                  "⚠ UNSAFE: no sandbox; tools have full host access",
                ),
                width,
                "",
              ),
            ],
          },
        ]
      : [];
    if (this.overlays.active !== undefined) {
      this.liveRoot.replace([...unsafeComponents, this.overlays]);
      this.liveRoot.render(this.width);
      const cursor = this.overlays.cursorPlacement();
      return {
        components: [this.liveRoot],
        ...(cursor === undefined
          ? {}
          : {
              cursor: {
                ...cursor,
                row: this.liveRoot.offsetOf(this.overlays) + cursor.row,
              },
            }),
      };
    }

    const spinner = SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length] as string;
    this.activity.update({
      working: this.view.working || this.connectionState === "reconnecting",
      label:
        this.connectionState === "reconnecting"
          ? "Reconnecting"
          : extensionSingleLine(this.extensionHost.workingLabel() ?? "Working"),
      spinner,
      elapsedSeconds: this.view.elapsedSeconds,
      queued: this.queued.length,
    });
    const completion = this.completions();
    const inputMode = this.view.working
      ? this.activeRequest === "shell" || this.activeRequest === "compaction"
        ? "FOLLOW-UP"
        : "STEER"
      : undefined;
    const editorMode = [
      this.editorMode === "vim" ? this.vim.mode.toUpperCase() : undefined,
      inputMode,
    ]
      .filter(Boolean)
      .join(" · ");
    this.editorFrame.update({
      ...(this.notice === undefined ? {} : { notice: this.notice }),
      ...(editorMode ? { mode: editorMode } : {}),
      location: `${formatPath(this.cwd)}${this.branch ? `  git:${this.branch}` : ""}${
        this.view.sandbox ? `  sandbox:${this.view.sandbox}` : ""
      }${this.connectionState === "connected" ? "" : `  · ${this.connectionState}`}${this.extensionHost
        .statuses()
        .map((line) => `  · ${this.styledExtensionLine(line)}`)
        .join("")}`,
      ...(completion === undefined ? {} : { completion }),
    });
    this.attachmentBar.update(this.pendingAttachments);
    this.developerPanel.update({
      sessionId: this.sessionId,
      ...(this.branch === undefined ? {} : { branch: this.branch }),
      ...(this.view.sandbox === undefined ? {} : { sandbox: this.view.sandbox }),
      connection: this.connectionState,
      phase: this.view.working ? "active" : "idle",
      ...(this.workspaceDiff === undefined ? {} : { diff: this.workspaceDiff }),
      ...(this.workspaceDiffError === undefined ? {} : { error: this.workspaceDiffError }),
    });
    const tools = this.toolTransactions.components();
    const fixed: Component[] = [
      ...unsafeComponents,
      ...(includePendingTools ? [this.activity, ...tools] : []),
      this.extensionWidgetsAbove,
      this.attachmentBar,
      ...(this.developerPanelEnabled ? [this.developerPanel] : []),
      this.editorFrame,
      this.extensionWidgetsBelow,
    ];
    const reservedRows = fixed.reduce(
      (total, component) => total + component.render(this.width).length,
      0,
    );
    this.liveAssistant.setMaxRows(
      includePendingTools ? Math.max(0, this.height - reservedRows) : undefined,
    );
    this.liveRoot.replace([
      ...unsafeComponents,
      ...(includePendingTools ? [this.activity, this.liveAssistant, ...tools] : []),
      this.extensionWidgetsAbove,
      this.attachmentBar,
      ...(this.developerPanelEnabled ? [this.developerPanel] : []),
      this.editorFrame,
      this.extensionWidgetsBelow,
    ]);
    this.liveRoot.render(this.width);
    const editorCursor = this.editorFrame.cursorPlacement();
    return {
      components: [this.liveRoot],
      cursor: {
        row: this.liveRoot.offsetOf(this.editorFrame) + editorCursor.row,
        column: editorCursor.column,
        visible: !this.view.working && this.connectionState === "connected",
      },
    };
  }

  private completionCandidates(text = this.editor.text): readonly string[] {
    if (this.editor.isBrowsingHistory) return [];
    if (/^\/[a-z]*$/.test(text)) {
      return this.availableCommands()
        .filter((command) => command.name.startsWith(text))
        .map((command) => command.name);
    }
    const extensionArgument = /^\/([a-z][a-z0-9-]*)\s+(.*)$/u.exec(text);
    if (extensionArgument) {
      const extensionCommand = this.extensionHost
        .commands()
        .find((candidate) => candidate.name === extensionArgument[1]);
      if (extensionCommand !== undefined) {
        const prefix = extensionArgument[2] ?? "";
        try {
          const values = extensionCommand.complete?.(prefix) ?? [];
          if (!Array.isArray(values)) throw new TypeError("completion must return an array");
          return values
            .slice(0, MAX_EXTENSION_COMPLETIONS)
            .flatMap((value) =>
              typeof value === "string"
                ? [`/${extensionCommand.name} ${extensionSingleLine(value)}`]
                : [],
            );
        } catch (error) {
          this.notice = this.view.palette.error(
            `✖ extension ${extensionCommand.extensionId} completion failed · ${extensionSingleLine(
              error instanceof Error ? error.message : "unknown completion failure",
            )}`,
          );
          return [];
        }
      }
    }
    const argument =
      /^(\/model|\/thinking|\/theme|\/details|\/favorite|\/developer|\/review|\/vim)\s+(\S*)$/.exec(
        text,
      );
    if (!argument) return [];
    const [, command, query = ""] = argument;
    const values =
      command === "/model"
        ? (this.options.models ?? [])
        : command === "/thinking"
          ? (() => {
              const model = this.options.modelCatalog?.find(
                (candidate) => candidate.modelId === this.view.model,
              );
              return model === undefined ? THINKING_LEVELS : supportedThinkingLevels(model);
            })()
          : command === "/theme"
            ? themeNames()
            : command === "/favorite"
              ? (this.options.models ?? [])
              : command === "/developer"
                ? ["on", "off"]
                : command === "/review"
                  ? ["working", "last-turn", "off"]
                  : command === "/vim"
                    ? ["on", "off"]
                    : ["compact", "full", "focus"];
    return values
      .filter((value) => value.toLowerCase().startsWith(query.toLowerCase()))
      .map((value) => `${command} ${value}`);
  }

  private completionMatches(): readonly string[] {
    const text = this.editor.text;
    const matches = this.completionCandidates(text);
    if (text !== this.completionText) {
      this.completionText = text;
      this.completionIndex = 0;
    }
    this.completionIndex = Math.min(this.completionIndex, Math.max(0, matches.length - 1));
    return matches;
  }

  private moveCompletion(delta: -1 | 1): boolean {
    const matches = this.completionMatches();
    if (matches.length === 0) return false;
    this.completionIndex = (this.completionIndex + delta + matches.length) % matches.length;
    return true;
  }

  private acceptCompletion(): boolean {
    const matches = this.completionMatches();
    const selected = matches[this.completionIndex];
    if (selected === undefined) return false;
    this.editor.setText(selected);
    this.completionText = selected;
    this.completionIndex = 0;
    return true;
  }

  private completions(): readonly string[] | undefined {
    const matches = this.completionMatches();
    if (matches.length === 0) return undefined;
    const { accent, dim } = this.view.palette;
    const windowSize = 6;
    const start = Math.max(
      0,
      Math.min(this.completionIndex - Math.floor(windowSize / 2), matches.length - windowSize),
    );
    const visible = matches.slice(start, start + windowSize);
    return [
      `  ${accent("Commands")}`,
      ...visible.map((value, offset) => {
        const index = start + offset;
        const command = this.availableCommands().find((candidate) => candidate.name === value);
        const description = command === undefined ? "" : `  ${dim(command.summary)}`;
        const line = `  ${index === this.completionIndex ? ">" : " "} ${value}${description}`;
        return index === this.completionIndex
          ? (this.view.palette.selection ?? accent)(line)
          : line;
      }),
      `  ${dim(`${this.completionIndex + 1}/${matches.length} · ↑↓ choose · Tab complete · Enter run`)}`,
    ];
  }

  private redraw(): void {
    if (this.stopped) return;
    const { components, cursor } = this.liveFrame(this.tuiMode === "regular");
    if (this.tuiMode === "fullscreen") {
      const dock = components.flatMap((component) => component.render(this.width));
      this.fullscreen.render({
        document: this.fullscreenDocumentRows(),
        dock,
        ...(cursor === undefined ? {} : { cursor }),
        palette: this.view.palette,
        sessionId: this.sessionId,
      });
      return;
    }
    this.options.output.write(this.screen.frame(components, cursor));
  }

  private fullscreenDocumentRows() {
    if (this.fullscreenRowsCache === undefined) {
      const pending = this.toolTransactions.rows(this.width);
      const streaming = this.liveAssistant.render(this.width).map((text, rowInSource) => ({
        text,
        sourceId: "live-assistant",
        prompt: false,
        rowInSource,
      }));
      const activity = this.activity.render(this.width).map((text, rowInSource) => ({
        text,
        sourceId: "activity",
        prompt: false,
        rowInSource,
      }));
      this.fullscreenRowsCache = [...this.document.rows, ...streaming, ...pending, ...activity];
    }
    return this.fullscreenRowsCache;
  }

  private invalidateFullscreenRows(): void {
    this.fullscreenRowsCache = undefined;
  }

  private invalidateScreens(): void {
    this.screen.invalidate();
    this.fullscreen.invalidate();
  }

  private scheduleActivityRender(): void {
    this.invalidateFullscreenRows();
    if (!this.liveAssistant.active) {
      this.cancelActivityRender();
      if (!this.sending) this.setWorking(false);
      this.redraw();
      return;
    }
    if (!this.view.working) this.setWorking(true);
    if (this.activityRenderTimer !== undefined) return;
    this.activityRenderTimer = setTimeout(() => {
      this.activityRenderTimer = undefined;
      this.redraw();
    }, 16);
    this.activityRenderTimer.unref?.();
  }

  private cancelActivityRender(): void {
    if (this.activityRenderTimer === undefined) return;
    clearTimeout(this.activityRenderTimer);
    this.activityRenderTimer = undefined;
  }

  private setWorking(working: boolean): void {
    const changed = this.view.working !== working;
    this.view.working = working;
    if (changed) {
      void this.extensionHost
        .emit({ type: working ? "working.start" : "working.end" })
        .then((errors) => this.reportExtensionErrors(errors));
    }
    this.invalidateFullscreenRows();
    if (working && this.spinnerTimer === null) {
      const started = Date.now();
      this.view.elapsedSeconds = 0;
      this.spinnerTimer = setInterval(() => {
        this.spinnerIndex += 1;
        this.view.elapsedSeconds = Math.floor((Date.now() - started) / 1000);
        this.invalidateFullscreenRows();
        this.redraw();
      }, 120);
      this.spinnerTimer.unref?.();
    } else if (!working && this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      this.view.elapsedSeconds = 0;
    }
  }

  private async prepareEventMedia(event: CanonicalEvent): Promise<void> {
    if (
      event.type !== "user.message" &&
      event.type !== "user.shell" &&
      event.type !== "assistant.message" &&
      event.type !== "tool.result"
    ) {
      return;
    }
    await Promise.all(
      event.payload.content.flatMap((item) =>
        item.type === "blob" ? [this.mediaCache.ensure(item.blob)] : [],
      ),
    );
  }

  private commitEvent(event: CanonicalEvent, redraw = true): void {
    if (this.seenEventIds.has(event.id)) return;
    this.seenEventIds.add(event.id);
    this.transcript.push({ kind: "event", event });
    void this.extensionHost
      .emit({ type: "session.event", event })
      .then((errors) => this.reportExtensionErrors(errors));
    if (!this.focused) {
      if (event.type === "assistant.message" && event.payload.stopReason !== "tool_use") {
        this.awayCompletedTurns += 1;
      } else if (event.type === "tool.call" && ["edit", "write"].includes(event.payload.name)) {
        const input = jsonObject(event.payload.input);
        const path = input?.path ?? input?.filePath ?? input?.file_path;
        if (typeof path === "string") this.awayChangedFiles.add(path);
      }
    }

    if (event.type === "config.tools") {
      this.webFetchEnabled = event.payload.webFetch;
      this.webSearchEnabled = event.payload.webSearch;
    }
    if (event.type === "user.message") this.consumePendingTurnInput(event);

    if (event.type === "tool.call") {
      this.view.apply(event);
      this.liveAssistant.clear();
      if (!this.hydrating) this.setWorking(true);
      this.toolTransactions.start(event, this.hydrating ? "pending" : "running");
      this.invalidateFullscreenRows();
      if (redraw) this.redraw();
      return;
    }

    if (event.type === "queue.started" && !this.hydrating) this.setWorking(true);

    const completesOperation =
      event.type === "assistant.message" && event.payload.stopReason !== "tool_use";
    if (event.type === "assistant.message") {
      this.liveAssistant.clear();
      this.cancelActivityRender();
    }

    let absorbedSandboxViolation = false;
    if (event.type === "sandbox.violation") {
      absorbedSandboxViolation = this.toolTransactions.deny(event);
      if (absorbedSandboxViolation) this.invalidateFullscreenRows();
    }

    const lines = this.view.apply(event);
    if (
      event.type === "interaction.requested" ||
      event.type === "session.error" ||
      (event.type === "assistant.message" && event.payload.stopReason !== "tool_use")
    ) {
      this.attend();
    }
    if (event.type === "tool.result") {
      void this.refreshBranch();
      const component = this.toolTransactions.settle(event);
      this.invalidateFullscreenRows();
      if (component !== undefined) {
        this.commitLines(component.render(this.width), false, false, {
          sourceId: component.sourceId,
        });
      } else {
        this.commitLines(
          [this.view.palette.error(`✖ orphaned tool result ${event.payload.callId}`)],
          false,
          false,
          { sourceId: event.id },
        );
      }
    } else if (event.type === "interaction.requested") {
      this.interactionQueue.push(event.payload);
      if (redraw) this.openNextInteraction();
    } else if (event.type === "interaction.resolved") {
      const queued = this.interactionQueue.findIndex(
        (request) => request.interactionId === event.payload.interactionId,
      );
      if (queued >= 0) this.interactionQueue.splice(queued, 1);
      if (this.activeInteractionId === event.payload.interactionId) {
        this.activeInteractionId = undefined;
        this.overlays.close();
        this.openNextInteraction();
      }
    } else if (lines.length > 0 && !absorbedSandboxViolation) {
      this.commitLines(lines, false, false, {
        sourceId: event.id,
        prompt: event.type === "user.message",
      });
    }
    if (completesOperation) this.setWorking(false);
    if (this.developerPanelEnabled && (event.type === "tool.result" || completesOperation)) {
      void this.refreshWorkspaceDiff();
    }
    if (redraw) this.redraw();
  }

  private reportExtensionErrors(errors: readonly Error[]): void {
    if (errors.length === 0 || this.stopped) return;
    const message = sanitizeTerminalText(errors[0]?.message ?? "extension failed");
    this.notice = this.view.palette.error(`✖ ${truncateToWidth(message, 160, "…")}`);
    this.redraw();
  }

  private extensionCommandContext(controller: AbortController): TerminalCommandContext {
    const assertActive = (): void => {
      if (controller.signal.aborted || this.stopped) {
        throw new Error("Extension command context is no longer active");
      }
    };
    return {
      signal: controller.signal,
      notify: (message, tone = "muted") => {
        assertActive();
        this.notice = this.styledExtensionLine({ text: `· ${message}`, tone });
        this.redraw();
      },
      select: (title, items) =>
        new Promise<string | undefined>((resolvePromise) => {
          if (controller.signal.aborted || this.stopped) {
            resolvePromise(undefined);
            return;
          }
          let settled = false;
          const finish = (value: string | undefined): void => {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener("abort", abort);
            resolvePromise(value);
          };
          const abort = (): void => finish(undefined);
          controller.signal.addEventListener("abort", abort, { once: true });
          this.openPicker({
            title: extensionSingleLine(title),
            items: items.slice(0, MAX_EXTENSION_SELECTOR_ITEMS).map((item) => ({
              value: item.value,
              label: extensionSingleLine(item.label),
              ...(item.description === undefined
                ? {}
                : { description: extensionSingleLine(item.description) }),
            })),
            current: "",
            onPick: (value) => finish(value),
            onCancel: () => finish(undefined),
          });
        }),
      getEditorText: () => {
        assertActive();
        return this.editor.text;
      },
      setEditorText: (text) => {
        assertActive();
        this.editor.setText(sanitizeTerminalText(text));
        this.redraw();
      },
    };
  }

  private runExtensionAction(
    extensionId: string,
    action: (context: TerminalCommandContext) => void | Promise<void>,
  ): void {
    const controller = new AbortController();
    this.extensionCommandControllers.add(controller);
    Promise.resolve(action(this.extensionCommandContext(controller)))
      .catch((error: unknown) => {
        if (controller.signal.aborted || this.stopped) return;
        const message = sanitizeTerminalText(
          error instanceof Error ? error.message : "unknown command failure",
        );
        this.notice = this.view.palette.error(
          `✖ extension ${extensionId} failed · ${truncateToWidth(message, 120, "…")}`,
        );
      })
      .finally(() => {
        this.extensionCommandControllers.delete(controller);
        if (!this.stopped) this.redraw();
      });
  }

  private handleExtensionShortcut(data: string): boolean {
    if (isReservedExtensionShortcut(data)) return false;
    const shortcut = this.extensionHost.shortcuts().find((candidate) => candidate.key === data);
    if (shortcut === undefined) return false;
    this.runExtensionAction(shortcut.extensionId, shortcut.run);
    return true;
  }

  private handleInput(data: string): void {
    if (this.stopped) return;
    if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
      void this.handleBracketedPaste(data.slice(6, -6));
      return;
    }
    if (data === "\x1b[I") {
      const wasAway = !this.focused;
      this.focused = true;
      if (wasAway && this.refocusRecap) this.showRefocusRecap();
      this.redraw();
      return;
    }
    if (data === "\x1b[O") {
      this.focused = false;
      this.awayCompletedTurns = 0;
      this.awayChangedFiles.clear();
      return;
    }
    if (
      this.tuiMode === "fullscreen" &&
      this.overlays.active !== undefined &&
      isMouseReport(data)
    ) {
      return;
    }
    if (this.tuiMode === "fullscreen" && this.overlays.active === undefined) {
      const frame = this.liveFrame();
      const dockHeight = frame.components.flatMap((component) =>
        component.render(this.width),
      ).length;
      if (this.fullscreen.handleInput(data, this.fullscreenDocumentRows(), dockHeight)) {
        this.redraw();
        return;
      }
    }
    if (this.overlays.active !== undefined) {
      this.overlays.handleInput(data);
      if (!this.stopped) this.redraw();
      return;
    }
    if (this.handleExtensionShortcut(data)) return;

    for (let index = 0; index < data.length; ) {
      const overlay = this.overlays.current();
      if (overlay !== undefined) {
        overlay.handleKey(data.slice(index));
        break;
      }
      const decoded = decodeOneKey(data, index);
      const key = decoded.key;
      index = decoded.next;

      if (key.kind === "up" && !this.editor.isBrowsingHistory && this.moveCompletion(-1)) {
        // Completion owns navigation only while editing the current draft.
      } else if (key.kind === "down" && !this.editor.isBrowsingHistory && this.moveCompletion(1)) {
        // History navigation keeps ownership until it returns to the draft.
      } else if (key.kind === "ctrl" && key.char === "c") {
        if (this.editor.selectedText) void this.copySelection(false);
        else this.handleInterruptKey();
      } else if (key.kind === "ctrl" && key.char === "x") {
        if (this.editor.selectedText) void this.copySelection(true);
      } else if (key.kind === "ctrl" && key.char === "v") {
        void this.pasteClipboard();
      } else if (key.kind === "ctrl" && key.char === "d") {
        if (this.editor.text.length === 0) this.stop();
        else this.editor.apply({ kind: "delete" });
      } else if (key.kind === "ctrl" && key.char === "g") {
        void this.openExternalEditor();
      } else if (key.kind === "alt" && key.char.toLowerCase() === "s") {
        this.togglePromptStash();
      } else if (key.kind === "ctrl" && key.char === "r") {
        if (this.editorMode === "vim" && this.vim.mode === "normal") {
          this.vim.handle(key, this.editor);
        } else this.openHistory();
      } else if (key.kind === "ctrl" && key.char === "l") {
        this.screen.invalidate();
      } else if (key.kind === "ctrl" && key.char === "z") {
        this.suspend();
      } else if (key.kind === "ctrl" && key.char === "o") {
        const mode = this.view.toggleToolOutput();
        void this.persistPreferences({ toolOutputDisplay: mode });
        this.notice = this.view.palette.dim(`· tool details ${mode}`);
        this.rebuildTranscript();
      } else if (key.kind === "ctrl" && key.char === "t") {
        const mode = this.view.cycleThinkingDisplay();
        void this.persistPreferences({ thinkingDisplay: mode });
        this.notice = this.view.palette.dim(`· thoughts ${mode}`);
      } else if (key.kind === "shift-tab") {
        void this.cycleThinkingLevel();
      } else if (key.kind === "tab") {
        if (!this.acceptCompletion()) this.editor.apply(key);
      } else if (key.kind === "escape") {
        if (this.view.working) void this.interrupt();
        else if (this.editorMode === "vim") this.vim.handle(key, this.editor);
        else {
          this.editor.clear();
          this.notice = undefined;
        }
      } else if (this.editorMode === "vim" && this.vim.handle(key, this.editor)) {
        this.notice = undefined;
      } else if (key.kind === "enter" || key.kind === "follow-up") {
        const matches = key.kind === "enter" ? this.completionMatches() : [];
        const selected = matches[this.completionIndex];
        if (selected !== undefined && selected !== this.editor.text) {
          this.acceptCompletion();
        }
        const line = this.editor.apply({ kind: "enter" });
        if (line !== undefined) {
          this.vim.reset();
          this.submit(line.trim(), key.kind === "follow-up");
        }
      } else {
        this.editor.apply(key);
      }
      if (this.stopped) return;
    }
    this.redraw();
  }

  private showRefocusRecap(): void {
    const parts: string[] = [];
    if (this.awayCompletedTurns > 0) {
      parts.push(
        `${this.awayCompletedTurns} turn${this.awayCompletedTurns === 1 ? "" : "s"} completed`,
      );
    }
    if (this.awayChangedFiles.size > 0) {
      parts.push(
        `${this.awayChangedFiles.size} file${this.awayChangedFiles.size === 1 ? "" : "s"} changed`,
      );
    }
    if (this.activeInteractionId !== undefined || this.interactionQueue.length > 0) {
      parts.push("input waiting");
    }
    if (parts.length > 0) {
      this.notice = this.view.palette.dim(`· while away: ${parts.join(" · ")}`);
    }
    this.awayCompletedTurns = 0;
    this.awayChangedFiles.clear();
  }

  private attend(): void {
    if (this.attention !== "bell" || this.focused) return;
    const now = Date.now();
    if (now - this.lastAttentionAt < 2_000) return;
    this.lastAttentionAt = now;
    this.options.output.write("\x07");
  }

  private async pasteClipboard(): Promise<void> {
    if (this.attachmentBusy) {
      this.notice = this.view.palette.dim("· wait for the current attachment upload");
      this.redraw();
      return;
    }
    this.notice = this.view.palette.dim("· reading clipboard…");
    this.redraw();
    try {
      const text = await (this.options.readClipboard ?? readClipboardText)();
      if (this.stopped) return;
      if (!text) {
        this.notice = this.view.palette.dim("· clipboard has no text");
      } else {
        this.editor.insertText(text);
        this.notice = this.view.palette.dim(
          `· pasted ${text.split("\n").length} line${text.includes("\n") ? "s" : ""}`,
        );
      }
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "clipboard read failed"}`,
      );
    }
    this.redraw();
  }

  private async handleBracketedPaste(text: string): Promise<void> {
    try {
      const attachments = await droppedImages(text, this.cwd);
      if (this.stopped) return;
      if (attachments.length === 0) {
        this.editor.insertText(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
        this.redraw();
        return;
      }
      for (const attachment of attachments) await this.attachLocal(attachment);
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "dropped image failed"}`,
      );
      this.redraw();
    }
  }

  private async attachPath(path: string): Promise<void> {
    try {
      await this.attachLocal(await readImageFile(resolve(this.cwd, path)));
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "attachment failed"}`,
      );
      this.redraw();
    }
  }

  private async attachLocal(attachment: LocalAttachment): Promise<void> {
    if (this.attachmentBusy) throw new Error("Another attachment is still uploading");
    this.attachmentBusy = true;
    this.notice = this.view.palette.dim(`· attaching ${sanitizeTerminalText(attachment.name)}…`);
    this.redraw();
    try {
      const reference = await uploadBlob(
        this.client,
        this.sessionId,
        attachment.bytes,
        attachment.mediaType,
        attachment.name,
      );
      if (this.stopped) return;
      this.mediaCache.put(reference, attachment.bytes);
      this.pendingAttachments.push(reference);
      this.notice = this.view.palette.dim(
        `· attached ${sanitizeTerminalText(reference.name ?? reference.mediaType)}`,
      );
    } finally {
      this.attachmentBusy = false;
      this.redraw();
    }
  }

  private async copySelection(cut: boolean): Promise<void> {
    const selected = this.editor.selectedText;
    if (!selected) return;
    try {
      await (this.options.writeClipboard ?? writeClipboardText)(selected);
      if (this.stopped) return;
      if (cut && this.editor.selectedText === selected) this.editor.deleteSelection();
      this.notice = this.view.palette.dim(cut ? "· selection cut" : "· selection copied");
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "clipboard write failed"}`,
      );
    }
    this.redraw();
  }

  private openHistory(): void {
    const history = this.editor.historyEntries;
    if (history.length === 0) {
      this.notice = this.view.palette.dim("· prompt history is empty");
      return;
    }
    this.openPicker({
      title: "Prompt history",
      items: history.map((value, index) => ({
        value: String(index),
        label: value.replace(/\n/g, " ↵ "),
      })),
      current: "",
      onPick: (value) => this.editor.setText(history[Number(value)] ?? ""),
    });
  }

  private openCommands(): void {
    this.openPicker({
      title: "Commands",
      items: this.availableCommands().map((command) => ({
        value: command.name,
        label: command.name,
        description: command.summary,
      })),
      current: "",
      onPick: (value) => this.editor.setText(value),
    });
  }

  private async openExternalEditor(): Promise<void> {
    if (this.view.working) {
      this.notice = this.view.palette.dim("· interrupt the active operation before editing");
      this.redraw();
      return;
    }
    const fullscreen = this.tuiMode === "fullscreen";
    try {
      if (fullscreen) this.fullscreen.pause();
      else this.options.output.write(this.screen.clear());
      this.terminal.stop();
      const edited = await (this.options.editPrompt ?? editPromptExternally)(this.editor.text);
      this.editor.setText(edited);
      this.notice = this.view.palette.dim("· external editor closed");
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "external editor failed"}`,
      );
    } finally {
      this.screen.reset(this.width);
      const failures: unknown[] = [];
      try {
        this.terminal.start();
      } catch (error) {
        failures.push(error);
      }
      if (fullscreen) {
        try {
          this.fullscreen.resume();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        const failure = failures[0];
        this.notice = this.view.palette.error(
          `✖ ${failure instanceof Error ? failure.message : "terminal restoration failed"}`,
        );
      }
      this.redraw();
    }
  }

  private suspend(): void {
    const fullscreen = this.tuiMode === "fullscreen";
    try {
      this.cancelResize();
      if (fullscreen) this.fullscreen.pause();
      else this.options.output.write(this.screen.clear());
      this.terminal.suspend();
      this.screen.reset(this.width);
      this.notice = this.view.palette.dim("· terminal resumed");
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "terminal suspension failed"}`,
      );
    } finally {
      if (fullscreen) {
        try {
          this.fullscreen.resume();
        } catch (error) {
          this.notice = this.view.palette.error(
            `✖ ${error instanceof Error ? error.message : "fullscreen resume failed"}`,
          );
        }
      }
      this.redraw();
    }
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

  private submit(inputLine: string, prioritize = false): void {
    this.notice = undefined;
    if (!inputLine && this.pendingAttachments.length === 0) return;
    const prefixMatches = /^\/[a-z]+$/.test(inputLine)
      ? this.availableCommands().filter((command) => command.name.startsWith(inputLine))
      : [];
    const line =
      prefixMatches.length === 1 ? (prefixMatches[0] as (typeof COMMANDS)[number]).name : inputLine;
    if (line.startsWith("!")) {
      const excluded = line.startsWith("!!");
      const shellCommand = line.slice(excluded ? 2 : 1).trim();
      if (!shellCommand) this.notice = this.view.palette.dim("· enter a command after !");
      else if (this.view.working)
        this.notice = this.view.palette.dim("· interrupt the active operation first");
      else void this.runShell(shellCommand, excluded);
      return;
    }
    const [command, ...arguments_] = line.split(/\s+/);
    const argument = arguments_.join(" ");

    if (command === "/quit" || command === "/detach") {
      this.stop();
      return;
    }
    if (command === "/resume" || command === "/fork" || command === "/clone") {
      if (this.view.working) {
        this.notice = this.view.palette.dim("· finish or interrupt the turn first");
      } else if (this.pendingAttachments.length > 0) {
        this.notice = this.view.palette.dim("· send or clear attachments before changing sessions");
      } else if (command === "/resume") void this.openResume();
      else if (command === "/fork") this.openFork();
      else void this.cloneSession();
      return;
    }
    if (command === "/export") {
      if (this.view.working) {
        this.notice = this.view.palette.dim("· finish or interrupt the turn before exporting");
      } else {
        void this.exportSession(argument);
      }
      return;
    }
    if (command === "/help") {
      const { dim, accent } = this.view.palette;
      this.commitLines([
        accent("Commands"),
        ...this.availableCommands().map(
          (item) => `  ${accent(item.name.padEnd(11))} ${dim(item.summary)}`,
        ),
        "",
        accent("Keys"),
        ...KEY_HELP.map((row) => `  ${dim(row)}`),
      ]);
      return;
    }
    if (command === "/commands") {
      this.openCommands();
      return;
    }
    if (command === "/history") {
      this.openHistory();
      return;
    }
    if (command === "/edit") {
      void this.openExternalEditor();
      return;
    }
    if (command === "/hotkeys") {
      this.openPicker({
        title: "Keyboard shortcuts",
        items: this.availableHotkeys().map((item) => ({
          value: `${item.key} ${item.action}`,
          label: item.key,
          description: item.action,
        })),
        current: "",
        onPick: () => undefined,
      });
      return;
    }
    if (command === "/stash") {
      if (argument === "clear") {
        this.stashedPrompt = undefined;
        this.notice = this.view.palette.dim("· prompt stash cleared");
      } else if (argument) this.notice = this.view.palette.error("✖ use /stash or /stash clear");
      else this.togglePromptStash();
      return;
    }
    if (command === "/favorite") {
      this.toggleModelFavorite(argument || this.view.model || this.options.currentModel || "");
      return;
    }
    if (command === "/developer") {
      this.setDeveloperPanel(argument);
      return;
    }
    if (command === "/vim") {
      this.setEditorMode(argument);
      return;
    }
    if (command === "/attach") {
      if (argument === "clear") {
        this.pendingAttachments.length = 0;
        this.notice = this.view.palette.dim("· attachments cleared");
      } else if (!argument) {
        this.notice = this.view.palette.dim("· use /attach <image path> or /attach clear");
      } else {
        void this.attachPath(argument);
      }
      return;
    }
    if (command === "/review") {
      if (argument === "off") {
        void this.configureWorkspaceReview(false);
        this.notice = this.view.palette.dim("· workspace review disabled");
      } else if (argument && argument !== "working" && argument !== "last-turn") {
        this.notice = this.view.palette.error(
          "✖ use /review working, /review last-turn, or /review off",
        );
      } else void this.openDiffReview((argument || "working") as WorkspaceReviewScope);
      return;
    }
    if (command === "/status") {
      this.commitLines([
        this.view.palette.accent("Session"),
        `  id        ${this.sessionId}`,
        `  profile   ${this.view.profile ?? "?"}`,
        `  model     ${this.view.model ?? "?"}`,
        `  thinking  ${this.view.thinking ?? "?"}`,
        `  sandbox   ${this.view.sandbox ?? "?"}`,
        `  connection ${this.connectionState}`,
        `  display   ${this.tuiMode}${this.tuiMode === "fullscreen" ? ` · mouse ${this.fullscreenMouse}` : ""}`,
        `  events    ${this.seenEventIds.size}`,
        ...(this.lastReconnectError === undefined
          ? []
          : [`  last error ${this.lastReconnectError}`]),
        `  usage     ${this.view.usageLabel()}`,
        `  speed     ${this.view.tpsLabel() || "?"}`,
        `  queued    ${
          this.queued.length +
          (this.sessionSubscription?.projector.state.queue.filter(
            (item) => item.status === "queued" || item.status === "paused",
          ).length ?? 0)
        }`,
        `  editor    ${this.editorMode}`,
        `  favorites ${this.modelFavorites.length}`,
        `  developer ${this.developerPanelEnabled ? "on" : "off"}`,
      ]);
      return;
    }
    if (command === "/requeue") {
      const queueItem = this.sessionSubscription?.projector.state.queue.find(
        (item) => item.queueItemId === argument && item.status === "paused",
      );
      if (queueItem === undefined) {
        this.notice = this.view.palette.error("✖ provide the ID of a paused queued prompt");
      } else {
        void this.client
          .request("session.queue.requeue", {
            sessionId: this.sessionId,
            queueItemId: queueItem.queueItemId,
            priority: "back",
          })
          .catch((error: unknown) => {
            this.notice = this.view.palette.error(
              `✖ ${error instanceof Error ? error.message : "re-queue failed"}`,
            );
            this.redraw();
          });
      }
      return;
    }
    if (command === "/fullscreen") {
      this.setTuiMode("fullscreen");
      return;
    }
    if (command === "/regular") {
      this.setTuiMode("regular");
      return;
    }
    if (command === "/settings") {
      this.openSettings();
      return;
    }
    if (command === "/details") {
      this.selectDetails(argument);
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
    if (command === "/login" || command === "/reload" || command === "/compact") {
      if (this.view.working)
        this.notice = this.view.palette.dim("· finish or interrupt the turn first");
      else if (command === "/login") void this.openLogin();
      else if (command === "/reload") void this.reload();
      else void this.compact(argument || undefined);
      return;
    }
    const extensionCommand = this.extensionHost
      .commands()
      .find((candidate) => `/${candidate.name}` === command);
    if (extensionCommand !== undefined) {
      this.runExtensionAction(extensionCommand.extensionId, (context) =>
        extensionCommand.run(argument, context),
      );
      return;
    }
    if (line.startsWith("/")) {
      this.notice = this.view.palette.error(`✖ unknown command ${command}`);
      return;
    }

    const queued = { text: line, attachments: [...this.pendingAttachments] };
    this.pendingAttachments.length = 0;
    if (
      this.view.working &&
      this.activeRequest !== "shell" &&
      this.activeRequest !== "compaction"
    ) {
      void this.queueDuringTurn(queued, prioritize ? "followUp" : "steer");
      return;
    }
    if (this.sending || this.view.working) {
      this.notice = this.view.palette.dim("· queueing follow-up");
      this.invalidateFullscreenRows();
      this.redraw();
      void this.enqueuePrompt(queued, prioritize ? "front" : "back");
      return;
    }
    this.queued.push(queued);
    this.invalidateFullscreenRows();
    void this.drainQueue();
  }

  private commitLines(
    lines: readonly string[],
    redraw = true,
    remember = true,
    metadata: TranscriptAppendOptions = {},
  ): void {
    if (lines.length > 0) {
      if (remember) this.transcript.push({ kind: "lines", lines: [...lines] });
      this.document.append(lines, metadata);
      this.invalidateFullscreenRows();
      if (this.tuiMode === "regular") {
        this.options.output.write(this.screen.clear());
        this.options.output.write(`${lines.join("\r\n")}\r\n`);
      }
    }
    if (redraw) this.redraw();
  }

  private rebuildTranscript(repaintAfterResize = false): void {
    const previous = this.view;
    const next = new SessionView(
      this.width,
      previous.palette,
      this.options.modelCatalog,
      (reference, mediaWidth, mediaPalette) =>
        this.mediaCache.rows(reference, mediaWidth, this.tuiMode === "fullscreen", mediaPalette),
    );
    next.thinkingDisplay = previous.thinkingDisplay;
    next.toolOutputDisplay = previous.toolOutputDisplay;
    const document = new TranscriptDocument();
    const pending = new ToolTransactionStore(
      () => next.palette,
      () => next.toolOutputDisplay,
      (name) => this.extensionHost.toolRenderer(name),
      (reference, mediaWidth, mediaPalette) =>
        this.mediaCache.rows(reference, mediaWidth, this.tuiMode === "fullscreen", mediaPalette),
    );
    for (const entry of this.transcript) {
      if (entry.kind === "lines") {
        document.append(entry.lines.flatMap((line) => wrapLine(line, this.width)));
        continue;
      }
      const event = entry.event;
      if (event.type === "tool.call") {
        next.apply(event);
        pending.start(event, "pending");
        continue;
      }
      if (event.type === "sandbox.violation" && pending.deny(event)) {
        next.apply(event);
        continue;
      }
      const lines = next.apply(event);
      if (event.type === "tool.result") {
        const component = pending.settle(event);
        if (component !== undefined) {
          document.append(component.render(this.width), { sourceId: component.sourceId });
          continue;
        }
        document.append([next.palette.error(`✖ orphaned tool result ${event.payload.callId}`)], {
          sourceId: event.id,
        });
        continue;
      }
      document.append(lines, {
        sourceId: event.id,
        prompt: event.type === "user.message",
      });
    }
    next.working = previous.working;
    next.elapsedSeconds = previous.elapsedSeconds;
    next.tokensPerSecond = previous.tokensPerSecond;
    this.view = next;
    this.toolTransactions.replace(pending);
    this.document.replace(document.rows);
    this.invalidateFullscreenRows();
    if (this.tuiMode === "regular") {
      if (repaintAfterResize) {
        this.repaintRegularAfterResize();
        return;
      }
      this.options.output.write(this.screen.clear());
      this.screen.reset(this.width);
    }
    this.redraw();
  }

  private repaintRegularAfterResize(): void {
    this.screen.reset(this.width);
    this.options.output.write(`${SYNC_BEGIN}${AUTOWRAP_OFF}\x1b[2J\x1b[H\x1b[3J`);
    for (const [index, row] of this.document.rows.entries()) {
      if (index > 0) this.options.output.write("\r\n");
      this.options.output.write(truncateToWidth(row.text, this.width, ""));
    }
    if (this.document.rows.length > 0) this.options.output.write("\r\n");
    this.options.output.write(`${AUTOWRAP_ON}${SYNC_END}`);
    this.redraw();
  }

  private setTuiMode(mode: "regular" | "fullscreen"): void {
    if (mode === this.tuiMode) return;
    if (this.overlays.active !== undefined) {
      this.notice = this.view.palette.dim("· close the active dialog before changing display mode");
      return;
    }
    if (mode === "fullscreen") {
      this.options.output.write(this.screen.clear());
      this.screen.reset(this.width);
      this.tuiMode = mode;
      this.fullscreen.enter();
    } else {
      this.fullscreen.exit(this.fullscreenDocumentRows(), "transcript", this.sessionId);
      this.tuiMode = mode;
      this.screen.reset(this.width);
    }
    void this.persistPreferences({ tuiMode: mode });
    this.rebuildTranscript();
  }

  private togglePromptStash(): void {
    const current = this.editor.text;
    if (this.stashedPrompt === undefined && !current) {
      this.notice = this.view.palette.dim("· prompt stash is empty");
      return;
    }
    if (this.stashedPrompt === undefined) {
      this.stashedPrompt = current;
      this.editor.clear();
      this.notice = this.view.palette.dim("· prompt stashed");
      return;
    }
    this.editor.setText(this.stashedPrompt);
    this.stashedPrompt = current || undefined;
    this.notice = this.view.palette.dim(
      current ? "· prompt swapped with stash" : "· prompt restored",
    );
  }

  private toggleModelFavorite(modelId: string): void {
    if (!modelId) {
      this.notice = this.view.palette.dim("· no active model to favorite");
      return;
    }
    if (this.options.models && !this.options.models.includes(modelId)) {
      this.notice = this.view.palette.error(`✖ unknown model ${modelId}`);
      return;
    }
    const index = this.modelFavorites.indexOf(modelId);
    if (index >= 0) {
      this.modelFavorites.splice(index, 1);
      this.notice = this.view.palette.dim(`· removed ${modelId} from favorites`);
    } else {
      this.modelFavorites.push(modelId);
      this.notice = this.view.palette.dim(`· favorited ${modelId}`);
    }
    void this.persistPreferences({ modelFavorites: [...this.modelFavorites] });
  }

  private setEditorMode(argument: string): void {
    const mode =
      argument === "on"
        ? "vim"
        : argument === "off"
          ? "standard"
          : argument || (this.editorMode === "vim" ? "standard" : "vim");
    if (mode !== "standard" && mode !== "vim") {
      this.notice = this.view.palette.error("✖ use /vim on, /vim off, standard, or vim");
      return;
    }
    this.editorMode = mode;
    this.vim.reset();
    void this.persistPreferences({ editorMode: mode });
    this.notice = this.view.palette.dim(`· editor mode ${mode}`);
  }

  private setDeveloperPanel(argument: string): void {
    if (argument && argument !== "on" && argument !== "off") {
      this.notice = this.view.palette.error("✖ use /developer on or /developer off");
      return;
    }
    this.developerPanelEnabled = argument ? argument === "on" : !this.developerPanelEnabled;
    if (!this.developerPanelEnabled) this.workspaceDiffGeneration += 1;
    void this.persistPreferences({ developerPanel: this.developerPanelEnabled });
    this.notice = this.view.palette.dim(
      `· developer panel ${this.developerPanelEnabled ? "enabled" : "disabled"}`,
    );
    if (this.developerPanelEnabled) void this.refreshWorkspaceDiff();
  }

  private async loadWorkspaceDiff(scope: WorkspaceReviewScope): Promise<WorkspaceReview> {
    const status = await this.client.request("session.workspace.status", {
      sessionId: this.sessionId,
      scope,
    });
    const files = await Promise.all(
      status.entries.map(async (entry) => {
        const diff = await this.client.request("session.workspace.diff", {
          sessionId: this.sessionId,
          entryId: entry.entryId,
          contextLines: 3,
          repositoryGeneration: status.repositoryGeneration,
          maxBytes: 4 * 1024 * 1024,
        });
        const lines = diff.hunks.flatMap((hunk) => [
          hunk.header,
          ...hunk.lines.map((line) => {
            const prefix =
              line.kind === "addition"
                ? "+"
                : line.kind === "deletion"
                  ? "-"
                  : line.kind === "context"
                    ? " "
                    : "";
            return `${prefix}${line.text}`;
          }),
        ]);
        return {
          path: entry.path,
          status: entry.kind,
          additions: diff.hunks.reduce(
            (total, hunk) => total + hunk.lines.filter((line) => line.kind === "addition").length,
            0,
          ),
          deletions: diff.hunks.reduce(
            (total, hunk) => total + hunk.lines.filter((line) => line.kind === "deletion").length,
            0,
          ),
          patch: entry.binary ? "Binary file" : lines.join("\n"),
          truncated: false,
        };
      }),
    );
    return {
      scope,
      ...(status.checkpointId === undefined ? {} : { checkpointId: status.checkpointId }),
      files,
    };
  }

  private async refreshWorkspaceDiff(): Promise<void> {
    if (!this.developerPanelEnabled || this.connectionState !== "connected") return;
    const generation = ++this.workspaceDiffGeneration;
    try {
      const diff = await this.loadWorkspaceDiff("working");
      if (generation !== this.workspaceDiffGeneration || !this.developerPanelEnabled) return;
      this.workspaceDiff = diff;
      this.workspaceDiffError = undefined;
    } catch (error) {
      if (generation !== this.workspaceDiffGeneration || !this.developerPanelEnabled) return;
      this.workspaceDiff = undefined;
      this.workspaceDiffError = error instanceof Error ? error.message : "Workspace review failed";
    }
    this.redraw();
  }

  private async configureWorkspaceReview(enabled: boolean, persist = true): Promise<boolean> {
    try {
      await this.client.request("session.workspace.checkpoint", {
        sessionId: this.sessionId,
        enabled,
      });
      this.workspaceReviewEnabled = enabled;
      if (persist) await this.persistPreferences({ workspaceReview: enabled });
      return true;
    } catch (error) {
      this.workspaceReviewEnabled = false;
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "Workspace checkpoints unavailable"}`,
      );
      return false;
    }
  }

  private async openDiffReview(scope: WorkspaceReviewScope): Promise<void> {
    if (this.overlays.active !== undefined) return;
    const newlyEnabled = !this.workspaceReviewEnabled;
    if (newlyEnabled && !(await this.configureWorkspaceReview(true))) {
      this.redraw();
      return;
    }
    if (newlyEnabled && scope === "last-turn") {
      this.notice = this.view.palette.dim(
        "· workspace checkpoints enabled · last-turn review starts with the next prompt",
      );
      this.redraw();
      return;
    }
    this.notice = this.view.palette.dim("· loading workspace review…");
    this.redraw();
    try {
      const initial = await this.loadWorkspaceDiff(scope);
      this.notice = undefined;
      this.overlays.replace(
        new DiffReviewOverlay({
          initial,
          layout: this.diffLayout,
          palette: () => this.view.palette,
          width: () => this.width,
          height: () => this.height,
          load: (nextScope) => this.loadWorkspaceDiff(nextScope),
          onLayout: (layout) => {
            this.diffLayout = layout;
            void this.persistPreferences({ diffLayout: layout });
          },
          onClose: () => {
            this.overlays.close();
            this.openNextInteraction();
          },
          refresh: () => this.redraw(),
        }),
      );
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "Workspace review failed"}`,
      );
    }
    this.redraw();
  }

  private openSettings(): void {
    this.openPicker({
      title: "Terminal settings",
      items: [
        { value: "theme", label: "Theme", description: this.currentTheme },
        { value: "tools", label: "Tool details", description: this.view.toolOutputDisplay },
        { value: "thoughts", label: "Thoughts", description: this.view.thinkingDisplay },
        { value: "mode", label: "Display mode", description: this.tuiMode },
        { value: "exit", label: "Fullscreen exit", description: this.fullscreenExitOutput },
        { value: "scrollbar", label: "Scrollbar", description: this.fullscreenScrollbar },
        { value: "mouse", label: "Mouse selection", description: this.fullscreenMouse },
        { value: "attention", label: "Attention", description: this.attention },
        { value: "editor", label: "Editor mode", description: this.editorMode },
        {
          value: "recap",
          label: "Refocus recap",
          description: this.refocusRecap ? "on" : "off",
        },
        {
          value: "developer",
          label: "Developer panel",
          description: this.developerPanelEnabled ? "on" : "off",
        },
        {
          value: "review",
          label: "Workspace review",
          description: this.workspaceReviewEnabled ? "on" : "off",
        },
        {
          value: "web-fetch",
          label: "Web fetch tool",
          description: this.webFetchEnabled ? "on" : "off",
        },
        {
          value: "web-search",
          label: "Web search tool",
          description: this.webSearchEnabled ? "on" : "off",
        },
        { value: "images", label: "Image display", description: this.imageDisplay },
        { value: "diff", label: "Diff layout", description: this.diffLayout },
      ],
      current: "",
      onPick: (value) => {
        if (value === "theme") this.selectTheme("");
        else if (value === "tools") this.selectToolDisplay();
        else if (value === "thoughts") this.selectThinkingDisplay();
        else if (value === "mode") this.selectTuiMode();
        else if (value === "exit") this.selectFullscreenExit();
        else if (value === "scrollbar") this.selectFullscreenScrollbar();
        else if (value === "mouse") this.selectFullscreenMouse();
        else if (value === "attention") this.selectAttention();
        else if (value === "editor") this.selectEditorMode();
        else if (value === "recap") this.selectRefocusRecap();
        else if (value === "developer") this.selectDeveloperPanel();
        else if (value === "review") this.selectWorkspaceReview();
        else if (value === "web-fetch") this.selectWebTool("webFetch");
        else if (value === "web-search") this.selectWebTool("webSearch");
        else if (value === "images") this.selectImageDisplay();
        else this.selectDiffLayout();
      },
    });
  }

  private selectWebTool(tool: "webFetch" | "webSearch"): void {
    const current = tool === "webFetch" ? this.webFetchEnabled : this.webSearchEnabled;
    this.openPicker({
      title: tool === "webFetch" ? "Web fetch tool" : "Web search tool",
      items: [
        { value: "on", label: "On", description: "include the tool in model requests" },
        { value: "off", label: "Off", description: "remove all schema and prompt contribution" },
      ],
      current: current ? "on" : "off",
      onPick: (value) => void this.configure({ [tool]: value === "on" }),
    });
  }

  private selectTuiMode(): void {
    this.openPicker({
      title: "Display mode",
      items: [
        { value: "regular", label: "regular      terminal scrollback" },
        { value: "fullscreen", label: "fullscreen   fixed transcript viewport" },
      ],
      current: this.tuiMode,
      onPick: (value) => this.setTuiMode(value as "regular" | "fullscreen"),
    });
  }

  private selectFullscreenExit(): void {
    this.openPicker({
      title: "Fullscreen exit output",
      items: [
        { value: "transcript", label: "transcript    print session into scrollback" },
        { value: "resume-hint", label: "resume-hint   print only the session command" },
      ],
      current: this.fullscreenExitOutput,
      onPick: (value) => {
        this.fullscreenExitOutput = value as "transcript" | "resume-hint";
        void this.persistPreferences({ fullscreenExitOutput: this.fullscreenExitOutput });
      },
    });
  }

  private selectFullscreenScrollbar(): void {
    this.openPicker({
      title: "Fullscreen scrollbar",
      items: [
        { value: "auto", label: "auto     show when content overflows" },
        { value: "always", label: "always   keep the scrollbar visible" },
        { value: "hidden", label: "hidden   maximize transcript width" },
      ],
      current: this.fullscreenScrollbar,
      onPick: (value) => {
        const scrollbar = value as "auto" | "always" | "hidden";
        this.fullscreenScrollbar = scrollbar;
        this.fullscreen.setScrollbar(scrollbar);
        void this.persistPreferences({ fullscreenScrollbar: scrollbar });
        this.redraw();
      },
    });
  }

  private selectFullscreenMouse(): void {
    this.openPicker({
      title: "Fullscreen mouse",
      items: [
        { value: "capture", label: "capture   scroll, select, and drag the scrollbar" },
        { value: "native", label: "native    leave selection to the terminal" },
      ],
      current: this.fullscreenMouse,
      onPick: (value) => {
        this.fullscreenMouse = value as FullscreenMouse;
        this.fullscreen.setMouse(this.fullscreenMouse);
        void this.persistPreferences({ fullscreenMouse: this.fullscreenMouse });
        this.redraw();
      },
    });
  }

  private selectDetails(mode: string): void {
    if (!mode) {
      this.selectToolDisplay();
      return;
    }
    if (mode !== "compact" && mode !== "full" && mode !== "focus") {
      this.notice = this.view.palette.error("✖ use /details compact, full, or focus");
      return;
    }
    this.view.toolOutputDisplay = mode;
    void this.persistPreferences({ toolOutputDisplay: mode });
    this.notice = this.view.palette.dim(`· tool details ${mode}`);
    this.rebuildTranscript();
  }

  private selectAttention(): void {
    this.openPicker({
      title: "Attention",
      items: [
        { value: "off", label: "Off", description: "no terminal bell" },
        { value: "bell", label: "Terminal bell", description: "only while unfocused" },
      ],
      current: this.attention,
      onPick: (value) => {
        this.attention = value as "off" | "bell";
        void this.persistPreferences({ attention: this.attention });
      },
    });
  }

  private selectEditorMode(): void {
    this.openPicker({
      title: "Editor mode",
      items: [
        { value: "standard", label: "Standard", description: "direct multiline editing" },
        { value: "vim", label: "Vim", description: "insert and normal command modes" },
      ],
      current: this.editorMode,
      onPick: (value) => this.setEditorMode(value),
    });
  }

  private selectRefocusRecap(): void {
    this.openPicker({
      title: "Refocus recap",
      items: [
        { value: "off", label: "Off", description: "stay quiet when focus returns" },
        { value: "on", label: "On", description: "summarize activity that occurred while away" },
      ],
      current: this.refocusRecap ? "on" : "off",
      onPick: (value) => {
        this.refocusRecap = value === "on";
        void this.persistPreferences({ refocusRecap: this.refocusRecap });
      },
    });
  }

  private selectDeveloperPanel(): void {
    this.openPicker({
      title: "Developer panel",
      items: [
        { value: "off", label: "Off", description: "no workspace summary" },
        { value: "on", label: "On", description: "wide-screen workspace summary" },
      ],
      current: this.developerPanelEnabled ? "on" : "off",
      onPick: (value) => this.setDeveloperPanel(value),
    });
  }

  private selectWorkspaceReview(): void {
    this.openPicker({
      title: "Workspace review checkpoints",
      items: [
        { value: "off", label: "Off", description: "perform no checkpoint work" },
        { value: "on", label: "On", description: "capture bounded baselines before turns" },
      ],
      current: this.workspaceReviewEnabled ? "on" : "off",
      onPick: (value) => void this.configureWorkspaceReview(value === "on"),
    });
  }

  private selectImageDisplay(): void {
    this.openPicker({
      title: "Image display",
      items: [
        { value: "auto", label: "Auto", description: "inline where terminal support is known" },
        { value: "inline", label: "Inline", description: "request Kitty or iTerm2 rendering" },
        { value: "metadata", label: "Metadata", description: "always use safe text summaries" },
      ],
      current: this.imageDisplay,
      onPick: (value) => {
        this.imageDisplay = value as ImageDisplay;
        void this.persistPreferences({ imageDisplay: this.imageDisplay });
        this.rebuildTranscript();
      },
    });
  }

  private selectDiffLayout(): void {
    this.openPicker({
      title: "Diff layout",
      items: [
        { value: "unified", label: "Unified", description: "one responsive patch column" },
        { value: "split", label: "Split", description: "side-by-side at wide widths" },
      ],
      current: this.diffLayout,
      onPick: (value) => {
        this.diffLayout = value as DiffLayout;
        void this.persistPreferences({ diffLayout: this.diffLayout });
      },
    });
  }

  private selectToolDisplay(): void {
    this.openPicker({
      title: "Tool details",
      items: [
        { value: "compact", label: "compact   bounded output" },
        { value: "full", label: "full      complete output" },
        { value: "focus", label: "focus     hide routine successful reads and searches" },
      ],
      current: this.view.toolOutputDisplay,
      onPick: (value) => {
        this.view.toolOutputDisplay = value as ToolOutputDisplay;
        void this.persistPreferences({ toolOutputDisplay: this.view.toolOutputDisplay });
        this.rebuildTranscript();
      },
    });
  }

  private selectThinkingDisplay(): void {
    this.openPicker({
      title: "Thought display",
      items: [
        { value: "compact", label: "compact   summary only" },
        { value: "show", label: "show      full reasoning" },
        { value: "hide", label: "hide      no reasoning text" },
      ],
      current: this.view.thinkingDisplay,
      onPick: (value) => {
        this.view.thinkingDisplay = value as "compact" | "show" | "hide";
        void this.persistPreferences({ thinkingDisplay: this.view.thinkingDisplay });
        this.rebuildTranscript();
      },
    });
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
      void this.persistPreferences({ theme: name });
      this.notice = undefined;
      this.rebuildTranscript();
      return;
    }
    const originalTheme = this.currentTheme;
    const originalPalette = this.view.palette;
    this.openPicker({
      title: "Select theme",
      items: THEME_DEFINITIONS.map((theme) => ({
        value: theme.id,
        label: theme.label,
        description: theme.appearance,
      })),
      current: this.currentTheme,
      onHighlight: (value) => {
        const palette = THEMES[value];
        if (palette !== undefined) this.view.palette = palette;
      },
      preview: (width) => themePreview(width, this.view.palette),
      onCancel: () => {
        this.currentTheme = originalTheme;
        this.view.palette = originalPalette;
      },
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
    const favorites = new Set(this.modelFavorites);
    const ordered = models.toSorted((left, right) => {
      const favoriteOrder = Number(favorites.has(right)) - Number(favorites.has(left));
      return favoriteOrder;
    });
    this.openPicker({
      title: "Select model",
      items: ordered.map((id) => ({
        value: id,
        label: `${favorites.has(id) ? "◆ " : ""}${this.modelLabel(id, models)}`,
        ...(favorites.has(id) ? { description: "favorite" } : {}),
      })),
      current: this.view.model ?? this.options.currentModel ?? "",
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

  private modelLabel(modelId: string, all: readonly string[]): string {
    const info = this.options.modelCatalog?.find((model) => model.modelId === modelId);
    if (!info) return modelId;
    const pad = Math.min(24, Math.max(...all.map((id) => id.length)) + 2);
    const context =
      info.contextWindow >= 1_000_000
        ? `${(info.contextWindow / 1_000_000).toFixed(1)}M`
        : `${Math.round(info.contextWindow / 1000)}K`;
    const price = info.cost ? `$${info.cost.inputUsdPerMTok}/$${info.cost.outputUsdPerMTok}` : "";
    return `${modelId.padEnd(pad)}${this.view.palette.dim(
      `${context.padStart(6)} ctx  ${price.padStart(9)}${info.reasoning ? "  ∴" : ""}`,
    )}`;
  }

  private async openResume(): Promise<void> {
    try {
      const sessions: readonly ResumeSessionEntry[] =
        this.options.listResumeSessions === undefined
          ? (
              await this.client.request("session.list", {
                scope: "all_local",
                order: "recent",
                pageSize: 100,
              })
            ).sessions.map((session) => ({
              ...session,
              resumeKey: session.sessionId,
              placementLabel:
                session.securityMode === "unsafe"
                  ? "UNSAFE"
                  : `SANDBOXED · ${session.sandboxProvider ?? "current"}`,
              unsafe: session.securityMode === "unsafe",
            }))
          : await this.options.listResumeSessions();
      if (sessions.length === 0) {
        this.notice = this.view.palette.dim("· no saved sessions");
        if (this.initialResumePending) this.stop();
        else this.redraw();
        return;
      }
      let scope: "current" | "all" = this.initialResumePending ? "all" : "current";
      let filter = "";
      let index = 0;
      const visibleSessions = (): ResumeSessionEntry[] => {
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
        );
      };
      const overlay: Overlay = {
        render: () => {
          const filtered = visibleSessions();
          index = Math.min(index, Math.max(0, filtered.length - 1));
          const start = Math.max(
            0,
            Math.min(
              index - Math.floor(SESSION_SELECTOR_WINDOW / 2),
              filtered.length - SESSION_SELECTOR_WINDOW,
            ),
          );
          const shown = filtered.slice(start, start + SESSION_SELECTOR_WINDOW);
          const scopeLabel = `${scope === "current" ? "●" : "○"} Current Folder  |  ${
            scope === "all" ? "●" : "○"
          } All  ·  Most Recently Updated`;
          return renderDialog({
            title: `Resume Session (${scope === "current" ? "Current Folder" : "All"})`,
            rows: [
              this.view.palette.dim(scopeLabel),
              this.view.palette.dim("Tab scope · Enter resume · Esc close"),
              `> ${filter}`,
              "",
              ...shown.flatMap((session, position) => {
                const selected = start + position === index;
                const message =
                  session.lastUserMessage ?? session.firstUserMessage ?? "Session without a prompt";
                const current = session.sessionId === this.sessionId ? " · current" : "";
                const location = scope === "all" ? ` · ${formatPath(session.cwd)}` : "";
                return [
                  truncateToWidth(
                    `${selected ? this.view.palette.accent("›") : " "} ${
                      selected && this.view.palette.bold ? this.view.palette.bold(message) : message
                    }`,
                    this.width - 4,
                    "…",
                  ),
                  this.view.palette.dim(
                    `  ${plural(session.userMessageCount, "message")} · ${relativeAge(session.updatedAt)} · ${
                      session.unsafe
                        ? (this.view.palette.warning ?? this.view.palette.error)(
                            session.placementLabel,
                          )
                        : session.placementLabel
                    }${current}${location}`,
                  ),
                  "",
                ];
              }),
              ...(filtered.length === 0 ? [this.view.palette.dim("No matching sessions")] : []),
              ...(filtered.length > SESSION_SELECTOR_WINDOW
                ? [this.view.palette.dim(`(${index + 1}/${filtered.length})`)]
                : []),
            ],
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
            } else if (key.kind === "up" && filtered.length > 0) {
              index = (index - 1 + filtered.length) % filtered.length;
            } else if (key.kind === "down" && filtered.length > 0) {
              index = (index + 1) % filtered.length;
            } else if (key.kind === "enter") {
              const selected = filtered[index];
              if (selected !== undefined) {
                this.overlays.close();
                void this.resumeSession(selected);
                return;
              }
            } else if (key.kind === "escape" || (key.kind === "ctrl" && key.char === "c")) {
              this.overlays.close();
              if (this.initialResumePending) this.stop();
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
      this.overlays.replace(overlay);
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
    const overlay: Overlay = {
      render: () => {
        const start = Math.max(
          0,
          Math.min(
            index - Math.floor(SESSION_SELECTOR_WINDOW / 2),
            messages.length - SESSION_SELECTOR_WINDOW,
          ),
        );
        const shown = messages.slice(start, start + SESSION_SELECTOR_WINDOW);
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
          ],
          footer: "↑↓ navigate · Enter fork · Esc close",
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
            this.overlays.close();
            void this.forkSession(messages[index]?.id);
            return;
          } else if (key.kind === "escape" || (key.kind === "ctrl" && key.char === "c")) {
            this.overlays.close();
            return;
          }
        }
      },
    };
    this.overlays.replace(overlay);
  }

  private async resumeSession(session: ResumeSessionEntry | string): Promise<void> {
    const entry =
      typeof session === "string"
        ? {
            sessionId: session,
            resumeKey: session,
            placementLabel: "current",
            unsafe: false,
          }
        : session;
    const previousReconnect = this.reconnectClient;
    let candidate: ResumeSessionConnection | undefined;
    try {
      candidate =
        typeof session === "string" ? undefined : await this.options.openResumeSession?.(session);
      const client = candidate?.client ?? this.client;
      if (candidate !== undefined) this.reconnectClient = candidate.reconnectClient;
      await this.switchSession(
        await resumeSessionMetadata(client, entry.sessionId),
        "",
        `· resumed session · ${entry.placementLabel}`,
        client,
      );
      this.initialResumePending = false;
    } catch (error) {
      const adoptedCandidate = candidate?.client === this.client;
      if (!adoptedCandidate) {
        candidate?.client.close();
        this.reconnectClient = previousReconnect;
      } else {
        this.initialResumePending = false;
      }
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "could not resume session"}`,
      );
      this.redraw();
      if (this.initialResumePending) void this.openResume();
    }
  }

  private async forkSession(fromEventId: string | undefined): Promise<void> {
    if (fromEventId === undefined) return;
    try {
      const forked = await this.client.request("session.fork", {
        sessionId: this.sessionId,
        fromEventId: parseEventId(fromEventId),
      });
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
      const cloned = await this.client.request("session.clone", {
        sessionId: this.sessionId,
      });
      await this.switchSession(cloned, "", "· cloned to new session");
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "could not clone session"}`,
      );
      this.redraw();
    }
  }

  private async exportSession(path: string): Promise<void> {
    const outputDirectory = resolve(this.cwd, path || `axl-session-${this.sessionId}`);
    this.notice = this.view.palette.dim("· exporting session…");
    this.redraw();
    try {
      const exported = await this.client.request("session.export", {
        sessionId: this.sessionId,
        outputDirectory,
      });
      this.notice = this.view.palette.dim(
        `· exported ${plural(exported.eventCount, "event")} and ${plural(exported.blobCount, "blob")} to ${sanitizeTerminalText(exported.outputDirectory)}`,
      );
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "could not export session"}`,
      );
    }
    this.redraw();
  }

  private async switchSession(
    opened: SessionOpenResult,
    draft: string,
    notice: string,
    client = this.client,
  ): Promise<void> {
    const branch = await readGitBranch(opened.cwd);
    const projectionEvents: CanonicalEvent[] = [];
    const projection = new ConversationProjector(opened.sessionId);
    let activated = false;
    const nextSubscription = await subscribeSession(client, opened.sessionId, {
      projector: projection,
      onEvent: async (event) => {
        if (!activated) {
          projectionEvents.push(event);
          return;
        }
        await this.prepareEventMedia(event);
        if (!this.stopped) this.commitEvent(event, !this.hydrating);
      },
      onChange: (projector) => {
        if (activated && this.liveAssistant.replace(projector.state.activity)) {
          this.scheduleActivityRender();
        }
      },
      onResyncRequired: (error) => {
        if (!activated || this.stopped) return;
        this.notice = this.view.palette.error(`✖ event resync: ${error.message}`);
        this.redraw();
      },
    });

    const previousSubscription = this.sessionSubscription;
    try {
      await previousSubscription?.close();
    } catch (error) {
      await nextSubscription.close().catch(() => undefined);
      throw error;
    }
    this.reconnectGeneration += 1;
    if (client !== this.client) this.bindClient(client);
    this.connectionState = "connected";
    if (this.tuiMode === "regular") this.options.output.write(this.screen.clear());
    this.liveAssistant.reset();
    this.cancelActivityRender();
    this.cwd = opened.cwd;
    this.sessionId = opened.sessionId;
    this.mediaCache.setSession(opened.sessionId);
    this.branch = branch;
    this.seenEventIds.clear();
    this.transcript.length = 0;
    this.document.clear();
    this.toolTransactions.replace(
      new ToolTransactionStore(
        () => this.view.palette,
        () => this.view.toolOutputDisplay,
        (name) => this.extensionHost.toolRenderer(name),
        (reference, mediaWidth, mediaPalette) =>
          this.mediaCache.rows(reference, mediaWidth, this.tuiMode === "fullscreen", mediaPalette),
      ),
    );
    this.interactionQueue.length = 0;
    this.pendingTurnInputs.length = 0;
    this.activeInteractionId = undefined;
    this.interactionError = undefined;
    this.workspaceDiff = undefined;
    this.workspaceDiffError = undefined;
    this.hydrating = true;
    const palette = this.view.palette;
    const thinkingDisplay = this.view.thinkingDisplay;
    const toolOutputDisplay = this.view.toolOutputDisplay;
    this.view = new SessionView(
      this.width,
      palette,
      this.options.modelCatalog,
      (reference, mediaWidth, mediaPalette) =>
        this.mediaCache.rows(reference, mediaWidth, this.tuiMode === "fullscreen", mediaPalette),
    );
    this.view.thinkingDisplay = thinkingDisplay;
    this.view.toolOutputDisplay = toolOutputDisplay;
    this.commitLines(this.welcomeLines(this.cwd, true), false);
    for (const event of projectionEvents) {
      await this.prepareEventMedia(event);
      this.commitEvent(event, false);
    }
    this.sessionSubscription = nextSubscription;
    activated = true;
    this.liveAssistant.replace(projection.state.activity);
    this.hydrating = false;
    this.setWorking(projection.state.activeOperationId !== undefined);
    this.editor.setText(draft);
    this.notice = this.view.palette.dim(notice);
    this.openNextInteraction();
    this.rebuildTranscript();
    try {
      await client.request("session.workspace.checkpoint", {
        sessionId: opened.sessionId,
        enabled: this.workspaceReviewEnabled,
      });
    } catch (error) {
      this.workspaceDiffError =
        error instanceof Error ? error.message : "Workspace checkpoints unavailable";
    }
  }

  private openPicker(input: {
    readonly title: string;
    readonly items: readonly {
      readonly value: string;
      readonly label: string;
      readonly description?: string;
    }[];
    readonly current: string;
    readonly onPick: (value: string) => void;
    readonly onCancel?: () => void;
    readonly onHighlight?: (value: string) => void;
    readonly preview?: (width: number) => readonly string[];
  }): void {
    const close = (): void => {
      this.overlays.close();
      this.openNextInteraction();
    };
    this.overlays.replace(
      new PickerOverlay({
        ...input,
        palette: () => this.view.palette,
        onPick: (value) => {
          close();
          input.onPick(value);
        },
        onCancel: () => {
          input.onCancel?.();
          close();
        },
      }),
    );
  }

  private openNextInteraction(): void {
    if (this.overlays.active !== undefined || this.interactionQueue.length === 0) return;
    const request = this.interactionQueue.shift() as EventPayloadMap["interaction.requested"];
    this.activeInteractionId = request.interactionId;
    this.interactionError = undefined;
    if (request.kind === "mcp_elicitation_form") this.openInteractionForm(request);
    else this.openInteractionApproval(request);
  }

  private openInteractionApproval(request: EventPayloadMap["interaction.requested"]): void {
    const { dim, accent } = this.view.palette;
    const url = interactionUrl(request.data);
    const title =
      request.kind === "mcp_elicitation_url"
        ? "Browser authorization"
        : request.kind.startsWith("mcp_sampling")
          ? "Model request"
          : "Approval required";
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
      void this.respondToInteraction(request.interactionId, action);
    };
    const modal: Overlay = {
      render: () =>
        renderDialog({
          title,
          rows: [
            request.message,
            dim(`Source · ${request.source}`),
            ...(url ? ["", dim("Destination"), accent(url)] : []),
            ...(detail.length > 2 ? ["", dim("Details"), ...detail.map((line) => dim(line))] : []),
            ...(this.interactionError === undefined
              ? []
              : ["", this.view.palette.error(`✖ ${this.interactionError}`)]),
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
    this.overlays.replace(modal);
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
      void this.respondToInteraction(request.interactionId, action, content);
    };
    const modal: Overlay = {
      render: () => {
        const field = fields[index];
        const rows = [
          this.view.palette.accent(request.source),
          request.message,
          "",
          ...fields.map((item, fieldIndex) => {
            const marker =
              fieldIndex === index && !confirming
                ? ">"
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
          ...(this.interactionError === undefined
            ? []
            : [this.view.palette.error(`✖ ${this.interactionError}`)]),
        ];
        return renderDialog({
          title: "Input required",
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
        return { row: fields.length + 5, column: 2 + visibleWidth(`${name}: ${draft}`) };
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
    this.overlays.replace(modal);
  }

  private async respondToInteraction(
    interactionId: string,
    action: "accept" | "decline" | "cancel",
    content?: JsonObject,
  ): Promise<void> {
    if (this.interactionResponding) return;
    this.interactionResponding = true;
    let resolved = false;
    try {
      await this.client.request("session.interaction.respond", {
        sessionId: this.sessionId,
        interactionId,
        action,
        ...(content === undefined ? {} : { content }),
      });
      resolved = true;
    } catch (error) {
      this.interactionError =
        error instanceof Error ? error.message : "interaction response failed";
    } finally {
      this.interactionResponding = false;
      if (resolved && this.activeInteractionId === interactionId) {
        this.activeInteractionId = undefined;
        this.interactionError = undefined;
        this.overlays.close();
        this.openNextInteraction();
      }
      this.redraw();
    }
  }

  private async openLogin(): Promise<void> {
    let definition: LoginDialogDefinition | undefined;
    try {
      definition = await this.options.loadLogin?.();
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "login initialization failed"}`,
      );
      this.redraw();
      return;
    }
    if (definition === undefined) {
      this.notice = this.view.palette.dim("· login is unavailable over this attachment");
      this.redraw();
      return;
    }
    const { LoginDialog } = await import("./login-dialog.ts");
    this.overlays.replace(
      new LoginDialog({
        definition,
        palette: this.view.palette,
        width: this.width,
        refresh: () => this.redraw(),
        close: (summary) => {
          this.overlays.close();
          this.commitLines([this.view.palette.dim(summary)]);
          this.openNextInteraction();
        },
      }),
    );
    this.redraw();
  }

  private async persistPreferences(update: {
    modelId?: string;
    thinkingLevel?: ThinkingLevel;
    webFetch?: boolean;
    webSearch?: boolean;
    theme?: string;
    toolOutputDisplay?: ToolOutputDisplay;
    thinkingDisplay?: "show" | "compact" | "hide";
    tuiMode?: "regular" | "fullscreen";
    fullscreenExitOutput?: "transcript" | "resume-hint";
    fullscreenScrollbar?: "auto" | "always" | "hidden";
    fullscreenMouse?: FullscreenMouse;
    attention?: "off" | "bell";
    editorMode?: "standard" | "vim";
    modelFavorites?: readonly string[];
    refocusRecap?: boolean;
    developerPanel?: boolean;
    diffLayout?: DiffLayout;
    workspaceReview?: boolean;
    imageDisplay?: ImageDisplay;
  }): Promise<void> {
    try {
      await this.options.onPreferenceChange?.(update);
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "settings save failed"}`,
      );
      this.redraw();
    }
  }

  private async configure(update: {
    modelId?: string;
    thinkingLevel?: ThinkingLevel;
    webFetch?: boolean;
    webSearch?: boolean;
  }): Promise<void> {
    if (this.configuring) {
      this.notice = this.view.palette.dim("· configuration change already in progress");
      this.redraw();
      return;
    }
    this.configuring = true;
    try {
      await this.client.request("session.configure", {
        sessionId: this.sessionId,
        ...update,
      });
      if (update.modelId) this.options.onModelChange?.(update.modelId);
      await this.persistPreferences(update);
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "configuration failed"}`,
      );
    } finally {
      this.configuring = false;
    }
    this.redraw();
  }

  private async runShell(command: string, excluded: boolean): Promise<void> {
    this.sending = true;
    this.activeRequest = "shell";
    this.setWorking(true);
    this.redraw();
    const operationId = parseOperationId(randomUUID());
    try {
      const outcome = await this.client.shell({
        sessionId: this.sessionId,
        operationId,
        command,
        excluded,
      });
      if (outcome.state === "uncertain") {
        this.sessionSubscription?.projector.markShellUncertain(operationId, command);
        this.editor.setText(`${excluded ? "!!" : "!"}${command}`);
        this.notice = this.view.palette.error("✖ shell delivery unknown · command restored");
      }
    } catch (error) {
      if (this.isConnectionFailure(error)) {
        this.sessionSubscription?.projector.markShellUncertain(operationId, command);
        this.editor.setText(`${excluded ? "!!" : "!"}${command}`);
        this.notice = this.view.palette.error("✖ shell delivery unknown · command restored");
      } else {
        this.notice = this.view.palette.error(
          `✖ ${error instanceof Error ? error.message : "shell command failed"}`,
        );
      }
    } finally {
      this.setWorking(false);
      this.sending = false;
      this.activeRequest = undefined;
      this.redraw();
      void this.drainQueue();
    }
  }

  private async queueDuringTurn(
    queued: { readonly text: string; readonly attachments: readonly BlobReference[] },
    mode: "steer" | "followUp",
  ): Promise<void> {
    const params = {
      sessionId: this.sessionId,
      content: [
        ...(queued.text ? [{ type: "text" as const, text: queued.text }] : []),
        ...queued.attachments.map((blob) => ({ type: "blob" as const, blob })),
      ],
    };
    const pending = { mode, contentKey: JSON.stringify(params.content) };
    this.pendingTurnInputs.push(pending);
    try {
      if (mode === "steer") await this.client.request("session.steer", params);
      else await this.client.request("session.followUp", params);
      this.updateTurnInputNotice();
    } catch (error) {
      const pendingIndex = this.pendingTurnInputs.indexOf(pending);
      if (pendingIndex >= 0) {
        this.pendingTurnInputs.splice(pendingIndex, 1);
        this.pendingAttachments.unshift(...queued.attachments);
        this.editor.setText([queued.text, this.editor.text].filter(Boolean).join("\n\n"));
        this.notice = this.view.palette.error(
          `✖ ${error instanceof Error ? error.message : `${mode} failed`} · prompt restored`,
        );
      }
    }
    this.redraw();
  }

  private consumePendingTurnInput(event: CanonicalEvent<"user.message">): void {
    const contentKey = JSON.stringify(event.payload.content);
    const index = this.pendingTurnInputs.findIndex((pending) => pending.contentKey === contentKey);
    if (index < 0) return;
    this.pendingTurnInputs.splice(index, 1);
    this.updateTurnInputNotice();
  }

  private updateTurnInputNotice(): void {
    const steering = this.pendingTurnInputs.filter((pending) => pending.mode === "steer").length;
    const followUps = this.pendingTurnInputs.length - steering;
    if (steering === 0 && followUps === 0) {
      if (this.notice?.includes("steering queued") || this.notice?.includes("follow-up queued")) {
        this.notice = undefined;
      }
      return;
    }
    const parts = [
      ...(steering === 0 ? [] : [`${steering === 1 ? "steering" : `${steering} steering`} queued`]),
      ...(followUps === 0
        ? []
        : [`${followUps === 1 ? "follow-up" : `${followUps} follow-ups`} queued`]),
    ];
    this.notice = this.view.palette.dim(`· ${parts.join(" · ")}`);
  }

  private async enqueuePrompt(
    queued: { readonly text: string; readonly attachments: readonly BlobReference[] },
    priority: "front" | "back",
  ): Promise<void> {
    try {
      await this.client.request("session.queue.enqueue", {
        sessionId: this.sessionId,
        content: [
          ...(queued.text ? [{ type: "text" as const, text: queued.text }] : []),
          ...queued.attachments.map((blob) => ({ type: "blob" as const, blob })),
        ],
        priority,
      });
      const count =
        this.sessionSubscription?.projector.state.queue.filter((item) => item.status === "queued")
          .length ?? 0;
      this.notice = this.view.palette.dim(`· queued follow-up (${count})`);
    } catch (error) {
      this.editor.setText([queued.text, this.editor.text].filter(Boolean).join("\n\n"));
      this.pendingAttachments.unshift(...queued.attachments);
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "queue failed"}`,
      );
    }
    this.redraw();
  }

  private async drainQueue(): Promise<void> {
    if (this.sending || this.stopped) return;
    this.sending = true;
    this.activeRequest = "turn";
    try {
      while (this.queued.length > 0 && !this.stopped) {
        const queued = this.queued.shift() as {
          readonly text: string;
          readonly attachments: readonly BlobReference[];
        };
        this.setWorking(true);
        this.view.beginResponse();
        this.redraw();
        try {
          await this.client.request("session.send", {
            sessionId: this.sessionId,
            delivery: "prompt",
            content: [
              ...(queued.text ? [{ type: "text" as const, text: queued.text }] : []),
              ...queued.attachments.map((blob) => ({ type: "blob" as const, blob })),
            ],
          });
        } catch (error) {
          if (this.isConnectionFailure(error)) {
            const restored = [
              queued.text,
              ...this.queued.map((item) => item.text),
              this.editor.text,
            ]
              .filter(Boolean)
              .join("\n\n");
            this.pendingAttachments.unshift(
              ...queued.attachments,
              ...this.queued.flatMap((item) => item.attachments),
            );
            this.queued.length = 0;
            this.editor.setText(restored);
            this.notice = this.view.palette.error(
              "✖ delivery unknown · prompts restored for review",
            );
          } else {
            this.notice = this.view.palette.error(
              `✖ ${error instanceof Error ? error.message : "send failed"}`,
            );
          }
          break;
        }
      }
    } finally {
      this.sending = false;
      this.activeRequest = undefined;
      this.setWorking(false);
      this.redraw();
    }
  }

  private isConnectionFailure(error: unknown): boolean {
    if (typeof error !== "object" || error === null || !("code" in error)) return false;
    return ["disconnected", "connection_error", "write_failed"].includes(String(error.code));
  }

  private async refreshBranch(): Promise<void> {
    const branch = await readGitBranch(this.cwd);
    if (branch !== this.branch) {
      this.branch = branch;
      this.redraw();
    }
  }

  private async compact(instructions?: string): Promise<void> {
    this.sending = true;
    this.activeRequest = "compaction";
    this.setWorking(true);
    this.notice = this.view.palette.dim("· compacting context");
    this.redraw();
    try {
      await this.client.request("session.compact", {
        sessionId: this.sessionId,
        ...(instructions === undefined ? {} : { instructions }),
      });
      this.notice = undefined;
    } catch (error) {
      this.notice = this.view.palette.error(
        `✖ ${error instanceof Error ? error.message : "compaction failed"}`,
      );
    } finally {
      this.sending = false;
      this.activeRequest = undefined;
      this.setWorking(false);
      this.redraw();
      void this.drainQueue();
    }
  }

  private async reload(): Promise<void> {
    try {
      await this.client.request("session.reload", { sessionId: this.sessionId });
      for (const controller of this.extensionCommandControllers) controller.abort();
      this.extensionCommandControllers.clear();
      this.overlays.clear();
      await this.extensionHost.reload();
      this.rebuildTranscript();
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
      await this.client.request("session.interrupt", { sessionId: this.sessionId });
    } catch {
      this.notice = this.view.palette.dim("· turn already finished");
      this.redraw();
    }
  }
}
