// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { EventId, JsonObject, OperationId, SessionId } from "./event-envelope.ts";
import {
  ProtocolValidationError,
  parseEventId,
  parseOperationId,
  parseSessionId,
} from "./event-envelope.ts";
import type {
  AssistantStopReason,
  BlobReference,
  CanonicalEvent,
  InteractionAction,
  ThinkingLevel,
  UserContent,
} from "./events.ts";
import { parseBlobReference, parseEvent, parseUserContent } from "./events.ts";

export const MAX_HISTORY_PAGE_EVENTS = 5_000;

export interface SessionModelSelection {
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
}

export interface SessionSummary {
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly userMessageCount: number;
  readonly firstUserMessage?: string;
  readonly lastUserMessage?: string;
  readonly parentSessionId?: SessionId;
}

export interface TransientToolCall {
  readonly callId: string;
  readonly name: string;
}

/** Sequenced, non-durable model output for one active operation. */
export type SessionActivityFrame =
  | {
      readonly operationId: OperationId;
      readonly sequence: number;
      readonly type: "text_delta" | "thinking_delta";
      readonly text: string;
    }
  | {
      readonly operationId: OperationId;
      readonly sequence: number;
      readonly type: "tool_call";
      readonly call: TransientToolCall;
    }
  | {
      readonly operationId: OperationId;
      readonly sequence: number;
      readonly type: "snapshot";
      readonly text: string;
      readonly thinking: string;
      readonly toolCalls: readonly TransientToolCall[];
    }
  | {
      readonly operationId: OperationId;
      readonly sequence: number;
      readonly type: "clear";
    };

export interface BlobReadResult {
  readonly data: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly eof: boolean;
}

export function parseBlobReadResult(value: unknown): BlobReadResult {
  const result = object(value, "blobRead");
  exact(result, "blobRead", ["data", "offset", "nextOffset", "eof"]);
  if (typeof result.eof !== "boolean") {
    throw new ProtocolValidationError("blobRead.eof", "must be a boolean");
  }
  return {
    data: boundedText(result.data, "blobRead.data", 700_000),
    offset: nonNegativeInteger(result.offset, "blobRead.offset"),
    nextOffset: nonNegativeInteger(result.nextOffset, "blobRead.nextOffset"),
    eof: result.eof,
  };
}

export type WorkspaceDiffScope = "working" | "last-turn";

export interface WorkspaceFileDiff {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
  readonly truncated: boolean;
}

export interface WorkspaceDiff {
  readonly scope: WorkspaceDiffScope;
  readonly checkpointId?: string;
  readonly files: readonly WorkspaceFileDiff[];
}

export function parseWorkspaceDiff(value: unknown): WorkspaceDiff {
  const diff = object(value, "workspaceDiff");
  exact(diff, "workspaceDiff", ["scope", "checkpointId", "files"]);
  if (diff.scope !== "working" && diff.scope !== "last-turn") {
    throw new ProtocolValidationError("workspaceDiff.scope", "must be working or last-turn");
  }
  if (diff.checkpointId !== undefined) string(diff.checkpointId, "workspaceDiff.checkpointId");
  if (!Array.isArray(diff.files) || diff.files.length > 500) {
    throw new ProtocolValidationError("workspaceDiff.files", "must contain at most 500 files");
  }
  const files = diff.files.map((value, index): WorkspaceFileDiff => {
    const path = `workspaceDiff.files[${index}]`;
    const file = object(value, path);
    exact(file, path, ["path", "status", "additions", "deletions", "patch", "truncated"]);
    if (file.status !== "added" && file.status !== "modified" && file.status !== "deleted") {
      throw new ProtocolValidationError(`${path}.status`, "must be added, modified, or deleted");
    }
    for (const field of ["additions", "deletions"] as const) {
      if (!Number.isSafeInteger(file[field]) || (file[field] as number) < 0) {
        throw new ProtocolValidationError(`${path}.${field}`, "must be a non-negative integer");
      }
    }
    if (typeof file.patch !== "string") {
      throw new ProtocolValidationError(`${path}.patch`, "must be a string");
    }
    if (typeof file.truncated !== "boolean") {
      throw new ProtocolValidationError(`${path}.truncated`, "must be a boolean");
    }
    return {
      path: string(file.path, `${path}.path`),
      status: file.status,
      additions: file.additions as number,
      deletions: file.deletions as number,
      patch: file.patch,
      truncated: file.truncated,
    };
  });
  return {
    scope: diff.scope,
    ...(diff.checkpointId === undefined ? {} : { checkpointId: diff.checkpointId as string }),
    files,
  };
}

export type CapabilityId = string;
export type ClientKind = string;

export const WIRE_CAPABILITIES = [
  "session.create",
  "session.list",
  "session.resume",
  "session.fork",
  "session.clone",
  "session.send.prompt",
  "session.shell",
  "session.interrupt",
  "session.reload",
  "session.configure",
  "session.interaction.respond",
  "session.dispose",
  "session.subscribe",
  "session.activity",
  "session.blob.start",
  "session.blob.chunk",
  "session.blob.commit",
  "session.blob.abort",
  "session.blob.read",
  "session.workspace.diff",
  "session.workspace.checkpoint",
] as const satisfies readonly CapabilityId[];

