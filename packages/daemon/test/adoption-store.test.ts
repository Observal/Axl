// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { parseAdoptionManifest, parseAdoptionRevisionId } from "@axl/protocol";
import {
  type AdoptionOperationRecord,
  AdoptionStore,
  AdoptionStoreError,
  type AdoptionStoreFailpoint,
  decodeAdoptionPackageId,
  encodeAdoptionPackageId,
} from "../src/adoption-store.ts";

const source = Buffer.from("{}", "utf8");
const generated = Buffer.from("export {};\n", "utf8");
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const fixedSha = "a".repeat(64);
const revisionId = parseAdoptionRevisionId("018f1f60-7b2a-7ccd-8f7a-4c57d8532d92");

function manifest() {
  return parseAdoptionManifest({
    version: 1,
    adoptionId: "018f1f60-7b2a-7ccd-8f7a-4c57d8532d91",
    revisionId,
    ecosystem: "pi",
    scope: "global",
    packageId: "@hostile/../../package",
    sourceUri: "file:///safe/source",
    sourceLock: {
      kind: "local-snapshot",
      treeSha256: fixedSha,
      fileCount: 1,
      sizeBytes: source.length,
    },
    sourceContentSha256: fixedSha,
    fileInventorySha256: fixedSha,
    sourceFiles: [
      { path: "package.json", sha256: hash(source), sizeBytes: source.length, executable: false },
    ],
    license: { files: [], notices: [], warnings: ["license-not-detected"] },
    model: { converterVersion: "native-1", targetContractVersion: "1", requestSettings: {} },
    surfaces: [
      {
        surfaceId: "primary",
        kind: "extension",
        name: "primary",
        primary: true,
        executable: true,
        compatibility: "adapted",
        rationale: "reviewed conversion",
        generatedPaths: ["index.js"],
      },
    ],
    requestedCapabilities: ["tool.register"],
    approvedCapabilities: ["tool.register"],
    deniedCapabilities: [],
    generatedFiles: [
      { path: "index.js", sha256: hash(generated), sizeBytes: generated.length, executable: false },
    ],
    dependencies: [],
    verification: {
      verifierVersion: "1",
      environment: "test",
      sandboxControls: ["no-network"],
      steps: [{ name: "hashes", version: "1", status: "passed" }],
    },
    unsupportedBehavior: [],
    partialAdoptionAcknowledged: false,
    approvals: [],
    overlayHashes: [],
  });
}

async function makeWritable(directory: string): Promise<void> {
  let entries: Dirent[];
  try {
    await chmod(directory, 0o700);
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await makeWritable(path);
    else await chmod(path, 0o600).catch(() => undefined);
  }
}

