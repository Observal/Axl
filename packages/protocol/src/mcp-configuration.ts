// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import { ProtocolValidationError } from "./event-envelope.ts";

export interface McpHttpServerDefinition {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly oauth?: {
    readonly clientId?: string;
    readonly clientSecretEnv?: string;
    readonly scope?: string;
  };
  readonly roots?: readonly string[];
  readonly enabled?: boolean;
  readonly requestTimeoutMs?: number;
}

export interface McpStdioServerDefinition {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly roots?: readonly string[];
  readonly enabled?: boolean;
  readonly requestTimeoutMs?: number;
}

export type McpServerDefinition = McpHttpServerDefinition | McpStdioServerDefinition;

/**
 * Daemon-projected discovery state for one configured server.
 * `pending` means no session has discovered the server yet.
 */
export type McpServerStatus = "discovered" | "failed" | "disabled" | "pending";

export interface McpServerToolSummary {
  readonly name: string;
  readonly description: string;
}

export interface McpServerEntry {
  readonly name: string;
  readonly definition: McpServerDefinition;
  readonly status: McpServerStatus;
  readonly tools: readonly McpServerToolSummary[];
  /** Present when `status` is `discovered`. */
  readonly discoveredAt?: number;
  /** Redacted failure message. Present when `status` is `failed`. */
  readonly error?: string;
}

export interface McpConfigListResult {
  readonly path: string;
  readonly servers: readonly McpServerEntry[];
}

export interface McpConfigUpsertParams {
  readonly name: string;
  readonly definition: McpServerDefinition;
}

export interface McpConfigRemoveParams {
  readonly name: string;
}

export interface McpConfigProbeParams {
  readonly name: string;
  readonly definition: McpServerDefinition;
}

export interface McpConfigProbeResult {
  readonly protocolVersion: string;
  readonly tools: readonly McpServerToolSummary[];
  /**
   * The server answered but requires OAuth before it lists tools. Saving it is
   * safe; the browser authorization prompt appears when a session first connects.
   */
  readonly authorization?: "required";
}

export interface McpConfigMutationResult extends McpConfigListResult {
  readonly changed: boolean;
}

export const MCP_CONFIG_LIMITS = {
  servers: 256,
  toolsPerServer: 1_000,
  toolDescription: 4_096,
  error: 2_000,
} as const;

export const MCP_SERVER_STATUSES: readonly McpServerStatus[] = [
  "discovered",
  "failed",
  "disabled",
  "pending",
];

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new ProtocolValidationError(`${path}.${key}`, "is not allowed");
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new ProtocolValidationError(
      path,
      "must be a non-empty string of at most 4096 characters",
    );
  }
  return value;
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path);
}

function stringArray(value: unknown, path: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) {
    throw new ProtocolValidationError(path, "must be an array of at most 128 strings");
  }
  return value.map((item, index) => text(item, `${path}[${index}]`));
}

function stringMap(value: unknown, path: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const input = object(value, path);
  if (Object.keys(input).length > 128) {
    throw new ProtocolValidationError(path, "must contain at most 128 entries");
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, item]) => [
      text(key, `${path}.key`),
      text(item, `${path}.${key}`),
    ]),
  );
}

function common(
  input: Record<string, unknown>,
  path: string,
): {
  roots?: readonly string[];
  enabled?: boolean;
  requestTimeoutMs?: number;
} {
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new ProtocolValidationError(`${path}.enabled`, "must be a boolean");
  }
  if (
    input.requestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(input.requestTimeoutMs) || (input.requestTimeoutMs as number) < 1)
  ) {
    throw new ProtocolValidationError(
      `${path}.requestTimeoutMs`,
      "must be a positive safe integer",
    );
  }
  const roots = stringArray(input.roots, `${path}.roots`);
  return {
    ...(roots === undefined ? {} : { roots }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled as boolean }),
    ...(input.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: input.requestTimeoutMs as number }),
  };
}