export interface ClientIdentity {
  readonly kind: ClientKind;
  readonly version: string;
  readonly instanceId: string;
}

export interface ConnectionInitializeParams {
  readonly client: ClientIdentity;
  readonly requestedCapabilities: readonly CapabilityId[];
}

export interface ConnectionInitializeResult {
  readonly attachmentId: string;
  readonly daemonInstanceId: string;
  readonly wireVersion: number;
  readonly grantedCapabilities: readonly CapabilityId[];
  readonly scope: "local_control";
  readonly heartbeatIntervalMs: number;
  readonly presenceTimeoutMs: number;
}

export interface DaemonInfoResult {
  readonly securityMode: "sandboxed" | "unsafe";
  readonly sandboxProvider: string;
  readonly sandboxImage?: string;
}

export interface RpcMethodMap {
  readonly "daemon.info": {
    readonly params: Record<string, never>;
    readonly result: DaemonInfoResult;
  };
  readonly "connection.initialize": {
    readonly params: ConnectionInitializeParams;
    readonly result: ConnectionInitializeResult;
  };
  readonly "connection.ping": {
    readonly params: Record<string, never>;
    readonly result: Record<string, never>;
  };
  readonly "session.create": {
    readonly params: { readonly cwd: string } & SessionModelSelection;
    readonly result: SessionSnapshot;
  };
  readonly "session.resume": {
    readonly params: { readonly sessionId: SessionId; readonly includeEvents?: boolean };
    readonly result: SessionSnapshot;
  };
  readonly "session.list": {
    readonly params: Record<string, never>;
    readonly result: readonly SessionSummary[];
  };
  readonly "session.history": {
    readonly params: {
      readonly sessionId: SessionId;
      readonly afterEventId?: EventId;
      readonly limit?: number;
    };
    readonly result: SessionHistoryPage;
  };
  readonly "session.fork": {
    readonly params: { readonly sessionId: SessionId; readonly fromEventId: EventId };
    readonly result: SessionForkResult;
  };
  readonly "session.clone": {
    readonly params: { readonly sessionId: SessionId };
    readonly result: SessionForkResult;
  };
  readonly "session.send": {
    readonly params: { readonly sessionId: SessionId; readonly content: readonly UserContent[] };
    readonly result: { readonly stopReason: AssistantStopReason };
  };
  readonly "session.shell": {
    readonly params: {
      readonly sessionId: SessionId;
      readonly command: string;
      readonly excluded: boolean;
    };
    readonly result: { readonly isError: boolean };
  };
  readonly "session.interrupt": {
    readonly params: { readonly sessionId: SessionId };
    readonly result: { readonly interrupted: boolean };
  };
  readonly "session.reload": {
    readonly params: { readonly sessionId: SessionId };
    readonly result: { readonly events: readonly CanonicalEvent[] };
  };
  readonly "session.configure": {
    readonly params: { readonly sessionId: SessionId } & SessionModelSelection;
    readonly result: { readonly events: readonly CanonicalEvent[] };
  };
  readonly "session.interaction.respond": {
    readonly params: {
      readonly sessionId: SessionId;
      readonly interactionId: string;
      readonly action: InteractionAction;
      readonly content?: JsonObject;
    };
    readonly result: { readonly resolved: true };
  };
  readonly "session.subscribe": {
    readonly params: { readonly sessionId: SessionId; readonly afterEventId?: EventId };
    readonly result: {
      readonly snapshot: readonly CanonicalEvent[];
      readonly activity?: SessionActivityFrame;
    };
  };
  readonly "session.workspace.diff": {
    readonly params: { readonly sessionId: SessionId; readonly scope: WorkspaceDiffScope };
    readonly result: WorkspaceDiff;
  };
  readonly "session.workspace.checkpoint": {
    readonly params: { readonly sessionId: SessionId; readonly enabled: boolean };
    readonly result: { readonly enabled: boolean };
  };
  readonly "session.blob.start": {
    readonly params: {
      readonly sessionId: SessionId;
      readonly mediaType: string;
      readonly sizeBytes: number;
      readonly name?: string;
    };
    readonly result: { readonly uploadId: string; readonly chunkBytes: number };
  };
  readonly "session.blob.chunk": {
    readonly params: {
      readonly sessionId: SessionId;
      readonly uploadId: string;
      readonly offset: number;
      readonly data: string;
    };
    readonly result: { readonly nextOffset: number };
  };
  readonly "session.blob.commit": {
    readonly params: { readonly sessionId: SessionId; readonly uploadId: string };
    readonly result: BlobReference;
  };
  readonly "session.blob.abort": {
    readonly params: { readonly sessionId: SessionId; readonly uploadId: string };
    readonly result: { readonly aborted: boolean };
  };
  readonly "session.blob.read": {
    readonly params: {
      readonly sessionId: SessionId;
      readonly sha256: string;
      readonly offset: number;
      readonly length: number;
    };
    readonly result: BlobReadResult;
  };
  readonly "session.dispose": {
    readonly params: { readonly sessionId: SessionId };
    readonly result: { readonly disposed: boolean };
  };
}

