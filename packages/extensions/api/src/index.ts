// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

export type ExtensionCapability =
  | "terminal.commands"
  | "terminal.shortcuts"
  | "terminal.status"
  | "terminal.widgets"
  | "terminal.events"
  | "terminal.tool-renderers"
  | "terminal.activities"
  | "terminal.activity-storage";

export interface ExtensionManifest {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly ExtensionCapability[];
}

export type TerminalTone = "text" | "muted" | "accent" | "success" | "warning" | "error";

export interface TerminalLine {
  readonly text: string;
  readonly tone?: TerminalTone;
}

export interface TerminalCommandContext {
  readonly signal: AbortSignal;
  notify(message: string, tone?: Exclude<TerminalTone, "text">): void;
  select(
    title: string,
    items: readonly {
      readonly value: string;
      readonly label: string;
      readonly description?: string;
    }[],
  ): Promise<string | undefined>;
  getEditorText(): string;
  setEditorText(text: string): void;
}

export interface TerminalCommand {
  readonly name: string;
  readonly description: string;
  readonly complete?: (argumentPrefix: string) => readonly string[];
  readonly run: (arguments_: string, context: TerminalCommandContext) => void | Promise<void>;
}

export interface TerminalShortcut {
  readonly key: string;
  readonly description: string;
  readonly run: (context: TerminalCommandContext) => void | Promise<void>;
}

export interface TerminalWidget {
  readonly placement?: "aboveEditor" | "belowEditor";
  /** Increment when external widget state changes. */
  readonly revision?: number;
  render(width: number): readonly TerminalLine[];
  dispose?(): void | Promise<void>;
}

export interface TerminalToolRenderInput {
  readonly callId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly result?: string;
  readonly isError: boolean;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "denied" | "aborted";
  readonly durationMs?: number;
  readonly detail: "compact" | "full" | "focus";
}

export interface TerminalToolRenderResult {
  readonly label?: string;
  readonly target?: string;
  readonly lines?: readonly TerminalLine[];
  readonly hideWhenSuccessfulInFocus?: boolean;
}

export type TerminalToolRenderer = (
  input: TerminalToolRenderInput,
) => TerminalToolRenderResult | undefined;

export type TerminalExtensionEventInput =
  | { readonly type: "session.event"; readonly event: unknown }
  | { readonly type: "working.start" }
  | { readonly type: "working.end" };

export type TerminalExtensionEvent = TerminalExtensionEventInput & {
  readonly signal: AbortSignal;
};

export type ExtensionDisposer = () => void | Promise<void>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ActivityStyle =
  | "text"
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "selection";

export interface ActivitySpan {
  readonly text: string;
  readonly style: ActivityStyle;
  readonly emphasis?: "none" | "strong" | "reverse";
}

export interface ActivityFrame {
  readonly lines: readonly (readonly ActivitySpan[])[];
  readonly cursor?: { readonly row: number; readonly column: number };
  readonly announcement?: string;
}

export interface ActivityViewport {
  readonly width: number;
  readonly height: number;
}

export interface ActivityPresentationPreferences {
  readonly reducedMotion: boolean;
  readonly textOnly: boolean;
}

export interface ActivitySafeStatus {
  readonly operation:
    | "idle"
    | "working"
    | "waiting"
    | "blocked"
    | "failed"
    | "completed"
    | "unknown";
  readonly elapsedMs?: number;
  readonly activeToolCount: number;
  readonly queuedInput: {
    readonly steer: number;
    readonly followUp: number;
    readonly interrupt: number;
  };
}

export type ActivityInput =
  | {
      readonly type: "key";
      readonly key: string;
      readonly ctrl: boolean;
      readonly alt: boolean;
      readonly shift: boolean;
      readonly repeat: boolean;
    }
  | { readonly type: "paste" }
  | { readonly type: "composition" }
  | {
      readonly type: "mouse";
      readonly phase: "press" | "release";
      readonly button: "left" | "middle" | "right";
      readonly row: number;
      readonly column: number;
      readonly ctrl: boolean;
      readonly alt: boolean;
      readonly shift: boolean;
    }
  | { readonly type: "focus"; readonly focused: boolean }
  | { readonly type: "unknown" };

export type ActivityPauseReason =
  | "attention"
  | "hidden"
  | "unfocused"
  | "monitor-focused"
  | "unsupported-size"
  | "disconnect"
  | "completion"
  | "failure"
  | "session-switch"
  | "reload";

export interface ActivityStoredValue<T extends JsonValue = JsonValue> {
  readonly revision: number;
  readonly schemaVersion: number;
  readonly value: T;
}

export interface ActivityStorage<T extends JsonValue = JsonValue> {
  read(signal?: AbortSignal): Promise<ActivityStoredValue<T> | undefined>;
  write(
    expectedRevision: number | null,
    schemaVersion: number,
    value: T,
    signal?: AbortSignal,
  ): Promise<ActivityStoredValue<T>>;
  reset(expectedRevision: number, signal?: AbortSignal): Promise<void>;
}

export interface ActivityStorageScope {
  readonly extensionId: string;
  readonly activityId: string;
}

export interface ActivityStorageAdapter {
  read(scope: ActivityStorageScope, signal: AbortSignal): Promise<ActivityStoredValue | undefined>;
  write(
    scope: ActivityStorageScope,
    expectedRevision: number | null,
    schemaVersion: number,
    value: JsonValue,
    signal: AbortSignal,
  ): Promise<ActivityStoredValue>;
  reset(scope: ActivityStorageScope, expectedRevision: number, signal: AbortSignal): Promise<void>;
}

