// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { ProtocolValidationError } from "./event-envelope.ts";
import type { BlobReference } from "./events.ts";

export const ADOPTION_LIMITS = Object.freeze({
  resultBytes: 786_432,
  jsonDepth: 32,
  cursorBytes: 512,
  pathBytes: 4_096,
  queryBytes: 256,
  nameBytes: 256,
  statusBytes: 512,
  reasonBytes: 1_024,
  rationaleBytes: 2_048,
  codeBytes: 128,
  pageSize: 100,
  pageWarnings: 64,
  capabilitiesPerSurface: 64,
  capabilityRequestsPerRevision: 256,
  activeAdoptionsPerSession: 256,
  progressCount: 1_000_000_000,
  progressSnapshotOperations: 100,
  progressUnacknowledgedDeliveries: 1_024,
  progressUnacknowledgedBytes: 4 * 1_024 * 1_024,
  progressIdleMs: 10 * 60 * 1_000,
  progressMaximumLifetimeMs: 24 * 60 * 60 * 1_000,
  tokenEstimate: 2_000_000_000,
  durationMs: 604_800_000,
  costUsd: 1_000_000,
} as const);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CODE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };
export type AdoptionCandidateId = Brand<string, "AdoptionCandidateId">;
export type AdoptionOperationId = Brand<string, "AdoptionOperationId">;
export type AdoptionId = Brand<string, "AdoptionId">;
export type AdoptionRevisionId = Brand<string, "AdoptionRevisionId">;
export type AdoptionApprovalId = Brand<string, "AdoptionApprovalId">;
export type AdoptionSubscriptionId = Brand<string, "AdoptionSubscriptionId">;

function parseUuid<Name extends string>(
  value: unknown,
  path: string,
  version: "7" | "8",
): Brand<string, Name> {
  if (typeof value !== "string" || value.length !== 36)
    fail(path, `must be a lowercase UUIDv${version}`);
  const match = UUID_PATTERN.exec(value);
  if (match?.[1] !== version) fail(path, `must be a lowercase UUIDv${version}`);
  return value as Brand<string, Name>;
}

export function parseAdoptionCandidateId(
  value: unknown,
  path = "candidateId",
): AdoptionCandidateId {
  return parseUuid(value, path, "8");
}
export function parseAdoptionOperationId(
  value: unknown,
  path = "operationId",
): AdoptionOperationId {
  return parseUuid(value, path, "7");
}
export function parseAdoptionId(value: unknown, path = "adoptionId"): AdoptionId {
  return parseUuid(value, path, "7");
}
export function parseAdoptionRevisionId(value: unknown, path = "revisionId"): AdoptionRevisionId {
  return parseUuid(value, path, "7");
}
export function parseAdoptionApprovalId(value: unknown, path = "approvalId"): AdoptionApprovalId {
  return parseUuid(value, path, "7");
}
export function parseAdoptionSubscriptionId(
  value: unknown,
  path = "subscriptionId",
): AdoptionSubscriptionId {
  return parseUuid(value, path, "7");
}

export const ADOPTION_ECOSYSTEMS = ["opencode", "dsh", "claude-code", "pi"] as const;
export type AdoptionEcosystem = (typeof ADOPTION_ECOSYSTEMS)[number];
export const ADOPTION_SCOPES = ["global", "project"] as const;
export type AdoptionScope = (typeof ADOPTION_SCOPES)[number];
export const ADOPTION_RESOURCE_KINDS = [
  "package",
  "extension",
  "skill",
  "hook",
  "prompt",
  "theme",
  "mcp-server",
  "agent",
  "instructions",
  "provider",
  "workflow",
] as const;
export type AdoptionResourceKind = (typeof ADOPTION_RESOURCE_KINDS)[number];
export const ADOPTION_COMPATIBILITY_VALUES = [
  "native",
  "adapted",
  "isolated",
  "unsupported",
] as const;
export type AdoptionCompatibility = (typeof ADOPTION_COMPATIBILITY_VALUES)[number];
export const ADOPTION_OPERATION_STATES = [
  "created",
  "discovering",
  "inspected",
  "awaiting-plan-approval",
  "acquiring",
  "converting",
  "native-staging",
  "verifying",
  "repairing",
  "awaiting-activation-approval",
  "activating",
  "active",
  "inactive",
  "cancelled",
  "failed",
  "blocked",
] as const;
export type AdoptionOperationState = (typeof ADOPTION_OPERATION_STATES)[number];

export function parseAdoptionEcosystem(value: unknown, path = "ecosystem"): AdoptionEcosystem {
  return enumValue(value, path, ADOPTION_ECOSYSTEMS);
}
export function parseAdoptionScope(value: unknown, path = "scope"): AdoptionScope {
  return enumValue(value, path, ADOPTION_SCOPES);
}
export function parseAdoptionResourceKind(value: unknown, path = "kind"): AdoptionResourceKind {
  return enumValue(value, path, ADOPTION_RESOURCE_KINDS);
}
export function parseAdoptionCompatibility(
  value: unknown,
  path = "compatibility",
): AdoptionCompatibility {
  return enumValue(value, path, ADOPTION_COMPATIBILITY_VALUES);
}
export function parseAdoptionOperationState(
  value: unknown,
  path = "state",
): AdoptionOperationState {
  return enumValue(value, path, ADOPTION_OPERATION_STATES);
}

export type AdoptionSourceLocator =
  | { readonly kind: "local"; readonly canonicalPath: string }
  | {
      readonly kind: "npm";
      readonly registryOrigin: string;
      readonly packageName: string;
      readonly requested: string;
    }
  | { readonly kind: "git"; readonly repositoryUri: string; readonly requestedRef: string };

export type AdoptionSourceLock =
  | {
      readonly kind: "local-snapshot";
      readonly treeSha256: string;
      readonly fileCount: number;
      readonly sizeBytes: number;
    }
  | {
      readonly kind: "npm";
      readonly registryOrigin: string;
      readonly packageName: string;
      readonly version: string;
      readonly integrity: string;
      readonly tarballSha256: string;
    }
  | {
      readonly kind: "git";
      readonly repositoryUri: string;
      readonly commit: string;
      readonly treeSha256: string;
    };

export interface AdoptionDiagnosticSummary {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly relativePath?: string;
  readonly surfaceId?: string;
}

export interface AdoptionCandidate {
  readonly candidateId: AdoptionCandidateId;
  readonly discoveryFingerprint: string;
  readonly ecosystem: AdoptionEcosystem;
  readonly scope: AdoptionScope;
  readonly kind: AdoptionResourceKind;
  readonly displayName: string;
  readonly source: AdoptionSourceLocator;
  readonly packageId?: string;
  readonly relativeResourcePath: string;
  readonly primary: boolean;
  readonly executable: boolean;
  readonly resourceCount?: number;
  readonly warningCount: number;
  readonly malformed: boolean;
}

export type AdoptionCandidateSummary = AdoptionCandidate;

export interface AdoptionResourceSurface {
  readonly surfaceId: string;
  readonly kind: AdoptionResourceKind;
  readonly name: string;
  readonly relativePath?: string;
  readonly primary: boolean;
  readonly executable: boolean;
  readonly compatibility?: AdoptionCompatibility;
  readonly compatibilityReason?: string;
  readonly requiredCapabilities: readonly string[];
  readonly diagnosticCount: number;
  readonly dynamicBehavior: "none" | "reported" | "unknown";
}

export type AdoptionSurfaceSummary = AdoptionResourceSurface;

export interface AdoptionCapabilityRequest {
  readonly capability: string;
  readonly required: boolean;
  readonly rationale: string;
}

export interface AdoptionPolicyEvaluation {
  readonly generation: string;
  readonly decision: "allow" | "deny" | "requires-approval";
  readonly deniedCapabilities: readonly string[];
  readonly reasons: readonly string[];
}

export interface AdoptionCompatibilitySummary {
  readonly primarySurfaceId: string;
  readonly overall: AdoptionCompatibility;
  readonly surfaceCount: number;
  readonly unsupportedSurfaceCount: number;
  readonly partialAcknowledgementRequired: boolean;
}

/** A bounded page of a compatibility report. Use the containing RPC cursor for the next page. */
export interface AdoptionCompatibilityReport extends AdoptionCompatibilitySummary {
  readonly surfaces: readonly AdoptionResourceSurface[];
}

export interface AdoptionDisclosureFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface AdoptionSourceDisclosureManifest {
  /** Hash of the complete canonical manifest, including all file metadata. */
  readonly manifestSha256: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly endpointLocation: "local" | "remote" | "unknown";
  readonly fileCount: number;
  /** Digest of the complete canonical file-metadata sequence. */
  readonly filesSha256: string;
  readonly totalBytes: number;
  /** At most 100 metadata entries for a small manifest or preview. Never contains source bodies. */
  readonly files?: readonly AdoptionDisclosureFile[];
  /** Complete metadata for a large manifest. The referenced blob is bound by filesSha256. */
  readonly filesBlob?: BlobReference;
  readonly retentionMetadataRevision: string;
}

export interface AdoptionEstimateRange {
  readonly lower: number;
  readonly upper: number;
}
export interface AdoptionEstimates {
  readonly inputTokens: AdoptionEstimateRange;
  readonly outputTokens: AdoptionEstimateRange;
  readonly durationMs?: AdoptionEstimateRange;
  readonly costUsd?: AdoptionEstimateRange;
  readonly pricingRevision?: string;
}

export interface AdoptionVerificationStep {
  readonly id: string;
  readonly name: string;
  readonly status: "pending" | "running" | "passed" | "failed" | "skipped";
  readonly toolVersion: string;
  readonly log?: BlobReference;
}
export interface AdoptionVerificationSummary {
  readonly status: "pending" | "running" | "passed" | "failed";
  readonly steps: readonly AdoptionVerificationStep[];
  readonly evidenceSha256?: string;
}

export interface AdoptionOperationSummary {
  readonly operationId: AdoptionOperationId;
  readonly state: AdoptionOperationState;
  readonly phase: string;
  readonly statusText: string;
  readonly sequence: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly adoptionId?: AdoptionId;
  readonly revisionId?: AdoptionRevisionId;
  readonly progress?: {
    readonly completed: number;
    readonly total?: number;
    readonly unit?: string;
  };
}

