// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ProviderEnv = Readonly<Record<string, string>>;

/** Stored api-key credential. `env` holds provider-scoped config such as endpoint IDs. */
export interface ApiKeyCredential {
  readonly type: "api_key";
  readonly key?: string;
  readonly env?: ProviderEnv;
}

export interface OAuthCredential {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  /** Access-token expiry as epoch milliseconds. */
  readonly expiresAt: number;
}

export type Credential = ApiKeyCredential | OAuthCredential;

/** Non-secret metadata for status enumeration. */
export interface CredentialInfo {
  readonly providerId: string;
  readonly type: Credential["type"];
}

export class CredentialStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialStoreError";
  }
}

/**
 * Credential storage keyed by provider ID, one credential per provider, held
 * apart from provider and session configuration. `modify` is the only write
 * path: a serialized read-modify-write, so a refresh and a concurrent login
 * cannot clobber each other and tokens are never double-refreshed.
 */
export interface CredentialStore {
  /** Read the stored credential, possibly expired. Display and resolution use. */
  read(providerId: string): Promise<Credential | undefined>;
  /** List metadata without exposing secret values. */
  list(): Promise<readonly CredentialInfo[]>;
  /**
   * Serialized write. `fn` sees the current credential; return the replacement,
   * or undefined to leave the entry unchanged. Resolves with the stored
   * post-write credential. Rejections from `fn` propagate and write nothing.
   */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined>;
  /** Remove a credential (logout). Serialized against `modify`. */
  delete(providerId: string): Promise<void>;
}

/** The secret values inside a credential, for event-log redaction registration. */
export function credentialSecretValues(credential: Credential): readonly string[] {
  if (credential.type === "api_key") return credential.key === undefined ? [] : [credential.key];
  return [credential.access, credential.refresh];
}

function parseCredential(value: unknown, providerId: string): Credential {
  const fail = (message: string): never => {
    throw new CredentialStoreError(`Stored credential for ${providerId} ${message}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("must be an object");
  const credential = value as Record<string, unknown>;
  const allowed =
    credential.type === "api_key"
      ? new Set(["type", "key", "env"])
      : credential.type === "oauth"
        ? new Set(["type", "access", "refresh", "expiresAt"])
        : undefined;
  if (allowed === undefined) return fail("has an unknown type");
  for (const key of Object.keys(credential)) {
    if (!allowed.has(key)) fail(`has an unknown field ${JSON.stringify(key)}`);
  }

  if (credential.type === "api_key") {
    if (
      credential.key !== undefined &&
      (typeof credential.key !== "string" || credential.key.length === 0)
    ) {
      fail("has an invalid key");
    }
    if (credential.env !== undefined) {
      if (
        typeof credential.env !== "object" ||
        credential.env === null ||
        Array.isArray(credential.env) ||
        Object.getPrototypeOf(credential.env) !== Object.prototype
      ) {
        fail("has a non-object env");
      }
      for (const item of Object.values(credential.env as Record<string, unknown>)) {
        if (typeof item !== "string") fail("has a non-string env value");
      }
    }
    return credential as unknown as ApiKeyCredential;
  }
  if (
    typeof credential.access !== "string" ||
    credential.access.length === 0 ||
    typeof credential.refresh !== "string" ||
    credential.refresh.length === 0
  ) {
    fail("is missing oauth token strings");
  }
  if (!Number.isSafeInteger(credential.expiresAt) || (credential.expiresAt as number) < 0) {
    fail("has an invalid expiresAt");
  }
  return credential as unknown as OAuthCredential;
}

/** In-memory store for tests and ephemeral sessions. */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>();
  private tail: Promise<unknown> = Promise.resolve();

  private enqueue<Result>(task: () => Promise<Result>): Promise<Result> {
    const queued = this.tail.then(task, task);
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  read(providerId: string): Promise<Credential | undefined> {
    return Promise.resolve(this.credentials.get(providerId));
  }

  list(): Promise<readonly CredentialInfo[]> {
    return Promise.resolve(
      [...this.credentials].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      })),
    );
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const current = this.credentials.get(providerId);
      const next = await fn(current);
      if (next !== undefined) this.credentials.set(providerId, next);
      return next ?? current;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(async () => {
      this.credentials.delete(providerId);
    });
  }
}

const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * File-backed store: one JSON object keyed by provider ID. The directory is
 * created 0700 and the file written 0600 via atomic temp-file rename. A
 * cross-process `.lock` file (O_EXCL, stale after 10s) serializes writers;
 * in-process operations are additionally serialized per store instance.
 */
export class FileCredentialStore implements CredentialStore {
  readonly path: string;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  read(providerId: string): Promise<Credential | undefined> {
    return this.enqueue(async () => (await this.load())[providerId]);
  }

  list(): Promise<readonly CredentialInfo[]> {
    return this.enqueue(async () =>
      Object.entries(await this.load()).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      })),
    );
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(() =>
      this.withFileLock(async () => {
        const data = await this.load();
        const current = data[providerId];
        const next = await fn(current);
        if (next === undefined) return current;
        await this.persist({ ...data, [providerId]: next });
        return next;
      }),
    );
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(() =>
      this.withFileLock(async () => {
        const data = await this.load();
        if (!(providerId in data)) return;
        const { [providerId]: _removed, ...remaining } = data;
        await this.persist(remaining);
      }),
    );
  }

  private enqueue<Result>(task: () => Promise<Result>): Promise<Result> {
    const queued = this.tail.then(task, task);
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async load(): Promise<Record<string, Credential>> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new CredentialStoreError(`Cannot read credential store ${this.path}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new CredentialStoreError(`Credential store ${this.path} is not valid JSON`, {
        cause: error,
      });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CredentialStoreError(`Credential store ${this.path} must contain a JSON object`);
    }
    const data: Record<string, Credential> = {};
    for (const [providerId, value] of Object.entries(parsed)) {
      data[providerId] = parseCredential(value, providerId);
    }
    return data;
  }

  private async persist(data: Record<string, Credential>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(data, null, "\t")}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async withFileLock<Result>(task: () => Promise<Result>): Promise<Result> {
    const lockPath = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${process.pid} ${Date.now()}\n`);
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new CredentialStoreError(`Cannot lock credential store ${this.path}`, {
            cause: error,
          });
        }
        if (await this.removeStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new CredentialStoreError(`Timed out locking credential store ${this.path}`);
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    try {
      return await task();
    } finally {
      await rm(lockPath, { force: true });
    }
  }

  private async removeStaleLock(lockPath: string): Promise<boolean> {
    try {
      const contents = await readFile(lockPath, "utf8");
      const [rawPid, rawTime] = contents.trim().split(" ");
      const pid = Number(rawPid);
      const lockedAt = Number(rawTime);
      if (
        !Number.isSafeInteger(pid) ||
        !Number.isFinite(lockedAt) ||
        Date.now() - lockedAt <= LOCK_STALE_MS
      ) {
        return false;
      }
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
      await rm(lockPath, { force: true });
      return true;
    } catch {
      // The lock vanished or cannot be inspected; acquisition will retry or time out.
    }
    return false;
  }
}
