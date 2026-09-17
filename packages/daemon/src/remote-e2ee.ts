// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";

import {
  encodeRemoteDaemonMessage,
  encodeRemoteE2eeEnvelope,
  parseAuthenticatedRemoteRequest,
  parseDeviceId,
  parseRemoteE2eeEnvelope,
  type DeviceId,
  type OperationId,
  type RemoteDaemonMessage,
  type RequestId,
  type RouteId,
  type ServerMessage,
} from "@axl/protocol";

import {
  type AuthenticatedRemoteAttachment,
  type AuthenticatedRemoteRequestResult,
  AxlDaemon,
} from "./daemon.ts";
import type { RemoteDeviceAuthorityStore } from "./remote-authority.ts";

interface NativeCiphertext {
  readonly operationId: Uint8Array;
  readonly logicalMessageId: Uint8Array;
  readonly messageClass: string;
  readonly ciphertext: Uint8Array;
}

interface NativePlaintext {
  readonly plaintext: Uint8Array;
}

/** Narrow structural subset of the private Node binding used by the daemon. */
export interface NativeDaemonE2eeEndpoint {
  prepareApplication(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    plaintext: Uint8Array,
  ): Promise<NativeCiphertext>;
  receiveApplication(
    operationId: Uint8Array,
    ciphertext: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<NativePlaintext>;
  acknowledgeOutbox(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<NativeCiphertext>;
  acknowledgeReceive(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<"acknowledged">;
  close(): void;
}

export interface RemoteEncryptedDelivery {
  readonly sourceRouteId: RouteId;
  readonly opaqueEnvelope: Uint8Array;
}

export interface RemoteEncryptedSender {
  send(destinationRouteId: RouteId, opaqueEnvelope: Uint8Array): Promise<void> | void;
}

export interface WindowsRemoteE2eeBridgeOptions {
  readonly daemon: AxlDaemon;
  readonly deviceId: DeviceId;
  readonly authority: RemoteDeviceAuthorityStore;
  readonly endpoint: NativeDaemonE2eeEndpoint;
  readonly sender: RemoteEncryptedSender;
  readonly onError?: (error: Error) => void;
}

function idBytes(value: string): Uint8Array {
  const encoded = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/u.test(encoded)) throw new Error("Invalid operation identity");
  return Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16),
  );
}

function derivedId(
  domain: string,
  requestId: string,
): { readonly text: string; readonly bytes: Uint8Array } {
  const digest = createHash("sha256").update(domain).update("\0").update(requestId).digest();
  const value = new Uint8Array(digest.subarray(0, 16));
  value[6] = ((value[6] ?? 0) & 0x0f) | 0x70;
  value[8] = ((value[8] ?? 0) & 0x3f) | 0x80;
  const encoded = Buffer.from(value).toString("hex");
  return {
    text: `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20)}`,
    bytes: value,
  };
}

