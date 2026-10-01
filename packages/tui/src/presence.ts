// SPDX-FileCopyrightText: 2026 PranavD2905
// SPDX-License-Identifier: Apache-2.0

import {
  type AttachmentPresence,
  type PresenceDelivery,
  type SessionId,
  sessionPeers,
} from "@axl/sdk";

/** Counts above this bound render as `99+` so the footer width stays fixed. */
export const PRESENCE_COUNT_LIMIT = 99;

/**
 * Holds the latest daemon presence snapshot for the footer indicator.
 * The snapshot is informational: it never grants ownership or permission.
 */
export class SessionPresence {
  private attachments: readonly AttachmentPresence[] | undefined;

  /** Replaces the snapshot with a fresh daemon delivery. */
  update(delivery: PresenceDelivery): void {
    this.attachments = delivery.attachments;
  }

  /** Drops the snapshot until the daemon sends a fresh one. */
  clear(): void {
    this.attachments = undefined;
  }

  /** Returns the footer label, or `undefined` when there is no fresh peer to show. */
  label(sessionId: SessionId, ownAttachmentId: string | undefined): string | undefined {
    if (this.attachments === undefined || ownAttachmentId === undefined) return undefined;
    const count = sessionPeers(this.attachments, sessionId, ownAttachmentId).length;
    if (count === 0) return undefined;
    const shown = count > PRESENCE_COUNT_LIMIT ? `${PRESENCE_COUNT_LIMIT}+` : `${count}`;
    return `${shown} other client${count === 1 ? "" : "s"}`;
  }
}