export type ActivityScheduledCallback = (elapsedMs: number) => void;

export interface ActivityContext {
  readonly signal: AbortSignal;
  now(): number;
  status(): ActivitySafeStatus;
  presentation(): ActivityPresentationPreferences;
  invalidate(): void;
  schedule(delayMs: number, callback: ActivityScheduledCallback): ExtensionDisposer;
  readonly storage?: ActivityStorage;
}

export interface TerminalActivityInstance {
  render(viewport: ActivityViewport): ActivityFrame;
  handleInput(input: ActivityInput): void;
  presentationChanged?(): void;
  pause(reason: ActivityPauseReason): void;
  resume(): void;
  serialize(): JsonValue | undefined;
  dispose(): void | Promise<void>;
}

export interface TerminalActivity {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: "game";
  readonly mouse?: boolean;
  readonly minimumViewport?: ActivityViewport;
  create(context: ActivityContext): TerminalActivityInstance;
}

export interface OwnedTerminalActivity extends TerminalActivity {
  readonly extensionId: string;
}

export interface ActivityHostServices {
  now(): number;
  schedule(delayMs: number, callback: () => void): ExtensionDisposer;
  invalidate(): void;
  status(): ActivitySafeStatus;
  presentation(): ActivityPresentationPreferences;
  readonly storage?: ActivityStorageAdapter;
}

export interface HostedActivityInstance {
  readonly extensionId: string;
  readonly activityId: string;
  readonly epoch: number;
  readonly state: "active" | "paused" | "disposed";
  render(epoch: number, viewport: ActivityViewport): ActivityFrame;
  handleInput(epoch: number, input: ActivityInput): void;
  presentationChanged(epoch: number): void;
  pause(epoch: number, reason: ActivityPauseReason): void;
  resume(epoch: number): void;
  serialize(epoch: number): JsonValue | undefined;
  dispose(): Promise<void>;
}

export const ACTIVITY_LIMITS = Object.freeze({
  maxFrameLines: 512,
  maxSpans: 4_096,
  maxFrameBytes: 256 * 1024,
  maxAnnouncementBytes: 4 * 1024,
  maxStoredBytes: 256 * 1024,
  maxViewportWidth: 1_000,
  maxViewportHeight: 1_000,
  maxScheduleDelayMs: 24 * 60 * 60 * 1_000,
});

export class ActivityContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityContractError";
  }
}

export type ActivityStorageErrorCode =
  | "conflict"
  | "invalid"
  | "corrupt"
  | "future-version"
  | "oversized"
  | "permission"
  | "locked"
  | "unavailable"
  | "aborted";

export class ActivityStorageError extends Error {
  readonly code: ActivityStorageErrorCode;

  constructor(code: ActivityStorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ActivityStorageError";
    this.code = code;
  }
}

export interface TerminalExtensionApi {
  registerCommand(command: TerminalCommand): ExtensionDisposer;
  registerShortcut(shortcut: TerminalShortcut): ExtensionDisposer;
  registerStatus(key: string, text: TerminalLine): ExtensionDisposer;
  registerWorkingLabel(label: string): ExtensionDisposer;
  registerWidget(key: string, widget: TerminalWidget): ExtensionDisposer;
  registerToolRenderer(toolName: string, renderer: TerminalToolRenderer): ExtensionDisposer;
  registerActivity(activity: TerminalActivity): ExtensionDisposer;
  on(
    event: TerminalExtensionEventInput["type"],
    handler: (event: TerminalExtensionEvent) => void | Promise<void>,
  ): ExtensionDisposer;
  track(disposer: ExtensionDisposer): ExtensionDisposer;
}

export interface TerminalExtension {
  readonly manifest: ExtensionManifest;
  activate(
    api: TerminalExtensionApi,
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface OwnedTerminalCommand extends TerminalCommand {
  readonly extensionId: string;
}

export interface OwnedTerminalShortcut extends TerminalShortcut {
  readonly extensionId: string;
}

export interface OwnedTerminalToolRenderer {
  readonly extensionId: string;
  readonly renderer: TerminalToolRenderer;
}

interface OwnedStatus {
  readonly extensionId: string;
  readonly line: TerminalLine;
}

interface OwnedWidget {
  readonly extensionId: string;
  readonly widget: TerminalWidget;
}

interface OwnedListener {
  readonly extensionId: string;
  readonly handler: (event: TerminalExtensionEvent) => void | Promise<void>;
}

export interface TerminalExtensionHostOptions {
  readonly cleanupTimeoutMs?: number;
  /** Definitions kept available for explicit later activation without running them initially. */
  readonly initiallyInactiveExtensionIds?: readonly string[];
}

interface OwnedDisposer {
  readonly extensionId: string;
  readonly dispose: ExtensionDisposer;
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const EXTENSION_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

export class ExtensionRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionRegistrationError";
  }
}

function once(dispose: ExtensionDisposer): ExtensionDisposer {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    return dispose();
  };
}

