// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { AxlClientError, type AxlTransport, type AxlTransportFactory } from "./client.ts";

interface SocketEventMap {
  open: unknown;
  message: { readonly data: unknown };
  close: { readonly code?: number; readonly reason?: string };
  error: unknown;
}

interface BrowserSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener<Type extends keyof SocketEventMap>(
    type: Type,
    listener: (event: SocketEventMap[Type]) => void,
  ): void;
  removeEventListener<Type extends keyof SocketEventMap>(
    type: Type,
    listener: (event: SocketEventMap[Type]) => void,
  ): void;
}

interface BrowserSocketConstructor {
  readonly OPEN: number;
  new (url: string): BrowserSocket;
}

export class BrowserWebSocketTransportFactory implements AxlTransportFactory<never> {
  private readonly url: string;
  private readonly Socket: BrowserSocketConstructor;

  constructor(
    url: string,
    Socket: BrowserSocketConstructor = (
      globalThis as unknown as { readonly WebSocket: BrowserSocketConstructor }
    ).WebSocket,
  ) {
    this.url = url;
    this.Socket = Socket;
  }

  connect(): Promise<AxlTransport> {
    return new Promise((resolve, reject) => {
      const socket = new this.Socket(this.url);
      const opened = (): void => {
        cleanup();
        resolve({
          send(message) {
            if (socket.readyState !== thisSocket.OPEN) {
              throw new AxlClientError("disconnected", "Browser WebSocket is closed");
            }
            socket.send(message);
          },
          onMessage(listener) {
            const receive = (event: SocketEventMap["message"]): void => {
              if (typeof event.data !== "string") {
                listener(event.data);
                return;
              }
              try {
                listener(JSON.parse(event.data) as unknown);
              } catch {
                listener(event.data);
              }
            };
            socket.addEventListener("message", receive);
            return () => socket.removeEventListener("message", receive);
          },
          onClose(listener) {
            const close = (event: SocketEventMap["close"]) =>
              listener(
                event.reason
                  ? new AxlClientError("disconnected", event.reason, {
                      details: { code: event.code ?? 0 },
                    })
                  : undefined,
              );
            socket.addEventListener("close", close);
            return () => socket.removeEventListener("close", close);
          },
          close: () => socket.close(),
        });
      };
      const failed = (): void => {
        cleanup();
        socket.close();
        reject(new AxlClientError("connection_error", "Could not open browser WebSocket"));
      };
      const cleanup = (): void => {
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
      };
      const thisSocket = this.Socket;
      socket.addEventListener("open", opened);
      socket.addEventListener("error", failed);
    });
  }
}
