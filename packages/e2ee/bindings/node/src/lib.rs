// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

//! Private Node-API binding for the Axl endpoint E2EE core.
//!
//! Every state-changing endpoint call returns a [`WitnessOutcome`]: either the exact pending
//! witness request that JavaScript must transport to all three replicas, or an already released
//! exact typed result. Nothing typed leaves the binding before `continueWitness` verifies the
//! unanimous certificate. The continuation lives on the endpoint and reloads the durable pending
//! record on every call; JavaScript holds only opaque bytes and an operation ID.

#[cfg(feature = "deployment-test")]
mod deployment_store;
mod support;
#[cfg(feature = "test-fixtures")]
mod test_store;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[cfg(feature = "test-fixtures")]
use axl_e2ee::witness::{WITNESS_REQUEST_MAX_BYTES, WitnessError};
use axl_e2ee::{
    APPLICATION_MAX_BYTES, CommitMetadata, ENVELOPE_MAX_BYTES, HANDSHAKE_MAX_BYTES, Id, Identity,
    PROFILE_ID, PROFILE_REVISION,
    pairing::{
        PAIRING_CLAIM_MAX_BYTES, PAIRING_INVITATION_MAX_BYTES, PairingClaimV1, PairingInvitation,
    },
    persistence::{
        AcceptedMessageRecord, ActivationAcceptance, ActivationOutcome, ClaimSubmission,
        DurablePendingInvitation, DurablePlaintext, DurablePreJoinDevice, EnvelopeKeyStore,
        EpochReadyAcceptance, InvitationLifecycle, InvitationPublication, OutboxRecord,
        PairLifecycle, PendingWitnessRequest, PersistenceError, PreJoinLifecycle,
        PreJoinPublication, RePairRequirement, RemovalOutcome, ReservationIntent,
        ReservationOutcome, RetryState, TypedResult, WelcomeOutcome, WelcomePublication,
        WitnessEndpoint, WitnessOutcome as Outcome,
    },
    witness::{
        EndpointQuarantineReason, EndpointReconciliation, ReplicaTrustSet,
        WITNESS_CERTIFICATE_MAX_BYTES, WitnessRequestKind,
    },
};
use napi::{
    Result,
    bindgen_prelude::{AsyncTask, BigInt, Buffer},
};
use napi_derive::{module_init, napi};

use support::{HandleGate, Work, bigint, copy_bounded, error, id, u64_from_bigint};

#[module_init]
fn initialize() {
    support::install_panic_redaction();
}

const ABI_VERSION: u32 = 2;
const ERROR_CODES: &[&str] = &[
    "already_acknowledged",
    "already_exists",
    "artifact_integrity_failed",
    "bound_exceeded",
    "clock_rollback",
    "conflict",
    "consumed",
    "corrupt_state",
    "endpoint_closed",
    "endpoint_revoked",
    "expired",
    "fresh_witness_required",
    "future_epoch",
    "identity_mismatch",
    "initialization_incomplete",
    "internal_error",
    "invalid_argument",
    "invalid_ciphertext",
    "invalid_hash",
    "invalid_id",
    "invalid_lifecycle",
    "invalid_u64",
    "key_record_missing",
    "lifecycle_busy",
    "missing_commit",
    "not_found",
    "profile_mismatch",
    "re_pair_required",
    "replay_rejected",
    "retention_exceeded",
    "rollback_anchor_unavailable",
    "rollback_detected",
    "secure_store_access_denied",
    "secure_store_ambiguous",
    "secure_store_locked",
    "secure_store_unavailable",
    "stale_epoch",
    "state_loss",
    "storage_unavailable",
    "unsupported_platform",
    "unsupported_schema",
    "witness_auth_failed",
    "witness_conflict",
    "witness_invalid_expected",
    "witness_operation_conflict",
    "witness_receipt_invalid",
    "witness_registration_conflict",
    "witness_unavailable",
];

#[napi(object)]
pub struct BindingInfo {
    pub abi_version: u32,
    pub profile_id: String,
    pub profile_revision: u32,
    pub node_api: u32,
    pub production_storage_ready: bool,
}

#[napi]
pub fn get_binding_info() -> BindingInfo {
    BindingInfo {
        abi_version: ABI_VERSION,
        profile_id: PROFILE_ID.to_owned(),
        profile_revision: u32::from(PROFILE_REVISION),
        node_api: 9,
        production_storage_ready: false,
    }
}

#[napi]
pub fn error_codes() -> Vec<String> {
    ERROR_CODES
        .iter()
        .map(|value| (*value).to_owned())
        .collect()
}

#[napi(object)]
pub struct PairingInspection {
    pub kind: String,
    pub profile_id: String,
    pub profile_revision: u32,
    pub crypto_session_id: Buffer,
}

#[doc(hidden)]
pub struct InspectTask {
    bytes: Vec<u8>,
    claim: bool,
}
impl napi::Task for InspectTask {
    type Output = PairingInspection;
    type JsValue = PairingInspection;
    fn compute(&mut self) -> Result<Self::Output> {
        if self.claim {
            let value = PairingClaimV1::decode(&self.bytes).map_err(map_pairing)?;
            Ok(PairingInspection {
                kind: "pairing_claim".into(),
                profile_id: value.profile_id().into(),
                profile_revision: u32::from(value.profile_revision()),
                crypto_session_id: value.crypto_session_id().to_vec().into(),
            })
        } else {
            let value = PairingInvitation::decode(&self.bytes).map_err(map_pairing)?;
            value.verify_signature().map_err(map_pairing)?;
            Ok(PairingInspection {
                kind: "pairing_invitation".into(),
                profile_id: value.profile_id().into(),
                profile_revision: u32::from(value.profile_revision()),
                crypto_session_id: value.crypto_session_id().to_vec().into(),
            })
        }
    }
    fn resolve(&mut self, _env: napi::Env, value: Self::Output) -> Result<Self::JsValue> {
        Ok(value)
    }
}

#[napi]
pub fn inspect_pairing_invitation(bytes: Buffer) -> Result<AsyncTask<InspectTask>> {
    let bytes = copy_bounded(
        bytes.as_ref(),
        PAIRING_INVITATION_MAX_BYTES,
        "bound_exceeded",
    )?;
    Ok(AsyncTask::new(InspectTask {
        bytes,
        claim: false,
    }))
}

#[napi]
pub fn inspect_pairing_claim(bytes: Buffer) -> Result<AsyncTask<InspectTask>> {
    let bytes = copy_bounded(bytes.as_ref(), PAIRING_CLAIM_MAX_BYTES, "bound_exceeded")?;
    Ok(AsyncTask::new(InspectTask { bytes, claim: true }))
}

/// Endpoint construction inputs. Only test artifacts can build one: production key storage and
/// production replica trust are not approved, so the production constructors fail closed before
/// any configuration exists.
#[cfg_attr(not(feature = "test-fixtures"), allow(dead_code))]
#[derive(Clone)]
struct Config {
    root: PathBuf,
    account: Id,
    installation: Id,
    session: Id,
    device: Option<Id>,
    keys: Arc<dyn EnvelopeKeyStore>,
    trust: Arc<ReplicaTrustSet>,
}

struct DaemonState {
    gate: Arc<HandleGate>,
    config: Config,
    endpoint: Mutex<Option<DurablePendingInvitation>>,
}
struct DeviceState {
    gate: Arc<HandleGate>,
    config: Config,
    endpoint: Mutex<Option<DurablePreJoinDevice>>,
}

#[napi]
pub struct DaemonEndpoint {
    state: Arc<DaemonState>,
}
#[napi]
pub struct DeviceEndpoint {
    state: Arc<DeviceState>,
}

// ---- Witness continuation values -------------------------------------------------------------

/// The one durable pending witness request. It carries only the operation ID, the exact signed
/// request bytes, and the request hash. Transport it to all three replicas and pass the unanimous
/// certificate back to `continueWitness` on the same endpoint.
#[napi(object)]
pub struct PendingWitness {
    pub operation_id: Buffer,
    pub request: Buffer,
    pub request_hash: Buffer,
    pub kind: String,
}

fn pending_witness(value: &PendingWitnessRequest) -> PendingWitness {
    PendingWitness {
        operation_id: value.operation_id().to_vec().into(),
        request: value.request().to_vec().into(),
        request_hash: value.request_hash().to_vec().into(),
        kind: match value.kind() {
            WitnessRequestKind::Register => "register",
            WitnessRequestKind::Advance => "advance",
            WitnessRequestKind::Read => "read",
        }
        .into(),
    }
}

/// Outcome of a fresh unanimous `read` reconciliation.
#[napi(object)]
pub struct WitnessReconciliation {
    pub tag: String,
    pub reason: Option<String>,
}

fn reconciliation(value: EndpointReconciliation) -> WitnessReconciliation {
    let (tag, reason) = match value {
        EndpointReconciliation::Ready => ("ready", None),
        EndpointReconciliation::ResendPending => ("resend_pending", None),
        EndpointReconciliation::RecoverAccepted => ("recover_accepted", None),
        EndpointReconciliation::WitnessUnavailable => ("witness_unavailable", None),
        EndpointReconciliation::Revoked => ("revoked", None),
        EndpointReconciliation::Quarantined(reason) => (
            "quarantined",
            Some(match reason {
                EndpointQuarantineReason::StateLoss => "stale_local_state",
                EndpointQuarantineReason::PendingWithoutLocalState => "pending_without_local_state",
                EndpointQuarantineReason::WitnessLineageMissing => "witness_lineage_missing",
                EndpointQuarantineReason::CommitmentConflict => "commitment_conflict",
                EndpointQuarantineReason::LocalAheadMoreThanOne => "local_ahead_more_than_one",
                EndpointQuarantineReason::WitnessBehindMoreThanOne => {
                    "witness_behind_more_than_one"
                }
                EndpointQuarantineReason::WitnessInconsistent => "witness_inconsistent",
                EndpointQuarantineReason::ImmediateFork => "immediate_fork",
                EndpointQuarantineReason::HistoricalFork => "historical_fork",
            }),
        ),
    };
    WitnessReconciliation {
        tag: tag.into(),
        reason: reason.map(str::to_owned),
    }
}

