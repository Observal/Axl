// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_WIRE_MESSAGE_BYTES, WIRE_PROTOCOL_VERSION } from "@axl/protocol";
import WebSocket from "ws";
import {
  encodeWebSessionArtifact,
  startWebGateway,
  verifyWebAssets,
  writeWebSessionArtifact,
} from "../src/web-gateway.ts";

test("web assets fail closed when missing, altered, or incompatible", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-web-assets-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const html = '<div id="root"></div>';
  await writeFile(join(directory, "index.html"), html);
  const metadata = {
    webAssetVersion: 1,
    packageVersion: "0.0.0",
    sourceRevision: "fixture",
    wireVersion: WIRE_PROTOCOL_VERSION,
    entrypoints: ["index.html"],
    sha256: { "index.html": createHash("sha256").update(html).digest("hex") },
  };
  await writeFile(join(directory, "asset-metadata.json"), JSON.stringify(metadata));
  assert.equal((await verifyWebAssets(directory, "0.0.0")).wireVersion, WIRE_PROTOCOL_VERSION);
  await assert.rejects(verifyWebAssets(directory, "0.0.1"), /missing or incompatible/);
  await writeFile(join(directory, "index.html"), "changed");
  await assert.rejects(verifyWebAssets(directory), /hash mismatch/);
  await writeFile(
    join(directory, "asset-metadata.json"),
    JSON.stringify({ ...metadata, wireVersion: 0 }),
  );
  await assert.rejects(verifyWebAssets(directory), /missing or incompatible/);
});

test("browser session artifacts round-trip only manifest-declared files", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-web-artifact-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const target = join(directory, "target");
  const digest = createHash("sha256").update("attachment").digest("hex");
  await mkdir(join(source, "blobs"), { recursive: true });
  await writeFile(
    join(source, "manifest.json"),
    JSON.stringify({
      format: "axl.session",
      version: 1,
      sourceSessionId: "123e4567-e89b-42d3-a456-426614174000",
      sourceSha256: "a".repeat(64),
      eventCount: 1,
      blobDigests: [digest],
    }),
  );
  await writeFile(join(source, "events.jsonl"), "event\n");
  await writeFile(join(source, "blobs", digest), "attachment");

  const artifact = await encodeWebSessionArtifact(source);
  await writeWebSessionArtifact(artifact, target);
  assert.equal(await readFile(join(target, "events.jsonl"), "utf8"), "event\n");
  assert.equal(await readFile(join(target, "blobs", digest), "utf8"), "attachment");

  const invalid = JSON.parse(artifact.toString("utf8")) as { files: Record<string, string> };
  invalid.files.unexpected = "";
  await assert.rejects(
    writeWebSessionArtifact(Buffer.from(JSON.stringify(invalid)), join(directory, "invalid")),
    /unexpected files/,
  );
});

