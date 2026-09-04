// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { StringDecoder } from "node:string_decoder";

const ESCAPE = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
const DEFAULT_SSH_ESCAPE_TIMEOUT_MS = 100;
const DEFAULT_SEQUENCE_TIMEOUT_MS = 50;
const DEFAULT_PASTE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_SEQUENCE_BYTES = 64 * 1024;
const DEFAULT_MAX_PASTE_BYTES = 10 * 1024 * 1024;

type SequenceState =
  | { readonly kind: "complete"; readonly length: number }
  | { readonly kind: "incomplete" };

export interface TerminalInputBufferOptions {
  readonly onSequence: (sequence: string) => void;
  readonly onError: (error: Error) => void;
  readonly escapeTimeoutMs?: number;
  readonly sequenceTimeoutMs?: number;
  readonly pasteTimeoutMs?: number;
  readonly maxSequenceBytes?: number;
  readonly maxPasteBytes?: number;
}

function duration(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function byteLimit(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export function terminalEscapeTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AXL_TUI_ESCAPE_TIMEOUT_MS;
  if (raw !== undefined) return duration("AXL_TUI_ESCAPE_TIMEOUT_MS", Number(raw), 0);
  return env.SSH_CONNECTION || env.SSH_TTY
    ? DEFAULT_SSH_ESCAPE_TIMEOUT_MS
    : DEFAULT_ESCAPE_TIMEOUT_MS;
}

function stringTerminatedLength(value: string, allowBell: boolean): SequenceState {
  for (let index = 2; index < value.length; index += 1) {
    if (allowBell && value[index] === "\x07") return { kind: "complete", length: index + 1 };
    if (value[index] === ESCAPE && value[index + 1] === "\\") {
      return { kind: "complete", length: index + 2 };
    }
  }
  return { kind: "incomplete" };
}

function csiLength(value: string): SequenceState {
  if (value.length < 3) return { kind: "incomplete" };
  if (value.startsWith("\x1b[M")) {
    return value.length >= 6 ? { kind: "complete", length: 6 } : { kind: "incomplete" };
  }
  for (let index = 2; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return { kind: "complete", length: index + 1 };
  }
  return { kind: "incomplete" };
}

function nextSequence(value: string): SequenceState {
  if (!value.startsWith(ESCAPE)) {
    const nextEscape = value.indexOf(ESCAPE);
    return { kind: "complete", length: nextEscape < 0 ? value.length : nextEscape };
  }
  if (value.length === 1) return { kind: "incomplete" };
  if (value.startsWith(PASTE_START)) {
    const end = value.indexOf(PASTE_END, PASTE_START.length);
    return end < 0 ? { kind: "incomplete" } : { kind: "complete", length: end + PASTE_END.length };
  }

  const introducer = value[1];
  if (introducer === "[") return csiLength(value);
  if (introducer === "]") return stringTerminatedLength(value, true);
  if (introducer === "P" || introducer === "_") {
    return stringTerminatedLength(value, false);
  }
  if (introducer === "O") {
    return value.length >= 3 ? { kind: "complete", length: 3 } : { kind: "incomplete" };
  }
  if (introducer === ESCAPE) return { kind: "complete", length: 1 };

  const code = value.codePointAt(1);
  return {
    kind: "complete",
    length: 1 + (code !== undefined && code > 0xffff ? 2 : 1),
  };
}

/** Reassembles terminal sequences that may be split across stdin chunks. */
export class TerminalInputBuffer {
  private readonly options: TerminalInputBufferOptions;
  private readonly escapeTimeoutMs: number;
  private readonly sequenceTimeoutMs: number;
  private readonly pasteTimeoutMs: number;
  private readonly maxSequenceBytes: number;
  private readonly maxPasteBytes: number;
  private pending = "";
  private pendingBytes = 0;
  private decoder = new StringDecoder("utf8");
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(options: TerminalInputBufferOptions) {
    this.options = options;
    this.escapeTimeoutMs =
      options.escapeTimeoutMs === undefined
        ? terminalEscapeTimeout()
        : duration("escapeTimeoutMs", options.escapeTimeoutMs, 0);
    this.sequenceTimeoutMs = duration(
      "sequenceTimeoutMs",
      options.sequenceTimeoutMs,
      DEFAULT_SEQUENCE_TIMEOUT_MS,
    );
    this.pasteTimeoutMs = duration(
      "pasteTimeoutMs",
      options.pasteTimeoutMs,
      DEFAULT_PASTE_TIMEOUT_MS,
    );
    this.maxSequenceBytes = byteLimit(
      "maxSequenceBytes",
      options.maxSequenceBytes,
      DEFAULT_MAX_SEQUENCE_BYTES,
    );
    this.maxPasteBytes = byteLimit("maxPasteBytes", options.maxPasteBytes, DEFAULT_MAX_PASTE_BYTES);
  }

  push(chunk: Buffer | string): void {
    if (this.disposed) return;
    this.clearTimer();
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.pending += this.decoder.write(bytes);
    this.pendingBytes += bytes.byteLength;
    this.drain();
    if (this.pending.length === 0 && this.pendingBytes > 0) {
      this.scheduleFlush(this.sequenceTimeoutMs);
    }
  }

  flush(): void {
    if (this.disposed || (this.pending.length === 0 && this.pendingBytes === 0)) return;
    this.clearTimer();
    this.pending += this.decoder.end();
    this.decoder = new StringDecoder("utf8");
    if (this.pending === ESCAPE) {
      this.pending = "";
      this.pendingBytes = 0;
      this.options.onSequence(ESCAPE);
      return;
    }
    const bytes = this.pendingBytes;
    this.pending = "";
    this.pendingBytes = 0;
    this.options.onError(new Error(`Incomplete terminal input sequence (${bytes} bytes)`));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.decoder = new StringDecoder("utf8");
    this.pending = "";
    this.pendingBytes = 0;
  }

  private drain(): void {
    while (this.pending.length > 0) {
      const paste = this.pending.startsWith(PASTE_START);
      const limit = paste ? this.maxPasteBytes : this.maxSequenceBytes;
      if (this.pending.startsWith(ESCAPE) && this.pendingBytes > limit) {
        const kind = paste ? "paste" : "input sequence";
        const bytes = this.pendingBytes;
        this.pending = "";
        this.pendingBytes = 0;
        this.options.onError(
          new Error(`Terminal ${kind} exceeded the ${limit}-byte limit (${bytes} bytes)`),
        );
        return;
      }

      const state = nextSequence(this.pending);
      if (state.kind === "incomplete") {
        const delay =
          this.pending === ESCAPE
            ? this.escapeTimeoutMs
            : paste
              ? this.pasteTimeoutMs
              : this.sequenceTimeoutMs;
        this.scheduleFlush(delay);
        return;
      }
      const sequence = this.pending.slice(0, state.length);
      this.pending = this.pending.slice(state.length);
      this.pendingBytes -= Buffer.byteLength(sequence);
      this.options.onSequence(sequence);
    }
  }

  private scheduleFlush(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
