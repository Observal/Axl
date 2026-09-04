// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { type Duplex, Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import {
  MAX_CANONICAL_EVENT_BYTES,
  MAX_WIRE_MESSAGE_BYTES,
  parseServerMessage,
  parseWireRequest,
} from "@axl/protocol";
import { WebSocket, WebSocketServer } from "ws";

export const WEB_GATEWAY_LIMITS = {
  handshakeTimeoutMs: 5_000,
  idleTimeoutMs: 60_000,
  maximumMessageBytes: MAX_WIRE_MESSAGE_BYTES,
  maximumPendingRequests: 64,
  inboundWindowMs: 10_000,
  inboundMessagesPerWindow: 100,
  inboundBurst: 20,
  outboundQueuedBytes: 4 * 1024 * 1024,
  outboundQueuedMessages: 1_024,
  slowClientTimeoutMs: 10_000,
  maximumAttachments: 16,
} as const;

export interface WebGatewayLimits {
  readonly handshakeTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maximumMessageBytes: number;
  readonly maximumPendingRequests: number;
  readonly inboundWindowMs: number;
  readonly inboundMessagesPerWindow: number;
  readonly inboundBurst: number;
  readonly outboundQueuedBytes: number;
  readonly outboundQueuedMessages: number;
  readonly slowClientTimeoutMs: number;
  readonly maximumAttachments: number;
}

export interface WebGatewayLogEntry {
  readonly event: "started" | "stopped" | "attachment_opened" | "attachment_closed" | "error";
  readonly attachmentId?: string;
  readonly code?: string;
}

export interface StartWebGatewayOptions {
  readonly socketPath: string;
  readonly port?: number;
  readonly viteUrl?: string;
  readonly launchTokenLifetimeMs?: number;
  readonly browserCredentialLifetimeSeconds?: number;
  readonly limits?: Partial<WebGatewayLimits>;
  readonly now?: () => number;
  readonly logger?: (entry: WebGatewayLogEntry) => void;
}

export interface WebGateway {
  readonly origin: string;
  readonly launchUrl: string;
  readonly pathPrefix: string;
  close(): Promise<void>;
}

const LOOPBACK_HOST = "127.0.0.1";
const VITE_INTERNAL_BASE = "/__axl_dev__/";
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

const BOOTSTRAP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Axl</title></head><body><p id="status">Authenticating Axl…</p><script src="/bootstrap.js" defer></script></body></html>`;

const BOOTSTRAP_SCRIPT = `"use strict";
(async () => {
  let launchToken = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  history.replaceState(null, "", location.pathname);
  if (!launchToken) { document.getElementById("status").textContent = "A launch token is required."; return; }
  try {
    const response = await fetch("/auth/exchange", { method: "POST", headers: { "Content-Type": "text/plain" }, body: launchToken, credentials: "same-origin" });
    launchToken = "";
    if (!response.ok) throw new Error("authentication failed");
    const result = await response.json();
    location.replace(result.path);
  } catch { launchToken = ""; document.getElementById("status").textContent = "Axl authentication failed."; }
})();
`;

const READY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Axl</title></head><body><p>Secure Axl gateway ready.</p></body></html>`;

function validateLimits(input: Partial<WebGatewayLimits>): WebGatewayLimits {
  const limits = { ...WEB_GATEWAY_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  }
  if (limits.maximumMessageBytes > MAX_WIRE_MESSAGE_BYTES) {
    throw new TypeError("maximumMessageBytes may not exceed the protocol limit");
  }
  if (limits.outboundQueuedBytes < limits.maximumMessageBytes) {
    throw new TypeError("outboundQueuedBytes must hold one maximum-size message");
  }
  return limits;
}

export function validateLoopbackViteUrl(value: string): URL {
  const target = new URL(value);
  const hostname = target.hostname.startsWith("[") ? target.hostname.slice(1, -1) : target.hostname;
  if (
    target.protocol !== "http:" ||
    target.username !== "" ||
    target.password !== "" ||
    target.search !== "" ||
    target.hash !== "" ||
    target.pathname !== "/" ||
    isIP(hostname) === 0 ||
    (hostname !== "::1" && !hostname.startsWith("127."))
  ) {
    throw new TypeError("--vite-url must be an HTTP IP-literal loopback origin");
  }
  return target;
}

function applySecurityHeaders(response: ServerResponse, development = false): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  if (development) {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
  }
}