/// Exact typed value released by the barrier. Constructed only from the authenticated exact
/// result of a completed operation or from a read-only no-change branch.
#[derive(Clone)]
enum Value {
    Empty,
    Outbox(OutboxRecord),
    Plaintext(DurablePlaintext),
    Accepted(AcceptedMessageRecord),
    Commit(CommitMetadata),
    Invitation(InvitationPublication),
    PreJoin(PreJoinPublication),
    Welcome(WelcomePublication),
    Claim(ClaimSubmission),
    Reservation(ReservationOutcome),
    Activation(ActivationAcceptance),
    EpochReady(EpochReadyAcceptance),
    InvitationState(InvitationLifecycle),
    PreJoinState(PreJoinLifecycle),
    PairState(PairLifecycle),
    Removal(RemovalOutcome),
    RePair(RePairRequirement),
    Status(&'static str),
}

impl TryFrom<TypedResult> for Value {
    type Error = napi::Error;

    fn try_from(value: TypedResult) -> Result<Self> {
        Ok(match value {
            TypedResult::Empty => Self::Empty,
            TypedResult::Envelope(v) | TypedResult::OutboxAcknowledged(v) => Self::Outbox(v),
            TypedResult::Plaintext(v) => Self::Plaintext(v),
            TypedResult::Accepted(v) | TypedResult::ReceiveAcknowledged(v) => Self::Accepted(v),
            TypedResult::Commit(v) => Self::Commit(v),
            TypedResult::Invitation(v) => Self::Invitation(v),
            TypedResult::PreJoin(v) => Self::PreJoin(v),
            TypedResult::Welcome(v) => Self::Welcome(v),
            TypedResult::Claim(v) => Self::Claim(v),
            TypedResult::Reservation(v) => Self::Reservation(v),
            TypedResult::Activation(v) => Self::Activation(v),
            TypedResult::EpochReady(v) => Self::EpochReady(v),
            TypedResult::InvitationLifecycle(v) => Self::InvitationState(v),
            TypedResult::PreJoinLifecycle(v) => Self::PreJoinState(v),
            TypedResult::PairLifecycle(v) => Self::PairState(v),
            TypedResult::Removal(v) => Self::from(v),
            TypedResult::RePair(v) => Self::RePair(v),
            // Legacy test-only endpoint results never belong to a pairing facade.
            TypedResult::KeyPackage(_) | TypedResult::LegacyWelcome(_) => {
                return Err(error("internal_error"));
            }
        })
    }
}

impl From<WelcomeOutcome> for Value {
    fn from(value: WelcomeOutcome) -> Self {
        match value {
            WelcomeOutcome::Committed(v) | WelcomeOutcome::Duplicate(v) => Self::Welcome(v),
            WelcomeOutcome::Busy => Self::Status("busy"),
            WelcomeOutcome::Expired => Self::Status("expired"),
            WelcomeOutcome::Consumed => Self::Status("consumed"),
            WelcomeOutcome::Rejected => Self::Status("rejected"),
            WelcomeOutcome::Unavailable => Self::Status("unavailable"),
        }
    }
}

impl From<RemovalOutcome> for Value {
    fn from(value: RemovalOutcome) -> Self {
        match value {
            RemovalOutcome::Commit(v) => Self::Outbox(v),
            RemovalOutcome::RePairRequired(v) => Self::RePair(v),
            RemovalOutcome::Removed | RemovalOutcome::Revoked => Self::Removal(value),
        }
    }
}

impl From<ActivationOutcome> for Value {
    fn from(value: ActivationOutcome) -> Self {
        match value {
            ActivationOutcome::Prepared(v) => Self::Outbox(v),
            ActivationOutcome::Activated(v) | ActivationOutcome::Duplicate(v) => {
                Self::Activation(v)
            }
            ActivationOutcome::Rejected => Self::Status("rejected"),
        }
    }
}

/// Tagged exact result. Exactly one typed accessor is populated for each tag; `status` carries
/// the discriminant of lifecycle, claim, reservation, removal, and no-change results.
#[napi]
pub struct NativeResult {
    value: Value,
}

#[napi]
impl NativeResult {
    #[napi(getter)]
    pub fn tag(&self) -> String {
        match &self.value {
            Value::Empty => "empty",
            Value::Outbox(_) => "outbox",
            Value::Plaintext(_) => "plaintext",
            Value::Accepted(_) => "accepted",
            Value::Commit(_) => "commit",
            Value::Invitation(_) => "invitation",
            Value::PreJoin(_) => "pre_join",
            Value::Welcome(_) => "welcome",
            Value::Claim(_) => "claim",
            Value::Reservation(_) => "reservation",
            Value::Activation(_) => "activation",
            Value::EpochReady(_) => "epoch_ready",
            Value::InvitationState(_) => "invitation_state",
            Value::PreJoinState(_) => "pre_join_state",
            Value::PairState(_) => "pair_state",
            Value::Removal(_) => "removal",
            Value::RePair(_) => "re_pair",
            Value::Status(_) => "status",
        }
        .into()
    }

    #[napi(getter)]
    pub fn status(&self) -> Option<String> {
        Some(match &self.value {
            Value::InvitationState(v) => invitation_lifecycle(*v),
            Value::PreJoinState(v) => prejoin_lifecycle(*v),
            Value::PairState(v) => lifecycle(*v),
            Value::Removal(RemovalOutcome::Removed) => "removed".into(),
            Value::Removal(RemovalOutcome::Revoked) => "revoked".into(),
            Value::Removal(_) => return None,
            Value::Claim(v) => claim_publication(v).tag,
            Value::Reservation(v) => reservation_publication(v).tag,
            Value::Status(v) => (*v).into(),
            _ => return None,
        })
    }

    #[napi(getter)]
    pub fn outbox(&self) -> Option<NativeOutbox> {
        match &self.value {
            Value::Outbox(v) => Some(outbox(v.clone())),
            _ => None,
        }
    }

    #[napi(getter)]
    pub fn plaintext(&self) -> Option<NativePlaintext> {
        match &self.value {
            Value::Plaintext(v) => Some(plaintext(v.clone())),
            _ => None,
        }
    }

    #[napi(getter)]
    pub fn accepted(&self) -> Option<NativeAccepted> {
        match &self.value {
            Value::Accepted(v) => Some(NativeAccepted { inner: v.clone() }),
            _ => None,
        }
    }

    #[napi(getter)]
    pub fn commit(&self) -> Option<NativeCommit> {
        match &self.value {
            Value::Commit(v) => Some(NativeCommit { inner: v.clone() }),
            _ => None,
        }
    }

    #[napi(getter)]
    pub fn publication(&self) -> Option<Publication> {
        match &self.value {
            Value::Invitation(v) => Some(invitation_publication(v)),
            Value::PreJoin(v) => Some(prejoin_publication(v)),
            Value::Claim(v) => Some(claim_publication(v)),
            Value::Reservation(v) => Some(reservation_publication(v)),
            _ => None,
        }
    }

    #[napi(getter)]
    pub fn welcome(&self) -> Option<NativeWelcome> {
        match &self.value {
            Value::Welcome(v) => Some(NativeWelcome { inner: v.clone() }),
            _ => None,
        }
    }

    #[napi(getter)]
    pub fn activation(&self) -> Option<NativeActivationAcceptance> {
        match &self.value {
            Value::Activation(v) => Some(NativeActivationAcceptance { inner: v.clone() }),
            _ => None,
        }
    }

    #[napi(getter)]
    pub fn epoch_ready(&self) -> Option<NativeEpochReadyAcceptance> {
        match &self.value {
            Value::EpochReady(v) => Some(NativeEpochReadyAcceptance { inner: v.clone() }),
            _ => None,
        }
    }

    #[napi(getter)]
    pub fn re_pair(&self) -> Option<NativeRePairRequirement> {
        match &self.value {
            Value::RePair(v) => Some(NativeRePairRequirement { inner: v.clone() }),
            _ => None,
        }
    }
}

/// Result of a state-changing endpoint call: the exact pending request, or an exact result that
/// needs no new barrier.
#[napi]
pub struct WitnessOutcome {
    pending: Option<PendingWitnessRequest>,
    released: Option<Value>,
}

#[napi]
impl WitnessOutcome {
    #[napi(getter)]
    pub fn tag(&self) -> String {
        if self.pending.is_some() {
            "pending"
        } else {
            "released"
        }
        .into()
    }

    #[napi(getter)]
    pub fn pending(&self) -> Option<PendingWitness> {
        self.pending.as_ref().map(pending_witness)
    }

