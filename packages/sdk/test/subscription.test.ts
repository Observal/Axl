// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_FORMAT_VERSION,
  parseEvent,
  parseOperationId,
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
  disconnectListener: (() => void) | undefined;
  readonly calls: string[] = [];
  readonly requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  readonly connection: { readonly daemonInstanceId: string };

  constructor(daemonInstanceId = "daemon-1") {
    this.connection = { daemonInstanceId };
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push(method);
    this.requests.push({ method, params });
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

  onDisconnect(listener: () => void): () => void {
    this.disconnectListener = listener;
    return () => {
      this.disconnectListener = undefined;
    };
  }

  onReconnect(): () => void {
    return () => undefined;
  }

  loadingSnapshot<Result>(load: () => Promise<Result>): Promise<Result> {
    return load();
  }
}

class ResumeFixtureClient extends FixtureClient {
  override async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push(method);
    this.requests.push({ method, params });
    if (method === "session.subscribe") {
      const after = (params as { readonly after?: string } | undefined)?.after;
      return {
        subscriptionId: "subscription-2",
        sessionId,
        ...(after === undefined ? {} : { resumedFrom: after }),
      };
    }
    if (method === "session.ack") {
      return { cursor: (params as { readonly cursor: string }).cursor };
    }
    if (method === "session.unsubscribe") return { unsubscribed: true };
    throw new Error(`Unexpected ${method}`);
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
  assert.deepEqual(subscription.cursorPersistence, { state: "available" });
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

test("cursor-store failure disables resumability without stopping delivery", async () => {
  const fixture = new FixtureClient();
  const subscription = await subscribeSession(fixture as unknown as AxlClient, sessionId, {
    cursorStore: {
      async load() {
        return undefined;
      },
      async save() {
        throw new Error("storage unavailable");
      },
      async delete() {},
    },
  });
  assert.equal(subscription.resumable, false);
  assert.deepEqual(subscription.cursorPersistence, {
    state: "unavailable",
    reason: "cursor_store_failed",
  });
  assert.equal(subscription.projector.state.records.length, 2);
  const replacement = new FixtureClient();
  await subscription.reconnect(replacement as unknown as AxlClient);
  assert.deepEqual(replacement.requests[0], {
    method: "session.subscribe",
    params: { sessionId },
  });
  await subscription.close();
});

test("reports when persistent cursor storage is not configured", async () => {
  const fixture = new FixtureClient();
  const subscription = await subscribeSession(fixture as unknown as AxlClient, sessionId);
  assert.deepEqual(subscription.cursorPersistence, { state: "not_configured" });
  await subscription.close();
});

test("rebinds a live view from its last acknowledgement without merging snapshots", async () => {
  const firstClient = new FixtureClient();
  const changes: number[] = [];
  const subscription = await subscribeSession(firstClient as unknown as AxlClient, sessionId, {
    onChange(projector) {
      changes.push(projector.state.records.length);
    },
  });
  firstClient.activityListener?.({
    kind: "activity",
    subscriptionId: "subscription-1",
    sessionId,
    frame: {
      operationId: parseOperationId("00000000-0000-4000-8000-000000000099"),
      sequence: 1,
      type: "text_delta",
      text: "working",
    },
  });
  assert.equal(subscription.projector.state.activity?.text, "working");

  const resumedClient = new ResumeFixtureClient();
  await subscription.reconnect(resumedClient as unknown as AxlClient);
  assert.equal(subscription.subscriptionId, "subscription-2");
  assert.equal(subscription.projector.state.records.length, 2);
  assert.equal(subscription.projector.state.activity, undefined);
  assert.deepEqual(resumedClient.requests[0], {
    method: "session.subscribe",
    params: { sessionId, after: "boundary-1" },
  });

  const third = parseEvent({
    version: EVENT_FORMAT_VERSION,
    id: "00000000-0000-4000-8000-000000000003",
    sessionId,
    parentId: second.id,
    timestamp: 3,
    type: "assistant.message",
    payload: { content: [{ type: "text", text: "done" }], stopReason: "stop" },
  });
  resumedClient.eventListener?.({
    kind: "event",
    subscriptionId: "subscription-2",
    sessionId,
    sequence: 1,
    cursor: "live-1",
    event: third,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subscription.projector.state.records.length, 3);
  assert.equal(changes.at(-1), 3);
  await subscription.close();
});

test("replaces projection state when daemon lineage changes", async () => {
  const initial = new FixtureClient();
  const subscription = await subscribeSession(initial as unknown as AxlClient, sessionId);
  const replacement = new FixtureClient("daemon-2");
  await subscription.reconnect(replacement as unknown as AxlClient);
  assert.equal(subscription.projector.state.records.length, 2);
  assert.deepEqual(replacement.requests[0], { method: "session.subscribe", params: { sessionId } });
  await subscription.close();
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