export type RpcMethod = keyof RpcMethodMap;
export type RpcParams<Method extends RpcMethod> = RpcMethodMap[Method]["params"];

export function requiredCapability(method: RpcMethod): CapabilityId | undefined {
  if (
    method === "daemon.info" ||
    method === "connection.initialize" ||
    method === "connection.ping" ||
    method === "session.history"
  ) {
    return undefined;
  }
  if (method === "session.send") return "session.send.prompt";
  return method;
}
export type RpcResult<Method extends RpcMethod> = RpcMethodMap[Method]["result"];

export type RpcRequest = {
  [Method in RpcMethod]: {
    readonly kind: "request";
    readonly id: number;
    readonly method: Method;
    readonly params: RpcParams<Method>;
  };
}[RpcMethod];

export type RpcSuccess = {
  [Method in RpcMethod]: {
    readonly kind: "success";
    readonly id: number;
    readonly method: Method;
    readonly result: RpcResult<Method>;
  };
}[RpcMethod];

export const RPC_ERROR_CODES = [
  "bad_request",
  "unsupported_version",
  "unsupported_capability",
  "connection_not_initialized",
  "connection_already_initialized",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "frame_too_large",
  "request_timeout",
  "cancelled",
  "internal_error",
  "invalid_idempotency_key",
  "idempotency_conflict",
  "unknown_session",
  "corrupt_session",
  "event_migration_required",
  "operation_active",
  "invalid_fork_point",
  "unknown_interaction",
  "interaction_already_resolved",
  "unknown_subscription",
  "unknown_cursor",
  "cursor_expired",
  "snapshot_required",
  "workspace_unavailable",
  "workspace_changed",
  "invalid_path",
  "path_denied",
  "symlink_escape",
  "not_found",
  "not_a_file",
  "unsupported_file_type",
  "unsupported_filename_encoding",
  "binary_file",
  "invalid_encoding",
  "content_too_large",
  "not_git_repository",
  "git_unavailable",
  "git_timeout",
  "git_output_too_large",
  "unsupported_git_state",
  "repository_changed",
] as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number] | (string & {});

export interface RpcError {
  readonly kind: "error";
  readonly id: number;
  readonly method?: RpcMethod;
  readonly error: {
    readonly code: RpcErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: JsonObject;
  };
}

export interface WireEvent {
  readonly kind: "event";
  readonly sessionId: SessionId;
  readonly event: CanonicalEvent;
}

export interface WireActivity {
  readonly kind: "activity";
  readonly sessionId: SessionId;
  readonly frame: SessionActivityFrame;
}

export interface WireHello {
  readonly kind: "hello";
  readonly wireVersion: number;
  readonly daemonInstanceId: string;
  readonly capabilities: readonly CapabilityId[];
  readonly limits: {
    readonly maxMessageBytes: number;
    readonly maxPendingRequests: number;
  };
}

export type WireRequest = RpcRequest;
export type WireMethod = RpcMethod;
export type WireResponse = RpcSuccess;
export type WireError = RpcError;
export type ServerMessage = RpcSuccess | RpcError | WireEvent | WireActivity | WireHello;

export interface SessionSnapshot {
  readonly sessionId: SessionId;
  readonly events: readonly CanonicalEvent[];
}

export interface SessionForkResult extends SessionSnapshot {
  readonly selectedText?: string;
}

export interface SessionHistoryPage {
  readonly events: readonly CanonicalEvent[];
  readonly done: boolean;
}

export function parseSessionHistoryPage(
  value: unknown,
  expectedSessionId?: unknown,
): SessionHistoryPage {
  const page = object(value, "sessionHistoryPage");
  exact(page, "sessionHistoryPage", ["events", "done"]);
  if (!Array.isArray(page.events) || page.events.length > MAX_HISTORY_PAGE_EVENTS) {
    throw new ProtocolValidationError(
      "sessionHistoryPage.events",
      `must contain at most ${MAX_HISTORY_PAGE_EVENTS} events`,
    );
  }
  if (typeof page.done !== "boolean") {
    throw new ProtocolValidationError("sessionHistoryPage.done", "must be a boolean");
  }
  const sessionId =
    expectedSessionId === undefined
      ? undefined
      : parseSessionId(expectedSessionId, "sessionHistoryPage.sessionId");
  const events = page.events.map((event, index) => {
    const parsed = parseEvent(event);
    if (sessionId !== undefined && parsed.sessionId !== sessionId) {
      throw new ProtocolValidationError(
        `sessionHistoryPage.events[${index}].sessionId`,
        `must match session ${sessionId}`,
      );
    }
    return parsed;
  });
  if (!page.done && events.length === 0) {
    throw new ProtocolValidationError(
      "sessionHistoryPage.events",
      "must make progress when more history remains",
    );
  }
  return { events, done: page.done };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, path: string, keys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new ProtocolValidationError(`${path}.${key}`, "is not allowed");
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolValidationError(path, "must be a non-empty string");
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolValidationError(path, "must be a non-negative safe integer");
  }
  return value as number;
}

function boundedString(value: unknown, path: string, maximum: number): string {
  const result = string(value, path);
  if (new TextEncoder().encode(result).byteLength > maximum) {
    throw new ProtocolValidationError(path, `must not exceed ${maximum} UTF-8 bytes`);
  }
  return result;
}

