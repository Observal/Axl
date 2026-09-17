// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import {
  decodeRemoteDaemonMessage,
  encodeRemoteE2eeEnvelope,
  parseOperationId,
  parseRemoteE2eeEnvelope,
  type CryptoSessionId,
  type DeviceId,
  type IdempotencyKey,
  type OpaqueOutboxRecord,
  type OperationId,
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

function framed(prepared: NativeCiphertext, hostedGrantGeneration: number): Uint8Array {
  if (prepared.messageClass !== "application_request") {
    throw new TypeError("Native endpoint returned the wrong message class");
  }
  return encodeRemoteE2eeEnvelope({
    operationId: uuidText(prepared.operationId),
    logicalMessageId: uuidText(prepared.logicalMessageId),
    messageClass: "application_request",
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
    if (request.deviceId !== this.options.localDeviceId) {
      throw new TypeError("Remote request device does not match the E2EE endpoint");
    }
    const logicalId = derivedId(request.requestId, 0x41);
    const plaintext = requestBytes(request);
    const operation = uuidBytes(request.idempotencyKey);
    try {
      const prepared = await this.options.endpoint.prepareApplication(
        operation,
        logicalId,
        BigInt(hostedGrantGeneration),
        plaintext,
      );
      return {
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        destinationCryptoSessionId: this.options.destinationCryptoSessionId,
        opaqueEnvelope: framed(prepared, hostedGrantGeneration),
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
    if (request.deviceId !== this.options.localDeviceId) {
      throw new TypeError("Remote request device does not match the E2EE endpoint");
    }
    const operation = uuidBytes(request.requestId);
    const logicalId = derivedId(request.requestId, 0x42);
    const plaintext = requestBytes(request);
    try {
      const prepared = await this.options.endpoint.prepareApplication(
        operation,
        logicalId,
        BigInt(hostedGrantGeneration),
        plaintext,
      );
      return framed(prepared, hostedGrantGeneration);
    } finally {
      plaintext.fill(0);
      operation.fill(0);
      logicalId.fill(0);
    }
  }

  async open(opaqueEnvelope: Uint8Array): Promise<AuthenticatedRemotePayload> {
    const envelope: RemoteE2eeEnvelope = parseRemoteE2eeEnvelope(opaqueEnvelope);
    if (envelope.messageClass !== "application_delivery") {
      throw new TypeError("Remote E2EE envelope is not an application delivery");
    }
    const operation = uuidBytes(envelope.operationId);
    const logical = uuidBytes(envelope.logicalMessageId);
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
  }

  decode(plaintext: Uint8Array): RemoteDaemonMessage {
    return decodeRemoteDaemonMessage(plaintext);
  }
}
