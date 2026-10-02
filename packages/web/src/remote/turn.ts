// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/** What the phone says about a running turn: its stage and how long it has been running. */

import type { ConversationState, ProjectedInteraction } from "@axl/sdk";

/** The agent's questions to the user can be answered from the phone; approvals cannot. */
export function phoneCanAnswer(interaction: ProjectedInteraction): boolean {
  return interaction.request.payload.kind === "user_question";
}

/** What the running turn is doing, in a few words; undefined when nothing runs. */
export function turnStage(state: ConversationState): string | undefined {
  const operation = state.activeOperationId;
  if (operation === undefined) return undefined;
  const activity = state.activity?.operationId === operation ? state.activity : undefined;
  const status = state.operations.find((entry) => entry.operationId === operation)?.status;
  if (status === "waiting_interaction") {
    const waiting = state.interactions.filter(
      (interaction) =>
        interaction.resolution === undefined && interaction.request.operationId === operation,
    );
    return waiting.some(phoneCanAnswer)
      ? "Waiting for your answer"
      : "Waiting for approval on the computer";
  }
  const running = state.tools.filter(
    (tool) => tool.operationId === operation && tool.result === undefined,
  );
  const tool = running.at(-1)?.name ?? activity?.toolCalls.at(-1)?.name;
  if (tool !== undefined) return `Running ${tool}`;
  if (activity !== undefined && activity.text.length > 0) return "Writing";
  if (activity !== undefined && activity.thinking.length > 0) return "Thinking";
  if (status === "queued") return "Queued";
  return "Working";
}

/** When the running turn started: the time of its first event, if one arrived. */
export function turnStartedAt(state: ConversationState): number | undefined {
  const operation = state.activeOperationId;
  if (operation === undefined) return undefined;
  for (const record of state.records) {
    if (record.kind === "event" && record.event.operationId === operation) {
      return record.event.timestamp;
    }
  }
  return undefined;
}

/** "12s" or "3m 04s". */
export function elapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}
