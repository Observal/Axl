// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM049
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
import {
  releasedField,
  type WitnessEndpointOperations,
  type WitnessMutationOutcome,
  type WitnessTypedResult,
  type WitnessedEndpoint,
} from "./witness.ts";

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

/** Released `commit` result of an applied received commit. */
export interface NativeCommitMetadata {
  readonly commitId: Uint8Array;
  readonly targetEpoch: bigint;
  readonly epochAuthenticator: Uint8Array;
}

/**
 * Narrow structural subset implemented by the native device binding. A browser page-facing
 * endpoint must present the same outcome shape once it is enabled. Every mutation returns a
 * witness outcome; the adapter reads results only after the barrier completes.
 */
export interface NativeDeviceE2eeEndpoint extends WitnessEndpointOperations {
  prepareApplication(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    plaintext: Uint8Array,
  ): Promise<WitnessMutationOutcome>;
  receiveApplication(
    operationId: Uint8Array,
    ciphertext: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<WitnessMutationOutcome>;
  prepareReplacement?(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<WitnessMutationOutcome>;
  applyReceivedUpdateCommit?(
    operationId: Uint8Array,
    ciphertext: Uint8Array,
    commitLogicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<WitnessMutationOutcome>;
  prepareEpochReady?(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    commit: NativeCommitMetadata,
  ): Promise<WitnessMutationOutcome>;
  acceptEpochReadyConfirmation?(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    ciphertext: Uint8Array,
  ): Promise<WitnessMutationOutcome>;
  acknowledgeOutbox(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<WitnessMutationOutcome>;
  acknowledgeReceive(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<WitnessMutationOutcome>;
}

export interface RemoteDeviceE2eeOptions {
  /** The device endpoint behind its witness barrier, shared with the native outbox projection. */
  readonly endpoint: WitnessedEndpoint<NativeDeviceE2eeEndpoint>;
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

function outbox(result: WitnessTypedResult): NativeCiphertext {
  const value = releasedField<NativeCiphertext>(result, "outbox", "outbox");
  if (
    !(value.operationId instanceof Uint8Array) ||
    !(value.logicalMessageId instanceof Uint8Array) ||
    typeof value.messageClass !== "string" ||
    !(value.ciphertext instanceof Uint8Array)
  ) {
    throw new TypeError("Native endpoint released an invalid outbox record");
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
      const prepared = outbox(
        await this.options.endpoint.mutate((endpoint) =>
          endpoint.prepareApplication(operation, logicalId, BigInt(grant), plaintext),
        ),
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
      const prepared = outbox(
        await this.options.endpoint.mutate((endpoint) =>
          endpoint.prepareApplication(operation, logicalId, BigInt(grant), plaintext),
        ),
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
    const grant = generation(hostedGrantGeneration);
    const operation = uuidBytes(operationId);
    const logical = uuidBytes(logicalMessageId);
    try {
      const prepared = outbox(
        await this.options.endpoint.mutate((endpoint) => {
          if (endpoint.prepareReplacement === undefined) {
            throw new TypeError("Native endpoint does not support MLS updates");
          }
          return endpoint.prepareReplacement(operation, logical, BigInt(grant));
        }),
      );
      return framed(prepared, operation, logical, grant, "update_proposal");
    } finally {
      operation.fill(0);
      logical.fill(0);
    }
  }

  /**
   * Apply a daemon commit and create its epoch-ready message as two witnessed operations. The
   * epoch-ready operation ID is derived from the apply operation ID so a retried delivery replays
   * both exact results instead of creating a second transition.
   */
  async applyUpdateCommit(
    opaqueEnvelope: Uint8Array,
    operationId: OperationId,
    epochReadyLogicalMessageId: OperationId,
  ): Promise<Uint8Array> {
    const envelope = parseRemoteE2eeEnvelope(opaqueEnvelope);
    if (envelope.messageClass !== "commit") {
      throw new TypeError("Remote E2EE envelope is not an MLS commit");
    }
    const operation = uuidBytes(operationId);
    const readyOperation = derivedId(operationId, 0x4a);
    const commitLogical = uuidBytes(envelope.logicalMessageId);
    const readyLogical = uuidBytes(epochReadyLogicalMessageId);
    const grant = BigInt(envelope.hostedGrantGeneration);
    try {
      const commit = releasedField<NativeCommitMetadata>(
        await this.options.endpoint.mutate((endpoint) => {
          if (endpoint.applyReceivedUpdateCommit === undefined) {
            throw new TypeError("Native endpoint does not support MLS updates");
          }
          return endpoint.applyReceivedUpdateCommit(
            operation,
            envelope.ciphertext,
            commitLogical,
            grant,
          );
        }),
        "commit",
        "commit",
      );
      if (
        !(commit.commitId instanceof Uint8Array) ||
        typeof commit.targetEpoch !== "bigint" ||
        !(commit.epochAuthenticator instanceof Uint8Array)
      ) {
        throw new TypeError("Native endpoint released invalid commit metadata");
      }
      const prepared = outbox(
        await this.options.endpoint.mutate((endpoint) => {
          if (endpoint.prepareEpochReady === undefined) {
            throw new TypeError("Native endpoint does not support MLS updates");
          }
          return endpoint.prepareEpochReady(readyOperation, readyLogical, grant, commit);
        }),
      );
      return framed(
        prepared,
        readyOperation,
        readyLogical,
        envelope.hostedGrantGeneration,
        "epoch_ready",
      );
    } finally {
      operation.fill(0);
      readyOperation.fill(0);
      commitLogical.fill(0);
      readyLogical.fill(0);
    }
  }

  async open(opaqueEnvelope: Uint8Array): Promise<AuthenticatedRemotePayload> {
    const envelope: RemoteE2eeEnvelope = parseRemoteE2eeEnvelope(opaqueEnvelope);
    if (envelope.messageClass === "resync_control") {
      const operation = derivedId(envelope.operationId, 0x47);
      const logical = uuidBytes(envelope.logicalMessageId);
      const acknowledgement = derivedId(envelope.logicalMessageId, 0x48);
      try {
        const lifecycle = releasedField<string>(
          await this.options.endpoint.mutate((endpoint) => {
            if (endpoint.acceptEpochReadyConfirmation === undefined) {
              throw new TypeError("Native endpoint does not support epoch-ready confirmation");
            }
            return endpoint.acceptEpochReadyConfirmation(
              operation,
              logical,
              BigInt(envelope.hostedGrantGeneration),
              envelope.ciphertext,
            );
          }),
          "pair_state",
          "status",
        );
        if (lifecycle !== "active") {
          throw new TypeError("Epoch-ready confirmation did not activate the pair");
        }
        outbox(
          await this.options.endpoint.mutate((endpoint) =>
            endpoint.acknowledgeOutbox(acknowledgement, logical),
          ),
        );
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
        outbox(
          await this.options.endpoint.mutate((endpoint) =>
            endpoint.acknowledgeOutbox(proposalAcknowledgement, proposalOperation),
          ),
        );
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
      const opened = releasedField<NativePlaintext>(
        await this.options.endpoint.mutate((endpoint) =>
          endpoint.receiveApplication(
            operation,
            envelope.ciphertext,
            logical,
            BigInt(envelope.hostedGrantGeneration),
          ),
        ),
        "plaintext",
        "plaintext",
      );
      if (!(opened.plaintext instanceof Uint8Array)) {
        throw new TypeError("Native endpoint released invalid plaintext");
      }
      let acknowledged = false;
      return {
        authenticatedPeerId: this.options.daemonDeviceId,
        plaintext: opened.plaintext,
        acknowledge: async () => {
          if (acknowledged) return;
          const acknowledgement = derivedId(envelope.operationId, 0x43);
          try {
            releasedField(
              await this.options.endpoint.mutate((endpoint) =>
                endpoint.acknowledgeReceive(acknowledgement, operation),
              ),
              "accepted",
              "accepted",
            );
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
