// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM049
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
import {
  DaemonWitnessBarrier,
  type DaemonWitnessEndpointOperations,
  type DaemonWitnessOutcome,
  type DaemonWitnessResult,
  type DaemonWitnessTransport,
  releasedField,
} from "./remote-witness.ts";

/** Released `outbox` result: the exact committed ciphertext and its envelope metadata. */
export interface NativeCiphertext {
  readonly operationId: Uint8Array;
  readonly logicalMessageId: Uint8Array;
  readonly messageClass: string;
  readonly ciphertext: Uint8Array;
}

/** Released `plaintext` result of a completed receive. */
export interface NativePlaintext {
  readonly plaintext: Uint8Array;
}

/** Released `epoch_ready` result of an accepted epoch-ready message. */
export interface NativeEpochReadyAcceptance {
  readonly cryptoSessionId: Uint8Array;
  readonly commitId: Uint8Array;
}

/**
 * Narrow structural subset of the private Node binding used by the daemon. Every mutation returns
 * a witness outcome; the bridge reads results only after the barrier completes.
 */
export interface NativeDaemonE2eeEndpoint extends DaemonWitnessEndpointOperations {
  prepareApplication(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    plaintext: Uint8Array,
  ): Promise<DaemonWitnessOutcome>;
  receiveApplication(
    operationId: Uint8Array,
    ciphertext: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<DaemonWitnessOutcome>;
  receiveReplacementProposal?(
    operationId: Uint8Array,
    ciphertext: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<DaemonWitnessOutcome>;
  createUpdateCommit?(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<DaemonWitnessOutcome>;
  acceptEpochReady?(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    ciphertext: Uint8Array,
  ): Promise<DaemonWitnessOutcome>;
  prepareEpochReadyConfirmation?(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    acceptance: NativeEpochReadyAcceptance,
  ): Promise<DaemonWitnessOutcome>;
  acknowledgeOutbox(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<DaemonWitnessOutcome>;
  acknowledgeReceive(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<DaemonWitnessOutcome>;
  close(): void;
}

function outbox(result: DaemonWitnessResult): NativeCiphertext {
  const value = releasedField<NativeCiphertext>(result, "outbox", "outbox");
  if (
    !(value.operationId instanceof Uint8Array) ||
    !(value.logicalMessageId instanceof Uint8Array) ||
    typeof value.messageClass !== "string" ||
    !(value.ciphertext instanceof Uint8Array)
  ) {
    throw new Error("Native endpoint released an invalid outbox record");
  }
  return value;
}

function accepted(result: DaemonWitnessResult): void {
  releasedField(result, "accepted", "accepted");
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
  /** Daemon-owned authenticated witness transport for the endpoint's signed requests. */
  readonly witness: DaemonWitnessTransport;
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
 * Bridges opaque relay delivery to one native daemon E2EE endpoint. Every endpoint mutation
 * completes its witness barrier before the bridge frames ciphertext, parses plaintext, or
 * authorizes a request. Cryptographic authentication precedes daemon authorization. All endpoint
 * calls and outbound encryption are serialized; the serialization orders work, the barrier
 * authorizes it.
 */
export class WindowsRemoteE2eeBridge {
  private readonly options: WindowsRemoteE2eeBridgeOptions;
  private readonly barrier: DaemonWitnessBarrier<NativeDaemonE2eeEndpoint>;
  private readonly attachment: AuthenticatedRemoteAttachment;
  private tail: Promise<void> = Promise.resolve();
  private currentRoute: RouteId | undefined;
  private closed = false;

  constructor(options: WindowsRemoteE2eeBridgeOptions) {
    this.options = options;
    this.barrier = new DaemonWitnessBarrier(options.endpoint, options.witness);
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

  async drain(): Promise<void> {
    while (true) {
      const current = this.tail;
      await current;
      if (current === this.tail) return;
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.attachment.close();
    await this.drain();
    this.options.endpoint.close();
    this.currentRoute = undefined;
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
      const logical = idBytes(envelope.logicalMessageId);
      const target = incomingOperation;
      const opened = releasedField<NativePlaintext>(
        await this.barrier.mutate((endpoint) =>
          endpoint.receiveApplication(
            target,
            envelope.ciphertext,
            logical,
            BigInt(envelope.hostedGrantGeneration),
          ),
        ),
        "plaintext",
        "plaintext",
      );
      if (!(opened.plaintext instanceof Uint8Array)) {
        throw new Error("Native endpoint released invalid plaintext");
      }
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
      accepted(
        await this.barrier.mutate((endpoint) =>
          endpoint.acknowledgeReceive(acknowledgement.bytes, target),
        ),
      );
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
    const logical = idBytes(envelope.logicalMessageId);
    try {
      accepted(
        await this.barrier.mutate((endpoint) => {
          if (endpoint.receiveReplacementProposal === undefined) {
            throw new Error("Native endpoint does not support MLS updates");
          }
          return endpoint.receiveReplacementProposal(
            incomingOperation,
            envelope.ciphertext,
            logical,
            BigInt(envelope.hostedGrantGeneration),
          );
        }),
      );
      const commitOperation = derivedId(
        "axl-e2ee-daemon-commit-operation-v1",
        envelope.operationId,
      );
      const commitLogical = {
        text: envelope.operationId,
        bytes: idBytes(envelope.operationId),
      };
      try {
        const commit = outbox(
          await this.barrier.mutate((endpoint) => {
            if (endpoint.createUpdateCommit === undefined) {
              throw new Error("Native endpoint does not support MLS updates");
            }
            return endpoint.createUpdateCommit(
              commitOperation.bytes,
              commitLogical.bytes,
              BigInt(envelope.hostedGrantGeneration),
            );
          }),
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
        accepted(
          await this.barrier.mutate((endpoint) =>
            endpoint.acknowledgeReceive(acknowledgement.bytes, incomingOperation),
          ),
        );
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
    const logical = idBytes(envelope.logicalMessageId);
    try {
      const acceptance = releasedField<NativeEpochReadyAcceptance>(
        await this.barrier.mutate((endpoint) => {
          if (endpoint.acceptEpochReady === undefined) {
            throw new Error("Native endpoint does not support epoch readiness");
          }
          return endpoint.acceptEpochReady(
            incomingOperation,
            logical,
            BigInt(envelope.hostedGrantGeneration),
            envelope.ciphertext,
          );
        }),
        "epoch_ready",
        "epochReady",
      );
      if (
        !(acceptance.cryptoSessionId instanceof Uint8Array) ||
        !(acceptance.commitId instanceof Uint8Array)
      ) {
        throw new Error("Native endpoint released an invalid epoch-ready acceptance");
      }
      const confirmationOperation = derivedId(
        "axl-e2ee-epoch-ready-confirmation-operation-v1",
        envelope.operationId,
      );
      const confirmationLogical = {
        text: envelope.operationId,
        bytes: idBytes(envelope.operationId),
      };
      try {
        const confirmation = outbox(
          await this.barrier.mutate((endpoint) => {
            if (endpoint.prepareEpochReadyConfirmation === undefined) {
              throw new Error("Native endpoint does not support epoch-ready confirmation");
            }
            return endpoint.prepareEpochReadyConfirmation(
              confirmationOperation.bytes,
              confirmationLogical.bytes,
              BigInt(envelope.hostedGrantGeneration),
              acceptance,
            );
          }),
        );
        const route = this.currentRoute;
        if (route === undefined) throw new Error("Remote route is unavailable");
        await this.sendPrepared(
          route,
          confirmation,
          envelope.hostedGrantGeneration,
          "resync_control",
        );
      } finally {
        confirmationOperation.bytes.fill(0);
        confirmationLogical.bytes.fill(0);
      }
      const commitAcknowledgement = derivedId(
        "axl-e2ee-commit-outbox-ack-v1",
        envelope.logicalMessageId,
      );
      const commitOperation = idBytes(envelope.logicalMessageId);
      try {
        outbox(
          await this.barrier.mutate((endpoint) =>
            endpoint.acknowledgeOutbox(commitAcknowledgement.bytes, commitOperation),
          ),
        );
      } finally {
        commitAcknowledgement.bytes.fill(0);
        commitOperation.fill(0);
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
    const hostedGeneration = authority.hostedGeneration;
    const requestIdentity = "requestId" in message ? message.requestId : randomUUID();
    const operation = derivedId(`axl-e2ee-daemon-${message.type}-operation-v1`, requestIdentity);
    const logical = derivedId(`axl-e2ee-daemon-${message.type}-logical-v1`, requestIdentity);
    const plaintext = encodeRemoteDaemonMessage(message);
    try {
      const prepared = outbox(
        await this.barrier.mutate((endpoint) =>
          endpoint.prepareApplication(
            operation.bytes,
            logical.bytes,
            BigInt(hostedGeneration),
            plaintext,
          ),
        ),
      );
      await this.sendPrepared(routeId, prepared, hostedGeneration, "application_delivery");
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