    #[napi(getter)]
    pub fn result(&self) -> Option<NativeResult> {
        self.released.clone().map(|value| NativeResult { value })
    }
}

fn outcome<T>(value: Outcome<T>, into: impl FnOnce(T) -> Value) -> WitnessOutcome {
    match value {
        Outcome::Pending(request) => WitnessOutcome {
            pending: Some(request),
            released: None,
        },
        Outcome::Released(value) => WitnessOutcome {
            pending: None,
            released: Some(into(value)),
        },
    }
}

// ---- Construction ----------------------------------------------------------------------------

#[cfg(feature = "test-fixtures")]
fn test_config(
    root: String,
    account: Buffer,
    installation: Buffer,
    session: Buffer,
    device: Option<Buffer>,
    witness: &TestWitness,
) -> Result<Config> {
    Ok(Config {
        root: PathBuf::from(root),
        account: id(account.as_ref())?,
        installation: id(installation.as_ref())?,
        session: id(session.as_ref())?,
        device: device.map(|v| id(v.as_ref())).transpose()?,
        keys: Arc::new(test_store::TestKeys::default()),
        trust: witness.inner.trust(),
    })
}

#[cfg(all(feature = "test-fixtures", target_os = "windows"))]
fn windows_test_config(
    root: String,
    account: Buffer,
    installation: Buffer,
    session: Buffer,
    device: Option<Buffer>,
    witness: &TestWitness,
) -> Result<Config> {
    let root = PathBuf::from(root);
    let keys = axl_e2ee::persistence::windows_test_envelope_key_store(&root.join("dpapi"))
        .map_err(map_persistence)?;
    Ok(Config {
        root,
        account: id(account.as_ref())?,
        installation: id(installation.as_ref())?,
        session: id(session.as_ref())?,
        device: device.map(|value| id(value.as_ref())).transpose()?,
        keys,
        trust: witness.inner.trust(),
    })
}

/// Test storage with replica trust named by a deployment instead of an in-process witness. Used by
/// deployment tests whose endpoints certify through a hosted witness; production storage and
/// build-pinned production trust remain unavailable.
#[cfg(feature = "test-fixtures")]
fn configured_config(
    root: String,
    account: Buffer,
    installation: Buffer,
    session: Buffer,
    device: Option<Buffer>,
    trust: Buffer,
) -> Result<Config> {
    let trust = copy_bounded(
        trust.as_ref(),
        axl_e2ee::witness::REPLICA_TRUST_CONFIG_MAX_BYTES,
        "bound_exceeded",
    )?;
    Ok(Config {
        root: PathBuf::from(root),
        account: id(account.as_ref())?,
        installation: id(installation.as_ref())?,
        session: id(session.as_ref())?,
        device: device.map(|v| id(v.as_ref())).transpose()?,
        keys: Arc::new(test_store::TestKeys::default()),
        trust: Arc::new(
            ReplicaTrustSet::decode_config(&trust).map_err(|_| error("invalid_argument"))?,
        ),
    })
}

#[cfg(any(feature = "test-fixtures", feature = "deployment-test"))]
fn daemon_handle(config: Config) -> DaemonEndpoint {
    DaemonEndpoint {
        state: Arc::new(DaemonState {
            gate: HandleGate::new(),
            config,
            endpoint: Mutex::new(None),
        }),
    }
}
#[cfg(feature = "test-fixtures")]
fn device_handle(config: Config) -> DeviceEndpoint {
    DeviceEndpoint {
        state: Arc::new(DeviceState {
            gate: HandleGate::new(),
            config,
            endpoint: Mutex::new(None),
        }),
    }
}

/// The replica trust configuration pinned into this deployment-test build.
#[cfg(feature = "deployment-test")]
const DEPLOYMENT_TEST_REPLICA_TRUST: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/replica-trust.bin"));

/// Hosted deployment-test daemon endpoint: storage under `root`, envelope keys in an owner-only
/// file beside it, and certificates verified against the build-pinned replica trust. It is the
/// same endpoint as production in every other respect and exists only in deployment-test builds.
#[cfg(feature = "deployment-test")]
#[napi]
pub fn deployment_test_daemon_endpoint(
    root: String,
    account: Buffer,
    installation: Buffer,
    session: Buffer,
) -> Result<DaemonEndpoint> {
    let root = PathBuf::from(root);
    let keys = deployment_store::DeploymentTestFileKeys::open(&root.join("keys"))
        .map_err(map_persistence)?;
    let trust = ReplicaTrustSet::decode_config(DEPLOYMENT_TEST_REPLICA_TRUST)
        .map_err(|_| error("rollback_anchor_unavailable"))?;
    Ok(daemon_handle(Config {
        root,
        account: id(account.as_ref())?,
        installation: id(installation.as_ref())?,
        session: id(session.as_ref())?,
        device: None,
        keys: Arc::new(keys),
        trust: Arc::new(trust),
    }))
}

#[doc(hidden)]
pub struct FailTask(&'static str);
impl napi::Task for FailTask {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> Result<()> {
        Err(error(self.0))
    }
    fn resolve(&mut self, _: napi::Env, _: ()) -> Result<()> {
        Ok(())
    }
}

#[napi]
pub fn create_daemon_endpoint() -> AsyncTask<FailTask> {
    AsyncTask::new(FailTask("secure_store_unavailable"))
}
#[napi]
pub fn open_daemon_endpoint() -> AsyncTask<FailTask> {
    AsyncTask::new(FailTask("rollback_anchor_unavailable"))
}
#[napi]
pub fn create_device_endpoint() -> AsyncTask<FailTask> {
    AsyncTask::new(FailTask("secure_store_unavailable"))
}
#[napi]
pub fn open_device_endpoint() -> AsyncTask<FailTask> {
    AsyncTask::new(FailTask("rollback_anchor_unavailable"))
}

/// Deterministic in-process three-replica witness. Test artifact only.
#[cfg(feature = "test-fixtures")]
#[napi]
pub struct TestWitness {
    inner: Arc<axl_e2ee::test_witness::TestWitness>,
}

#[cfg(feature = "test-fixtures")]
#[napi]
impl TestWitness {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: axl_e2ee::test_witness::TestWitness::new(),
        }
    }

    /// Answer one exact request with a unanimous certificate, exactly as the replicas would.
    #[napi]
    pub fn respond(&self, request: Buffer) -> Result<Buffer> {
        let request = copy_bounded(
            request.as_ref(),
            WITNESS_REQUEST_MAX_BYTES,
            "bound_exceeded",
        )?;
        axl_e2ee::witness::WitnessRequest::decode(&request).map_err(map_witness)?;
        self.inner
            .respond(&request)
            .map(|bytes| bytes.into())
            .map_err(|_| error("witness_unavailable"))
    }

    #[napi]
    pub fn set_unavailable(&self, value: bool) {
        self.inner.set_unavailable(value);
    }

    #[napi]
    pub fn set_forge_signature(&self, value: bool) {
        self.inner.set_forge_signature(value);
    }

    #[napi]
    pub fn roll_back_all(&self, request: Buffer) -> Result<()> {
        self.inner.roll_back_all(&self.known_request(request)?);
        Ok(())
    }

    #[napi]
    pub fn advance_foreign(&self, request: Buffer) -> Result<()> {
        self.inner.advance_foreign(&self.known_request(request)?);
        Ok(())
    }

    #[napi]
    pub fn revoke(&self, request: Buffer) -> Result<()> {
        self.inner.revoke(&self.known_request(request)?);
        Ok(())
    }

    #[napi(getter)]
    pub fn responses(&self) -> BigInt {
        bigint(self.inner.responses())
    }

    /// The canonical trust configuration naming this witness's replica keys.
    #[napi(getter)]
    pub fn trust_config(&self) -> Result<Buffer> {
        self.inner
            .trust()
            .encode_config()
            .map(Buffer::from)
            .map_err(map_witness)
    }

    fn known_request(&self, request: Buffer) -> Result<Vec<u8>> {
        let request = copy_bounded(
            request.as_ref(),
            WITNESS_REQUEST_MAX_BYTES,
            "bound_exceeded",
        )?;
        axl_e2ee::witness::WitnessRequest::decode(&request).map_err(map_witness)?;
        if self.inner.head(&request).is_none() {
            return Err(error("not_found"));
        }
        Ok(request)
    }
}

#[cfg(feature = "test-fixtures")]
impl Default for TestWitness {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "test-fixtures")]
#[napi]
pub fn test_daemon_endpoint(
    root: String,
    account: Buffer,
    installation: Buffer,
    session: Buffer,
    witness: &TestWitness,
) -> Result<DaemonEndpoint> {
    Ok(daemon_handle(test_config(
        root,
        account,
        installation,
        session,
        None,
        witness,
    )?))
}
#[cfg(feature = "test-fixtures")]
#[napi]
pub fn test_device_endpoint(
    root: String,
    account: Buffer,
    installation: Buffer,
    session: Buffer,
    device: Buffer,
    witness: &TestWitness,
) -> Result<DeviceEndpoint> {
    Ok(device_handle(test_config(
        root,
        account,
        installation,
        session,
        Some(device),
        witness,
    )?))
}

#[cfg(feature = "test-fixtures")]
#[napi]
pub fn configured_daemon_endpoint(
    root: String,
    account: Buffer,
    installation: Buffer,
    session: Buffer,
    trust: Buffer,
) -> Result<DaemonEndpoint> {
    Ok(daemon_handle(configured_config(
        root,
        account,
        installation,
        session,
        None,
        trust,
    )?))
}
#[cfg(feature = "test-fixtures")]
#[napi]
pub fn configured_device_endpoint(
    root: String,
    account: Buffer,
    installation: Buffer,
    session: Buffer,
    device: Buffer,
    trust: Buffer,
) -> Result<DeviceEndpoint> {
    Ok(device_handle(configured_config(
        root,
        account,
        installation,
        session,
        Some(device),
        trust,
    )?))
}

#[cfg(all(feature = "test-fixtures", target_os = "windows"))]
#[napi]
pub fn test_windows_daemon_endpoint(
    root: String,
    account: Buffer,
    installation: Buffer,
    session: Buffer,
    witness: &TestWitness,
) -> Result<DaemonEndpoint> {
    Ok(daemon_handle(windows_test_config(
        root,
        account,
        installation,
        session,
        None,
        witness,
    )?))
}

