// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import {
  type CryptoSessionId,
  type DeviceId,
  decodeRemoteDaemonMessage,
  encodeRemoteE2eeEnvelope,
  type IdempotencyKey,
  type OpaqueOutboxRecord,
  type OperationId,
  parseAuthenticatedRemoteRequest,
  parseOperationId,
  parseRemoteE2eeEnvelope,
  type RemoteDaemonMessage,
  type RemoteE2eeEnvelope,
  type RequestId,
} from "@axl/protocol";

import type { AuthenticatedRemotePayload, RemotePayloadOpener } from "./remote-relay.ts";

interface NativeCiphertext {
  readonly operationId: Uint8Array;
  readonly logicalMessageId: Uint8Array;
  readonly messageClass: string;
  readonly ciphertext: Uint8Array;
}

interface NativePlaintext {
  readonly plaintext: Uint8Array;
}

/** Narrow structural subset implemented by the browser and native device bindings. */
export interface NativeDeviceE2eeEndpoint {
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
  prepareReplacement?(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<NativeCiphertext>;
  applyReceivedUpdateCommit?(
    operationId: Uint8Array,
    ciphertext: Uint8Array,
    commitLogicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    epochReadyLogicalId: Uint8Array,
  ): Promise<NativeCiphertext>;
  acceptEpochReadyConfirmation?(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    ciphertext: Uint8Array,
  ): Promise<"active">;
  acknowledgeOutbox(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<NativeCiphertext>;
  acknowledgeReceive(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<"acknowledged">;
}

export interface RemoteDeviceE2eeOptions {
  readonly endpoint: NativeDeviceE2eeEndpoint;
  readonly localDeviceId: DeviceId;
  readonly daemonDeviceId: DeviceId;
  readonly destinationCryptoSessionId: CryptoSessionId;
  readonly now?: () => number;
}

function uuidBytes(value: string): Uint8Array {
  const encoded = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/u.test(encoded)) throw new TypeError("Invalid operation identity");
  return Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16),
  );
}

function uuidText(value: Uint8Array): OperationId {
  if (value.byteLength !== 16) throw new TypeError("Native endpoint returned an invalid identity");
  const encoded = [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return parseOperationId(
    `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20)}`,
  );
}

function derivedId(value: string, domain: number): Uint8Array {
  const output = uuidBytes(value);
  output[0] = (output[0] ?? 0) ^ domain;
  return output;
}

function requestBytes(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength === 0 || bytes.byteLength > 60_000) {
    throw new TypeError("Remote request exceeds the E2EE plaintext bound");
  }
  return bytes;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function generation(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Hosted grant generation must be a positive safe integer");
  }
  return value;
}

function framed(
  prepared: NativeCiphertext,
  operationId: Uint8Array,
  logicalMessageId: Uint8Array,
  hostedGrantGeneration: number,
  expectedClass: RemoteE2eeEnvelope["messageClass"] = "application_request",
): Uint8Array {
  if (
    prepared.messageClass !== expectedClass ||
    !sameBytes(prepared.operationId, operationId) ||
    !sameBytes(prepared.logicalMessageId, logicalMessageId)
  ) {
    throw new TypeError("Native endpoint returned mismatched envelope metadata");
  }
  return encodeRemoteE2eeEnvelope({
    operationId: uuidText(operationId),
    logicalMessageId: uuidText(logicalMessageId),
    messageClass: expectedClass,
    hostedGrantGeneration,
    ciphertext: prepared.ciphertext,
  });
}

/** Device-side E2EE adapter used before handing immutable bytes to relay delivery. */
export class RemoteDeviceE2ee implements RemotePayloadOpener {
  private readonly options: RemoteDeviceE2eeOptions;
  private readonly now: () => number;

