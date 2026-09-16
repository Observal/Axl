// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Dirent } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  parseAdoptionId,
  parseAdoptionManifest,
  parseAdoptionOperationId,
  parseAdoptionRevisionId,
} from "@axl/protocol";
import {
  type AdoptionOperationRecord,
  AdoptionStore,
  AdoptionStoreError,
  type AdoptionStoreFailpoint,
  decodeAdoptionPackageId,
  encodeAdoptionPackageId,
  hashAdoptionSourceInventory,
} from "../src/adoption-store.ts";

const source = Buffer.from("{}", "utf8");
const generated = Buffer.from("export {};\n", "utf8");
const hash = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const sourceFiles = [
  { path: "package.json", sha256: hash(source), sizeBytes: source.length, executable: false },
] as const;
const sourceTreeSha256 = hashAdoptionSourceInventory(sourceFiles);
const fileInventorySha256 = hash(JSON.stringify(sourceFiles));
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
      treeSha256: sourceTreeSha256,
      fileCount: 1,
      sizeBytes: source.length,
    },
    sourceContentSha256: sourceTreeSha256,
    fileInventorySha256,
    sourceFiles,
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

test("startup preserves published source paths that resemble staging names", async (context) => {
  const { root, store } = await temporaryStore(context);
  const stagedNameBytes = Buffer.from("visible", "utf8");
  const nestedStagedNameBytes = Buffer.from("also-visible", "utf8");
  const stagedSourceFiles = [
    ...sourceFiles,
    {
      path: ".staging-config.json",
      sha256: hash(stagedNameBytes),
      sizeBytes: stagedNameBytes.length,
      executable: false,
    },
    {
      path: "nested/.staging-data",
      sha256: hash(nestedStagedNameBytes),
      sizeBytes: nestedStagedNameBytes.length,
      executable: false,
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const stagedSourceTreeSha256 = hashAdoptionSourceInventory(stagedSourceFiles);
  const stagedManifest = parseAdoptionManifest({
    ...manifest(),
    sourceLock: {
      kind: "local-snapshot",
      treeSha256: stagedSourceTreeSha256,
      fileCount: stagedSourceFiles.length,
      sizeBytes: stagedSourceFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
    },
    sourceContentSha256: stagedSourceTreeSha256,
    fileInventorySha256: hash(JSON.stringify(stagedSourceFiles)),
    sourceFiles: stagedSourceFiles,
  });
  const published = await store.publishRevision({
    manifest: stagedManifest,
    artifacts: [
      ...artifacts,
      { kind: "source", path: ".staging-config.json", bytes: stagedNameBytes },
      { kind: "source", path: "nested/.staging-data", bytes: nestedStagedNameBytes },
    ],
  });

  const restarted = new AdoptionStore(root);
  await restarted.initialize();
  await restarted.readRevision("pi", stagedManifest.packageId, stagedManifest.revisionId);
  assert.equal(
    await readFile(join(published.directory, "source/.staging-config.json"), "utf8"),
    "visible",
  );
  assert.equal(
    await readFile(join(published.directory, "source/nested/.staging-data"), "utf8"),
    "also-visible",
  );
});

test("publication binds aggregate provenance hashes to staged source bytes", async (context) => {
  const { store } = await temporaryStore(context);
  const wrongTree = "b".repeat(64);
  await assert.rejects(
    store.publishRevision({
      manifest: {
        ...manifest(),
        sourceLock: {
          kind: "local-snapshot",
          treeSha256: wrongTree,
          fileCount: sourceFiles.length,
          sizeBytes: source.length,
        },
        sourceContentSha256: wrongTree,
      },
      artifacts,
    }),
    /source hashes do not match the staged source inventory/,
  );
  await assert.rejects(
    store.publishRevision({
      manifest: { ...manifest(), fileInventorySha256: "c".repeat(64) },
      artifacts,
    }),
    /source hashes do not match the staged source inventory/,
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
    packageKey: `pi:${manifest().packageId}`,
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

test("published revisions reject mutable directory permissions", async (context) => {
  const { store } = await temporaryStore(context);
  const published = await store.publishRevision({ manifest: manifest(), artifacts });
  await chmod(join(published.directory, "source"), 0o700);
  await assert.rejects(
    store.readRevision("pi", manifest().packageId, revisionId),
    /mutable directory/,
  );
  await assert.rejects(store.initialize(), /mutable directory/);
});

test("different immutable sources under one package remain separate revisions", async (context) => {
  const { store } = await temporaryStore(context);
  const first = await store.publishRevision({ manifest: manifest(), artifacts });
  const secondSource = Buffer.from('{"version":2}', "utf8");
  const secondFiles = [
    {
      path: "package.json",
      sha256: hash(secondSource),
      sizeBytes: secondSource.length,
      executable: false,
    },
  ] as const;
  const secondTree = hashAdoptionSourceInventory(secondFiles);
  const secondManifest = parseAdoptionManifest({
    ...manifest(),
    revisionId: "018f1f60-7b2a-7ccd-8f7a-4c57d8532d98",
    sourceLock: {
      kind: "local-snapshot",
      treeSha256: secondTree,
      fileCount: 1,
      sizeBytes: secondSource.length,
    },
    sourceContentSha256: secondTree,
    fileInventorySha256: hash(JSON.stringify(secondFiles)),
    sourceFiles: secondFiles,
  });
  const second = await store.publishRevision({
    manifest: secondManifest,
    artifacts: [
      { kind: "source", path: "package.json", bytes: secondSource },
      ...artifacts.filter((artifact) => artifact.kind !== "source"),
    ],
  });
  assert.notEqual(first.directory, second.directory);
  assert.notEqual(first.manifest.sourceContentSha256, second.manifest.sourceContentSha256);
});

test("registry rejects dangling and identity-mismatched active revisions", async (context) => {
  const { store } = await temporaryStore(context);
  const current = await store.readRegistry();
  await assert.rejects(
    store.updateRegistry(current.generation, [
      {
        adoptionId: manifest().adoptionId,
        scope: "global",
        packageKey: `pi:${manifest().packageId}`,
        activeRevisionId: revisionId,
      },
    ]),
    /does not resolve to a valid revision/,
  );
  assert.equal((await store.readRegistry()).generation, current.generation);

  await store.publishRevision({ manifest: manifest(), artifacts });
  await assert.rejects(
    store.updateRegistry(current.generation, [
      {
        adoptionId: parseAdoptionId("018f1f60-7b2a-7ccd-8f7a-4c57d8532d99"),
        scope: "global",
        packageKey: `pi:${manifest().packageId}`,
        activeRevisionId: revisionId,
      },
    ]),
    /does not match a verified adoption revision/,
  );
  assert.equal((await store.readRegistry()).generation, current.generation);
});

test("registry activation requires successful verification evidence", async (context) => {
  for (const steps of [[], [{ name: "not-run", version: "1", status: "omitted" as const }]]) {
    const { store } = await temporaryStore(context);
    const unverified = parseAdoptionManifest({
      ...manifest(),
      verification: { ...manifest().verification, steps },
    });
    await store.publishRevision({ manifest: unverified, artifacts });
    await assert.rejects(
      store.updateRegistry(0, [
        {
          adoptionId: unverified.adoptionId,
          scope: unverified.scope,
          packageKey: `pi:${unverified.packageId}`,
          activeRevisionId: unverified.revisionId,
        },
      ]),
      /verified adoption revision/,
    );
    assert.equal((await store.readRegistry()).generation, 0);
  }
});

test("immutable artifact cache deduplicates and quarantines corrupt bytes", async (context) => {
  const { store } = await temporaryStore(context);
  const cache = store.immutableArtifactCache();
  await cache.write("npm-sha512-example", Buffer.from("artifact"));
  await cache.write("npm-sha512-example", Buffer.from("artifact"));
  assert.equal(Buffer.from((await cache.read("npm-sha512-example")) ?? []).toString(), "artifact");
  await cache.quarantine("npm-sha512-example");
  assert.equal(await cache.read("npm-sha512-example"), undefined);
  await assert.rejects(cache.write("../escape", Buffer.from("bad")), /cache key is invalid/);
});

test("startup reconciles interrupted acquisition journals by immutable publication state", async (context) => {
  for (const publishBeforeRestart of [false, true]) {
    const { store } = await temporaryStore(context);
    const operationId = parseAdoptionOperationId(
      publishBeforeRestart
        ? "018f1f60-7b2a-7ccd-8f7a-4c57d8532d97"
        : "018f1f60-7b2a-7ccd-8f7a-4c57d8532d96",
    );
    const sourceLocator = { kind: "local" as const, canonicalPath: "/safe/source" };
    await store.beginAcquisitionOperation(operationId, sourceLocator);
    await store.appendAcquisitionOperation({
      version: 1,
      operationId,
      sequence: 1,
      state: "acquired",
      updatedAt: "2026-03-01T00:00:00.000Z",
      source: sourceLocator,
      sourceLock: manifest().sourceLock,
    });
    await store.appendAcquisitionOperation({
      version: 1,
      operationId,
      sequence: 2,
      state: "publishing",
      updatedAt: "2026-03-01T00:00:01.000Z",
      source: sourceLocator,
      sourceLock: manifest().sourceLock,
      target: { ecosystem: "pi", packageId: manifest().packageId, revisionId },
    });
    if (publishBeforeRestart) await store.publishRevision({ manifest: manifest(), artifacts });
    await store.initialize();
    const recovered = await store.readAcquisitionOperation(operationId);
    assert.equal(recovered?.sequence, 3);
    assert.equal(recovered?.state, publishBeforeRestart ? "published" : "failed");
  }
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
  const abandoned = join(
    root,
    "operations",
    ".staging-018f1f60-7b2a-7ccd-8f7a-4c57d8532d93-aaaaaaaaaaaa",
  );
  await mkdir(abandoned);
  await writeFile(join(abandoned, "partial"), "partial");
  await store.initialize();
  await assert.rejects(readFile(join(abandoned, "partial")), /ENOENT/);
  await symlink(tmpdir(), join(root, "operations", "linked"));
  await assert.rejects(store.initialize(), /symbolic link/);
});

test("restart reconciles process death during staging and accepts only complete publication", async (context) => {
  for (const killAfterRename of [1, 2]) {
    const { root } = await temporaryStore(context);
    const moduleUrl = new URL("../src/adoption-store.ts", import.meta.url).href;
    const script = `
      import { AdoptionStore } from ${JSON.stringify(moduleUrl)};
      const manifest = JSON.parse(process.env.AXL_TEST_MANIFEST);
      const store = new AdoptionStore(process.env.AXL_TEST_ROOT, {
        fail(point) {
          if (point === "after-rename") {
            globalThis.count = (globalThis.count ?? 0) + 1;
            if (globalThis.count === Number(process.env.AXL_TEST_KILL_AFTER))
              process.kill(process.pid, "SIGKILL");
          }
        }
      });
      await store.initialize();
      globalThis.count = 0;
      await store.publishRevision({
        manifest,
        artifacts: [
          { kind: "source", path: "package.json", bytes: Buffer.from("e30=", "base64") },
          { kind: "converted", path: "index.js", bytes: Buffer.from("ZXhwb3J0IHt9Owo=", "base64") },
          { kind: "verification", path: "result.json", bytes: Buffer.from("e30=", "base64") }
        ]
      });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env,
        AXL_TEST_ROOT: root,
        AXL_TEST_MANIFEST: JSON.stringify(manifest()),
        AXL_TEST_KILL_AFTER: String(killAfterRename),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    assert.equal(code, null, Buffer.concat(stderr).toString("utf8"));
    assert.equal(signal, "SIGKILL");

    const recovered = new AdoptionStore(root);
    await recovered.initialize();
    if (killAfterRename === 1) {
      const operationEntries = await readdir(join(root, "pi"), { recursive: true }).catch(() => []);
      assert.equal(
        operationEntries.some((entry) => String(entry).includes(".staging-")),
        false,
      );
    } else {
      const published = await recovered.readRevision("pi", manifest().packageId, revisionId);
      assert.equal(published.manifest.revisionId, revisionId);
    }
  }
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

test("revision publication fails closed at every durability boundary", async (context) => {
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
          throw new Error(`injected revision ${point}`);
        }
      },
    });
    armed = true;
    await assert.rejects(
      store.publishRevision({ manifest: manifest(), artifacts }),
      new RegExp(`injected revision ${point}`),
    );
    armed = false;
    try {
      const published = await store.readRevision("pi", manifest().packageId, revisionId);
      assert.equal(published.manifest.revisionId, revisionId);
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    }
  }
});

test("disk-full and permission failures propagate without publishing operations", async (context) => {
  for (const code of ["ENOSPC", "EACCES"] as const) {
    let armed = false;
    const { store } = await temporaryStore(context, {
      fail(point: AdoptionStoreFailpoint) {
        if (armed && point === "before-file-fsync") {
          const error = new Error(code) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
      },
    });
    armed = true;
    const operation = {
      version: 1,
      operationId:
        code === "ENOSPC"
          ? "018f1f60-7b2a-7ccd-8f7a-4c57d8532d95"
          : "018f1f60-7b2a-7ccd-8f7a-4c57d8532d96",
      state: "acquiring",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    } as AdoptionOperationRecord;
    await assert.rejects(store.publishOperation(operation), (error: unknown) => {
      return (error as NodeJS.ErrnoException).code === code;
    });
    await assert.rejects(store.readOperation(operation.operationId), /ENOENT/);
  }
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
