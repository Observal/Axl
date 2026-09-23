// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { TerminalInputBuffer } from "./input-buffer.ts";

const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";
const FOCUS_ON = "\x1b[?1004h";
const FOCUS_OFF = "\x1b[?1004l";
const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
const KITTY_QUERY_AND_ENABLE = "\x1b[>1u\x1b[?u\x1b[c";
const CELL_SIZE_QUERY = "\x1b[16t";
const KITTY_KEYS_OFF = "\x1b[<u";
const MODIFY_OTHER_KEYS_ON = "\x1b[>4;2m";
const MODIFY_OTHER_KEYS_OFF = "\x1b[>4;0m";
const SHOW_CURSOR = "\x1b[?25h";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const RESET_STYLE = "\x1b[0m\x1b]8;;\x1b\\";
const KEYBOARD_NEGOTIATION_TIMEOUT_MS = 200;

export interface TerminalInput {
  readonly isTTY: boolean | undefined;
  readonly isRaw?: boolean;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  setRawMode?(mode: boolean): unknown;
}

export interface TerminalOutput {
  readonly isTTY: boolean | undefined;
  columns?: number;
  rows?: number;
  write(data: string): unknown;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

export class TerminalUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalUnavailableError";
  }
}

export function assertInteractiveTerminal(input: TerminalInput, output: TerminalOutput): void {
  if (input.isTTY !== true || output.isTTY !== true) {
    throw new TerminalUnavailableError(
      "Interactive mode requires TTY input and output; use a headless client for redirected streams",
    );
  }
}

export interface TerminalCellSize {
  readonly width: number;
  readonly height: number;
}

export interface TerminalSessionOptions {
  readonly input: TerminalInput;
  readonly output: TerminalOutput;
  readonly onInput: (sequence: string) => void;
  readonly onInputError: (error: Error) => void;
  readonly onResize: () => void;
  readonly onCellSize?: (size: TerminalCellSize | undefined) => void;
  readonly suspendProcess?: () => void;
  readonly keyboardNegotiationTimeoutMs?: number;
}

type KeyboardMode = "inactive" | "negotiating" | "kitty" | "modifyOtherKeys";

function kittyFlags(sequence: string): number | undefined {
  if (!sequence.startsWith("\x1b[")) return undefined;
  const match = /^\?(\d+)u$/.exec(sequence.slice(2));
  return match ? Number.parseInt(match[1] as string, 10) : undefined;
}

function isDeviceAttributes(sequence: string): boolean {
  if (!sequence.startsWith("\x1b[")) return false;
  return sequence === "\x1b[c" || /^\?[0-9;]*c$/.test(sequence.slice(2));
}

function terminalCellSize(sequence: string): TerminalCellSize | null | undefined {
  if (!sequence.startsWith("\x1b[6;") || !sequence.endsWith("t")) return undefined;
  const match = /^6;(\d+);(\d+)t$/.exec(sequence.slice(2));
  if (match === null) return null;
  const height = Number(match[1]);
  const width = Number(match[2]);
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    width > 4_096 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    height > 4_096
  )
    return null;
  return Object.freeze({ width, height });
}

/** Owns process-terminal modes, input buffering, and listeners for one interactive attachment. */
export class TerminalSession {
  private readonly options: TerminalSessionOptions;
  private readonly keyboardNegotiationTimeoutMs: number;
  private started = false;
  private previousRaw = false;
  private inputAttached = false;
  private resizeAttached = false;
  private pasteEnabled = false;
  private focusEnabled = false;
  private mouseCaptureRequested = false;
  private mouseCaptureEnabled = false;
  private keyboardMode: KeyboardMode = "inactive";
  private keyboardTimer: NodeJS.Timeout | undefined;
  private inputBuffer: TerminalInputBuffer | undefined;

