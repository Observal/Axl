// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { ConversationState } from "@axl/sdk";

/** Dock panes in their fixed top-to-bottom tiling order. */
export const PANE_IDS = ["browser", "files", "changes", "terminal"] as const;
export type PaneId = (typeof PANE_IDS)[number];

export const PANE_LABELS: Readonly<Record<PaneId, string>> = {
  browser: "Browser",
  files: "Files",
  changes: "Changes",
  terminal: "Terminal",
};

/** Smallest height a tiled pane may be resized to. */
export const MIN_PANE_HEIGHT = 140;
export const MAX_OPEN_PANES = PANE_IDS.length;

export interface PaneLayout {
  /** Open panes, top to bottom. Always a subset of PANE_IDS in canonical order. */
  readonly panes: readonly PaneId[];
  /** Relative heights. Missing panes weigh 1. */
  readonly weights: Readonly<Partial<Record<PaneId, number>>>;
  /** A pane occupying the whole dock, if any. */
  readonly zoomed?: PaneId;
}

export const DEFAULT_PANES: readonly PaneId[] = ["browser", "files"];

export interface PaneChoice {
  readonly id: PaneId;
  readonly label: string;
  readonly open: boolean;
  /** Unavailable open panes stay enabled so the user can close stale persisted state. */
  readonly disabled: boolean;
  readonly state: "Open" | "Closed" | "Open · unavailable" | "Unavailable";
  readonly unavailableReason?: string;
}

export function paneChoices(
  openPanes: readonly PaneId[],
  unavailableReasons: Readonly<Record<PaneId, string | undefined>>,
): readonly PaneChoice[] {
  return PANE_IDS.map((id) => {
    const open = openPanes.includes(id);
    const unavailableReason = unavailableReasons[id];
    return {
      id,
      label: PANE_LABELS[id],
      open,
      disabled: unavailableReason !== undefined && !open,
      state:
        unavailableReason === undefined
          ? open
            ? "Open"
            : "Closed"
          : open
            ? "Open · unavailable"
            : "Unavailable",
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
    };
  });
}

export function isPaneId(value: unknown): value is PaneId {
  return typeof value === "string" && (PANE_IDS as readonly string[]).includes(value);
}

/** Validates a persisted open-pane list: known ids, unique, canonical order. */
export function parsePaneIds(value: unknown): readonly PaneId[] {
  if (!Array.isArray(value) || value.length > MAX_OPEN_PANES) throw new Error("Invalid pane list");
  const seen = new Set<PaneId>();
  for (const pane of value) {
    if (!isPaneId(pane) || seen.has(pane)) throw new Error("Invalid pane list");
    seen.add(pane);
  }
  return canonicalOrder(seen);
}

function canonicalOrder(open: ReadonlySet<PaneId>): readonly PaneId[] {
  return PANE_IDS.filter((pane) => open.has(pane));
}

export function createPaneLayout(panes: readonly PaneId[] = DEFAULT_PANES): PaneLayout {
  return { panes: canonicalOrder(new Set(panes)), weights: {} };
}

export function openPane(layout: PaneLayout, pane: PaneId): PaneLayout {
  if (layout.panes.includes(pane)) return layout;
  return {
    panes: canonicalOrder(new Set([...layout.panes, pane])),
    weights: layout.weights,
    ...(layout.zoomed === undefined ? {} : { zoomed: layout.zoomed }),
  };
}

export function closePane(layout: PaneLayout, pane: PaneId): PaneLayout {
  if (!layout.panes.includes(pane)) return layout;
  const { [pane]: _removed, ...weights } = layout.weights;
  void _removed;
  return {
    panes: layout.panes.filter((open) => open !== pane),
    weights,
    ...(layout.zoomed === undefined || layout.zoomed === pane ? {} : { zoomed: layout.zoomed }),
  };
}

export function togglePane(layout: PaneLayout, pane: PaneId): PaneLayout {
  return layout.panes.includes(pane) ? closePane(layout, pane) : openPane(layout, pane);
}

