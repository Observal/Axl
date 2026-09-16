// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationState } from "@axl/sdk";
import { Conversation } from "@axl/ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const conversation = {
  compactedEventIds: [],
  records: [
    {
      kind: "event",
      event: { id: "provider", type: "config.provider", payload: { providerId: "anthropic" } },
    },
    {
      kind: "event",
      event: { id: "model", type: "config.model", payload: { modelId: "claude-sonnet-4-6" } },
    },
    {
      kind: "event",
      event: { id: "thinking", type: "config.thinking", payload: { effective: "high" } },
    },
    {
      kind: "event",
      event: { id: "request", timestamp: 1000, type: "model.request_configured", payload: {} },
    },
    {
      kind: "event",
      event: {
        id: "user",
        timestamp: 1500,
        type: "user.message",
        payload: {
          content: [
            { type: "text", text: "Inspect this image" },
            {
              type: "blob",
              blob: {
                sha256: "a".repeat(64),
                mediaType: "image/png",
                sizeBytes: 2048,
                name: "reference.png",
              },
            },
            {
              type: "blob",
              blob: {
                sha256: "b".repeat(64),
                mediaType: "application/pdf",
                sizeBytes: 4096,
                name: "notes.pdf",
              },
            },
          ],
        },
      },
    },
    {
      kind: "event",
      event: {
        id: "tool",
        type: "tool.call",
        payload: { callId: "bash", name: "bash", input: { command: "test" } },
      },
    },
    {
      kind: "event",
      event: {
        id: "queue",
        type: "queue.enqueued",
        payload: { content: [{ type: "text", text: "Queued prompt" }] },
      },
    },
    {
      kind: "event",
      event: {
        id: "interrupt",
        type: "interrupt.requested",
        payload: { content: [{ type: "text", text: "Replacement prompt" }] },
      },
    },
    {
      kind: "event",
      event: {
        id: "assistant",
        timestamp: 3000,
        type: "assistant.message",
        payload: {
          content: [{ type: "text", text: "Partial answer" }],
          stopReason: "length",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 50,
            cacheWriteTokens: 0,
            reasoningTokens: 5,
            costUsd: 0.0124,
          },
        },
      },
    },
    {
      kind: "event",
      event: { id: "request-2", timestamp: 4000, type: "model.request_configured", payload: {} },
    },
    {
      kind: "event",
      event: {
        id: "assistant-2",
        timestamp: 5000,
        type: "assistant.message",
        payload: {
          content: [{ type: "text", text: "Unknown cost" }],
          stopReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      },
    },
  ],
  interactions: [],
  capabilitySearches: [],
  activeCapabilities: [],
  capabilityDenials: [],
  tools: [
    {
      callEventId: "tool",
      name: "bash",
      input: { command: "test" },
      renderIntent: "shell",
      result: {
        content: [{ type: "text", text: "bounded output" }],
        isError: false,
        details: {
          outputBytes: 319488,
          overflowBlob: {
            sha256: "c".repeat(64),
            mediaType: "text/plain",
            sizeBytes: 319488,
          },
        },
      },
    },
  ],
  queue: [
    {
      queueItemId: "queue",
      content: [{ type: "text", text: "Queued prompt" }],
      priority: "back",
      status: "paused",
    },
  ],
  interruptDeliveries: [
    {
      requestEventId: "interrupt",
      content: [{ type: "text", text: "Replacement prompt" }],
      status: "delivered",
    },
  ],
} as unknown as ConversationState;