function safeRemoteError(cause: unknown, requestId: RequestId): RemoteDaemonMessage {
  const candidate = cause as { readonly code?: unknown; readonly retryable?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "internal_error";
  return {
    version: 1,
    type: "daemon_error",
    requestId,
    code,
    message: "The remote request failed safely.",
    retryable: candidate?.retryable === true,
  };
}

/**
 * Bridges opaque relay delivery to one native daemon E2EE endpoint. Cryptographic authentication
 * precedes daemon authorization. All endpoint calls and outbound encryption are serialized.
 */
export class WindowsRemoteE2eeBridge {
  private readonly options: WindowsRemoteE2eeBridgeOptions;
  private readonly attachment: AuthenticatedRemoteAttachment;
  private tail: Promise<void> = Promise.resolve();
  private currentRoute: RouteId | undefined;
  private closed = false;

  constructor(options: WindowsRemoteE2eeBridgeOptions) {
    this.options = options;
    this.attachment = options.daemon.attachAuthenticatedRemoteDevice({
      deviceId: options.deviceId,
      authority: options.authority,
      send: (message) => this.enqueueDaemonMessage(message),
    });
  }

  receive(delivery: RemoteEncryptedDelivery): Promise<void> {
    const copied = new Uint8Array(delivery.opaqueEnvelope);
    const operation = this.tail.then(() => this.receiveOne(delivery.sourceRouteId, copied));
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.attachment.close();
    this.options.endpoint.close();
    this.currentRoute = undefined;
  }

  private async receiveOne(sourceRouteId: RouteId, bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("Remote E2EE bridge is closed");
    let requestId: RequestId | undefined;
    let incomingOperation: Uint8Array | undefined;
    try {
      const envelope = parseRemoteE2eeEnvelope(bytes);
      if (envelope.messageClass !== "application_request") {
        throw new Error("Remote E2EE envelope is not an application request");
      }
      this.currentRoute = sourceRouteId;
      incomingOperation = idBytes(envelope.operationId);
      const opened = await this.options.endpoint.receiveApplication(
        incomingOperation,
        envelope.ciphertext,
        idBytes(envelope.logicalMessageId),
        BigInt(envelope.hostedGrantGeneration),
      );
      const request = parseAuthenticatedRemoteRequest(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext)),
      );
      requestId = request.requestId;
      if (parseDeviceId(request.deviceId) !== this.options.deviceId) {
        throw new Error("Authenticated request device does not match the endpoint");
      }
      const response = await this.attachment.request(request);
      if (request.idempotencyKey !== undefined) {
        await this.sendMessage(sourceRouteId, {
          version: 1,
          type: "daemon_accepted",
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
        });
      }
      await this.sendResult(sourceRouteId, response);
      const acknowledgement = derivedId("axl-e2ee-receive-ack-v1", envelope.operationId);
      await this.options.endpoint.acknowledgeReceive(acknowledgement.bytes, incomingOperation);
    } catch (cause) {
      if (requestId !== undefined) {
        await this.sendMessage(sourceRouteId, safeRemoteError(cause, requestId));
      } else {
        this.options.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
      }
      throw cause;
    } finally {
      bytes.fill(0);
      incomingOperation?.fill(0);
    }
  }

  private sendResult(routeId: RouteId, response: AuthenticatedRemoteRequestResult): Promise<void> {
    return this.sendMessage(routeId, {
      version: 1,
      type: "daemon_result",
      requestId: response.requestId,
      method: response.method,
      result: response.result,
    });
  }

  private enqueueDaemonMessage(message: ServerMessage): void {
    const route = this.currentRoute;
    if (route === undefined || this.closed) return;
    const operation = this.tail.then(() =>
      this.sendMessage(route, { version: 1, type: "daemon_delivery", message }),
    );
    this.tail = operation.catch((cause: unknown) => {
      this.options.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
    });
  }

  private async sendMessage(routeId: RouteId, message: RemoteDaemonMessage): Promise<void> {
    const authority = this.options.authority.snapshot(this.options.deviceId);
    if (authority?.hostedGeneration === undefined || authority.effectiveScopes.length === 0) {
      throw new Error("Remote authority is unavailable");
    }
    const requestIdentity = "requestId" in message ? message.requestId : randomUUID();
    const operation = derivedId(`axl-e2ee-daemon-${message.type}-operation-v1`, requestIdentity);
    const logical = derivedId(`axl-e2ee-daemon-${message.type}-logical-v1`, requestIdentity);
    const plaintext = encodeRemoteDaemonMessage(message);
    try {
      const prepared = await this.options.endpoint.prepareApplication(
        operation.bytes,
        logical.bytes,
        BigInt(authority.hostedGeneration),
        plaintext,
      );
      if (prepared.messageClass !== "application_delivery") {
        throw new Error("Native endpoint returned the wrong message class");
      }
      await this.options.sender.send(
        routeId,
        encodeRemoteE2eeEnvelope({
          operationId: operation.text as OperationId,
          logicalMessageId: logical.text as OperationId,
          messageClass: "application_delivery",
          hostedGrantGeneration: authority.hostedGeneration,
          ciphertext: prepared.ciphertext,
        }),
      );
    } finally {
      plaintext.fill(0);
      operation.bytes.fill(0);
      logical.bytes.fill(0);
    }
  }
}
