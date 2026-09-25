// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

//! Durable pre-group pairing state for native endpoints.

use std::{collections::BTreeMap, fmt, path::Path, sync::Arc};

use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::{OpenMlsProvider, random::OpenMlsRand as _};

use super::{
    CoreProvider, EnvelopeKeyStore, FaultPoint, Lookup, NativeTransactionalProvider, NoFaults,
    PairingOperationRecord, PendingWitnessRequest, PersistenceError, RuntimeHooks, SystemClock,
    TypedResult, WitnessEndpoint, WitnessOutcome, begin_current, fresh_or_return,
    impl_witness_endpoint, op_kind, optional_field, witness_v2::operation_fingerprint,
};
use crate::{
    CommitMetadata, Daemon, GroupTransaction, Id, Identity, PROFILE_ID, PROFILE_REVISION,
    PairContext, PairWelcome, Phone, PhoneKeyPackage, Role, epoch_ready_payload,
    pairing::{
        ClassifiedClaim, FailedClaimReason, PAIRING_CLAIM_MAX_BYTES, PAIRING_INVITATION_MAX_BYTES,
        PAIRING_MAX_FAILED_CLAIMS, PairingClaimAccountant, PairingClaimV1, PairingCredential,
        PairingInvitation, comparison_value, sha384,
    },
    witness::{EndpointReconciliation, ReplicaTrustSet},
};

const DAEMON_PAIRING_KEY: &[u8] = b"\0axl-daemon-pairing-v1";
const DEVICE_PREJOIN_KEY: &[u8] = b"\0axl-device-prejoin-v1";
const PAIRING_RECORD_VERSION: u16 = 2;
const OP_ISSUE_INVITATION: u8 = 1;
const OP_PREPARE_CLAIM: u8 = 2;
const OP_SUBMIT_CLAIM: u8 = 3;
const OP_CANCEL_INVITATION: u8 = 4;
const OP_EXPIRE_INVITATION: u8 = 5;
const OP_EXPIRE_PREJOIN: u8 = 6;
const OP_CONFIRM_CLAIM: u8 = 7;
const OP_CREATE_WELCOME: u8 = 8;
const OP_JOIN_WELCOME: u8 = 9;
const OP_CREATE_ACTIVATION: u8 = 10;
const OP_ACCEPT_ACTIVATION: u8 = 11;
const OP_SELF_UPDATE: u8 = 12;
const OP_ACCEPT_UPDATE: u8 = 13;
const OP_UPDATE_COMMIT: u8 = 14;
const OP_APPLY_COMMIT: u8 = 15;
const OP_EPOCH_READY: u8 = 16;
const OP_REMOVE: u8 = 17;
const OP_APPLY_REMOVAL: u8 = 18;
const OP_RESET: u8 = 19;
const OP_EXPIRE_WELCOME: u8 = 20;
const OP_RELEASE_RESERVATION: u8 = 21;
const OP_CONFIRM_EPOCH_READY: u8 = 22;
const OUTCOME_ISSUED: u8 = 1;
const OUTCOME_PREPARED: u8 = 2;
const OUTCOME_PENDING: u8 = 3;
const OUTCOME_REJECTED_CREDENTIAL: u8 = 4;
const OUTCOME_REJECTED_KEY_PACKAGE: u8 = 5;
const OUTCOME_REJECTED_SIGNATURE: u8 = 6;
const OUTCOME_CANCELLED: u8 = 7;
const OUTCOME_EXPIRED: u8 = 8;
const OUTCOME_CONFLICT: u8 = 9;
const OUTCOME_RESERVED: u8 = 10;
const OUTCOME_WELCOME: u8 = 11;
const OUTCOME_JOINED: u8 = 12;
const OUTCOME_ACTIVATED: u8 = 13;
const OUTCOME_UPDATED: u8 = 14;
const OUTCOME_REMOVED: u8 = 15;
const OUTCOME_RESET: u8 = 16;

/// Durable daemon-side invitation state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum InvitationLifecycle {
    Issued = 1,
    ClaimPending = 2,
    Confirmed = 3,
    Consumed = 4,
    Cancelled = 5,
    Expired = 6,
}

/// Durable device state before a Welcome establishes the group.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum PreJoinLifecycle {
    PreJoin = 1,
    Expired = 2,
    Cancelled = 3,
    Joined = 4,
    Activated = 5,
    Removed = 6,
    Reset = 7,
}

/// Active-pair lifecycle shared by daemon and device facades.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum PairLifecycle {
    AwaitingActivation = 1,
    Active = 2,
    ReplacementProposed = 3,
    WaitingForEpochReady = 4,
    Removed = 5,
    Revoked = 6,
    Reset = 7,
}

/// Terminal local state and the identifiers that may not be reused.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RePairRequirement {
    device_id: Id,
    crypto_session_id: Id,
    group_id: Option<[u8; 32]>,
    key_package_hash: [u8; 48],
}

impl RePairRequirement {
    pub fn device_id(&self) -> Id {
        self.device_id
    }

    pub fn crypto_session_id(&self) -> Id {
        self.crypto_session_id
    }

    pub fn group_id(&self) -> Option<[u8; 32]> {
        self.group_id
    }

    pub fn key_package_hash(&self) -> [u8; 48] {
        self.key_package_hash
    }

    pub fn validate_fresh(
        &self,
        device_id: Id,
        crypto_session_id: Id,
        group_id: [u8; 32],
        key_package_hash: [u8; 48],
    ) -> Result<(), PersistenceError> {
        if device_id == self.device_id
            || crypto_session_id == self.crypto_session_id
            || self.group_id == Some(group_id)
            || key_package_hash == self.key_package_hash
        {
            Err(PersistenceError::IdentityMismatch)
        } else {
            Ok(())
        }
    }
}

/// Typed result of daemon revocation or member removal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RemovalOutcome {
    Commit(super::OutboxRecord),
    Removed,
    Revoked,
    RePairRequired(RePairRequirement),
}

/// A local reservation intent suitable for later opaque publication by a host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReservationIntent {
    pub reservation_id: Id,
    pub crypto_session_id: Id,
    pub account_id: Id,
    pub installation_id: Id,
    pub device_id: Id,
    pub claim_hash: [u8; 48],
    pub key_package_hash: [u8; 48],
    pub expires_at_ms: u64,
}

/// Typed KeyPackage reservation result. No hosted storage is implemented here.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReservationOutcome {
    Reserved(ReservationIntent),
    Busy,
    Expired,
    Consumed,
    Rejected,
    Unavailable,
}

/// Exact Welcome bytes released only after group state commits.
#[derive(Clone, Eq, PartialEq)]
pub struct WelcomePublication {
    bytes: Vec<u8>,
    group_id: [u8; 32],
    claim_hash: [u8; 48],
    expires_at_ms: u64,
}

impl fmt::Debug for WelcomePublication {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WelcomePublication")
            .field("bytes", &"[redacted]")
            .field("group_id", &self.group_id)
            .field("claim_hash", &self.claim_hash)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

impl WelcomePublication {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn group_id(&self) -> [u8; 32] {
        self.group_id
    }

    pub fn claim_hash(&self) -> [u8; 48] {
        self.claim_hash
    }

    pub fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }
}

/// Typed result of exact Welcome creation or recovery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WelcomeOutcome {
    Committed(WelcomePublication),
    Duplicate(WelcomePublication),
    Busy,
    Expired,
    Consumed,
    Rejected,
    Unavailable,
}

/// Durable evidence that the daemon accepted the authenticated epoch-ready message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EpochReadyAcceptance {
    crypto_session_id: Id,
    commit_id: [u8; 48],
}

impl EpochReadyAcceptance {
    pub fn crypto_session_id(&self) -> Id {
        self.crypto_session_id
    }

    pub fn commit_id(&self) -> [u8; 48] {
        self.commit_id
    }
}

/// Durable evidence that the daemon accepted the authenticated activation message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivationAcceptance {
    crypto_session_id: Id,
    group_id: [u8; 32],
    claim_hash: [u8; 48],
    activation_hash: [u8; 48],
}

impl ActivationAcceptance {
    pub fn crypto_session_id(&self) -> Id {
        self.crypto_session_id
    }

    pub fn group_id(&self) -> [u8; 32] {
        self.group_id
    }

    pub fn claim_hash(&self) -> [u8; 48] {
        self.claim_hash
    }

    pub fn activation_hash(&self) -> [u8; 48] {
        self.activation_hash
    }
}

/// Durable activation acknowledgement outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActivationOutcome {
    Prepared(super::OutboxRecord),
    Activated(ActivationAcceptance),
    Duplicate(ActivationAcceptance),
    Rejected,
}

/// Stable public reason for an eligible failed claim.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaimFailure {
    Credential,
    KeyPackage,
    Signature,
}

impl From<FailedClaimReason> for ClaimFailure {
    fn from(value: FailedClaimReason) -> Self {
        match value {
            FailedClaimReason::Credential => Self::Credential,
            FailedClaimReason::KeyPackage => Self::KeyPackage,
            FailedClaimReason::Signature => Self::Signature,
        }
    }
}

/// Typed result of submitting claim bytes to a known durable invitation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClaimSubmission {
    Pending {
        claim_hash: [u8; 48],
        comparison: String,
    },
    Confirmed(ReservationIntent),
    Accepted(WelcomePublication),
    Consumed,
    Rejected {
        reason: Option<ClaimFailure>,
    },
    Cancelled,
    Expired,
    Conflict,
}

/// Exact invitation bytes released only after their durable commit.
#[derive(Clone, Eq, PartialEq)]
pub struct InvitationPublication {
    bytes: Vec<u8>,
    invitation_hash: [u8; 48],
    expires_at_ms: u64,
}

impl fmt::Debug for InvitationPublication {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InvitationPublication")
            .field("bytes", &"[redacted]")
            .field("invitation_hash", &self.invitation_hash)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

impl InvitationPublication {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn invitation_hash(&self) -> [u8; 48] {
        self.invitation_hash
    }

    pub fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }
}

/// Exact device claim and KeyPackage bytes released only after their durable commit.
#[derive(Clone, Eq, PartialEq)]
pub struct PreJoinPublication {
    claim: Vec<u8>,
    key_package: Vec<u8>,
    invitation_hash: [u8; 48],
    expires_at_ms: u64,
}

impl fmt::Debug for PreJoinPublication {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PreJoinPublication")
            .field("claim", &"[redacted]")
            .field("key_package", &"[redacted]")
            .field("invitation_hash", &self.invitation_hash)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

impl PreJoinPublication {
    pub fn claim(&self) -> &[u8] {
        &self.claim
    }

    pub fn key_package(&self) -> &[u8] {
        &self.key_package
    }

    pub fn invitation_hash(&self) -> [u8; 48] {
        self.invitation_hash
    }

    pub fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CancellationReason {
    Explicit = 1,
    FailedClaims = 2,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FailedClaim {
    hash: [u8; 48],
    reason: ClaimFailure,
    outcome: u8,
}

type PendingClaim = ([u8; 48], Vec<u8>);

#[derive(Clone)]
struct DaemonPairingRecord {
    state: InvitationLifecycle,
    crypto_session_id: Id,
    account_id: Id,
    installation_id: Id,
    invitation: Vec<u8>,
    invitation_hash: [u8; 48],
    invitation_nonce: [u8; 32],
    issued_at_ms: u64,
    expires_at_ms: u64,
    last_now_ms: u64,
    failed: Vec<FailedClaim>,
    pending_claim: Option<PendingClaim>,
    accepted_claim_hash: Option<[u8; 48]>,
    accepted_result: Option<Vec<u8>>,
    reservation: Option<([u8; 16], u64)>,
    group_id: Option<[u8; 32]>,
    welcome: Option<Vec<u8>>,
    welcome_expires_at_ms: Option<u64>,
    welcome_expired: bool,
    activation_accepted: bool,
    activation_hash: Option<[u8; 48]>,
    pair_lifecycle: Option<PairLifecycle>,
    pending_commit: Option<CommitMetadata>,
    cancellation_reason: Option<CancellationReason>,
}

#[derive(Clone)]
struct DevicePreJoinRecord {
    state: PreJoinLifecycle,
    crypto_session_id: Id,
    account_id: Id,
    installation_id: Id,
    device_id: Id,
    invitation: Vec<u8>,
    invitation_hash: [u8; 48],
    expires_at_ms: u64,
    last_now_ms: u64,
    key_package: Vec<u8>,
    claim: Vec<u8>,
    group_id: Option<[u8; 32]>,
    welcome: Option<Vec<u8>>,
    welcome_expires_at_ms: Option<u64>,
    activation: Option<Vec<u8>>,
    pair_lifecycle: Option<PairLifecycle>,
    pending_commit: Option<CommitMetadata>,
    /// True once the epoch-ready message for `pending_commit` has been created. A received
    /// commit is applied in one operation; the epoch-ready send is a separate operation.
    epoch_ready_prepared: bool,
    forbidden_group_id: Option<[u8; 32]>,
}

/// Durable owner of one daemon pending invitation.
#[derive(Clone)]
pub struct DurablePendingInvitation {
    store: Arc<NativeTransactionalProvider>,
}

/// Durable owner of one device pre-join state.
#[derive(Clone)]
pub struct DurablePreJoinDevice {
    store: Arc<NativeTransactionalProvider>,
}

struct DevicePreparation<'a> {
    runtime: RuntimeHooks,
    requirement: Option<&'a RePairRequirement>,
}

impl DurablePendingInvitation {
    pub fn issue(
        root: &Path,
        identity: Identity,
        crypto_session_id: Id,
        operation_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
    ) -> Result<(Self, PendingWitnessRequest), PersistenceError> {
        Self::issue_with_runtime(
            root,
            identity,
            crypto_session_id,
            operation_id,
            envelope_keys,
            trust,
            RuntimeHooks {
                faults: Arc::new(NoFaults),
                clock: Arc::new(SystemClock),
            },
        )
    }

