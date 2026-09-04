// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { decodeEventLogBytes, SessionTree, verifyToolCallIntegrity } from "@axl/kernel";
import type {
  BlobReference,
  CanonicalEvent,
  JsonValue,
  OperationId,
  SessionId,
} from "@axl/protocol";
import { encodeCanonicalEvent, parseEvent, parseSessionId } from "@axl/protocol";

const MAX_ARTIFACT_BLOB_BYTES = 20 * 1024 * 1024;

export class SessionArtifactError extends Error {
  readonly code:
    | "artifact_exists"
    | "invalid_artifact"
    | "invalid_path"
    | "not_found"
    | "blob_missing"
    | "blob_corrupt";

  constructor(code: SessionArtifactError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionArtifactError";
    this.code = code;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function blobReferences(events: readonly CanonicalEvent[]): readonly BlobReference[] {
  const references = new Map<string, BlobReference>();
  for (const event of events) {
    if (
      event.type !== "user.message" &&
      event.type !== "assistant.message" &&
      event.type !== "queue.enqueued" &&
      event.type !== "user.shell" &&
      event.type !== "tool.result"
    ) {
      continue;
    }
    for (const item of event.payload.content) {
      if (item.type === "blob") references.set(item.blob.sha256, item.blob);
    }
  }
  return [...references.values()].sort((left, right) => left.sha256.localeCompare(right.sha256));
}

export async function exportSessionArtifact(input: {
  readonly events: readonly CanonicalEvent[];
  readonly outputDirectory: string;
  readonly readBlob: (reference: BlobReference) => Promise<Uint8Array>;
}): Promise<{
  readonly outputDirectory: string;
  readonly sourceSha256: string;
  readonly eventCount: number;
  readonly blobCount: number;
}> {
  const root = input.events[0];
  if (root?.type !== "session.created") throw new Error("Session has no creation event");
  const sessionId: SessionId = root.sessionId;
  const outputDirectory = resolve(input.outputDirectory);
  const eventBytes = Buffer.concat(
    input.events.map((event) =>
      Buffer.concat([Buffer.from(encodeCanonicalEvent(event)), Buffer.of(0x0a)]),
    ),
  );
  const references = blobReferences(input.events);
  let created = false;
  try {
    await mkdir(outputDirectory, { mode: 0o700 });
    created = true;
    await writeFile(join(outputDirectory, "events.jsonl"), eventBytes, { flag: "wx", mode: 0o400 });
    if (references.length > 0) await mkdir(join(outputDirectory, "blobs"), { mode: 0o700 });
    for (const reference of references) {
      await writeFile(
        join(outputDirectory, "blobs", reference.sha256),
        await input.readBlob(reference),
        {
          flag: "wx",
          mode: 0o400,
        },
      );
    }
    const sourceSha256 = sha256(eventBytes);
    await writeFile(
      join(outputDirectory, "manifest.json"),
      `${JSON.stringify(
        {
          format: "axl.session",
          version: 1,
          sourceSessionId: sessionId,
          sourceSha256,
          eventCount: input.events.length,
          blobDigests: references.map((reference) => reference.sha256),
        },
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o400 },
    );
    return {
      outputDirectory,
      sourceSha256,
      eventCount: input.events.length,
      blobCount: references.length,
    };
  } catch (error) {
    if (created) await rm(outputDirectory, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new SessionArtifactError(
        "artifact_exists",
        `Artifact destination already exists: ${outputDirectory}`,
        { cause: error },
      );
    }
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code ?? "")) {
      throw new SessionArtifactError(
        "invalid_path",
        `Cannot write artifact to ${outputDirectory}`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

function invalidArtifact(message: string, cause?: unknown): SessionArtifactError {
  return new SessionArtifactError("invalid_artifact", message, { cause });
}

async function readArtifactFile(path: string, label: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SessionArtifactError("not_found", `Artifact ${label} is missing`, { cause: error });
    }
    if (["ENOTDIR", "EISDIR", "EACCES", "EPERM"].includes(code ?? "")) {
      throw new SessionArtifactError("invalid_path", `Cannot read artifact ${label}`, {
        cause: error,
      });
    }
    throw error;
  }
}

interface SessionArtifactManifest {
  readonly sourceSessionId: SessionId;
  readonly sourceSha256: string;
  readonly eventCount: number;
  readonly blobDigests: readonly string[];
}

async function readManifest(directory: string): Promise<SessionArtifactManifest> {
  const bytes = await readArtifactFile(join(directory, "manifest.json"), "manifest.json");
  if (bytes.byteLength > 1024 * 1024) throw invalidArtifact("Artifact manifest is too large");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (cause) {
    throw invalidArtifact("Artifact manifest is not valid JSON", cause);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidArtifact("Artifact manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  const expected = [
    "format",
    "version",
    "sourceSessionId",
    "sourceSha256",
    "eventCount",
    "blobDigests",
  ];
  if (
    Object.keys(manifest).some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(manifest, key)) ||
    manifest.format !== "axl.session" ||
    manifest.version !== 1 ||
    typeof manifest.sourceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.sourceSha256) ||
    !Number.isSafeInteger(manifest.eventCount) ||
    (manifest.eventCount as number) < 1 ||
    !Array.isArray(manifest.blobDigests) ||
    manifest.blobDigests.length > 10_000 ||
    manifest.blobDigests.some(
      (digest) => typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest),
    ) ||
    new Set(manifest.blobDigests).size !== manifest.blobDigests.length
  ) {
    throw invalidArtifact("Artifact manifest is invalid");
  }
  let sourceSessionId: SessionId;
  try {
    sourceSessionId = parseSessionId(manifest.sourceSessionId, "manifest.sourceSessionId");
  } catch (cause) {
    throw invalidArtifact("Artifact source session ID is invalid", cause);
  }
  return {
    sourceSessionId,
    sourceSha256: manifest.sourceSha256,
    eventCount: manifest.eventCount as number,
    blobDigests: manifest.blobDigests as string[],
  };
}

function remapReference(
  eventIds: ReadonlyMap<string, string>,
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string") throw invalidArtifact(`${label} is invalid`);
  const mapped = eventIds.get(value);
  if (mapped === undefined) throw invalidArtifact(`${label} points outside the artifact`);
  return mapped;
}

function remapEvents(
  source: readonly CanonicalEvent[],
  targetSessionId: SessionId,
  cwd: string,
  creationOperationId: OperationId,
): readonly CanonicalEvent[] {
  const root = source[0];
  if (root?.type !== "session.created") throw invalidArtifact("Artifact has no creation event");
  const eventIds = new Map(source.map((event) => [event.id, randomUUID()]));
  const operationIds = new Map<string, string>();
  if (root.operationId !== undefined) operationIds.set(root.operationId, creationOperationId);
  return source.map((event, index) => {
    const payload =
      event.type === "session.created"
        ? { cwd }
        : (structuredClone(event.payload) as Record<string, JsonValue>);
    if (event.type === "permission.resolved") {
      payload.requestId = remapReference(eventIds, payload.requestId, "permission request");
    } else if (
      event.type === "queue.requeued" ||
      event.type === "queue.started" ||
      event.type === "queue.paused"
    ) {
      payload.queueItemId = remapReference(eventIds, payload.queueItemId, "queue item");
    } else if (event.type === "context.compacted") {
      if (!Array.isArray(payload.replacedEventIds)) {
        throw invalidArtifact("Compaction references are invalid");
      }
      payload.replacedEventIds = payload.replacedEventIds.map((id) =>
        remapReference(eventIds, id, "compaction event"),
      );
    }
    const operationId =
      index === 0
        ? creationOperationId
        : event.operationId === undefined
          ? undefined
          : (operationIds.get(event.operationId) ??
            (() => {
              const id = randomUUID();
              operationIds.set(event.operationId as string, id);
              return id;
            })());
    return parseEvent({
      ...event,
      id: remapReference(eventIds, event.id, "event"),
      sessionId: targetSessionId,
      operationId,
      parentId:
        event.parentId === null
          ? null
          : remapReference(eventIds, event.parentId, `event ${event.id} parent`),
      payload,
    });
  });
}

export async function importSessionArtifact(input: {
  readonly dataDirectory: string;
  readonly inputDirectory: string;
  readonly targetSessionId: SessionId;
  readonly cwd: string;
  readonly creationOperationId: OperationId;
}): Promise<void> {
  const inputDirectory = resolve(input.inputDirectory);
  const manifest = await readManifest(inputDirectory);
  const eventPath = join(inputDirectory, "events.jsonl");
  const sourceBytes = await readArtifactFile(eventPath, "events.jsonl");
  if (sha256(sourceBytes) !== manifest.sourceSha256) {
    throw invalidArtifact("Artifact event log digest does not match its manifest");
  }
  let sourceEvents: readonly CanonicalEvent[];
  try {
    const decoded = decodeEventLogBytes(eventPath, sourceBytes, manifest.sourceSessionId);
    if (decoded.cleanByteLength !== sourceBytes.byteLength) {
      throw invalidArtifact("Artifact event log has an incomplete final line");
    }
    sourceEvents = decoded.events;
    if (sourceEvents.length !== manifest.eventCount) {
      throw invalidArtifact("Artifact event count does not match its manifest");
    }
    verifyToolCallIntegrity(SessionTree.fromEvents(manifest.sourceSessionId, sourceEvents));
  } catch (error) {
    if (error instanceof SessionArtifactError) throw error;
    throw invalidArtifact("Artifact event log is invalid", error);
  }
  const references = blobReferences(sourceEvents);
  const expectedDigests = references.map((reference) => reference.sha256);
  if (JSON.stringify(expectedDigests) !== JSON.stringify(manifest.blobDigests)) {
    throw invalidArtifact("Artifact blob list does not match its event log");
  }
  for (const reference of references) {
    if (reference.sizeBytes > MAX_ARTIFACT_BLOB_BYTES) {
      throw invalidArtifact(`Artifact blob ${reference.sha256} exceeds the size limit`);
    }
    const path = join(inputDirectory, "blobs", reference.sha256);
    const info = await stat(path).catch((cause: unknown) => {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new SessionArtifactError(
          "blob_missing",
          `Artifact blob ${reference.sha256} is missing`,
          { cause },
        );
      }
      throw new SessionArtifactError(
        "invalid_path",
        `Cannot read artifact blob ${reference.sha256}`,
        { cause },
      );
    });
    if (!info.isFile() || info.size !== reference.sizeBytes) {
      throw new SessionArtifactError(
        "blob_corrupt",
        `Artifact blob ${reference.sha256} has an invalid size`,
      );
    }
    const bytes = await readArtifactFile(path, `blob ${reference.sha256}`);
    if (sha256(bytes) !== reference.sha256) {
      throw new SessionArtifactError(
        "blob_corrupt",
        `Artifact blob ${reference.sha256} failed digest validation`,
      );
    }
  }

  const events = remapEvents(
    sourceEvents,
    input.targetSessionId,
    input.cwd,
    input.creationOperationId,
  );
  verifyToolCallIntegrity(SessionTree.fromEvents(input.targetSessionId, events));
  const eventBytes = Buffer.concat(
    events.map((event) =>
      Buffer.concat([Buffer.from(encodeCanonicalEvent(event)), Buffer.of(0x0a)]),
    ),
  );
  const dataDirectory = resolve(input.dataDirectory);
  const sessionsDirectory = join(dataDirectory, "sessions");
  const blobsDirectory = join(dataDirectory, "blobs");
  const stagingPath = join(sessionsDirectory, `.staging-import-${input.targetSessionId}.jsonl`);
  const targetPath = join(sessionsDirectory, `${input.targetSessionId}.jsonl`);
  try {
    await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
    await rm(stagingPath, { force: true });
    await writeFile(stagingPath, eventBytes, { flag: "wx", mode: 0o600 });
    await syncFile(stagingPath);
    if (references.length > 0) await mkdir(blobsDirectory, { recursive: true, mode: 0o700 });
    for (const reference of references) {
      const destination = join(blobsDirectory, reference.sha256);
      let created = false;
      try {
        await copyFile(
          join(inputDirectory, "blobs", reference.sha256),
          destination,
          constants.COPYFILE_EXCL,
        );
        created = true;
        await chmod(destination, 0o600);
        await syncFile(destination);
        const bytes = await readFile(destination);
        if (bytes.byteLength !== reference.sizeBytes || sha256(bytes) !== reference.sha256) {
          throw new SessionArtifactError(
            "blob_corrupt",
            `Artifact blob ${reference.sha256} changed during import`,
          );
        }
      } catch (error) {
        if (created) await rm(destination, { force: true });
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stored = await readFile(destination);
        if (stored.byteLength !== reference.sizeBytes || sha256(stored) !== reference.sha256) {
          throw new SessionArtifactError(
            "blob_corrupt",
            `Stored blob ${reference.sha256} is corrupt`,
          );
        }
      }
    }
    if (references.length > 0) {
      const directory = await open(blobsDirectory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    await rename(stagingPath, targetPath);
    const directory = await open(sessionsDirectory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(stagingPath, { force: true });
    if (error instanceof SessionArtifactError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SessionArtifactError("blob_missing", "An artifact blob disappeared during import", {
        cause: error,
      });
    }
    if (["ENOTDIR", "EISDIR", "EACCES", "EPERM"].includes(code ?? "")) {
      throw new SessionArtifactError("invalid_path", "Cannot publish the imported session", {
        cause: error,
      });
    }
    throw error;
  }
}