export interface AdoptionOperationDetail extends AdoptionOperationSummary {
  readonly candidate?: AdoptionCandidate;
  readonly sourceLock?: AdoptionSourceLock;
  readonly compatibility?: AdoptionCompatibilityReport;
  readonly capabilityRequests: readonly AdoptionCapabilityRequest[];
  readonly policy?: AdoptionPolicyEvaluation;
  readonly disclosure?: AdoptionSourceDisclosureManifest;
  readonly estimates?: AdoptionEstimates;
  readonly verification?: AdoptionVerificationSummary;
  /** Surfaces and diagnostics form one page of at most 100 combined entries. */
  readonly diagnosticCount: number;
  readonly detailOffset: number;
  readonly diagnostics: readonly AdoptionDiagnosticSummary[];
  readonly nextDetailPageCursor?: string;
  readonly review?: BlobReference;
}

export interface AdoptedRevisionSummary {
  readonly revisionId: AdoptionRevisionId;
  readonly createdAt: number;
  readonly active: boolean;
  readonly manifestSha256: string;
  readonly compatibility: AdoptionCompatibility;
  readonly parentRevisionId?: AdoptionRevisionId;
}
export interface AdoptedPackageSummary {
  readonly adoptionId: AdoptionId;
  readonly displayName: string;
  readonly ecosystem: AdoptionEcosystem;
  readonly scope: AdoptionScope;
  readonly enabled: boolean;
  readonly activeRevisionId?: AdoptionRevisionId;
  readonly revisionCount: number;
}

export interface AdoptionDiffSummary {
  readonly fromRevisionId?: AdoptionRevisionId;
  readonly toRevisionId: AdoptionRevisionId;
  readonly filesChanged: number;
  readonly surfacesChanged: number;
  readonly truncated: boolean;
  readonly body?: BlobReference;
}
export interface AdoptionUpdatePreview {
  readonly adoptionId: AdoptionId;
  readonly currentRevisionId: AdoptionRevisionId;
  readonly source: AdoptionSourceLocator;
  readonly available: boolean;
  readonly requestedRef?: string;
}
export interface AdoptionRollbackPreview {
  readonly adoptionId: AdoptionId;
  readonly fromRevisionId: AdoptionRevisionId;
  readonly toRevisionId: AdoptionRevisionId;
  readonly compatibility: AdoptionCompatibilitySummary;
}

export interface AdoptionDiscoverParams {
  readonly ecosystems?: readonly AdoptionEcosystem[];
  readonly scopes?: readonly AdoptionScope[];
  readonly projectRoot?: string;
  readonly query?: string;
  readonly includeMalformed?: boolean;
  readonly pageSize: number;
  readonly pageCursor?: string;
}
export interface AdoptionDiscoverResult {
  readonly scanGeneration: string;
  readonly candidates: readonly AdoptionCandidate[];
  readonly warnings: readonly AdoptionDiagnosticSummary[];
  readonly nextPageCursor?: string;
}
export interface AdoptionInspectParams {
  readonly candidateId: AdoptionCandidateId;
  readonly expectedDiscoveryFingerprint: string;
  readonly pageSize: number;
  readonly pageCursor?: string;
}
export interface AdoptionInspectResult {
  readonly candidate: AdoptionCandidate;
  readonly adapter: {
    readonly id: string;
    readonly version: string;
    readonly sourceSchemaVersion: string;
  };
  readonly license: {
    readonly expressions: readonly string[];
    readonly notices: readonly BlobReference[];
  };
  readonly inventory: {
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly executable: boolean;
  };
  readonly limits: {
    readonly maxTraversalDepth: number;
    readonly maxEntries: number;
    readonly maxFiles: number;
    readonly maxTotalBytes: number;
    readonly maxFileBytes: number;
    readonly maxManifestBytes: number;
  };
  readonly surfaceCount: number;
  readonly diagnosticCount: number;
  /** Offset in the combined surfaces-then-diagnostics detail stream. */
  readonly detailOffset: number;
  readonly surfaces: readonly AdoptionResourceSurface[];
  readonly diagnostics: readonly AdoptionDiagnosticSummary[];
  readonly nextPageCursor?: string;
}

export type AdoptionRpcMethodMap = {
  readonly "adoption.discover": {
    readonly params: AdoptionDiscoverParams;
    readonly result: AdoptionDiscoverResult;
  };
  readonly "adoption.inspect": {
    readonly params: AdoptionInspectParams;
    readonly result: AdoptionInspectResult;
  };
  readonly "adoption.plan": {
    readonly params: {
      readonly candidateId: AdoptionCandidateId;
      readonly expectedDiscoveryFingerprint: string;
      /** Omit to select the whole package; otherwise contains the exact selected surfaces. */
      readonly selectedSurfaceIds?: readonly string[];
      readonly targetScope: AdoptionScope;
    };
    readonly result: {
      readonly operationId: AdoptionOperationId;
      readonly operation: AdoptionOperationDetail;
    };
  };
  readonly "adoption.start": {
    readonly params: { readonly operationId: AdoptionOperationId };
    readonly result: AdoptionOperationSummary;
  };
  readonly "adoption.operation.get": {
    readonly params: {
      readonly operationId: AdoptionOperationId;
      readonly detailPageSize: number;
      readonly detailPageCursor?: string;
    };
    readonly result: AdoptionOperationDetail;
  };
  readonly "adoption.operation.list": {
    readonly params: {
      readonly states?: readonly AdoptionOperationState[];
      readonly pageSize: number;
      readonly pageCursor?: string;
    };
    readonly result: {
      readonly operations: readonly AdoptionOperationSummary[];
      readonly nextPageCursor?: string;
    };
  };
  readonly "adoption.operation.cancel": {
    readonly params: { readonly operationId: AdoptionOperationId };
    readonly result: AdoptionOperationSummary;
  };
  readonly "adoption.operation.approveConversion": {
    readonly params: {
      readonly operationId: AdoptionOperationId;
      readonly disclosureManifestSha256: string;
      readonly rationale?: string;
    };
    readonly result: {
      readonly approvalId: AdoptionApprovalId;
      readonly operation: AdoptionOperationSummary;
    };
  };
  readonly "adoption.operation.acknowledgePartial": {
    readonly params: {
      readonly operationId: AdoptionOperationId;
      readonly reportSha256: string;
      readonly rationale: string;
    };
    readonly result: {
      readonly approvalId: AdoptionApprovalId;
      readonly operation: AdoptionOperationSummary;
    };
  };
  readonly "adoption.operation.approveActivation": {
    readonly params: {
      readonly operationId: AdoptionOperationId;
      readonly revisionId: AdoptionRevisionId;
      readonly rationale?: string;
    };
    readonly result: {
      readonly approvalId: AdoptionApprovalId;
      readonly operation: AdoptionOperationSummary;
    };
  };
  readonly "adoption.list": {
    readonly params: {
      readonly scopes?: readonly AdoptionScope[];
      readonly pageSize: number;
      readonly pageCursor?: string;
    };
    readonly result: {
      readonly adoptions: readonly AdoptedPackageSummary[];
      readonly nextPageCursor?: string;
    };
  };
  readonly "adoption.revision.get": {
    readonly params: {
      readonly adoptionId: AdoptionId;
      readonly revisionId: AdoptionRevisionId;
      readonly detailPageSize: number;
      readonly detailPageCursor?: string;
    };
    readonly result: {
      readonly adoption: AdoptedPackageSummary;
      readonly revision: AdoptedRevisionSummary;
      readonly compatibility: AdoptionCompatibilityReport;
      readonly verification: AdoptionVerificationSummary;
      readonly diagnosticCount: number;
      readonly detailOffset: number;
      readonly diagnostics: readonly AdoptionDiagnosticSummary[];
      readonly nextDetailPageCursor?: string;
    };
  };
  readonly "adoption.diff": {
    readonly params: {
      readonly adoptionId: AdoptionId;
      readonly fromRevisionId?: AdoptionRevisionId;
      readonly toRevisionId: AdoptionRevisionId;
    };
    readonly result: AdoptionDiffSummary;
  };
  readonly "adoption.update": {
    readonly params: { readonly adoptionId: AdoptionId; readonly previewOnly: boolean };
    readonly result: {
      readonly preview: AdoptionUpdatePreview;
      readonly operationId?: AdoptionOperationId;
    };
  };
  readonly "adoption.rollback": {
    readonly params: {
      readonly adoptionId: AdoptionId;
      readonly targetRevisionId: AdoptionRevisionId;
      readonly expectedActiveRevisionId: AdoptionRevisionId;
    };
    readonly result: {
      readonly preview: AdoptionRollbackPreview;
      readonly operation: AdoptionOperationSummary;
    };
  };
  readonly "adoption.disable": {
    readonly params: {
      readonly adoptionId: AdoptionId;
      readonly expectedActiveRevisionId?: AdoptionRevisionId;
    };
    readonly result: AdoptedPackageSummary;
  };
  readonly "adoption.remove": {
    readonly params: { readonly adoptionId: AdoptionId };
    readonly result: { readonly removed: boolean; readonly retainedRevisions: number };
  };
  readonly "adoption.purge": {
    readonly params: {
      readonly adoptionId: AdoptionId;
      readonly purgePlanSha256: string;
      readonly confirmAdoptionId: AdoptionId;
    };
    readonly result: { readonly purged: boolean; readonly tombstoneSha256: string };
  };
  readonly "adoption.subscribe": {
    readonly params: { readonly fromCursor?: string };
    readonly result: {
      readonly subscriptionId: AdoptionSubscriptionId;
      readonly boundaryCursor: string;
      readonly operations: readonly AdoptionOperationSummary[];
      readonly resumed: boolean;
    };
  };
  readonly "adoption.ack": {
    readonly params: { readonly subscriptionId: AdoptionSubscriptionId; readonly cursor: string };
    readonly result: { readonly cursor: string };
  };
  readonly "adoption.unsubscribe": {
    readonly params: { readonly subscriptionId: AdoptionSubscriptionId };
    readonly result: { readonly unsubscribed: boolean };
  };
};

