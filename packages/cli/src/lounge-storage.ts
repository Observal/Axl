// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  ACTIVITY_LIMITS,
  ActivityStorageError,
  type ActivityStorageAdapter,
  type ActivityStorageScope,
  type ActivityStoredValue,
  type JsonValue,
} from "@axl/extension-api";

const DOCUMENT_VERSION = 1;
const SETTINGS_MAX_BYTES = 64 * 1024;
const STATE_MAX_BYTES = 5 * 1024 * 1024;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export interface LoungeSettings {
  readonly version: 1;
  readonly lastActivityId?: string;
  readonly reducedMotion: boolean;
  readonly textOnly: boolean;
}

export type LoungeSettingsUpdate = Partial<Omit<LoungeSettings, "version">>;

export const DEFAULT_LOUNGE_SETTINGS: LoungeSettings = Object.freeze({
  version: 1,
  reducedMotion: false,
  textOnly: false,
});

type StorageErrorCode = ActivityStorageError["code"];

interface StateDocument {
  readonly version: 1;
  readonly activities: Readonly<Record<string, ActivityStoredValue>>;
}

interface LockOwner {
  readonly pid: number;
  readonly createdAt: number;
  readonly token: string;
}

interface AcquiredLock {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

function fail(code: StorageErrorCode, message: string, cause?: unknown): never {
  throw new ActivityStorageError(code, message, cause === undefined ? undefined : { cause });
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function mapFilesystemError(error: unknown, action: string): never {
  if (error instanceof ActivityStorageError) throw error;
  const code = errno(error);
  if (["EACCES", "EPERM", "ELOOP"].includes(code ?? "")) {
    fail("permission", `Lounge storage permission denied while ${action}`, error);
  }
  fail("unavailable", `Lounge storage failed while ${action}`, error);
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("corrupt", `${label} must contain a JSON object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const keys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown !== undefined) fail("corrupt", `${label} contains unknown field ${unknown}`);
}

function parseVersion(value: Record<string, unknown>, label: string): void {
  if (typeof value.version === "number" && value.version > DOCUMENT_VERSION) {
    fail("future-version", `${label} uses future schema version ${value.version}`);
  }
  if (value.version !== DOCUMENT_VERSION) {
    fail("corrupt", `${label} must use schema version ${DOCUMENT_VERSION}`);
  }
}

function validateSettings(value: unknown, label: string): LoungeSettings {
  assertPlainObject(value, label);
  assertExactKeys(value, ["version", "lastActivityId", "reducedMotion", "textOnly"], label);
  parseVersion(value, label);
  for (const key of ["reducedMotion", "textOnly"] as const) {
    if (typeof value[key] !== "boolean") fail("corrupt", `${label}.${key} must be a boolean`);
  }
  if (
    value.lastActivityId !== undefined &&
    (typeof value.lastActivityId !== "string" || !IDENTIFIER.test(value.lastActivityId))
  ) {
    fail("corrupt", `${label}.lastActivityId is invalid`);
  }
  return Object.freeze({
    version: 1,
    reducedMotion: value.reducedMotion as boolean,
    textOnly: value.textOnly as boolean,
    ...(value.lastActivityId === undefined ? {} : { lastActivityId: value.lastActivityId }),
  });
}

function validateJson(
  value: unknown,
  label: string,
  code: "corrupt" | "invalid" = "corrupt",
  seen = new Set<object>(),
  depth = 0,
): JsonValue {
  if (depth > 128) fail(code, `${label} exceeds the JSON nesting limit`);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value as JsonValue;
  }
  if (typeof value !== "object" || value === null) fail(code, `${label} is not valid JSON`);
  if (seen.has(value)) fail(code, `${label} must not contain cycles`);
  seen.add(value);
  let checked: JsonValue;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) fail(code, `${label} must not contain sparse arrays`);
    }
    checked = value.map((item, index) =>
      validateJson(item, `${label}[${index}]`, code, seen, depth + 1),
    );
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(code, `${label} must contain only plain JSON objects`);
    }
    checked = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        validateJson(item, `${label}.${key}`, code, seen, depth + 1),
      ]),
    );
  }
  seen.delete(value);
  return checked;
}

function validateStoredValue(value: unknown, label: string): ActivityStoredValue {
  assertPlainObject(value, label);
  assertExactKeys(value, ["revision", "schemaVersion", "value"], label);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    fail("corrupt", `${label}.revision must be a positive integer`);
  }
  if (!Number.isSafeInteger(value.schemaVersion) || (value.schemaVersion as number) < 1) {
    fail("corrupt", `${label}.schemaVersion must be a positive integer`);
  }
  return Object.freeze({
    revision: value.revision as number,
    schemaVersion: value.schemaVersion as number,
    value: validateJson(value.value, `${label}.value`),
  });
}

function validateState(value: unknown, label: string): StateDocument {
  assertPlainObject(value, label);
  assertExactKeys(value, ["version", "activities"], label);
  parseVersion(value, label);
  assertPlainObject(value.activities, `${label}.activities`);
  const activities: Record<string, ActivityStoredValue> = {};
  for (const [key, stored] of Object.entries(value.activities)) {
    const [extensionId, activityId, extra] = key.split("/");
    if (
      extra !== undefined ||
      extensionId === undefined ||
      activityId === undefined ||
      !IDENTIFIER.test(extensionId) ||
      !IDENTIFIER.test(activityId)
    ) {
      fail("corrupt", `${label} contains invalid activity scope ${key}`);
    }
    activities[key] = validateStoredValue(stored, `${label}.activities.${key}`);
  }
  return Object.freeze({ version: 1, activities: Object.freeze(activities) });
}

function scopeKey(scope: ActivityStorageScope): string {
  if (!IDENTIFIER.test(scope.extensionId) || !IDENTIFIER.test(scope.activityId)) {
    fail("invalid", "Activity storage scope is invalid");
  }
  return `${scope.extensionId}/${scope.activityId}`;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) fail("aborted", "Lounge storage operation was aborted", signal.reason);
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  await new Promise<void>((resolvePromise, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new ActivityStorageError("aborted", "Lounge storage operation was aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** CLI-owned local persistence for client-local Lounge settings and activity state. */
export class LoungeStorage implements ActivityStorageAdapter {
  readonly directory: string;
  readonly settingsPath: string;
  readonly statePath: string;
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(directory: string) {
    this.directory = resolve(directory);
    this.settingsPath = resolve(this.directory, "settings.json");
    this.statePath = resolve(this.directory, "state.json");
  }

  async loadSettings(signal?: AbortSignal): Promise<LoungeSettings> {
    const value = await this.readDocument(this.settingsPath, SETTINGS_MAX_BYTES, signal);
    return value === undefined
      ? DEFAULT_LOUNGE_SETTINGS
      : validateSettings(value, this.settingsPath);
  }

  updateSettings(update: LoungeSettingsUpdate, signal?: AbortSignal): Promise<LoungeSettings> {
    return this.enqueue(this.settingsPath, () =>
      this.withLock(this.settingsPath, signal, async () => {
        const current = await this.loadSettings(signal);
        const next = validateSettings({ ...current, ...update, version: 1 }, this.settingsPath);
        await this.writeDocument(this.settingsPath, next, SETTINGS_MAX_BYTES, signal);
        return next;
      }),
    );
  }

  read(scope: ActivityStorageScope, signal: AbortSignal): Promise<ActivityStoredValue | undefined> {
    const key = scopeKey(scope);
    return this.enqueue(this.statePath, async () => {
      const state = await this.loadState(signal);
      return state.activities[key];
    });
  }

  write(
    scope: ActivityStorageScope,
    expectedRevision: number | null,
    schemaVersion: number,
    value: JsonValue,
    signal: AbortSignal,
  ): Promise<ActivityStoredValue> {
    const key = scopeKey(scope);
    if (
      expectedRevision !== null &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    ) {
      fail("invalid", "Expected Lounge activity revision must be null or a positive integer");
    }
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
      fail("invalid", "Lounge activity schema version must be a positive integer");
    }
    const checkedValue = validateJson(value, `activity ${key}.value`, "invalid");
    if (Buffer.byteLength(JSON.stringify(checkedValue)) > ACTIVITY_LIMITS.maxStoredBytes) {
      fail("oversized", `Lounge activity ${key} exceeds ${ACTIVITY_LIMITS.maxStoredBytes} bytes`);
    }
    return this.enqueue(this.statePath, () =>
      this.withLock(this.statePath, signal, async () => {
        checkAbort(signal);
        const state = await this.loadState(signal);
        const current = state.activities[key];
        const actualRevision = current?.revision ?? null;
        if (actualRevision !== expectedRevision) {
          fail(
            "conflict",
            `Lounge activity revision conflict: expected ${String(expectedRevision)}, found ${String(actualRevision)}`,
          );
        }
        const stored = validateStoredValue(
          { revision: (actualRevision ?? 0) + 1, schemaVersion, value: checkedValue },
          `activity ${key}`,
        );
        const activities = { ...state.activities, [key]: stored };
        await this.writeState({ version: 1, activities }, signal);
        return stored;
      }),
    );
  }

  reset(scope: ActivityStorageScope, expectedRevision: number, signal: AbortSignal): Promise<void> {
    const key = scopeKey(scope);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      fail("invalid", "Expected Lounge activity revision must be a positive integer");
    }
    return this.enqueue(this.statePath, () =>
      this.withLock(this.statePath, signal, async () => {
        checkAbort(signal);
        const state = await this.loadState(signal);
        const actualRevision = state.activities[key]?.revision ?? null;
        if (actualRevision !== expectedRevision) {
          fail(
            "conflict",
            `Lounge activity revision conflict: expected ${expectedRevision}, found ${String(actualRevision)}`,
          );
        }
        const { [key]: _removed, ...activities } = state.activities;
        await this.writeState({ version: 1, activities }, signal);
      }),
    );
  }

  private async loadState(signal?: AbortSignal): Promise<StateDocument> {
    const value = await this.readDocument(this.statePath, STATE_MAX_BYTES, signal);
    return value === undefined
      ? Object.freeze({ version: 1, activities: Object.freeze({}) })
      : validateState(value, this.statePath);
  }

  private async writeState(state: StateDocument, signal?: AbortSignal): Promise<void> {
    const serialized = JSON.stringify(state);
    for (const [key, stored] of Object.entries(state.activities)) {
      const bytes = Buffer.byteLength(JSON.stringify(stored.value));
      if (bytes > ACTIVITY_LIMITS.maxStoredBytes) {
        fail("oversized", `Lounge activity ${key} exceeds ${ACTIVITY_LIMITS.maxStoredBytes} bytes`);
      }
    }
    if (Buffer.byteLength(serialized) > STATE_MAX_BYTES) {
      fail("oversized", `Total Lounge state exceeds ${STATE_MAX_BYTES} bytes`);
    }
    await this.writeDocument(this.statePath, state, STATE_MAX_BYTES, signal);
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE });
      const metadata = await lstat(this.directory, { bigint: true });
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        fail("permission", `Lounge storage root ${this.directory} is not a private directory`);
      }
      if (process.getuid !== undefined && metadata.uid !== BigInt(process.getuid())) {
        fail(
          "permission",
          `Lounge storage root ${this.directory} is not owned by the current user`,
        );
      }
      if ((metadata.mode & 0o077n) !== 0n) {
        fail("permission", `Lounge storage root ${this.directory} must use owner-only permissions`);
      }
      if ((await realpath(this.directory)) !== this.directory) {
        fail(
          "permission",
          `Lounge storage root ${this.directory} must not traverse symbolic links`,
        );
      }
    } catch (error) {
      mapFilesystemError(error, `checking ${this.directory}`);
    }
  }

  private async openPrivateFile(path: string): Promise<FileHandle> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.nlink !== 1n) {
        fail("permission", `Lounge storage file ${path} is not a private regular file`);
      }
      if (process.getuid !== undefined && metadata.uid !== BigInt(process.getuid())) {
        fail("permission", `Lounge storage file ${path} is not owned by the current user`);
      }
      if ((metadata.mode & 0o177n) !== 0n) {
        fail("permission", `Lounge storage file ${path} must use owner-only permissions`);
      }
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (errno(error) === "ENOENT") throw error;
      mapFilesystemError(error, `opening ${path}`);
    }
  }

  private async readDocument(
    path: string,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<unknown | undefined> {
    checkAbort(signal);
    await this.ensureDirectory();
    let handle: FileHandle;
    try {
      handle = await this.openPrivateFile(path);
    } catch (error) {
      if (
        errno(error) === "ENOENT" ||
        (error as Error & { cause?: NodeJS.ErrnoException }).cause?.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (metadata.size > maximumBytes)
        fail("oversized", `Lounge storage file ${path} exceeds ${maximumBytes} bytes`);
      const buffer = Buffer.alloc(maximumBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maximumBytes)
        fail("oversized", `Lounge storage file ${path} exceeds ${maximumBytes} bytes`);
      checkAbort(signal);
      try {
        return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } catch (error) {
        fail("corrupt", `Lounge storage file ${path} is not valid JSON`, error);
      }
    } catch (error) {
      if (error instanceof ActivityStorageError) throw error;
      mapFilesystemError(error, `reading ${path}`);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async writeDocument(
    path: string,
    value: object,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<void> {
    checkAbort(signal);
    await this.ensureDirectory();
    const body = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(body) > maximumBytes) {
      fail("oversized", `Lounge storage file ${path} exceeds ${maximumBytes} bytes`);
    }
    const temporary = resolve(dirname(path), `.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
        FILE_MODE,
      );
      await handle.writeFile(body);
      await handle.sync();
      await handle.close();
      handle = undefined;
      checkAbort(signal);
      await rename(temporary, path);
      await this.flushDirectory();
    } catch (error) {
      if (error instanceof ActivityStorageError) throw error;
      mapFilesystemError(error, `writing ${path}`);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async flushDirectory(): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.directory, constants.O_RDONLY);
      await handle.sync();
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EBADF", "EISDIR"].includes(errno(error) ?? "")) {
        mapFilesystemError(error, `flushing ${this.directory}`);
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private enqueue<Result>(key: string, task: () => Promise<Result>): Promise<Result> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const queued = previous.then(task, task);
    const tail = queued.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return queued;
  }

