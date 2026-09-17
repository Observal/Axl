// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";

import {
  type DeviceId,
  encodeRemoteDaemonMessage,
  encodeRemoteE2eeEnvelope,
  type OperationId,
  parseAuthenticatedRemoteRequest,
  parseDeviceId,
  parseRemoteE2eeEnvelope,
  type RemoteDaemonMessage,
  type RemoteE2eeEnvelope,
  type RequestId,
  type RouteId,
  type ServerMessage,
} from "@axl/protocol";

import type {
  AuthenticatedRemoteAttachment,
  AuthenticatedRemoteRequestResult,
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

interface NativeEpochReadyAcceptance {
  readonly cryptoSessionId: Uint8Array;
  readonly commitId: Uint8Array;
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
  receiveReplacementProposal?(
    operationId: Uint8Array,
    ciphertext: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<"accepted">;
  createUpdateCommit?(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<NativeCiphertext>;
  acceptEpochReady?(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<NativeEpochReadyAcceptance>;
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

function uuidText(value: Uint8Array): OperationId {
  if (value.byteLength !== 16) throw new Error("Invalid native operation identity");
  const encoded = Buffer.from(value).toString("hex");
  return `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20)}` as OperationId;
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
      const authority = this.options.authority.snapshot(this.options.deviceId);
      if (
        authority?.hostedGeneration !== envelope.hostedGrantGeneration ||
        authority.effectiveScopes.length === 0
      ) {
        throw new Error("Remote hosted grant generation is stale or unavailable");
      }
      this.currentRoute = sourceRouteId;
      incomingOperation = idBytes(envelope.operationId);
      if (envelope.messageClass === "update_proposal") {
        await this.receiveUpdateProposal(sourceRouteId, envelope, incomingOperation);
        return;
      }
      if (envelope.messageClass === "epoch_ready") {
        await this.receiveEpochReady(envelope, incomingOperation);
        return;
      }
      if (envelope.messageClass !== "application_request") {
        throw new Error("Remote E2EE envelope has an invalid device-to-daemon class");
      }
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

  private async receiveUpdateProposal(
    routeId: RouteId,
    envelope: RemoteE2eeEnvelope,
    incomingOperation: Uint8Array,
  ): Promise<void> {
    const receive = this.options.endpoint.receiveReplacementProposal;
    const createCommit = this.options.endpoint.createUpdateCommit;
    if (receive === undefined || createCommit === undefined) {
      throw new Error("Native endpoint does not support MLS updates");
    }
    const logical = idBytes(envelope.logicalMessageId);
    try {
      await receive.call(
        this.options.endpoint,
        incomingOperation,
        envelope.ciphertext,
        logical,
        BigInt(envelope.hostedGrantGeneration),
      );
      const commitOperation = derivedId(
        "axl-e2ee-daemon-commit-operation-v1",
        envelope.operationId,
      );
      const commitLogical = derivedId(
        "axl-e2ee-daemon-commit-logical-v1",
        envelope.logicalMessageId,
      );
      try {
        const commit = await createCommit.call(
          this.options.endpoint,
          commitOperation.bytes,
          commitLogical.bytes,
          BigInt(envelope.hostedGrantGeneration),
        );
        await this.sendPrepared(routeId, commit, envelope.hostedGrantGeneration, "commit");
      } finally {
        commitOperation.bytes.fill(0);
        commitLogical.bytes.fill(0);
      }
      const acknowledgement = derivedId(
        "axl-e2ee-update-proposal-receive-ack-v1",
        envelope.operationId,
      );
      try {
        await this.options.endpoint.acknowledgeReceive(acknowledgement.bytes, incomingOperation);
      } finally {
        acknowledgement.bytes.fill(0);
      }
    } finally {
      logical.fill(0);
    }
  }

  private async receiveEpochReady(
    envelope: RemoteE2eeEnvelope,
    incomingOperation: Uint8Array,
  ): Promise<void> {
    const accept = this.options.endpoint.acceptEpochReady;
    if (accept === undefined) throw new Error("Native endpoint does not support epoch readiness");
    const logical = idBytes(envelope.logicalMessageId);
    try {
      await accept.call(this.options.endpoint, incomingOperation, logical, envelope.ciphertext);
      const acknowledgement = derivedId(
        "axl-e2ee-epoch-ready-receive-ack-v1",
        envelope.operationId,
      );
      try {
        await this.options.endpoint.acknowledgeReceive(acknowledgement.bytes, incomingOperation);
      } finally {
        acknowledgement.bytes.fill(0);
      }
    } finally {
      logical.fill(0);
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
      await this.sendPrepared(
        routeId,
        prepared,
        authority.hostedGeneration,
        "application_delivery",
      );
    } finally {
      plaintext.fill(0);
      operation.bytes.fill(0);
      logical.bytes.fill(0);
    }
  }

  private async sendPrepared(
    routeId: RouteId,
    prepared: NativeCiphertext,
    hostedGrantGeneration: number,
    expectedClass: RemoteE2eeEnvelope["messageClass"],
  ): Promise<void> {
    if (prepared.messageClass !== expectedClass) {
      throw new Error("Native endpoint returned the wrong message class");
    }
    await this.options.sender.send(
      routeId,
      encodeRemoteE2eeEnvelope({
        operationId: uuidText(prepared.operationId),
        logicalMessageId: uuidText(prepared.logicalMessageId),
        messageClass: expectedClass,
        hostedGrantGeneration,
        ciphertext: prepared.ciphertext,
      }),
    );
  }
}
