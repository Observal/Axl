// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  AcquisitionError,
  acquireGitSource,
  acquireNpmSource,
  extractBoundedTar,
  type GitCommandRunner,
  type ImmutableArtifactCache,
  type NpmSourceLock,
  normalizeGitRepositoryUri,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporary(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `axl-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

interface TarEntry {
  readonly path: string;
  readonly content?: string;
  readonly mode?: number;
  readonly type?: "0" | "5" | "2";
}

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
}

function tar(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    octal(entry.mode ?? 0o644, 8).copy(header, 100);
    octal(0, 8).copy(header, 108);
    octal(0, 8).copy(header, 116);
    octal(content.length, 12).copy(header, 124);
    octal(0, 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    octal(
      [...header].reduce((sum, byte) => sum + byte, 0),
      8,
    ).copy(header, 148);
    chunks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

class MemoryCache implements ImmutableArtifactCache {
  readonly values = new Map<string, Uint8Array>();
  async read(key: string): Promise<Uint8Array | undefined> {
    return this.values.get(key);
  }
  async write(key: string, bytes: Uint8Array): Promise<void> {
    this.values.set(key, bytes);
  }
}

test("npm resolves a range, drops credentials across approved origins, verifies and extracts without scripts", async () => {
  const artifact = gzipSync(
    tar([
      {
        path: "package/package.json",
        content: JSON.stringify({ name: "safe-pkg", scripts: { install: "touch sentinel" } }),
      },
      { path: "package/index.js", content: "export default 1;", mode: 0o755 },
    ]),
  );
  const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
  const metadata = JSON.stringify({
    "dist-tags": { latest: "1.2.3" },
    versions: {
      "1.2.2": {
        name: "safe-pkg",
        version: "1.2.2",
        dist: { integrity, tarball: "https://cdn.example/safe-pkg.tgz" },
      },
      "1.2.3": {
        name: "safe-pkg",
        version: "1.2.3",
        dist: { integrity, tarball: "https://cdn.example/safe-pkg.tgz" },
      },
    },
  });
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization") });
    if (url.includes("registry.example")) return new Response(metadata, { status: 200 });
    return new Response(artifact, { status: 200 });
  };
  const destination = join(await temporary("npm"), "snapshot");
  const cache = new MemoryCache();
  const result = await acquireNpmSource(
    {
      kind: "npm",
      registryOrigin: "https://registry.example",
      packageName: "safe-pkg",
      requested: "^1.2.0",
    },
    {
      destination,
      credentialReference: "credential:registry",
      approvedRedirectOrigins: ["https://cdn.example"],
    },
    {
      fetch: fetcher,
      cache,
      credentials: {
        async authorizationHeader(reference, origin) {
          assert.equal(reference, "credential:registry");
          assert.equal(origin, "https://registry.example");
          return "Bearer secret-value";
        },
      },
    },
  );

  assert.equal(result.lock.version, "1.2.3");
  assert.match(result.lock.tarballSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.snapshot.fileCount, 2);
  assert.equal(await readFile(join(destination, "index.js"), "utf8"), "export default 1;");
  assert.equal(requests[0]?.authorization, "Bearer secret-value");
  assert.equal(requests[1]?.authorization, null);
  assert.equal(
    requests.some((request) => request.url.includes("sentinel")),
    false,
  );
  assert.equal(result.credentialReferenceUsed, "credential:registry");
  assert.equal(JSON.stringify(result).includes("secret-value"), false);

  const offlineDestination = join(await temporary("npm-offline"), "snapshot");
  const offline = await acquireNpmSource(
    {
      kind: "npm",
      registryOrigin: "https://registry.example",
      packageName: "safe-pkg",
      requested: "^1.2.0",
    },
    { destination: offlineDestination, offline: true, lock: result.lock },
    {
      cache,
      fetch: async () => {
        throw new Error("network must not be used offline");
      },
    },
  );
  assert.equal(offline.fromCache, true);
  assert.equal(offline.snapshot.treeSha256, result.snapshot.treeSha256);
});

test("npm rejects bad integrity, unapproved origins, missing offline locks, and traversal archives", async () => {
  const artifact = gzipSync(tar([{ path: "package/../escape", content: "bad" }]));
  const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
  const metadata = JSON.stringify({
    "dist-tags": { latest: "1.0.0" },
    versions: {
      "1.0.0": {
        name: "safe-pkg",
        version: "1.0.0",
        dist: { integrity, tarball: "https://cdn.example/pkg.tgz" },
      },
    },
  });
  const fetcher: typeof fetch = async (input) =>
    new Response(String(input).includes("registry") ? metadata : artifact);
  await assert.rejects(
    acquireNpmSource(
      {
        kind: "npm",
        registryOrigin: "https://registry.example",
        packageName: "safe-pkg",
        requested: "latest",
      },
      { destination: join(await temporary("npm-origin"), "snapshot") },
      { fetch: fetcher },
    ),
    (error: unknown) => error instanceof AcquisitionError && error.code === "network_unavailable",
  );
  await assert.rejects(
    acquireNpmSource(
      {
        kind: "npm",
        registryOrigin: "https://registry.example",
        packageName: "safe-pkg",
        requested: "latest",
      },
      { destination: join(await temporary("npm-offline-missing"), "snapshot"), offline: true },
      { fetch: fetcher },
    ),
    (error: unknown) => error instanceof AcquisitionError && error.code === "source_mutable",
  );
  await assert.rejects(
    acquireNpmSource(
      {
        kind: "npm",
        registryOrigin: "https://registry.example",
        packageName: "safe-pkg",
        requested: "latest",
      },
      {
        destination: join(await temporary("npm-traversal"), "snapshot"),
        approvedRedirectOrigins: ["https://cdn.example"],
      },
      { fetch: fetcher },
    ),
    (error: unknown) => error instanceof AcquisitionError && error.code === "archive_path_invalid",
  );

  const badLock: NpmSourceLock = {
    kind: "npm",
    registryOrigin: "https://registry.example",
    packageName: "safe-pkg",
    version: "1.0.0",
    integrity,
    tarballSha256: "0".repeat(64),
    tarballUrl: "https://cdn.example/pkg.tgz",
  };
  const cache = new MemoryCache();
  await cache.write(`npm-sha512-${createHash("sha256").update(integrity).digest("hex")}`, artifact);
  await assert.rejects(
    acquireNpmSource(
      {
        kind: "npm",
        registryOrigin: "https://registry.example",
        packageName: "safe-pkg",
        requested: "1.0.0",
      },
      {
        destination: join(await temporary("npm-integrity"), "snapshot"),
        offline: true,
        lock: badLock,
      },
      { cache },
    ),
    (error: unknown) => error instanceof AcquisitionError && error.code === "integrity_mismatch",
  );
});

test("bounded tar extraction rejects links and file limits", async () => {
  await assert.rejects(
    extractBoundedTar(
      tar([{ path: "link", type: "2" }]),
      join(await temporary("tar-link"), "snapshot"),
    ),
    (error: unknown) =>
      error instanceof AcquisitionError && error.code === "archive_entry_unsupported",
  );
  await assert.rejects(
    extractBoundedTar(
      tar([{ path: "large", content: "12345" }]),
      join(await temporary("tar-limit"), "snapshot"),
      {
        limits: {
          maxEntries: 2,
          maxFiles: 1,
          maxTotalBytes: 4,
          maxFileBytes: 4,
          maxPathBytes: 30,
          maxDepth: 3,
        },
      },
    ),
    (error: unknown) =>
      error instanceof AcquisitionError && error.code === "archive_limit_exceeded",
  );
});

test("git accepts only credential-free HTTPS and runs a constrained fetch into a bounded snapshot", async () => {
  for (const invalid of [
    "http://example.com/a.git",
    "ssh://example.com/a.git",
    "git@example.com:a.git",
    "https://user:pass@example.com/a.git",
    "ext::helper a",
  ]) {
    assert.throws(() => normalizeGitRepositoryUri(invalid), AcquisitionError);
  }
  assert.equal(
    normalizeGitRepositoryUri("https://EXAMPLE.com/org/repo.git/"),
    "https://example.com/org/repo.git",
  );

  const archive = tar([
    { path: "package.json", content: "{}" },
    { path: "src/index.ts", content: "export {};" },
  ]);
  const calls: Array<{ args: readonly string[]; env: Readonly<Record<string, string>> }> = [];
  const runner: GitCommandRunner = {
    async run(_executable, args, options) {
      calls.push({ args, env: options.env });
      const command = args.includes("rev-parse")
        ? "commit"
        : args.includes("--format=%T")
          ? "tree"
          : args.includes("ls-tree")
            ? "inventory"
            : args.includes("archive")
              ? "archive"
              : "other";
      return {
        exitCode: 0,
        stdout:
          command === "commit"
            ? Buffer.from(`${"a".repeat(40)}\n`)
            : command === "tree"
              ? Buffer.from(`${"b".repeat(40)}\n`)
              : command === "inventory"
                ? Buffer.from(
                    `100644 blob ${"c".repeat(40)}\tpackage.json\0${`100644 blob ${"d".repeat(40)}\tsrc/index.ts\0`}`,
                  )
                : command === "archive"
                  ? archive
                  : new Uint8Array(),
        stderr: new Uint8Array(),
      };
    },
  };
  const destination = join(await temporary("git"), "snapshot");
  const result = await acquireGitSource(
    { kind: "git", repositoryUri: "https://example.com/org/repo.git", requestedRef: "v1.2.3" },
    { destination },
    runner,
  );
  assert.equal(result.lock.commit, "a".repeat(40));
  assert.equal(result.lock.repositoryTreeObject, "b".repeat(40));
  assert.match(result.lock.treeSha256, /^[0-9a-f]{64}$/);
  assert.equal(await readFile(join(destination, "src/index.ts"), "utf8"), "export {};");
  const fetchCall = calls.find((call) => call.args.includes("fetch"));
  assert.ok(fetchCall);
  assert.ok(fetchCall.args.includes("--no-tags"));
  assert.ok(fetchCall.args.includes("submodule.recurse=false"));
  assert.equal(fetchCall.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(fetchCall.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(fetchCall.env.GIT_ASKPASS, "");
  assert.equal(
    calls.some((call) => call.args.some((argument) => argument.includes("submodule update"))),
    false,
  );
});

test("git rejects submodules and LFS pointers as unsupported surfaces", async () => {
  const archive = tar([
    {
      path: "asset.bin",
      content: "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n",
    },
  ]);
  const runner = (inventory: string): GitCommandRunner => ({
    async run(_executable, args) {
      return {
        exitCode: 0,
        stdout: args.includes("rev-parse")
          ? Buffer.from("a".repeat(40))
          : args.includes("--format=%T")
            ? Buffer.from("b".repeat(40))
            : args.includes("ls-tree")
              ? Buffer.from(inventory)
              : args.includes("archive")
                ? archive
                : new Uint8Array(),
        stderr: new Uint8Array(),
      };
    },
  });
  await assert.rejects(
    acquireGitSource(
      { kind: "git", repositoryUri: "https://example.com/repo.git", requestedRef: "main" },
      { destination: join(await temporary("git-submodule"), "snapshot") },
      runner(`160000 commit ${"c".repeat(40)}\tvendor/dep\0`),
    ),
    (error: unknown) => error instanceof AcquisitionError && error.code === "git_unsupported",
  );
  await assert.rejects(
    acquireGitSource(
      { kind: "git", repositoryUri: "https://example.com/repo.git", requestedRef: "main" },
      { destination: join(await temporary("git-lfs"), "snapshot") },
      runner(`100644 blob ${"c".repeat(40)}\tasset.bin\0`),
    ),
    (error: unknown) => error instanceof AcquisitionError && error.code === "git_unsupported",
  );
});
