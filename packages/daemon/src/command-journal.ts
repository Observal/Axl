// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { open, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  isRetryableMutationMethod,
  isRpcErrorRetryable,
  parseOperationId,
  parseRpcResult,
  parseSessionId,
  type JsonObject,
  type RetryableMutationMethod,
  type RpcResult,
  type SessionId,
} from "@axl/protocol";

export interface CommandFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
}

export interface CommandAcceptance {
  readonly version: 1;
  readonly type: "accepted";
  readonly idempotencyKey: string;
  readonly method: RetryableMutationMethod;
  readonly requestHash: string;
  readonly targetSessionId?: SessionId;
  readonly intendedSessionId?: SessionId;
  readonly affectedOperationId?: string;
  readonly interactionId?: string;
  readonly operationId: string;
  readonly acceptedAt: number;
}

type CommandCompletion =
  | {
      readonly version: 1;
      readonly type: "succeeded";
      readonly idempotencyKey: string;
      readonly result: unknown;
      readonly completedAt: number;
    }
  | {
      readonly version: 1;
      readonly type: "failed";
      readonly idempotencyKey: string;
      readonly error: CommandFailure;
      readonly completedAt: number;
    };

type CommandRecord = CommandAcceptance | CommandCompletion;

interface CommandEntry {
  readonly acceptance: CommandAcceptance;
  completion?: CommandCompletion;
  running?: Promise<unknown>;
}

export class CommandJournalError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: JsonObject | undefined;

  constructor(code: string, message: string, retryable = false, details?: JsonObject) {
    super(message);
    this.name = "CommandJournalError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, path: string, keys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${path}.${key} is not allowed`);
  }
}

