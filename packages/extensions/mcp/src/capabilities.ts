// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { type CapabilityService, ToolCapabilityService, type ToolRegistry } from "@axl/kernel";
import {
  CAPABILITY_LIMITS,
  type CapabilityActivationResult,
  type CapabilityRecord,
  type CapabilitySearchResult,
  type JsonObject,
} from "@axl/protocol";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

import { mcpConfigurationFingerprint, type NamedMcpServerConfig } from "./config.ts";
import type { McpManager } from "./manager.ts";
import type { McpToolBinding, McpToolDiscovery } from "./types.ts";

const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CACHE_BYTES = 10 * 1024 * 1024;
const MCP_AUTHORITY = "mcp.call";

interface CacheFile {
  readonly version: typeof CACHE_VERSION;
  readonly servers: readonly CacheServer[];
}

interface CacheServer {
  readonly fingerprint: string;
  readonly server: string;
  readonly discoveredAt: number;
  readonly protocolVersion: string;
  readonly tools: readonly CachedTool[];
}

interface CachedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly annotations?: JsonObject;
  readonly taskSupport?: "forbidden" | "optional" | "required";
}

export function mcpCanonicalToolName(server: string, tool: string): string {
  const identity = `${server}/${tool}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 10);
  const base = `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 53);
  return `${base}_${digest}`;
}

function aliases(name: string): readonly string[] {
  return [...new Set([name.replaceAll("-", "_"), name.replaceAll("_", "-")])].filter(
    (alias) => alias !== name,
  );
}

function records(bindings: readonly McpToolBinding[]): readonly CapabilityRecord[] {
  return bindings.map((binding) => ({
    identity: binding.identity,
    kind: "tool",
    name: binding.toolName,
    description: binding.description,
    aliases: [binding.serverName, ...aliases(binding.toolName)],
    path: binding.identity,
    scope: "global",
    provenance: `${binding.source}#${binding.serverName}`,
    enabled: true,
    trust: "trusted",
    available: true,
    requiredAuthority: [MCP_AUTHORITY],
  }));
}

export class McpCapabilityService implements CapabilityService {
  readonly records: readonly CapabilityRecord[];
  private readonly delegate: ToolCapabilityService;

  constructor(bindings: readonly McpToolBinding[], grantedAuthorities: ReadonlySet<string>) {
    this.records = records(bindings);
    this.delegate = new ToolCapabilityService(this.records, grantedAuthorities);
  }

  search(query: string, limit: number): Promise<CapabilitySearchResult> {
    return this.delegate.search(query, limit);
  }

  activate(identities: readonly string[]): Promise<CapabilityActivationResult> {
    return this.delegate.activate(identities);
  }

  read(identity: string, _path: string): Promise<string> {
    return this.delegate.read(identity);
  }
}

function validCache(value: unknown): CacheFile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Partial<CacheFile>;
  if (input.version !== CACHE_VERSION || !Array.isArray(input.servers)) return undefined;
  for (const server of input.servers) {
    if (
      typeof server !== "object" ||
      server === null ||
      typeof server.fingerprint !== "string" ||
      typeof server.server !== "string" ||
      typeof server.discoveredAt !== "number" ||
      typeof server.protocolVersion !== "string" ||
      !Array.isArray(server.tools)
    ) {
      return undefined;
    }
    for (const tool of server.tools) {
      if (
        typeof tool !== "object" ||
        tool === null ||
        typeof tool.name !== "string" ||
        typeof tool.description !== "string" ||
        typeof tool.inputSchema !== "object" ||
        tool.inputSchema === null ||
        Array.isArray(tool.inputSchema)
      ) {
        return undefined;
      }
    }
  }
  return input as CacheFile;
}

