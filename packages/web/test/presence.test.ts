// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { type AttachmentPresence, parseSessionId } from "@axl/sdk";
import { presenceDescription, sessionPeers } from "../src/presence.ts";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
const otherSessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174001");
const attachments: readonly AttachmentPresence[] = [
  {
    attachmentId: "self",
    clientKind: "web",
    connectedAt: 1,
    lastSeenAt: 2,
    subscribedSessionIds: [sessionId],
    scope: "local_control",
  },
  {
    attachmentId: "tui",
    clientKind: "tui",
    connectedAt: 1,
    lastSeenAt: 2,
    subscribedSessionIds: [sessionId],
    scope: "local_control",
  },
  {
    attachmentId: "ide",
    clientKind: "ide",
    connectedAt: 1,
    lastSeenAt: 2,
    subscribedSessionIds: [otherSessionId],
    scope: "local_control",
  },
];

test("reports only other clients attached to the selected session", () => {
  const peers = sessionPeers(attachments, sessionId, "self");
  assert.deepEqual(
    peers.map((peer) => peer.attachmentId),
    ["tui"],
  );
  assert.equal(presenceDescription(peers), "1 other client attached: tui");
  assert.deepEqual(sessionPeers(attachments, undefined, "self"), []);
});
