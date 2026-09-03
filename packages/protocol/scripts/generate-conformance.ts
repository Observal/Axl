// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVENT_FORMAT_VERSION,
  type EventPayloadMap,
  EVENT_TYPES,
  parseEvent,
  type EventType,
  isRetryableMutationMethod,
  isRpcErrorAllowed,
  isRpcErrorRetryable,
  parseEventId,
  parseOperationId,
  parseServerMessage,
  parseSessionId,
  parseWireRequest,
  PRE_RPC_ERROR_CODES,
  RPC_ERROR_CODES,
  RPC_METHOD_ERROR_CODES,
  type RpcMethod,
  RPC_METHODS,
  UNIVERSAL_RPC_ERROR_CODES,
  type RpcParams,
  type RpcResult,
  WIRE_PROTOCOL_VERSION,
} from "../src/index.ts";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
const otherSessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174001");
const eventId = parseEventId("00000000-0000-4000-8000-000000000001");
const queueItemId = parseEventId("00000000-0000-4000-8000-000000000005");
const otherEventId = parseEventId("00000000-0000-4000-8000-000000000002");
const operationId = parseOperationId("00000000-0000-4000-8000-000000000010");
const idempotencyKey = "00000000-0000-4000-8000-000000000020";
const digest = "a".repeat(64);

const eventPayloads = {
  "session.created": { cwd: "/workspace" },
  "session.resumed": {},
  "session.closed": { reason: "completed" },
  "user.message": { content: [{ type: "text", text: "hello" }] },
  "queue.enqueued": { content: [{ type: "text", text: "later" }], priority: "back" },
  "queue.requeued": { queueItemId, priority: "front" },
  "queue.started": { queueItemId },
  "queue.paused": { queueItemId, reason: "daemon_restart" },
  "user.shell": {
    command: "pwd",
    content: [{ type: "text", text: "/workspace" }],
    isError: false,
    excluded: false,
  },
  "assistant.message": {
    content: [
      { type: "thinking", text: "reasoning" },
      { type: "text", text: "answer" },
    ],
    stopReason: "stop",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      reasoningTokens: 3,
      costUsd: 0.01,
    },
  },
  "tool.call": { callId: "call-1", name: "read", input: { path: "README.md" } },
  "tool.result": {
    callId: "call-1",
    name: "read",
    content: [{ type: "text", text: "contents" }],
    isError: false,
    details: { lines: 1 },
  },
  "config.model": { modelId: "model-1" },
  "config.provider": { providerId: "provider-1" },
  "config.entitlement": { entitlementId: "credential-reference" },
  "config.thinking": { requested: "high", effective: "medium", clamped: true },
  "config.dialect": {
    dialectId: "openai-chat",
    rosterFingerprint: digest,
    reason: "model_switch",
  },
  "prompt.section": { name: "identity", source: "core", content: "You are Axl." },
  "tool.schema": {
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", required: ["path"] },
  },
  "context.injected": { source: "skill", content: "Follow this procedure." },
  "context.extension": {
    extensionId: "example",
    source: "hook",
    content: "Additional context",
  },
  "permission.requested": { capability: "filesystem.write", description: "Write README.md" },
  "permission.resolved": { requestId: eventId, decision: "allow_once" },
  "interaction.requested": {
    interactionId: "interaction-1",
    kind: "mcp_elicitation_form",
    source: "mcp:example",
    message: "Choose a value",
    data: { requestedSchema: { type: "object" } },
  },
  "interaction.resolved": {
    interactionId: "interaction-1",
    action: "accept",
    content: { answer: "yes" },
  },
  "sandbox.configured": {
    provider: "bubblewrap",
    enforced: true,
    controls: ["filesystem"],
    details: { landlock: "full" },
  },
  "sandbox.violation": { capability: "filesystem.write", reason: "outside workspace" },
  "context.compacted": { summary: "Earlier work", replacedEventIds: [otherEventId] },
  "session.error": { code: "provider_failed", message: "Provider unavailable", retryable: true },
  "child.result": {
    childSessionId: otherSessionId,
    status: "completed",
    result: { summary: "done" },
  },
} satisfies { readonly [Type in EventType]: EventPayloadMap[Type] };

