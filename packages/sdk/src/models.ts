// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { ProviderInventoryGroup, ThinkingLevel } from "@axl/protocol";
import type { AxlClient } from "./client.ts";

export interface ClientModelCost {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly cacheReadUsdPerMTok?: number;
  readonly cacheWriteUsdPerMTok?: number;
}

/** Provider-neutral model metadata used by presentation clients. */
export interface ModelChoice {
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly thinkingLevels: readonly ThinkingLevel[];
  readonly availability: {
    readonly status: "available" | "preview" | "deprecated" | "unavailable";
    readonly reason?: string;
  };
}

export interface ProviderDirectoryState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly providers: readonly ProviderInventoryGroup[];
  readonly models: readonly ModelChoice[];
  readonly refresh?: { readonly providerId?: string };
  readonly error?: string;
}

export class ProviderDirectoryController {
  private stateValue: ProviderDirectoryState = { status: "idle", providers: [], models: [] };
  private readonly listeners = new Set<(state: ProviderDirectoryState) => void>();
  private loading: Promise<ProviderDirectoryState> | undefined;
  private cancellation: AbortController | undefined;
  private readonly removeReconnectListener: () => void;
  private readonly client: AxlClient;

  constructor(client: AxlClient) {
    this.client = client;
    this.removeReconnectListener = client.onReconnect(() => this.load(true).then(() => undefined));
  }

  get state(): ProviderDirectoryState {
    return this.stateValue;
  }

  subscribe(listener: (state: ProviderDirectoryState) => void): () => void {
    this.listeners.add(listener);
    listener(this.stateValue);
    return () => this.listeners.delete(listener);
  }

  load(refresh = false): Promise<ProviderDirectoryState> {
    if (!refresh && this.stateValue.status === "ready") return Promise.resolve(this.stateValue);
    if (!refresh && this.loading !== undefined) return this.loading;
    this.cancellation?.abort();
    const cancellation = new AbortController();
    this.cancellation = cancellation;
    const { refresh: _, ...current } = this.stateValue;
    this.setState({ ...current, status: "loading" });
    const loading = this.read(cancellation.signal)
      .then((state) => {
        if (!cancellation.signal.aborted) this.setState(state);
        return state;
      })
      .catch((error: unknown) => {
        if (!cancellation.signal.aborted) {
          this.setState({
            ...this.stateValue,
            status: "error",
            error: error instanceof Error ? error.message : "Could not load providers",
          });
        }
        throw error;
      })
      .finally(() => {
        if (this.cancellation === cancellation) {
          this.cancellation = undefined;
          this.loading = undefined;
        }
      });
    this.loading = loading;
    return loading;
  }

  async refresh(providerId?: string): Promise<ProviderDirectoryState> {
    this.cancellation?.abort();
    const cancellation = new AbortController();
    this.cancellation = cancellation;
    const { error: _, ...current } = this.stateValue;
    this.setState({
      ...current,
      refresh: providerId === undefined ? {} : { providerId },
    });
    try {
      await this.client.refreshProviderCatalogs(providerId === undefined ? {} : { providerId }, {
        signal: cancellation.signal,
      });
      const state = await this.read(cancellation.signal);
      if (!cancellation.signal.aborted) this.setState(state);
      return state;
    } catch (error) {
      if (this.cancellation === cancellation) {
        const { refresh: _, ...current } = this.stateValue;
        this.setState(
          cancellation.signal.aborted
            ? current
            : {
                ...current,
                status: "error",
                error: error instanceof Error ? error.message : "Could not refresh providers",
              },
        );
      }
      throw error;
    } finally {
      if (this.cancellation === cancellation) this.cancellation = undefined;
    }
  }

  cancelRefresh(): void {
    if (this.stateValue.refresh !== undefined) this.cancellation?.abort();
  }

  dispose(): void {
    this.cancellation?.abort();
    this.cancellation = undefined;
    this.loading = undefined;
    this.removeReconnectListener();
    this.listeners.clear();
  }

  private async read(signal: AbortSignal): Promise<ProviderDirectoryState> {
    const listed = await this.client.listProviders({}, { signal });
    let statuses: Awaited<ReturnType<AxlClient["providerAuthenticationStatus"]>> = {
      providers: [],
    };
    let error: string | undefined;
    if (this.client.connection.grantedCapabilities.includes("provider.auth.status")) {
      try {
        statuses = await this.client.providerAuthenticationStatus({}, { signal });
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "Could not load authentication status";
      }
    }
    const statusByProvider = new Map(
      statuses.providers.map((status) => [status.providerId, status]),
    );
    const providers = listed.providers.map((provider) => ({
      ...provider,
      authentication: statusByProvider.get(provider.providerId) ?? provider.authentication,
    }));
    return {
      status: "ready",
      providers,
      models: providers.flatMap((provider) =>
        provider.models.map((model) => ({
          providerId: model.providerId,
          providerDisplayName: provider.displayName,
          modelId: model.modelId,
          displayName: model.displayName,
          thinkingLevels: model.supportedThinkingLevels,
          availability: model.availability,
        })),
      ),
      ...(error === undefined ? {} : { error }),
    };
  }

  private setState(state: ProviderDirectoryState): void {
    this.stateValue = state;
    for (const listener of this.listeners) listener(state);
  }
}

export interface ClientModelInfo {
  readonly providerId?: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Readonly<Partial<Record<ThinkingLevel, string | null>>>;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly cost?: ClientModelCost;
}