function fixedResponse(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
  development = false,
): void {
  applySecurityHeaders(response, development);
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function exactHost(request: IncomingMessage, expected: string): boolean {
  return request.headers.host === expected && !/^https?:\/\//i.test(request.url ?? "");
}

function exactOrigin(request: IncomingMessage, expected: string): boolean {
  return request.headers.origin === expected;
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readSmallBody(request: IncomingMessage, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error("request timeout"));
    }, timeoutMs);
    timer.unref();
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 4_096) {
        clearTimeout(timer);
        request.destroy();
        reject(new Error("request too large"));
      } else chunks.push(chunk);
    });
    request.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function safeClose(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 0\r\n\r\n`,
  );
}

class InboundRateLimiter {
  private readonly timestamps: number[] = [];
  private readonly limits: WebGatewayLimits;
  private tokens: number;
  private updatedAt: number;

  constructor(limits: WebGatewayLimits, now: number) {
    this.limits = limits;
    this.tokens = limits.inboundBurst;
    this.updatedAt = now;
  }

  accept(now: number): boolean {
    const cutoff = now - this.limits.inboundWindowMs;
    while ((this.timestamps[0] ?? Infinity) <= cutoff) this.timestamps.shift();
    const refill =
      ((now - this.updatedAt) * this.limits.inboundMessagesPerWindow) / this.limits.inboundWindowMs;
    this.tokens = Math.min(this.limits.inboundBurst, this.tokens + refill);
    this.updatedAt = now;
    if (this.timestamps.length >= this.limits.inboundMessagesPerWindow || this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    this.timestamps.push(now);
    return true;
  }
}

function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
  targetPath: string,
  browserBase: string,
): void {
  const upstream = httpRequest(
    target,
    {
      method: request.method,
      path: targetPath,
      headers: {
        accept: request.headers.accept ?? "*/*",
        "accept-encoding": "identity",
        host: target.host,
      },
    },
    (upstreamResponse) => {
      applySecurityHeaders(response, true);
      response.statusCode = upstreamResponse.statusCode ?? 502;
      const contentType = upstreamResponse.headers["content-type"];
      if (typeof contentType === "string") response.setHeader("Content-Type", contentType);
      if (typeof contentType === "string" && /(?:text\/|javascript|json)/i.test(contentType)) {
        const decoder = new StringDecoder("utf8");
        let pending = "";
        const rewrite = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            pending += decoder.write(chunk);
            let output = "";
            for (let match = pending.indexOf(VITE_INTERNAL_BASE); match !== -1; ) {
              output += `${pending.slice(0, match)}${browserBase}`;
              pending = pending.slice(match + VITE_INTERNAL_BASE.length);
              match = pending.indexOf(VITE_INTERNAL_BASE);
            }
            const boundary = Math.max(0, pending.length - VITE_INTERNAL_BASE.length + 1);
            output += pending.slice(0, boundary);
            pending = pending.slice(boundary);
            callback(null, output);
          },
          flush(callback) {
            pending += decoder.end();
            callback(null, pending.replaceAll(VITE_INTERNAL_BASE, browserBase));
          },
        });
        upstreamResponse.pipe(rewrite).pipe(response);
      } else {
        upstreamResponse.pipe(response);
      }
    },
  );
  upstream.setTimeout(WEB_GATEWAY_LIMITS.handshakeTimeoutMs, () => upstream.destroy());
  upstream.once("error", () =>
    fixedResponse(response, 502, "Development server unavailable\n", undefined, true),
  );
  upstream.end();
}

function bridgeViteWebSocket(browser: WebSocket, target: URL, targetPath: string): void {
  const upstream = new WebSocket(`ws://${target.host}${targetPath}`, {
    perMessageDeflate: false,
    handshakeTimeout: WEB_GATEWAY_LIMITS.handshakeTimeoutMs,
    headers: { Origin: target.origin },
  });
  const closeBoth = (): void => {
    if (browser.readyState < WebSocket.CLOSING) browser.close(1011, "development proxy closed");
    if (upstream.readyState < WebSocket.CLOSING) upstream.close();
  };
  upstream.once("open", () => {
    browser.on("message", (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
    });
    upstream.on("message", (data, binary) => {
      if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary });
    });
  });
  upstream.once("error", closeBoth);
  upstream.once("close", closeBoth);
  browser.once("close", closeBoth);
  browser.once("error", closeBoth);
}

