// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeWireMessage,
  isRetryableMutationMethod,
  ProtocolValidationError,
  parseServerMessage,
  parseSnapshotPage,
  parseWireRequest,
  parseWorkspaceDiff,
  requiredCapability,
  WIRE_PROTOCOL_VERSION,
} from "../src/index.ts";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";

test("maps feature methods to negotiated capabilities", () => {
  assert.equal(requiredCapability("daemon.info"), undefined);
  assert.equal(requiredCapability("request.cancel"), undefined);
  assert.equal(requiredCapability("session.history"), undefined);
  assert.equal(requiredCapability("session.send"), "session.send.prompt");
  assert.equal(requiredCapability("session.blob.abort"), "session.blob.abort");
});

test("validates every request shape", () => {
  const requests = [
    { kind: "request", id: 0, method: "daemon.info", params: {} },
    {
      kind: "request",
      id: 22,
      method: "connection.initialize",
      params: {
        client: { kind: "future_client", version: "1.2.3", instanceId: "client-1" },
        requestedCapabilities: ["session.create"],
      },
    },
    { kind: "request", id: 23, method: "connection.ping", params: {} },
    { kind: "request", id: 24, method: "request.cancel", params: { requestId: 7 } },
    {
      kind: "request",
      id: 1,
      method: "session.create",
      params: { cwd: "/repo", profile: "minimal" },
    },
    {
      kind: "request",
      id: 2,
      method: "session.resume",
      params: { sessionId },
    },
    {
      kind: "request",
      id: 17,
      method: "session.list",
      params: { scope: "all_local", order: "recent", pageSize: 50 },
    },
    {
      kind: "request",
      id: 20,
      method: "session.history",
      params: { snapshotId: "snapshot-1", pageCursor: "page-1" },
    },
    {
      kind: "request",
      id: 24,
      method: "session.ack",
      params: { subscriptionId: "subscription-1", cursor: "cursor-1" },
    },
    {
      kind: "request",
      id: 25,
      method: "session.unsubscribe",
      params: { subscriptionId: "subscription-1" },
    },
    {
      kind: "request",
      id: 18,
      method: "session.fork",
      params: { sessionId, fromEventId: "00000000-0000-4000-8000-000000000001" },
    },
    { kind: "request", id: 19, method: "session.clone", params: { sessionId } },
    {
      kind: "request",
      id: 3,
      method: "session.send",
      params: {
        sessionId,
        content: [{ type: "text", text: "hello" }],
        delivery: "prompt",
      },
    },
    {
      kind: "request",
      id: 4,
      method: "session.shell",
      params: {
        sessionId,
        operationId: "00000000-0000-4000-8000-000000000010",
        command: "pwd",
        excluded: false,
      },
    },
    { kind: "request", id: 5, method: "session.interrupt", params: { sessionId } },
    {
      kind: "request",
      id: 5,
      method: "session.subscribe",
      params: { sessionId, after: "cursor-1" },
    },
    { kind: "request", id: 6, method: "session.reload", params: { sessionId } },
    { kind: "request", id: 7, method: "session.dispose", params: { sessionId } },
    {
      kind: "request",
      id: 8,
      method: "session.configure",
      params: {
        sessionId,
        modelId: "gpt-5",
        thinkingLevel: "high",
        profile: "minimal",
      },
    },
    {
      kind: "request",
      id: 9,
      method: "session.create",
      params: {
        cwd: "/repo",
        modelId: "gpt-5",
        thinkingLevel: "medium",
        profile: "minimal",
      },
    },
    {
      kind: "request",
      id: 10,
      method: "session.workspace.diff",
      params: { sessionId, scope: "last-turn" },
    },
    {
      kind: "request",
      id: 11,
      method: "session.workspace.checkpoint",
      params: { sessionId, enabled: true },
    },
    {
      kind: "request",
      id: 12,
      method: "session.interaction.respond",
      params: {
        sessionId,
        interactionId: "interaction-1",
        action: "accept",
        content: { answer: "yes" },
      },
    },
    {
      kind: "request",
      id: 13,
      method: "session.blob.start",
      params: { sessionId, mediaType: "image/png", sizeBytes: 4, name: "clip.png" },
    },
    {
      kind: "request",
      id: 14,
      method: "session.blob.chunk",
      params: { sessionId, uploadId: "upload-1", offset: 0, data: "YWJjZA==" },
    },
    {
      kind: "request",
      id: 15,
      method: "session.blob.commit",
      params: { sessionId, uploadId: "upload-1" },
    },
    {
      kind: "request",
      id: 21,
      method: "session.blob.abort",
      params: { sessionId, uploadId: "upload-1" },
    },
    {
      kind: "request",
      id: 16,
      method: "session.blob.read",
      params: { sessionId, sha256: "a".repeat(64), offset: 0, length: 4 },
    },
  ];
  for (const request of requests) {
    const keyed = isRetryableMutationMethod(request.method as never)
      ? { ...request, idempotencyKey: "00000000-0000-4000-8000-000000000001" }
      : request;
    assert.deepEqual(parseWireRequest(keyed), keyed);
  }
});

