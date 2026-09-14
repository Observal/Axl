// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionId } from "@axl/protocol";
import {
  type AxlClient,
  ProviderDirectoryController,
  SessionConfigurationController,
} from "../src/index.ts";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");

test("provider directory retains usable inventory when authentication status fails", async () => {
  let listCalls = 0;
  const client = {
    connection: { grantedCapabilities: ["provider.auth.status"] },
    listProviders: async () => {
      listCalls += 1;
      return {
        providers: [
          {
            providerId: "provider",
            displayName: "Provider",
            enabled: true,
            authMethods: [],
            loginMethods: [],
            authentication: { providerId: "provider", phase: "idle" },
            catalog: { refreshable: true },
            models: [
              {
                providerId: "provider",
                modelId: "available",
                displayName: "Available",
                apiDialect: "openai-responses",
                capabilities: { toolUse: true, structuredOutput: true, imageInput: false },
                reasoning: false,
                supportedThinkingLevels: [],
                contextWindow: 10,
                maxOutputTokens: 10,
                availability: { status: "unavailable", reason: "Region unavailable" },
              },
            ],
          },
        ],
      };
    },
    providerAuthenticationStatus: async () => {
      throw new Error("Status failed");
    },
    onReconnect: () => () => undefined,
  } as unknown as AxlClient;
  const controller = new ProviderDirectoryController(client);

  const state = await controller.load();
  assert.equal(state.status, "ready");
  assert.equal(state.error, "Status failed");
  assert.equal(state.models[0]?.availability.reason, "Region unavailable");
  assert.equal(await controller.load(), state);
  assert.equal(listCalls, 1);
  controller.dispose();
});

test("provider refresh exposes its target and supports cancellation", async () => {
  const client = {
    connection: { grantedCapabilities: [] },
    listProviders: async () => ({ providers: [] }),
    refreshProviderCatalogs: async (_params: unknown, options: { readonly signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      }),
    onReconnect: () => () => undefined,
  } as unknown as AxlClient;
  const controller = new ProviderDirectoryController(client);
  await controller.load();

  const refreshing = controller.refresh("provider");
  assert.deepEqual(controller.state.refresh, { providerId: "provider" });
  controller.cancelRefresh();
  await assert.rejects(refreshing, { name: "AbortError" });
  assert.equal(controller.state.status, "ready");
  assert.equal(controller.state.refresh, undefined);
  controller.dispose();
});

test("configuration mutations run in order and retain field-scoped failures", async () => {
  const calls: string[] = [];
  const client = {
    async request(_method: string, params: { modelId?: string; thinkingLevel?: string }) {
      const value = params.modelId ?? params.thinkingLevel ?? "";
      calls.push(`start:${value}`);
      await Promise.resolve();
      calls.push(`end:${value}`);
      if (params.thinkingLevel) throw new Error("Unsupported effort");
      return {
        providerId: "provider",
        modelId: params.modelId ?? "model",
        requestedThinkingLevel: "medium",
        effectiveThinkingLevel: "medium",
        requestSettings: { maxOutputTokens: null, idleTimeoutMs: null },
        profile: "standard",
        webFetch: false,
        webSearch: false,
        userQuestions: false,
        boundaryEventIds: [],
      };
    },
  } as unknown as AxlClient;
  const controller = new SessionConfigurationController(client);
  const first = controller.configure(sessionId, { modelId: "first" });
  const second = controller.configure(sessionId, { thinkingLevel: "high" });

  await first;
  await assert.rejects(second, /Unsupported effort/);
  assert.deepEqual(calls, ["start:first", "end:first", "start:high", "end:high"]);
  assert.equal(controller.state.errors.thinkingLevel, "Unsupported effort");
  assert.equal(controller.state.errors.modelId, undefined);
  assert.deepEqual(controller.state.pending, []);
  controller.dispose();
});