#[cfg(all(feature = "test-fixtures", target_os = "windows"))]
#[napi]
pub fn test_windows_device_endpoint(
    root: String,
    account: Buffer,
    installation: Buffer,
    session: Buffer,
    device: Buffer,
    witness: &TestWitness,
) -> Result<DeviceEndpoint> {
    Ok(device_handle(windows_test_config(
        root,
        account,
        installation,
        session,
        Some(device),
        witness,
    )?))
}

#[cfg(feature = "test-fixtures")]
#[napi]
pub fn test_panic(endpoint: &DaemonEndpoint) -> Result<AsyncTask<Work<String>>> {
    endpoint.work(move |_, _| panic!("contained test panic"))
}

// ---- Typed values ----------------------------------------------------------------------------

#[napi(object)]
pub struct Publication {
    pub tag: String,
    pub bytes: Option<Buffer>,
    pub secondary_bytes: Option<Buffer>,
    pub hash: Option<Buffer>,
    pub group_id: Option<Buffer>,
    pub expires_at_ms: Option<BigInt>,
    pub comparison: Option<String>,
    pub reservation: Option<NativeReservationIntent>,
}

/// The complete exact `ReservationIntent` released by a confirmed claim or a reservation.
#[napi(object)]
pub struct NativeReservationIntent {
    pub reservation_id: Buffer,
    pub crypto_session_id: Buffer,
    pub account_id: Buffer,
    pub installation_id: Buffer,
    pub device_id: Buffer,
    pub claim_hash: Buffer,
    pub key_package_hash: Buffer,
    pub expires_at_ms: BigInt,
}

fn reservation_intent(v: &ReservationIntent) -> NativeReservationIntent {
    NativeReservationIntent {
        reservation_id: v.reservation_id.to_vec().into(),
        crypto_session_id: v.crypto_session_id.to_vec().into(),
        account_id: v.account_id.to_vec().into(),
        installation_id: v.installation_id.to_vec().into(),
        device_id: v.device_id.to_vec().into(),
        claim_hash: v.claim_hash.to_vec().into(),
        key_package_hash: v.key_package_hash.to_vec().into(),
        expires_at_ms: bigint(v.expires_at_ms),
    }
}

fn reserved_publication(tag: &str, v: &ReservationIntent) -> Publication {
    Publication {
        tag: tag.into(),
        bytes: None,
        secondary_bytes: None,
        hash: None,
        group_id: None,
        expires_at_ms: None,
        comparison: None,
        reservation: Some(reservation_intent(v)),
    }
}

#[napi]
pub struct NativeOutbox {
    inner: OutboxRecord,
}
#[napi]
impl NativeOutbox {
    #[napi(getter)]
    pub fn operation_id(&self) -> Buffer {
        self.inner.operation_id().to_vec().into()
    }
    #[napi(getter)]
    pub fn crypto_session_id(&self) -> Buffer {
        self.inner.crypto_session_id().to_vec().into()
    }
    #[napi(getter)]
    pub fn logical_message_id(&self) -> Buffer {
        self.inner.logical_message_id().to_vec().into()
    }
    #[napi(getter)]
    pub fn message_class(&self) -> String {
        message_class(self.inner.class()).into()
    }
    #[napi(getter)]
    pub fn epoch(&self) -> BigInt {
        bigint(self.inner.epoch())
    }
    #[napi(getter)]
    pub fn hosted_grant_generation(&self) -> BigInt {
        bigint(self.inner.hosted_generation())
    }
    #[napi(getter)]
    pub fn profile_revision(&self) -> u32 {
        u32::from(self.inner.profile_revision())
    }
    #[napi(getter)]
    pub fn retry_state(&self) -> String {
        match self.inner.retry_state() {
            RetryState::Pending => "pending",
            RetryState::Acknowledged => "acknowledged",
        }
        .into()
    }
    #[napi(getter)]
    pub fn ciphertext(&self) -> Buffer {
        self.inner.ciphertext().to_vec().into()
    }
    #[napi(getter)]
    pub fn commit_id(&self) -> Option<Buffer> {
        self.inner.commit().map(|v| v.commit_id.to_vec().into())
    }
    #[napi(getter)]
    pub fn target_epoch(&self) -> Option<BigInt> {
        self.inner.commit().map(|v| bigint(v.target_epoch))
    }
    #[napi(getter)]
    pub fn epoch_authenticator(&self) -> Option<Buffer> {
        self.inner
            .commit()
            .map(|v| v.epoch_authenticator.to_vec().into())
    }
}

fn message_class(value: axl_e2ee::MessageClass) -> &'static str {
    match value {
        axl_e2ee::MessageClass::ApplicationRequest => "application_request",
        axl_e2ee::MessageClass::ApplicationDelivery => "application_delivery",
        axl_e2ee::MessageClass::UpdateProposal => "update_proposal",
        axl_e2ee::MessageClass::Commit => "commit",
        axl_e2ee::MessageClass::EpochReady => "epoch_ready",
        axl_e2ee::MessageClass::PairActivation => "pair_activation",
        axl_e2ee::MessageClass::ResyncControl => "resync_control",
    }
}

#[napi]
pub struct NativePlaintext {
    inner: DurablePlaintext,
}
#[napi]
impl NativePlaintext {
    #[napi(getter)]
    pub fn operation_id(&self) -> Buffer {
        self.inner.operation_id.to_vec().into()
    }
    #[napi(getter)]
    pub fn logical_message_id(&self) -> Buffer {
        self.inner.logical_message_id.to_vec().into()
    }
    #[napi(getter)]
    pub fn epoch(&self) -> BigInt {
        bigint(self.inner.epoch)
    }
    #[napi(getter)]
    pub fn plaintext(&self) -> Buffer {
        self.inner.plaintext().to_vec().into()
    }
}

/// Durable identity of an accepted handshake or acknowledged receive.
#[napi]
pub struct NativeAccepted {
    inner: AcceptedMessageRecord,
}
#[napi]
impl NativeAccepted {
    #[napi(getter)]
    pub fn operation_id(&self) -> Buffer {
        self.inner.operation_id.to_vec().into()
    }
    #[napi(getter)]
    pub fn crypto_session_id(&self) -> Buffer {
        self.inner.crypto_session_id.to_vec().into()
    }
    #[napi(getter)]
    pub fn logical_message_id(&self) -> Buffer {
        self.inner.logical_message_id.to_vec().into()
    }
    #[napi(getter)]
    pub fn message_class(&self) -> String {
        message_class(self.inner.class).into()
    }
    #[napi(getter)]
    pub fn epoch(&self) -> BigInt {
        bigint(self.inner.epoch)
    }
    #[napi(getter)]
    pub fn acknowledged(&self) -> bool {
        self.inner.acknowledged
    }
}

/// Metadata of a commit applied to the device group state. Pass it to `prepareEpochReady`.
#[napi]
pub struct NativeCommit {
    inner: CommitMetadata,
}
#[napi]
impl NativeCommit {
    #[napi(getter)]
    pub fn commit_id(&self) -> Buffer {
        self.inner.commit_id.to_vec().into()
    }
    #[napi(getter)]
    pub fn target_epoch(&self) -> BigInt {
        bigint(self.inner.target_epoch)
    }
    #[napi(getter)]
    pub fn epoch_authenticator(&self) -> Buffer {
        self.inner.epoch_authenticator.to_vec().into()
    }
}

#[napi]
pub struct NativeWelcome {
    inner: WelcomePublication,
}
#[napi]
impl NativeWelcome {
    #[napi(getter)]
    pub fn bytes(&self) -> Buffer {
        self.inner.bytes().to_vec().into()
    }
    #[napi(getter)]
    pub fn group_id(&self) -> Buffer {
        self.inner.group_id().to_vec().into()
    }
    #[napi(getter)]
    pub fn claim_hash(&self) -> Buffer {
        self.inner.claim_hash().to_vec().into()
    }
    #[napi(getter)]
    pub fn expires_at_ms(&self) -> BigInt {
        bigint(self.inner.expires_at_ms())
    }
}

#[napi]
pub struct NativeActivationAcceptance {
    inner: ActivationAcceptance,
}
#[napi]
impl NativeActivationAcceptance {
    #[napi(getter)]
    pub fn crypto_session_id(&self) -> Buffer {
        self.inner.crypto_session_id().to_vec().into()
    }
    #[napi(getter)]
    pub fn group_id(&self) -> Buffer {
        self.inner.group_id().to_vec().into()
    }
    #[napi(getter)]
    pub fn claim_hash(&self) -> Buffer {
        self.inner.claim_hash().to_vec().into()
    }
    #[napi(getter)]
    pub fn activation_hash(&self) -> Buffer {
        self.inner.activation_hash().to_vec().into()
    }
}

#[napi]
pub struct NativeEpochReadyAcceptance {
    inner: EpochReadyAcceptance,
}
#[napi]
impl NativeEpochReadyAcceptance {
    #[napi(getter)]
    pub fn crypto_session_id(&self) -> Buffer {
        self.inner.crypto_session_id().to_vec().into()
    }
    #[napi(getter)]
    pub fn commit_id(&self) -> Buffer {
        self.inner.commit_id().to_vec().into()
    }
}

#[napi]
pub struct NativeRePairRequirement {
    inner: RePairRequirement,
}
#[napi]
impl NativeRePairRequirement {
    #[napi(getter)]
    pub fn device_id(&self) -> Buffer {
        self.inner.device_id().to_vec().into()
    }
    #[napi(getter)]
    pub fn crypto_session_id(&self) -> Buffer {
        self.inner.crypto_session_id().to_vec().into()
    }
    #[napi(getter)]
    pub fn group_id(&self) -> Option<Buffer> {
        self.inner.group_id().map(|v| v.to_vec().into())
    }
    #[napi(getter)]
    pub fn key_package_hash(&self) -> Buffer {
        self.inner.key_package_hash().to_vec().into()
    }
}

