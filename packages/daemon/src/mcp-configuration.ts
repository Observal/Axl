// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import type {
  McpConfigListResult,
  McpConfigMutationResult,
  McpConfigProbeParams,
  McpConfigProbeResult,
  McpConfigRemoveParams,
  McpConfigUpsertParams,
} from "@axl/protocol";

import { DaemonError } from "./session-manager.ts";

export interface McpConfigurationService {
  list(): Promise<McpConfigListResult>;
  upsert(params: McpConfigUpsertParams): Promise<McpConfigMutationResult>;
  remove(params: McpConfigRemoveParams): Promise<McpConfigMutationResult>;
  /** Connects to a definition and lists its tools without persisting anything. */
  probe(params: McpConfigProbeParams, signal?: AbortSignal): Promise<McpConfigProbeResult>;
}

/** A probe that reached the transport but could not complete discovery. */
export class McpProbeFailedError extends DaemonError {
  declare readonly code: "mcp_probe_failed";

  constructor(server: string, message: string, options?: { cause?: unknown }) {
    super("mcp_probe_failed", message, { ...options, details: { server } });
    this.name = "McpProbeFailedError";
    this.code = "mcp_probe_failed";
  }
}
