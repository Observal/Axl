// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { CanonicalEvent, EventType, JsonObject } from "@axl/protocol";

export type EventPresentationSurface =
  | "transcript"
  | "interaction"
  | "status"
  | "state"
  | "internal"
  | "paired";

/**
 * Exhaustive presentation policy for canonical events. Adding an event to the
 * protocol requires an explicit client-facing classification here.
 */
export const EVENT_PRESENTATION_SURFACES = Object.freeze({
  "session.created": "state",
  "session.resumed": "state",
  "session.renamed": "state",
  "session.closed": "transcript",
  "user.message": "transcript",
  "queue.enqueued": "transcript",
  "queue.requeued": "transcript",
  "queue.started": "transcript",
  "queue.paused": "transcript",
  "queue.restored": "transcript",
  "interrupt.requested": "transcript",
  "interrupt.updated": "paired",
  "user.shell": "transcript",
  "assistant.message": "transcript",
  "model.retry_scheduled": "status",
  "tool.call": "transcript",
  "tool.result": "paired",
  "config.request": "state",
  "config.compaction": "state",
  "model.request_configured": "state",
  "config.model": "status",
  "config.provider": "status",
  "config.entitlement": "state",
  "config.profile": "state",
  "config.thinking": "status",
  "config.tools": "state",
  "config.dialect": "status",
  "prompt.section": "internal",
  "context.resources": "state",
  "tool.schema": "internal",
  "context.injected": "transcript",
  "extension.state": "internal",
  "extension.label": "internal",
  "extension.event": "internal",
  "context.extension": "internal",
  "capability.searched": "state",
  "capability.activated": "state",
  "capability.denied": "state",
  "permission.requested": "interaction",
  "permission.resolved": "interaction",
  "interaction.requested": "interaction",
  "interaction.resolved": "paired",
  "sandbox.configured": "status",
  "sandbox.violation": "transcript",
  "compaction.queued": "status",
  "compaction.started": "status",
  "compaction.failed": "transcript",
  "context.compacted": "transcript",
  "session.error": "transcript",
  "child.result": "transcript",
} as const satisfies Readonly<Record<EventType, EventPresentationSurface>>);

export type CanonicalPresentationItem<Type extends EventType = EventType> = Type extends EventType
  ? {
      readonly kind: Type;
      readonly surface: (typeof EVENT_PRESENTATION_SURFACES)[Type];
      readonly event: CanonicalEvent<Type>;
    }
  : never;

export interface GenericEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly operationId?: string;
  readonly timestamp: number;
  readonly type: string;
  readonly payload: JsonObject;
}

export interface UnknownPresentationItem {
  readonly kind: "unknown_event";
  readonly surface: "transcript";
  readonly event: GenericEvent;
}

export type ConversationPresentationItem = CanonicalPresentationItem | UnknownPresentationItem;

export function presentCanonicalEvent<Type extends EventType>(
  event: CanonicalEvent<Type>,
): CanonicalPresentationItem<Type> {
  return Object.freeze({
    kind: event.type,
    surface: EVENT_PRESENTATION_SURFACES[event.type],
    event,
  }) as CanonicalPresentationItem<Type>;
}

export function presentUnknownEvent(event: GenericEvent): UnknownPresentationItem {
  return Object.freeze({ kind: "unknown_event", surface: "transcript", event });
}
