// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  ADOPTION_CAPABILITIES,
  ADOPTION_COMPATIBILITY_VALUES,
  ADOPTION_ECOSYSTEMS,
  ADOPTION_OPERATION_STATES,
  ADOPTION_RESOURCE_KINDS,
  ADOPTION_SCOPES,
  hashCanonicalRequest,
  isRetryableMutationMethod,
  parseAdoptionCandidateId,
  parseAdoptionOperationDetail,
  parseAdoptionOperationId,
  parseAdoptionOperationState,
  parseAdoptionResourceKind,
  parseAdoptionSourceLocator,
  parseServerMessage,
  parseWireRequest,
  ProtocolValidationError,
  requiredCapability,
  RPC_METHOD_ERROR_CODES,
} from "../src/index.ts";

const candidateId = "018f0000-0000-8000-8000-000000000001";
const operationId = "018f0000-0000-7000-8000-000000000002";
const subscriptionId = "018f0000-0000-7000-8000-000000000003";
const idempotencyKey = "00000000-0000-4000-8000-000000000020";
const digest = "a".repeat(64);

function discover(query = "math") {
  return {
    kind: "request",
    id: 1,
    method: "adoption.discover",
    params: { ecosystems: ["opencode"], scopes: ["project"], query, pageSize: 100 },
  } as const;
}

function start() {
  return {
    kind: "request",
    id: 2,
    method: "adoption.start",
    params: { operationId },
    idempotencyKey,
  } as const;
}

test("exports the closed adoption vocabulary", () => {
  assert.deepEqual(ADOPTION_ECOSYSTEMS, ["opencode", "dsh", "claude-code", "pi"]);
  assert.deepEqual(ADOPTION_SCOPES, ["global", "project"]);
  assert.deepEqual(ADOPTION_COMPATIBILITY_VALUES, ["native", "adapted", "isolated", "unsupported"]);
  assert.ok(ADOPTION_RESOURCE_KINDS.includes("mcp-server"));
  assert.ok(ADOPTION_OPERATION_STATES.includes("awaiting-activation-approval"));
  assert.equal(parseAdoptionResourceKind("workflow"), "workflow");
  assert.equal(parseAdoptionOperationState("blocked"), "blocked");
});

test("strictly validates versioned adoption identifiers", () => {
  assert.equal(parseAdoptionCandidateId(candidateId), candidateId);
  assert.equal(parseAdoptionOperationId(operationId), operationId);
  assert.throws(() => parseAdoptionCandidateId(operationId), ProtocolValidationError);
  assert.throws(() => parseAdoptionOperationId(candidateId), ProtocolValidationError);
  assert.throws(() => parseAdoptionOperationId(operationId.toUpperCase()), ProtocolValidationError);
});

test("maps every adoption method to a narrow capability", () => {
  assert.equal(requiredCapability("adoption.discover"), "adoption.discover");
  assert.equal(requiredCapability("adoption.inspect"), "adoption.inspect");
  assert.equal(requiredCapability("adoption.operation.get"), "adoption.read");
  assert.equal(requiredCapability("adoption.operation.cancel"), "adoption.cancel");
  assert.equal(
    requiredCapability("adoption.operation.approveActivation"),
    "adoption.approve-activation",
  );
  assert.equal(requiredCapability("adoption.disable"), "adoption.remove");
  assert.equal(new Set(ADOPTION_CAPABILITIES).size, ADOPTION_CAPABILITIES.length);
});

test("does not let discovery authority imply mutation authority", () => {
  assert.notEqual(requiredCapability("adoption.discover"), requiredCapability("adoption.start"));
  assert.notEqual(requiredCapability("adoption.discover"), requiredCapability("adoption.update"));
  assert.notEqual(requiredCapability("adoption.discover"), requiredCapability("adoption.purge"));
});

