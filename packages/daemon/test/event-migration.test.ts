// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { JsonlEventLog } from "@axl/kernel";
import { MAX_CANONICAL_EVENT_BYTES, parseEvent, parseEventId, parseSessionId } from "@axl/protocol";

import {
  EventMigrationUnsupportedError,
  exportSessionRaw,
  migrateSessionEvents,
} from "../src/index.ts";
import { DataDirectoryLock, DataDirectoryLockedError } from "../src/data-directory-lock.ts";

const sourceSessionId = parseSessionId("00000000-0000-4000-8000-000000000301");

async function fixture(context: TestContext, secondType: "user.message" | "prompt.section") {
  const dataDirectory = await mkdtemp(join(tmpdir(), "axl-event-migration-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const sessions = join(dataDirectory, "sessions");
  await mkdir(sessions, { recursive: true });
  const root = parseEvent({
    version: 1,
    id: "00000000-0000-4000-8000-000000000302",
    sessionId: sourceSessionId,
    parentId: null,
    timestamp: 1,
    type: "session.created",
    payload: { cwd: "/workspace" },
  });
  const eventId = parseEventId("00000000-0000-4000-8000-000000000303");
  const text = "é".repeat(MAX_CANONICAL_EVENT_BYTES);
  const second = parseEvent({
    version: 1,
    id: eventId,
    sessionId: sourceSessionId,
    parentId: root.id,
    timestamp: 2,
    type: secondType,
    payload:
      secondType === "user.message"
        ? { content: [{ type: "text", text }] }
        : { name: "legacy", source: "test", content: text },
  });
  const sourcePath = join(sessions, `${sourceSessionId}.jsonl`);
  await writeFile(sourcePath, `${JSON.stringify(root)}\n${JSON.stringify(second)}\n`);
  return { dataDirectory, sourcePath, sourceBytes: await readFile(sourcePath), text };
}

test("losslessly migrates schema-supported oversized text without changing the source", async (context) => {
  const input = await fixture(context, "user.message");
  const manifest = await migrateSessionEvents({
    dataDirectory: input.dataDirectory,
    sessionId: sourceSessionId,
    toolVersion: "test",
  });

  assert.equal(manifest.recovery, "lossless");
  assert.equal(manifest.sourceSessionId, sourceSessionId);
  assert.equal(manifest.externalizedBlobDigests.length, 1);
  assert.deepEqual(await readFile(input.sourcePath), input.sourceBytes);
  const migrated = await JsonlEventLog.open(
    join(input.dataDirectory, "sessions", `${manifest.targetSessionId}.jsonl`),
    manifest.targetSessionId,
  );
  assert.equal(migrated.events.length, 2);
  const message = migrated.events[1];
  assert.equal(message?.type, "user.message");
  if (message?.type !== "user.message") return;
  const content = message.payload.content[0];
  assert.equal(content?.type, "blob");
  if (content?.type !== "blob") return;
  assert.equal(content.blob.mediaType, "text/plain");
  assert.equal(
    (await readFile(join(input.dataDirectory, "blobs", content.blob.sha256))).toString("utf8"),
    input.text,
  );
  await readFile(
    join(input.dataDirectory, "migrations", "manifests", `${manifest.targetSessionId}.json`),
  );
  assert.deepEqual(
    await migrateSessionEvents({
      dataDirectory: input.dataDirectory,
      sessionId: sourceSessionId,
      toolVersion: "test",
      confirmPrefix: true,
    }),
    manifest,
  );
});

test("publishes nothing for unsupported migration until prefix recovery is confirmed", async (context) => {
  const input = await fixture(context, "prompt.section");
  await assert.rejects(
    migrateSessionEvents({
      dataDirectory: input.dataDirectory,
      sessionId: sourceSessionId,
      toolVersion: "test",
    }),
    EventMigrationUnsupportedError,
  );
  assert.deepEqual(await readdir(join(input.dataDirectory, "sessions")), [
    `${sourceSessionId}.jsonl`,
  ]);
  assert.deepEqual(await readFile(input.sourcePath), input.sourceBytes);

  const incompleteId = "00000000-0000-4000-8000-000000000305";
  const pendingDirectory = join(input.dataDirectory, "migrations", "pending");
  await mkdir(pendingDirectory, { recursive: true });
  await writeFile(
    join(input.dataDirectory, "sessions", `${incompleteId}.jsonl`),
    `${JSON.stringify({ ...JSON.parse(input.sourceBytes.toString("utf8").split("\n")[0] as string), sessionId: incompleteId })}\n`,
  );
  await writeFile(
    join(pendingDirectory, `${incompleteId}.json`),
    `${JSON.stringify({ version: 1, sourceSessionId, targetSessionId: incompleteId })}\n`,
  );

  const manifest = await migrateSessionEvents({
    dataDirectory: input.dataDirectory,
    sessionId: sourceSessionId,
    toolVersion: "test",
    confirmPrefix: true,
  });
  assert.equal(manifest.recovery, "prefix_only");
  assert.equal(manifest.omittedSuffix?.firstEventId, "00000000-0000-4000-8000-000000000303");
  assert.equal(manifest.omittedSuffix?.eventCount, 1);
  const recovered = await JsonlEventLog.open(
    join(input.dataDirectory, "sessions", `${manifest.targetSessionId}.jsonl`),
    manifest.targetSessionId,
  );
  assert.equal(recovered.events.length, 1);
  assert.equal(recovered.events[0]?.type, "session.created");
  await assert.rejects(
    readFile(join(input.dataDirectory, "sessions", `${incompleteId}.jsonl`)),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  assert.deepEqual(await readFile(input.sourcePath), input.sourceBytes);
});

test("refuses offline recovery while the data directory is owned", async (context) => {
  const input = await fixture(context, "user.message");
  const lock = await DataDirectoryLock.acquire(input.dataDirectory, "daemon");
  try {
    await assert.rejects(
      migrateSessionEvents({
        dataDirectory: input.dataDirectory,
        sessionId: sourceSessionId,
        toolVersion: "test",
      }),
      DataDirectoryLockedError,
    );
    assert.deepEqual(await readFile(input.sourcePath), input.sourceBytes);
  } finally {
    await lock.release();
  }
});

test("raw export copies the original bytes without parsing", async (context) => {
  const input = await fixture(context, "prompt.section");
  const outputDirectory = join(input.dataDirectory, "..", `raw-export-${Date.now()}`);
  context.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const exported = await exportSessionRaw({
    dataDirectory: input.dataDirectory,
    sessionId: sourceSessionId,
    outputDirectory,
  });
  assert.equal(exported.outputDirectory, outputDirectory);
  assert.deepEqual(
    await readFile(join(outputDirectory, `${sourceSessionId}.jsonl`)),
    input.sourceBytes,
  );
});
