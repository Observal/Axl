// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  DEFAULT_INSPECTION_LIMITS,
  type DiscoveryCandidate,
  type DiscoveryContext,
  type DiscoveryDiagnostic,
  DiscoveryError,
  type DiscoveryResult,
  discover,
  inspectCandidate,
  inspectSource,
  type ResourceSurface,
  sourceAdapters,
} from "@axl/compiler";
import {
  type AdoptionRegistryEntry,
  type AdoptionRequestContext,
  type AdoptionService,
  AdoptionServiceError,
  type NativeAdoptionOperationRecord,
} from "@axl/daemon";
import { loadSkill } from "@axl/extension-skills";
import {
  ADOPTION_LIMITS,
  type AdoptionCandidate,
  type AdoptionDiagnosticSummary,
  type AdoptionDiscoverParams,
  type AdoptionDiscoverResult,
  type AdoptionInspectParams,
  type AdoptionInspectResult,
  type AdoptionManifest,
  type AdoptionOperationDetail,
  type AdoptionOperationId,
  type AdoptionOperationSummary,
  type AdoptionResourceSurface,
  type AdoptionRpcMethodMap,
  type AdoptionScope,
  type AdoptionTrustReview,
  parseAdoptionApprovalId,
  parseAdoptionId,
  parseAdoptionOperationId,
  parseAdoptionRevisionId,
  parseRpcResult,
} from "@axl/protocol";
import type { AdoptionAcquisitionCoordinator } from "./adoption-acquisition.ts";

const CACHE_ENTRIES = 8;
const CURSOR_ENTRIES = 512;
// A discovery snapshot must remain selectable for normal human review in the
// picker. Inspection still performs a fresh fingerprint revalidation.
const CACHE_LIFETIME_MS = 5 * 60_000;
const CURSOR_LIFETIME_MS = 5 * 60_000;

interface ScanCacheEntry {
  readonly key: string;
  readonly generation: string;
  readonly context: DiscoveryContext;
  readonly result: DiscoveryResult;
  readonly createdAt: number;
}

interface DiscoverCursor {
  readonly kind: "discover";
  readonly requestKey: string;
  readonly generation: string;
  readonly candidates: readonly AdoptionCandidate[];
  readonly warnings: readonly AdoptionDiagnosticSummary[];
  readonly candidateOffset: number;
  readonly warningOffset: number;
  readonly createdAt: number;
}

interface InspectCursor {
  readonly kind: "inspect";
  readonly requestKey: string;
  readonly result: Omit<
    AdoptionInspectResult,
    "detailOffset" | "surfaces" | "diagnostics" | "nextPageCursor"
  >;
  readonly surfaces: readonly AdoptionResourceSurface[];
  readonly diagnostics: readonly AdoptionDiagnosticSummary[];
  readonly offset: number;
  readonly createdAt: number;
}

type CursorRecord = DiscoverCursor | InspectCursor;

export interface LocalAdoptionServiceOptions {
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly cacheLifetimeMs?: number;
  readonly acquisition?: AdoptionAcquisitionCoordinator;
  /** Optional process-host policy that may further narrow opened Axl session roots. */
  readonly authorizeProjectRoot?: (
    canonicalRoot: string,
    context: AdoptionRequestContext,
  ) => boolean | Promise<boolean>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function uuidV7(): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp >> BigInt((5 - index) * 8)) & 0xff;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return `${bytes.toString("hex", 0, 4)}-${bytes.toString("hex", 4, 6)}-${bytes.toString("hex", 6, 8)}-${bytes.toString("hex", 8, 10)}-${bytes.toString("hex", 10)}`;
}

const NATIVE_SKILL_POLICY_GENERATION = sha256(
  "axl-native-agent-skills-v1:block-executable:block-manual-only:explicit-collisions",
);
const SCRIPT_PATH = /\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|fish|rb|pl|ps1|cmd|bat)$/iu;

interface NativeSkillOperation extends NativeAdoptionOperationRecord {
  /** Present only until restart and used for an extra discovery-fingerprint check. */
  readonly discoveryCandidate?: DiscoveryCandidate;
  readonly discoveryContext?: DiscoveryContext;
}