export type AdoptionRpcMethod = keyof AdoptionRpcMethodMap;
export const ADOPTION_RPC_METHODS = [
  "adoption.discover",
  "adoption.inspect",
  "adoption.plan",
  "adoption.start",
  "adoption.operation.get",
  "adoption.operation.list",
  "adoption.operation.cancel",
  "adoption.operation.approveConversion",
  "adoption.operation.acknowledgePartial",
  "adoption.operation.approveActivation",
  "adoption.list",
  "adoption.revision.get",
  "adoption.diff",
  "adoption.update",
  "adoption.rollback",
  "adoption.disable",
  "adoption.remove",
  "adoption.purge",
  "adoption.subscribe",
  "adoption.ack",
  "adoption.unsubscribe",
] as const satisfies readonly AdoptionRpcMethod[];

export const ADOPTION_CAPABILITIES = [
  "adoption.discover",
  "adoption.inspect",
  "adoption.plan",
  "adoption.start",
  "adoption.read",
  "adoption.cancel",
  "adoption.approve-conversion",
  "adoption.approve-activation",
  "adoption.update",
  "adoption.diff",
  "adoption.rollback",
  "adoption.remove",
  "adoption.list",
  "adoption.purge",
] as const;
export type AdoptionCapabilityId = (typeof ADOPTION_CAPABILITIES)[number];

/** All adoption authority is daemon-global; attachment policy may narrow it to named scopes and roots. */
export const ADOPTION_CAPABILITY_SCOPES = Object.freeze(
  Object.fromEntries(
    ADOPTION_CAPABILITIES.map((capability) => [
      capability,
      {
        authority: "global" as const,
        attachmentMayNarrow: true,
      },
    ]),
  ) as Readonly<
    Record<
      AdoptionCapabilityId,
      { readonly authority: "global"; readonly attachmentMayNarrow: true }
    >
  >,
);

export const ADOPTION_RETRYABLE_MUTATION_METHODS = [
  "adoption.plan",
  "adoption.start",
  "adoption.operation.cancel",
  "adoption.operation.approveConversion",
  "adoption.operation.acknowledgePartial",
  "adoption.operation.approveActivation",
  "adoption.update",
  "adoption.rollback",
  "adoption.disable",
  "adoption.remove",
  "adoption.purge",
] as const satisfies readonly AdoptionRpcMethod[];

export function requiredAdoptionCapability(
  method: AdoptionRpcMethod,
): AdoptionCapabilityId | undefined {
  const map: Record<AdoptionRpcMethod, AdoptionCapabilityId | undefined> = {
    "adoption.discover": "adoption.discover",
    "adoption.inspect": "adoption.inspect",
    "adoption.plan": "adoption.plan",
    "adoption.start": "adoption.start",
    "adoption.operation.get": "adoption.read",
    "adoption.operation.list": "adoption.read",
    "adoption.operation.cancel": "adoption.cancel",
    "adoption.operation.approveConversion": "adoption.approve-conversion",
    "adoption.operation.acknowledgePartial": "adoption.approve-conversion",
    "adoption.operation.approveActivation": "adoption.approve-activation",
    "adoption.list": "adoption.list",
    "adoption.revision.get": "adoption.read",
    "adoption.diff": "adoption.diff",
    "adoption.update": "adoption.update",
    "adoption.rollback": "adoption.rollback",
    "adoption.disable": "adoption.remove",
    "adoption.remove": "adoption.remove",
    "adoption.purge": "adoption.purge",
    "adoption.subscribe": "adoption.read",
    "adoption.ack": "adoption.read",
    "adoption.unsubscribe": "adoption.read",
  };
  return map[method];
}

/**
 * A bounded journal projection. Consumers stop on a cursor gap, poll visible operations,
 * then resubscribe from the last acknowledged cursor. `operation.get` remains authoritative.
 */
export interface AdoptionOperationDelivery {
  readonly kind: "adoption_operation";
  readonly subscriptionId: AdoptionSubscriptionId;
  readonly cursor: string;
  readonly operation: AdoptionOperationSummary;
}

export function isAdoptionRpcMethod(value: string): value is AdoptionRpcMethod {
  return (ADOPTION_RPC_METHODS as readonly string[]).includes(value);
}

export function parseAdoptionRpcParams<Method extends AdoptionRpcMethod>(
  method: Method,
  value: unknown,
): AdoptionRpcMethodMap[Method]["params"] {
  const path = "request.params";
  const input = object(value, path);
  let parsed: unknown;
  if (method === "adoption.discover") parsed = parseDiscoverParams(input, path);
  else if (method === "adoption.inspect") parsed = parseInspectParams(input, path);
  else if (method === "adoption.plan") {
    exact(input, path, [
      "candidateId",
      "expectedDiscoveryFingerprint",
      "selectedSurfaceIds",
      "targetScope",
    ]);
    parsed = {
      candidateId: parseAdoptionCandidateId(input.candidateId, `${path}.candidateId`),
      expectedDiscoveryFingerprint: sha(
        input.expectedDiscoveryFingerprint,
        `${path}.expectedDiscoveryFingerprint`,
      ),
      ...(input.selectedSurfaceIds === undefined
        ? {}
        : {
            selectedSurfaceIds: uniqueArray(
              input.selectedSurfaceIds,
              `${path}.selectedSurfaceIds`,
              10_000,
              (value, itemPath) => sha(value, itemPath),
            ),
          }),
      targetScope: parseAdoptionScope(input.targetScope, `${path}.targetScope`),
    };
  } else if (method === "adoption.start" || method === "adoption.operation.cancel") {
    exact(input, path, ["operationId"]);
    parsed = { operationId: parseAdoptionOperationId(input.operationId, `${path}.operationId`) };
  } else if (method === "adoption.operation.get") {
    exact(input, path, ["operationId", "detailPageSize", "detailPageCursor"]);
    parsed = {
      operationId: parseAdoptionOperationId(input.operationId, `${path}.operationId`),
      detailPageSize: pageSize(input.detailPageSize, `${path}.detailPageSize`),
      ...(input.detailPageCursor === undefined
        ? {}
        : { detailPageCursor: text(input.detailPageCursor, `${path}.detailPageCursor`, 512) }),
    };
  } else if (method === "adoption.operation.list") {
    exact(input, path, ["states", "pageSize", "pageCursor"]);
    parsed = {
      ...(input.states === undefined
        ? {}
        : { states: uniqueArray(input.states, `${path}.states`, 16, parseAdoptionOperationState) }),
      pageSize: pageSize(input.pageSize, `${path}.pageSize`),
      ...(input.pageCursor === undefined
        ? {}
        : { pageCursor: text(input.pageCursor, `${path}.pageCursor`, 512) }),
    };
  } else if (method === "adoption.operation.approveConversion") {
    exact(input, path, ["operationId", "disclosureManifestSha256", "rationale"]);
    parsed = {
      operationId: parseAdoptionOperationId(input.operationId, `${path}.operationId`),
      disclosureManifestSha256: sha(
        input.disclosureManifestSha256,
        `${path}.disclosureManifestSha256`,
      ),
      ...(input.rationale === undefined
        ? {}
        : { rationale: text(input.rationale, `${path}.rationale`, 2_048) }),
    };
  } else if (method === "adoption.operation.acknowledgePartial") {
    exact(input, path, ["operationId", "reportSha256", "rationale"]);
    parsed = {
      operationId: parseAdoptionOperationId(input.operationId, `${path}.operationId`),
      reportSha256: sha(input.reportSha256, `${path}.reportSha256`),
      rationale: text(input.rationale, `${path}.rationale`, 2_048),
    };
  } else if (method === "adoption.operation.approveActivation") {
    exact(input, path, ["operationId", "revisionId", "rationale"]);
    parsed = {
      operationId: parseAdoptionOperationId(input.operationId, `${path}.operationId`),
      revisionId: parseAdoptionRevisionId(input.revisionId, `${path}.revisionId`),
      ...(input.rationale === undefined
        ? {}
        : { rationale: text(input.rationale, `${path}.rationale`, 2_048) }),
    };
  } else if (method === "adoption.list") {
    exact(input, path, ["scopes", "pageSize", "pageCursor"]);
    parsed = {
      ...(input.scopes === undefined
        ? {}
        : { scopes: uniqueArray(input.scopes, `${path}.scopes`, 2, parseAdoptionScope) }),
      pageSize: pageSize(input.pageSize, `${path}.pageSize`),
      ...(input.pageCursor === undefined
        ? {}
        : { pageCursor: text(input.pageCursor, `${path}.pageCursor`, 512) }),
    };
  } else if (method === "adoption.revision.get") {
    exact(input, path, ["adoptionId", "revisionId", "detailPageSize", "detailPageCursor"]);
    parsed = {
      adoptionId: parseAdoptionId(input.adoptionId, `${path}.adoptionId`),
      revisionId: parseAdoptionRevisionId(input.revisionId, `${path}.revisionId`),
      detailPageSize: pageSize(input.detailPageSize, `${path}.detailPageSize`),
      ...(input.detailPageCursor === undefined
        ? {}
        : { detailPageCursor: text(input.detailPageCursor, `${path}.detailPageCursor`, 512) }),
    };
  } else if (method === "adoption.diff") {
    exact(input, path, ["adoptionId", "fromRevisionId", "toRevisionId"]);
    parsed = {
      adoptionId: parseAdoptionId(input.adoptionId, `${path}.adoptionId`),
      ...(input.fromRevisionId === undefined
        ? {}
        : {
            fromRevisionId: parseAdoptionRevisionId(input.fromRevisionId, `${path}.fromRevisionId`),
          }),
      toRevisionId: parseAdoptionRevisionId(input.toRevisionId, `${path}.toRevisionId`),
    };
  } else if (method === "adoption.update") {
    exact(input, path, ["adoptionId", "previewOnly"]);
    parsed = {
      adoptionId: parseAdoptionId(input.adoptionId, `${path}.adoptionId`),
      previewOnly: bool(input.previewOnly, `${path}.previewOnly`),
    };
  } else if (method === "adoption.rollback") {
    exact(input, path, ["adoptionId", "targetRevisionId", "expectedActiveRevisionId"]);
    parsed = {
      adoptionId: parseAdoptionId(input.adoptionId, `${path}.adoptionId`),
      targetRevisionId: parseAdoptionRevisionId(input.targetRevisionId, `${path}.targetRevisionId`),
      expectedActiveRevisionId: parseAdoptionRevisionId(
        input.expectedActiveRevisionId,
        `${path}.expectedActiveRevisionId`,
      ),
    };
  } else if (method === "adoption.disable") {
    exact(input, path, ["adoptionId", "expectedActiveRevisionId"]);
    parsed = {
      adoptionId: parseAdoptionId(input.adoptionId, `${path}.adoptionId`),
      ...(input.expectedActiveRevisionId === undefined
        ? {}
        : {
            expectedActiveRevisionId: parseAdoptionRevisionId(
              input.expectedActiveRevisionId,
              `${path}.expectedActiveRevisionId`,
            ),
          }),
    };
  } else if (method === "adoption.remove") {
    exact(input, path, ["adoptionId"]);
    parsed = { adoptionId: parseAdoptionId(input.adoptionId, `${path}.adoptionId`) };
  } else if (method === "adoption.purge") {
    exact(input, path, ["adoptionId", "purgePlanSha256", "confirmAdoptionId"]);
    const adoptionId = parseAdoptionId(input.adoptionId, `${path}.adoptionId`);
    const confirmAdoptionId = parseAdoptionId(input.confirmAdoptionId, `${path}.confirmAdoptionId`);
    if (adoptionId !== confirmAdoptionId)
      fail(`${path}.confirmAdoptionId`, "must match adoptionId");
    parsed = {
      adoptionId,
      purgePlanSha256: sha(input.purgePlanSha256, `${path}.purgePlanSha256`),
      confirmAdoptionId,
    };
  } else if (method === "adoption.subscribe") {
    exact(input, path, ["fromCursor"]);
    parsed =
      input.fromCursor === undefined
        ? {}
        : { fromCursor: text(input.fromCursor, `${path}.fromCursor`, 512) };
  } else if (method === "adoption.ack") {
    exact(input, path, ["subscriptionId", "cursor"]);
    parsed = {
      subscriptionId: parseAdoptionSubscriptionId(input.subscriptionId, `${path}.subscriptionId`),
      cursor: text(input.cursor, `${path}.cursor`, 512),
    };
  } else {
    exact(input, path, ["subscriptionId"]);
    parsed = {
      subscriptionId: parseAdoptionSubscriptionId(input.subscriptionId, `${path}.subscriptionId`),
    };
  }
  return parsed as AdoptionRpcMethodMap[Method]["params"];
}

