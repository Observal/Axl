// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  AdoptionCandidate,
  AdoptionDiagnosticSummary,
  AdoptionDiscoverParams,
  AdoptionInspectResult,
} from "@axl/protocol";

import { type AxlClient, AxlClientError } from "./client.ts";

const PAGE_SIZE = 100;

export interface AdoptionDiscoveryScope {
  readonly ecosystems?: AdoptionDiscoverParams["ecosystems"];
  readonly scopes?: AdoptionDiscoverParams["scopes"];
  readonly projectRoot?: string;
  readonly query?: string;
  readonly includeMalformed?: boolean;
}

export interface AdoptionControllerError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface AdoptionControllerState {
  readonly status: "idle" | "loading" | "ready" | "unavailable" | "error";
  readonly scope: AdoptionDiscoveryScope;
  readonly candidates: readonly AdoptionCandidate[];
  readonly warnings: readonly AdoptionDiagnosticSummary[];
  readonly scanGeneration?: string | undefined;
  readonly inspection?: AdoptionInspectResult | undefined;
  readonly error?: AdoptionControllerError | undefined;
  readonly hasMore: boolean;
  readonly findingsDismissed: boolean;
  readonly dismissedScanGeneration?: string | undefined;
}

function boundedUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maximumBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return output;
}

function normalizedError(error: unknown): AdoptionControllerError {
  if (error instanceof AxlClientError) {
    return Object.freeze({
      code: error.code,
      message: boundedUtf8(error.message, 1_024),
      retryable: error.retryable,
    });
  }
  return Object.freeze({
    code: "adoption_request_failed",
    message: error instanceof Error ? boundedUtf8(error.message, 1_024) : "Adoption request failed",
    retryable: false,
  });
}

function immutableCandidate(candidate: AdoptionCandidate): AdoptionCandidate {
  return Object.freeze({ ...candidate, source: Object.freeze({ ...candidate.source }) });
}

function immutableState(state: AdoptionControllerState): AdoptionControllerState {
  return Object.freeze({
    ...state,
    scope: Object.freeze({
      ...state.scope,
      ...(state.scope.ecosystems === undefined
        ? {}
        : { ecosystems: Object.freeze([...state.scope.ecosystems]) }),
      ...(state.scope.scopes === undefined
        ? {}
        : { scopes: Object.freeze([...state.scope.scopes]) }),
    }),
    candidates: Object.freeze(state.candidates.map(immutableCandidate)),
    warnings: Object.freeze(state.warnings.map((warning) => Object.freeze({ ...warning }))),
  });
}

export interface AdoptionControllerOptions {
  readonly dismissedScanGeneration?: string;
  readonly onDismissedScanGeneration?: (generation?: string) => void | Promise<void>;
}

/** Shared discovery workflow. Presentation clients only render this immutable state. */
export class AdoptionController {
  private stateValue: AdoptionControllerState;
  private readonly listeners = new Set<(state: AdoptionControllerState) => void>();
  private readonly client: AxlClient;
  private readonly onDismissedScanGeneration?: AdoptionControllerOptions["onDismissedScanGeneration"];
  private dismissedScanGeneration: string | undefined;
  private generation = 0;
  private nextPageCursor: string | undefined;
  private requestController: AbortController | undefined;
  private disposed = false;

  constructor(client: AxlClient, options: AdoptionControllerOptions = {}) {
    this.client = client;
    this.onDismissedScanGeneration = options.onDismissedScanGeneration;
    this.dismissedScanGeneration = options.dismissedScanGeneration;
    const available = client.connection.grantedCapabilities?.includes("adoption.discover") === true;
    this.stateValue = immutableState({
      status: available ? "idle" : "unavailable",
      scope: {},
      candidates: [],
      warnings: [],
      hasMore: false,
      findingsDismissed: false,
      ...(this.dismissedScanGeneration === undefined
        ? {}
        : { dismissedScanGeneration: this.dismissedScanGeneration }),
      ...(available
        ? {}
        : {
            error: {
              code: "unsupported_capability",
              message: "Adoption discovery is not available on this connection",
              retryable: false,
            },
          }),
    });
  }

  get state(): AdoptionControllerState {
    return this.stateValue;
  }

  subscribe(listener: (state: AdoptionControllerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.stateValue);
    return () => this.listeners.delete(listener);
  }

  async load(scope: AdoptionDiscoveryScope = {}): Promise<AdoptionControllerState> {
    return this.beginLoad(scope, false);
  }

