// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  type ApiKeyCredential,
  type Credential,
  type CredentialStore,
  credentialSecretValues,
  type OAuthCredential,
  type ProviderEnv,
} from "./credentials.ts";

export type AuthErrorCode = "not_configured" | "invalid_auth" | "refresh_failed" | "store_failure";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly providerId: string;

  constructor(code: AuthErrorCode, providerId: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AuthError";
    this.code = code;
    this.providerId = providerId;
  }
}

/** Request auth for one model call. Anything else is provider configuration. */
export interface ModelAuth {
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly baseUrl?: string;
}

export interface ResolvedAuth {
  readonly auth: ModelAuth;
  /** Human-readable origin for status display, e.g. `AZURE_OPENAI_API_KEY`. */
  readonly source: string;
  /** Provider-scoped config resolved alongside the auth. */
  readonly env?: ProviderEnv;
  /**
   * Every secret inside `auth`. Callers must register these with the event
   * log's redaction before the auth is used, so credentials can never enter
   * prompts, events, generated artifacts, or diagnostics.
   */
  readonly secretValues: readonly string[];
}

/** Environment access for resolution. Injectable for tests. */
export interface AuthContext {
  env(name: string): string | undefined;
  fileExists(path: string): Promise<boolean>;
}

export const nodeAuthContext: AuthContext = {
  env: (name) => process.env[name],
  fileExists: async (path) => {
    const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
    try {
      await access(expanded);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Api-key-shaped auth: stored keys, environment variables, ambient credential
 * files, and keyless local endpoints. `resolve` merges the stored credential
 * with ambient sources and returns undefined when the provider is simply not
 * configured.
 */
export interface ApiKeyAuthMethod {
  readonly displayName: string;
  resolve(input: {
    context: AuthContext;
    credential?: ApiKeyCredential | undefined;
    signal: AbortSignal;
  }): Promise<ResolvedAuth | undefined>;
}

/**
 * OAuth-shaped auth. `refresh` exchanges the refresh token (network call,
 * throws on failure); `toAuth` derives request auth from a valid credential
 * without side effects. The resolver owns the locked refresh pattern.
 */
export interface OAuthAuthMethod {
  readonly displayName: string;
  refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
  toAuth(credential: OAuthCredential): ModelAuth;
}

export interface ProviderAuthMethods {
  readonly apiKey?: ApiKeyAuthMethod;
  readonly oauth?: OAuthAuthMethod;
}

export interface ResolveAuthOptions {
  readonly signal?: AbortSignal;
  /** Remaining OAuth validity required before a refresh triggers. */
  readonly minValidityMs?: number;
}

const DEFAULT_MIN_VALIDITY_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15_000;

/** Explicit login: persist a credential through the store's serialized write path. */
export async function login(
  store: CredentialStore,
  providerId: string,
  credential: Credential,
): Promise<void> {
  await store.modify(providerId, () => Promise.resolve(credential));
}

/** Explicit logout: remove the stored credential. */
export async function logout(store: CredentialStore, providerId: string): Promise<void> {
  await store.delete(providerId);
}

/**
 * Resolves request auth for a provider or fails with an explicit auth state.
 * A stored credential owns the provider; ambient sources are consulted only
 * when nothing is stored, and never after a failed refresh.
 */
export async function resolveProviderAuth(
  providerId: string,
  methods: ProviderAuthMethods,
  store: CredentialStore,
  context: AuthContext,
  options: ResolveAuthOptions = {},
): Promise<ResolvedAuth> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();

  let stored: Credential | undefined;
  try {
    stored = await store.read(providerId);
  } catch (error) {
    throw new AuthError(
      "store_failure",
      providerId,
      `Credential store read failed for ${providerId}`,
      error,
    );
  }

  if (stored !== undefined) {
    if (stored.type === "oauth" && methods.oauth) {
      return resolveStoredOAuth(providerId, methods.oauth, store, stored, signal, options);
    }
    if (stored.type === "api_key" && methods.apiKey) {
      return resolveApiKey(providerId, methods.apiKey, context, stored, signal);
    }
    throw new AuthError(
      "not_configured",
      providerId,
      `Stored ${stored.type} credential for ${providerId} has no matching auth method`,
    );
  }

  if (methods.apiKey) {
    return resolveApiKey(providerId, methods.apiKey, context, undefined, signal);
  }
  throw new AuthError(
    "not_configured",
    providerId,
    `Provider ${providerId} has no stored credential and no ambient auth method`,
  );
}

async function resolveApiKey(
  providerId: string,
  method: ApiKeyAuthMethod,
  context: AuthContext,
  credential: ApiKeyCredential | undefined,
  signal: AbortSignal,
): Promise<ResolvedAuth> {
  let resolved: ResolvedAuth | undefined;
  try {
    resolved = await method.resolve({ context, credential, signal });
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(
      "invalid_auth",
      providerId,
      `${method.displayName} resolution failed for ${providerId}`,
      error,
    );
  }
  if (resolved === undefined) {
    throw new AuthError(
      "not_configured",
      providerId,
      `${method.displayName} is not configured for ${providerId}`,
    );
  }
  return resolved;
}

async function resolveStoredOAuth(
  providerId: string,
  method: OAuthAuthMethod,
  store: CredentialStore,
  stored: OAuthCredential,
  signal: AbortSignal,
  options: ResolveAuthOptions,
): Promise<ResolvedAuth> {
  const minValidityMs = Math.max(DEFAULT_MIN_VALIDITY_MS, options.minValidityMs ?? 0);
  const expiresSoon = (credential: OAuthCredential) =>
    Date.now() + minValidityMs >= credential.expiresAt;

  let credential = stored;
  if (expiresSoon(credential)) {
    // The optimistic check saw an expiring token; the authoritative check and
    // the single refresh both run inside the store's serialized write.
    let post: Credential | undefined;
    try {
      post = await store.modify(providerId, async (current) => {
        if (current?.type !== "oauth") return undefined; // logged out meanwhile
        if (!expiresSoon(current)) return undefined; // already refreshed elsewhere
        const refreshSignal = AbortSignal.any([signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)]);
        return method.refresh(current, refreshSignal);
      });
    } catch (error) {
      throw new AuthError(
        "refresh_failed",
        providerId,
        `OAuth refresh failed for ${providerId}; log in again`,
        error,
      );
    }
    if (post?.type !== "oauth") {
      throw new AuthError(
        "not_configured",
        providerId,
        `Provider ${providerId} was logged out during refresh`,
      );
    }
    credential = post;
  }

  return {
    auth: method.toAuth(credential),
    source: method.displayName,
    secretValues: credentialSecretValues(credential),
  };
}