export function parseAdoptionRpcResult<Method extends AdoptionRpcMethod>(
  method: Method,
  value: unknown,
): AdoptionRpcMethodMap[Method]["result"] {
  const path = "success.result";
  const input = object(value, path);
  let parsed: unknown;
  if (method === "adoption.discover") parsed = parseDiscoverResult(input, path);
  else if (method === "adoption.inspect") parsed = parseInspectResult(input, path);
  else if (method === "adoption.plan") {
    exact(input, path, ["operationId", "operation"]);
    const operation = parseOperationDetail(input.operation, `${path}.operation`);
    const operationId = parseAdoptionOperationId(input.operationId, `${path}.operationId`);
    if (operation.operationId !== operationId)
      fail(`${path}.operation.operationId`, "must match operationId");
    parsed = { operationId, operation };
  } else if (method === "adoption.start" || method === "adoption.operation.cancel")
    parsed = parseOperationSummary(input, path);
  else if (method === "adoption.operation.get") parsed = parseOperationDetail(input, path);
  else if (method === "adoption.operation.list") {
    exact(input, path, ["operations", "nextPageCursor"]);
    const operations = array(input.operations, `${path}.operations`, 100).map((v, i) =>
      parseOperationSummary(v, `${path}.operations[${i}]`),
    );
    assertUniqueBy(operations, (operation) => operation.operationId, `${path}.operations`);
    parsed = {
      operations,
      ...(input.nextPageCursor === undefined
        ? {}
        : { nextPageCursor: text(input.nextPageCursor, `${path}.nextPageCursor`, 512) }),
    };
  } else if (
    method === "adoption.operation.approveConversion" ||
    method === "adoption.operation.acknowledgePartial" ||
    method === "adoption.operation.approveActivation"
  ) {
    exact(input, path, ["approvalId", "operation"]);
    parsed = {
      approvalId: parseAdoptionApprovalId(input.approvalId, `${path}.approvalId`),
      operation: parseOperationSummary(input.operation, `${path}.operation`),
    };
  } else if (method === "adoption.list") {
    exact(input, path, ["adoptions", "nextPageCursor"]);
    const adoptions = array(input.adoptions, `${path}.adoptions`, 100).map((v, i) =>
      parsePackage(v, `${path}.adoptions[${i}]`),
    );
    assertUniqueBy(adoptions, (adoption) => adoption.adoptionId, `${path}.adoptions`);
    parsed = {
      adoptions,
      ...(input.nextPageCursor === undefined
        ? {}
        : { nextPageCursor: text(input.nextPageCursor, `${path}.nextPageCursor`, 512) }),
    };
  } else if (method === "adoption.revision.get") {
    exact(input, path, [
      "adoption",
      "revision",
      "compatibility",
      "verification",
      "diagnosticCount",
      "detailOffset",
      "diagnostics",
      "nextDetailPageCursor",
    ]);
    const compatibility = parseCompatibilityReport(input.compatibility, `${path}.compatibility`);
    const diagnosticCount = count(input.diagnosticCount, `${path}.diagnosticCount`, 10_000);
    const detailOffset = count(input.detailOffset, `${path}.detailOffset`, 20_000);
    const diagnostics = array(input.diagnostics, `${path}.diagnostics`, 100).map((value, index) =>
      parseDiagnostic(value, `${path}.diagnostics[${index}]`),
    );
    const nextDetailPageCursor = optionalCursor(
      input.nextDetailPageCursor,
      `${path}.nextDetailPageCursor`,
    );
    assertDetailPage(
      compatibility.surfaceCount,
      diagnosticCount,
      detailOffset,
      compatibility.surfaces,
      diagnostics,
      nextDetailPageCursor,
      path,
    );
    parsed = {
      adoption: parsePackage(input.adoption, `${path}.adoption`),
      revision: parseRevision(input.revision, `${path}.revision`),
      compatibility,
      verification: parseVerification(input.verification, `${path}.verification`),
      diagnosticCount,
      detailOffset,
      diagnostics,
      ...(nextDetailPageCursor === undefined ? {} : { nextDetailPageCursor }),
    };
  } else if (method === "adoption.diff") parsed = parseDiff(input, path);
  else if (method === "adoption.update") {
    exact(input, path, ["preview", "operationId"]);
    parsed = {
      preview: parseUpdatePreview(input.preview, `${path}.preview`),
      ...(input.operationId === undefined
        ? {}
        : { operationId: parseAdoptionOperationId(input.operationId, `${path}.operationId`) }),
    };
  } else if (method === "adoption.rollback") {
    exact(input, path, ["preview", "operation"]);
    parsed = {
      preview: parseRollbackPreview(input.preview, `${path}.preview`),
      operation: parseOperationSummary(input.operation, `${path}.operation`),
    };
  } else if (method === "adoption.disable") parsed = parsePackage(input, path);
  else if (method === "adoption.remove") {
    exact(input, path, ["removed", "retainedRevisions"]);
    parsed = {
      removed: bool(input.removed, `${path}.removed`),
      retainedRevisions: count(input.retainedRevisions, `${path}.retainedRevisions`),
    };
  } else if (method === "adoption.purge") {
    exact(input, path, ["purged", "tombstoneSha256"]);
    parsed = {
      purged: bool(input.purged, `${path}.purged`),
      tombstoneSha256: sha(input.tombstoneSha256, `${path}.tombstoneSha256`),
    };
  } else if (method === "adoption.subscribe") {
    exact(input, path, ["subscriptionId", "boundaryCursor", "operations", "resumed"]);
    const operations = array(input.operations, `${path}.operations`, 100).map((v, i) =>
      parseOperationSummary(v, `${path}.operations[${i}]`),
    );
    assertUniqueBy(operations, (operation) => operation.operationId, `${path}.operations`);
    parsed = {
      subscriptionId: parseAdoptionSubscriptionId(input.subscriptionId, `${path}.subscriptionId`),
      boundaryCursor: text(input.boundaryCursor, `${path}.boundaryCursor`, 512),
      operations,
      resumed: bool(input.resumed, `${path}.resumed`),
    };
  } else if (method === "adoption.ack") {
    exact(input, path, ["cursor"]);
    parsed = { cursor: text(input.cursor, `${path}.cursor`, 512) };
  } else {
    exact(input, path, ["unsubscribed"]);
    parsed = { unsubscribed: bool(input.unsubscribed, `${path}.unsubscribed`) };
  }
  boundedJson(parsed, path);
  return parsed as AdoptionRpcMethodMap[Method]["result"];
}

export function parseAdoptionSourceLocator(value: unknown, path = "source"): AdoptionSourceLocator {
  return parseSource(value, path);
}

export function parseAdoptionSourceLock(value: unknown, path = "sourceLock"): AdoptionSourceLock {
  return parseSourceLock(value, path);
}

export function parseAdoptionCandidate(value: unknown, path = "candidate"): AdoptionCandidate {
  return parseCandidate(value, path);
}

export function parseAdoptionResourceSurface(
  value: unknown,
  path = "surface",
): AdoptionResourceSurface {
  return parseSurface(value, path);
}

export function parseAdoptionDiagnosticSummary(
  value: unknown,
  path = "diagnostic",
): AdoptionDiagnosticSummary {
  return parseDiagnostic(value, path);
}

export function parseAdoptionOperationSummary(
  value: unknown,
  path = "operation",
): AdoptionOperationSummary {
  return parseOperationSummary(value, path);
}