  async refresh(
    scope: AdoptionDiscoveryScope = this.stateValue.scope,
  ): Promise<AdoptionControllerState> {
    return this.beginLoad(scope, true);
  }

  async loadMore(): Promise<AdoptionControllerState> {
    if (this.disposed) throw new Error("Adoption controller is disposed");
    if (this.nextPageCursor === undefined || this.stateValue.status === "loading")
      return this.stateValue;
    const generation = this.generation;
    const daemonInstanceId = this.client.connection.daemonInstanceId;
    const scope = this.stateValue.scope;
    const controller = new AbortController();
    this.requestController = controller;
    this.publish({ status: "loading" });
    try {
      const page = await this.client.request(
        "adoption.discover",
        this.params(scope, this.nextPageCursor),
        { signal: controller.signal },
      );
      if (!this.current(generation, daemonInstanceId, scope)) return this.stateValue;
      if (
        this.stateValue.scanGeneration !== undefined &&
        page.scanGeneration !== this.stateValue.scanGeneration
      ) {
        throw new AxlClientError("adoption_source_changed", "Discovery changed while paging");
      }
      this.nextPageCursor = page.nextPageCursor;
      this.publish({
        status: "ready",
        candidates: [...this.stateValue.candidates, ...page.candidates],
        warnings: page.warnings,
        scanGeneration: page.scanGeneration,
        hasMore: page.nextPageCursor !== undefined,
        findingsDismissed: this.dismissedScanGeneration === page.scanGeneration,
      });
    } catch (error) {
      if (!this.current(generation, daemonInstanceId, scope) || controller.signal.aborted)
        return this.stateValue;
      this.publish({ status: "error", error: normalizedError(error), hasMore: false });
      throw error;
    } finally {
      if (this.requestController === controller) this.requestController = undefined;
    }
    return this.stateValue;
  }

  async loadAll(scope: AdoptionDiscoveryScope = {}): Promise<AdoptionControllerState> {
    await this.load(scope);
    while (this.stateValue.hasMore) await this.loadMore();
    return this.stateValue;
  }

  async inspect(candidate: AdoptionCandidate): Promise<AdoptionInspectResult | undefined> {
    if (this.disposed) throw new Error("Adoption controller is disposed");
    if (this.client.connection.grantedCapabilities?.includes("adoption.inspect") !== true) {
      const error = new AxlClientError(
        "unsupported_capability",
        "Adoption inspection is not available on this connection",
      );
      this.publish({ status: "unavailable", error: normalizedError(error) });
      throw error;
    }
    const generation = this.generation;
    const daemonInstanceId = this.client.connection.daemonInstanceId;
    const scope = this.stateValue.scope;
    const controller = new AbortController();
    this.requestController?.abort();
    this.requestController = controller;
    this.publish({ status: "loading", inspection: undefined });
    try {
      let pageCursor: string | undefined;
      let first: AdoptionInspectResult | undefined;
      const surfaces: AdoptionInspectResult["surfaces"][number][] = [];
      const diagnostics: AdoptionInspectResult["diagnostics"][number][] = [];
      do {
        const page = await this.client.request(
          "adoption.inspect",
          {
            candidateId: candidate.candidateId,
            expectedDiscoveryFingerprint: candidate.discoveryFingerprint,
            pageSize: PAGE_SIZE,
            ...(pageCursor === undefined ? {} : { pageCursor }),
          },
          { signal: controller.signal },
        );
        if (!this.current(generation, daemonInstanceId, scope)) return undefined;
        if (
          page.candidate.candidateId !== candidate.candidateId ||
          page.candidate.discoveryFingerprint !== candidate.discoveryFingerprint
        ) {
          throw new AxlClientError(
            "adoption_source_changed",
            "Inspection no longer matches discovery",
          );
        }
        first ??= page;
        surfaces.push(...page.surfaces);
        diagnostics.push(...page.diagnostics);
        pageCursor = page.nextPageCursor;
      } while (pageCursor !== undefined);
      if (first === undefined) throw new Error("Adoption inspection returned no page");
      const { nextPageCursor: _nextPageCursor, ...base } = first;
      const inspection = Object.freeze({
        ...base,
        candidate: immutableCandidate(base.candidate),
        adapter: Object.freeze({ ...base.adapter }),
        license: Object.freeze({
          expressions: Object.freeze([...base.license.expressions]),
          notices: Object.freeze(
            base.license.notices.map((notice) => Object.freeze({ ...notice })),
          ),
        }),
        inventory: Object.freeze({ ...base.inventory }),
        limits: Object.freeze({ ...base.limits }),
        detailOffset: 0,
        surfaces: Object.freeze(
          surfaces.map((surface) =>
            Object.freeze({
              ...surface,
              requiredCapabilities: Object.freeze([...surface.requiredCapabilities]),
            }),
          ),
        ),
        diagnostics: Object.freeze(
          diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
        ),
      });
      this.publish({ status: "ready", inspection, error: undefined });
      return inspection;
    } catch (error) {
      if (!this.current(generation, daemonInstanceId, scope) || controller.signal.aborted)
        return undefined;
      this.publish({ status: "error", error: normalizedError(error) });
      throw error;
    } finally {
      if (this.requestController === controller) this.requestController = undefined;
    }
  }

