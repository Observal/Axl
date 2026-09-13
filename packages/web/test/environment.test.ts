// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  browserProviderHost,
  importSessionArtifact,
  parseBootstrap,
  WEB_REQUESTED_CAPABILITIES,
} from "../src/environment.ts";

const valid = {
  cwd: "/workspace",
  webSocketPath: "/a/process/ws",
  preferences: {
    sidebarWidth: 280,
    dockWidth: 720,
    sidebarCollapsed: false,
    changesView: "files",
    panes: ["browser", "files"],
  },
  hostCapabilities: ["provider.auth.login"],
};

test("rejects oversized session imports before upload", async () => {
  await assert.rejects(
    importSessionArtifact({ size: 64 * 1024 * 1024 + 1 } as File),
    /between 1 byte and 64 MiB/,
  );
});

test("validates persisted browser layout preferences", () => {
  assert.deepEqual(parseBootstrap(valid), valid);
  assert.throws(
    () => parseBootstrap({ ...valid, preferences: { ...valid.preferences, dockWidth: 2000 } }),
    /Invalid web preferences/,
  );
  assert.throws(
    () => parseBootstrap({ ...valid, preferences: { ...valid.preferences, panes: ["editor"] } }),
    /Invalid web preferences/,
  );
  assert.deepEqual(
    parseBootstrap({ ...valid, preferences: { ...valid.preferences, panes: ["files", "browser"] } })
      .preferences.panes,
    ["browser", "files"],
  );
  assert.throws(
    () => parseBootstrap({ ...valid, preferences: { ...valid.preferences, changesView: "grid" } }),
    /Invalid web preferences/,
  );
  assert.throws(
    () => parseBootstrap({ ...valid, hostCapabilities: ["process.spawn"] }),
    /Invalid web bootstrap response/,
  );
});

test("browser requests queue and presence capabilities but omits trusted login", () => {
  assert.equal(WEB_REQUESTED_CAPABILITIES.includes("provider.auth.login"), false);
  assert.equal(WEB_REQUESTED_CAPABILITIES.includes("provider.auth.status"), true);
  assert.equal(WEB_REQUESTED_CAPABILITIES.includes("session.queue.requeue"), true);
  assert.equal(WEB_REQUESTED_CAPABILITIES.includes("session.queue.restore"), true);
  assert.equal(WEB_REQUESTED_CAPABILITIES.includes("session.presence"), true);
});

test("provider login sends only typed intent to the trusted host", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  globalThis.fetch = (_input, init) => {
    requestBody = String(init?.body);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          providerId: "openai",
          phase: "authenticated",
          method: "oauth",
          source: "OpenAI OAuth",
        }),
      ),
    );
  };
  try {
    const result = await browserProviderHost.loginProvider({
      providerId: "openai",
      method: "oauth",
    });
    const request = JSON.parse(requestBody) as Record<string, unknown>;
    assert.deepEqual(Object.keys(request).sort(), ["method", "providerId", "requestId"]);
    assert.equal(request.providerId, "openai");
    assert.equal(request.method, "oauth");
    assert.match(String(request.requestId), /^[0-9a-f-]{36}$/u);
    assert.equal(result.phase, "authenticated");
    assert.equal(requestBody.includes("secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider login cancellation reaches the trusted host", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ readonly path: string; readonly body: string }> = [];
  globalThis.fetch = (input, init) => {
    requests.push({ path: String(input), body: String(init?.body ?? "") });
    if (String(input).endsWith("/cancel")) return Promise.resolve(new Response("{}"));
    return new Promise(() => undefined);
  };
  try {
    const controller = new AbortController();
    const pending = browserProviderHost.loginProvider(
      { providerId: "openai", method: "api_key" },
      { signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(
      requests.map((request) => request.path),
      ["host/provider/login", "host/provider/login/cancel"],
    );
    assert.equal(
      (JSON.parse(requests[0]?.body ?? "") as { requestId: string }).requestId,
      (JSON.parse(requests[1]?.body ?? "") as { requestId: string }).requestId,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
