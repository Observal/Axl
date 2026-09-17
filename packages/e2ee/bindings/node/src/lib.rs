// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

//! Private Node-API binding for the Axl endpoint E2EE core.

mod support;
#[cfg(feature = "test-fixtures")]
mod test_store;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[cfg(feature = "test-fixtures")]
use axl_e2ee::witness::{ReplicaKey, ReplicaTrust};
use axl_e2ee::{
    APPLICATION_MAX_BYTES, ENVELOPE_MAX_BYTES, HANDSHAKE_MAX_BYTES, Id, Identity, PROFILE_ID,
    PROFILE_REVISION,
    pairing::{
        PAIRING_CLAIM_MAX_BYTES, PAIRING_INVITATION_MAX_BYTES, PairingClaimV1, PairingInvitation,
    },
    persistence::{
        ActivationAcceptance, ActivationOutcome, ClaimSubmission, DurablePendingInvitation,
        DurablePlaintext, DurablePreJoinDevice, EnvelopeKeyStore, EpochReadyAcceptance,
        InvitationLifecycle, OutboxRecord, PairLifecycle, PersistenceError, PreJoinLifecycle,
        RePairRequirement, RemovalOutcome, ReservationOutcome, RetryState, RollbackAnchor,
        RollbackState, WelcomeOutcome, WelcomePublication,
    },
    witness::{
        PendingWitnessOperation, PendingWitnessStatus, ReplicaTrustSet,
        WITNESS_CERTIFICATE_MAX_BYTES, WitnessError,
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

const ABI_VERSION: u32 = 1;
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
    "expired",
    "future_epoch",
    "identity_mismatch",
    "internal_error",
    "invalid_argument",
    "invalid_ciphertext",
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

#[allow(dead_code)]
struct UnavailableKeys;
impl EnvelopeKeyStore for UnavailableKeys {
    fn available(&self) -> bool {
        false
    }
    fn prepare(
        &self,
        _: Id,
        _: Id,
        _: &[u8; 32],
        _: &[u8],
    ) -> std::result::Result<(), PersistenceError> {
        Err(PersistenceError::KeyUnavailable)
    }
    fn load(&self, _: Id, _: Id, _: &[u8]) -> std::result::Result<[u8; 32], PersistenceError> {
        Err(PersistenceError::KeyUnavailable)
    }
    fn activate(&self, _: Id, _: Id, _: &[u8]) -> std::result::Result<(), PersistenceError> {
        Err(PersistenceError::KeyUnavailable)
    }
    fn reconcile_prepared(
        &self,
        _: Id,
        _: Option<(Id, Vec<u8>)>,
    ) -> std::result::Result<(), PersistenceError> {
        Err(PersistenceError::KeyUnavailable)
    }
    fn erase(&self, _: Id, _: Id) -> std::result::Result<(), PersistenceError> {
        Err(PersistenceError::KeyUnavailable)
    }
    fn destroy_session(&self, _: Id) -> std::result::Result<(), PersistenceError> {
        Err(PersistenceError::KeyUnavailable)
    }
}
#[allow(dead_code)]
struct UnavailableAnchor;
impl RollbackAnchor for UnavailableAnchor {
    fn available(&self) -> bool {
        false
    }
    fn read(&self, _: Id) -> std::result::Result<RollbackState, PersistenceError> {
        Err(PersistenceError::AnchorUnavailable)
    }
    fn advance(
        &self,
        _: Id,
        _: &RollbackState,
        _: &RollbackState,
        _: Id,
    ) -> std::result::Result<(), PersistenceError> {
        Err(PersistenceError::AnchorUnavailable)
    }
}

#[derive(Clone)]
struct Config {
    root: PathBuf,
    account: Id,
    installation: Id,
    session: Id,
    device: Option<Id>,
    keys: Arc<dyn EnvelopeKeyStore>,
    anchor: Arc<dyn RollbackAnchor>,
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

struct PendingWitnessState {
    operation: PendingWitnessOperation,
    trust: ReplicaTrustSet,
}

/// Native-owned continuation. JavaScript can transport only the immutable request and return a
/// certificate for the same operation ID.
#[napi]
pub struct NativePendingWitness {
    gate: Arc<HandleGate>,
    state: Arc<Mutex<PendingWitnessState>>,
}

impl NativePendingWitness {
    #[allow(dead_code)]
    fn new(operation: PendingWitnessOperation, trust: ReplicaTrustSet) -> Self {
        Self {
            gate: HandleGate::new(),
            state: Arc::new(Mutex::new(PendingWitnessState { operation, trust })),
        }
    }
}

#[napi]
impl NativePendingWitness {
    #[napi(getter)]
    pub fn operation_id(&self) -> Result<Buffer> {
        let state = self.state.lock().map_err(|_| error("internal_error"))?;
        Ok(state.operation.operation_id().to_vec().into())
    }

    #[napi(getter)]
    pub fn witness_request(&self) -> Result<Buffer> {
        let state = self.state.lock().map_err(|_| error("internal_error"))?;
        Ok(state.operation.witness_request().to_vec().into())
    }

    #[napi(getter)]
    pub fn request_hash(&self) -> Result<Buffer> {
        let state = self.state.lock().map_err(|_| error("internal_error"))?;
        Ok(state.operation.request_hash().to_vec().into())
    }

    #[napi(getter)]
    pub fn status(&self) -> Result<String> {
        let state = self.state.lock().map_err(|_| error("internal_error"))?;
        Ok(match state.operation.status() {
            PendingWitnessStatus::AwaitingQuorum => "pending_quorum",
            PendingWitnessStatus::Ready => "committed",
        }
        .into())
    }

    #[napi]
    pub fn continue_witness(
        &self,
        operation_id: Buffer,
        certificate: Buffer,
    ) -> Result<AsyncTask<Work<Buffer>>> {
        let operation_id = id(operation_id.as_ref())?;
        let certificate = copy_bounded(
            certificate.as_ref(),
            WITNESS_CERTIFICATE_MAX_BYTES,
            "bound_exceeded",
        )?;
        let lease = self.gate.acquire(false)?;
        let state = Arc::clone(&self.state);
        Ok(AsyncTask::new(Work::new(lease, move || {
            let mut state = state.lock().map_err(|_| error("internal_error"))?;
            if state.operation.operation_id() != operation_id {
                return Err(error("witness_operation_conflict"));
            }
            let trust = state.trust.clone();
            state
                .operation
                .confirm_quorum(&certificate, &trust)
                .map_err(map_witness)?;
            Ok(state
                .operation
                .committed_result()
                .map_err(map_witness)?
                .to_vec()
                .into())
        })))
    }

    #[napi]
    pub fn close(&self) {
        self.gate.close();
    }
}

#[allow(dead_code)]
fn config(
    root: String,
    account: Buffer,
    installation: Buffer,
    session: Buffer,
    device: Option<Buffer>,
    test: bool,
) -> Result<Config> {
    let keys: Arc<dyn EnvelopeKeyStore> = if test {
        test_keys()
    } else {
        Arc::new(UnavailableKeys)
    };
    let anchor: Arc<dyn RollbackAnchor> = if test {
        test_anchor()
    } else {
        Arc::new(UnavailableAnchor)
    };
    Ok(Config {
        root: PathBuf::from(root),
        account: id(account.as_ref())?,
        installation: id(installation.as_ref())?,
        session: id(session.as_ref())?,
        device: device.map(|v| id(v.as_ref())).transpose()?,
        keys,
        anchor,
    })
}

#[cfg(all(feature = "test-fixtures", target_os = "windows"))]
fn windows_test_config(
    root: String,
    account: Buffer,
    installation: Buffer,
    session: Buffer,
    device: Option<Buffer>,
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
        anchor: test_anchor(),
    })
}

#[cfg(feature = "test-fixtures")]
fn test_keys() -> Arc<dyn EnvelopeKeyStore> {
    Arc::new(test_store::TestKeys::default())
}
#[cfg(not(feature = "test-fixtures"))]
#[allow(dead_code)]
fn test_keys() -> Arc<dyn EnvelopeKeyStore> {
    Arc::new(UnavailableKeys)
}
#[cfg(feature = "test-fixtures")]
fn test_anchor() -> Arc<dyn RollbackAnchor> {
    Arc::new(test_store::TestAnchor::default())
}
#[cfg(not(feature = "test-fixtures"))]
#[allow(dead_code)]
fn test_anchor() -> Arc<dyn RollbackAnchor> {
    Arc::new(UnavailableAnchor)
}

#[allow(dead_code)]
fn daemon_handle(config: Config) -> DaemonEndpoint {
    DaemonEndpoint {
        state: Arc::new(DaemonState {
            gate: HandleGate::new(),
            config,
            endpoint: Mutex::new(None),
        }),
    }
}
#[allow(dead_code)]
fn device_handle(config: Config) -> DeviceEndpoint {
    DeviceEndpoint {
        state: Arc::new(DeviceState {
            gate: HandleGate::new(),
            config,
            endpoint: Mutex::new(None),
        }),
    }
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

#[cfg(feature = "test-fixtures")]
#[napi]
pub fn test_daemon_endpoint(
    root: String,
    account: Buffer,
    installation: Buffer,
    session: Buffer,
) -> Result<DaemonEndpoint> {
    Ok(daemon_handle(config(
        root,
        account,
        installation,
        session,
        None,
        true,
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
) -> Result<DeviceEndpoint> {
    Ok(device_handle(config(
        root,
        account,
        installation,
        session,
        Some(device),
        true,
    )?))
}

#[cfg(all(feature = "test-fixtures", target_os = "windows"))]
#[napi]
pub fn test_windows_daemon_endpoint(
    root: String,
    account: Buffer,
    installation: Buffer,
    session: Buffer,
) -> Result<DaemonEndpoint> {
    Ok(daemon_handle(windows_test_config(
        root,
        account,
        installation,
        session,
        None,
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
) -> Result<DeviceEndpoint> {
    Ok(device_handle(windows_test_config(
        root,
        account,
        installation,
        session,
        Some(device),
    )?))
}

#[cfg(feature = "test-fixtures")]
#[napi]
pub fn test_panic(endpoint: &DaemonEndpoint) -> Result<AsyncTask<Work<String>>> {
    endpoint.work(move |_, _| panic!("contained test panic"))
}

#[cfg(feature = "test-fixtures")]
fn witness_fixture_trust() -> Result<ReplicaTrustSet> {
    let public_keys = [
        [
            0x1e, 0xbe, 0x96, 0x8b, 0x69, 0xd6, 0x14, 0xf9, 0xe4, 0xcb, 0x0f, 0x44, 0xbf, 0xc3,
            0x8c, 0x01, 0x0b, 0x35, 0x5c, 0x65, 0x2d, 0xc3, 0xc4, 0x79, 0x5f, 0x1b, 0x03, 0xcf,
            0xf7, 0xf8, 0x6e, 0xab,
        ],
        [
            0x48, 0x8d, 0xa5, 0xa0, 0xa4, 0xe3, 0x75, 0xf9, 0x4b, 0x45, 0xa0, 0x09, 0xf4, 0x57,
            0x33, 0xb3, 0xff, 0x9d, 0x6b, 0x01, 0x83, 0x5b, 0x21, 0x19, 0x66, 0x6c, 0x39, 0xed,
            0xfb, 0xe1, 0x3f, 0x60,
        ],
        [
            0x03, 0xc8, 0xc9, 0xea, 0xf5, 0xef, 0x22, 0x9b, 0x40, 0xa1, 0x26, 0x5e, 0xfa, 0x46,
            0x4b, 0x0a, 0xe0, 0x33, 0xfc, 0x1e, 0xea, 0xaf, 0x35, 0x6f, 0xb4, 0xdc, 0xf4, 0x1a,
            0x2b, 0x48, 0x14, 0xaa,
        ],
    ];
    let mut replicas = Vec::with_capacity(3);
    for (index, public_key) in public_keys.into_iter().enumerate() {
        let replica_byte = 0x14 + index as u8;
        let key_byte = 0x1e + index as u8;
        let key = ReplicaKey::new([key_byte; 16], public_key).map_err(map_witness)?;
        replicas.push(ReplicaTrust::new([replica_byte; 16], vec![key]).map_err(map_witness)?);
    }
    ReplicaTrustSet::new(replicas).map_err(map_witness)
}

#[cfg(feature = "test-fixtures")]
#[napi]
pub fn test_witness_pending(request: Buffer, exact_result: Buffer) -> Result<NativePendingWitness> {
    let request = copy_bounded(
        request.as_ref(),
        axl_e2ee::witness::WITNESS_REQUEST_MAX_BYTES,
        "bound_exceeded",
    )?;
    let exact_result = copy_bounded(exact_result.as_ref(), 1024 * 1024, "bound_exceeded")?;
    let operation = axl_e2ee::witness::test_pending_witness_operation(&request, &exact_result)
        .map_err(map_witness)?;
    Ok(NativePendingWitness::new(
        operation,
        witness_fixture_trust()?,
    ))
}

#[napi(object)]
pub struct Publication {
    pub tag: String,
    pub bytes: Option<Buffer>,
    pub secondary_bytes: Option<Buffer>,
    pub hash: Option<Buffer>,
    pub group_id: Option<Buffer>,
    pub expires_at_ms: Option<BigInt>,
    pub comparison: Option<String>,
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
        match self.inner.class() {
            axl_e2ee::MessageClass::ApplicationRequest => "application_request",
            axl_e2ee::MessageClass::ApplicationDelivery => "application_delivery",
            axl_e2ee::MessageClass::UpdateProposal => "update_proposal",
            axl_e2ee::MessageClass::Commit => "commit",
            axl_e2ee::MessageClass::EpochReady => "epoch_ready",
            axl_e2ee::MessageClass::PairActivation => "pair_activation",
            axl_e2ee::MessageClass::ResyncControl => "resync_control",
        }
        .into()
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

#[napi(object)]
pub struct StatusOutcome {
    pub tag: String,
    pub device_id: Option<Buffer>,
    pub crypto_session_id: Option<Buffer>,
    pub group_id: Option<Buffer>,
    pub key_package_hash: Option<Buffer>,
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
    }
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

#[napi]
impl DaemonEndpoint {
    #[napi]
    pub fn issue(&self, operation_id: Buffer) -> Result<AsyncTask<Work<Publication>>> {
        let op = id(operation_id.as_ref())?;
        self.work(move |slot, c| {
            let (endpoint, p) = DurablePendingInvitation::issue(
                &c.root,
                Identity::daemon(c.account, c.installation),
                c.session,
                op,
                Arc::clone(&c.keys),
                Arc::clone(&c.anchor),
            )
            .map_err(map_persistence)?;
            *slot = Some(endpoint);
            Ok(publication(
                "issued",
                Some(p.bytes()),
                None,
                Some(&p.invitation_hash()),
                None,
                Some(p.expires_at_ms()),
                None,
            ))
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
                Arc::clone(&state.config.anchor),
            )
            .map_err(map_persistence)?;
            *state.endpoint.lock().map_err(|_| error("internal_error"))? = Some(opened);
            state.gate.reopen();
            Ok("opened".into())
        })))
    }
    #[napi]
    pub fn invitation(&self) -> Result<AsyncTask<Work<Publication>>> {
        self.work(move |slot, _| {
            let p = daemon_mut(slot)?.publication().map_err(map_persistence)?;
            Ok(publication(
                "issued",
                Some(p.bytes()),
                None,
                Some(&p.invitation_hash()),
                None,
                Some(p.expires_at_ms()),
                None,
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
    pub fn cancel(&self, operation_id: Buffer) -> Result<AsyncTask<Work<String>>> {
        let op = id(operation_id.as_ref())?;
        self.work(move |slot, _| {
            Ok(invitation_lifecycle(
                daemon_mut(slot)?.cancel(op).map_err(map_persistence)?,
            ))
        })
    }
    #[napi]
    pub fn submit_claim(
        &self,
        operation_id: Buffer,
        claim: Buffer,
    ) -> Result<AsyncTask<Work<Publication>>> {
        let op = id(operation_id.as_ref())?;
        let claim = copy_bounded(claim.as_ref(), PAIRING_CLAIM_MAX_BYTES, "bound_exceeded")?;
        self.work(move |slot, _| {
            let result = daemon_mut(slot)?
                .submit_claim(op, &claim)
                .map_err(map_persistence)?;
            Ok(match result {
                ClaimSubmission::Pending {
                    claim_hash,
                    comparison,
                } => publication(
                    "pending",
                    None,
                    None,
                    Some(&claim_hash),
                    None,
                    None,
                    Some(comparison),
                ),
                ClaimSubmission::Confirmed(v) => publication(
                    "confirmed",
                    None,
                    None,
                    Some(&v.claim_hash),
                    None,
                    Some(v.expires_at_ms),
                    None,
                ),
                ClaimSubmission::Accepted(v) => welcome_publication("accepted", &v),
                ClaimSubmission::Consumed => {
                    publication("consumed", None, None, None, None, None, None)
                }
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
                ClaimSubmission::Cancelled => {
                    publication("cancelled", None, None, None, None, None, None)
                }
                ClaimSubmission::Expired => {
                    publication("expired", None, None, None, None, None, None)
                }
                ClaimSubmission::Conflict => {
                    publication("conflict", None, None, None, None, None, None)
                }
            })
        })
    }
    #[napi]
    pub fn confirm_claim(
        &self,
        operation_id: Buffer,
        claim_hash: Buffer,
        reservation_id: Buffer,
    ) -> Result<AsyncTask<Work<Publication>>> {
        let op = id(operation_id.as_ref())?;
        let reservation = id(reservation_id.as_ref())?;
        let hash = fixed::<48>(claim_hash.as_ref(), "invalid_hash")?;
        self.work(move |slot, _| {
            let value = daemon_mut(slot)?
                .confirm_claim(op, hash, reservation)
                .map_err(map_persistence)?;
            Ok(match value {
                ReservationOutcome::Reserved(v) => publication(
                    "reserved",
                    None,
                    None,
                    Some(&v.claim_hash),
                    None,
                    Some(v.expires_at_ms),
                    None,
                ),
                ReservationOutcome::Busy => publication("busy", None, None, None, None, None, None),
                ReservationOutcome::Expired => {
                    publication("expired", None, None, None, None, None, None)
                }
                ReservationOutcome::Consumed => {
                    publication("consumed", None, None, None, None, None, None)
                }
                ReservationOutcome::Rejected => {
                    publication("rejected", None, None, None, None, None, None)
                }
                ReservationOutcome::Unavailable => {
                    publication("unavailable", None, None, None, None, None, None)
                }
            })
        })
    }
    #[napi]
    pub fn release_reservation(
        &self,
        operation_id: Buffer,
        reservation_id: Buffer,
    ) -> Result<AsyncTask<Work<String>>> {
        let op = id(operation_id.as_ref())?;
        let reservation = id(reservation_id.as_ref())?;
        self.work(move |slot, _| {
            let tag = match daemon_mut(slot)?
                .release_reservation(op, reservation)
                .map_err(map_persistence)?
            {
                ReservationOutcome::Reserved(_) => "reserved",
                ReservationOutcome::Busy => "busy",
                ReservationOutcome::Expired => "expired",
                ReservationOutcome::Consumed => "consumed",
                ReservationOutcome::Rejected => "rejected",
                ReservationOutcome::Unavailable => "unavailable",
            };
            Ok(tag.into())
        })
    }
    #[napi]
    pub fn create_welcome(
        &self,
        operation_id: Buffer,
        reservation_id: Buffer,
    ) -> Result<AsyncTask<Work<NativeWelcome>>> {
        let op = id(operation_id.as_ref())?;
        let reservation = id(reservation_id.as_ref())?;
        self.work(move |slot, _| {
            match daemon_mut(slot)?
                .create_welcome(op, reservation)
                .map_err(map_persistence)?
            {
                WelcomeOutcome::Committed(v) | WelcomeOutcome::Duplicate(v) => {
                    Ok(NativeWelcome { inner: v })
                }
                value => Err(error(match value {
                    WelcomeOutcome::Busy => "lifecycle_busy",
                    WelcomeOutcome::Expired => "expired",
                    WelcomeOutcome::Consumed => "consumed",
                    WelcomeOutcome::Rejected => "invalid_argument",
                    WelcomeOutcome::Unavailable => "storage_unavailable",
                    _ => "internal_error",
                })),
            }
        })
    }
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
    ) -> Result<AsyncTask<Work<NativeActivationAcceptance>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let bytes = copy_bounded(ciphertext.as_ref(), ENVELOPE_MAX_BYTES, "bound_exceeded")?;
        self.work(move |slot, _| {
            match daemon_mut(slot)?
                .accept_activation(op, logical, &bytes)
                .map_err(map_persistence)?
            {
                ActivationOutcome::Activated(v) | ActivationOutcome::Duplicate(v) => {
                    Ok(NativeActivationAcceptance { inner: v })
                }
                _ => Err(error("invalid_lifecycle")),
            }
        })
    }
    #[napi]
    pub fn prepare_application(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
        plaintext: Buffer,
    ) -> Result<AsyncTask<Work<NativeOutbox>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let bytes = copy_bounded(plaintext.as_ref(), APPLICATION_MAX_BYTES, "bound_exceeded")?;
        self.work(move |slot, _| {
            Ok(outbox(
                daemon_mut(slot)?
                    .prepare_application(op, logical, generation, &bytes)
                    .map_err(map_persistence)?,
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
    ) -> Result<AsyncTask<Work<NativePlaintext>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let bytes = copy_bounded(ciphertext.as_ref(), ENVELOPE_MAX_BYTES, "bound_exceeded")?;
        self.work(move |slot, _| {
            Ok(plaintext(
                daemon_mut(slot)?
                    .receive_application(op, &bytes, logical, generation)
                    .map_err(map_persistence)?,
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
    ) -> Result<AsyncTask<Work<String>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let bytes = copy_bounded(ciphertext.as_ref(), HANDSHAKE_MAX_BYTES, "bound_exceeded")?;
        self.work(move |slot, _| {
            daemon_mut(slot)?
                .receive_replacement_proposal(op, &bytes, logical, generation)
                .map_err(map_persistence)?;
            Ok("accepted".into())
        })
    }
    #[napi]
    pub fn create_update_commit(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
    ) -> Result<AsyncTask<Work<NativeOutbox>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        self.work(move |slot, _| {
            Ok(outbox(
                daemon_mut(slot)?
                    .create_update_commit(op, logical, generation)
                    .map_err(map_persistence)?,
            ))
        })
    }
    #[napi]
    pub fn accept_epoch_ready(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        ciphertext: Buffer,
    ) -> Result<AsyncTask<Work<NativeEpochReadyAcceptance>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let bytes = copy_bounded(ciphertext.as_ref(), 2 * 1024, "bound_exceeded")?;
        self.work(move |slot, _| {
            Ok(NativeEpochReadyAcceptance {
                inner: daemon_mut(slot)?
                    .accept_epoch_ready(op, logical, &bytes)
                    .map_err(map_persistence)?,
            })
        })
    }
    #[napi]
    pub fn remove_device(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
    ) -> Result<AsyncTask<Work<NativeOutbox>>> {
        daemon_removal(self, operation_id, logical_id, generation, false)
    }
    #[napi]
    pub fn revoke_device(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
    ) -> Result<AsyncTask<Work<NativeOutbox>>> {
        daemon_removal(self, operation_id, logical_id, generation, true)
    }
    #[napi]
    pub fn reset(&self, operation_id: Buffer) -> Result<AsyncTask<Work<StatusOutcome>>> {
        let op = id(operation_id.as_ref())?;
        self.work(move |slot, _| {
            Ok(removal_status(
                daemon_mut(slot)?.reset(op).map_err(map_persistence)?,
            ))
        })
    }
    #[napi]
    pub fn mark_revoked(&self, operation_id: Buffer) -> Result<AsyncTask<Work<StatusOutcome>>> {
        let op = id(operation_id.as_ref())?;
        self.work(move |slot, _| {
            Ok(removal_status(
                daemon_mut(slot)?
                    .mark_revoked(op)
                    .map_err(map_persistence)?,
            ))
        })
    }
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
    ) -> Result<AsyncTask<Work<NativeOutbox>>> {
        let op = id(operation_id.as_ref())?;
        let target = id(target.as_ref())?;
        self.work(move |slot, _| {
            Ok(outbox(
                daemon_mut(slot)?
                    .acknowledge_outbox(op, target)
                    .map_err(map_persistence)?,
            ))
        })
    }
    #[napi]
    pub fn acknowledge_receive(
        &self,
        operation_id: Buffer,
        target: Buffer,
    ) -> Result<AsyncTask<Work<String>>> {
        let op = id(operation_id.as_ref())?;
        let target = id(target.as_ref())?;
        self.work(move |slot, _| {
            daemon_mut(slot)?
                .acknowledge_receive(op, target)
                .map_err(map_persistence)?;
            Ok("acknowledged".into())
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
) -> Result<AsyncTask<Work<NativeOutbox>>> {
    let op = id(operation_id.as_ref())?;
    let logical = id(logical_id.as_ref())?;
    let generation = u64_from_bigint(&generation)?;
    endpoint.work(move |slot, _| {
        let outcome = if revoke {
            daemon_mut(slot)?.revoke_device(op, logical, generation)
        } else {
            daemon_mut(slot)?.remove_device(op, logical, generation)
        }
        .map_err(map_persistence)?;
        match outcome {
            RemovalOutcome::Commit(v) => Ok(outbox(v)),
            _ => Err(error("invalid_lifecycle")),
        }
    })
}

#[napi]
impl DeviceEndpoint {
    #[napi]
    pub fn prepare(
        &self,
        invitation: Buffer,
        operation_id: Buffer,
    ) -> Result<AsyncTask<Work<Publication>>> {
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
            let (endpoint, p) = DurablePreJoinDevice::prepare(
                &c.root,
                identity,
                &bytes,
                op,
                Arc::clone(&c.keys),
                Arc::clone(&c.anchor),
            )
            .map_err(map_persistence)?;
            *slot = Some(endpoint);
            Ok(publication(
                "prepared",
                Some(p.claim()),
                Some(p.key_package()),
                Some(&p.invitation_hash()),
                None,
                Some(p.expires_at_ms()),
                None,
            ))
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
                Arc::clone(&state.config.anchor),
            )
            .map_err(map_persistence)?;
            *state.endpoint.lock().map_err(|_| error("internal_error"))? = Some(opened);
            state.gate.reopen();
            Ok("opened".into())
        })))
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
            let p = device_mut(slot)?.publication().map_err(map_persistence)?;
            Ok(publication(
                "prepared",
                Some(p.claim()),
                Some(p.key_package()),
                Some(&p.invitation_hash()),
                None,
                Some(p.expires_at_ms()),
                None,
            ))
        })
    }
    #[napi]
    pub fn join(
        &self,
        operation_id: Buffer,
        welcome: &NativeWelcome,
    ) -> Result<AsyncTask<Work<String>>> {
        let op = id(operation_id.as_ref())?;
        let welcome = welcome.inner.clone();
        self.work(move |slot, _| {
            Ok(prejoin_lifecycle(
                device_mut(slot)?
                    .join(op, &welcome)
                    .map_err(map_persistence)?,
            ))
        })
    }
    #[napi]
    pub fn prepare_activation(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
    ) -> Result<AsyncTask<Work<NativeOutbox>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        self.work(move |slot, _| {
            match device_mut(slot)?
                .prepare_activation(op, logical)
                .map_err(map_persistence)?
            {
                ActivationOutcome::Prepared(v) => Ok(outbox(v)),
                _ => Err(error("invalid_lifecycle")),
            }
        })
    }
    #[napi]
    pub fn acknowledge_activation(
        &self,
        operation_id: Buffer,
        acceptance: &NativeActivationAcceptance,
    ) -> Result<AsyncTask<Work<String>>> {
        let op = id(operation_id.as_ref())?;
        let acceptance = acceptance.inner.clone();
        self.work(move |slot, _| {
            Ok(lifecycle(
                device_mut(slot)?
                    .acknowledge_activation(op, &acceptance)
                    .map_err(map_persistence)?,
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
    ) -> Result<AsyncTask<Work<NativeOutbox>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let bytes = copy_bounded(plaintext.as_ref(), APPLICATION_MAX_BYTES, "bound_exceeded")?;
        self.work(move |slot, _| {
            Ok(outbox(
                device_mut(slot)?
                    .prepare_application(op, logical, generation, &bytes)
                    .map_err(map_persistence)?,
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
    ) -> Result<AsyncTask<Work<NativePlaintext>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let bytes = copy_bounded(ciphertext.as_ref(), ENVELOPE_MAX_BYTES, "bound_exceeded")?;
        self.work(move |slot, _| {
            Ok(plaintext(
                device_mut(slot)?
                    .receive_application(op, &bytes, logical, generation)
                    .map_err(map_persistence)?,
            ))
        })
    }
    #[napi]
    pub fn prepare_replacement(
        &self,
        operation_id: Buffer,
        logical_id: Buffer,
        generation: BigInt,
    ) -> Result<AsyncTask<Work<NativeOutbox>>> {
        let op = id(operation_id.as_ref())?;
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        self.work(move |slot, _| {
            Ok(outbox(
                device_mut(slot)?
                    .prepare_replacement(op, logical, generation)
                    .map_err(map_persistence)?,
            ))
        })
    }
    #[napi]
    pub fn apply_update_commit(
        &self,
        operation_id: Buffer,
        commit: &NativeOutbox,
        commit_logical_id: Buffer,
        generation: BigInt,
        ready_logical_id: Buffer,
    ) -> Result<AsyncTask<Work<NativeOutbox>>> {
        let op = id(operation_id.as_ref())?;
        let commit = commit.inner.clone();
        let logical = id(commit_logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let ready = id(ready_logical_id.as_ref())?;
        self.work(move |slot, _| {
            Ok(outbox(
                device_mut(slot)?
                    .apply_update_commit(op, &commit, logical, generation, ready)
                    .map_err(map_persistence)?,
            ))
        })
    }
    #[napi]
    pub fn apply_received_update_commit(
        &self,
        operation_id: Buffer,
        ciphertext: Buffer,
        commit_logical_id: Buffer,
        generation: BigInt,
        ready_logical_id: Buffer,
    ) -> Result<AsyncTask<Work<NativeOutbox>>> {
        let op = id(operation_id.as_ref())?;
        let bytes = copy_bounded(ciphertext.as_ref(), HANDSHAKE_MAX_BYTES, "bound_exceeded")?;
        let logical = id(commit_logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        let ready = id(ready_logical_id.as_ref())?;
        self.work(move |slot, _| {
            Ok(outbox(
                device_mut(slot)?
                    .apply_received_update_commit(op, &bytes, logical, generation, ready)
                    .map_err(map_persistence)?,
            ))
        })
    }
    #[napi]
    pub fn acknowledge_epoch_ready(
        &self,
        operation_id: Buffer,
        acceptance: &NativeEpochReadyAcceptance,
    ) -> Result<AsyncTask<Work<String>>> {
        let op = id(operation_id.as_ref())?;
        let acceptance = acceptance.inner.clone();
        self.work(move |slot, _| {
            Ok(lifecycle(
                device_mut(slot)?
                    .acknowledge_epoch_ready(op, &acceptance)
                    .map_err(map_persistence)?,
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
    ) -> Result<AsyncTask<Work<String>>> {
        let op = id(operation_id.as_ref())?;
        let commit = commit.inner.clone();
        let logical = id(logical_id.as_ref())?;
        let generation = u64_from_bigint(&generation)?;
        self.work(move |slot, _| {
            match device_mut(slot)?
                .apply_removal(op, &commit, logical, generation)
                .map_err(map_persistence)?
            {
                RemovalOutcome::Removed => Ok("removed".into()),
                _ => Err(error("invalid_lifecycle")),
            }
        })
    }
    #[napi]
    pub fn reset(&self, operation_id: Buffer) -> Result<AsyncTask<Work<NativeRePairRequirement>>> {
        let op = id(operation_id.as_ref())?;
        self.work(move |slot, _| {
            Ok(NativeRePairRequirement {
                inner: device_mut(slot)?.reset(op).map_err(map_persistence)?,
            })
        })
    }
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
    ) -> Result<AsyncTask<Work<NativeOutbox>>> {
        let op = id(operation_id.as_ref())?;
        let target = id(target.as_ref())?;
        self.work(move |slot, _| {
            Ok(outbox(
                device_mut(slot)?
                    .acknowledge_outbox(op, target)
                    .map_err(map_persistence)?,
            ))
        })
    }
    #[napi]
    pub fn acknowledge_receive(
        &self,
        operation_id: Buffer,
        target: Buffer,
    ) -> Result<AsyncTask<Work<String>>> {
        let op = id(operation_id.as_ref())?;
        let target = id(target.as_ref())?;
        self.work(move |slot, _| {
            device_mut(slot)?
                .acknowledge_receive(op, target)
                .map_err(map_persistence)?;
            Ok("acknowledged".into())
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
fn plaintext(value: DurablePlaintext) -> NativePlaintext {
    NativePlaintext { inner: value }
}
fn removal_status(value: RemovalOutcome) -> StatusOutcome {
    let empty = |tag: &str| StatusOutcome {
        tag: tag.into(),
        device_id: None,
        crypto_session_id: None,
        group_id: None,
        key_package_hash: None,
    };
    match value {
        RemovalOutcome::Removed => empty("removed"),
        RemovalOutcome::Revoked => empty("revoked"),
        RemovalOutcome::Commit(_) => empty("commit"),
        RemovalOutcome::RePairRequired(value) => StatusOutcome {
            tag: "re_pair_required".into(),
            device_id: Some(value.device_id().to_vec().into()),
            crypto_session_id: Some(value.crypto_session_id().to_vec().into()),
            group_id: value.group_id().map(|bytes| bytes.to_vec().into()),
            key_package_hash: Some(value.key_package_hash().to_vec().into()),
        },
    }
}

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
fn map_witness(value: WitnessError) -> napi::Error {
    use WitnessError::*;
    error(match value {
        BoundExceeded => "bound_exceeded",
        CredentialMismatch => "witness_auth_failed",
        OperationConflict | OperationMismatch => "witness_operation_conflict",
        RegistrationConflict => "witness_registration_conflict",
        InvalidExpected | StaleExpected => "witness_invalid_expected",
        Revoked | Forked | Quarantined => "witness_conflict",
        FreshWitnessRequired | PendingOperation | NoPendingOperation | OutputBlocked => {
            "witness_unavailable"
        }
        Malformed | NonCanonical | ProfileMismatch | LineageMismatch | RoleMismatch
        | GenerationMismatch | CounterMismatch | CommitmentMismatch | PredecessorMismatch
        | RequestHashMismatch | RevocationMismatch | InvalidSignature | InvalidQuorum
        | DuplicateReplica | InvalidTrustSet | UnpinnedKey | MixedReceipts | UnexpectedResult
        | CorruptState | Crypto => "witness_receipt_invalid",
    })
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
        AnchorUnavailable => error("rollback_anchor_unavailable"),
        LifecycleBusy => error("lifecycle_busy"),
        Conflict | GenerationConflict => error("conflict"),
        Corrupt | UnsupportedSchema => error("corrupt_state"),
        Quarantined => error("rollback_detected"),
        NotFound => error("state_loss"),
        AlreadyExists => error("already_exists"),
        AlreadyAcknowledged => error("already_acknowledged"),
        RetentionExceeded => error("retention_exceeded"),
        IdentityMismatch => error("identity_mismatch"),
        InitializationIncomplete | Io | Storage | InjectedFault => error("storage_unavailable"),
    }
}
