// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AcquisitionError,
  materializeNpmDependencyLock,
  PINNED_NPM_RESOLVER_VERSION,
  resolveNpmDependencyLock,
  validateNpmLockfileV3,
} from "../src/index.ts";

const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;

function lockfile() {
  return {
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
        dependencies: { child: "2.0.0" },
      },
      "node_modules/root/node_modules/child": {
        version: "2.0.0",
        resolved: "https://registry.example/child.tgz",
        integrity,
      },
    },
  };
}

test("validates bounded npm lockfile-v3 registry dependency graphs", () => {
  const parsed = validateNpmLockfileV3(lockfile());
  assert.deepEqual(
    parsed.packages.map((item) => [item.path, item.name, item.version]),
    [
      ["node_modules/root", "root", "1.0.0"],
      ["node_modules/root/node_modules/child", "child", "2.0.0"],
    ],
  );
  assert.throws(
    () =>
      validateNpmLockfileV3({
        ...lockfile(),
        packages: {
          ...lockfile().packages,
          "node_modules/root": {
            ...lockfile().packages["node_modules/root"],
            hasInstallScript: true,
          },
        },
      }),
    AcquisitionError,
  );
  assert.throws(
    () =>
      validateNpmLockfileV3({
        ...lockfile(),
        packages: {
          ...lockfile().packages,
          "node_modules/root": {
            ...lockfile().packages["node_modules/root"],
            dependencies: { missing: "1.0.0" },
          },
        },
      }),
    /no locked package/,
  );
  assert.throws(
    () =>
      validateNpmLockfileV3(lockfile(), {
        expectedRootDependencies: { other: "1.0.0" },
      }),
    /root dependencies do not match/,
  );
  assert.throws(
    () =>
      validateNpmLockfileV3(lockfile(), {
        approvedArtifactOrigins: ["https://approved.example"],
      }),
    /unapproved registry origin/,
  );
  assert.throws(
    () =>
      validateNpmLockfileV3(
        {
          ...lockfile(),
          packages: {
            ...lockfile().packages,
            "node_modules/root": {
              ...lockfile().packages["node_modules/root"],
              os: ["darwin"],
            },
          },
        },
        { target: { nodeVersion: "22.0.0", os: "linux", cpu: "x64" } },
      ),
    /incompatible with the target platform/,
  );
});

test("accepts only the pinned no-script sandbox resolver contract", async () => {
  const parsed = await resolveNpmDependencyLock("root", "1.0.0", "https://registry.example", {
    async resolve(input) {
      assert.deepEqual(input.syntheticManifest.dependencies, { root: "1.0.0" });
      return {
        npmVersion: PINNED_NPM_RESOLVER_VERSION,
        command: ["install", "--package-lock-only", "--ignore-scripts"],
        noSourceMount: true,
        noAmbientCredentials: true,
        lockfile: lockfile(),
      };
    },
  });
  assert.equal(parsed.packages.length, 2);

  await assert.rejects(
    resolveNpmDependencyLock("root", "1.0.0", "https://registry.example", {
      async resolve() {
        return {
          npmVersion: PINNED_NPM_RESOLVER_VERSION,
          command: ["install", "--package-lock-only", "--ignore-scripts"],
          noSourceMount: false as never,
          noAmbientCredentials: true,
          lockfile: lockfile(),
        };
      },
    }),
    /sandbox contract/,
  );
});

test("materializes each dependency at its locked path without creating bin shims", async () => {
  const root = await mkdtemp(join(tmpdir(), "axl-npm-lock-"));
  try {
    const parsed = validateNpmLockfileV3(lockfile());
    const visited: string[] = [];
    const locks = await materializeNpmDependencyLock(
      parsed,
      join(root, "tree"),
      async (item, target) => {
        visited.push(`${item.path}:${target}`);
        return {
          lock: {
            kind: "npm",
            registryOrigin: "https://registry.example",
            packageName: item.name,
            version: item.version,
            integrity: item.integrity,
            tarballSha256: "a".repeat(64),
          },
          sourceUri: item.resolved,
          snapshot: { files: [], fileCount: 0, sizeBytes: 0, treeSha256: "b".repeat(64) },
          redirects: [],
          finalOrigin: "https://registry.example",
          fromCache: false,
        };
      },
    );
    assert.equal(locks.length, 2);
    assert.equal(
      visited.some((entry) => entry.includes("node_modules/.bin")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
