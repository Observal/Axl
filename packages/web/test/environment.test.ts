// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { parseSessionId } from "@axl/sdk";

import {
  browserProviderHost,
  browserSessionPath,
  importSessionArtifact,
  parseBootstrap,
  validateProjectFolder,
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
  hostCapabilities: ["project.folder.validate", "provider.auth.login"],
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

test("browser session URLs survive refresh without retaining launch credentials", () => {
  const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");
  assert.equal(
    browserSessionPath("http://127.0.0.1/a/token/?theme=dark#token=secret", sessionId),
    `/a/token/?theme=dark&session=${sessionId}`,
  );
  assert.equal(browserSessionPath(`http://127.0.0.1/a/token/?session=${sessionId}`), "/a/token/");
});

test("browser requests queue and presence capabilities but omits trusted login", () => {
  assert.equal(WEB_REQUESTED_CAPABILITIES.includes("provider.auth.login"), false);
  assert.equal(WEB_REQUESTED_CAPABILITIES.includes("provider.auth.status"), true);
  assert.equal(WEB_REQUESTED_CAPABILITIES.includes("session.queue.requeue"), true);
  assert.equal(WEB_REQUESTED_CAPABILITIES.includes("session.queue.restore"), true);
  assert.equal(WEB_REQUESTED_CAPABILITIES.includes("session.presence"), true);
  assert.equal(WEB_REQUESTED_CAPABILITIES.includes("adoption.plan"), true);
  assert.equal(WEB_REQUESTED_CAPABILITIES.includes("adoption.start"), true);
  assert.equal(WEB_REQUESTED_CAPABILITIES.includes("adoption.approve-activation"), true);
});

test("project folder validation sends one exact path to the trusted host", async () => {
  const originalFetch = globalThis.fetch;
  let requestPath = "";
  let requestBody = "";
  globalThis.fetch = (input, init) => {
    requestPath = String(input);
    requestBody = String(init?.body);
    return Promise.resolve(
      new Response(JSON.stringify({ valid: true, path: "/canonical/project" })),
    );
  };
  try {
    assert.deepEqual(await validateProjectFolder("/project"), {
      valid: true,
      path: "/canonical/project",
    });
    assert.equal(requestPath, "host/project-folder/validate");
    assert.deepEqual(JSON.parse(requestBody), { path: "/project" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("project folder validation rejects malformed host responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response(JSON.stringify({ valid: true, path: "/project", extra: true })));
  try {
    await assert.rejects(validateProjectFolder("/project"), /Invalid project folder validation/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
