// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileCredentialStore } from "@axl/ai";
import { DaemonClient, type SessionSnapshot } from "@axl/daemon";

import { startLocalDaemon } from "../src/index.ts";

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
  const client = await DaemonClient.connect(socketPath);
  context.after(() => client.close());

  assert.deepEqual(await client.request("daemon.info", {}), { securityMode: "unsafe" });
  const snapshot = (await client.request("session.create", { cwd: workspace })) as SessionSnapshot;
  const sandbox = snapshot.events.find((event) => event.type === "sandbox.configured");
  assert.deepEqual(sandbox?.type === "sandbox.configured" ? sandbox.payload : undefined, {
    provider: "none",
    enforced: false,
    controls: [],
  });
  assert.deepEqual(
    snapshot.events
      .filter((event) => event.type === "tool.schema")
      .map((event) => (event.type === "tool.schema" ? event.payload.name : "")),
    ["shell", "read", "edit"],
  );
});
