// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type {
  CanonicalEvent,
  EventId,
  EventPayloadMap,
  JsonObject,
  JsonValue,
  OperationId,
  SessionActivityFrame,
  SessionId,
  SessionProfile,
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

export interface ProjectedOperation {
  readonly operationId: OperationId;
  readonly status: "running" | "waiting_interaction" | "succeeded" | "failed" | "aborted";
}

export interface UncertainShellOperation {
  readonly operationId: OperationId;
  readonly command: string;
}

export interface ProjectedQueueItem {
  readonly queueItemId: EventId;
  readonly operationId?: OperationId;
  readonly content: EventPayloadMap["queue.enqueued"]["content"];
  readonly priority: "front" | "back";
  readonly status: "queued" | "running" | "paused" | "completed" | "failed" | "aborted";
}

export interface ConversationState {
  readonly sessionId?: SessionId;
  readonly selectedNodeId?: EventId;
  readonly records: readonly ConversationRecord[];
  readonly tools: readonly ProjectedToolCall[];
  readonly interactions: readonly ProjectedInteraction[];
  readonly operations: readonly ProjectedOperation[];
  readonly activeOperationId?: OperationId;
  readonly uncertainShellOperations: readonly UncertainShellOperation[];
  readonly queue: readonly ProjectedQueueItem[];
  readonly model?: string;
  readonly provider?: string;
  readonly entitlement?: string;
  readonly thinking?: ThinkingLevel;
  readonly profile?: SessionProfile;
  readonly webFetch?: boolean;
  readonly webSearch?: boolean;
  readonly sandbox?: { readonly provider: string; readonly enforced: boolean };
  readonly usage: UsageTotals;
  readonly activity?: ProjectedActivity;
  readonly closed: boolean;
  readonly lastError?: CanonicalEvent<"session.error">;
  readonly lastCompaction?: CanonicalEvent<"context.compacted">;
}

/** Status and activity without materializing the accumulated conversation collections. */
export type ConversationOverview = Omit<
  ConversationState,
  "records" | "tools" | "interactions" | "operations" | "queue" | "uncertainShellOperations"
> & { readonly recordCount: number };

const MAX_PROJECTED_ACTIVITY_CHARACTERS = 131_072;
const ACTIVITY_TRIM_BATCH_CHARACTERS = 16_384;

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

