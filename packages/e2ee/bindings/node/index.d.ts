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
  | "endpoint_revoked"
  | "expired"
  | "fresh_witness_required"
  | "future_epoch"
  | "identity_mismatch"
  | "initialization_incomplete"
  | "internal_error"
  | "invalid_argument"
  | "invalid_ciphertext"
  | "invalid_hash"
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
  constructor(code: AxlE2eeErrorCode, detail?: string);
}

export interface BindingInfo {
  readonly abiVersion: 2;
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
export type RemovalState = "removed" | "revoked";
export type NoChangeState = "busy" | "expired" | "consumed" | "rejected" | "unavailable";

/** The complete exact reservation intent released by a confirmed claim or a reservation. */
export interface ReservationIntent {
  readonly reservationId: OwnedBytes;
  readonly cryptoSessionId: OwnedBytes;
  readonly accountId: OwnedBytes;
  readonly installationId: OwnedBytes;
  readonly deviceId: OwnedBytes;
  readonly claimHash: OwnedBytes;
  readonly keyPackageHash: OwnedBytes;
  readonly expiresAtMs: bigint;
}
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
  | {
      readonly tag: "pending";
      readonly hash: OwnedBytes;
      readonly comparison: string;
    }
  | {
      readonly tag: "confirmed" | "reserved";
      readonly reservation: ReservationIntent;
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

/**
 * The one durable pending witness request of an endpoint. Transport `request` unchanged to all
 * three replicas and pass the unanimous certificate to `continueWitness` on the same endpoint.
 * It never carries ciphertext, plaintext, pairing artifacts, or typed state.
 */
export interface PendingWitness {
  readonly operationId: OwnedBytes;
  readonly request: OwnedBytes;
  readonly requestHash: OwnedBytes;
  readonly kind: "register" | "advance";
}
export type WitnessQuarantineReason =
  | "stale_local_state"
  | "pending_without_local_state"
  | "witness_lineage_missing"
  | "commitment_conflict"
  | "local_ahead_more_than_one"
  | "witness_behind_more_than_one"
  | "witness_inconsistent"
  | "immediate_fork"
  | "historical_fork";
export type WitnessReconciliation =
  | {
      readonly tag:
        | "ready"
        | "resend_pending"
        | "recover_accepted"
        | "witness_unavailable"
        | "revoked";
    }
  | { readonly tag: "quarantined"; readonly reason: WitnessQuarantineReason };

export type NativeResultTag =
  | "empty"
  | "outbox"
  | "plaintext"
  | "accepted"
  | "commit"
  | "invitation"
  | "pre_join"
  | "welcome"
  | "claim"
  | "reservation"
  | "activation"
  | "epoch_ready"
  | "invitation_state"
  | "pre_join_state"
  | "pair_state"
  | "removal"
  | "re_pair"
  | "status";
/**
 * Exact typed result released by a completed witness barrier. Exactly one typed accessor is
 * populated for a tag; `status` carries the discriminant of lifecycle, claim, reservation,
 * removal, and no-change results.
 */
export interface NativeResult {
  readonly tag: NativeResultTag;
  readonly status?:
    | InvitationState
    | PreJoinState
    | PairState
    | RemovalState
    | NoChangeState
    | string;
  readonly outbox?: NativeOutbox;
  readonly plaintext?: NativePlaintext;
  readonly accepted?: NativeAccepted;
  readonly commit?: NativeCommit;
  readonly publication?: Publication;
  readonly welcome?: NativeWelcome;
  readonly activation?: NativeActivationAcceptance;
  readonly epochReady?: NativeEpochReadyAcceptance;
  readonly rePair?: NativeRePairRequirement;
}
/** Result of every state-changing endpoint call. */
export interface WitnessOutcome {
  readonly tag: "pending" | "released";
  readonly pending?: PendingWitness;
  readonly result?: NativeResult;
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
export interface NativeAccepted {
  readonly operationId: OwnedBytes;
  readonly cryptoSessionId: OwnedBytes;
  readonly logicalMessageId: OwnedBytes;
  readonly messageClass: string;
  readonly epoch: bigint;
  readonly acknowledged: boolean;
}
export interface NativeCommit {
  readonly commitId: OwnedBytes;
  readonly targetEpoch: bigint;
  readonly epochAuthenticator: OwnedBytes;
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

/** Endpoint-owned witness operations shared by both endpoint kinds. */
export interface WitnessEndpoint {
  /** Fresh signed `read`; the next `reconcileWitness` must present a certificate for these bytes. */
  witnessReadRequest(): Promise<OwnedBytes>;
  /** Verify the unanimous `read` certificate. `ready` grants exactly one mutation. */
  reconcileWitness(certificate: Uint8Array): Promise<WitnessReconciliation>;
  /** The one durable pending request, or `null`. Reloaded from storage on every call. */
  pendingWitness(): Promise<PendingWitness | null>;
  /** Verify the certificate, finish the key lifecycle, and release the exact result. */
  continueWitness(operationId: Uint8Array, certificate: Uint8Array): Promise<NativeResult>;
  /** Persist a due expiry as a witnessed operation; `null` when nothing is due. */
  expireIfNeeded(): Promise<PendingWitness | null>;
}

export interface DaemonEndpoint extends WitnessEndpoint {
  /** Creates storage and returns the counter-1 `register` request; nothing is published yet. */
  issue(operationId: Uint8Array): Promise<PendingWitness>;
  reopen(): Promise<"opened">;
  expireWelcomeIfNeeded(): Promise<PendingWitness | null>;
  invitation(): Promise<Publication>;
  status(): Promise<InvitationState>;
  cancel(operationId: Uint8Array): Promise<WitnessOutcome>;
  submitClaim(operationId: Uint8Array, claim: Uint8Array): Promise<WitnessOutcome>;
  confirmClaim(
    operationId: Uint8Array,
    claimHash: Uint8Array,
    reservationId: Uint8Array,
  ): Promise<WitnessOutcome>;
  releaseReservation(operationId: Uint8Array, reservationId: Uint8Array): Promise<WitnessOutcome>;
  createWelcome(operationId: Uint8Array, reservationId: Uint8Array): Promise<WitnessOutcome>;
  recoverWelcome(claimHash: Uint8Array): Promise<NativeWelcome>;
  acceptActivation(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<WitnessOutcome>;
  prepareApplication(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    plaintext: Uint8Array,
  ): Promise<WitnessOutcome>;
  receiveApplication(
    operationId: Uint8Array,
    ciphertext: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<WitnessOutcome>;
  receiveReplacementProposal(
    operationId: Uint8Array,
    ciphertext: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<WitnessOutcome>;
  createUpdateCommit(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<WitnessOutcome>;
  acceptEpochReady(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    ciphertext: Uint8Array,
  ): Promise<WitnessOutcome>;
  prepareEpochReadyConfirmation(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    acceptance: NativeEpochReadyAcceptance,
  ): Promise<WitnessOutcome>;
  removeDevice(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<WitnessOutcome>;
  revokeDevice(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<WitnessOutcome>;
  reset(operationId: Uint8Array): Promise<WitnessOutcome>;
  markRevoked(operationId: Uint8Array): Promise<WitnessOutcome>;
  pendingOutbox(): Promise<readonly NativeOutbox[]>;
  acknowledgeOutbox(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<WitnessOutcome>;
  acknowledgeReceive(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<WitnessOutcome>;
  pairStatus(): Promise<PairState | undefined>;
  close(): void;
}
export interface DeviceEndpoint extends WitnessEndpoint {
  /** Creates storage and returns the counter-1 `register` request; nothing is published yet. */
  prepare(invitation: Uint8Array, operationId: Uint8Array): Promise<PendingWitness>;
  prepareRepair(
    invitation: Uint8Array,
    operationId: Uint8Array,
    requirement: NativeRePairRequirement,
  ): Promise<PendingWitness>;
  reopen(): Promise<"opened">;
  status(): Promise<PreJoinState>;
  publication(): Promise<Publication>;
  join(operationId: Uint8Array, welcome: NativeWelcome): Promise<WitnessOutcome>;
  joinPublishedWelcome(
    operationId: Uint8Array,
    welcome: Uint8Array,
    claimHash: Uint8Array,
    welcomeHash: Uint8Array,
    expiresAtMs: bigint,
  ): Promise<WitnessOutcome>;
  prepareActivation(operationId: Uint8Array, logicalId: Uint8Array): Promise<WitnessOutcome>;
  acknowledgeActivation(
    operationId: Uint8Array,
    acceptance: NativeActivationAcceptance,
  ): Promise<WitnessOutcome>;
  prepareApplication(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    plaintext: Uint8Array,
  ): Promise<WitnessOutcome>;
  receiveApplication(
    operationId: Uint8Array,
    ciphertext: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<WitnessOutcome>;
  prepareReplacement(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<WitnessOutcome>;
  /** One OpenMLS transition. The released result is the `commit` metadata. */
  applyUpdateCommit(
    operationId: Uint8Array,
    commit: NativeOutbox,
    commitLogicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<WitnessOutcome>;
  /** One OpenMLS transition. The released result is the `commit` metadata. */
  applyReceivedUpdateCommit(
    operationId: Uint8Array,
    ciphertext: Uint8Array,
    commitLogicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<WitnessOutcome>;
  /** Separate operation creating the epoch-ready message for an applied commit. */
  prepareEpochReady(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    commit: NativeCommit,
  ): Promise<WitnessOutcome>;
  acceptEpochReadyConfirmation(
    operationId: Uint8Array,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
    ciphertext: Uint8Array,
  ): Promise<WitnessOutcome>;
  acknowledgeEpochReady(
    operationId: Uint8Array,
    acceptance: NativeEpochReadyAcceptance,
  ): Promise<WitnessOutcome>;
  applyRemoval(
    operationId: Uint8Array,
    commit: NativeOutbox,
    logicalId: Uint8Array,
    hostedGrantGeneration: bigint,
  ): Promise<WitnessOutcome>;
  reset(operationId: Uint8Array): Promise<WitnessOutcome>;
  pendingOutbox(): Promise<readonly NativeOutbox[]>;
  acknowledgeOutbox(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<WitnessOutcome>;
  acknowledgeReceive(
    operationId: Uint8Array,
    targetOperationId: Uint8Array,
  ): Promise<WitnessOutcome>;
  pairStatus(): Promise<PairState | undefined>;
  close(): void;
}

export declare const ERROR_CODES: readonly AxlE2eeErrorCode[];
export declare function getBindingInfo(): Readonly<BindingInfo>;
export declare function inspectPairingInvitation(bytes: Uint8Array): Promise<PairingInspection>;
export declare function inspectPairingClaim(bytes: Uint8Array): Promise<PairingInspection>;
/** Always rejects until a production EnvelopeKeyStore is separately approved. */
export declare function createDaemonEndpoint(): Promise<DaemonEndpoint>;
/** Always rejects until production secure storage and an approved witness quorum exist. */
export declare function openDaemonEndpoint(): Promise<DaemonEndpoint>;
/** Always rejects until a production EnvelopeKeyStore is separately approved. */
export declare function createDeviceEndpoint(): Promise<DeviceEndpoint>;
/** Always rejects until production secure storage and an approved witness quorum exist. */
export declare function openDeviceEndpoint(): Promise<DeviceEndpoint>;
