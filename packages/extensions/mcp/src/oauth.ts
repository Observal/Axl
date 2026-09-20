// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { McpHttpOAuthConfig } from "./config.ts";
import type { McpInteractionRequest, McpInteractionResponse } from "./types.ts";

function assertSafeAuthorizationUrl(url: URL): void {
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password
  ) {
    throw new Error(`Unsafe MCP authorization URL ${url.href}`);
  }
}

interface StoredOAuthState {
  readonly clientInformation?: OAuthClientInformationMixed;
  readonly tokens?: OAuthTokens;
  readonly codeVerifier?: string;
  readonly discovery?: OAuthDiscoveryState;
}

async function readState(path: string): Promise<StoredOAuthState> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("OAuth state must be an object");
    }
    return value as StoredOAuthState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read MCP OAuth state ${path}`, { cause: error });
  }
}

async function writeState(path: string, state: StoredOAuthState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

interface CallbackListener {
  readonly redirectUrl: URL;
  waitForCode(expectedState: string, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

async function callbackListener(): Promise<CallbackListener> {
  let pending:
    | {
        readonly expectedState: string;
        readonly resolve: (value: string) => void;
        readonly reject: (error: Error) => void;
      }
    | undefined;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!pending) {
      response.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("No authorization is pending. Return to Axl.");
      return;
    }
    if (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Authorization failed. Return to Axl.");
      pending.reject(new Error(`OAuth authorization failed: ${error}`));
      pending = undefined;
      return;
    }
    if (!code || !state || state !== pending.expectedState) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Invalid OAuth callback. Return to Axl.");
      pending.reject(new Error("OAuth callback did not contain the expected code and state"));
      pending = undefined;
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
    response.end(
      "<!doctype html><title>Axl</title><h1>Authorization complete</h1><p>You may close this window.</p>",
    );
    pending.resolve(code);
    pending = undefined;
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("OAuth callback server did not bind a TCP port");
  }
  return {
    redirectUrl: new URL(`http://127.0.0.1:${address.port}/callback`),
    waitForCode(state: string, signal?: AbortSignal): Promise<string> {
      if (signal?.aborted) return Promise.reject(new DOMException("OAuth aborted", "AbortError"));
      if (pending) return Promise.reject(new Error("Another OAuth callback is already pending"));
      return new Promise<string>((resolvePromise, rejectPromise) => {
        const abort = (): void => {
          pending = undefined;
          rejectPromise(new DOMException("OAuth aborted", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        pending = {
          expectedState: state,
          resolve: (code) => {
            signal?.removeEventListener("abort", abort);
            resolvePromise(code);
          },
          reject: (error) => {
            signal?.removeEventListener("abort", abort);
            rejectPromise(error);
          },
        };
      });
    },
    close: () =>
      new Promise<void>((resolvePromise) => {
        pending?.reject(new Error("OAuth callback listener closed"));
        pending = undefined;
        if (!server.listening) resolvePromise();
        else server.close(() => resolvePromise());
      }),
  };
}

function oauthSecrets(state: StoredOAuthState): readonly string[] {
  return [
    state.clientInformation?.client_secret,
    state.tokens?.access_token,
    state.tokens?.refresh_token,
    state.codeVerifier,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

class PersistentOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: URL;
  readonly clientMetadata: OAuthClientMetadata;
  private readonly path: string;
  private stored: StoredOAuthState;
  private readonly callback: CallbackListener;
  private readonly interact: (
    request: McpInteractionRequest,
    signal?: AbortSignal,
  ) => Promise<McpInteractionResponse>;
  private readonly source: string;
  private readonly signal: AbortSignal | undefined;
  private readonly configuredClientInformation: OAuthClientInformationMixed | undefined;
  private readonly onSecrets: (values: readonly string[]) => void;
  private stateValue = randomUUID();
  private authorizationCode: string | undefined;

  constructor(
    path: string,
    stored: StoredOAuthState,
    callback: CallbackListener,
    config: McpHttpOAuthConfig,
    interact: (
      request: McpInteractionRequest,
      signal?: AbortSignal,
    ) => Promise<McpInteractionResponse>,
    source: string,
    signal: AbortSignal | undefined,
    env: Readonly<Record<string, string | undefined>>,
    onSecrets: (values: readonly string[]) => void,
  ) {
    this.path = path;
    this.stored = stored;
    this.callback = callback;
    this.interact = interact;
    this.source = source;
    this.signal = signal;
    this.onSecrets = onSecrets;
    this.redirectUrl = callback.redirectUrl;
    const secret = config.clientSecretEnv ? env[config.clientSecretEnv] : undefined;
    if (config.clientSecretEnv && !secret) {
      throw new Error(`MCP OAuth client secret source ${config.clientSecretEnv} is not set`);
    }
    this.clientMetadata = {
      client_name: "Axl",
      redirect_uris: [this.redirectUrl.href],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: secret ? "client_secret_post" : "none",
      ...(config.scope === undefined ? {} : { scope: config.scope }),
    };
    this.configuredClientInformation = config.clientId
      ? {
          client_id: config.clientId,
          ...(secret === undefined ? {} : { client_secret: secret }),
        }
      : undefined;
    this.onSecrets(oauthSecrets(this.stored));
    if (secret) this.onSecrets([secret]);
  }

  state(): string {
    this.stateValue = randomUUID();
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.configuredClientInformation ?? this.stored.clientInformation;
  }

  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    this.stored = { ...this.stored, clientInformation: value };
    this.onSecrets(oauthSecrets(this.stored));
    await writeState(this.path, this.stored);
  }

  tokens(): OAuthTokens | undefined {
    return this.stored.tokens;
  }

  async saveTokens(value: OAuthTokens): Promise<void> {
    this.stored = { ...this.stored, tokens: value };
    this.onSecrets(oauthSecrets(this.stored));
    await writeState(this.path, this.stored);
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    assertSafeAuthorizationUrl(url);
    const code = this.callback.waitForCode(this.stateValue, this.signal);
    let response: McpInteractionResponse;
    try {
      response = await this.interact(
        {
          kind: "mcp_elicitation_url",
          source: this.source,
          message: "Authorize this MCP server in your browser",
          data: { url: url.href },
        },
        this.signal,
      );
    } catch (error) {
      await this.callback.close();
      await code.catch(() => undefined);
      throw error;
    }
    if (response.action !== "accept") {
      await this.callback.close();
      await code.catch(() => undefined);
      throw new Error("MCP authorization was not approved");
    }
    this.authorizationCode = await code;
  }

  async saveCodeVerifier(value: string): Promise<void> {
    this.stored = { ...this.stored, codeVerifier: value };
    this.onSecrets(oauthSecrets(this.stored));
    await writeState(this.path, this.stored);
  }

  codeVerifier(): string {
    if (!this.stored.codeVerifier) throw new Error("MCP OAuth code verifier is missing");
    return this.stored.codeVerifier;
  }

  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    this.stored = { ...this.stored, discovery: value };
    await writeState(this.path, this.stored);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.stored.discovery;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    this.stored =
      scope === "all"
        ? {}
        : {
            ...(scope === "client" || this.stored.clientInformation === undefined
              ? {}
              : { clientInformation: this.stored.clientInformation }),
            ...(scope === "tokens" || this.stored.tokens === undefined
              ? {}
              : { tokens: this.stored.tokens }),
            ...(scope === "verifier" || this.stored.codeVerifier === undefined
              ? {}
              : { codeVerifier: this.stored.codeVerifier }),
            ...(scope === "discovery" || this.stored.discovery === undefined
              ? {}
              : { discovery: this.stored.discovery }),
          };
    await writeState(this.path, this.stored);
  }

  takeAuthorizationCode(): string | undefined {
    const code = this.authorizationCode;
    this.authorizationCode = undefined;
    return code;
  }
}

export interface OAuthSession {
  readonly provider: PersistentOAuthProvider;
  close(): Promise<void>;
}

export async function createOAuthSession(input: {
  readonly path: string;
  readonly config: McpHttpOAuthConfig;
  readonly source: string;
  readonly interact: (
    request: McpInteractionRequest,
    signal?: AbortSignal,
  ) => Promise<McpInteractionResponse>;
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onSecrets?: (values: readonly string[]) => void;
}): Promise<OAuthSession> {
  const stored = await readState(input.path);
  const callback = await callbackListener();
  try {
    const provider = new PersistentOAuthProvider(
      input.path,
      stored,
      callback,
      input.config,
      input.interact,
      input.source,
      input.signal,
      input.env ?? process.env,
      input.onSecrets ?? (() => undefined),
    );
    return { provider, close: () => callback.close() };
  } catch (error) {
    await callback.close();
    throw error;
  }
}
