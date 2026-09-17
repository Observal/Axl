// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionId } from "@axl/protocol";
import { type AxlClient, AxlClientError, NewSessionController } from "../src/index.ts";

const opened = {
  sessionId: parseSessionId("123e4567-e89b-42d3-a456-426614174000"),
  cwd: "/workspace",
  runtime: { state: "idle" as const },
  profile: "chat" as const,
};

test("creates Chat without staged workspace or tools and preserves unspecified defaults", async () => {
  const requests: unknown[] = [];
  const client = {
    request: async (_method: string, params: unknown) => {
      requests.push(params);
      return opened;
    },
  } as unknown as AxlClient;
  const controller = new NewSessionController();
  controller.update({
    workspace: "/ignored",
    webFetch: true,
    providerId: "provider",
    modelId: "model",
  });

  assert.deepEqual(await controller.create(client, "/default"), opened);
  assert.deepEqual(requests, [
    { cwd: "/default", profile: "chat", providerId: "provider", modelId: "model" },
  ]);
});

test("requires a workspace for Code and submits staged choices atomically", async () => {
  const requests: unknown[] = [];
  const client = {
    request: async (_method: string, params: unknown) => {
      requests.push(params);
      return { ...opened, profile: "standard" as const };
    },
  } as unknown as AxlClient;
  const controller = new NewSessionController();
  controller.update({
    mode: "code",
    workspace: "  /code  ",
    thinkingLevel: "high",
    webSearch: true,
    webFetch: false,
  });

  await controller.create(client, "/default");
  assert.deepEqual(requests, [
    {
      cwd: "/code",
      profile: "standard",
      thinkingLevel: "high",
      webFetch: false,
      webSearch: true,
    },
  ]);

  controller.reset("code");
  await assert.rejects(
    controller.create(client, "/default"),
    (error) => error instanceof AxlClientError && error.code === "invalid_command_argument",
  );
});