function boundedActivityText(current: string, addition: string): string {
  const combined = current + addition;
  return combined.length <= MAX_PROJECTED_ACTIVITY_CHARACTERS + ACTIVITY_TRIM_BATCH_CHARACTERS
    ? combined
    : combined.slice(-MAX_PROJECTED_ACTIVITY_CHARACTERS);
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
  private readonly operations = new Map<OperationId, ProjectedOperation>();
  private readonly uncertainShellOperations = new Map<OperationId, UncertainShellOperation>();
  private readonly queue = new Map<EventId, ProjectedQueueItem>();
  private activeOperationId: OperationId | undefined;
  private model: string | undefined;
  private provider: string | undefined;
  private entitlement: string | undefined;
  private thinking: ThinkingLevel | undefined;
  private profile: SessionProfile | undefined;
  private webFetch: boolean | undefined;
  private webSearch: boolean | undefined;
  private sandbox: ConversationState["sandbox"];
  private usage: UsageTotals = EMPTY_USAGE;
  private activity: ProjectedActivity | undefined;
  private readonly activitySequences = new Map<OperationId, number>();
  private readonly retiredActivityOperations = new Set<OperationId>();
  private latestActivityOperationId: OperationId | undefined;
  private closed = false;
  private lastError: CanonicalEvent<"session.error"> | undefined;
  private lastCompaction: CanonicalEvent<"context.compacted"> | undefined;

  constructor(sessionId?: SessionId, selectedNodeId?: EventId) {
    this.expectedSessionId = sessionId;
    this.selectedNodeId = selectedNodeId;
  }

  get state(): ConversationState {
    const { recordCount: _recordCount, ...overview } = this.overview;
    return Object.freeze({
      ...overview,
      records: Object.freeze([...this.records]),
      tools: Object.freeze([...this.tools.values()]),
      interactions: Object.freeze([...this.interactions.values()]),
      operations: Object.freeze([...this.operations.values()]),
      uncertainShellOperations: Object.freeze([...this.uncertainShellOperations.values()]),
      queue: Object.freeze([...this.queue.values()]),
    });
  }

  get overview(): ConversationOverview {
    return Object.freeze({
      ...(this.expectedSessionId === undefined ? {} : { sessionId: this.expectedSessionId }),
      ...(this.selectedNodeId === undefined ? {} : { selectedNodeId: this.selectedNodeId }),
      recordCount: this.records.length,
      ...(this.activeOperationId === undefined
        ? {}
        : { activeOperationId: this.activeOperationId }),
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.provider === undefined ? {} : { provider: this.provider }),
      ...(this.entitlement === undefined ? {} : { entitlement: this.entitlement }),
      ...(this.thinking === undefined ? {} : { thinking: this.thinking }),
      ...(this.profile === undefined ? {} : { profile: this.profile }),
      ...(this.webFetch === undefined ? {} : { webFetch: this.webFetch }),
      ...(this.webSearch === undefined ? {} : { webSearch: this.webSearch }),
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
    const keepUncertainShells =
      sessionId === this.expectedSessionId && selectedNodeId === this.selectedNodeId;
    this.expectedSessionId = sessionId;
    this.selectedNodeId = selectedNodeId;
    this.records.length = 0;
    this.events.clear();
    this.tools.clear();
    this.interactions.clear();
    this.operations.clear();
    this.activeOperationId = undefined;
    if (!keepUncertainShells) this.uncertainShellOperations.clear();
    this.queue.clear();
    this.model = undefined;
    this.provider = undefined;
    this.entitlement = undefined;
    this.thinking = undefined;
    this.profile = undefined;
    this.webFetch = undefined;
    this.webSearch = undefined;
    this.sandbox = undefined;
    this.usage = EMPTY_USAGE;
    this.activity = undefined;
    this.activitySequences.clear();
    this.retiredActivityOperations.clear();
    this.latestActivityOperationId = undefined;
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
      case "user.message":
        this.updateOperation(event.operationId, "running");
        break;
      case "queue.enqueued":
        this.queue.set(event.id, {
          queueItemId: event.id,
          ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
          content: event.payload.content,
          priority: event.payload.priority,
          status: "queued",
        });
        break;
      case "queue.requeued":
        this.updateQueueItem(event.payload.queueItemId, {
          status: "queued",
          priority: event.payload.priority,
        });
        break;
      case "queue.started":
        this.updateQueueItem(event.payload.queueItemId, { status: "running" });
        this.updateOperation(event.operationId, "running");
        break;
      case "queue.paused":
        this.updateQueueItem(event.payload.queueItemId, { status: "paused" });
        break;
      case "user.shell":
        this.updateOperation(event.operationId, event.payload.isError ? "failed" : "succeeded");
        if (event.operationId !== undefined)
          this.uncertainShellOperations.delete(event.operationId);
        break;
      case "tool.call": {
        this.updateOperation(event.operationId, "running");
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
        this.updateOperation(event.operationId, "waiting_interaction");
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
        this.updateOperation(event.operationId, "running");
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
      case "config.profile":
        this.profile = event.payload.profile;
        break;
      case "config.tools":
        this.webFetch = event.payload.webFetch;
        this.webSearch = event.payload.webSearch;
        break;
      case "sandbox.configured":
        this.sandbox = { provider: event.payload.provider, enforced: event.payload.enforced };
        break;
      case "assistant.message":
        this.usage = addUsage(this.usage, event.payload.usage);
        if (event.payload.stopReason === "tool_use") {
          this.updateOperation(event.operationId, "running");
        } else {
          const status =
            event.payload.stopReason === "aborted"
              ? "aborted"
              : event.payload.stopReason === "error"
                ? "failed"
                : "succeeded";
          this.updateOperation(event.operationId, status);
          this.completeQueuedOperation(event.operationId, status);
          this.clearActivity(event.operationId);
        }
        break;
      case "context.compacted":
        this.usage = addUsage(this.usage, event.payload.usage);
        this.lastCompaction = event;
        break;
      case "session.error":
        this.lastError = event;
        this.updateOperation(event.operationId, "failed");
        this.completeQueuedOperation(event.operationId, "failed");
        this.clearActivity(event.operationId);
        break;
      case "session.closed":
        this.closed = true;
        this.updateOperation(event.operationId, "succeeded");
        this.activeOperationId = undefined;
        this.clearActivity(event.operationId);
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
    if (this.retiredActivityOperations.has(frame.operationId)) return false;
    const priorSequence = this.activitySequences.get(frame.operationId);
    if (priorSequence !== undefined) {
      if (frame.sequence <= priorSequence) return false;
      if (frame.sequence !== priorSequence + 1) {
        if (this.activity?.operationId === frame.operationId) this.activity = undefined;
        throw new ProjectionError(
          "activity_sequence_gap",
          `Transient activity sequence gap: expected ${priorSequence + 1}, received ${frame.sequence}`,
        );
      }
    } else if (frame.type !== "snapshot" && frame.sequence !== 0 && frame.sequence !== 1) {
      this.activity = undefined;
      throw new ProjectionError(
        "activity_sequence_gap",
        `Transient activity must start at sequence 0 or 1, received ${frame.sequence}`,
      );
    }

    if (
      this.latestActivityOperationId !== undefined &&
      this.latestActivityOperationId !== frame.operationId
    ) {
      this.retireActivity(this.latestActivityOperationId);
    }
    this.latestActivityOperationId = frame.operationId;
    if (this.activity === undefined || this.activity.operationId !== frame.operationId) {
      this.activity = {
        operationId: frame.operationId,
        sequence: frame.sequence - 1,
        text: "",
        thinking: "",
        toolCalls: [],
      };
    }
    this.rememberActivitySequence(frame.operationId, frame.sequence);
    const base = this.activity;
    if (frame.type === "clear") {
      this.activity = undefined;
    } else if (frame.type === "snapshot") {
      this.activity = {
        operationId: frame.operationId,
        sequence: frame.sequence,
        text: boundedActivityText("", frame.text),
        thinking: boundedActivityText("", frame.thinking),
        toolCalls: [...frame.toolCalls],
      };
    } else if (frame.type === "text_delta") {
      this.activity = {
        ...base,
        sequence: frame.sequence,
        text: boundedActivityText(base.text, frame.text),
      };
    } else if (frame.type === "thinking_delta") {
      this.activity = {
        ...base,
        sequence: frame.sequence,
        thinking: boundedActivityText(base.thinking, frame.text),
      };
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

  markShellUncertain(operationId: OperationId, command: string): void {
    this.uncertainShellOperations.set(operationId, { operationId, command });
  }

  private updateQueueItem(
    queueItemId: EventId,
    update: Pick<ProjectedQueueItem, "status"> & Partial<Pick<ProjectedQueueItem, "priority">>,
  ): void {
    const current = this.queue.get(queueItemId);
    if (current === undefined) {
      throw new ProjectionError("queue_identity_conflict", `Unknown queue item ${queueItemId}`);
    }
    this.queue.set(queueItemId, { ...current, ...update });
  }

  private completeQueuedOperation(
    operationId: OperationId | undefined,
    status: "succeeded" | "failed" | "aborted",
  ): void {
    if (operationId === undefined) return;
    for (const [queueItemId, item] of this.queue) {
      if (item.operationId === operationId && item.status === "running") {
        this.queue.set(queueItemId, {
          ...item,
          status: status === "succeeded" ? "completed" : status,
        });
      }
    }
  }

  private updateOperation(
    operationId: OperationId | undefined,
    status: ProjectedOperation["status"],
  ): void {
    if (operationId === undefined) return;
    this.operations.set(operationId, { operationId, status });
    if (status === "running" || status === "waiting_interaction") {
      this.activeOperationId = operationId;
    } else if (this.activeOperationId === operationId) {
      this.activeOperationId = undefined;
    }
  }

  resetActivity(): void {
    this.activity = undefined;
    this.activitySequences.clear();
    this.retiredActivityOperations.clear();
    this.latestActivityOperationId = undefined;
  }

  clearActivity(operationId?: OperationId): void {
    if (operationId === undefined) {
      if (this.latestActivityOperationId !== undefined) {
        this.retireActivity(this.latestActivityOperationId);
      }
      this.activity = undefined;
      this.latestActivityOperationId = undefined;
    } else {
      if (this.activity?.operationId === operationId) this.activity = undefined;
      this.retireActivity(operationId);
      if (this.latestActivityOperationId === operationId)
        this.latestActivityOperationId = undefined;
    }
  }

  private rememberActivitySequence(operationId: OperationId, sequence: number): void {
    this.activitySequences.delete(operationId);
    this.activitySequences.set(operationId, sequence);
    while (this.activitySequences.size > 128) {
      const oldest = this.activitySequences.keys().next().value;
      if (oldest === undefined) break;
      this.activitySequences.delete(oldest);
      this.retiredActivityOperations.delete(oldest);
    }
  }

  private retireActivity(operationId: OperationId): void {
    this.retiredActivityOperations.add(operationId);
    this.rememberActivitySequence(
      operationId,
      this.activitySequences.get(operationId) ?? this.activity?.sequence ?? 0,
    );
  }
}