    pub(crate) fn issue_with_runtime(
        root: &Path,
        identity: Identity,
        crypto_session_id: Id,
        operation_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
        runtime: RuntimeHooks,
    ) -> Result<(Self, PendingWitnessRequest), PersistenceError> {
        if identity.role != Role::Daemon {
            return Err(PersistenceError::IdentityMismatch);
        }
        let store = NativeTransactionalProvider::create(
            root,
            crypto_session_id,
            envelope_keys,
            trust,
            runtime.faults,
            runtime.clock,
        )?;
        let fingerprint = operation_fingerprint(
            op_kind::DAEMON_INVITATION,
            &[
                &[identity.role as u8],
                &identity.account_id,
                &identity.installation_id,
                &crypto_session_id,
            ],
        )?;
        let mut transaction =
            match store.begin_witnessed(operation_id, op_kind::DAEMON_INVITATION, fingerprint)? {
                Lookup::Fresh(transaction) => *transaction,
                Lookup::Pending(_) | Lookup::Released(_) => return Err(PersistenceError::Conflict),
            };
        store.faults.check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let (_, signer) = crate::make_credential(&transaction.provider, &identity)?;
        let pairing_credential = PairingCredential::new(identity.clone(), &signer)
            .map_err(|_| PersistenceError::Corrupt)?;
        let invitation = PairingInvitation::create_with_clock(
            identity.account_id,
            identity.installation_id,
            crypto_session_id,
            pairing_credential,
            &signer,
            store.clock.as_ref(),
        )
        .map_err(map_pairing_error)?;
        let invitation_bytes = invitation.encode().map_err(map_pairing_error)?;
        let invitation_hash = invitation.invitation_hash().map_err(map_pairing_error)?;
        let record = DaemonPairingRecord {
            state: InvitationLifecycle::Issued,
            crypto_session_id,
            account_id: identity.account_id,
            installation_id: identity.installation_id,
            invitation: invitation_bytes.clone(),
            invitation_hash,
            invitation_nonce: invitation.invitation_nonce(),
            issued_at_ms: invitation.issued_at_ms(),
            expires_at_ms: invitation.expires_at_ms(),
            last_now_ms: invitation.issued_at_ms(),
            failed: Vec::new(),
            pending_claim: None,
            accepted_claim_hash: None,
            accepted_result: None,
            reservation: None,
            group_id: None,
            welcome: None,
            welcome_expires_at_ms: None,
            welcome_expired: false,
            activation_accepted: false,
            activation_hash: None,
            pair_lifecycle: None,
            pending_commit: None,
            cancellation_reason: None,
        };
        transaction
            .provider
            .insert_internal(DAEMON_PAIRING_KEY.to_vec(), encode_daemon_record(&record)?);
        // The daemon has no group yet. Its witness lineage and request signer are still named by
        // endpoint metadata so every later transition reconstructs them from one place.
        transaction.provider.insert_internal(
            super::ENDPOINT_METADATA_KEY.to_vec(),
            super::encode_endpoint_metadata(
                identity.clone(),
                identity.clone(),
                None,
                signer.public(),
                &BTreeMap::new(),
                invitation.issued_at_ms(),
            ),
        );
        transaction.set_successor_epoch(0, &[]);
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id,
                kind: OP_ISSUE_INVITATION,
                outcome: OUTCOME_ISSUED,
                artifact_hash: invitation_hash,
            },
        ))?;
        // The database stays `initializing` and the invitation stays withheld until the
        // counter-1 register certificate completes through `continue_witness`.
        let request =
            transaction.commit_witnessed(TypedResult::Invitation(publication(&record)))?;
        Ok((Self { store }, request))
    }

    pub fn open(
        root: &Path,
        crypto_session_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
    ) -> Result<Self, PersistenceError> {
        Self::open_with_runtime(
            root,
            crypto_session_id,
            envelope_keys,
            trust,
            RuntimeHooks {
                faults: Arc::new(NoFaults),
                clock: Arc::new(SystemClock),
            },
        )
    }

    pub(crate) fn open_with_runtime(
        root: &Path,
        crypto_session_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
        runtime: RuntimeHooks,
    ) -> Result<Self, PersistenceError> {
        let store = NativeTransactionalProvider::open(
            root,
            crypto_session_id,
            envelope_keys,
            trust,
            runtime.faults,
            runtime.clock,
        )?;
        let transaction = begin_current(&store)?;
        let record = daemon_record(&transaction.provider, crypto_session_id)?;
        validate_daemon_signer(&transaction.provider, &record)?;
        if record.state == InvitationLifecycle::Consumed {
            let daemon = super::load_daemon(
                &transaction.provider,
                Arc::clone(&store.clock),
                transaction.accepted_ids.clone(),
            )?;
            if !matches!(
                record.pair_lifecycle,
                Some(PairLifecycle::Removed | PairLifecycle::Revoked | PairLifecycle::Reset)
            ) {
                crate::validate_members(
                    daemon.endpoint.group()?,
                    &daemon.endpoint.identity,
                    &daemon.endpoint.peer,
                )?;
            }
        }
        transaction.rollback()?;
        // Opening reconciles and publishes committed state only. It never creates a successor,
        // so a due expiry waits for the next witnessed mutation.
        store.finish_opening()?;
        Ok(Self { store })
    }

    /// Read-only. Returns the committed invitation; it does not persist a due expiry. An
    /// interrupted initial registration keeps the invitation withheld.
    pub fn publication(&mut self) -> Result<InvitationPublication, PersistenceError> {
        self.store.require_published()?;
        self.store.require_no_pending()?;
        let transaction = begin_current(&self.store)?;
        let record = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        let result = match record.state {
            InvitationLifecycle::Issued | InvitationLifecycle::ClaimPending => {
                Ok(publication(&record))
            }
            InvitationLifecycle::Expired => Err(PersistenceError::Conflict),
            _ => Err(PersistenceError::Conflict),
        };
        transaction.rollback()?;
        result
    }

    /// Read-only committed lifecycle. A due but not yet witnessed expiry is not reported here.
    pub fn lifecycle(&mut self) -> Result<InvitationLifecycle, PersistenceError> {
        self.store.require_no_pending()?;
        let transaction = begin_current(&self.store)?;
        let state = daemon_record(&transaction.provider, self.store.crypto_session_id)?.state;
        transaction.rollback()?;
        Ok(state)
    }

    pub fn submit_claim(
        &mut self,
        operation_id: Id,
        claim_bytes: &[u8],
    ) -> Result<WitnessOutcome<ClaimSubmission>, PersistenceError> {
        if claim_bytes.len() > PAIRING_CLAIM_MAX_BYTES {
            return Ok(WitnessOutcome::Released(ClaimSubmission::Rejected {
                reason: None,
            }));
        }
        if let Some(expiry) = self.expire_if_needed()? {
            return Ok(WitnessOutcome::Pending(expiry));
        }
        let fingerprint = operation_fingerprint(op_kind::CLAIM_SUBMIT, &[claim_bytes])?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::CLAIM_SUBMIT,
            fingerprint
        )?);
        let mut record = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        let now = self.store.clock.now_ms().map_err(PersistenceError::Core)?;
        if now < record.last_now_ms {
            transaction.rollback()?;
            return Err(PersistenceError::Core(crate::Error::ClockRollback));
        }
        record.last_now_ms = now;
        let submitted_hash = sha384(claim_bytes).map_err(map_pairing_error)?;
        if record.state == InvitationLifecycle::Consumed
            && record.accepted_claim_hash == Some(submitted_hash)
        {
            let result = if welcome_is_expired(&record, now)? {
                ClaimSubmission::Expired
            } else {
                welcome_publication(&record)
                    .map(ClaimSubmission::Accepted)
                    .unwrap_or(ClaimSubmission::Consumed)
            };
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(result));
        }
        let invitation =
            PairingInvitation::decode(&record.invitation).map_err(map_pairing_error)?;
        let classification = PairingClaimAccountant::classify(&invitation, claim_bytes, now);
        let (outcome, artifact_hash, result, changed) = match classification {
            ClassifiedClaim::NonCounting => {
                transaction.rollback()?;
                return Ok(WitnessOutcome::Released(ClaimSubmission::Rejected {
                    reason: None,
                }));
            }
            ClassifiedClaim::EligibleFailure { claim_hash, reason } => {
                if let Some(failed) = record
                    .failed
                    .iter()
                    .find(|failed| failed.hash == claim_hash)
                {
                    let result = failed_result(failed)?;
                    transaction.rollback()?;
                    return Ok(WitnessOutcome::Released(result));
                }
                if record.state == InvitationLifecycle::Expired {
                    transaction.rollback()?;
                    return Ok(WitnessOutcome::Released(ClaimSubmission::Expired));
                }
                if record.state == InvitationLifecycle::Cancelled {
                    transaction.rollback()?;
                    return Ok(WitnessOutcome::Released(ClaimSubmission::Cancelled));
                }
                if matches!(
                    record.state,
                    InvitationLifecycle::Confirmed | InvitationLifecycle::Consumed
                ) || record
                    .pending_claim
                    .as_ref()
                    .is_some_and(|(hash, _)| *hash != claim_hash)
                {
                    (
                        OUTCOME_CONFLICT,
                        claim_hash,
                        ClaimSubmission::Conflict,
                        false,
                    )
                } else {
                    let cancelled = record.failed.len() + 1 == PAIRING_MAX_FAILED_CLAIMS;
                    let public_reason = ClaimFailure::from(reason);
                    let terminal = if cancelled {
                        record.state = InvitationLifecycle::Cancelled;
                        record.pending_claim = None;
                        record.accepted_claim_hash = None;
                        record.accepted_result = None;
                        record.reservation = None;
                        record.cancellation_reason = Some(CancellationReason::FailedClaims);
                        OUTCOME_CANCELLED
                    } else {
                        record.state = InvitationLifecycle::Issued;
                        outcome_for_failure(public_reason)
                    };
                    record.failed.push(FailedClaim {
                        hash: claim_hash,
                        reason: public_reason,
                        outcome: terminal,
                    });
                    let result = if cancelled {
                        ClaimSubmission::Cancelled
                    } else {
                        ClaimSubmission::Rejected {
                            reason: Some(public_reason),
                        }
                    };
                    (terminal, claim_hash, result, true)
                }
            }
            ClassifiedClaim::Eligible { claim_hash, claim } => {
                if record.state == InvitationLifecycle::Expired {
                    transaction.rollback()?;
                    return Ok(WitnessOutcome::Released(ClaimSubmission::Expired));
                }
                if record.state == InvitationLifecycle::Cancelled {
                    transaction.rollback()?;
                    return Ok(WitnessOutcome::Released(ClaimSubmission::Cancelled));
                }
                if let Some((pending_hash, _)) = &record.pending_claim {
                    if *pending_hash == claim_hash {
                        let result = match record.state {
                            InvitationLifecycle::ClaimPending => ClaimSubmission::Pending {
                                claim_hash,
                                comparison: comparison_value(&invitation, &claim)
                                    .map_err(map_pairing_error)?,
                            },
                            InvitationLifecycle::Confirmed => {
                                ClaimSubmission::Confirmed(reservation_intent(&record)?)
                            }
                            InvitationLifecycle::Consumed => {
                                if welcome_is_expired(&record, now)? {
                                    ClaimSubmission::Expired
                                } else {
                                    welcome_publication(&record)
                                        .map(ClaimSubmission::Accepted)
                                        .unwrap_or(ClaimSubmission::Consumed)
                                }
                            }
                            _ => return Err(PersistenceError::Corrupt),
                        };
                        transaction.rollback()?;
                        return Ok(WitnessOutcome::Released(result));
                    }
                    (
                        OUTCOME_CONFLICT,
                        claim_hash,
                        ClaimSubmission::Conflict,
                        false,
                    )
                } else if matches!(
                    record.state,
                    InvitationLifecycle::Confirmed | InvitationLifecycle::Consumed
                ) {
                    (
                        OUTCOME_CONFLICT,
                        claim_hash,
                        ClaimSubmission::Conflict,
                        false,
                    )
                } else {
                    record.state = InvitationLifecycle::ClaimPending;
                    record.pending_claim = Some((claim_hash, claim_bytes.to_vec()));
                    (
                        OUTCOME_PENDING,
                        claim_hash,
                        ClaimSubmission::Pending {
                            claim_hash,
                            comparison: comparison_value(&invitation, &claim)
                                .map_err(map_pairing_error)?,
                        },
                        true,
                    )
                }
            }
        };
        if !changed && outcome != OUTCOME_CONFLICT {
            transaction.rollback()?;
            return Err(PersistenceError::Corrupt);
        }
        // A recorded conflict changes operation history and the clock state; the remaining
        // record fields are unchanged. Both are authenticated endpoint state and advance.
        transaction
            .provider
            .insert_internal(DAEMON_PAIRING_KEY.to_vec(), encode_daemon_record(&record)?);
        transaction.keep_epoch();
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_SUBMIT_CLAIM,
                outcome,
                artifact_hash,
            },
        ))?;
        let request = transaction.commit_witnessed(TypedResult::Claim(result))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn confirm_claim(
        &mut self,
        operation_id: Id,
        claim_hash: [u8; 48],
        reservation_id: Id,
    ) -> Result<WitnessOutcome<ReservationOutcome>, PersistenceError> {
        if let Some(expiry) = self.expire_if_needed()? {
            return Ok(WitnessOutcome::Pending(expiry));
        }
        let fingerprint =
            operation_fingerprint(op_kind::CLAIM_CONFIRM, &[&claim_hash, &reservation_id])?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::CLAIM_CONFIRM,
            fingerprint
        )?);
        let mut record = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        let now = checked_pairing_now(&self.store, record.last_now_ms)?;
        record.last_now_ms = now;
        let result = match record.state {
            InvitationLifecycle::Expired => ReservationOutcome::Expired,
            InvitationLifecycle::Consumed => ReservationOutcome::Consumed,
            InvitationLifecycle::Cancelled | InvitationLifecycle::Issued => {
                ReservationOutcome::Rejected
            }
            InvitationLifecycle::Confirmed => {
                if record.accepted_claim_hash != Some(claim_hash) {
                    ReservationOutcome::Busy
                } else if let Some((stored_id, deadline)) = record.reservation {
                    if stored_id == reservation_id && now < deadline {
                        ReservationOutcome::Reserved(reservation_intent(&record)?)
                    } else if stored_id == reservation_id {
                        ReservationOutcome::Expired
                    } else if now >= deadline {
                        let next_deadline = now
                            .checked_add(60_000)
                            .ok_or(PersistenceError::Corrupt)?
                            .min(record.expires_at_ms);
                        record.reservation = Some((reservation_id, next_deadline));
                        let intent = reservation_intent(&record)?;
                        record.accepted_result = Some(encode_reservation_intent(&intent));
                        ReservationOutcome::Reserved(intent)
                    } else {
                        ReservationOutcome::Busy
                    }
                } else {
                    let deadline = now
                        .checked_add(60_000)
                        .ok_or(PersistenceError::Corrupt)?
                        .min(record.expires_at_ms);
                    record.reservation = Some((reservation_id, deadline));
                    let intent = reservation_intent(&record)?;
                    record.accepted_result = Some(encode_reservation_intent(&intent));
                    ReservationOutcome::Reserved(intent)
                }
            }
            InvitationLifecycle::ClaimPending => {
                let Some((pending_hash, claim_bytes)) = &record.pending_claim else {
                    return Err(PersistenceError::Corrupt);
                };
                if *pending_hash != claim_hash {
                    ReservationOutcome::Rejected
                } else {
                    let claim = PairingClaimV1::decode(claim_bytes).map_err(map_pairing_error)?;
                    let deadline = now
                        .checked_add(60_000)
                        .ok_or(PersistenceError::Corrupt)?
                        .min(record.expires_at_ms);
                    record.state = InvitationLifecycle::Confirmed;
                    record.accepted_claim_hash = Some(claim_hash);
                    record.reservation = Some((reservation_id, deadline));
                    let intent = ReservationIntent {
                        reservation_id,
                        crypto_session_id: record.crypto_session_id,
                        account_id: record.account_id,
                        installation_id: record.installation_id,
                        device_id: claim.device_credential().identity().device_id,
                        claim_hash,
                        key_package_hash: sha384(claim.key_package()).map_err(map_pairing_error)?,
                        expires_at_ms: deadline,
                    };
                    record.accepted_result = Some(encode_reservation_intent(&intent));
                    ReservationOutcome::Reserved(intent)
                }
            }
        };
        let outcome = match result {
            ReservationOutcome::Reserved(_) => OUTCOME_RESERVED,
            ReservationOutcome::Busy => OUTCOME_CONFLICT,
            ReservationOutcome::Expired => OUTCOME_EXPIRED,
            ReservationOutcome::Consumed => OUTCOME_WELCOME,
            ReservationOutcome::Rejected => OUTCOME_REJECTED_CREDENTIAL,
            ReservationOutcome::Unavailable => OUTCOME_REJECTED_KEY_PACKAGE,
        };
        transaction
            .provider
            .insert_internal(DAEMON_PAIRING_KEY.to_vec(), encode_daemon_record(&record)?);
        transaction.keep_epoch();
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_CONFIRM_CLAIM,
                outcome,
                artifact_hash: claim_hash,
            },
        ))?;
        let request = transaction.commit_witnessed(TypedResult::Reservation(result))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn release_reservation(
        &mut self,
        operation_id: Id,
        reservation_id: Id,
    ) -> Result<WitnessOutcome<ReservationOutcome>, PersistenceError> {
        if let Some(expiry) = self.expire_if_needed()? {
            return Ok(WitnessOutcome::Pending(expiry));
        }
        let fingerprint = operation_fingerprint(op_kind::RESERVATION_RELEASE, &[&reservation_id])?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::RESERVATION_RELEASE,
            fingerprint
        )?);
        let mut record = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        let now = checked_pairing_now(&self.store, record.last_now_ms)?;
        record.last_now_ms = now;
        let Some((stored_id, deadline)) = record.reservation else {
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(ReservationOutcome::Unavailable));
        };
        if stored_id != reservation_id {
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(ReservationOutcome::Busy));
        }
        if record.welcome.is_some() || record.state == InvitationLifecycle::Consumed {
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(ReservationOutcome::Consumed));
        }
        if now >= deadline {
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(ReservationOutcome::Expired));
        }
        let released_claim_hash = record
            .accepted_claim_hash
            .ok_or(PersistenceError::Corrupt)?;
        record.state = InvitationLifecycle::ClaimPending;
        record.accepted_claim_hash = None;
        record.reservation = None;
        record.accepted_result = None;
        transaction
            .provider
            .insert_internal(DAEMON_PAIRING_KEY.to_vec(), encode_daemon_record(&record)?);
        transaction.keep_epoch();
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_RELEASE_RESERVATION,
                outcome: OUTCOME_REJECTED_KEY_PACKAGE,
                artifact_hash: released_claim_hash,
            },
        ))?;
        let request = transaction
            .commit_witnessed(TypedResult::Reservation(ReservationOutcome::Unavailable))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn create_welcome(
        &mut self,
        operation_id: Id,
        reservation_id: Id,
    ) -> Result<WitnessOutcome<WelcomeOutcome>, PersistenceError> {
        if let Some(expiry) = self.expire_if_needed()? {
            return Ok(WitnessOutcome::Pending(expiry));
        }
        let fingerprint = operation_fingerprint(op_kind::WELCOME_CREATE, &[&reservation_id])?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::WELCOME_CREATE,
            fingerprint
        )?);
        let mut record = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        let now = checked_pairing_now(&self.store, record.last_now_ms)?;
        if record.state == InvitationLifecycle::Consumed {
            let result = if welcome_is_expired(&record, now)? {
                WelcomeOutcome::Expired
            } else {
                welcome_publication(&record)
                    .map(WelcomeOutcome::Duplicate)
                    .unwrap_or(WelcomeOutcome::Consumed)
            };
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(result));
        }
        if record.state == InvitationLifecycle::Expired {
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(WelcomeOutcome::Expired));
        }
        if record.state != InvitationLifecycle::Confirmed {
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(WelcomeOutcome::Rejected));
        }
        let Some((stored_reservation, deadline)) = record.reservation else {
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(WelcomeOutcome::Unavailable));
        };
        if stored_reservation != reservation_id {
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(WelcomeOutcome::Busy));
        }
        if now >= deadline {
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(WelcomeOutcome::Expired));
        }
        let (_, claim_bytes) = record
            .pending_claim
            .as_ref()
            .ok_or(PersistenceError::Corrupt)?;
        let claim = PairingClaimV1::decode(claim_bytes).map_err(map_pairing_error)?;
        let invitation =
            PairingInvitation::decode(&record.invitation).map_err(map_pairing_error)?;
        claim
            .verify_signature_and_bindings(&invitation)
            .map_err(map_pairing_error)?;
        let group_id = transaction
            .provider
            .rand()
            .random_array::<32>()
            .map_err(|_| PersistenceError::Storage)?;
        if group_id == [0; 32] {
            return Err(PersistenceError::Corrupt);
        }
        let context = PairContext {
            crypto_session_id: record.crypto_session_id,
            group_id,
            account_id: record.account_id,
            installation_id: record.installation_id,
            device_id: claim.device_credential().identity().device_id,
        };
        let daemon_identity = invitation.daemon_credential().identity().clone();
        let signer_public = invitation.daemon_credential().verification_key();
        self.store
            .faults
            .check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let mut daemon = Daemon::create_from_pairing_state(
            transaction.provider.storage_values(),
            daemon_identity,
            context.clone(),
            signer_public,
            Arc::clone(&self.store.clock),
        )?;
        let package = PhoneKeyPackage {
            bytes: claim.key_package().to_vec().into_boxed_slice(),
            identity: claim.device_credential().identity().clone(),
        };
        let welcome = daemon.consume_key_package(package)?;
        let welcome_expires_at_ms = now
            .checked_add(10 * 60 * 1_000)
            .ok_or(PersistenceError::Corrupt)?;
        record.state = InvitationLifecycle::Consumed;
        record.last_now_ms = now;
        record.group_id = Some(group_id);
        record.welcome = Some(welcome.bytes().to_vec());
        record.welcome_expires_at_ms = Some(welcome_expires_at_ms);
        record.welcome_expired = false;
        record.accepted_result = Some(welcome.bytes().to_vec());
        record.pair_lifecycle = Some(PairLifecycle::AwaitingActivation);
        daemon
            .endpoint
            .provider
            .insert_internal(DAEMON_PAIRING_KEY.to_vec(), encode_daemon_record(&record)?);
        super::persist_endpoint_metadata(&daemon.endpoint, &daemon.endpoint.provider);
        transaction.replace_provider_values(daemon.endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(
            daemon.endpoint.epoch()?,
            &daemon.endpoint.epoch_authenticator()?,
        );
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_CREATE_WELCOME,
                outcome: OUTCOME_WELCOME,
                artifact_hash: record
                    .accepted_claim_hash
                    .ok_or(PersistenceError::Corrupt)?,
            },
        ))?;
        let request = transaction.commit_witnessed(TypedResult::Welcome(
            welcome_publication(&record).ok_or(PersistenceError::Corrupt)?,
        ))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn recover_welcome(
        &mut self,
        claim_hash: [u8; 48],
    ) -> Result<WelcomeOutcome, PersistenceError> {
        self.store.require_no_pending()?;
        let transaction = begin_current(&self.store)?;
        let record = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        let now = checked_pairing_now(&self.store, record.last_now_ms)?;
        let result = if record.accepted_claim_hash != Some(claim_hash) {
            WelcomeOutcome::Rejected
        } else if record.activation_accepted {
            WelcomeOutcome::Consumed
        } else if record.welcome_expired
            || record
                .welcome_expires_at_ms
                .is_some_and(|expires| now >= expires)
        {
            WelcomeOutcome::Expired
        } else {
            welcome_publication(&record)
                .map(WelcomeOutcome::Duplicate)
                .unwrap_or(WelcomeOutcome::Unavailable)
        };
        transaction.rollback()?;
        Ok(result)
    }

    pub fn accept_activation(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        ciphertext: &[u8],
    ) -> Result<WitnessOutcome<ActivationOutcome>, PersistenceError> {
        let ciphertext_hash = sha384(ciphertext).map_err(map_pairing_error)?;
        let fingerprint = operation_fingerprint(
            op_kind::ACTIVATION_RECEIVE,
            &[&logical_message_id, ciphertext],
        )?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::ACTIVATION_RECEIVE,
            fingerprint
        )?);
        let mut record = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        let now = checked_pairing_now(&self.store, record.last_now_ms)?;
        if record.activation_accepted {
            let result = if record.activation_hash == Some(ciphertext_hash) {
                ActivationOutcome::Duplicate(activation_acceptance(&record, ciphertext_hash)?)
            } else {
                ActivationOutcome::Rejected
            };
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(result));
        }
        if record.state != InvitationLifecycle::Consumed
            || record.welcome.is_none()
            || welcome_is_expired(&record, now)?
        {
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(ActivationOutcome::Rejected));
        }
        let mut daemon = super::load_daemon(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        let plaintext = daemon.receive_pair_activation(ciphertext, logical_message_id)?;
        validate_activation_payload(
            plaintext.plaintext(),
            record.crypto_session_id,
            record
                .accepted_claim_hash
                .ok_or(PersistenceError::Corrupt)?,
            daemon.endpoint.context.group_id,
        )?;
        record.activation_accepted = true;
        record.activation_hash = Some(ciphertext_hash);
        record.pair_lifecycle = Some(PairLifecycle::Active);
        record.welcome = None;
        record.welcome_expires_at_ms = None;
        record.welcome_expired = false;
        record.accepted_result = None;
        daemon
            .endpoint
            .provider
            .insert_internal(DAEMON_PAIRING_KEY.to_vec(), encode_daemon_record(&record)?);
        super::persist_endpoint_metadata(&daemon.endpoint, &daemon.endpoint.provider);
        transaction.replace_provider_values(daemon.endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(
            daemon.endpoint.epoch()?,
            &daemon.endpoint.epoch_authenticator()?,
        );
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_ACCEPT_ACTIVATION,
                outcome: OUTCOME_ACTIVATED,
                artifact_hash: ciphertext_hash,
            },
        ))?;
        let acceptance = activation_acceptance(&record, ciphertext_hash)?;
        let request = transaction.commit_witnessed(TypedResult::Activation(acceptance))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn prepare_application(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        plaintext: &[u8],
    ) -> Result<WitnessOutcome<super::OutboxRecord>, PersistenceError> {
        super::DurableDaemon {
            store: Arc::clone(&self.store),
        }
        .prepare_application_guarded(
            operation_id,
            logical_message_id,
            hosted_generation,
            plaintext,
            &self.active_precondition(),
        )
    }

    pub fn receive_application(
        &mut self,
        operation_id: Id,
        ciphertext: &[u8],
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<super::DurablePlaintext>, PersistenceError> {
        super::DurableDaemon {
            store: Arc::clone(&self.store),
        }
        .receive_application_guarded(
            operation_id,
            ciphertext,
            logical_message_id,
            hosted_generation,
            &self.active_precondition(),
        )
    }

    pub fn pending_outbox(&self) -> Result<Vec<super::OutboxRecord>, PersistenceError> {
        self.store.pending_outbox()
    }

    pub fn acknowledge_outbox(
        &mut self,
        acknowledgement_operation_id: Id,
        outbox_operation_id: Id,
    ) -> Result<WitnessOutcome<super::OutboxRecord>, PersistenceError> {
        super::acknowledge_outbox(
            &self.store,
            acknowledgement_operation_id,
            outbox_operation_id,
        )
    }

    pub fn acknowledge_receive(
        &mut self,
        acknowledgement_operation_id: Id,
        receive_operation_id: Id,
    ) -> Result<WitnessOutcome<super::AcceptedMessageRecord>, PersistenceError> {
        super::acknowledge_receive(
            &self.store,
            acknowledgement_operation_id,
            receive_operation_id,
        )
    }

    /// Runner precondition on the committed pair record. The runner evaluates it on the fresh
    /// transaction only after terminal state, the pending barrier, exact duplicates, and same-ID
    /// conflicts have been resolved, so it can never preempt quarantine or duplicate replay.
    fn active_precondition(&self) -> impl Fn(&super::CoreProvider) -> Result<(), PersistenceError> {
        let crypto_session_id = self.store.crypto_session_id;
        move |provider| {
            if daemon_record(provider, crypto_session_id)?.pair_lifecycle
                == Some(PairLifecycle::Active)
            {
                Ok(())
            } else {
                Err(PersistenceError::Conflict)
            }
        }
    }

    pub fn pair_lifecycle(&self) -> Result<Option<PairLifecycle>, PersistenceError> {
        self.store.require_no_pending()?;
        let transaction = begin_current(&self.store)?;
        let state =
            daemon_record(&transaction.provider, self.store.crypto_session_id)?.pair_lifecycle;
        transaction.rollback()?;
        Ok(state)
    }

    pub fn receive_replacement_proposal(
        &mut self,
        operation_id: Id,
        ciphertext: &[u8],
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<super::AcceptedMessageRecord>, PersistenceError> {
        let fingerprint = operation_fingerprint(
            op_kind::PROPOSAL_RECEIVE,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                ciphertext,
            ],
        )?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::PROPOSAL_RECEIVE,
            fingerprint
        )?);
        let mut lifecycle = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        if lifecycle.pair_lifecycle != Some(PairLifecycle::Active) {
            transaction.rollback()?;
            return Err(PersistenceError::Conflict);
        }
        let mut daemon = super::load_daemon(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        daemon.receive_update_proposal(ciphertext, logical_message_id, hosted_generation)?;
        lifecycle.pair_lifecycle = Some(PairLifecycle::ReplacementProposed);
        daemon.endpoint.provider.insert_internal(
            DAEMON_PAIRING_KEY.to_vec(),
            encode_daemon_record(&lifecycle)?,
        );
        super::persist_endpoint_metadata(&daemon.endpoint, &daemon.endpoint.provider);
        transaction.replace_provider_values(daemon.endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(
            daemon.endpoint.epoch()?,
            &daemon.endpoint.epoch_authenticator()?,
        );
        let accepted = super::AcceptedMessageRecord {
            operation_id,
            crypto_session_id: self.store.crypto_session_id,
            logical_message_id,
            class: crate::MessageClass::UpdateProposal,
            epoch: daemon.endpoint.epoch()?,
            profile_revision: PROFILE_REVISION,
            acknowledged: false,
        };
        transaction.stage_accepted_record(accepted.clone())?;
        let request = transaction.commit_witnessed(TypedResult::Accepted(accepted))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn create_update_commit(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<super::OutboxRecord>, PersistenceError> {
        self.create_lifecycle_commit(
            operation_id,
            logical_message_id,
            hosted_generation,
            false,
            false,
        )
    }

    pub fn prepare_epoch_ready_confirmation(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        acceptance: &EpochReadyAcceptance,
    ) -> Result<WitnessOutcome<super::OutboxRecord>, PersistenceError> {
        if acceptance.crypto_session_id != self.store.crypto_session_id {
            return Err(PersistenceError::IdentityMismatch);
        }
        let payload = epoch_ready_acceptance_payload(acceptance);
        super::DurableDaemon {
            store: Arc::clone(&self.store),
        }
        .prepare_resync_control_guarded(
            operation_id,
            logical_message_id,
            hosted_generation,
            &payload,
            &self.active_precondition(),
        )
    }

    pub fn remove_device(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<RemovalOutcome>, PersistenceError> {
        Ok(
            match self.create_lifecycle_commit(
                operation_id,
                logical_message_id,
                hosted_generation,
                true,
                false,
            )? {
                WitnessOutcome::Pending(request) => WitnessOutcome::Pending(request),
                WitnessOutcome::Released(record) => {
                    WitnessOutcome::Released(RemovalOutcome::Commit(record))
                }
            },
        )
    }

    pub fn revoke_device(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<RemovalOutcome>, PersistenceError> {
        Ok(
            match self.create_lifecycle_commit(
                operation_id,
                logical_message_id,
                hosted_generation,
                true,
                true,
            )? {
                WitnessOutcome::Pending(request) => WitnessOutcome::Pending(request),
                WitnessOutcome::Released(record) => {
                    WitnessOutcome::Released(RemovalOutcome::Commit(record))
                }
            },
        )
    }

    fn create_lifecycle_commit(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        removal: bool,
        revoked: bool,
    ) -> Result<WitnessOutcome<super::OutboxRecord>, PersistenceError> {
        let kind = if removal {
            op_kind::REMOVAL_COMMIT
        } else {
            op_kind::DAEMON_COMMIT
        };
        let fingerprint = if removal {
            operation_fingerprint(
                kind,
                &[
                    &logical_message_id,
                    &hosted_generation.to_be_bytes(),
                    &[u8::from(revoked)],
                ],
            )?
        } else {
            operation_fingerprint(
                kind,
                &[&logical_message_id, &hosted_generation.to_be_bytes()],
            )?
        };
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            kind,
            fingerprint
        )?);
        let mut lifecycle = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        let allowed = if removal {
            matches!(
                lifecycle.pair_lifecycle,
                Some(PairLifecycle::Active | PairLifecycle::ReplacementProposed)
            )
        } else {
            lifecycle.pair_lifecycle == Some(PairLifecycle::ReplacementProposed)
        };
        if !allowed {
            transaction.rollback()?;
            return Err(PersistenceError::Conflict);
        }
        let mut daemon = super::load_daemon(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        let envelope = if removal {
            daemon.prepare_removal(logical_message_id, hosted_generation)?
        } else {
            daemon.prepare_commit(logical_message_id, hosted_generation)?
        };
        lifecycle.pair_lifecycle = Some(if revoked {
            PairLifecycle::Revoked
        } else if removal {
            PairLifecycle::Removed
        } else {
            PairLifecycle::WaitingForEpochReady
        });
        lifecycle.pending_commit = if removal {
            None
        } else {
            envelope.commit.clone()
        };
        daemon.endpoint.provider.insert_internal(
            DAEMON_PAIRING_KEY.to_vec(),
            encode_daemon_record(&lifecycle)?,
        );
        super::persist_endpoint_metadata(&daemon.endpoint, &daemon.endpoint.provider);
        transaction.replace_provider_values(daemon.endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(
            daemon.endpoint.epoch()?,
            &daemon.endpoint.epoch_authenticator()?,
        );
        transaction.stage_envelope(&envelope)?;
        let request = transaction.commit_witnessed(TypedResult::Envelope(
            super::envelope_record(operation_id, &envelope),
        ))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn accept_epoch_ready(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        ciphertext: &[u8],
    ) -> Result<WitnessOutcome<EpochReadyAcceptance>, PersistenceError> {
        let fingerprint = operation_fingerprint(
            op_kind::EPOCH_READY_RECEIVE,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                ciphertext,
            ],
        )?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::EPOCH_READY_RECEIVE,
            fingerprint
        )?);
        let mut lifecycle = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        if lifecycle.pair_lifecycle != Some(PairLifecycle::WaitingForEpochReady) {
            transaction.rollback()?;
            return Err(PersistenceError::Conflict);
        }
        let expected = lifecycle
            .pending_commit
            .clone()
            .ok_or(PersistenceError::Corrupt)?;
        let mut daemon = super::load_daemon(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        let plaintext =
            daemon.receive_epoch_ready(ciphertext, logical_message_id, hosted_generation)?;
        validate_epoch_ready_payload(
            plaintext.plaintext(),
            lifecycle.crypto_session_id,
            lifecycle.group_id.ok_or(PersistenceError::Corrupt)?,
            &expected,
        )?;
        lifecycle.pair_lifecycle = Some(PairLifecycle::Active);
        lifecycle.pending_commit = None;
        daemon.endpoint.provider.insert_internal(
            DAEMON_PAIRING_KEY.to_vec(),
            encode_daemon_record(&lifecycle)?,
        );
        super::persist_endpoint_metadata(&daemon.endpoint, &daemon.endpoint.provider);
        transaction.replace_provider_values(daemon.endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(
            daemon.endpoint.epoch()?,
            &daemon.endpoint.epoch_authenticator()?,
        );
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_EPOCH_READY,
                outcome: OUTCOME_UPDATED,
                artifact_hash: expected.commit_id,
            },
        ))?;
        let request =
            transaction.commit_witnessed(TypedResult::EpochReady(EpochReadyAcceptance {
                crypto_session_id: self.store.crypto_session_id,
                commit_id: expected.commit_id,
            }))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn reset(
        &mut self,
        operation_id: Id,
    ) -> Result<WitnessOutcome<RemovalOutcome>, PersistenceError> {
        self.finish_locally(operation_id, false)
    }

    pub fn mark_revoked(
        &mut self,
        operation_id: Id,
    ) -> Result<WitnessOutcome<RemovalOutcome>, PersistenceError> {
        self.finish_locally(operation_id, true)
    }

    fn finish_locally(
        &mut self,
        operation_id: Id,
        revoked: bool,
    ) -> Result<WitnessOutcome<RemovalOutcome>, PersistenceError> {
        let kind = if revoked {
            op_kind::LOCAL_REVOCATION
        } else {
            op_kind::RESET
        };
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            kind,
            operation_fingerprint(kind, &[])?
        )?);
        let mut lifecycle = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        if lifecycle.group_id.is_none() {
            transaction.rollback()?;
            return Err(PersistenceError::Conflict);
        }
        lifecycle.pair_lifecycle = Some(if revoked {
            PairLifecycle::Revoked
        } else {
            PairLifecycle::Reset
        });
        lifecycle.pending_commit = None;
        transaction.provider.insert_internal(
            DAEMON_PAIRING_KEY.to_vec(),
            encode_daemon_record(&lifecycle)?,
        );
        transaction.keep_epoch();
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_RESET,
                outcome: if revoked {
                    OUTCOME_REMOVED
                } else {
                    OUTCOME_RESET
                },
                artifact_hash: lifecycle.accepted_claim_hash.unwrap_or([0; 48]),
            },
        ))?;
        let result = if revoked {
            RemovalOutcome::Revoked
        } else {
            RemovalOutcome::RePairRequired(re_pair_requirement(&lifecycle)?)
        };
        let request = transaction.commit_witnessed(TypedResult::Removal(result))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn close(&self) -> Result<(), PersistenceError> {
        self.store.close()
    }

    pub fn cancel(
        &mut self,
        operation_id: Id,
    ) -> Result<WitnessOutcome<InvitationLifecycle>, PersistenceError> {
        if let Some(expiry) = self.expire_if_needed()? {
            return Ok(WitnessOutcome::Pending(expiry));
        }
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::INVITATION_CANCEL,
            operation_fingerprint(op_kind::INVITATION_CANCEL, &[])?
        )?);
        let mut record = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        let now = self.store.clock.now_ms().map_err(PersistenceError::Core)?;
        if now < record.last_now_ms {
            transaction.rollback()?;
            return Err(PersistenceError::Core(crate::Error::ClockRollback));
        }
        record.last_now_ms = now;
        match record.state {
            InvitationLifecycle::Issued | InvitationLifecycle::ClaimPending => {
                record.state = InvitationLifecycle::Cancelled;
                record.pending_claim = None;
                record.accepted_claim_hash = None;
                record.accepted_result = None;
                record.reservation = None;
                record.cancellation_reason = Some(CancellationReason::Explicit);
            }
            InvitationLifecycle::Cancelled => {
                transaction.rollback()?;
                return Ok(WitnessOutcome::Released(InvitationLifecycle::Cancelled));
            }
            InvitationLifecycle::Expired => {
                transaction.rollback()?;
                return Ok(WitnessOutcome::Released(InvitationLifecycle::Expired));
            }
            InvitationLifecycle::Confirmed | InvitationLifecycle::Consumed => {
                transaction.rollback()?;
                return Err(PersistenceError::Conflict);
            }
        }
        transaction
            .provider
            .insert_internal(DAEMON_PAIRING_KEY.to_vec(), encode_daemon_record(&record)?);
        let old_epoch = transaction.old_epoch;
        let old_authenticator = transaction.old_authenticator.clone();
        transaction.set_successor_epoch(old_epoch, &old_authenticator);
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_CANCEL_INVITATION,
                outcome: OUTCOME_CANCELLED,
                artifact_hash: record.invitation_hash,
            },
        ))?;
        let request = transaction.commit_witnessed(TypedResult::InvitationLifecycle(
            InvitationLifecycle::Cancelled,
        ))?;
        Ok(WitnessOutcome::Pending(request))
    }

    /// Durably expire an unacknowledged Welcome once its deadline passes. Returns the pending
    /// request of the deterministic expiry operation, or `None` when nothing is due.
    pub fn expire_welcome_if_needed(
        &mut self,
    ) -> Result<Option<PendingWitnessRequest>, PersistenceError> {
        let (record, now) = {
            let transaction = begin_current(&self.store)?;
            let record = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
            let now = checked_pairing_now(&self.store, record.last_now_ms)?;
            transaction.rollback()?;
            (record, now)
        };
        let Some(expires_at_ms) = record.welcome_expires_at_ms else {
            return Ok(None);
        };
        if now < expires_at_ms || record.activation_accepted {
            return Ok(None);
        }
        let operation_id = expiry_operation_id(b"welcome", record.invitation_hash)?;
        let fingerprint = operation_fingerprint(
            op_kind::WELCOME_EXPIRY,
            &[&record.invitation_hash, &expires_at_ms.to_be_bytes()],
        )?;
        let mut transaction =
            match self
                .store
                .begin_witnessed(operation_id, op_kind::WELCOME_EXPIRY, fingerprint)?
            {
                Lookup::Pending(request) => return Ok(Some(request)),
                Lookup::Released(_) => return Ok(None),
                Lookup::Fresh(transaction) => transaction,
            };
        let mut record = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        record.last_now_ms = now;
        record.welcome = None;
        record.welcome_expires_at_ms = None;
        record.accepted_result = None;
        record.welcome_expired = true;
        transaction
            .provider
            .insert_internal(DAEMON_PAIRING_KEY.to_vec(), encode_daemon_record(&record)?);
        transaction.keep_epoch();
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_EXPIRE_WELCOME,
                outcome: OUTCOME_EXPIRED,
                artifact_hash: record.invitation_hash,
            },
        ))?;
        let state = record.state;
        let request = transaction.commit_witnessed(TypedResult::InvitationLifecycle(state))?;
        Ok(Some(request))
    }

    /// Durably expire the invitation once its deadline passes. Expiry is a witnessed operation
    /// with its deterministic operation ID; it cannot bypass a pending operation. Returns the
    /// pending expiry request, or `None` when nothing is due or expiry already completed.
    pub fn expire_if_needed(&mut self) -> Result<Option<PendingWitnessRequest>, PersistenceError> {
        let (record, now) = {
            let transaction = begin_current(&self.store)?;
            let record = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
            let now = self.store.clock.now_ms().map_err(PersistenceError::Core)?;
            transaction.rollback()?;
            (record, now)
        };
        if now < record.last_now_ms {
            return Err(PersistenceError::Core(crate::Error::ClockRollback));
        }
        if now < record.expires_at_ms
            || matches!(
                record.state,
                InvitationLifecycle::Consumed
                    | InvitationLifecycle::Cancelled
                    | InvitationLifecycle::Expired
            )
        {
            return Ok(None);
        }
        let operation_id = expiry_operation_id(b"daemon", record.invitation_hash)?;
        let fingerprint = operation_fingerprint(
            op_kind::INVITATION_EXPIRY,
            &[&record.invitation_hash, &record.expires_at_ms.to_be_bytes()],
        )?;
        let mut transaction = match self.store.begin_witnessed(
            operation_id,
            op_kind::INVITATION_EXPIRY,
            fingerprint,
        )? {
            Lookup::Pending(request) => return Ok(Some(request)),
            Lookup::Released(_) => return Ok(None),
            Lookup::Fresh(transaction) => *transaction,
        };
        let mut record = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        record.last_now_ms = now;
        record.state = InvitationLifecycle::Expired;
        record.pending_claim = None;
        record.accepted_claim_hash = None;
        record.accepted_result = None;
        record.reservation = None;
        transaction
            .provider
            .insert_internal(DAEMON_PAIRING_KEY.to_vec(), encode_daemon_record(&record)?);
        transaction.keep_epoch();
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_EXPIRE_INVITATION,
                outcome: OUTCOME_EXPIRED,
                artifact_hash: record.invitation_hash,
            },
        ))?;
        let request = transaction.commit_witnessed(TypedResult::InvitationLifecycle(
            InvitationLifecycle::Expired,
        ))?;
        Ok(Some(request))
    }

    #[cfg(test)]
    pub(crate) fn store(&self) -> &Arc<NativeTransactionalProvider> {
        &self.store
    }

    #[cfg(test)]
    pub(crate) fn failed_claim_count(&self) -> Result<usize, PersistenceError> {
        let transaction = begin_current(&self.store)?;
        let count = daemon_record(&transaction.provider, self.store.crypto_session_id)?
            .failed
            .len();
        transaction.rollback()?;
        Ok(count)
    }

    #[cfg(test)]
    pub(crate) fn replace_record_for_test(
        &self,
        operation_id: Id,
        bytes: &[u8],
    ) -> Result<PendingWitnessRequest, PersistenceError> {
        let mut transaction = match self.store.begin_witnessed(
            operation_id,
            op_kind::LEGACY_CREATE,
            operation_fingerprint(op_kind::LEGACY_CREATE, &[b"replace-record", bytes])?,
        )? {
            Lookup::Fresh(transaction) => *transaction,
            _ => return Err(PersistenceError::Conflict),
        };
        transaction
            .provider
            .insert_internal(DAEMON_PAIRING_KEY.to_vec(), bytes.to_vec());
        transaction.keep_epoch();
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_RESET,
                outcome: OUTCOME_RESET,
                artifact_hash: sha384(bytes).map_err(map_pairing_error)?,
            },
        ))?;
        transaction.commit_witnessed(TypedResult::Empty)
    }

    #[cfg(test)]
    pub(crate) fn rejects_shape_mutation_for_test(
        &self,
        mutation: u8,
    ) -> Result<bool, PersistenceError> {
        let transaction = begin_current(&self.store)?;
        let mut record = daemon_record(&transaction.provider, self.store.crypto_session_id)?;
        transaction.rollback()?;
        match mutation {
            1 => record.accepted_claim_hash = Some([0x41; 48]),
            2 => {
                record.accepted_claim_hash = Some([0x42; 48]);
            }
            3 => record.reservation = Some(([0x43; 16], record.expires_at_ms)),
            4 => {
                record.welcome_expired = true;
                record.accepted_result = Some(vec![0x44]);
            }
            5 => record.pair_lifecycle = Some(PairLifecycle::AwaitingActivation),
            _ => return Err(PersistenceError::Conflict),
        }
        Ok(validate_daemon_record(&record).is_err())
    }

    #[cfg(test)]
    pub(crate) fn record_bytes_for_test(&self) -> Result<Vec<u8>, PersistenceError> {
        let transaction = begin_current(&self.store)?;
        let bytes = transaction
            .provider
            .internal(DAEMON_PAIRING_KEY)
            .ok_or(PersistenceError::Corrupt)?;
        transaction.rollback()?;
        Ok(bytes)
    }

    #[cfg(test)]
    pub(crate) fn remove_record_for_test(
        &self,
        operation_id: Id,
    ) -> Result<PendingWitnessRequest, PersistenceError> {
        let mut transaction = match self.store.begin_witnessed(
            operation_id,
            op_kind::LEGACY_CREATE,
            operation_fingerprint(op_kind::LEGACY_CREATE, &[b"remove-record"])?,
        )? {
            Lookup::Fresh(transaction) => *transaction,
            _ => return Err(PersistenceError::Conflict),
        };
        transaction.provider.remove_internal(DAEMON_PAIRING_KEY);
        transaction.keep_epoch();
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_RESET,
                outcome: OUTCOME_RESET,
                artifact_hash: [0; 48],
            },
        ))?;
        transaction.commit_witnessed(TypedResult::Empty)
    }
}