export function parseAdoptionOperationDetail(
  value: unknown,
  path = "operation",
): AdoptionOperationDetail {
  const detail = parseOperationDetail(value, path);
  boundedJson(detail, path);
  return detail;
}

export function parseAdoptionCompatibilityReport(
  value: unknown,
  path = "compatibility",
): AdoptionCompatibilityReport {
  return parseCompatibilityReport(value, path);
}

export function parseAdoptionOperationDelivery(
  value: unknown,
  path = "message",
): AdoptionOperationDelivery {
  const input = object(value, path);
  exact(input, path, ["kind", "subscriptionId", "cursor", "operation"]);
  if (input.kind !== "adoption_operation") fail(`${path}.kind`, 'must be "adoption_operation"');
  return {
    kind: "adoption_operation",
    subscriptionId: parseAdoptionSubscriptionId(input.subscriptionId, `${path}.subscriptionId`),
    cursor: text(input.cursor, `${path}.cursor`, 512),
    operation: parseOperationSummary(input.operation, `${path}.operation`),
  };
}

function parseDiscoverParams(input: Record<string, unknown>, path: string): AdoptionDiscoverParams {
  exact(input, path, [
    "ecosystems",
    "scopes",
    "projectRoot",
    "query",
    "includeMalformed",
    "pageSize",
    "pageCursor",
  ]);
  return {
    ...(input.ecosystems === undefined
      ? {}
      : {
          ecosystems: uniqueArray(
            input.ecosystems,
            `${path}.ecosystems`,
            4,
            parseAdoptionEcosystem,
          ),
        }),
    ...(input.scopes === undefined
      ? {}
      : { scopes: uniqueArray(input.scopes, `${path}.scopes`, 2, parseAdoptionScope) }),
    ...(input.projectRoot === undefined
      ? {}
      : { projectRoot: text(input.projectRoot, `${path}.projectRoot`, 4_096) }),
    ...(input.query === undefined ? {} : { query: text(input.query, `${path}.query`, 256) }),
    ...(input.includeMalformed === undefined
      ? {}
      : { includeMalformed: bool(input.includeMalformed, `${path}.includeMalformed`) }),
    pageSize: pageSize(input.pageSize, `${path}.pageSize`),
    ...(input.pageCursor === undefined
      ? {}
      : { pageCursor: text(input.pageCursor, `${path}.pageCursor`, 512) }),
  };
}
function parseInspectParams(input: Record<string, unknown>, path: string): AdoptionInspectParams {
  exact(input, path, ["candidateId", "expectedDiscoveryFingerprint", "pageSize", "pageCursor"]);
  return {
    candidateId: parseAdoptionCandidateId(input.candidateId, `${path}.candidateId`),
    expectedDiscoveryFingerprint: sha(
      input.expectedDiscoveryFingerprint,
      `${path}.expectedDiscoveryFingerprint`,
    ),
    pageSize: pageSize(input.pageSize, `${path}.pageSize`),
    ...(input.pageCursor === undefined
      ? {}
      : { pageCursor: text(input.pageCursor, `${path}.pageCursor`, 512) }),
  };
}
function parseDiscoverResult(input: Record<string, unknown>, path: string): AdoptionDiscoverResult {
  exact(input, path, ["scanGeneration", "candidates", "warnings", "nextPageCursor"]);
  const candidates = array(input.candidates, `${path}.candidates`, 100).map((v, i) =>
    parseCandidate(v, `${path}.candidates[${i}]`),
  );
  assertUniqueBy(candidates, (candidate) => candidate.candidateId, `${path}.candidates`);
  return {
    scanGeneration: text(input.scanGeneration, `${path}.scanGeneration`, 128),
    candidates,
    warnings: array(input.warnings, `${path}.warnings`, 64).map((v, i) =>
      parseDiagnostic(v, `${path}.warnings[${i}]`),
    ),
    ...(input.nextPageCursor === undefined
      ? {}
      : { nextPageCursor: text(input.nextPageCursor, `${path}.nextPageCursor`, 512) }),
  };
}
function parseInspectResult(input: Record<string, unknown>, path: string): AdoptionInspectResult {
  exact(input, path, [
    "candidate",
    "adapter",
    "license",
    "inventory",
    "limits",
    "surfaceCount",
    "diagnosticCount",
    "detailOffset",
    "surfaces",
    "diagnostics",
    "nextPageCursor",
  ]);
  const adapter = object(input.adapter, `${path}.adapter`);
  exact(adapter, `${path}.adapter`, ["id", "version", "sourceSchemaVersion"]);
  const license = object(input.license, `${path}.license`);
  exact(license, `${path}.license`, ["expressions", "notices"]);
  const inventory = object(input.inventory, `${path}.inventory`);
  exact(inventory, `${path}.inventory`, ["fileCount", "totalBytes", "executable"]);
  const limits = object(input.limits, `${path}.limits`);
  exact(limits, `${path}.limits`, [
    "maxTraversalDepth",
    "maxEntries",
    "maxFiles",
    "maxTotalBytes",
    "maxFileBytes",
    "maxManifestBytes",
  ]);
  const surfaceCount = count(input.surfaceCount, `${path}.surfaceCount`, 10_000);
  const diagnosticCount = count(input.diagnosticCount, `${path}.diagnosticCount`, 10_000);
  const detailOffset = count(input.detailOffset, `${path}.detailOffset`, 20_000);
  const surfaces = array(input.surfaces, `${path}.surfaces`, 100).map((value, index) =>
    parseSurface(value, `${path}.surfaces[${index}]`),
  );
  const diagnostics = array(input.diagnostics, `${path}.diagnostics`, 100).map((value, index) =>
    parseDiagnostic(value, `${path}.diagnostics[${index}]`),
  );
  assertUniqueBy(surfaces, (surface) => surface.surfaceId, `${path}.surfaces`);
  const nextPageCursor = optionalCursor(input.nextPageCursor, `${path}.nextPageCursor`);
  assertDetailPage(
    surfaceCount,
    diagnosticCount,
    detailOffset,
    surfaces,
    diagnostics,
    nextPageCursor,
    path,
  );
  return {
    candidate: parseCandidate(input.candidate, `${path}.candidate`),
    adapter: {
      id: code(adapter.id, `${path}.adapter.id`),
      version: text(adapter.version, `${path}.adapter.version`, 128),
      sourceSchemaVersion: text(
        adapter.sourceSchemaVersion,
        `${path}.adapter.sourceSchemaVersion`,
        128,
      ),
    },
    license: {
      expressions: uniqueArray(license.expressions, `${path}.license.expressions`, 32, (v, p) =>
        text(v, p, 256),
      ),
      notices: array(license.notices, `${path}.license.notices`, 32).map((value, index) =>
        parseBlob(value, `${path}.license.notices[${index}]`),
      ),
    },
    inventory: {
      fileCount: count(inventory.fileCount, `${path}.inventory.fileCount`),
      totalBytes: count(inventory.totalBytes, `${path}.inventory.totalBytes`),
      executable: bool(inventory.executable, `${path}.inventory.executable`),
    },
    limits: {
      maxTraversalDepth: count(limits.maxTraversalDepth, `${path}.limits.maxTraversalDepth`, 32),
      maxEntries: count(limits.maxEntries, `${path}.limits.maxEntries`, 50_000),
      maxFiles: count(limits.maxFiles, `${path}.limits.maxFiles`, 20_000),
      maxTotalBytes: count(limits.maxTotalBytes, `${path}.limits.maxTotalBytes`, 67_108_864),
      maxFileBytes: count(limits.maxFileBytes, `${path}.limits.maxFileBytes`, 1_048_576),
      maxManifestBytes: count(limits.maxManifestBytes, `${path}.limits.maxManifestBytes`, 262_144),
    },
    surfaceCount,
    diagnosticCount,
    detailOffset,
    surfaces,
    diagnostics,
    ...(nextPageCursor === undefined ? {} : { nextPageCursor }),
  };
}
function parseCandidate(value: unknown, path: string): AdoptionCandidate {
  const x = object(value, path);
  exact(x, path, [
    "candidateId",
    "discoveryFingerprint",
    "ecosystem",
    "scope",
    "kind",
    "displayName",
    "source",
    "packageId",
    "relativeResourcePath",
    "primary",
    "executable",
    "resourceCount",
    "warningCount",
    "malformed",
  ]);
  return {
    candidateId: parseAdoptionCandidateId(x.candidateId, `${path}.candidateId`),
    discoveryFingerprint: sha(x.discoveryFingerprint, `${path}.discoveryFingerprint`),
    ecosystem: parseAdoptionEcosystem(x.ecosystem, `${path}.ecosystem`),
    scope: parseAdoptionScope(x.scope, `${path}.scope`),
    kind: parseAdoptionResourceKind(x.kind, `${path}.kind`),
    displayName: text(x.displayName, `${path}.displayName`, 256),
    source: parseSource(x.source, `${path}.source`),
    ...(x.packageId === undefined
      ? {}
      : { packageId: text(x.packageId, `${path}.packageId`, 256) }),
    relativeResourcePath: pathText(x.relativeResourcePath, `${path}.relativeResourcePath`, true),
    primary: bool(x.primary, `${path}.primary`),
    executable: bool(x.executable, `${path}.executable`),
    ...(x.resourceCount === undefined
      ? {}
      : { resourceCount: count(x.resourceCount, `${path}.resourceCount`, 10_000) }),
    warningCount: count(x.warningCount, `${path}.warningCount`, 10_000),
    malformed: bool(x.malformed, `${path}.malformed`),
  };
}
function parseSource(value: unknown, path: string): AdoptionSourceLocator {
  const x = object(value, path);
  if (x.kind === "local") {
    exact(x, path, ["kind", "canonicalPath"]);
    return {
      kind: "local",
      canonicalPath: absoluteCanonicalHostPath(x.canonicalPath, `${path}.canonicalPath`),
    };
  }
  if (x.kind === "npm") {
    exact(x, path, ["kind", "registryOrigin", "packageName", "requested"]);
    return {
      kind: "npm",
      registryOrigin: safeUri(x.registryOrigin, `${path}.registryOrigin`, 2048),
      packageName: npmPackageName(x.packageName, `${path}.packageName`),
      requested: text(x.requested, `${path}.requested`, 512),
    };
  }
  if (x.kind === "git") {
    exact(x, path, ["kind", "repositoryUri", "requestedRef"]);
    return {
      kind: "git",
      repositoryUri: safeUri(x.repositoryUri, `${path}.repositoryUri`, 4096),
      requestedRef: text(x.requestedRef, `${path}.requestedRef`, 512),
    };
  }
  return fail(`${path}.kind`, "must be local, npm, or git");
}
function parseSourceLock(value: unknown, path: string): AdoptionSourceLock {
  const x = object(value, path);
  if (x.kind === "local-snapshot") {
    exact(x, path, ["kind", "treeSha256", "fileCount", "sizeBytes"]);
    return {
      kind: "local-snapshot",
      treeSha256: sha(x.treeSha256, `${path}.treeSha256`),
      fileCount: count(x.fileCount, `${path}.fileCount`),
      sizeBytes: count(x.sizeBytes, `${path}.sizeBytes`),
    };
  }
  if (x.kind === "npm") {
    exact(x, path, [
      "kind",
      "registryOrigin",
      "packageName",
      "version",
      "integrity",
      "tarballSha256",
    ]);
    return {
      kind: "npm",
      registryOrigin: safeUri(x.registryOrigin, `${path}.registryOrigin`, 2048),
      packageName: npmPackageName(x.packageName, `${path}.packageName`),
      version: text(x.version, `${path}.version`, 128),
      integrity: text(x.integrity, `${path}.integrity`, 256),
      tarballSha256: sha(x.tarballSha256, `${path}.tarballSha256`),
    };
  }
  if (x.kind === "git") {
    exact(x, path, ["kind", "repositoryUri", "commit", "treeSha256"]);
    return {
      kind: "git",
      repositoryUri: safeUri(x.repositoryUri, `${path}.repositoryUri`, 4096),
      commit: gitObjectId(x.commit, `${path}.commit`),
      treeSha256: sha(x.treeSha256, `${path}.treeSha256`),
    };
  }
  return fail(`${path}.kind`, "must be local-snapshot, npm, or git");
}
function parseSurface(value: unknown, path: string): AdoptionResourceSurface {
  const x = object(value, path);
  exact(x, path, [
    "surfaceId",
    "kind",
    "name",
    "relativePath",
    "primary",
    "executable",
    "compatibility",
    "compatibilityReason",
    "requiredCapabilities",
    "diagnosticCount",
    "dynamicBehavior",
  ]);
  const dynamic = enumValue(x.dynamicBehavior, `${path}.dynamicBehavior`, [
    "none",
    "reported",
    "unknown",
  ] as const);
  return {
    surfaceId: sha(x.surfaceId, `${path}.surfaceId`),
    kind: parseAdoptionResourceKind(x.kind, `${path}.kind`),
    name: text(x.name, `${path}.name`, 256),
    ...(x.relativePath === undefined
      ? {}
      : { relativePath: pathText(x.relativePath, `${path}.relativePath`, false) }),
    primary: bool(x.primary, `${path}.primary`),
    executable: bool(x.executable, `${path}.executable`),
    ...(x.compatibility === undefined
      ? {}
      : { compatibility: parseAdoptionCompatibility(x.compatibility, `${path}.compatibility`) }),
    ...(x.compatibilityReason === undefined
      ? {}
      : { compatibilityReason: text(x.compatibilityReason, `${path}.compatibilityReason`, 1024) }),
    requiredCapabilities: uniqueArray(
      x.requiredCapabilities,
      `${path}.requiredCapabilities`,
      64,
      (v, p) => code(v, p),
    ),
    diagnosticCount: count(x.diagnosticCount, `${path}.diagnosticCount`, 10_000),
    dynamicBehavior: dynamic,
  };
}
function parseDiagnostic(value: unknown, path: string): AdoptionDiagnosticSummary {
  const x = object(value, path);
  exact(x, path, ["code", "severity", "message", "relativePath", "surfaceId"]);
  return {
    code: code(x.code, `${path}.code`),
    severity: enumValue(x.severity, `${path}.severity`, ["info", "warning", "error"] as const),
    message: text(x.message, `${path}.message`, 1024),
    ...(x.relativePath === undefined
      ? {}
      : { relativePath: pathText(x.relativePath, `${path}.relativePath`, false) }),
    ...(x.surfaceId === undefined ? {} : { surfaceId: sha(x.surfaceId, `${path}.surfaceId`) }),
  };
}
function parseOperationSummary(
  value: unknown,
  path: string,
  additionalFields: readonly string[] = [],
): AdoptionOperationSummary {
  const x = object(value, path);
  exact(x, path, [
    "operationId",
    "state",
    "phase",
    "statusText",
    "sequence",
    "createdAt",
    "updatedAt",
    "adoptionId",
    "revisionId",
    "progress",
    ...additionalFields,
  ]);
  let progress: AdoptionOperationSummary["progress"];
  if (x.progress !== undefined) {
    const p = object(x.progress, `${path}.progress`);
    exact(p, `${path}.progress`, ["completed", "total", "unit"]);
    const completed = count(p.completed, `${path}.progress.completed`, 1e9);
    const total = p.total === undefined ? undefined : count(p.total, `${path}.progress.total`, 1e9);
    if (total !== undefined && completed > total)
      fail(`${path}.progress.completed`, "must not exceed total");
    progress = {
      completed,
      ...(total === undefined ? {} : { total }),
      ...(p.unit === undefined ? {} : { unit: text(p.unit, `${path}.progress.unit`, 128) }),
    };
  }
  return {
    operationId: parseAdoptionOperationId(x.operationId, `${path}.operationId`),
    state: parseAdoptionOperationState(x.state, `${path}.state`),
    phase: text(x.phase, `${path}.phase`, 512),
    statusText: text(x.statusText, `${path}.statusText`, 512),
    sequence: count(x.sequence, `${path}.sequence`),
    createdAt: count(x.createdAt, `${path}.createdAt`),
    updatedAt: count(x.updatedAt, `${path}.updatedAt`),
    ...(x.adoptionId === undefined
      ? {}
      : { adoptionId: parseAdoptionId(x.adoptionId, `${path}.adoptionId`) }),
    ...(x.revisionId === undefined
      ? {}
      : { revisionId: parseAdoptionRevisionId(x.revisionId, `${path}.revisionId`) }),
    ...(progress === undefined ? {} : { progress }),
  };
}
function parseOperationDetail(value: unknown, path: string): AdoptionOperationDetail {
  const x = object(value, path);
  const base = parseOperationSummary(value, path, [
    "candidate",
    "sourceLock",
    "compatibility",
    "capabilityRequests",
    "policy",
    "disclosure",
    "estimates",
    "verification",
    "diagnosticCount",
    "detailOffset",
    "diagnostics",
    "nextDetailPageCursor",
    "review",
  ]);
  const compatibility =
    x.compatibility === undefined
      ? undefined
      : parseCompatibilityReport(x.compatibility, `${path}.compatibility`);
  const capabilityRequests = array(x.capabilityRequests, `${path}.capabilityRequests`, 256).map(
    (value, index) => parseCapabilityRequest(value, `${path}.capabilityRequests[${index}]`),
  );
  assertUniqueBy(capabilityRequests, (request) => request.capability, `${path}.capabilityRequests`);
  const diagnosticCount = count(x.diagnosticCount, `${path}.diagnosticCount`, 10_000);
  const detailOffset = count(x.detailOffset, `${path}.detailOffset`, 20_000);
  const diagnostics = array(x.diagnostics, `${path}.diagnostics`, 100).map((v, i) =>
    parseDiagnostic(v, `${path}.diagnostics[${i}]`),
  );
  const nextDetailPageCursor = optionalCursor(
    x.nextDetailPageCursor,
    `${path}.nextDetailPageCursor`,
  );
  assertDetailPage(
    compatibility?.surfaceCount ?? 0,
    diagnosticCount,
    detailOffset,
    compatibility?.surfaces ?? [],
    diagnostics,
    nextDetailPageCursor,
    path,
  );
  return {
    ...base,
    ...(x.candidate === undefined
      ? {}
      : { candidate: parseCandidate(x.candidate, `${path}.candidate`) }),
    ...(x.sourceLock === undefined
      ? {}
      : { sourceLock: parseSourceLock(x.sourceLock, `${path}.sourceLock`) }),
    ...(compatibility === undefined ? {} : { compatibility }),
    capabilityRequests,
    ...(x.policy === undefined ? {} : { policy: parsePolicy(x.policy, `${path}.policy`) }),
    ...(x.disclosure === undefined
      ? {}
      : { disclosure: parseDisclosure(x.disclosure, `${path}.disclosure`) }),
    ...(x.estimates === undefined
      ? {}
      : { estimates: parseEstimates(x.estimates, `${path}.estimates`) }),
    ...(x.verification === undefined
      ? {}
      : { verification: parseVerification(x.verification, `${path}.verification`) }),
    diagnosticCount,
    detailOffset,
    diagnostics,
    ...(nextDetailPageCursor === undefined ? {} : { nextDetailPageCursor }),
    ...(x.review === undefined ? {} : { review: parseBlob(x.review, `${path}.review`) }),
  };
}
function optionalCursor(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path, 512);
}

