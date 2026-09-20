// SPDX-FileCopyrightText: 2026 Hari Srinivasan
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

export interface McpConfigListResult {
  readonly path: string;
  readonly servers: readonly {
    readonly name: string;
    readonly definition: McpServerDefinition;
  }[];
}

export interface McpConfigUpsertParams {
  readonly name: string;
  readonly definition: McpServerDefinition;
}

export interface McpConfigRemoveParams {
  readonly name: string;
}

export interface McpConfigMutationResult extends McpConfigListResult {
  readonly changed: boolean;
}

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

export function parseMcpConfigListResult(value: unknown): McpConfigListResult {
  const input = object(value, "result");
  exact(input, "result", ["path", "servers"]);
  if (!Array.isArray(input.servers) || input.servers.length > 256) {
    throw new ProtocolValidationError("result.servers", "must be an array of at most 256 servers");
  }
  return {
    path: text(input.path, "result.path"),
    servers: input.servers.map((value, index) => {
      const item = object(value, `result.servers[${index}]`);
      exact(item, `result.servers[${index}]`, ["name", "definition"]);
      return {
        name: parseMcpServerName(item.name, `result.servers[${index}].name`),
        definition: parseMcpServerDefinition(
          item.definition,
          `result.servers[${index}].definition`,
        ),
      };
    }),
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