function boundedText(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string") throw new ProtocolValidationError(path, "must be a string");
  if (new TextEncoder().encode(value).byteLength > maximum) {
    throw new ProtocolValidationError(path, `must not exceed ${maximum} UTF-8 bytes`);
  }
  return value;
}

function stringArray(value: unknown, path: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ProtocolValidationError(path, `must contain at most ${maximum} strings`);
  }
  const result = value.map((item, index) => boundedString(item, `${path}[${index}]`, 128));
  if (new Set(result).size !== result.length) {
    throw new ProtocolValidationError(path, "must not contain duplicates");
  }
  return result;
}

function capabilityArray(value: unknown, path: string): readonly CapabilityId[] {
  const capabilities = stringArray(value, path, 128);
  for (const [index, capability] of capabilities.entries()) {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(capability)) {
      throw new ProtocolValidationError(`${path}[${index}]`, "must be a protocol identifier");
    }
  }
  return capabilities;
}

function sha256(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^[0-9a-f]{64}$/.test(result)) {
    throw new ProtocolValidationError(path, "must be a lowercase SHA-256 digest");
  }
  return result;
}

function parseTransientToolCall(value: unknown, path: string): TransientToolCall {
  const call = object(value, path);
  exact(call, path, ["callId", "name"]);
  return {
    callId: boundedString(call.callId, `${path}.callId`, 256),
    name: boundedString(call.name, `${path}.name`, 256),
  };
}

export function parseSessionActivityFrame(value: unknown): SessionActivityFrame {
  const frame = object(value, "activity.frame");
  const operationId = parseOperationId(frame.operationId, "activity.frame.operationId");
  const sequence = nonNegativeInteger(frame.sequence, "activity.frame.sequence");
  if (frame.type === "text_delta" || frame.type === "thinking_delta") {
    exact(frame, "activity.frame", ["operationId", "sequence", "type", "text"]);
    return {
      operationId,
      sequence,
      type: frame.type,
      text: boundedText(frame.text, "activity.frame.text", 262_144),
    };
  }
  if (frame.type === "tool_call") {
    exact(frame, "activity.frame", ["operationId", "sequence", "type", "call"]);
    return {
      operationId,
      sequence,
      type: frame.type,
      call: parseTransientToolCall(frame.call, "activity.frame.call"),
    };
  }
  if (frame.type === "snapshot") {
    exact(frame, "activity.frame", [
      "operationId",
      "sequence",
      "type",
      "text",
      "thinking",
      "toolCalls",
    ]);
    if (!Array.isArray(frame.toolCalls) || frame.toolCalls.length > 64) {
      throw new ProtocolValidationError(
        "activity.frame.toolCalls",
        "must contain at most 64 calls",
      );
    }
    return {
      operationId,
      sequence,
      type: frame.type,
      text: boundedText(frame.text, "activity.frame.text", 262_144),
      thinking: boundedText(frame.thinking, "activity.frame.thinking", 262_144),
      toolCalls: frame.toolCalls.map((call, index) =>
        parseTransientToolCall(call, `activity.frame.toolCalls[${index}]`),
      ),
    };
  }
  if (frame.type === "clear") {
    exact(frame, "activity.frame", ["operationId", "sequence", "type"]);
    return { operationId, sequence, type: frame.type };
  }
  throw new ProtocolValidationError(
    "activity.frame.type",
    "must be text_delta, thinking_delta, tool_call, snapshot, or clear",
  );
}

const thinkingLevels: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function selection(params: Record<string, unknown>, path: string): SessionModelSelection {
  const modelId =
    params.modelId === undefined ? undefined : string(params.modelId, `${path}.modelId`);
  const thinkingLevel = params.thinkingLevel;
  if (thinkingLevel !== undefined && !thinkingLevels.includes(thinkingLevel as ThinkingLevel)) {
    throw new ProtocolValidationError(
      `${path}.thinkingLevel`,
      `must be one of: ${thinkingLevels.join(", ")}`,
    );
  }
  return {
    ...(modelId === undefined ? {} : { modelId }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as ThinkingLevel }),
  };
}

