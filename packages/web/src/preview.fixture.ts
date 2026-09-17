// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { type ConversationState, parseSessionId } from "@axl/sdk";
import type { WebPreview } from "./app.tsx";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174099");
const conversation: ConversationState = {
  records: [],
  compactedEventIds: [],
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
  profile: "standard",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  thinking: "off",
  webSearch: true,
  webFetch: true,
  closed: false,
};

export const previewFixture: WebPreview = {
  sessions: [
    {
      sessionId,
      cwd: "/workspace/axl",
      createdAt: 1,
      updatedAt: 1,
      userMessageCount: 0,
      securityMode: "sandboxed",
      sandboxProvider: "bubblewrap",
      runtime: { state: "idle" },
      attachmentCount: 1,
    },
  ],
  opened: {
    sessionId,
    cwd: "/workspace/axl",
    runtime: { state: "idle" },
    profile: "standard",
  },
  conversation,
  modelCatalog: [
    {
      providerId: "anthropic",
      providerDisplayName: "Anthropic",
      modelId: "claude-haiku-4-5",
      displayName: "Claude Haiku 4.5",
      thinkingLevels: ["off", "low", "medium", "high"],
      availability: { status: "available" },
    },
  ],
};