async function withinCleanupBudget(
  tasks: readonly Promise<void>[],
  milliseconds: number,
): Promise<void> {
  if (tasks.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Extension cleanup exceeded ${milliseconds}ms`)),
      milliseconds,
    );
  });
  try {
    await Promise.race([Promise.all(tasks), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertBoundedText(value: string, label: string, maximumBytes: number): void {
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new ActivityContractError(`${label} exceeds ${maximumBytes} bytes`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ActivityContractError(`${label} must be a positive integer`);
  }
}

function validateJson(value: unknown, maximumBytes = ACTIVITY_LIMITS.maxStoredBytes): JsonValue {
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string") {
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate))
        throw new ActivityStorageError("invalid", "JSON numbers must be finite");
      return;
    }
    if (typeof candidate !== "object") {
      throw new ActivityStorageError("invalid", "Activity state must contain only JSON values");
    }
    if (seen.has(candidate))
      throw new ActivityStorageError("invalid", "Activity state must not be cyclic");
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (let index = 0; index < candidate.length; index += 1) {
        if (!(index in candidate))
          throw new ActivityStorageError("invalid", "Activity state arrays must not be sparse");
        visit(candidate[index]);
      }
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ActivityStorageError("invalid", "Activity state objects must be plain objects");
      }
      for (const item of Object.values(candidate)) visit(item);
    }
    seen.delete(candidate);
  };
  visit(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new ActivityStorageError(
      "invalid",
      `Activity state is not serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (new TextEncoder().encode(serialized).byteLength > maximumBytes) {
    throw new ActivityStorageError("oversized", `Activity state exceeds ${maximumBytes} bytes`);
  }
  return value as JsonValue;
}

function validateStoredValue(value: ActivityStoredValue): ActivityStoredValue {
  assertPositiveInteger(value.revision, "storage revision");
  assertPositiveInteger(value.schemaVersion, "storage schemaVersion");
  validateJson(value.value);
  return value;
}

function validateStatus(status: ActivitySafeStatus): ActivitySafeStatus {
  const operations = new Set<ActivitySafeStatus["operation"]>([
    "idle",
    "working",
    "waiting",
    "blocked",
    "failed",
    "completed",
    "unknown",
  ]);
  if (!operations.has(status.operation))
    throw new ActivityContractError("Invalid activity operation status");
  for (const [label, value] of [
    ["activeToolCount", status.activeToolCount],
    ["queuedInput.steer", status.queuedInput.steer],
    ["queuedInput.followUp", status.queuedInput.followUp],
    ["queuedInput.interrupt", status.queuedInput.interrupt],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ActivityContractError(`${label} must be a non-negative integer`);
    }
  }
  if (
    status.elapsedMs !== undefined &&
    (!Number.isFinite(status.elapsedMs) || status.elapsedMs < 0)
  ) {
    throw new ActivityContractError("elapsedMs must be finite and non-negative");
  }
  return Object.freeze({
    operation: status.operation,
    ...(status.elapsedMs === undefined ? {} : { elapsedMs: status.elapsedMs }),
    activeToolCount: status.activeToolCount,
    queuedInput: Object.freeze({ ...status.queuedInput }),
  });
}

function validatePresentation(
  preferences: ActivityPresentationPreferences,
): ActivityPresentationPreferences {
  if (typeof preferences.reducedMotion !== "boolean" || typeof preferences.textOnly !== "boolean") {
    throw new ActivityContractError("Activity presentation preferences must be boolean");
  }
  return Object.freeze({ ...preferences });
}

function validateViewport(viewport: ActivityViewport): void {
  assertPositiveInteger(viewport.width, "viewport width");
  assertPositiveInteger(viewport.height, "viewport height");
  if (
    viewport.width > ACTIVITY_LIMITS.maxViewportWidth ||
    viewport.height > ACTIVITY_LIMITS.maxViewportHeight
  ) {
    throw new ActivityContractError("Activity viewport exceeds host bounds");
  }
}

function validateFrame(frame: ActivityFrame, viewport: ActivityViewport): ActivityFrame {
  if (!Array.isArray(frame.lines))
    throw new ActivityContractError("Activity frame lines must be an array");
  if (frame.lines.length > viewport.height || frame.lines.length > ACTIVITY_LIMITS.maxFrameLines) {
    throw new ActivityContractError("Activity frame exceeds the line bound");
  }
  let spans = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  const styles = new Set<ActivityStyle>([
    "text",
    "muted",
    "accent",
    "success",
    "warning",
    "error",
    "selection",
  ]);
  for (const line of frame.lines) {
    if (!Array.isArray(line))
      throw new ActivityContractError("Activity frame lines must contain span arrays");
    spans += line.length;
    for (const span of line) {
      if (typeof span.text !== "string" || !styles.has(span.style)) {
        throw new ActivityContractError("Activity frame contains an invalid span");
      }
      if (span.emphasis !== undefined && !["none", "strong", "reverse"].includes(span.emphasis)) {
        throw new ActivityContractError("Activity frame contains invalid emphasis");
      }
      bytes += encoder.encode(span.text).byteLength;
    }
  }
  if (spans > ACTIVITY_LIMITS.maxSpans)
    throw new ActivityContractError("Activity frame exceeds the span bound");
  if (bytes > ACTIVITY_LIMITS.maxFrameBytes)
    throw new ActivityContractError("Activity frame exceeds the text bound");
  if (frame.announcement !== undefined) {
    assertBoundedText(
      frame.announcement,
      "Activity announcement",
      ACTIVITY_LIMITS.maxAnnouncementBytes,
    );
  }
  if (frame.cursor !== undefined) {
    if (
      !Number.isSafeInteger(frame.cursor.row) ||
      !Number.isSafeInteger(frame.cursor.column) ||
      frame.cursor.row < 0 ||
      frame.cursor.column < 0 ||
      frame.cursor.row >= viewport.height ||
      frame.cursor.column >= viewport.width
    ) {
      throw new ActivityContractError("Activity cursor is outside the viewport");
    }
  }
  return frame;
}

function validateInput(input: ActivityInput): void {
  if (input.type === "key") {
    if (typeof input.key !== "string" || input.key.length === 0 || input.key.length > 64) {
      throw new ActivityContractError("Activity key identifier is invalid");
    }
    for (const modifier of [input.ctrl, input.alt, input.shift, input.repeat]) {
      if (typeof modifier !== "boolean")
        throw new ActivityContractError("Activity key modifiers must be boolean");
    }
  } else if (input.type === "mouse") {
    if (input.phase !== "press" && input.phase !== "release") {
      throw new ActivityContractError("Activity mouse phase is invalid");
    }
    if (input.button !== "left" && input.button !== "middle" && input.button !== "right") {
      throw new ActivityContractError("Activity mouse button is invalid");
    }
    if (
      !Number.isSafeInteger(input.row) ||
      !Number.isSafeInteger(input.column) ||
      input.row < 0 ||
      input.column < 0 ||
      input.row >= ACTIVITY_LIMITS.maxViewportHeight ||
      input.column >= ACTIVITY_LIMITS.maxViewportWidth
    ) {
      throw new ActivityContractError("Activity mouse position is outside host bounds");
    }
    for (const modifier of [input.ctrl, input.alt, input.shift]) {
      if (typeof modifier !== "boolean") {
        throw new ActivityContractError("Activity mouse modifiers must be boolean");
      }
    }
  } else if (input.type === "focus") {
    if (typeof input.focused !== "boolean")
      throw new ActivityContractError("Activity focus must be boolean");
  } else if (!["paste", "composition", "unknown"].includes(input.type)) {
    throw new ActivityContractError("Unknown structured activity input");
  }
}

class HostedActivity implements HostedActivityInstance {
  readonly extensionId: string;
  readonly activityId: string;
  private readonly services: ActivityHostServices;
  private readonly mouseEnabled: boolean;
  private readonly onDisposed: () => void;
  private epochValue = 1;
  private stateValue: "active" | "paused" | "disposed" = "active";
  private readonly lifecycle = new AbortController();
  private epochLifecycle = new AbortController();
  private readonly schedules = new Set<ExtensionDisposer>();
  private invalidationPending = false;
  private lastNow = 0;
  private viewport: ActivityViewport | undefined;
  private instance: TerminalActivityInstance | undefined;
  private disposal: Promise<void> | undefined;

  constructor(
    extensionId: string,
    activityId: string,
    services: ActivityHostServices,
    create: (context: ActivityContext) => TerminalActivityInstance,
    storageEnabled: boolean,
    mouseEnabled: boolean,
    onDisposed: () => void,
  ) {
    this.extensionId = extensionId;
    this.activityId = activityId;
    this.services = services;
    this.mouseEnabled = mouseEnabled;
    this.onDisposed = onDisposed;
    this.lastNow = this.readNow();
    const thisHost = this;
    const context: ActivityContext = {
      get signal() {
        return thisHost.epochLifecycle.signal;
      },
      now: () => {
        this.assertActive();
        return this.readNow();
      },
      status: () => {
        this.assertActive();
        return validateStatus(this.services.status());
      },
      presentation: () => {
        this.assertActive();
        return validatePresentation(this.services.presentation());
      },
      invalidate: () => {
        this.assertActive();
        if (this.invalidationPending) return;
        this.invalidationPending = true;
        this.services.invalidate();
      },
      schedule: (delayMs, callback) => this.schedule(delayMs, callback),
      ...(storageEnabled ? { storage: this.createStorage() } : {}),
    };
    try {
      this.instance = create(Object.freeze(context));
      if (this.instance === null || typeof this.instance !== "object") {
        throw new ActivityContractError(`Activity ${activityId} did not create an instance`);
      }
    } catch (error) {
      this.stateValue = "disposed";
      this.lifecycle.abort();
      this.epochLifecycle.abort();
      this.cancelSchedules();
      throw error;
    }
  }

  get epoch(): number {
    return this.epochValue;
  }

  get state(): "active" | "paused" | "disposed" {
    return this.stateValue;
  }

  render(epoch: number, viewport: ActivityViewport): ActivityFrame {
    this.assertEpoch(epoch, "render");
    validateViewport(viewport);
    this.invalidationPending = false;
    const frame = validateFrame(
      this.requireInstance().render(Object.freeze({ ...viewport })),
      viewport,
    );
    this.viewport = Object.freeze({ ...viewport });
    return frame;
  }

  handleInput(epoch: number, input: ActivityInput): void {
    this.assertEpoch(epoch, "input");
    validateInput(input);
    if (input.type === "mouse" && !this.mouseEnabled) {
      throw new ActivityContractError(`Activity ${this.activityId} did not opt in to mouse input`);
    }
    if (
      input.type === "mouse" &&
      (this.viewport === undefined ||
        input.row >= this.viewport.height ||
        input.column >= this.viewport.width)
    ) {
      throw new ActivityContractError("Activity mouse position is outside its rendered viewport");
    }
    this.requireInstance().handleInput(Object.freeze({ ...input }));
  }

  presentationChanged(epoch: number): void {
    this.assertEpoch(epoch, "presentation change");
    this.cancelSchedules();
    this.requireInstance().presentationChanged?.();
  }

  pause(epoch: number, reason: ActivityPauseReason): void {
    this.assertEpoch(epoch, "pause");
    this.stateValue = "paused";
    this.epochValue += 1;
    this.epochLifecycle.abort();
    this.cancelSchedules();
    this.invalidationPending = false;
    this.viewport = undefined;
    this.requireInstance().pause(reason);
  }

  resume(epoch: number): void {
    if (this.stateValue !== "paused" || epoch !== this.epochValue) {
      throw new ActivityContractError(`Activity ${this.activityId} resume used a stale epoch`);
    }
    this.stateValue = "active";
    this.epochValue += 1;
    this.epochLifecycle = new AbortController();
    this.requireInstance().resume();
  }

  serialize(epoch: number): JsonValue | undefined {
    if (this.stateValue === "disposed" || epoch !== this.epochValue) {
      throw new ActivityContractError(`Activity ${this.activityId} serialize used a stale epoch`);
    }
    const value = this.requireInstance().serialize();
    return value === undefined ? undefined : validateJson(value);
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.stateValue = "disposed";
    this.epochValue += 1;
    this.lifecycle.abort();
    this.epochLifecycle.abort();
    this.cancelSchedules();
    this.invalidationPending = false;
    this.viewport = undefined;
    const instance = this.instance;
    this.instance = undefined;
    this.onDisposed();
    this.disposal = Promise.resolve()
      .then(() => instance?.dispose())
      .then(() => undefined);
    return this.disposal;
  }

  private assertActive(): void {
    if (this.stateValue !== "active" || this.lifecycle.signal.aborted) {
      throw new ActivityContractError(`Activity ${this.activityId} context is stale`);
    }
  }

  private assertEpoch(epoch: number, operation: string): void {
    if (this.stateValue !== "active" || epoch !== this.epochValue) {
      throw new ActivityContractError(
        `Activity ${this.activityId} ${operation} used a stale epoch`,
      );
    }
  }

  private requireInstance(): TerminalActivityInstance {
    if (this.instance === undefined)
      throw new ActivityContractError(`Activity ${this.activityId} is disposed`);
    return this.instance;
  }

  private readNow(): number {
    const value = this.services.now();
    if (!Number.isFinite(value) || value < this.lastNow) {
      throw new ActivityContractError("Activity host clock must be finite and monotonic");
    }
    this.lastNow = value;
    return value;
  }

  private schedule(delayMs: number, callback: ActivityScheduledCallback): ExtensionDisposer {
    this.assertActive();
    if (
      !Number.isSafeInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > ACTIVITY_LIMITS.maxScheduleDelayMs
    ) {
      throw new ActivityContractError("Activity schedule delay is outside host bounds");
    }
    const epoch = this.epochValue;
    const startedAt = this.readNow();
    let active = true;
    let cancelHost: ExtensionDisposer = () => undefined;
    const cancel = once(() => {
      if (!active) return;
      active = false;
      this.schedules.delete(cancel);
      return cancelHost();
    });
    cancelHost = this.services.schedule(delayMs, () => {
      if (!active) return;
      active = false;
      this.schedules.delete(cancel);
      if (this.stateValue !== "active" || this.epochValue !== epoch) return;
      callback(this.readNow() - startedAt);
    });
    if (active) this.schedules.add(cancel);
    return cancel;
  }

  private cancelSchedules(): void {
    for (const cancel of [...this.schedules]) cancel();
    this.schedules.clear();
  }

  private createStorage(): ActivityStorage {
    const adapter = this.services.storage;
    if (adapter === undefined) {
      throw new ActivityContractError("Activity storage capability has no host adapter");
    }
    const scope = Object.freeze({ extensionId: this.extensionId, activityId: this.activityId });
    const run = async <T>(
      signal: AbortSignal | undefined,
      operation: (combined: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      this.assertActive();
      const epoch = this.epochValue;
      const signals = [this.lifecycle.signal, this.epochLifecycle.signal];
      if (signal !== undefined) signals.push(signal);
      const controller = new AbortController();
      const listeners = signals.map((source) => {
        const abort = () => controller.abort(source.reason);
        if (source.aborted) abort();
        else source.addEventListener("abort", abort, { once: true });
        return { source, abort };
      });
      const combined = controller.signal;
      try {
        if (combined.aborted) {
          throw new ActivityStorageError("aborted", "Activity storage operation was aborted");
        }
        let result: T;
        try {
          result = await operation(combined);
        } catch (error) {
          if (combined.aborted) {
            throw new ActivityStorageError("aborted", "Activity storage operation was aborted");
          }
          throw error;
        }
        if (this.stateValue !== "active" || this.epochValue !== epoch || combined.aborted) {
          throw new ActivityStorageError("aborted", "Activity storage context became stale");
        }
        return result;
      } finally {
        for (const { source, abort } of listeners) source.removeEventListener("abort", abort);
      }
    };
    const storage: ActivityStorage = {
      read: (signal?: AbortSignal) =>
        run(signal, async (combined) => {
          const value = await adapter.read(scope, combined);
          return value === undefined ? undefined : validateStoredValue(value);
        }),
      write: (expectedRevision, schemaVersion, value, signal?: AbortSignal) => {
        if (
          expectedRevision !== null &&
          (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
        ) {
          throw new ActivityStorageError(
            "invalid",
            "Expected revision must be null or a positive integer",
          );
        }
        if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
          throw new ActivityStorageError("invalid", "Schema version must be a positive integer");
        }
        const checked = validateJson(value);
        return run(signal, async (combined) => {
          const stored = validateStoredValue(
            await adapter.write(scope, expectedRevision, schemaVersion, checked, combined),
          );
          const nextRevision = expectedRevision === null ? 1 : expectedRevision + 1;
          if (stored.revision !== nextRevision || stored.schemaVersion !== schemaVersion) {
            throw new ActivityStorageError(
              "invalid",
              "Storage adapter returned an invalid revision",
            );
          }
          return stored;
        });
      },
      reset: (expectedRevision, signal?: AbortSignal) => {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
          throw new ActivityStorageError("invalid", "Expected revision must be a positive integer");
        }
        return run(signal, (combined) => adapter.reset(scope, expectedRevision, combined));
      },
    };
    return Object.freeze(storage);
  }
}

/** Owns trusted terminal registrations without exposing client or daemon internals. */
export class TerminalExtensionHost {
  private readonly definitions: readonly TerminalExtension[];
  private readonly commandsByName = new Map<string, OwnedTerminalCommand>();
  private readonly shortcutsByKey = new Map<string, OwnedTerminalShortcut>();
  private readonly statusesByKey = new Map<string, OwnedStatus>();
  private readonly widgetsByKey = new Map<string, OwnedWidget>();
  private readonly toolRenderersByName = new Map<string, OwnedTerminalToolRenderer>();
  private readonly activitiesById = new Map<string, OwnedTerminalActivity>();
  private readonly activityInstances = new Map<string, Set<HostedActivity>>();
  private readonly listenersByEvent = new Map<
    TerminalExtensionEventInput["type"],
    Set<OwnedListener>
  >();
  private readonly workingLabels: Array<{ extensionId: string; label: string }> = [];
  private readonly pendingEvents = new Map<string, Set<Promise<Error | undefined>>>();
  private readonly lifecycles = new Map<string, AbortController>();
  private readonly activeExtensions = new Set<string>();
  private ownedDisposers: OwnedDisposer[] = [];
  private readonly cleanupTimeoutMs: number;
  private readonly inactiveExtensionIds: Set<string>;
  private widgetRevisionValue = 0;
  private active = false;

  constructor(
    definitions: readonly TerminalExtension[] = [],
    options: TerminalExtensionHostOptions = {},
  ) {
    this.definitions = [...definitions];
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    this.inactiveExtensionIds = new Set(options.initiallyInactiveExtensionIds ?? []);
    if (!Number.isSafeInteger(this.cleanupTimeoutMs) || this.cleanupTimeoutMs < 1) {
      throw new ExtensionRegistrationError("cleanupTimeoutMs must be a positive integer");
    }
    const ids = new Set<string>();
    for (const definition of definitions) {
      const { id, name } = definition.manifest;
      if (!EXTENSION_ID.test(id))
        throw new ExtensionRegistrationError(`Invalid extension id ${id}`);
      if (!name.trim()) throw new ExtensionRegistrationError(`Extension ${id} has no display name`);
      if (ids.has(id)) throw new ExtensionRegistrationError(`Duplicate extension id ${id}`);
      ids.add(id);
    }
    for (const id of this.inactiveExtensionIds) {
      if (!ids.has(id))
        throw new ExtensionRegistrationError(`Unknown initially inactive extension ${id}`);
    }
  }

  async activate(): Promise<void> {
    if (this.active) throw new ExtensionRegistrationError("Terminal extensions are already active");
    this.active = true;
    try {
      for (const definition of this.definitions) {
        if (!this.inactiveExtensionIds.has(definition.manifest.id)) {
          await this.activateExtension(definition.manifest.id);
        }
      }
    } catch (error) {
      try {
        await this.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Extension activation cleanup failed");
      }
      throw error;
    }
  }

  async activateExtension(extensionId: string): Promise<void> {
    if (!this.active) throw new ExtensionRegistrationError("Terminal extension host is not active");
    if (this.activeExtensions.has(extensionId)) return;
    const definition = this.definitions.find((candidate) => candidate.manifest.id === extensionId);
    if (definition === undefined) {
      throw new ExtensionRegistrationError(`Unknown extension ${extensionId}`);
    }
    const lifecycle = new AbortController();
    this.lifecycles.set(extensionId, lifecycle);
    this.activeExtensions.add(extensionId);
    try {
      const cleanup = await definition.activate(this.apiFor(definition, lifecycle));
      if (cleanup !== undefined) {
        this.ownedDisposers.push({ extensionId, dispose: once(cleanup) });
      }
    } catch (error) {
      const activationError = new ExtensionRegistrationError(
        `Extension ${extensionId} failed to activate: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        await this.deactivate(extensionId);
      } catch (cleanupError) {
        throw new AggregateError(
          [activationError, cleanupError],
          `Extension ${extensionId} activation rollback failed`,
        );
      }
      throw activationError;
    }
  }

  async setExtensionEnabled(extensionId: string, enabled: boolean): Promise<void> {
    if (!this.definitions.some((definition) => definition.manifest.id === extensionId)) {
      throw new ExtensionRegistrationError(`Unknown extension ${extensionId}`);
    }
    if (enabled) {
      this.inactiveExtensionIds.delete(extensionId);
      await this.activateExtension(extensionId);
    } else {
      this.inactiveExtensionIds.add(extensionId);
      await this.deactivate(extensionId);
    }
  }

  async deactivate(extensionId: string): Promise<void> {
    if (!this.activeExtensions.has(extensionId)) return;
    this.activeExtensions.delete(extensionId);
    this.lifecycles.get(extensionId)?.abort();
    this.lifecycles.delete(extensionId);
    const failures: unknown[] = [];
    const owned = this.ownedDisposers.filter((entry) => entry.extensionId === extensionId);
    this.ownedDisposers = this.ownedDisposers.filter((entry) => entry.extensionId !== extensionId);
    const pending: Promise<void>[] = [];
    for (const entry of owned.reverse()) {
      try {
        const result = entry.dispose();
        if (result !== undefined) {
          pending.push(
            Promise.resolve(result).catch((error: unknown) => {
              failures.push(error);
            }),
          );
        }
      } catch (error) {
        failures.push(error);
      }
    }
    const eventWork = [...(this.pendingEvents.get(extensionId) ?? [])].map((task) =>
      task.then((error) => {
        if (error !== undefined) failures.push(error);
      }),
    );
    this.pendingEvents.delete(extensionId);
    try {
      await withinCleanupBudget([...pending, ...eventWork], this.cleanupTimeoutMs);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Extension ${extensionId} cleanup failed`);
    }
  }

  async reload(): Promise<void> {
    await this.dispose();
    await this.activate();
  }

  async dispose(): Promise<void> {
    const failures: unknown[] = [];
    for (const definition of [...this.definitions].reverse()) {
      try {
        await this.deactivate(definition.manifest.id);
      } catch (error) {
        failures.push(error);
      }
    }
    this.active = false;
    if (failures.length > 0)
      throw new AggregateError(failures, "Terminal extension cleanup failed");
  }

  extensionStates(): readonly { readonly id: string; readonly active: boolean }[] {
    return this.definitions.map((definition) => ({
      id: definition.manifest.id,
      active: this.activeExtensions.has(definition.manifest.id),
    }));
  }

  commands(): readonly OwnedTerminalCommand[] {
    return [...this.commandsByName.values()];
  }

  shortcuts(): readonly OwnedTerminalShortcut[] {
    return [...this.shortcutsByKey.values()];
  }

  statuses(): readonly TerminalLine[] {
    return [...this.statusesByKey.values()].map((status) => status.line);
  }

  get widgetRevision(): number {
    return this.widgetRevisionValue;
  }

  widgets(placement: "aboveEditor" | "belowEditor"): readonly TerminalWidget[] {
    return [...this.widgetsByKey.values()]
      .map((entry) => entry.widget)
      .filter((widget) => (widget.placement ?? "aboveEditor") === placement);
  }

  workingLabel(): string | undefined {
    return this.workingLabels.at(-1)?.label;
  }

  toolRenderer(name: string): OwnedTerminalToolRenderer | undefined {
    return this.toolRenderersByName.get(name);
  }

  activities(): readonly OwnedTerminalActivity[] {
    return [...this.activitiesById.values()];
  }

  createActivity(activityId: string, services: ActivityHostServices): HostedActivityInstance {
    const activity = this.activitiesById.get(activityId);
    if (activity === undefined) {
      throw new ExtensionRegistrationError(`Unknown activity ${activityId}`);
    }
    const lifecycle = this.lifecycles.get(activity.extensionId);
    if (!this.active || lifecycle === undefined || lifecycle.signal.aborted) {
      throw new ExtensionRegistrationError(`Extension ${activity.extensionId} API is stale`);
    }
    let hosted: HostedActivity;
    const instances = this.activityInstances.get(activityId) ?? new Set<HostedActivity>();
    hosted = new HostedActivity(
      activity.extensionId,
      activity.id,
      services,
      activity.create,
      this.definitions
        .find((definition) => definition.manifest.id === activity.extensionId)
        ?.manifest.capabilities.includes("terminal.activity-storage") ?? false,
      activity.mouse === true,
      () => {
        instances.delete(hosted);
        if (instances.size === 0) this.activityInstances.delete(activityId);
      },
    );
    instances.add(hosted);
    this.activityInstances.set(activityId, instances);
    return hosted;
  }

  async emit(input: TerminalExtensionEventInput): Promise<readonly Error[]> {
    if (!this.active) return [];
    const tasks: Promise<Error | undefined>[] = [];
    for (const listener of this.listenersByEvent.get(input.type) ?? []) {
      const lifecycle = this.lifecycles.get(listener.extensionId);
      if (lifecycle === undefined || lifecycle.signal.aborted) continue;
      const event = { ...input, signal: lifecycle.signal } as TerminalExtensionEvent;
      const task = Promise.resolve()
        .then(() => (lifecycle.signal.aborted ? undefined : listener.handler(event)))
        .then(
          () => undefined,
          (error: unknown) =>
            new Error(
              `Extension ${listener.extensionId} ${event.type} handler failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
        );
      const pending = this.pendingEvents.get(listener.extensionId) ?? new Set();
      pending.add(task);
      this.pendingEvents.set(listener.extensionId, pending);
      void task.finally(() => {
        pending.delete(task);
        if (pending.size === 0) this.pendingEvents.delete(listener.extensionId);
      });
      tasks.push(task);
    }
    const results = await Promise.all(tasks);
    return results.filter((error): error is Error => error !== undefined);
  }

  private apiFor(definition: TerminalExtension, lifecycle: AbortController): TerminalExtensionApi {
    const extensionId = definition.manifest.id;
    const declared = new Set(definition.manifest.capabilities);
    const assertActive = (): void => {
      if (
        !this.active ||
        this.lifecycles.get(extensionId) !== lifecycle ||
        lifecycle.signal.aborted
      ) {
        throw new ExtensionRegistrationError(`Extension ${extensionId} API is stale`);
      }
    };
    const requireCapability = (capability: ExtensionCapability): void => {
      assertActive();
      if (!declared.has(capability)) {
        throw new ExtensionRegistrationError(
          `Extension ${extensionId} did not declare capability ${capability}`,
        );
      }
    };
    const own = (dispose: ExtensionDisposer): ExtensionDisposer => {
      const tracked = once(dispose);
      this.ownedDisposers.push({ extensionId, dispose: tracked });
      return tracked;
    };
    return {
      registerCommand: (command) => {
        requireCapability("terminal.commands");
        if (!COMMAND_NAME.test(command.name)) {
          throw new ExtensionRegistrationError(`Invalid command name ${command.name}`);
        }
        if (this.commandsByName.has(command.name)) {
          throw new ExtensionRegistrationError(`Command /${command.name} is already registered`);
        }
        const owned = { ...command, extensionId };
        this.commandsByName.set(command.name, owned);
        return own(() => {
          if (this.commandsByName.get(command.name) === owned)
            this.commandsByName.delete(command.name);
        });
      },
      registerShortcut: (shortcut) => {
        requireCapability("terminal.shortcuts");
        if (!shortcut.key) throw new ExtensionRegistrationError("Shortcut key cannot be empty");
        if (this.shortcutsByKey.has(shortcut.key)) {
          throw new ExtensionRegistrationError(`Shortcut ${shortcut.key} is already registered`);
        }
        const owned = { ...shortcut, extensionId };
        this.shortcutsByKey.set(shortcut.key, owned);
        return own(() => {
          if (this.shortcutsByKey.get(shortcut.key) === owned)
            this.shortcutsByKey.delete(shortcut.key);
        });
      },
      registerStatus: (key, line) => {
        requireCapability("terminal.status");
        const owned = { extensionId, line };
        this.statusesByKey.set(`${extensionId}:${key}`, owned);
        return own(() => {
          if (this.statusesByKey.get(`${extensionId}:${key}`) === owned) {
            this.statusesByKey.delete(`${extensionId}:${key}`);
          }
        });
      },
      registerWorkingLabel: (label) => {
        requireCapability("terminal.status");
        const owned = { extensionId, label };
        this.workingLabels.push(owned);
        return own(() => {
          const index = this.workingLabels.indexOf(owned);
          if (index >= 0) this.workingLabels.splice(index, 1);
        });
      },
      registerWidget: (key, widget) => {
        requireCapability("terminal.widgets");
        const owned = { extensionId, widget };
        const registryKey = `${extensionId}:${key}`;
        if (this.widgetsByKey.has(registryKey)) {
          throw new ExtensionRegistrationError(`Widget ${registryKey} is already registered`);
        }
        this.widgetsByKey.set(registryKey, owned);
        this.widgetRevisionValue += 1;
        return own(async () => {
          if (this.widgetsByKey.get(registryKey) !== owned) return;
          this.widgetsByKey.delete(registryKey);
          this.widgetRevisionValue += 1;
          await widget.dispose?.();
        });
      },
      registerToolRenderer: (toolName, renderer) => {
        requireCapability("terminal.tool-renderers");
        if (this.toolRenderersByName.has(toolName)) {
          throw new ExtensionRegistrationError(`Tool renderer ${toolName} is already registered`);
        }
        const owned = { extensionId, renderer };
        this.toolRenderersByName.set(toolName, owned);
        return own(() => {
          if (this.toolRenderersByName.get(toolName) === owned) {
            this.toolRenderersByName.delete(toolName);
          }
        });
      },
      registerActivity: (activity) => {
        requireCapability("terminal.activities");
        if (!EXTENSION_ID.test(activity.id)) {
          throw new ExtensionRegistrationError(`Invalid activity id ${activity.id}`);
        }
        if (!activity.name.trim() || !activity.description.trim()) {
          throw new ExtensionRegistrationError(
            `Activity ${activity.id} requires a name and description`,
          );
        }
        assertBoundedText(activity.name, "Activity name", 128);
        assertBoundedText(activity.description, "Activity description", 1_024);
        if (activity.category !== "game") {
          throw new ExtensionRegistrationError(
            `Activity ${activity.id} has an unsupported category`,
          );
        }
        if (activity.mouse !== undefined && typeof activity.mouse !== "boolean") {
          throw new ExtensionRegistrationError(`Activity ${activity.id} mouse support is invalid`);
        }
        if (activity.minimumViewport !== undefined) {
          validateViewport(activity.minimumViewport);
        }
        if (this.activitiesById.has(activity.id)) {
          throw new ExtensionRegistrationError(`Activity ${activity.id} is already registered`);
        }
        const owned = {
          ...activity,
          ...(activity.minimumViewport === undefined
            ? {}
            : { minimumViewport: Object.freeze({ ...activity.minimumViewport }) }),
          extensionId,
        };
        this.activitiesById.set(activity.id, owned);
        return own(async () => {
          if (this.activitiesById.get(activity.id) !== owned) return;
          this.activitiesById.delete(activity.id);
          const instances = [...(this.activityInstances.get(activity.id) ?? [])];
          await Promise.all(instances.map((instance) => instance.dispose()));
        });
      },
      on: (event, handler) => {
        requireCapability("terminal.events");
        const owned = { extensionId, handler };
        const listeners = this.listenersByEvent.get(event) ?? new Set<OwnedListener>();
        listeners.add(owned);
        this.listenersByEvent.set(event, listeners);
        return own(() => {
          listeners.delete(owned);
          if (listeners.size === 0) this.listenersByEvent.delete(event);
        });
      },
      track: (disposer) => {
        assertActive();
        return own(disposer);
      },
    };
  }
}