export function parseWireRequest(value: unknown): WireRequest {
  const request = object(value, "request");
  exact(request, "request", ["kind", "id", "method", "params"]);
  if (request.kind !== "request")
    throw new ProtocolValidationError("request.kind", 'must be "request"');
  if (!Number.isSafeInteger(request.id) || (request.id as number) < 0) {
    throw new ProtocolValidationError("request.id", "must be a non-negative safe integer");
  }
  const method = string(request.method, "request.method");
  const params = object(request.params, "request.params");
  const base = { kind: "request" as const, id: request.id as number };

  if (method === "connection.initialize") {
    exact(params, "request.params", ["client", "requestedCapabilities"]);
    const client = object(params.client, "request.params.client");
    exact(client, "request.params.client", ["kind", "version", "instanceId"]);
    const kind = boundedString(client.kind, "request.params.client.kind", 64);
    if (!/^[a-z][a-z0-9_-]*$/.test(kind)) {
      throw new ProtocolValidationError(
        "request.params.client.kind",
        "must be a lowercase protocol identifier",
      );
    }
    const requestedCapabilities = capabilityArray(
      params.requestedCapabilities,
      "request.params.requestedCapabilities",
    );
    return {
      ...base,
      method,
      params: {
        client: {
          kind,
          version: boundedString(client.version, "request.params.client.version", 128),
          instanceId: boundedString(client.instanceId, "request.params.client.instanceId", 128),
        },
        requestedCapabilities,
      },
    };
  }
  if (method === "daemon.info" || method === "connection.ping") {
    exact(params, "request.params", []);
    return { ...base, method, params: {} };
  }
  if (method === "session.create") {
    exact(params, "request.params", ["cwd", "modelId", "thinkingLevel"]);
    return {
      ...base,
      method,
      params: {
        cwd: string(params.cwd, "request.params.cwd"),
        ...selection(params, "request.params"),
      },
    };
  }
  if (method === "session.resume") {
    exact(params, "request.params", ["sessionId", "includeEvents"]);
    if (params.includeEvents !== undefined && typeof params.includeEvents !== "boolean") {
      throw new ProtocolValidationError("request.params.includeEvents", "must be a boolean");
    }
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        ...(params.includeEvents === undefined ? {} : { includeEvents: params.includeEvents }),
      },
    };
  }
  if (method === "session.list") {
    exact(params, "request.params", []);
    return { ...base, method, params: {} };
  }
  if (method === "session.history") {
    exact(params, "request.params", ["sessionId", "afterEventId", "limit"]);
    const limit =
      params.limit === undefined
        ? undefined
        : nonNegativeInteger(params.limit, "request.params.limit");
    if (limit === 0 || (limit !== undefined && limit > MAX_HISTORY_PAGE_EVENTS)) {
      throw new ProtocolValidationError(
        "request.params.limit",
        `must be between 1 and ${MAX_HISTORY_PAGE_EVENTS}`,
      );
    }
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        ...(params.afterEventId === undefined
          ? {}
          : { afterEventId: parseEventId(params.afterEventId, "request.params.afterEventId") }),
        ...(limit === undefined ? {} : { limit }),
      },
    };
  }
  if (method === "session.fork") {
    exact(params, "request.params", ["sessionId", "fromEventId"]);
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        fromEventId: parseEventId(params.fromEventId, "request.params.fromEventId"),
      },
    };
  }
  if (method === "session.clone") {
    exact(params, "request.params", ["sessionId"]);
    return {
      ...base,
      method,
      params: { sessionId: parseSessionId(params.sessionId, "request.params.sessionId") },
    };
  }
  if (method === "session.send") {
    exact(params, "request.params", ["sessionId", "content"]);
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        content: parseUserContent(params.content, "request.params.content"),
      },
    };
  }
  if (method === "session.shell") {
    exact(params, "request.params", ["sessionId", "command", "excluded"]);
    if (typeof params.excluded !== "boolean") {
      throw new ProtocolValidationError("request.params.excluded", "must be a boolean");
    }
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        command: string(params.command, "request.params.command"),
        excluded: params.excluded,
      },
    };
  }
  if (method === "session.configure") {
    exact(params, "request.params", ["sessionId", "modelId", "thinkingLevel"]);
    const configured = selection(params, "request.params");
    if (configured.modelId === undefined && configured.thinkingLevel === undefined) {
      throw new ProtocolValidationError("request.params", "must include modelId or thinkingLevel");
    }
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        ...configured,
      },
    };
  }
  if (method === "session.interaction.respond") {
    exact(params, "request.params", ["sessionId", "interactionId", "action", "content"]);
    const action = params.action;
    if (action !== "accept" && action !== "decline" && action !== "cancel") {
      throw new ProtocolValidationError(
        "request.params.action",
        "must be one of: accept, decline, cancel",
      );
    }
    if (
      params.content !== undefined &&
      (typeof params.content !== "object" ||
        params.content === null ||
        Array.isArray(params.content))
    ) {
      throw new ProtocolValidationError("request.params.content", "must be an object");
    }
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        interactionId: string(params.interactionId, "request.params.interactionId"),
        action,
        ...(params.content === undefined ? {} : { content: params.content as JsonObject }),
      },
    };
  }
  if (method === "session.subscribe") {
    exact(params, "request.params", ["sessionId", "afterEventId"]);
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        ...(params.afterEventId === undefined
          ? {}
          : { afterEventId: parseEventId(params.afterEventId, "request.params.afterEventId") }),
      },
    };
  }
  if (method === "session.workspace.checkpoint") {
    exact(params, "request.params", ["sessionId", "enabled"]);
    if (typeof params.enabled !== "boolean") {
      throw new ProtocolValidationError("request.params.enabled", "must be a boolean");
    }
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        enabled: params.enabled,
      },
    };
  }
  if (method === "session.workspace.diff") {
    exact(params, "request.params", ["sessionId", "scope"]);
    if (params.scope !== "working" && params.scope !== "last-turn") {
      throw new ProtocolValidationError(
        "request.params.scope",
        "must be one of: working, last-turn",
      );
    }
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        scope: params.scope,
      },
    };
  }
  if (method === "session.blob.start") {
    exact(params, "request.params", ["sessionId", "mediaType", "sizeBytes", "name"]);
    const mediaType = boundedString(params.mediaType, "request.params.mediaType", 127);
    const name =
      params.name === undefined
        ? undefined
        : boundedString(params.name, "request.params.name", 255);
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        mediaType,
        sizeBytes: nonNegativeInteger(params.sizeBytes, "request.params.sizeBytes"),
        ...(name === undefined ? {} : { name }),
      },
    };
  }
  if (method === "session.blob.chunk") {
    exact(params, "request.params", ["sessionId", "uploadId", "offset", "data"]);
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        uploadId: boundedString(params.uploadId, "request.params.uploadId", 128),
        offset: nonNegativeInteger(params.offset, "request.params.offset"),
        data: boundedString(params.data, "request.params.data", 700_000),
      },
    };
  }
  if (method === "session.blob.commit" || method === "session.blob.abort") {
    exact(params, "request.params", ["sessionId", "uploadId"]);
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        uploadId: boundedString(params.uploadId, "request.params.uploadId", 128),
      },
    };
  }
  if (method === "session.blob.read") {
    exact(params, "request.params", ["sessionId", "sha256", "offset", "length"]);
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        sha256: sha256(params.sha256, "request.params.sha256"),
        offset: nonNegativeInteger(params.offset, "request.params.offset"),
        length: nonNegativeInteger(params.length, "request.params.length"),
      },
    };
  }
  if (
    method === "session.interrupt" ||
    method === "session.reload" ||
    method === "session.dispose"
  ) {
    exact(params, "request.params", ["sessionId"]);
    return {
      ...base,
      method,
      params: { sessionId: parseSessionId(params.sessionId, "request.params.sessionId") },
    };
  }
  throw new ProtocolValidationError("request.method", `unknown method ${JSON.stringify(method)}`);
}