impl DurablePreJoinDevice {
    pub fn prepare(
        root: &Path,
        identity: Identity,
        invitation_bytes: &[u8],
        operation_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
    ) -> Result<(Self, PendingWitnessRequest), PersistenceError> {
        Self::prepare_with_runtime_and_requirement(
            root,
            identity,
            invitation_bytes,
            operation_id,
            envelope_keys,
            trust,
            DevicePreparation {
                runtime: RuntimeHooks {
                    faults: Arc::new(NoFaults),
                    clock: Arc::new(SystemClock),
                },
                requirement: None,
            },
        )
    }

    pub fn prepare_repair(
        root: &Path,
        identity: Identity,
        invitation_bytes: &[u8],
        operation_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
        requirement: &RePairRequirement,
    ) -> Result<(Self, PendingWitnessRequest), PersistenceError> {
        Self::prepare_with_runtime_and_requirement(
            root,
            identity,
            invitation_bytes,
            operation_id,
            envelope_keys,
            trust,
            DevicePreparation {
                runtime: RuntimeHooks {
                    faults: Arc::new(NoFaults),
                    clock: Arc::new(SystemClock),
                },
                requirement: Some(requirement),
            },
        )
    }

    #[cfg(test)]
    pub(crate) fn prepare_repair_with_runtime(
        root: &Path,
        identity: Identity,
        invitation_bytes: &[u8],
        operation_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
        runtime_and_requirement: (RuntimeHooks, &RePairRequirement),
    ) -> Result<(Self, PendingWitnessRequest), PersistenceError> {
        let (runtime, requirement) = runtime_and_requirement;
        Self::prepare_with_runtime_and_requirement(
            root,
            identity,
            invitation_bytes,
            operation_id,
            envelope_keys,
            trust,
            DevicePreparation {
                runtime,
                requirement: Some(requirement),
            },
        )
    }

