// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BlobReference, CanonicalEvent, SessionId } from "@axl/protocol";
import { encodeCanonicalEvent } from "@axl/protocol";

export class SessionArtifactError extends Error {
  readonly code: "artifact_exists" | "invalid_path";

  constructor(code: SessionArtifactError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionArtifactError";
    this.code = code;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
