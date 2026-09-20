// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  MCP_CONFIG_LIMITS,
  type McpConfigListResult,
  type McpConfigMutationResult,
  type McpServerDefinition,
  type McpServerEntry,
  parseMcpServerDefinition,
  parseMcpServerName,
} from "@axl/protocol";

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_CONFIG_BYTES = 1024 * 1024;

export interface McpStdioServerConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Child variable to a parent variable name or a `${VAR}` template. */
  readonly env: Readonly<Record<string, string>>;
  readonly roots: readonly string[];
  readonly enabled: boolean;
  readonly requestTimeoutMs: number;
}

export interface McpHttpOAuthConfig {
  readonly clientId?: string;
  readonly clientSecretEnv?: string;
  readonly scope?: string;
}

export interface McpHttpServerConfig {
  readonly transport: "http";
  readonly url: string;
  /** HTTP header to a parent variable name or a `${VAR}` template such as `Bearer ${TOKEN}`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly oauth?: McpHttpOAuthConfig;
  readonly roots: readonly string[];
  readonly enabled: boolean;
  readonly requestTimeoutMs: number;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function mcpConfigurationFingerprint(config: McpServerConfig): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

/** Fingerprint of the definition as written, independent of the resolving working directory. */
export function mcpDefinitionFingerprint(definition: McpServerDefinition): string {
  return createHash("sha256").update(canonicalJson(definition)).digest("hex");
}

export interface NamedMcpServerConfig {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly source: string;
  /** The validated definition exactly as configured. */
  readonly definition: McpServerDefinition;
}

/** Discovery state recorded by sessions and projected to clients through the config store. */
export interface McpDiscoveryStateReader {
  read(): Promise<{
    readonly discovered: readonly {
      readonly server: string;
      readonly definitionFingerprint: string;
      readonly discoveredAt: number;
      readonly tools: readonly { readonly name: string; readonly description: string }[];
    }[];
    readonly failed: readonly {
      readonly server: string;
      readonly definitionFingerprint: string;
      readonly error: string;
    }[];
  }>;
}

export interface LoadMcpConfigOptions {
  readonly cwd: string;
  readonly globalDirectory?: string;
}

export class McpConfigError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "McpConfigError";
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new McpConfigError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new McpConfigError(`${path}.${key}`, "is not allowed");
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new McpConfigError(path, "must be a non-empty string");
  }
  return value;
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new McpConfigError(path, "must be an array of strings");
  }
  return value;
}

function stringMap(value: unknown, path: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  const source = object(value, path);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) result[key] = string(item, `${path}.${key}`);
  return result;
}

/** Bare references must be conventional UPPER_CASE names so a pasted token is never mistaken for one. */
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/;
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Names of the environment variables a header or env value reads from. A bare
 * name means "the whole value comes from this variable"; otherwise the value is
 * literal text with `${VAR}` placeholders. Literal text without a placeholder is
 * rejected so secrets can never be written into the configuration file.
 */
export function mcpSecretReferences(value: string): readonly string[] {
  if (ENVIRONMENT_NAME.test(value)) return [value];
  return [...value.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
}

/** Resolves a header or env value from the environment. Throws when a referenced variable is unset. */
export function resolveMcpSecretValue(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  describe: () => string,
): string {
  if (ENVIRONMENT_NAME.test(value)) {
    const resolved = env[value];
    if (resolved === undefined) throw new Error(`${describe()}: ${value} is not set`);
    return resolved;
  }
  return value.replace(PLACEHOLDER, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) throw new Error(`${describe()}: ${name} is not set`);
    return resolved;
  });
}

function secretMap(value: unknown, path: string): Readonly<Record<string, string>> {
  const map = stringMap(value, path);
  for (const [key, item] of Object.entries(map)) {
    if (mcpSecretReferences(item).length === 0) {
      throw new McpConfigError(
        `${path}.${key}`,
        "must be an UPPER_CASE environment variable name (TOKEN) or use ${VAR} placeholders (Bearer ${TOKEN}); literal values are never stored",
      );
    }
  }
  return map;
}

function timeout(value: unknown, path: string): number {
  if (value === undefined) return 60_000;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new McpConfigError(path, "must be a positive safe integer");
  }
  return value as number;
}

function enabled(value: unknown, path: string): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new McpConfigError(path, "must be a boolean");
  return value;
}

function httpUrl(value: unknown, path: string): URL {
  let url: URL;
  try {
    url = new URL(string(value, path));
  } catch {
    throw new McpConfigError(path, "must be a valid URL");
  }
  return url;
}

