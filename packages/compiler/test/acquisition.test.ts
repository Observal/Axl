// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  type BoundedFileSystem,
  DiscoveryError,
  gitSourceLocator,
  inspectSource,
  localSourceLocator,
  mergeLimits,
  nodeFileSystem,
  normalizeGitRepositoryUri,
  parseForeignInstall,
  publishLocalSnapshot,
  resolvedGitLock,
  resolvedNpmLock,
  sha256,
  verifyImmutableLocalSnapshot,
} from "../src/index.ts";

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "axl-acquisition-test-"));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

test("source locators canonicalize local, npm, and Git input", async () => {
  const root = await fixture({ "package.json": "{}" });
  assert.deepEqual(await localSourceLocator(root, "discovered"), {
    kind: "local",
    canonicalPath: root,
    origin: "discovered",
  });
  assert.deepEqual(
    await parseForeignInstall("pi", ["pi", "install", "npm:@scope/example@^2.0.0"]),
    {
      kind: "npm",
      registryOrigin: "https://registry.npmjs.org",
      packageName: "@scope/example",
      requested: "^2.0.0",
    },
  );
  assert.deepEqual(
    await parseForeignInstall("claude-code", [
      "claude",
      "plugin",
      "install",
      "https://EXAMPLE.com/org/repo.git#v1",
    ]),
    { kind: "git", repositoryUri: "https://example.com/org/repo.git", requestedRef: "v1" },
  );
  assert.deepEqual(await parseForeignInstall("opencode", ["opencode", "install", `file:${root}`]), {
    kind: "local",
    canonicalPath: root,
    origin: "explicit",
  });
});

test("passthrough parser rejects unsupported flags, shell syntax, and credentialed transports", async () => {
  await assert.rejects(parseForeignInstall("pi", ["pi", "install", "--global", "example"]));
  await assert.rejects(
    parseForeignInstall("dsh", ["dsh", "install", "example;touch /tmp/sentinel"]),
  );
  await assert.rejects(parseForeignInstall("claude-code", ["claude", "install", "example"]));
  await assert.rejects(parseForeignInstall("pi", ["pi", "install", "git+ssh://host/repo#main"]));
  assert.throws(() => normalizeGitRepositoryUri("https://user:password@example.com/repo"));
  assert.throws(() => normalizeGitRepositoryUri("git@example.com:org/repo.git"));
  assert.throws(() => gitSourceLocator("http://example.com/repo", "main"));
});

test("immutable remote locks require exact verifiable identities", () => {
  const digest = "a".repeat(64);
  assert.deepEqual(
    resolvedNpmLock({
      registryOrigin: "https://registry.npmjs.org/",
      packageName: "example",
      version: "1.2.3",
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      tarballSha256: digest,
    }),
    {
      kind: "npm",
      registryOrigin: "https://registry.npmjs.org",
      packageName: "example",
      version: "1.2.3",
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      tarballSha256: digest,
    },
  );
  assert.throws(() =>
    resolvedNpmLock({
      registryOrigin: "http://registry.example",
      packageName: "x",
      version: "latest",
      integrity: "sha1-x",
      tarballSha256: digest,
    }),
  );
  assert.deepEqual(resolvedGitLock("https://example.com/repo", "b".repeat(40), digest), {
    kind: "git",
    repositoryUri: "https://example.com/repo",
    commit: "b".repeat(40),
    treeSha256: digest,
  });
  assert.throws(() => resolvedGitLock("https://example.com/repo", "main", digest));
});

