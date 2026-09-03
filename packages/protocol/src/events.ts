// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import {
  type EventEnvelope,
  type EventId,
  type JsonObject,
  type JsonValue,
  type SessionId,
  parseEventEnvelope,
  parseEventId,
  parseSessionId,
  ProtocolValidationError,
} from "./event-envelope.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type PermissionDecision = "allow_once" | "allow_session" | "deny";
export type InteractionAction = "accept" | "decline" | "cancel";
export type InteractionKind =
  | "mcp_tool"
  | "mcp_sampling_request"
  | "mcp_sampling_response"
  | "mcp_elicitation_form"
  | "mcp_elicitation_url";
export type SessionCloseReason = "completed" | "disposed" | "failed";
export type AssistantStopReason = "stop" | "length" | "tool_use" | "error" | "aborted";
export type ChildStatus = "completed" | "failed" | "aborted";
/** Why the provider-visible tool roster was (re)rendered — each is a deliberate prompt-cache break. */
export type DialectBoundaryReason = "session_start" | "model_switch" | "tool_change" | "reload";

export type BlobReference = {
  readonly sha256: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly name?: string;
};

export type TextContent = { readonly type: "text"; readonly text: string };
export type ThinkingContent = { readonly type: "thinking"; readonly text: string };
export type BlobContent = { readonly type: "blob"; readonly blob: BlobReference };
export type UserContent = TextContent | BlobContent;
export type AssistantContent = TextContent | ThinkingContent | BlobContent;

export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens?: number;
  readonly costUsd?: number;
};

export type EventPayloadMap = {
  "session.created": { readonly cwd: string; readonly parentSessionId?: SessionId };
  "session.resumed": Record<string, never>;
  "session.closed": { readonly reason: SessionCloseReason };
  "user.message": { readonly content: readonly UserContent[] };
  "user.shell": {
    readonly command: string;
    readonly content: readonly UserContent[];
    readonly isError: boolean;
    readonly excluded: boolean;
  };
  "assistant.message": {
    readonly content: readonly AssistantContent[];
    readonly stopReason: AssistantStopReason;
    readonly usage?: Usage;
    readonly errorMessage?: string;
  };
  "tool.call": { readonly callId: string; readonly name: string; readonly input: JsonObject };
  "tool.result": {
    readonly callId: string;
    readonly name: string;
    readonly content: readonly UserContent[];
    readonly isError: boolean;
    readonly details?: JsonValue;
  };
  "config.model": { readonly modelId: string };
  "config.provider": { readonly providerId: string };
  "config.entitlement": { readonly entitlementId: string };
  "config.thinking": {
    readonly requested: ThinkingLevel;
    readonly effective: ThinkingLevel;
    readonly clamped: boolean;
  };
  "config.tools": {
    readonly webFetch: boolean;
    readonly webSearch: boolean;
  };
  "config.dialect": {
    readonly dialectId: string;
    readonly rosterFingerprint: string;
    readonly reason: DialectBoundaryReason;
  };
  "prompt.section": { readonly name: string; readonly source: string; readonly content: string };
  "tool.schema": {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonObject;
  };
  "context.injected": { readonly source: string; readonly content: string };
  "context.extension": {
    readonly extensionId: string;
    readonly source: string;
    readonly content: string;
  };
  "permission.requested": { readonly capability: string; readonly description: string };
  "permission.resolved": {
    readonly requestId: EventId;
    readonly decision: PermissionDecision;
    readonly reason?: string;
  };
  "interaction.requested": {
    readonly interactionId: string;
    readonly kind: InteractionKind;
    readonly source: string;
    readonly message: string;
    readonly data?: JsonObject;
  };
  "interaction.resolved": {
    readonly interactionId: string;
    readonly action: InteractionAction;
    readonly content?: JsonObject;
  };
  "sandbox.configured": {
    readonly provider: string;
    readonly enforced: boolean;
    readonly controls: readonly string[];
    readonly details?: JsonObject;
  };
  "sandbox.violation": { readonly capability: string; readonly reason: string };
  "context.compacted": {
    readonly summary: string;
    readonly replacedEventIds: readonly EventId[];
    readonly usage?: Usage;
  };
  "session.error": {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: JsonValue;
  };
  "child.result": {
    readonly childSessionId: SessionId;
    readonly status: ChildStatus;
    readonly result?: JsonValue;
  };
};