function within(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

function diagnostic(input: DiscoveryDiagnostic): AdoptionDiagnosticSummary {
  return {
    code: input.code,
    severity: input.severity,
    // Compiler diagnostics can wrap parser failures whose native messages include
    // source fragments. Public diagnostics identify the condition without copying
    // hostile or potentially sensitive source content across the daemon boundary.
    message: `Source inspection reported ${input.code}`,
    ...(input.relativePath === undefined ? {} : { relativePath: input.relativePath }),
  };
}

function surface(candidate: DiscoveryCandidate, item: ResourceSurface): AdoptionResourceSurface {
  return {
    surfaceId: sha256(
      canonicalJson({
        candidateId: candidate.candidateId,
        kind: item.kind,
        name: item.name.normalize("NFC"),
        relativePath: item.relativePath.normalize("NFC"),
      }),
    ),
    kind: item.kind,
    name: item.name,
    relativePath: item.relativePath,
    primary: item.primary,
    executable: item.executable,
    // Static indicators are diagnostics, not grants or requested capabilities.
    requiredCapabilities: [],
    diagnosticCount: candidate.diagnostics.filter(
      (entry) => entry.relativePath === item.relativePath,
    ).length,
    dynamicBehavior: item.dynamicBehavior ? "unknown" : "none",
  };
}

function candidateSourcePath(candidate: DiscoveryCandidate): string {
  const path = resolve(candidate.provenance.canonicalRoot, candidate.provenance.relativePath);
  if (!within(path, candidate.provenance.canonicalRoot)) {
    throw new AdoptionServiceError(
      "adoption_source_unavailable",
      "Discovered source is outside its approved root",
    );
  }
  return candidate.kind === "skill" ? dirname(path) : candidate.provenance.canonicalRoot;
}

function primarySurface(candidate: DiscoveryCandidate): ResourceSurface {
  const value = candidate.surfaces.find((item) => item.primary) ?? candidate.surfaces[0];
  if (value === undefined)
    throw new AdoptionServiceError(
      "adoption_primary_unsupported",
      "Candidate has no primary surface",
    );
  return value;
}

function publicCandidate(candidate: DiscoveryCandidate): AdoptionCandidate {
  return {
    candidateId: candidate.candidateId as AdoptionCandidate["candidateId"],
    discoveryFingerprint: candidate.discoveryFingerprint,
    ecosystem: candidate.ecosystem,
    scope: candidate.scope,
    kind: candidate.kind,
    displayName: candidate.displayName,
    source: { kind: "local", canonicalPath: candidateSourcePath(candidate) },
    ...(candidate.packageIdentity === undefined ? {} : { packageId: candidate.packageIdentity }),
    relativeResourcePath:
      candidate.kind === "skill" ? "SKILL.md" : candidate.provenance.relativePath,
    primary: candidate.primary,
    executable: candidate.executable,
    resourceCount: candidate.surfaces.length,
    warningCount: candidate.diagnostics.filter((entry) => entry.severity !== "info").length,
    malformed: candidate.malformed,
  };
}

function mapError(error: unknown): never {
  if (error instanceof AdoptionServiceError) throw error;
  if (error instanceof DiscoveryError) {
    const code =
      error.code === "adoption_source_unavailable" && error.message === "candidate was not found"
        ? "adoption_candidate_not_found"
        : error.code;
    const messages: Readonly<Record<string, string>> = {
      adoption_candidate_not_found: "Adoption candidate was not found",
      adoption_manifest_invalid: "Source manifest is invalid",
      adoption_project_untrusted: "Project root is not trusted",
      adoption_scan_limit_exceeded: "Discovery exceeded a configured limit",
      adoption_source_changed: "Source changed during discovery",
      adoption_source_schema_unsupported: "Source schema is unsupported",
      adoption_source_unavailable: "Source is unavailable",
    };
    throw new AdoptionServiceError(code, messages[code] ?? "Adoption discovery failed", {
      ...(error.relativePath === undefined ? {} : { relativePath: error.relativePath }),
    });
  }
  if (error instanceof DOMException && error.name === "AbortError") throw error;
  throw new AdoptionServiceError("internal_error", "Adoption discovery failed");
}

/** Runtime composition of the data-only compiler behind the daemon service contract. */
export class LocalAdoptionService implements AdoptionService {
  private readonly homeDirectory: string;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly authorizeProjectRoot: NonNullable<
    LocalAdoptionServiceOptions["authorizeProjectRoot"]
  >;
  private readonly cacheLifetimeMs: number;
  readonly acquisition: AdoptionAcquisitionCoordinator | undefined;
  private readonly cache = new Map<string, ScanCacheEntry>();
  private readonly cursors = new Map<string, CursorRecord>();
  private readonly lifecycle = new AbortController();
  private readonly nativeOperations = new Map<AdoptionOperationId, NativeSkillOperation>();
  private nativeOperationsLoaded: Promise<void> | undefined;
  private activationListener:
    | ((
        scope: AdoptionScope,
        registryGeneration: number,
        projectRoot?: string,
      ) => void | Promise<void>)
    | undefined;
  private disposed = false;

  constructor(options: LocalAdoptionServiceOptions = {}) {
    this.homeDirectory = resolve(options.homeDirectory ?? homedir());
    this.environment = Object.freeze({ ...(options.environment ?? process.env) });
    this.cacheLifetimeMs = options.cacheLifetimeMs ?? CACHE_LIFETIME_MS;
    this.acquisition = options.acquisition;
    this.authorizeProjectRoot = options.authorizeProjectRoot ?? (() => true);
  }

  setActivationListener(
    listener: (
      scope: AdoptionScope,
      registryGeneration: number,
      projectRoot?: string,
    ) => void | Promise<void>,
  ): void {
    this.activationListener = listener;
  }

  async prime(): Promise<void> {
    if (this.disposed) return;
    await this.ensureNativeOperations();
    await this.scan(
      {},
      {
        attachmentId: "daemon-prime",
        client: { kind: "daemon", version: "1", instanceId: "daemon-prime" },
        openedProjectRoots: [],
      },
      this.lifecycle.signal,
    );
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.lifecycle.abort();
    this.cache.clear();
    this.cursors.clear();
    return Promise.resolve();
  }

  async discover(
    params: AdoptionDiscoverParams,
    context: AdoptionRequestContext,
    signal?: AbortSignal,
  ): Promise<AdoptionDiscoverResult> {
    try {
      const operationSignal = this.operationSignal(signal);
      this.ready(operationSignal);
      const requestKey = canonicalJson({
        attachmentId: context.attachmentId,
        ecosystems: params.ecosystems ?? null,
        scopes: params.scopes ?? null,
        projectRoot: params.projectRoot ?? null,
        query: params.query ?? null,
        includeMalformed: params.includeMalformed ?? false,
      });
      if (params.pageCursor !== undefined) {
        const cursor = this.takeCursor(params.pageCursor, "discover", requestKey);
        return this.discoveryPage(cursor, params.pageSize);
      }
      const scan = await this.scan(params, context, operationSignal);
      const query = params.query?.normalize("NFC").toLocaleLowerCase();
      const scopes = new Set(params.scopes ?? ["global", "project"]);
      const candidates = scan.result.candidates
        .filter((entry) => scopes.has(entry.scope))
        .filter((entry) => params.includeMalformed === true || !entry.malformed)
        .filter(
          (entry) =>
            query === undefined ||
            entry.displayName.normalize("NFC").toLocaleLowerCase().includes(query) ||
            entry.kind.includes(query) ||
            entry.ecosystem.includes(query),
        )
        .map(publicCandidate);
      return this.discoveryPage(
        {
          kind: "discover",
          requestKey,
          generation: scan.generation,
          candidates,
          warnings: scan.result.diagnostics.map(diagnostic),
          candidateOffset: 0,
          warningOffset: 0,
          createdAt: Date.now(),
        },
        params.pageSize,
      );
    } catch (error) {
      return mapError(error);
    }
  }

  async inspect(
    params: AdoptionInspectParams,
    context: AdoptionRequestContext,
    signal?: AbortSignal,
  ): Promise<AdoptionInspectResult> {
    try {
      const operationSignal = this.operationSignal(signal);
      this.ready(operationSignal);
      const requestKey = canonicalJson({
        attachmentId: context.attachmentId,
        candidateId: params.candidateId,
        fingerprint: params.expectedDiscoveryFingerprint,
      });
      if (params.pageCursor !== undefined) {
        const cursor = this.takeCursor(params.pageCursor, "inspect", requestKey);
        return this.inspectionPage(cursor, params.pageSize);
      }
      const cached = [...this.cache.values()]
        .sort((left, right) => right.createdAt - left.createdAt)
        .find((entry) =>
          entry.result.candidates.some((candidate) => candidate.candidateId === params.candidateId),
        );
      if (cached === undefined) {
        throw new AdoptionServiceError(
          "adoption_candidate_not_found",
          "Candidate is not present in a current discovery snapshot",
        );
      }
      if (
        cached.context.projectDirectory !== undefined &&
        !context.openedProjectRoots.includes(cached.context.projectDirectory)
      ) {
        throw new AdoptionServiceError(
          "adoption_project_untrusted",
          "Project root is no longer an opened Axl session root",
        );
      }
      const cachedCandidate = cached.result.candidates.find(
        (candidate) => candidate.candidateId === params.candidateId,
      );
      if (cachedCandidate === undefined) {
        throw new AdoptionServiceError(
          "adoption_candidate_not_found",
          "Candidate is not present in a current discovery snapshot",
        );
      }
      const inspected = await inspectCandidate(
        cached.context,
        params.candidateId,
        params.expectedDiscoveryFingerprint,
        { ecosystems: [cachedCandidate.ecosystem], signal: operationSignal },
      );
      this.ready(operationSignal);
      const publicValue = publicCandidate(inspected);
      const surfaces = inspected.surfaces.map((entry) => surface(inspected, entry));
      const diagnostics = inspected.diagnostics.map(diagnostic);
      const licenseExpression = inspected.inventory?.gallery.license;
      const trustReview =
        inspected.kind === "skill" && !inspected.malformed
          ? await this.buildTrustReview(inspected, cached.context, inspected.scope)
          : undefined;
      const base: InspectCursor["result"] = {
        candidate: publicValue,
        adapter: {
          id: inspected.adapterId,
          version: inspected.adapterVersion,
          sourceSchemaVersion: inspected.sourceSchemaVersion,
        },
        license: {
          expressions: licenseExpression === undefined ? [] : [licenseExpression],
          notices: [],
        },
        inventory: {
          fileCount: inspected.sourceFileCount,
          totalBytes: inspected.sourceTotalBytes,
          executable: inspected.sourceExecutable || inspected.executable,
        },
        limits: {
          maxTraversalDepth: cached.result.appliedLimits.maxDepth,
          maxEntries: cached.result.appliedLimits.maxEntries,
          maxFiles: cached.result.appliedLimits.maxFiles,
          maxTotalBytes: cached.result.appliedLimits.maxTotalBytes,
          maxFileBytes: cached.result.appliedLimits.maxFileBytes,
          maxManifestBytes: cached.result.appliedLimits.maxManifestBytes,
        },
        surfaceCount: surfaces.length,
        diagnosticCount: diagnostics.length,
        ...(trustReview === undefined ? {} : { trustReview }),
      };
      return this.inspectionPage(
        {
          kind: "inspect",
          requestKey,
          result: base,
          surfaces,
          diagnostics,
          offset: 0,
          createdAt: Date.now(),
        },
        params.pageSize,
      );
    } catch (error) {
      return mapError(error);
    }
  }

  async plan(
    params: AdoptionRpcMethodMap["adoption.plan"]["params"],
    context: AdoptionRequestContext,
    _signal?: AbortSignal,
  ): Promise<AdoptionRpcMethodMap["adoption.plan"]["result"]> {
    await this.ensureNativeOperations();
    const { candidate, snapshot } = this.cachedCandidate(params.candidateId, context);
    if (candidate.kind !== "skill" || candidate.malformed) {
      throw new AdoptionServiceError(
        "adoption_primary_unsupported",
        "Only valid Agent Skills can be installed natively in this stage",
      );
    }
    if (params.expectedDiscoveryFingerprint !== candidate.discoveryFingerprint)
      throw new AdoptionServiceError("adoption_source_changed", "Discovery fingerprint changed");
    const selectedSurface = surface(candidate, primarySurface(candidate));
    if (
      params.selectedSurfaceIds !== undefined &&
      (params.selectedSurfaceIds.length !== 1 ||
        params.selectedSurfaceIds[0] !== selectedSurface.surfaceId)
    )
      throw new AdoptionServiceError(
        "adoption_primary_unsupported",
        "Native skill installation requires the complete primary skill surface",
      );
    if (params.targetScope === "project" && snapshot.context.projectDirectory === undefined)
      throw new AdoptionServiceError(
        "adoption_project_untrusted",
        "Project activation requires an opened project root",
      );
    const publicValue = publicCandidate(candidate);
    const review = await this.buildTrustReview(candidate, snapshot.context, params.targetScope);
    const operationId = parseAdoptionOperationId(uuidV7());
    const operation: NativeSkillOperation = {
      version: 1,
      operationId,
      sequence: 1,
      state: "awaiting-plan-approval",
      candidate: publicValue,
      surface: selectedSurface,
      adapter: {
        id: candidate.adapterId,
        version: candidate.adapterVersion,
        sourceSchemaVersion: candidate.sourceSchemaVersion,
      },
      targetScope: params.targetScope,
      review,
      ...(snapshot.context.projectDirectory === undefined
        ? {}
        : { projectRoot: snapshot.context.projectDirectory }),
      packageId: candidate.packageIdentity ?? `skill:${candidate.displayName}`,
      adoptionId: parseAdoptionId(uuidV7()),
      revisionId: parseAdoptionRevisionId(uuidV7()),
      createdAt: Date.now(),
      discoveryCandidate: candidate,
      discoveryContext: snapshot.context,
    };
    await this.persistNativeOperation(operation);
    return parseRpcResult("adoption.plan", {
      operationId,
      operation: this.operationDetail(operation),
    });
  }

  async start(
    params: AdoptionRpcMethodMap["adoption.start"]["params"],
    _context: AdoptionRequestContext,
    signal?: AbortSignal,
  ): Promise<AdoptionRpcMethodMap["adoption.start"]["result"]> {
    await this.ensureNativeOperations();
    const operation = this.nativeOperation(params.operationId, "awaiting-plan-approval");
    if (
      operation.review.conflicts.some((conflict) => conflict.includes("disable-model-invocation"))
    )
      throw new AdoptionServiceError(
        "adoption_primary_unsupported",
        "Pi disable-model-invocation skills require manual-only activation support",
      );
    if (operation.review.conflicts.length > 0)
      throw new AdoptionServiceError(
        "adoption_collision",
        "Native skill activation has unresolved name conflicts",
      );
    try {
      if (operation.discoveryCandidate !== undefined && operation.discoveryContext !== undefined) {
        await inspectCandidate(
          operation.discoveryContext,
          operation.discoveryCandidate.candidateId,
          operation.discoveryCandidate.discoveryFingerprint,
          {
            ecosystems: [operation.discoveryCandidate.ecosystem],
            ...(signal === undefined ? {} : { signal }),
          },
        );
      }
      if (this.acquisition === undefined)
        throw new AdoptionServiceError("adoption_source_unavailable", "Adoption store unavailable");
      if (operation.candidate.source.kind !== "local")
        throw new AdoptionServiceError(
          "adoption_source_unavailable",
          "Native skill source is not local",
        );
      const published = await this.acquisition.acquireAndPublish({
        operationId: operation.operationId,
        locator: operation.candidate.source,
        selectionKind: "explicit",
        ...(signal === undefined ? {} : { signal }),
        createManifest: async (source) => {
          if (
            source.sourceContentSha256 !== operation.review.sourceContentSha256 ||
            source.fileInventorySha256 !== operation.review.fileInventorySha256
          )
            throw new AdoptionServiceError(
              "adoption_approval_stale",
              "Source inventory changed after trust review",
            );
          const skill = await loadSkill(source.sourceDirectory, {
            expectedName: operation.candidate.displayName,
          });
          if (skill.manualOnly)
            throw new AdoptionServiceError(
              "adoption_primary_unsupported",
              "Pi disable-model-invocation skills require manual-only activation support",
            );
          const executableFiles = await this.executableSkillFiles(
            source.sourceDirectory,
            "SKILL.md",
            source.sourceFiles,
            skill.instructions,
          );
          if (executableFiles.length > 0)
            throw new AdoptionServiceError(
              "adoption_policy_denied",
              "Agent Skill contains scripts or executable binaries",
            );
          return {
            version: 1,
            adoptionId: operation.adoptionId,
            revisionId: operation.revisionId,
            ecosystem: operation.candidate.ecosystem,
            scope: operation.targetScope,
            packageId: operation.packageId,
            sourceUri: source.sourceUri,
            sourceLock: source.lock,
            sourceContentSha256: source.sourceContentSha256,
            fileInventorySha256: source.fileInventorySha256,
            sourceFiles: source.sourceFiles,
            license: {
              ...(operation.review.licenseExpressions[0] === undefined
                ? {}
                : { expression: operation.review.licenseExpressions[0] }),
              files: this.manifestFiles(source.sourceFiles, source.inspection?.licenseFiles ?? []),
              notices: this.manifestFiles(source.sourceFiles, source.inspection?.noticeFiles ?? []),
              warnings:
                source.inspection?.licenseFiles.length === 0 ? ["No license file found"] : [],
            },
            model: {
              converterVersion: "native-agent-skills-v1",
              targetContractVersion: "agent-skills-v1",
              requestSettings: {},
            },
            surfaces: [
              {
                surfaceId: operation.surface.surfaceId,
                kind: "skill",
                name: skill.name,
                primary: true,
                executable: false,
                compatibility: "native",
                rationale: "Validated by Axl's Agent Skills loader without conversion",
                sourcePath: "SKILL.md",
                generatedPaths: [],
              },
            ],
            requestedCapabilities: [],
            approvedCapabilities: [],
            deniedCapabilities: [],
            generatedFiles: [],
            dependencies: [],
            verification: {
              verifierVersion: "native-agent-skills-v1",
              environment: "data-only",
              sandboxControls: ["no-execution"],
              steps: [
                {
                  name: "Axl Agent Skills validation",
                  version: "1",
                  status: "passed",
                },
              ],
            },
            unsupportedBehavior: [],
            partialAdoptionAcknowledged: false,
            approvals: [],
            overlayHashes: [],
          } satisfies AdoptionManifest;
        },
      });
      const staged = await this.transitionNativeOperation(
        operation,
        "awaiting-activation-approval",
      );
      return parseRpcResult("adoption.start", this.operationSummary(staged, published.manifest));
    } catch (error) {
      await this.transitionNativeOperation(operation, "failed");
      return mapError(error);
    }
  }

  async approveActivation(
    params: AdoptionRpcMethodMap["adoption.operation.approveActivation"]["params"],
    _context: AdoptionRequestContext,
  ): Promise<AdoptionRpcMethodMap["adoption.operation.approveActivation"]["result"]> {
    await this.ensureNativeOperations();
    const existing = this.nativeOperations.get(params.operationId);
    if (
      existing?.state === "active" &&
      existing.approvalId !== undefined &&
      params.revisionId === existing.revisionId &&
      params.reviewBindingSha256 === existing.review.bindingSha256 &&
      params.policyGeneration === existing.review.policyGeneration
    ) {
      // Retry a derived journal write only when activation committed before it.
      // The registry remains the authoritative activation record.
      if (this.acquisition !== undefined) {
        const persisted = await this.acquisition.readNativeOperation(existing.operationId);
        if (persisted.state !== "active" || persisted.sequence !== existing.sequence)
          await this.persistNativeOperation(existing);
      }
      return parseRpcResult("adoption.operation.approveActivation", {
        approvalId: existing.approvalId,
        operation: this.operationSummary(existing),
      });
    }
    const operation = this.nativeOperation(params.operationId, "awaiting-activation-approval");
    if (params.revisionId !== operation.revisionId)
      throw new AdoptionServiceError("adoption_approval_stale", "Revision changed after review");
    if (
      params.reviewBindingSha256 !== operation.review.bindingSha256 ||
      params.policyGeneration !== operation.review.policyGeneration
    )
      throw new AdoptionServiceError("adoption_approval_stale", "Trust review binding is stale");
    if (this.acquisition === undefined)
      throw new AdoptionServiceError("adoption_source_unavailable", "Adoption store unavailable");
    const current = await this.acquisition.readRegistry();
    if (current.generation !== operation.review.registryGeneration)
      throw new AdoptionServiceError(
        "adoption_approval_stale",
        "The active adoption catalog changed after review",
      );
    let refreshed: AdoptionTrustReview;
    try {
      refreshed = await this.buildPersistedTrustReview(operation);
    } catch (error) {
      return mapError(error);
    }
    if (refreshed.bindingSha256 !== operation.review.bindingSha256)
      throw new AdoptionServiceError("adoption_approval_stale", "Trust review inputs changed");
    if (refreshed.conflicts.length > 0)
      throw new AdoptionServiceError("adoption_collision", "Skill name collision is unresolved");
    const approvalId = parseAdoptionApprovalId(uuidV7());
    const entry: AdoptionRegistryEntry = {
      adoptionId: operation.adoptionId,
      scope: operation.targetScope,
      packageKey: `${operation.candidate.ecosystem}:${operation.packageId}`,
      ...(operation.projectRoot === undefined ? {} : { projectRoot: operation.projectRoot }),
      activeRevisionId: operation.revisionId,
      approvalId,
      reviewBindingSha256: operation.review.bindingSha256,
      policyGeneration: operation.review.policyGeneration,
    };
    const entries = current.entries.filter(
      (item) =>
        item.adoptionId !== operation.adoptionId &&
        !(
          item.scope === operation.targetScope &&
          item.projectRoot === entry.projectRoot &&
          item.packageKey === entry.packageKey
        ),
    );
    const updated = await this.acquisition
      .updateRegistry(current.generation, [...entries, entry])
      .catch(() => {
        throw new AdoptionServiceError(
          "adoption_approval_stale",
          "The active adoption catalog changed during activation",
        );
      });
    let active: NativeSkillOperation;
    try {
      active = await this.transitionNativeOperation(operation, "active", approvalId);
    } finally {
      // The registry commit is authoritative. Schedule runtime convergence even
      // if persisting the derived operation state fails after that commit.
      void Promise.resolve(
        this.activationListener?.(operation.targetScope, updated.generation, operation.projectRoot),
      ).catch((error: unknown) => {
        console.error("Adoption activation reload failed", error);
      });
    }
    return parseRpcResult("adoption.operation.approveActivation", {
      approvalId,
      operation: this.operationSummary(active),
    });
  }

  private cachedCandidate(
    candidateId: AdoptionCandidate["candidateId"],
    context: AdoptionRequestContext,
  ): { readonly candidate: DiscoveryCandidate; readonly snapshot: ScanCacheEntry } {
    const snapshot = [...this.cache.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .find((entry) => entry.result.candidates.some((item) => item.candidateId === candidateId));
    const candidate = snapshot?.result.candidates.find((item) => item.candidateId === candidateId);
    if (snapshot === undefined || candidate === undefined)
      throw new AdoptionServiceError(
        "adoption_candidate_not_found",
        "Candidate is not present in a current discovery snapshot",
      );
    if (
      snapshot.context.projectDirectory !== undefined &&
      !context.openedProjectRoots.includes(snapshot.context.projectDirectory)
    )
      throw new AdoptionServiceError(
        "adoption_project_untrusted",
        "Project root is no longer open",
      );
    return { candidate, snapshot };
  }

  private async ensureNativeOperations(): Promise<void> {
    if (this.nativeOperationsLoaded !== undefined) return this.nativeOperationsLoaded;
    this.nativeOperationsLoaded = (async () => {
      if (this.acquisition === undefined) return;
      const [records, registry] = await Promise.all([
        this.acquisition.listNativeOperations(),
        this.acquisition.readRegistry(),
      ]);
      for (const record of records) {
        let operation: NativeSkillOperation = record;
        if (operation.state === "awaiting-activation-approval") {
          const active = registry.entries.find(
            (entry) =>
              entry.adoptionId === operation.adoptionId &&
              entry.activeRevisionId === operation.revisionId &&
              entry.reviewBindingSha256 === operation.review.bindingSha256 &&
              entry.policyGeneration === operation.review.policyGeneration &&
              entry.approvalId !== undefined,
          );
          if (active?.approvalId !== undefined) {
            operation = {
              ...operation,
              sequence: operation.sequence + 1,
              state: "active",
              approvalId: active.approvalId,
            };
            await this.acquisition.writeNativeOperation(operation);
          }
        }
        this.nativeOperations.set(operation.operationId, operation);
      }
    })();
    return this.nativeOperationsLoaded;
  }

  private async persistNativeOperation(operation: NativeSkillOperation): Promise<void> {
    if (this.acquisition === undefined)
      throw new AdoptionServiceError("adoption_source_unavailable", "Adoption store unavailable");
    const { discoveryCandidate: _candidate, discoveryContext: _context, ...record } = operation;
    await this.acquisition.writeNativeOperation(record);
    this.nativeOperations.set(operation.operationId, operation);
  }

  private async transitionNativeOperation(
    operation: NativeSkillOperation,
    state: NativeSkillOperation["state"],
    approvalId?: ReturnType<typeof parseAdoptionApprovalId>,
  ): Promise<NativeSkillOperation> {
    const next: NativeSkillOperation = {
      ...operation,
      sequence: operation.sequence + 1,
      state,
      ...(approvalId === undefined ? {} : { approvalId }),
    };
    // Publish the in-memory transition first so a retry can observe a registry
    // commit even when the derived operation journal write fails.
    this.nativeOperations.set(next.operationId, next);
    await this.persistNativeOperation(next);
    return next;
  }

  private nativeOperation(
    operationId: AdoptionOperationId,
    expected: NativeSkillOperation["state"],
  ): NativeSkillOperation {
    const operation = this.nativeOperations.get(operationId);
    if (operation === undefined)
      throw new AdoptionServiceError(
        "adoption_operation_not_found",
        "Adoption operation not found",
      );
    if (operation.state !== expected)
      throw new AdoptionServiceError(
        "adoption_operation_state_conflict",
        `Adoption operation is ${operation.state}`,
      );
    return operation;
  }

  private operationSummary(
    operation: NativeSkillOperation,
    _manifest?: AdoptionManifest,
  ): AdoptionOperationSummary {
    return {
      operationId: operation.operationId,
      state: operation.state,
      phase: operation.state,
      statusText:
        operation.state === "active"
          ? "Native Agent Skill is active"
          : operation.state === "awaiting-activation-approval"
            ? "Ready for activation approval"
            : operation.state === "failed"
              ? "Native installation failed"
              : "Review native Agent Skill",
      sequence: operation.sequence,
      createdAt: operation.createdAt,
      updatedAt: Date.now(),
      adoptionId: operation.adoptionId,
      revisionId: operation.revisionId,
    };
  }

  private operationDetail(operation: NativeSkillOperation): AdoptionOperationDetail {
    const item = operation.surface;
    return {
      ...this.operationSummary(operation),
      candidate: operation.candidate,
      compatibility: {
        primarySurfaceId: item.surfaceId,
        overall: "native",
        surfaceCount: 1,
        unsupportedSurfaceCount: 0,
        partialAcknowledgementRequired: false,
        surfaces: [{ ...item, compatibility: "native", compatibilityReason: "Native Agent Skill" }],
      },
      capabilityRequests: operation.review.capabilityRequests,
      policy: {
        generation: operation.review.policyGeneration,
        decision: operation.review.conflicts.length === 0 ? "requires-approval" : "deny",
        deniedCapabilities: [],
        reasons: operation.review.conflicts,
      },
      diagnosticCount: 0,
      detailOffset: 0,
      diagnostics: [],
    };
  }

  private manifestFiles(
    files: AdoptionManifest["sourceFiles"],
    paths: readonly string[],
  ): AdoptionManifest["sourceFiles"] {
    const selected = new Set(paths);
    return files.filter((file) => selected.has(file.path));
  }

  private async executableSkillFiles(
    root: string,
    skillPath: string,
    files: AdoptionManifest["sourceFiles"],
    instructions: string,
  ): Promise<AdoptionTrustReview["executableFiles"]> {
    const directory = dirname(skillPath);
    const prefix = directory === "." ? "" : `${directory}/`;
    const interpreter =
      /(?:^|[\s'"`])(?:python(?:3)?|node|deno|bun|bash|sh|zsh|fish|ruby|perl|php|pwsh)(?:\s|$)/iu;
    const instructionLines = instructions.split(/\r?\n/u).filter((line) => interpreter.test(line));
    const output: AdoptionTrustReview["executableFiles"][number][] = [];
    for (const file of files) {
      if (!file.path.startsWith(prefix) || file.path === skillPath) continue;
      const bytes = await readFile(join(root, ...file.path.split("/")));
      const magic =
        (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) ||
        (bytes[0] === 0x4d && bytes[1] === 0x5a) ||
        (bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe) ||
        (bytes[0] === 0xfe && bytes[1] === 0xed && bytes[2] === 0xfa && bytes[3] === 0xcf);
      const shebang = bytes[0] === 0x23 && bytes[1] === 0x21;
      const localPath = prefix === "" ? file.path : file.path.slice(prefix.length);
      const referencedByInterpreter = instructionLines.some((line) =>
        [localPath, `./${localPath}`].some((reference) => {
          const index = line.indexOf(reference);
          if (index < 0) return false;
          const before = index === 0 ? " " : (line[index - 1] ?? "");
          const after = line[index + reference.length] ?? " ";
          return /[\s'"`]/u.test(before) && /[\s'"`,;)]/u.test(after);
        }),
      );
      if (
        file.executable ||
        SCRIPT_PATH.test(file.path) ||
        shebang ||
        magic ||
        referencedByInterpreter
      ) {
        output.push({
          relativePath: file.path,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
          executable: true,
        });
      }
    }
    return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  private async buildTrustReview(
    candidate: DiscoveryCandidate,
    context: DiscoveryContext,
    targetScope: AdoptionScope,
  ): Promise<AdoptionTrustReview> {
    return this.buildTrustReviewFromSource({
      candidate: publicCandidate(candidate),
      surface: surface(candidate, primarySurface(candidate)),
      adapter: {
        id: candidate.adapterId,
        version: candidate.adapterVersion,
        sourceSchemaVersion: candidate.sourceSchemaVersion,
      },
      targetScope,
      ...(context.projectDirectory === undefined ? {} : { projectRoot: context.projectDirectory }),
      licenseExpressions:
        candidate.inventory?.gallery.license === undefined
          ? []
          : [candidate.inventory.gallery.license],
    });
  }

  private async buildPersistedTrustReview(
    operation: NativeSkillOperation,
  ): Promise<AdoptionTrustReview> {
    if (this.acquisition === undefined)
      throw new AdoptionServiceError("adoption_source_unavailable", "Adoption store unavailable");
    const revision = await this.acquisition.readRevision(
      operation.candidate.ecosystem,
      operation.packageId,
      operation.revisionId,
    );
    return this.buildTrustReviewFromSource({
      candidate: operation.candidate,
      surface: operation.surface,
      adapter: operation.adapter,
      targetScope: operation.targetScope,
      ...(operation.projectRoot === undefined ? {} : { projectRoot: operation.projectRoot }),
      licenseExpressions: operation.review.licenseExpressions,
      sourceRoot: join(revision.directory, "source"),
    });
  }

  private async buildTrustReviewFromSource(input: {
    readonly candidate: AdoptionCandidate;
    readonly surface: AdoptionResourceSurface;
    readonly adapter: NativeSkillOperation["adapter"];
    readonly targetScope: AdoptionScope;
    readonly projectRoot?: string;
    readonly licenseExpressions: readonly string[];
    readonly sourceRoot?: string;
  }): Promise<AdoptionTrustReview> {
    if (input.candidate.source.kind !== "local")
      throw new AdoptionServiceError(
        "adoption_source_unavailable",
        "Native skill source is not local",
      );
    const inspection = await inspectSource({
      sourceRoot: input.sourceRoot ?? input.candidate.source.canonicalPath,
    });
    const files = inspection.inventory.map((file) => ({
      relativePath: file.relativePath,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      executable: file.executable,
    }));
    const validatedSkill = await loadSkill(inspection.canonicalRoot, {
      expectedName: input.candidate.displayName,
    });
    const executableFiles = await this.executableSkillFiles(
      inspection.canonicalRoot,
      "SKILL.md",
      files.map((file) => ({
        path: file.relativePath,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        executable: file.executable,
      })),
      validatedSkill.instructions,
    );
    const selected = (paths: readonly string[]) => {
      const wanted = new Set(paths);
      return files.filter((file) => wanted.has(file.relativePath));
    };
    const collisionReview = await this.skillConflicts(
      input.candidate,
      input.projectRoot,
      input.targetScope,
    );
    const conflicts = [...collisionReview.conflicts];
    if (validatedSkill.manualOnly)
      conflicts.push(
        "Pi disable-model-invocation requires manual-only activation support and is unsupported",
      );
    const executablePaths = new Set(executableFiles.map((file) => file.relativePath));
    const declarativeFiles = files.filter((file) => !executablePaths.has(file.relativePath));
    const capabilityRequests = inspection.capabilityIndicators.map((capability) => ({
      capability,
      required: false,
      rationale: "Static source indicator; native declarative activation grants no capability",
    }));
    if (validatedSkill.allowedTools !== undefined)
      capabilityRequests.push({
        capability: "skill.allowed-tools",
        required: true,
        rationale: validatedSkill.allowedTools,
      });
    const unsigned = {
      sourceContentSha256: inspection.treeSha256,
      fileInventorySha256: sha256(
        JSON.stringify(
          inspection.inventory.map((file) => ({
            path: file.relativePath,
            sha256: file.sha256,
            sizeBytes: file.sizeBytes,
            executable: file.executable,
          })),
        ),
      ),
      targetScope: input.targetScope,
      licenseExpressions: input.licenseExpressions,
      licenseFiles: selected(inspection.licenseFiles),
      noticeFiles: selected(inspection.noticeFiles),
      declarativeFiles,
      executableFiles,
      capabilityRequests,
      conflicts: Object.freeze(conflicts.sort()),
      precedenceChanges: collisionReview.precedenceChanges,
      policyGeneration: NATIVE_SKILL_POLICY_GENERATION,
      registryGeneration: collisionReview.registryGeneration,
    };
    const bindingSha256 = sha256(
      canonicalJson({
        ...unsigned,
        candidate: input.candidate,
        adapter: input.adapter,
        surfaces: [input.surface],
      }),
    );
    return { bindingSha256, ...unsigned };
  }

  private async skillConflicts(
    candidate: AdoptionCandidate,
    projectRoot: string | undefined,
    targetScope: AdoptionScope,
  ): Promise<{
    readonly conflicts: readonly string[];
    readonly precedenceChanges: readonly string[];
    readonly registryGeneration: number;
  }> {
    const conflicts: string[] = [];
    const precedenceChanges: string[] = [];
    const name = candidate.displayName;
    const packageKey = `${candidate.ecosystem}:${candidate.packageId ?? `skill:${name}`}`;
    const hasLocalSkill = async (root: string): Promise<boolean> => {
      try {
        return (await lstat(join(root, name, "SKILL.md"))).isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    };
    const globalRoot = join(this.homeDirectory, ".axl", "skills");
    if (await hasLocalSkill(globalRoot)) {
      if (targetScope === "global") conflicts.push(`Local global skill ${name} already exists`);
      else precedenceChanges.push(`Project skill ${name} will shadow a local global skill`);
    }
    if (
      targetScope === "project" &&
      projectRoot !== undefined &&
      (await hasLocalSkill(join(projectRoot, ".axl", "skills")))
    )
      conflicts.push(`Local project skill ${name} already exists`);
    if (this.acquisition === undefined)
      return { conflicts, precedenceChanges, registryGeneration: 0 };
    const active = await this.acquisition.activeSkills();
    for (const skill of active.skills) {
      if (skill.name !== name) continue;
      if (
        targetScope === "project" &&
        skill.scope === "project" &&
        skill.projectRoot !== projectRoot
      )
        continue;
      if (targetScope === "global" && skill.scope === "project") {
        precedenceChanges.push(`Project skill ${name} will continue to shadow this global skill`);
        continue;
      }
      if (skill.packageKey !== packageKey) {
        conflicts.push(`Active ${skill.scope} skill ${name} belongs to ${skill.packageKey}`);
      } else if (targetScope === "project" && skill.scope === "global") {
        precedenceChanges.push(`Project skill ${name} will shadow the same global package`);
      } else if (skill.scope === targetScope) {
        precedenceChanges.push(`${targetScope} skill ${name} will replace its active revision`);
      }
    }
    return {
      conflicts: Object.freeze([...new Set(conflicts)].sort()),
      precedenceChanges: Object.freeze([...new Set(precedenceChanges)].sort()),
      registryGeneration: active.generation,
    };
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([this.lifecycle.signal, signal]);
  }

  private ready(signal?: AbortSignal): void {
    if (this.disposed)
      throw new AdoptionServiceError("adoption_source_unavailable", "Adoption service is closed");
    if (signal?.aborted === true) throw new DOMException("Discovery was cancelled", "AbortError");
    this.prune();
  }

  private async scan(
    params: Pick<AdoptionDiscoverParams, "ecosystems" | "projectRoot" | "scopes">,
    requestContext: AdoptionRequestContext,
    signal?: AbortSignal,
  ): Promise<ScanCacheEntry> {
    let projectDirectory: string | undefined;
    const requestsProject = params.scopes?.includes("project") ?? params.projectRoot !== undefined;
    if (params.projectRoot !== undefined) {
      try {
        const requested = resolve(params.projectRoot);
        projectDirectory = await realpath(requested);
        if (
          requested !== params.projectRoot ||
          projectDirectory !== requested ||
          !(await lstat(projectDirectory)).isDirectory()
        ) {
          throw new Error("not an exact canonical directory");
        }
      } catch {
        throw new AdoptionServiceError(
          "adoption_source_unavailable",
          "Project root is unavailable or non-canonical",
        );
      }
      if (
        !requestContext.openedProjectRoots.includes(projectDirectory) ||
        !(await this.authorizeProjectRoot(projectDirectory, requestContext))
      ) {
        throw new AdoptionServiceError(
          "adoption_project_untrusted",
          "Project root is not an opened Axl session root",
        );
      }
    } else if (requestsProject) {
      throw new AdoptionServiceError(
        "adoption_project_untrusted",
        "Project-scoped discovery requires an explicitly trusted project root",
      );
    }
    const context: DiscoveryContext = {
      homeDirectory: this.homeDirectory,
      ...(projectDirectory === undefined ? {} : { projectDirectory }),
      projectTrusted: projectDirectory !== undefined,
      environment: this.environment,
      limits: DEFAULT_INSPECTION_LIMITS,
    };
    const metadata = await Promise.all(
      [this.homeDirectory, projectDirectory]
        .filter((path): path is string => path !== undefined)
        .map(async (path) => {
          const stat = await lstat(path);
          return { path, dev: stat.dev, ino: stat.ino, mode: stat.mode, mtimeMs: stat.mtimeMs };
        }),
    );
    const key = sha256(
      canonicalJson({
        metadata,
        ecosystems: params.ecosystems ?? null,
        projectDirectory: projectDirectory ?? null,
        environment: {
          DSH_HOME: this.environment.DSH_HOME ?? null,
          PI_CODING_AGENT_DIR: this.environment.PI_CODING_AGENT_DIR ?? null,
          PI_PACKAGE_DIR: this.environment.PI_PACKAGE_DIR ?? null,
        },
        adapters: sourceAdapters.map((adapter) => ({
          id: adapter.adapterId,
          version: adapter.adapterVersion,
          schemas: adapter.sourceSchemaVersions,
        })),
      }),
    );
    // Every first-page request performs a fresh scan. Cached entries only retain
    // bounded snapshot context for paging and subsequent fingerprinted inspection.
    const result = await discover(context, {
      ...(params.ecosystems === undefined ? {} : { ecosystems: params.ecosystems }),
      ...(signal === undefined ? {} : { signal }),
    });
    this.ready(signal);
    const generation = sha256(
      canonicalJson({
        key,
        candidates: result.candidates.map((entry) => [
          entry.candidateId,
          entry.discoveryFingerprint,
        ]),
      }),
    ).slice(0, 32);
    const entry = {
      key,
      generation,
      context,
      result,
      createdAt: Date.now(),
    } satisfies ScanCacheEntry;
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > CACHE_ENTRIES)
      this.cache.delete(this.cache.keys().next().value as string);
    return entry;
  }

  private discoveryPage(cursor: DiscoverCursor, pageSize: number): AdoptionDiscoverResult {
    let candidateCount = Math.min(pageSize, cursor.candidates.length - cursor.candidateOffset);
    let warningCount = Math.min(
      ADOPTION_LIMITS.pageWarnings,
      cursor.warnings.length - cursor.warningOffset,
    );
    const nextCursorValue = randomUUID();
    let result: AdoptionDiscoverResult;
    for (;;) {
      const candidates = cursor.candidates.slice(
        cursor.candidateOffset,
        cursor.candidateOffset + candidateCount,
      );
      const warnings = cursor.warnings.slice(
        cursor.warningOffset,
        cursor.warningOffset + warningCount,
      );
      const candidateOffset = cursor.candidateOffset + candidates.length;
      const warningOffset = cursor.warningOffset + warnings.length;
      const hasMore =
        candidateOffset < cursor.candidates.length || warningOffset < cursor.warnings.length;
      const value = {
        scanGeneration: cursor.generation,
        candidates,
        warnings,
        ...(hasMore ? { nextPageCursor: nextCursorValue } : {}),
      };
      if (
        new TextEncoder().encode(JSON.stringify(value)).byteLength <= ADOPTION_LIMITS.resultBytes
      ) {
        result = parseRpcResult("adoption.discover", value);
        if (hasMore) {
          this.storeCursor(
            { ...cursor, candidateOffset, warningOffset, createdAt: Date.now() },
            nextCursorValue,
          );
        }
        break;
      }
      if (candidateCount > 0) candidateCount -= 1;
      else if (warningCount > 0) warningCount -= 1;
      else {
        throw new AdoptionServiceError(
          "adoption_scan_limit_exceeded",
          "A discovery item exceeds the result size limit",
        );
      }
    }
    return result;
  }

  private inspectionPage(cursor: InspectCursor, pageSize: number): AdoptionInspectResult {
    const combined = [...cursor.surfaces, ...cursor.diagnostics];
    const detail = combined.slice(cursor.offset, cursor.offset + pageSize);
    const surfaces = detail.filter(
      (entry): entry is AdoptionResourceSurface => !("severity" in entry),
    );
    const diagnostics = detail.filter(
      (entry): entry is AdoptionDiagnosticSummary => "severity" in entry,
    );
    const offset = cursor.offset + detail.length;
    const nextPageCursor =
      offset < combined.length
        ? this.storeCursor({ ...cursor, offset, createdAt: Date.now() })
        : undefined;
    return parseRpcResult("adoption.inspect", {
      ...cursor.result,
      detailOffset: cursor.offset,
      surfaces,
      diagnostics,
      ...(nextPageCursor === undefined ? {} : { nextPageCursor }),
    });
  }

  private storeCursor(record: CursorRecord, value = randomUUID()): string {
    const cursor = value;
    this.cursors.set(cursor, record);
    while (this.cursors.size > CURSOR_ENTRIES)
      this.cursors.delete(this.cursors.keys().next().value as string);
    return cursor;
  }

  private takeCursor<Kind extends CursorRecord["kind"]>(
    cursor: string,
    kind: Kind,
    requestKey: string,
  ): Extract<CursorRecord, { readonly kind: Kind }> {
    const record = this.cursors.get(cursor);
    this.cursors.delete(cursor);
    if (
      record === undefined ||
      record.kind !== kind ||
      record.requestKey !== requestKey ||
      Date.now() - record.createdAt > CURSOR_LIFETIME_MS
    ) {
      throw new AdoptionServiceError(
        "adoption_snapshot_required",
        "Discovery page expired; refresh the scan",
      );
    }
    return record as Extract<CursorRecord, { readonly kind: Kind }>;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > this.cacheLifetimeMs) this.cache.delete(key);
    }
    for (const [key, cursor] of this.cursors) {
      if (now - cursor.createdAt > CURSOR_LIFETIME_MS) this.cursors.delete(key);
    }
  }
}