test("local snapshot publication is immutable, executable-aware, verified, and idempotent", async () => {
  const source = await fixture({ "bin/run.sh": "#!/bin/sh\nexit 0\n", "lib/data.txt": "content" });
  await chmod(join(source, "bin/run.sh"), 0o755);
  const store = await mkdtemp(join(tmpdir(), "axl-adoption-store-"));
  const first = await publishLocalSnapshot({ storeRoot: store, sourceRoot: source });
  assert.equal(first.lock.kind, "local-snapshot");
  assert.equal(first.lock.fileCount, 2);
  assert.equal(first.alreadyPresent, false);
  assert.equal(await readFile(join(first.sourceDirectory, "lib/data.txt"), "utf8"), "content");
  assert.equal((await stat(join(first.sourceDirectory, "bin/run.sh"))).mode & 0o777, 0o500);
  assert.equal((await stat(join(first.sourceDirectory, "lib/data.txt"))).mode & 0o777, 0o400);
  await verifyImmutableLocalSnapshot(first);

  const second = await publishLocalSnapshot({ storeRoot: store, sourceRoot: source });
  assert.equal(second.alreadyPresent, true);
  assert.equal(second.sourceDirectory, first.sourceDirectory);
  assert.deepEqual(second.lock, first.lock);
  assert.equal(await readFile(join(source, "lib/data.txt"), "utf8"), "content");

  await chmod(first.sourceDirectory, 0o700);
  await assert.rejects(
    publishLocalSnapshot({ storeRoot: store, sourceRoot: source }),
    (error: unknown) => error instanceof DiscoveryError && error.code === "adoption_source_changed",
  );
});

test("concurrent aliases deduplicate by immutable local tree identity", async () => {
  const firstSource = await fixture({ "index.ts": "export {};" });
  const secondSource = await fixture({ "index.ts": "export {};" });
  const store = await mkdtemp(join(tmpdir(), "axl-adoption-store-"));
  const [first, second] = await Promise.all([
    publishLocalSnapshot({ storeRoot: store, sourceRoot: firstSource }),
    publishLocalSnapshot({ storeRoot: store, sourceRoot: secondSource }),
  ]);
  assert.equal(first.sourceDirectory, second.sourceDirectory);
  assert.deepEqual(first.lock, second.lock);
  assert.deepEqual([first.alreadyPresent, second.alreadyPresent].sort(), [false, true]);
});

test("an explicit local file is published as a one-file immutable tree", async () => {
  const directory = await fixture({ "standalone.ts": "export const value = 1;" });
  const source = join(directory, "standalone.ts");
  const store = await mkdtemp(join(tmpdir(), "axl-adoption-store-"));
  const published = await publishLocalSnapshot({ storeRoot: store, sourceRoot: source });
  assert.equal(published.lock.fileCount, 1);
  assert.equal(published.inventory[0]?.relativePath, "standalone.ts");
  assert.equal(
    await readFile(join(published.sourceDirectory, "standalone.ts"), "utf8"),
    "export const value = 1;",
  );
});

test("local snapshot rejects links and source mutation", async () => {
  const outside = await fixture({ secret: "outside" });
  const linked = await fixture({ regular: "ok" });
  await symlink(join(outside, "secret"), join(linked, "escape"));
  await assert.rejects(
    publishLocalSnapshot({
      storeRoot: await mkdtemp(join(tmpdir(), "axl-store-")),
      sourceRoot: linked,
    }),
    (error: unknown) =>
      error instanceof DiscoveryError && error.code === "adoption_source_unavailable",
  );

  const source = await fixture({ file: "before" });
  let fileStats = 0;
  const mutating: BoundedFileSystem = {
    ...nodeFileSystem,
    async lstat(path) {
      if (path === join(source, "file")) {
        fileStats += 1;
        if (fileStats === 3) await writeFile(path, "changed");
      }
      return nodeFileSystem.lstat(path);
    },
  };
  await assert.rejects(
    publishLocalSnapshot({
      storeRoot: await mkdtemp(join(tmpdir(), "axl-store-")),
      sourceRoot: source,
      fileSystem: mutating,
    }),
    (error: unknown) => error instanceof DiscoveryError && error.code === "adoption_source_changed",
  );
});

