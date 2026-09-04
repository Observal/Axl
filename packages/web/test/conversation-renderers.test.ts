// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ConversationProjector,
  EVENT_FORMAT_VERSION,
  parseEvent,
  parseOperationId,
  parseSessionId,
  type CanonicalEvent,
  type EventPayloadMap,
  type EventType,
} from "@axl/sdk";

import {
  ConversationPresentation,
  interactionFields,
  parseInteractionValue,
} from "../dist/conversation.js";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
const operationId = parseOperationId("00000000-0000-4000-8000-000000000099");

function fixtureProjector(): ConversationProjector {
  let counter = 0;
  let parentId: string | null = null;
  const projector = new ConversationProjector(sessionId);
  const add = <Type extends EventType>(
    type: Type,
    payload: EventPayloadMap[Type],
  ): CanonicalEvent<Type> => {
    counter += 1;
    const canonical = parseEvent({
      version: EVENT_FORMAT_VERSION,
      id: `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`,
      sessionId,
      parentId,
      operationId,
      timestamp: counter * 10,
      type,
      payload,
    });
    parentId = canonical.id;
    projector.applyEvent(canonical);
    return canonical as CanonicalEvent<Type>;
  };

  const first = add("user.message", {
    content: [
      { type: "text", text: "Treat **Markdown** and <script>alert('user')</script> as text." },
    ],
  });
  add("assistant.message", {
    content: [
      { type: "thinking", text: "Untrusted <b>reasoning</b>" },
      { type: "text", text: "Assistant <img src=x onerror=alert(1)>" },
    ],
    stopReason: "aborted",
    usage: {
      inputTokens: 12,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      reasoningTokens: 3,
      costUsd: 0.02,
    },
  });

  const tools = [
    ["bash", { command: "printf '<script>shell</script>'" }],
    ["read", { path: "<img src=x>.ts" }],
    ["edit", { path: "src/app.ts", patch: "- old\n+ <script>new</script>" }],
    ["grep", { pattern: "needle", path: "src" }],
    ["web_search", { query: "untrusted <query>" }],
    ["mcp_fixture__inspect", { server: "fixture", tool: "inspect" }],
    ["workflow_run", { workflow: "verify" }],
    ["future_<tool>", { payload: "x".repeat(20_000) }],
  ] as const;
  for (const [name, input] of tools) {
    const callId = `call-${name}`;
    add("tool.call", { callId, name, input });
    add("tool.result", {
      callId,
      name,
      content: [{ type: "text", text: `result from ${name}: <script>output</script>` }],
      isError: name.startsWith("future"),
      details: { permissionReason: "fixture policy" },
    });
  }

  const permission = add("permission.requested", {
    capability: "filesystem.write",
    description: "Write <unsafe> filename",
  });
  add("permission.resolved", {
    requestId: permission.id,
    decision: "deny",
    reason: "Outside the allowed workspace",
  });
  add("context.compacted", {
    summary: "Summary <strong>is text</strong>",
    replacedEventIds: [first.id],
  });
  add("session.error", {
    code: "fixture_error",
    message: "Provider <script>failure</script>",
    retryable: false,
    details: { cause: "bounded" },
  });
  add("queue.enqueued", {
    content: [{ type: "text", text: "queued <item>" }],
    priority: "back",
  });
  add("interaction.requested", {
    interactionId: "form-1",
    kind: "mcp_elicitation_form",
    source: "mcp:fixture",
    message: "Provide structured values",
    data: {
      request: {
        requestedSchema: {
          type: "object",
          required: ["name", "count"],
          properties: {
            name: { type: "string", description: "Untrusted <name>" },
            count: { type: "integer" },
            enabled: { type: "boolean" },
            mode: { type: "string", enum: ["safe", "safer"] },
          },
        },
      },
    },
  });
  projector.applyActivity({
    operationId: parseOperationId("00000000-0000-4000-8000-000000000100"),
    sequence: 1,
    type: "snapshot",
    text: "live <script>tail</script>",
    thinking: "live <em>thinking</em>",
    toolCalls: [{ callId: "transient", name: "future_live" }],
  });
  counter += 1;
  projector.applyUnknownEvent({
    id: `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`,
    sessionId,
    parentId,
    timestamp: counter * 10,
    type: "future.<script>event</script>",
    payload: { html: "<script>alert('unknown')</script>" },
  });
  return projector;
}

function render(projector: ConversationProjector): string {
  return renderToStaticMarkup(
    createElement(ConversationPresentation, {
      state: projector.state,
      interactionDisabled: false,
      queueDisabled: false,
      onRespond: () => undefined,
      onRequeue: () => undefined,
    }),
  );
}

test("deterministic projector fixtures drive every tool renderer and bounded generic fallbacks", () => {
  const first = fixtureProjector();
  const second = fixtureProjector();
  assert.deepEqual(first.state, second.state);
  const html = render(first);

  for (const intent of ["shell", "read", "edit", "search", "web", "mcp", "workflow", "generic"]) {
    assert.match(html, new RegExp(`data-render-intent="${intent}"`));
  }
  assert.match(html, /Unknown event: future/);
  assert.match(html, /characters omitted/);
  assert.match(html, /Latency<\/dt><dd>10 ms/);
  assert.match(html, /Outside the allowed workspace/);
  assert.match(html, /Live details/);
  assert.match(html, /Response interrupted/);
  assert.match(html, /Context compacted/);
  assert.match(html, /Prompt queue/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("structured interaction fixtures expose bounded typed fields and values", () => {
  const interaction = fixtureProjector().state.interactions[0];
  assert.ok(interaction);
  const fields = interactionFields(interaction);
  assert.deepEqual(
    fields.map(({ name, type, required }) => ({ name, type, required })),
    [
      { name: "name", type: "string", required: true },
      { name: "count", type: "integer", required: true },
      { name: "enabled", type: "boolean", required: false },
      { name: "mode", type: "string", required: false },
    ],
  );
  const [name, count, enabled, mode] = fields;
  assert.ok(name && count && enabled && mode);
  assert.equal(parseInteractionValue(name, "Axl"), "Axl");
  assert.equal(parseInteractionValue(count, "3"), 3);
  assert.equal(parseInteractionValue(enabled, "on"), true);
  assert.equal(parseInteractionValue(enabled, null), false);
  assert.throws(() => parseInteractionValue(count, "3.5"), /must be a integer/);
  assert.throws(() => parseInteractionValue(mode, "unsafe"), /not an allowed value/);

  const html = render(fixtureProjector());
  assert.match(html, /name \(required\)/);
  assert.match(html, /type="number"/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /<option value="safe">safe<\/option>/);
});
