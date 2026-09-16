// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { AdoptionCandidate, AdoptionController, AdoptionInspectResult } from "@axl/sdk";

export interface AdoptionTrustReviewPresentation {
  readonly sourceIdentity: string;
  readonly sourceHash: string;
  readonly policyGeneration: string;
  readonly destinationScope: string;
  readonly license: string;
  readonly licenseFiles: readonly string[];
  readonly noticeFiles: readonly string[];
  readonly declarativeFiles: readonly string[];
  readonly executableFiles: readonly string[];
  readonly capabilities: readonly string[];
  readonly conflicts: readonly string[];
  readonly precedenceChanges: readonly string[];
}

export function adoptionTrustReviewPresentation(
  report: AdoptionInspectResult,
): AdoptionTrustReviewPresentation | undefined {
  const review = report.trustReview;
  if (review === undefined) return undefined;
  const source = report.candidate.source;
  return Object.freeze({
    sourceIdentity:
      source.kind === "local"
        ? source.canonicalPath
        : source.kind === "npm"
          ? `${source.packageName}@${source.requested} · ${source.registryOrigin}`
          : `${source.repositoryUri}#${source.requestedRef}`,
    sourceHash: review.sourceContentSha256,
    policyGeneration: review.policyGeneration,
    destinationScope: review.targetScope,
    license: review.licenseExpressions.join(", ") || "Not declared",
    licenseFiles: Object.freeze(review.licenseFiles.map((file) => file.relativePath)),
    noticeFiles: Object.freeze(review.noticeFiles.map((file) => file.relativePath)),
    declarativeFiles: Object.freeze(review.declarativeFiles.map((file) => file.relativePath)),
    executableFiles: Object.freeze(review.executableFiles.map((file) => file.relativePath)),
    capabilities: Object.freeze(
      review.capabilityRequests.map((request) => `${request.capability} · ${request.rationale}`),
    ),
    conflicts: Object.freeze([...review.conflicts]),
    precedenceChanges: Object.freeze([...review.precedenceChanges]),
  });
}

export async function activateNativeSkill(
  controller: AdoptionController,
  candidate: AdoptionCandidate,
  report: AdoptionInspectResult,
): Promise<void> {
  const review = report.trustReview;
  if (
    candidate.kind !== "skill" ||
    report.candidate.candidateId !== candidate.candidateId ||
    review === undefined
  )
    throw new Error("A complete native Agent Skill trust review is required");
  if (review.executableFiles.length > 0 || review.conflicts.length > 0)
    throw new Error("Native installation is blocked by the trust review");
  const planned = await controller.planNativeSkill(candidate, review.targetScope);
  const staged = await controller.stageNativeSkill(planned.operationId);
  if (staged.revisionId === undefined)
    throw new Error("Native skill installation did not produce a revision");
  await controller.approveNativeSkill({
    operationId: planned.operationId,
    revisionId: staged.revisionId,
    reviewBindingSha256: review.bindingSha256,
    policyGeneration: review.policyGeneration,
  });
}
