// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from "node:net";
import test from "node:test";

import {
  MAX_JSON_RESPONSE_BYTES,
  readBoundedJson,
  runWithProviderHooks,
  safeEndpoint,
  safeFetch,
  stripTrailingSlashes,
} from "../src/index.ts";

test("endpoint policy permits HTTPS and explicit loopback HTTP only", () => {
  assert.equal(
    safeEndpoint("https://example.com/v1///", { label: "test" }),
    "https://example.com/v1",
  );
  assert.equal(
    safeEndpoint("http://127.0.0.1:11434/v1", { label: "test", allowLoopbackHttp: true }),
    "http://127.0.0.1:11434/v1",
  );
  for (const value of [
    "http://example.com/v1",
    "https://10.0.0.1/v1",
    "https://169.254.169.254/v1",
    "https://[::1]/v1",
    "https://user:password@example.com/v1",
    "https://example.com/v1#fragment",
  ])
    assert.throws(() => safeEndpoint(value, { label: "test" }));
  assert.throws(() =>
    safeEndpoint("https://other.example/v1", {
      label: "test",
      expectedOrigin: "https://example.com/catalog",
    }),
  );
});

test("provider hooks chain headers, JSON payloads, and responses around safe dispatch", async () => {
  const observed: string[] = [];
  const response = await runWithProviderHooks(
    {
      beforeHeaders: ({ headers }) => ({ ...headers, "x-extension": "yes" }),
      beforeRequest: ({ payload }) => ({ ...(payload as object), extension: true }),
      afterResponse: ({ status }) => {
        observed.push(`response:${status}`);
      },
    },
    () =>
      safeFetch(
        "https://provider.example/v1/messages",
        { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' },
        {
          label: "test provider",
          resolve: async () => [{ address: "8.8.8.8", family: 4 }],
          fetch: async (_url, init) => {
            assert.equal(new Headers(init?.headers).get("x-extension"), "yes");
            assert.deepEqual(JSON.parse(String(init?.body)), { a: 1, extension: true });
            return new Response("ok", { status: 200, headers: { "x-response": "yes" } });
          },
        },
      ),
  );
  assert.equal(await response.text(), "ok");
  assert.deepEqual(observed, ["response:200"]);
});

test("trailing slash removal is linear and handles long non-matching input", () => {
  const value = `${"/".repeat(100_000)}x`;
  assert.equal(stripTrailingSlashes(value), value);
  assert.equal(stripTrailingSlashes(`${value}///`), value);
});

test("safe transport rejects private DNS answers before dispatch", async () => {
  let requests = 0;
  await assert.rejects(
    safeFetch(
      "https://provider.example/v1/models",
      { headers: { "x-api-key": "fake-secret" } },
      {
        label: "test provider",
        fetch: async () => {
          requests += 1;
          return new Response("{}");
        },
        resolve: () => Promise.resolve([{ address: "169.254.169.254", family: 4 }]),
      },
    ),
    /disallowed destination/,
  );
  assert.equal(requests, 0);
});

test("safe transport rejects cross-origin redirects without forwarding request data", async () => {
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  await assert.rejects(
    safeFetch(
      "https://provider.example/v1/responses",
      {
        method: "POST",
        headers: { "x-api-key": "fake-secret" },
        body: '{"prompt":"private prompt"}',
      },
      {
        label: "test provider",
        fetch: async (input, init) => {
          requests.push({
            url: String(input),
            headers: new Headers(init?.headers),
            body: init?.body,
          });
          return new Response(null, {
            status: 307,
            headers: { location: "http://127.0.0.1/internal" },
          });
        },
        resolve: () => Promise.resolve([{ address: "8.8.8.8", family: 4 }]),
      },
    ),
    /must use HTTPS|unapproved origin/,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://provider.example/v1/responses");
  assert.equal(requests[0]?.headers.get("x-api-key"), "fake-secret");
  assert.equal(requests[0]?.body, '{"prompt":"private prompt"}');
});

test("bounded JSON rejects declared and chunked response overflow", async () => {
  await assert.rejects(
    readBoundedJson(
      new Response("{}", { headers: { "content-length": String(MAX_JSON_RESPONSE_BYTES + 1) } }),
    ),
    /exceeds/,
  );
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(Math.floor(MAX_JSON_RESPONSE_BYTES / 2)));
        controller.enqueue(new Uint8Array(Math.floor(MAX_JSON_RESPONSE_BYTES / 2) + 1));
        controller.close();
      },
    }),
  );
  await assert.rejects(readBoundedJson(response), /exceeds/);
});

test("real transport honors both Node DNS lookup callback shapes", async (context) => {
  const previous = getDefaultAutoSelectFamily();
  context.after(() => setDefaultAutoSelectFamily(previous));
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  for (const autoSelectFamily of [true, false]) {
    setDefaultAutoSelectFamily(autoSelectFamily);
    const response = await safeFetch(
      `http://localhost:${address.port}/`,
      {},
      {
        label: "loopback transport test",
        allowLoopbackHttp: true,
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      },
    );
    assert.equal(await response.text(), "ok");
  }
});
