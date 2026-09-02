// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { EventId, JsonObject, SessionId } from "./event-envelope.ts";
import { ProtocolValidationError, parseEventId, parseSessionId } from "./event-envelope.ts";
import type { CanonicalEvent, InteractionAction, ThinkingLevel, UserContent } from "./events.ts";
import { parseEvent, parseUserContent } from "./events.ts";

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
      readonly params: { readonly cwd: string } & SessionModelSelection;
    }
  | {
      readonly kind: "request";
      readonly id: number;
      readonly method: "session.resume";
      readonly params: { readonly sessionId: SessionId };
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
      readonly method: "session.send";
      readonly params: { readonly sessionId: SessionId; readonly content: readonly UserContent[] };
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
      readonly params: { readonly sessionId: SessionId } & SessionModelSelection;
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

export interface WireHello {
  readonly kind: "hello";
  readonly wireVersion: number;
}

export type ServerMessage = WireResponse | WireError | WireEvent | WireHello;

export interface SessionSnapshot {
  readonly sessionId: SessionId;
  readonly events: readonly CanonicalEvent[];
}

export interface SessionForkResult extends SessionSnapshot {
  readonly selectedText?: string;
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

  if (method === "daemon.info") {
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
  if (method === "session.resume" || method === "session.clone") {
    exact(params, "request.params", ["sessionId"]);
    return {
      ...base,
      method,
      params: { sessionId: parseSessionId(params.sessionId, "request.params.sessionId") },
    };
  }
  if (method === "session.list") {
    exact(params, "request.params", []);
    return { ...base, method, params: {} };
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
  throw new ProtocolValidationError("message.kind", `unknown message kind ${JSON.stringify(kind)}`);
}

export function encodeWireMessage(message: ServerMessage | WireRequest): string {
  return `${JSON.stringify(message)}\n`;
}