function parseEventList(value: unknown, path: string): readonly CanonicalEvent[] {
  if (!Array.isArray(value) || value.length > MAX_HISTORY_PAGE_EVENTS) {
    throw new ProtocolValidationError(
      path,
      `must contain at most ${MAX_HISTORY_PAGE_EVENTS} events`,
    );
  }
  return value.map((event) => parseEvent(event));
}

function parseSessionSnapshot(value: unknown, path: string): SessionSnapshot {
  const snapshot = object(value, path);
  exact(snapshot, path, ["sessionId", "events"]);
  const sessionId = parseSessionId(snapshot.sessionId, `${path}.sessionId`);
  const events = parseEventList(snapshot.events, `${path}.events`);
  for (const [index, event] of events.entries()) {
    if (event.sessionId !== sessionId) {
      throw new ProtocolValidationError(
        `${path}.events[${index}].sessionId`,
        `must match session ${sessionId}`,
      );
    }
  }
  return { sessionId, events };
}

function parseSessionSummary(value: unknown, path: string): SessionSummary {
  const summary = object(value, path);
  exact(summary, path, [
    "sessionId",
    "cwd",
    "createdAt",
    "updatedAt",
    "userMessageCount",
    "firstUserMessage",
    "lastUserMessage",
    "parentSessionId",
  ]);
  return {
    sessionId: parseSessionId(summary.sessionId, `${path}.sessionId`),
    cwd: string(summary.cwd, `${path}.cwd`),
    createdAt: nonNegativeInteger(summary.createdAt, `${path}.createdAt`),
    updatedAt: nonNegativeInteger(summary.updatedAt, `${path}.updatedAt`),
    userMessageCount: nonNegativeInteger(summary.userMessageCount, `${path}.userMessageCount`),
    ...(summary.firstUserMessage === undefined
      ? {}
      : {
          firstUserMessage: boundedText(summary.firstUserMessage, `${path}.firstUserMessage`, 4096),
        }),
    ...(summary.lastUserMessage === undefined
      ? {}
      : { lastUserMessage: boundedText(summary.lastUserMessage, `${path}.lastUserMessage`, 4096) }),
    ...(summary.parentSessionId === undefined
      ? {}
      : { parentSessionId: parseSessionId(summary.parentSessionId, `${path}.parentSessionId`) }),
  };
}

function parseBooleanResult(value: unknown, path: string, field: string): Record<string, boolean> {
  const result = object(value, path);
  exact(result, path, [field]);
  if (typeof result[field] !== "boolean") {
    throw new ProtocolValidationError(`${path}.${field}`, "must be a boolean");
  }
  return { [field]: result[field] as boolean };
}

function parseBoundaryResult(
  value: unknown,
  path: string,
): { readonly events: readonly CanonicalEvent[] } {
  const result = object(value, path);
  exact(result, path, ["events"]);
  return { events: parseEventList(result.events, `${path}.events`) };
}

function parseJsonObject(value: unknown, path: string): JsonObject {
  const result = object(value, path);
  let encoded: string;
  try {
    encoded = JSON.stringify(result);
  } catch {
    throw new ProtocolValidationError(path, "must be JSON-compatible");
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > 65_536) {
    throw new ProtocolValidationError(path, "must be a bounded JSON object");
  }
  return result as JsonObject;
}

