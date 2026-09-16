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