function oauth(value: unknown, path: string): McpHttpOAuthConfig {
  const input = object(value, path);
  exact(input, path, ["clientId", "clientSecretEnv", "scope"]);
  return {
    ...(input.clientId === undefined
      ? {}
      : { clientId: string(input.clientId, `${path}.clientId`) }),
    ...(input.clientSecretEnv === undefined
      ? {}
      : { clientSecretEnv: string(input.clientSecretEnv, `${path}.clientSecretEnv`) }),
    ...(input.scope === undefined ? {} : { scope: string(input.scope, `${path}.scope`) }),
  };
}

function serverConfig(value: unknown, path: string, cwd: string): McpServerConfig {
  const input = object(value, path);
  const hasUrl = input.url !== undefined;
  const hasCommand = input.command !== undefined;
  if (hasUrl === hasCommand) {
    throw new McpConfigError(path, "must contain exactly one of url or command");
  }
  const transport = hasUrl ? "http" : "stdio";
  if (transport === "stdio") {
    exact(input, path, ["command", "args", "cwd", "env", "roots", "enabled", "requestTimeoutMs"]);
    const configuredCwd = input.cwd === undefined ? undefined : string(input.cwd, `${path}.cwd`);
    return {
      transport,
      command: string(input.command, `${path}.command`),
      args: stringArray(input.args, `${path}.args`),
      ...(configuredCwd === undefined
        ? {}
        : { cwd: isAbsolute(configuredCwd) ? configuredCwd : resolve(cwd, configuredCwd) }),
      env: secretMap(input.env, `${path}.env`),
      roots: stringArray(input.roots, `${path}.roots`).map((root) =>
        isAbsolute(root) ? resolve(root) : resolve(cwd, root),
      ),
      enabled: enabled(input.enabled, `${path}.enabled`),
      requestTimeoutMs: timeout(input.requestTimeoutMs, `${path}.requestTimeoutMs`),
    };
  }
  {
    exact(input, path, ["url", "headers", "oauth", "roots", "enabled", "requestTimeoutMs"]);
    const url = httpUrl(input.url, `${path}.url`);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    ) {
      throw new McpConfigError(
        `${path}.url`,
        "must use HTTPS, except for loopback development servers",
      );
    }
    if (url.username || url.password || url.hash) {
      throw new McpConfigError(`${path}.url`, "must not contain credentials or a fragment");
    }
    return {
      transport: "http",
      url: url.href,
      headers: secretMap(input.headers, `${path}.headers`),
      ...(input.oauth === undefined ? {} : { oauth: oauth(input.oauth, `${path}.oauth`) }),
      roots: stringArray(input.roots, `${path}.roots`).map((root) =>
        isAbsolute(root) ? resolve(root) : resolve(cwd, root),
      ),
      enabled: enabled(input.enabled, `${path}.enabled`),
      requestTimeoutMs: timeout(input.requestTimeoutMs, `${path}.requestTimeoutMs`),
    };
  }
}

async function readConfig(path: string, cwd: string): Promise<NamedMcpServerConfig[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new McpConfigError(path, `invalid JSON: ${String(cause)}`);
  }
  const root = object(parsed, path);
  exact(root, path, ["mcpServers"]);
  const servers = object(root.mcpServers, `${path}.mcpServers`);
  const result: NamedMcpServerConfig[] = [];
  for (const [name, value] of Object.entries(servers)) {
    if (!SERVER_NAME.test(name)) {
      throw new McpConfigError(`${path}.mcpServers.${name}`, "server name is invalid");
    }
    const config = serverConfig(value, `${path}.mcpServers.${name}`, cwd);
    const definition = parseMcpServerDefinition(value, `${path}.mcpServers.${name}`);
    result.push({ name, config, source: path, definition });
  }
  return result;
}

export function mcpSecretValues(
  servers: readonly NamedMcpServerConfig[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const names = new Set<string>();
  for (const server of servers) {
    const values =
      server.config.transport === "stdio"
        ? Object.values(server.config.env)
        : Object.values(server.config.headers);
    for (const value of values) for (const name of mcpSecretReferences(value)) names.add(name);
    if (server.config.transport === "http" && server.config.oauth?.clientSecretEnv) {
      names.add(server.config.oauth.clientSecretEnv);
    }
  }
  return [...new Set([...names].flatMap((name) => (env[name] ? [env[name] as string] : [])))];
}

function definitions(value: unknown, path: string): Record<string, McpServerDefinition> {
  const root = object(value, path);
  exact(root, path, ["mcpServers"]);
  const servers = object(root.mcpServers, `${path}.mcpServers`);
  if (Object.keys(servers).length > 256) throw new McpConfigError(path, "has too many servers");
  return Object.fromEntries(
    Object.entries(servers).map(([name, value]) => {
      parseMcpServerName(name, `${path}.mcpServers.${name}`);
      return [name, parseMcpServerDefinition(value, `${path}.mcpServers.${name}`)];
    }),
  );
}

async function readDefinitions(
  path: string,
  cwd: string,
): Promise<Record<string, McpServerDefinition>> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new McpConfigError(path, "must be a regular file, not a symlink");
    }
    if (stats.size > MAX_CONFIG_BYTES) {
      throw new McpConfigError(path, `must not exceed ${MAX_CONFIG_BYTES} bytes`);
    }
    const configured = definitions(JSON.parse(await readFile(path, "utf8")) as unknown, path);
    for (const [name, definition] of Object.entries(configured)) {
      serverConfig(definition, `${path}.mcpServers.${name}`, cwd);
    }
    return configured;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError)
      throw new McpConfigError(path, `invalid JSON: ${error.message}`);
    throw error;
  }
}