test("local snapshot refuses blocked and potentially secret-bearing files", async () => {
  for (const files of [
    { ".env": "ordinary=value" },
    { "config.json": 'api_key = "secret-value"' },
    { "src/innocent.ts": `${" ".repeat(300_000)}api_key = "never-copy-this"` },
    { "private-token.txt": "opaque" },
  ]) {
    const source = await fixture(files);
    const store = await mkdtemp(join(tmpdir(), "axl-adoption-store-"));
    await assert.rejects(
      publishLocalSnapshot({ storeRoot: store, sourceRoot: source }),
      (error: unknown) =>
        error instanceof DiscoveryError && error.code === "adoption_source_unavailable",
    );
    assert.deepEqual(await readdir(join(store, "sources")), []);
  }
});

test("source inspection is deterministic and reports metadata without executing scripts", async () => {
  const sentinel = join(await mkdtemp(join(tmpdir(), "axl-never-created-")), "sentinel");
  const source = await fixture({
    "package.json": JSON.stringify({
      scripts: { test: `touch ${sentinel}`, postinstall: `touch ${sentinel}` },
    }),
    "package-lock.json": "{}",
    LICENSE: "Apache-2.0",
    "THIRD_PARTY_NOTICES.txt": "notice",
    "src/index.ts":
      "import { readFile } from 'node:fs/promises'; fetch('https://example.com'); process.env.TOKEN;",
    "test/index.test.ts": "export {};",
    ".env": "API_KEY=secret-value",
  });
  const fingerprint = sha256("stable-discovery-fingerprint");
  const inspection = await inspectSource({
    sourceRoot: source,
    expectedDiscoveryFingerprint: fingerprint,
    resolveDiscoveryFingerprint: () => fingerprint,
  });
  assert.equal(inspection.packageManager, "npm");
  assert.deepEqual(inspection.lockfiles, ["package-lock.json"]);
  assert.deepEqual(inspection.licenseFiles, ["LICENSE"]);
  assert.deepEqual(inspection.noticeFiles, ["THIRD_PARTY_NOTICES.txt"]);
  assert.ok(inspection.tests.some((entry) => entry.kind === "script" && entry.name === "test"));
  assert.ok(inspection.tests.some((entry) => entry.relativePath === "test/index.test.ts"));
  assert.deepEqual(inspection.blockedPaths, [".env"]);
  assert.deepEqual(inspection.potentialSecretFiles, [".env"]);
  assert.ok(inspection.capabilityIndicators.includes("filesystem.read"));
  assert.ok(inspection.capabilityIndicators.includes("network.client"));
  assert.ok(inspection.capabilityIndicators.includes("environment.read"));
  assert.equal(
    inspection.disclosure.find((entry) => entry.relativePath === ".env")?.disclose,
    false,
  );
  await assert.rejects(readFile(sentinel));

  const again = await inspectSource({
    sourceRoot: source,
    expectedDiscoveryFingerprint: fingerprint,
    resolveDiscoveryFingerprint: () => fingerprint,
  });
  assert.deepEqual(again, inspection);

  const oversizedText = await fixture({
    "src/innocent.ts": `${" ".repeat(300_000)}\napi_key = "secret-value-that-must-not-leave"`,
  });
  const oversizedInspection = await inspectSource({
    sourceRoot: oversizedText,
    expectedDiscoveryFingerprint: fingerprint,
    resolveDiscoveryFingerprint: () => fingerprint,
  });
  assert.equal(oversizedInspection.disclosure[0]?.disclose, false);
  assert.deepEqual(oversizedInspection.potentialSecretFiles, ["src/innocent.ts"]);
  await assert.rejects(
    inspectSource({
      sourceRoot: source,
      expectedDiscoveryFingerprint: sha256("old"),
      resolveDiscoveryFingerprint: () => fingerprint,
    }),
    (error: unknown) => error instanceof DiscoveryError && error.code === "adoption_source_changed",
  );
});

test("snapshot and inspection bounds are enforced", async () => {
  const source = await fixture({ big: "12345" });
  await assert.rejects(
    publishLocalSnapshot({
      storeRoot: await mkdtemp(join(tmpdir(), "axl-store-")),
      sourceRoot: source,
      limits: mergeLimits({ maxFileBytes: 4 }),
    }),
    (error: unknown) =>
      error instanceof DiscoveryError && error.code === "adoption_scan_limit_exceeded",
  );
});