    #[cfg(test)]
    pub(crate) fn prepare_with_runtime(
        root: &Path,
        identity: Identity,
        invitation_bytes: &[u8],
        operation_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
        runtime: RuntimeHooks,
    ) -> Result<(Self, PendingWitnessRequest), PersistenceError> {
        Self::prepare_with_runtime_and_requirement(
            root,
            identity,
            invitation_bytes,
            operation_id,
            envelope_keys,
            trust,
            DevicePreparation {
                runtime,
                requirement: None,
            },
        )
    }

    fn prepare_with_runtime_and_requirement(
        root: &Path,
        identity: Identity,
        invitation_bytes: &[u8],
        operation_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
        preparation: DevicePreparation<'_>,
    ) -> Result<(Self, PendingWitnessRequest), PersistenceError> {
        let DevicePreparation {
            runtime,
            requirement,
        } = preparation;
        if invitation_bytes.len() > PAIRING_INVITATION_MAX_BYTES || identity.role != Role::Device {
            return Err(PersistenceError::IdentityMismatch);
        }
        let invitation = PairingInvitation::decode(invitation_bytes).map_err(map_pairing_error)?;
        let now_ms = runtime.clock.now_ms().map_err(PersistenceError::Core)?;
        invitation.verify_at(now_ms).map_err(map_pairing_error)?;
        if identity.account_id != invitation.account_id()
            || identity.installation_id != invitation.installation_id()
        {
            return Err(PersistenceError::IdentityMismatch);
        }
        let crypto_session_id = invitation.crypto_session_id();
        let store = NativeTransactionalProvider::create(
            root,
            crypto_session_id,
            envelope_keys,
            trust,
            runtime.faults,
            runtime.clock,
        )?;
        let requirement_field = requirement.map(encode_re_pair_requirement);
        let fingerprint = operation_fingerprint(
            op_kind::DEVICE_PRE_JOIN,
            &[
                &[identity.role as u8],
                &identity.account_id,
                &identity.installation_id,
                &identity.device_id,
                invitation_bytes,
                &optional_field(requirement_field.as_deref()),
            ],
        )?;
        let mut transaction =
            match store.begin_witnessed(operation_id, op_kind::DEVICE_PRE_JOIN, fingerprint)? {
                Lookup::Fresh(transaction) => *transaction,
                Lookup::Pending(_) | Lookup::Released(_) => return Err(PersistenceError::Conflict),
            };
        store.faults.check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let (phone, package) = Phone::create_at(identity.clone(), now_ms)?;
        let key_package_hash = sha384(package.bytes()).map_err(map_pairing_error)?;
        if let Some(requirement) = requirement
            && (identity.device_id == requirement.device_id
                || crypto_session_id == requirement.crypto_session_id
                || key_package_hash == requirement.key_package_hash)
        {
            return Err(PersistenceError::IdentityMismatch);
        }
        let device_credential =
            PairingCredential::new(identity.clone(), &phone.signer).map_err(map_pairing_error)?;
        let claim = PairingClaimV1::create_at(
            &invitation,
            device_credential,
            package.bytes(),
            &phone.signer,
            now_ms,
        )
        .map_err(map_pairing_error)?;
        let claim_bytes = claim.encode().map_err(map_pairing_error)?;
        let invitation_hash = invitation.invitation_hash().map_err(map_pairing_error)?;
        let record = DevicePreJoinRecord {
            state: PreJoinLifecycle::PreJoin,
            crypto_session_id,
            account_id: identity.account_id,
            installation_id: identity.installation_id,
            device_id: identity.device_id,
            invitation: invitation_bytes.to_vec(),
            invitation_hash,
            expires_at_ms: invitation.expires_at_ms(),
            last_now_ms: now_ms,
            key_package: package.bytes().to_vec(),
            claim: claim_bytes.clone(),
            group_id: None,
            welcome: None,
            welcome_expires_at_ms: None,
            activation: None,
            pair_lifecycle: None,
            pending_commit: None,
            epoch_ready_prepared: false,
            forbidden_group_id: requirement.and_then(|value| value.group_id),
        };
        super::persist_phone_metadata(&phone, &phone.provider, None, now_ms);
        phone
            .provider
            .insert_internal(DEVICE_PREJOIN_KEY.to_vec(), encode_device_record(&record)?);
        transaction.replace_provider_values(phone.provider.storage_values())?;
        transaction.set_successor_epoch(0, &[]);
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id,
                kind: OP_PREPARE_CLAIM,
                outcome: OUTCOME_PREPARED,
                artifact_hash: claim.claim_hash().map_err(map_pairing_error)?,
            },
        ))?;
        let request =
            transaction.commit_witnessed(TypedResult::PreJoin(prejoin_publication(&record)))?;
        Ok((Self { store }, request))
    }

    pub fn open(
        root: &Path,
        crypto_session_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
    ) -> Result<Self, PersistenceError> {
        Self::open_with_runtime(
            root,
            crypto_session_id,
            envelope_keys,
            trust,
            RuntimeHooks {
                faults: Arc::new(NoFaults),
                clock: Arc::new(SystemClock),
            },
        )
    }

    pub(crate) fn open_with_runtime(
        root: &Path,
        crypto_session_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
        runtime: RuntimeHooks,
    ) -> Result<Self, PersistenceError> {
        let store = NativeTransactionalProvider::open(
            root,
            crypto_session_id,
            envelope_keys,
            trust,
            runtime.faults,
            runtime.clock,
        )?;
        let transaction = begin_current(&store)?;
        let record = device_record(&transaction.provider, crypto_session_id)?;
        validate_device_state(&transaction.provider, &record, store.clock.as_ref())?;
        if matches!(
            record.state,
            PreJoinLifecycle::Joined | PreJoinLifecycle::Activated
        ) {
            let phone = super::load_phone(
                &transaction.provider,
                Arc::clone(&store.clock),
                transaction.accepted_ids.clone(),
            )?;
            let endpoint = phone.endpoint.as_ref().ok_or(PersistenceError::Corrupt)?;
            crate::validate_members(endpoint.group()?, &endpoint.peer, &endpoint.identity)?;
        }
        transaction.rollback()?;
        store.finish_opening()?;
        Ok(Self { store })
    }

    pub fn join(
        &mut self,
        operation_id: Id,
        welcome: &WelcomePublication,
    ) -> Result<WitnessOutcome<PreJoinLifecycle>, PersistenceError> {
        let fingerprint = operation_fingerprint(
            op_kind::WELCOME_JOIN,
            &[
                welcome.bytes(),
                &optional_field(Some(&welcome.group_id)),
                &optional_field(Some(&welcome.claim_hash)),
                &optional_field(Some(&welcome.expires_at_ms.to_be_bytes())),
            ],
        )?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::WELCOME_JOIN,
            fingerprint
        )?);
        let mut record = device_record(&transaction.provider, self.store.crypto_session_id)?;
        let now = checked_pairing_now(&self.store, record.last_now_ms)?;
        if now >= welcome.expires_at_ms
            || !matches!(
                record.state,
                PreJoinLifecycle::PreJoin | PreJoinLifecycle::Expired
            )
        {
            transaction.rollback()?;
            return Err(PersistenceError::Conflict);
        }
        let invitation =
            PairingInvitation::decode(&record.invitation).map_err(map_pairing_error)?;
        let claim = PairingClaimV1::decode(&record.claim).map_err(map_pairing_error)?;
        if claim.claim_hash().map_err(map_pairing_error)? != welcome.claim_hash
            || welcome.group_id == [0; 32]
            || record.forbidden_group_id == Some(welcome.group_id)
        {
            transaction.rollback()?;
            return Err(PersistenceError::IdentityMismatch);
        }
        let mut phone = super::load_phone(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        let context = PairContext {
            crypto_session_id: record.crypto_session_id,
            group_id: welcome.group_id,
            account_id: record.account_id,
            installation_id: record.installation_id,
            device_id: record.device_id,
        };
        let pair_welcome = PairWelcome {
            bytes: welcome.bytes.clone().into_boxed_slice(),
            context: context.clone(),
            daemon_identity: invitation.daemon_credential().identity().clone(),
            device_identity: claim.device_credential().identity().clone(),
        };
        self.store
            .faults
            .check(FaultPoint::BeforeOpenMlsStateWrites)?;
        phone.join(pair_welcome, &context)?;
        {
            let endpoint = phone.endpoint.as_mut().ok_or(PersistenceError::Corrupt)?;
            endpoint.clock = Arc::clone(&self.store.clock);
            endpoint.last_wall_time_ms = now;
            record.state = PreJoinLifecycle::Joined;
            record.pair_lifecycle = Some(PairLifecycle::AwaitingActivation);
            record.last_now_ms = now;
            record.group_id = Some(welcome.group_id);
            record.welcome = Some(welcome.bytes.clone());
            record.welcome_expires_at_ms = Some(welcome.expires_at_ms);
            endpoint
                .provider
                .insert_internal(DEVICE_PREJOIN_KEY.to_vec(), encode_device_record(&record)?);
        }
        let endpoint = phone.endpoint.as_ref().ok_or(PersistenceError::Corrupt)?;
        super::persist_phone_metadata(&phone, &endpoint.provider, Some(&context), 0);
        transaction.replace_provider_values(endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(endpoint.epoch()?, &endpoint.epoch_authenticator()?);
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_JOIN_WELCOME,
                outcome: OUTCOME_JOINED,
                artifact_hash: welcome.claim_hash,
            },
        ))?;
        let request = transaction
            .commit_witnessed(TypedResult::PreJoinLifecycle(PreJoinLifecycle::Joined))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn join_published_welcome(
        &mut self,
        operation_id: Id,
        welcome_bytes: &[u8],
        claim_hash: [u8; 48],
        welcome_hash: [u8; 48],
        expires_at_ms: u64,
    ) -> Result<WitnessOutcome<PreJoinLifecycle>, PersistenceError> {
        if sha384(welcome_bytes).map_err(map_pairing_error)? != welcome_hash {
            return Err(PersistenceError::IdentityMismatch);
        }
        let fingerprint = operation_fingerprint(
            op_kind::WELCOME_JOIN,
            &[
                welcome_bytes,
                &optional_field(None),
                &optional_field(Some(&claim_hash)),
                &optional_field(Some(&expires_at_ms.to_be_bytes())),
            ],
        )?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::WELCOME_JOIN,
            fingerprint
        )?);
        let mut record = device_record(&transaction.provider, self.store.crypto_session_id)?;
        let now = checked_pairing_now(&self.store, record.last_now_ms)?;
        if now >= expires_at_ms
            || expires_at_ms.saturating_sub(now) > 10 * 60 * 1_000
            || !matches!(
                record.state,
                PreJoinLifecycle::PreJoin | PreJoinLifecycle::Expired
            )
            || sha384(&record.claim).map_err(map_pairing_error)? != claim_hash
        {
            transaction.rollback()?;
            return Err(PersistenceError::IdentityMismatch);
        }
        let invitation =
            PairingInvitation::decode(&record.invitation).map_err(map_pairing_error)?;
        let mut phone = super::load_phone(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        self.store
            .faults
            .check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let context = phone.join_published_welcome(
            welcome_bytes,
            record.crypto_session_id,
            invitation.daemon_credential().identity().clone(),
            Arc::clone(&self.store.clock),
        )?;
        if record.forbidden_group_id == Some(context.group_id) {
            transaction.rollback()?;
            return Err(PersistenceError::IdentityMismatch);
        }
        {
            let endpoint = phone.endpoint.as_mut().ok_or(PersistenceError::Corrupt)?;
            endpoint.last_wall_time_ms = now;
            record.state = PreJoinLifecycle::Joined;
            record.pair_lifecycle = Some(PairLifecycle::AwaitingActivation);
            record.last_now_ms = now;
            record.group_id = Some(context.group_id);
            record.welcome = Some(welcome_bytes.to_vec());
            record.welcome_expires_at_ms = Some(expires_at_ms);
            endpoint
                .provider
                .insert_internal(DEVICE_PREJOIN_KEY.to_vec(), encode_device_record(&record)?);
        }
        let endpoint = phone.endpoint.as_ref().ok_or(PersistenceError::Corrupt)?;
        super::persist_phone_metadata(&phone, &endpoint.provider, Some(&context), 0);
        transaction.replace_provider_values(endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(endpoint.epoch()?, &endpoint.epoch_authenticator()?);
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_JOIN_WELCOME,
                outcome: OUTCOME_JOINED,
                artifact_hash: claim_hash,
            },
        ))?;
        let request = transaction
            .commit_witnessed(TypedResult::PreJoinLifecycle(PreJoinLifecycle::Joined))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn prepare_activation(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
    ) -> Result<WitnessOutcome<ActivationOutcome>, PersistenceError> {
        let fingerprint = operation_fingerprint(op_kind::ACTIVATION_SEND, &[&logical_message_id])?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::ACTIVATION_SEND,
            fingerprint
        )?);
        let mut record = device_record(&transaction.provider, self.store.crypto_session_id)?;
        if record.state != PreJoinLifecycle::Joined {
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(ActivationOutcome::Rejected));
        }
        let now = checked_pairing_now(&self.store, record.last_now_ms)?;
        if now
            >= record
                .welcome_expires_at_ms
                .ok_or(PersistenceError::Corrupt)?
        {
            transaction.rollback()?;
            return Ok(WitnessOutcome::Released(ActivationOutcome::Rejected));
        }
        let group_id = record.group_id.ok_or(PersistenceError::Corrupt)?;
        let claim_hash = sha384(&record.claim).map_err(map_pairing_error)?;
        let payload = activation_payload(record.crypto_session_id, claim_hash, group_id);
        let mut phone = super::load_phone(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        let envelope = phone.prepare_pair_activation(logical_message_id, &payload)?;
        let endpoint = phone.endpoint.as_ref().ok_or(PersistenceError::Corrupt)?;
        record.last_now_ms = now;
        record.activation = Some(envelope.ciphertext().to_vec());
        endpoint
            .provider
            .insert_internal(DEVICE_PREJOIN_KEY.to_vec(), encode_device_record(&record)?);
        super::persist_phone_metadata(&phone, &endpoint.provider, Some(&endpoint.context), 0);
        transaction.replace_provider_values(endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(endpoint.epoch()?, &endpoint.epoch_authenticator()?);
        transaction.stage_envelope(&envelope)?;
        let request = transaction.commit_witnessed(TypedResult::Envelope(
            super::envelope_record(operation_id, &envelope),
        ))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn acknowledge_activation(
        &mut self,
        operation_id: Id,
        acceptance: &ActivationAcceptance,
    ) -> Result<WitnessOutcome<PairLifecycle>, PersistenceError> {
        let fingerprint = operation_fingerprint(
            op_kind::ACTIVATION_ACK,
            &[
                &acceptance.crypto_session_id,
                &acceptance.group_id,
                &acceptance.claim_hash,
                &acceptance.activation_hash,
            ],
        )?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::ACTIVATION_ACK,
            fingerprint
        )?);
        let mut record = device_record(&transaction.provider, self.store.crypto_session_id)?;
        let activation = record
            .activation
            .as_deref()
            .ok_or(PersistenceError::Conflict)?;
        let activation_hash = sha384(activation).map_err(map_pairing_error)?;
        let claim_hash = sha384(&record.claim).map_err(map_pairing_error)?;
        if record.state != PreJoinLifecycle::Joined
            || record.pair_lifecycle != Some(PairLifecycle::AwaitingActivation)
            || acceptance.crypto_session_id != record.crypto_session_id
            || acceptance.group_id != record.group_id.ok_or(PersistenceError::Corrupt)?
            || acceptance.claim_hash != claim_hash
            || acceptance.activation_hash != activation_hash
        {
            transaction.rollback()?;
            return Err(PersistenceError::IdentityMismatch);
        }
        record.state = PreJoinLifecycle::Activated;
        record.pair_lifecycle = Some(PairLifecycle::Active);
        transaction
            .provider
            .insert_internal(DEVICE_PREJOIN_KEY.to_vec(), encode_device_record(&record)?);
        transaction.keep_epoch();
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_ACCEPT_ACTIVATION,
                outcome: OUTCOME_ACTIVATED,
                artifact_hash: activation_hash,
            },
        ))?;
        let request =
            transaction.commit_witnessed(TypedResult::PairLifecycle(PairLifecycle::Active))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn prepare_application(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        plaintext: &[u8],
    ) -> Result<WitnessOutcome<super::OutboxRecord>, PersistenceError> {
        super::DurablePhone {
            store: Arc::clone(&self.store),
        }
        .prepare_application_guarded(
            operation_id,
            logical_message_id,
            hosted_generation,
            plaintext,
            &self.active_precondition(),
        )
    }

    pub fn receive_application(
        &mut self,
        operation_id: Id,
        ciphertext: &[u8],
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<super::DurablePlaintext>, PersistenceError> {
        super::DurablePhone {
            store: Arc::clone(&self.store),
        }
        .receive_application_guarded(
            operation_id,
            ciphertext,
            logical_message_id,
            hosted_generation,
            &self.active_precondition(),
        )
    }

    pub fn pending_outbox(&self) -> Result<Vec<super::OutboxRecord>, PersistenceError> {
        self.store.pending_outbox()
    }

    pub fn acknowledge_outbox(
        &mut self,
        acknowledgement_operation_id: Id,
        outbox_operation_id: Id,
    ) -> Result<WitnessOutcome<super::OutboxRecord>, PersistenceError> {
        super::acknowledge_outbox(
            &self.store,
            acknowledgement_operation_id,
            outbox_operation_id,
        )
    }

    pub fn acknowledge_receive(
        &mut self,
        acknowledgement_operation_id: Id,
        receive_operation_id: Id,
    ) -> Result<WitnessOutcome<super::AcceptedMessageRecord>, PersistenceError> {
        super::acknowledge_receive(
            &self.store,
            acknowledgement_operation_id,
            receive_operation_id,
        )
    }

    /// Runner precondition on the committed pair record. The runner evaluates it on the fresh
    /// transaction only after terminal state, the pending barrier, exact duplicates, and same-ID
    /// conflicts have been resolved, so it can never preempt quarantine or duplicate replay.
    fn active_precondition(&self) -> impl Fn(&super::CoreProvider) -> Result<(), PersistenceError> {
        let crypto_session_id = self.store.crypto_session_id;
        move |provider| {
            if device_record(provider, crypto_session_id)?.pair_lifecycle
                == Some(PairLifecycle::Active)
            {
                Ok(())
            } else {
                Err(PersistenceError::Conflict)
            }
        }
    }

    pub fn pair_lifecycle(&self) -> Result<Option<PairLifecycle>, PersistenceError> {
        self.store.require_no_pending()?;
        let transaction = begin_current(&self.store)?;
        let state =
            device_record(&transaction.provider, self.store.crypto_session_id)?.pair_lifecycle;
        transaction.rollback()?;
        Ok(state)
    }

    pub fn prepare_replacement(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<super::OutboxRecord>, PersistenceError> {
        let fingerprint = operation_fingerprint(
            op_kind::PROPOSAL_SEND,
            &[&logical_message_id, &hosted_generation.to_be_bytes()],
        )?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::PROPOSAL_SEND,
            fingerprint
        )?);
        let mut lifecycle = device_record(&transaction.provider, self.store.crypto_session_id)?;
        if lifecycle.pair_lifecycle != Some(PairLifecycle::Active) {
            transaction.rollback()?;
            return Err(PersistenceError::Conflict);
        }
        let mut phone = super::load_phone(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        let envelope = phone.prepare_self_update(logical_message_id, hosted_generation)?;
        let endpoint = phone.endpoint.as_ref().ok_or(PersistenceError::Corrupt)?;
        lifecycle.pair_lifecycle = Some(PairLifecycle::ReplacementProposed);
        endpoint.provider.insert_internal(
            DEVICE_PREJOIN_KEY.to_vec(),
            encode_device_record(&lifecycle)?,
        );
        super::persist_phone_metadata(&phone, &endpoint.provider, Some(&endpoint.context), 0);
        transaction.replace_provider_values(endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(endpoint.epoch()?, &endpoint.epoch_authenticator()?);
        transaction.stage_envelope(&envelope)?;
        let request = transaction.commit_witnessed(TypedResult::Envelope(
            super::envelope_record(operation_id, &envelope),
        ))?;
        Ok(WitnessOutcome::Pending(request))
    }

    /// Apply a typed commit record. Exactly one OpenMLS transition; the epoch-ready message is a
    /// separate operation (`prepare_epoch_ready`).
    pub fn apply_update_commit(
        &mut self,
        operation_id: Id,
        commit: &super::OutboxRecord,
        commit_logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<CommitMetadata>, PersistenceError> {
        let expected = commit.commit.as_ref().ok_or(PersistenceError::Corrupt)?;
        self.apply_update_commit_inner(
            operation_id,
            &commit.ciphertext,
            commit_logical_message_id,
            hosted_generation,
            Some(expected),
        )
    }

    /// Apply received commit ciphertext. Exactly one OpenMLS transition.
    pub fn apply_received_update_commit(
        &mut self,
        operation_id: Id,
        ciphertext: &[u8],
        commit_logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<CommitMetadata>, PersistenceError> {
        self.apply_update_commit_inner(
            operation_id,
            ciphertext,
            commit_logical_message_id,
            hosted_generation,
            None,
        )
    }

    fn apply_update_commit_inner(
        &mut self,
        operation_id: Id,
        ciphertext: &[u8],
        commit_logical_message_id: Id,
        hosted_generation: u64,
        expected: Option<&CommitMetadata>,
    ) -> Result<WitnessOutcome<CommitMetadata>, PersistenceError> {
        let expected_field = expected.map(encode_commit_metadata);
        let fingerprint = operation_fingerprint(
            op_kind::COMMIT_APPLY,
            &[
                &commit_logical_message_id,
                &hosted_generation.to_be_bytes(),
                ciphertext,
                &optional_field(expected_field.as_deref()),
            ],
        )?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::COMMIT_APPLY,
            fingerprint
        )?);
        let mut lifecycle = device_record(&transaction.provider, self.store.crypto_session_id)?;
        if lifecycle.pair_lifecycle != Some(PairLifecycle::ReplacementProposed) {
            transaction.rollback()?;
            return Err(PersistenceError::Conflict);
        }
        let mut phone = super::load_phone(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        self.store
            .faults
            .check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let metadata =
            phone.apply_commit(ciphertext, commit_logical_message_id, hosted_generation)?;
        if expected.is_some_and(|value| value != &metadata) {
            transaction.rollback()?;
            return Err(PersistenceError::IdentityMismatch);
        }
        phone.continue_pending_transaction()?;
        let endpoint = phone.endpoint.as_ref().ok_or(PersistenceError::Corrupt)?;
        lifecycle.pair_lifecycle = Some(PairLifecycle::WaitingForEpochReady);
        lifecycle.pending_commit = Some(metadata.clone());
        lifecycle.epoch_ready_prepared = false;
        endpoint.provider.insert_internal(
            DEVICE_PREJOIN_KEY.to_vec(),
            encode_device_record(&lifecycle)?,
        );
        super::persist_phone_metadata(&phone, &endpoint.provider, Some(&endpoint.context), 0);
        transaction.replace_provider_values(endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(endpoint.epoch()?, &endpoint.epoch_authenticator()?);
        transaction.stage_accepted_record(super::AcceptedMessageRecord {
            operation_id,
            crypto_session_id: self.store.crypto_session_id,
            logical_message_id: commit_logical_message_id,
            class: crate::MessageClass::Commit,
            epoch: endpoint.epoch()?,
            profile_revision: PROFILE_REVISION,
            acknowledged: true,
        })?;
        let request = transaction.commit_witnessed(TypedResult::Commit(metadata))?;
        Ok(WitnessOutcome::Pending(request))
    }

    /// Create the epoch-ready message for the applied commit. Exactly one OpenMLS application
    /// send. It requires the commit to be applied and refuses a second epoch-ready under another
    /// operation ID.
    pub fn prepare_epoch_ready(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        commit: &CommitMetadata,
    ) -> Result<WitnessOutcome<super::OutboxRecord>, PersistenceError> {
        let fingerprint = operation_fingerprint(
            op_kind::EPOCH_READY_SEND,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                &encode_commit_metadata(commit),
            ],
        )?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::EPOCH_READY_SEND,
            fingerprint
        )?);
        let mut lifecycle = device_record(&transaction.provider, self.store.crypto_session_id)?;
        if lifecycle.pair_lifecycle != Some(PairLifecycle::WaitingForEpochReady)
            || lifecycle.pending_commit.as_ref() != Some(commit)
            || lifecycle.epoch_ready_prepared
        {
            transaction.rollback()?;
            return Err(PersistenceError::Conflict);
        }
        let mut phone = super::load_phone(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        let payload = epoch_ready_payload(
            lifecycle.crypto_session_id,
            lifecycle.group_id.ok_or(PersistenceError::Corrupt)?,
            commit,
        );
        self.store
            .faults
            .check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let envelope =
            phone.prepare_epoch_ready(logical_message_id, hosted_generation, &payload)?;
        let endpoint = phone.endpoint.as_ref().ok_or(PersistenceError::Corrupt)?;
        lifecycle.epoch_ready_prepared = true;
        endpoint.provider.insert_internal(
            DEVICE_PREJOIN_KEY.to_vec(),
            encode_device_record(&lifecycle)?,
        );
        super::persist_phone_metadata(&phone, &endpoint.provider, Some(&endpoint.context), 0);
        transaction.replace_provider_values(endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(endpoint.epoch()?, &endpoint.epoch_authenticator()?);
        transaction.stage_envelope(&envelope)?;
        let request = transaction.commit_witnessed(TypedResult::Envelope(
            super::envelope_record(operation_id, &envelope),
        ))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn accept_epoch_ready_confirmation(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        ciphertext: &[u8],
    ) -> Result<WitnessOutcome<PairLifecycle>, PersistenceError> {
        let fingerprint = operation_fingerprint(
            op_kind::EPOCH_READY_CONFIRM_RECEIVE,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                ciphertext,
            ],
        )?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::EPOCH_READY_CONFIRM_RECEIVE,
            fingerprint
        )?);
        let mut lifecycle = device_record(&transaction.provider, self.store.crypto_session_id)?;
        let pending = lifecycle
            .pending_commit
            .clone()
            .ok_or(PersistenceError::Conflict)?;
        if lifecycle.pair_lifecycle != Some(PairLifecycle::WaitingForEpochReady) {
            transaction.rollback()?;
            return Err(PersistenceError::Conflict);
        }
        let mut phone = super::load_phone(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        let plaintext =
            phone.receive_resync_control(ciphertext, logical_message_id, hosted_generation)?;
        validate_epoch_ready_acceptance_payload(
            plaintext.plaintext(),
            lifecycle.crypto_session_id,
            &pending,
        )?;
        lifecycle.pair_lifecycle = Some(PairLifecycle::Active);
        lifecycle.pending_commit = None;
        lifecycle.epoch_ready_prepared = false;
        let endpoint = phone.endpoint.as_ref().ok_or(PersistenceError::Corrupt)?;
        endpoint.provider.insert_internal(
            DEVICE_PREJOIN_KEY.to_vec(),
            encode_device_record(&lifecycle)?,
        );
        super::persist_phone_metadata(&phone, &endpoint.provider, Some(&endpoint.context), 0);
        transaction.replace_provider_values(endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(endpoint.epoch()?, &endpoint.epoch_authenticator()?);
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_CONFIRM_EPOCH_READY,
                outcome: OUTCOME_UPDATED,
                artifact_hash: pending.commit_id,
            },
        ))?;
        let request =
            transaction.commit_witnessed(TypedResult::PairLifecycle(PairLifecycle::Active))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn acknowledge_epoch_ready(
        &mut self,
        operation_id: Id,
        acceptance: &EpochReadyAcceptance,
    ) -> Result<WitnessOutcome<PairLifecycle>, PersistenceError> {
        let fingerprint = operation_fingerprint(
            op_kind::EPOCH_READY_ACK,
            &[&acceptance.crypto_session_id, &acceptance.commit_id],
        )?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::EPOCH_READY_ACK,
            fingerprint
        )?);
        let mut lifecycle = device_record(&transaction.provider, self.store.crypto_session_id)?;
        let pending = lifecycle
            .pending_commit
            .as_ref()
            .ok_or(PersistenceError::Conflict)?;
        if lifecycle.pair_lifecycle != Some(PairLifecycle::WaitingForEpochReady)
            || acceptance.crypto_session_id != lifecycle.crypto_session_id
            || acceptance.commit_id != pending.commit_id
        {
            transaction.rollback()?;
            return Err(PersistenceError::IdentityMismatch);
        }
        lifecycle.pair_lifecycle = Some(PairLifecycle::Active);
        lifecycle.pending_commit = None;
        lifecycle.epoch_ready_prepared = false;
        transaction.provider.insert_internal(
            DEVICE_PREJOIN_KEY.to_vec(),
            encode_device_record(&lifecycle)?,
        );
        transaction.keep_epoch();
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_EPOCH_READY,
                outcome: OUTCOME_UPDATED,
                artifact_hash: acceptance.commit_id,
            },
        ))?;
        let request =
            transaction.commit_witnessed(TypedResult::PairLifecycle(PairLifecycle::Active))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn apply_removal(
        &mut self,
        operation_id: Id,
        commit: &super::OutboxRecord,
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<RemovalOutcome>, PersistenceError> {
        let commit_field = commit.commit.as_ref().map(encode_commit_metadata);
        let fingerprint = operation_fingerprint(
            op_kind::REMOVAL_APPLY,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                &commit.ciphertext,
                &optional_field(commit_field.as_deref()),
            ],
        )?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::REMOVAL_APPLY,
            fingerprint
        )?);
        let mut lifecycle = device_record(&transaction.provider, self.store.crypto_session_id)?;
        if !matches!(
            lifecycle.pair_lifecycle,
            Some(PairLifecycle::Active | PairLifecycle::ReplacementProposed)
        ) {
            transaction.rollback()?;
            return Err(PersistenceError::Conflict);
        }
        let mut phone = super::load_phone(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        phone.apply_removal(&commit.ciphertext, logical_message_id, hosted_generation)?;
        let endpoint = phone.endpoint.as_ref().ok_or(PersistenceError::Corrupt)?;
        lifecycle.state = PreJoinLifecycle::Removed;
        lifecycle.pair_lifecycle = Some(PairLifecycle::Removed);
        lifecycle.pending_commit = None;
        lifecycle.epoch_ready_prepared = false;
        endpoint.provider.insert_internal(
            DEVICE_PREJOIN_KEY.to_vec(),
            encode_device_record(&lifecycle)?,
        );
        super::persist_phone_metadata(&phone, &endpoint.provider, Some(&endpoint.context), 0);
        transaction.replace_provider_values(endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(endpoint.epoch()?, &endpoint.epoch_authenticator()?);
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_APPLY_REMOVAL,
                outcome: OUTCOME_REMOVED,
                artifact_hash: commit
                    .commit
                    .as_ref()
                    .map(|metadata| metadata.commit_id)
                    .ok_or(PersistenceError::Corrupt)?,
            },
        ))?;
        let request =
            transaction.commit_witnessed(TypedResult::Removal(RemovalOutcome::Removed))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn reset(
        &mut self,
        operation_id: Id,
    ) -> Result<WitnessOutcome<RePairRequirement>, PersistenceError> {
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::RESET,
            operation_fingerprint(op_kind::RESET, &[])?
        )?);
        let mut lifecycle = device_record(&transaction.provider, self.store.crypto_session_id)?;
        let group_id = lifecycle.group_id;
        let key_package_hash = sha384(&lifecycle.key_package).map_err(map_pairing_error)?;
        lifecycle.state = PreJoinLifecycle::Reset;
        lifecycle.pair_lifecycle = Some(PairLifecycle::Reset);
        lifecycle.pending_commit = None;
        lifecycle.epoch_ready_prepared = false;
        transaction.provider.insert_internal(
            DEVICE_PREJOIN_KEY.to_vec(),
            encode_device_record(&lifecycle)?,
        );
        transaction.keep_epoch();
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_RESET,
                outcome: OUTCOME_RESET,
                artifact_hash: lifecycle.invitation_hash,
            },
        ))?;
        let request = transaction.commit_witnessed(TypedResult::RePair(RePairRequirement {
            device_id: lifecycle.device_id,
            crypto_session_id: lifecycle.crypto_session_id,
            group_id,
            key_package_hash,
        }))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn close(&self) -> Result<(), PersistenceError> {
        self.store.close()
    }

    /// Read-only. Returns the committed claim and KeyPackage; it does not persist a due expiry.
    /// An interrupted initial registration keeps them withheld.
    pub fn publication(&mut self) -> Result<PreJoinPublication, PersistenceError> {
        self.store.require_published()?;
        self.store.require_no_pending()?;
        let transaction = begin_current(&self.store)?;
        let record = device_record(&transaction.provider, self.store.crypto_session_id)?;
        let result = if record.state == PreJoinLifecycle::PreJoin {
            Ok(prejoin_publication(&record))
        } else {
            Err(PersistenceError::Conflict)
        };
        transaction.rollback()?;
        result
    }

    /// Read-only committed lifecycle. A due but not yet witnessed expiry is not reported here.
    pub fn lifecycle(&mut self) -> Result<PreJoinLifecycle, PersistenceError> {
        self.store.require_no_pending()?;
        let transaction = begin_current(&self.store)?;
        let state = device_record(&transaction.provider, self.store.crypto_session_id)?.state;
        transaction.rollback()?;
        Ok(state)
    }

    /// Durably expire the pre-join state once the invitation deadline passes. Returns the
    /// pending expiry request, or `None` when nothing is due or expiry already completed.
    pub fn expire_if_needed(&mut self) -> Result<Option<PendingWitnessRequest>, PersistenceError> {
        let (record, now) = {
            let transaction = begin_current(&self.store)?;
            let record = device_record(&transaction.provider, self.store.crypto_session_id)?;
            let now = self.store.clock.now_ms().map_err(PersistenceError::Core)?;
            transaction.rollback()?;
            (record, now)
        };
        if now < record.last_now_ms {
            return Err(PersistenceError::Core(crate::Error::ClockRollback));
        }
        if now < record.expires_at_ms || record.state != PreJoinLifecycle::PreJoin {
            return Ok(None);
        }
        let operation_id = expiry_operation_id(b"device", record.invitation_hash)?;
        let fingerprint = operation_fingerprint(
            op_kind::PRE_JOIN_EXPIRY,
            &[&record.invitation_hash, &record.expires_at_ms.to_be_bytes()],
        )?;
        let mut transaction =
            match self
                .store
                .begin_witnessed(operation_id, op_kind::PRE_JOIN_EXPIRY, fingerprint)?
            {
                Lookup::Pending(request) => return Ok(Some(request)),
                Lookup::Released(_) => return Ok(None),
                Lookup::Fresh(transaction) => transaction,
            };
        let mut record = device_record(&transaction.provider, self.store.crypto_session_id)?;
        record.last_now_ms = now;
        record.state = PreJoinLifecycle::Expired;
        transaction
            .provider
            .insert_internal(DEVICE_PREJOIN_KEY.to_vec(), encode_device_record(&record)?);
        transaction.keep_epoch();
        transaction.stage_operation(super::CommittedOperation::Pairing(
            PairingOperationRecord {
                operation_id,
                crypto_session_id: self.store.crypto_session_id,
                kind: OP_EXPIRE_PREJOIN,
                outcome: OUTCOME_EXPIRED,
                artifact_hash: record.invitation_hash,
            },
        ))?;
        let request = transaction
            .commit_witnessed(TypedResult::PreJoinLifecycle(PreJoinLifecycle::Expired))?;
        Ok(Some(request))
    }

    #[cfg(test)]
    pub(crate) fn store(&self) -> &Arc<NativeTransactionalProvider> {
        &self.store
    }

    #[cfg(test)]
    pub(crate) fn last_now_ms_for_test(&self) -> Result<u64, PersistenceError> {
        let transaction = begin_current(&self.store)?;
        let now = device_record(&transaction.provider, self.store.crypto_session_id)?.last_now_ms;
        transaction.rollback()?;
        Ok(now)
    }
}

