// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitCommandRunner } from "@axl/compiler";
import { AdoptionStore } from "@axl/daemon";
import {
  parseAdoptionManifest,
  parseAdoptionOperationId,
  parseAdoptionRevisionId,
} from "@axl/protocol";
import { AdoptionAcquisitionCoordinator } from "../src/adoption-acquisition.ts";

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
}

async function makeWritable(path: string): Promise<void> {
  let information: Stats;
  try {
    information = await lstat(path);
  } catch {
    return;
  }
  if (information.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await makeWritable(join(path, entry));
  } else if (information.isFile()) await chmod(path, 0o600);
}

function tar(path: string, content: string): Buffer {
  const bytes = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  octal(0o644, 8).copy(header, 100);
  octal(bytes.length, 12).copy(header, 124);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  octal(
    [...header].reduce((sum, byte) => sum + byte, 0),
    8,
  ).copy(header, 148);
  return Buffer.concat([
    header,
    bytes,
    Buffer.alloc((512 - (bytes.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
}

const operationId = parseAdoptionOperationId("018f1f60-7b2a-7ccd-8f7a-4c57d8532d90");
const revisionId = parseAdoptionRevisionId("018f1f60-7b2a-7ccd-8f7a-4c57d8532d92");
function runner(archive: Uint8Array): GitCommandRunner {
  return {
    async run(executable, args) {
      assert.equal(executable, "/opt/axl/bin/git");
      return {
        exitCode: 0,
        stdout: args.includes("rev-parse")
          ? Buffer.from("a".repeat(40))
          : args.includes("--format=%T")
            ? Buffer.from("b".repeat(40))
            : args.includes("ls-tree")
              ? Buffer.from(`100644 blob ${"c".repeat(40)}\tpackage.json\0`)
              : args.includes("archive")
                ? archive
                : new Uint8Array(),
        stderr: new Uint8Array(),
      };
    },
  };
}

test("npm acquisition validates and materializes its dependency closure before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "axl-npm-acquisition-integration-"));
  try {
    const store = new AdoptionStore(root);
    await store.initialize();
    const coordinator = new AdoptionAcquisitionCoordinator(store);
    const packageArchive = tar(
      "package/package.json",
      JSON.stringify({
        name: "root",
        version: "1.0.0",
        optionalDependencies: { child: "2.0.0" },
        peerDependencies: { peer: "3.0.0" },
      }),
    );
    const integrity = `sha512-${createHash("sha512").update(packageArchive).digest("base64")}`;
    const published = await coordinator.acquireAndPublish({
      operationId,
      locator: {
        kind: "npm",
        registryOrigin: "https://registry.example",
        packageName: "root",
        requested: "1.0.0",
      },
      selectionKind: "explicit",
      npm: {},
      npmDependencies: {
        fetch: async (input) =>
          String(input).endsWith(".tgz")
            ? new Response(packageArchive)
            : new Response(
                JSON.stringify({
                  "dist-tags": { latest: "1.0.0" },
                  versions: {
                    "1.0.0": {
                      name: "root",
                      version: "1.0.0",
                      dist: { integrity, tarball: "https://registry.example/root.tgz" },
                    },
                  },
                }),
              ),
      },
      npmLockResolver: {
        async resolve() {
          return {
            npmVersion: "10.9.8",
            command: ["install", "--package-lock-only", "--ignore-scripts"],
            noSourceMount: true,
            noAmbientCredentials: true,
            lockfile: {
              name: "axl-adoption-resolution",
              version: "0.0.0",
              lockfileVersion: 3,
              requires: true,
              packages: {
                "": { dependencies: { root: "1.0.0" } },
                "node_modules/root": {
                  version: "1.0.0",
                  resolved: "https://registry.example/root.tgz",
                  integrity,
                  optionalDependencies: { child: "2.0.0" },
                  peerDependencies: { peer: "3.0.0" },
                },
                "node_modules/root/node_modules/child": {
                  version: "2.0.0",
                  resolved: "https://registry.example/child.tgz",
                  integrity,
                },
                "node_modules/root/node_modules/peer": {
                  version: "3.0.0",
                  resolved: "https://registry.example/peer.tgz",
                  integrity,
                  peer: true,
                },
              },
            },
          };
        },
      },
      npmDependencyAcquirer: async (item, destination) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "package.json"), JSON.stringify({ name: item.name }));
        return {
          lock: {
            kind: "npm",
            registryOrigin: "https://registry.example",
            packageName: item.name,
            version: item.version,
            integrity: item.integrity,
            tarballSha256: "d".repeat(64),
          },
          sourceUri: item.resolved,
          snapshot: { files: [], fileCount: 0, sizeBytes: 0, treeSha256: "e".repeat(64) },
          redirects: [],
          finalOrigin: "https://registry.example",
          fromCache: false,
        };
      },
      createManifest(acquired) {
        const dependencies = acquired.dependencyLock?.packages.filter(
          (item) => item.name !== "root",
        );
        assert.equal(dependencies?.length, 2);
        return parseAdoptionManifest({
          version: 1,
          adoptionId: "018f1f60-7b2a-7ccd-8f7a-4c57d8532d91",
          revisionId,
          ecosystem: "pi",
          scope: "global",
          packageId: "root",
          sourceUri: acquired.sourceUri,
          sourceLock: acquired.lock,
          sourceContentSha256: acquired.sourceContentSha256,
          fileInventorySha256: acquired.fileInventorySha256,
          sourceFiles: acquired.sourceFiles,
          license: { files: [], notices: [], warnings: [] },
          model: { converterVersion: "native-1", targetContractVersion: "1", requestSettings: {} },
          surfaces: [
            {
              surfaceId: "primary",
              kind: "extension",
              name: "primary",
              primary: true,
              executable: false,
              compatibility: "native",
              rationale: "fixture",
              generatedPaths: [],
            },
          ],
          requestedCapabilities: [],
          approvedCapabilities: [],
          deniedCapabilities: [],
          generatedFiles: [],
          dependencies: (dependencies ?? []).map((dependency) => ({
            name: dependency.name,
            source: dependency.resolved,
            immutableIdentity: dependency.version,
            integrity: dependency.integrity,
            auditStatus: "passed",
          })),
          verification: {
            verifierVersion: "hash-v1",
            environment: "data-only",
            sandboxControls: ["no-execution"],
            steps: [{ name: "source-hashes", version: "1", status: "passed" }],
          },
          unsupportedBehavior: [],
          partialAdoptionAcknowledged: false,
          approvals: [],
          overlayHashes: [],
        });
      },
    });
    assert.deepEqual(
      published.manifest.dependencies.map((dependency) => dependency.name),
      ["child", "peer"],
    );
    assert.ok(published.manifest.sourceFiles.some((file) => file.path.includes("dependencies/")));
  } finally {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("Git acquisition publishes one provenance-bound immutable daemon revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "axl-acquisition-integration-"));
  try {
    const store = new AdoptionStore(root);
    await store.initialize();
    const coordinator = new AdoptionAcquisitionCoordinator(store);
    const published = await coordinator.acquireAndPublish({
      operationId,
      locator: {
        kind: "git",
        repositoryUri: "https://example.com/example.git",
        requestedRef: "main",
      },
      selectionKind: "explicit",
      gitExecutable: "/opt/axl/bin/git",
      gitRunner: runner(tar("package.json", "{}")),
      createManifest(acquired) {
        return parseAdoptionManifest({
          version: 1,
          adoptionId: "018f1f60-7b2a-7ccd-8f7a-4c57d8532d91",
          revisionId,
          ecosystem: "pi",
          scope: "global",
          packageId: "example",
          sourceUri: acquired.sourceUri,
          sourceLock: acquired.lock,
          sourceContentSha256: acquired.sourceContentSha256,
          fileInventorySha256: acquired.fileInventorySha256,
          sourceFiles: acquired.sourceFiles,
          license: { files: [], notices: [], warnings: [] },
          model: {
            converterVersion: "native-1",
            targetContractVersion: "1",
            requestSettings: {},
          },
          surfaces: [
            {
              surfaceId: "primary",
              kind: "extension",
              name: "primary",
              primary: true,
              executable: false,
              compatibility: "native",
              rationale: "declarative fixture",
              generatedPaths: [],
            },
          ],
          requestedCapabilities: [],
          approvedCapabilities: [],
          deniedCapabilities: [],
          generatedFiles: [],
          dependencies: [],
          verification: {
            verifierVersion: "hash-v1",
            environment: "data-only",
            sandboxControls: ["no-execution"],
            steps: [{ name: "source-hashes", version: "1", status: "passed" }],
          },
          unsupportedBehavior: [],
          partialAdoptionAcknowledged: false,
          approvals: [],
          overlayHashes: [],
        });
      },
    });
    assert.equal(published.manifest.sourceLock.kind, "git");
    assert.equal(
      published.manifest.sourceContentSha256,
      published.manifest.sourceLock.kind === "git"
        ? published.manifest.sourceLock.treeSha256
        : undefined,
    );
    assert.ok(published.manifest.sourceFiles.length > 0);
    const operation = await store.readAcquisitionOperation(operationId);
    assert.equal(operation?.state, "published");
    assert.equal(operation?.sequence, 3);
    assert.equal(operation?.sourceLock?.kind, "git");
    const registry = await store.updateRegistry(0, [
      {
        adoptionId: published.manifest.adoptionId,
        scope: "global",
        packageKey: "pi:example",
        activeRevisionId: revisionId,
      },
    ]);
    assert.equal(registry.generation, 1);
    assert.equal(
      (await store.readRevision("pi", "example", revisionId)).treeSha256,
      published.treeSha256,
    );
  } finally {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});
