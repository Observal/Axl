// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { open, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  type CanonicalEvent,
  CanonicalEventSizeError,
  encodeCanonicalEvent,
  MAX_CANONICAL_EVENT_BYTES,
  type SessionId,
  parseEvent,
  parseSessionId,
  ProtocolValidationError,
} from "@axl/protocol";

import { redactEventForStorage } from "./redaction.ts";

export interface EventLogOptions {
  readonly secretValues?: readonly string[];
  /** Daemon-owned transformation available only when canonical encoding exceeds the limit. */
  readonly prepareOversizedEvent?: (
    event: CanonicalEvent,
  ) => CanonicalEvent | Promise<CanonicalEvent>;
}

export interface EventLogReadResult {
  readonly events: readonly CanonicalEvent[];
  readonly recoveredBytes: number;
}

export interface OpenEventLogResult extends EventLogReadResult {
  readonly log: JsonlEventLog;
}

export class EventLogCorruptionError extends Error {
  readonly logPath: string;
  readonly line: number;

  constructor(logPath: string, line: number, message: string, cause?: unknown) {
    super(`Corrupt event log ${JSON.stringify(logPath)} at line ${line}: ${message}`, {
      cause,
    });
    this.name = "EventLogCorruptionError";
    this.logPath = logPath;
    this.line = line;
  }
}

export class EventLogMigrationRequiredError extends Error {
  readonly sessionId: SessionId;
  readonly eventId: CanonicalEvent["id"];
  readonly eventType: CanonicalEvent["type"];
  readonly encodedBytes: number;
  readonly maximumBytes = MAX_CANONICAL_EVENT_BYTES;