fn checked_pairing_now(
    store: &NativeTransactionalProvider,
    last_now_ms: u64,
) -> Result<u64, PersistenceError> {
    let now = store.clock.now_ms().map_err(PersistenceError::Core)?;
    if now < last_now_ms {
        return Err(PersistenceError::Core(crate::Error::ClockRollback));
    }
    Ok(now)
}

fn re_pair_requirement(
    record: &DaemonPairingRecord,
) -> Result<RePairRequirement, PersistenceError> {
    Ok(RePairRequirement {
        device_id: record
            .pending_claim
            .as_ref()
            .and_then(|(_, bytes)| PairingClaimV1::decode(bytes).ok())
            .map(|claim| claim.device_credential().identity().device_id)
            .ok_or(PersistenceError::Corrupt)?,
        crypto_session_id: record.crypto_session_id,
        group_id: record.group_id,
        key_package_hash: record
            .pending_claim
            .as_ref()
            .and_then(|(_, bytes)| PairingClaimV1::decode(bytes).ok())
            .and_then(|claim| sha384(claim.key_package()).ok())
            .ok_or(PersistenceError::Corrupt)?,
    })
}

fn reservation_intent(record: &DaemonPairingRecord) -> Result<ReservationIntent, PersistenceError> {
    let (reservation_id, expires_at_ms) = record.reservation.ok_or(PersistenceError::Corrupt)?;
    let (claim_hash, claim_bytes) = record
        .pending_claim
        .as_ref()
        .ok_or(PersistenceError::Corrupt)?;
    if record.accepted_claim_hash != Some(*claim_hash) {
        return Err(PersistenceError::Corrupt);
    }
    let claim = PairingClaimV1::decode(claim_bytes).map_err(map_pairing_error)?;
    Ok(ReservationIntent {
        reservation_id,
        crypto_session_id: record.crypto_session_id,
        account_id: record.account_id,
        installation_id: record.installation_id,
        device_id: claim.device_credential().identity().device_id,
        claim_hash: *claim_hash,
        key_package_hash: sha384(claim.key_package()).map_err(map_pairing_error)?,
        expires_at_ms,
    })
}

