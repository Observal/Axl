// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Phone sign-in: the OAuth authorization code flow with PKCE against the stack's Cognito user
 * pool, which federates Google. The page sends the pool's access token where it used to send the
 * account token from the pairing link; the control plane grants it the phone scope only.
 *
 * The refresh token stays in local storage so the phone stays signed in across visits, like the
 * pairing it sits next to. Access tokens live in memory and are refreshed shortly before they
 * expire.
 */

export interface SignInConfig {
  /** Origin of the user pool's hosted domain, for example `https://auth.remote.observal.io`. */
  readonly authority: string;
  readonly clientId: string;
  /** The identity provider to send people straight to, skipping the hosted chooser. */
  readonly provider: string;
}

export interface SignInStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface Pending {
  readonly state: string;
  readonly verifier: string;
  /** The pairing link's fragment, which the round trip through the provider would lose. */
  readonly fragment: string;
}

interface Tokens {
  readonly accessToken: string;
  readonly expiresAt: number;
}

const SESSION_KEY = "axl.remote.sign-in";
const PENDING_KEY = "axl.remote.sign-in.pending";
/** Refresh this long before the access token expires, so no request carries a stale one. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_TOKEN_CHARACTERS = 16_384;

export class SignInRequiredError extends Error {
  constructor(message = "Sign in again to use this phone") {
    super(message);
    this.name = "SignInRequiredError";
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomText(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The S256 PKCE challenge for `verifier`. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Parse `sign-in.json`; anything malformed turns sign-in off rather than half on. */
export function parseSignInConfig(value: unknown): SignInConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { authority, clientId, provider } = value as Record<string, unknown>;
  if (typeof authority !== "string" || typeof clientId !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(authority);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") return undefined;
  if (clientId.length === 0 || clientId.length > 256) return undefined;
  return {
    authority: url.origin,
    clientId,
    provider: typeof provider === "string" && provider.length > 0 ? provider : "Google",
  };
}

/** Load the page's sign-in configuration; undefined when the stack has no phone sign-in. */
export async function loadSignInConfig(page: URL): Promise<SignInConfig | undefined> {
  const response = await fetch(new URL("sign-in.json", page), { cache: "no-store" });
  if (response.status === 404 || response.status === 403) return undefined;
  if (!response.ok) throw new Error(`Sign-in configuration is unavailable (${response.status})`);
  return parseSignInConfig(await response.json());
}

function tokens(value: unknown, now: number): { tokens: Tokens; refreshToken?: string } {
  const body = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const accessToken = body.access_token;
  const expiresIn = body.expires_in;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    accessToken.length > MAX_TOKEN_CHARACTERS ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error("Sign-in answered without a usable access token");
  }
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? body.refresh_token
      : undefined;
  return {
    tokens: { accessToken, expiresAt: now + expiresIn * 1000 },
    ...(refreshToken === undefined ? {} : { refreshToken }),
  };
}

export class PhoneSignIn {
  readonly #config: SignInConfig;
  readonly #redirectUri: string;
  readonly #local: SignInStorage;
  readonly #session: SignInStorage;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #listeners = new Set<(accessToken: string) => void>();
  #tokens: Tokens | undefined;
  #refreshing: Promise<string> | undefined;