fn publication(
    tag: &str,
    bytes: Option<&[u8]>,
    secondary: Option<&[u8]>,
    hash: Option<&[u8]>,
    group: Option<&[u8]>,
    expires: Option<u64>,
    comparison: Option<String>,
) -> Publication {
    Publication {
        tag: tag.into(),
        bytes: bytes.map(|v| v.to_vec().into()),
        secondary_bytes: secondary.map(|v| v.to_vec().into()),
        hash: hash.map(|v| v.to_vec().into()),
        group_id: group.map(|v| v.to_vec().into()),
        expires_at_ms: expires.map(bigint),
        comparison,
        reservation: None,
    }
}
fn invitation_publication(p: &InvitationPublication) -> Publication {
    publication(
        "issued",
        Some(p.bytes()),
        None,
        Some(&p.invitation_hash()),
        None,
        Some(p.expires_at_ms()),
        None,
    )
}
fn prejoin_publication(p: &PreJoinPublication) -> Publication {
    publication(
        "prepared",
        Some(p.claim()),
        Some(p.key_package()),
        Some(&p.invitation_hash()),
        None,
        Some(p.expires_at_ms()),
        None,
    )
}
fn claim_publication(result: &ClaimSubmission) -> Publication {
    match result {
        ClaimSubmission::Pending {
            claim_hash,
            comparison,
        } => publication(
            "pending",
            None,
            None,
            Some(claim_hash),
            None,
            None,
            Some(comparison.clone()),
        ),
        ClaimSubmission::Confirmed(v) => reserved_publication("confirmed", v),
        ClaimSubmission::Accepted(v) => welcome_publication("accepted", v),
        ClaimSubmission::Consumed => publication("consumed", None, None, None, None, None, None),
        ClaimSubmission::Rejected { reason } => publication(
            reason
                .map_or("rejected".into(), |v| {
                    format!("rejected_{v:?}").to_ascii_lowercase()
                })
                .as_str(),
            None,
            None,
            None,
            None,
            None,
            None,
        ),
        ClaimSubmission::Cancelled => publication("cancelled", None, None, None, None, None, None),
        ClaimSubmission::Expired => publication("expired", None, None, None, None, None, None),
        ClaimSubmission::Conflict => publication("conflict", None, None, None, None, None, None),
    }
}
fn reservation_publication(value: &ReservationOutcome) -> Publication {
    match value {
        ReservationOutcome::Reserved(v) => reserved_publication("reserved", v),
        ReservationOutcome::Busy => publication("busy", None, None, None, None, None, None),
        ReservationOutcome::Expired => publication("expired", None, None, None, None, None, None),
        ReservationOutcome::Consumed => publication("consumed", None, None, None, None, None, None),
        ReservationOutcome::Rejected => publication("rejected", None, None, None, None, None, None),
        ReservationOutcome::Unavailable => {
            publication("unavailable", None, None, None, None, None, None)
        }
    }
}
fn welcome_publication(tag: &str, value: &WelcomePublication) -> Publication {
    publication(
        tag,
        Some(value.bytes()),
        None,
        Some(&value.claim_hash()),
        Some(&value.group_id()),
        Some(value.expires_at_ms()),
        None,
    )
}
fn lifecycle(value: PairLifecycle) -> String {
    match value {
        PairLifecycle::AwaitingActivation => "awaiting_activation",
        PairLifecycle::Active => "active",
        PairLifecycle::ReplacementProposed => "replacement_proposed",
        PairLifecycle::WaitingForEpochReady => "waiting_for_epoch_ready",
        PairLifecycle::Removed => "removed",
        PairLifecycle::Revoked => "revoked",
        PairLifecycle::Reset => "reset",
    }
    .into()
}
fn invitation_lifecycle(value: InvitationLifecycle) -> String {
    format!("{value:?}").to_ascii_lowercase()
}
fn prejoin_lifecycle(value: PreJoinLifecycle) -> String {
    match value {
        PreJoinLifecycle::PreJoin => "pre_join",
        PreJoinLifecycle::Expired => "expired",
        PreJoinLifecycle::Cancelled => "cancelled",
        PreJoinLifecycle::Joined => "joined",
        PreJoinLifecycle::Activated => "activated",
        PreJoinLifecycle::Removed => "removed",
        PreJoinLifecycle::Reset => "reset",
    }
    .into()
}
fn outbox(value: OutboxRecord) -> NativeOutbox {
    NativeOutbox { inner: value }
}
fn plaintext(value: DurablePlaintext) -> NativePlaintext {
    NativePlaintext { inner: value }
}

// ---- Endpoint work ---------------------------------------------------------------------------

impl DaemonEndpoint {
    fn work<
        T: Send + 'static + napi::bindgen_prelude::ToNapiValue + napi::bindgen_prelude::TypeName,
    >(
        &self,
        f: impl FnOnce(&mut Option<DurablePendingInvitation>, &Config) -> Result<T> + Send + 'static,
    ) -> Result<AsyncTask<Work<T>>> {
        let lease = self.state.gate.acquire(false)?;
        let state = Arc::clone(&self.state);
        Ok(AsyncTask::new(Work::new(lease, move || {
            let mut endpoint = state.endpoint.lock().map_err(|_| error("internal_error"))?;
            f(&mut endpoint, &state.config)
        })))
    }
}
impl DeviceEndpoint {
    fn work<
        T: Send + 'static + napi::bindgen_prelude::ToNapiValue + napi::bindgen_prelude::TypeName,
    >(
        &self,
        f: impl FnOnce(&mut Option<DurablePreJoinDevice>, &Config) -> Result<T> + Send + 'static,
    ) -> Result<AsyncTask<Work<T>>> {
        let lease = self.state.gate.acquire(false)?;
        let state = Arc::clone(&self.state);
        Ok(AsyncTask::new(Work::new(lease, move || {
            let mut endpoint = state.endpoint.lock().map_err(|_| error("internal_error"))?;
            f(&mut endpoint, &state.config)
        })))
    }
}

fn daemon_mut(
    value: &mut Option<DurablePendingInvitation>,
) -> Result<&mut DurablePendingInvitation> {
    value.as_mut().ok_or_else(|| error("invalid_lifecycle"))
}
fn device_mut(value: &mut Option<DurablePreJoinDevice>) -> Result<&mut DurablePreJoinDevice> {
    value.as_mut().ok_or_else(|| error("invalid_lifecycle"))
}

/// Endpoint-owned witness operations shared by both facades. The durable pending record is
/// reloaded on every call; no in-memory handle is recovery authority.
fn witness_read_request<E: WitnessEndpoint>(endpoint: &E) -> Result<Buffer> {
    endpoint
        .witness_read_request()
        .map(Buffer::from)
        .map_err(map_persistence)
}
fn reconcile_witness<E: WitnessEndpoint>(
    endpoint: &E,
    certificate: &[u8],
) -> Result<WitnessReconciliation> {
    endpoint
        .reconcile_witness(certificate)
        .map(reconciliation)
        .map_err(map_persistence)
}
fn pending_witness_of<E: WitnessEndpoint>(endpoint: &E) -> Result<Option<PendingWitness>> {
    endpoint
        .pending_witness()
        .map(|value| value.as_ref().map(pending_witness))
        .map_err(map_persistence)
}
fn continue_witness<E: WitnessEndpoint>(
    endpoint: &E,
    operation_id: Id,
    certificate: &[u8],
) -> Result<NativeResult> {
    let value = endpoint
        .continue_witness(operation_id, certificate)
        .map_err(map_persistence)?;
    Ok(NativeResult {
        value: Value::try_from(value)?,
    })
}
fn certificate_bytes(certificate: Buffer) -> Result<Vec<u8>> {
    copy_bounded(
        certificate.as_ref(),
        WITNESS_CERTIFICATE_MAX_BYTES,
        "bound_exceeded",
    )
}

#[napi]
impl DaemonEndpoint {
    /// Create the daemon endpoint and return the counter-1 `register` request. The invitation
    /// stays withheld until `continueWitness` completes that registration.
    #[napi]
    pub fn issue(&self, operation_id: Buffer) -> Result<AsyncTask<Work<PendingWitness>>> {
        let op = id(operation_id.as_ref())?;
        self.work(move |slot, c| {
            let (endpoint, request) = DurablePendingInvitation::issue(
                &c.root,
                Identity::daemon(c.account, c.installation),
                c.session,
                op,
                Arc::clone(&c.keys),
                Arc::clone(&c.trust),
            )
            .map_err(map_persistence)?;
            *slot = Some(endpoint);
            Ok(pending_witness(&request))
        })
    }
    #[napi]
    pub fn reopen(&self) -> Result<AsyncTask<Work<String>>> {
        let lease = self.state.gate.acquire(true)?;
        let state = Arc::clone(&self.state);
        Ok(AsyncTask::new(Work::new(lease, move || {
            let opened = DurablePendingInvitation::open(
                &state.config.root,
                state.config.session,
                Arc::clone(&state.config.keys),
                Arc::clone(&state.config.trust),
            )
            .map_err(map_open)?;
            *state.endpoint.lock().map_err(|_| error("internal_error"))? = Some(opened);
            state.gate.reopen();
            Ok("opened".into())
        })))
    }

