// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  type AdoptionController,
  type AdoptionInspectResult,
  parseAdoptionCandidateId,
  parseAdoptionOperationId,
  parseAdoptionRevisionId,
} from "@axl/sdk";
import {
  adoptionCandidateDescription,
  groupAdoptionCandidates,
} from "../src/adoption-presentation.ts";
import { activateNativeSkill, adoptionTrustReviewPresentation } from "../src/adoption-workflow.ts";

const candidate = {
  candidateId: parseAdoptionCandidateId("123e4567-e89b-812d-a456-426614174000"),
  discoveryFingerprint: "a".repeat(64),
  ecosystem: "pi" as const,
  scope: "project" as const,
  kind: "extension" as const,
  displayName: "hello",
  source: { kind: "local" as const, canonicalPath: "/workspace/.pi/extensions/hello.ts" },
  relativeResourcePath: ".pi/extensions/hello.ts",
  primary: true,
  executable: true,
  resourceCount: 1,
  warningCount: 1,
  malformed: true,
};

test("web adoption presentation groups and labels executable malformed resources", () => {
  assert.deepEqual([...groupAdoptionCandidates([candidate]).keys()], ["pi · project"]);
  assert.equal(
    adoptionCandidateDescription(candidate),
    "extension · 1 resource · executable · malformed · 1 warning",
  );
});

const nativeCandidate = {
  ...candidate,
  kind: "skill" as const,
  displayName: "review-code",
  executable: false,
  malformed: false,
};

const report: AdoptionInspectResult = {
  candidate: nativeCandidate,
  adapter: { id: "axl.pi.discovery", version: "1", sourceSchemaVersion: "1" },
  license: { expressions: ["Apache-2.0"], notices: [] },
  inventory: { fileCount: 2, totalBytes: 42, executable: false },
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
  trustReview: {
    bindingSha256: "b".repeat(64),
    sourceContentSha256: "c".repeat(64),
    fileInventorySha256: "d".repeat(64),
    targetScope: "project",
    licenseExpressions: ["Apache-2.0"],
    licenseFiles: [
      { relativePath: "LICENSE", sha256: "e".repeat(64), sizeBytes: 10, executable: false },
    ],
    noticeFiles: [],
    declarativeFiles: [
      { relativePath: "SKILL.md", sha256: "a".repeat(64), sizeBytes: 32, executable: false },
    ],
    executableFiles: [],
    capabilityRequests: [{ capability: "skill.allowed-tools", required: true, rationale: "read" }],
    conflicts: [],
    precedenceChanges: ["Project skill shadows global skill"],
    policyGeneration: "f".repeat(64),
    registryGeneration: 2,
  },
  detailOffset: 0,
  surfaces: [
    {
      surfaceId: "g".repeat(64),
      kind: "skill",
      name: "review-code",
      primary: true,
      executable: false,
      requiredCapabilities: [],
      diagnosticCount: 0,
      dynamicBehavior: "none",
    },
  ],
  diagnostics: [],
};

test("web adoption presentation exposes the complete native trust review", () => {
  const presentation = adoptionTrustReviewPresentation(report);
  assert.deepEqual(presentation, {
    sourceIdentity: nativeCandidate.source.canonicalPath,
    sourceHash: report.trustReview?.sourceContentSha256,
    policyGeneration: report.trustReview?.policyGeneration,
    destinationScope: "project",
    license: "Apache-2.0",
    licenseFiles: ["LICENSE"],
    noticeFiles: [],
    declarativeFiles: ["SKILL.md"],
    executableFiles: [],
    capabilities: ["skill.allowed-tools · read"],
    conflicts: [],
    precedenceChanges: ["Project skill shadows global skill"],
  });
});

test("web native activation uses the exact reviewed binding after explicit confirmation", async () => {
  const calls: string[] = [];
  const operationId = parseAdoptionOperationId("018f1f60-7b2a-7ccd-8f7a-4c57d8532d91");
  const revisionId = parseAdoptionRevisionId("018f1f60-7b2a-7ccd-8f7a-4c57d8532d92");
  const controller = {
    async planNativeSkill(value: typeof nativeCandidate, scope: string) {
      assert.equal(value, nativeCandidate);
      assert.equal(scope, "project");
      calls.push("plan");
      return { operationId, operation: {} };
    },
    async stageNativeSkill(value: typeof operationId) {
      assert.equal(value, operationId);
      calls.push("start");
      return { revisionId };
    },
    async approveNativeSkill(value: Record<string, unknown>) {
      assert.deepEqual(value, {
        operationId,
        revisionId,
        reviewBindingSha256: report.trustReview?.bindingSha256,
        policyGeneration: report.trustReview?.policyGeneration,
      });
      calls.push("approve");
      return {};
    },
  } as unknown as AdoptionController;
  await activateNativeSkill(controller, nativeCandidate, report);
  assert.deepEqual(calls, ["plan", "start", "approve"]);
});