const events = Object.entries(eventPayloads).map(([type, payload], index) =>
  parseEvent({
    version: EVENT_FORMAT_VERSION,
    id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
    sessionId,
    operationId,
    parentId: null,
    timestamp: 1_725_000_000_000 + index,
    type,
    payload,
  }),
);
const createdEvent = events[0];
if (createdEvent === undefined) throw new Error("Canonical event fixtures are empty");

const params = {
  "daemon.info": {},
  "connection.initialize": {
    client: { kind: "fixture", version: "1.0.0", instanceId: "fixture-1" },
    requestedCapabilities: ["session.create"],
  },
  "connection.ping": {},
  "request.cancel": { requestId: 7 },
  "session.create": { cwd: "/workspace", profile: "minimal" },
  "session.resume": { sessionId },
  "session.list": { scope: "all_local", order: "recent", pageSize: 50 },
  "session.history": { snapshotId: "snapshot-1", pageCursor: "page-1" },
  "session.ack": { subscriptionId: "subscription-1", cursor: "cursor-1" },
  "session.unsubscribe": { subscriptionId: "subscription-1" },
  "session.fork": { sessionId, fromEventId: eventId },
  "session.clone": { sessionId },
  "session.send": { sessionId, content: [{ type: "text", text: "hello" }], delivery: "prompt" },
  "session.queue.enqueue": {
    sessionId,
    content: [{ type: "text", text: "later" }],
    priority: "back",
  },
  "session.queue.requeue": { sessionId, queueItemId: eventId, priority: "front" },
  "session.shell": { sessionId, operationId, command: "pwd", excluded: false },
  "session.interrupt": { sessionId },
  "session.reload": { sessionId },
  "session.configure": { sessionId, modelId: "model-1", thinkingLevel: "medium" },
  "session.interaction.respond": {
    sessionId,
    interactionId: "interaction-1",
    action: "accept",
    content: { answer: "yes" },
  },
  "session.subscribe": { sessionId },
  "session.workspace.list": { sessionId, path: "", pageSize: 100 },
  "session.workspace.read": { sessionId, path: "README.md", maxLines: 100, maxBytes: 65_536 },
  "session.workspace.status": { sessionId, scope: "working" },
  "session.workspace.diff": {
    sessionId,
    entryId: "entry-1",
    contextLines: 3,
    repositoryGeneration: "repository-1",
    maxBytes: 65_536,
  },
  "session.workspace.checkpoint": { sessionId, enabled: true },
  "session.blob.start": { sessionId, mediaType: "image/png", sizeBytes: 4, name: "clip.png" },
  "session.blob.chunk": { sessionId, uploadId: "upload-1", offset: 0, data: "YWJjZA==" },
  "session.blob.commit": { sessionId, uploadId: "upload-1" },
  "session.blob.abort": { sessionId, uploadId: "upload-1" },
  "session.blob.read": { sessionId, sha256: digest, offset: 0, length: 4 },
  "session.dispose": { sessionId },
} satisfies { readonly [Method in RpcMethod]: RpcParams<Method> };

