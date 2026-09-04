// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import {
  connect as connectNet,
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { MAX_CANONICAL_EVENT_BYTES, WIRE_CAPABILITIES, WIRE_PROTOCOL_VERSION } from "@axl/protocol";
import { WebSocket } from "ws";

import {
  maximumCanonicalEventEnvelopeFits,
  startWebGateway,
  validateLoopbackViteUrl,
  type WebGateway,
  type WebGatewayLogEntry,
} from "../src/web-gateway.ts";

type HttpResult = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
};

async function request(
  gateway: WebGateway,
  path: string,
  options: {
    readonly method?: string;
    readonly origin?: string;
    readonly host?: string;
    readonly cookie?: string;
    readonly body?: string;
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(path, gateway.origin);
    const outgoingHeaders: Record<string, string> = {};
    if (options.origin !== undefined) outgoingHeaders.Origin = options.origin;
    if (options.host !== undefined) outgoingHeaders.Host = options.host;
    if (options.cookie !== undefined) outgoingHeaders.Cookie = options.cookie;
    const outgoing = httpRequest(
      target,
      { method: options.method ?? "GET", headers: outgoingHeaders },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) for (const item of value) headers.append(name, item);
            else if (value !== undefined) headers.set(name, value);
          }
          resolve({
            status: incoming.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end(options.body);
  });
}

async function fakeDaemon(
  context: TestContext,
): Promise<{ socketPath: string; received: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), "axl-web-gateway-"));
  const socketPath = join(directory, "daemon.sock");
  const received: string[] = [];
  const server = createNetServer((socket) => {
    socket.write(
      `${JSON.stringify({
        kind: "hello",
        wireVersion: WIRE_PROTOCOL_VERSION,
        daemonInstanceId: "daemon-fixture",
        capabilities: WIRE_CAPABILITIES,
        limits: { maxMessageBytes: 1_048_576, maxPendingRequests: 64 },
      })}\n`,
    );
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        received.push(line);
        const value = JSON.parse(line) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
        };
        if (value.method === "connection.initialize") {
          socket.write(
            `${JSON.stringify({
              kind: "success",
              id: value.id,
              method: value.method,
              result: {
                attachmentId: "attachment-fixture",
                daemonInstanceId: "daemon-fixture",
                wireVersion: WIRE_PROTOCOL_VERSION,
                grantedCapabilities: value.params.requestedCapabilities,
                scope: "local_control",
                heartbeatIntervalMs: 20_000,
                presenceTimeoutMs: 60_000,
              },
            })}\n`,
          );
        } else if (value.method === "daemon.info") {
          socket.write(
            `${JSON.stringify({
              kind: "success",
              id: value.id,
              method: value.method,
              result: { securityMode: "sandboxed", sandboxProvider: "fixture" },
            })}\n`,
          );
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  context.after(async () => {
    await closeNetServer(server);
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, received };
}

function closeNetServer(server: NetServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function gatewayFixture(
  context: TestContext,
  options: Omit<Parameters<typeof startWebGateway>[0], "socketPath"> = {},
): Promise<{ gateway: WebGateway; received: string[] }> {
  const daemon = await fakeDaemon(context);
  const gateway = await startWebGateway({ socketPath: daemon.socketPath, ...options });
  context.after(() => gateway.close());
  return { gateway, received: daemon.received };
}

async function authenticate(
  gateway: WebGateway,
): Promise<{ cookie: string; path: string; token: string; setCookie: string }> {
  const launch = new URL(gateway.launchUrl);
  const token = launch.hash.slice(1);
  const result = await request(gateway, "/auth/exchange", {
    method: "POST",
    origin: gateway.origin,
    body: token,
  });
  assert.equal(result.status, 200, result.body);
  const setCookie = result.headers.get("set-cookie");
  assert.ok(setCookie);
  return {
    cookie: setCookie.split(";", 1)[0] as string,
    path: (JSON.parse(result.body) as { path: string }).path,
    token,
    setCookie,
  };
}

function openSocket(
  gateway: WebGateway,
  cookie: string,
  path = `${gateway.pathPrefix}/rpc`,
  origin = gateway.origin,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = new URL(gateway.origin);
    url.protocol = "ws:";
    url.pathname = path;
    const socket = new WebSocket(url, {
      headers: { Cookie: cookie, Origin: origin },
      perMessageDeflate: false,
    });
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`upgrade rejected with ${response.statusCode}`)),
    );
    socket.once("error", reject);
  });
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) =>
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") })),
  );
}