async function readCache(path: string): Promise<CacheFile | undefined> {
  try {
    if ((await stat(path)).size > MAX_CACHE_BYTES) return undefined;
    return validCache(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function writeCache(path: string, cache: CacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const content = `${JSON.stringify(cache, null, 2)}\n`;
    if (Buffer.byteLength(content) > MAX_CACHE_BYTES) {
      throw new Error(`MCP metadata cache exceeds ${MAX_CACHE_BYTES} bytes`);
    }
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function updateMcpCapabilityCache(input: {
  readonly cachePath: string;
  readonly server: NamedMcpServerConfig;
  readonly discovery: McpToolDiscovery;
  readonly discoveredAt?: number;
}): Promise<void> {
  const cached = await readCache(input.cachePath);
  const entry: CacheServer = {
    fingerprint: mcpConfigurationFingerprint(input.server.config),
    server: input.server.name,
    discoveredAt: input.discoveredAt ?? Date.now(),
    ...input.discovery,
  };
  await writeCache(input.cachePath, {
    version: CACHE_VERSION,
    servers: [
      ...(cached?.servers.filter((server) => server.server !== input.server.name) ?? []),
      entry,
    ].sort((left, right) => left.server.localeCompare(right.server)),
  });
}

function binding(
  server: NamedMcpServerConfig,
  fingerprint: string,
  tool: CachedTool,
): McpToolBinding {
  const identity = `mcp:${server.name}/${tool.name}`;
  const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
  if (bytes(identity) > CAPABILITY_LIMITS.identityBytes) {
    throw new Error(`MCP capability identity is too long: ${identity}`);
  }
  if (bytes(tool.name) > CAPABILITY_LIMITS.nameBytes) {
    throw new Error(`MCP tool name is too long: ${server.name}/${tool.name}`);
  }
  if (bytes(tool.description) > CAPABILITY_LIMITS.descriptionBytes) {
    throw new Error(`MCP tool description is too long: ${server.name}/${tool.name}`);
  }
  return {
    identity,
    canonicalName: mcpCanonicalToolName(server.name, tool.name),
    serverName: server.name,
    toolName: tool.name,
    description: tool.description || tool.name,
    inputSchema: tool.inputSchema,
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    ...(tool.taskSupport === undefined ? {} : { taskSupport: tool.taskSupport }),
    configurationFingerprint: fingerprint,
    source: server.source,
  };
}

export async function loadMcpCapabilities(input: {
  readonly servers: readonly NamedMcpServerConfig[];
  readonly manager: McpManager;
  readonly tools: ToolRegistry;
  readonly cachePath: string;
  readonly now?: number;
}): Promise<{ readonly service: McpCapabilityService; readonly authority: string }> {
  const now = input.now ?? Date.now();
  const cached = await readCache(input.cachePath);
  const next: CacheServer[] = [];
  const bindings: McpToolBinding[] = [];
  for (const server of input.servers) {
    const fingerprint = mcpConfigurationFingerprint(server.config);
    const hit = cached?.servers.find(
      (entry) =>
        entry.server === server.name &&
        entry.fingerprint === fingerprint &&
        SUPPORTED_PROTOCOL_VERSIONS.includes(entry.protocolVersion) &&
        entry.discoveredAt <= now &&
        now - entry.discoveredAt <= CACHE_MAX_AGE_MS,
    );
    let metadata: CacheServer;
    if (hit !== undefined) metadata = hit;
    else {
      try {
        const discovered = await input.manager.discoverTools(server.name);
        metadata = { fingerprint, server: server.name, discoveredAt: now, ...discovered };
      } catch (cause) {
        throw new Error(`Cannot index MCP server ${server.name}: ${String(cause)}`, { cause });
      }
    }
    next.push(metadata);
    for (const tool of metadata.tools) {
      const frozen = binding(server, fingerprint, tool);
      bindings.push(frozen);
      input.tools.registerCapability(frozen.identity, input.manager.makeDirectTool(frozen));
    }
  }
  await writeCache(input.cachePath, { version: CACHE_VERSION, servers: next });
  const authorities = new Set([MCP_AUTHORITY]);
  return { service: new McpCapabilityService(bindings, authorities), authority: MCP_AUTHORITY };
}
