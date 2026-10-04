// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * One daemon at a time serves remote access for an installation.
 *
 * Every daemon a user runs (`axl`, `axl --unsafe`, another sandbox) keeps its own state directory,
 * so each can hold its own pairing, but they share the installation and so its relay identity. Two
 * of them connected at once would replace each other's relay route over and over, and neither
 * phone would get through. The daemon serving remote access holds a claim file under the shared
 * Axl home; another daemon's `/remote` is refused with a reason, and its restore waits until the
 * claim is released or its owner has exited.
 */

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm, unlink } from "node:fs/promises";
import { dirname } from "node:path";

interface ClaimRecord {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly stateDirectory: string;
}

export interface RemoteAccessClaim {
  release(): Promise<void>;
}

/** Another daemon serves remote access for this installation. */
export class RemoteAccessBusyError extends Error {
  readonly code = "remote_busy";
  readonly pid: number;
  readonly stateDirectory: string;

  constructor(pid: number, stateDirectory: string) {
    super(
      `Remote access is in use by another Axl daemon (process ${pid}, state in ${stateDirectory}). Use /remote in that daemon's sessions, or stop it first.`,
    );
    this.name = "RemoteAccessBusyError";
    this.pid = pid;
    this.stateDirectory = stateDirectory;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readRecord(path: string): Promise<ClaimRecord | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  try {
    const value = JSON.parse(text) as Partial<ClaimRecord>;
    if (
      value.version === 1 &&
      typeof value.token === "string" &&
      Number.isSafeInteger(value.pid) &&
      typeof value.stateDirectory === "string"
    ) {
      return value as ClaimRecord;
    }
  } catch {
    // A torn or foreign file is treated like a claim whose owner is gone.
  }
  return { version: 1, token: "", pid: 0, stateDirectory: "" };
}

/**
 * Claim remote access at `path` for the daemon whose state is in `stateDirectory`. A claim left by
 * a process that has exited is taken over; a live one rejects with `RemoteAccessBusyError`.
 */
export async function claimRemoteAccess(
  path: string,
  stateDirectory: string,
): Promise<RemoteAccessClaim> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record: ClaimRecord = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      stateDirectory,
    };
    const candidate = `${path}.${record.token}.tmp`;
    try {
      const handle = await open(candidate, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      // link() fails if the claim exists, so exactly one daemon creates it.
      await link(candidate, path);
      return {
        async release() {
          const current = await readRecord(path).catch(() => undefined);
          if (current?.token === record.token) await unlink(path).catch(() => undefined);
        },
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const existing = await readRecord(path);
      if (existing === undefined) continue;
      if (existing.pid !== process.pid && existing.pid > 1 && alive(existing.pid)) {
        throw new RemoteAccessBusyError(existing.pid, existing.stateDirectory);
      }
      // Its owner exited, or it is this process's own leftover: remove it unless it changed.
      const current = await readRecord(path);
      if (current !== undefined && current.token === existing.token) {
        await unlink(path).catch(() => undefined);
      }
    } finally {
      await rm(candidate, { force: true });
    }
  }
  throw new Error("Could not claim remote access");
}
