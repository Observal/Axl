// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileCredentialStore } from "@axl/ai";
import { AxlDaemon } from "@axl/daemon";
import { type ModelPort, ToolRegistry } from "@axl/kernel";
import type { ModelStreamEvent } from "@axl/protocol";
import { connectUnixClient } from "@axl/sdk/unix";

import { listLocalSessions, localSandboxStateKey, startLocalDaemon } from "../src/index.ts";

test("OCI state keys require a digest and cannot traverse directories", () => {
  assert.equal(
    localSandboxStateKey({
      type: "oci",
      engine: "podman",
      image: `example.invalid/image@sha256:${"a".repeat(64)}`,
    }),
    join("oci", "podman", "a".repeat(64)),
  );
  assert.throws(
    () =>
      localSandboxStateKey({
        type: "oci",
        engine: "docker",
        image: "example.invalid/image@sha256:../../outside",
      }),
    /must be pinned/,
  );
});

test("discovers native and unsafe histories with explicit placement labels", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-runtime-catalog-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const axlHome = join(root, ".axl");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const model: ModelPort = {
    stream: () =>
      (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield {
          type: "completed",
          stopReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      })(),
  };
  const start = async (directory: string, enforced: boolean) => {
    const daemon = new AxlDaemon({
      socketPath: join(directory, "test.sock"),
      dataDirectory: directory,
      securityMode: enforced ? "sandboxed" : "unsafe",
      sandboxProvider: enforced ? "bubblewrap" : "none",
      runtime: () => ({
        model,
        tools: new ToolRegistry(),
        sandbox: { provider: enforced ? "bubblewrap" : "none", enforced, controls: [] },
      }),
    });
    await daemon.start();
    context.after(() => daemon.stop());
    return (await daemon.sessions.create(workspace)).sessionId;
  };
  const nativeId = await start(axlHome, true);
  const unsafeId = await start(join(axlHome, "unsafe"), false);
  const sessions = await listLocalSessions(axlHome);
  assert.deepEqual(
    new Map(sessions.map((session) => [session.sessionId, session.placementLabel])),
    new Map([
      [nativeId, "SANDBOXED · native"],
      [unsafeId, "UNSAFE"],
    ]),
  );
});

test("assembles an authoritative local runtime without a presentation client", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const axlHome = join(root, ".axl");
  const workspace = join(root, "workspace");
  const stateDirectory = join(axlHome, "unsafe");
  const socketPath = join(stateDirectory, "axl.sock");
  await mkdir(workspace, { recursive: true });

  const store = new FileCredentialStore(join(axlHome, "credentials.json"));
  await store.modify("azure-openai", () =>
    Promise.resolve({
      type: "api_key",
      key: "obviously-fake-runtime-test-key",
      env: { AZURE_OPENAI_BASE_URL: "https://example.invalid/openai/v1" },
    }),
  );

  const daemon = await startLocalDaemon({
    axlHome,
    stateDirectory,
    socketPath,
    defaults: { modelId: "gpt-5", thinkingLevel: "medium" },
    store,
    unsafe: true,
  });
  context.after(() => daemon.stop());
  const client = await connectUnixClient(socketPath);
  context.after(() => client.close());

  assert.deepEqual(await client.request("daemon.info", {}), {
    securityMode: "unsafe",
    sandboxProvider: "none",
  });
  const opened = await client.request("session.create", { cwd: workspace });
  const subscription = await client.request("session.subscribe", {
    sessionId: opened.sessionId,
  });
  assert.ok(subscription.snapshot?.page.complete);
  const events = subscription.snapshot.page.events;
  await client.request("session.ack", {
    subscriptionId: subscription.subscriptionId,
    cursor: subscription.snapshot.boundaryCursor,
  });
  const sandbox = events.find((event) => event.type === "sandbox.configured");
  assert.deepEqual(sandbox?.type === "sandbox.configured" ? sandbox.payload : undefined, {
    provider: "none",
    enforced: false,
    controls: [],
  });
  assert.deepEqual(
    events
      .filter((event) => event.type === "tool.schema")
      .map((event) => (event.type === "tool.schema" ? event.payload.name : "")),
    ["bash", "read", "write", "edit", "web_fetch", "web_search"],
  );
  assert.deepEqual(events.find((event) => event.type === "config.profile")?.payload, {
    profile: "standard",
  });
  assert.deepEqual(events.find((event) => event.type === "config.tools")?.payload, {
    webFetch: true,
    webSearch: true,
  });

  for (const [profile, expectedTools] of [
    ["minimal", ["bash", "edit"]],
    ["exec", ["bash"]],
    ["chat", []],
  ] as const) {
    const createdProfile = await client.request("session.create", { cwd: workspace, profile });
    const subscribed = await client.request("session.subscribe", {
      sessionId: createdProfile.sessionId,
    });
    assert.deepEqual(
      subscribed.snapshot?.page.events
        .filter((event) => event.type === "tool.schema")
        .map((event) => (event.type === "tool.schema" ? event.payload.name : "")),
      expectedTools,
    );
  }
});