  constructor(options: TerminalSessionOptions) {
    this.options = options;
    const timeout = options.keyboardNegotiationTimeoutMs ?? KEYBOARD_NEGOTIATION_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw new RangeError("keyboardNegotiationTimeoutMs must be a non-negative finite number");
    }
    this.keyboardNegotiationTimeoutMs = timeout;
  }

  start(): void {
    if (this.started) return;
    assertInteractiveTerminal(this.options.input, this.options.output);

    this.previousRaw = this.options.input.isRaw ?? false;
    this.inputBuffer = new TerminalInputBuffer({
      onSequence: (sequence) => this.handleSequence(sequence),
      onError: this.options.onInputError,
    });
    try {
      this.options.input.setRawMode?.(true);
      this.pasteEnabled = true;
      this.focusEnabled = true;
      this.keyboardMode = "negotiating";
      this.inputAttached = true;
      this.options.input.on("data", this.inputListener);
      this.resizeAttached = true;
      this.options.output.on("resize", this.resizeListener);
      this.options.onCellSize?.(undefined);
      this.options.output.write(
        `${PASTE_ON}${FOCUS_ON}${KITTY_QUERY_AND_ENABLE}${CELL_SIZE_QUERY}${this.mouseCaptureRequested ? MOUSE_ON : ""}`,
      );
      this.mouseCaptureEnabled = this.mouseCaptureRequested;
      this.scheduleKeyboardFallback();
      this.started = true;
    } catch (error) {
      try {
        this.restore();
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Terminal startup and restoration both failed",
        );
      }
      throw error;
    }
  }

  stop(): void {
    if (
      !this.started &&
      !this.inputAttached &&
      !this.resizeAttached &&
      !this.pasteEnabled &&
      !this.focusEnabled &&
      this.keyboardMode === "inactive" &&
      !this.mouseCaptureEnabled
    ) {
      return;
    }
    this.restore();
  }

  setMouseCapture(enabled: boolean): void {
    this.mouseCaptureRequested = enabled;
    if (!this.started || enabled === this.mouseCaptureEnabled) return;
    this.options.output.write(enabled ? MOUSE_ON : MOUSE_OFF);
    this.mouseCaptureEnabled = enabled;
  }

  refreshMouseCapture(): void {
    if (!this.started) return;
    this.options.output.write(this.mouseCaptureRequested ? MOUSE_ON : MOUSE_OFF);
    this.mouseCaptureEnabled = this.mouseCaptureRequested;
  }

  suspend(): void {
    if (!this.started) throw new Error("Cannot suspend an inactive terminal session");
    if (process.platform === "win32" && this.options.suspendProcess === undefined) {
      throw new TerminalUnavailableError("Terminal suspension is unavailable on Windows");
    }

    this.stop();
    let suspendFailure: unknown;
    try {
      (this.options.suspendProcess ?? (() => process.kill(process.pid, "SIGTSTP")))();
    } catch (error) {
      suspendFailure = error;
    }

    try {
      this.start();
    } catch (resumeFailure) {
      if (suspendFailure !== undefined) {
        throw new AggregateError(
          [suspendFailure, resumeFailure],
          "Terminal suspension and resume both failed",
        );
      }
      throw resumeFailure;
    }
    if (suspendFailure !== undefined) throw suspendFailure;
  }

  private readonly inputListener = (chunk: Buffer | string): void => {
    try {
      this.inputBuffer?.push(chunk);
    } catch (error) {
      this.reportInputError(error);
    }
  };

  private readonly resizeListener = (): void => {
    this.options.onCellSize?.(undefined);
    try {
      this.options.output.write(CELL_SIZE_QUERY);
    } catch (error) {
      this.reportInputError(error);
    }
    this.options.onResize();
  };

  private handleSequence(sequence: string): void {
    const size = terminalCellSize(sequence);
    if (size !== undefined) {
      this.options.onCellSize?.(size ?? undefined);
      return;
    }
    const flags = kittyFlags(sequence);
    if (flags !== undefined) {
      this.clearKeyboardTimer();
      if (flags > 0) {
        if (this.keyboardMode === "modifyOtherKeys")
          this.options.output.write(MODIFY_OTHER_KEYS_OFF);
        this.keyboardMode = "kitty";
      } else {
        this.enableModifyOtherKeys();
      }
      return;
    }
    if (isDeviceAttributes(sequence)) {
      if (this.keyboardMode === "negotiating") this.enableModifyOtherKeys();
      return;
    }
    this.options.onInput(sequence);
  }

  private scheduleKeyboardFallback(): void {
    this.clearKeyboardTimer();
    this.keyboardTimer = setTimeout(() => {
      this.keyboardTimer = undefined;
      if (this.keyboardMode !== "negotiating") return;
      try {
        this.enableModifyOtherKeys();
      } catch (error) {
        this.reportInputError(error);
      }
    }, this.keyboardNegotiationTimeoutMs);
    this.keyboardTimer.unref?.();
  }

  private enableModifyOtherKeys(): void {
    this.clearKeyboardTimer();
    if (this.keyboardMode === "modifyOtherKeys") return;
    this.options.output.write(MODIFY_OTHER_KEYS_ON);
    this.keyboardMode = "modifyOtherKeys";
  }

  private clearKeyboardTimer(): void {
    if (this.keyboardTimer === undefined) return;
    clearTimeout(this.keyboardTimer);
    this.keyboardTimer = undefined;
  }

  private reportInputError(error: unknown): void {
    this.options.onInputError(
      error instanceof Error ? error : new Error("Terminal input failed with a non-Error value"),
    );
  }

  private restore(): void {
    const failures: unknown[] = [];
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };

    this.clearKeyboardTimer();
    this.inputBuffer?.dispose();
    this.inputBuffer = undefined;
    if (this.inputAttached) {
      attempt(() => this.options.input.off("data", this.inputListener));
      this.inputAttached = false;
    }
    if (this.resizeAttached) {
      attempt(() => this.options.output.off("resize", this.resizeListener));
      this.resizeAttached = false;
    }
    if (
      this.pasteEnabled ||
      this.focusEnabled ||
      this.mouseCaptureEnabled ||
      this.keyboardMode !== "inactive"
    ) {
      const keyboardOff =
        this.keyboardMode === "modifyOtherKeys" ? MODIFY_OTHER_KEYS_OFF : KITTY_KEYS_OFF;
      attempt(() => {
        this.options.output.write(
          `${PASTE_OFF}${FOCUS_OFF}${this.mouseCaptureEnabled ? MOUSE_OFF : ""}${keyboardOff}${RESET_STYLE}${ENABLE_AUTOWRAP}${SHOW_CURSOR}`,
        );
      });
      this.pasteEnabled = false;
      this.focusEnabled = false;
      this.mouseCaptureEnabled = false;
      this.keyboardMode = "inactive";
    }
    attempt(() => this.options.input.setRawMode?.(this.previousRaw));
    this.started = false;

    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to restore terminal state");
    }
  }
}