export function parseRpcResult<Method extends RpcMethod>(
  method: Method,
  value: unknown,
): RpcResult<Method> {
  const path = "success.result";
  let parsed: unknown;
  if (method === "daemon.info") {
    const result = object(value, path);
    exact(result, path, ["securityMode", "sandboxProvider", "sandboxImage"]);
    if (result.securityMode !== "sandboxed" && result.securityMode !== "unsafe") {
      throw new ProtocolValidationError(`${path}.securityMode`, "must be sandboxed or unsafe");
    }
    parsed = {
      securityMode: result.securityMode,
      sandboxProvider: boundedString(result.sandboxProvider, `${path}.sandboxProvider`, 128),
      ...(result.sandboxImage === undefined
        ? {}
        : { sandboxImage: boundedString(result.sandboxImage, `${path}.sandboxImage`, 1024) }),
    };
  } else if (method === "connection.initialize") {
    const result = object(value, path);
    exact(result, path, [
      "attachmentId",
      "daemonInstanceId",
      "wireVersion",
      "grantedCapabilities",
      "scope",
      "heartbeatIntervalMs",
      "presenceTimeoutMs",
    ]);
    if (result.scope !== "local_control") {
      throw new ProtocolValidationError(`${path}.scope`, 'must be "local_control"');
    }
    parsed = {
      attachmentId: boundedString(result.attachmentId, `${path}.attachmentId`, 128),
      daemonInstanceId: boundedString(result.daemonInstanceId, `${path}.daemonInstanceId`, 128),
      wireVersion: nonNegativeInteger(result.wireVersion, `${path}.wireVersion`),
      grantedCapabilities: capabilityArray(
        result.grantedCapabilities,
        `${path}.grantedCapabilities`,
      ),
      scope: result.scope,
      heartbeatIntervalMs: nonNegativeInteger(
        result.heartbeatIntervalMs,
        `${path}.heartbeatIntervalMs`,
      ),
      presenceTimeoutMs: nonNegativeInteger(result.presenceTimeoutMs, `${path}.presenceTimeoutMs`),
    };
  } else if (method === "connection.ping") {
    const result = object(value, path);
    exact(result, path, []);
    parsed = {};
  } else if (method === "session.create" || method === "session.resume") {
    parsed = parseSessionSnapshot(value, path);
  } else if (method === "session.list") {
    if (!Array.isArray(value) || value.length > 10_000) {
      throw new ProtocolValidationError(path, "must contain at most 10000 sessions");
    }
    parsed = value.map((summary, index) => parseSessionSummary(summary, `${path}[${index}]`));
  } else if (method === "session.history") {
    parsed = parseSessionHistoryPage(value);
  } else if (method === "session.fork" || method === "session.clone") {
    const result = object(value, path);
    exact(result, path, ["sessionId", "events", "selectedText"]);
    const snapshot = parseSessionSnapshot(
      { sessionId: result.sessionId, events: result.events },
      path,
    );
    parsed = {
      ...snapshot,
      ...(result.selectedText === undefined
        ? {}
        : { selectedText: boundedText(result.selectedText, `${path}.selectedText`, 262_144) }),
    };
  } else if (method === "session.send") {
    const result = object(value, path);
    exact(result, path, ["stopReason"]);
    const reasons: readonly AssistantStopReason[] = [
      "stop",
      "length",
      "tool_use",
      "error",
      "aborted",
    ];
    if (!reasons.includes(result.stopReason as AssistantStopReason)) {
      throw new ProtocolValidationError(`${path}.stopReason`, "is not a valid stop reason");
    }
    parsed = { stopReason: result.stopReason };
  } else if (method === "session.shell") {
    parsed = parseBooleanResult(value, path, "isError");
  } else if (method === "session.interrupt") {
    parsed = parseBooleanResult(value, path, "interrupted");
  } else if (method === "session.reload" || method === "session.configure") {
    parsed = parseBoundaryResult(value, path);
  } else if (method === "session.interaction.respond") {
    const result = object(value, path);
    exact(result, path, ["resolved"]);
    if (result.resolved !== true) {
      throw new ProtocolValidationError(`${path}.resolved`, "must be true");
    }
    parsed = { resolved: true };
  } else if (method === "session.subscribe") {
    const result = object(value, path);
    exact(result, path, ["snapshot", "activity"]);
    parsed = {
      snapshot: parseEventList(result.snapshot, `${path}.snapshot`),
      ...(result.activity === undefined
        ? {}
        : { activity: parseSessionActivityFrame(result.activity) }),
    };
  } else if (method === "session.workspace.diff") {
    parsed = parseWorkspaceDiff(value);
  } else if (method === "session.workspace.checkpoint") {
    parsed = parseBooleanResult(value, path, "enabled");
  } else if (method === "session.blob.start") {
    const result = object(value, path);
    exact(result, path, ["uploadId", "chunkBytes"]);
    parsed = {
      uploadId: boundedString(result.uploadId, `${path}.uploadId`, 128),
      chunkBytes: nonNegativeInteger(result.chunkBytes, `${path}.chunkBytes`),
    };
  } else if (method === "session.blob.chunk") {
    const result = object(value, path);
    exact(result, path, ["nextOffset"]);
    parsed = { nextOffset: nonNegativeInteger(result.nextOffset, `${path}.nextOffset`) };
  } else if (method === "session.blob.commit") {
    parsed = parseBlobReference(value, path);
  } else if (method === "session.blob.abort") {
    parsed = parseBooleanResult(value, path, "aborted");
  } else if (method === "session.blob.read") {
    parsed = parseBlobReadResult(value);
  } else if (method === "session.dispose") {
    parsed = parseBooleanResult(value, path, "disposed");
  } else {
    const exhaustive: never = method;
    throw new ProtocolValidationError("success.method", `unknown method ${String(exhaustive)}`);
  }
  return parsed as RpcResult<Method>;
}

