// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { AttachmentPresence, SessionId } from "@axl/sdk";

export function sessionPeers(
  attachments: readonly AttachmentPresence[],
  sessionId: SessionId | undefined,
  ownAttachmentId: string | undefined,
): readonly AttachmentPresence[] {
  if (sessionId === undefined) return [];
  return attachments.filter(
    (attachment) =>
      attachment.attachmentId !== ownAttachmentId &&
      attachment.subscribedSessionIds.includes(sessionId),
  );
}

export function presenceDescription(peers: readonly AttachmentPresence[]): string {
  const kinds = peers.map((peer) => peer.clientKind).join(", ");
  return `${peers.length} other client${peers.length === 1 ? "" : "s"} attached${kinds ? `: ${kinds}` : ""}`;
}
