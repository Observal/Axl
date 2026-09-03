// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

import { MAX_WIRE_MESSAGE_BYTES } from "@axl/protocol";

import {
  AxlClient,
  AxlClientError,
  type AxlClientOptions,
  type AxlTransport,
  type AxlTransportFactory,
  type IdempotencyKeyFactory,
} from "./client.ts";

class UnixSocketTransport implements AxlTransport {
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<(cause?: Error) => void>();
  private readonly decoder = new StringDecoder("utf8");
  private readonly queuedMessages: unknown[] = [];
  private buffer = "";
  private closed = false;
  private closeCause: Error | undefined;

  private readonly socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.receive(chunk));
    socket.once("error", (cause) => this.finish(cause));
    socket.once("close", () => this.finish());
  }

  send(message: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(message, (error) => (error ? reject(error) : resolve()));
    });
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
    if (!this.closed) this.socket.destroy();
    this.closed = true;
  }

  private receive(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > MAX_WIRE_MESSAGE_BYTES && !this.buffer.includes("\n")) {
      this.finish(new AxlClientError("frame_too_large", "Daemon message exceeded the size limit"));
      this.socket.destroy();
      return;
    }
    for (
      let newline = this.buffer.indexOf("\n");
      newline !== -1;
      newline = this.buffer.indexOf("\n")
    ) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_WIRE_MESSAGE_BYTES) {
        this.finish(
          new AxlClientError("frame_too_large", "Daemon message exceeded the size limit"),
        );
        this.socket.destroy();
        return;
      }
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (cause) {
        this.finish(new AxlClientError("protocol_error", "Daemon sent invalid JSON", { cause }));
        this.socket.destroy();
        return;
      }
      if (this.messageListeners.size === 0) this.queuedMessages.push(value);
      else for (const listener of this.messageListeners) listener(value);
    }
  }

  private finish(cause?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCause = cause;
    for (const listener of this.closeListeners) listener(cause);
    this.closeListeners.clear();
  }
}

export class UnixSocketTransportFactory implements AxlTransportFactory<never> {
  readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  connect(): Promise<AxlTransport> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      socket.once("connect", () => resolve(new UnixSocketTransport(socket)));
      socket.once("error", reject);
    });
  }
}

export const nodeIdempotencyKeys: IdempotencyKeyFactory = { create: () => randomUUID() };

export async function connectUnixClient(
  socketPath: string,
  options: Partial<Omit<AxlClientOptions<never>, "transport" | "idempotencyKeys">> = {},
): Promise<AxlClient> {
  return AxlClient.connect({
    ...options,
    identity: options.identity ?? { kind: "tui", version: "0.0.0", instanceId: randomUUID() },
    transport: new UnixSocketTransportFactory(socketPath),
    idempotencyKeys: nodeIdempotencyKeys,
  });
}
