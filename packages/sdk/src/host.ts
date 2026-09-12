// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import {
  type DaemonHostStatus,
  HOST_CONTROL_VERSION,
  type HostContext,
  type HostRequest,
  type ProviderAuthenticationStatus,
  type ProviderLoginParams,
  parseHostRequest,
  parseHostResponse,
} from "@axl/protocol";

import { AxlClientError, type AxlTransport, type AxlTransportFactory } from "./client.ts";

/** Provider login intent only. Credential prompts stay inside the trusted process host. */
export interface TrustedProviderHost {
  loginProvider(
    params: ProviderLoginParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProviderAuthenticationStatus>;
}

/** Host intent only. Presentation code receives this from its trusted process host. */
export interface DaemonHostControl {
  status(context?: HostContext): Promise<DaemonHostStatus>;
  shutdown(
    status: DaemonHostStatus,
    options: HostContext & { interrupt: boolean; confirmed: boolean },
  ): Promise<DaemonHostStatus>;
  force(instanceId: string): Promise<DaemonHostStatus>;
}

/** No launches, PID signals, session handshake bypass, or automatic retries. */
export class DaemonHostClient implements DaemonHostControl {
  private readonly transport: AxlTransportFactory<never>;
  private readonly timeoutMs: number;

  constructor(transport: AxlTransportFactory<never>, timeoutMs = 10_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new TypeError("Host timeout must be positive");
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }

  status(context: HostContext = {}): Promise<DaemonHostStatus> {
    return this.request({
      kind: "host.request",
      version: HOST_CONTROL_VERSION,
      method: "status",
      context,
    });
  }

  shutdown(
    status: DaemonHostStatus,
    options: HostContext & { interrupt: boolean; confirmed: boolean },
  ): Promise<DaemonHostStatus> {
    const { interrupt, confirmed, ...context } = options;
    return this.request({
      kind: "host.request",
      version: HOST_CONTROL_VERSION,
      method: "shutdown",
      instanceId: status.instanceId,
      revision: status.revision,
      context,
      interrupt,
      confirmed,
    });
  }

  force(instanceId: string): Promise<DaemonHostStatus> {
    return this.request({
      kind: "host.request",
      version: HOST_CONTROL_VERSION,
      method: "force",
      instanceId,
    });
  }

  private request(request: HostRequest): Promise<DaemonHostStatus> {
    parseHostRequest(request);
    return new Promise((resolve, reject) => {
      let transport: AxlTransport | undefined;
      let settled = false;
      const finish = (status?: DaemonHostStatus, error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        transport?.close();
        if (error !== undefined) reject(error);
        else if (status !== undefined) resolve(status);
      };
      const timer = setTimeout(
        () =>
          finish(
            undefined,
            new AxlClientError(
              "host_timeout",
              "Daemon control timed out. Shutdown may still be running; inspect status before explicitly forcing termination.",
            ),
          ),
        this.timeoutMs,
      );
      void this.transport.connect(undefined).then(
        (connected) => {
          if (settled) {
            connected.close();
            return;
          }
          transport = connected;
          connected.onClose((cause) =>
            finish(
              undefined,
              new AxlClientError(
                "disconnected",
                "Daemon control connection closed before confirming the outcome",
                { cause },
              ),
            ),
          );
          connected.onMessage((message) => {
            // The shared socket announces its session wire first. Host control has its own version.
            if (
              typeof message === "object" &&
              message !== null &&
              "kind" in message &&
              message.kind === "hello"
            )
              return;
            try {
              if (
                typeof message === "object" &&
                message !== null &&
                "kind" in message &&
                message.kind === "error"
              ) {
                throw new AxlClientError(
                  "host_unavailable",
                  "This daemon has no host-control channel. Use its original build or manually verify its process before stopping it; Axl will not signal a PID from a lock file.",
                );
              }
              const response = parseHostResponse(message);
              if ("error" in response)
                throw new AxlClientError(response.error.code, response.error.message);
              finish(response.status);
            } catch (error) {
              finish(undefined, error);
            }
          });
          void Promise.resolve()
            .then(() => connected.send(`${JSON.stringify(request)}\n`))
            .catch((error: unknown) => finish(undefined, error));
        },
        (cause: unknown) =>
          finish(
            undefined,
            new AxlClientError("connection_error", "Could not connect to daemon host control", {
              cause,
            }),
          ),
      );
    });
  }
}