  constructor(event: CanonicalEvent, encodedBytes: number) {
    super(
      `Session ${event.sessionId} contains oversized event ${event.id} (${event.type}): ${encodedBytes} bytes`,
    );
    this.name = "EventLogMigrationRequiredError";
    this.sessionId = event.sessionId;
    this.eventId = event.id;
    this.eventType = event.type;
    this.encodedBytes = encodedBytes;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureLogFile(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const existing = await open(path, "r+");
    await existing.close();
    return;
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }

  const created = await open(path, "wx+", 0o600);
  try {
    await created.sync();
  } finally {
    await created.close();
  }
  await syncDirectory(directory);
}

function decodeEventLine(
  path: string,
  lineNumber: number,
  line: Uint8Array,
  expectedSessionId: SessionId,
): CanonicalEvent {
  try {
    const oversized = line.byteLength > MAX_CANONICAL_EVENT_BYTES;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    const event = parseEvent(JSON.parse(text) as unknown);
    if (event.sessionId !== expectedSessionId) {
      throw new ProtocolValidationError(
        "event.sessionId",
        `must match log session ${expectedSessionId}`,
      );
    }
    if (oversized) throw new EventLogMigrationRequiredError(event, line.byteLength);
    return event;
  } catch (error) {
    if (error instanceof EventLogMigrationRequiredError) throw error;
    throw new EventLogCorruptionError(
      path,
      lineNumber,
      error instanceof Error ? error.message : "cannot be decoded",
      error,
    );
  }
}

async function truncateDurably(path: string, size: number): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.truncate(size);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface DecodedEventLog {
  readonly events: readonly CanonicalEvent[];
  readonly cleanByteLength: number;
}

/**
 * Decodes event-log bytes without touching the filesystem. Bytes after the
 * final newline are a torn tail and excluded from `cleanByteLength`; committed
 * lines that cannot be decoded throw `EventLogCorruptionError`. This pure
 * reader is the fuzz entry point for untrusted log input.
 */
export function decodeEventLogBytes(
  path: string,
  bytes: Uint8Array,
  expectedSessionId: SessionId,
): DecodedEventLog {
  const events: CanonicalEvent[] = [];
  let lineStart = 0;
  let lineNumber = 1;

  for (
    let newline = bytes.indexOf(0x0a);
    newline !== -1;
    newline = bytes.indexOf(0x0a, lineStart)
  ) {
    const line = bytes.subarray(lineStart, newline);
    events.push(decodeEventLine(path, lineNumber, line, expectedSessionId));
    lineStart = newline + 1;
    lineNumber += 1;
  }

  return { events, cleanByteLength: lineStart };
}

async function readAndRecover(
  path: string,
  expectedSessionId: SessionId,
): Promise<EventLogReadResult> {
  // ponytail: Phase 1 reads one file at startup; use a streaming scanner when measured log sizes require it.
  const bytes = await readFile(path);
  const { events, cleanByteLength } = decodeEventLogBytes(path, bytes, expectedSessionId);
  const recoveredBytes = bytes.byteLength - cleanByteLength;
  if (recoveredBytes > 0) await truncateDurably(path, cleanByteLength);
  return { events, recoveredBytes };
}

async function appendDurably(path: string, line: Uint8Array): Promise<void> {
  const handle = await open(path, "r+");
  try {
    const before = (await handle.stat()).size;
    try {
      let written = 0;
      while (written < line.byteLength) {
        const result = await handle.write(
          line,
          written,
          line.byteLength - written,
          before + written,
        );
        if (result.bytesWritten === 0) throw new Error("event log append wrote zero bytes");
        written += result.bytesWritten;
      }
      await handle.sync();
    } catch (error) {
      try {
        await handle.truncate(before);
        await handle.sync();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Failed to roll back event log append to ${JSON.stringify(path)}`,
        );
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}

export class JsonlEventLog {
  readonly path: string;
  readonly sessionId: SessionId;
  private readonly secretValues: readonly string[];
  private readonly prepareOversizedEvent:
    | ((event: CanonicalEvent) => CanonicalEvent | Promise<CanonicalEvent>)
    | undefined;
  private tail: Promise<void> = Promise.resolve();

  private constructor(path: string, sessionId: SessionId, options: EventLogOptions) {
    this.path = path;
    this.sessionId = sessionId;
    this.secretValues = [...(options.secretValues ?? [])];
    this.prepareOversizedEvent = options.prepareOversizedEvent;
  }

  static async open(
    path: string,
    sessionId: unknown,
    options: EventLogOptions = {},
  ): Promise<OpenEventLogResult> {
    const absolutePath = resolve(path);
    const parsedSessionId = parseSessionId(sessionId, "sessionId");
    await ensureLogFile(absolutePath);
    const log = new JsonlEventLog(absolutePath, parsedSessionId, options);
    const result = await log.read();
    return { log, ...result };
  }

  append(value: unknown): Promise<CanonicalEvent> {
    let redacted: CanonicalEvent;
    try {
      redacted = redactEventForStorage(value, this.secretValues);
      if (redacted.sessionId !== this.sessionId) {
        throw new ProtocolValidationError(
          "event.sessionId",
          `must match log session ${this.sessionId}`,
        );
      }
    } catch (error) {
      return Promise.reject(error);
    }

    return this.enqueue(async () => {
      let event = redacted;
      let encoded: Uint8Array;
      try {
        encoded = encodeCanonicalEvent(event);
      } catch (error) {
        if (
          !(error instanceof CanonicalEventSizeError) ||
          this.prepareOversizedEvent === undefined
        ) {
          throw error;
        }
        event = parseEvent(await this.prepareOversizedEvent(event));
        if (event.sessionId !== this.sessionId) {
          throw new ProtocolValidationError(
            "event.sessionId",
            `must match log session ${this.sessionId}`,
          );
        }
        encoded = encodeCanonicalEvent(event);
      }
      const line = Buffer.allocUnsafe(encoded.byteLength + 1);
      line.set(encoded);
      line[encoded.byteLength] = 0x0a;
      await appendDurably(this.path, line);
      return event;
    });
  }

  read(): Promise<EventLogReadResult> {
    return this.enqueue(() => readAndRecover(this.path, this.sessionId));
  }

  drain(): Promise<void> {
    return this.tail;
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