fn encode_reservation_intent(intent: &ReservationIntent) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 * 5 + 48 * 2 + 8);
    out.extend_from_slice(&intent.reservation_id);
    out.extend_from_slice(&intent.crypto_session_id);
    out.extend_from_slice(&intent.account_id);
    out.extend_from_slice(&intent.installation_id);
    out.extend_from_slice(&intent.device_id);
    out.extend_from_slice(&intent.claim_hash);
    out.extend_from_slice(&intent.key_package_hash);
    out.extend_from_slice(&intent.expires_at_ms.to_be_bytes());
    out
}

fn welcome_is_expired(record: &DaemonPairingRecord, now_ms: u64) -> Result<bool, PersistenceError> {
    if record.state != InvitationLifecycle::Consumed || record.activation_accepted {
        return Ok(false);
    }
    if record.welcome_expired {
        return Ok(true);
    }
    let expires_at_ms = record
        .welcome_expires_at_ms
        .ok_or(PersistenceError::Corrupt)?;
    Ok(now_ms >= expires_at_ms)
}

fn welcome_publication(record: &DaemonPairingRecord) -> Option<WelcomePublication> {
    Some(WelcomePublication {
        bytes: record.welcome.clone()?,
        group_id: record.group_id?,
        claim_hash: record.accepted_claim_hash?,
        expires_at_ms: record.welcome_expires_at_ms?,
    })
}

fn activation_acceptance(
    record: &DaemonPairingRecord,
    activation_hash: [u8; 48],
) -> Result<ActivationAcceptance, PersistenceError> {
    if !record.activation_accepted || record.activation_hash != Some(activation_hash) {
        return Err(PersistenceError::Corrupt);
    }
    Ok(ActivationAcceptance {
        crypto_session_id: record.crypto_session_id,
        group_id: record.group_id.ok_or(PersistenceError::Corrupt)?,
        claim_hash: record
            .accepted_claim_hash
            .ok_or(PersistenceError::Corrupt)?,
        activation_hash,
    })
}

fn activation_payload(crypto_session_id: Id, claim_hash: [u8; 48], group_id: [u8; 32]) -> Vec<u8> {
    crate::pairing::pair_activation_payload(crypto_session_id, claim_hash, group_id)
}

fn validate_activation_payload(
    bytes: &[u8],
    crypto_session_id: Id,
    claim_hash: [u8; 48],
    group_id: [u8; 32],
) -> Result<(), PersistenceError> {
    if bytes != activation_payload(crypto_session_id, claim_hash, group_id) {
        return Err(PersistenceError::IdentityMismatch);
    }
    Ok(())
}

fn validate_epoch_ready_payload(
    bytes: &[u8],
    crypto_session_id: Id,
    group_id: [u8; 32],
    commit: &CommitMetadata,
) -> Result<(), PersistenceError> {
    if bytes != epoch_ready_payload(crypto_session_id, group_id, commit) {
        return Err(PersistenceError::IdentityMismatch);
    }
    Ok(())
}

fn epoch_ready_acceptance_payload(acceptance: &EpochReadyAcceptance) -> Vec<u8> {
    let mut out = b"Axl epoch ready accepted v1".to_vec();
    out.extend_from_slice(&PROFILE_REVISION.to_be_bytes());
    out.extend_from_slice(&acceptance.crypto_session_id);
    out.extend_from_slice(&acceptance.commit_id);
    out
}

fn validate_epoch_ready_acceptance_payload(
    bytes: &[u8],
    crypto_session_id: Id,
    commit: &CommitMetadata,
) -> Result<(), PersistenceError> {
    let expected = EpochReadyAcceptance {
        crypto_session_id,
        commit_id: commit.commit_id,
    };
    if bytes != epoch_ready_acceptance_payload(&expected) {
        return Err(PersistenceError::IdentityMismatch);
    }
    Ok(())
}

fn publication(record: &DaemonPairingRecord) -> InvitationPublication {
    InvitationPublication {
        bytes: record.invitation.clone(),
        invitation_hash: record.invitation_hash,
        expires_at_ms: record.expires_at_ms,
    }
}

fn prejoin_publication(record: &DevicePreJoinRecord) -> PreJoinPublication {
    PreJoinPublication {
        claim: record.claim.clone(),
        key_package: record.key_package.clone(),
        invitation_hash: record.invitation_hash,
        expires_at_ms: record.expires_at_ms,
    }
}

fn failed_result(failed: &FailedClaim) -> Result<ClaimSubmission, PersistenceError> {
    match failed.outcome {
        OUTCOME_CANCELLED => Ok(ClaimSubmission::Cancelled),
        value if value == outcome_for_failure(failed.reason) => Ok(ClaimSubmission::Rejected {
            reason: Some(failed.reason),
        }),
        _ => Err(PersistenceError::Corrupt),
    }
}

pub(super) fn validate_pairing_operation_kind(
    kind: u8,
    outcome: u8,
) -> Result<(), PersistenceError> {
    let valid = match kind {
        OP_ISSUE_INVITATION => outcome == OUTCOME_ISSUED,
        OP_PREPARE_CLAIM => outcome == OUTCOME_PREPARED,
        OP_SUBMIT_CLAIM => matches!(
            outcome,
            OUTCOME_PENDING
                | OUTCOME_REJECTED_CREDENTIAL
                | OUTCOME_REJECTED_KEY_PACKAGE
                | OUTCOME_REJECTED_SIGNATURE
                | OUTCOME_CANCELLED
                | OUTCOME_CONFLICT
        ),
        OP_CANCEL_INVITATION => outcome == OUTCOME_CANCELLED,
        OP_EXPIRE_INVITATION | OP_EXPIRE_PREJOIN | OP_EXPIRE_WELCOME => outcome == OUTCOME_EXPIRED,
        OP_CONFIRM_CLAIM => matches!(
            outcome,
            OUTCOME_RESERVED
                | OUTCOME_CONFLICT
                | OUTCOME_EXPIRED
                | OUTCOME_WELCOME
                | OUTCOME_REJECTED_CREDENTIAL
                | OUTCOME_REJECTED_KEY_PACKAGE
        ),
        OP_CREATE_WELCOME => outcome == OUTCOME_WELCOME,
        OP_JOIN_WELCOME => outcome == OUTCOME_JOINED,
        OP_ACCEPT_ACTIVATION => outcome == OUTCOME_ACTIVATED,
        OP_EPOCH_READY | OP_CONFIRM_EPOCH_READY => outcome == OUTCOME_UPDATED,
        OP_APPLY_REMOVAL => outcome == OUTCOME_REMOVED,
        OP_RESET => matches!(outcome, OUTCOME_REMOVED | OUTCOME_RESET),
        OP_RELEASE_RESERVATION => outcome == OUTCOME_REJECTED_KEY_PACKAGE,
        // These operations persist Envelope or Accepted records, never Pairing records.
        OP_CREATE_ACTIVATION | OP_SELF_UPDATE | OP_ACCEPT_UPDATE | OP_UPDATE_COMMIT
        | OP_APPLY_COMMIT | OP_REMOVE => false,
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(PersistenceError::Corrupt)
    }
}

fn outcome_for_failure(reason: ClaimFailure) -> u8 {
    match reason {
        ClaimFailure::Credential => OUTCOME_REJECTED_CREDENTIAL,
        ClaimFailure::KeyPackage => OUTCOME_REJECTED_KEY_PACKAGE,
        ClaimFailure::Signature => OUTCOME_REJECTED_SIGNATURE,
    }
}

fn daemon_record(
    provider: &CoreProvider,
    crypto_session_id: Id,
) -> Result<DaemonPairingRecord, PersistenceError> {
    let bytes = provider
        .internal(DAEMON_PAIRING_KEY)
        .ok_or(PersistenceError::Corrupt)?;
    let record = decode_daemon_record(&bytes)?;
    if record.crypto_session_id != crypto_session_id {
        return Err(PersistenceError::IdentityMismatch);
    }
    Ok(record)
}

fn device_record(
    provider: &CoreProvider,
    crypto_session_id: Id,
) -> Result<DevicePreJoinRecord, PersistenceError> {
    let bytes = provider
        .internal(DEVICE_PREJOIN_KEY)
        .ok_or(PersistenceError::Corrupt)?;
    let record = decode_device_record(&bytes)?;
    if record.crypto_session_id != crypto_session_id {
        return Err(PersistenceError::IdentityMismatch);
    }
    Ok(record)
}

fn validate_daemon_signer(
    provider: &CoreProvider,
    record: &DaemonPairingRecord,
) -> Result<(), PersistenceError> {
    let invitation = PairingInvitation::decode(&record.invitation).map_err(map_pairing_error)?;
    invitation.verify_signature().map_err(map_pairing_error)?;
    let credential = invitation.daemon_credential();
    SignatureKeyPair::read(
        provider.storage(),
        credential.verification_key(),
        crate::SUITE.signature_algorithm(),
    )
    .ok_or(PersistenceError::Corrupt)?;
    Ok(())
}

fn validate_device_state(
    provider: &CoreProvider,
    record: &DevicePreJoinRecord,
    clock: &dyn crate::Clock,
) -> Result<(), PersistenceError> {
    let metadata = super::decode_endpoint_metadata(
        &provider
            .internal(super::ENDPOINT_METADATA_KEY)
            .ok_or(PersistenceError::Corrupt)?,
    )?;
    let context_matches = match (&metadata.context, record.state) {
        (
            None,
            PreJoinLifecycle::PreJoin
            | PreJoinLifecycle::Expired
            | PreJoinLifecycle::Cancelled
            | PreJoinLifecycle::Reset,
        ) => record.group_id.is_none(),
        (
            Some(context),
            PreJoinLifecycle::Joined
            | PreJoinLifecycle::Activated
            | PreJoinLifecycle::Removed
            | PreJoinLifecycle::Reset,
        ) => {
            record.group_id == Some(context.group_id)
                && context.crypto_session_id == record.crypto_session_id
                && context.account_id == record.account_id
                && context.installation_id == record.installation_id
                && context.device_id == record.device_id
        }
        _ => false,
    };
    if !context_matches
        || metadata.identity.role != Role::Device
        || metadata.identity.account_id != record.account_id
        || metadata.identity.installation_id != record.installation_id
        || metadata.identity.device_id != record.device_id
    {
        return Err(PersistenceError::IdentityMismatch);
    }
    if clock.now_ms().map_err(PersistenceError::Core)? < metadata.last_wall_time_ms {
        return Err(PersistenceError::Core(crate::Error::ClockRollback));
    }
    SignatureKeyPair::read(
        provider.storage(),
        &metadata.signer_public,
        crate::SUITE.signature_algorithm(),
    )
    .ok_or(PersistenceError::Corrupt)?;
    let invitation = PairingInvitation::decode(&record.invitation).map_err(map_pairing_error)?;
    let claim = PairingClaimV1::decode(&record.claim).map_err(map_pairing_error)?;
    if invitation.invitation_hash().map_err(map_pairing_error)? != record.invitation_hash
        || claim.key_package() != record.key_package
        || claim.crypto_session_id() != record.crypto_session_id
        || claim.device_credential().identity() != &metadata.identity
    {
        return Err(PersistenceError::IdentityMismatch);
    }
    claim
        .verify_signature_and_bindings(&invitation)
        .map_err(map_pairing_error)
}

fn expiry_operation_id(label: &[u8], invitation_hash: [u8; 48]) -> Result<Id, PersistenceError> {
    let mut input = b"Axl pairing expiry operation v1".to_vec();
    input.extend_from_slice(label);
    input.extend_from_slice(&invitation_hash);
    let digest = sha384(&input).map_err(map_pairing_error)?;
    digest[..16]
        .try_into()
        .map_err(|_| PersistenceError::Corrupt)
}

fn encode_daemon_record(record: &DaemonPairingRecord) -> Result<Vec<u8>, PersistenceError> {
    validate_daemon_record(record)?;
    let mut out = Vec::new();
    out.extend_from_slice(&PAIRING_RECORD_VERSION.to_be_bytes());
    put_profile(&mut out)?;
    out.push(record.state as u8);
    out.extend_from_slice(&record.crypto_session_id);
    out.extend_from_slice(&record.account_id);
    out.extend_from_slice(&record.installation_id);
    put_bounded(&mut out, &record.invitation, PAIRING_INVITATION_MAX_BYTES)?;
    out.extend_from_slice(&record.invitation_hash);
    out.extend_from_slice(&record.invitation_nonce);
    out.extend_from_slice(&record.issued_at_ms.to_be_bytes());
    out.extend_from_slice(&record.expires_at_ms.to_be_bytes());
    out.extend_from_slice(&record.last_now_ms.to_be_bytes());
    out.push(record.failed.len() as u8);
    for failed in &record.failed {
        out.extend_from_slice(&failed.hash);
        out.push(match failed.reason {
            ClaimFailure::Credential => 1,
            ClaimFailure::KeyPackage => 2,
            ClaimFailure::Signature => 3,
        });
        out.push(failed.outcome);
    }
    put_optional_hash_bytes(
        &mut out,
        record.pending_claim.as_ref(),
        PAIRING_CLAIM_MAX_BYTES,
    )?;
    put_optional_hash(&mut out, record.accepted_claim_hash);
    put_optional_bytes(&mut out, record.accepted_result.as_deref(), 16_384)?;
    match record.reservation {
        Some((id, deadline)) => {
            out.push(1);
            out.extend_from_slice(&id);
            out.extend_from_slice(&deadline.to_be_bytes());
        }
        None => out.push(0),
    }
    match record.group_id {
        Some(group_id) => {
            out.push(1);
            out.extend_from_slice(&group_id);
        }
        None => out.push(0),
    }
    put_optional_bytes(&mut out, record.welcome.as_deref(), 16_384)?;
    match record.welcome_expires_at_ms {
        Some(expires_at_ms) => {
            out.push(1);
            out.extend_from_slice(&expires_at_ms.to_be_bytes());
        }
        None => out.push(0),
    }
    out.push(u8::from(record.welcome_expired));
    out.push(u8::from(record.activation_accepted));
    put_optional_hash(&mut out, record.activation_hash);
    put_pair_lifecycle(&mut out, record.pair_lifecycle);
    put_commit_metadata(&mut out, record.pending_commit.as_ref());
    out.push(record.cancellation_reason.map_or(0, |reason| reason as u8));
    Ok(out)
}

