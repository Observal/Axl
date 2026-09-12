// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { AxlClient } from "@axl/sdk";
import { loadProviderDirectory } from "../src/model-catalog.ts";

test("caches the daemon model directory until an explicit refresh", async () => {
  let calls = 0;
  let statusCalls = 0;
  const client = {
    connection: { grantedCapabilities: ["provider.auth.status"] },
    providerAuthenticationStatus: async () => {
      statusCalls += 1;
      return {
        providers: [
          {
            providerId: "anthropic",
            phase: "authenticated" as const,
            method: "oauth" as const,
            source: "Anthropic OAuth",
          },
        ],
      };
    },
    listProviders: async () => {
      calls += 1;
      return {
        providers: [
          {
            providerId: "anthropic",
            displayName: "Anthropic",
            enabled: true,
            authMethods: [],
            loginMethods: [],
            authentication: { providerId: "anthropic", phase: "idle" },
            catalog: { refreshable: false },
            models: [
              {
                providerId: "anthropic",
                modelId: "claude-sonnet-4-6",
                displayName: "Claude Sonnet 4.6",
                apiDialect: "anthropic-messages",
                capabilities: { toolUse: true, structuredOutput: true, imageInput: true },
                reasoning: true,
                supportedThinkingLevels: ["low", "high"] as const,
                contextWindow: 200_000,
                maxOutputTokens: 64_000,
                availability: { status: "available" as const },
              },
            ],
          },
        ],
      };
    },
  } as unknown as AxlClient;

  const directory = await loadProviderDirectory(client);
  assert.equal(directory.providers[0]?.providerId, "anthropic");
  assert.equal(directory.providers[0]?.authentication.phase, "authenticated");
  assert.equal(directory.models[0]?.modelId, "claude-sonnet-4-6");
  await loadProviderDirectory(client);
  assert.equal(calls, 1);
  assert.equal(statusCalls, 1);
  await loadProviderDirectory(client, true);
  assert.equal(calls, 2);
  assert.equal(statusCalls, 2);
});