async function temporaryStore(context: TestContext, options = {}) {
  const root = join(
    tmpdir(),
    `axl-adoption-store-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  context.after(async () => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const store = new AdoptionStore(root, options);
  await store.initialize();
  return { root, store };
}

const artifacts = [
  { kind: "source" as const, path: "package.json", bytes: source },
  { kind: "converted" as const, path: "index.js", bytes: generated },
  { kind: "verification" as const, path: "result.json", bytes: Buffer.from("{}") },
];

test("package IDs are reversible safe names bound to their hash", () => {
  const packageId = "@hostile/../../package ✓";
  const encoded = encodeAdoptionPackageId(packageId);
  assert.doesNotMatch(encoded, /[/.]/);
  assert.equal(decodeAdoptionPackageId(encoded), packageId);
  assert.throws(() => decodeAdoptionPackageId(`${encoded.slice(0, -1)}0`), /hash does not match/);
});

test("publishes and verifies an immutable artifact-separated revision", async (context) => {
  const { store } = await temporaryStore(context);
  const published = await store.publishRevision({ manifest: manifest(), artifacts });
  assert.equal(published.manifest.revisionId, revisionId);
  assert.match(published.treeSha256, /^[0-9a-f]{64}$/);
  assert.equal(await readFile(join(published.directory, "source/package.json"), "utf8"), "{}");
  assert.equal(
    await readFile(join(published.directory, "converted/index.js"), "utf8"),
    "export {};\n",
  );

  await chmod(join(published.directory, "converted/index.js"), 0o600);
  await writeFile(join(published.directory, "converted/index.js"), "tampered");
  await assert.rejects(
    store.readRevision("pi", manifest().packageId, revisionId),
    (error: unknown) => error instanceof AdoptionStoreError && error.code === "corrupt",
  );
});

test("published revisions fail closed on unindexed or corrupted content", async (context) => {
  const { store } = await temporaryStore(context);
  const published = await store.publishRevision({ manifest: manifest(), artifacts });
  await chmod(published.directory, 0o700);
  await writeFile(join(published.directory, "unexpected"), "extra");
  await assert.rejects(
    store.readRevision("pi", manifest().packageId, revisionId),
    (error: unknown) => error instanceof AdoptionStoreError && error.code === "corrupt",
  );
});

test("concurrent identical publication deduplicates while registry generations serialize", async (context) => {
  const { store } = await temporaryStore(context);
  const [left, right] = await Promise.all([
    store.publishRevision({ manifest: manifest(), artifacts }),
    store.publishRevision({ manifest: manifest(), artifacts }),
  ]);
  assert.equal(left.treeSha256, right.treeSha256);
  const current = await store.readRegistry();
  const entry = {
    adoptionId: manifest().adoptionId,
    scope: "global" as const,
    packageKey: "pi:test",
    activeRevisionId: revisionId,
  };
  const results = await Promise.allSettled([
    store.updateRegistry(current.generation, [entry]),
    store.updateRegistry(current.generation, [entry]),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await store.readRegistry()).generation, 1);
});

test("operation records are immutable and strict", async (context) => {
  const { store } = await temporaryStore(context);
  const operation = {
    version: 1,
    operationId: "018f1f60-7b2a-7ccd-8f7a-4c57d8532d94",
    state: "acquiring",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  } as AdoptionOperationRecord;
  await store.publishOperation(operation);
  assert.deepEqual(await store.readOperation(operation.operationId), operation);
  await assert.rejects(store.publishOperation(operation), /already exists/);
});

test("startup removes abandoned staging but rejects store symlinks", async (context) => {
  const { root, store } = await temporaryStore(context);
  const abandoned = join(root, "operations", ".staging-abandoned");
  await mkdir(abandoned);
  await writeFile(join(abandoned, "partial"), "partial");
  await store.initialize();
  await assert.rejects(readFile(join(abandoned, "partial")), /ENOENT/);
  await symlink(tmpdir(), join(root, "operations", "linked"));
  await assert.rejects(store.initialize(), /symbolic link/);
});

test("strict registry reads reject corruption", async (context) => {
  const { root, store } = await temporaryStore(context);
  await writeFile(
    join(root, "registry.json"),
    '{"version":1,"generation":0,"entries":[],"extra":true}',
  );
  await assert.rejects(
    store.readRegistry(),
    (error: unknown) => error instanceof AdoptionStoreError && error.code === "corrupt",
  );
});

test("durability failures never expose malformed registry JSON", async (context) => {
  const points: AdoptionStoreFailpoint[] = [
    "before-file-fsync",
    "after-file-fsync",
    "before-directory-fsync",
    "after-directory-fsync",
    "before-rename",
    "after-rename",
  ];
  for (const point of points) {
    let armed = false;
    let fired = false;
    const { store } = await temporaryStore(context, {
      fail(candidate: AdoptionStoreFailpoint) {
        if (armed && !fired && candidate === point) {
          fired = true;
          throw new Error(`injected ${point}`);
        }
      },
      lockAttempts: 2,
    });
    armed = true;
    const before = await store.readRegistry();
    await assert.rejects(store.updateRegistry(before.generation, []), /injected/);
    armed = false;
    const after = await store.readRegistry();
    assert.ok(after.generation === before.generation || after.generation === before.generation + 1);
  }
});
