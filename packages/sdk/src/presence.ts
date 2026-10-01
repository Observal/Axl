// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 PranavD2905
// SPDX-License-Identifier: Apache-2.0

import type { AttachmentPresence, SessionId } from "@axl/protocol";

/** Returns the other attachments subscribed to `sessionId`, excluding this client's own attachment. */
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
