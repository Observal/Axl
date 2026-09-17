// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

/** Every returned byte array is a fresh Node-owned copy. */
export type OwnedBytes = Uint8Array;
export type AxlE2eeErrorCode =
  | "already_acknowledged"
  | "already_exists"
  | "artifact_integrity_failed"
  | "bound_exceeded"
  | "clock_rollback"
  | "conflict"
  | "consumed"
  | "corrupt_state"
  | "endpoint_closed"
  | "expired"
  | "future_epoch"
  | "identity_mismatch"
  | "internal_error"
  | "invalid_argument"
  | "invalid_ciphertext"
  | "invalid_id"
  | "invalid_lifecycle"
  | "invalid_u64"
  | "key_record_missing"
  | "lifecycle_busy"
  | "missing_commit"
  | "not_found"
  | "profile_mismatch"
  | "re_pair_required"
  | "replay_rejected"
  | "retention_exceeded"
  | "rollback_anchor_unavailable"
  | "rollback_detected"
  | "secure_store_access_denied"
  | "secure_store_ambiguous"
  | "secure_store_locked"
  | "secure_store_unavailable"
  | "stale_epoch"
  | "state_loss"
  | "storage_unavailable"
  | "unsupported_platform"
  | "witness_auth_failed"
  | "witness_conflict"
  | "witness_invalid_expected"
  | "witness_operation_conflict"
  | "witness_receipt_invalid"
  | "witness_registration_conflict"
  | "witness_unavailable";

export declare class AxlE2eeError extends Error {
  readonly code: AxlE2eeErrorCode;
  constructor(code: AxlE2eeErrorCode, detail?: string);
}

export interface BindingInfo {
  readonly abiVersion: 1;
  readonly profileId: "axl-e2ee-mls-pq-v1";
  readonly profileRevision: 1;
  readonly nodeApi: 9;
  readonly productionStorageReady: false;
}
export interface PairingInspection {
  readonly kind: "pairing_invitation" | "pairing_claim";
  readonly profileId: "axl-e2ee-mls-pq-v1";
  readonly profileRevision: 1;
  readonly cryptoSessionId: OwnedBytes;
}
export type InvitationState =
  | "issued"
  | "claimpending"
  | "confirmed"
  | "consumed"
  | "cancelled"
  | "expired";
export type PreJoinState =
  | "pre_join"
  | "expired"
  | "cancelled"
  | "joined"
  | "activated"
  | "removed"
  | "reset";
export type PairState =
  | "awaiting_activation"
  | "active"
  | "replacement_proposed"
  | "waiting_for_epoch_ready"
  | "removed"
  | "revoked"
  | "reset";

export type Publication =
  | {
      readonly tag: "issued";
      readonly bytes: OwnedBytes;
      readonly hash: OwnedBytes;
      readonly expiresAtMs: bigint;
    }
  | {
      readonly tag: "prepared";
      readonly bytes: OwnedBytes;
      readonly secondaryBytes: OwnedBytes;
      readonly hash: OwnedBytes;
      readonly expiresAtMs: bigint;
    }
  | { readonly tag: "pending"; readonly hash: OwnedBytes; readonly comparison: string }
  | {
      readonly tag: "confirmed" | "reserved";
      readonly hash: OwnedBytes;
      readonly expiresAtMs: bigint;
    }
  | {
      readonly tag: "accepted";
      readonly bytes: OwnedBytes;
      readonly hash: OwnedBytes;
      readonly groupId: OwnedBytes;
      readonly expiresAtMs: bigint;
    }
  | {
      readonly tag:
        | "busy"
        | "cancelled"
        | "conflict"
        | "consumed"
        | "expired"
        | "rejected"
        | "rejected_credential"
        | "rejected_keypackage"
        | "rejected_signature"
        | "unavailable";
    };
export interface NativePendingWitness {
  readonly operationId: OwnedBytes;
  readonly witnessRequest: OwnedBytes;
  readonly requestHash: OwnedBytes;
  readonly status: "pending_quorum" | "committed";
  continueWitness(operationId: Uint8Array, certificate: Uint8Array): Promise<OwnedBytes>;
  close(): void;
}
export interface NativeOutbox {
  readonly operationId: OwnedBytes;
  readonly cryptoSessionId: OwnedBytes;
  readonly logicalMessageId: OwnedBytes;
  readonly messageClass:
    | "application_request"
    | "application_delivery"
    | "update_proposal"
    | "commit"
    | "epoch_ready"
    | "pair_activation"
    | "resync_control";
  readonly epoch: bigint;
  readonly hostedGrantGeneration: bigint;
  readonly profileRevision: 1;
  readonly retryState: "pending" | "acknowledged";
  readonly ciphertext: OwnedBytes;
  readonly commitId?: OwnedBytes;
  readonly targetEpoch?: bigint;
  readonly epochAuthenticator?: OwnedBytes;
}
export interface NativePlaintext {
  readonly operationId: OwnedBytes;
  readonly logicalMessageId: OwnedBytes;
  readonly epoch: bigint;
  readonly plaintext: OwnedBytes;
}
export interface NativeWelcome {
  readonly bytes: OwnedBytes;
  readonly groupId: OwnedBytes;
  readonly claimHash: OwnedBytes;
  readonly expiresAtMs: bigint;
}
export interface NativeActivationAcceptance {
  readonly cryptoSessionId: OwnedBytes;
  readonly groupId: OwnedBytes;
  readonly claimHash: OwnedBytes;
  readonly activationHash: OwnedBytes;
}
export interface NativeEpochReadyAcceptance {
  readonly cryptoSessionId: OwnedBytes;
  readonly commitId: OwnedBytes;
}
export interface NativeRePairRequirement {
  readonly deviceId: OwnedBytes;
  readonly cryptoSessionId: OwnedBytes;
  readonly groupId?: OwnedBytes;
  readonly keyPackageHash: OwnedBytes;
}
export interface StatusOutcome {
  readonly tag: "removed" | "revoked" | "commit" | "re_pair_required";
  readonly deviceId?: OwnedBytes;
  readonly cryptoSessionId?: OwnedBytes;
  readonly groupId?: OwnedBytes;
  readonly keyPackageHash?: OwnedBytes;
}

