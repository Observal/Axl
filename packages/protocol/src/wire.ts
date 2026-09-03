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
export const MAX_WIRE_MESSAGE_BYTES = 1024 * 1024;

export type EventCursor = string;

export type SessionProfile = "minimal" | "standard" | "chat";

export interface SessionModelSelection {
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
}

export interface SessionOpenResult {
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly runtime: {
    readonly state: "inactive" | "idle" | "running" | "waiting_interaction" | "disposing";
    readonly activeOperationId?: OperationId;
  };
  readonly profile: SessionProfile;
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
  readonly runtime: SessionOpenResult["runtime"];
  readonly attachmentCount: number;
}

export interface SessionListParams {
  readonly scope: "current_workspace" | "all_local";
  readonly cwd?: string;
  readonly query?: string;
  readonly order: "recent" | "threaded";
  readonly pageSize: number;
  readonly pageCursor?: string;
}

export interface SessionListResult {
  readonly sessions: readonly SessionSummary[];
  readonly nextPageCursor?: string;
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
  "session.presence",
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

export interface RequestCancelParams {
  readonly requestId: number;
}

export interface RequestCancelResult {
  readonly cancellationRequested: boolean;
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
  readonly "request.cancel": {
    readonly params: RequestCancelParams;
    readonly result: RequestCancelResult;
  };
  readonly "session.create": {
    readonly params: {
      readonly cwd: string;
      readonly profile?: SessionProfile;
    } & SessionModelSelection;
    readonly result: SessionOpenResult;
  };
  readonly "session.resume": {
    readonly params: { readonly sessionId: SessionId };
    readonly result: SessionOpenResult;
  };
  readonly "session.list": {
    readonly params: SessionListParams;
    readonly result: SessionListResult;
  };
  readonly "session.history": {
    readonly params: SessionHistoryParams;
    readonly result: SessionHistoryResult;
  };
  readonly "session.ack": {
    readonly params: SessionAckParams;
    readonly result: SessionAckResult;
  };
  readonly "session.unsubscribe": {
    readonly params: SessionUnsubscribeParams;
    readonly result: SessionUnsubscribeResult;
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
    readonly params: {
      readonly sessionId: SessionId;
      readonly content: readonly UserContent[];
      readonly delivery: "prompt" | "steer" | "follow_up";
    };
    readonly result: {
      readonly operationId: OperationId;
      readonly stopReason: AssistantStopReason;
    };
  };
  readonly "session.shell": {
    readonly params: {
      readonly sessionId: SessionId;
      readonly operationId: OperationId;
      readonly command: string;
      readonly excluded: boolean;
    };
    readonly result: {
      readonly operationId: OperationId;
      readonly isError: boolean;
      readonly resultEventId: EventId;
    };
  };
  readonly "session.interrupt": {
    readonly params: { readonly sessionId: SessionId };
    readonly result: { readonly interrupted: boolean; readonly operationId?: OperationId };
  };
  readonly "session.reload": {
    readonly params: { readonly sessionId: SessionId };
    readonly result: { readonly boundaryEventIds: readonly EventId[] };
  };
  readonly "session.configure": {
    readonly params: {
      readonly sessionId: SessionId;
      readonly profile?: SessionProfile;
    } & SessionModelSelection;
    readonly result: {
      readonly modelId: string;
      readonly requestedThinkingLevel: ThinkingLevel;
      readonly effectiveThinkingLevel: ThinkingLevel;
      readonly profile: SessionProfile;
      readonly boundaryEventIds: readonly EventId[];
    };
  };
  readonly "session.interaction.respond": {
    readonly params: {
      readonly sessionId: SessionId;
      readonly interactionId: string;
      readonly action: InteractionAction;
      readonly content?: JsonObject;
    };
    readonly result: { readonly interactionId: string; readonly resolutionEventId: EventId };
  };
  readonly "session.subscribe": {
    readonly params: SessionSubscribeParams;
    readonly result: SessionSubscribeResult;
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
    readonly result: { readonly disposed: boolean; readonly historyPreserved: true };
  };
}

export type RpcMethod = keyof RpcMethodMap;
export type RpcParams<Method extends RpcMethod> = RpcMethodMap[Method]["params"];

export const RETRYABLE_MUTATION_METHODS = [
  "session.create",
  "session.fork",
  "session.clone",
  "session.send",
  "session.interrupt",
  "session.reload",
  "session.configure",
  "session.interaction.respond",
  "session.dispose",
] as const satisfies readonly RpcMethod[];

export type RetryableMutationMethod = (typeof RETRYABLE_MUTATION_METHODS)[number];

export function isRetryableMutationMethod(method: RpcMethod): method is RetryableMutationMethod {
  return RETRYABLE_MUTATION_METHODS.includes(method as RetryableMutationMethod);
}

export function requiredCapability(method: RpcMethod): CapabilityId | undefined {
  if (
    method === "daemon.info" ||
    method === "connection.initialize" ||
    method === "connection.ping" ||
    method === "request.cancel" ||
    method === "session.history" ||
    method === "session.ack" ||
    method === "session.unsubscribe"
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
    readonly idempotencyKey?: string;
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
  readonly subscriptionId: string;
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly cursor: EventCursor;
  readonly event: CanonicalEvent;
}

export interface WireActivity {
  readonly kind: "activity";
  readonly subscriptionId: string;
  readonly sessionId: SessionId;
  readonly frame: SessionActivityFrame;
}

export interface AttachmentPresence {
  readonly attachmentId: string;
  readonly clientKind: ClientKind;
  readonly connectedAt: number;
  readonly lastSeenAt: number;
  readonly subscribedSessionIds: readonly SessionId[];
  readonly scope: "local_control";
}

export interface PresenceDelivery {
  readonly kind: "presence";
  readonly attachments: readonly AttachmentPresence[];
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
export type ServerMessage =
  | RpcSuccess
  | RpcError
  | WireEvent
  | WireActivity
  | PresenceDelivery
  | WireHello;

export interface SessionForkResult extends SessionOpenResult {
  readonly selectedText?: string;
}

export interface SnapshotPage {
  readonly events: readonly CanonicalEvent[];
  readonly nextPageCursor?: string;
  readonly complete: boolean;
}

export interface SnapshotDescriptor {
  readonly snapshotId: string;
  readonly sessionId: SessionId;
  readonly fromNodeId?: EventId;
  readonly boundaryCursor: EventCursor;
  readonly eventCount: number;
  readonly page: SnapshotPage;
}

export interface SessionHistoryParams {
  readonly snapshotId: string;
  readonly pageCursor: string;
}

export interface SessionHistoryResult {
  readonly snapshotId: string;
  readonly page: SnapshotPage;
}

export interface SessionSubscribeParams {
  readonly sessionId: SessionId;
  readonly fromNodeId?: EventId;
  readonly after?: EventCursor;
}

export interface SessionSubscribeResult {
  readonly subscriptionId: string;
  readonly sessionId: SessionId;
  readonly fromNodeId?: EventId;
  readonly snapshot?: SnapshotDescriptor;
  readonly resumedFrom?: EventCursor;
}

export interface SessionAckParams {
  readonly subscriptionId: string;
  readonly cursor: EventCursor;
}

export interface SessionAckResult {
  readonly cursor: EventCursor;
}

export interface SessionUnsubscribeParams {
  readonly subscriptionId: string;
}

export interface SessionUnsubscribeResult {
  readonly unsubscribed: boolean;
}

export function parseSnapshotPage(value: unknown, expectedSessionId?: unknown): SnapshotPage {
  const page = object(value, "snapshotPage");
  exact(page, "snapshotPage", ["events", "nextPageCursor", "complete"]);
  if (!Array.isArray(page.events) || page.events.length > MAX_HISTORY_PAGE_EVENTS) {
    throw new ProtocolValidationError(
      "snapshotPage.events",
      `must contain at most ${MAX_HISTORY_PAGE_EVENTS} events`,
    );
  }
  if (typeof page.complete !== "boolean") {
    throw new ProtocolValidationError("snapshotPage.complete", "must be a boolean");
  }
  const sessionId =
    expectedSessionId === undefined
      ? undefined
      : parseSessionId(expectedSessionId, "snapshotPage.sessionId");
  const events = page.events.map((event, index) => {
    const parsed = parseEvent(event);
    if (sessionId !== undefined && parsed.sessionId !== sessionId) {
      throw new ProtocolValidationError(
        `snapshotPage.events[${index}].sessionId`,
        `must match session ${sessionId}`,
      );
    }
    return parsed;
  });
  const nextPageCursor =
    page.nextPageCursor === undefined
      ? undefined
      : boundedString(page.nextPageCursor, "snapshotPage.nextPageCursor", 512);
  if (page.complete === (nextPageCursor !== undefined)) {
    throw new ProtocolValidationError(
      "snapshotPage",
      "complete pages cannot have a next cursor and incomplete pages require one",
    );
  }
  if (!page.complete && events.length === 0) {
    throw new ProtocolValidationError(
      "snapshotPage.events",
      "must make progress when more history remains",
    );
  }
  return {
    events,
    ...(nextPageCursor === undefined ? {} : { nextPageCursor }),
    complete: page.complete,
  };
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

function positiveInteger(value: unknown, path: string): number {
  const result = nonNegativeInteger(value, path);
  if (result === 0) throw new ProtocolValidationError(path, "must be a positive integer");
  return result;
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

function sessionProfile(value: unknown, path: string): SessionProfile | undefined {
  if (value === undefined) return undefined;
  if (value !== "minimal" && value !== "standard" && value !== "chat") {
    throw new ProtocolValidationError(path, "must be minimal, standard, or chat");
  }
  return value;
}

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
  exact(request, "request", ["kind", "id", "method", "params", "idempotencyKey"]);
  if (request.kind !== "request")
    throw new ProtocolValidationError("request.kind", 'must be "request"');
  if (!Number.isSafeInteger(request.id) || (request.id as number) < 0) {
    throw new ProtocolValidationError("request.id", "must be a non-negative safe integer");
  }
  const method = parseRpcMethod(request.method, "request.method");
  const params = object(request.params, "request.params");
  let idempotencyKey: string | undefined;
  if (isRetryableMutationMethod(method)) {
    idempotencyKey = parseOperationId(request.idempotencyKey, "request.idempotencyKey");
  } else if (request.idempotencyKey !== undefined) {
    throw new ProtocolValidationError("request.idempotencyKey", `is not allowed for ${method}`);
  }
  const base = {
    kind: "request" as const,
    id: request.id as number,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };

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
  if (method === "request.cancel") {
    exact(params, "request.params", ["requestId"]);
    return {
      ...base,
      method,
      params: { requestId: nonNegativeInteger(params.requestId, "request.params.requestId") },
    };
  }
  if (method === "session.create") {
    exact(params, "request.params", ["cwd", "modelId", "thinkingLevel", "profile"]);
    const profile = sessionProfile(params.profile, "request.params.profile");
    return {
      ...base,
      method,
      params: {
        cwd: string(params.cwd, "request.params.cwd"),
        ...selection(params, "request.params"),
        profile: profile ?? "minimal",
      },
    };
  }
  if (method === "session.resume") {
    exact(params, "request.params", ["sessionId"]);
    return {
      ...base,
      method,
      params: { sessionId: parseSessionId(params.sessionId, "request.params.sessionId") },
    };
  }
  if (method === "session.list") {
    exact(params, "request.params", ["scope", "cwd", "query", "order", "pageSize", "pageCursor"]);
    if (params.scope !== "current_workspace" && params.scope !== "all_local") {
      throw new ProtocolValidationError(
        "request.params.scope",
        "must be current_workspace or all_local",
      );
    }
    if (params.order !== "recent" && params.order !== "threaded") {
      throw new ProtocolValidationError("request.params.order", "must be recent or threaded");
    }
    const cwd =
      params.cwd === undefined ? undefined : boundedString(params.cwd, "request.params.cwd", 4096);
    if (params.scope === "current_workspace" && cwd === undefined) {
      throw new ProtocolValidationError(
        "request.params.cwd",
        "is required for current_workspace scope",
      );
    }
    const query =
      params.query === undefined
        ? undefined
        : boundedText(params.query, "request.params.query", 1024);
    const pageSize = positiveInteger(params.pageSize, "request.params.pageSize");
    if (pageSize > 100) {
      throw new ProtocolValidationError("request.params.pageSize", "must not exceed 100");
    }
    return {
      ...base,
      method,
      params: {
        scope: params.scope,
        ...(cwd === undefined ? {} : { cwd }),
        ...(query === undefined ? {} : { query }),
        order: params.order,
        pageSize,
        ...(params.pageCursor === undefined
          ? {}
          : { pageCursor: boundedString(params.pageCursor, "request.params.pageCursor", 512) }),
      },
    };
  }
  if (method === "session.history") {
    exact(params, "request.params", ["snapshotId", "pageCursor"]);
    return {
      ...base,
      method,
      params: {
        snapshotId: boundedString(params.snapshotId, "request.params.snapshotId", 128),
        pageCursor: boundedString(params.pageCursor, "request.params.pageCursor", 512),
      },
    };
  }
  if (method === "session.ack") {
    exact(params, "request.params", ["subscriptionId", "cursor"]);
    return {
      ...base,
      method,
      params: {
        subscriptionId: boundedString(params.subscriptionId, "request.params.subscriptionId", 128),
        cursor: boundedString(params.cursor, "request.params.cursor", 512),
      },
    };
  }
  if (method === "session.unsubscribe") {
    exact(params, "request.params", ["subscriptionId"]);
    return {
      ...base,
      method,
      params: {
        subscriptionId: boundedString(params.subscriptionId, "request.params.subscriptionId", 128),
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
    exact(params, "request.params", ["sessionId", "content", "delivery"]);
    if (
      params.delivery !== "prompt" &&
      params.delivery !== "steer" &&
      params.delivery !== "follow_up"
    ) {
      throw new ProtocolValidationError(
        "request.params.delivery",
        "must be prompt, steer, or follow_up",
      );
    }
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        content: parseUserContent(params.content, "request.params.content"),
        delivery: params.delivery,
      },
    };
  }
  if (method === "session.shell") {
    exact(params, "request.params", ["sessionId", "operationId", "command", "excluded"]);
    if (typeof params.excluded !== "boolean") {
      throw new ProtocolValidationError("request.params.excluded", "must be a boolean");
    }
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        operationId: parseOperationId(params.operationId, "request.params.operationId"),
        command: string(params.command, "request.params.command"),
        excluded: params.excluded,
      },
    };
  }
  if (method === "session.configure") {
    exact(params, "request.params", ["sessionId", "modelId", "thinkingLevel", "profile"]);
    const configured = selection(params, "request.params");
    const profile = sessionProfile(params.profile, "request.params.profile");
    if (
      configured.modelId === undefined &&
      configured.thinkingLevel === undefined &&
      profile === undefined
    ) {
      throw new ProtocolValidationError(
        "request.params",
        "must include modelId, thinkingLevel, or profile",
      );
    }
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        ...configured,
        profile: profile ?? "minimal",
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
    exact(params, "request.params", ["sessionId", "fromNodeId", "after"]);
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        ...(params.fromNodeId === undefined
          ? {}
          : { fromNodeId: parseEventId(params.fromNodeId, "request.params.fromNodeId") }),
        ...(params.after === undefined
          ? {}
          : { after: boundedString(params.after, "request.params.after", 512) }),
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

function parseSessionOpenResult(
  value: unknown,
  path: string,
  allowSelectedText = false,
): SessionOpenResult {
  const result = object(value, path);
  exact(result, path, [
    "sessionId",
    "cwd",
    "runtime",
    "profile",
    ...(allowSelectedText ? ["selectedText"] : []),
  ]);
  const runtime = object(result.runtime, `${path}.runtime`);
  exact(runtime, `${path}.runtime`, ["state", "activeOperationId"]);
  const states = ["inactive", "idle", "running", "waiting_interaction", "disposing"] as const;
  if (!states.includes(runtime.state as (typeof states)[number])) {
    throw new ProtocolValidationError(`${path}.runtime.state`, "is not a valid runtime state");
  }
  const profiles: readonly SessionProfile[] = ["minimal", "standard", "chat"];
  if (!profiles.includes(result.profile as SessionProfile)) {
    throw new ProtocolValidationError(`${path}.profile`, "is not a valid session profile");
  }
  return {
    sessionId: parseSessionId(result.sessionId, `${path}.sessionId`),
    cwd: string(result.cwd, `${path}.cwd`),
    runtime: {
      state: runtime.state as SessionOpenResult["runtime"]["state"],
      ...(runtime.activeOperationId === undefined
        ? {}
        : {
            activeOperationId: parseOperationId(
              runtime.activeOperationId,
              `${path}.runtime.activeOperationId`,
            ),
          }),
    },
    profile: result.profile as SessionProfile,
  };
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
    "runtime",
    "attachmentCount",
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
    runtime: parseSessionRuntime(summary.runtime, `${path}.runtime`),
    attachmentCount: nonNegativeInteger(summary.attachmentCount, `${path}.attachmentCount`),
  };
}

function parseSessionRuntime(value: unknown, path: string): SessionOpenResult["runtime"] {
  const runtime = object(value, path);
  exact(runtime, path, ["state", "activeOperationId"]);
  const states = ["inactive", "idle", "running", "waiting_interaction", "disposing"] as const;
  if (!states.includes(runtime.state as (typeof states)[number])) {
    throw new ProtocolValidationError(`${path}.state`, "is not a valid runtime state");
  }
  return {
    state: runtime.state as SessionOpenResult["runtime"]["state"],
    ...(runtime.activeOperationId === undefined
      ? {}
      : {
          activeOperationId: parseOperationId(
            runtime.activeOperationId,
            `${path}.activeOperationId`,
          ),
        }),
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
    const heartbeatIntervalMs = positiveInteger(
      result.heartbeatIntervalMs,
      `${path}.heartbeatIntervalMs`,
    );
    const presenceTimeoutMs = positiveInteger(
      result.presenceTimeoutMs,
      `${path}.presenceTimeoutMs`,
    );
    if (heartbeatIntervalMs >= presenceTimeoutMs) {
      throw new ProtocolValidationError(
        `${path}.heartbeatIntervalMs`,
        "must be less than presenceTimeoutMs",
      );
    }
    parsed = {
      attachmentId: boundedString(result.attachmentId, `${path}.attachmentId`, 128),
      daemonInstanceId: boundedString(result.daemonInstanceId, `${path}.daemonInstanceId`, 128),
      wireVersion: positiveInteger(result.wireVersion, `${path}.wireVersion`),
      grantedCapabilities: capabilityArray(
        result.grantedCapabilities,
        `${path}.grantedCapabilities`,
      ),
      scope: result.scope,
      heartbeatIntervalMs,
      presenceTimeoutMs,
    };
  } else if (method === "connection.ping") {
    const result = object(value, path);
    exact(result, path, []);
    parsed = {};
  } else if (method === "request.cancel") {
    parsed = parseBooleanResult(value, path, "cancellationRequested");
  } else if (method === "session.create" || method === "session.resume") {
    parsed = parseSessionOpenResult(value, path);
  } else if (method === "session.list") {
    const result = object(value, path);
    exact(result, path, ["sessions", "nextPageCursor"]);
    if (!Array.isArray(result.sessions) || result.sessions.length > 100) {
      throw new ProtocolValidationError(`${path}.sessions`, "must contain at most 100 sessions");
    }
    parsed = {
      sessions: result.sessions.map((summary, index) =>
        parseSessionSummary(summary, `${path}.sessions[${index}]`),
      ),
      ...(result.nextPageCursor === undefined
        ? {}
        : {
            nextPageCursor: boundedString(result.nextPageCursor, `${path}.nextPageCursor`, 512),
          }),
    };
  } else if (method === "session.history") {
    const result = object(value, path);
    exact(result, path, ["snapshotId", "page"]);
    parsed = {
      snapshotId: boundedString(result.snapshotId, `${path}.snapshotId`, 128),
      page: parseSnapshotPage(result.page),
    };
  } else if (method === "session.ack") {
    const result = object(value, path);
    exact(result, path, ["cursor"]);
    parsed = { cursor: boundedString(result.cursor, `${path}.cursor`, 512) };
  } else if (method === "session.unsubscribe") {
    parsed = parseBooleanResult(value, path, "unsubscribed");
  } else if (method === "session.fork" || method === "session.clone") {
    const result = object(value, path);
    const opened = parseSessionOpenResult(value, path, true);
    parsed = {
      ...opened,
      ...(result.selectedText === undefined
        ? {}
        : { selectedText: boundedText(result.selectedText, `${path}.selectedText`, 262_144) }),
    };
  } else if (method === "session.send") {
    const result = object(value, path);
    exact(result, path, ["operationId", "stopReason"]);
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
    parsed = {
      operationId: parseOperationId(result.operationId, `${path}.operationId`),
      stopReason: result.stopReason,
    };
  } else if (method === "session.shell") {
    const result = object(value, path);
    exact(result, path, ["operationId", "isError", "resultEventId"]);
    if (typeof result.isError !== "boolean") {
      throw new ProtocolValidationError(`${path}.isError`, "must be a boolean");
    }
    parsed = {
      operationId: parseOperationId(result.operationId, `${path}.operationId`),
      isError: result.isError,
      resultEventId: parseEventId(result.resultEventId, `${path}.resultEventId`),
    };
  } else if (method === "session.interrupt") {
    const result = object(value, path);
    exact(result, path, ["interrupted", "operationId"]);
    if (typeof result.interrupted !== "boolean") {
      throw new ProtocolValidationError(`${path}.interrupted`, "must be a boolean");
    }
    parsed = {
      interrupted: result.interrupted,
      ...(result.operationId === undefined
        ? {}
        : { operationId: parseOperationId(result.operationId, `${path}.operationId`) }),
    };
  } else if (method === "session.reload") {
    const result = object(value, path);
    exact(result, path, ["boundaryEventIds"]);
    if (!Array.isArray(result.boundaryEventIds) || result.boundaryEventIds.length > 256) {
      throw new ProtocolValidationError(`${path}.boundaryEventIds`, "must contain at most 256 IDs");
    }
    parsed = {
      boundaryEventIds: result.boundaryEventIds.map((id, index) =>
        parseEventId(id, `${path}.boundaryEventIds[${index}]`),
      ),
    };
  } else if (method === "session.configure") {
    const result = object(value, path);
    exact(result, path, [
      "modelId",
      "requestedThinkingLevel",
      "effectiveThinkingLevel",
      "profile",
      "boundaryEventIds",
    ]);
    if (!thinkingLevels.includes(result.requestedThinkingLevel as ThinkingLevel)) {
      throw new ProtocolValidationError(
        `${path}.requestedThinkingLevel`,
        "must be a thinking level",
      );
    }
    if (!thinkingLevels.includes(result.effectiveThinkingLevel as ThinkingLevel)) {
      throw new ProtocolValidationError(
        `${path}.effectiveThinkingLevel`,
        "must be a thinking level",
      );
    }
    if (!Array.isArray(result.boundaryEventIds) || result.boundaryEventIds.length > 256) {
      throw new ProtocolValidationError(`${path}.boundaryEventIds`, "must contain at most 256 IDs");
    }
    const profile = sessionProfile(result.profile, `${path}.profile`);
    if (profile === undefined) {
      throw new ProtocolValidationError(`${path}.profile`, "is required");
    }
    parsed = {
      modelId: boundedString(result.modelId, `${path}.modelId`, 512),
      requestedThinkingLevel: result.requestedThinkingLevel,
      effectiveThinkingLevel: result.effectiveThinkingLevel,
      profile,
      boundaryEventIds: result.boundaryEventIds.map((id, index) =>
        parseEventId(id, `${path}.boundaryEventIds[${index}]`),
      ),
    };
  } else if (method === "session.interaction.respond") {
    const result = object(value, path);
    exact(result, path, ["interactionId", "resolutionEventId"]);
    parsed = {
      interactionId: boundedString(result.interactionId, `${path}.interactionId`, 128),
      resolutionEventId: parseEventId(result.resolutionEventId, `${path}.resolutionEventId`),
    };
  } else if (method === "session.subscribe") {
    const result = object(value, path);
    exact(result, path, ["subscriptionId", "sessionId", "fromNodeId", "snapshot", "resumedFrom"]);
    const sessionId = parseSessionId(result.sessionId, `${path}.sessionId`);
    const fromNodeId =
      result.fromNodeId === undefined
        ? undefined
        : parseEventId(result.fromNodeId, `${path}.fromNodeId`);
    let snapshot: SnapshotDescriptor | undefined;
    if (result.snapshot !== undefined) {
      const descriptor = object(result.snapshot, `${path}.snapshot`);
      exact(descriptor, `${path}.snapshot`, [
        "snapshotId",
        "sessionId",
        "fromNodeId",
        "boundaryCursor",
        "eventCount",
        "page",
      ]);
      const snapshotSessionId = parseSessionId(descriptor.sessionId, `${path}.snapshot.sessionId`);
      if (snapshotSessionId !== sessionId) {
        throw new ProtocolValidationError(`${path}.snapshot.sessionId`, "must match sessionId");
      }
      const snapshotFromNodeId =
        descriptor.fromNodeId === undefined
          ? undefined
          : parseEventId(descriptor.fromNodeId, `${path}.snapshot.fromNodeId`);
      if (snapshotFromNodeId !== fromNodeId) {
        throw new ProtocolValidationError(`${path}.snapshot.fromNodeId`, "must match fromNodeId");
      }
      const page = parseSnapshotPage(descriptor.page, sessionId);
      const eventCount = nonNegativeInteger(descriptor.eventCount, `${path}.snapshot.eventCount`);
      if (page.events.length > eventCount || (page.complete && page.events.length !== eventCount)) {
        throw new ProtocolValidationError(
          `${path}.snapshot.eventCount`,
          "must match the frozen snapshot pages",
        );
      }
      snapshot = {
        snapshotId: boundedString(descriptor.snapshotId, `${path}.snapshot.snapshotId`, 128),
        sessionId: snapshotSessionId,
        ...(snapshotFromNodeId === undefined ? {} : { fromNodeId: snapshotFromNodeId }),
        boundaryCursor: boundedString(
          descriptor.boundaryCursor,
          `${path}.snapshot.boundaryCursor`,
          512,
        ),
        eventCount,
        page,
      };
    }
    const resumedFrom =
      result.resumedFrom === undefined
        ? undefined
        : boundedString(result.resumedFrom, `${path}.resumedFrom`, 512);
    if ((snapshot === undefined) === (resumedFrom === undefined)) {
      throw new ProtocolValidationError(
        path,
        "must contain exactly one of snapshot or resumedFrom",
      );
    }
    parsed = {
      subscriptionId: boundedString(result.subscriptionId, `${path}.subscriptionId`, 128),
      sessionId,
      ...(fromNodeId === undefined ? {} : { fromNodeId }),
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(resumedFrom === undefined ? {} : { resumedFrom }),
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
    const result = object(value, path);
    exact(result, path, ["disposed", "historyPreserved"]);
    if (typeof result.disposed !== "boolean") {
      throw new ProtocolValidationError(`${path}.disposed`, "must be a boolean");
    }
    if (result.historyPreserved !== true) {
      throw new ProtocolValidationError(`${path}.historyPreserved`, "must be true");
    }
    parsed = { disposed: result.disposed, historyPreserved: true };
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
  "request.cancel",
  "session.create",
  "session.resume",
  "session.list",
  "session.history",
  "session.ack",
  "session.unsubscribe",
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
        maxMessageBytes: positiveInteger(limits.maxMessageBytes, "message.limits.maxMessageBytes"),
        maxPendingRequests: positiveInteger(
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
  if (kind === "presence") {
    exact(message, "message", ["kind", "attachments"]);
    if (!Array.isArray(message.attachments) || message.attachments.length > 256) {
      throw new ProtocolValidationError(
        "message.attachments",
        "must contain at most 256 attachments",
      );
    }
    const attachments = message.attachments.map((value, index): AttachmentPresence => {
      const path = `message.attachments[${index}]`;
      const attachment = object(value, path);
      exact(attachment, path, [
        "attachmentId",
        "clientKind",
        "connectedAt",
        "lastSeenAt",
        "subscribedSessionIds",
        "scope",
      ]);
      if (attachment.scope !== "local_control") {
        throw new ProtocolValidationError(`${path}.scope`, 'must be "local_control"');
      }
      const clientKind = boundedString(attachment.clientKind, `${path}.clientKind`, 64);
      if (!/^[a-z][a-z0-9_-]*$/.test(clientKind)) {
        throw new ProtocolValidationError(`${path}.clientKind`, "must be a protocol identifier");
      }
      if (
        !Array.isArray(attachment.subscribedSessionIds) ||
        attachment.subscribedSessionIds.length > 256
      ) {
        throw new ProtocolValidationError(
          `${path}.subscribedSessionIds`,
          "must contain at most 256 session IDs",
        );
      }
      const subscribedSessionIds = attachment.subscribedSessionIds.map((sessionId, at) =>
        parseSessionId(sessionId, `${path}.subscribedSessionIds[${at}]`),
      );
      if (new Set(subscribedSessionIds).size !== subscribedSessionIds.length) {
        throw new ProtocolValidationError(
          `${path}.subscribedSessionIds`,
          "must not contain duplicates",
        );
      }
      const connectedAt = nonNegativeInteger(attachment.connectedAt, `${path}.connectedAt`);
      const lastSeenAt = nonNegativeInteger(attachment.lastSeenAt, `${path}.lastSeenAt`);
      if (lastSeenAt < connectedAt) {
        throw new ProtocolValidationError(`${path}.lastSeenAt`, "must not precede connectedAt");
      }
      return {
        attachmentId: boundedString(attachment.attachmentId, `${path}.attachmentId`, 128),
        clientKind,
        connectedAt,
        lastSeenAt,
        subscribedSessionIds,
        scope: attachment.scope,
      };
    });
    if (
      new Set(attachments.map((attachment) => attachment.attachmentId)).size !== attachments.length
    ) {
      throw new ProtocolValidationError("message.attachments", "must not contain duplicate IDs");
    }
    return { kind, attachments };
  }
  if (kind === "event") {
    exact(message, "message", [
      "kind",
      "subscriptionId",
      "sessionId",
      "sequence",
      "cursor",
      "event",
    ]);
    const sessionId = parseSessionId(message.sessionId, "message.sessionId");
    const event = parseEvent(message.event);
    if (event.sessionId !== sessionId) {
      throw new ProtocolValidationError("message.event.sessionId", "must match message.sessionId");
    }
    const sequence = nonNegativeInteger(message.sequence, "message.sequence");
    if (sequence < 1) {
      throw new ProtocolValidationError("message.sequence", "must be at least 1");
    }
    return {
      kind,
      subscriptionId: boundedString(message.subscriptionId, "message.subscriptionId", 128),
      sessionId,
      sequence,
      cursor: boundedString(message.cursor, "message.cursor", 512),
      event,
    };
  }
  if (kind === "activity") {
    exact(message, "message", ["kind", "subscriptionId", "sessionId", "frame"]);
    return {
      kind,
      subscriptionId: boundedString(message.subscriptionId, "message.subscriptionId", 128),
      sessionId: parseSessionId(message.sessionId, "message.sessionId"),
      frame: parseSessionActivityFrame(message.frame),
    };
  }
  throw new ProtocolValidationError("message.kind", `unknown message kind ${JSON.stringify(kind)}`);
}

export function encodeWireMessage(message: ServerMessage | WireRequest): string {
  return `${JSON.stringify(message)}\n`;
}
