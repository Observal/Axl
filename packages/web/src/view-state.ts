// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  BlobReference,
  ConversationState,
  PromptDeliveryMode,
  SessionOpenResult,
  SessionSummary,
  WorkspaceDiffResult,
} from "@axl/sdk";

export interface SessionStateHistoryEntry {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly timestamp: number;
}

export interface PendingPromptDelivery {
  readonly id: number;
  readonly mode: "steer" | "follow_up" | "interrupt";
  readonly text: string;
  readonly contentKey: string;
  readonly afterRecord: number;
}

export interface DirectShellInput {
  readonly command: string;
  readonly excluded: boolean;
}

export function directShellInput(input: string): DirectShellInput | undefined {
  const value = input.trim();
  if (!value.startsWith("!")) return undefined;
  const excluded = value.startsWith("!!");
  return { command: value.slice(excluded ? 2 : 1).trim(), excluded };
}

export function consumePendingPromptDeliveries(
  pendingInputs: readonly PendingPromptDelivery[],
  conversation: ConversationState,
): readonly PendingPromptDelivery[] {
  const consumed = new Set<string>();
  return pendingInputs.filter((pending) => {
    const delivered = conversation.records.slice(pending.afterRecord).find((record) => {
      if (
        record.kind !== "event" ||
        record.event.type !== "user.message" ||
        consumed.has(record.event.id) ||
        JSON.stringify(record.event.payload.content) !== pending.contentKey
      )
        return false;
      consumed.add(record.event.id);
      return true;
    });
    return delivered === undefined;
  });
}

export function promptDeliveryShortcut(modifiers: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): PromptDeliveryMode | undefined {
  if (modifiers.ctrlKey || modifiers.metaKey) return "interrupt";
  return modifiers.altKey ? "follow_up" : undefined;
}

function messageText(
  content: readonly { readonly type: string; readonly text?: string }[],
): string {
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("");
}

export function transcriptPromptBreakpoints(
  conversation: ConversationState,
): readonly { readonly id: string; readonly text: string }[] {
  const compacted = new Set(conversation.compactedEventIds);
  return conversation.records.flatMap((record) =>
    record.kind === "event" &&
    !compacted.has(record.event.id) &&
    record.event.type === "user.message"
      ? [
          {
            id: record.event.id,
            text: messageText(record.event.payload.content).trim() || "Attachment",
          },
        ]
      : [],
  );
}

export function transcriptMessageMatches(
  conversation: ConversationState,
  query: string,
): readonly string[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const compacted = new Set(conversation.compactedEventIds);
  return conversation.records.flatMap((record) =>
    record.kind === "event" &&
    !compacted.has(record.event.id) &&
    (record.event.type === "user.message" || record.event.type === "assistant.message") &&
    messageText(record.event.payload.content).toLocaleLowerCase().includes(needle)
      ? [record.event.id]
      : [],
  );
}

export function sessionUsageStats(conversation: ConversationState): {
  readonly cacheHitPercent: number;
  readonly tokensPerSecond?: number;
  readonly unknownCostResponses: number;
} {
  const promptTokens =
    conversation.usage.inputTokens +
    conversation.usage.cacheReadTokens +
    conversation.usage.cacheWriteTokens;
  let requestStartedAt: number | undefined;
  let outputTokens = 0;
  let responseMs = 0;
  let unknownCostResponses = 0;
  for (const record of conversation.records) {
    if (record.kind !== "event") continue;
    if (record.event.type === "model.request_configured") requestStartedAt = record.event.timestamp;
    else if (
      record.event.type === "assistant.message" &&
      record.event.payload.usage !== undefined
    ) {
      if (record.event.payload.usage.costUsd === undefined) unknownCostResponses += 1;
      if (requestStartedAt !== undefined && record.event.payload.usage.outputTokens > 0) {
        outputTokens += record.event.payload.usage.outputTokens;
        responseMs += Math.max(1, record.event.timestamp - requestStartedAt);
      }
      requestStartedAt = undefined;
    }
  }
  return {
    cacheHitPercent:
      promptTokens === 0 ? 0 : (conversation.usage.cacheReadTokens / promptTokens) * 100,
    ...(responseMs === 0 ? {} : { tokensPerSecond: (outputTokens * 1000) / responseMs }),
    unknownCostResponses,
  };
}

export function workspaceTotals(diffs: readonly WorkspaceDiffResult[]): {
  readonly additions: number;
  readonly deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const diff of diffs) {
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "addition") additions += 1;
        else if (line.kind === "deletion") deletions += 1;
      }
    }
  }
  return { additions, deletions };
}