fn decode_daemon_record(bytes: &[u8]) -> Result<DaemonPairingRecord, PersistenceError> {
    let mut cursor = RecordCursor::new(bytes);
    require_record_header(&mut cursor)?;
    let state = match cursor.u8()? {
        1 => InvitationLifecycle::Issued,
        2 => InvitationLifecycle::ClaimPending,
        3 => InvitationLifecycle::Confirmed,
        4 => InvitationLifecycle::Consumed,
        5 => InvitationLifecycle::Cancelled,
        6 => InvitationLifecycle::Expired,
        _ => return Err(PersistenceError::Corrupt),
    };
    let crypto_session_id = cursor.array()?;
    let account_id = cursor.array()?;
    let installation_id = cursor.array()?;
    let invitation = cursor.bytes(PAIRING_INVITATION_MAX_BYTES)?.to_vec();
    let invitation_hash = cursor.array()?;
    let invitation_nonce = cursor.array()?;
    let issued_at_ms = cursor.u64()?;
    let expires_at_ms = cursor.u64()?;
    let last_now_ms = cursor.u64()?;
    let failed_count = usize::from(cursor.u8()?);
    if failed_count > PAIRING_MAX_FAILED_CLAIMS {
        return Err(PersistenceError::Corrupt);
    }
    let mut failed = Vec::with_capacity(failed_count);
    for _ in 0..failed_count {
        let hash = cursor.array()?;
        let reason = match cursor.u8()? {
            1 => ClaimFailure::Credential,
            2 => ClaimFailure::KeyPackage,
            3 => ClaimFailure::Signature,
            _ => return Err(PersistenceError::Corrupt),
        };
        let outcome = cursor.u8()?;
        failed.push(FailedClaim {
            hash,
            reason,
            outcome,
        });
    }
    let pending_claim = cursor.optional_hash_bytes(PAIRING_CLAIM_MAX_BYTES)?;
    let accepted_claim_hash = cursor.optional_hash()?;
    let accepted_result = cursor.optional_bytes(16_384)?;
    let reservation = match cursor.u8()? {
        0 => None,
        1 => Some((cursor.array()?, cursor.u64()?)),
        _ => return Err(PersistenceError::Corrupt),
    };
    let group_id = match cursor.u8()? {
        0 => None,
        1 => Some(cursor.array()?),
        _ => return Err(PersistenceError::Corrupt),
    };
    let welcome = cursor.optional_bytes(16_384)?;
    let welcome_expires_at_ms = match cursor.u8()? {
        0 => None,
        1 => Some(cursor.u64()?),
        _ => return Err(PersistenceError::Corrupt),
    };
    let welcome_expired = match cursor.u8()? {
        0 => false,
        1 => true,
        _ => return Err(PersistenceError::Corrupt),
    };
    let activation_accepted = match cursor.u8()? {
        0 => false,
        1 => true,
        _ => return Err(PersistenceError::Corrupt),
    };
    let activation_hash = cursor.optional_hash()?;
    let pair_lifecycle = cursor.pair_lifecycle()?;
    let pending_commit = cursor.commit_metadata()?;
    let cancellation_reason = match cursor.u8()? {
        0 => None,
        1 => Some(CancellationReason::Explicit),
        2 => Some(CancellationReason::FailedClaims),
        _ => return Err(PersistenceError::Corrupt),
    };
    cursor.finish()?;
    let record = DaemonPairingRecord {
        state,
        crypto_session_id,
        account_id,
        installation_id,
        invitation,
        invitation_hash,
        invitation_nonce,
        issued_at_ms,
        expires_at_ms,
        last_now_ms,
        failed,
        pending_claim,
        accepted_claim_hash,
        accepted_result,
        reservation,
        group_id,
        welcome,
        welcome_expires_at_ms,
        welcome_expired,
        activation_accepted,
        activation_hash,
        pair_lifecycle,
        pending_commit,
        cancellation_reason,
    };
    validate_daemon_record(&record)?;
    Ok(record)
}

fn validate_daemon_record(record: &DaemonPairingRecord) -> Result<(), PersistenceError> {
    if record.crypto_session_id == [0; 16]
        || record.failed.len() > PAIRING_MAX_FAILED_CLAIMS
        || record.last_now_ms < record.issued_at_ms
    {
        return Err(PersistenceError::Corrupt);
    }
    let invitation = PairingInvitation::decode(&record.invitation).map_err(map_pairing_error)?;
    if invitation.crypto_session_id() != record.crypto_session_id
        || invitation.account_id() != record.account_id
        || invitation.installation_id() != record.installation_id
        || invitation.invitation_hash().map_err(map_pairing_error)? != record.invitation_hash
        || invitation.invitation_nonce() != record.invitation_nonce
        || invitation.issued_at_ms() != record.issued_at_ms
        || invitation.expires_at_ms() != record.expires_at_ms
    {
        return Err(PersistenceError::IdentityMismatch);
    }
    let mut hashes = BTreeMap::new();
    for (index, failed) in record.failed.iter().enumerate() {
        if hashes.insert(failed.hash, ()).is_some()
            || (failed.outcome == OUTCOME_CANCELLED) != (index + 1 == PAIRING_MAX_FAILED_CLAIMS)
            || (failed.outcome != OUTCOME_CANCELLED
                && failed.outcome != outcome_for_failure(failed.reason))
        {
            return Err(PersistenceError::Corrupt);
        }
    }
    if (record.failed.len() == PAIRING_MAX_FAILED_CLAIMS)
        != (record.state == InvitationLifecycle::Cancelled
            && record.cancellation_reason == Some(CancellationReason::FailedClaims))
    {
        return Err(PersistenceError::Corrupt);
    }
    let pending_hash = if let Some((hash, bytes)) = &record.pending_claim {
        let claim = PairingClaimV1::decode(bytes).map_err(map_pairing_error)?;
        if claim.claim_hash().map_err(map_pairing_error)? != *hash {
            return Err(PersistenceError::Corrupt);
        }
        Some(*hash)
    } else {
        None
    };
    if record.accepted_claim_hash.is_some() && record.accepted_claim_hash != pending_hash
        || record.reservation.is_some() && record.accepted_claim_hash.is_none()
    {
        return Err(PersistenceError::Corrupt);
    }
    let no_group = record.group_id.is_none()
        && record.welcome.is_none()
        && record.welcome_expires_at_ms.is_none()
        && !record.welcome_expired
        && !record.activation_accepted
        && record.activation_hash.is_none()
        && record.pair_lifecycle.is_none()
        && record.pending_commit.is_none();
    let valid = match record.state {
        InvitationLifecycle::Issued => {
            record.pending_claim.is_none()
                && record.accepted_claim_hash.is_none()
                && record.accepted_result.is_none()
                && record.reservation.is_none()
                && record.cancellation_reason.is_none()
                && no_group
        }
        InvitationLifecycle::ClaimPending => {
            record.pending_claim.is_some()
                && record.accepted_claim_hash.is_none()
                && record.accepted_result.is_none()
                && record.reservation.is_none()
                && record.cancellation_reason.is_none()
                && no_group
        }
        InvitationLifecycle::Confirmed => {
            let intent_matches = reservation_intent(record)
                .map(|intent| {
                    record.accepted_result.as_deref() == Some(&encode_reservation_intent(&intent))
                })
                .unwrap_or(false);
            record.pending_claim.is_some()
                && record.accepted_claim_hash == pending_hash
                && record
                    .reservation
                    .is_some_and(|(_, deadline)| deadline <= record.expires_at_ms)
                && intent_matches
                && record.cancellation_reason.is_none()
                && no_group
        }
        InvitationLifecycle::Consumed => {
            let lifecycle = record.pair_lifecycle;
            let commit_shape = (lifecycle == Some(PairLifecycle::WaitingForEpochReady))
                == record.pending_commit.is_some();
            let active_shape = record.activation_accepted
                && record.activation_hash.is_some()
                && record.welcome.is_none()
                && record.welcome_expires_at_ms.is_none()
                && !record.welcome_expired
                && record.accepted_result.is_none()
                && matches!(
                    lifecycle,
                    Some(
                        PairLifecycle::Active
                            | PairLifecycle::ReplacementProposed
                            | PairLifecycle::WaitingForEpochReady
                            | PairLifecycle::Removed
                            | PairLifecycle::Revoked
                            | PairLifecycle::Reset
                    )
                );
            let pending_activation_shape = !record.activation_accepted
                && record.activation_hash.is_none()
                && lifecycle == Some(PairLifecycle::AwaitingActivation)
                && record.pending_commit.is_none()
                && ((record.welcome_expired
                    && record.welcome.is_none()
                    && record.welcome_expires_at_ms.is_none()
                    && record.accepted_result.is_none())
                    || (!record.welcome_expired
                        && record.welcome.is_some()
                        && record.welcome_expires_at_ms.is_some()
                        && record.accepted_result.as_ref() == record.welcome.as_ref()));
            record.pending_claim.is_some()
                && record.accepted_claim_hash == pending_hash
                && record.reservation.is_some()
                && record.group_id.is_some()
                && record.cancellation_reason.is_none()
                && commit_shape
                && (active_shape || pending_activation_shape)
        }
        InvitationLifecycle::Cancelled => {
            record.pending_claim.is_none()
                && record.accepted_claim_hash.is_none()
                && record.accepted_result.is_none()
                && record.reservation.is_none()
                && record.cancellation_reason.is_some()
                && no_group
        }
        InvitationLifecycle::Expired => {
            record.pending_claim.is_none()
                && record.accepted_claim_hash.is_none()
                && record.accepted_result.is_none()
                && record.reservation.is_none()
                && record.cancellation_reason.is_none()
                && no_group
        }
    };
    if !valid {
        return Err(PersistenceError::Corrupt);
    }
    Ok(())
}

fn encode_device_record(record: &DevicePreJoinRecord) -> Result<Vec<u8>, PersistenceError> {
    validate_device_record(record)?;
    let mut out = Vec::new();
    out.extend_from_slice(&PAIRING_RECORD_VERSION.to_be_bytes());
    put_profile(&mut out)?;
    out.push(record.state as u8);
    out.extend_from_slice(&record.crypto_session_id);
    out.extend_from_slice(&record.account_id);
    out.extend_from_slice(&record.installation_id);
    out.extend_from_slice(&record.device_id);
    put_bounded(&mut out, &record.invitation, PAIRING_INVITATION_MAX_BYTES)?;
    out.extend_from_slice(&record.invitation_hash);
    out.extend_from_slice(&record.expires_at_ms.to_be_bytes());
    out.extend_from_slice(&record.last_now_ms.to_be_bytes());
    put_bounded(&mut out, &record.key_package, 16_384)?;
    put_bounded(&mut out, &record.claim, PAIRING_CLAIM_MAX_BYTES)?;
    match record.group_id {
        Some(group_id) => {
            out.push(1);
            out.extend_from_slice(&group_id);
        }
        None => out.push(0),
    }
    put_optional_bytes(&mut out, record.welcome.as_deref(), 16_384)?;
    match record.welcome_expires_at_ms {
        Some(expires_at_ms) => {
            out.push(1);
            out.extend_from_slice(&expires_at_ms.to_be_bytes());
        }
        None => out.push(0),
    }
    put_optional_bytes(&mut out, record.activation.as_deref(), 2_048)?;
    put_pair_lifecycle(&mut out, record.pair_lifecycle);
    put_commit_metadata(&mut out, record.pending_commit.as_ref());
    out.push(u8::from(record.epoch_ready_prepared));
    match record.forbidden_group_id {
        Some(group_id) => {
            out.push(1);
            out.extend_from_slice(&group_id);
        }
        None => out.push(0),
    }
    Ok(out)
}

fn decode_device_record(bytes: &[u8]) -> Result<DevicePreJoinRecord, PersistenceError> {
    let mut cursor = RecordCursor::new(bytes);
    require_record_header(&mut cursor)?;
    let state = match cursor.u8()? {
        1 => PreJoinLifecycle::PreJoin,
        2 => PreJoinLifecycle::Expired,
        3 => PreJoinLifecycle::Cancelled,
        4 => PreJoinLifecycle::Joined,
        5 => PreJoinLifecycle::Activated,
        6 => PreJoinLifecycle::Removed,
        7 => PreJoinLifecycle::Reset,
        _ => return Err(PersistenceError::Corrupt),
    };
    let record = DevicePreJoinRecord {
        state,
        crypto_session_id: cursor.array()?,
        account_id: cursor.array()?,
        installation_id: cursor.array()?,
        device_id: cursor.array()?,
        invitation: cursor.bytes(PAIRING_INVITATION_MAX_BYTES)?.to_vec(),
        invitation_hash: cursor.array()?,
        expires_at_ms: cursor.u64()?,
        last_now_ms: cursor.u64()?,
        key_package: cursor.bytes(16_384)?.to_vec(),
        claim: cursor.bytes(PAIRING_CLAIM_MAX_BYTES)?.to_vec(),
        group_id: match cursor.u8()? {
            0 => None,
            1 => Some(cursor.array()?),
            _ => return Err(PersistenceError::Corrupt),
        },
        welcome: cursor.optional_bytes(16_384)?,
        welcome_expires_at_ms: match cursor.u8()? {
            0 => None,
            1 => Some(cursor.u64()?),
            _ => return Err(PersistenceError::Corrupt),
        },
        activation: cursor.optional_bytes(2_048)?,
        pair_lifecycle: cursor.pair_lifecycle()?,
        pending_commit: cursor.commit_metadata()?,
        epoch_ready_prepared: match cursor.u8()? {
            0 => false,
            1 => true,
            _ => return Err(PersistenceError::Corrupt),
        },
        forbidden_group_id: match cursor.u8()? {
            0 => None,
            1 => Some(cursor.array()?),
            _ => return Err(PersistenceError::Corrupt),
        },
    };
    cursor.finish()?;
    validate_device_record(&record)?;
    Ok(record)
}

fn validate_device_record(record: &DevicePreJoinRecord) -> Result<(), PersistenceError> {
    if record.crypto_session_id == [0; 16]
        || record.key_package.is_empty()
        || record.claim.is_empty()
    {
        return Err(PersistenceError::Corrupt);
    }
    let invitation = PairingInvitation::decode(&record.invitation).map_err(map_pairing_error)?;
    let claim = PairingClaimV1::decode(&record.claim).map_err(map_pairing_error)?;
    if invitation.crypto_session_id() != record.crypto_session_id
        || invitation.account_id() != record.account_id
        || invitation.installation_id() != record.installation_id
        || invitation.invitation_hash().map_err(map_pairing_error)? != record.invitation_hash
        || invitation.expires_at_ms() != record.expires_at_ms
        || record.last_now_ms < invitation.issued_at_ms()
        || claim.crypto_session_id() != record.crypto_session_id
        || claim.account_id() != record.account_id
        || claim.installation_id() != record.installation_id
        || claim.device_credential().identity().device_id != record.device_id
        || claim.key_package() != record.key_package
    {
        return Err(PersistenceError::IdentityMismatch);
    }
    match record.state {
        PreJoinLifecycle::PreJoin | PreJoinLifecycle::Expired | PreJoinLifecycle::Cancelled
            if record.group_id.is_some()
                || record.welcome.is_some()
                || record.welcome_expires_at_ms.is_some()
                || record.activation.is_some() =>
        {
            return Err(PersistenceError::Corrupt);
        }
        PreJoinLifecycle::Joined
            if record.group_id.is_none()
                || record.welcome.is_none()
                || record.welcome_expires_at_ms.is_none() =>
        {
            return Err(PersistenceError::Corrupt);
        }
        PreJoinLifecycle::Activated
            if record.group_id.is_none()
                || record.welcome.is_none()
                || record.welcome_expires_at_ms.is_none()
                || record.activation.is_none() =>
        {
            return Err(PersistenceError::Corrupt);
        }
        _ => {}
    }
    let pair_shape_valid = match record.state {
        PreJoinLifecycle::PreJoin => {
            record.pair_lifecycle.is_none()
                && record.pending_commit.is_none()
                && record.last_now_ms < record.expires_at_ms
        }
        PreJoinLifecycle::Expired => {
            record.pair_lifecycle.is_none()
                && record.pending_commit.is_none()
                && record.last_now_ms >= record.expires_at_ms
        }
        PreJoinLifecycle::Cancelled => {
            record.pair_lifecycle.is_none() && record.pending_commit.is_none()
        }
        PreJoinLifecycle::Joined => {
            record.pair_lifecycle == Some(PairLifecycle::AwaitingActivation)
                && record.pending_commit.is_none()
        }
        PreJoinLifecycle::Activated => matches!(
            record.pair_lifecycle,
            Some(
                PairLifecycle::Active
                    | PairLifecycle::ReplacementProposed
                    | PairLifecycle::WaitingForEpochReady
            )
        ),
        PreJoinLifecycle::Removed => {
            record.pair_lifecycle == Some(PairLifecycle::Removed)
                && record.pending_commit.is_none()
                && record.group_id.is_some()
                && record.activation.is_some()
        }
        PreJoinLifecycle::Reset => {
            record.pair_lifecycle == Some(PairLifecycle::Reset)
                && record.pending_commit.is_none()
                && if record.group_id.is_some() {
                    record.welcome.is_some()
                        && record.welcome_expires_at_ms.is_some()
                        && record.activation.is_some()
                } else {
                    record.welcome.is_none()
                        && record.welcome_expires_at_ms.is_none()
                        && record.activation.is_none()
                }
        }
    };
    if !pair_shape_valid
        || record.welcome.is_some() != record.welcome_expires_at_ms.is_some()
        || (record.forbidden_group_id.is_some() && record.forbidden_group_id == record.group_id)
        || (record.pair_lifecycle == Some(PairLifecycle::WaitingForEpochReady))
            != record.pending_commit.is_some()
        || (record.epoch_ready_prepared && record.pending_commit.is_none())
    {
        return Err(PersistenceError::Corrupt);
    }
    Ok(())
}

fn put_profile(out: &mut Vec<u8>) -> Result<(), PersistenceError> {
    let length = u8::try_from(PROFILE_ID.len()).map_err(|_| PersistenceError::Corrupt)?;
    out.push(length);
    out.extend_from_slice(PROFILE_ID.as_bytes());
    out.extend_from_slice(&PROFILE_REVISION.to_be_bytes());
    Ok(())
}