function assertDetailPage(
  surfaceCount: number,
  diagnosticCount: number,
  detailOffset: number,
  surfaces: readonly AdoptionResourceSurface[],
  diagnostics: readonly AdoptionDiagnosticSummary[],
  nextCursor: string | undefined,
  path: string,
): void {
  if (surfaces.length + diagnostics.length > 100) {
    fail(path, "surfaces plus diagnostics must not exceed 100 entries per page");
  }
  const total = surfaceCount + diagnosticCount;
  const returned = surfaces.length + diagnostics.length;
  if (detailOffset > total || detailOffset + returned > total) {
    fail(`${path}.detailOffset`, "page range must not exceed declared totals");
  }
  if (detailOffset + returned < total && nextCursor === undefined) {
    fail(`${path}.nextDetailPageCursor`, "is required while detail entries remain");
  }
  if (detailOffset + returned === total && nextCursor !== undefined) {
    fail(`${path}.nextDetailPageCursor`, "must be absent on the final detail page");
  }
}

function parseCapabilityRequest(value: unknown, path: string): AdoptionCapabilityRequest {
  const x = object(value, path);
  exact(x, path, ["capability", "required", "rationale"]);
  return {
    capability: code(x.capability, `${path}.capability`),
    required: bool(x.required, `${path}.required`),
    rationale: text(x.rationale, `${path}.rationale`, 2048),
  };
}
function parsePolicy(value: unknown, path: string): AdoptionPolicyEvaluation {
  const x = object(value, path);
  exact(x, path, ["generation", "decision", "deniedCapabilities", "reasons"]);
  return {
    generation: text(x.generation, `${path}.generation`, 128),
    decision: enumValue(x.decision, `${path}.decision`, [
      "allow",
      "deny",
      "requires-approval",
    ] as const),
    deniedCapabilities: uniqueArray(
      x.deniedCapabilities,
      `${path}.deniedCapabilities`,
      256,
      (v, p) => code(v, p),
    ),
    reasons: array(x.reasons, `${path}.reasons`, 100).map((v, i) =>
      text(v, `${path}.reasons[${i}]`, 1024),
    ),
  };
}
function parseCompatibilitySummary(value: unknown, path: string): AdoptionCompatibilitySummary {
  const x = object(value, path);
  exact(x, path, [
    "primarySurfaceId",
    "overall",
    "surfaceCount",
    "unsupportedSurfaceCount",
    "partialAcknowledgementRequired",
  ]);
  const surfaceCount = count(x.surfaceCount, `${path}.surfaceCount`, 10_000);
  if (surfaceCount < 1) fail(`${path}.surfaceCount`, "must be at least 1");
  const unsupportedSurfaceCount = count(
    x.unsupportedSurfaceCount,
    `${path}.unsupportedSurfaceCount`,
    10_000,
  );
  if (unsupportedSurfaceCount > surfaceCount) {
    fail(`${path}.unsupportedSurfaceCount`, "must not exceed surfaceCount");
  }
  return {
    primarySurfaceId: sha(x.primarySurfaceId, `${path}.primarySurfaceId`),
    overall: parseAdoptionCompatibility(x.overall, `${path}.overall`),
    surfaceCount,
    unsupportedSurfaceCount,
    partialAcknowledgementRequired: bool(
      x.partialAcknowledgementRequired,
      `${path}.partialAcknowledgementRequired`,
    ),
  };
}
function parseCompatibilityReport(value: unknown, path: string): AdoptionCompatibilityReport {
  const x = object(value, path);
  const summary = parseCompatibilitySummary(
    {
      primarySurfaceId: x.primarySurfaceId,
      overall: x.overall,
      surfaceCount: x.surfaceCount,
      unsupportedSurfaceCount: x.unsupportedSurfaceCount,
      partialAcknowledgementRequired: x.partialAcknowledgementRequired,
    },
    path,
  );
  exact(x, path, [
    "primarySurfaceId",
    "overall",
    "surfaceCount",
    "unsupportedSurfaceCount",
    "surfaces",
    "partialAcknowledgementRequired",
  ]);
  const surfaces = array(x.surfaces, `${path}.surfaces`, 100).map((v, i) =>
    parseSurface(v, `${path}.surfaces[${i}]`),
  );
  assertUniqueBy(surfaces, (surface) => surface.surfaceId, `${path}.surfaces`);
  if (surfaces.length > summary.surfaceCount) {
    fail(`${path}.surfaces`, "page length must not exceed surfaceCount");
  }
  const primarySurfaces = surfaces.filter((surface) => surface.primary);
  if (
    primarySurfaces.length > 1 ||
    primarySurfaces.some((surface) => surface.surfaceId !== summary.primarySurfaceId)
  ) {
    fail(`${path}.primarySurfaceId`, "must identify the only primary surface on this page");
  }
  return { ...summary, surfaces };
}
function parseDisclosure(value: unknown, path: string): AdoptionSourceDisclosureManifest {
  const x = object(value, path);
  exact(x, path, [
    "manifestSha256",
    "providerId",
    "modelId",
    "endpointLocation",
    "fileCount",
    "filesSha256",
    "totalBytes",
    "files",
    "filesBlob",
    "retentionMetadataRevision",
  ]);
  const fileCount = count(x.fileCount, `${path}.fileCount`, 20_000);
  const files =
    x.files === undefined
      ? undefined
      : array(x.files, `${path}.files`, 100).map((v, i) => {
          const p = `${path}.files[${i}]`;
          const f = object(v, p);
          exact(f, p, ["relativePath", "sha256", "sizeBytes"]);
          return {
            relativePath: pathText(f.relativePath, `${p}.relativePath`, false),
            sha256: sha(f.sha256, `${p}.sha256`),
            sizeBytes: count(f.sizeBytes, `${p}.sizeBytes`),
          };
        });
  if (files !== undefined) {
    assertUniqueBy(files, (file) => file.relativePath, `${path}.files`);
  }
  const filesSha256 = sha(x.filesSha256, `${path}.filesSha256`);
  const filesBlob =
    x.filesBlob === undefined
      ? undefined
      : parseBlob(x.filesBlob, `${path}.filesBlob`, 256 * 1_024 * 1_024);
  if (filesBlob !== undefined) {
    if (filesBlob.mediaType !== "application/vnd.axl.adoption-disclosure+json") {
      fail(`${path}.filesBlob.mediaType`, "must identify an adoption disclosure manifest");
    }
    if (filesBlob.sha256 !== filesSha256) {
      fail(`${path}.filesBlob.sha256`, "must match filesSha256");
    }
  }
  if (files === undefined && filesBlob === undefined) {
    fail(path, "must contain files or filesBlob");
  }
  if (files !== undefined && files.length > fileCount) {
    fail(`${path}.files`, "must not contain more entries than fileCount");
  }
  if (filesBlob === undefined && files?.length !== fileCount) {
    fail(`${path}.filesBlob`, "is required when the inline file page is incomplete");
  }
  return {
    manifestSha256: sha(x.manifestSha256, `${path}.manifestSha256`),
    providerId: text(x.providerId, `${path}.providerId`, 512),
    modelId: text(x.modelId, `${path}.modelId`, 512),
    endpointLocation: enumValue(x.endpointLocation, `${path}.endpointLocation`, [
      "local",
      "remote",
      "unknown",
    ] as const),
    fileCount,
    filesSha256,
    totalBytes: count(x.totalBytes, `${path}.totalBytes`),
    ...(files === undefined ? {} : { files }),
    ...(filesBlob === undefined ? {} : { filesBlob }),
    retentionMetadataRevision: text(
      x.retentionMetadataRevision,
      `${path}.retentionMetadataRevision`,
      128,
    ),
  };
}
function parseEstimates(value: unknown, path: string): AdoptionEstimates {
  const x = object(value, path);
  exact(x, path, ["inputTokens", "outputTokens", "durationMs", "costUsd", "pricingRevision"]);
  return {
    inputTokens: range(x.inputTokens, `${path}.inputTokens`, 2e9),
    outputTokens: range(x.outputTokens, `${path}.outputTokens`, 2e9),
    ...(x.durationMs === undefined
      ? {}
      : { durationMs: range(x.durationMs, `${path}.durationMs`, 604_800_000) }),
    ...(x.costUsd === undefined ? {} : { costUsd: range(x.costUsd, `${path}.costUsd`, 1e6, true) }),
    ...(x.pricingRevision === undefined
      ? {}
      : { pricingRevision: text(x.pricingRevision, `${path}.pricingRevision`, 128) }),
  };
}
function parseVerification(value: unknown, path: string): AdoptionVerificationSummary {
  const x = object(value, path);
  exact(x, path, ["status", "steps", "evidenceSha256"]);
  const steps = array(x.steps, `${path}.steps`, 100).map((v, i) => {
    const p = `${path}.steps[${i}]`;
    const s = object(v, p);
    exact(s, p, ["id", "name", "status", "toolVersion", "log"]);
    return {
      id: code(s.id, `${p}.id`),
      name: text(s.name, `${p}.name`, 256),
      status: enumValue(s.status, `${p}.status`, [
        "pending",
        "running",
        "passed",
        "failed",
        "skipped",
      ] as const),
      toolVersion: text(s.toolVersion, `${p}.toolVersion`, 128),
      ...(s.log === undefined ? {} : { log: parseBlob(s.log, `${p}.log`) }),
    };
  });
  assertUniqueBy(steps, (step) => step.id, `${path}.steps`);
  return {
    status: enumValue(x.status, `${path}.status`, [
      "pending",
      "running",
      "passed",
      "failed",
    ] as const),
    steps,
    ...(x.evidenceSha256 === undefined
      ? {}
      : { evidenceSha256: sha(x.evidenceSha256, `${path}.evidenceSha256`) }),
  };
}
function parsePackage(value: unknown, path: string): AdoptedPackageSummary {
  const x = object(value, path);
  exact(x, path, [
    "adoptionId",
    "displayName",
    "ecosystem",
    "scope",
    "enabled",
    "activeRevisionId",
    "revisionCount",
  ]);
  return {
    adoptionId: parseAdoptionId(x.adoptionId, `${path}.adoptionId`),
    displayName: text(x.displayName, `${path}.displayName`, 256),
    ecosystem: parseAdoptionEcosystem(x.ecosystem, `${path}.ecosystem`),
    scope: parseAdoptionScope(x.scope, `${path}.scope`),
    enabled: bool(x.enabled, `${path}.enabled`),
    ...(x.activeRevisionId === undefined
      ? {}
      : {
          activeRevisionId: parseAdoptionRevisionId(x.activeRevisionId, `${path}.activeRevisionId`),
        }),
    revisionCount: count(x.revisionCount, `${path}.revisionCount`, 10_000),
  };
}
function parseRevision(value: unknown, path: string): AdoptedRevisionSummary {
  const x = object(value, path);
  exact(x, path, [
    "revisionId",
    "createdAt",
    "active",
    "manifestSha256",
    "compatibility",
    "parentRevisionId",
  ]);
  return {
    revisionId: parseAdoptionRevisionId(x.revisionId, `${path}.revisionId`),
    createdAt: count(x.createdAt, `${path}.createdAt`),
    active: bool(x.active, `${path}.active`),
    manifestSha256: sha(x.manifestSha256, `${path}.manifestSha256`),
    compatibility: parseAdoptionCompatibility(x.compatibility, `${path}.compatibility`),
    ...(x.parentRevisionId === undefined
      ? {}
      : {
          parentRevisionId: parseAdoptionRevisionId(x.parentRevisionId, `${path}.parentRevisionId`),
        }),
  };
}
function parseDiff(value: unknown, path: string): AdoptionDiffSummary {
  const x = object(value, path);
  exact(x, path, [
    "fromRevisionId",
    "toRevisionId",
    "filesChanged",
    "surfacesChanged",
    "truncated",
    "body",
  ]);
  return {
    ...(x.fromRevisionId === undefined
      ? {}
      : { fromRevisionId: parseAdoptionRevisionId(x.fromRevisionId, `${path}.fromRevisionId`) }),
    toRevisionId: parseAdoptionRevisionId(x.toRevisionId, `${path}.toRevisionId`),
    filesChanged: count(x.filesChanged, `${path}.filesChanged`),
    surfacesChanged: count(x.surfacesChanged, `${path}.surfacesChanged`),
    truncated: bool(x.truncated, `${path}.truncated`),
    ...(x.body === undefined ? {} : { body: parseBlob(x.body, `${path}.body`) }),
  };
}
function parseUpdatePreview(value: unknown, path: string): AdoptionUpdatePreview {
  const x = object(value, path);
  exact(x, path, ["adoptionId", "currentRevisionId", "source", "available", "requestedRef"]);
  return {
    adoptionId: parseAdoptionId(x.adoptionId, `${path}.adoptionId`),
    currentRevisionId: parseAdoptionRevisionId(x.currentRevisionId, `${path}.currentRevisionId`),
    source: parseSource(x.source, `${path}.source`),
    available: bool(x.available, `${path}.available`),
    ...(x.requestedRef === undefined
      ? {}
      : { requestedRef: text(x.requestedRef, `${path}.requestedRef`, 512) }),
  };
}
function parseRollbackPreview(value: unknown, path: string): AdoptionRollbackPreview {
  const x = object(value, path);
  exact(x, path, ["adoptionId", "fromRevisionId", "toRevisionId", "compatibility"]);
  return {
    adoptionId: parseAdoptionId(x.adoptionId, `${path}.adoptionId`),
    fromRevisionId: parseAdoptionRevisionId(x.fromRevisionId, `${path}.fromRevisionId`),
    toRevisionId: parseAdoptionRevisionId(x.toRevisionId, `${path}.toRevisionId`),
    compatibility: parseCompatibilitySummary(x.compatibility, `${path}.compatibility`),
  };
}
function parseBlob(value: unknown, path: string, maxSizeBytes = 67_108_864): BlobReference {
  const x = object(value, path);
  exact(x, path, ["sha256", "mediaType", "sizeBytes", "name"]);
  return {
    sha256: sha(x.sha256, `${path}.sha256`),
    mediaType: text(x.mediaType, `${path}.mediaType`, 128),
    sizeBytes: count(x.sizeBytes, `${path}.sizeBytes`, maxSizeBytes),
    ...(x.name === undefined ? {} : { name: text(x.name, `${path}.name`, 256) }),
  };
}
function range(value: unknown, path: string, max: number, float = false): AdoptionEstimateRange {
  const x = object(value, path);
  exact(x, path, ["lower", "upper"]);
  const lower = number(x.lower, `${path}.lower`, max, float);
  const upper = number(x.upper, `${path}.upper`, max, float);
  if (lower > upper) fail(path, "lower must not exceed upper");
  return { lower, upper };
}
function safeUri(value: unknown, path: string, max: number): string {
  const result = text(value, path, max);
  if (hasAsciiControl(result, true)) {
    return fail(path, "must not contain whitespace or control characters");
  }
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    return fail(path, "must be an absolute URL");
  }
  if (url.username || url.password) fail(path, "must not contain credentials");
  if (url.search || url.hash) fail(path, "must not contain query or fragment data");
  if (url.protocol !== "https:") fail(path, "must use HTTPS");
  return result;
}
function absoluteCanonicalHostPath(value: unknown, path: string): string {
  const result = text(value, path, 4096);
  if (result !== result.normalize("NFC")) fail(path, "must use Unicode NFC");
  if (hasAsciiControl(result, false)) fail(path, "must not contain control characters");

  if (result.startsWith("/")) {
    if (result === "/") return result;
    if (result.endsWith("/") || result.includes("//")) {
      fail(path, "must be a canonical POSIX absolute path");
    }
    const segments = result.split("/").slice(1);
    if (segments.some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
      fail(path, "must not contain empty, dot, or dot-dot segments");
    }
    return result;
  }

  if (/^[A-Z]:\\/.test(result)) {
    if (result.length === 3) return result;
    if (result.endsWith("\\")) fail(path, "must not have a trailing separator");
    const segments = result.slice(3).split("\\");
    if (segments.some((segment) => !validWindowsSegment(segment))) {
      fail(path, "must not contain empty, dot, dot-dot, or invalid Windows segments");
    }
    if (result.includes("/")) fail(path, "must use canonical Windows separators");
    return result;
  }

  if (result.startsWith("\\\\")) {
    if (result.endsWith("\\") || result.includes("/")) {
      fail(path, "must be a canonical UNC absolute path");
    }
    const segments = result.slice(2).split("\\");
    if (segments.length < 2 || segments.some((segment) => !validWindowsSegment(segment))) {
      fail(path, "must contain canonical UNC server and share segments");
    }
    return result;
  }

  return fail(path, "must be an absolute canonical POSIX, drive-letter, or UNC path");
}
function validWindowsSegment(segment: string): boolean {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    /[<>:"|?*]/.test(segment) ||
    /[. ]$/.test(segment)
  ) {
    return false;
  }
  const basename = segment.split(".", 1)[0]?.toUpperCase();
  return !(
    basename === "CON" ||
    basename === "PRN" ||
    basename === "AUX" ||
    basename === "NUL" ||
    /^COM[1-9]$/.test(basename ?? "") ||
    /^LPT[1-9]$/.test(basename ?? "")
  );
}
function pathText(value: unknown, path: string, allowEmpty: boolean): string {
  const result = text(value, path, 4096, allowEmpty);
  if (
    result.startsWith("/") ||
    result.includes("\\") ||
    result.split("/").some((v) => v === "." || v === ".." || v === "")
  ) {
    if (!(allowEmpty && result === "")) fail(path, "must be a normalized relative path");
  }
  if (result !== result.normalize("NFC")) fail(path, "must use Unicode NFC");
  return result;
}
function sha(value: unknown, path: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value))
    return fail(path, "must be 64 lowercase hexadecimal characters");
  return value;
}
function hasAsciiControl(value: string, includeSpace: boolean): boolean {
  const maximum = includeSpace ? 0x20 : 0x1f;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= maximum || codePoint === 0x7f) return true;
  }
  return false;
}
function npmPackageName(value: unknown, path: string): string {
  const result = text(value, path, 256);
  if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(result)) {
    return fail(path, "must be a valid lowercase npm package name");
  }
  return result;
}
function gitObjectId(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    return fail(path, "must be a full lowercase SHA-1 or SHA-256 Git object ID");
  }
  return value;
}
function code(value: unknown, path: string): string {
  const result = text(value, path, 128);
  if (!CODE_PATTERN.test(result)) fail(path, "must be a protocol identifier");
  return result;
}
function text(value: unknown, path: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") return fail(path, "must be a string");
  const bytes = new TextEncoder().encode(value).byteLength;
  if ((!allowEmpty && bytes === 0) || bytes > max)
    return fail(path, `must contain ${allowEmpty ? "at most" : "1 to"} ${max} UTF-8 bytes`);
  return value;
}
function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return fail(path, "must be a boolean");
  return value;
}
function number(value: unknown, path: string, max: number, float = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    (!float && !Number.isSafeInteger(value))
  )
    return fail(path, `must be a ${float ? "finite number" : "safe integer"} from 0 to ${max}`);
  return value;
}
function count(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): number {
  return number(value, path, max);
}
function pageSize(value: unknown, path: string): number {
  const result = count(value, path, 100);
  if (result < 1) fail(path, "must be from 1 to 100");
  return result;
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail(path, "must be an object");
  return value as Record<string, unknown>;
}
function array(value: unknown, path: string, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max)
    return fail(path, `must be an array with at most ${max} entries`);
  return value;
}
function uniqueArray<T>(
  value: unknown,
  path: string,
  max: number,
  parse: (value: unknown, path: string) => T,
): readonly T[] {
  const values = array(value, path, max).map((v, i) => parse(v, `${path}[${i}]`));
  if (new Set(values).size !== values.length) fail(path, "must not contain duplicates");
  return values;
}
function assertUniqueBy<T>(values: readonly T[], key: (value: T) => string, path: string): void {
  if (new Set(values.map(key)).size !== values.length) fail(path, "must not contain duplicates");
}
function enumValue<const T extends readonly string[]>(
  value: unknown,
  path: string,
  values: T,
): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value))
    return fail(path, `must be one of: ${values.join(", ")}`);
  return value as T[number];
}
function exact(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) fail(`${path}.${key}`, "is not allowed");
}
function boundedJson(value: unknown, path: string): void {
  const seen = new Set<object>();
  const walk = (item: unknown, depth: number): void => {
    if (depth > 32) fail(path, "exceeds maximum JSON depth");
    if (item && typeof item === "object") {
      if (seen.has(item)) fail(path, "must not contain cycles");
      seen.add(item);
      for (const child of Array.isArray(item)
        ? item
        : Object.values(item as Record<string, unknown>))
        walk(child, depth + 1);
      seen.delete(item);
    }
  };
  walk(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 786_432)
    fail(path, "exceeds adoption result size limit");
}
function fail(path: string, message: string): never {
  throw new ProtocolValidationError(path, message);
}
