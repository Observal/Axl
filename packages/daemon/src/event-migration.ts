// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { decodeEventLogBytes, SessionTree, verifyToolCallIntegrity } from "@axl/kernel";
import {
  type BlobReference,
  type CanonicalEvent,
  CanonicalEventSizeError,
  encodeCanonicalEvent,
  MAX_CANONICAL_EVENT_BYTES,
  parseEvent,
  parseEventId,
  parseSessionId,
  type SessionId,
} from "@axl/protocol";

import { DataDirectoryLock } from "./data-directory-lock.ts";

const MAX_MIGRATION_BLOB_BYTES = 20 * 1024 * 1024;

export interface EventMigrationManifest {
  readonly version: 1;
  readonly toolVersion: string;
  readonly sourceSessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly sourceSha256: string;
  readonly targetSha256: string;
  readonly eventIdMappings: Readonly<Record<string, string>>;
  readonly externalizedBlobDigests: readonly string[];
  readonly validation: {
    readonly parsed: true;
    readonly treeIntegrity: true;
    readonly blobDigests: true;
  };
  readonly recovery: "lossless" | "prefix_only";
  readonly omittedSuffix?: {
    readonly firstEventId: string;
    readonly eventCount: number;
  };
}

export class EventMigrationUnsupportedError extends Error {
  readonly sessionId: SessionId;
  readonly eventId: string;
  readonly eventType: string;
  readonly encodedBytes: number;
  readonly maximumBytes = MAX_CANONICAL_EVENT_BYTES;

  constructor(event: CanonicalEvent, encodedBytes: number) {
    super(
      `Event ${event.id} (${event.type}) cannot be losslessly externalized; rerun with --confirm-prefix to recover the preceding prefix`,
    );
    this.name = "EventMigrationUnsupportedError";
    this.sessionId = event.sessionId;
    this.eventId = event.id;
    this.eventType = event.type;
    this.encodedBytes = encodedBytes;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
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

function sessionLogPath(dataDirectory: string, sessionId: SessionId): string {
  return join(resolve(dataDirectory), "sessions", `${sessionId}.jsonl`);
}

function referencedBlobDigests(bytes: Uint8Array): ReadonlySet<string> {
  const digests = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  for (let newline = bytes.indexOf(0x0a); newline !== -1; newline = bytes.indexOf(0x0a, start)) {
    const root = JSON.parse(decoder.decode(bytes.subarray(start, newline))) as unknown;
    const pending: unknown[] = [root];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value !== "object" || value === null) continue;
      if (Array.isArray(value)) {
        pending.push(...value);
        continue;
      }
      const object = value as Record<string, unknown>;
      if (
        typeof object.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(object.sha256) &&
        typeof object.mediaType === "string" &&
        Number.isSafeInteger(object.sizeBytes)
      ) {
        digests.add(object.sha256);
      }
      pending.push(...Object.values(object));
    }
    start = newline + 1;
  }
  return digests;
}

export async function exportSessionRaw(input: {
  readonly dataDirectory: string;
  readonly sessionId: unknown;
  readonly outputDirectory: string;
}): Promise<{ readonly outputDirectory: string; readonly sourceSha256: string }> {
  const sessionId = parseSessionId(input.sessionId, "sessionId");
  const lock = await DataDirectoryLock.acquire(input.dataDirectory, "event_migration");
  const source = sessionLogPath(input.dataDirectory, sessionId);
  const output = resolve(input.outputDirectory);
  let created = false;
  try {
    await mkdir(output, { recursive: false, mode: 0o700 });
    created = true;
    const bytes = await readFile(source);
    await writeFile(join(output, `${sessionId}.jsonl`), bytes, { mode: 0o400, flag: "wx" });
    const sourceBlobs = join(resolve(input.dataDirectory), "blobs");
    const outputBlobs = join(output, "blobs");
    const digests = referencedBlobDigests(bytes);
    if (digests.size > 0) await mkdir(outputBlobs, { mode: 0o700 });
    for (const digest of digests) {
      const sourcePath = join(sourceBlobs, digest);
      const blob = await readFile(sourcePath);
      if (sha256(blob) !== digest) throw new Error(`Referenced blob ${digest} failed validation`);
      await copyFile(sourcePath, join(outputBlobs, digest));
      await chmod(join(outputBlobs, digest), 0o400);
    }
    const sourceSha256 = sha256(bytes);
    await writeFile(
      join(output, "export.json"),
      `${JSON.stringify({ version: 1, sessionId, sourceSha256 }, null, 2)}\n`,
      { mode: 0o400, flag: "wx" },
    );
    return { outputDirectory: output, sourceSha256 };
  } catch (error) {
    if (created) await rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    await lock.release();
  }
}