function nextMessage(
  socket: WebSocket,
  accept: (message: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const receive = (data: WebSocket.RawData): void => {
      const message = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      if (!accept(message)) return;
      socket.off("message", receive);
      resolve(message);
    };
    socket.on("message", receive);
  });
}

test("1. gateway listens only on an IP-literal loopback origin", async (context) => {
  const { gateway } = await gatewayFixture(context);
  const url = new URL(gateway.origin);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(await request(gateway, "/").then((result) => result.status), 200);
});

test("2. invalid and ambiguous Host values expose no protected content", async (context) => {
  const { gateway } = await gatewayFixture(context);
  for (const host of ["localhost", `evil.invalid, ${new URL(gateway.origin).host}`, "127.0.0.1"]) {
    const result = await request(gateway, "/", { host });
    assert.equal(result.status, 421);
    assert.doesNotMatch(result.body, /Secure Axl gateway ready/);
  }
});

test("3. missing, null, and alternate Origin values cannot authenticate", async (context) => {
  const { gateway } = await gatewayFixture(context);
  const token = new URL(gateway.launchUrl).hash.slice(1);
  for (const origin of [undefined, "null", "http://localhost:1"]) {
    const result = await request(gateway, "/auth/exchange", {
      method: "POST",
      ...(origin === undefined ? {} : { origin }),
      body: token,
    });
    assert.equal(result.status, 403);
  }
});