    #[napi]
    pub fn witness_read_request(&self) -> Result<AsyncTask<Work<Buffer>>> {
        self.work(move |slot, _| witness_read_request(daemon_mut(slot)?))
    }
    #[napi]
    pub fn reconcile_witness(
        &self,
        certificate: Buffer,
    ) -> Result<AsyncTask<Work<WitnessReconciliation>>> {
        let certificate = certificate_bytes(certificate)?;
        self.work(move |slot, _| reconcile_witness(daemon_mut(slot)?, &certificate))
    }
    #[napi]
    pub fn pending_witness(&self) -> Result<AsyncTask<Work<Option<PendingWitness>>>> {
        self.work(move |slot, _| pending_witness_of(daemon_mut(slot)?))
    }
    #[napi]
    pub fn continue_witness(
        &self,
        operation_id: Buffer,
        certificate: Buffer,
    ) -> Result<AsyncTask<Work<NativeResult>>> {
        let op = id(operation_id.as_ref())?;
        let certificate = certificate_bytes(certificate)?;
        self.work(move |slot, _| continue_witness(daemon_mut(slot)?, op, &certificate))
    }
    /// Persist a due invitation expiry as a witnessed operation. `null` when nothing is due.
    #[napi]
    pub fn expire_if_needed(&self) -> Result<AsyncTask<Work<Option<PendingWitness>>>> {
        self.work(move |slot, _| {
            Ok(daemon_mut(slot)?
                .expire_if_needed()
                .map_err(map_persistence)?
                .as_ref()
                .map(pending_witness))
        })
    }
    /// Persist a due Welcome expiry as a witnessed operation. `null` when nothing is due.
    #[napi]
    pub fn expire_welcome_if_needed(&self) -> Result<AsyncTask<Work<Option<PendingWitness>>>> {
        self.work(move |slot, _| {
            Ok(daemon_mut(slot)?
                .expire_welcome_if_needed()
                .map_err(map_persistence)?
                .as_ref()
                .map(pending_witness))
        })
    }

    #[napi]
    pub fn invitation(&self) -> Result<AsyncTask<Work<Publication>>> {
        self.work(move |slot, _| {
            Ok(invitation_publication(
                &daemon_mut(slot)?.publication().map_err(map_persistence)?,
            ))
        })
    }
    #[napi]
    pub fn status(&self) -> Result<AsyncTask<Work<String>>> {
        self.work(move |slot, _| {
            Ok(invitation_lifecycle(
                daemon_mut(slot)?.lifecycle().map_err(map_persistence)?,
            ))
        })
    }
    #[napi]
    pub fn cancel(&self, operation_id: Buffer) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?.cancel(op).map_err(map_persistence)?,
                Value::InvitationState,
            ))
        })
    }
    #[napi]
    pub fn submit_claim(
        &self,
        operation_id: Buffer,
        claim: Buffer,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let claim = copy_bounded(claim.as_ref(), PAIRING_CLAIM_MAX_BYTES, "bound_exceeded")?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?
                    .submit_claim(op, &claim)
                    .map_err(map_persistence)?,
                Value::Claim,
            ))
        })
    }
    #[napi]
    pub fn confirm_claim(
        &self,
        operation_id: Buffer,
        claim_hash: Buffer,
        reservation_id: Buffer,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let reservation = id(reservation_id.as_ref())?;
        let hash = fixed::<48>(claim_hash.as_ref(), "invalid_hash")?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?
                    .confirm_claim(op, hash, reservation)
                    .map_err(map_persistence)?,
                Value::Reservation,
            ))
        })
    }
    #[napi]
    pub fn release_reservation(
        &self,
        operation_id: Buffer,
        reservation_id: Buffer,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let reservation = id(reservation_id.as_ref())?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?
                    .release_reservation(op, reservation)
                    .map_err(map_persistence)?,
                Value::Reservation,
            ))
        })
    }
    #[napi]
    pub fn create_welcome(
        &self,
        operation_id: Buffer,
        reservation_id: Buffer,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let reservation = id(reservation_id.as_ref())?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?
                    .create_welcome(op, reservation)
                    .map_err(map_persistence)?,
                Value::from,
            ))
        })
    }
    /// Read-only: the committed Welcome for a claim hash. Withheld while a barrier is pending.
    #[napi]
    pub fn recover_welcome(&self, claim_hash: Buffer) -> Result<AsyncTask<Work<NativeWelcome>>> {
        let hash = fixed::<48>(claim_hash.as_ref(), "invalid_hash")?;
        self.work(move |slot, _| {
            match daemon_mut(slot)?
                .recover_welcome(hash)
                .map_err(map_persistence)?
            {
                WelcomeOutcome::Committed(v) | WelcomeOutcome::Duplicate(v) => {
                    Ok(NativeWelcome { inner: v })
                }
                value => Err(error(match value {
                    WelcomeOutcome::Expired => "expired",
                    WelcomeOutcome::Consumed => "consumed",
                    WelcomeOutcome::Rejected => "invalid_argument",
                    WelcomeOutcome::Busy => "lifecycle_busy",
                    WelcomeOutcome::Unavailable => "storage_unavailable",
                    _ => "internal_error",
                })),
            }
        })
    }
    #[napi]
    pub fn accept_activation(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        ciphertext: Buffer,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let bytes = copy_bounded(ciphertext.as_ref(), ENVELOPE_MAX_BYTES, "bound_exceeded")?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?
                    .accept_activation(op, logical, &bytes)
                    .map_err(map_persistence)?,
                Value::from,
            ))
        })
    }
    #[napi]
    pub fn prepare_application(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
        plaintext: Buffer,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let bytes = copy_bounded(plaintext.as_ref(), APPLICATION_MAX_BYTES, "bound_exceeded")?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?
                    .prepare_application(op, logical, generation, &bytes)
                    .map_err(map_persistence)?,
                Value::Outbox,
            ))
        })
    }
    #[napi]
    pub fn receive_application(
        &self,
        operation_id: Buffer,
        ciphertext: Buffer,
        logical_id: Buffer,
        generation: BigInt,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let bytes = copy_bounded(ciphertext.as_ref(), ENVELOPE_MAX_BYTES, "bound_exceeded")?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?
                    .receive_application(op, &bytes, logical, generation)
                    .map_err(map_persistence)?,
                Value::Plaintext,
            ))
        })
    }
    #[napi]
    pub fn receive_replacement_proposal(
        &self,
        operation_id: Buffer,
        ciphertext: Buffer,
        logical_id: Buffer,
        generation: BigInt,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let bytes = copy_bounded(ciphertext.as_ref(), HANDSHAKE_MAX_BYTES, "bound_exceeded")?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?
                    .receive_replacement_proposal(op, &bytes, logical, generation)
                    .map_err(map_persistence)?,
                Value::Accepted,
            ))
        })
    }
    #[napi]
    pub fn create_update_commit(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?
                    .create_update_commit(op, logical, generation)
                    .map_err(map_persistence)?,
                Value::Outbox,
            ))
        })
    }
    #[napi]
    pub fn accept_epoch_ready(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
        ciphertext: Buffer,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let bytes = copy_bounded(ciphertext.as_ref(), 2 * 1024, "bound_exceeded")?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?
                    .accept_epoch_ready(op, logical, generation, &bytes)
                    .map_err(map_persistence)?,
                Value::EpochReady,
            ))
        })
    }
    #[napi]
    pub fn prepare_epoch_ready_confirmation(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
        acceptance: &NativeEpochReadyAcceptance,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let acceptance = acceptance.inner.clone();
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?
                    .prepare_epoch_ready_confirmation(op, logical, generation, &acceptance)
                    .map_err(map_persistence)?,
                Value::Outbox,
            ))
        })
    }
    #[napi]
    pub fn remove_device(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        daemon_removal(self, operation_id, logical_id, generation, false)
    }
    #[napi]
    pub fn revoke_device(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        daemon_removal(self, operation_id, logical_id, generation, true)
    }
    #[napi]
    pub fn reset(&self, operation_id: Buffer) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?.reset(op).map_err(map_persistence)?,
                Value::from,
            ))
        })
    }
    #[napi]
    pub fn mark_revoked(&self, operation_id: Buffer) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?
                    .mark_revoked(op)
                    .map_err(map_persistence)?,
                Value::from,
            ))
        })
    }
    /// Read-only: transmittable records. A record whose barrier is unconfirmed is withheld.
    #[napi]
    pub fn pending_outbox(&self) -> Result<AsyncTask<Work<Vec<NativeOutbox>>>> {
        self.work(move |slot, _| {
            daemon_mut(slot)?
                .pending_outbox()
                .map(|records| records.into_iter().map(outbox).collect())
                .map_err(map_persistence)
        })
    }
    #[napi]
    pub fn acknowledge_outbox(
        &self,
        operation_id: Buffer,
        target: Buffer,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let target = id(target.as_ref())?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?
                    .acknowledge_outbox(op, target)
                    .map_err(map_persistence)?,
                Value::Outbox,
            ))
        })
    }
    #[napi]
    pub fn acknowledge_receive(
        &self,
        operation_id: Buffer,
        target: Buffer,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let target = id(target.as_ref())?;
        self.work(move |slot, _| {
            Ok(outcome(
                daemon_mut(slot)?
                    .acknowledge_receive(op, target)
                    .map_err(map_persistence)?,
                Value::Accepted,
            ))
        })
    }
    #[napi]
    pub fn pair_status(&self) -> Result<AsyncTask<Work<Option<String>>>> {
        self.work(move |slot, _| {
            Ok(daemon_mut(slot)?
                .pair_lifecycle()
                .map_err(map_persistence)?
                .map(lifecycle))
        })
    }
    #[napi]
    pub fn close(&self) -> Result<()> {
        let _lease = self.state.gate.acquire(true)?;
        if let Some(endpoint) = self
            .state
            .endpoint
            .lock()
            .map_err(|_| error("internal_error"))?
            .as_ref()
        {
            endpoint.close().map_err(map_persistence)?;
        }
        self.state.gate.close();
        Ok(())
    }
}

