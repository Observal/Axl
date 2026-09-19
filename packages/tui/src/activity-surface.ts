// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type {
  ActivityFrame,
  ActivityInput,
  ActivityPauseReason,
  ActivityPresentationPreferences,
  ActivitySafeStatus,
  ActivitySpan,
  ActivityStorageAdapter,
  HostedActivityInstance,
  JsonValue,
  TerminalExtensionHost,
} from "@axl/extension-api";

import {
  type ActivityRasterProtocol,
  activityRasterSequence,
  normalizeActivityRasterPointer,
  type PreparedActivityRaster,
  prepareActivityRaster,
  type TerminalCellPixels,
  validTerminalCellPixels,
} from "./activity-raster.ts";
import type { EditorKey } from "./editor.ts";
import { isMouseReport, type MouseInput, parseMouseInput } from "./fullscreen-input.ts";
import { sanitizeTerminalText, truncateToWidth, visibleWidth } from "./render.ts";
import type { Palette } from "./transcript.ts";

const MIN_WIDTH = 40;
const MIN_HEIGHT = 12;
const FRAME_INTERVAL_MS = Math.ceil(1_000 / 15);

export interface ActivityMonitorEntry {
  readonly label: string;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "denied" | "aborted";
  readonly preview: readonly string[];
}

export interface ActivityMonitorSnapshot {
  readonly status: ActivitySafeStatus;
  readonly connection: "connected" | "reconnecting" | "detached";
  readonly sandbox?: string;
  readonly current?: ActivityMonitorEntry;
  readonly recent: readonly ActivityMonitorEntry[];
  readonly changes: readonly string[];
  readonly changesAuthoritative: boolean;
}

export interface ActivityAgentFrame {
  readonly lines: readonly string[];
  readonly cursor?: { readonly row: number; readonly column: number; readonly visible?: boolean };
}

export interface ActivitySurfaceOptions {
  readonly host: TerminalExtensionHost;
  readonly palette: () => Palette;
  readonly invalidate: () => void;
  readonly monitor: () => ActivityMonitorSnapshot;
  /** TUI-private normal Agent surface. The activity extension never receives this frame. */
  readonly agentFrame?: (width: number, height: number, focused: boolean) => ActivityAgentFrame;
  /** Returns false only when an unclaimed Tab should switch panes. */
  readonly handleAgentInput?: (data: string) => boolean;
  readonly agentTabHint?: () => "complete" | "game";
  readonly presentation: () => ActivityPresentationPreferences;
  readonly rasterProtocol?: ActivityRasterProtocol;
  readonly terminalCellPixels?: () => TerminalCellPixels | undefined;
  readonly returnToTranscript: () => void;
  readonly returnToEditor: () => void;
  readonly openWorkspaceReview: () => void;
  readonly reportError: (error: Error) => void;
  readonly storage?: ActivityStorageAdapter;
  readonly now?: () => number;
  readonly schedule?: (delayMs: number, callback: () => void) => () => void;
  readonly setMouseCapture?: (enabled: boolean) => void;
  readonly onActivityOpened?: (activityId: string) => void | Promise<void>;
}

export type ActivitySurfaceState = "closed" | "picker" | "active" | "suspended" | "disposed";

type PointerLayout =
  | {
      readonly kind: "activity";
      readonly width: number;
      readonly height: number;
      readonly wide: boolean;
      readonly agentWidth: number;
      readonly gameLeft: number;
      readonly gameTop: number;
      readonly gameWidth: number;
      readonly gameHeight: number;
      readonly footer: string;
    }
  | {
      readonly kind: "picker";
      readonly width: number;
      readonly height: number;
      readonly wide: boolean;
      readonly agentWidth: number;
      readonly pickerLeft: number;
      readonly pickerWidth: number;
      readonly footer: string;
    }
  | {
      readonly kind: "agent";
      readonly width: number;
      readonly height: number;
      readonly footer: string;
    };

function style(span: ActivitySpan, palette: Palette, textOnly: boolean): string {
  const text = sanitizeTerminalText(span.text);
  const surfaced =
    span.background === undefined || textOnly
      ? text
      : (palette.activityBackground?.(span.background, text) ?? text);
  const styled =
    span.style === "muted"
      ? palette.dim(surfaced)
      : span.style === "accent"
        ? palette.accent(surfaced)
        : span.style === "success"
          ? (palette.success ?? palette.accent)(surfaced)
          : span.style === "warning"
            ? (palette.warning ?? palette.accent)(surfaced)
            : span.style === "error"
              ? palette.error(surfaced)
              : span.style === "selection"
                ? (palette.selection ?? palette.bold ?? palette.accent)(surfaced)
                : (palette.text ?? ((value: string) => value))(surfaced);
  if (span.emphasis === "strong") return (palette.bold ?? palette.accent)(styled);
  if (span.emphasis === "reverse")
    return (palette.selection ?? palette.bold ?? palette.accent)(styled);
  return styled;
}