  dismissFindings(): void {
    const scanGeneration = this.stateValue.scanGeneration;
    if (scanGeneration === undefined || this.dismissedScanGeneration === scanGeneration) return;
    this.dismissedScanGeneration = scanGeneration;
    this.publish({ findingsDismissed: true, dismissedScanGeneration: scanGeneration });
    void this.onDismissedScanGeneration?.(scanGeneration);
  }

  restoreFindings(): void {
    if (this.dismissedScanGeneration === undefined) return;
    this.dismissedScanGeneration = undefined;
    this.publish({ findingsDismissed: false, dismissedScanGeneration: undefined });
    void this.onDismissedScanGeneration?.();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.requestController?.abort();
    this.requestController = undefined;
    this.listeners.clear();
  }

  private async beginLoad(
    scope: AdoptionDiscoveryScope,
    force: boolean,
  ): Promise<AdoptionControllerState> {
    if (this.disposed) throw new Error("Adoption controller is disposed");
    if (this.client.connection.grantedCapabilities?.includes("adoption.discover") !== true)
      return this.stateValue;
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    const generation = ++this.generation;
    const daemonInstanceId = this.client.connection.daemonInstanceId;
    const normalizedScope = Object.freeze({ ...scope });
    this.nextPageCursor = undefined;
    this.stateValue = immutableState({
      status: "loading",
      scope: normalizedScope,
      candidates: [],
      warnings: [],
      hasMore: false,
      findingsDismissed: false,
      ...(this.dismissedScanGeneration === undefined
        ? {}
        : { dismissedScanGeneration: this.dismissedScanGeneration }),
    });
    this.emit();
    try {
      const page = await this.client.request("adoption.discover", this.params(normalizedScope), {
        signal: controller.signal,
      });
      if (!this.current(generation, daemonInstanceId, normalizedScope)) return this.stateValue;
      this.nextPageCursor = page.nextPageCursor;
      this.publish({
        status: "ready",
        candidates: page.candidates,
        warnings: page.warnings,
        scanGeneration: page.scanGeneration,
        hasMore: page.nextPageCursor !== undefined,
        findingsDismissed: this.dismissedScanGeneration === page.scanGeneration,
        error: undefined,
        inspection: undefined,
      });
      // `force` distinguishes intent for callers and deliberately starts a new generation.
      void force;
    } catch (error) {
      if (!this.current(generation, daemonInstanceId, normalizedScope) || controller.signal.aborted)
        return this.stateValue;
      this.publish({ status: "error", error: normalizedError(error), hasMore: false });
      throw error;
    } finally {
      if (this.requestController === controller) this.requestController = undefined;
    }
    return this.stateValue;
  }

  private params(scope: AdoptionDiscoveryScope, pageCursor?: string): AdoptionDiscoverParams {
    return {
      ...(scope.ecosystems === undefined ? {} : { ecosystems: scope.ecosystems }),
      ...(scope.scopes === undefined ? {} : { scopes: scope.scopes }),
      ...(scope.projectRoot === undefined ? {} : { projectRoot: scope.projectRoot }),
      ...(scope.query === undefined ? {} : { query: scope.query }),
      ...(scope.includeMalformed === undefined ? {} : { includeMalformed: scope.includeMalformed }),
      pageSize: PAGE_SIZE,
      ...(pageCursor === undefined ? {} : { pageCursor }),
    };
  }

  private current(
    generation: number,
    daemonInstanceId: string,
    _scope: AdoptionDiscoveryScope,
  ): boolean {
    return (
      !this.disposed &&
      generation === this.generation &&
      daemonInstanceId === this.client.connection.daemonInstanceId
    );
  }

  private publish(update: Partial<AdoptionControllerState>): void {
    this.stateValue = immutableState({ ...this.stateValue, ...update });
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.stateValue);
  }
}
