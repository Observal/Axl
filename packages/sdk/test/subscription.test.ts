// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_FORMAT_VERSION,
  parseEvent,
  parseSessionId,
  subscribeSession,
  type AxlClient,
  type CanonicalEvent,
  type WireActivity,
  type WireEvent,
} from "../src/index.ts";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
const first = parseEvent({
  version: EVENT_FORMAT_VERSION,
  id: "00000000-0000-4000-8000-000000000001",
  sessionId,
  parentId: null,
  timestamp: 1,
  type: "session.created",
  payload: { cwd: "/workspace" },
});
const second = parseEvent({
  version: EVENT_FORMAT_VERSION,
  id: "00000000-0000-4000-8000-000000000002",
  sessionId,
  parentId: first.id,
  timestamp: 2,
  type: "user.message",
  payload: { content: [{ type: "text", text: "hello" }] },
});

class FixtureClient {
  eventListener: ((event: WireEvent) => void) | undefined;
  activityListener: ((event: WireActivity) => void) | undefined;
  readonly calls: string[] = [];
  readonly connection = { daemonInstanceId: "daemon-1" };

  async request(method: string): Promise<unknown> {
    this.calls.push(method);
    if (method === "session.subscribe") {
      return {
        subscriptionId: "subscription-1",
        sessionId,
        snapshot: {
          snapshotId: "snapshot-1",
          sessionId,
          boundaryCursor: "boundary-1",
          eventCount: 2,
          page: { events: [first], nextPageCursor: "page-2", complete: false },
        },
      };
    }
    if (method === "session.history") {
      return { snapshotId: "snapshot-1", page: { events: [second], complete: true } };
    }
    if (method === "session.ack") return { cursor: "boundary-1" };
    if (method === "session.unsubscribe") return { unsubscribed: true };
    throw new Error(`Unexpected ${method}`);
  }

  onEvent(listener: (event: WireEvent) => void): () => void {
    this.eventListener = listener;
    return () => {
      this.eventListener = undefined;
    };
  }

  onActivity(listener: (event: WireActivity) => void): () => void {
    this.activityListener = listener;
    return () => {
      this.activityListener = undefined;
    };
  }

  onDisconnect(): () => void {
    return () => undefined;
  }

  loadingSnapshot<Result>(load: () => Promise<Result>): Promise<Result> {
    return load();
  }
}

test("reduces every frozen page before acknowledging and persists live cursors", async () => {
  const fixture = new FixtureClient();
  const saved: Array<[string, string]> = [];
  const subscription = await subscribeSession(fixture as unknown as AxlClient, sessionId, {
    cursorStore: {
      async load() {
        return undefined;
      },
      async save(key, cursor) {
        saved.push([key, cursor]);
      },
      async delete() {},
    },
  });
  assert.deepEqual(fixture.calls.slice(0, 3), [
    "session.subscribe",
    "session.history",
    "session.ack",
  ]);
  assert.deepEqual(
    subscription.projector.state.records.map((record) => record.event.id),
    [first.id, second.id],
  );

  const third = parseEvent({
    version: EVENT_FORMAT_VERSION,
    id: "00000000-0000-4000-8000-000000000003",
    sessionId,
    parentId: second.id,
    timestamp: 3,
    type: "assistant.message",
    payload: { content: [{ type: "text", text: "hi" }], stopReason: "stop" },
  }) as CanonicalEvent;
  fixture.eventListener?.({
    kind: "event",
    subscriptionId: "subscription-1",
    sessionId,
    sequence: 1,
    cursor: "live-1",
    event: third,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subscription.projector.state.records.length, 3);
  assert.equal(saved.at(-1)?.[1], "live-1");
  await subscription.close();
  assert.equal(subscription.projector.state.activity, undefined);
});

test("reports sequence gaps without sorting or mutating canonical state", async () => {
  const fixture = new FixtureClient();
  let failure: Error | undefined;
  const subscription = await subscribeSession(fixture as unknown as AxlClient, sessionId, {
    onResyncRequired(error) {
      failure = error;
    },
  });
  fixture.eventListener?.({
    kind: "event",
    subscriptionId: "subscription-1",
    sessionId,
    sequence: 2,
    cursor: "live-2",
    event: second,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(failure?.message ?? "", /out of order/);
  assert.equal(subscription.projector.state.records.length, 2);
  await subscription.close();
});
