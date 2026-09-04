// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { MAX_WIRE_MESSAGE_BYTES } from "@axl/protocol";

import {
  AxlClient,
  AxlClientError,
  type AxlClientOptions,
  type AxlTransport,
  type AxlTransportFactory,
  type IdempotencyKeyFactory,
} from "./client.ts";

interface WebSocketMessageEvent {
  readonly data: unknown;
}

interface WebSocketCloseEvent {
  readonly code: number;
  readonly reason: string;
}

export interface BrowserWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void, options?: { readonly once?: boolean }): void;
  addEventListener(
    type: "message",
    listener: (event: WebSocketMessageEvent) => void,
    options?: { readonly once?: boolean },
  ): void;
  addEventListener(
    type: "close",
    listener: (event: WebSocketCloseEvent) => void,
    options?: { readonly once?: boolean },
  ): void;
  addEventListener(
    type: "error",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: "message", listener: (event: WebSocketMessageEvent) => void): void;
  removeEventListener(type: "close", listener: (event: WebSocketCloseEvent) => void): void;
}

export type BrowserWebSocketConstructor = new (url: string) => BrowserWebSocketLike;

export interface BrowserWebSocketTransportOptions {
  readonly origin?: string;
  readonly WebSocket?: BrowserWebSocketConstructor;
  readonly maximumMessageBytes?: number;
}

function browserWebSocket(): BrowserWebSocketConstructor {
  const value = (globalThis as { readonly WebSocket?: unknown }).WebSocket;
  if (typeof value !== "function") {
    throw new AxlClientError("transport_unavailable", "This runtime has no WebSocket transport");
  }
  return value as BrowserWebSocketConstructor;
}

function browserOrigin(): string {
  const value = (globalThis as { readonly location?: { readonly origin?: unknown } }).location
    ?.origin;
  if (typeof value !== "string") {
    throw new AxlClientError("transport_unavailable", "This runtime has no browser origin");
  }
  return value;
}

function websocketUrl(path: string, origin: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("#") || path.includes("?")) {
    throw new TypeError(
      "WebSocket path must be an absolute same-origin path without query or fragment",
    );
  }
  const base = new URL(origin);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new TypeError("WebSocket origin must use HTTP or HTTPS");
  }
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new TypeError("WebSocket URL must remain same-origin");
  url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

class BrowserWebSocketTransport implements AxlTransport {
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<(cause?: Error) => void>();
  private readonly queuedMessages: unknown[] = [];
  private closed = false;
  private closeCause: Error | undefined;

  private readonly socket: BrowserWebSocketLike;
  private readonly maximumMessageBytes: number;

  constructor(socket: BrowserWebSocketLike, maximumMessageBytes: number) {
    this.socket = socket;
    this.maximumMessageBytes = maximumMessageBytes;
    socket.addEventListener("message", this.receive);
    socket.addEventListener("close", this.closedByPeer);
    socket.addEventListener("error", this.failed);
  }

  send(message: string): void {
    if (this.closed || this.socket.readyState !== 1) {
      throw new AxlClientError("write_failed", "WebSocket is not open");
    }
    if (new TextEncoder().encode(message).byteLength > this.maximumMessageBytes) {
      throw new AxlClientError("frame_too_large", "Request exceeded the WebSocket size limit");
    }
    this.socket.send(message);
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    for (const message of this.queuedMessages.splice(0)) listener(message);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (cause?: Error) => void): () => void {
    if (this.closed) queueMicrotask(() => listener(this.closeCause));
    else this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    if (!this.closed) this.socket.close(1000, "client closed");
    this.finish();
  }

  private readonly receive = (event: WebSocketMessageEvent): void => {
    if (typeof event.data !== "string") {
      this.finish(new AxlClientError("protocol_error", "Gateway sent a binary WebSocket message"));
      this.socket.close(1003, "text messages required");
      return;
    }
    if (new TextEncoder().encode(event.data).byteLength > this.maximumMessageBytes) {
      this.finish(new AxlClientError("frame_too_large", "Gateway message exceeded the size limit"));
      this.socket.close(1009, "message too large");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data.trim()) as unknown;
    } catch (cause) {
      this.finish(new AxlClientError("protocol_error", "Gateway sent invalid JSON", { cause }));
      this.socket.close(1007, "invalid JSON");
      return;
    }
    if (this.messageListeners.size === 0) this.queuedMessages.push(value);
    else for (const listener of this.messageListeners) listener(value);
  };

  private readonly closedByPeer = (event: WebSocketCloseEvent): void => {
    const cause =
      event.code === 1000
        ? undefined
        : new AxlClientError("connection_error", "WebSocket connection closed", {
            details: { closeCode: event.code },
          });
    this.finish(cause);
  };

  private readonly failed = (): void => {
    this.finish(new AxlClientError("connection_error", "WebSocket transport failed"));
  };

  private finish(cause?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCause = cause;
    this.socket.removeEventListener("message", this.receive);
    this.socket.removeEventListener("close", this.closedByPeer);
    for (const listener of this.closeListeners) listener(cause);
    this.closeListeners.clear();
  }
}

export class BrowserWebSocketTransportFactory implements AxlTransportFactory<never> {
  private readonly path: string;
  private readonly origin: string;
  private readonly WebSocket: BrowserWebSocketConstructor;
  private readonly maximumMessageBytes: number;

  constructor(path: string, options: BrowserWebSocketTransportOptions = {}) {
    this.path = path;
    this.origin = options.origin ?? browserOrigin();
    this.WebSocket = options.WebSocket ?? browserWebSocket();
    this.maximumMessageBytes = options.maximumMessageBytes ?? MAX_WIRE_MESSAGE_BYTES;
    if (!Number.isSafeInteger(this.maximumMessageBytes) || this.maximumMessageBytes <= 0) {
      throw new TypeError("maximumMessageBytes must be a positive safe integer");
    }
  }

  connect(): Promise<AxlTransport> {
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocket(websocketUrl(this.path, this.origin));
      let settled = false;
      const opened = (): void => {
        if (settled) return;
        settled = true;
        resolve(new BrowserWebSocketTransport(socket, this.maximumMessageBytes));
      };
      const failed = (): void => {
        if (settled) return;
        settled = true;
        reject(new AxlClientError("connection_error", "Could not open the WebSocket"));
      };
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
    });
  }
}

export const browserIdempotencyKeys: IdempotencyKeyFactory = {
  create: () => globalThis.crypto.randomUUID(),
};

export async function connectBrowserClient(
  path: string,
  options: Partial<Omit<AxlClientOptions<never>, "transport" | "idempotencyKeys">> &
    BrowserWebSocketTransportOptions = {},
): Promise<AxlClient> {
  const { origin, WebSocket, maximumMessageBytes, ...clientOptions } = options;
  return AxlClient.connect({
    ...clientOptions,
    identity: clientOptions.identity ?? {
      kind: "web",
      version: "0.0.0",
      instanceId: globalThis.crypto.randomUUID(),
    },
    requestedCapabilities: clientOptions.requestedCapabilities ?? [],
    transport: new BrowserWebSocketTransportFactory(path, {
      ...(origin === undefined ? {} : { origin }),
      ...(WebSocket === undefined ? {} : { WebSocket }),
      ...(maximumMessageBytes === undefined ? {} : { maximumMessageBytes }),
    }),
    idempotencyKeys: browserIdempotencyKeys,
  });
}
