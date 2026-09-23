// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { DaemonExtensionFactory } from "@observal/axl/extension-api";

const model = {
  providerId: "example-provider",
  modelId: "example-model",
  displayName: "Example model",
  contextWindow: 32_000,
  maxOutputTokens: 4_096,
  capabilities: {
    input: ["text"],
    reasoning: false,
    tools: false,
    streaming: true,
  },
  pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

const extension: DaemonExtensionFactory = (axl) =>
  axl.registerProvider({
    id: "example-provider",
    displayName: "Example provider",
    authMethods: [],
    listModels: async () => [model],
    stream: async function* () {
      yield { type: "text_delta", text: "Hello from the example provider." };
      yield {
        type: "completed",
        stopReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  });

export default extension;