fn require_record_header(cursor: &mut RecordCursor<'_>) -> Result<(), PersistenceError> {
    if cursor.u16()? != PAIRING_RECORD_VERSION {
        return Err(PersistenceError::UnsupportedSchema);
    }
    let profile = cursor.u8_bytes(255)?;
    if profile != PROFILE_ID.as_bytes() || cursor.u16()? != PROFILE_REVISION {
        return Err(PersistenceError::IdentityMismatch);
    }
    Ok(())
}

fn put_bounded(out: &mut Vec<u8>, bytes: &[u8], max: usize) -> Result<(), PersistenceError> {
    if bytes.is_empty() || bytes.len() > max {
        return Err(PersistenceError::Corrupt);
    }
    let length = u32::try_from(bytes.len()).map_err(|_| PersistenceError::Corrupt)?;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

fn put_optional_bytes(
    out: &mut Vec<u8>,
    bytes: Option<&[u8]>,
    max: usize,
) -> Result<(), PersistenceError> {
    match bytes {
        Some(bytes) => {
            out.push(1);
            put_bounded(out, bytes, max)?;
        }
        None => out.push(0),
    }
    Ok(())
}

fn put_pair_lifecycle(out: &mut Vec<u8>, state: Option<PairLifecycle>) {
    out.push(state.map_or(0, |state| state as u8));
}

fn put_commit_metadata(out: &mut Vec<u8>, commit: Option<&CommitMetadata>) {
    match commit {
        Some(commit) => {
            out.push(1);
            out.extend_from_slice(&commit.commit_id);
            out.extend_from_slice(&commit.target_epoch.to_be_bytes());
            out.extend_from_slice(&commit.epoch_authenticator);
        }
        None => out.push(0),
    }
}

fn put_optional_hash(out: &mut Vec<u8>, hash: Option<[u8; 48]>) {
    match hash {
        Some(hash) => {
            out.push(1);
            out.extend_from_slice(&hash);
        }
        None => out.push(0),
    }
}

fn put_optional_hash_bytes(
    out: &mut Vec<u8>,
    value: Option<&PendingClaim>,
    max: usize,
) -> Result<(), PersistenceError> {
    match value {
        Some((hash, bytes)) => {
            out.push(1);
            out.extend_from_slice(hash);
            put_bounded(out, bytes, max)?;
        }
        None => out.push(0),
    }
    Ok(())
}

struct RecordCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> RecordCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], PersistenceError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(PersistenceError::Corrupt)?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(PersistenceError::Corrupt)?;
        self.offset = end;
        Ok(value)
    }

    fn u8(&mut self) -> Result<u8, PersistenceError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, PersistenceError> {
        Ok(u16::from_be_bytes(self.array()?))
    }

    fn u32(&mut self) -> Result<u32, PersistenceError> {
        Ok(u32::from_be_bytes(self.array()?))
    }

    fn u64(&mut self) -> Result<u64, PersistenceError> {
        Ok(u64::from_be_bytes(self.array()?))
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], PersistenceError> {
        self.take(N)?
            .try_into()
            .map_err(|_| PersistenceError::Corrupt)
    }

    fn u8_bytes(&mut self, max: usize) -> Result<&'a [u8], PersistenceError> {
        let length = usize::from(self.u8()?);
        if length == 0 || length > max {
            return Err(PersistenceError::Corrupt);
        }
        self.take(length)
    }

    fn bytes(&mut self, max: usize) -> Result<&'a [u8], PersistenceError> {
        let length = self.u32()? as usize;
        if length == 0 || length > max {
            return Err(PersistenceError::Corrupt);
        }
        self.take(length)
    }

    fn pair_lifecycle(&mut self) -> Result<Option<PairLifecycle>, PersistenceError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(PairLifecycle::AwaitingActivation)),
            2 => Ok(Some(PairLifecycle::Active)),
            3 => Ok(Some(PairLifecycle::ReplacementProposed)),
            4 => Ok(Some(PairLifecycle::WaitingForEpochReady)),
            5 => Ok(Some(PairLifecycle::Removed)),
            6 => Ok(Some(PairLifecycle::Revoked)),
            7 => Ok(Some(PairLifecycle::Reset)),
            _ => Err(PersistenceError::Corrupt),
        }
    }

    fn commit_metadata(&mut self) -> Result<Option<CommitMetadata>, PersistenceError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(CommitMetadata {
                commit_id: self.array()?,
                target_epoch: self.u64()?,
                epoch_authenticator: self.array()?,
            })),
            _ => Err(PersistenceError::Corrupt),
        }
    }

    fn optional_hash(&mut self) -> Result<Option<[u8; 48]>, PersistenceError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(self.array()?)),
            _ => Err(PersistenceError::Corrupt),
        }
    }

    fn optional_bytes(&mut self, max: usize) -> Result<Option<Vec<u8>>, PersistenceError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(self.bytes(max)?.to_vec())),
            _ => Err(PersistenceError::Corrupt),
        }
    }

    fn optional_hash_bytes(
        &mut self,
        max: usize,
    ) -> Result<Option<PendingClaim>, PersistenceError> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some((self.array()?, self.bytes(max)?.to_vec()))),
            _ => Err(PersistenceError::Corrupt),
        }
    }

    fn finish(self) -> Result<(), PersistenceError> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(PersistenceError::Corrupt)
        }
    }
}

impl_witness_endpoint!(DurablePendingInvitation);
impl_witness_endpoint!(DurablePreJoinDevice);

impl TryFrom<TypedResult> for ActivationOutcome {
    type Error = PersistenceError;

    fn try_from(value: TypedResult) -> Result<Self, PersistenceError> {
        match value {
            TypedResult::Envelope(record) => Ok(Self::Prepared(record)),
            TypedResult::Activation(acceptance) => Ok(Self::Activated(acceptance)),
            _ => Err(PersistenceError::Corrupt),
        }
    }
}

impl TryFrom<TypedResult> for RemovalOutcome {
    type Error = PersistenceError;

    fn try_from(value: TypedResult) -> Result<Self, PersistenceError> {
        match value {
            TypedResult::Envelope(record) => Ok(Self::Commit(record)),
            TypedResult::Removal(outcome) => Ok(outcome),
            _ => Err(PersistenceError::Corrupt),
        }
    }
}

impl TryFrom<TypedResult> for WelcomeOutcome {
    type Error = PersistenceError;

    fn try_from(value: TypedResult) -> Result<Self, PersistenceError> {
        match value {
            TypedResult::Welcome(publication) => Ok(Self::Committed(publication)),
            _ => Err(PersistenceError::Corrupt),
        }
    }
}

// ---- Private exact-result codecs for pairing types. These are persistence formats only. ----

pub(super) fn encode_commit_metadata(commit: &CommitMetadata) -> Vec<u8> {
    commit.encode().to_vec()
}

pub(super) fn encode_invitation_publication(
    value: &InvitationPublication,
) -> Result<Vec<u8>, PersistenceError> {
    let mut out = Vec::new();
    put_bounded(&mut out, &value.bytes, PAIRING_INVITATION_MAX_BYTES)?;
    out.extend_from_slice(&value.invitation_hash);
    out.extend_from_slice(&value.expires_at_ms.to_be_bytes());
    Ok(out)
}

pub(super) fn decode_invitation_publication(
    bytes: &[u8],
) -> Result<InvitationPublication, PersistenceError> {
    let mut cursor = RecordCursor::new(bytes);
    let value = InvitationPublication {
        bytes: cursor.bytes(PAIRING_INVITATION_MAX_BYTES)?.to_vec(),
        invitation_hash: cursor.array()?,
        expires_at_ms: cursor.u64()?,
    };
    cursor.finish()?;
    Ok(value)
}

pub(super) fn encode_prejoin_publication(
    value: &PreJoinPublication,
) -> Result<Vec<u8>, PersistenceError> {
    let mut out = Vec::new();
    put_bounded(&mut out, &value.claim, PAIRING_CLAIM_MAX_BYTES)?;
    put_bounded(&mut out, &value.key_package, 16_384)?;
    out.extend_from_slice(&value.invitation_hash);
    out.extend_from_slice(&value.expires_at_ms.to_be_bytes());
    Ok(out)
}

pub(super) fn decode_prejoin_publication(
    bytes: &[u8],
) -> Result<PreJoinPublication, PersistenceError> {
    let mut cursor = RecordCursor::new(bytes);
    let value = PreJoinPublication {
        claim: cursor.bytes(PAIRING_CLAIM_MAX_BYTES)?.to_vec(),
        key_package: cursor.bytes(16_384)?.to_vec(),
        invitation_hash: cursor.array()?,
        expires_at_ms: cursor.u64()?,
    };
    cursor.finish()?;
    Ok(value)
}

pub(super) fn encode_welcome_publication(
    value: &WelcomePublication,
) -> Result<Vec<u8>, PersistenceError> {
    let mut out = Vec::new();
    put_bounded(&mut out, &value.bytes, 16_384)?;
    out.extend_from_slice(&value.group_id);
    out.extend_from_slice(&value.claim_hash);
    out.extend_from_slice(&value.expires_at_ms.to_be_bytes());
    Ok(out)
}

pub(super) fn decode_welcome_publication(
    bytes: &[u8],
) -> Result<WelcomePublication, PersistenceError> {
    let mut cursor = RecordCursor::new(bytes);
    let value = WelcomePublication {
        bytes: cursor.bytes(16_384)?.to_vec(),
        group_id: cursor.array()?,
        claim_hash: cursor.array()?,
        expires_at_ms: cursor.u64()?,
    };
    cursor.finish()?;
    if value.group_id == [0; 32] {
        return Err(PersistenceError::Corrupt);
    }
    Ok(value)
}

pub(super) fn encode_claim_submission(
    value: &ClaimSubmission,
) -> Result<Vec<u8>, PersistenceError> {
    let mut out = Vec::new();
    match value {
        ClaimSubmission::Pending {
            claim_hash,
            comparison,
        } => {
            out.push(1);
            out.extend_from_slice(claim_hash);
            put_bounded(&mut out, comparison.as_bytes(), 64)?;
        }
        ClaimSubmission::Confirmed(intent) => {
            out.push(2);
            out.extend_from_slice(&encode_reservation_intent(intent));
        }
        ClaimSubmission::Accepted(publication) => {
            out.push(3);
            out.extend_from_slice(&encode_welcome_publication(publication)?);
        }
        ClaimSubmission::Consumed => out.push(4),
        ClaimSubmission::Rejected { reason } => {
            out.push(5);
            out.push(match reason {
                None => 0,
                Some(ClaimFailure::Credential) => 1,
                Some(ClaimFailure::KeyPackage) => 2,
                Some(ClaimFailure::Signature) => 3,
            });
        }
        ClaimSubmission::Cancelled => out.push(6),
        ClaimSubmission::Expired => out.push(7),
        ClaimSubmission::Conflict => out.push(8),
    }
    Ok(out)
}

pub(super) fn decode_claim_submission(bytes: &[u8]) -> Result<ClaimSubmission, PersistenceError> {
    let mut cursor = RecordCursor::new(bytes);
    let value = match cursor.u8()? {
        1 => ClaimSubmission::Pending {
            claim_hash: cursor.array()?,
            comparison: String::from_utf8(cursor.bytes(64)?.to_vec())
                .map_err(|_| PersistenceError::Corrupt)?,
        },
        2 => ClaimSubmission::Confirmed(decode_reservation_intent(&mut cursor)?),
        3 => {
            let rest = cursor.take(bytes.len() - 1)?;
            ClaimSubmission::Accepted(decode_welcome_publication(rest)?)
        }
        4 => ClaimSubmission::Consumed,
        5 => ClaimSubmission::Rejected {
            reason: match cursor.u8()? {
                0 => None,
                1 => Some(ClaimFailure::Credential),
                2 => Some(ClaimFailure::KeyPackage),
                3 => Some(ClaimFailure::Signature),
                _ => return Err(PersistenceError::Corrupt),
            },
        },
        6 => ClaimSubmission::Cancelled,
        7 => ClaimSubmission::Expired,
        8 => ClaimSubmission::Conflict,
        _ => return Err(PersistenceError::Corrupt),
    };
    cursor.finish()?;
    Ok(value)
}

fn decode_reservation_intent(
    cursor: &mut RecordCursor<'_>,
) -> Result<ReservationIntent, PersistenceError> {
    Ok(ReservationIntent {
        reservation_id: cursor.array()?,
        crypto_session_id: cursor.array()?,
        account_id: cursor.array()?,
        installation_id: cursor.array()?,
        device_id: cursor.array()?,
        claim_hash: cursor.array()?,
        key_package_hash: cursor.array()?,
        expires_at_ms: cursor.u64()?,
    })
}

pub(super) fn encode_reservation_outcome(
    value: &ReservationOutcome,
) -> Result<Vec<u8>, PersistenceError> {
    let mut out = Vec::new();
    match value {
        ReservationOutcome::Reserved(intent) => {
            out.push(1);
            out.extend_from_slice(&encode_reservation_intent(intent));
        }
        ReservationOutcome::Busy => out.push(2),
        ReservationOutcome::Expired => out.push(3),
        ReservationOutcome::Consumed => out.push(4),
        ReservationOutcome::Rejected => out.push(5),
        ReservationOutcome::Unavailable => out.push(6),
    }
    Ok(out)
}

pub(super) fn decode_reservation_outcome(
    bytes: &[u8],
) -> Result<ReservationOutcome, PersistenceError> {
    let mut cursor = RecordCursor::new(bytes);
    let value = match cursor.u8()? {
        1 => ReservationOutcome::Reserved(decode_reservation_intent(&mut cursor)?),
        2 => ReservationOutcome::Busy,
        3 => ReservationOutcome::Expired,
        4 => ReservationOutcome::Consumed,
        5 => ReservationOutcome::Rejected,
        6 => ReservationOutcome::Unavailable,
        _ => return Err(PersistenceError::Corrupt),
    };
    cursor.finish()?;
    Ok(value)
}

pub(super) fn encode_activation_acceptance(value: &ActivationAcceptance) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + 32 + 48 + 48);
    out.extend_from_slice(&value.crypto_session_id);
    out.extend_from_slice(&value.group_id);
    out.extend_from_slice(&value.claim_hash);
    out.extend_from_slice(&value.activation_hash);
    out
}

pub(super) fn decode_activation_acceptance(
    bytes: &[u8],
) -> Result<ActivationAcceptance, PersistenceError> {
    let mut cursor = RecordCursor::new(bytes);
    let value = ActivationAcceptance {
        crypto_session_id: cursor.array()?,
        group_id: cursor.array()?,
        claim_hash: cursor.array()?,
        activation_hash: cursor.array()?,
    };
    cursor.finish()?;
    Ok(value)
}

pub(super) fn encode_epoch_ready_acceptance(value: &EpochReadyAcceptance) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + 48);
    out.extend_from_slice(&value.crypto_session_id);
    out.extend_from_slice(&value.commit_id);
    out
}

pub(super) fn decode_epoch_ready_acceptance(
    bytes: &[u8],
) -> Result<EpochReadyAcceptance, PersistenceError> {
    let mut cursor = RecordCursor::new(bytes);
    let value = EpochReadyAcceptance {
        crypto_session_id: cursor.array()?,
        commit_id: cursor.array()?,
    };
    cursor.finish()?;
    Ok(value)
}

pub(super) fn encode_re_pair_requirement(value: &RePairRequirement) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + 16 + 33 + 48);
    out.extend_from_slice(&value.device_id);
    out.extend_from_slice(&value.crypto_session_id);
    match value.group_id {
        Some(group_id) => {
            out.push(1);
            out.extend_from_slice(&group_id);
        }
        None => out.push(0),
    }
    out.extend_from_slice(&value.key_package_hash);
    out
}

pub(super) fn decode_re_pair_requirement(
    bytes: &[u8],
) -> Result<RePairRequirement, PersistenceError> {
    let mut cursor = RecordCursor::new(bytes);
    let value = RePairRequirement {
        device_id: cursor.array()?,
        crypto_session_id: cursor.array()?,
        group_id: match cursor.u8()? {
            0 => None,
            1 => Some(cursor.array()?),
            _ => return Err(PersistenceError::Corrupt),
        },
        key_package_hash: cursor.array()?,
    };
    cursor.finish()?;
    Ok(value)
}

pub(super) fn encode_removal_outcome(value: &RemovalOutcome) -> Result<Vec<u8>, PersistenceError> {
    Ok(match value {
        RemovalOutcome::Commit(_) => return Err(PersistenceError::Corrupt),
        RemovalOutcome::Removed => vec![1],
        RemovalOutcome::Revoked => vec![2],
        RemovalOutcome::RePairRequired(requirement) => {
            let mut out = vec![3];
            out.extend_from_slice(&encode_re_pair_requirement(requirement));
            out
        }
    })
}

pub(super) fn decode_removal_outcome(bytes: &[u8]) -> Result<RemovalOutcome, PersistenceError> {
    match bytes {
        [1] => Ok(RemovalOutcome::Removed),
        [2] => Ok(RemovalOutcome::Revoked),
        [3, rest @ ..] => Ok(RemovalOutcome::RePairRequired(decode_re_pair_requirement(
            rest,
        )?)),
        _ => Err(PersistenceError::Corrupt),
    }
}

pub(super) fn decode_invitation_lifecycle(
    value: u8,
) -> Result<InvitationLifecycle, PersistenceError> {
    Ok(match value {
        1 => InvitationLifecycle::Issued,
        2 => InvitationLifecycle::ClaimPending,
        3 => InvitationLifecycle::Confirmed,
        4 => InvitationLifecycle::Consumed,
        5 => InvitationLifecycle::Cancelled,
        6 => InvitationLifecycle::Expired,
        _ => return Err(PersistenceError::Corrupt),
    })
}

pub(super) fn decode_prejoin_lifecycle(value: u8) -> Result<PreJoinLifecycle, PersistenceError> {
    Ok(match value {
        1 => PreJoinLifecycle::PreJoin,
        2 => PreJoinLifecycle::Expired,
        3 => PreJoinLifecycle::Cancelled,
        4 => PreJoinLifecycle::Joined,
        5 => PreJoinLifecycle::Activated,
        6 => PreJoinLifecycle::Removed,
        7 => PreJoinLifecycle::Reset,
        _ => return Err(PersistenceError::Corrupt),
    })
}

pub(super) fn decode_pair_lifecycle(value: u8) -> Result<PairLifecycle, PersistenceError> {
    Ok(match value {
        1 => PairLifecycle::AwaitingActivation,
        2 => PairLifecycle::Active,
        3 => PairLifecycle::ReplacementProposed,
        4 => PairLifecycle::WaitingForEpochReady,
        5 => PairLifecycle::Removed,
        6 => PairLifecycle::Revoked,
        7 => PairLifecycle::Reset,
        _ => return Err(PersistenceError::Corrupt),
    })
}

fn map_pairing_error(error: crate::pairing::PairingError) -> PersistenceError {
    match error {
        crate::pairing::PairingError::ClockRollback => {
            PersistenceError::Core(crate::Error::ClockRollback)
        }
        crate::pairing::PairingError::IdentityMismatch
        | crate::pairing::PairingError::WrongProfile
        | crate::pairing::PairingError::WrongProfileRevision
        | crate::pairing::PairingError::WrongVersion => PersistenceError::IdentityMismatch,
        _ => PersistenceError::Corrupt,
    }
}