/** Validates one definition the way the session loader does and resolves it against `cwd`. */
export function resolveMcpServerConfig(
  name: string,
  definition: McpServerDefinition,
  cwd: string,
  source = "probe",
): NamedMcpServerConfig {
  parseMcpServerName(name, "name");
  const parsed = parseMcpServerDefinition(definition, "definition");
  return {
    name,
    config: serverConfig(parsed, `mcpServers.${name}`, cwd),
    source,
    definition: parsed,
  };
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/** Owns validated user MCP configuration outside model command sandboxes. */
export class McpConfigStore {
  readonly path: string;
  private readonly cwd: string;
  private readonly discovery: McpDiscoveryStateReader | undefined;
  private pending = Promise.resolve();

  constructor(globalDirectory: string, cwd: string, discovery?: McpDiscoveryStateReader) {
    this.path = join(globalDirectory, "mcp.json");
    this.cwd = cwd;
    this.discovery = discovery;
  }

  async list(): Promise<McpConfigListResult> {
    const configured = await readDefinitions(this.path, this.cwd);
    const state = (await this.discovery?.read()) ?? { discovered: [], failed: [] };
    return {
      path: this.path,
      servers: Object.entries(configured)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, definition]): McpServerEntry => {
          if (definition.enabled === false)
            return { name, definition, status: "disabled", tools: [] };
          const fingerprint = mcpDefinitionFingerprint(definition);
          const discovered = state.discovered.find(
            (entry) => entry.server === name && entry.definitionFingerprint === fingerprint,
          );
          if (discovered !== undefined) {
            return {
              name,
              definition,
              status: "discovered",
              discoveredAt: discovered.discoveredAt,
              tools: discovered.tools.map((tool) => ({
                name: tool.name,
                description: truncate(tool.description, MCP_CONFIG_LIMITS.toolDescription),
              })),
            };
          }
          const failed = state.failed.find(
            (entry) => entry.server === name && entry.definitionFingerprint === fingerprint,
          );
          if (failed !== undefined) {
            return {
              name,
              definition,
              status: "failed",
              tools: [],
              error: truncate(failed.error, MCP_CONFIG_LIMITS.error),
            };
          }
          return { name, definition, status: "pending", tools: [] };
        }),
    };
  }

  upsert(name: string, definition: McpServerDefinition): Promise<McpConfigMutationResult> {
    return this.mutate(async (configured) => {
      parseMcpServerName(name, "name");
      const parsed = parseMcpServerDefinition(definition, "definition");
      serverConfig(parsed, `mcpServers.${name}`, this.cwd);
      const changed = JSON.stringify(configured[name]) !== JSON.stringify(parsed);
      configured[name] = parsed;
      return changed;
    });
  }

  remove(name: string): Promise<McpConfigMutationResult> {
    return this.mutate(async (configured) => {
      parseMcpServerName(name, "name");
      if (!(name in configured)) return false;
      delete configured[name];
      return true;
    });
  }

  private mutate(
    update: (configured: Record<string, McpServerDefinition>) => Promise<boolean>,
  ): Promise<McpConfigMutationResult> {
    const operation = this.pending.then(async () => {
      const configured = await readDefinitions(this.path, this.cwd);
      const changed = await update(configured);
      if (changed) await this.write(configured);
      return { ...(await this.list()), changed };
    });
    this.pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async write(configured: Record<string, McpServerDefinition>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify({ mcpServers: configured }, null, 2)}\n`;
    if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) {
      throw new McpConfigError(this.path, `must not exceed ${MAX_CONFIG_BYTES} bytes`);
    }
    try {
      await writeFile(temporary, content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

/** Loads only the user-owned global MCP configuration. */
export async function loadMcpConfig(
  options: LoadMcpConfigOptions,
): Promise<readonly NamedMcpServerConfig[]> {
  if (options.globalDirectory === undefined) return [];
  return (await readConfig(join(options.globalDirectory, "mcp.json"), options.cwd))
    .filter((server) => server.config.enabled)
    .sort((left, right) => left.name.localeCompare(right.name));
}