  constructor(options: RemoteDeviceE2eeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async prepareDurable(
    request: {
      readonly deviceId: DeviceId;
      readonly requestId: RequestId;
      readonly idempotencyKey: IdempotencyKey;
      readonly method: string;
      readonly params: unknown;
    },
    hostedGrantGeneration: number,
  ): Promise<OpaqueOutboxRecord> {
    const validated = parseAuthenticatedRemoteRequest(request);
    if (
      validated.deviceId !== this.options.localDeviceId ||
      validated.idempotencyKey === undefined
    ) {
      throw new TypeError("Remote request does not match the E2EE endpoint");
    }
    const grant = generation(hostedGrantGeneration);
    const logicalId = derivedId(validated.requestId, 0x41);
    const plaintext = requestBytes(validated);
    const operation = uuidBytes(validated.idempotencyKey);
    try {
      const prepared = await this.options.endpoint.prepareApplication(
        operation,
        logicalId,
        BigInt(grant),
        plaintext,
      );
      return {
        requestId: validated.requestId,
        idempotencyKey: validated.idempotencyKey,
        destinationCryptoSessionId: this.options.destinationCryptoSessionId,
        opaqueEnvelope: framed(prepared, operation, logicalId, grant),
        createdAt: this.now(),
        state: "queued_local",
      };
    } finally {
      plaintext.fill(0);
      logicalId.fill(0);
      operation.fill(0);
    }
  }

  async prepareEphemeral(
    request: {
      readonly deviceId: DeviceId;
      readonly requestId: RequestId;
      readonly method: string;
      readonly params: unknown;
    },
    hostedGrantGeneration: number,
  ): Promise<Uint8Array> {
    const validated = parseAuthenticatedRemoteRequest(request);
    if (
      validated.deviceId !== this.options.localDeviceId ||
      validated.idempotencyKey !== undefined
    ) {
      throw new TypeError("Remote request does not match the E2EE endpoint");
    }
    const grant = generation(hostedGrantGeneration);
    const operation = uuidBytes(validated.requestId);
    const logicalId = derivedId(validated.requestId, 0x42);
    const plaintext = requestBytes(validated);
    try {
      const prepared = await this.options.endpoint.prepareApplication(
        operation,
        logicalId,
        BigInt(grant),
        plaintext,
      );
      return framed(prepared, operation, logicalId, grant);
    } finally {
      plaintext.fill(0);
      operation.fill(0);
      logicalId.fill(0);
    }
  }

  async prepareUpdateProposal(
    operationId: OperationId,
    logicalMessageId: OperationId,
    hostedGrantGeneration: number,
  ): Promise<Uint8Array> {
    const prepare = this.options.endpoint.prepareReplacement;
    if (prepare === undefined) throw new TypeError("Native endpoint does not support MLS updates");
    const grant = generation(hostedGrantGeneration);
    const operation = uuidBytes(operationId);
    const logical = uuidBytes(logicalMessageId);
    try {
      const prepared = await prepare.call(this.options.endpoint, operation, logical, BigInt(grant));
      return framed(prepared, operation, logical, grant, "update_proposal");
    } finally {
      operation.fill(0);
      logical.fill(0);
    }
  }

  async applyUpdateCommit(
    opaqueEnvelope: Uint8Array,
    operationId: OperationId,
    epochReadyLogicalMessageId: OperationId,
  ): Promise<Uint8Array> {
    const apply = this.options.endpoint.applyReceivedUpdateCommit;
    if (apply === undefined) throw new TypeError("Native endpoint does not support MLS updates");
    const envelope = parseRemoteE2eeEnvelope(opaqueEnvelope);
    if (envelope.messageClass !== "commit") {
      throw new TypeError("Remote E2EE envelope is not an MLS commit");
    }
    const operation = uuidBytes(operationId);
    const commitLogical = uuidBytes(envelope.logicalMessageId);
    const readyLogical = uuidBytes(epochReadyLogicalMessageId);
    try {
      const prepared = await apply.call(
        this.options.endpoint,
        operation,
        envelope.ciphertext,
        commitLogical,
        BigInt(envelope.hostedGrantGeneration),
        readyLogical,
      );
      return framed(
        prepared,
        operation,
        readyLogical,
        envelope.hostedGrantGeneration,
        "epoch_ready",
      );
    } finally {
      operation.fill(0);
      commitLogical.fill(0);
      readyLogical.fill(0);
    }
  }

  async open(opaqueEnvelope: Uint8Array): Promise<AuthenticatedRemotePayload> {
    const envelope: RemoteE2eeEnvelope = parseRemoteE2eeEnvelope(opaqueEnvelope);
    if (envelope.messageClass === "resync_control") {
      const accept = this.options.endpoint.acceptEpochReadyConfirmation;
      if (accept === undefined) {
        throw new TypeError("Native endpoint does not support epoch-ready confirmation");
      }
      const operation = derivedId(envelope.operationId, 0x47);
      const logical = uuidBytes(envelope.logicalMessageId);
      const acknowledgement = derivedId(envelope.logicalMessageId, 0x48);
      try {
        await accept.call(
          this.options.endpoint,
          operation,
          logical,
          BigInt(envelope.hostedGrantGeneration),
          envelope.ciphertext,
        );
        await this.options.endpoint.acknowledgeOutbox(acknowledgement, logical);
        return {
          authenticatedPeerId: this.options.daemonDeviceId,
          plaintext: new Uint8Array(),
          controlOnly: true,
        };
      } finally {
        operation.fill(0);
        logical.fill(0);
        acknowledgement.fill(0);
      }
    }
    if (envelope.messageClass === "commit") {
      const operation = derivedId(envelope.operationId, 0x45);
      const readyLogical = uuidBytes(envelope.operationId);
      const proposalOperation = uuidBytes(envelope.logicalMessageId);
      const proposalAcknowledgement = derivedId(envelope.logicalMessageId, 0x46);
      try {
        await this.applyUpdateCommit(opaqueEnvelope, uuidText(operation), uuidText(readyLogical));
        await this.options.endpoint.acknowledgeOutbox(proposalAcknowledgement, proposalOperation);
        return {
          authenticatedPeerId: this.options.daemonDeviceId,
          plaintext: new Uint8Array(),
          controlOnly: true,
        };
      } finally {
        operation.fill(0);
        readyLogical.fill(0);
        proposalOperation.fill(0);
        proposalAcknowledgement.fill(0);
      }
    }
    if (envelope.messageClass !== "application_delivery") {
      throw new TypeError("Remote E2EE envelope is not an application delivery");
    }
    const operation = uuidBytes(envelope.operationId);
    const logical = uuidBytes(envelope.logicalMessageId);
    try {
      const opened = await this.options.endpoint.receiveApplication(
        operation,
        envelope.ciphertext,
        logical,
        BigInt(envelope.hostedGrantGeneration),
      );
      let acknowledged = false;
      return {
        authenticatedPeerId: this.options.daemonDeviceId,
        plaintext: opened.plaintext,
        acknowledge: async () => {
          if (acknowledged) return;
          const acknowledgement = derivedId(envelope.operationId, 0x43);
          try {
            await this.options.endpoint.acknowledgeReceive(acknowledgement, operation);
            acknowledged = true;
          } finally {
            acknowledgement.fill(0);
            operation.fill(0);
            logical.fill(0);
          }
        },
      };
    } catch (cause) {
      operation.fill(0);
      logical.fill(0);
      throw cause;
    }
  }

  decode(plaintext: Uint8Array): RemoteDaemonMessage {
    return decodeRemoteDaemonMessage(plaintext);
  }
}