function bridgeDaemon(
  browser: WebSocket,
  daemon: Socket,
  limits: WebGatewayLimits,
  now: () => number,
  attachmentId: string,
  logger: (entry: WebGatewayLogEntry) => void,
): void {
  const pending = new Set<number>();
  const limiter = new InboundRateLimiter(limits, now());
  const decoder = new StringDecoder("utf8");
  let daemonBuffer = "";
  let queuedBytes = 0;
  let queuedMessages = 0;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  let lastActivity = now();
  let closed = false;

  const close = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    if (slowTimer !== undefined) clearTimeout(slowTimer);
    clearInterval(idleTimer);
    daemon.destroy();
    if (browser.readyState < WebSocket.CLOSING) browser.close(code, reason);
    logger({ event: "attachment_closed", attachmentId, code: reason });
  };

  const checkQueue = (): void => {
    const aboveHalf =
      queuedBytes >= limits.outboundQueuedBytes / 2 ||
      queuedMessages >= limits.outboundQueuedMessages / 2;
    if (!aboveHalf) {
      daemon.resume();
      if (slowTimer !== undefined) clearTimeout(slowTimer);
      slowTimer = undefined;
    }
  };

  const send = (message: string): void => {
    const bytes = Buffer.byteLength(message);
    queuedBytes = Math.max(queuedBytes, browser.bufferedAmount);
    if (bytes > limits.maximumMessageBytes) {
      close(1009, "message too large");
      return;
    }
    if (
      queuedBytes + bytes > limits.outboundQueuedBytes ||
      queuedMessages + 1 > limits.outboundQueuedMessages
    ) {
      daemon.pause();
      slowTimer ??= setTimeout(() => close(1008, "slow client"), limits.slowClientTimeoutMs);
      slowTimer.unref();
      return;
    }
    queuedBytes += bytes;
    queuedMessages += 1;
    browser.send(message, (error) => {
      queuedBytes -= bytes;
      queuedMessages -= 1;
      if (error) close(1011, "write failed");
      else checkQueue();
    });
    if (
      queuedBytes >= limits.outboundQueuedBytes ||
      queuedMessages >= limits.outboundQueuedMessages
    ) {
      daemon.pause();
      slowTimer ??= setTimeout(() => close(1008, "slow client"), limits.slowClientTimeoutMs);
      slowTimer.unref();
    }
  };

  browser.on("message", (data, isBinary) => {
    lastActivity = now();
    if (isBinary || Array.isArray(data)) {
      close(1003, "text messages required");
      return;
    }
    const bytes = Buffer.byteLength(data);
    if (bytes > limits.maximumMessageBytes || !limiter.accept(now())) {
      close(bytes > limits.maximumMessageBytes ? 1009 : 1008, "limit exceeded");
      return;
    }
    if (pending.size >= limits.maximumPendingRequests) {
      close(1008, "request limit exceeded");
      return;
    }
    let request: ReturnType<typeof parseWireRequest>;
    try {
      request = parseWireRequest(JSON.parse(data.toString("utf8").trim()) as unknown);
    } catch {
      close(1007, "invalid protocol message");
      return;
    }
    if (pending.has(request.id)) {
      close(1008, "duplicate request");
      return;
    }
    pending.add(request.id);
    daemon.write(`${JSON.stringify(request)}\n`);
  });

  daemon.on("data", (chunk: Buffer) => {
    daemonBuffer += decoder.write(chunk);
    if (
      Buffer.byteLength(daemonBuffer) > limits.maximumMessageBytes &&
      !daemonBuffer.includes("\n")
    ) {
      close(1009, "message too large");
      return;
    }
    for (
      let newline = daemonBuffer.indexOf("\n");
      newline !== -1;
      newline = daemonBuffer.indexOf("\n")
    ) {
      const line = daemonBuffer.slice(0, newline);
      daemonBuffer = daemonBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: ReturnType<typeof parseServerMessage>;
      try {
        if (Buffer.byteLength(line) > limits.maximumMessageBytes) throw new Error("too large");
        message = parseServerMessage(JSON.parse(line) as unknown);
      } catch {
        close(1007, "invalid daemon message");
        return;
      }
      if (message.kind === "success" || (message.kind === "error" && message.id !== -1)) {
        pending.delete(message.id);
      }
      send(JSON.stringify(message));
    }
  });

  browser.once("close", () => close(1000, "closed"));
  browser.once("error", () => close(1011, "transport error"));
  daemon.once("close", () => close(1011, "daemon closed"));
  daemon.once("error", () => close(1011, "daemon error"));

  const idleTimer = setInterval(
    () => {
      if (now() - lastActivity >= limits.idleTimeoutMs) close(1008, "idle timeout");
      else if (browser.readyState === WebSocket.OPEN) browser.ping();
    },
    Math.max(1, Math.min(limits.idleTimeoutMs / 2, 30_000)),
  );
  idleTimer.unref();
}