test("renders message actions, attachments, delivery, truncation, and usage states", () => {
  const html = renderToStaticMarkup(
    createElement(Conversation, {
      conversation,
      resolveBlobUrl: () => "data:image/png;base64,AA==",
      loadFullToolOutput: async () => "complete output",
      onCopyMessage: () => undefined,
      onForkMessage: () => undefined,
    }),
  );

  assert.match(html, /reference\.png/);
  assert.match(html, /<img /);
  assert.match(html, /notes\.pdf/);
  assert.match(html, /Delivery paused/);
  assert.match(html, /Interrupted and delivered/);
  assert.match(html, /Output truncated/);
  assert.match(html, /312 KB total/);
  assert.match(html, /Load complete output/);
  assert.match(html, /Response incomplete/);
  assert.match(html, /Response details/);
  const usageSummary =
    /<summary><svg[^>]*>.*?<\/svg><span>Response details<\/span><\/summary>/u.exec(html)?.[0];
  assert.ok(usageSummary);
  assert.doesNotMatch(usageSummary, /anthropic|\$0\.0124/);
  assert.match(html, /anthropic \/ claude-sonnet-4-6/);
  assert.match(html, /Cost unavailable/);
  assert.match(html, /\$0\.0124/);
  assert.match(html, /Cache hit/);
  assert.match(html, /tok\/s/);
  assert.match(html, /Copy message/);
  assert.match(html, /Fork from this message/);
});

test("renders safe assistant Markdown without interpreting model HTML", () => {
  const markdown = {
    compactedEventIds: [],
    capabilitySearches: [],
    activeCapabilities: [],
    capabilityDenials: [],
    records: [
      {
        kind: "event",
        event: {
          id: "assistant-markdown",
          timestamp: 1000,
          type: "assistant.message",
          payload: {
            content: [
              {
                type: "text",
                text: "## Result\n\n- **ready**\n\n`code`\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))",
              },
            ],
            stopReason: "stop",
          },
        },
      },
    ],
    tools: [],
    interactions: [],
    operations: [],
    uncertainShellOperations: [],
    queue: [],
    interruptDeliveries: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    },
  } as unknown as ConversationState;

  const html = renderToStaticMarkup(createElement(Conversation, { conversation: markdown }));
  assert.match(html, /<h2>Result<\/h2>/);
  assert.match(html, /<strong>ready<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.doesNotMatch(html, /<script>/i);
  assert.doesNotMatch(html, /href="javascript:/i);
});

test("renders specialized tool details and actionable MCP forms", () => {
  const rich = {
    compactedEventIds: [],
    records: [
      {
        kind: "event",
        event: {
          id: "search",
          type: "tool.call",
          payload: { callId: "search", name: "web_search", input: { query: "Axl docs" } },
        },
      },
      {
        kind: "event",
        event: {
          id: "mcp",
          type: "tool.call",
          payload: {
            callId: "mcp",
            name: "mcp",
            input: { action: "call_tool", server: "issues", name: "lookup", arguments: { id: 1 } },
          },
        },
      },
      {
        kind: "event",
        event: {
          id: "workflow",
          type: "tool.call",
          payload: {
            callId: "workflow",
            name: "workflow_run",
            input: { workflow: "verify", action: "run" },
          },
        },
      },
      {
        kind: "event",
        event: {
          id: "interaction",
          type: "interaction.requested",
          payload: {
            interactionId: "form-1",
            kind: "mcp_elicitation_form",
            source: "mcp:issues",
            message: "Choose a channel",
            data: {
              request: {
                requestedSchema: {
                  type: "object",
                  properties: { channel: { type: "string", enum: ["alpha", "stable"] } },
                  required: ["channel"],
                },
              },
            },
          },
        },
      },
    ],
    tools: [
      {
        callEventId: "search",
        name: "web_search",
        input: { query: "Axl docs" },
        renderIntent: "search",
        result: {
          content: [{ type: "text", text: "Two results" }],
          isError: false,
          details: { resultCount: 2 },
        },
      },
      {
        callEventId: "mcp",
        name: "mcp",
        input: { action: "call_tool", server: "issues", name: "lookup", arguments: { id: 1 } },
        renderIntent: "mcp",
        result: {
          content: [{ type: "text", text: "AXL-1" }],
          isError: false,
          details: { durationMs: 4 },
        },
      },
      {
        callEventId: "workflow",
        name: "workflow_run",
        input: { workflow: "verify", action: "run" },
        renderIntent: "workflow",
        result: { content: [{ type: "text", text: "Passed" }], isError: false },
      },
    ],
    interactions: [
      {
        interactionId: "form-1",
        request: {
          id: "interaction",
          type: "interaction.requested",
          payload: {
            interactionId: "form-1",
            kind: "mcp_elicitation_form",
            source: "mcp:issues",
            message: "Choose a channel",
            data: {
              request: {
                requestedSchema: {
                  type: "object",
                  properties: { channel: { type: "string", enum: ["alpha", "stable"] } },
                  required: ["channel"],
                },
              },
            },
          },
        },
      },
    ],
    operations: [],
    uncertainShellOperations: [],
    queue: [],
    interruptDeliveries: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    },
  } as unknown as ConversationState;
  const html = renderToStaticMarkup(
    createElement(Conversation, {
      conversation: rich,
      onRespondInteraction: async () => undefined,
    }),
  );
  assert.match(html, /Searched/);
  assert.match(html, /Called MCP/);
  assert.match(html, /Ran workflow/);
  assert.match(html, /Complete input/);
  assert.match(html, /Result metadata/);
  assert.match(html, /MCP input/);
  assert.match(html, /<select/);
  assert.match(html, /Submit/);
});