const opened = {
  sessionId,
  cwd: "/workspace",
  runtime: { state: "idle" },
  profile: "minimal",
} as const;
const entry = {
  entryId: "entry-1",
  path: "README.md",
  area: "unstaged",
  kind: "modified",
  binary: false,
  submodule: false,
} as const;
const results = {
  "daemon.info": { securityMode: "sandboxed", sandboxProvider: "bubblewrap" },
  "connection.initialize": {
    attachmentId: "attachment-1",
    daemonInstanceId: "daemon-1",
    wireVersion: WIRE_PROTOCOL_VERSION,
    grantedCapabilities: ["session.create"],
    scope: "local_control",
    heartbeatIntervalMs: 20_000,
    presenceTimeoutMs: 60_000,
  },
  "connection.ping": {},
  "request.cancel": { cancellationRequested: true },
  "session.create": opened,
  "session.resume": opened,
  "session.list": {
    sessions: [
      {
        sessionId,
        cwd: "/workspace",
        createdAt: 1,
        updatedAt: 2,
        userMessageCount: 1,
        firstUserMessage: "hello",
        lastUserMessage: "hello",
        runtime: { state: "idle" },
        attachmentCount: 1,
      },
    ],
  },
  "session.history": {
    snapshotId: "snapshot-1",
    page: { events: [createdEvent], complete: true },
  },
  "session.ack": { cursor: "cursor-1" },
  "session.unsubscribe": { unsubscribed: true },
  "session.fork": { ...opened, selectedText: "hello" },
  "session.clone": opened,
  "session.send": { operationId, stopReason: "stop" },
  "session.queue.enqueue": { queueItemId: eventId, state: "queued" },
  "session.queue.requeue": { queueItemId: eventId, state: "queued" },
  "session.shell": { operationId, isError: false, resultEventId: eventId },
  "session.interrupt": { interrupted: true, operationId },
  "session.reload": { boundaryEventIds: [eventId] },
  "session.configure": {
    modelId: "model-1",
    requestedThinkingLevel: "medium",
    effectiveThinkingLevel: "medium",
    profile: "minimal",
    boundaryEventIds: [eventId],
  },
  "session.interaction.respond": {
    interactionId: "interaction-1",
    resolutionEventId: eventId,
  },
  "session.subscribe": {
    subscriptionId: "subscription-1",
    sessionId,
    snapshot: {
      snapshotId: "snapshot-1",
      sessionId,
      boundaryCursor: "cursor-1",
      eventCount: 1,
      page: { events: [createdEvent], complete: true },
    },
  },
  "session.workspace.list": {
    workspaceGeneration: "workspace-1",
    entries: [{ path: "README.md", name: "README.md", type: "file", sizeBytes: 10 }],
  },
  "session.workspace.read": {
    workspaceGeneration: "workspace-1",
    fileRevision: "file-1",
    path: "README.md",
    encoding: "utf-8",
    text: "hello\n",
    startLine: 1,
    endLine: 1,
    totalLines: 1,
    truncated: false,
  },
  "session.workspace.status": {
    workspaceGeneration: "workspace-1",
    repositoryGeneration: "repository-1",
    repositoryRoot: "",
    branch: { state: "branch", name: "main", head: digest },
    sparseCheckout: false,
    entries: [entry],
  },
  "session.workspace.diff": {
    workspaceGeneration: "workspace-1",
    repositoryGeneration: "repository-1",
    entry,
    oldRevision: "old-1",
    newRevision: "new-1",
    hunks: [
      {
        header: "@@ -1 +1 @@",
        lines: [
          { kind: "deletion", oldLine: 1, text: "old" },
          { kind: "addition", newLine: 1, text: "new" },
        ],
      },
    ],
    binary: false,
  },
  "session.workspace.checkpoint": { enabled: true, checkpointId: "checkpoint-1" },
  "session.blob.start": { uploadId: "upload-1", chunkBytes: 65_536 },
  "session.blob.chunk": { nextOffset: 4 },
  "session.blob.commit": { sha256: digest, mediaType: "image/png", sizeBytes: 4, name: "clip.png" },
  "session.blob.abort": { aborted: true },
  "session.blob.read": { data: "YWJjZA==", offset: 0, nextOffset: 4, eof: true },
  "session.dispose": { disposed: true, historyPreserved: true },
} satisfies { readonly [Method in RpcMethod]: RpcResult<Method> };

