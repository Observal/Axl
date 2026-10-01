// SPDX-FileCopyrightText: 2026 PranavD2905
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { type AttachmentPresence, type PresenceDelivery, parseSessionId } from "@axl/sdk";
import { SessionPresence } from "../src/presence.ts";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
const otherSessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174001");

function attachment(
  attachmentId: string,
  subscribedSessionIds: readonly (typeof sessionId)[],
): AttachmentPresence {
  return {
    attachmentId,
    clientKind: "web",
    connectedAt: 1,
    lastSeenAt: 2,
    subscribedSessionIds,
    scope: "local_control",
  };
}

function delivery(...attachments: AttachmentPresence[]): PresenceDelivery {
  return { kind: "presence", attachments };
}

test("shows nothing before the first snapshot", () => {
  const presence = new SessionPresence();
  assert.equal(presence.label(sessionId, "self"), undefined);
});

test("excludes the local attachment and attachments on other sessions", () => {
  const presence = new SessionPresence();
  presence.update(
    delivery(
      attachment("self", [sessionId]),
      attachment("ide", [otherSessionId]),
      attachment("idle", []),
    ),
  );
  assert.equal(presence.label(sessionId, "self"), undefined);
  presence.update(
    delivery(
      attachment("self", [sessionId]),
      attachment("web", [sessionId, otherSessionId]),
      attachment("ide", [otherSessionId]),
    ),
  );
  assert.equal(presence.label(sessionId, "self"), "1 other client");
  assert.equal(presence.label(otherSessionId, "self"), "2 other clients");
});

test("follows joins and leaves across snapshots", () => {
  const presence = new SessionPresence();
  presence.update(delivery(attachment("self", [sessionId]), attachment("a", [sessionId])));
  assert.equal(presence.label(sessionId, "self"), "1 other client");
  presence.update(
    delivery(
      attachment("self", [sessionId]),
      attachment("a", [sessionId]),
      attachment("b", [sessionId]),
    ),
  );
  assert.equal(presence.label(sessionId, "self"), "2 other clients");
  presence.update(delivery(attachment("self", [sessionId]), attachment("b", [otherSessionId])));
  assert.equal(presence.label(sessionId, "self"), undefined);
  presence.update(delivery());
  assert.equal(presence.label(sessionId, "self"), undefined);
});

test("drops a stale snapshot after disconnect until a fresh one arrives", () => {
  const presence = new SessionPresence();
  presence.update(delivery(attachment("self", [sessionId]), attachment("a", [sessionId])));
  presence.clear();
  assert.equal(presence.label(sessionId, "self"), undefined);
  presence.update(delivery(attachment("new-self", [sessionId]), attachment("a", [sessionId])));
  assert.equal(presence.label(sessionId, "new-self"), "1 other client");
  assert.equal(presence.label(sessionId, undefined), undefined);
});

test("bounds large counts", () => {
  const presence = new SessionPresence();
  presence.update(
    delivery(
      ...Array.from({ length: 150 }, (_, index) => attachment(`peer-${index}`, [sessionId])),
    ),
  );
  assert.equal(presence.label(sessionId, "self"), "99+ other clients");
});
