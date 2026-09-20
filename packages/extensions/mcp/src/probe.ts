// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import type { ModelPort } from "@axl/kernel";
import type { McpConfigProbeResult } from "@axl/protocol";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import { updateMcpCapabilityCache } from "./capabilities.ts";
import type { NamedMcpServerConfig } from "./config.ts";
import { McpManager } from "./manager.ts";
import type { McpManagerOptions } from "./types.ts";

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const MAX_PROBE_ERROR_BYTES = 2_000;

export class McpProbeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "McpProbeError";
  }
}

/** Raised inside a probe when the server asks the user to authorize in a browser. */
class McpProbeAuthorizationRequired extends Error {
  constructor() {
    super("MCP server requires browser authorization");
    this.name = "McpProbeAuthorizationRequired";
  }
}

function requiresAuthorization(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current instanceof McpProbeAuthorizationRequired) return true;
  }
  return false;
}

export interface McpProbeOptions {
  readonly server: NamedMcpServerConfig;
  readonly cwd: string;
  readonly stateDirectory: string;
  readonly blobDirectory: string;
  readonly wrapStdio: McpManagerOptions["wrapStdio"];
  readonly env?: McpManagerOptions["env"];
  readonly secretValues?: readonly string[];
  /** When set, a successful probe is recorded so the next session reload reuses it. */
  readonly cachePath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** A probe never samples the model. Any sampling request from the server fails loudly. */
const probeModel: ModelPort = {
  // biome-ignore lint/correctness/useYield: the generator exists only to fail loudly.
  async *stream() {
    throw new Error("Model sampling is unavailable while probing an MCP server");
  },
};

/**
 * Connects to one server definition, lists its tools, and disconnects. Nothing
 * is persisted to the configuration. Errors are redacted before they surface.
 * A probe has no user to show a login page to, so an OAuth request is reported
 * as `authorization: "required"` rather than completed.
 */
export async function probeMcpServer(options: McpProbeOptions): Promise<McpConfigProbeResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const manager = new McpManager({
    servers: [options.server],
    cwd: options.cwd,
    sessionId: `mcp-probe-${randomUUID()}`,
    stateDirectory: options.stateDirectory,
    blobDirectory: options.blobDirectory,
    model: probeModel,
    modelId: "mcp-probe",
    ...(options.secretValues === undefined ? {} : { secretValues: options.secretValues }),
    interact: (request) =>
      request.kind === "mcp_elicitation_url"
        ? Promise.reject(new McpProbeAuthorizationRequired())
        : Promise.resolve({ action: "decline" as const }),
    wrapStdio: options.wrapStdio,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  try {
    const discovery = await manager.discoverTools(options.server.name, signal);
    if (options.cachePath !== undefined) {
      await updateMcpCapabilityCache({
        cachePath: options.cachePath,
        server: options.server,
        discovery,
      });
    }
    return {
      protocolVersion: discovery.protocolVersion,
      tools: discovery.tools.map((tool) => ({ name: tool.name, description: tool.description })),
    };
  } catch (cause) {
    if (requiresAuthorization(cause)) {
      return { protocolVersion: LATEST_PROTOCOL_VERSION, tools: [], authorization: "required" };
    }
    const raw = timeout.aborted
      ? `MCP server ${options.server.name} did not respond within ${options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS} ms`
      : cause instanceof Error
        ? cause.message
        : String(cause);
    const message = manager.redactText(raw.replace(/\s+/g, " ").trim() || "unknown error");
    throw new McpProbeError(
      message.length <= MAX_PROBE_ERROR_BYTES
        ? message
        : `${message.slice(0, MAX_PROBE_ERROR_BYTES - 1)}…`,
      { cause },
    );
  } finally {
    await manager.dispose();
  }
}