const requests = Object.entries(params).map(([method, methodParams], index) => ({
  kind: "request",
  id: index + 1,
  method,
  params: methodParams,
  ...(isRetryableMutationMethod(method as RpcMethod) ? { idempotencyKey } : {}),
}));
const successes = Object.entries(results).map(([method, result], index) => ({
  kind: "success",
  id: index + 1,
  method,
  result,
}));
const errors = RPC_ERROR_CODES.map((code, index) => {
  if ((PRE_RPC_ERROR_CODES as readonly string[]).includes(code)) {
    return {
      kind: "error" as const,
      id: -1,
      error: { code, message: `Fixture error: ${code}`, retryable: isRpcErrorRetryable(code) },
    };
  }
  const method = RPC_METHODS.find((candidate) => isRpcErrorAllowed(candidate, code));
  if (method === undefined) throw new Error(`No RPC method allows ${code}`);
  return {
    kind: "error" as const,
    id: index + 1,
    method,
    error: { code, message: `Fixture error: ${code}`, retryable: isRpcErrorRetryable(code) },
  };
});
const allowedErrors = RPC_METHODS.flatMap((method, methodIndex) =>
  [...new Set([...UNIVERSAL_RPC_ERROR_CODES, ...RPC_METHOD_ERROR_CODES[method]])].map(
    (code, codeIndex) => ({
      kind: "error" as const,
      id: methodIndex * 100 + codeIndex + 1,
      method,
      error: {
        code,
        message: `Fixture ${method} error: ${code}`,
        retryable: isRpcErrorRetryable(code),
      },
    }),
  ),
);
const serverMessages = [
  {
    kind: "hello",
    wireVersion: WIRE_PROTOCOL_VERSION,
    daemonInstanceId: "daemon-1",
    capabilities: ["session.create", "session.subscribe", "session.activity", "session.presence"],
    limits: { maxMessageBytes: 1_048_576, maxPendingRequests: 64 },
  },
  {
    kind: "error",
    id: 1,
    method: "session.create",
    error: { code: "bad_request", message: "Invalid request", retryable: false },
  },
  {
    kind: "event",
    subscriptionId: "subscription-1",
    sessionId,
    sequence: 1,
    cursor: "cursor-1",
    event: createdEvent,
  },
  {
    kind: "activity",
    subscriptionId: "subscription-1",
    sessionId,
    frame: { operationId, sequence: 1, type: "text_delta", text: "working" },
  },
  {
    kind: "presence",
    attachments: [
      {
        attachmentId: "attachment-1",
        clientKind: "tui",
        connectedAt: 1,
        lastSeenAt: 2,
        subscribedSessionIds: [sessionId],
        scope: "local_control",
      },
    ],
  },
];

const fixtureMethods = Object.keys(params).sort();
if (JSON.stringify(fixtureMethods) !== JSON.stringify([...RPC_METHODS].sort())) {
  throw new Error("Request fixtures do not cover every RPC method");
}
if (JSON.stringify(Object.keys(results).sort()) !== JSON.stringify([...RPC_METHODS].sort())) {
  throw new Error("Success fixtures do not cover every RPC method");
}
if (JSON.stringify(Object.keys(eventPayloads).sort()) !== JSON.stringify([...EVENT_TYPES].sort())) {
  throw new Error("Event fixtures do not cover every canonical event type");
}
for (const request of requests) parseWireRequest(request);
for (const success of successes) parseServerMessage(success);
for (const message of serverMessages) parseServerMessage(message);
for (const error of errors) parseServerMessage(error);
for (const error of allowedErrors) parseServerMessage(error);
for (const event of events) parseEvent(event);

const document = {
  "SPDX-FileCopyrightText": "2026 Hari Srinivasan",
  "SPDX-License-Identifier": "Apache-2.0",
  _generated: "@generated by packages/protocol/scripts/generate-conformance.ts; do not edit.",
  wireVersion: WIRE_PROTOCOL_VERSION,
  requests,
  successes,
  errors,
  allowedErrors,
  serverMessages,
  events,
};
const output = `${JSON.stringify(document, null, 2).replace(
  /\[\n\s+("(?:[^"\\]|\\.)*")\n\s*\]/g,
  "[$1]",
)}\n`;
const defaultTarget = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../test/fixtures/conformance.json",
);
const check = process.argv[2] === "--check";
const target = check ? resolve(process.cwd(), process.argv[3] ?? defaultTarget) : defaultTarget;
if (check) {
  if (readFileSync(target, "utf8") !== output) process.exitCode = 1;
} else {
  writeFileSync(target, output);
}
