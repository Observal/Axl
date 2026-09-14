// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import {
  AxlClient,
  parseProviderAuthenticationStatus,
  parseRpcResult,
  parseSessionId,
  type SessionId,
  type SessionOpenResult,
  type TrustedProviderHost,
  WIRE_CAPABILITIES,
} from "@axl/sdk";
import { BrowserWebSocketTransportFactory } from "@axl/sdk/browser";

import { type PaneId, parsePaneIds } from "./panes.ts";

export const SIDEBAR_WIDTH_RANGE = Object.freeze({ min: 200, max: 420 });
export const DOCK_WIDTH_RANGE = Object.freeze({ min: 380, max: 1200 });

export interface WebPreferences {
  readonly sidebarWidth: number;
  /** Width of the right-hand pane dock. */
  readonly dockWidth: number;
  readonly sidebarCollapsed: boolean;
  readonly changesView: "files" | "all";
  /** Open dock panes in tiling order. */
  readonly panes: readonly PaneId[];
}

export type WebHostCapability = "project.folder.validate" | "provider.auth.login";

export type ProjectFolderValidation =
  | { readonly valid: true; readonly path: string }
  | { readonly valid: false; readonly error: string };

const WEB_HOST_CAPABILITIES = ["project.folder.validate", "provider.auth.login"] as const;

export const WEB_REQUESTED_CAPABILITIES = Object.freeze(
  WIRE_CAPABILITIES.filter((capability) => capability !== "provider.auth.login"),
);

export interface WebBootstrap {
  readonly cwd: string;
  readonly webSocketPath: string;
  readonly preferences: WebPreferences;
  readonly hostCapabilities: readonly WebHostCapability[];
}

export function browserSessionPath(href: string, sessionId?: SessionId): string {
  const url = new URL(href);
  if (sessionId === undefined) url.searchParams.delete("session");
  else url.searchParams.set("session", sessionId);
  return `${url.pathname}${url.search}`;
}

export function retainBrowserSession(sessionId?: SessionId): void {
  history.replaceState(null, "", browserSessionPath(location.href, sessionId));
}

function fragment(): { readonly token?: string; readonly sessionId?: SessionId } {
  const values = new URLSearchParams(location.hash.slice(1));
  const token = values.get("token") ?? undefined;
  const requestedSession =
    values.get("session") ?? new URLSearchParams(location.search).get("session");
  let sessionId: SessionId | undefined;
  try {
    if (requestedSession !== null) sessionId = parseSessionId(requestedSession);
  } catch {
    sessionId = undefined;
  }
  retainBrowserSession(sessionId);
  return {
    ...(token === undefined ? {} : { token }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

async function json<Response>(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok)
    throw new Error((await response.text()) || `Request failed (${response.status})`);
  return response.json() as Promise<Response>;
}

export function parseWebPreferences(value: unknown): WebPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid web preferences");
  const preferences = value as Record<string, unknown>;
  if (
    !Number.isInteger(preferences.sidebarWidth) ||
    Number(preferences.sidebarWidth) < SIDEBAR_WIDTH_RANGE.min ||
    Number(preferences.sidebarWidth) > SIDEBAR_WIDTH_RANGE.max ||
    !Number.isInteger(preferences.dockWidth) ||
    Number(preferences.dockWidth) < DOCK_WIDTH_RANGE.min ||
    Number(preferences.dockWidth) > DOCK_WIDTH_RANGE.max ||
    typeof preferences.sidebarCollapsed !== "boolean" ||
    (preferences.changesView !== "files" && preferences.changesView !== "all")
  )
    throw new Error("Invalid web preferences");
  let panes: readonly PaneId[];
  try {
    panes = parsePaneIds(preferences.panes);
  } catch (cause) {
    throw new Error("Invalid web preferences", { cause });
  }
  return {
    sidebarWidth: preferences.sidebarWidth as number,
    dockWidth: preferences.dockWidth as number,
    sidebarCollapsed: preferences.sidebarCollapsed,
    changesView: preferences.changesView,
    panes,
  };
}

export function parseBootstrap(value: unknown): WebBootstrap {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid web bootstrap response");
  const record = value as Record<string, unknown>;
  if (
    typeof record.cwd !== "string" ||
    typeof record.webSocketPath !== "string" ||
    !Array.isArray(record.hostCapabilities) ||
    record.hostCapabilities.some(
      (capability) => !(WEB_HOST_CAPABILITIES as readonly unknown[]).includes(capability),
    ) ||
    new Set(record.hostCapabilities).size !== record.hostCapabilities.length
  )
    throw new Error("Invalid web bootstrap response");
  return {
    cwd: record.cwd,
    webSocketPath: record.webSocketPath,
    preferences: parseWebPreferences(record.preferences),
    hostCapabilities: record.hostCapabilities as readonly WebHostCapability[],
  };
}

export const browserProviderHost: TrustedProviderHost = {
  loginProvider: async (params, options = {}) => {
    options.signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    const login = json<unknown>("host/provider/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, ...params }),
    }).then((result) => parseProviderAuthenticationStatus(result, "providerLogin"));
    if (options.signal === undefined) return login;
    const signal = options.signal;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result?: Awaited<typeof login>, error?: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", cancel);
        if (error !== undefined) reject(error);
        else if (result !== undefined) resolve(result);
      };
      const cancel = (): void => {
        void json<unknown>("host/provider/login/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId }),
        }).then(
          () => finish(undefined, new DOMException("Provider login cancelled", "AbortError")),
          (cause: unknown) =>
            finish(
              undefined,
              new Error("Could not cancel provider login; check the terminal", { cause }),
            ),
        );
      };
      signal.addEventListener("abort", cancel, { once: true });
      void login.then(
        (result) => {
          if (!signal.aborted) finish(result);
        },
        (error: unknown) => {
          if (!signal.aborted) finish(undefined, error);
        },
      );
      if (signal.aborted) cancel();
    });
  },
};

