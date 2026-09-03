// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  CanonicalEvent,
  EventId,
  JsonObject,
  JsonValue,
  OperationId,
  SessionActivityFrame,
  SessionId,
  ThinkingLevel,
  Usage,
} from "@axl/protocol";

export interface GenericEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly operationId?: string;
  readonly timestamp: number;
  readonly type: string;
  readonly payload: JsonObject;
}

export type ConversationRecord =
  | { readonly kind: "event"; readonly event: CanonicalEvent }
  | { readonly kind: "unknown_event"; readonly event: GenericEvent };

export interface ProjectedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonObject;
  readonly callEventId: EventId;
  readonly operationId?: OperationId;
  readonly result?: {
    readonly eventId: EventId;
    readonly content: CanonicalEvent<"tool.result">["payload"]["content"];
    readonly isError: boolean;
    readonly details?: JsonValue;
  };
  readonly renderIntent:
    | "shell"
    | "read"
    | "edit"
    | "search"
    | "web"
    | "mcp"
    | "workflow"
    | "generic";
}

export interface ProjectedInteraction {
  readonly interactionId: string;
  readonly request: CanonicalEvent<"interaction.requested">;
  readonly resolution?: CanonicalEvent<"interaction.resolved">;
}

export interface ProjectedActivity {
  readonly operationId: OperationId;
  readonly sequence: number;
  readonly text: string;
  readonly thinking: string;
  readonly toolCalls: readonly { readonly callId: string; readonly name: string }[];
}

export interface UsageTotals extends Usage {
  readonly reasoningTokens: number;
  readonly costUsd: number;
}

export interface ConversationState {
  readonly sessionId?: SessionId;
  readonly selectedNodeId?: EventId;
  readonly records: readonly ConversationRecord[];
  readonly tools: readonly ProjectedToolCall[];
  readonly interactions: readonly ProjectedInteraction[];
  readonly model?: string;
  readonly provider?: string;
  readonly entitlement?: string;
  readonly thinking?: ThinkingLevel;
  readonly sandbox?: { readonly provider: string; readonly enforced: boolean };
  readonly usage: UsageTotals;
  readonly activity?: ProjectedActivity;
  readonly closed: boolean;
  readonly lastError?: CanonicalEvent<"session.error">;
  readonly lastCompaction?: CanonicalEvent<"context.compacted">;
}

const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
};

export class ProjectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectionError";
    this.code = code;
  }
}

function renderIntent(name: string): ProjectedToolCall["renderIntent"] {
  const normalized = name.toLowerCase();
  if (normalized === "shell" || normalized.includes("terminal")) return "shell";
  if (normalized === "read" || normalized.includes("read_file")) return "read";
  if (normalized === "edit" || normalized.includes("write") || normalized.includes("diff")) {
    return "edit";
  }
  if (normalized.includes("search") || normalized.includes("grep")) return "search";
  if (normalized.includes("web") || normalized.includes("fetch")) return "web";
  if (normalized.startsWith("mcp") || normalized.includes("__")) return "mcp";
  if (normalized.includes("workflow")) return "workflow";
  return "generic";
}

function addUsage(total: UsageTotals, usage: Usage | undefined): UsageTotals {
  if (usage === undefined) return total;
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
    reasoningTokens: total.reasoningTokens + (usage.reasoningTokens ?? 0),
    costUsd: total.costUsd + (usage.costUsd ?? 0),
  };
}

/** Deterministic, framework-neutral reduction of one selected session lineage. */
export class ConversationProjector {
  private expectedSessionId: SessionId | undefined;
  private selectedNodeId: EventId | undefined;
  private readonly records: ConversationRecord[] = [];
  private readonly events = new Map<string, string>();
  private readonly tools = new Map<string, ProjectedToolCall>();
  private readonly interactions = new Map<string, ProjectedInteraction>();
  private model: string | undefined;
  private provider: string | undefined;
  private entitlement: string | undefined;
  private thinking: ThinkingLevel | undefined;
  private sandbox: ConversationState["sandbox"];
  private usage: UsageTotals = EMPTY_USAGE;
  private activity: ProjectedActivity | undefined;
  private closed = false;
  private lastError: CanonicalEvent<"session.error"> | undefined;
  private lastCompaction: CanonicalEvent<"context.compacted"> | undefined;

