// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

/** Every returned byte array is a fresh JavaScript-owned copy. */
export type OwnedBytes = Uint8Array;
export type AxlE2eeErrorCode =
  | "already_exists"
  | "artifact_integrity_failed"
  | "bound_exceeded"
  | "clock_rollback"
  | "conflict"
  | "consumed"
  | "corrupt_state"
  | "endpoint_closed"
  | "endpoint_revoked"
  | "expired"
  | "fresh_witness_required"
  | "identity_mismatch"
  | "internal_error"
  | "invalid_argument"
  | "key_record_missing"
  | "lifecycle_busy"
  | "not_found"
  | "profile_mismatch"
  | "recovery_required"
  | "rollback_anchor_unavailable"
  | "rollback_detected"
  | "secure_random_unavailable"
  | "state_loss"
  | "storage_unavailable"
  | "strict_durability_unavailable"
  | "unsupported_schema"
  | "witness_auth_failed"
  | "witness_conflict"
  | "witness_invalid_expected"
  | "witness_operation_conflict"
  | "witness_receipt_invalid"
  | "witness_registration_conflict"
  | "witness_unavailable";

export declare class AxlE2eeError extends Error {
  readonly code: AxlE2eeErrorCode;
  constructor(code: AxlE2eeErrorCode);
}

export interface BindingInfo {
  readonly abiVersion: 1;
  readonly profileId: "axl-e2ee-mls-pq-v1";
  readonly profileRevision: 1;
  readonly productionStorageReady: false;
  readonly workerRequired: true;
}

export interface PairingInspection {
  readonly kind: "pairing_invitation" | "pairing_claim";
  readonly profileId: "axl-e2ee-mls-pq-v1";
  readonly profileRevision: 1;
  readonly cryptoSessionId: OwnedBytes;
}

/**
 * The exact released result of one endpoint operation. Present fields depend on `tag`: `joined`
 * carries `epoch`; `envelope` carries `logicalMessageId`, `messageClass`, `epoch`,
 * `hostedGeneration`, and `bytes` (the ciphertext); `plaintext` carries `logicalMessageId`,
 * `messageClass`, `epoch`, and `bytes`; `commit_applied` carries `commitId`, `epoch`,
 * `epochAuthenticator`, and `removal`.
 */
export interface DeviceOperationResult {
  readonly status: "completed";
  readonly tag: string;
  readonly bytes?: OwnedBytes;
  readonly logicalMessageId?: OwnedBytes;
  readonly messageClass?: number;
  readonly epoch?: bigint;
  readonly hostedGeneration?: bigint;
  readonly commitId?: OwnedBytes;
  readonly epochAuthenticator?: OwnedBytes;
  readonly removal?: boolean;
}

export interface DeviceCommit {
  readonly commitId: Uint8Array;
  readonly targetEpoch: bigint;
  readonly epochAuthenticator: Uint8Array;
}

/**
 * The page's handle to the worker-private device endpoint. Every mutation completes through the
 * witness barrier inside the worker before it resolves; retrying the same operation ID returns the
 * same exact result.
 */
export interface DeviceEndpoint {
  pairingClaim(invitation: Uint8Array): Promise<OwnedBytes>;
  joinPublished(operationId: Uint8Array, welcome: Uint8Array): Promise<DeviceOperationResult>;
  preparePairActivation(
    operationId: Uint8Array,
    logicalMessageId: Uint8Array,
    claim: Uint8Array,
  ): Promise<DeviceOperationResult>;
  prepareApplication(
    operationId: Uint8Array,
    logicalMessageId: Uint8Array,
    hostedGeneration: bigint,
    plaintext: Uint8Array,
  ): Promise<DeviceOperationResult>;
  receiveApplication(
    operationId: Uint8Array,
    logicalMessageId: Uint8Array,
    hostedGeneration: bigint,
    ciphertext: Uint8Array,
  ): Promise<DeviceOperationResult>;
  prepareReplacement(
    operationId: Uint8Array,
    logicalMessageId: Uint8Array,
    hostedGeneration: bigint,
  ): Promise<DeviceOperationResult>;
  applyUpdateCommit(
    operationId: Uint8Array,
    logicalMessageId: Uint8Array,
    hostedGeneration: bigint,
    ciphertext: Uint8Array,
  ): Promise<DeviceOperationResult>;
  prepareEpochReady(
    operationId: Uint8Array,
    logicalMessageId: Uint8Array,
    hostedGeneration: bigint,
    commit: DeviceCommit,
  ): Promise<DeviceOperationResult>;
  acceptEpochReadyConfirmation(
    operationId: Uint8Array,
    logicalMessageId: Uint8Array,
    hostedGeneration: bigint,
    ciphertext: Uint8Array,
  ): Promise<DeviceOperationResult>;
  applyRemoval(
    operationId: Uint8Array,
    logicalMessageId: Uint8Array,
    hostedGeneration: bigint,
    ciphertext: Uint8Array,
  ): Promise<DeviceOperationResult>;
  close(): Promise<void>;
}

export interface DeviceEndpointIdentity {
  readonly accountId: Uint8Array;
  readonly installationId: Uint8Array;
  readonly deviceId: Uint8Array;
  readonly cryptoSessionId: Uint8Array;
  readonly operationId: Uint8Array;
}

export declare const ERROR_CODES: readonly AxlE2eeErrorCode[];
export declare function getBindingInfo(): Promise<BindingInfo>;
export declare function inspectPairingInvitation(bytes: Uint8Array): Promise<PairingInspection>;
export declare function inspectPairingClaim(bytes: Uint8Array): Promise<PairingInspection>;
export declare function createDaemonEndpoint(): Promise<never>;
export declare function openDaemonEndpoint(): Promise<never>;
/** The account credential the same-origin witness gateway authenticates; it stays in the worker. */
export declare function authorizeWitness(authorization: string): Promise<null>;
/** Fails with `rollback_anchor_unavailable` in a build that carries no replica trust. */
export declare function createDeviceEndpoint(
  identity: DeviceEndpointIdentity,
): Promise<DeviceEndpoint>;
export declare function openDeviceEndpoint(session: {
  readonly cryptoSessionId: Uint8Array;
}): Promise<DeviceEndpoint>;
/** Permanently closes this module instance. Repeated close calls are harmless. */
export declare function closeBrowserBinding(): void;