fn daemon_removal(
    endpoint: &DaemonEndpoint,
    operation_id: Buffer,
    logical_id: Buffer,
    generation: BigInt,
    revoke: bool,
) -> Result<AsyncTask<Work<WitnessOutcome>>> {
    let op = id(operation_id.as_ref())?;
    let logical = id(logical_id.as_ref())?;
    let generation = u64_from_bigint(&generation)?;
    endpoint.work(move |slot, _| {
        let value = if revoke {
            daemon_mut(slot)?.revoke_device(op, logical, generation)
        } else {
            daemon_mut(slot)?.remove_device(op, logical, generation)
        }
        .map_err(map_persistence)?;
        Ok(outcome(value, Value::from))
    })
}

#[napi]
impl DeviceEndpoint {
    /// Create the device endpoint and return the counter-1 `register` request. The claim and
    /// KeyPackage stay withheld until `continueWitness` completes that registration.
    #[napi]
    pub fn prepare(
        &self,
        invitation: Buffer,
        operation_id: Buffer,
    ) -> Result<AsyncTask<Work<PendingWitness>>> {
        let bytes = copy_bounded(
            invitation.as_ref(),
            PAIRING_INVITATION_MAX_BYTES,
            "bound_exceeded",
        )?;
        let op = id(operation_id.as_ref())?;
        self.work(move |slot, c| {
            let identity = Identity::device(
                c.account,
                c.installation,
                c.device.ok_or_else(|| error("invalid_id"))?,
            )
            .map_err(map_core)?;
            let (endpoint, request) = DurablePreJoinDevice::prepare(
                &c.root,
                identity,
                &bytes,
                op,
                Arc::clone(&c.keys),
                Arc::clone(&c.trust),
            )
            .map_err(map_persistence)?;
            *slot = Some(endpoint);
            Ok(pending_witness(&request))
        })
    }
    /// Re-pair after `reset`: a fresh crypto session and group are required by `requirement`.
    #[napi]
    pub fn prepare_repair(
        &self,
        invitation: Buffer,
        operation_id: Buffer,
        requirement: &NativeRePairRequirement,
    ) -> Result<AsyncTask<Work<PendingWitness>>> {
        let bytes = copy_bounded(
            invitation.as_ref(),
            PAIRING_INVITATION_MAX_BYTES,
            "bound_exceeded",
        )?;
        let op = id(operation_id.as_ref())?;
        let requirement = requirement.inner.clone();
        self.work(move |slot, c| {
            let identity = Identity::device(
                c.account,
                c.installation,
                c.device.ok_or_else(|| error("invalid_id"))?,
            )
            .map_err(map_core)?;
            let (endpoint, request) = DurablePreJoinDevice::prepare_repair(
                &c.root,
                identity,
                &bytes,
                op,
                Arc::clone(&c.keys),
                Arc::clone(&c.trust),
                &requirement,
            )
            .map_err(map_persistence)?;
            *slot = Some(endpoint);
            Ok(pending_witness(&request))
        })
    }
    #[napi]
    pub fn reopen(&self) -> Result<AsyncTask<Work<String>>> {
        let lease = self.state.gate.acquire(true)?;
        let state = Arc::clone(&self.state);
        Ok(AsyncTask::new(Work::new(lease, move || {
            let opened = DurablePreJoinDevice::open(
                &state.config.root,
                state.config.session,
                Arc::clone(&state.config.keys),
                Arc::clone(&state.config.trust),
            )
            .map_err(map_open)?;
            *state.endpoint.lock().map_err(|_| error("internal_error"))? = Some(opened);
            state.gate.reopen();
            Ok("opened".into())
        })))
    }

    #[napi]
    pub fn witness_read_request(&self) -> Result<AsyncTask<Work<Buffer>>> {
        self.work(move |slot, _| witness_read_request(device_mut(slot)?))
    }
    #[napi]
    pub fn reconcile_witness(
        &self,
        certificate: Buffer,
    ) -> Result<AsyncTask<Work<WitnessReconciliation>>> {
        let certificate = certificate_bytes(certificate)?;
        self.work(move |slot, _| reconcile_witness(device_mut(slot)?, &certificate))
    }
    #[napi]
    pub fn pending_witness(&self) -> Result<AsyncTask<Work<Option<PendingWitness>>>> {
        self.work(move |slot, _| pending_witness_of(device_mut(slot)?))
    }
    #[napi]
    pub fn continue_witness(
        &self,
        operation_id: Buffer,
        certificate: Buffer,
    ) -> Result<AsyncTask<Work<NativeResult>>> {
        let op = id(operation_id.as_ref())?;
        let certificate = certificate_bytes(certificate)?;
        self.work(move |slot, _| continue_witness(device_mut(slot)?, op, &certificate))
    }
    /// Persist a due pre-join expiry as a witnessed operation. `null` when nothing is due.
    #[napi]
    pub fn expire_if_needed(&self) -> Result<AsyncTask<Work<Option<PendingWitness>>>> {
        self.work(move |slot, _| {
            Ok(device_mut(slot)?
                .expire_if_needed()
                .map_err(map_persistence)?
                .as_ref()
                .map(pending_witness))
        })
    }

    #[napi]
    pub fn status(&self) -> Result<AsyncTask<Work<String>>> {
        self.work(move |slot, _| {
            Ok(prejoin_lifecycle(
                device_mut(slot)?.lifecycle().map_err(map_persistence)?,
            ))
        })
    }
    #[napi]
    pub fn publication(&self) -> Result<AsyncTask<Work<Publication>>> {
        self.work(move |slot, _| {
            Ok(prejoin_publication(
                &device_mut(slot)?.publication().map_err(map_persistence)?,
            ))
        })
    }
    #[napi]
    pub fn join(
        &self,
        operation_id: Buffer,
        welcome: &NativeWelcome,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let welcome = welcome.inner.clone();
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .join(op, &welcome)
                    .map_err(map_persistence)?,
                Value::PreJoinState,
            ))
        })
    }
    #[napi]
    pub fn join_published_welcome(
        &self,
        operation_id: Buffer,
        welcome: Buffer,
        claim_hash: Buffer,
        welcome_hash: Buffer,
        expires_at_ms: BigInt,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let bytes = copy_bounded(welcome.as_ref(), HANDSHAKE_MAX_BYTES, "bound_exceeded")?;
        let claim_hash = fixed::<48>(claim_hash.as_ref(), "invalid_hash")?;
        let welcome_hash = fixed::<48>(welcome_hash.as_ref(), "invalid_hash")?;
        let expires_at_ms = u64_from_bigint(&expires_at_ms)?;
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .join_published_welcome(op, &bytes, claim_hash, welcome_hash, expires_at_ms)
                    .map_err(map_persistence)?,
                Value::PreJoinState,
            ))
        })
    }
    #[napi]
    pub fn prepare_activation(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .prepare_activation(op, logical)
                    .map_err(map_persistence)?,
                Value::from,
            ))
        })
    }
    #[napi]
    pub fn acknowledge_activation(
        &self,
        operation_id: Buffer,
        acceptance: &NativeActivationAcceptance,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let acceptance = acceptance.inner.clone();
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .acknowledge_activation(op, &acceptance)
                    .map_err(map_persistence)?,
                Value::PairState,
            ))
        })
    }
    #[napi]
    pub fn prepare_application(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
        plaintext: Buffer,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let bytes = copy_bounded(plaintext.as_ref(), APPLICATION_MAX_BYTES, "bound_exceeded")?;
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .prepare_application(op, logical, generation, &bytes)
                    .map_err(map_persistence)?,
                Value::Outbox,
            ))
        })
    }
    #[napi]
    pub fn receive_application(
        &self,
        operation_id: Buffer,
        ciphertext: Buffer,
        logical_id: Buffer,
        generation: BigInt,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let bytes = copy_bounded(ciphertext.as_ref(), ENVELOPE_MAX_BYTES, "bound_exceeded")?;
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .receive_application(op, &bytes, logical, generation)
                    .map_err(map_persistence)?,
                Value::Plaintext,
            ))
        })
    }
    #[napi]
    pub fn prepare_replacement(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .prepare_replacement(op, logical, generation)
                    .map_err(map_persistence)?,
                Value::Outbox,
            ))
        })
    }
    /// Apply a locally held commit record. One OpenMLS transition; the epoch-ready message is a
    /// separate operation (`prepareEpochReady`).
    #[napi]
    pub fn apply_update_commit(
        &self,
        operation_id: Buffer,
        commit: &NativeOutbox,
        commit_logical_id: Buffer,
        generation: BigInt,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let commit = commit.inner.clone();
        let logical = id(commit_logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .apply_update_commit(op, &commit, logical, generation)
                    .map_err(map_persistence)?,
                Value::Commit,
            ))
        })
    }
    /// Apply a received commit ciphertext. One OpenMLS transition; the epoch-ready message is a
    /// separate operation (`prepareEpochReady`).
    #[napi]
    pub fn apply_received_update_commit(
        &self,
        operation_id: Buffer,
        ciphertext: Buffer,
        commit_logical_id: Buffer,
        generation: BigInt,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let bytes = copy_bounded(ciphertext.as_ref(), HANDSHAKE_MAX_BYTES, "bound_exceeded")?;
        let logical = id(commit_logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .apply_received_update_commit(op, &bytes, logical, generation)
                    .map_err(map_persistence)?,
                Value::Commit,
            ))
        })
    }
    /// Create the epoch-ready message for the exact commit metadata released by the apply
    /// operation.
    #[napi]
    pub fn prepare_epoch_ready(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
        commit: &NativeCommit,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let commit = commit.inner.clone();
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .prepare_epoch_ready(op, logical, generation, &commit)
                    .map_err(map_persistence)?,
                Value::Outbox,
            ))
        })
    }
    #[napi]
    pub fn accept_epoch_ready_confirmation(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
        ciphertext: Buffer,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let bytes = copy_bounded(ciphertext.as_ref(), 2 * 1024, "bound_exceeded")?;
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .accept_epoch_ready_confirmation(op, logical, generation, &bytes)
                    .map_err(map_persistence)?,
                Value::PairState,
            ))
        })
    }
    #[napi]
    pub fn acknowledge_epoch_ready(
        &self,
        operation_id: Buffer,
        acceptance: &NativeEpochReadyAcceptance,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let acceptance = acceptance.inner.clone();
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .acknowledge_epoch_ready(op, &acceptance)
                    .map_err(map_persistence)?,
                Value::PairState,
            ))
        })
    }
    #[napi]
    pub fn apply_removal(
        &self,
        operation_id: Buffer,
        commit: &NativeOutbox,
        logical_id: Buffer,
        generation: BigInt,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let commit = commit.inner.clone();
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .apply_removal(op, &commit, logical, generation)
                    .map_err(map_persistence)?,
                Value::from,
            ))
        })
    }
    #[napi]
    pub fn reset(&self, operation_id: Buffer) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?.reset(op).map_err(map_persistence)?,
                Value::RePair,
            ))
        })
    }
    /// Read-only: transmittable records. A record whose barrier is unconfirmed is withheld.
    #[napi]
    pub fn pending_outbox(&self) -> Result<AsyncTask<Work<Vec<NativeOutbox>>>> {
        self.work(move |slot, _| {
            device_mut(slot)?
                .pending_outbox()
                .map(|records| records.into_iter().map(outbox).collect())
                .map_err(map_persistence)
        })
    }
    #[napi]
    pub fn acknowledge_outbox(
        &self,
        operation_id: Buffer,
        target: Buffer,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let target = id(target.as_ref())?;
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .acknowledge_outbox(op, target)
                    .map_err(map_persistence)?,
                Value::Outbox,
            ))
        })
    }
    #[napi]
    pub fn acknowledge_receive(
        &self,
        operation_id: Buffer,
        target: Buffer,
    ) -> Result<AsyncTask<Work<WitnessOutcome>>> {
        let op = id(operation_id.as_ref())?;
        let target = id(target.as_ref())?;
        self.work(move |slot, _| {
            Ok(outcome(
                device_mut(slot)?
                    .acknowledge_receive(op, target)
                    .map_err(map_persistence)?,
                Value::Accepted,
            ))
        })
    }
    #[napi]
    pub fn pair_status(&self) -> Result<AsyncTask<Work<Option<String>>>> {
        self.work(move |slot, _| {
            Ok(device_mut(slot)?
                .pair_lifecycle()
                .map_err(map_persistence)?
                .map(lifecycle))
        })
    }
    #[napi]
    pub fn close(&self) -> Result<()> {
        let _lease = self.state.gate.acquire(true)?;
        if let Some(endpoint) = self
            .state
            .endpoint
            .lock()
            .map_err(|_| error("internal_error"))?
            .as_ref()
        {
            endpoint.close().map_err(map_persistence)?;
        }
        self.state.gate.close();
        Ok(())
    }
}