  constructor(sessionId?: SessionId, selectedNodeId?: EventId) {
    this.expectedSessionId = sessionId;
    this.selectedNodeId = selectedNodeId;
  }

  get state(): ConversationState {
    return Object.freeze({
      ...(this.expectedSessionId === undefined ? {} : { sessionId: this.expectedSessionId }),
      ...(this.selectedNodeId === undefined ? {} : { selectedNodeId: this.selectedNodeId }),
      records: Object.freeze([...this.records]),
      tools: Object.freeze([...this.tools.values()]),
      interactions: Object.freeze([...this.interactions.values()]),
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.provider === undefined ? {} : { provider: this.provider }),
      ...(this.entitlement === undefined ? {} : { entitlement: this.entitlement }),
      ...(this.thinking === undefined ? {} : { thinking: this.thinking }),
      ...(this.sandbox === undefined ? {} : { sandbox: this.sandbox }),
      usage: this.usage,
      ...(this.activity === undefined ? {} : { activity: this.activity }),
      closed: this.closed,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.lastCompaction === undefined ? {} : { lastCompaction: this.lastCompaction }),
    });
  }

  replace(
    events: readonly CanonicalEvent[],
    sessionId?: SessionId,
    selectedNodeId?: EventId,
  ): void {
    this.reset(sessionId, selectedNodeId);
    for (const event of events) this.applyEvent(event);
  }

  reset(sessionId = this.expectedSessionId, selectedNodeId = this.selectedNodeId): void {
    this.expectedSessionId = sessionId;
    this.selectedNodeId = selectedNodeId;
    this.records.length = 0;
    this.events.clear();
    this.tools.clear();
    this.interactions.clear();
    this.model = undefined;
    this.provider = undefined;
    this.entitlement = undefined;
    this.thinking = undefined;
    this.sandbox = undefined;
    this.usage = EMPTY_USAGE;
    this.activity = undefined;
    this.closed = false;
    this.lastError = undefined;
    this.lastCompaction = undefined;
  }

  applyEvent(event: CanonicalEvent): boolean {
    if (this.expectedSessionId === undefined) this.expectedSessionId = event.sessionId;
    if (event.sessionId !== this.expectedSessionId) {
      throw new ProjectionError("session_mismatch", "Event belongs to another session");
    }
    const encoded = JSON.stringify(event);
    const prior = this.events.get(event.id);
    if (prior !== undefined) {
      if (prior !== encoded) {
        throw new ProjectionError("altered_duplicate", `Event ${event.id} changed in transit`);
      }
      return false;
    }
    if (event.parentId !== null && !this.events.has(event.parentId)) {
      throw new ProjectionError("missing_parent", `Event ${event.id} has a missing parent`);
    }
    this.events.set(event.id, encoded);
    this.records.push({ kind: "event", event });

    switch (event.type) {
      case "tool.call": {
        if (this.tools.has(event.payload.callId)) {
          throw new ProjectionError(
            "tool_identity_conflict",
            `Duplicate tool call ${event.payload.callId}`,
          );
        }
        this.tools.set(event.payload.callId, {
          callId: event.payload.callId,
          name: event.payload.name,
          input: event.payload.input,
          callEventId: event.id,
          ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
          renderIntent: renderIntent(event.payload.name),
        });
        const activity = this.activity;
        if (activity !== undefined && activity.operationId === event.operationId) {
          const remaining = activity.toolCalls.filter(
            (call) => call.callId !== event.payload.callId,
          );
          this.activity = { ...activity, toolCalls: remaining };
        }
        break;
      }
      case "tool.result": {
        const call = this.tools.get(event.payload.callId);
        if (call === undefined || call.name !== event.payload.name || call.result !== undefined) {
          throw new ProjectionError(
            "tool_identity_conflict",
            `Tool result ${event.payload.callId} has no matching call`,
          );
        }
        this.tools.set(event.payload.callId, {
          ...call,
          result: {
            eventId: event.id,
            content: event.payload.content,
            isError: event.payload.isError,
            ...(event.payload.details === undefined ? {} : { details: event.payload.details }),
          },
        });
        break;
      }
      case "interaction.requested":
        if (this.interactions.has(event.payload.interactionId)) {
          throw new ProjectionError(
            "interaction_identity_conflict",
            `Duplicate interaction ${event.payload.interactionId}`,
          );
        }
        this.interactions.set(event.payload.interactionId, {
          interactionId: event.payload.interactionId,
          request: event,
        });
        break;
      case "interaction.resolved": {
        const interaction = this.interactions.get(event.payload.interactionId);
        if (interaction === undefined || interaction.resolution !== undefined) {
          throw new ProjectionError(
            "interaction_identity_conflict",
            `Interaction ${event.payload.interactionId} cannot be resolved`,
          );
        }
        this.interactions.set(event.payload.interactionId, { ...interaction, resolution: event });
        break;
      }
      case "config.model":
        this.model = event.payload.modelId;
        break;
      case "config.provider":
        this.provider = event.payload.providerId;
        break;
      case "config.entitlement":
        this.entitlement = event.payload.entitlementId;
        break;
      case "config.thinking":
        this.thinking = event.payload.effective;
        break;
      case "sandbox.configured":
        this.sandbox = { provider: event.payload.provider, enforced: event.payload.enforced };
        break;
      case "assistant.message":
        this.usage = addUsage(this.usage, event.payload.usage);
        if (event.payload.stopReason === "aborted" || event.payload.stopReason === "error") {
          this.clearActivity(event.operationId);
        } else this.clearActivity(event.operationId);
        break;
      case "context.compacted":
        this.usage = addUsage(this.usage, event.payload.usage);
        this.lastCompaction = event;
        break;
      case "session.error":
        this.lastError = event;
        this.clearActivity(event.operationId);
        break;
      case "session.closed":
        this.closed = true;
        this.activity = undefined;
        break;
      default:
        break;
    }
    return true;
  }

  applyUnknownEvent(event: GenericEvent): boolean {
    if (this.expectedSessionId !== undefined && event.sessionId !== this.expectedSessionId) {
      throw new ProjectionError("session_mismatch", "Event belongs to another session");
    }
    const encoded = JSON.stringify(event);
    const prior = this.events.get(event.id);
    if (prior !== undefined) {
      if (prior !== encoded)
        throw new ProjectionError("altered_duplicate", "Unknown event changed");
      return false;
    }
    if (event.parentId !== null && !this.events.has(event.parentId)) {
      throw new ProjectionError("missing_parent", `Event ${event.id} has a missing parent`);
    }
    this.events.set(event.id, encoded);
    this.records.push({ kind: "unknown_event", event });
    return true;
  }

  applyActivity(frame: SessionActivityFrame): boolean {
    const current = this.activity;
    if (current !== undefined && current.operationId === frame.operationId) {
      if (frame.sequence <= current.sequence) return false;
      if (frame.sequence !== current.sequence + 1) {
        this.activity = undefined;
        throw new ProjectionError(
          "activity_sequence_gap",
          "Transient activity requires a snapshot",
        );
      }
    }
    if (current === undefined || current.operationId !== frame.operationId) {
      if (frame.type !== "snapshot" && frame.sequence !== 0 && frame.sequence !== 1) {
        this.activity = undefined;
        throw new ProjectionError(
          "activity_sequence_gap",
          "Transient activity requires a snapshot",
        );
      }
      this.activity = {
        operationId: frame.operationId,
        sequence: frame.sequence - 1,
        text: "",
        thinking: "",
        toolCalls: [],
      };
    }
    const base = this.activity as ProjectedActivity;
    if (frame.type === "clear") {
      this.activity = undefined;
    } else if (frame.type === "snapshot") {
      this.activity = {
        operationId: frame.operationId,
        sequence: frame.sequence,
        text: frame.text,
        thinking: frame.thinking,
        toolCalls: [...frame.toolCalls],
      };
    } else if (frame.type === "text_delta") {
      this.activity = { ...base, sequence: frame.sequence, text: base.text + frame.text };
    } else if (frame.type === "thinking_delta") {
      this.activity = { ...base, sequence: frame.sequence, thinking: base.thinking + frame.text };
    } else if (frame.type === "tool_call") {
      this.activity = base.toolCalls.some((call) => call.callId === frame.call.callId)
        ? { ...base, sequence: frame.sequence }
        : {
            ...base,
            sequence: frame.sequence,
            toolCalls: [...base.toolCalls, frame.call],
          };
    }
    return true;
  }

  clearActivity(operationId?: OperationId): void {
    if (operationId === undefined || this.activity?.operationId === operationId) {
      this.activity = undefined;
    }
  }
}
