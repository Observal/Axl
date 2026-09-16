// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  DEFAULT_INSPECTION_LIMITS,
  type DiscoveryCandidate,
  type DiscoveryContext,
  type DiscoveryDiagnostic,
  DiscoveryError,
  type DiscoveryResult,
  discover,
  inspectCandidate,
  type ResourceSurface,
  sourceAdapters,
} from "@axl/compiler";
import {
  type AdoptionRequestContext,
  type AdoptionService,
  AdoptionServiceError,
} from "@axl/daemon";
import {
  ADOPTION_LIMITS,
  type AdoptionCandidate,
  type AdoptionDiagnosticSummary,
  type AdoptionDiscoverParams,
  type AdoptionDiscoverResult,
  type AdoptionInspectParams,
  type AdoptionInspectResult,
  type AdoptionResourceSurface,
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
  return candidate.provenance.canonicalRoot;
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
    relativeResourcePath: candidate.provenance.relativePath,
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
  private disposed = false;

  constructor(options: LocalAdoptionServiceOptions = {}) {
    this.homeDirectory = resolve(options.homeDirectory ?? homedir());
    this.environment = Object.freeze({ ...(options.environment ?? process.env) });
    this.cacheLifetimeMs = options.cacheLifetimeMs ?? CACHE_LIFETIME_MS;
    this.acquisition = options.acquisition;
    this.authorizeProjectRoot = options.authorizeProjectRoot ?? (() => true);
  }

  async prime(): Promise<void> {
    if (this.disposed) return;
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