function fit(value: string, width: number): string {
  const clipped = truncateToWidth(value, Math.max(0, width), "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function operationLabel(status: ActivitySafeStatus): string {
  const marker =
    status.operation === "working"
      ? "◐"
      : status.operation === "completed"
        ? "✓"
        : status.operation === "failed" || status.operation === "blocked"
          ? "!"
          : status.operation === "waiting"
            ? "…"
            : "·";
  const elapsed = status.elapsedMs === undefined ? "" : ` ${Math.floor(status.elapsedMs / 1_000)}s`;
  return `${marker} ${status.operation}${elapsed}`;
}

function inputFromEditorKey(key: EditorKey): ActivityInput {
  if (key.kind === "char") {
    return { type: "key", key: key.char, ctrl: false, alt: false, shift: false, repeat: false };
  }
  if (key.kind === "ctrl" || key.kind === "alt") {
    return {
      type: "key",
      key: key.char,
      ctrl: key.kind === "ctrl",
      alt: key.kind === "alt",
      shift: false,
      repeat: false,
    };
  }
  if (key.kind === "paste-start" || key.kind === "paste-end") return { type: "paste" };
  if (key.kind === "unknown") return { type: "unknown" };
  return {
    type: "key",
    key: key.kind,
    ctrl: false,
    alt: false,
    shift: key.kind === "shift-tab" || key.kind.startsWith("select-"),
    repeat: false,
  };
}

/** Owns the client-local activity state beneath ordinary and attention overlays. */
export class ActivitySurfaceHost {
  private readonly options: ActivitySurfaceOptions;
  private stateValue: ActivitySurfaceState = "closed";
  private instance: HostedActivityInstance | undefined;
  private activityId: string | undefined;
  private pickerIndex = 0;
  private monitorFocused = false;
  private suspensionReason: ActivityPauseReason | undefined;
  private completionNotice: string | undefined;
  private lastFrame: ActivityFrame | undefined;
  private snapshotValue: JsonValue | undefined;
  private pointerLayout: PointerLayout | undefined;
  private preparedRasters: readonly PreparedActivityRaster[] = [];
  private mouseCaptureEnabled = false;
  private disposed = false;

  constructor(options: ActivitySurfaceOptions) {
    this.options = options;
  }

  get state(): ActivitySurfaceState {
    return this.stateValue;
  }

  get visible(): boolean {
    return this.stateValue !== "closed" && this.stateValue !== "disposed";
  }

  get snapshot(): JsonValue | undefined {
    return this.snapshotValue;
  }

  get agentFocused(): boolean {
    return this.visible && this.monitorFocused;
  }

  openPrimary(): boolean {
    this.assertUsable();
    if (this.stateValue === "active" && this.instance !== undefined) {
      this.monitorFocused = false;
      this.options.invalidate();
      return true;
    }
    const activities = this.options.host.activities();
    if (activities.length === 0) return false;
    if (activities.length === 1) {
      this.open((activities[0] as (typeof activities)[number]).id);
      return true;
    }
    return this.openPicker();
  }

  openPicker(): boolean {
    this.assertUsable();
    if (this.options.host.activities().length === 0) return false;
    if (this.stateValue === "picker") return true;
    if (this.instance !== undefined && this.instance.state === "active") {
      try {
        this.instance.pause(this.instance.epoch, "hidden");
      } catch (error) {
        this.report(error);
      }
    }
    this.stateValue = "picker";
    this.updateMouseCapture();
    this.suspensionReason = "hidden";
    this.monitorFocused = false;
    const currentIndex = this.options.host
      .activities()
      .findIndex(({ id }) => id === this.activityId);
    this.pickerIndex =
      currentIndex < 0
        ? Math.min(this.pickerIndex, this.options.host.activities().length - 1)
        : currentIndex;
    this.options.invalidate();
    return true;
  }

  open(activityId: string): void {
    this.assertUsable();
    if (
      this.stateValue === "picker" &&
      activityId === this.activityId &&
      this.instance?.state === "paused"
    ) {
      this.returnFromPicker();
      return;
    }
    if (activityId === this.activityId && this.instance?.state === "active") {
      this.stateValue = "active";
      this.updateMouseCapture();
      this.setAgentFocused(false);
      this.options.invalidate();
      return;
    }
    void this.disposeInstance().catch((error: unknown) => this.report(error));
    this.activityId = activityId;
    this.lastFrame = undefined;
    this.snapshotValue = undefined;
    this.suspensionReason = undefined;
    this.completionNotice = undefined;
    try {
      this.instance = this.options.host.createActivity(activityId, {
        now: this.options.now ?? (() => performance.now()),
        schedule:
          this.options.schedule ??
          ((delayMs, callback) => {
            const timer = setTimeout(callback, Math.max(FRAME_INTERVAL_MS, delayMs));
            timer.unref?.();
            return () => clearTimeout(timer);
          }),
        invalidate: this.options.invalidate,
        status: () => this.options.monitor().status,
        presentation: this.options.presentation,
        ...(this.options.storage === undefined ? {} : { storage: this.options.storage }),
      });
      this.stateValue = "active";
      this.updateMouseCapture();
      this.monitorFocused = false;
      void Promise.resolve(this.options.onActivityOpened?.(activityId)).catch((error: unknown) =>
        this.report(error),
      );
    } catch (error) {
      this.instance = undefined;
      this.stateValue = "picker";
      this.updateMouseCapture();
      this.report(error);
    }
    this.options.invalidate();
  }

  suspend(reason: ActivityPauseReason): void {
    if (!this.visible || this.instance === undefined) return;
    if (this.instance.state === "active") {
      try {
        this.instance.pause(this.instance.epoch, reason);
      } catch (error) {
        this.report(error);
      }
    }
    this.captureSnapshot();
    this.suspensionReason = reason;
    this.stateValue = "suspended";
    this.updateMouseCapture();
    this.options.invalidate();
  }

  resume(): boolean {
    if (this.instance === undefined || this.instance.state !== "paused") return false;
    try {
      this.instance.resume(this.instance.epoch);
    } catch (error) {
      this.report(error);
      return false;
    }
    this.stateValue = "active";
    this.updateMouseCapture();
    this.suspensionReason = undefined;
    this.monitorFocused = false;
    this.options.invalidate();
    return true;
  }

  restoreTerminalFocus(): void {
    if (this.stateValue === "suspended" && this.suspensionReason === "unfocused") this.resume();
  }

  notifyCompletion(): void {
    if (!this.visible) return;
    this.completionNotice = "Axl finished";
    this.options.invalidate();
  }

  notifyOperationStarted(): void {
    if (this.completionNotice === undefined) return;
    this.completionNotice = undefined;
    this.options.invalidate();
  }

  presentationChanged(): void {
    if (this.instance?.state !== "active") return;
    try {
      this.instance.presentationChanged(this.instance.epoch);
    } catch (error) {
      this.report(error);
      this.suspend("attention");
      return;
    }
    this.options.invalidate();
  }

  close(reason: ActivityPauseReason = "hidden"): void {
    if (this.instance !== undefined && this.instance.state === "active") {
      try {
        this.instance.pause(this.instance.epoch, reason);
      } catch (error) {
        this.report(error);
      }
    }
    this.captureSnapshot();
    this.stateValue = "closed";
    this.updateMouseCapture();
    this.suspensionReason = reason;
    this.monitorFocused = false;
    this.options.returnToTranscript();
  }

  async reset(): Promise<void> {
    this.stateValue = "closed";
    this.updateMouseCapture();
    await this.disposeInstance();
    this.activityId = undefined;
    this.snapshotValue = undefined;
    this.suspensionReason = undefined;
    this.completionNotice = undefined;
    this.monitorFocused = false;
    this.options.invalidate();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stateValue = "disposed";
    this.updateMouseCapture();
    await this.disposeInstance();
  }

  statusLabel(): string {
    if (this.instance === undefined) return "closed";
    const name = this.options.host.activities().find(({ id }) => id === this.activityId)?.name;
    return `${name ?? "activity"} · ${this.stateValue}`;
  }

  handleInput(
    data: string,
    decode: (data: string, index: number) => { key: EditorKey; next: number },
    rowOffset = 0,
  ): void {
    if (!this.visible) return;
    if (isMouseReport(data)) {
      const mouse = parseMouseInput(data);
      if (mouse !== undefined && mouse.row >= rowOffset) {
        this.handleMouse({ ...mouse, row: mouse.row - rowOffset });
      }
      return;
    }
    for (let index = 0; index < data.length; ) {
      const start = index;
      const decoded = decode(data, index);
      index = decoded.next;
      const encodedKey = data.slice(start, index);
      const key = decoded.key;
      if (key.kind === "escape") {
        if (
          this.stateValue === "active" &&
          !this.monitorFocused &&
          this.instance?.state === "active"
        ) {
          try {
            const consumed = this.instance.handleInput(
              this.instance.epoch,
              inputFromEditorKey(key),
            );
            if (consumed) continue;
          } catch (error) {
            this.report(error);
            this.suspend("attention");
            return;
          }
        }
        this.close();
        return;
      }
      if (key.kind === "ctrl" && key.char === "c") {
        this.close();
        return;
      }
      if (key.kind === "ctrl" && key.char === "t") {
        this.close();
        return;
      }
      if (key.kind === "ctrl" && key.char === "p" && this.options.host.activities().length > 1) {
        if (this.stateValue === "picker") this.returnFromPicker();
        else this.openPicker();
        continue;
      }
      if (key.kind === "tab" || key.kind === "shift-tab") {
        if (
          this.monitorFocused &&
          key.kind === "tab" &&
          this.options.handleAgentInput?.(encodedKey)
        ) {
          continue;
        }
        this.setAgentFocused(!this.monitorFocused);
        this.options.invalidate();
        continue;
      }
      if (this.stateValue === "suspended") {
        if (key.kind === "char" && key.char.toLowerCase() === "r") this.resume();
        continue;
      }
      if (this.monitorFocused) {
        this.options.handleAgentInput?.(encodedKey);
        this.options.invalidate();
        continue;
      }
      if (this.stateValue === "picker") {
        const activities = this.options.host.activities();
        if (key.kind === "down" || (key.kind === "char" && key.char.toLowerCase() === "j")) {
          this.pickerIndex = (this.pickerIndex + 1) % activities.length;
        } else if (key.kind === "up" || (key.kind === "char" && key.char.toLowerCase() === "k")) {
          this.pickerIndex = (this.pickerIndex - 1 + activities.length) % activities.length;
        } else if (key.kind === "enter") {
          const selected = activities[this.pickerIndex];
          if (selected?.id === this.activityId && this.instance?.state === "paused") {
            this.returnFromPicker();
          } else if (selected !== undefined) this.open(selected.id);
        }
        this.options.invalidate();
        continue;
      }
      if (!this.monitorFocused && this.instance?.state === "active") {
        try {
          this.instance.handleInput(this.instance.epoch, inputFromEditorKey(key));
        } catch (error) {
          this.report(error);
          this.suspend("attention");
        }
      }
    }
  }

  render(
    width: number,
    height: number,
  ): {
    readonly lines: readonly string[];
    readonly cursor?: { readonly row: number; readonly column: number; readonly visible?: boolean };
  } {
    this.pointerLayout = undefined;
    this.preparedRasters = [];
    if (!this.visible) return { lines: [] };
    const palette = this.options.palette();
    const monitor = this.options.monitor();
    if (width < MIN_WIDTH || height < MIN_HEIGHT) {
      if (this.instance?.state === "active") this.suspend("unsupported-size");
      return {
        lines: [
          palette.accent(fit("Axl Lounge · terminal too small", width)),
          (palette.warning ?? palette.accent)(
            fit(`Need at least 40×12 · current ${width}×${height}`, width),
          ),
          palette.dim(fit(operationLabel(monitor.status), width)),
          palette.dim(fit("Esc return", width)),
        ],
      };
    }
    const wide = width >= 100 && height >= 18;
    if (this.stateValue === "picker") {
      if (wide) return this.renderWidePicker(width, height, monitor);
      if (this.monitorFocused) {
        const footerText = "Esc close · Tab library · Enter send · Ctrl+P return";
        this.pointerLayout = { kind: "agent", width, height, footer: footerText };
        const agent = this.renderAgentPane(monitor, width, height - 1, palette);
        return {
          lines: [...agent.lines, palette.dim(fit(footerText, width))],
          ...(agent.cursor === undefined ? {} : { cursor: agent.cursor }),
        };
      }
      const footerText =
        this.instance === undefined
          ? "↑↓ choose · Enter open · Esc close"
          : "↑↓ choose · Enter open · Ctrl+P current · Esc close";
      this.pointerLayout = {
        kind: "picker",
        width,
        height,
        wide: false,
        agentWidth: 0,
        pickerLeft: 0,
        pickerWidth: width,
        footer: footerText,
      };
      return { lines: this.renderPicker(width, height, monitor) };
    }
    if (this.stateValue === "suspended") {
      return {
        lines: [
          palette.accent(fit(`Axl Lounge · ${this.activityId ?? "activity"} paused`, width)),
          ...(this.completionNotice === undefined
            ? [palette.dim(fit(operationLabel(monitor.status), width))]
            : [(palette.success ?? palette.accent)(fit(this.completionNotice, width))]),
          fit("R resume · Ctrl+T transcript · Esc return", width),
        ],
      };
    }
    const instance = this.instance;
    if (instance === undefined) return { lines: [] };
    const activity = this.options.host
      .activities()
      .find((candidate) => candidate.id === this.activityId);
    const activityName = activity?.name ?? this.activityId ?? "Activity";
    const gameWidth = wide ? Math.max(40, Math.min(64, Math.round(width * 0.45))) : width;
    const agentWidth = wide ? width - gameWidth - 3 : width;
    const completion = this.completionNotice;
    const minimum = activity?.minimumViewport;
    const baseGameHeight = Math.max(1, height - 2);
    const completionRows =
      !wide &&
      completion !== undefined &&
      !this.monitorFocused &&
      baseGameHeight > (minimum?.height ?? 0)
        ? 1
        : 0;
    const gameHeight = Math.max(1, baseGameHeight - completionRows);
    if (minimum !== undefined && (gameWidth < minimum.width || baseGameHeight < minimum.height)) {
      if (instance.state === "active") this.suspend("unsupported-size");
      return {
        lines: [
          palette.accent(fit(`Axl Lounge · ${activityName}`, width)),
          (palette.warning ?? palette.accent)(
            fit(
              `Activity needs ${minimum.width}×${minimum.height} · available ${gameWidth}×${gameHeight}`,
              width,
            ),
          ),
          palette.dim(fit(operationLabel(monitor.status), width)),
          palette.dim(fit("R resume when resized · Esc return", width)),
        ],
      };
    }
    let frame = this.lastFrame;
    if (instance.state === "active") {
      try {
        frame = instance.render(instance.epoch, { width: gameWidth, height: gameHeight });
        this.lastFrame = frame;
      } catch (error) {
        this.report(error);
        this.suspend("attention");
        return {
          lines: [
            palette.error(fit("Activity rendering failed", width)),
            palette.dim(fit("Esc return", width)),
          ],
        };
      }
    }
    const effectiveFrame: ActivityFrame = frame ?? { lines: [] };
    const renderedActivityRows = this.renderFrame(
      effectiveFrame,
      gameWidth,
      gameHeight,
      palette,
      this.options.presentation().textOnly,
    );
    const topPadding = Math.max(0, Math.floor((gameHeight - renderedActivityRows.length) / 2));
    const activityRows = [
      ...Array.from({ length: topPadding }, () => fit("", gameWidth)),
      ...renderedActivityRows,
    ];
    while (activityRows.length < gameHeight) activityRows.push(fit("", gameWidth));
    const footerText = this.monitorFocused
      ? width < 60
        ? `Esc close · Tab ${this.options.agentTabHint?.() ?? "game"} · Enter send`
        : `Tab ${this.options.agentTabHint?.() ?? "game"} · Ctrl+O details · Ctrl+R history · Enter send · Ctrl+T exit`
      : width < 60
        ? "Esc close · Tab agent · Ctrl+P games"
        : "Tab agent · ? help · Ctrl+P menu · Ctrl+T transcript · Esc close";
    const footer = palette.dim(fit(footerText, width));
    if (wide) {
      this.pointerLayout = {
        kind: "activity",
        width,
        height,
        wide: true,
        agentWidth,
        gameLeft: agentWidth + 3,
        gameTop: 1 + topPadding,
        gameWidth,
        gameHeight,
        footer: footerText,
      };
      const agent = this.renderAgentPane(monitor, agentWidth, height - 1, palette);
      const agentRows = agent.lines;
      const gameTitle = `${this.monitorFocused ? " " : "▶"} ${activityName}`;
      const gameRows = [
        (this.monitorFocused ? palette.dim : palette.accent)(fit(gameTitle, gameWidth)),
        ...activityRows,
      ];
      const lines = [
        ...Array.from({ length: height - 1 }, (_, index) => {
          const agent = agentRows[index] ?? "";
          const game = gameRows[index] ?? "";
          return `${fit(agent, agentWidth)} ${palette.dim("│")} ${fit(game, gameWidth)}`;
        }),
        footer,
      ];
      this.appendRasterImages(lines, effectiveFrame, width, agentWidth + 3, 1 + topPadding);
      return {
        lines,
        ...(this.monitorFocused && agent.cursor !== undefined
          ? { cursor: agent.cursor }
          : effectiveFrame.cursor === undefined || this.monitorFocused
            ? {}
            : {
                cursor: {
                  ...effectiveFrame.cursor,
                  row: effectiveFrame.cursor.row + 1 + topPadding,
                  column: agentWidth + 3 + effectiveFrame.cursor.column,
                  visible: true,
                },
              }),
      };
    }
    if (this.monitorFocused) {
      this.pointerLayout = { kind: "agent", width, height, footer: footerText };
      const agent = this.renderAgentPane(monitor, width, height - 1, palette);
      return {
        lines: [...agent.lines, footer],
        ...(agent.cursor === undefined ? {} : { cursor: agent.cursor }),
      };
    }
    const inlineCompletion = completion !== undefined && completionRows === 0;
    const title = inlineCompletion
      ? "✓ Axl finished · Tab Agent · Ctrl+T exit game"
      : `▶ ${activityName} · ${this.compactStatus(monitor)}`;
    const completionBanner =
      completion === undefined || inlineCompletion
        ? []
        : [
            (palette.success ?? palette.accent)(
              fit("✓ Axl finished · Tab Agent · Ctrl+T exit game", width),
            ),
          ];
    const titleStyle = inlineCompletion ? (palette.success ?? palette.accent) : palette.accent;
    this.pointerLayout = {
      kind: "activity",
      width,
      height,
      wide: false,
      agentWidth: 0,
      gameLeft: 0,
      gameTop: 1 + completionRows + topPadding,
      gameWidth,
      gameHeight,
      footer: footerText,
    };
    const lines = [
      titleStyle(fit(title, width)),
      ...completionBanner,
      ...activityRows,
      footer,
    ].slice(0, height);
    this.appendRasterImages(lines, effectiveFrame, width, 0, 1 + completionRows + topPadding);
    return {
      lines,
      ...(effectiveFrame.cursor === undefined
        ? {}
        : {
            cursor: {
              ...effectiveFrame.cursor,
              row: effectiveFrame.cursor.row + 1 + completionRows + topPadding,
              visible: true,
            },
          }),
    };
  }

  private appendRasterImages(
    lines: string[],
    frame: ActivityFrame,
    width: number,
    gameLeft: number,
    gameTop: number,
  ): void {
    const cellPixels = this.options.terminalCellPixels?.();
    if (
      this.options.presentation().textOnly ||
      this.options.rasterProtocol == null ||
      !validTerminalCellPixels(cellPixels) ||
      frame.images === undefined ||
      lines.length === 0
    )
      return;
    const prepared = frame.images.map((image) => prepareActivityRaster(image, cellPixels));
    this.preparedRasters = Object.freeze(prepared);
    const lastRow = lines.length - 1;
    let sequences = "";
    for (const raster of prepared) {
      const targetRow = gameTop + raster.row;
      sequences += activityRasterSequence(
        raster.image,
        lastRow - targetRow,
        gameLeft + raster.column,
        this.options.rasterProtocol,
      );
    }
    lines[lastRow] = `${fit(lines[lastRow] ?? "", width)}${sequences}`;
  }

  private renderFrame(
    frame: ActivityFrame,
    width: number,
    height: number,
    palette: Palette,
    textOnly: boolean,
  ): string[] {
    return frame.lines
      .slice(0, height)
      .map((line) =>
        truncateToWidth(line.map((span) => style(span, palette, textOnly)).join(""), width, ""),
      );
  }

  private renderWidePicker(
    width: number,
    height: number,
    monitor: ActivityMonitorSnapshot,
  ): {
    readonly lines: readonly string[];
    readonly cursor?: { readonly row: number; readonly column: number; readonly visible?: boolean };
  } {
    const palette = this.options.palette();
    const pickerWidth = Math.max(40, Math.min(64, Math.round(width * 0.45)));
    const agentWidth = width - pickerWidth - 3;
    const footerText =
      this.instance === undefined
        ? "↑↓ choose · Enter open · Esc close"
        : "↑↓ choose · Enter open · Ctrl+P current · Esc close";
    this.pointerLayout = {
      kind: "picker",
      width,
      height,
      wide: true,
      agentWidth,
      pickerLeft: agentWidth + 3,
      pickerWidth,
      footer: footerText,
    };
    const agent = this.renderAgentPane(monitor, agentWidth, height, palette);
    const picker = this.renderPicker(pickerWidth, height, monitor);
    while (picker.length < height) picker.splice(picker.length - 1, 0, fit("", pickerWidth));
    return {
      lines: Array.from({ length: height }, (_, index) => {
        const agentRow = agent.lines[index] ?? "";
        const pickerRow = picker[index] ?? "";
        return `${fit(agentRow, agentWidth)} ${palette.dim("│")} ${fit(pickerRow, pickerWidth)}`;
      }),
      ...(this.monitorFocused && agent.cursor !== undefined ? { cursor: agent.cursor } : {}),
    };
  }

  private renderPicker(width: number, height: number, monitor: ActivityMonitorSnapshot): string[] {
    const palette = this.options.palette();
    const activities = this.options.host.activities();
    const rows = activities.map((activity, index) => {
      const marker = index === this.pickerIndex ? ">" : " ";
      const current =
        activity.id === this.activityId && this.instance !== undefined ? " · current" : "";
      const text = `${marker} ${sanitizeTerminalText(activity.name)}${current} · ${sanitizeTerminalText(activity.description)}`;
      return index === this.pickerIndex
        ? (palette.selection ?? palette.accent)(truncateToWidth(text, width, "…"))
        : truncateToWidth(text, width, "…");
    });
    return [
      (this.monitorFocused ? palette.dim : palette.accent)(
        fit(`${this.monitorFocused ? " " : "▶"} Axl Lounge · Games`, width),
      ),
      ...rows.slice(0, Math.max(1, height - 4)),
      palette.dim(fit(operationLabel(monitor.status), width)),
      palette.dim(
        fit(
          this.instance === undefined
            ? "↑↓ choose · Enter open · Esc close"
            : "↑↓ choose · Enter open · Ctrl+P current · Esc close",
          width,
        ),
      ),
    ].slice(0, height);
  }

  private handleMouse(mouse: MouseInput): void {
    if (this.stateValue !== "active" && this.stateValue !== "picker") return;
    const layout = this.pointerLayout;
    if (layout === undefined || mouse.motion || mouse.wheel !== 0) return;
    const direction = mouse.button & 3;
    const button =
      direction === 0 ? "left" : direction === 1 ? "middle" : direction === 2 ? "right" : undefined;
    if (button === undefined) return;
    const phase = mouse.release ? "release" : "press";

    if (phase === "press" && mouse.row === layout.height - 1) {
      const footerColumn =
        layout.kind === "picker" && layout.wide ? mouse.column - layout.pickerLeft : mouse.column;
      if (footerColumn >= 0 && this.handleFooterClick(layout.footer, footerColumn)) return;
    }

    if (layout.kind === "agent") return;
    if (
      layout.wide &&
      mouse.column < (layout.kind === "activity" ? layout.gameLeft : layout.pickerLeft)
    ) {
      if (phase === "press" && button === "left") {
        this.setAgentFocused(true);
        this.options.invalidate();
      }
      return;
    }

    if (layout.kind === "picker") {
      if (phase !== "press" || button !== "left") return;
      const localColumn = mouse.column - layout.pickerLeft;
      const index = mouse.row - 1;
      const activities = this.options.host.activities();
      if (
        localColumn < 0 ||
        localColumn >= layout.pickerWidth ||
        index < 0 ||
        index >= activities.length
      )
        return;
      this.pickerIndex = index;
      const selected = activities[index];
      if (selected?.id === this.activityId && this.instance?.state === "paused")
        this.returnFromPicker();
      else if (selected !== undefined) this.open(selected.id);
      this.options.invalidate();
      return;
    }

    if (
      mouse.column < layout.gameLeft ||
      mouse.column >= layout.gameLeft + layout.gameWidth ||
      mouse.row < layout.gameTop ||
      mouse.row >= layout.gameTop + layout.gameHeight ||
      this.instance?.state !== "active"
    ) {
      return;
    }
    if (phase === "press" && button === "left") this.setAgentFocused(false);
    let row = mouse.row - layout.gameTop;
    let column = mouse.column - layout.gameLeft;
    for (const raster of this.preparedRasters) {
      const normalized = normalizeActivityRasterPointer(raster, row, column);
      if (normalized.kind === "margin") return;
      if (normalized.kind === "image") {
        row = normalized.row;
        column = normalized.column;
        break;
      }
    }
    try {
      this.instance.handleInput(this.instance.epoch, {
        type: "mouse",
        phase,
        button,
        row,
        column,
        ctrl: (mouse.button & 16) !== 0,
        alt: (mouse.button & 8) !== 0,
        shift: (mouse.button & 4) !== 0,
      });
    } catch (error) {
      this.report(error);
      this.suspend("attention");
    }
  }

  private handleFooterClick(footer: string, column: number): boolean {
    const contains = (label: string): boolean => {
      const start = footer.indexOf(label);
      return start >= 0 && column >= start && column < start + label.length;
    };
    if (contains("Esc close")) {
      this.close();
      return true;
    }
    if (contains("Tab agent")) {
      this.setAgentFocused(true);
      this.options.invalidate();
      return true;
    }
    if (contains("Tab game") || contains("Tab library")) {
      this.setAgentFocused(false);
      this.options.invalidate();
      return true;
    }
    if (contains("? help") && this.instance?.state === "active") {
      this.instance.handleInput(this.instance.epoch, {
        type: "key",
        key: "?",
        ctrl: false,
        alt: false,
        shift: false,
        repeat: false,
      });
      this.options.invalidate();
      return true;
    }
    if (contains("Ctrl+P menu") || contains("Ctrl+P games")) {
      this.openPicker();
      return true;
    }
    if (contains("Ctrl+P current")) {
      this.returnFromPicker();
      return true;
    }
    if (contains("Ctrl+T transcript") || contains("Ctrl+T exit")) {
      this.close();
      return true;
    }
    return false;
  }

  private updateMouseCapture(): void {
    const activitySupportsMouse = this.options.host
      .activities()
      .some((activity) => activity.id === this.activityId && activity.mouse === true);
    const enabled =
      this.stateValue === "picker" || (this.stateValue === "active" && activitySupportsMouse);
    if (enabled === this.mouseCaptureEnabled) return;
    this.mouseCaptureEnabled = enabled;
    this.options.setMouseCapture?.(enabled);
  }

  private returnFromPicker(): void {
    if (this.stateValue !== "picker" || this.instance?.state !== "paused") return;
    try {
      this.instance.resume(this.instance.epoch);
      this.stateValue = "active";
      this.updateMouseCapture();
      this.suspensionReason = undefined;
      this.monitorFocused = false;
      this.options.invalidate();
    } catch (error) {
      this.report(error);
    }
  }

  private setAgentFocused(focused: boolean): void {
    if (this.monitorFocused === focused) return;
    this.monitorFocused = focused;
    if (this.stateValue !== "active" || this.instance?.state !== "active") return;
    try {
      this.instance.handleInput(this.instance.epoch, { type: "focus", focused: !focused });
    } catch (error) {
      this.report(error);
      this.suspend("attention");
    }
  }

  private compactStatus(monitor: ActivityMonitorSnapshot): string {
    const queued = monitor.status.queuedInput;
    const queueCount = queued.steer + queued.followUp + queued.interrupt;
    return [
      `Axl ${operationLabel(monitor.status)}`,
      monitor.current?.label,
      monitor.status.activeToolCount > 1 ? `${monitor.status.activeToolCount} tools` : undefined,
      queueCount > 0 ? `${queueCount} queued` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" · ");
  }

  private renderAgentPane(
    monitor: ActivityMonitorSnapshot,
    width: number,
    height: number,
    palette: Palette,
  ): ActivityAgentFrame {
    const title = `${this.monitorFocused ? "▶" : " "} Agent ${operationLabel(monitor.status)}`;
    const completionBanner =
      this.completionNotice === undefined
        ? []
        : [
            (palette.success ?? palette.accent)(fit("╭─ ✓ Axl finished", width)),
            (palette.success ?? palette.accent)(
              fit("╰─ Keep prompting · Ctrl+T leave Wordle", width),
            ),
          ];
    const bodyHeight = Math.max(0, height - 1 - completionBanner.length);
    const body = this.options.agentFrame?.(width, bodyHeight, this.monitorFocused) ?? {
      lines: monitor.recent.map(({ label }) => fit(sanitizeTerminalText(label), width)),
    };
    const lines = [
      (this.monitorFocused ? palette.accent : palette.dim)(fit(`${title} · live`, width)),
      ...completionBanner,
      ...body.lines.slice(0, bodyHeight),
    ];
    while (lines.length < height) lines.push(fit("", width));
    return {
      lines: lines.slice(0, height),
      ...(body.cursor === undefined
        ? {}
        : {
            cursor: {
              ...body.cursor,
              row: body.cursor.row + 1 + completionBanner.length,
            },
          }),
    };
  }

  private async disposeInstance(): Promise<void> {
    const instance = this.instance;
    this.instance = undefined;
    this.lastFrame = undefined;
    if (instance !== undefined) await instance.dispose();
  }

  private captureSnapshot(): void {
    if (this.instance === undefined || this.instance.state === "disposed") return;
    try {
      this.snapshotValue = this.instance.serialize(this.instance.epoch);
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    this.options.reportError(error instanceof Error ? error : new Error(String(error)));
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("Activity surface is disposed");
  }
}