export type EventType = keyof EventPayloadMap;
export type CanonicalEvent<Type extends EventType = EventType> = {
  [CurrentType in Type]: EventEnvelope<CurrentType, EventPayloadMap[CurrentType]>;
}[Type];

type PayloadParser = (payload: JsonObject, path: string) => JsonObject;

function validationError(path: string, message: string): never {
  throw new ProtocolValidationError(path, message);
}

function exact(
  value: JsonObject,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) validationError(`${path}.${key}`, "is not allowed");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) validationError(`${path}.${key}`, "is required");
  }
}

function string(value: JsonValue | undefined, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    validationError(path, allowEmpty ? "must be a string" : "must be a non-empty string");
  }
  return value;
}

function boolean(value: JsonValue | undefined, path: string): boolean {
  if (typeof value !== "boolean") validationError(path, "must be a boolean");
  return value;
}

function nonNegativeInteger(value: JsonValue | undefined, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    validationError(path, "must be a non-negative safe integer");
  }
  return value as number;
}

function nonNegativeNumber(value: JsonValue | undefined, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    validationError(path, "must be a non-negative finite number");
  }
  return value;
}

function choice<const Values extends readonly string[]>(
  value: JsonValue | undefined,
  path: string,
  values: Values,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    validationError(path, `must be one of: ${values.join(", ")}`);
  }
  return value as Values[number];
}

function object(value: JsonValue | undefined, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    validationError(path, "must be an object");
  }
  return value as JsonObject;
}

function array(value: JsonValue | undefined, path: string): readonly JsonValue[] {
  if (!Array.isArray(value)) validationError(path, "must be an array");
  return value;
}

function optionalString(value: JsonValue | undefined, path: string): void {
  if (value !== undefined) string(value, path);
}

function validateBlob(value: JsonValue, path: string): void {
  const blob = object(value, path);
  exact(blob, path, ["sha256", "mediaType", "sizeBytes"], ["name"]);
  const digest = string(blob.sha256, `${path}.sha256`);
  if (!/^[0-9a-f]{64}$/.test(digest))
    validationError(`${path}.sha256`, "must be a lowercase SHA-256 digest");
  string(blob.mediaType, `${path}.mediaType`);
  nonNegativeInteger(blob.sizeBytes, `${path}.sizeBytes`);
  optionalString(blob.name, `${path}.name`);
}

export function parseBlobReference(value: unknown, path = "blob"): BlobReference {
  validateBlob(value as JsonValue, path);
  return value as BlobReference;
}

function validateContent(value: JsonValue | undefined, path: string, assistant: boolean): void {
  for (const [index, item] of array(value, path).entries()) {
    const itemPath = `${path}[${index}]`;
    const content = object(item, itemPath);
    const type = string(content.type, `${itemPath}.type`);
    if (type === "text" || (assistant && type === "thinking")) {
      exact(content, itemPath, ["type", "text"]);
      string(content.text, `${itemPath}.text`, true);
    } else if (type === "blob") {
      exact(content, itemPath, ["type", "blob"]);
      validateBlob(content.blob as JsonValue, `${itemPath}.blob`);
    } else {
      validationError(`${itemPath}.type`, "is not allowed for this message");
    }
  }
}

export function parseUserContent(value: unknown, path = "content"): readonly UserContent[] {
  validateContent(value as JsonValue | undefined, path, false);
  return value as readonly UserContent[];
}

function validateUsage(value: JsonValue, path: string): void {
  const usage = object(value, path);
  exact(
    usage,
    path,
    ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"],
    ["reasoningTokens", "costUsd"],
  );
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    nonNegativeInteger(usage[key], `${path}.${key}`);
  }
  if (usage.reasoningTokens !== undefined)
    nonNegativeInteger(usage.reasoningTokens, `${path}.reasoningTokens`);
  if (usage.costUsd !== undefined) nonNegativeNumber(usage.costUsd, `${path}.costUsd`);
}

function validateStringArray(value: JsonValue | undefined, path: string): void {
  for (const [index, item] of array(value, path).entries()) string(item, `${path}[${index}]`);
}

function validateEventIds(value: JsonValue | undefined, path: string): void {
  for (const [index, item] of array(value, path).entries()) parseEventId(item, `${path}[${index}]`);
}