function eventBlobReferences(event: CanonicalEvent): readonly BlobReference[] {
  if (
    event.type !== "user.message" &&
    event.type !== "assistant.message" &&
    event.type !== "user.shell" &&
    event.type !== "tool.result"
  ) {
    return [];
  }
  return event.payload.content.flatMap((item) => (item.type === "blob" ? [item.blob] : []));
}

function externalizeTextContent(
  event: CanonicalEvent,
  blobs: Map<string, Uint8Array>,
): CanonicalEvent {
  if (
    event.type !== "user.message" &&
    event.type !== "assistant.message" &&
    event.type !== "user.shell" &&
    event.type !== "tool.result"
  ) {
    return event;
  }
  const content = event.payload.content.map((item) => {
    if (item.type !== "text" || item.text.length === 0) return item;
    const bytes = new TextEncoder().encode(item.text);
    if (bytes.byteLength > MAX_MIGRATION_BLOB_BYTES) return item;
    const digest = sha256(bytes);
    blobs.set(digest, bytes);
    const blob: BlobReference = {
      sha256: digest,
      mediaType: "text/plain",
      sizeBytes: bytes.byteLength,
    };
    return { type: "blob" as const, blob };
  });
  return parseEvent({ ...event, payload: { ...event.payload, content } });
}

function remapEvent(
  event: CanonicalEvent,
  targetSessionId: SessionId,
  mappings: ReadonlyMap<string, string>,
): CanonicalEvent {
  return parseEvent({
    ...event,
    id: mappings.get(event.id),
    sessionId: targetSessionId,
    parentId: event.parentId === null ? null : mappings.get(event.parentId),
  });
}

function parseCommittedEvents(
  bytes: Uint8Array,
  sourceSessionId: SessionId,
): Array<{ readonly event: CanonicalEvent; readonly encodedBytes: number }> {
  const events: Array<{ event: CanonicalEvent; encodedBytes: number }> = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  for (let newline = bytes.indexOf(0x0a); newline !== -1; newline = bytes.indexOf(0x0a, start)) {
    const line = bytes.subarray(start, newline);
    const event = parseEvent(JSON.parse(decoder.decode(line)) as unknown);
    if (event.sessionId !== sourceSessionId)
      throw new Error("Source log session identity mismatch");
    events.push({ event, encodedBytes: line.byteLength });
    start = newline + 1;
  }
  if (start !== bytes.byteLength) throw new Error("Source log has an incomplete final line");
  return events;
}

function buildMigratedEvents(
  sourceRecords: readonly { readonly event: CanonicalEvent; readonly encodedBytes: number }[],
  targetSessionId: SessionId,
): {
  readonly mappings: ReadonlyMap<string, string>;
  readonly blobs: Map<string, Uint8Array>;
  readonly events: readonly CanonicalEvent[];
} {
  const mappings = new Map(
    sourceRecords.map(({ event }) => [
      event.id,
      parseEventId(deterministicUuid(`${targetSessionId}:${event.id}`), "eventId"),
    ]),
  );
  const blobs = new Map<string, Uint8Array>();
  const events: CanonicalEvent[] = [];
  for (const sourceRecord of sourceRecords) {
    const sourceEvent = sourceRecord.event;
    let event = remapEvent(sourceEvent, targetSessionId, mappings);
    try {
      encodeCanonicalEvent(event);
    } catch (error) {
      if (!(error instanceof CanonicalEventSizeError)) throw error;
      event = externalizeTextContent(event, blobs);
      try {
        encodeCanonicalEvent(event);
      } catch (externalizedError) {
        if (!(externalizedError instanceof CanonicalEventSizeError)) throw externalizedError;
        throw new EventMigrationUnsupportedError(sourceEvent, sourceRecord.encodedBytes);
      }
    }
    events.push(event);
  }
  return { mappings, blobs, events };
}