test("requires idempotency keys exactly for replay-safe adoption mutations", () => {
  assert.equal(isRetryableMutationMethod("adoption.start"), true);
  assert.equal(isRetryableMutationMethod("adoption.discover"), false);
  assert.deepEqual(parseWireRequest(start()), start());
  const { idempotencyKey: _, ...withoutKey } = start();
  assert.throws(() => parseWireRequest(withoutKey), ProtocolValidationError);
  assert.throws(() => parseWireRequest({ ...discover(), idempotencyKey }), ProtocolValidationError);
  assert.ok(RPC_METHOD_ERROR_CODES["adoption.start"].includes("idempotency_conflict"));
  const first = parseWireRequest(start());
  const second = parseWireRequest({
    ...start(),
    params: { operationId: "018f0000-0000-7000-8000-000000000099" },
  });
  if (first.method !== "adoption.start" || second.method !== "adoption.start") assert.fail();
  assert.notEqual(
    hashCanonicalRequest(first.method, first.params),
    hashCanonicalRequest(second.method, second.params),
    "the same idempotency key with a different body has a distinct conflict fingerprint",
  );
});

test("rejects unknown fields and invalid enum values at adoption boundaries", () => {
  assert.throws(
    () =>
      parseWireRequest({ ...discover(), params: { ...discover().params, credential: "secret" } }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseWireRequest({ ...discover(), params: { ...discover().params, ecosystems: ["other"] } }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseWireRequest({
        ...discover(),
        params: { ...discover().params, scopes: ["project", "project"] },
      }),
    ProtocolValidationError,
  );
  const { pageSize: _, ...missingPageSize } = discover().params;
  assert.throws(
    () => parseWireRequest({ ...discover(), params: missingPageSize }),
    ProtocolValidationError,
  );
});

test("accepts maximum text values and rejects one byte over", () => {
  assert.doesNotThrow(() => parseWireRequest(discover("x".repeat(256))));
  assert.throws(() => parseWireRequest(discover("x".repeat(257))), ProtocolValidationError);
  assert.throws(
    () => parseWireRequest({ ...discover(), params: { ...discover().params, pageSize: 101 } }),
    ProtocolValidationError,
  );
});

test("rejects credentials and ambiguous URL identity", () => {
  assert.throws(
    () =>
      parseAdoptionSourceLocator({
        kind: "npm",
        registryOrigin: "https://token@registry.example.test",
        packageName: "safe-package",
        requested: "1.0.0",
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseAdoptionSourceLocator({
        kind: "npm",
        registryOrigin: "https://registry.example.test",
        packageName: "../escape",
        requested: "1.0.0",
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseWireRequest({
        kind: "request",
        id: 3,
        method: "adoption.update",
        idempotencyKey,
        params: { adoptionId: operationId, previewOnly: true, token: "secret" },
      }),
    ProtocolValidationError,
  );
});

test("validates bounded resumable adoption progress without source bodies", () => {
  const delivery = {
    kind: "adoption_operation",
    subscriptionId,
    cursor: "cursor-2",
    operation: {
      operationId,
      state: "verifying",
      phase: "verification",
      statusText: "Running checks",
      sequence: 4,
      createdAt: 1,
      updatedAt: 2,
      progress: { completed: 1, total: 2, unit: "checks" },
    },
  } as const;
  assert.deepEqual(parseServerMessage(delivery), delivery);
  assert.throws(
    () =>
      parseServerMessage({
        ...delivery,
        sourceText: "must not cross progress delivery",
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseServerMessage({
        ...delivery,
        operation: { ...delivery.operation, statusText: "x".repeat(513) },
      }),
    ProtocolValidationError,
  );
});

test("accepts canonical POSIX and Windows local paths and rejects ambiguous forms", () => {
  for (const canonicalPath of [
    "/",
    `/${"a".repeat(4_095)}`,
    "/home/user/project",
    "C:\\",
    "C:\\Users\\User\\project",
    "\\\\server\\share",
    "\\\\server\\share\\project",
  ]) {
    assert.deepEqual(parseAdoptionSourceLocator({ kind: "local", canonicalPath }), {
      kind: "local",
      canonicalPath,
    });
  }

  for (const canonicalPath of [
    "relative/path",
    "./relative",
    "../escape",
    "/tmp/../escape",
    "/tmp//file",
    "/tmp/",
    "/tmp/\u0000file",
    "/tmp/e\u0301",
    `/${"a".repeat(4_096)}`,
    "c:\\project",
    "C:/project",
    "C:\\project\\..\\escape",
    "C:\\project\\NUL.txt",
    "C:\\project\\trailing. ",
    "\\\\server",
    "\\\\server\\share\\",
  ]) {
    assert.throws(
      () => parseAdoptionSourceLocator({ kind: "local", canonicalPath }),
      ProtocolValidationError,
      canonicalPath,
    );
  }
});

test("pages operation and revision details across the 10,000-surface bound", () => {
  const surfaces = Array.from({ length: 100 }, (_, index) => ({
    surfaceId: index.toString(16).padStart(64, "0"),
    kind: "extension",
    name: `tool-${index}`,
    primary: index === 0,
    executable: true,
    compatibility: "adapted",
    requiredCapabilities: [],
    diagnosticCount: 0,
    dynamicBehavior: "none",
  }));
  const compatibility = {
    primarySurfaceId: surfaces[0]?.surfaceId,
    overall: "adapted",
    surfaceCount: 10_000,
    unsupportedSurfaceCount: 0,
    partialAcknowledgementRequired: false,
    surfaces,
  };
  const detail = {
    operationId,
    state: "inspected",
    phase: "inspection",
    statusText: "Inspection complete",
    sequence: 2,
    createdAt: 1,
    updatedAt: 2,
    compatibility,
    capabilityRequests: [],
    diagnosticCount: 0,
    detailOffset: 0,
    diagnostics: [],
    nextDetailPageCursor: "detail-page-2",
  };
  assert.deepEqual(parseAdoptionOperationDetail(detail), detail);
  assert.deepEqual(
    parseWireRequest({
      kind: "request",
      id: 10,
      method: "adoption.operation.get",
      params: { operationId, detailPageSize: 100, detailPageCursor: "detail-page-2" },
    }),
    {
      kind: "request",
      id: 10,
      method: "adoption.operation.get",
      params: { operationId, detailPageSize: 100, detailPageCursor: "detail-page-2" },
    },
  );

  const adoptionId = "018f0000-0000-7000-8000-000000000004";
  const revisionId = "018f0000-0000-7000-8000-000000000005";
  const revisionResult = {
    adoption: {
      adoptionId,
      displayName: "large package",
      ecosystem: "opencode",
      scope: "project",
      enabled: true,
      activeRevisionId: revisionId,
      revisionCount: 1,
    },
    revision: {
      revisionId,
      createdAt: 1,
      active: true,
      manifestSha256: digest,
      compatibility: "adapted",
    },
    compatibility,
    verification: { status: "passed", steps: [], evidenceSha256: digest },
    diagnosticCount: 0,
    detailOffset: 0,
    diagnostics: [],
    nextDetailPageCursor: "detail-page-2",
  };
  assert.deepEqual(
    parseWireRequest({
      kind: "request",
      id: 11,
      method: "adoption.revision.get",
      params: { adoptionId, revisionId, detailPageSize: 100, detailPageCursor: "detail-page-2" },
    }),
    {
      kind: "request",
      id: 11,
      method: "adoption.revision.get",
      params: { adoptionId, revisionId, detailPageSize: 100, detailPageCursor: "detail-page-2" },
    },
  );
  assert.equal(
    parseServerMessage({
      kind: "success",
      id: 12,
      method: "adoption.revision.get",
      result: revisionResult,
    }).kind,
    "success",
  );
  assert.doesNotThrow(() =>
    parseAdoptionOperationDetail({
      ...detail,
      detailOffset: 9_900,
      compatibility: {
        ...compatibility,
        surfaces: surfaces.map((surface) => ({ ...surface, primary: false })),
      },
      nextDetailPageCursor: undefined,
    }),
  );
  assert.throws(
    () => parseAdoptionOperationDetail({ ...detail, nextDetailPageCursor: undefined }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseAdoptionOperationDetail({
        ...detail,
        compatibility: { ...compatibility, surfaces: [surfaces[0], surfaces[0]] },
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseAdoptionOperationDetail({
        ...detail,
        diagnosticCount: 1,
        diagnostics: [{ code: "extra", severity: "warning", message: "extra detail" }],
      }),
    ProtocolValidationError,
  );
});

test("represents a 20,000-file disclosure by immutable metadata blob", () => {
  const base = {
    operationId,
    state: "awaiting-plan-approval",
    phase: "review",
    statusText: "Review source disclosure",
    sequence: 3,
    createdAt: 1,
    updatedAt: 2,
    capabilityRequests: [],
    diagnosticCount: 0,
    detailOffset: 0,
    diagnostics: [],
  } as const;
  const disclosure = {
    manifestSha256: digest,
    providerId: "provider-1",
    modelId: "model-1",
    endpointLocation: "remote",
    fileCount: 20_000,
    filesSha256: "b".repeat(64),
    totalBytes: 67_108_864,
    files: [{ relativePath: "src/index.ts", sha256: digest, sizeBytes: 100 }],
    filesBlob: {
      sha256: "b".repeat(64),
      mediaType: "application/vnd.axl.adoption-disclosure+json",
      sizeBytes: 80 * 1_024 * 1_024,
    },
    retentionMetadataRevision: "policy-1",
  } as const;
  assert.deepEqual(parseAdoptionOperationDetail({ ...base, disclosure }), {
    ...base,
    disclosure,
  });
  const smallDisclosure = {
    ...disclosure,
    fileCount: 1,
    filesSha256: digest,
    files: [{ relativePath: "src/index.ts", sha256: digest, sizeBytes: 100 }],
    filesBlob: undefined,
  };
  assert.deepEqual(parseAdoptionOperationDetail({ ...base, disclosure: smallDisclosure }), {
    ...base,
    disclosure: {
      manifestSha256: digest,
      providerId: "provider-1",
      modelId: "model-1",
      endpointLocation: "remote",
      fileCount: 1,
      filesSha256: digest,
      totalBytes: 67_108_864,
      files: [{ relativePath: "src/index.ts", sha256: digest, sizeBytes: 100 }],
      retentionMetadataRevision: "policy-1",
    },
  });
  assert.throws(
    () =>
      parseAdoptionOperationDetail({ ...base, disclosure: { ...disclosure, fileCount: 20_001 } }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseAdoptionOperationDetail({
        ...base,
        disclosure: { ...disclosure, filesSha256: digest },
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseAdoptionOperationDetail({
        ...base,
        disclosure: {
          ...disclosure,
          fileCount: 101,
          files: Array.from({ length: 101 }, (_, index) => ({
            relativePath: `src/file-${index}.ts`,
            sha256: digest,
            sizeBytes: 1,
          })),
        },
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseAdoptionOperationDetail({
        ...base,
        disclosure: { ...disclosure, filesBlob: undefined },
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseAdoptionOperationDetail({
        ...base,
        disclosure: {
          ...disclosure,
          fileCount: 1,
          filesBlob: undefined,
          files: [{ relativePath: "src/index.ts", sha256: digest, sizeBytes: 100, content: "no" }],
        },
      }),
    ProtocolValidationError,
  );
});

test("enforces the aggregate adoption result byte limit", () => {
  const longPath = (index: number) => `src/${index}-${"a".repeat(4_080)}`;
  const surfaces = Array.from({ length: 100 }, (_, index) => ({
    surfaceId: index.toString(16).padStart(64, "0"),
    kind: "extension",
    name: `tool-${index}`,
    relativePath: longPath(index),
    primary: index === 0,
    executable: true,
    compatibility: "adapted",
    requiredCapabilities: [],
    diagnosticCount: 0,
    dynamicBehavior: "none",
  }));
  const files = Array.from({ length: 100 }, (_, index) => ({
    relativePath: longPath(index),
    sha256: digest,
    sizeBytes: 1,
  }));
  assert.throws(
    () =>
      parseAdoptionOperationDetail({
        operationId,
        state: "inspected",
        phase: "inspection",
        statusText: "Inspection complete",
        sequence: 2,
        createdAt: 1,
        updatedAt: 2,
        compatibility: {
          primarySurfaceId: surfaces[0]?.surfaceId,
          overall: "adapted",
          surfaceCount: 100,
          unsupportedSurfaceCount: 0,
          partialAcknowledgementRequired: false,
          surfaces,
        },
        capabilityRequests: [],
        disclosure: {
          manifestSha256: digest,
          providerId: "provider-1",
          modelId: "model-1",
          endpointLocation: "remote",
          fileCount: 100,
          filesSha256: digest,
          totalBytes: 100,
          files,
          retentionMetadataRevision: "policy-1",
        },
        diagnosticCount: 0,
        detailOffset: 0,
        diagnostics: [],
      }),
    ProtocolValidationError,
  );
});

test("validates inspection primary surfaces and bounded source identity", () => {
  const candidate = {
    candidateId,
    discoveryFingerprint: digest,
    ecosystem: "opencode",
    scope: "project",
    kind: "package",
    displayName: "math tools",
    source: {
      kind: "git",
      repositoryUri: "https://github.com/example/tools.git",
      requestedRef: "main",
    },
    relativeResourcePath: ".opencode/tools/math.ts",
    primary: true,
    executable: true,
    warningCount: 0,
    malformed: false,
  } as const;
  const result = {
    candidate,
    adapter: { id: "opencode", version: "1", sourceSchemaVersion: "1" },
    license: { expressions: ["MIT"], notices: [] },
    inventory: { fileCount: 1, totalBytes: 10, executable: true },
    limits: {
      maxTraversalDepth: 32,
      maxEntries: 50_000,
      maxFiles: 20_000,
      maxTotalBytes: 67_108_864,
      maxFileBytes: 1_048_576,
      maxManifestBytes: 262_144,
    },
    surfaceCount: 1,
    diagnosticCount: 0,
    detailOffset: 0,
    surfaces: [
      {
        surfaceId: digest,
        kind: "extension",
        name: "math_add",
        relativePath: ".opencode/tools/math.ts",
        primary: true,
        executable: true,
        compatibility: "adapted",
        requiredCapabilities: [],
        diagnosticCount: 0,
        dynamicBehavior: "none",
      },
    ],
    diagnostics: [],
  } as const;
  assert.deepEqual(
    parseServerMessage({ kind: "success", id: 9, method: "adoption.inspect", result }),
    { kind: "success", id: 9, method: "adoption.inspect", result },
  );
  assert.throws(
    () =>
      parseServerMessage({
        kind: "success",
        id: 9,
        method: "adoption.inspect",
        result: { ...result, surfaceCount: 10_000 },
      }),
    ProtocolValidationError,
  );
  assert.equal(
    parseServerMessage({
      kind: "success",
      id: 9,
      method: "adoption.inspect",
      result: { ...result, surfaceCount: 10_000, nextPageCursor: "page-2" },
    }).kind,
    "success",
  );
  assert.throws(
    () =>
      parseServerMessage({
        kind: "success",
        id: 9,
        method: "adoption.inspect",
        result: {
          ...result,
          candidate: {
            ...candidate,
            source: { ...candidate.source, repositoryUri: "https://token@example.com/tools.git" },
          },
        },
      }),
    ProtocolValidationError,
  );
});