test("requires idempotency keys only for retryable mutations", () => {
  assert.throws(
    () =>
      parseWireRequest({
        kind: "request",
        id: 1,
        method: "session.create",
        params: { cwd: "/repo" },
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseWireRequest({
        kind: "request",
        id: 1,
        method: "session.create",
        params: { cwd: "/repo" },
        idempotencyKey: "NOT-A-UUID",
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseWireRequest({
        kind: "request",
        id: 1,
        method: "session.list",
        params: {},
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      }),
    ProtocolValidationError,
  );
  assert.doesNotThrow(() =>
    parseWireRequest({
      kind: "request",
      id: 1,
      method: "session.shell",
      params: {
        sessionId,
        operationId: "00000000-0000-4000-8000-000000000010",
        command: "pwd",
        excluded: false,
      },
    }),
  );
});

test("rejects malformed requests at the wire boundary", () => {
  for (const request of [
    { kind: "request", id: -1, method: "session.create", params: { cwd: "/repo" } },
    { kind: "request", id: 1, method: "daemon.info", params: { extra: true } },
    {
      kind: "request",
      id: 1,
      method: "connection.initialize",
      params: {
        client: { kind: "Web", version: "1", instanceId: "client-1" },
        requestedCapabilities: [],
      },
    },
    {
      kind: "request",
      id: 1,
      method: "connection.initialize",
      params: {
        client: { kind: "web", version: "1", instanceId: "client-1" },
        requestedCapabilities: ["session.create", "session.create"],
      },
    },
    {
      kind: "request",
      id: 1,
      method: "connection.initialize",
      params: {
        client: { kind: "web", version: "1", instanceId: "client-1" },
        requestedCapabilities: ["Invalid Capability"],
      },
    },
    { kind: "request", id: 1, method: "unknown", params: {} },
    { kind: "request", id: 1, method: "session.create", params: { cwd: "" } },
    { kind: "request", id: 1, method: "session.resume", params: { sessionId: "bad" } },
    {
      kind: "request",
      id: 1,
      method: "session.resume",
      params: { sessionId, includeEvents: false },
    },
    { kind: "request", id: 1, method: "session.list", params: { cwd: "/repo" } },
    {
      kind: "request",
      id: 1,
      method: "session.history",
      params: { snapshotId: "snapshot-1", pageCursor: "" },
    },
    {
      kind: "request",
      id: 1,
      method: "session.ack",
      params: { subscriptionId: "", cursor: "cursor-1" },
    },
    { kind: "request", id: 1, method: "session.fork", params: { sessionId } },
    {
      kind: "request",
      id: 1,
      method: "session.send",
      params: { sessionId, content: "bad", delivery: "prompt" },
    },
    {
      kind: "request",
      id: 1,
      method: "session.send",
      params: { sessionId, content: [], delivery: "later" },
    },
    {
      kind: "request",
      id: 1,
      method: "session.shell",
      params: { sessionId, command: "", excluded: false },
    },
    {
      kind: "request",
      id: 1,
      method: "session.shell",
      params: { sessionId, command: "pwd", excluded: "no" },
    },
    { kind: "request", id: 1, method: "session.configure", params: { sessionId } },
    {
      kind: "request",
      id: 1,
      method: "session.configure",
      params: { sessionId, thinkingLevel: "extreme" },
    },
    {
      kind: "request",
      id: 1,
      method: "session.interaction.respond",
      params: { sessionId, interactionId: "interaction-1", action: "maybe" },
    },
    {
      kind: "request",
      id: 1,
      method: "session.workspace.diff",
      params: { sessionId, scope: "everything" },
    },
    {
      kind: "request",
      id: 1,
      method: "session.workspace.checkpoint",
      params: { sessionId, enabled: "yes" },
    },
    {
      kind: "request",
      id: 1,
      method: "session.blob.start",
      params: { sessionId, mediaType: "bad", sizeBytes: -1 },
    },
    {
      kind: "request",
      id: 1,
      method: "session.blob.read",
      params: { sessionId, sha256: "bad", offset: 0, length: 4 },
    },
  ]) {
    assert.throws(() => parseWireRequest(request), ProtocolValidationError);
  }
});

test("validates frozen snapshot pages", () => {
  const event = {
    version: 1,
    id: "00000000-0000-4000-8000-000000000001",
    sessionId,
    parentId: null,
    timestamp: 1,
    type: "session.created",
    payload: { cwd: "/repo" },
  };
  assert.deepEqual(parseSnapshotPage({ events: [event], complete: true }, sessionId), {
    events: [event],
    complete: true,
  });
  assert.throws(
    () => parseSnapshotPage({ events: [], complete: false }, sessionId),
    ProtocolValidationError,
  );
  assert.throws(
    () => parseSnapshotPage({ events: [event], complete: false }, sessionId),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseSnapshotPage(
        {
          events: [{ ...event, sessionId: "123e4567-e89b-42d3-a456-426614174001" }],
          complete: true,
        },
        sessionId,
      ),
    ProtocolValidationError,
  );

  const subscribed = {
    kind: "success",
    id: 8,
    method: "session.subscribe",
    result: {
      subscriptionId: "subscription-1",
      sessionId,
      snapshot: {
        snapshotId: "snapshot-1",
        sessionId,
        boundaryCursor: "cursor-1",
        eventCount: 1,
        page: { events: [event], complete: true },
      },
    },
  } as const;
  assert.deepEqual(parseServerMessage(subscribed), subscribed);
  assert.throws(
    () =>
      parseServerMessage({
        ...subscribed,
        result: {
          ...subscribed.result,
          snapshot: { ...subscribed.result.snapshot, eventCount: 2 },
        },
      }),
    ProtocolValidationError,
  );
});

test("validates bounded workspace diff responses", () => {
  const value = {
    scope: "last-turn",
    checkpointId: "123e4567-e89b-42d3-a456-426614174001",
    files: [
      {
        path: "src/app.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1 @@",
        truncated: false,
      },
    ],
  };
  assert.deepEqual(parseWorkspaceDiff(value), value);
  assert.throws(
    () => parseWorkspaceDiff({ ...value, files: [{ ...value.files[0], path: "" }] }),
    ProtocolValidationError,
  );
  assert.throws(
    () => parseWorkspaceDiff({ ...value, files: [{ ...value.files[0], additions: -1 }] }),
    ProtocolValidationError,
  );
});

test("validates server messages and newline framing", () => {
  const hello = {
    kind: "hello",
    wireVersion: WIRE_PROTOCOL_VERSION,
    daemonInstanceId: "daemon-1",
    capabilities: ["session.create"],
    limits: { maxMessageBytes: 1_048_576, maxPendingRequests: 64 },
  } as const;
  assert.deepEqual(parseServerMessage(hello), hello);
  assert.equal(encodeWireMessage(hello), `${JSON.stringify(hello)}\n`);
  assert.deepEqual(parseServerMessage({ ...hello, wireVersion: 99 }), {
    ...hello,
    wireVersion: 99,
  });
  assert.throws(() => parseServerMessage({ ...hello, wireVersion: 0 }), ProtocolValidationError);

  const initialized = {
    kind: "success",
    id: 1,
    method: "connection.initialize",
    result: {
      attachmentId: "attachment-1",
      daemonInstanceId: "daemon-1",
      wireVersion: WIRE_PROTOCOL_VERSION,
      grantedCapabilities: ["session.create"],
      scope: "local_control",
      heartbeatIntervalMs: 20_000,
      presenceTimeoutMs: 60_000,
    },
  } as const;
  assert.deepEqual(parseServerMessage(initialized), initialized);
  const cancelled = {
    kind: "success",
    id: 2,
    method: "request.cancel",
    result: { cancellationRequested: true },
  } as const;
  assert.deepEqual(parseServerMessage(cancelled), cancelled);
  const listed = {
    kind: "success",
    id: 3,
    method: "session.list",
    result: {
      sessions: [
        {
          sessionId,
          cwd: "/repo",
          createdAt: 1,
          updatedAt: 2,
          userMessageCount: 1,
          firstUserMessage: "hello",
          lastUserMessage: "hello",
          runtime: { state: "idle" },
          attachmentCount: 1,
        },
      ],
      nextPageCursor: "page-2",
    },
  } as const;
  assert.deepEqual(parseServerMessage(listed), listed);
  assert.throws(
    () =>
      parseServerMessage({
        ...initialized,
        result: { ...initialized.result, unexpected: true },
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseServerMessage({
        ...initialized,
        result: { ...initialized.result, heartbeatIntervalMs: 0 },
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseServerMessage({
        ...initialized,
        result: { ...initialized.result, heartbeatIntervalMs: 60_000 },
      }),
    ProtocolValidationError,
  );
  assert.deepEqual(
    parseServerMessage({
      kind: "success",
      id: 2,
      method: "session.send",
      result: {
        operationId: "00000000-0000-4000-8000-000000000010",
        stopReason: "stop",
      },
    }),
    {
      kind: "success",
      id: 2,
      method: "session.send",
      result: {
        operationId: "00000000-0000-4000-8000-000000000010",
        stopReason: "stop",
      },
    },
  );
  assert.deepEqual(
    parseServerMessage({
      kind: "success",
      id: 3,
      method: "session.shell",
      result: {
        operationId: "00000000-0000-4000-8000-000000000010",
        isError: false,
        resultEventId: "00000000-0000-4000-8000-000000000011",
      },
    }),
    {
      kind: "success",
      id: 3,
      method: "session.shell",
      result: {
        operationId: "00000000-0000-4000-8000-000000000010",
        isError: false,
        resultEventId: "00000000-0000-4000-8000-000000000011",
      },
    },
  );
  assert.throws(
    () =>
      parseServerMessage({
        kind: "success",
        id: 2,
        method: "session.interrupt",
        result: { stopReason: "stop" },
      }),
    ProtocolValidationError,
  );
  assert.deepEqual(
    parseServerMessage({
      kind: "error",
      id: 2,
      method: "session.interrupt",
      error: {
        code: "operation_active",
        message: "An operation is active",
        retryable: false,
        details: { sessionId },
      },
    }),
    {
      kind: "error",
      id: 2,
      method: "session.interrupt",
      error: {
        code: "operation_active",
        message: "An operation is active",
        retryable: false,
        details: { sessionId },
      },
    },
  );

  const presence = {
    kind: "presence",
    attachments: [
      {
        attachmentId: "attachment-1",
        clientKind: "future_client",
        connectedAt: 10,
        lastSeenAt: 20,
        subscribedSessionIds: [sessionId],
        scope: "local_control",
      },
    ],
  } as const;
  assert.deepEqual(parseServerMessage(presence), presence);
  assert.throws(
    () =>
      parseServerMessage({
        ...presence,
        attachments: [{ ...presence.attachments[0], lastSeenAt: 9 }],
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseServerMessage({
        ...presence,
        attachments: [presence.attachments[0], presence.attachments[0]],
      }),
    ProtocolValidationError,
  );

  const activity = {
    kind: "activity",
    subscriptionId: "subscription-1",
    sessionId,
    frame: {
      operationId: "123e4567-e89b-42d3-a456-426614174001",
      sequence: 3,
      type: "text_delta",
      text: "streaming",
    },
  } as const;
  assert.deepEqual(parseServerMessage(activity), activity);
  const deliveredEvent = {
    kind: "event",
    subscriptionId: "subscription-1",
    sessionId,
    sequence: 1,
    cursor: "cursor-2",
    event: {
      version: 1,
      id: "00000000-0000-4000-8000-000000000001",
      sessionId,
      parentId: null,
      timestamp: 1,
      type: "session.created",
      payload: { cwd: "/repo" },
    },
  } as const;
  assert.deepEqual(parseServerMessage(deliveredEvent), deliveredEvent);
  assert.throws(
    () => parseServerMessage({ ...deliveredEvent, sequence: 0 }),
    ProtocolValidationError,
  );
  assert.throws(
    () =>
      parseServerMessage({
        ...activity,
        frame: { ...activity.frame, sequence: -1 },
      }),
    ProtocolValidationError,
  );
});