export function sessionTitle(session: SessionSummary): string {
  return session.title ?? session.lastUserMessage ?? session.firstUserMessage ?? "New session";
}

/**
 * Builds the sidebar summary for a session opened in preview mode, where there
 * is no daemon catalog to refresh from. The message and attachment counts are
 * placeholders for the fixture; live sessions always come from session.list.
 */
export function previewSessionSummary(
  session: SessionOpenResult,
  now: number = Date.now(),
): SessionSummary {
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    ...(session.title === undefined ? {} : { title: session.title }),
    createdAt: now,
    updatedAt: now,
    userMessageCount: 0,
    runtime: session.runtime,
    attachmentCount: 1,
    profile: session.profile,
  };
}

export function restoreDraft(sent: string, current: string): string {
  return current ? `${sent}\n${current}` : sent;
}

export interface SlashCommandAvailability {
  readonly availability: { readonly state: string };
}

/**
 * The next slash-command index in the given direction whose availability is not
 * "unavailable", so keyboard navigation skips commands the user cannot run.
 * Returns the current index when nothing else is selectable.
 */
export function nextSelectableSlashIndex<T extends SlashCommandAvailability>(
  commands: readonly T[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (commands.length === 0) return currentIndex;
  let index = currentIndex;
  for (let step = 0; step < commands.length; step += 1) {
    index = (index + direction + commands.length) % commands.length;
    if (commands[index]?.availability.state !== "unavailable") return index;
  }
  return currentIndex;
}

/**
 * The slash command that Enter or Tab should run: the highlighted one when it is
 * available, otherwise the first available command, otherwise undefined so the
 * caller can fall back to sending the draft.
 */
export function selectableSlashCommand<T extends SlashCommandAvailability>(
  commands: readonly T[],
  index: number,
): T | undefined {
  const highlighted = commands[index];
  if (highlighted !== undefined && highlighted.availability.state !== "unavailable")
    return highlighted;
  return commands.find((command) => command.availability.state !== "unavailable");
}

export interface SessionCatalogPage<T> {
  readonly sessions: readonly T[];
  readonly nextPageCursor?: string;
}

/**
 * Scans a paginated session catalog for one session id. Absence from the first
 * page does not prove deletion once there is more than one page, so the opened
 * session must be confirmed missing across the whole catalog before it is torn
 * down. Returns {@link confirmedAbsent} only when a terminal page is reached
 * without a match; hitting the page cap leaves absence unconfirmed so callers
 * fail safe and keep the session.
 */
export async function findSessionInCatalog<T extends { readonly sessionId: string }>(
  fetchPage: (cursor: string | undefined) => Promise<SessionCatalogPage<T>>,
  sessionId: string,
  maxPages = 50,
): Promise<{ readonly session?: T; readonly confirmedAbsent: boolean }> {
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(cursor);
    const session = result.sessions.find((item) => item.sessionId === sessionId);
    if (session !== undefined) return { session, confirmedAbsent: false };
    if (result.nextPageCursor === undefined) return { confirmedAbsent: true };
    cursor = result.nextPageCursor;
  }
  return { confirmedAbsent: false };
}

export function matchesSession(session: SessionSummary, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return (
    needle === "" || `${sessionTitle(session)}\n${session.cwd}`.toLocaleLowerCase().includes(needle)
  );
}

/** Unique attachment blobs referenced by the conversation's user and assistant messages. */
export function messageBlobs(conversation: ConversationState): readonly BlobReference[] {
  const blobs = new Map<string, BlobReference>();
  for (const record of conversation.records) {
    if (
      record.kind !== "event" ||
      (record.event.type !== "user.message" && record.event.type !== "assistant.message")
    )
      continue;
    for (const item of record.event.payload.content) {
      if (item.type === "blob") blobs.set(item.blob.sha256, item.blob);
    }
  }
  return [...blobs.values()];
}

