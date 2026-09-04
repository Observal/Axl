// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

interface LockRecord {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly owner: "daemon" | "event_migration";
  readonly acquiredAt: number;
}

export class DataDirectoryLockedError extends Error {
  readonly owner: string;
  readonly pid: number;

  constructor(owner: string, pid: number) {
    super(`Axl data directory is locked by ${owner} process ${pid}`);
    this.name = "DataDirectoryLockedError";
    this.owner = owner;
    this.pid = pid;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseRecord(text: string): LockRecord {
  const value = JSON.parse(text) as Partial<LockRecord>;
  if (
    value.version !== 1 ||
    typeof value.token !== "string" ||
    !Number.isSafeInteger(value.pid) ||
    (value.owner !== "daemon" && value.owner !== "event_migration") ||
    !Number.isSafeInteger(value.acquiredAt)
  ) {
    throw new Error("Axl data-directory lock is corrupt");
  }
  return value as LockRecord;
}

export class DataDirectoryLock {
  private released = false;
  private readonly path: string;
  private readonly record: LockRecord;

  private constructor(path: string, record: LockRecord) {
    this.path = path;
    this.record = record;
  }

  static async acquire(
    dataDirectory: string,
    owner: LockRecord["owner"],
  ): Promise<DataDirectoryLock> {
    const directory = resolve(dataDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, ".axl-data.lock");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record: LockRecord = {
        version: 1,
        token: randomUUID(),
        pid: process.pid,
        owner,
        acquiredAt: Date.now(),
      };
      const candidatePath = `${path}.${record.token}.tmp`;
      try {
        const handle = await open(candidatePath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await link(candidatePath, path);
        await unlink(candidatePath);
        await syncDirectory(directory);
        return new DataDirectoryLock(path, record);
      } catch (error) {
        await rm(candidatePath, { force: true });
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existing: LockRecord;
        try {
          existing = parseRecord(await readFile(path, "utf8"));
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw readError;
        }
        if (isProcessAlive(existing.pid)) {
          throw new DataDirectoryLockedError(existing.owner, existing.pid);
        }
        const current = parseRecord(await readFile(path, "utf8"));
        if (current.token !== existing.token) {
          throw new DataDirectoryLockedError(current.owner, current.pid);
        }
        await unlink(path);
        await syncDirectory(directory);
      }
    }
    throw new Error("Could not acquire the Axl data-directory lock");
  }

  async release(options: { readonly allowMissing?: boolean } = {}): Promise<void> {
    if (this.released) return;
    let existing: LockRecord;
    try {
      existing = parseRecord(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing === true) {
        this.released = true;
        return;
      }
      throw error;
    }
    if (existing.token !== this.record.token) {
      throw new Error("Axl data-directory lock ownership changed");
    }
    await unlink(this.path);
    await syncDirectory(dirname(this.path));
    this.released = true;
  }
}