  private async withLock<Result>(
    documentPath: string,
    signal: AbortSignal | undefined,
    task: () => Promise<Result>,
  ): Promise<Result> {
    await this.ensureDirectory();
    const lockPath = `${documentPath}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let acquired: AcquiredLock | undefined;
    for (;;) {
      checkAbort(signal);
      try {
        const handle = await open(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
          FILE_MODE,
        );
        try {
          const owner: LockOwner = { pid: process.pid, createdAt: Date.now(), token: randomUUID() };
          await handle.writeFile(`${JSON.stringify(owner)}\n`);
          await handle.sync();
          const metadata = await handle.stat({ bigint: true });
          acquired = { path: lockPath, device: metadata.dev, inode: metadata.ino };
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if (errno(error) !== "EEXIST") mapFilesystemError(error, `locking ${documentPath}`);
        if (await this.removeStaleLock(lockPath)) continue;
        if (Date.now() >= deadline)
          fail("locked", `Timed out locking Lounge storage file ${documentPath}`);
        await delay(LOCK_RETRY_MS, signal);
      }
    }
    try {
      checkAbort(signal);
      return await task();
    } finally {
      if (acquired !== undefined) await this.releaseLock(acquired);
    }
  }

  private async removeStaleLock(path: string): Promise<boolean> {
    let handle: FileHandle | undefined;
    try {
      handle = await this.openPrivateFile(path);
      const metadata = await handle.stat({ bigint: true });
      if (metadata.size > 4_096n) fail("locked", `Lounge storage lock ${path} is malformed`);
      const body = Buffer.alloc(Number(metadata.size));
      await handle.read(body, 0, body.length, 0);
      let owner: unknown;
      try {
        owner = JSON.parse(body.toString("utf8"));
      } catch (error) {
        fail("locked", `Lounge storage lock ${path} is malformed`, error);
      }
      assertPlainObject(owner, `Lounge storage lock ${path}`);
      if (
        !Number.isSafeInteger(owner.pid) ||
        typeof owner.createdAt !== "number" ||
        !Number.isFinite(owner.createdAt) ||
        typeof owner.token !== "string" ||
        owner.token.length === 0
      ) {
        fail("locked", `Lounge storage lock ${path} is malformed`);
      }
      if (Date.now() - owner.createdAt <= LOCK_STALE_MS) return false;
      try {
        process.kill(owner.pid as number, 0);
        return false;
      } catch (error) {
        if (errno(error) !== "ESRCH") return false;
      }
      const current = await lstat(path, { bigint: true });
      if (current.dev !== metadata.dev || current.ino !== metadata.ino) return false;
      await rm(path);
      return true;
    } catch (error) {
      if (errno(error) === "ENOENT") return true;
      if (error instanceof ActivityStorageError) throw error;
      mapFilesystemError(error, `recovering stale lock ${path}`);
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return false;
  }

  private async releaseLock(lock: AcquiredLock): Promise<void> {
    try {
      const current = await lstat(lock.path, { bigint: true });
      if (current.dev !== lock.device || current.ino !== lock.inode) {
        fail("locked", `Lounge storage lock ${lock.path} changed while held`);
      }
      await rm(lock.path);
    } catch (error) {
      if (error instanceof ActivityStorageError) throw error;
      mapFilesystemError(error, `releasing ${lock.path}`);
    }
  }
}
