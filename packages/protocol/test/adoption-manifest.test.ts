// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { parseAdoptionManifest } from "../src/adoption-manifest.ts";

const sha = "a".repeat(64);
const manifest = {
  version: 1,
  adoptionId: "018f1f60-7b2a-7ccd-8f7a-4c57d8532d91",
  revisionId: "018f1f60-7b2a-7ccd-8f7a-4c57d8532d92",
  ecosystem: "pi",
  scope: "global",
  packageId: "@example/package",
  sourceUri: "https://registry.npmjs.org/@example/package",
  sourceLock: {
    kind: "npm",
    registryOrigin: "https://registry.npmjs.org",
    packageName: "@example/package",
    version: "1.0.0",
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    tarballSha256: sha,
  },
  sourceContentSha256: sha,
  fileInventorySha256: sha,
  sourceFiles: [{ path: "package.json", sha256: sha, sizeBytes: 2, executable: false }],
  license: { files: [], notices: [], warnings: [] },
  model: {
    converterVersion: "native-1",
    targetContractVersion: "1",
    requestSettings: {},
  },
  surfaces: [
    {
      surfaceId: "tool",
      kind: "extension",
      name: "tool",
      primary: true,
      executable: true,
      compatibility: "adapted",
      rationale: "Converted through the reviewed contract",
      generatedPaths: ["index.js"],
    },
  ],
  requestedCapabilities: ["tool.register"],
  approvedCapabilities: ["tool.register"],
  deniedCapabilities: [],
  generatedFiles: [{ path: "index.js", sha256: sha, sizeBytes: 10, executable: false }],
  dependencies: [],
  verification: {
    verifierVersion: "1",
    environment: "sandbox-image@sha256:abc",
    sandboxControls: ["no-network"],
    steps: [{ name: "typecheck", version: "1", status: "passed" }],
  },
  unsupportedBehavior: [],
  partialAdoptionAcknowledged: false,
  approvals: [
    {
      approvalId: "018f1f60-7b2a-7ccd-8f7a-4c57d8532d93",
      kind: "activation",
      actorId: "local-user",
      approvedAt: "2026-03-01T00:00:00.000Z",
      bindingSha256: sha,
    },
  ],
  overlayHashes: [],
} as const;

test("parses a complete versioned adoption manifest", () => {
  const parsed = parseAdoptionManifest(manifest);
  assert.equal(parsed.packageId, "@example/package");
  assert.equal(parsed.surfaces[0]?.compatibility, "adapted");
  assert.ok(Object.isFrozen(parsed));
});

test("rejects unknown fields, credentials, and ambiguous primary surfaces", () => {
  assert.throws(() => parseAdoptionManifest({ ...manifest, extra: true }), /extra.*not allowed/);
  assert.throws(
    () => parseAdoptionManifest({ ...manifest, sourceUri: "https://user:secret@example.com/a" }),
    /credential-free/,
  );
  assert.throws(
    () =>
      parseAdoptionManifest({
        ...manifest,
        model: { ...manifest.model, requestSettings: { authToken: "secret" } },
      }),
    /credentials/,
  );
  assert.throws(() => parseAdoptionManifest({ ...manifest, surfaces: [] }), /primary surface/);
});

test("enforces immutable identity and cross-field adoption invariants", () => {
  assert.throws(
    () =>
      parseAdoptionManifest({
        ...manifest,
        surfaces: [{ ...manifest.surfaces[0], compatibility: "unsupported" }],
      }),
    /primary surface must not be unsupported/,
  );
  assert.throws(
    () =>
      parseAdoptionManifest({
        ...manifest,
        surfaces: [
          manifest.surfaces[0],
          {
            ...manifest.surfaces[0],
            surfaceId: "secondary",
            primary: false,
            compatibility: "unsupported",
          },
        ],
      }),
    /partial approval for unsupported non-primary surfaces/,
  );
  assert.throws(
    () => parseAdoptionManifest({ ...manifest, approvedCapabilities: ["network.client"] }),
    /disjoint approved and denied capabilities/,
  );
  assert.throws(
    () =>
      parseAdoptionManifest({
        ...manifest,
        generatedFiles: [],
      }),
    /absent from generatedFiles/,
  );
  assert.throws(
    () =>
      parseAdoptionManifest({
        ...manifest,
        sourceLock: {
          kind: "local-snapshot",
          treeSha256: "b".repeat(64),
          fileCount: 1,
          sizeBytes: 2,
        },
      }),
    /must match the immutable source tree/,
  );
});

test("rejects unsafe generated paths and malformed file hashes", () => {
  assert.throws(
    () =>
      parseAdoptionManifest({
        ...manifest,
        generatedFiles: [{ path: "../escape", sha256: sha, sizeBytes: 1, executable: false }],
      }),
    /canonical relative path/,
  );
  assert.throws(
    () =>
      parseAdoptionManifest({
        ...manifest,
        generatedFiles: [{ path: "file", sha256: "bad", sizeBytes: 1, executable: false }],
      }),
    /SHA-256/,
  );
});
