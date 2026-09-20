// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import type { ModelPort } from "@axl/kernel";
import type { InteractionKind, JsonObject } from "@axl/protocol";

import type { NamedMcpServerConfig } from "./config.ts";

export interface McpInteractionRequest {
  readonly kind: InteractionKind;
  readonly source: string;
  readonly message: string;
  readonly data?: JsonObject;
}

export interface McpInteractionResponse {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: JsonObject;
}

export interface WrappedMcpProcess {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Idempotent process-backend cleanup and termination verification. */
  readonly cleanup?: () => Promise<void>;
}

export interface McpToolBinding {
  readonly identity: string;
  readonly canonicalName: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly annotations?: JsonObject;
  readonly taskSupport?: "forbidden" | "optional" | "required";
  readonly configurationFingerprint: string;
  readonly source: string;
}

export interface McpToolDiscovery {
  readonly protocolVersion: string;
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonObject;
    readonly annotations?: JsonObject;
    readonly taskSupport?: "forbidden" | "optional" | "required";
  }[];
}

export interface McpManagerOptions {
  readonly servers: readonly NamedMcpServerConfig[];
  readonly cwd: string;
  readonly sessionId: string;
  readonly stateDirectory: string;
  readonly blobDirectory: string;
  readonly model: ModelPort;
  readonly modelId: string;
  readonly secretValues?: readonly string[];
  readonly onSecrets?: (values: readonly string[]) => void;
  readonly onToolListChanged?: (
    server: NamedMcpServerConfig,
    discovery: McpToolDiscovery,
  ) => void | Promise<void>;
  readonly interact: (
    request: McpInteractionRequest,
    signal?: AbortSignal,
  ) => Promise<McpInteractionResponse>;
  readonly wrapStdio: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  }) => WrappedMcpProcess;
  readonly env?: Readonly<Record<string, string | undefined>>;
}