export interface DaemonEndpoint {
  issue(operationId: Uint8Array): Promise<Publication>;
  reopen(): Promise<"opened">;
  invitation(): Promise<Publication>;
  status(): Promise<InvitationState>;
  cancel(operationId: Uint8Array): Promise<InvitationState>;
  submitClaim(operationId: Uint8Array, claim: Uint8Array): Promise<Publication>;
  confirmClaim(
    operationId: Uint8Array,
    claimHash: Uint8Array,
    reservationId: Uint8Array,
  ): Promise<Publication>;
  releaseReservation(operationId: Uint8Array, reservationId: Uint8Array): Promise<string>;
  createWelcome(operationId: Uint8Array, reservationId: Uint8Array): Promise<NativeWelcome>;
  recoverWelcome(claimHash: Uint8Array): Promise<NativeWelcome>;
  acceptActivation(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<NativeActivationAcceptance>;
  prepareApplication(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    plaintext: Uint8Array,
  ): Promise<NativeOutbox>;
  receiveApplication(
    operationId: Uint8Array,
    ciphertext: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<NativePlaintext>;
  receiveReplacementProposal(
    operationId: Uint8Array,
    ciphertext: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<"accepted">;
  createUpdateCommit(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<NativeOutbox>;
  acceptEpochReady(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<NativeEpochReadyAcceptance>;
  removeDevice(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<NativeOutbox>;
  revokeDevice(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<NativeOutbox>;
  reset(operationId: Uint8Array): Promise<StatusOutcome>;
  markRevoked(operationId: Uint8Array): Promise<StatusOutcome>;
  pendingOutbox(): Promise<readonly NativeOutbox[]>;
  acknowledgeOutbox(operationId: Uint8Array, targetOperationId: Uint8Array): Promise<NativeOutbox>;
  acknowledgeReceive(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<"acknowledged">;
  pairStatus(): Promise<PairState | undefined>;
  close(): void;
}
export interface DeviceEndpoint {
  prepare(invitation: Uint8Array, operationId: Uint8Array): Promise<Publication>;
  reopen(): Promise<"opened">;
  status(): Promise<PreJoinState>;
  publication(): Promise<Publication>;
  join(operationId: Uint8Array, welcome: NativeWelcome): Promise<PreJoinState>;
  prepareActivation(operationId: Uint8Array, logicalId: Uint8Array): Promise<NativeOutbox>;
  acknowledgeActivation(
    operationId: Uint8Array,
    acceptance: NativeActivationAcceptance,
  ): Promise<PairState>;
  prepareApplication(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    plaintext: Uint8Array,
  ): Promise<NativeOutbox>;
  receiveApplication(
    operationId: Uint8Array,
    ciphertext: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<NativePlaintext>;
  prepareReplacement(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<NativeOutbox>;
  applyUpdateCommit(
    operationId: Uint8Array,
    commit: NativeOutbox,
    commitLogicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    epochReadyLogicalId: Uint8Array,
  ): Promise<NativeOutbox>;
  acknowledgeEpochReady(
    operationId: Uint8Array,
    acceptance: NativeEpochReadyAcceptance,
  ): Promise<PairState>;
  applyRemoval(
    operationId: Uint8Array,
    commit: NativeOutbox,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<"removed">;
  reset(operationId: Uint8Array): Promise<NativeRePairRequirement>;
  pendingOutbox(): Promise<readonly NativeOutbox[]>;
  acknowledgeOutbox(operationId: Uint8Array, targetOperationId: Uint8Array): Promise<NativeOutbox>;
  acknowledgeReceive(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<"acknowledged">;
  pairStatus(): Promise<PairState | undefined>;
  close(): void;
}

export declare const ERROR_CODES: readonly AxlE2eeErrorCode[];
export declare function getBindingInfo(): Readonly<BindingInfo>;
export declare function inspectPairingInvitation(bytes: Uint8Array): Promise<PairingInspection>;
export declare function inspectPairingClaim(bytes: Uint8Array): Promise<PairingInspection>;
/** Always rejects until a production EnvelopeKeyStore is separately approved. */
export declare function createDaemonEndpoint(): Promise<DaemonEndpoint>;
/** Always rejects until production secure storage and rollback anchors are separately approved. */
export declare function openDaemonEndpoint(): Promise<DaemonEndpoint>;
/** Always rejects until a production EnvelopeKeyStore is separately approved. */
export declare function createDeviceEndpoint(): Promise<DeviceEndpoint>;
/** Always rejects until production secure storage and rollback anchors are separately approved. */
export declare function openDeviceEndpoint(): Promise<DeviceEndpoint>;
