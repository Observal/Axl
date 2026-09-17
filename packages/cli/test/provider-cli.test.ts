// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { AxlClient } from "@axl/sdk";

import {
  createTerminalProviderLoginAdapter,
  openAuthorizationUrl,
  validatedAuthorizationUrl,
} from "../src/provider-auth-ui.ts";
import { providerErrorMessage, runProviderCommand, usageLine } from "../src/provider-cli.ts";

class Input extends PassThrough {
  isTTY = true;
  isRaw = false;

  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }
}

function client(): AxlClient {
  return {
    listProviders: () =>
      Promise.resolve({
        providers: [
          {
            providerId: "test-provider",
            displayName: "Test Provider",
            enabled: true,
            authMethods: ["environment"],
            loginMethods: ["api_key"],
            authentication: { providerId: "test-provider", phase: "idle" },
            catalog: { refreshable: true },
            models: [
              {
                providerId: "test-provider",
                modelId: "test-model",
                displayName: "Test Model",
                apiDialect: "openai-chat",
                capabilities: { toolUse: true, structuredOutput: true, imageInput: false },
                reasoning: false,
                supportedThinkingLevels: ["off"],
                contextWindow: 8_000,
                maxOutputTokens: 1_000,
                availability: { status: "unavailable", reason: "configure a region" },
              },
            ],
          },
        ],
      }),
    providerAuthenticationStatus: () =>
      Promise.resolve({
        providers: [
          {
            providerId: "test-provider",
            phase: "authenticated",
            method: "api_key",
            source: "TEST_API_KEY",
          },
        ],
      }),
    refreshProviderCatalogs: () =>
      Promise.resolve({
        providers: [{ providerId: "test-provider", status: "refreshed", modelCount: 1 }],
      }),
    loginProvider: ({ providerId, method }: { providerId: string; method: "api_key" | "oauth" }) =>
      Promise.resolve({ providerId, phase: "authenticated", method }),
    logoutProvider: ({ providerId }: { providerId: string }) =>
      Promise.resolve({ providerId, phase: "logged_out" }),
  } as unknown as AxlClient;
}

test("provider CLI commands render grouped safe status and model data", async () => {
  const output: string[] = [];
  const write = (value: string) => output.push(value);
  const sdk = client();
  await runProviderCommand({ client: sdk, command: "providers", write });
  await runProviderCommand({ client: sdk, command: "models", write });
  await runProviderCommand({ client: sdk, command: "refresh", write });
  let hostLogins = 0;
  await runProviderCommand({
    client: sdk,
    command: "login",
    providerId: "test-provider",
    loginMethod: "api_key",
    login: (providerId, method) => {
      hostLogins += 1;
      return Promise.resolve({ providerId, phase: "authenticated", method });
    },
    write,
  });
  await runProviderCommand({ client: sdk, command: "logout", providerId: "test-provider", write });

  const rendered = output.join("");
  assert.match(rendered, /Test Provider \(test-provider\)/);
  assert.match(rendered, /authenticated · api_key · TEST_API_KEY/);
  assert.match(rendered, /unavailable: configure a region/);
  assert.match(rendered, /test-provider: refreshed · 1 models/);
  assert.equal(hostLogins, 1);
});

test("trusted terminal adapter masks and cancels prompt answers without retaining raw mode", async () => {
  const input = new Input();
  let output = "";
  const adapter = createTerminalProviderLoginAdapter(input, {
    isTTY: true,
    write: (value) => {
      output += value;
    },
  });
  const controller = new AbortController();
  const interaction = adapter.createInteraction({
    providerId: "test-provider",
    method: "api_key",
    signal: controller.signal,
  });
  const answer = interaction.prompt({ type: "secret", message: "API key" });
  input.write("super-secret\r");
  assert.equal(await answer, "super-secret");
  assert.equal(output.includes("super-secret"), false);
  assert.match(output, /\*{12}/);
  assert.equal(input.isRaw, false);

  const cancelled = interaction.prompt({ type: "text", message: "Account" });
  controller.abort();
  await assert.rejects(cancelled, /Setup aborted/);
  assert.equal(input.isRaw, false);
});

test("browser launch failures remain visible", async () => {
  let output = "";
  await openAuthorizationUrl(
    validatedAuthorizationUrl("https://example.com/login"),
    {
      write: (value) => {
        output += value;
      },
    },
    {
      spawn: (_command, handlers) =>
        handlers.error(new Error("launcher unavailable\nretry manually")),
    },
  );
  assert.match(output, /Could not open the authorization URL automatically/);
  assert.match(output, /launcher unavailable retry manually/);
});

test("authorization URLs are restricted and usage remains explicit", () => {
  assert.equal(validatedAuthorizationUrl("https://example.com/login").hostname, "example.com");
  assert.throws(() => validatedAuthorizationUrl("http://example.com/login"), /must use HTTPS/);
  assert.throws(
    () => validatedAuthorizationUrl("https://user:pass@example.com/login"),
    /must not contain credentials/,
  );
  assert.equal(
    usageLine({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      reasoningTokens: 1,
      costUsd: 0.000123,
    }),
    "usage: input 10 · output 4 · cache read 3 · cache write 2 · reasoning 1 · cost $0.000123",
  );
  assert.equal(providerErrorMessage(new Error("safe failure\nnext")), "safe failure next");
});

test("aggregate refresh failures reject after rendering actionable results", async () => {
  const sdk = client();
  sdk.refreshProviderCatalogs = async () => ({
    providers: [
      {
        providerId: "test-provider",
        status: "failed",
        modelCount: 0,
        error: { code: "catalog_refresh_failed", message: "Service unavailable", action: "retry" },
      },
    ],
  });
  let output = "";
  await assert.rejects(
    runProviderCommand({
      client: sdk,
      command: "refresh",
      write: (value) => {
        output += value;
      },
    }),
    /failed to refresh/,
  );
  assert.match(output, /Service unavailable/);
});