function timestamp(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseFailure(value: unknown, path: string): CommandFailure {
  const error = object(value, path);
  exact(error, path, ["code", "message", "retryable", "details"]);
  if (typeof error.code !== "string" || error.code.length === 0) {
    throw new Error(`${path}.code must be a non-empty string`);
  }
  if (typeof error.message !== "string" || error.message.length === 0) {
    throw new Error(`${path}.message must be a non-empty string`);
  }
  if (typeof error.retryable !== "boolean") throw new Error(`${path}.retryable must be boolean`);
  if (
    error.details !== undefined &&
    (typeof error.details !== "object" || error.details === null || Array.isArray(error.details))
  ) {
    throw new Error(`${path}.details must be an object`);
  }
  return {
    code: error.code,
    message: error.message,
    // Retryability is code-defined. Reclassify persisted failures when the
    // protocol corrects a code's semantics instead of replaying stale metadata.
    retryable: isRpcErrorRetryable(error.code),
    ...(error.details === undefined ? {} : { details: error.details as JsonObject }),
  };
}

function parseRecord(value: unknown, line: number): CommandRecord {
  const path = `command journal line ${line}`;
  const record = object(value, path);
  if (record.version !== 1) throw new Error(`${path}.version must be 1`);
  const idempotencyKey = parseOperationId(record.idempotencyKey, `${path}.idempotencyKey`);
  if (record.type === "accepted") {
    exact(record, path, [
      "version",
      "type",
      "idempotencyKey",
      "method",
      "requestHash",
      "targetSessionId",
      "intendedSessionId",
      "affectedOperationId",
      "interactionId",
      "operationId",
      "acceptedAt",
    ]);
    if (typeof record.method !== "string" || !isRetryableMutationMethod(record.method as never)) {
      throw new Error(`${path}.method must be a retryable mutation`);
    }
    if (typeof record.requestHash !== "string" || !/^[0-9a-f]{64}$/.test(record.requestHash)) {
      throw new Error(`${path}.requestHash must be a lowercase SHA-256 digest`);
    }
    return {
      version: 1,
      type: "accepted",
      idempotencyKey,
      method: record.method as RetryableMutationMethod,
      requestHash: record.requestHash,
      ...(record.targetSessionId === undefined
        ? {}
        : { targetSessionId: parseSessionId(record.targetSessionId, `${path}.targetSessionId`) }),
      ...(record.intendedSessionId === undefined
        ? {}
        : {
            intendedSessionId: parseSessionId(
              record.intendedSessionId,
              `${path}.intendedSessionId`,
            ),
          }),
      ...(record.affectedOperationId === undefined
        ? {}
        : {
            affectedOperationId: parseOperationId(
              record.affectedOperationId,
              `${path}.affectedOperationId`,
            ),
          }),
      ...(record.interactionId === undefined
        ? {}
        : {
            interactionId:
              typeof record.interactionId === "string" && record.interactionId.length > 0
                ? record.interactionId
                : (() => {
                    throw new Error(`${path}.interactionId must be a non-empty string`);
                  })(),
          }),
      operationId: parseOperationId(record.operationId, `${path}.operationId`),
      acceptedAt: timestamp(record.acceptedAt, `${path}.acceptedAt`),
    };
  }
  if (record.type === "succeeded") {
    exact(record, path, ["version", "type", "idempotencyKey", "result", "completedAt"]);
    return {
      version: 1,
      type: "succeeded",
      idempotencyKey,
      result: record.result,
      completedAt: timestamp(record.completedAt, `${path}.completedAt`),
    };
  }
  if (record.type === "failed") {
    exact(record, path, ["version", "type", "idempotencyKey", "error", "completedAt"]);
    return {
      version: 1,
      type: "failed",
      idempotencyKey,
      error: parseFailure(record.error, `${path}.error`),
      completedAt: timestamp(record.completedAt, `${path}.completedAt`),
    };
  }
  throw new Error(`${path}.type is unknown`);
}

async function appendSynced(path: string, record: CommandRecord): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class CommandJournal {
  readonly path: string;
  private readonly entries = new Map<string, CommandEntry>();
  private tail: Promise<void> = Promise.resolve();

  private constructor(path: string) {
    this.path = path;
  }

  static async open(dataDirectory: string): Promise<CommandJournal> {
    const path = resolve(dataDirectory, "commands.jsonl");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, "a", 0o600);
    await handle.close();
    const journal = new CommandJournal(path);
    const bytes = await readFile(path);
    const finalNewline = bytes.lastIndexOf(0x0a);
    if (bytes.length > 0 && finalNewline !== bytes.length - 1) {
      const writable = await open(path, "r+");
      try {
        await writable.truncate(finalNewline + 1);
        await writable.sync();
      } finally {
        await writable.close();
      }
    }
    const text = bytes.subarray(0, finalNewline + 1).toString("utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (line.length === 0) continue;
      let record: CommandRecord;
      try {
        record = parseRecord(JSON.parse(line) as unknown, index + 1);
      } catch (cause) {
        throw new Error(`Corrupt command journal ${JSON.stringify(path)}`, { cause });
      }
      if (record.type === "accepted") {
        if (journal.entries.has(record.idempotencyKey)) {
          throw new Error(`Corrupt command journal: duplicate acceptance ${record.idempotencyKey}`);
        }
        journal.entries.set(record.idempotencyKey, { acceptance: record });
      } else {
        const entry = journal.entries.get(record.idempotencyKey);
        if (entry === undefined || entry.completion !== undefined) {
          throw new Error(`Corrupt command journal: unmatched completion ${record.idempotencyKey}`);
        }
        if (record.type === "succeeded") {
          parseRpcResult(entry.acceptance.method, record.result);
        }
        entry.completion = record;
      }
    }
    return journal;
  }

  async reconcile(
    recover: (
      acceptance: CommandAcceptance,
    ) => Promise<{ readonly result: unknown } | { readonly error: CommandFailure } | undefined>,
  ): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.completion !== undefined) continue;
      const recovered = await recover(entry.acceptance);
      if (recovered === undefined) continue;
      const terminal: CommandCompletion =
        "result" in recovered
          ? {
              version: 1,
              type: "succeeded",
              idempotencyKey: entry.acceptance.idempotencyKey,
              result: parseRpcResult(entry.acceptance.method, recovered.result),
              completedAt: Date.now(),
            }
          : {
              version: 1,
              type: "failed",
              idempotencyKey: entry.acceptance.idempotencyKey,
              error: recovered.error,
              completedAt: Date.now(),
            };
      await this.append(terminal);
      entry.completion = terminal;
    }
  }

  execute<Method extends RetryableMutationMethod>(
    input: {
      readonly idempotencyKey: string;
      readonly method: Method;
      readonly requestHash: string;
      readonly targetSessionId?: SessionId;
      readonly intendedSessionId?: SessionId;
      readonly affectedOperationId?: string;
      readonly interactionId?: string;
    },
    effect: (acceptance: CommandAcceptance) => Promise<RpcResult<Method>>,
  ): Promise<RpcResult<Method>> {
    return this.accept(input).then((entry) => {
      const completion = entry.completion;
      if (completion?.type === "succeeded") {
        return parseRpcResult(input.method, completion.result);
      }
      if (completion?.type === "failed") {
        throw new CommandJournalError(
          completion.error.code,
          completion.error.message,
          completion.error.retryable,
          completion.error.details,
        );
      }
      if (entry.running !== undefined) return entry.running as Promise<RpcResult<Method>>;
      const running = effect(entry.acceptance).then(
        async (result) => {
          const validated = parseRpcResult(input.method, result);
          const terminal: CommandCompletion = {
            version: 1,
            type: "succeeded",
            idempotencyKey: input.idempotencyKey,
            result: validated,
            completedAt: Date.now(),
          };
          await this.append(terminal);
          entry.completion = terminal;
          return validated;
        },
        async (cause: unknown) => {
          const code =
            cause instanceof Error && "code" in cause && typeof cause.code === "string"
              ? cause.code
              : "internal_error";
          const failure: CommandFailure = {
            code,
            message: cause instanceof Error ? cause.message : "Request failed",
            retryable: isRpcErrorRetryable(code),
            ...(cause instanceof Error &&
            "details" in cause &&
            typeof cause.details === "object" &&
            cause.details !== null &&
            !Array.isArray(cause.details)
              ? { details: cause.details as JsonObject }
              : {}),
          };
          const terminal: CommandCompletion = {
            version: 1,
            type: "failed",
            idempotencyKey: input.idempotencyKey,
            error: failure,
            completedAt: Date.now(),
          };
          await this.append(terminal);
          entry.completion = terminal;
          throw new CommandJournalError(
            failure.code,
            failure.message,
            failure.retryable,
            failure.details,
          );
        },
      );
      entry.running = running;
      void running.then(
        () => delete entry.running,
        () => delete entry.running,
      );
      return running;
    });
  }

  private accept(input: {
    readonly idempotencyKey: string;
    readonly method: RetryableMutationMethod;
    readonly requestHash: string;
    readonly targetSessionId?: SessionId;
    readonly intendedSessionId?: SessionId;
    readonly affectedOperationId?: string;
    readonly interactionId?: string;
  }): Promise<CommandEntry> {
    return this.enqueue(async () => {
      const existing = this.entries.get(input.idempotencyKey);
      if (existing !== undefined) {
        if (
          existing.acceptance.method !== input.method ||
          existing.acceptance.requestHash !== input.requestHash
        ) {
          throw new CommandJournalError(
            "idempotency_conflict",
            "The idempotency key is already bound to another request",
          );
        }
        return existing;
      }
      const acceptance: CommandAcceptance = {
        version: 1,
        type: "accepted",
        idempotencyKey: input.idempotencyKey,
        method: input.method,
        requestHash: input.requestHash,
        ...(input.targetSessionId === undefined ? {} : { targetSessionId: input.targetSessionId }),
        ...(input.intendedSessionId === undefined
          ? {}
          : { intendedSessionId: input.intendedSessionId }),
        ...(input.affectedOperationId === undefined
          ? {}
          : { affectedOperationId: input.affectedOperationId }),
        ...(input.interactionId === undefined ? {} : { interactionId: input.interactionId }),
        operationId: input.idempotencyKey,
        acceptedAt: Date.now(),
      };
      await appendSynced(this.path, acceptance);
      const entry = { acceptance };
      this.entries.set(input.idempotencyKey, entry);
      return entry;
    });
  }

  private append(record: CommandRecord): Promise<void> {
    return this.enqueue(() => appendSynced(this.path, record));
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
