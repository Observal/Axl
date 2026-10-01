// SPDX-FileCopyrightText: 2026 PranavD2905
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { type AttachmentPresence, parseSessionId, sessionPeers } from "../src/index.ts";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
const otherSessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174001");

function attachment(
  attachmentId: string,
  sessionIds: readonly (typeof sessionId)[],
): AttachmentPresence {
  return {
    attachmentId,
    clientKind: "tui",
    connectedAt: 1,
    lastSeenAt: 2,
    subscribedSessionIds: sessionIds,
    scope: "local_control",
  };
}

test("session peers exclude the own attachment and other sessions", () => {
  const attachments = [
    attachment("self", [sessionId]),
    attachment("peer", [sessionId]),
    attachment("elsewhere", [otherSessionId]),
  ];
  assert.deepEqual(
    sessionPeers(attachments, sessionId, "self").map((peer) => peer.attachmentId),
    ["peer"],
  );
  assert.deepEqual(sessionPeers(attachments, undefined, "self"), []);
});