export async function startWebGateway(options: StartWebGatewayOptions): Promise<WebGateway> {
  if (options.socketPath.length === 0) throw new TypeError("socketPath is required");
  const limits = validateLimits(options.limits ?? {});
  const launchLifetime = options.launchTokenLifetimeMs ?? 60_000;
  const credentialLifetime = options.browserCredentialLifetimeSeconds ?? 12 * 60 * 60;
  if (!Number.isSafeInteger(launchLifetime) || launchLifetime <= 0 || launchLifetime > 60_000) {
    throw new TypeError("launchTokenLifetimeMs must be between 1 and 60000");
  }
  if (
    !Number.isSafeInteger(credentialLifetime) ||
    credentialLifetime <= 0 ||
    credentialLifetime > 43_200
  ) {
    throw new TypeError("browserCredentialLifetimeSeconds must be between 1 and 43200");
  }
  const viteTarget =
    options.viteUrl === undefined ? undefined : validateLoopbackViteUrl(options.viteUrl);
  const now = options.now ?? Date.now;
  const logger = options.logger ?? (() => undefined);
  let launchToken: string | undefined = randomBytes(32).toString("base64url");
  const launchExpiresAt = now() + launchLifetime;
  const credential = randomBytes(32).toString("base64url");
  const credentialExpiresAt = now() + credentialLifetime * 1_000;
  const pathPrefix = `/_axl/${randomBytes(16).toString("hex")}`;
  const cookieName = "axl_browser";
  const webSockets = new Set<WebSocket>();
  let attachments = 0;
  let expectedHost = "";
  let origin = "";

  const rpcServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: limits.maximumMessageBytes,
  });
  const viteServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: limits.maximumMessageBytes,
  });

  const server = createServer((request, response) => {
    request.socket.setTimeout(0);
    const handle = async (): Promise<void> => {
      if (!exactHost(request, expectedHost)) {
        fixedResponse(response, 421, "Misdirected request\n");
        return;
      }
      const requestUrl = new URL(request.url ?? "/", origin);
      if (
        requestUrl.search !== "" &&
        ["/", "/bootstrap.js", "/auth/exchange"].includes(requestUrl.pathname)
      ) {
        fixedResponse(response, 400, "Invalid request\n");
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/") {
        fixedResponse(response, 200, BOOTSTRAP_HTML, "text/html; charset=utf-8");
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/bootstrap.js") {
        fixedResponse(response, 200, BOOTSTRAP_SCRIPT, "text/javascript; charset=utf-8");
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/auth/exchange") {
        if (!exactOrigin(request, origin)) {
          fixedResponse(response, 403, "Forbidden\n");
          return;
        }
        const supplied = await readSmallBody(request, limits.handshakeTimeoutMs).catch(() => "");
        if (
          launchToken === undefined ||
          now() >= launchExpiresAt ||
          !secretMatches(supplied, launchToken)
        ) {
          fixedResponse(response, 401, "Authentication failed\n");
          return;
        }
        launchToken = undefined;
        response.setHeader(
          "Set-Cookie",
          `${cookieName}=${credential}; Path=${pathPrefix}; HttpOnly; SameSite=Strict; Max-Age=${credentialLifetime}`,
        );
        fixedResponse(
          response,
          200,
          JSON.stringify({
            path: viteTarget === undefined ? `${pathPrefix}/` : `${pathPrefix}/dev/`,
          }),
          "application/json; charset=utf-8",
          viteTarget !== undefined,
        );
        return;
      }
      const authenticated =
        requestUrl.pathname.startsWith(`${pathPrefix}/`) &&
        exactOrigin(request, origin) &&
        now() < credentialExpiresAt &&
        secretMatches(cookieValue(request, cookieName), credential);
      if (!authenticated) {
        fixedResponse(response, 404, "Not found\n");
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === `${pathPrefix}/`) {
        fixedResponse(response, 200, READY_HTML, "text/html; charset=utf-8");
        return;
      }
      if (
        viteTarget !== undefined &&
        (request.method === "GET" || request.method === "HEAD") &&
        requestUrl.pathname.startsWith(`${pathPrefix}/dev/`)
      ) {
        const targetPath = `${VITE_INTERNAL_BASE}${requestUrl.pathname.slice(`${pathPrefix}/dev/`.length)}${requestUrl.search}`;
        proxyHttp(request, response, viteTarget, targetPath, `${pathPrefix}/dev/`);
        return;
      }
      fixedResponse(response, 404, "Not found\n", undefined, viteTarget !== undefined);
    };
    void handle().catch(() => fixedResponse(response, 500, "Internal error\n"));
  });
  server.headersTimeout = limits.handshakeTimeoutMs;
  server.requestTimeout = limits.handshakeTimeoutMs;
  server.on("connection", (socket) => {
    socket.setTimeout(limits.handshakeTimeoutMs, () => socket.destroy());
  });

  server.on("upgrade", (request, socket, head) => {
    (socket as Socket).setTimeout(0);
    if (!exactHost(request, expectedHost) || !exactOrigin(request, origin)) {
      safeClose(socket, 403, "Forbidden");
      return;
    }
    const requestUrl = new URL(request.url ?? "/", origin);
    if (
      !requestUrl.pathname.startsWith(`${pathPrefix}/`) ||
      now() >= credentialExpiresAt ||
      !secretMatches(cookieValue(request, cookieName), credential)
    ) {
      safeClose(socket, 404, "Not Found");
      return;
    }
    if (viteTarget !== undefined && requestUrl.pathname.startsWith(`${pathPrefix}/dev/`)) {
      const targetPath = `${VITE_INTERNAL_BASE}${requestUrl.pathname.slice(`${pathPrefix}/dev/`.length)}${requestUrl.search}`;
      viteServer.handleUpgrade(request, socket, head, (browser) => {
        webSockets.add(browser);
        browser.once("close", () => webSockets.delete(browser));
        bridgeViteWebSocket(browser, viteTarget, targetPath);
      });
      return;
    }
    if (
      requestUrl.search !== "" ||
      requestUrl.pathname !== `${pathPrefix}/rpc` ||
      attachments >= limits.maximumAttachments
    ) {
      safeClose(socket, attachments >= limits.maximumAttachments ? 429 : 404, "Not Found");
      return;
    }
    attachments += 1;
    const daemon = connect(options.socketPath);
    const timeout = setTimeout(
      () => daemon.destroy(new Error("handshake timeout")),
      limits.handshakeTimeoutMs,
    );
    timeout.unref();
    let settled = false;
    const release = (): void => {
      if (!settled) attachments -= 1;
      settled = true;
      clearTimeout(timeout);
    };
    const connectFailed = (): void => {
      release();
      safeClose(socket, 502, "Bad Gateway");
    };
    daemon.once("error", connectFailed);
    daemon.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      daemon.off("error", connectFailed);
      rpcServer.handleUpgrade(request, socket, head, (browser) => {
        const attachmentId = createHash("sha256")
          .update(randomBytes(32))
          .digest("hex")
          .slice(0, 16);
        webSockets.add(browser);
        logger({ event: "attachment_opened", attachmentId });
        browser.once("close", () => {
          webSockets.delete(browser);
          attachments -= 1;
        });
        bridgeDaemon(browser, daemon, limits, now, attachmentId, logger);
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => {
      server.off("listening", listening);
      reject(error);
    };
    const listening = (): void => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(options.port ?? 0, LOOPBACK_HOST);
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== LOOPBACK_HOST) {
    await closeServer(server);
    throw new Error("Gateway failed to bind the required loopback address");
  }
  expectedHost = `${LOOPBACK_HOST}:${address.port}`;
  origin = `http://${expectedHost}`;
  logger({ event: "started" });

  let stopped = false;
  return {
    origin,
    launchUrl: `${origin}/#${launchToken}`,
    pathPrefix,
    async close(): Promise<void> {
      if (stopped) return;
      stopped = true;
      launchToken = undefined;
      for (const webSocket of webSockets) webSocket.terminate();
      webSockets.clear();
      await closeServer(server);
      rpcServer.close();
      viteServer.close();
      logger({ event: "stopped" });
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

export function maximumCanonicalEventEnvelopeFits(
  eventJsonBytes = MAX_CANONICAL_EVENT_BYTES,
): boolean {
  return (
    eventJsonBytes + (MAX_WIRE_MESSAGE_BYTES - MAX_CANONICAL_EVENT_BYTES) <= MAX_WIRE_MESSAGE_BYTES
  );
}