/** The most recent configuration and lifecycle events, newest first, capped at 20. */
export function sessionStateHistory(
  conversation: ConversationState,
): readonly SessionStateHistoryEntry[] {
  const history: SessionStateHistoryEntry[] = [];
  for (const record of conversation.records) {
    if (record.kind !== "event") continue;
    const event = record.event;
    switch (event.type) {
      case "session.created":
        history.push({
          id: event.id,
          label: "Session created",
          detail: event.payload.profile ?? "legacy",
          timestamp: event.timestamp,
        });
        break;
      case "session.resumed":
        history.push({
          id: event.id,
          label: "Session resumed",
          detail: "Runtime restored",
          timestamp: event.timestamp,
        });
        break;
      case "session.closed":
        history.push({
          id: event.id,
          label: "Session closed",
          detail: event.payload.reason,
          timestamp: event.timestamp,
        });
        break;
      case "config.provider":
        history.push({
          id: event.id,
          label: "Provider",
          detail: event.payload.providerId,
          timestamp: event.timestamp,
        });
        break;
      case "config.model":
        history.push({
          id: event.id,
          label: "Model",
          detail: event.payload.modelId,
          timestamp: event.timestamp,
        });
        break;
      case "config.profile":
        history.push({
          id: event.id,
          label: "Profile",
          detail: event.payload.profile,
          timestamp: event.timestamp,
        });
        break;
      case "config.thinking":
        history.push({
          id: event.id,
          label: "Thinking",
          detail: event.payload.clamped
            ? `${event.payload.requested} → ${event.payload.effective}`
            : event.payload.effective,
          timestamp: event.timestamp,
        });
        break;
      case "config.dialect":
        history.push({
          id: event.id,
          label: "Tool dialect",
          detail: `${event.payload.dialectId} · ${event.payload.reason.replaceAll("_", " ")}`,
          timestamp: event.timestamp,
        });
        break;
      case "config.tools":
        history.push({
          id: event.id,
          label: "Web tools",
          detail: `search ${event.payload.webSearch ? "on" : "off"} · fetch ${event.payload.webFetch ? "on" : "off"}`,
          timestamp: event.timestamp,
        });
        break;
      case "sandbox.configured":
        history.push({
          id: event.id,
          label: "Sandbox",
          detail: event.payload.enforced ? `${event.payload.provider} enforced` : "not enforced",
          timestamp: event.timestamp,
        });
        break;
      default:
        break;
    }
  }
  return history.slice(-20).reverse();
}

/** Human-friendly compact rendering of a token count (e.g. 12800 -> "13k"). */
export function compactNumber(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

/**
 * Overlay surfaces that can be open at once. Modal dialogs own their own Escape
 * key (they render an in-dialog handler), so they are not force-closed by the
 * global shortcut handler; the "light" overlays below have no local handler and
 * are dismissed by the global Escape.
 */
export interface OverlayFlags {
  readonly requeue: boolean;
  readonly sessionLifecycle: boolean;
  readonly newSession: boolean;
  readonly commandPalette: boolean;
  readonly transcriptSearch: boolean;
  readonly usage: boolean;
  readonly controlCenter: boolean;
  readonly mobileDock: boolean;
  readonly sidebar: boolean;
}

export type OverlayId = keyof OverlayFlags;

// Modal dialogs render their own focus trap and Escape handler.
const MODAL_OVERLAYS: readonly OverlayId[] = ["requeue", "sessionLifecycle", "newSession"];

// Light overlays have no local Escape handler; the global handler dismisses the
// topmost one, most modal first.
const LIGHT_OVERLAY_PRIORITY: readonly OverlayId[] = [
  "commandPalette",
  "transcriptSearch",
  "usage",
  "controlCenter",
  "mobileDock",
  "sidebar",
];

/** True when a modal dialog owns the keyboard, so global shortcuts must yield. */
export function anyModalOverlayOpen(flags: OverlayFlags): boolean {
  return MODAL_OVERLAYS.some((id) => flags[id]);
}

/**
 * The single light overlay the global Escape handler should close, or undefined
 * when none is open. Escape closes one overlay at a time instead of collapsing
 * every surface at once, and it never force-closes a modal dialog.
 */
export function topLightOverlay(flags: OverlayFlags): OverlayId | undefined {
  return LIGHT_OVERLAY_PRIORITY.find((id) => flags[id]);
}

/** Distance from the bottom, in pixels, that still counts as "at the bottom". */
export const SCROLL_STICK_THRESHOLD = 64;

/**
 * Whether a scroll viewport is at (or within {@link SCROLL_STICK_THRESHOLD} of)
 * the bottom. Used to decide whether streaming updates may auto-scroll without
 * hijacking a reader who has scrolled up.
 */
export function isScrolledToBottom(
  viewport: {
    readonly scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
  },
  threshold: number = SCROLL_STICK_THRESHOLD,
): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= threshold;
}