const RPC_METHODS = new Set<RpcMethod>([
  "daemon.info",
  "connection.initialize",
  "connection.ping",
  "session.create",
  "session.resume",
  "session.list",
  "session.history",
  "session.fork",
  "session.clone",
  "session.send",
  "session.shell",
  "session.interrupt",
  "session.reload",
  "session.configure",
  "session.interaction.respond",
  "session.subscribe",
  "session.workspace.diff",
  "session.workspace.checkpoint",
  "session.blob.start",
  "session.blob.chunk",
  "session.blob.commit",
  "session.blob.abort",
  "session.blob.read",
  "session.dispose",
]);

function parseRpcMethod(value: unknown, path: string): RpcMethod {
  const method = string(value, path) as RpcMethod;
  if (!RPC_METHODS.has(method)) {
    throw new ProtocolValidationError(path, `unknown method ${JSON.stringify(method)}`);
  }
  return method;
}

export function parseServerMessage(value: unknown): ServerMessage {
  const message = object(value, "message");
  const kind = string(message.kind, "message.kind");
  if (kind === "hello") {
    exact(message, "message", [
      "kind",
      "wireVersion",
      "daemonInstanceId",
      "capabilities",
      "limits",
    ]);
    if (!Number.isSafeInteger(message.wireVersion) || (message.wireVersion as number) < 1) {
      throw new ProtocolValidationError("message.wireVersion", "must be a positive safe integer");
    }
    const limits = object(message.limits, "message.limits");
    exact(limits, "message.limits", ["maxMessageBytes", "maxPendingRequests"]);
    return {
      kind,
      wireVersion: message.wireVersion as number,
      daemonInstanceId: boundedString(message.daemonInstanceId, "message.daemonInstanceId", 128),
      capabilities: capabilityArray(message.capabilities, "message.capabilities"),
      limits: {
        maxMessageBytes: nonNegativeInteger(
          limits.maxMessageBytes,
          "message.limits.maxMessageBytes",
        ),
        maxPendingRequests: nonNegativeInteger(
          limits.maxPendingRequests,
          "message.limits.maxPendingRequests",
        ),
      },
    };
  }
  if (kind === "success") {
    exact(message, "message", ["kind", "id", "method", "result"]);
    if (!Number.isSafeInteger(message.id) || (message.id as number) < 0) {
      throw new ProtocolValidationError("message.id", "must be a non-negative safe integer");
    }
    const method = parseRpcMethod(message.method, "message.method");
    return {
      kind,
      id: message.id as number,
      method,
      result: parseRpcResult(method, message.result),
    } as RpcSuccess;
  }
  if (kind === "error") {
    exact(message, "message", ["kind", "id", "method", "error"]);
    if (!Number.isSafeInteger(message.id) || (message.id as number) < -1) {
      throw new ProtocolValidationError("message.id", "must be a safe integer at least -1");
    }
    const error = object(message.error, "message.error");
    exact(error, "message.error", ["code", "message", "retryable", "details"]);
    if (typeof error.retryable !== "boolean") {
      throw new ProtocolValidationError("message.error.retryable", "must be a boolean");
    }
    return {
      kind,
      id: message.id as number,
      ...(message.method === undefined
        ? {}
        : { method: parseRpcMethod(message.method, "message.method") }),
      error: {
        code: boundedString(error.code, "message.error.code", 128),
        message: boundedText(error.message, "message.error.message", 4096),
        retryable: error.retryable,
        ...(error.details === undefined
          ? {}
          : { details: parseJsonObject(error.details, "message.error.details") }),
      },
    };
  }
  if (kind === "event") {
    exact(message, "message", ["kind", "sessionId", "event"]);
    const sessionId = parseSessionId(message.sessionId, "message.sessionId");
    const event = parseEvent(message.event);
    if (event.sessionId !== sessionId) {
      throw new ProtocolValidationError("message.event.sessionId", "must match message.sessionId");
    }
    return { kind, sessionId, event };
  }
  if (kind === "activity") {
    exact(message, "message", ["kind", "sessionId", "frame"]);
    return {
      kind,
      sessionId: parseSessionId(message.sessionId, "message.sessionId"),
      frame: parseSessionActivityFrame(message.frame),
    };
  }
  throw new ProtocolValidationError("message.kind", `unknown message kind ${JSON.stringify(kind)}`);
}

export function encodeWireMessage(message: ServerMessage | WireRequest): string {
  return `${JSON.stringify(message)}\n`;
}