export async function saveWebPreferences(preferences: WebPreferences): Promise<void> {
  await json("preferences", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(preferences),
  });
}

export async function validateProjectFolder(
  path: string,
  signal?: AbortSignal,
): Promise<ProjectFolderValidation> {
  const value = await json<unknown>("host/project-folder/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid project folder validation response");
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result).sort();
  if (
    keys.join(",") === "path,valid" &&
    result.valid === true &&
    typeof result.path === "string" &&
    result.path !== ""
  )
    return { valid: true, path: result.path };
  if (
    keys.join(",") === "error,valid" &&
    result.valid === false &&
    typeof result.error === "string" &&
    result.error !== ""
  )
    return { valid: false, error: result.error };
  throw new Error("Invalid project folder validation response");
}

export async function exportSessionArtifact(sessionId: SessionId): Promise<Blob> {
  const response = await fetch("artifact/export", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!response.ok) throw new Error((await response.text()) || "Could not export the session");
  return response.blob();
}

export async function importSessionArtifact(file: File): Promise<SessionOpenResult> {
  if (file.size === 0 || file.size > 64 * 1024 * 1024) {
    throw new Error("Session artifact must be between 1 byte and 64 MiB");
  }
  const response = await fetch("artifact/import", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: file,
  });
  if (!response.ok) throw new Error((await response.text()) || "Could not import the session");
  return parseRpcResult("session.import", await response.json());
}

export async function connectWebEnvironment(): Promise<{
  readonly client: AxlClient;
  readonly bootstrap: WebBootstrap;
  readonly selectedSessionId?: SessionId;
}> {
  const selected = fragment();
  if (selected.token !== undefined) {
    await json("auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: selected.token }),
    });
  }
  const bootstrap = parseBootstrap(await json<unknown>("bootstrap", { method: "POST" }));
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const client = await AxlClient.connect({
    transport: new BrowserWebSocketTransportFactory(
      `${protocol}//${location.host}${new URL(bootstrap.webSocketPath, location.href).pathname}`,
    ),
    identity: { kind: "web", version: "0.0.0", instanceId: crypto.randomUUID() },
    idempotencyKeys: { create: () => crypto.randomUUID() },
    requestedCapabilities: WEB_REQUESTED_CAPABILITIES,
  });
  return {
    client,
    bootstrap,
    ...(selected.sessionId === undefined ? {} : { selectedSessionId: selected.sessionId }),
  };
}