export async function migrateSessionEvents(input: {
  readonly dataDirectory: string;
  readonly sessionId: unknown;
  readonly toolVersion: string;
  readonly confirmPrefix?: boolean;
}): Promise<EventMigrationManifest> {
  const dataDirectory = resolve(input.dataDirectory);
  const sourceSessionId = parseSessionId(input.sessionId, "sessionId");
  const lock = await DataDirectoryLock.acquire(dataDirectory, "event_migration");
  const migrationsDirectory = join(dataDirectory, "migrations");
  const staging = join(migrationsDirectory, `.staging-${randomUUID()}`);
  try {
    await mkdir(migrationsDirectory, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(migrationsDirectory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(".staging-")) {
        await rm(join(migrationsDirectory, entry.name), { recursive: true, force: true });
      }
    }
    const pendingDirectory = join(migrationsDirectory, "pending");
    await mkdir(pendingDirectory, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(pendingDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const pendingPath = join(pendingDirectory, entry.name);
      const pending = JSON.parse(await readFile(pendingPath, "utf8")) as {
        readonly targetSessionId?: unknown;
      };
      const incompleteId = parseSessionId(pending.targetSessionId, "pending.targetSessionId");
      const completedManifest = join(migrationsDirectory, "manifests", `${incompleteId}.json`);
      try {
        await readFile(completedManifest);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rm(sessionLogPath(dataDirectory, incompleteId), { force: true });
      }
      await unlink(pendingPath);
    }
    const sourcePath = sessionLogPath(dataDirectory, sourceSessionId);
    const sourceBytes = await readFile(sourcePath);
    const sourceSha256 = sha256(sourceBytes);
    const backupDirectory = join(migrationsDirectory, "backups");
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const backupPath = join(backupDirectory, `${sourceSessionId}-${sourceSha256}.jsonl`);
    try {
      await writeFile(backupPath, sourceBytes, { flag: "wx", mode: 0o400 });
      await syncFile(backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (sha256(await readFile(backupPath)) !== sourceSha256) {
        throw new Error("Existing migration backup does not match the source log");
      }
    }

    const sourceRecords = parseCommittedEvents(sourceBytes, sourceSessionId);
    if (sourceRecords.length === 0) throw new Error("Source session is empty");
    const firstOversized = sourceRecords.find(
      (record) => record.encodedBytes > MAX_CANONICAL_EVENT_BYTES,
    );
    if (firstOversized === undefined) throw new Error("Session does not require event migration");

    const losslessTarget = parseSessionId(
      deterministicUuid(`axl-event-migration:${sourceSha256}:lossless`),
      "targetSessionId",
    );
    let targetSessionId = losslessTarget;
    let selected = sourceRecords;
    let recovery: EventMigrationManifest["recovery"] = "lossless";
    let omittedSuffix: EventMigrationManifest["omittedSuffix"];
    let built: ReturnType<typeof buildMigratedEvents>;
    try {
      built = buildMigratedEvents(selected, targetSessionId);
    } catch (error) {
      if (!(error instanceof EventMigrationUnsupportedError) || !input.confirmPrefix) throw error;
      const blockingIndex = sourceRecords.findIndex((record) => record.event.id === error.eventId);
      selected = sourceRecords.slice(0, blockingIndex);
      if (selected.length === 0 || selected[0]?.event.type !== "session.created") {
        throw new Error("Cannot recover a prefix without the session creation event");
      }
      recovery = "prefix_only";
      omittedSuffix = {
        firstEventId: error.eventId,
        eventCount: sourceRecords.length - selected.length,
      };
      targetSessionId = parseSessionId(
        deterministicUuid(`axl-event-migration:${sourceSha256}:prefix:${error.eventId}`),
        "targetSessionId",
      );
      built = buildMigratedEvents(selected, targetSessionId);
    }
    const { mappings, blobs: stagedBlobs, events: migrated } = built;

    const manifestDirectory = join(migrationsDirectory, "manifests");
    const manifestPath = join(manifestDirectory, `${targetSessionId}.json`);
    try {
      const existing = JSON.parse(await readFile(manifestPath, "utf8")) as EventMigrationManifest;
      if (existing.sourceSha256 !== sourceSha256) {
        throw new Error("Existing migration manifest does not match the source log");
      }
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rm(sessionLogPath(dataDirectory, targetSessionId), { force: true });

    await mkdir(staging, { recursive: true, mode: 0o700 });
    const targetBytes = Buffer.concat(
      migrated.map((event) =>
        Buffer.concat([Buffer.from(encodeCanonicalEvent(event)), Buffer.of(0x0a)]),
      ),
    );
    const stagedLog = join(staging, `${targetSessionId}.jsonl`);
    await writeFile(stagedLog, targetBytes, { flag: "wx", mode: 0o600 });
    await syncFile(stagedLog);
    const stagedBlobDirectory = join(staging, "blobs");
    if (stagedBlobs.size > 0) await mkdir(stagedBlobDirectory, { mode: 0o700 });
    for (const [digest, bytes] of stagedBlobs) {
      const path = join(stagedBlobDirectory, digest);
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      await syncFile(path);
      if (sha256(await readFile(path)) !== digest)
        throw new Error(`Staged blob ${digest} failed validation`);
    }

    const decoded = decodeEventLogBytes(stagedLog, targetBytes, targetSessionId);
    const tree = SessionTree.fromEvents(targetSessionId, decoded.events);
    verifyToolCallIntegrity(tree);
    if (decoded.cleanByteLength !== targetBytes.byteLength)
      throw new Error("Migrated log is incomplete");
    const blobsDirectory = join(dataDirectory, "blobs");
    for (const reference of migrated.flatMap(eventBlobReferences)) {
      const bytes =
        stagedBlobs.get(reference.sha256) ??
        (await readFile(join(blobsDirectory, reference.sha256)));
      if (bytes.byteLength !== reference.sizeBytes || sha256(bytes) !== reference.sha256) {
        throw new Error(`Blob ${reference.sha256} failed digest validation`);
      }
    }

    await mkdir(blobsDirectory, { recursive: true, mode: 0o700 });
    for (const digest of stagedBlobs.keys()) {
      const source = join(stagedBlobDirectory, digest);
      const destination = join(blobsDirectory, digest);
      try {
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        await chmod(destination, 0o600);
        await syncFile(destination);
        await unlink(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (sha256(await readFile(destination)) !== digest) {
          throw new Error(`Existing blob ${digest} failed digest validation`);
        }
      }
    }
    const sessionsDirectory = join(dataDirectory, "sessions");
    await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
    const pendingPath = join(pendingDirectory, `${targetSessionId}.json`);
    await writeFile(
      pendingPath,
      `${JSON.stringify({ version: 1, sourceSessionId, targetSessionId })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await syncFile(pendingPath);
    await syncDirectory(pendingDirectory);
    const targetPath = sessionLogPath(dataDirectory, targetSessionId);
    await rename(stagedLog, targetPath);
    await syncDirectory(sessionsDirectory);

    const manifest: EventMigrationManifest = {
      version: 1,
      toolVersion: input.toolVersion,
      sourceSessionId,
      targetSessionId,
      sourceSha256,
      targetSha256: sha256(targetBytes),
      eventIdMappings: Object.fromEntries(mappings),
      externalizedBlobDigests: [...stagedBlobs.keys()].sort(),
      validation: { parsed: true, treeIntegrity: true, blobDigests: true },
      recovery,
      ...(omittedSuffix === undefined ? {} : { omittedSuffix }),
    };
    await mkdir(manifestDirectory, { recursive: true, mode: 0o700 });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o400,
    });
    await syncFile(manifestPath);
    await syncDirectory(manifestDirectory);
    await unlink(pendingPath);
    await syncDirectory(pendingDirectory);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await lock.release();
  }
}