/** Zooms one open pane to fill the dock, or restores tiling when already zoomed. */
export function toggleZoom(layout: PaneLayout, pane: PaneId): PaneLayout {
  if (!layout.panes.includes(pane)) return layout;
  if (layout.zoomed === pane) {
    const { zoomed: _zoomed, ...rest } = layout;
    void _zoomed;
    return rest;
  }
  return { ...layout, zoomed: pane };
}

/** Height fraction for each open pane, in order. Zoomed layouts give the whole dock to one pane. */
export function paneFractions(layout: PaneLayout): readonly number[] {
  if (layout.zoomed !== undefined && layout.panes.includes(layout.zoomed)) {
    return layout.panes.map((pane) => (pane === layout.zoomed ? 1 : 0));
  }
  const weights = layout.panes.map((pane) => layout.weights[pane] ?? 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return total === 0 ? weights.map(() => 1 / weights.length) : weights.map((w) => w / total);
}

/**
 * Moves the separator below pane `index` by `deltaPx` inside a dock of `dockHeight` pixels.
 * Neighbouring panes exchange height; neither drops below MIN_PANE_HEIGHT.
 */
export function resizePane(
  layout: PaneLayout,
  index: number,
  deltaPx: number,
  dockHeight: number,
): PaneLayout {
  const upper = layout.panes[index];
  const lower = layout.panes[index + 1];
  if (upper === undefined || lower === undefined || layout.zoomed !== undefined || dockHeight <= 0)
    return layout;
  const fractions = paneFractions(layout);
  const upperPx = (fractions[index] ?? 0) * dockHeight;
  const lowerPx = (fractions[index + 1] ?? 0) * dockHeight;
  const pair = upperPx + lowerPx;
  if (pair < MIN_PANE_HEIGHT * 2) return layout;
  const nextUpper = Math.min(pair - MIN_PANE_HEIGHT, Math.max(MIN_PANE_HEIGHT, upperPx + deltaPx));
  const nextLower = pair - nextUpper;
  const weights: Partial<Record<PaneId, number>> = {};
  layout.panes.forEach((pane, i) => {
    const px =
      i === index ? nextUpper : i === index + 1 ? nextLower : (fractions[i] ?? 0) * dockHeight;
    weights[pane] = Math.max(px / dockHeight, 0);
  });
  return { ...layout, weights };
}

export interface BrowserTarget {
  readonly url: string;
  /** Loopback development servers; these almost always allow embedding. */
  readonly loopback: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Resolves user input into a browser-pane URL. Only http and https are allowed. A bare
 * loopback "host:port" gets an http scheme; any other bare host gets https.
 */
export function parseBrowserTarget(input: string): BrowserTarget {
  const trimmed = input.trim();
  if (trimmed === "") throw new Error("Enter a URL");
  // "host:port" has no scheme; a scheme is followed by something other than a bare port.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/iu.test(trimmed);
  const bareHost = (trimmed.split(/[/?#]/u, 1)[0] ?? trimmed).replace(/:\d+$/u, "");
  const scheme = LOOPBACK_HOSTS.has(bareHost) ? "http" : "https";
  const withScheme = hasScheme ? trimmed : `${scheme}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("That is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be opened");
  }
  if (url.username !== "" || url.password !== "")
    throw new Error("URLs with credentials are not allowed");
  return { url: url.href, loopback: LOOPBACK_HOSTS.has(url.hostname) };
}

export interface TerminalEntry {
  readonly id: string;
  readonly command: string;
  readonly output: string;
  readonly isError: boolean;
  readonly excluded: boolean;
  readonly timestamp: number;
}

/** Projects the session's direct shell history for the terminal pane. */
export function terminalEntries(conversation: ConversationState): readonly TerminalEntry[] {
  const entries: TerminalEntry[] = [];
  for (const record of conversation.records) {
    if (record.kind !== "event" || record.event.type !== "user.shell") continue;
    const { payload } = record.event;
    entries.push({
      id: record.event.id,
      command: payload.command,
      output: payload.content
        .map((item) =>
          item.type === "text" ? item.text : `[${item.blob.name ?? item.blob.mediaType}]`,
        )
        .join("\n"),
      isError: payload.isError,
      excluded: payload.excluded,
      timestamp: record.event.timestamp,
    });
  }
  return entries;
}