fn fixed<const N: usize>(bytes: &[u8], code: &'static str) -> Result<[u8; N]> {
    if bytes.len() != N {
        return Err(error(code));
    }
    bytes.try_into().map_err(|_| error(code))
}

// ---- Error mapping ---------------------------------------------------------------------------

fn map_pairing(value: axl_e2ee::pairing::PairingError) -> napi::Error {
    use axl_e2ee::pairing::PairingError::*;
    error(match value {
        BoundExceeded => "bound_exceeded",
        ClockRollback => "clock_rollback",
        Expired => "expired",
        IdentityMismatch => "identity_mismatch",
        NonceMismatch => "identity_mismatch",
        WrongProfile | WrongProfileRevision | WrongVersion => "profile_mismatch",
        InvalidSignature | InvalidCredential | InvalidTime | NonCanonical
        | CryptographicFailure | NonCounting => "invalid_argument",
    })
}
fn map_core(value: axl_e2ee::Error) -> napi::Error {
    use axl_e2ee::Error::*;
    error(match value {
        BoundExceeded(_) => "bound_exceeded",
        ClockRollback => "clock_rollback",
        FutureEpoch => "future_epoch",
        StaleEpoch => "stale_epoch",
        DuplicateCiphertext => "replay_rejected",
        WrongProfile => "profile_mismatch",
        WrongGroup | InvalidIdentity(_) => "identity_mismatch",
        InvalidCiphertext => "invalid_ciphertext",
        TransactionPending => "lifecycle_busy",
        CompetingCommit => "conflict",
        _ => "invalid_argument",
    })
}
#[cfg(feature = "test-fixtures")]
fn map_witness(value: WitnessError) -> napi::Error {
    use WitnessError::*;
    error(match value {
        BoundExceeded => "bound_exceeded",
        CredentialMismatch => "witness_auth_failed",
        OperationConflict | OperationMismatch => "witness_operation_conflict",
        RegistrationConflict => "witness_registration_conflict",
        InvalidExpected | StaleExpected => "witness_invalid_expected",
        Revoked => "endpoint_revoked",
        Forked | Quarantined => "witness_conflict",
        FreshWitnessRequired => "fresh_witness_required",
        PendingOperation | NoPendingOperation | OutputBlocked => "witness_unavailable",
        Malformed | NonCanonical | ProfileMismatch | LineageMismatch | RoleMismatch
        | GenerationMismatch | CounterMismatch | CommitmentMismatch | PredecessorMismatch
        | RequestHashMismatch | RevocationMismatch | InvalidSignature | InvalidQuorum
        | DuplicateReplica | InvalidTrustSet | UnpinnedKey | MixedReceipts | UnexpectedResult
        | CorruptState | Crypto => "witness_receipt_invalid",
    })
}

/// Opening an endpoint whose database is missing is state loss, not a missing record.
fn map_open(value: PersistenceError) -> napi::Error {
    match value {
        PersistenceError::NotFound => error("state_loss"),
        other => map_persistence(other),
    }
}

fn map_persistence(value: PersistenceError) -> napi::Error {
    use PersistenceError::*;
    match value {
        Core(v) => map_core(v),
        KeyRecordMissing => error("key_record_missing"),
        KeyUnavailable | SecureStoreUnavailable => error("secure_store_unavailable"),
        SecureStoreLocked => error("secure_store_locked"),
        SecureStoreAccessDenied => error("secure_store_access_denied"),
        SecureStoreAmbiguous => error("secure_store_ambiguous"),
        StateLoss => error("state_loss"),
        LifecycleBusy => error("lifecycle_busy"),
        Conflict | GenerationConflict => error("conflict"),
        Corrupt => error("corrupt_state"),
        UnsupportedSchema => error("unsupported_schema"),
        Quarantined => error("rollback_detected"),
        EndpointRevoked => error("endpoint_revoked"),
        FreshWitnessRequired => error("fresh_witness_required"),
        InitializationIncomplete => error("initialization_incomplete"),
        NotFound => error("not_found"),
        AlreadyExists => error("already_exists"),
        AlreadyAcknowledged => error("already_acknowledged"),
        RetentionExceeded => error("retention_exceeded"),
        IdentityMismatch => error("identity_mismatch"),
        WitnessConflict => error("witness_conflict"),
        WitnessInvalidExpected => error("witness_invalid_expected"),
        WitnessOperationConflict => error("witness_operation_conflict"),
        WitnessReceiptInvalid => error("witness_receipt_invalid"),
        WitnessRegistrationConflict => error("witness_registration_conflict"),
        WitnessUnavailable => error("witness_unavailable"),
        Io | Storage | InjectedFault => error("storage_unavailable"),
    }
}

#[cfg(test)]
mod tests {
    use super::ERROR_CODES;

    /// Every stable code the binding can emit, including codes passed indirectly through
    /// `fixed`, `ok_or_else`, or helper functions, must be declared in `ERROR_CODES`. The
    /// declaration check in `scripts/check-abi.mjs` only sees `ERROR_CODES`; this closes the gap
    /// for codes it cannot observe.
    #[test]
    fn every_emitted_error_code_is_declared() {
        let sources = [
            include_str!("lib.rs"),
            include_str!("support.rs"),
            include_str!("test_store.rs"),
        ];
        let mut emitted = std::collections::BTreeSet::new();
        for source in sources {
            for (index, _) in source.match_indices('"') {
                let rest = &source[index + 1..];
                let Some(end) = rest.find('"') else { continue };
                let literal = &rest[..end];
                let is_code = !literal.is_empty()
                    && literal.len() <= 40
                    && literal
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                    && literal.contains('_');
                if !is_code {
                    continue;
                }
                let before = &source[..index];
                let context = before.trim_end();
                let emits = context.ends_with("error(")
                    || context.ends_with("Err(error(")
                    || (context.ends_with(',') && before_is_fixed_call(context));
                if emits {
                    emitted.insert(literal);
                }
            }
        }
        assert!(
            emitted.contains("invalid_hash"),
            "scanner did not see fixed() codes"
        );
        assert!(emitted.contains("unsupported_schema"));
        let undeclared: Vec<_> = emitted
            .iter()
            .filter(|code| !ERROR_CODES.contains(code))
            .collect();
        assert!(
            undeclared.is_empty(),
            "undeclared error codes: {undeclared:?}"
        );
        assert!(
            ERROR_CODES.windows(2).all(|w| w[0] < w[1]),
            "ERROR_CODES not sorted"
        );
    }

    fn before_is_fixed_call(context: &str) -> bool {
        // `fixed::<N>(bytes, "code")`: the literal follows the first argument's comma.
        let Some(open) = context.rfind("fixed::<") else {
            return false;
        };
        let tail = &context[open..];
        tail.matches('(').count() == tail.matches(')').count() + 1
    }
}