  constructor(options: {
    readonly config: SignInConfig;
    /** The page URL without query or fragment; registered with the user pool client. */
    readonly redirectUri: string;
    readonly local: SignInStorage;
    readonly session: SignInStorage;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
  }) {
    this.#config = options.config;
    this.#redirectUri = options.redirectUri;
    this.#local = options.local;
    this.#session = options.session;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  /** Whether a refresh token is kept, so the phone can get access tokens without a redirect. */
  get signedIn(): boolean {
    return this.#tokens !== undefined || this.#refreshToken() !== undefined;
  }

  /** Called with each new access token; the witness binding needs the current one. */
  onToken(listener: (accessToken: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The URL to send the browser to, keeping `fragment` (the pairing link) for the way back. */
  async authorizeUrl(fragment: string): Promise<string> {
    const pending: Pending = { state: randomText(16), verifier: randomText(48), fragment };
    this.#session.setItem(PENDING_KEY, JSON.stringify(pending));
    const url = new URL("/oauth2/authorize", this.#config.authority);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.#config.clientId,
      redirect_uri: this.#redirectUri,
      scope: "openid email",
      identity_provider: this.#config.provider,
      state: pending.state,
      code_challenge_method: "S256",
      code_challenge: await pkceChallenge(pending.verifier),
    }).toString();
    return url.toString();
  }

  /**
   * Finish a redirect back from the provider: exchange the code, keep the refresh token, and
   * return the fragment saved before leaving. Undefined when `search` carries no answer.
   */
  async complete(search: string): Promise<{ readonly fragment: string } | undefined> {
    const query = new URLSearchParams(search);
    const code = query.get("code");
    const error = query.get("error");
    if (code === null && error === null) return undefined;
    const raw = this.#session.getItem(PENDING_KEY);
    this.#session.removeItem(PENDING_KEY);
    const pending = raw === null ? undefined : (JSON.parse(raw) as Pending);
    if (pending === undefined || query.get("state") !== pending.state) {
      throw new SignInRequiredError("This sign-in did not start on this page. Sign in again.");
    }
    if (error !== null || code === null) {
      throw new SignInRequiredError(
        error === "access_denied" ? "Sign-in was cancelled" : "Sign-in failed. Try again.",
      );
    }
    const answer = await this.#token({
      grant_type: "authorization_code",
      client_id: this.#config.clientId,
      code,
      redirect_uri: this.#redirectUri,
      code_verifier: pending.verifier,
    });
    if (answer.refreshToken === undefined) {
      throw new Error("Sign-in answered without a refresh token");
    }
    this.#local.setItem(SESSION_KEY, JSON.stringify({ refreshToken: answer.refreshToken }));
    this.#accept(answer.tokens);
    return { fragment: pending.fragment };
  }

  /** A current access token, refreshed when it is close to expiring. */
  async accessToken(): Promise<string> {
    const current = this.#tokens;
    if (current !== undefined && current.expiresAt - this.#now() > REFRESH_MARGIN_MS) {
      return current.accessToken;
    }
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    try {
      return await this.#refreshing;
    } catch (cause) {
      // A refresh that failed for a network hiccup falls back on a token that is still good.
      if (
        !(cause instanceof SignInRequiredError) &&
        current !== undefined &&
        current.expiresAt - this.#now() > 30_000
      ) {
        return current.accessToken;
      }
      throw cause;
    }
  }

  /** Forget the session here and revoke its refresh token with the user pool. */
  async signOut(): Promise<void> {
    const refreshToken = this.#refreshToken();
    this.#local.removeItem(SESSION_KEY);
    this.#tokens = undefined;
    if (refreshToken === undefined) return;
    await this.#fetch(new URL("/oauth2/revoke", this.#config.authority), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken, client_id: this.#config.clientId }),
    }).catch(() => undefined);
  }

  async #refresh(): Promise<string> {
    const refreshToken = this.#refreshToken();
    if (refreshToken === undefined) throw new SignInRequiredError();
    const answer = await this.#token({
      grant_type: "refresh_token",
      client_id: this.#config.clientId,
      refresh_token: refreshToken,
    });
    this.#accept(answer.tokens);
    return answer.tokens.accessToken;
  }

  async #token(form: Record<string, string>) {
    const response = await this.#fetch(new URL("/oauth2/token", this.#config.authority), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    if (response.status === 400 || response.status === 401) {
      // invalid_grant and friends: the refresh token expired or was revoked.
      this.#local.removeItem(SESSION_KEY);
      this.#tokens = undefined;
      throw new SignInRequiredError();
    }
    if (!response.ok) throw new Error(`Sign-in is unavailable (${response.status})`);
    return tokens(await response.json(), this.#now());
  }

  #accept(next: Tokens): void {
    this.#tokens = next;
    for (const listener of this.#listeners) listener(next.accessToken);
  }

  #refreshToken(): string | undefined {
    try {
      const value = JSON.parse(this.#local.getItem(SESSION_KEY) ?? "null") as {
        readonly refreshToken?: unknown;
      } | null;
      return typeof value?.refreshToken === "string" && value.refreshToken.length > 0
        ? value.refreshToken
        : undefined;
    } catch {
      return undefined;
    }
  }
}