export function parseMcpServerDefinition(value: unknown, path: string): McpServerDefinition {
  const input = object(value, path);
  const hasUrl = input.url !== undefined;
  const hasCommand = input.command !== undefined;
  if (hasUrl === hasCommand) {
    throw new ProtocolValidationError(path, "must contain exactly one of url or command");
  }
  if (hasUrl) {
    exact(input, path, ["url", "headers", "oauth", "roots", "enabled", "requestTimeoutMs"]);
    const headers = stringMap(input.headers, `${path}.headers`);
    let oauth: McpHttpServerDefinition["oauth"];
    if (input.oauth !== undefined) {
      const raw = object(input.oauth, `${path}.oauth`);
      exact(raw, `${path}.oauth`, ["clientId", "clientSecretEnv", "scope"]);
      oauth = {
        ...(optionalText(raw.clientId, `${path}.oauth.clientId`) === undefined
          ? {}
          : { clientId: raw.clientId as string }),
        ...(optionalText(raw.clientSecretEnv, `${path}.oauth.clientSecretEnv`) === undefined
          ? {}
          : { clientSecretEnv: raw.clientSecretEnv as string }),
        ...(optionalText(raw.scope, `${path}.oauth.scope`) === undefined
          ? {}
          : { scope: raw.scope as string }),
      };
    }
    return {
      url: text(input.url, `${path}.url`),
      ...(headers === undefined ? {} : { headers }),
      ...(oauth === undefined ? {} : { oauth }),
      ...common(input, path),
    };
  }
  exact(input, path, ["command", "args", "cwd", "env", "roots", "enabled", "requestTimeoutMs"]);
  const args = stringArray(input.args, `${path}.args`);
  const cwd = optionalText(input.cwd, `${path}.cwd`);
  const env = stringMap(input.env, `${path}.env`);
  return {
    command: text(input.command, `${path}.command`),
    ...(args === undefined ? {} : { args }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    ...common(input, path),
  };
}

export function parseMcpServerName(value: unknown, path: string): string {
  if (typeof value !== "string" || !SERVER_NAME.test(value)) {
    throw new ProtocolValidationError(path, "must be a valid MCP server name");
  }
  return value;
}

function parseToolSummaries(value: unknown, path: string): readonly McpServerToolSummary[] {
  if (!Array.isArray(value) || value.length > MCP_CONFIG_LIMITS.toolsPerServer) {
    throw new ProtocolValidationError(
      path,
      `must be an array of at most ${MCP_CONFIG_LIMITS.toolsPerServer} tools`,
    );
  }
  return value.map((item, index) => {
    const tool = object(item, `${path}[${index}]`);
    exact(tool, `${path}[${index}]`, ["name", "description"]);
    const description = tool.description;
    if (typeof description !== "string" || description.length > MCP_CONFIG_LIMITS.toolDescription) {
      throw new ProtocolValidationError(
        `${path}[${index}].description`,
        `must be a string of at most ${MCP_CONFIG_LIMITS.toolDescription} characters`,
      );
    }
    return { name: text(tool.name, `${path}[${index}].name`), description };
  });
}

function parseServerEntry(value: unknown, path: string): McpServerEntry {
  const item = object(value, path);
  exact(item, path, ["name", "definition", "status", "tools", "discoveredAt", "error"]);
  const status = item.status;
  if (typeof status !== "string" || !MCP_SERVER_STATUSES.includes(status as McpServerStatus)) {
    throw new ProtocolValidationError(`${path}.status`, "must be a known MCP server status");
  }
  if (item.discoveredAt !== undefined) {
    if (status !== "discovered") {
      throw new ProtocolValidationError(
        `${path}.discoveredAt`,
        "is only allowed when status is discovered",
      );
    }
    if (!Number.isSafeInteger(item.discoveredAt) || (item.discoveredAt as number) < 0) {
      throw new ProtocolValidationError(
        `${path}.discoveredAt`,
        "must be a non-negative safe integer",
      );
    }
  }
  if (item.error !== undefined) {
    if (status !== "failed") {
      throw new ProtocolValidationError(`${path}.error`, "is only allowed when status is failed");
    }
    if (typeof item.error !== "string" || item.error.length > MCP_CONFIG_LIMITS.error) {
      throw new ProtocolValidationError(
        `${path}.error`,
        `must be a string of at most ${MCP_CONFIG_LIMITS.error} characters`,
      );
    }
  } else if (status === "failed") {
    throw new ProtocolValidationError(`${path}.error`, "is required when status is failed");
  }
  return {
    name: parseMcpServerName(item.name, `${path}.name`),
    definition: parseMcpServerDefinition(item.definition, `${path}.definition`),
    status: status as McpServerStatus,
    tools: parseToolSummaries(item.tools, `${path}.tools`),
    ...(item.discoveredAt === undefined ? {} : { discoveredAt: item.discoveredAt as number }),
    ...(item.error === undefined ? {} : { error: item.error as string }),
  };
}

export function parseMcpConfigListResult(value: unknown): McpConfigListResult {
  const input = object(value, "result");
  exact(input, "result", ["path", "servers"]);
  if (!Array.isArray(input.servers) || input.servers.length > MCP_CONFIG_LIMITS.servers) {
    throw new ProtocolValidationError(
      "result.servers",
      `must be an array of at most ${MCP_CONFIG_LIMITS.servers} servers`,
    );
  }
  return {
    path: text(input.path, "result.path"),
    servers: input.servers.map((item, index) => parseServerEntry(item, `result.servers[${index}]`)),
  };
}

export function parseMcpConfigProbeResult(value: unknown): McpConfigProbeResult {
  const input = object(value, "result");
  exact(input, "result", ["protocolVersion", "tools", "authorization"]);
  if (input.authorization !== undefined && input.authorization !== "required") {
    throw new ProtocolValidationError("result.authorization", 'must be "required" when present');
  }
  return {
    protocolVersion: text(input.protocolVersion, "result.protocolVersion"),
    tools: parseToolSummaries(input.tools, "result.tools"),
    ...(input.authorization === undefined ? {} : { authorization: "required" as const }),
  };
}

export function parseMcpConfigMutationResult(value: unknown): McpConfigMutationResult {
  const input = object(value, "result");
  exact(input, "result", ["path", "servers", "changed"]);
  if (typeof input.changed !== "boolean") {
    throw new ProtocolValidationError("result.changed", "must be a boolean");
  }
  const listed = parseMcpConfigListResult({ path: input.path, servers: input.servers });
  return { ...listed, changed: input.changed };
}