const payloadParsers: { readonly [Type in EventType]: PayloadParser } = {
  "session.created": (payload, path) => {
    exact(payload, path, ["cwd"], ["parentSessionId"]);
    string(payload.cwd, `${path}.cwd`);
    if (payload.parentSessionId !== undefined)
      parseSessionId(payload.parentSessionId, `${path}.parentSessionId`);
    return payload;
  },
  "session.resumed": (payload, path) => {
    exact(payload, path, []);
    return payload;
  },
  "session.closed": (payload, path) => {
    exact(payload, path, ["reason"]);
    choice(payload.reason, `${path}.reason`, ["completed", "disposed", "failed"]);
    return payload;
  },
  "user.message": (payload, path) => {
    exact(payload, path, ["content"]);
    validateContent(payload.content, `${path}.content`, false);
    return payload;
  },
  "user.shell": (payload, path) => {
    exact(payload, path, ["command", "content", "isError", "excluded"]);
    string(payload.command, `${path}.command`);
    validateContent(payload.content, `${path}.content`, false);
    boolean(payload.isError, `${path}.isError`);
    boolean(payload.excluded, `${path}.excluded`);
    return payload;
  },
  "assistant.message": (payload, path) => {
    exact(payload, path, ["content", "stopReason"], ["usage", "errorMessage"]);
    validateContent(payload.content, `${path}.content`, true);
    const stopReason = choice(payload.stopReason, `${path}.stopReason`, [
      "stop",
      "length",
      "tool_use",
      "error",
      "aborted",
    ]);
    if (payload.usage !== undefined) validateUsage(payload.usage, `${path}.usage`);
    optionalString(payload.errorMessage, `${path}.errorMessage`);
    if (stopReason === "error" && payload.errorMessage === undefined) {
      validationError(`${path}.errorMessage`, "is required when stopReason is error");
    }
    return payload;
  },
  "tool.call": (payload, path) => {
    exact(payload, path, ["callId", "name", "input"]);
    string(payload.callId, `${path}.callId`);
    string(payload.name, `${path}.name`);
    object(payload.input, `${path}.input`);
    return payload;
  },
  "tool.result": (payload, path) => {
    exact(payload, path, ["callId", "name", "content", "isError"], ["details"]);
    string(payload.callId, `${path}.callId`);
    string(payload.name, `${path}.name`);
    validateContent(payload.content, `${path}.content`, false);
    boolean(payload.isError, `${path}.isError`);
    return payload;
  },
  "config.model": (payload, path) => {
    exact(payload, path, ["modelId"]);
    string(payload.modelId, `${path}.modelId`);
    return payload;
  },
  "config.provider": (payload, path) => {
    exact(payload, path, ["providerId"]);
    string(payload.providerId, `${path}.providerId`);
    return payload;
  },
  "config.entitlement": (payload, path) => {
    exact(payload, path, ["entitlementId"]);
    string(payload.entitlementId, `${path}.entitlementId`);
    return payload;
  },
  "config.thinking": (payload, path) => {
    exact(payload, path, ["requested", "effective", "clamped"]);
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
    choice(payload.requested, `${path}.requested`, levels);
    choice(payload.effective, `${path}.effective`, levels);
    boolean(payload.clamped, `${path}.clamped`);
    return payload;
  },
  "config.tools": (payload, path) => {
    exact(payload, path, ["webFetch", "webSearch"]);
    boolean(payload.webFetch, `${path}.webFetch`);
    boolean(payload.webSearch, `${path}.webSearch`);
    return payload;
  },
  "config.dialect": (payload, path) => {
    exact(payload, path, ["dialectId", "rosterFingerprint", "reason"]);
    string(payload.dialectId, `${path}.dialectId`);
    string(payload.rosterFingerprint, `${path}.rosterFingerprint`);
    choice(payload.reason, `${path}.reason`, [
      "session_start",
      "model_switch",
      "tool_change",
      "reload",
    ]);
    return payload;
  },
  "prompt.section": (payload, path) => {
    exact(payload, path, ["name", "source", "content"]);
    string(payload.name, `${path}.name`);
    string(payload.source, `${path}.source`);
    string(payload.content, `${path}.content`, true);
    return payload;
  },
  "tool.schema": (payload, path) => {
    exact(payload, path, ["name", "description", "inputSchema"]);
    string(payload.name, `${path}.name`);
    string(payload.description, `${path}.description`, true);
    object(payload.inputSchema, `${path}.inputSchema`);
    return payload;
  },
  "context.injected": (payload, path) => {
    exact(payload, path, ["source", "content"]);
    string(payload.source, `${path}.source`);
    string(payload.content, `${path}.content`, true);
    return payload;
  },
  "context.extension": (payload, path) => {
    exact(payload, path, ["extensionId", "source", "content"]);
    string(payload.extensionId, `${path}.extensionId`);
    string(payload.source, `${path}.source`);
    string(payload.content, `${path}.content`, true);
    return payload;
  },
  "permission.requested": (payload, path) => {
    exact(payload, path, ["capability", "description"]);
    string(payload.capability, `${path}.capability`);
    string(payload.description, `${path}.description`);
    return payload;
  },
  "permission.resolved": (payload, path) => {
    exact(payload, path, ["requestId", "decision"], ["reason"]);
    parseEventId(payload.requestId, `${path}.requestId`);
    choice(payload.decision, `${path}.decision`, ["allow_once", "allow_session", "deny"]);
    optionalString(payload.reason, `${path}.reason`);
    return payload;
  },
  "interaction.requested": (payload, path) => {
    exact(payload, path, ["interactionId", "kind", "source", "message"], ["data"]);
    string(payload.interactionId, `${path}.interactionId`);
    choice(payload.kind, `${path}.kind`, [
      "mcp_tool",
      "mcp_sampling_request",
      "mcp_sampling_response",
      "mcp_elicitation_form",
      "mcp_elicitation_url",
    ]);
    string(payload.source, `${path}.source`);
    string(payload.message, `${path}.message`);
    if (payload.data !== undefined) object(payload.data, `${path}.data`);
    return payload;
  },
  "interaction.resolved": (payload, path) => {
    exact(payload, path, ["interactionId", "action"], ["content"]);
    string(payload.interactionId, `${path}.interactionId`);
    choice(payload.action, `${path}.action`, ["accept", "decline", "cancel"]);
    if (payload.content !== undefined) object(payload.content, `${path}.content`);
    return payload;
  },
  "sandbox.configured": (payload, path) => {
    exact(payload, path, ["provider", "enforced", "controls"], ["details"]);
    string(payload.provider, `${path}.provider`);
    boolean(payload.enforced, `${path}.enforced`);
    validateStringArray(payload.controls, `${path}.controls`);
    if (payload.details !== undefined) object(payload.details, `${path}.details`);
    return payload;
  },
  "sandbox.violation": (payload, path) => {
    exact(payload, path, ["capability", "reason"]);
    string(payload.capability, `${path}.capability`);
    string(payload.reason, `${path}.reason`);
    return payload;
  },
  "context.compacted": (payload, path) => {
    exact(payload, path, ["summary", "replacedEventIds"], ["usage"]);
    string(payload.summary, `${path}.summary`);
    validateEventIds(payload.replacedEventIds, `${path}.replacedEventIds`);
    if ((payload.replacedEventIds as readonly JsonValue[]).length === 0) {
      validationError(`${path}.replacedEventIds`, "must not be empty");
    }
    if (payload.usage !== undefined) validateUsage(payload.usage, `${path}.usage`);
    return payload;
  },
  "session.error": (payload, path) => {
    exact(payload, path, ["code", "message", "retryable"], ["details"]);
    string(payload.code, `${path}.code`);
    string(payload.message, `${path}.message`);
    boolean(payload.retryable, `${path}.retryable`);
    return payload;
  },
  "child.result": (payload, path) => {
    exact(payload, path, ["childSessionId", "status"], ["result"]);
    parseSessionId(payload.childSessionId, `${path}.childSessionId`);
    choice(payload.status, `${path}.status`, ["completed", "failed", "aborted"]);
    return payload;
  },
};

export const EVENT_TYPES = Object.freeze(Object.keys(payloadParsers) as EventType[]);

export function parseEvent(value: unknown): CanonicalEvent {
  const event = parseEventEnvelope(value);
  if (!Object.hasOwn(payloadParsers, event.type)) {
    validationError("event.type", "is not a recognized event type");
  }
  const type = event.type as EventType;
  const payload = payloadParsers[type](
    event.payload,
    "event.payload",
  ) as EventPayloadMap[typeof type];
  return { ...event, type, payload } as CanonicalEvent;
}