test("hides compacted records and renders the retained summary", () => {
  const compacted = {
    compactedEventIds: ["old-message"],
    capabilitySearches: [],
    activeCapabilities: [],
    capabilityDenials: [],
    records: [
      {
        kind: "event",
        event: {
          id: "old-message",
          timestamp: 1000,
          type: "user.message",
          payload: { content: [{ type: "text", text: "obsolete transcript text" }] },
        },
      },
      {
        kind: "event",
        event: {
          id: "queued-compaction",
          timestamp: 1500,
          type: "compaction.queued",
          payload: { instructions: "Keep decisions" },
        },
      },
      {
        kind: "event",
        event: {
          id: "compaction",
          timestamp: 2000,
          type: "context.compacted",
          payload: {
            summary: "## Retained context\n\nKeep the sandbox active.",
            replacedEventIds: ["old-message"],
          },
        },
      },
      {
        kind: "event",
        event: {
          id: "unsafe",
          timestamp: 3000,
          type: "sandbox.configured",
          payload: { provider: "none", enforced: false, controls: [] },
        },
      },
    ],
    tools: [],
    interactions: [],
    operations: [],
    uncertainShellOperations: [],
    queue: [],
    interruptDeliveries: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    },
    closed: false,
  } as unknown as ConversationState;

  const html = renderToStaticMarkup(createElement(Conversation, { conversation: compacted }));
  assert.doesNotMatch(html, /obsolete transcript text/);
  assert.match(html, /Compaction queued/);
  assert.match(html, /active response/);
  assert.match(html, /Context compacted/);
  assert.match(html, /Retained context/);
  assert.match(html, /Original history remains in the canonical session log/);
  assert.match(html, /Sandbox is not enforced/);
});

test("renders a pending user questionnaire as a stepped option list", () => {
  const request = {
    id: "question-event",
    type: "interaction.requested",
    payload: {
      interactionId: "question-1",
      kind: "user_question",
      source: "ask_user_question",
      message: "Which runtime?",
      data: {
        questions: [
          {
            header: "Runtime",
            question: "Which runtime?",
            options: [
              { label: "Node", description: "Use Node.js", preview: "node index.js" },
              { label: "Bun", description: "Use Bun" },
            ],
          },
          {
            header: "Checks",
            question: "Which checks?",
            multiSelect: true,
            options: [
              { label: "Test", description: "Run tests" },
              { label: "Lint", description: "Run lint" },
            ],
          },
        ],
      },
    },
  };
  const state = {
    compactedEventIds: [],
    records: [{ kind: "event", event: request }],
    tools: [],
    interactions: [{ interactionId: "question-1", request }],
    operations: [],
    uncertainShellOperations: [],
    queue: [],
    interruptDeliveries: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    },
    closed: false,
  } as unknown as ConversationState;
  const html = renderToStaticMarkup(
    createElement(Conversation, {
      conversation: state,
      onRespondInteraction: async () => undefined,
    }),
  );
  assert.match(html, /Which runtime\?/);
  assert.match(html, />1\/2</);
  assert.match(html, /Use Node\.js/);
  assert.match(html, /Type something else…/);
  assert.doesNotMatch(html, /type="radio"/);
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.doesNotMatch(html, /Which checks\?/);
});