test("4. launch tokens are 256-bit, one-use, expiring, and absent from queries and logs", async (context) => {
  let clock = 1_000;
  const logs: WebGatewayLogEntry[] = [];
  const first = await gatewayFixture(context, {
    now: () => clock,
    logger: (entry) => logs.push(entry),
  });
  const token = new URL(first.gateway.launchUrl).hash.slice(1);
  assert.equal(Buffer.from(token, "base64url").byteLength, 32);
  await authenticate(first.gateway);
  assert.equal(
    (
      await request(first.gateway, "/auth/exchange", {
        method: "POST",
        origin: first.gateway.origin,
        body: token,
      })
    ).status,
    401,
  );
  assert.equal((await request(first.gateway, `/?token=${token}`)).status, 400);
  assert.doesNotMatch(
    JSON.stringify(logs),
    new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  const second = await gatewayFixture(context, { now: () => clock });
  const expired = new URL(second.gateway.launchUrl).hash.slice(1);
  clock += 60_001;
  assert.equal(
    (
      await request(second.gateway, "/auth/exchange", {
        method: "POST",
        origin: second.gateway.origin,
        body: expired,
      })
    ).status,
    401,
  );
});

test("5. external bootstrap removes the fragment before application startup", async (context) => {
  const { gateway } = await gatewayFixture(context);
  const html = await request(gateway, "/");
  const script = await request(gateway, "/bootstrap.js");
  assert.match(html.body, /src="\/bootstrap\.js"/);
  assert.doesNotMatch(html.body, /<script(?![^>]*src=)[^>]*>/);
  assert.ok(script.body.indexOf("history.replaceState") < script.body.indexOf("fetch("));
  assert.doesNotMatch(script.body, /localStorage|sessionStorage|indexedDB/);
});

test("6. browser cookie is HttpOnly, strict, host-only, path-scoped, and process-scoped", async (context) => {
  const first = await gatewayFixture(context);
  const firstAuth = await authenticate(first.gateway);
  const header = (
    await request(first.gateway, "/auth/exchange", {
      method: "POST",
      origin: first.gateway.origin,
      body: firstAuth.token,
    })
  ).headers.get("set-cookie");
  assert.equal(header, null);
  const second = await gatewayFixture(context);
  const secondAuth = await authenticate(second.gateway);
  assert.notEqual(firstAuth.cookie, secondAuth.cookie);
  assert.notEqual(first.gateway.pathPrefix, second.gateway.pathPrefix);
  const exchange = await request(second.gateway, "/auth/exchange", {
    method: "POST",
    origin: second.gateway.origin,
    body: "invalid",
  });
  assert.equal(exchange.headers.get("set-cookie"), null);
  const cookieResult = await request(first.gateway, firstAuth.path, {
    origin: first.gateway.origin,
    cookie: firstAuth.cookie,
  });
  assert.equal(cookieResult.status, 200);
  assert.match(firstAuth.cookie, /^axl_browser=/);
  assert.match(
    firstAuth.setCookie,
    /; Path=\/_axl\/[0-9a-f]{32}; HttpOnly; SameSite=Strict; Max-Age=43200$/,
  );
  assert.doesNotMatch(firstAuth.setCookie, /Domain=/i);
});

test("7. an unrelated loopback service cannot discover the random cookie path", async (context) => {
  const { gateway } = await gatewayFixture(context);
  const auth = await authenticate(gateway);
  assert.match(gateway.pathPrefix, /^\/_axl\/[0-9a-f]{32}$/);
  assert.equal(
    (await request(gateway, "/_axl/guess/", { origin: gateway.origin, cookie: auth.cookie }))
      .status,
    404,
  );
  assert.doesNotMatch((await request(gateway, "/")).body, new RegExp(gateway.pathPrefix));
});

test("8. WebSocket upgrades require cookie, Host, Origin, and path prefix", async (context) => {
  const { gateway } = await gatewayFixture(context);
  const auth = await authenticate(gateway);
  for (const attempt of [
    () => openSocket(gateway, ""),
    () => openSocket(gateway, auth.cookie, `${gateway.pathPrefix}/wrong`),
    () => openSocket(gateway, auth.cookie, `${gateway.pathPrefix}/rpc`, "http://localhost:1"),
  ])
    await assert.rejects(attempt);
  const socket = await openSocket(gateway, auth.cookie);
  socket.close();
});

test("9. every HTTP response carries the required security headers", async (context) => {
  const { gateway } = await gatewayFixture(context);
  const response = await request(gateway, "/");
  for (const name of [
    "content-security-policy",
    "x-frame-options",
    "x-content-type-options",
    "referrer-policy",
    "cache-control",
    "cross-origin-opener-policy",
    "cross-origin-resource-policy",
  ])
    assert.ok(response.headers.get(name), name);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("10. development traffic is authenticated and remains on the gateway origin", async (context) => {
  const vite = createHttpServer((_request, response) => response.end("vite fixture"));
  await new Promise<void>((resolve) => vite.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => vite.close(() => resolve())));
  const address = vite.address();
  assert.ok(address && typeof address !== "string");
  const { gateway } = await gatewayFixture(context, {
    viteUrl: `http://127.0.0.1:${address.port}`,
  });
  const auth = await authenticate(gateway);
  assert.equal(auth.path, `${gateway.pathPrefix}/dev/`);
  assert.equal(
    (await request(gateway, auth.path, { origin: gateway.origin, cookie: auth.cookie })).body,
    "vite fixture",
  );
  assert.throws(() => validateLoopbackViteUrl("http://example.com:5173"));
});

test("11. oversized and fragmented messages cannot exceed the assembled limit", async (context) => {
  const { gateway } = await gatewayFixture(context, { limits: { maximumMessageBytes: 1_024 } });
  const auth = await authenticate(gateway);
  const socket = await openSocket(gateway, auth.cookie);
  const ended = closed(socket);
  socket.send("x".repeat(700), { fin: false });
  socket.send("x".repeat(700), { fin: true });
  assert.equal((await ended).code, 1009);
});

test("12. binary frames and WebSocket compression are disabled", async (context) => {
  const { gateway } = await gatewayFixture(context);
  const auth = await authenticate(gateway);
  const socket = await openSocket(gateway, auth.cookie);
  assert.equal(socket.extensions, "");
  const ended = closed(socket);
  socket.send(Buffer.from("binary"));
  assert.equal((await ended).code, 1003);
});

test("13. floods and idle clients are evicted without affecting another attachment", async (context) => {
  const { gateway } = await gatewayFixture(context, {
    limits: {
      handshakeTimeoutMs: 40,
      idleTimeoutMs: 80,
      inboundBurst: 2,
      inboundMessagesPerWindow: 2,
      inboundWindowMs: 10_000,
    },
  });
  const port = Number(new URL(gateway.origin).port);
  const stalled = connectNet(port, "127.0.0.1");
  const stalledClosed = new Promise<void>((resolve) => stalled.once("close", () => resolve()));
  stalled.once("connect", () => stalled.write("GET / HTTP/1.1\r\nHost:"));
  await stalledClosed;

  const auth = await authenticate(gateway);
  const flooded = await openSocket(gateway, auth.cookie);
  const healthy = await openSocket(gateway, auth.cookie);
  const floodClosed = closed(flooded);
  for (let id = 1; id <= 3; id += 1)
    flooded.send(JSON.stringify({ kind: "request", id, method: "connection.ping", params: {} }));
  assert.equal((await floodClosed).code, 1008);
  assert.equal(healthy.readyState, WebSocket.OPEN);
  assert.equal((await closed(healthy)).code, 1008);
});

test("14. browser-facing messages receive runtime protocol validation", async (context) => {
  const { gateway, received } = await gatewayFixture(context);
  const auth = await authenticate(gateway);
  const socket = await openSocket(gateway, auth.cookie);
  const ended = closed(socket);
  socket.send(
    JSON.stringify({
      kind: "request",
      id: 1,
      method: "not.a.method",
      params: {},
      secret: "do-not-echo",
    }),
  );
  assert.equal((await ended).code, 1007);
  assert.equal(received.length, 0);
});

test("15. the canonical event ceiling leaves room for a complete delivery envelope", () => {
  assert.equal(maximumCanonicalEventEnvelopeFits(MAX_CANONICAL_EVENT_BYTES), true);
  assert.equal(maximumCanonicalEventEnvelopeFits(MAX_CANONICAL_EVENT_BYTES + 1), false);
});

test("16. fixed errors and logs omit tokens, cookies, protected content, and rejected values", async (context) => {
  const logs: WebGatewayLogEntry[] = [];
  const { gateway } = await gatewayFixture(context, { logger: (entry) => logs.push(entry) });
  const secret = "rejected-super-secret";
  const result = await request(gateway, "/auth/exchange", {
    method: "POST",
    origin: gateway.origin,
    body: secret,
  });
  assert.equal(result.status, 401);
  assert.equal(result.body, "Authentication failed\n");
  assert.doesNotMatch(
    `${result.body}${JSON.stringify(logs)}`,
    /rejected-super-secret|Cookie|Authorization/,
  );
});

test("17. closing a tab or gateway only closes its daemon attachment", async (context) => {
  const { gateway, received } = await gatewayFixture(context);
  const auth = await authenticate(gateway);
  const socket = await openSocket(gateway, auth.cookie);
  const response = nextMessage(
    socket,
    (message) => message.kind === "success" && message.id === 17,
  );
  socket.send(
    JSON.stringify({
      kind: "request",
      id: 17,
      method: "connection.initialize",
      params: {
        client: { kind: "web", version: "test", instanceId: "browser-fixture" },
        requestedCapabilities: [],
      },
    }),
  );
  assert.equal((await response).kind, "success");
  const tabClosed = closed(socket);
  socket.close();
  await tabClosed;
  await gateway.close();
  const methods = received.map((line) => (JSON.parse(line) as { method: string }).method);
  assert.equal(methods.includes("session.interrupt"), false);
  assert.equal(methods.includes("session.dispose"), false);
});

test("18. missing or weakened required controls fail startup", async (context) => {
  const daemon = await fakeDaemon(context);
  await assert.rejects(
    startWebGateway({ socketPath: daemon.socketPath, limits: { outboundQueuedBytes: 100 } }),
    /outboundQueuedBytes/,
  );
  await assert.rejects(
    startWebGateway({ socketPath: daemon.socketPath, launchTokenLifetimeMs: 60_001 }),
  );
  assert.throws(() => validateLoopbackViteUrl("http://localhost:5173"));
});
