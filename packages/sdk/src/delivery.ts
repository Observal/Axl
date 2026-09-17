// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  AssistantStopReason,
  EventId,
  OperationId,
  QueueRestoreResult,
  SessionId,
  UserContent,
} from "@axl/protocol";

import { type AxlClient, AxlClientError } from "./client.ts";

export type PromptDeliveryMode =
  | "prompt"
  | "steer"
  | "follow_up"
  | "interrupt"
  | "queue_front"
  | "queue_back";

export type PromptDeliveryOutcome =
  | {
      readonly state: "completed";
      readonly mode: "prompt" | "interrupt";
      readonly operationId: OperationId;
      readonly stopReason: AssistantStopReason;
    }
  | { readonly state: "accepted"; readonly mode: "steer" | "follow_up" }
  | {
      readonly state: "queued";
      readonly mode: "queue_front" | "queue_back" | "steer" | "follow_up";
      readonly queueItemId: EventId;
      readonly queueState: "queued" | "paused";
    }
  | { readonly state: "uncertain"; readonly mode: PromptDeliveryMode };

function uncertain(error: unknown): boolean {
  return (
    error instanceof AxlClientError &&
    ["disconnected", "connection_error", "reconnect_failed", "write_failed"].includes(error.code)
  );
}

export async function restoreQueuedPrompts(
  client: AxlClient,
  sessionId: SessionId,
  interrupt = false,
): Promise<QueueRestoreResult> {
  return client.request("session.queue.restore", { sessionId, interrupt });
}

export async function deliverPrompt(
  client: AxlClient,
  sessionId: SessionId,
  content: readonly UserContent[],
  mode: PromptDeliveryMode,
): Promise<PromptDeliveryOutcome> {
  try {
    if (mode === "prompt") {
      const result = await client.request("session.send", {
        sessionId,
        content,
        delivery: "prompt",
      });
      return { state: "completed", mode, ...result };
    }
    if (mode === "interrupt") {
      const result = await client.request("session.interruptAndDeliver", { sessionId, content });
      return { state: "completed", mode, ...result };
    }
    if (mode === "queue_front" || mode === "queue_back") {
      const result = await client.request("session.queue.enqueue", {
        sessionId,
        content,
        priority: mode === "queue_front" ? "front" : "back",
      });
      return { state: "queued", mode, queueItemId: result.queueItemId, queueState: result.state };
    }
    try {
      await client.request(mode === "steer" ? "session.steer" : "session.followUp", {
        sessionId,
        content,
      });
      return { state: "accepted", mode };
    } catch (error) {
      if (!(error instanceof AxlClientError) || error.code !== "operation_inactive") throw error;
      const result = await client.request("session.queue.enqueue", {
        sessionId,
        content,
        priority: mode === "steer" ? "front" : "back",
      });
      return { state: "queued", mode, queueItemId: result.queueItemId, queueState: result.state };
    }
  } catch (error) {
    if (uncertain(error)) return { state: "uncertain", mode };
    throw error;
  }
}