test("the gateway exchanges one launch token and authenticates one daemon bridge", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-web-gateway-"));
  const socketPath = join(directory, "daemon.sock");
  context.after(() => rm(directory, { recursive: true, force: true }));

  const html = '<div id="root"></div>';
  await writeFile(join(directory, "index.html"), html);
  await writeFile(
    join(directory, "asset-metadata.json"),
    JSON.stringify({
      webAssetVersion: 1,
      packageVersion: "0.0.0-test",
      sourceRevision: "fixture",
      wireVersion: WIRE_PROTOCOL_VERSION,
      entrypoints: ["index.html"],
      sha256: { "index.html": createHash("sha256").update(html).digest("hex") },
    }),
  );

  const daemon = createServer((socket) =>
    socket.on("data", (data) => {
      if (data.toString() === "outbound-flood\n") socket.write("x\n".repeat(1_025));
      else socket.write(data);
    }),
  );
  await new Promise<void>((resolve, reject) => {
    daemon.once("error", reject);
    daemon.listen(socketPath, resolve);
  });
  context.after(() => new Promise<void>((resolve) => daemon.close(() => resolve())));

  const expiredToken = Buffer.alloc(32, 7);
  const expiredGateway = await startWebGateway({
    socketPath,
    assetDirectory: directory,
    stateDirectory: directory,
    cwd: "/workspace",
    packageVersion: "0.0.0-test",
    launchToken: expiredToken,
    pathToken: Buffer.alloc(16, 7),
  });
  const actualNow = Date.now;
  try {
    const future = actualNow() + 61_000;
    Date.now = () => future;
    const expiredUrl = new URL("auth/exchange", expiredGateway.origin);
    const expired = await fetch(expiredUrl, {
      method: "POST",
      headers: { origin: expiredUrl.origin, "content-type": "application/json" },
      body: JSON.stringify({ token: expiredToken.toString("base64url") }),
    });
    assert.equal(expired.status, 401);
  } finally {
    Date.now = actualNow;
    await expiredGateway.close();
  }

  const idleToken = Buffer.alloc(32, 8);
  const idleGateway = await startWebGateway({
    socketPath,
    assetDirectory: directory,
    stateDirectory: directory,
    cwd: "/workspace",
    packageVersion: "0.0.0-test",
    launchToken: idleToken,
    pathToken: Buffer.alloc(16, 8),
    webSocketIdleTimeoutMs: 40,
  });
  try {
    const idleUrl = new URL(idleGateway.origin);
    const idleOrigin = idleUrl.origin;
    const idleExchange = await fetch(new URL("auth/exchange", idleGateway.origin), {
      method: "POST",
      headers: { origin: idleOrigin, "content-type": "application/json" },
      body: JSON.stringify({ token: idleToken.toString("base64url") }),
    });
    const idleCookie = idleExchange.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(idleCookie);
    const idleSocket = new WebSocket(new URL("ws", idleGateway.origin), {
      headers: { origin: idleOrigin, cookie: idleCookie },
    });
    const idleClose = new Promise<number>((resolve, reject) => {
      idleSocket.once("close", (code) => resolve(code));
      idleSocket.once("error", reject);
    });
    assert.equal(await idleClose, 1008);
  } finally {
    await idleGateway.close();
  }

  const providerLogins: Array<{ providerId: string; method: string }> = [];
  let resolveSlowLoginStarted = (): void => undefined;
  const slowLoginStarted = new Promise<void>((resolve) => {
    resolveSlowLoginStarted = resolve;
  });
  let slowLoginAborted = false;
  const gateway = await startWebGateway({
    socketPath,
    assetDirectory: directory,
    stateDirectory: directory,
    cwd: "/workspace",
    packageVersion: "0.0.0-test",
    providerHost: {
      loginProvider: ({ providerId, method }, options = {}) => {
        const signal = options.signal ?? new AbortController().signal;
        signal.throwIfAborted();
        providerLogins.push({ providerId, method });
        if (providerId === "secret-provider") {
          throw new Error("credential secret-value was rejected");
        }
        if (providerId === "slow-provider") {
          resolveSlowLoginStarted();
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                slowLoginAborted = true;
                reject(new DOMException("cancelled", "AbortError"));
              },
              { once: true },
            );
          });
        }
        return Promise.resolve({
          providerId,
          phase: "authenticated",
          method,
          source: "Test host",
        });
      },
    },
    pathToken: Buffer.alloc(16, 2),
  });
  context.after(() => gateway.close());
  const gatewayUrl = new URL(gateway.origin);
  const origin = gatewayUrl.origin;
  assert.equal(gatewayUrl.hostname, "127.0.0.1");
  const launchUrl = new URL(gateway.launchUrl);
  assert.equal(launchUrl.search, "");
  const launchToken = new URLSearchParams(launchUrl.hash.slice(1)).get("token");
  assert.ok(launchToken);
  assert.equal(Buffer.from(launchToken, "base64url").byteLength, 32);

  const exchangeUrl = new URL("auth/exchange", gateway.origin);
  for (const rejectedOrigin of [undefined, "null", "http://localhost:1234"]) {
    const response = await fetch(exchangeUrl, {
      method: "POST",
      headers: {
        ...(rejectedOrigin === undefined ? {} : { origin: rejectedOrigin }),
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: launchToken }),
    });
    assert.equal(response.status, 401);
  }
  const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      exchangeUrl,
      { method: "POST", headers: { host: `localhost:${gatewayUrl.port}`, origin } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify({ token: launchToken }));
  });
  assert.equal(wrongHostStatus, 404);

  const exchange = await fetch(exchangeUrl, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ token: launchToken }),
  });
  assert.equal(exchange.status, 200);
  const sessionCookie = exchange.headers.get("set-cookie");
  assert.ok(sessionCookie?.includes("HttpOnly"));
  assert.ok(sessionCookie?.includes("SameSite=Strict"));
  assert.ok(sessionCookie?.includes(`Path=${gatewayUrl.pathname}`));
  assert.equal(sessionCookie?.includes("Domain="), false);
  assert.equal(
    exchange.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"),
    true,
  );
  assert.equal(exchange.headers.get("x-content-type-options"), "nosniff");
  assert.equal(exchange.headers.get("referrer-policy"), "no-referrer");
  assert.equal(exchange.headers.get("cache-control"), "no-store");
  assert.equal(exchange.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(exchange.headers.get("cross-origin-resource-policy"), "same-origin");
  if (sessionCookie === null) throw new Error("Gateway did not issue a session cookie");
  const cookieHeader = sessionCookie.split(";", 1)[0] ?? "";

  const replay = await fetch(exchangeUrl, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ token: launchToken }),
  });
  assert.equal(replay.status, 401);

  const bootstrap = await fetch(new URL("bootstrap", gateway.origin), {
    method: "POST",
    headers: { origin, cookie: cookieHeader },
  });
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(await bootstrap.json(), {
    cwd: "/workspace",
    webSocketPath: `${new URL(gateway.origin).pathname}ws`,
    preferences: {
      sidebarWidth: 264,
      dockWidth: 680,
      sidebarCollapsed: false,
      changesView: "files",
      panes: ["browser", "files"],
    },
    hostCapabilities: ["provider.auth.login"],
  });
  const preferences = await fetch(new URL("preferences", gateway.origin), {
    method: "POST",
    headers: { origin, cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify({
      sidebarWidth: 300,
      dockWidth: 720,
      sidebarCollapsed: true,
      changesView: "all",
      panes: ["terminal", "browser"],
    }),
  });
  assert.equal(preferences.status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "web-preferences.json"), "utf8")), {
    sidebarWidth: 300,
    dockWidth: 720,
    sidebarCollapsed: true,
    changesView: "all",
    panes: ["browser", "terminal"],
  });
  const invalidPanes = await fetch(new URL("preferences", gateway.origin), {
    method: "POST",
    headers: { origin, cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify({
      sidebarWidth: 300,
      dockWidth: 720,
      sidebarCollapsed: true,
      changesView: "all",
      panes: ["browser", "browser"],
    }),
  });
  assert.equal(invalidPanes.status, 400);

  const loginUrl = new URL("host/provider/login", gateway.origin);
  const loginRequestId = "123e4567-e89b-42d3-a456-426614174010";
  const login = await fetch(loginUrl, {
    method: "POST",
    headers: { origin, cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify({ requestId: loginRequestId, providerId: "openai", method: "oauth" }),
  });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), {
    providerId: "openai",
    phase: "authenticated",
    method: "oauth",
    source: "Test host",
  });
  assert.deepEqual(providerLogins, [{ providerId: "openai", method: "oauth" }]);

  const secretField = await fetch(loginUrl, {
    method: "POST",
    headers: { origin, cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: loginRequestId,
      providerId: "openai",
      method: "api_key",
      credential: "secret-value",
    }),
  });
  assert.equal(secretField.status, 400);
  assert.equal((await secretField.text()).includes("secret-value"), false);
  assert.equal(providerLogins.length, 1);

  const failedLogin = await fetch(loginUrl, {
    method: "POST",
    headers: { origin, cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "123e4567-e89b-42d3-a456-426614174011",
      providerId: "secret-provider",
      method: "api_key",
    }),
  });
  assert.equal(failedLogin.status, 400);
  assert.equal(await failedLogin.text(), "Provider login failed. Check the trusted host terminal.");

  const slowRequestId = "123e4567-e89b-42d3-a456-426614174012";
  const cancelledLogin = fetch(loginUrl, {
    method: "POST",
    headers: { origin, cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: slowRequestId,
      providerId: "slow-provider",
      method: "oauth",
    }),
  });
  await slowLoginStarted;
  const unrelatedCancel = await fetch(new URL("host/provider/login/cancel", gateway.origin), {
    method: "POST",
    headers: { origin, cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify({ requestId: "123e4567-e89b-42d3-a456-426614174099" }),
  });
  assert.deepEqual(await unrelatedCancel.json(), { cancelled: false });
  assert.equal(slowLoginAborted, false);
  const cancelLogin = await fetch(new URL("host/provider/login/cancel", gateway.origin), {
    method: "POST",
    headers: { origin, cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify({ requestId: slowRequestId }),
  });
  assert.equal(cancelLogin.status, 200);
  assert.deepEqual(await cancelLogin.json(), { cancelled: true });
  assert.equal((await cancelledLogin).status, 400);
  assert.equal(slowLoginAborted, true);

  const rejectWebSocket = async (url: URL, headers: Record<string, string>): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const rejected = new WebSocket(url, { headers });
      rejected.once("open", () => {
        rejected.close();
        reject(new Error("Gateway accepted an unauthorized WebSocket"));
      });
      rejected.once("error", () => resolve());
      rejected.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve();
      });
    });
  };
  await rejectWebSocket(new URL("ws", gateway.origin), { origin });
  await rejectWebSocket(new URL("ws", gateway.origin), { cookie: cookieHeader });
  await rejectWebSocket(new URL("ws", gateway.origin), {
    origin: "null",
    cookie: cookieHeader,
  });
  await rejectWebSocket(new URL("wrong", gateway.origin), { origin, cookie: cookieHeader });

  const socket = new WebSocket(new URL("ws", gateway.origin), {
    headers: { origin, cookie: cookieHeader },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send("ping\n");
  assert.equal(
    await new Promise<string>((resolve) =>
      socket.once("message", (data) => resolve(data.toString())),
    ),
    "ping",
  );
  assert.equal(socket.extensions, "");
  const binaryClose = new Promise<number>((resolve) =>
    socket.once("close", (code) => resolve(code)),
  );
  socket.send(Buffer.from([1]));
  assert.equal(await binaryClose, 1009);

  const oversized = new WebSocket(new URL("ws", gateway.origin), {
    headers: { origin, cookie: cookieHeader },
  });
  await new Promise<void>((resolve, reject) => {
    oversized.once("open", resolve);
    oversized.once("error", reject);
  });
  const oversizedClose = new Promise<number>((resolve) =>
    oversized.once("close", (code) => resolve(code)),
  );
  oversized.send("x".repeat(MAX_WIRE_MESSAGE_BYTES + 1));
  assert.equal(await oversizedClose, 1009);

  const fragmented = new WebSocket(new URL("ws", gateway.origin), {
    headers: { origin, cookie: cookieHeader },
  });
  await new Promise<void>((resolve, reject) => {
    fragmented.once("open", resolve);
    fragmented.once("error", reject);
  });
  const fragmentedClose = new Promise<number>((resolve) =>
    fragmented.once("close", (code) => resolve(code)),
  );
  fragmented.send("x".repeat(Math.ceil(MAX_WIRE_MESSAGE_BYTES / 2)), { fin: false });
  fragmented.send("x".repeat(Math.ceil(MAX_WIRE_MESSAGE_BYTES / 2) + 1), { fin: true });
  assert.equal(await fragmentedClose, 1009);

  const healthy = new WebSocket(new URL("ws", gateway.origin), {
    headers: { origin, cookie: cookieHeader },
  });
  await new Promise<void>((resolve, reject) => {
    healthy.once("open", resolve);
    healthy.once("error", reject);
  });
  const flooded = new WebSocket(new URL("ws", gateway.origin), {
    headers: { origin, cookie: cookieHeader },
  });
  await new Promise<void>((resolve, reject) => {
    flooded.once("open", resolve);
    flooded.once("error", reject);
  });
  const floodClose = new Promise<number>((resolve) =>
    flooded.once("close", (code) => resolve(code)),
  );
  for (let index = 0; index < 21; index += 1) flooded.send("ping\n");
  assert.equal(await floodClose, 1008);

  const slowReader = new WebSocket(new URL("ws", gateway.origin), {
    headers: { origin, cookie: cookieHeader },
  });
  await new Promise<void>((resolve, reject) => {
    slowReader.once("open", resolve);
    slowReader.once("error", reject);
  });
  const slowReaderClose = new Promise<number>((resolve) =>
    slowReader.once("close", (code) => resolve(code)),
  );
  slowReader.send("outbound-flood\n");
  assert.equal(await slowReaderClose, 1009);
  const healthyReply = new Promise<string>((resolve) =>
    healthy.once("message", (data) => resolve(data.toString())),
  );
  healthy.send("healthy\n");
  assert.equal(await healthyReply, "healthy");
  const healthyClose = new Promise<void>((resolve) => healthy.once("close", () => resolve()));
  healthy.close();
  await healthyClose;

  const attachments = await Promise.all(
    Array.from({ length: 16 }, async () => {
      const attachment = new WebSocket(new URL("ws", gateway.origin), {
        headers: { origin, cookie: cookieHeader },
      });
      await new Promise<void>((resolve, reject) => {
        attachment.once("open", resolve);
        attachment.once("error", reject);
      });
      return attachment;
    }),
  );
  await rejectWebSocket(new URL("ws", gateway.origin), { origin, cookie: cookieHeader });
  await Promise.all(
    attachments.map(
      (attachment) =>
        new Promise<void>((resolve) => {
          attachment.once("close", () => resolve());
          attachment.close();
        }),
    ),
  );

  const waitForTimeout = (requestText: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const stalled = createConnection(Number(gatewayUrl.port), gatewayUrl.hostname);
      const timer = setTimeout(() => {
        stalled.destroy();
        reject(new Error("Gateway did not time out a stalled HTTP request"));
      }, 8_000);
      stalled.once("connect", () => stalled.write(requestText));
      stalled.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      stalled.once("error", reject);
    });
  const stalledAt = performance.now();
  await Promise.all([
    waitForTimeout(`GET ${gatewayUrl.pathname} HTTP/1.1\r\nHost:`),
    waitForTimeout(
      `POST ${gatewayUrl.pathname}preferences HTTP/1.1\r\nHost: ${gatewayUrl.host}\r\nOrigin: ${origin}\r\nCookie: ${cookieHeader}\r\nContent-Length: 10\r\n\r\n{`,
    ),
  ]);
  assert.ok(performance.now() - stalledAt >= 4_000);
});
