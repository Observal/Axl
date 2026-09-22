// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

export interface ProviderHttpHooks {
  beforeHeaders?(
    input: { readonly url: string; readonly headers: Readonly<Record<string, string>> },
    signal: AbortSignal,
  ): Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  beforeRequest?(
    input: { readonly url: string; readonly payload: unknown },
    signal: AbortSignal,
  ): unknown | Promise<unknown>;
  afterResponse?(
    input: { readonly url: string; readonly status: number; readonly headers: Readonly<Record<string, string>> },
    signal: AbortSignal,
  ): void | Promise<void>;
}

const providerHooks = new AsyncLocalStorage<ProviderHttpHooks>();

export function runWithProviderHooks<Result>(
  hooks: ProviderHttpHooks | undefined,
  operation: () => Promise<Result>,
): Promise<Result> {
  return hooks === undefined ? operation() : providerHooks.run(hooks, operation);
}

export function currentProviderHooks(): ProviderHttpHooks | undefined {
  return providerHooks.getStore();
}
