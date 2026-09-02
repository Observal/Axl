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
  CanonicalEvent,
  InteractionAction,
  SessionProfile,
  ThinkingLevel,
  UserContent,
} from "./events.ts";
import { parseEvent, parseUserContent } from "./events.ts";

export const MAX_HISTORY_PAGE_EVENTS = 5_000;

export interface SessionModelSelection {
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
}

export interface SessionToolSelection {
  readonly webFetch?: boolean;
  readonly webSearch?: boolean;
}

export type SessionSelection = SessionModelSelection & SessionToolSelection;

export interface SessionConfiguration extends SessionSelection {
  readonly profile?: SessionProfile;
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
  readonly securityMode?: "sandboxed" | "unsafe";
  readonly sandboxProvider?: string;
  readonly sandboxImage?: string;
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

export type WireRequest =
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "daemon.info";
      readonly params: Record<string, never>;
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.create";
      readonly params: { readonly cwd: string } & SessionConfiguration;
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.resume";
      readonly params: { readonly sessionId: SessionId; readonly includeEvents?: boolean };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.list";
      readonly params: Record<string, never>;
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.history";
      readonly params: {
        readonly sessionId: SessionId;
        readonly afterEventId?: EventId;
        readonly limit?: number;
      };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.fork";
      readonly params: { readonly sessionId: SessionId; readonly fromEventId: EventId };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.clone";
      readonly params: { readonly sessionId: SessionId };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.send" | "session.steer" | "session.followUp";
      readonly params: { readonly sessionId: SessionId; readonly content: readonly UserContent[] };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.compact";
      readonly params: { readonly sessionId: SessionId; readonly instructions?: string };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.shell";
      readonly params: {
        readonly sessionId: SessionId;
        readonly command: string;
        readonly excluded: boolean;
      };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.interrupt" | "session.reload" | "session.dispose";
      readonly params: { readonly sessionId: SessionId };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.configure";
      readonly params: { readonly sessionId: SessionId } & SessionSelection;
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.interaction.respond";
      readonly params: {
        readonly sessionId: SessionId;
        readonly interactionId: string;
        readonly action: InteractionAction;
        readonly content?: JsonObject;
      };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.subscribe";
      readonly params: { readonly sessionId: SessionId; readonly afterEventId?: EventId };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.workspace.diff";
      readonly params: { readonly sessionId: SessionId; readonly scope: WorkspaceDiffScope };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.workspace.checkpoint";
      readonly params: { readonly sessionId: SessionId; readonly enabled: boolean };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.blob.start";
      readonly params: {
        readonly sessionId: SessionId;
        readonly mediaType: string;
        readonly sizeBytes: number;
        readonly name?: string;
      };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.blob.chunk";
      readonly params: {
        readonly sessionId: SessionId;
        readonly uploadId: string;
        readonly offset: number;
        readonly data: string;
      };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.blob.commit" | "session.blob.abort";
      readonly params: { readonly sessionId: SessionId; readonly uploadId: string };
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.blob.read";
      readonly params: {
        readonly sessionId: SessionId;
        readonly sha256: string;
        readonly offset: number;
        readonly length: number;
      };
    };

export type WireMethod = WireRequest["method"];

export interface WireResponse {
  readonly kind: "response";
  readonly id: number;
  readonly result: unknown;
}

export interface WireError {
  readonly kind: "error";
  readonly id: number;
  readonly code: string;
  readonly message: string;
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
}

export type ServerMessage = WireResponse | WireError | WireEvent | WireActivity | WireHello;

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

function selection(params: Record<string, unknown>, path: string): SessionSelection {
  const modelId =
    params.modelId === undefined ? undefined : string(params.modelId, `${path}.modelId`);
  const thinkingLevel = params.thinkingLevel;
  if (thinkingLevel !== undefined && !thinkingLevels.includes(thinkingLevel as ThinkingLevel)) {
    throw new ProtocolValidationError(
      `${path}.thinkingLevel`,
      `must be one of: ${thinkingLevels.join(", ")}`,
    );
  }
  for (const field of ["webFetch", "webSearch"] as const) {
    if (params[field] !== undefined && typeof params[field] !== "boolean") {
      throw new ProtocolValidationError(`${path}.${field}`, "must be a boolean");
    }
  }
  return {
    ...(modelId === undefined ? {} : { modelId }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as ThinkingLevel }),
    ...(params.webFetch === undefined ? {} : { webFetch: params.webFetch as boolean }),
    ...(params.webSearch === undefined ? {} : { webSearch: params.webSearch as boolean }),
  };
}

function configuration(params: Record<string, unknown>, path: string): SessionConfiguration {
  const selected = selection(params, path);
  const profile = params.profile;
  if (profile !== undefined && profile !== "standard" && profile !== "exec") {
    throw new ProtocolValidationError(`${path}.profile`, "must be one of: standard, exec");
  }
  return {
    ...selected,
    ...(profile === undefined ? {} : { profile }),
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

  if (method === "daemon.info") {
    exact(params, "request.params", []);
    return { ...base, method, params: {} };
  }
  if (method === "session.create") {
    exact(params, "request.params", [
      "cwd",
      "modelId",
      "thinkingLevel",
      "webFetch",
      "webSearch",
      "profile",
    ]);
    return {
      ...base,
      method,
      params: {
        cwd: string(params.cwd, "request.params.cwd"),
        ...configuration(params, "request.params"),
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
  if (method === "session.send" || method === "session.steer" || method === "session.followUp") {
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
  if (method === "session.compact") {
    exact(params, "request.params", ["sessionId", "instructions"]);
    return {
      ...base,
      method,
      params: {
        sessionId: parseSessionId(params.sessionId, "request.params.sessionId"),
        ...(params.instructions === undefined
          ? {}
          : {
              instructions: boundedString(
                params.instructions,
                "request.params.instructions",
                16_384,
              ),
            }),
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
    exact(params, "request.params", [
      "sessionId",
      "modelId",
      "thinkingLevel",
      "webFetch",
      "webSearch",
    ]);
    const configured = selection(params, "request.params");
    if (
      configured.modelId === undefined &&
      configured.thinkingLevel === undefined &&
      configured.webFetch === undefined &&
      configured.webSearch === undefined
    ) {
      throw new ProtocolValidationError(
        "request.params",
        "must include modelId, thinkingLevel, webFetch, or webSearch",
      );
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

export function parseServerMessage(value: unknown): ServerMessage {
  const message = object(value, "message");
  const kind = string(message.kind, "message.kind");
  if (kind === "hello") {
    exact(message, "message", ["kind", "wireVersion"]);
    if (!Number.isSafeInteger(message.wireVersion) || (message.wireVersion as number) < 1) {
      throw new ProtocolValidationError("message.wireVersion", "must be a positive safe integer");
    }
    return { kind, wireVersion: message.wireVersion as number };
  }
  if (kind === "response") {
    exact(message, "message", ["kind", "id", "result"]);
    if (!Number.isSafeInteger(message.id))
      throw new ProtocolValidationError("message.id", "must be a safe integer");
    return { kind, id: message.id as number, result: message.result };
  }
  if (kind === "error") {
    exact(message, "message", ["kind", "id", "code", "message"]);
    if (!Number.isSafeInteger(message.id))
      throw new ProtocolValidationError("message.id", "must be a safe integer");
    return {
      kind,
      id: message.id as number,
      code: string(message.code, "message.code"),
      message: string(message.message, "message.message"),
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
