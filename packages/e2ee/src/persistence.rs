// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

//! Native durable storage for the endpoint E2EE core.
//!
//! One database is permanently bound to one crypto session. Database values contain encrypted
//! OpenMLS storage images, exact ciphertext, and non-secret routing-independent metadata. Wrapping
//! keys are supplied by the platform and never enter redb. Every state-changing operation commits
//! one sealed witness transition and releases its exact result only after the hosted unanimous
//! witness barrier and obsolete-key erasure complete.

use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error as StdError,
    fmt,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use openmls::{group::MlsGroup, prelude::GroupId};
use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::{
    OpenMlsProvider, crypto::OpenMlsCrypto as _, random::OpenMlsRand as _, types::AeadType,
};
use redb::{
    Database, Durability, ReadableDatabase, ReadableTable, TableDefinition, TableHandle,
    WriteTransaction,
};

#[cfg(test)]
use crate::TransactionalProvider;
use crate::{
    Clock, CommitMetadata, CoreProvider, Daemon, Endpoint, Error as CoreError, GroupTransaction,
    Id, Identity, MAX_PAST_EPOCHS, MessageClass, PROFILE_ID, PROFILE_REVISION, PairContext,
    PairWelcome, Phone, PhoneKeyPackage, PreparedEnvelope, Role, SUITE, SystemClock,
    pairing::PairingCredential,
    witness::{
        self, EndpointReconciliation, EndpointTerminalState, EndpointWitnessState,
        FreshQuorumState, QuorumCertificate, ReplicaTrustSet, WitnessError, WitnessLineage,
        WitnessRequest, WitnessRequestKind,
    },
};
use witness_v2::{
    ConfirmedWitnessHead, DurableWitnessOperation, ExactResult, WitnessOperationDisposition,
    WitnessOperationIndex, WitnessRegistrationState,
};

#[cfg(target_os = "linux")]
#[allow(dead_code)] // Constructed only by the later internal production endpoint factory.
pub(crate) mod linux_secret_service;
#[cfg(target_os = "macos")]
#[allow(dead_code)] // Constructed only by the later internal production endpoint factory.
pub(crate) mod macos_keychain;
mod pairing_lifecycle;
#[cfg(target_os = "windows")]
#[allow(dead_code)] // Constructed only by the later internal production endpoint factory.
pub(crate) mod windows_dpapi;
#[cfg(target_os = "windows")]
mod windows_fs;
mod witness_v2;
pub use pairing_lifecycle::{
    ActivationAcceptance, ActivationOutcome, ClaimFailure, ClaimSubmission,
    DurablePendingInvitation, DurablePreJoinDevice, EpochReadyAcceptance, InvitationLifecycle,
    InvitationPublication, PairLifecycle, PreJoinLifecycle, PreJoinPublication, RePairRequirement,
    RemovalOutcome, ReservationIntent, ReservationOutcome, WelcomeOutcome, WelcomePublication,
};

/// Immutable descriptor of the one locally committed operation awaiting the witness barrier.
///
/// It exposes only the operation ID, the exact signed request bytes, and the request hash. It
/// never carries candidate ciphertext, plaintext, pairing artifacts, or typed state.
#[derive(Clone, Eq, PartialEq)]
pub struct PendingWitnessRequest {
    operation_id: Id,
    request: Vec<u8>,
    request_hash: [u8; 48],
    kind: WitnessRequestKind,
}

impl fmt::Debug for PendingWitnessRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PendingWitnessRequest")
            .field("operation_id", &self.operation_id)
            .field("kind", &self.kind)
            .field("request", &"[opaque]")
            .finish()
    }
}

impl PendingWitnessRequest {
    pub fn operation_id(&self) -> Id {
        self.operation_id
    }

    pub fn request(&self) -> &[u8] {
        &self.request
    }

    pub fn request_hash(&self) -> [u8; 48] {
        self.request_hash
    }

    pub fn kind(&self) -> WitnessRequestKind {
        self.kind
    }
}

/// Result of a state-changing endpoint call.
///
/// `Pending` carries the exact request that must reach all three replicas; the typed result is
/// withheld until `continue_witness` verifies the unanimous certificate. `Released` carries a
/// result that needs no new barrier: either a read-only no-change branch or the exact result of
/// an operation whose barrier already completed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WitnessOutcome<T> {
    Pending(PendingWitnessRequest),
    Released(T),
}

impl<T> WitnessOutcome<T> {
    pub fn released(self) -> Option<T> {
        match self {
            Self::Released(value) => Some(value),
            Self::Pending(_) => None,
        }
    }

    pub fn pending(&self) -> Option<&PendingWitnessRequest> {
        match self {
            Self::Pending(value) => Some(value),
            Self::Released(_) => None,
        }
    }
}

/// Tagged exact result decoded from the authenticated sealed inner payload after the barrier.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TypedResult {
    Empty,
    Envelope(OutboxRecord),
    Plaintext(DurablePlaintext),
    Accepted(AcceptedMessageRecord),
    Commit(CommitMetadata),
    OutboxAcknowledged(OutboxRecord),
    ReceiveAcknowledged(AcceptedMessageRecord),
    Invitation(InvitationPublication),
    PreJoin(PreJoinPublication),
    KeyPackage(Vec<u8>),
    Welcome(WelcomePublication),
    LegacyWelcome(Vec<u8>),
    Claim(ClaimSubmission),
    Reservation(ReservationOutcome),
    Activation(ActivationAcceptance),
    EpochReady(EpochReadyAcceptance),
    InvitationLifecycle(InvitationLifecycle),
    PreJoinLifecycle(PreJoinLifecycle),
    PairLifecycle(PairLifecycle),
    Removal(RemovalOutcome),
    RePair(RePairRequirement),
}

/// Version-2 operation kinds from the atomic witness integration specification.
pub(crate) mod op_kind {
    pub const DAEMON_INVITATION: u16 = 1;
    pub const DEVICE_PRE_JOIN: u16 = 2;
    pub const INVITATION_CANCEL: u16 = 3;
    pub const CLAIM_SUBMIT: u16 = 4;
    pub const CLAIM_CONFIRM: u16 = 5;
    pub const RESERVATION_RELEASE: u16 = 6;
    pub const WELCOME_CREATE: u16 = 7;
    pub const WELCOME_JOIN: u16 = 8;
    pub const ACTIVATION_SEND: u16 = 9;
    pub const ACTIVATION_RECEIVE: u16 = 10;
    pub const ACTIVATION_ACK: u16 = 11;
    pub const APPLICATION_SEND: u16 = 12;
    pub const APPLICATION_RECEIVE: u16 = 13;
    pub const PROPOSAL_SEND: u16 = 14;
    pub const PROPOSAL_RECEIVE: u16 = 15;
    pub const DAEMON_COMMIT: u16 = 16;
    pub const COMMIT_APPLY: u16 = 17;
    pub const EPOCH_READY_SEND: u16 = 18;
    pub const EPOCH_READY_RECEIVE: u16 = 19;
    pub const EPOCH_READY_CONFIRM_SEND: u16 = 20;
    pub const EPOCH_READY_CONFIRM_RECEIVE: u16 = 21;
    pub const EPOCH_READY_ACK: u16 = 22;
    pub const REMOVAL_COMMIT: u16 = 23;
    pub const REMOVAL_APPLY: u16 = 24;
    pub const LOCAL_REVOCATION: u16 = 25;
    pub const RESET: u16 = 26;
    pub const OUTBOX_ACK: u16 = 27;
    pub const RECEIVE_ACK: u16 = 28;
    pub const INVITATION_EXPIRY: u16 = 29;
    pub const PRE_JOIN_EXPIRY: u16 = 30;
    pub const WELCOME_EXPIRY: u16 = 31;
    pub const LEGACY_CREATE: u16 = 32;
}

/// Current Axl native E2EE storage schema.
pub const STORAGE_SCHEMA_VERSION: u16 = 2;
const STATE_FORMAT_VERSION: u16 = 2;
const MAX_STATE_ENTRIES: usize = 8192;
const MAX_STATE_BYTES: usize = 16 * 1024 * 1024;
const STATE_AAD_LABEL: &[u8] = b"Axl encrypted OpenMLS state v2";

const META: TableDefinition<u8, &[u8]> = TableDefinition::new("metadata_v1");
const STATE: TableDefinition<u8, &[u8]> = TableDefinition::new("encrypted_state_v1");
const OPERATIONS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("operations_v1");
const OUTBOX: TableDefinition<&[u8], &[u8]> = TableDefinition::new("outbox_v1");
const ACCEPTED: TableDefinition<&[u8], &[u8]> = TableDefinition::new("accepted_messages_v1");
const PENDING_WITNESS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("pending_witness_v2");

const META_SCHEMA: u8 = 1;
const META_SESSION: u8 = 2;
const META_PROFILE: u8 = 3;
const META_PROFILE_REVISION: u8 = 4;
const META_GENERATION: u8 = 5;
const META_ROLLBACK_COUNTER: u8 = 6;
const META_EPOCH: u8 = 7;
const META_EPOCH_AUTHENTICATOR: u8 = 8;
const META_PENDING_ERASE: u8 = 9;
const META_LIFECYCLE: u8 = 10;
const META_CONFIRMED_WITNESS_COUNTER: u8 = 11;
const META_CONFIRMED_WITNESS_COMMITMENT: u8 = 12;
const META_PREVIOUS_CERTIFICATE_HASH: u8 = 13;
const META_WITNESS_REGISTRATION: u8 = 14;
const META_CURRENT_KEY_ID: u8 = 15;
const META_OBSOLETE_KEY_ID: u8 = 16;
const WITNESS_UNREGISTERED: u8 = 0;
const WITNESS_REGISTERED: u8 = 1;
const LIFECYCLE_INITIALIZING: u8 = 1;
const LIFECYCLE_READY: u8 = 2;
/// Fail-closed terminal markers. They live outside the authenticated header and manifest, so they
/// cannot rewrite witness-bound state; a fresh quorum read rediscovers the terminal condition.
const LIFECYCLE_QUARANTINED: u8 = 3;
const LIFECYCLE_REVOKED: u8 = 4;
const STATE_CURRENT: u8 = 1;
const ENDPOINT_METADATA_KEY: &[u8] = b"\0axl-endpoint-metadata-v1";
const EXACT_RESULT_PREFIX: &[u8] = b"\0axl-exact-result-v2";
const DURABLE_MANIFEST_KEY: &[u8] = b"\0axl-durable-manifest-v1";
#[cfg(not(test))]
pub const IDEMPOTENCY_RETENTION_GENERATIONS: u64 = 4096;
#[cfg(test)]
pub const IDEMPOTENCY_RETENTION_GENERATIONS: u64 = 64;

/// Deterministic fault points exercised by the persistence test matrix.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FaultPoint {
    BeforeOpenMlsStateWrites,
    DuringOpenMlsProviderWrites,
    BeforeCiphertextInsertion,
    AfterCiphertextInsertion,
    BeforeCommit,
    AfterDurableCommit,
    AfterCommitBeforeNetworkSend,
    DuringReceiverStateWrites,
    BeforeReceiverAcknowledgement,
    AfterAcknowledgementLoss,
    DuringRestartReload,
    DuringWrappingRecordErasure,
    DuringCurrentKeyActivation,
    DuringPreparedKeyReconciliation,
    BeforeTransitionSealing,
    AfterTransitionSealingBeforeCommit,
    BeforeCertificateVerification,
    AfterCertificateVerificationBeforeErasure,
    AfterErasureBeforeRelease,
    DuringDuplicateOperation,
    DuringGenerationConflict,
    AfterInitializationMarkerCreation,
    AfterInitializationFileCreation,
    AfterInitializationSchemaCommit,
    BeforeInitializationReady,
    AfterInitializationReadyCommit,
}

/// Injected deterministic fault policy. Production uses [`NoFaults`].
pub(crate) trait FaultInjector: Send + Sync {
    fn check(&self, point: FaultPoint) -> Result<(), PersistenceError>;
}

/// Fault policy that never injects a failure.
pub(crate) struct NoFaults;

pub(crate) struct RuntimeHooks {
    pub(crate) faults: Arc<dyn FaultInjector>,
    pub(crate) clock: Arc<dyn Clock>,
}

impl FaultInjector for NoFaults {
    fn check(&self, _point: FaultPoint) -> Result<(), PersistenceError> {
        Ok(())
    }
}

/// Platform-owned envelope-key boundary.
///
/// Implementations keep wrapping keys and wrapping records outside redb. `prepare` creates an
/// inactive record bound to one crypto session and authenticated context. `load` accepts active
/// records only. `activate` makes a committed prepared record loadable and is idempotent.
/// `reconcile_prepared` must enumerate the session's prepared records, activate the committed
/// current record when supplied, and erase every other inactive orphan. It must not erase active
/// obsolete records; Axl does that only after rollback-anchor reconciliation. `activate`, `erase`,
/// `reconcile_prepared`, and `destroy_session` are idempotent. Platform secure-key
/// implementations are intentionally deferred to Session 50.
pub trait EnvelopeKeyStore: Send + Sync {
    fn available(&self) -> bool;
    fn prepare(
        &self,
        crypto_session_id: Id,
        key_id: [u8; 16],
        data_key: &[u8; 32],
        authenticated_context: &[u8],
    ) -> Result<(), PersistenceError>;
    fn load(
        &self,
        crypto_session_id: Id,
        key_id: [u8; 16],
        authenticated_context: &[u8],
    ) -> Result<[u8; 32], PersistenceError>;
    fn activate(
        &self,
        crypto_session_id: Id,
        key_id: [u8; 16],
        authenticated_context: &[u8],
    ) -> Result<(), PersistenceError>;
    fn reconcile_prepared(
        &self,
        crypto_session_id: Id,
        committed_current: Option<([u8; 16], Vec<u8>)>,
    ) -> Result<(), PersistenceError>;
    fn erase(&self, crypto_session_id: Id, key_id: [u8; 16]) -> Result<(), PersistenceError>;
    fn destroy_session(&self, crypto_session_id: Id) -> Result<(), PersistenceError>;
}

#[cfg(all(target_os = "windows", feature = "node-test-fixtures"))]
#[doc(hidden)]
pub fn windows_test_envelope_key_store(
    root: &Path,
) -> Result<Arc<dyn EnvelopeKeyStore>, PersistenceError> {
    Ok(Arc::new(
        windows_dpapi::WindowsDpapiEnvelopeKeyStore::for_current_process(root)?,
    ))
}

/// Durable exact-ciphertext record. Relay route identifiers are deliberately absent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutboxRecord {
    pub(crate) operation_id: Id,
    pub(crate) crypto_session_id: Id,
    pub(crate) logical_message_id: Id,
    pub(crate) class: MessageClass,
    pub(crate) epoch: u64,
    pub(crate) hosted_generation: u64,
    pub(crate) profile_revision: u16,
    pub(crate) retry_state: RetryState,
    pub(crate) ciphertext: Vec<u8>,
    pub(crate) commit: Option<CommitMetadata>,
}

struct OutboxRecordFields {
    operation_id: Id,
    crypto_session_id: Id,
    logical_message_id: Id,
    class: MessageClass,
    epoch: u64,
    hosted_generation: u64,
    profile_revision: u16,
    retry_state: RetryState,
    ciphertext: Vec<u8>,
    commit: Option<CommitMetadata>,
}

impl OutboxRecord {
    fn new(fields: OutboxRecordFields) -> Self {
        Self {
            operation_id: fields.operation_id,
            crypto_session_id: fields.crypto_session_id,
            logical_message_id: fields.logical_message_id,
            class: fields.class,
            epoch: fields.epoch,
            hosted_generation: fields.hosted_generation,
            profile_revision: fields.profile_revision,
            retry_state: fields.retry_state,
            ciphertext: fields.ciphertext,
            commit: fields.commit,
        }
    }

    pub fn operation_id(&self) -> Id {
        self.operation_id
    }

    pub fn crypto_session_id(&self) -> Id {
        self.crypto_session_id
    }

    pub fn logical_message_id(&self) -> Id {
        self.logical_message_id
    }

    pub fn class(&self) -> MessageClass {
        self.class
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn hosted_generation(&self) -> u64 {
        self.hosted_generation
    }

    pub fn profile_revision(&self) -> u16 {
        self.profile_revision
    }

    pub fn retry_state(&self) -> RetryState {
        self.retry_state
    }

    pub fn ciphertext(&self) -> &[u8] {
        &self.ciphertext
    }

    pub fn commit(&self) -> Option<&CommitMetadata> {
        self.commit.as_ref()
    }
}

fn outbox_priority(class: MessageClass) -> u8 {
    match class {
        MessageClass::Commit | MessageClass::EpochReady => 0,
        MessageClass::UpdateProposal
        | MessageClass::PairActivation
        | MessageClass::ResyncControl => 1,
        MessageClass::ApplicationRequest | MessageClass::ApplicationDelivery => 2,
    }
}

/// Durable retry state for an exact ciphertext.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum RetryState {
    Pending = 1,
    Acknowledged = 2,
}

/// Durable accepted-message identity. Plaintext is held only in the encrypted state envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMessageRecord {
    pub operation_id: Id,
    pub crypto_session_id: Id,
    pub logical_message_id: Id,
    pub class: MessageClass,
    pub epoch: u64,
    pub profile_revision: u16,
    pub acknowledged: bool,
}

/// Result recorded for operation-id recovery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CommittedOperation {
    Envelope(OutboxRecord),
    Accepted(AcceptedMessageRecord),
    OutboxAcknowledged(OutboxRecord),
    ReceiveAcknowledged(AcceptedMessageRecord),
    Pairing(PairingOperationRecord),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PairingOperationRecord {
    operation_id: Id,
    crypto_session_id: Id,
    kind: u8,
    outcome: u8,
    artifact_hash: [u8; 48],
}

/// Errors from the durable boundary. Messages never include keys, plaintext, or ciphertext.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PersistenceError {
    AlreadyAcknowledged,
    AlreadyExists,
    Conflict,
    Corrupt,
    EndpointRevoked,
    FreshWitnessRequired,
    InjectedFault,
    GenerationConflict,
    IdentityMismatch,
    InitializationIncomplete,
    Io,
    LifecycleBusy,
    KeyRecordMissing,
    KeyUnavailable,
    NotFound,
    Quarantined,
    RetentionExceeded,
    SecureStoreAccessDenied,
    SecureStoreAmbiguous,
    SecureStoreLocked,
    SecureStoreUnavailable,
    StateLoss,
    Storage,
    UnsupportedSchema,
    WitnessConflict,
    WitnessInvalidExpected,
    WitnessOperationConflict,
    WitnessReceiptInvalid,
    WitnessRegistrationConflict,
    WitnessUnavailable,
    Core(CoreError),
}

impl fmt::Display for PersistenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl StdError for PersistenceError {}

impl From<CoreError> for PersistenceError {
    fn from(value: CoreError) -> Self {
        Self::Core(value)
    }
}

/// In-memory witness runtime rebuilt from authenticated durable state at every open.
///
/// It is a cache of the confirmed head, the one-shot mutation authorization produced by the last
/// fresh unanimous read, and the read request awaiting its certificate. It is never recovery
/// authority: the redb database owns the pending operation and the exact request.
struct WitnessRuntime {
    state: EndpointWitnessState,
    /// Fresh signed read requests awaiting their certificates, newest last. Bounded so a caller
    /// that never presents certificates cannot grow memory; each is matched by request hash.
    pending_reads: std::collections::VecDeque<([u8; 48], WitnessRequest)>,
}

const MAX_PENDING_READS: usize = 8;

/// Native transactional provider backed by one redb file per pairwise group.
pub(crate) struct NativeTransactionalProvider {
    path: PathBuf,
    initialization_marker: PathBuf,
    crypto_session_id: Id,
    lifecycle_claim: Mutex<Option<SessionLifecycleClaim>>,
    database: Mutex<Option<Database>>,
    operation_lock: Mutex<()>,
    envelope_keys: Arc<dyn EnvelopeKeyStore>,
    trust: Arc<ReplicaTrustSet>,
    witness: Mutex<WitnessRuntime>,
    faults: Arc<dyn FaultInjector>,
    clock: Arc<dyn Clock>,
}

/// Explicitly remove an incomplete creation after the caller has abandoned that pairing attempt.
/// Ready databases are never removed by this function, and a consumed monotonic anchor means the
/// caller must choose a fresh crypto session ID for the next attempt.
pub fn discard_interrupted_creation(
    root: &Path,
    crypto_session_id: Id,
    envelope_keys: Arc<dyn EnvelopeKeyStore>,
) -> Result<(), PersistenceError> {
    let root = canonical_storage_root(root)?;
    let _lifecycle_claim = acquire_session_lifecycle_claim(&root, crypto_session_id)?;
    let path = root.join(format!("{}.redb", hex_id(crypto_session_id)));
    let marker = initializing_marker_for_database(&path);
    validate_regular_file(&marker, PersistenceError::NotFound)?;

    let database_metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(PersistenceError::Io),
    };
    let Some(database_metadata) = database_metadata else {
        envelope_keys.destroy_session(crypto_session_id)?;
        fs::remove_file(marker).map_err(|_| PersistenceError::Io)?;
        return sync_parent_directory(&path);
    };
    if database_metadata.file_type().is_symlink() || !database_metadata.is_file() {
        return Err(PersistenceError::IdentityMismatch);
    }
    let canonical = path.canonicalize().map_err(|_| PersistenceError::Io)?;
    if canonical.parent() != Some(root.as_path()) {
        return Err(PersistenceError::IdentityMismatch);
    }

    // The lifecycle claim excludes creators and openers, so writable open is safe here and lets
    // redb recover its own bookkeeping after an abruptly terminated process before inspection.
    let database = Database::open(&canonical).map_err(map_database_error)?;
    match (
        inspect_database_lifecycle(&database, crypto_session_id)?,
        inspect_initialization_state(&database, crypto_session_id)?,
    ) {
        (LIFECYCLE_INITIALIZING, InitializationState::Pristine) => {}
        (LIFECYCLE_INITIALIZING, InitializationState::Committed) => {
            return Err(PersistenceError::InitializationIncomplete);
        }
        (LIFECYCLE_INITIALIZING, InitializationState::Inconsistent) => {
            return Err(PersistenceError::Corrupt);
        }
        (LIFECYCLE_READY, _) => return Err(PersistenceError::AlreadyExists),
        // A terminal endpoint holds committed cryptographic state and is never deleted here.
        (LIFECYCLE_QUARANTINED, _) => return Err(PersistenceError::Quarantined),
        (LIFECYCLE_REVOKED, _) => return Err(PersistenceError::EndpointRevoked),
        _ => return Err(PersistenceError::Corrupt),
    }
    drop(database);

    envelope_keys.destroy_session(crypto_session_id)?;
    fs::remove_file(&canonical).map_err(|_| PersistenceError::Io)?;
    fs::remove_file(marker).map_err(|_| PersistenceError::Io)?;
    sync_parent_directory(&canonical)
}

impl NativeTransactionalProvider {
    /// Explicitly create new cryptographic storage. Existing paths are never reset or reused.
    pub(crate) fn create(
        root: &Path,
        crypto_session_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
        faults: Arc<dyn FaultInjector>,
        clock: Arc<dyn Clock>,
    ) -> Result<Arc<Self>, PersistenceError> {
        require_dependencies(&*envelope_keys)?;
        let root = prepare_storage_root(root, true)?;
        let lifecycle_claim = acquire_session_lifecycle_claim(&root, crypto_session_id)?;
        let path = database_path(&root, crypto_session_id, true, Some(&*faults))?;
        let database = Database::create(&path).map_err(map_database_error)?;
        restrict_file(&path)?;
        let initialization_marker = initializing_marker_for_database(&path);
        let mut state = EndpointWitnessState::new();
        state
            .authorize_initial_registration()
            .map_err(map_witness_error)?;
        let this = Arc::new(Self {
            path,
            initialization_marker,
            crypto_session_id,
            lifecycle_claim: Mutex::new(Some(lifecycle_claim)),
            database: Mutex::new(Some(database)),
            operation_lock: Mutex::new(()),
            envelope_keys,
            trust,
            witness: Mutex::new(WitnessRuntime {
                state,
                pending_reads: std::collections::VecDeque::new(),
            }),
            faults,
            clock,
        });
        this.faults
            .check(FaultPoint::AfterInitializationFileCreation)?;
        this.initialize_schema()?;
        this.faults
            .check(FaultPoint::AfterInitializationSchemaCommit)?;
        Ok(this)
    }

    /// Open existing cryptographic storage. Missing, corrupt, mismatched, or unsupported storage
    /// fails closed and is never recreated.
    pub(crate) fn open(
        root: &Path,
        crypto_session_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
        faults: Arc<dyn FaultInjector>,
        clock: Arc<dyn Clock>,
    ) -> Result<Arc<Self>, PersistenceError> {
        require_dependencies(&*envelope_keys)?;
        let root = prepare_storage_root(root, false)?;
        let lifecycle_claim = acquire_session_lifecycle_claim(&root, crypto_session_id)?;
        let path = database_path(&root, crypto_session_id, false, None)?;
        let initialization_marker = initializing_marker_for_database(&path);
        regular_file_exists(&initialization_marker)?;
        faults.check(FaultPoint::DuringRestartReload)?;
        let database = Database::open(&path).map_err(map_database_error)?;
        let lifecycle = inspect_database_lifecycle(&database, crypto_session_id)?;
        if lifecycle == LIFECYCLE_INITIALIZING {
            match inspect_initialization_state(&database, crypto_session_id)? {
                InitializationState::Pristine => {
                    return Err(PersistenceError::InitializationIncomplete);
                }
                InitializationState::Committed => {}
                InitializationState::Inconsistent => return Err(PersistenceError::Corrupt),
            }
        } else if !matches!(
            lifecycle,
            LIFECYCLE_READY | LIFECYCLE_QUARANTINED | LIFECYCLE_REVOKED
        ) {
            return Err(PersistenceError::Corrupt);
        }
        let this = Arc::new(Self {
            path,
            initialization_marker,
            crypto_session_id,
            lifecycle_claim: Mutex::new(Some(lifecycle_claim)),
            database: Mutex::new(Some(database)),
            operation_lock: Mutex::new(()),
            envelope_keys,
            trust,
            witness: Mutex::new(WitnessRuntime {
                state: EndpointWitnessState::new(),
                pending_reads: std::collections::VecDeque::new(),
            }),
            faults,
            clock,
        });
        let recovered = this.recover_storage()?;
        this.rebuild_witness_runtime(recovered)?;
        if lifecycle != LIFECYCLE_INITIALIZING {
            this.validate_ready()?;
        }
        Ok(this)
    }

    fn remove_stale_initialization_marker(&self) -> Result<(), PersistenceError> {
        if !regular_file_exists(&self.initialization_marker)? {
            return Ok(());
        }
        fs::remove_file(&self.initialization_marker).map_err(|_| PersistenceError::Io)?;
        sync_parent_directory(&self.path)
    }

    /// Finish opening. An `initializing` database whose registration is still pending keeps its
    /// marker until `continue_witness` completes the counter-1 register. The OS lifecycle claim
    /// is never released here: it protects the endpoint for its whole open lifetime.
    fn finish_opening(&self) -> Result<(), PersistenceError> {
        let lifecycle = {
            let database = self.database_lock()?;
            let database = database.as_ref().ok_or(PersistenceError::Storage)?;
            inspect_database_lifecycle(database, self.crypto_session_id)?
        };
        if lifecycle == LIFECYCLE_INITIALIZING {
            let pending = self.read_pending_row()?;
            match pending {
                Some(row) if row.disposition == WitnessOperationDisposition::Pending => Ok(()),
                Some(_) => self.mark_ready(),
                None => Err(PersistenceError::Corrupt),
            }
        } else if matches!(
            lifecycle,
            LIFECYCLE_READY | LIFECYCLE_QUARANTINED | LIFECYCLE_REVOKED
        ) {
            self.remove_stale_initialization_marker()
        } else {
            Err(PersistenceError::Corrupt)
        }
    }

    fn mark_ready(&self) -> Result<(), PersistenceError> {
        let database = self.database_lock()?;
        let mut write = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_write()
            .map_err(map_transaction_error)?;
        configure_transaction(&mut write)?;
        {
            let mut meta = write.open_table(META).map_err(map_table_error)?;
            meta.insert(META_LIFECYCLE, &[LIFECYCLE_READY] as &[u8])
                .map_err(map_storage_error)?;
        }
        write.commit().map_err(|_| PersistenceError::Storage)?;
        self.faults
            .check(FaultPoint::AfterInitializationReadyCommit)?;
        fs::remove_file(&self.initialization_marker).map_err(|_| PersistenceError::Io)?;
        sync_parent_directory(&self.path)
    }

    fn validate_ready(&self) -> Result<(), PersistenceError> {
        let database = self.database_lock()?;
        let read = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_read()
            .map_err(map_transaction_error)?;
        let meta = read.open_table(META).map_err(map_table_error)?;
        match read_bytes(&meta, META_LIFECYCLE)?.as_slice() {
            [LIFECYCLE_READY | LIFECYCLE_QUARANTINED | LIFECYCLE_REVOKED] => Ok(()),
            [LIFECYCLE_INITIALIZING] => Err(PersistenceError::InitializationIncomplete),
            _ => Err(PersistenceError::Corrupt),
        }
    }

    /// Read-only typed state is withheld while one witness operation is locally committed but not
    /// confirmed in this process: the locally committed successor is not a released result. After
    /// restart a `Completed` row is only a cache, so it counts as pending until a fresh unanimous
    /// head and the exact duplicate certificate confirm it again.
    pub(crate) fn require_no_pending(&self) -> Result<(), PersistenceError> {
        let runtime = self.witness_lock()?;
        if let Some(terminal) = runtime.state.terminal() {
            return Err(terminal_error(terminal));
        }
        if runtime.state.has_pending() {
            return Err(PersistenceError::WitnessUnavailable);
        }
        Ok(())
    }

    /// The operation whose successor is committed locally but not yet confirmed in this process.
    fn unconfirmed_operation_id(&self) -> Result<Option<Id>, PersistenceError> {
        if !self.witness_lock()?.state.has_pending() {
            return Ok(None);
        }
        Ok(self.read_pending_row()?.map(|row| row.operation_id))
    }

    /// Read-only publications are withheld while the initial registration is still pending.
    pub(crate) fn require_published(&self) -> Result<(), PersistenceError> {
        let database = self.database_lock()?;
        let lifecycle = inspect_database_lifecycle(
            database.as_ref().ok_or(PersistenceError::Storage)?,
            self.crypto_session_id,
        )?;
        if lifecycle == LIFECYCLE_INITIALIZING {
            return Err(PersistenceError::InitializationIncomplete);
        }
        Ok(())
    }

    fn persist_terminal_marker(
        &self,
        terminal: EndpointTerminalState,
    ) -> Result<(), PersistenceError> {
        let marker = match terminal {
            EndpointTerminalState::Quarantined(_) => LIFECYCLE_QUARANTINED,
            EndpointTerminalState::Revoked => LIFECYCLE_REVOKED,
        };
        let database = self.database_lock()?;
        let mut write = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_write()
            .map_err(map_transaction_error)?;
        configure_transaction(&mut write)?;
        {
            let mut meta = write.open_table(META).map_err(map_table_error)?;
            // A locally detected conflict or invalid certificate is never rediscoverable from the
            // witness, so the marker is written in every lifecycle, including an interrupted
            // creation whose registration is still pending.
            meta.insert(META_LIFECYCLE, &[marker] as &[u8])
                .map_err(map_storage_error)?;
        }
        write.commit().map_err(|_| PersistenceError::Storage)
    }

    fn durable_terminal_state(&self) -> Result<Option<EndpointTerminalState>, PersistenceError> {
        let database = self.database_lock()?;
        let read = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_read()
            .map_err(map_transaction_error)?;
        let meta = read.open_table(META).map_err(map_table_error)?;
        Ok(match read_bytes(&meta, META_LIFECYCLE)?.as_slice() {
            [LIFECYCLE_QUARANTINED] => Some(EndpointTerminalState::Quarantined(
                witness::EndpointQuarantineReason::WitnessInconsistent,
            )),
            [LIFECYCLE_REVOKED] => Some(EndpointTerminalState::Revoked),
            _ => None,
        })
    }

    #[cfg(test)]
    pub(crate) fn crypto_session_id(&self) -> Id {
        self.crypto_session_id
    }

    #[cfg(test)]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Close the database handle and release the OS lifecycle claim. Existing transactions retain
    /// their own engine handle and must finish before a reopen is attempted. A closed endpoint owns
    /// nothing until `reopen` acquires the claim again.
    pub(crate) fn close(&self) -> Result<(), PersistenceError> {
        *self
            .database
            .lock()
            .map_err(|_| PersistenceError::Storage)? = None;
        self.lifecycle_claim
            .lock()
            .map_err(|_| PersistenceError::Storage)?
            .take();
        Ok(())
    }

    /// Simulated restart: acquire the lifecycle claim again, reopen, and rebuild the witness
    /// runtime from durable state alone.
    #[cfg(test)]
    pub(crate) fn reopen(&self) -> Result<(), PersistenceError> {
        self.faults.check(FaultPoint::DuringRestartReload)?;
        {
            let mut claim = self
                .lifecycle_claim
                .lock()
                .map_err(|_| PersistenceError::Storage)?;
            if claim.is_none() {
                let root = self.path.parent().ok_or(PersistenceError::Io)?;
                *claim = Some(acquire_session_lifecycle_claim(
                    root,
                    self.crypto_session_id,
                )?);
            }
        }
        self.reopen_database_only()?;
        let recovered = self.recover_storage()?;
        self.rebuild_witness_runtime(recovered)?;
        self.validate_ready()
    }

    fn reopen_database_only(&self) -> Result<(), PersistenceError> {
        let database = Database::open(&self.path).map_err(map_database_error)?;
        *self
            .database
            .lock()
            .map_err(|_| PersistenceError::Storage)? = Some(database);
        Ok(())
    }

    /// Authenticate committed state, activate or verify the committed current key, and rebuild the
    /// in-memory witness runtime from the durable confirmed head and pending row. It never erases
    /// the obsolete key and never exposes a pending request whose key activation is uncertain.
    fn recover_storage(&self) -> Result<RecoveredWitnessState, PersistenceError> {
        require_dependencies(&*self.envelope_keys)?;
        self.validate_binding()?;
        self.faults
            .check(FaultPoint::DuringPreparedKeyReconciliation)?;
        self.activate_and_validate_current_state()
    }

    /// Rebuild the in-memory witness runtime from authenticated durable state. Called only at
    /// open, explicit reopen, and uncertain-commit recovery; a live continuation keeps its verified
    /// head and certificate hash until the next sealed commit persists them.
    fn rebuild_witness_runtime(
        &self,
        recovered: RecoveredWitnessState,
    ) -> Result<(), PersistenceError> {
        let mut runtime = self.witness_lock()?;
        let mut state = EndpointWitnessState::from_confirmed(
            recovered.confirmed.counter,
            recovered.confirmed.commitment,
            recovered.confirmed.previous_certificate_hash,
        );
        if let Some(pending) = recovered.pending {
            state.recover_pending(pending).map_err(map_witness_error)?;
        }
        if let Some(terminal) = self.durable_terminal_state()? {
            state.set_terminal(terminal);
        }
        runtime.state = state;
        runtime.pending_reads.clear();
        Ok(())
    }

    fn witness_lock(&self) -> Result<std::sync::MutexGuard<'_, WitnessRuntime>, PersistenceError> {
        self.witness.lock().map_err(|_| PersistenceError::Storage)
    }

    fn read_pending_row(&self) -> Result<Option<DurableWitnessOperation>, PersistenceError> {
        let database = self.database_lock()?;
        witness_v2::read_pending_operation(database.as_ref().ok_or(PersistenceError::Storage)?)
    }

    #[cfg(test)]
    pub(crate) fn generation(&self) -> Result<u64, PersistenceError> {
        self.read_u64_meta(META_GENERATION)
    }

    #[cfg(test)]
    pub(crate) fn rollback_counter(&self) -> Result<u64, PersistenceError> {
        self.read_u64_meta(META_ROLLBACK_COUNTER)
    }

    #[cfg(test)]
    pub(crate) fn operation(
        &self,
        operation_id: Id,
    ) -> Result<Option<CommittedOperation>, PersistenceError> {
        let database = self.database_lock()?;
        let read = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_read()
            .map_err(map_transaction_error)?;
        let table = read.open_table(OPERATIONS).map_err(map_table_error)?;
        let value = table
            .get(operation_id.as_slice())
            .map_err(map_storage_error)?;
        value
            .map(|bytes| {
                let operation = decode_operation(bytes.value())?;
                validate_operation_binding(&operation, operation_id, self.crypto_session_id)?;
                Ok(operation)
            })
            .transpose()
    }

    #[cfg(test)]
    pub(crate) fn outbox(
        &self,
        operation_id: Id,
    ) -> Result<Option<OutboxRecord>, PersistenceError> {
        let database = self.database_lock()?;
        let read = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_read()
            .map_err(map_transaction_error)?;
        let table = read.open_table(OUTBOX).map_err(map_table_error)?;
        let value = table
            .get(operation_id.as_slice())
            .map_err(map_storage_error)?;
        value
            .map(|bytes| {
                let record = decode_outbox(bytes.value())?;
                if record.operation_id != operation_id
                    || record.crypto_session_id != self.crypto_session_id
                {
                    return Err(PersistenceError::IdentityMismatch);
                }
                Ok(record)
            })
            .transpose()
    }

    fn pending_outbox(&self) -> Result<Vec<OutboxRecord>, PersistenceError> {
        let withheld = self.unconfirmed_operation_id()?;
        let database = self.database_lock()?;
        let read = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_read()
            .map_err(map_transaction_error)?;
        let table = read.open_table(OUTBOX).map_err(map_table_error)?;
        let entries = table.iter().map_err(map_storage_error)?;
        let mut records = Vec::new();
        for entry in entries {
            let (key, value) = entry.map_err(map_storage_error)?;
            let record = decode_outbox(value.value())?;
            if key.value() != record.operation_id
                || record.crypto_session_id != self.crypto_session_id
            {
                return Err(PersistenceError::IdentityMismatch);
            }
            // A record whose creating operation still awaits the witness is not transmittable.
            if record.retry_state == RetryState::Pending && withheld != Some(record.operation_id) {
                records.push(record);
            }
        }
        records.sort_by(|left, right| {
            outbox_priority(left.class)
                .cmp(&outbox_priority(right.class))
                .then_with(|| left.operation_id.cmp(&right.operation_id))
        });
        Ok(records)
    }

    fn initialize_schema(&self) -> Result<(), PersistenceError> {
        let database = self.database_lock()?;
        let mut write = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_write()
            .map_err(map_transaction_error)?;
        configure_transaction(&mut write)?;
        {
            let mut meta = write.open_table(META).map_err(map_table_error)?;
            meta.insert(META_SCHEMA, STORAGE_SCHEMA_VERSION.to_be_bytes().as_slice())
                .map_err(map_storage_error)?;
            meta.insert(META_SESSION, self.crypto_session_id.as_slice())
                .map_err(map_storage_error)?;
            meta.insert(META_PROFILE, PROFILE_ID.as_bytes())
                .map_err(map_storage_error)?;
            meta.insert(
                META_PROFILE_REVISION,
                PROFILE_REVISION.to_be_bytes().as_slice(),
            )
            .map_err(map_storage_error)?;
            meta.insert(META_GENERATION, 0_u64.to_be_bytes().as_slice())
                .map_err(map_storage_error)?;
            meta.insert(META_ROLLBACK_COUNTER, 0_u64.to_be_bytes().as_slice())
                .map_err(map_storage_error)?;
            meta.insert(META_EPOCH, 0_u64.to_be_bytes().as_slice())
                .map_err(map_storage_error)?;
            meta.insert(META_EPOCH_AUTHENTICATOR, &[] as &[u8])
                .map_err(map_storage_error)?;
            meta.insert(META_PENDING_ERASE, &[] as &[u8])
                .map_err(map_storage_error)?;
            meta.insert(META_LIFECYCLE, &[LIFECYCLE_INITIALIZING] as &[u8])
                .map_err(map_storage_error)?;
            meta.insert(
                META_CONFIRMED_WITNESS_COUNTER,
                0_u64.to_be_bytes().as_slice(),
            )
            .map_err(map_storage_error)?;
            meta.insert(META_CONFIRMED_WITNESS_COMMITMENT, &[0_u8; 48] as &[u8])
                .map_err(map_storage_error)?;
            meta.insert(META_PREVIOUS_CERTIFICATE_HASH, &[0_u8; 48] as &[u8])
                .map_err(map_storage_error)?;
            meta.insert(META_WITNESS_REGISTRATION, &[WITNESS_UNREGISTERED] as &[u8])
                .map_err(map_storage_error)?;
            meta.insert(META_CURRENT_KEY_ID, &[] as &[u8])
                .map_err(map_storage_error)?;
            meta.insert(META_OBSOLETE_KEY_ID, &[] as &[u8])
                .map_err(map_storage_error)?;
            write.open_table(STATE).map_err(map_table_error)?;
            write.open_table(OPERATIONS).map_err(map_table_error)?;
            write.open_table(OUTBOX).map_err(map_table_error)?;
            write.open_table(ACCEPTED).map_err(map_table_error)?;
            write.open_table(PENDING_WITNESS).map_err(map_table_error)?;
        }
        write.commit().map_err(|_| PersistenceError::Storage)
    }

    fn validate_binding(&self) -> Result<(), PersistenceError> {
        let database = self.database_lock()?;
        let read = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_read()
            .map_err(map_transaction_error)?;
        let meta = read.open_table(META).map_err(map_table_error)?;
        if read_u16(&meta, META_SCHEMA)? != STORAGE_SCHEMA_VERSION {
            return Err(PersistenceError::UnsupportedSchema);
        }
        if read_bytes(&meta, META_SESSION)? != self.crypto_session_id
            || read_bytes(&meta, META_PROFILE)? != PROFILE_ID.as_bytes()
            || read_u16(&meta, META_PROFILE_REVISION)? != PROFILE_REVISION
        {
            return Err(PersistenceError::IdentityMismatch);
        }
        let generation = read_u64(&meta, META_GENERATION)?;
        let pending_erase = read_bytes(&meta, META_PENDING_ERASE)?;
        let current_key = read_bytes(&meta, META_CURRENT_KEY_ID)?;
        let obsolete_key = read_bytes(&meta, META_OBSOLETE_KEY_ID)?;
        if !matches!(current_key.len(), 0 | 16)
            || !matches!(obsolete_key.len(), 0 | 16)
            || pending_erase != obsolete_key
            || (generation == 0) != current_key.is_empty()
        {
            return Err(PersistenceError::Corrupt);
        }
        let registration = match read_bytes(&meta, META_WITNESS_REGISTRATION)?.as_slice() {
            [WITNESS_UNREGISTERED] => witness_v2::WitnessRegistrationState::Unregistered,
            [1] => witness_v2::WitnessRegistrationState::Registered,
            _ => return Err(PersistenceError::Corrupt),
        };
        let confirmed = witness_v2::ConfirmedWitnessHead {
            counter: read_u64(&meta, META_CONFIRMED_WITNESS_COUNTER)?,
            commitment: read_bytes(&meta, META_CONFIRMED_WITNESS_COMMITMENT)?
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
            previous_certificate_hash: read_bytes(&meta, META_PREVIOUS_CERTIFICATE_HASH)?
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
            registration,
        };
        confirmed.validate()?;
        drop(meta);
        let pending = read.open_table(PENDING_WITNESS).map_err(map_table_error)?;
        if let Some(operation) = witness_v2::read_pending_operation_from_table(&pending)? {
            let expected_obsolete = operation
                .obsolete_key_id
                .map_or(Vec::new(), |value| value.to_vec());
            if operation.confirmed_head != confirmed
                || current_key.as_slice() != operation.successor_key_id
                || obsolete_key != expected_obsolete
            {
                return Err(PersistenceError::Corrupt);
            }
        }
        Ok(())
    }

    fn activate_and_validate_current_state(
        &self,
    ) -> Result<RecoveredWitnessState, PersistenceError> {
        let database = self.database_lock()?;
        let read = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_read()
            .map_err(map_transaction_error)?;
        let meta = read.open_table(META).map_err(map_table_error)?;
        let generation = read_u64(&meta, META_GENERATION)?;
        let current_key_id = read_bytes(&meta, META_CURRENT_KEY_ID)?;
        let confirmed = read_confirmed_head(&meta)?;
        let aad = state_aad(&meta)?;
        drop(meta);
        let state = read.open_table(STATE).map_err(map_table_error)?;
        let state_blob = state
            .get(STATE_CURRENT)
            .map_err(map_storage_error)?
            .map(|value| value.value().to_vec());
        drop(state);
        let pending = {
            let table = read.open_table(PENDING_WITNESS).map_err(map_table_error)?;
            witness_v2::read_pending_operation_from_table(&table)?
        };
        let Some(blob) = state_blob else {
            if pending.is_some() {
                return Err(PersistenceError::Corrupt);
            }
            self.envelope_keys
                .reconcile_prepared(self.crypto_session_id, None)?;
            return Ok(RecoveredWitnessState {
                confirmed,
                pending: None,
            });
        };
        let sealed = SealedState::decode(&blob)?;
        if current_key_id.as_slice() != sealed.key_id {
            return Err(PersistenceError::Corrupt);
        }
        self.envelope_keys
            .reconcile_prepared(self.crypto_session_id, Some((sealed.key_id, aad.clone())))
            .map_err(map_current_key_error)?;
        let mut key = self
            .envelope_keys
            .load(self.crypto_session_id, sealed.key_id, &aad)
            .map_err(map_current_key_error)?;
        let crypto = CoreProvider::new().map_err(|_| PersistenceError::Storage)?;
        let decrypted = crypto.crypto().aead_decrypt(
            AeadType::Aes256Gcm,
            &key,
            &sealed.ciphertext,
            &sealed.nonce,
            &aad,
        );
        let plaintext = match decrypted {
            Ok(value) => value,
            Err(_) => {
                key.fill(0);
                return Err(PersistenceError::Corrupt);
            }
        };
        let values = match decode_storage_image(&plaintext) {
            Ok(value) => value,
            Err(error) => {
                key.fill(0);
                return Err(error);
            }
        };
        let pending_validation =
            (|| -> Result<Option<witness::PendingWitnessOperation>, PersistenceError> {
                let Some(pending) = pending else {
                    return Ok(None);
                };
                let provider = CoreProvider::from_storage_values(values.clone())
                    .map_err(|_| PersistenceError::Corrupt)?;
                let signing = endpoint_signing(&provider, self.crypto_session_id)?;
                let operations = read.open_table(OPERATIONS).map_err(map_table_error)?;
                let operation_bytes = operations
                    .get(pending.operation_id.as_slice())
                    .map_err(map_storage_error)?
                    .ok_or(PersistenceError::Corrupt)?;
                let (operation_index, _) =
                    WitnessOperationIndex::decode_prefix(operation_bytes.value())?;
                pending.open_and_validate(
                    &key,
                    &signing.lineage,
                    &signing.credential,
                    generation,
                    &plaintext,
                    &operation_index,
                )?;
                let expected_result = values
                    .get(&exact_result_key(pending.operation_id))
                    .ok_or(PersistenceError::Corrupt)?;
                let (_, recovered) = witness::open_committed_transition(
                    &pending.committed_transition,
                    &key,
                    &signing.lineage,
                    &signing.credential,
                )
                .map_err(|_| PersistenceError::Corrupt)?;
                if recovered.exact_result != *expected_result {
                    return Err(PersistenceError::Corrupt);
                }
                let operation = witness::recover_committed_transition(
                    &pending.committed_transition,
                    &key,
                    &signing.lineage,
                    &signing.credential,
                    true,
                    pending.obsolete_key_id.is_none(),
                )
                .map_err(|_| PersistenceError::Corrupt)?;
                Ok(Some(operation))
            })();
        key.fill(0);
        let pending = pending_validation?;
        let expected_manifest = values
            .get(DURABLE_MANIFEST_KEY)
            .ok_or(PersistenceError::Corrupt)?;
        let actual_manifest = durable_manifest_read(&read, crypto.crypto())?;
        if expected_manifest.as_slice() != actual_manifest {
            return Err(PersistenceError::Quarantined);
        }
        Ok(RecoveredWitnessState { confirmed, pending })
    }

    /// Erase the obsolete key named by authenticated committed metadata and verify that it is no
    /// longer loadable. Callers invoke this only after a matching unanimous certificate.
    fn erase_and_verify_obsolete_key(&self, key_id: Id) -> Result<(), PersistenceError> {
        let (current_key_id, aad) = {
            let database = self.database_lock()?;
            let read = database
                .as_ref()
                .ok_or(PersistenceError::Storage)?
                .begin_read()
                .map_err(map_transaction_error)?;
            let meta = read.open_table(META).map_err(map_table_error)?;
            (read_bytes(&meta, META_CURRENT_KEY_ID)?, state_aad(&meta)?)
        };
        if current_key_id.as_slice() == key_id {
            return Err(PersistenceError::Quarantined);
        }
        self.faults.check(FaultPoint::DuringWrappingRecordErasure)?;
        self.envelope_keys.erase(self.crypto_session_id, key_id)?;
        match self
            .envelope_keys
            .load(self.crypto_session_id, key_id, &aad)
        {
            Err(PersistenceError::KeyUnavailable | PersistenceError::KeyRecordMissing) => Ok(()),
            Err(PersistenceError::IdentityMismatch) => {
                Err(PersistenceError::SecureStoreUnavailable)
            }
            Ok(mut leaked) => {
                leaked.fill(0);
                Err(PersistenceError::SecureStoreUnavailable)
            }
            Err(other) => Err(other),
        }
    }

    /// Verify that the successor key named by authenticated committed state is active.
    fn verify_current_key_active(&self, key_id: Id) -> Result<(), PersistenceError> {
        let (current_key_id, aad) = {
            let database = self.database_lock()?;
            let read = database
                .as_ref()
                .ok_or(PersistenceError::Storage)?
                .begin_read()
                .map_err(map_transaction_error)?;
            let meta = read.open_table(META).map_err(map_table_error)?;
            (read_bytes(&meta, META_CURRENT_KEY_ID)?, state_aad(&meta)?)
        };
        if current_key_id.as_slice() != key_id {
            return Err(PersistenceError::Corrupt);
        }
        let mut key = self
            .envelope_keys
            .load(self.crypto_session_id, key_id, &aad)
            .map_err(map_current_key_error)?;
        key.fill(0);
        Ok(())
    }

    #[cfg(test)]
    fn read_u64_meta(&self, key: u8) -> Result<u64, PersistenceError> {
        let database = self.database_lock()?;
        let read = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_read()
            .map_err(map_transaction_error)?;
        let meta = read.open_table(META).map_err(map_table_error)?;
        read_u64(&meta, key)
    }

    fn database_lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Option<Database>>, PersistenceError> {
        let guard = self
            .database
            .lock()
            .map_err(|_| PersistenceError::Storage)?;
        if guard.is_none() {
            return Err(PersistenceError::Storage);
        }
        Ok(guard)
    }

    /// A non-poisoned commit error has an uncertain outcome. Close and reopen the engine, then
    /// consult the authenticated pending row. Candidate state from this process is never reused.
    fn recover_uncertain(
        &self,
        operation_id: Id,
        prepared_key: Option<[u8; 16]>,
    ) -> Result<PendingWitnessRequest, PersistenceError> {
        self.close()?;
        self.reopen_database_only()?;
        let recovered = self.recover_storage()?;
        self.rebuild_witness_runtime(recovered)?;
        if let Some(row) = self.read_pending_row()?
            && row.operation_id == operation_id
        {
            return pending_request_from_row(&row);
        }
        if let Some(key_id) = prepared_key {
            self.faults.check(FaultPoint::DuringWrappingRecordErasure)?;
            self.envelope_keys.erase(self.crypto_session_id, key_id)?;
        }
        Err(PersistenceError::Storage)
    }
}

/// Authenticated confirmed head and recovered pending operation produced by state recovery.
struct RecoveredWitnessState {
    confirmed: ConfirmedWitnessHead,
    pending: Option<witness::PendingWitnessOperation>,
}

/// Endpoint lineage, credential, and signer reconstructed from the authenticated image.
struct EndpointSigning {
    lineage: WitnessLineage,
    credential: PairingCredential,
    signer: SignatureKeyPair,
}

fn endpoint_signing(
    provider: &CoreProvider,
    crypto_session_id: Id,
) -> Result<EndpointSigning, PersistenceError> {
    let metadata = decode_endpoint_metadata(
        &provider
            .internal(ENDPOINT_METADATA_KEY)
            .ok_or(PersistenceError::Corrupt)?,
    )?;
    let (identity, signer_public) = (metadata.identity, metadata.signer_public);
    let signer = SignatureKeyPair::read(
        provider.storage(),
        &signer_public,
        SUITE.signature_algorithm(),
    )
    .ok_or(PersistenceError::Corrupt)?;
    let credential =
        PairingCredential::new(identity.clone(), &signer).map_err(|_| PersistenceError::Corrupt)?;
    let lineage = WitnessLineage::from_identity(&identity, crypto_session_id)
        .map_err(|_| PersistenceError::IdentityMismatch)?;
    Ok(EndpointSigning {
        lineage,
        credential,
        signer,
    })
}

fn read_confirmed_head(
    meta: &impl ReadableTable<u8, &'static [u8]>,
) -> Result<ConfirmedWitnessHead, PersistenceError> {
    let registration = match read_bytes(meta, META_WITNESS_REGISTRATION)?.as_slice() {
        [WITNESS_UNREGISTERED] => WitnessRegistrationState::Unregistered,
        [WITNESS_REGISTERED] => WitnessRegistrationState::Registered,
        _ => return Err(PersistenceError::Corrupt),
    };
    let confirmed = ConfirmedWitnessHead {
        counter: read_u64(meta, META_CONFIRMED_WITNESS_COUNTER)?,
        commitment: read_bytes(meta, META_CONFIRMED_WITNESS_COMMITMENT)?
            .try_into()
            .map_err(|_| PersistenceError::Corrupt)?,
        previous_certificate_hash: read_bytes(meta, META_PREVIOUS_CERTIFICATE_HASH)?
            .try_into()
            .map_err(|_| PersistenceError::Corrupt)?,
        registration,
    };
    confirmed.validate()?;
    Ok(confirmed)
}

fn pending_request_from_row(
    row: &DurableWitnessOperation,
) -> Result<PendingWitnessRequest, PersistenceError> {
    let request =
        WitnessRequest::decode(&row.witness_request).map_err(|_| PersistenceError::Corrupt)?;
    Ok(PendingWitnessRequest {
        operation_id: row.operation_id,
        request: row.witness_request.clone(),
        request_hash: row.request_hash,
        kind: request.kind(),
    })
}

fn exact_result_key(operation_id: Id) -> Vec<u8> {
    let mut key = EXACT_RESULT_PREFIX.to_vec();
    key.extend_from_slice(&operation_id);
    key
}

fn map_witness_error(error: WitnessError) -> PersistenceError {
    match error {
        WitnessError::PendingOperation => PersistenceError::WitnessUnavailable,
        WitnessError::FreshWitnessRequired | WitnessError::NoPendingOperation => {
            PersistenceError::FreshWitnessRequired
        }
        WitnessError::OperationConflict => PersistenceError::WitnessOperationConflict,
        WitnessError::RegistrationConflict => PersistenceError::WitnessRegistrationConflict,
        WitnessError::Revoked => PersistenceError::EndpointRevoked,
        WitnessError::Forked | WitnessError::StaleExpected => PersistenceError::WitnessConflict,
        WitnessError::InvalidExpected => PersistenceError::WitnessInvalidExpected,
        WitnessError::Quarantined => PersistenceError::Quarantined,
        WitnessError::OutputBlocked => PersistenceError::WitnessUnavailable,
        WitnessError::GenerationMismatch => PersistenceError::GenerationConflict,
        WitnessError::CorruptState => PersistenceError::Corrupt,
        WitnessError::BoundExceeded
        | WitnessError::Malformed
        | WitnessError::NonCanonical
        | WitnessError::ProfileMismatch
        | WitnessError::LineageMismatch
        | WitnessError::RoleMismatch
        | WitnessError::CounterMismatch
        | WitnessError::CommitmentMismatch
        | WitnessError::PredecessorMismatch
        | WitnessError::OperationMismatch
        | WitnessError::RequestHashMismatch
        | WitnessError::RevocationMismatch
        | WitnessError::CredentialMismatch
        | WitnessError::InvalidSignature
        | WitnessError::InvalidQuorum
        | WitnessError::DuplicateReplica
        | WitnessError::InvalidTrustSet
        | WitnessError::UnpinnedKey
        | WitnessError::MixedReceipts
        | WitnessError::UnexpectedResult => PersistenceError::WitnessReceiptInvalid,
        WitnessError::Crypto => PersistenceError::Storage,
    }
}

#[cfg(test)]
impl TransactionalProvider for Arc<NativeTransactionalProvider> {
    type TransactionError = PersistenceError;
    type Transaction<'a>
        = NativeGroupTransaction<'a>
    where
        Self: 'a;

    fn begin_transaction(
        &self,
        crypto_session_id: Id,
        expected_generation: u64,
        expected_rollback_counter: u64,
    ) -> Result<Self::Transaction<'_>, Self::TransactionError> {
        let operation_guard = self
            .operation_lock
            .lock()
            .map_err(|_| PersistenceError::Storage)?;
        self.begin_transaction_locked(
            operation_guard,
            crypto_session_id,
            Some((expected_generation, expected_rollback_counter)),
        )
    }
}

/// Result of the pre-transition lookup performed by the witness runner.
pub(crate) enum Lookup<'a> {
    /// The same operation is locally committed and awaiting the witness barrier.
    Pending(PendingWitnessRequest),
    /// The same operation completed within the retention horizon; this is its exact result.
    Released(TypedResult),
    /// No prior record exists; the caller may perform at most one transition in this transaction.
    Fresh(Box<NativeGroupTransaction<'a>>),
}

impl NativeTransactionalProvider {
    fn begin_transaction_locked<'a>(
        self: &'a Arc<Self>,
        operation_guard: std::sync::MutexGuard<'a, ()>,
        crypto_session_id: Id,
        expected: Option<(u64, u64)>,
    ) -> Result<NativeGroupTransaction<'a>, PersistenceError> {
        self.recover_storage()?;
        if crypto_session_id != self.crypto_session_id {
            return Err(PersistenceError::IdentityMismatch);
        }
        let database = self.database_lock()?;
        let mut write = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_write()
            .map_err(map_transaction_error)?;
        configure_transaction(&mut write)?;
        let (generation, rollback_counter, epoch, authenticator, state_aad, state_blob) = {
            let meta = write.open_table(META).map_err(map_table_error)?;
            let generation = read_u64(&meta, META_GENERATION)?;
            let rollback_counter = read_u64(&meta, META_ROLLBACK_COUNTER)?;
            if let Some((expected_generation, expected_rollback_counter)) = expected
                && (generation != expected_generation
                    || rollback_counter != expected_rollback_counter)
            {
                self.faults.check(FaultPoint::DuringGenerationConflict)?;
                return Err(PersistenceError::GenerationConflict);
            }
            if generation != rollback_counter {
                return Err(PersistenceError::Corrupt);
            }
            let epoch = read_u64(&meta, META_EPOCH)?;
            let authenticator = read_bytes(&meta, META_EPOCH_AUTHENTICATOR)?.to_vec();
            let state_aad = state_aad(&meta)?;
            drop(meta);
            let state = write.open_table(STATE).map_err(map_table_error)?;
            let state_blob = state
                .get(STATE_CURRENT)
                .map_err(map_storage_error)?
                .map(|value| value.value().to_vec());
            (
                generation,
                rollback_counter,
                epoch,
                authenticator,
                state_aad,
                state_blob,
            )
        };
        let (provider, old_key_id) = if let Some(blob) = state_blob {
            let sealed = SealedState::decode(&blob)?;
            let mut key = self
                .envelope_keys
                .load(self.crypto_session_id, sealed.key_id, &state_aad)
                .map_err(map_current_key_error)?;
            let crypto = CoreProvider::new().map_err(|_| PersistenceError::Storage)?;
            let decrypted = crypto.crypto().aead_decrypt(
                AeadType::Aes256Gcm,
                &key,
                &sealed.ciphertext,
                &sealed.nonce,
                &state_aad,
            );
            key.fill(0);
            let plaintext = decrypted.map_err(|_| PersistenceError::Corrupt)?;
            let values = decode_storage_image(&plaintext)?;
            (
                CoreProvider::from_storage_values(values).map_err(|_| PersistenceError::Storage)?,
                Some(sealed.key_id),
            )
        } else {
            (
                CoreProvider::new().map_err(|_| PersistenceError::Storage)?,
                None,
            )
        };
        if old_key_id.is_some() {
            let expected_manifest = provider
                .internal(DURABLE_MANIFEST_KEY)
                .ok_or(PersistenceError::Corrupt)?;
            let actual_manifest = durable_manifest(&write, provider.crypto())?;
            if expected_manifest.as_slice() != actual_manifest {
                return Err(PersistenceError::Quarantined);
            }
        }
        let accepted_ids = load_accepted_ids(&write, self.crypto_session_id)?;
        drop(database);
        Ok(NativeGroupTransaction {
            owner: Arc::clone(self),
            write: Some(write),
            provider,
            expected_generation: generation,
            expected_rollback_counter: rollback_counter,
            old_epoch: epoch,
            old_authenticator: authenticator,
            operation_id: None,
            operation_kind: None,
            operation_fingerprint: None,
            staged: None,
            next_epoch: epoch,
            next_authenticator: Vec::new(),
            old_key_id,
            prepared_key_id: None,
            accepted_updates: Vec::new(),
            outbox_updates: Vec::new(),
            operation_updates: Vec::new(),
            accepted_ids,
            _operation_guard: operation_guard,
        })
    }

    /// Common witness transaction runner entry.
    ///
    /// Holds the endpoint operation mutex, refuses terminal endpoints, blocks every later mutation
    /// while one witness operation is pending without opening a write transaction, resolves
    /// duplicate operation IDs before any transition, and requires one unconsumed mutation
    /// authorization from a fresh unanimous read before returning a fresh transaction.
    pub(crate) fn begin_witnessed(
        self: &Arc<Self>,
        operation_id: Id,
        operation_kind: u16,
        fingerprint: [u8; 48],
    ) -> Result<Lookup<'_>, PersistenceError> {
        if operation_id == [0; 16] {
            return Err(PersistenceError::IdentityMismatch);
        }
        let operation_guard = self
            .operation_lock
            .lock()
            .map_err(|_| PersistenceError::Storage)?;
        {
            let runtime = self.witness_lock()?;
            if let Some(terminal) = runtime.state.terminal() {
                return Err(terminal_error(terminal));
            }
        }
        if let Some(row) = self.read_pending_row()? {
            if row.operation_id == operation_id {
                if row.fingerprint != fingerprint {
                    self.quarantine_locally()?;
                    return Err(PersistenceError::WitnessOperationConflict);
                }
                return match row.disposition {
                    WitnessOperationDisposition::Pending => {
                        self.ensure_pending_key_active(&row)?;
                        Ok(Lookup::Pending(pending_request_from_row(&row)?))
                    }
                    WitnessOperationDisposition::Completed => {
                        self.faults.check(FaultPoint::DuringDuplicateOperation)?;
                        let runtime = self.witness_lock()?;
                        let confirmed_live = !runtime.state.has_pending()
                            && runtime.state.head().counter
                                == row.confirmed_head.counter.saturating_add(1);
                        drop(runtime);
                        if !confirmed_live {
                            // The completion cache is not witness authority after restart.
                            return Err(PersistenceError::FreshWitnessRequired);
                        }
                        self.released_result(operation_id, row.operation_kind)
                            .map(Lookup::Released)
                    }
                };
            }
            if row.disposition == WitnessOperationDisposition::Pending {
                return Err(PersistenceError::WitnessUnavailable);
            }
        }
        if let Some((index, _)) = self.operation_index(operation_id)? {
            self.faults.check(FaultPoint::DuringDuplicateOperation)?;
            if index.fingerprint != fingerprint {
                self.quarantine_locally()?;
                return Err(PersistenceError::WitnessOperationConflict);
            }
            if self.witness_lock()?.state.has_pending() {
                // A restored snapshot is not validated until a fresh head confirms the cached
                // completion; no older exact result leaves the crate before that.
                return Err(PersistenceError::FreshWitnessRequired);
            }
            return self
                .released_result(operation_id, index.operation_kind)
                .map(Lookup::Released);
        }
        {
            let runtime = self.witness_lock()?;
            if runtime.state.has_pending() {
                return Err(PersistenceError::WitnessUnavailable);
            }
            if !runtime.state.has_mutation_authorization() {
                return Err(PersistenceError::FreshWitnessRequired);
            }
        }
        let mut transaction =
            self.begin_transaction_locked(operation_guard, self.crypto_session_id, None)?;
        transaction.operation_id = Some(operation_id);
        transaction.operation_kind = Some(operation_kind);
        transaction.operation_fingerprint = Some(fingerprint);
        Ok(Lookup::Fresh(Box::new(transaction)))
    }

    /// Idempotently finish or verify successor-key activation before exposing the pending
    /// request. A failed or uncertain first activation leaves committed state recoverable but
    /// externally invisible until this succeeds.
    fn ensure_pending_key_active(
        &self,
        row: &DurableWitnessOperation,
    ) -> Result<(), PersistenceError> {
        let aad = {
            let database = self.database_lock()?;
            let read = database
                .as_ref()
                .ok_or(PersistenceError::Storage)?
                .begin_read()
                .map_err(map_transaction_error)?;
            let meta = read.open_table(META).map_err(map_table_error)?;
            if read_bytes(&meta, META_CURRENT_KEY_ID)? != row.successor_key_id {
                return Err(PersistenceError::Corrupt);
            }
            state_aad(&meta)?
        };
        self.faults.check(FaultPoint::DuringCurrentKeyActivation)?;
        self.envelope_keys
            .activate(self.crypto_session_id, row.successor_key_id, &aad)
            .map_err(map_current_key_error)?;
        let mut runtime = self.witness_lock()?;
        runtime
            .state
            .pending_mut()
            .map_err(map_witness_error)?
            .current_key_activated();
        Ok(())
    }

    fn quarantine_locally(&self) -> Result<(), PersistenceError> {
        let reason = EndpointTerminalState::Quarantined(
            witness::EndpointQuarantineReason::CommitmentConflict,
        );
        self.witness_lock()?.state.set_terminal(reason);
        self.persist_terminal_marker(reason)
    }

    fn operation_index(
        &self,
        operation_id: Id,
    ) -> Result<Option<(WitnessOperationIndex, CommittedOperation)>, PersistenceError> {
        let database = self.database_lock()?;
        let read = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_read()
            .map_err(map_transaction_error)?;
        let table = read.open_table(OPERATIONS).map_err(map_table_error)?;
        let value = table
            .get(operation_id.as_slice())
            .map_err(map_storage_error)?;
        value
            .map(|bytes| {
                let (index, operation) = decode_operation_index(bytes.value())?;
                validate_operation_binding(&operation, operation_id, self.crypto_session_id)?;
                Ok((index, operation))
            })
            .transpose()
    }

    /// Decode the exact typed result of a completed operation from the authenticated image.
    fn released_result(
        &self,
        operation_id: Id,
        operation_kind: u16,
    ) -> Result<TypedResult, PersistenceError> {
        let database = self.database_lock()?;
        let read = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_read()
            .map_err(map_transaction_error)?;
        let meta = read.open_table(META).map_err(map_table_error)?;
        let aad = state_aad(&meta)?;
        drop(meta);
        let state = read.open_table(STATE).map_err(map_table_error)?;
        let blob = state
            .get(STATE_CURRENT)
            .map_err(map_storage_error)?
            .map(|value| value.value().to_vec())
            .ok_or(PersistenceError::Corrupt)?;
        drop(state);
        let sealed = SealedState::decode(&blob)?;
        let mut key = self
            .envelope_keys
            .load(self.crypto_session_id, sealed.key_id, &aad)
            .map_err(map_current_key_error)?;
        let crypto = CoreProvider::new().map_err(|_| PersistenceError::Storage)?;
        let decrypted = crypto.crypto().aead_decrypt(
            AeadType::Aes256Gcm,
            &key,
            &sealed.ciphertext,
            &sealed.nonce,
            &aad,
        );
        key.fill(0);
        let plaintext = decrypted.map_err(|_| PersistenceError::Corrupt)?;
        let values = decode_storage_image(&plaintext)?;
        let Some(encoded) = values.get(&exact_result_key(operation_id)) else {
            return Err(if operation_kind == op_kind::APPLICATION_RECEIVE {
                PersistenceError::AlreadyAcknowledged
            } else {
                PersistenceError::Corrupt
            });
        };
        let exact = ExactResult::decode(encoded)?;
        decode_typed_result(
            operation_kind,
            &exact,
            &values,
            &read,
            self.crypto_session_id,
        )
    }

    /// Expose the one durable pending request, or `None` when no operation awaits the barrier.
    pub(crate) fn pending_witness(
        &self,
    ) -> Result<Option<PendingWitnessRequest>, PersistenceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| PersistenceError::Storage)?;
        let runtime = self.witness_lock()?;
        if let Some(terminal) = runtime.state.terminal() {
            return Err(terminal_error(terminal));
        }
        if !runtime.state.has_pending() {
            return Ok(None);
        }
        drop(runtime);
        // A completed cache row is still resent after restart until a fresh head or the exact
        // duplicate certificate confirms it in this process.
        match self.read_pending_row()? {
            Some(row) => {
                self.ensure_pending_key_active(&row)?;
                Ok(Some(pending_request_from_row(&row)?))
            }
            None => Ok(None),
        }
    }

    /// Construct a fresh signed `read` for reconciliation. The next `reconcile_witness` call must
    /// present a certificate for exactly these bytes.
    pub(crate) fn witness_read_request(self: &Arc<Self>) -> Result<Vec<u8>, PersistenceError> {
        let operation_guard = self
            .operation_lock
            .lock()
            .map_err(|_| PersistenceError::Storage)?;
        let transaction =
            self.begin_transaction_locked(operation_guard, self.crypto_session_id, None)?;
        if transaction.expected_generation == 0 {
            transaction.rollback()?;
            return Err(PersistenceError::StateLoss);
        }
        let signing = endpoint_signing(&transaction.provider, self.crypto_session_id)?;
        let operation_id = loop {
            let value = transaction
                .provider
                .rand()
                .random_array::<16>()
                .map_err(|_| PersistenceError::Storage)?;
            if value != [0; 16] {
                break value;
            }
        };
        let nonce = loop {
            let value = transaction
                .provider
                .rand()
                .random_array::<32>()
                .map_err(|_| PersistenceError::Storage)?;
            if value != [0; 32] {
                break value;
            }
        };
        transaction.rollback()?;
        let mut runtime = self.witness_lock()?;
        let request = WitnessRequest::new_read(
            signing.lineage,
            operation_id,
            runtime.state.previous_certificate_hash(),
            &signing.credential,
            &signing.signer,
            nonce,
        )
        .map_err(map_witness_error)?;
        let bytes = request.encode().map_err(map_witness_error)?;
        let hash = request.request_hash().map_err(map_witness_error)?;
        if runtime.pending_reads.len() >= MAX_PENDING_READS {
            runtime.pending_reads.pop_front();
        }
        runtime.pending_reads.push_back((hash, request));
        Ok(bytes)
    }

    /// Verify a fresh unanimous `read` certificate and reconcile local state against it. A `Ready`
    /// outcome grants exactly one mutation authorization.
    pub(crate) fn reconcile_witness(
        self: &Arc<Self>,
        certificate: &[u8],
    ) -> Result<EndpointReconciliation, PersistenceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| PersistenceError::Storage)?;
        let (local_state_present, lineage_was_registered) = {
            let database = self.database_lock()?;
            let read = database
                .as_ref()
                .ok_or(PersistenceError::Storage)?
                .begin_read()
                .map_err(map_transaction_error)?;
            let meta = read.open_table(META).map_err(map_table_error)?;
            let generation = read_u64(&meta, META_GENERATION)?;
            let registered = read_bytes(&meta, META_WITNESS_REGISTRATION)? == [WITNESS_REGISTERED];
            (generation > 0, registered)
        };
        let pending_register = self
            .read_pending_row()?
            .is_some_and(|row| row.confirmed_head.counter == 0);
        let mut runtime = self.witness_lock()?;
        if runtime.pending_reads.is_empty() {
            return Err(PersistenceError::FreshWitnessRequired);
        }
        let certificate = QuorumCertificate::decode(certificate).map_err(|error| {
            let _ = self.quarantine_after_receipt_failure(&mut runtime.state);
            map_witness_error(error)
        })?;
        let request_hash = certificate.receipts()[0].request_hash();
        let Some(position) = runtime
            .pending_reads
            .iter()
            .position(|(hash, _)| *hash == request_hash)
        else {
            // A certificate for a read this endpoint never signed is not a fresh head.
            self.quarantine_after_receipt_failure(&mut runtime.state)?;
            return Err(PersistenceError::WitnessReceiptInvalid);
        };
        let (_, request) = runtime
            .pending_reads
            .remove(position)
            .ok_or(PersistenceError::Storage)?;
        let result = match certificate.verify(&request, &self.trust) {
            Ok(result) => result,
            Err(error) => {
                self.quarantine_after_receipt_failure(&mut runtime.state)?;
                return Err(map_witness_error(error));
            }
        };
        let quorum = FreshQuorumState::from_verified_read(&certificate, result);
        let outcome = runtime.state.reconcile(
            local_state_present,
            lineage_was_registered || pending_register,
            quorum,
        );
        if let Some(terminal) = runtime.state.terminal() {
            self.persist_terminal_marker(terminal)?;
        }
        Ok(outcome)
    }

    fn quarantine_after_receipt_failure(
        &self,
        state: &mut EndpointWitnessState,
    ) -> Result<(), PersistenceError> {
        let terminal = EndpointTerminalState::Quarantined(
            witness::EndpointQuarantineReason::WitnessInconsistent,
        );
        state.set_terminal(terminal);
        self.persist_terminal_marker(terminal)
    }

    /// Complete the barrier for the one pending operation.
    ///
    /// Order: verify the unanimous certificate against the exact stored request, verify that the
    /// successor key remains active, erase and verify absence of the obsolete key, mark the exact
    /// result releasable, and only then decode and return it.
    pub(crate) fn continue_witness(
        self: &Arc<Self>,
        operation_id: Id,
        certificate: &[u8],
    ) -> Result<TypedResult, PersistenceError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| PersistenceError::Storage)?;
        let row = self.read_pending_row()?.ok_or(PersistenceError::NotFound)?;
        if row.operation_id != operation_id {
            return Err(PersistenceError::NotFound);
        }
        let mut runtime = self.witness_lock()?;
        if let Some(terminal) = runtime.state.terminal() {
            return Err(terminal_error(terminal));
        }
        if !runtime.state.has_pending() {
            // The live process already released this result; a fresh head is required before
            // the cached completion may be reused.
            return Err(PersistenceError::FreshWitnessRequired);
        }
        self.faults
            .check(FaultPoint::BeforeCertificateVerification)?;
        {
            let pending = runtime.state.pending_mut().map_err(map_witness_error)?;
            if pending.operation_id() != operation_id || pending.request_hash() != row.request_hash
            {
                return Err(PersistenceError::Corrupt);
            }
            if let Err(error) = pending.confirm_quorum(certificate, &self.trust) {
                let mapped = map_witness_error(error.clone());
                match error {
                    WitnessError::Revoked => {
                        runtime.state.set_terminal(EndpointTerminalState::Revoked);
                        self.persist_terminal_marker(EndpointTerminalState::Revoked)?;
                    }
                    WitnessError::OperationConflict
                    | WitnessError::RegistrationConflict
                    | WitnessError::Forked
                    | WitnessError::StaleExpected
                    | WitnessError::InvalidExpected => {
                        let terminal = EndpointTerminalState::Quarantined(
                            witness::EndpointQuarantineReason::CommitmentConflict,
                        );
                        runtime.state.set_terminal(terminal);
                        self.persist_terminal_marker(terminal)?;
                    }
                    WitnessError::UnexpectedResult => {}
                    _ => self.quarantine_after_receipt_failure(&mut runtime.state)?,
                }
                return Err(mapped);
            }
        }
        self.faults
            .check(FaultPoint::AfterCertificateVerificationBeforeErasure)?;
        drop(runtime);
        self.verify_current_key_active(row.successor_key_id)?;
        let mut runtime = self.witness_lock()?;
        if let Some(obsolete) = row.obsolete_key_id {
            self.erase_and_verify_obsolete_key(obsolete)?;
        }
        runtime
            .state
            .pending_mut()
            .map_err(map_witness_error)?
            .obsolete_key_erased()
            .map_err(map_witness_error)?;
        self.faults.check(FaultPoint::AfterErasureBeforeRelease)?;
        self.mark_operation_completed(&row)?;
        let exact_result = runtime
            .state
            .release_and_advance()
            .map_err(map_witness_error)?;
        drop(runtime);
        let lifecycle = {
            let database = self.database_lock()?;
            inspect_database_lifecycle(
                database.as_ref().ok_or(PersistenceError::Storage)?,
                self.crypto_session_id,
            )?
        };
        if lifecycle == LIFECYCLE_INITIALIZING {
            self.faults.check(FaultPoint::BeforeInitializationReady)?;
            self.mark_ready()?;
        }
        let exact = ExactResult::decode(&exact_result)?;
        if exact.kind() != row.exact_result_kind {
            return Err(PersistenceError::Corrupt);
        }
        let database = self.database_lock()?;
        let read = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_read()
            .map_err(map_transaction_error)?;
        let values = self.authenticated_values(&read)?;
        decode_typed_result(
            row.operation_kind,
            &exact,
            &values,
            &read,
            self.crypto_session_id,
        )
    }

    fn authenticated_values(
        &self,
        read: &redb::ReadTransaction,
    ) -> Result<BTreeMap<Vec<u8>, Vec<u8>>, PersistenceError> {
        let meta = read.open_table(META).map_err(map_table_error)?;
        let aad = state_aad(&meta)?;
        drop(meta);
        let state = read.open_table(STATE).map_err(map_table_error)?;
        let blob = state
            .get(STATE_CURRENT)
            .map_err(map_storage_error)?
            .map(|value| value.value().to_vec())
            .ok_or(PersistenceError::Corrupt)?;
        drop(state);
        let sealed = SealedState::decode(&blob)?;
        let mut key = self
            .envelope_keys
            .load(self.crypto_session_id, sealed.key_id, &aad)
            .map_err(map_current_key_error)?;
        let crypto = CoreProvider::new().map_err(|_| PersistenceError::Storage)?;
        let decrypted = crypto.crypto().aead_decrypt(
            AeadType::Aes256Gcm,
            &key,
            &sealed.ciphertext,
            &sealed.nonce,
            &aad,
        );
        key.fill(0);
        let plaintext = decrypted.map_err(|_| PersistenceError::Corrupt)?;
        decode_storage_image(&plaintext)
    }

    /// Persist the releasable marker. It is a recovery cache: losing it forces re-verification,
    /// never a second mutation or result loss.
    fn mark_operation_completed(
        &self,
        row: &DurableWitnessOperation,
    ) -> Result<(), PersistenceError> {
        if row.disposition == WitnessOperationDisposition::Completed {
            return Ok(());
        }
        let mut completed = row.clone();
        completed.disposition = WitnessOperationDisposition::Completed;
        let database = self.database_lock()?;
        let mut write = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_write()
            .map_err(map_transaction_error)?;
        configure_transaction(&mut write)?;
        witness_v2::write_pending_operation(&write, &completed)?;
        write.commit().map_err(|_| PersistenceError::Storage)
    }
}

fn terminal_error(terminal: EndpointTerminalState) -> PersistenceError {
    match terminal {
        EndpointTerminalState::Quarantined(_) => PersistenceError::Quarantined,
        EndpointTerminalState::Revoked => PersistenceError::EndpointRevoked,
    }
}

/// One strict redb transaction and its transaction-local OpenMLS provider.
pub(crate) struct NativeGroupTransaction<'a> {
    owner: Arc<NativeTransactionalProvider>,
    write: Option<WriteTransaction>,
    provider: CoreProvider,
    expected_generation: u64,
    expected_rollback_counter: u64,
    old_epoch: u64,
    old_authenticator: Vec<u8>,
    operation_id: Option<Id>,
    operation_kind: Option<u16>,
    operation_fingerprint: Option<[u8; 48]>,
    staged: Option<CommittedOperation>,
    next_epoch: u64,
    next_authenticator: Vec<u8>,
    old_key_id: Option<[u8; 16]>,
    prepared_key_id: Option<[u8; 16]>,
    accepted_updates: Vec<(Id, AcceptedMessageRecord)>,
    outbox_updates: Vec<(Id, OutboxRecord)>,
    operation_updates: Vec<(Id, Vec<u8>)>,
    accepted_ids: BTreeSet<Id>,
    _operation_guard: std::sync::MutexGuard<'a, ()>,
}

impl NativeGroupTransaction<'_> {
    fn set_successor_epoch(&mut self, epoch: u64, authenticator: &[u8]) {
        self.next_epoch = epoch;
        self.next_authenticator.clear();
        self.next_authenticator.extend_from_slice(authenticator);
    }

    fn keep_epoch(&mut self) {
        let epoch = self.old_epoch;
        let authenticator = self.old_authenticator.clone();
        self.set_successor_epoch(epoch, &authenticator);
    }

    fn write(&mut self) -> Result<&mut WriteTransaction, PersistenceError> {
        self.write.as_mut().ok_or(PersistenceError::Storage)
    }

    pub(crate) fn replace_provider_values(
        &mut self,
        values: BTreeMap<Vec<u8>, Vec<u8>>,
    ) -> Result<(), PersistenceError> {
        self.provider =
            CoreProvider::from_storage_values(values).map_err(|_| PersistenceError::Storage)?;
        Ok(())
    }

    pub(crate) fn stage_accepted_record(
        &mut self,
        record: AcceptedMessageRecord,
    ) -> Result<(), PersistenceError> {
        self.owner
            .faults
            .check(FaultPoint::DuringReceiverStateWrites)?;
        self.stage_operation(CommittedOperation::Accepted(record))
    }

    fn update_accepted(&mut self, operation_id: Id, record: AcceptedMessageRecord) {
        self.accepted_updates.push((operation_id, record));
    }

    fn update_outbox(&mut self, operation_id: Id, record: OutboxRecord) {
        self.outbox_updates.push((operation_id, record));
    }

    fn update_operation(
        &mut self,
        operation_id: Id,
        operation: CommittedOperation,
    ) -> Result<(), PersistenceError> {
        let write = self.write.as_ref().ok_or(PersistenceError::Storage)?;
        let table = write.open_table(OPERATIONS).map_err(map_table_error)?;
        let bytes = table
            .get(operation_id.as_slice())
            .map_err(map_storage_error)?
            .ok_or(PersistenceError::NotFound)?;
        let (mut index, existing) = decode_operation_index(bytes.value())?;
        validate_operation_binding(&existing, operation_id, self.owner.crypto_session_id)?;
        drop(bytes);
        drop(table);
        index.disposition = WitnessOperationDisposition::Completed;
        self.operation_updates
            .push((operation_id, encode_operation_index(&index, &operation)?));
        Ok(())
    }

    fn stage_operation(&mut self, operation: CommittedOperation) -> Result<(), PersistenceError> {
        if self.operation_id.is_none()
            || self.operation_fingerprint.is_none()
            || self.staged.is_some()
        {
            return Err(PersistenceError::Conflict);
        }
        self.staged = Some(operation);
        Ok(())
    }

    /// Commit the complete successor image, exact result, operation index, pending marker,
    /// committed transition, and affected retry records atomically, then activate the successor
    /// key. Returns only the exact pending request; the typed result stays sealed.
    fn commit_witnessed(
        mut self,
        result: TypedResult,
    ) -> Result<PendingWitnessRequest, PersistenceError> {
        let operation_id = self.operation_id.ok_or(PersistenceError::Conflict)?;
        let operation_kind = self.operation_kind.ok_or(PersistenceError::Conflict)?;
        let fingerprint = self
            .operation_fingerprint
            .ok_or(PersistenceError::Conflict)?;
        let operation = self.staged.clone().ok_or(PersistenceError::Conflict)?;
        let exact = result.encode()?;
        let exact_bytes = exact.encode()?;
        let next_generation = self
            .expected_generation
            .checked_add(1)
            .ok_or(PersistenceError::Corrupt)?;
        let next_counter = self
            .expected_rollback_counter
            .checked_add(1)
            .ok_or(PersistenceError::Corrupt)?;

        // Confirmed predecessor head from the live runtime. The authorization was granted by a
        // fresh unanimous read (or the initial registration grant) and is consumed below.
        let (confirmed, previous_certificate_hash) = {
            let runtime = self.owner.witness_lock()?;
            if let Some(terminal) = runtime.state.terminal() {
                return Err(terminal_error(terminal));
            }
            if runtime.state.has_pending() {
                return Err(PersistenceError::WitnessUnavailable);
            }
            let head = runtime.state.head();
            (head, runtime.state.previous_certificate_hash())
        };
        if confirmed.counter != self.expected_rollback_counter {
            return Err(PersistenceError::FreshWitnessRequired);
        }
        let confirmed_head = ConfirmedWitnessHead {
            counter: confirmed.counter,
            commitment: confirmed.commitment,
            previous_certificate_hash,
            registration: if confirmed.counter == 0 {
                WitnessRegistrationState::Unregistered
            } else {
                WitnessRegistrationState::Registered
            },
        };
        confirmed_head.validate()?;

        self.owner
            .faults
            .check(FaultPoint::DuringOpenMlsProviderWrites)?;
        self.owner
            .faults
            .check(FaultPoint::BeforeCiphertextInsertion)?;
        let next_epoch_bytes = self.next_epoch.to_be_bytes();
        let next_authenticator = self.next_authenticator.clone();
        let pending_erase = self.old_key_id.map_or(Vec::new(), |key_id| key_id.to_vec());
        let accepted_updates = self.accepted_updates.clone();
        let outbox_updates = self.outbox_updates.clone();
        let operation_updates = self.operation_updates.clone();
        let index = WitnessOperationIndex {
            operation_kind,
            fingerprint,
            generation: next_generation,
            disposition: WitnessOperationDisposition::Pending,
            exact_result_kind: exact.kind(),
        };
        {
            let write = self.write()?;
            witness_v2::remove_completed_operation(write)?;
            mark_previous_pending_index_completed(write, operation_id)?;
            for (accepted_id, record) in &accepted_updates {
                let bytes = encode_accepted(record);
                let mut accepted = write.open_table(ACCEPTED).map_err(map_table_error)?;
                accepted
                    .insert(accepted_id.as_slice(), bytes.as_slice())
                    .map_err(map_storage_error)?;
            }
            for (updated_id, bytes) in &operation_updates {
                let mut operations = write.open_table(OPERATIONS).map_err(map_table_error)?;
                operations
                    .insert(updated_id.as_slice(), bytes.as_slice())
                    .map_err(map_storage_error)?;
            }
            for (outbox_id, record) in &outbox_updates {
                let bytes = encode_outbox(record)?;
                let mut outbox = write.open_table(OUTBOX).map_err(map_table_error)?;
                outbox
                    .insert(outbox_id.as_slice(), bytes.as_slice())
                    .map_err(map_storage_error)?;
            }
            match &operation {
                CommittedOperation::Envelope(record) => {
                    let bytes = encode_outbox(record)?;
                    let mut outbox = write.open_table(OUTBOX).map_err(map_table_error)?;
                    outbox
                        .insert(operation_id.as_slice(), bytes.as_slice())
                        .map_err(map_storage_error)?;
                }
                CommittedOperation::Accepted(record) => {
                    let bytes = encode_accepted(record);
                    let mut accepted = write.open_table(ACCEPTED).map_err(map_table_error)?;
                    accepted
                        .insert(operation_id.as_slice(), bytes.as_slice())
                        .map_err(map_storage_error)?;
                }
                CommittedOperation::OutboxAcknowledged(_)
                | CommittedOperation::ReceiveAcknowledged(_)
                | CommittedOperation::Pairing(_) => {}
            }
            let bytes = encode_operation_index(&index, &operation)?;
            let mut operations = write.open_table(OPERATIONS).map_err(map_table_error)?;
            operations
                .insert(operation_id.as_slice(), bytes.as_slice())
                .map_err(map_storage_error)?;
            drop(operations);
            let mut meta = write.open_table(META).map_err(map_table_error)?;
            meta.insert(META_GENERATION, next_generation.to_be_bytes().as_slice())
                .map_err(map_storage_error)?;
            meta.insert(META_ROLLBACK_COUNTER, next_counter.to_be_bytes().as_slice())
                .map_err(map_storage_error)?;
            meta.insert(META_EPOCH, next_epoch_bytes.as_slice())
                .map_err(map_storage_error)?;
            meta.insert(META_EPOCH_AUTHENTICATOR, next_authenticator.as_slice())
                .map_err(map_storage_error)?;
            meta.insert(META_PENDING_ERASE, pending_erase.as_slice())
                .map_err(map_storage_error)?;
            meta.insert(
                META_CONFIRMED_WITNESS_COUNTER,
                confirmed_head.counter.to_be_bytes().as_slice(),
            )
            .map_err(map_storage_error)?;
            meta.insert(
                META_CONFIRMED_WITNESS_COMMITMENT,
                confirmed_head.commitment.as_slice(),
            )
            .map_err(map_storage_error)?;
            meta.insert(
                META_PREVIOUS_CERTIFICATE_HASH,
                confirmed_head.previous_certificate_hash.as_slice(),
            )
            .map_err(map_storage_error)?;
            meta.insert(
                META_WITNESS_REGISTRATION,
                &[confirmed_head.registration as u8] as &[u8],
            )
            .map_err(map_storage_error)?;
        }
        self.owner
            .faults
            .check(FaultPoint::AfterCiphertextInsertion)?;
        let pruned = prune_durable_records(self.write()?, next_generation)?;
        for pruned_id in pruned {
            self.provider.remove_internal(&exact_result_key(pruned_id));
        }
        self.provider
            .insert_internal(exact_result_key(operation_id), exact_bytes.clone());
        let mut data_key = self
            .provider
            .rand()
            .random_array::<32>()
            .map_err(|_| PersistenceError::Storage)?;
        let key_id = loop {
            let value = self
                .provider
                .rand()
                .random_array::<16>()
                .map_err(|_| PersistenceError::Storage)?;
            if value != [0; 16] && Some(value) != self.old_key_id {
                break value;
            }
        };
        let nonce = self
            .provider
            .rand()
            .random_array::<12>()
            .map_err(|_| PersistenceError::Storage)?;
        let aad = {
            let write = self.write()?;
            let mut meta = write.open_table(META).map_err(map_table_error)?;
            meta.insert(META_CURRENT_KEY_ID, key_id.as_slice())
                .map_err(map_storage_error)?;
            meta.insert(META_OBSOLETE_KEY_ID, pending_erase.as_slice())
                .map_err(map_storage_error)?;
            state_aad(&meta)?
        };
        self.owner
            .envelope_keys
            .prepare(self.owner.crypto_session_id, key_id, &data_key, &aad)?;
        self.prepared_key_id = Some(key_id);
        let manifest_crypto = CoreProvider::new().map_err(|_| PersistenceError::Storage)?;
        let manifest = durable_manifest(self.write()?, manifest_crypto.crypto())?;
        self.provider
            .insert_internal(DURABLE_MANIFEST_KEY.to_vec(), manifest.to_vec());

        let plaintext = encode_storage_image(&self.provider.storage_values())?;
        self.owner
            .faults
            .check(FaultPoint::BeforeTransitionSealing)?;
        let signing = endpoint_signing(&self.provider, self.owner.crypto_session_id)?;
        let mut epoch_authenticator = [0_u8; 48];
        if next_authenticator.len() == 48 {
            epoch_authenticator.copy_from_slice(&next_authenticator);
        } else if !next_authenticator.is_empty() {
            data_key.fill(0);
            return Err(PersistenceError::Corrupt);
        }
        let prepared = {
            let mut runtime = self.owner.witness_lock()?;
            runtime.state.prepare(witness::TransitionMaterial {
                lineage: signing.lineage.clone(),
                counter: next_counter,
                generation: next_generation,
                epoch: self.next_epoch,
                epoch_authenticator,
                current_key_id: key_id,
                predecessor_commitment: confirmed.commitment,
                previous_certificate_hash,
                operation_id,
                inner_state: &plaintext,
                exact_result: &exact_bytes,
                data_key: &data_key,
                credential: &signing.credential,
                signer: &signing.signer,
            })
        };
        let prepared = match prepared {
            Ok(value) => value,
            Err(error) => {
                data_key.fill(0);
                return Err(map_witness_error(error));
            }
        };
        let committed_transition = match prepared.committed_record() {
            Ok(value) => value,
            Err(error) => {
                data_key.fill(0);
                return Err(map_witness_error(error));
            }
        };
        let crypto = self.provider.crypto();
        let encrypted =
            crypto.aead_encrypt(AeadType::Aes256Gcm, &data_key, &plaintext, &nonce, &aad);
        data_key.fill(0);
        let ciphertext = encrypted.map_err(|_| PersistenceError::Storage)?;
        let sealed = SealedState {
            key_id,
            nonce,
            ciphertext,
        }
        .encode()?;
        let row = DurableWitnessOperation {
            operation_id,
            operation_kind,
            fingerprint,
            witness_request: prepared.request_bytes().to_vec(),
            request_hash: prepared.request_hash(),
            committed_transition,
            confirmed_head,
            successor_key_id: key_id,
            obsolete_key_id: self.old_key_id,
            disposition: WitnessOperationDisposition::Pending,
            exact_result_kind: exact.kind(),
        };
        if prepared.is_register() != self.old_key_id.is_none() {
            return Err(PersistenceError::Corrupt);
        }
        {
            let write = self.write()?;
            let mut state = write.open_table(STATE).map_err(map_table_error)?;
            state
                .insert(STATE_CURRENT, sealed.as_slice())
                .map_err(map_storage_error)?;
            drop(state);
            witness_v2::write_pending_operation(write, &row)?;
        }
        self.owner
            .faults
            .check(FaultPoint::AfterTransitionSealingBeforeCommit)?;
        self.owner.faults.check(FaultPoint::BeforeCommit)?;
        let write = self.write.take().ok_or(PersistenceError::Storage)?;
        self.prepared_key_id = None;
        if write.commit().is_err() {
            return self.owner.recover_uncertain(operation_id, Some(key_id));
        }
        let request = PendingWitnessRequest {
            operation_id,
            request: prepared.request_bytes().to_vec(),
            request_hash: prepared.request_hash(),
            kind: if prepared.is_register() {
                WitnessRequestKind::Register
            } else {
                WitnessRequestKind::Advance
            },
        };
        {
            let mut runtime = self.owner.witness_lock()?;
            runtime
                .state
                .local_commit_complete(prepared)
                .map_err(map_witness_error)?;
        }
        if self
            .owner
            .faults
            .check(FaultPoint::DuringCurrentKeyActivation)
            .is_err()
        {
            // Committed but activation did not run: recoverable pending state, no exposure.
            return Err(PersistenceError::InjectedFault);
        }
        self.owner
            .envelope_keys
            .activate(self.owner.crypto_session_id, key_id, &aad)
            .map_err(map_current_key_error)?;
        {
            let mut runtime = self.owner.witness_lock()?;
            runtime
                .state
                .pending_mut()
                .map_err(map_witness_error)?
                .current_key_activated();
        }
        if self
            .owner
            .faults
            .check(FaultPoint::AfterDurableCommit)
            .is_err()
        {
            return self.owner.recover_uncertain(operation_id, None);
        }
        self.owner
            .faults
            .check(FaultPoint::AfterCommitBeforeNetworkSend)?;
        Ok(request)
    }
}

impl Drop for NativeGroupTransaction<'_> {
    fn drop(&mut self) {
        if let Some(key_id) = self.prepared_key_id.take() {
            let _ = self
                .owner
                .envelope_keys
                .erase(self.owner.crypto_session_id, key_id);
        }
    }
}

impl GroupTransaction for NativeGroupTransaction<'_> {
    type Error = PersistenceError;

    fn stage_envelope(&mut self, envelope: &PreparedEnvelope) -> Result<(), Self::Error> {
        self.stage_operation(CommittedOperation::Envelope(OutboxRecord::new(
            OutboxRecordFields {
                operation_id: self.operation_id.ok_or(PersistenceError::Conflict)?,
                crypto_session_id: envelope.crypto_session_id,
                logical_message_id: envelope.logical_message_id,
                class: envelope.class,
                epoch: envelope.epoch,
                hosted_generation: envelope.hosted_generation,
                profile_revision: PROFILE_REVISION,
                retry_state: RetryState::Pending,
                ciphertext: envelope.ciphertext.to_vec(),
                commit: envelope.commit.clone(),
            },
        )))
    }

    fn rollback(mut self) -> Result<(), Self::Error> {
        if let Some(write) = self.write.take() {
            write.abort().map_err(|_| PersistenceError::Storage)?;
        }
        Ok(())
    }
}

/// Flip the index of the previously pending operation to `Completed` inside the successor's
/// sealed manifest. Only one such index may exist, and it must not be the current operation.
fn mark_previous_pending_index_completed(
    write: &WriteTransaction,
    current_operation_id: Id,
) -> Result<(), PersistenceError> {
    let mut pending_entries = Vec::new();
    {
        let table = write.open_table(OPERATIONS).map_err(map_table_error)?;
        for entry in table.iter().map_err(map_storage_error)? {
            let (key, value) = entry.map_err(map_storage_error)?;
            let (index, operation) = decode_operation_index(value.value())?;
            if index.disposition == WitnessOperationDisposition::Pending {
                pending_entries.push((key.value().to_vec(), index, operation));
            }
        }
    }
    if pending_entries.len() > 1
        || pending_entries
            .iter()
            .any(|(key, _, _)| key.as_slice() == current_operation_id)
    {
        return Err(PersistenceError::Corrupt);
    }
    for (key, mut index, operation) in pending_entries {
        index.disposition = WitnessOperationDisposition::Completed;
        let bytes = encode_operation_index(&index, &operation)?;
        write
            .open_table(OPERATIONS)
            .map_err(map_table_error)?
            .insert(key.as_slice(), bytes.as_slice())
            .map_err(map_storage_error)?;
    }
    Ok(())
}

/// Durable daemon endpoint. Every method reloads committed MLS state after opening its redb
/// transaction; no `MlsGroup` survives a failed or completed operation. Every state change returns
/// a pending witness request; the typed result is released by `continue_witness`.
#[derive(Clone)]
pub(crate) struct DurableDaemon {
    store: Arc<NativeTransactionalProvider>,
}

/// Durable phone endpoint with the same transaction and reload guarantees as [`DurableDaemon`].
#[derive(Clone)]
pub(crate) struct DurablePhone {
    store: Arc<NativeTransactionalProvider>,
}

/// Plaintext released only after receive-state commit and the witness barrier complete.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurablePlaintext {
    pub operation_id: Id,
    pub logical_message_id: Id,
    pub epoch: u64,
    plaintext: Vec<u8>,
}

impl DurablePlaintext {
    pub fn plaintext(&self) -> &[u8] {
        &self.plaintext
    }
}

/// Endpoint-owned witness operations shared by every durable facade.
pub trait WitnessEndpoint {
    /// Build a fresh signed `read` request for pre-mutation reconciliation.
    fn witness_read_request(&self) -> Result<Vec<u8>, PersistenceError>;
    /// Verify the unanimous `read` certificate and reconcile; `Ready` grants one mutation.
    fn reconcile_witness(
        &self,
        certificate: &[u8],
    ) -> Result<EndpointReconciliation, PersistenceError>;
    /// Recover the one durable pending request, if any.
    fn pending_witness(&self) -> Result<Option<PendingWitnessRequest>, PersistenceError>;
    /// Verify the certificate, finish key lifecycle, and release the exact typed result.
    fn continue_witness(
        &self,
        operation_id: Id,
        certificate: &[u8],
    ) -> Result<TypedResult, PersistenceError>;
}

macro_rules! impl_witness_endpoint {
    ($type:ty) => {
        impl WitnessEndpoint for $type {
            fn witness_read_request(&self) -> Result<Vec<u8>, PersistenceError> {
                self.store.witness_read_request()
            }

            fn reconcile_witness(
                &self,
                certificate: &[u8],
            ) -> Result<EndpointReconciliation, PersistenceError> {
                self.store.reconcile_witness(certificate)
            }

            fn pending_witness(&self) -> Result<Option<PendingWitnessRequest>, PersistenceError> {
                self.store.pending_witness()
            }

            fn continue_witness(
                &self,
                operation_id: Id,
                certificate: &[u8],
            ) -> Result<TypedResult, PersistenceError> {
                self.store.continue_witness(operation_id, certificate)
            }
        }
    };
}
pub(crate) use impl_witness_endpoint;

impl_witness_endpoint!(DurableDaemon);
impl_witness_endpoint!(DurablePhone);

/// Resolve a runner lookup into either an early return or a fresh transaction.
macro_rules! fresh_or_return {
    ($lookup:expr) => {
        match $lookup {
            Lookup::Pending(request) => return Ok(WitnessOutcome::Pending(request)),
            Lookup::Released(result) => {
                return result
                    .try_into()
                    .map(WitnessOutcome::Released)
                    .map_err(|_| PersistenceError::Corrupt);
            }
            Lookup::Fresh(transaction) => *transaction,
        }
    };
}
pub(crate) use fresh_or_return;

fn optional_field(value: Option<&[u8]>) -> Vec<u8> {
    match value {
        Some(bytes) => {
            let mut out = vec![1];
            out.extend_from_slice(bytes);
            out
        }
        None => vec![0],
    }
}

/// A facade precondition on committed endpoint state. The runner evaluates it on the fresh
/// transaction only after `begin_witnessed` has resolved terminal state, the pending barrier,
/// exact duplicates, and same-ID conflicts, so a precondition can never preempt quarantine or
/// duplicate replay.
pub(crate) type Precondition<'a> = &'a dyn Fn(&CoreProvider) -> Result<(), PersistenceError>;

pub(crate) const NO_PRECONDITION: Precondition<'static> = &|_| Ok(());

#[allow(dead_code)]
impl DurableDaemon {
    pub fn create(
        root: &Path,
        identity: Identity,
        context: PairContext,
        operation_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
    ) -> Result<(Self, PendingWitnessRequest), PersistenceError> {
        Self::create_with_runtime(
            root,
            identity,
            context,
            operation_id,
            envelope_keys,
            trust,
            RuntimeHooks {
                faults: Arc::new(NoFaults),
                clock: Arc::new(SystemClock),
            },
        )
    }

    pub(crate) fn create_with_runtime(
        root: &Path,
        identity: Identity,
        context: PairContext,
        operation_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
        runtime: RuntimeHooks,
    ) -> Result<(Self, PendingWitnessRequest), PersistenceError> {
        let store = NativeTransactionalProvider::create(
            root,
            context.crypto_session_id,
            envelope_keys,
            trust,
            runtime.faults,
            runtime.clock,
        )?;
        let fingerprint = witness_v2::operation_fingerprint(
            op_kind::LEGACY_CREATE,
            &[
                &[identity.role as u8],
                &encode_identity_bytes(&identity),
                &encode_context_bytes(&context),
            ],
        )?;
        let mut transaction =
            match store.begin_witnessed(operation_id, op_kind::LEGACY_CREATE, fingerprint)? {
                Lookup::Fresh(transaction) => *transaction,
                Lookup::Pending(_) | Lookup::Released(_) => return Err(PersistenceError::Conflict),
            };
        store.faults.check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let mut daemon = Daemon::create(identity, context)?;
        daemon.endpoint.clock = Arc::clone(&store.clock);
        daemon.endpoint.last_wall_time_ms = store.clock.now_ms().map_err(PersistenceError::Core)?;
        store
            .faults
            .check(FaultPoint::DuringOpenMlsProviderWrites)?;
        persist_endpoint_metadata(&daemon.endpoint, &daemon.endpoint.provider);
        transaction.replace_provider_values(daemon.endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(
            daemon.endpoint.epoch()?,
            &daemon.endpoint.epoch_authenticator()?,
        );
        transaction
            .stage_accepted_record(initialized_record(operation_id, store.crypto_session_id))?;
        let request = transaction.commit_witnessed(TypedResult::Empty)?;
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
        // Loading inside a read-write transaction validates all committed OpenMLS and signer state.
        let transaction = begin_current(&store)?;
        let _ = load_daemon(
            &transaction.provider,
            Arc::clone(&store.clock),
            transaction.accepted_ids.clone(),
        )?;
        transaction.rollback()?;
        store.finish_opening()?;
        Ok(Self { store })
    }

    #[cfg(test)]
    pub(crate) fn store(&self) -> &Arc<NativeTransactionalProvider> {
        &self.store
    }

    /// Legacy test-only Welcome creation. Its canonical input is the exact KeyPackage. The
    /// released result is the exact Welcome bytes; the caller supplies the pair context.
    pub fn consume_key_package(
        &mut self,
        operation_id: Id,
        package: PhoneKeyPackage,
    ) -> Result<WitnessOutcome<Vec<u8>>, PersistenceError> {
        let fingerprint =
            witness_v2::operation_fingerprint(op_kind::WELCOME_CREATE, &[package.bytes()])?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::WELCOME_CREATE,
            fingerprint
        )?);
        self.store
            .faults
            .check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let mut daemon = load_daemon(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        let welcome = daemon.consume_key_package(package)?;
        self.store
            .faults
            .check(FaultPoint::DuringOpenMlsProviderWrites)?;
        persist_endpoint_metadata(&daemon.endpoint, &daemon.endpoint.provider);
        transaction.replace_provider_values(daemon.endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(
            daemon.endpoint.epoch()?,
            &daemon.endpoint.epoch_authenticator()?,
        );
        let record = OutboxRecord::new(OutboxRecordFields {
            operation_id,
            crypto_session_id: self.store.crypto_session_id,
            logical_message_id: operation_id,
            class: MessageClass::PairActivation,
            epoch: daemon.endpoint.epoch()?,
            hosted_generation: 0,
            profile_revision: PROFILE_REVISION,
            retry_state: RetryState::Pending,
            ciphertext: welcome.bytes.to_vec(),
            commit: None,
        });
        transaction.stage_operation(CommittedOperation::Envelope(record))?;
        let request =
            transaction.commit_witnessed(TypedResult::LegacyWelcome(welcome.bytes.to_vec()))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn prepare_application(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        plaintext: &[u8],
    ) -> Result<WitnessOutcome<OutboxRecord>, PersistenceError> {
        self.prepare_application_guarded(
            operation_id,
            logical_message_id,
            hosted_generation,
            plaintext,
            NO_PRECONDITION,
        )
    }

    pub(crate) fn prepare_application_guarded(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        plaintext: &[u8],
        precondition: Precondition<'_>,
    ) -> Result<WitnessOutcome<OutboxRecord>, PersistenceError> {
        self.send_operation(
            operation_id,
            op_kind::APPLICATION_SEND,
            witness_v2::operation_fingerprint(
                op_kind::APPLICATION_SEND,
                &[
                    &logical_message_id,
                    &hosted_generation.to_be_bytes(),
                    plaintext,
                ],
            )?,
            precondition,
            |daemon| daemon.prepare_application(logical_message_id, hosted_generation, plaintext),
        )
    }

    pub fn receive_application(
        &mut self,
        operation_id: Id,
        ciphertext: &[u8],
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<DurablePlaintext>, PersistenceError> {
        self.receive_application_guarded(
            operation_id,
            ciphertext,
            logical_message_id,
            hosted_generation,
            NO_PRECONDITION,
        )
    }

    pub(crate) fn receive_application_guarded(
        &mut self,
        operation_id: Id,
        ciphertext: &[u8],
        logical_message_id: Id,
        hosted_generation: u64,
        precondition: Precondition<'_>,
    ) -> Result<WitnessOutcome<DurablePlaintext>, PersistenceError> {
        self.receive_operation(
            operation_id,
            witness_v2::operation_fingerprint(
                op_kind::APPLICATION_RECEIVE,
                &[
                    &logical_message_id,
                    &hosted_generation.to_be_bytes(),
                    ciphertext,
                ],
            )?,
            MessageClass::ApplicationRequest,
            precondition,
            |daemon| daemon.receive_application(ciphertext, logical_message_id, hosted_generation),
        )
    }

    pub fn pending_outbox(&self) -> Result<Vec<OutboxRecord>, PersistenceError> {
        self.store.pending_outbox()
    }

    pub fn receive_update_proposal(
        &mut self,
        operation_id: Id,
        ciphertext: &[u8],
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<AcceptedMessageRecord>, PersistenceError> {
        let fingerprint = witness_v2::operation_fingerprint(
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
        self.store
            .faults
            .check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let mut daemon = load_daemon(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        daemon.receive_update_proposal(ciphertext, logical_message_id, hosted_generation)?;
        self.store
            .faults
            .check(FaultPoint::DuringOpenMlsProviderWrites)?;
        persist_endpoint_metadata(&daemon.endpoint, &daemon.endpoint.provider);
        transaction.replace_provider_values(daemon.endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(
            daemon.endpoint.epoch()?,
            &daemon.endpoint.epoch_authenticator()?,
        );
        let record = AcceptedMessageRecord {
            operation_id,
            crypto_session_id: self.store.crypto_session_id,
            logical_message_id,
            class: MessageClass::UpdateProposal,
            epoch: daemon.endpoint.epoch()?,
            profile_revision: PROFILE_REVISION,
            acknowledged: false,
        };
        transaction.stage_accepted_record(record.clone())?;
        let request = transaction.commit_witnessed(TypedResult::Accepted(record))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn acknowledge_receive(
        &mut self,
        acknowledgement_operation_id: Id,
        receive_operation_id: Id,
    ) -> Result<WitnessOutcome<AcceptedMessageRecord>, PersistenceError> {
        acknowledge_receive(
            &self.store,
            acknowledgement_operation_id,
            receive_operation_id,
        )
    }

    pub fn acknowledge_outbox(
        &mut self,
        acknowledgement_operation_id: Id,
        outbox_operation_id: Id,
    ) -> Result<WitnessOutcome<OutboxRecord>, PersistenceError> {
        acknowledge_outbox(
            &self.store,
            acknowledgement_operation_id,
            outbox_operation_id,
        )
    }

    pub(crate) fn prepare_resync_control_guarded(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        plaintext: &[u8],
        precondition: Precondition<'_>,
    ) -> Result<WitnessOutcome<OutboxRecord>, PersistenceError> {
        self.send_operation(
            operation_id,
            op_kind::EPOCH_READY_CONFIRM_SEND,
            witness_v2::operation_fingerprint(
                op_kind::EPOCH_READY_CONFIRM_SEND,
                &[
                    &logical_message_id,
                    &hosted_generation.to_be_bytes(),
                    plaintext,
                ],
            )?,
            precondition,
            |daemon| {
                daemon.prepare_resync_control(logical_message_id, hosted_generation, plaintext)
            },
        )
    }

    pub fn prepare_commit(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<OutboxRecord>, PersistenceError> {
        self.send_operation(
            operation_id,
            op_kind::DAEMON_COMMIT,
            witness_v2::operation_fingerprint(
                op_kind::DAEMON_COMMIT,
                &[&logical_message_id, &hosted_generation.to_be_bytes()],
            )?,
            NO_PRECONDITION,
            |daemon| daemon.prepare_commit(logical_message_id, hosted_generation),
        )
    }

    fn send_operation(
        &mut self,
        operation_id: Id,
        operation_kind: u16,
        fingerprint: [u8; 48],
        precondition: Precondition<'_>,
        operation: impl FnOnce(&mut Daemon) -> Result<PreparedEnvelope, CoreError>,
    ) -> Result<WitnessOutcome<OutboxRecord>, PersistenceError> {
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            operation_kind,
            fingerprint
        )?);
        precondition(&transaction.provider)?;
        self.store
            .faults
            .check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let mut daemon = load_daemon(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        let envelope = operation(&mut daemon)?;
        self.store
            .faults
            .check(FaultPoint::DuringOpenMlsProviderWrites)?;
        persist_endpoint_metadata(&daemon.endpoint, &daemon.endpoint.provider);
        transaction.replace_provider_values(daemon.endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(
            daemon.endpoint.epoch()?,
            &daemon.endpoint.epoch_authenticator()?,
        );
        transaction.stage_envelope(&envelope)?;
        let request = transaction.commit_witnessed(TypedResult::Envelope(envelope_record(
            operation_id,
            &envelope,
        )))?;
        Ok(WitnessOutcome::Pending(request))
    }

    fn receive_operation(
        &mut self,
        operation_id: Id,
        fingerprint: [u8; 48],
        class: MessageClass,
        precondition: Precondition<'_>,
        operation: impl FnOnce(&mut Daemon) -> Result<crate::PreparedPlaintext, CoreError>,
    ) -> Result<WitnessOutcome<DurablePlaintext>, PersistenceError> {
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::APPLICATION_RECEIVE,
            fingerprint
        )?);
        precondition(&transaction.provider)?;
        self.store
            .faults
            .check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let mut daemon = load_daemon(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        let prepared = operation(&mut daemon)?;
        self.store
            .faults
            .check(FaultPoint::DuringOpenMlsProviderWrites)?;
        persist_endpoint_metadata(&daemon.endpoint, &daemon.endpoint.provider);
        transaction.replace_provider_values(daemon.endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(
            daemon.endpoint.epoch()?,
            &daemon.endpoint.epoch_authenticator()?,
        );
        let record = AcceptedMessageRecord {
            operation_id,
            crypto_session_id: self.store.crypto_session_id,
            logical_message_id: prepared.logical_message_id,
            class,
            epoch: prepared.epoch,
            profile_revision: PROFILE_REVISION,
            acknowledged: false,
        };
        transaction.stage_accepted_record(record)?;
        let request = transaction.commit_witnessed(TypedResult::Plaintext(DurablePlaintext {
            operation_id,
            logical_message_id: prepared.logical_message_id,
            epoch: prepared.epoch,
            plaintext: prepared.plaintext.to_vec(),
        }))?;
        self.store
            .faults
            .check(FaultPoint::BeforeReceiverAcknowledgement)?;
        self.store
            .faults
            .check(FaultPoint::AfterAcknowledgementLoss)?;
        Ok(WitnessOutcome::Pending(request))
    }
}

fn envelope_record(operation_id: Id, envelope: &PreparedEnvelope) -> OutboxRecord {
    OutboxRecord::new(OutboxRecordFields {
        operation_id,
        crypto_session_id: envelope.crypto_session_id,
        logical_message_id: envelope.logical_message_id,
        class: envelope.class,
        epoch: envelope.epoch,
        hosted_generation: envelope.hosted_generation,
        profile_revision: PROFILE_REVISION,
        retry_state: RetryState::Pending,
        ciphertext: envelope.ciphertext.to_vec(),
        commit: envelope.commit.clone(),
    })
}

fn encode_identity_bytes(identity: &Identity) -> Vec<u8> {
    let mut out = Vec::with_capacity(49);
    encode_identity(&mut out, identity);
    out
}

fn encode_context_bytes(context: &PairContext) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 * 4 + 32);
    out.extend_from_slice(&context.crypto_session_id);
    out.extend_from_slice(&context.group_id);
    out.extend_from_slice(&context.account_id);
    out.extend_from_slice(&context.installation_id);
    out.extend_from_slice(&context.device_id);
    out
}

#[allow(dead_code)]
impl DurablePhone {
    pub fn create(
        root: &Path,
        identity: Identity,
        crypto_session_id: Id,
        operation_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
    ) -> Result<(Self, PendingWitnessRequest), PersistenceError> {
        Self::create_with_runtime(
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

    pub(crate) fn create_with_runtime(
        root: &Path,
        identity: Identity,
        crypto_session_id: Id,
        operation_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        trust: Arc<ReplicaTrustSet>,
        runtime: RuntimeHooks,
    ) -> Result<(Self, PendingWitnessRequest), PersistenceError> {
        let store = NativeTransactionalProvider::create(
            root,
            crypto_session_id,
            envelope_keys,
            trust,
            runtime.faults,
            runtime.clock,
        )?;
        let fingerprint = witness_v2::operation_fingerprint(
            op_kind::LEGACY_CREATE,
            &[
                &[identity.role as u8],
                &encode_identity_bytes(&identity),
                &crypto_session_id,
            ],
        )?;
        let mut transaction =
            match store.begin_witnessed(operation_id, op_kind::LEGACY_CREATE, fingerprint)? {
                Lookup::Fresh(transaction) => *transaction,
                Lookup::Pending(_) | Lookup::Released(_) => return Err(PersistenceError::Conflict),
            };
        store.faults.check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let (phone, package) = Phone::create_with_clock(identity.clone(), store.clock.as_ref())?;
        let provider = &phone.provider;
        persist_phone_metadata(
            &phone,
            provider,
            None,
            store.clock.now_ms().map_err(PersistenceError::Core)?,
        );
        transaction.replace_provider_values(provider.storage_values())?;
        let envelope = PreparedEnvelope {
            crypto_session_id,
            logical_message_id: operation_id,
            class: MessageClass::PairActivation,
            epoch: 0,
            hosted_generation: 0,
            commit: None,
            ciphertext: package.bytes.to_vec().into_boxed_slice(),
        };
        transaction.stage_envelope(&envelope)?;
        let request =
            transaction.commit_witnessed(TypedResult::KeyPackage(package.bytes.to_vec()))?;
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
        let _ = load_phone(
            &transaction.provider,
            Arc::clone(&store.clock),
            transaction.accepted_ids.clone(),
        )?;
        transaction.rollback()?;
        store.finish_opening()?;
        Ok(Self { store })
    }

    #[cfg(test)]
    pub(crate) fn store(&self) -> &Arc<NativeTransactionalProvider> {
        &self.store
    }

    /// Legacy test-only join. Fingerprint kind 8 with the group ID present and no claim or expiry.
    pub fn join(
        &mut self,
        operation_id: Id,
        welcome: PairWelcome,
        expected: &PairContext,
    ) -> Result<WitnessOutcome<()>, PersistenceError> {
        let fingerprint = witness_v2::operation_fingerprint(
            op_kind::WELCOME_JOIN,
            &[
                welcome.bytes(),
                &optional_field(Some(&expected.group_id)),
                &optional_field(None),
                &optional_field(None),
            ],
        )?;
        let mut transaction =
            match self
                .store
                .begin_witnessed(operation_id, op_kind::WELCOME_JOIN, fingerprint)?
            {
                Lookup::Pending(request) => return Ok(WitnessOutcome::Pending(request)),
                Lookup::Released(TypedResult::Empty) => return Ok(WitnessOutcome::Released(())),
                Lookup::Released(_) => return Err(PersistenceError::Corrupt),
                Lookup::Fresh(transaction) => transaction,
            };
        self.store
            .faults
            .check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let mut phone = load_phone(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        phone.join(welcome, expected)?;
        {
            let endpoint = phone.endpoint.as_mut().ok_or(PersistenceError::Corrupt)?;
            endpoint.clock = Arc::clone(&self.store.clock);
            endpoint.last_wall_time_ms =
                self.store.clock.now_ms().map_err(PersistenceError::Core)?;
        }
        let endpoint = phone.endpoint.as_ref().ok_or(PersistenceError::Corrupt)?;
        persist_phone_metadata(&phone, &endpoint.provider, Some(expected), 0);
        transaction.replace_provider_values(endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(endpoint.epoch()?, &endpoint.epoch_authenticator()?);
        transaction.stage_accepted_record(initialized_record(
            operation_id,
            self.store.crypto_session_id,
        ))?;
        let request = transaction.commit_witnessed(TypedResult::Empty)?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn prepare_application(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        plaintext: &[u8],
    ) -> Result<WitnessOutcome<OutboxRecord>, PersistenceError> {
        self.prepare_application_guarded(
            operation_id,
            logical_message_id,
            hosted_generation,
            plaintext,
            NO_PRECONDITION,
        )
    }

    pub(crate) fn prepare_application_guarded(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        plaintext: &[u8],
        precondition: Precondition<'_>,
    ) -> Result<WitnessOutcome<OutboxRecord>, PersistenceError> {
        self.send_operation(
            operation_id,
            op_kind::APPLICATION_SEND,
            witness_v2::operation_fingerprint(
                op_kind::APPLICATION_SEND,
                &[
                    &logical_message_id,
                    &hosted_generation.to_be_bytes(),
                    plaintext,
                ],
            )?,
            precondition,
            |phone| phone.prepare_application(logical_message_id, hosted_generation, plaintext),
        )
    }

    pub fn acknowledge_receive(
        &mut self,
        acknowledgement_operation_id: Id,
        receive_operation_id: Id,
    ) -> Result<WitnessOutcome<AcceptedMessageRecord>, PersistenceError> {
        acknowledge_receive(
            &self.store,
            acknowledgement_operation_id,
            receive_operation_id,
        )
    }

    pub fn acknowledge_outbox(
        &mut self,
        acknowledgement_operation_id: Id,
        outbox_operation_id: Id,
    ) -> Result<WitnessOutcome<OutboxRecord>, PersistenceError> {
        acknowledge_outbox(
            &self.store,
            acknowledgement_operation_id,
            outbox_operation_id,
        )
    }

    pub fn pending_outbox(&self) -> Result<Vec<OutboxRecord>, PersistenceError> {
        self.store.pending_outbox()
    }

    pub fn prepare_self_update(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<OutboxRecord>, PersistenceError> {
        self.send_operation(
            operation_id,
            op_kind::PROPOSAL_SEND,
            witness_v2::operation_fingerprint(
                op_kind::PROPOSAL_SEND,
                &[&logical_message_id, &hosted_generation.to_be_bytes()],
            )?,
            NO_PRECONDITION,
            |phone| phone.prepare_self_update(logical_message_id, hosted_generation),
        )
    }

    /// Legacy commit application without an epoch-ready send: exactly one commit transition.
    pub fn apply_commit(
        &mut self,
        operation_id: Id,
        ciphertext: &[u8],
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<AcceptedMessageRecord>, PersistenceError> {
        let fingerprint = witness_v2::operation_fingerprint(
            op_kind::COMMIT_APPLY,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                ciphertext,
                &optional_field(None),
            ],
        )?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::COMMIT_APPLY,
            fingerprint
        )?);
        self.store
            .faults
            .check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let mut phone = load_phone(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        phone.apply_commit(ciphertext, logical_message_id, hosted_generation)?;
        let endpoint = phone.endpoint.as_ref().ok_or(PersistenceError::Corrupt)?;
        self.store
            .faults
            .check(FaultPoint::DuringOpenMlsProviderWrites)?;
        persist_phone_metadata(&phone, &endpoint.provider, Some(&endpoint.context), 0);
        transaction.replace_provider_values(endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(endpoint.epoch()?, &endpoint.epoch_authenticator()?);
        let record = AcceptedMessageRecord {
            operation_id,
            crypto_session_id: self.store.crypto_session_id,
            logical_message_id,
            class: MessageClass::Commit,
            epoch: endpoint.epoch()?,
            profile_revision: PROFILE_REVISION,
            acknowledged: false,
        };
        transaction.stage_accepted_record(record.clone())?;
        let request = transaction.commit_witnessed(TypedResult::Accepted(record))?;
        Ok(WitnessOutcome::Pending(request))
    }

    pub fn receive_application(
        &mut self,
        operation_id: Id,
        ciphertext: &[u8],
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<WitnessOutcome<DurablePlaintext>, PersistenceError> {
        self.receive_application_guarded(
            operation_id,
            ciphertext,
            logical_message_id,
            hosted_generation,
            NO_PRECONDITION,
        )
    }

    pub(crate) fn receive_application_guarded(
        &mut self,
        operation_id: Id,
        ciphertext: &[u8],
        logical_message_id: Id,
        hosted_generation: u64,
        precondition: Precondition<'_>,
    ) -> Result<WitnessOutcome<DurablePlaintext>, PersistenceError> {
        let fingerprint = witness_v2::operation_fingerprint(
            op_kind::APPLICATION_RECEIVE,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                ciphertext,
            ],
        )?;
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            op_kind::APPLICATION_RECEIVE,
            fingerprint
        )?);
        precondition(&transaction.provider)?;
        self.store
            .faults
            .check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let mut phone = load_phone(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        let prepared =
            phone.receive_application(ciphertext, logical_message_id, hosted_generation)?;
        let endpoint = phone.endpoint.as_ref().ok_or(PersistenceError::Corrupt)?;
        persist_phone_metadata(&phone, &endpoint.provider, Some(&endpoint.context), 0);
        transaction.replace_provider_values(endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(endpoint.epoch()?, &endpoint.epoch_authenticator()?);
        let record = AcceptedMessageRecord {
            operation_id,
            crypto_session_id: self.store.crypto_session_id,
            logical_message_id,
            class: MessageClass::ApplicationDelivery,
            epoch: prepared.epoch,
            profile_revision: PROFILE_REVISION,
            acknowledged: false,
        };
        transaction.stage_accepted_record(record)?;
        let request = transaction.commit_witnessed(TypedResult::Plaintext(DurablePlaintext {
            operation_id,
            logical_message_id: prepared.logical_message_id,
            epoch: prepared.epoch,
            plaintext: prepared.plaintext.to_vec(),
        }))?;
        self.store
            .faults
            .check(FaultPoint::BeforeReceiverAcknowledgement)?;
        self.store
            .faults
            .check(FaultPoint::AfterAcknowledgementLoss)?;
        Ok(WitnessOutcome::Pending(request))
    }

    fn send_operation(
        &mut self,
        operation_id: Id,
        operation_kind: u16,
        fingerprint: [u8; 48],
        precondition: Precondition<'_>,
        operation: impl FnOnce(&mut Phone) -> Result<PreparedEnvelope, CoreError>,
    ) -> Result<WitnessOutcome<OutboxRecord>, PersistenceError> {
        let mut transaction = fresh_or_return!(self.store.begin_witnessed(
            operation_id,
            operation_kind,
            fingerprint
        )?);
        precondition(&transaction.provider)?;
        self.store
            .faults
            .check(FaultPoint::BeforeOpenMlsStateWrites)?;
        let mut phone = load_phone(
            &transaction.provider,
            Arc::clone(&self.store.clock),
            transaction.accepted_ids.clone(),
        )?;
        let envelope = operation(&mut phone)?;
        let endpoint = phone.endpoint.as_ref().ok_or(PersistenceError::Corrupt)?;
        self.store
            .faults
            .check(FaultPoint::DuringOpenMlsProviderWrites)?;
        persist_phone_metadata(&phone, &endpoint.provider, Some(&endpoint.context), 0);
        transaction.replace_provider_values(endpoint.provider.storage_values())?;
        transaction.set_successor_epoch(endpoint.epoch()?, &endpoint.epoch_authenticator()?);
        transaction.stage_envelope(&envelope)?;
        let request = transaction.commit_witnessed(TypedResult::Envelope(envelope_record(
            operation_id,
            &envelope,
        )))?;
        Ok(WitnessOutcome::Pending(request))
    }
}

/// Read-only transaction over committed state. Callers roll it back; it never commits.
fn begin_current(
    store: &Arc<NativeTransactionalProvider>,
) -> Result<NativeGroupTransaction<'_>, PersistenceError> {
    let operation_guard = store
        .operation_lock
        .lock()
        .map_err(|_| PersistenceError::Storage)?;
    store.begin_transaction_locked(operation_guard, store.crypto_session_id, None)
}

fn acknowledge_outbox(
    store: &Arc<NativeTransactionalProvider>,
    acknowledgement_operation_id: Id,
    outbox_operation_id: Id,
) -> Result<WitnessOutcome<OutboxRecord>, PersistenceError> {
    let fingerprint =
        witness_v2::operation_fingerprint(op_kind::OUTBOX_ACK, &[&outbox_operation_id])?;
    let mut transaction = fresh_or_return!(store.begin_witnessed(
        acknowledgement_operation_id,
        op_kind::OUTBOX_ACK,
        fingerprint
    )?);
    let mut record = read_outbox_in_transaction(&transaction, outbox_operation_id)?
        .ok_or(PersistenceError::NotFound)?;
    if record.retry_state == RetryState::Acknowledged {
        transaction.rollback()?;
        return Err(PersistenceError::Conflict);
    }
    record.retry_state = RetryState::Acknowledged;
    transaction.update_operation(
        outbox_operation_id,
        CommittedOperation::Envelope(record.clone()),
    )?;
    transaction.keep_epoch();
    transaction.update_outbox(outbox_operation_id, record.clone());
    let mut result = record.clone();
    result.operation_id = acknowledgement_operation_id;
    transaction.stage_operation(CommittedOperation::OutboxAcknowledged(result))?;
    let request = transaction.commit_witnessed(TypedResult::OutboxAcknowledged(record))?;
    Ok(WitnessOutcome::Pending(request))
}

fn acknowledge_receive(
    store: &Arc<NativeTransactionalProvider>,
    acknowledgement_operation_id: Id,
    receive_operation_id: Id,
) -> Result<WitnessOutcome<AcceptedMessageRecord>, PersistenceError> {
    store
        .faults
        .check(FaultPoint::BeforeReceiverAcknowledgement)?;
    let fingerprint =
        witness_v2::operation_fingerprint(op_kind::RECEIVE_ACK, &[&receive_operation_id])?;
    let mut transaction = fresh_or_return!(store.begin_witnessed(
        acknowledgement_operation_id,
        op_kind::RECEIVE_ACK,
        fingerprint
    )?);
    let mut accepted = read_accepted_in_transaction(&transaction, receive_operation_id)?
        .ok_or(PersistenceError::NotFound)?;
    if accepted.acknowledged {
        transaction.rollback()?;
        return Err(PersistenceError::Conflict);
    }
    accepted.acknowledged = true;
    transaction.update_operation(
        receive_operation_id,
        CommittedOperation::Accepted(accepted.clone()),
    )?;
    // Sealed receive plaintext is deleted from the next encrypted image after acknowledgement.
    transaction
        .provider
        .remove_internal(&exact_result_key(receive_operation_id));
    transaction.keep_epoch();
    transaction.update_accepted(receive_operation_id, accepted.clone());
    let acknowledgement = AcceptedMessageRecord {
        operation_id: acknowledgement_operation_id,
        ..accepted.clone()
    };
    transaction.stage_operation(CommittedOperation::ReceiveAcknowledged(acknowledgement))?;
    let request = transaction.commit_witnessed(TypedResult::ReceiveAcknowledged(accepted))?;
    store.faults.check(FaultPoint::AfterAcknowledgementLoss)?;
    Ok(WitnessOutcome::Pending(request))
}

fn initialized_record(operation_id: Id, session: Id) -> AcceptedMessageRecord {
    AcceptedMessageRecord {
        operation_id,
        crypto_session_id: session,
        logical_message_id: operation_id,
        class: MessageClass::PairActivation,
        epoch: 0,
        profile_revision: PROFILE_REVISION,
        acknowledged: true,
    }
}

fn persist_endpoint_metadata(endpoint: &Endpoint, provider: &CoreProvider) {
    provider.insert_internal(
        ENDPOINT_METADATA_KEY.to_vec(),
        encode_endpoint_metadata(
            endpoint.identity.clone(),
            endpoint.peer.clone(),
            Some(endpoint.context.clone()),
            endpoint.signer.public(),
            &endpoint.previous_epoch_deadlines,
            endpoint.last_wall_time_ms,
        ),
    );
}

fn persist_phone_metadata(
    phone: &Phone,
    provider: &CoreProvider,
    context: Option<&PairContext>,
    fallback_wall_time_ms: u64,
) {
    let endpoint = phone.endpoint.as_ref();
    let peer = endpoint.map(|value| value.peer.clone()).unwrap_or_else(|| {
        Identity::daemon(phone.identity.account_id, phone.identity.installation_id)
    });
    let signer_public =
        endpoint.map_or_else(|| phone.signer.public(), |value| value.signer.public());
    let deadlines = endpoint.map_or_else(BTreeMap::new, |value| {
        value.previous_epoch_deadlines.clone()
    });
    let last_wall_time_ms = endpoint.map_or(fallback_wall_time_ms, |value| value.last_wall_time_ms);
    provider.insert_internal(
        ENDPOINT_METADATA_KEY.to_vec(),
        encode_endpoint_metadata(
            phone.identity.clone(),
            peer,
            context.cloned(),
            signer_public,
            &deadlines,
            last_wall_time_ms,
        ),
    );
}

fn load_daemon(
    provider: &CoreProvider,
    clock: Arc<dyn Clock>,
    accepted: BTreeSet<Id>,
) -> Result<Daemon, PersistenceError> {
    let metadata = decode_endpoint_metadata(
        &provider
            .internal(ENDPOINT_METADATA_KEY)
            .ok_or(PersistenceError::Corrupt)?,
    )?;
    if metadata.identity.role != Role::Daemon {
        return Err(PersistenceError::IdentityMismatch);
    }
    let context = metadata.context.ok_or(PersistenceError::Corrupt)?;
    let now_ms = clock.now_ms().map_err(PersistenceError::Core)?;
    if now_ms < metadata.last_wall_time_ms {
        return Err(PersistenceError::Core(CoreError::ClockRollback));
    }
    let group = MlsGroup::load(provider.storage(), &GroupId::from_slice(&context.group_id))
        .map_err(|_| PersistenceError::Corrupt)?
        .ok_or(PersistenceError::Corrupt)?;
    let signer = SignatureKeyPair::read(
        provider.storage(),
        &metadata.signer_public,
        SUITE.signature_algorithm(),
    )
    .ok_or(PersistenceError::Corrupt)?;
    let key_package_consumed = group.members().count() == 2;
    Ok(Daemon {
        endpoint: Endpoint {
            provider: CoreProvider::from_storage_values(provider.storage_values())
                .map_err(|_| PersistenceError::Storage)?,
            signer,
            group: Some(group),
            identity: metadata.identity,
            peer: metadata.peer,
            context,
            accepted,
            previous_epoch_deadlines: metadata.previous_epoch_deadlines,
            last_wall_time_ms: now_ms,
            clock,
            transaction_pending: false,
        },
        key_package_consumed,
    })
}

fn load_phone(
    provider: &CoreProvider,
    clock: Arc<dyn Clock>,
    accepted: BTreeSet<Id>,
) -> Result<Phone, PersistenceError> {
    let metadata = decode_endpoint_metadata(
        &provider
            .internal(ENDPOINT_METADATA_KEY)
            .ok_or(PersistenceError::Corrupt)?,
    )?;
    if metadata.identity.role != Role::Device {
        return Err(PersistenceError::IdentityMismatch);
    }
    let now_ms = clock.now_ms().map_err(PersistenceError::Core)?;
    if now_ms < metadata.last_wall_time_ms {
        return Err(PersistenceError::Core(CoreError::ClockRollback));
    }
    let signer = SignatureKeyPair::read(
        provider.storage(),
        &metadata.signer_public,
        SUITE.signature_algorithm(),
    )
    .ok_or(PersistenceError::Corrupt)?;
    let provider_copy = CoreProvider::from_storage_values(provider.storage_values())
        .map_err(|_| PersistenceError::Storage)?;
    let Some(context) = metadata.context else {
        return Ok(Phone {
            endpoint: None,
            provider: provider_copy,
            signer,
            identity: metadata.identity,
        });
    };
    let group = MlsGroup::load(
        provider_copy.storage(),
        &GroupId::from_slice(&context.group_id),
    )
    .map_err(|_| PersistenceError::Corrupt)?
    .ok_or(PersistenceError::Corrupt)?;
    let endpoint = Endpoint {
        provider: provider_copy,
        signer,
        group: Some(group),
        identity: metadata.identity.clone(),
        peer: metadata.peer,
        context,
        accepted,
        previous_epoch_deadlines: metadata.previous_epoch_deadlines,
        last_wall_time_ms: now_ms,
        clock,
        transaction_pending: false,
    };
    Ok(Phone {
        endpoint: Some(endpoint),
        provider: CoreProvider::new().map_err(|_| PersistenceError::Storage)?,
        signer: SignatureKeyPair::new(SUITE.signature_algorithm())
            .map_err(|_| PersistenceError::Storage)?,
        identity: metadata.identity,
    })
}

struct EndpointMetadata {
    identity: Identity,
    peer: Identity,
    context: Option<PairContext>,
    signer_public: Vec<u8>,
    previous_epoch_deadlines: BTreeMap<u64, u64>,
    last_wall_time_ms: u64,
}

fn encode_endpoint_metadata(
    identity: Identity,
    peer: Identity,
    context: Option<PairContext>,
    signer_public: &[u8],
    previous_epoch_deadlines: &BTreeMap<u64, u64>,
    last_wall_time_ms: u64,
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&STORAGE_SCHEMA_VERSION.to_be_bytes());
    encode_identity(&mut out, &identity);
    encode_identity(&mut out, &peer);
    match context {
        Some(context) => {
            out.push(1);
            out.extend_from_slice(&context.crypto_session_id);
            out.extend_from_slice(&context.group_id);
            out.extend_from_slice(&context.account_id);
            out.extend_from_slice(&context.installation_id);
            out.extend_from_slice(&context.device_id);
        }
        None => out.push(0),
    }
    out.push(signer_public.len() as u8);
    out.extend_from_slice(signer_public);
    out.extend_from_slice(&(previous_epoch_deadlines.len() as u32).to_be_bytes());
    for (epoch, deadline_ms) in previous_epoch_deadlines {
        out.extend_from_slice(&epoch.to_be_bytes());
        out.extend_from_slice(&deadline_ms.to_be_bytes());
    }
    out.extend_from_slice(&last_wall_time_ms.to_be_bytes());
    out
}

fn decode_endpoint_metadata(bytes: &[u8]) -> Result<EndpointMetadata, PersistenceError> {
    let mut cursor = BinaryCursor::new(bytes);
    if cursor.u16()? != STORAGE_SCHEMA_VERSION {
        return Err(PersistenceError::UnsupportedSchema);
    }
    let identity = decode_identity(&mut cursor)?;
    let peer = decode_identity(&mut cursor)?;
    let context = match cursor.u8()? {
        0 => None,
        1 => Some(PairContext {
            crypto_session_id: cursor.array()?,
            group_id: cursor.array()?,
            account_id: cursor.array()?,
            installation_id: cursor.array()?,
            device_id: cursor.array()?,
        }),
        _ => return Err(PersistenceError::Corrupt),
    };
    let signer_len = cursor.u8()? as usize;
    let signer_public = cursor.take(signer_len)?.to_vec();
    let deadline_count = cursor.u32()? as usize;
    if deadline_count > MAX_PAST_EPOCHS as usize {
        return Err(PersistenceError::Corrupt);
    }
    let mut previous_epoch_deadlines = BTreeMap::new();
    for _ in 0..deadline_count {
        let epoch = cursor.u64()?;
        let deadline_ms = cursor.u64()?;
        if previous_epoch_deadlines
            .insert(epoch, deadline_ms)
            .is_some()
        {
            return Err(PersistenceError::Corrupt);
        }
    }
    let last_wall_time_ms = cursor.u64()?;
    cursor.finish()?;
    if signer_public.len() != 32 {
        return Err(PersistenceError::Corrupt);
    }
    if let Some(context) = &context
        && (context.crypto_session_id == [0; 16]
            || context.account_id != identity.account_id
            || context.installation_id != identity.installation_id)
    {
        return Err(PersistenceError::IdentityMismatch);
    }
    Ok(EndpointMetadata {
        identity,
        peer,
        context,
        signer_public,
        previous_epoch_deadlines,
        last_wall_time_ms,
    })
}

fn encode_identity(out: &mut Vec<u8>, identity: &Identity) {
    out.push(identity.role as u8);
    out.extend_from_slice(&identity.account_id);
    out.extend_from_slice(&identity.installation_id);
    out.extend_from_slice(&identity.device_id);
}

fn decode_identity(cursor: &mut BinaryCursor<'_>) -> Result<Identity, PersistenceError> {
    let role = match cursor.u8()? {
        1 => Role::Daemon,
        2 => Role::Device,
        _ => return Err(PersistenceError::Corrupt),
    };
    let identity = Identity {
        role,
        account_id: cursor.array()?,
        installation_id: cursor.array()?,
        device_id: cursor.array()?,
    };
    identity.validate().map_err(PersistenceError::Core)?;
    Ok(identity)
}

const RESULT_TAG_INVITATION: u8 = 1;
const RESULT_TAG_PRE_JOIN: u8 = 2;
const RESULT_TAG_WELCOME: u8 = 3;
const RESULT_TAG_LEGACY_WELCOME: u8 = 4;
const RESULT_TAG_KEY_PACKAGE: u8 = 5;
const RESULT_TAG_CLAIM: u8 = 1;
const RESULT_TAG_RESERVATION: u8 = 2;
const RESULT_TAG_ACTIVATION: u8 = 1;
const RESULT_TAG_EPOCH_READY: u8 = 2;
const RESULT_TAG_INVITATION_LIFECYCLE: u8 = 1;
const RESULT_TAG_PRE_JOIN_LIFECYCLE: u8 = 2;
const RESULT_TAG_PAIR_LIFECYCLE: u8 = 3;
const RESULT_TAG_REMOVAL: u8 = 4;
const RESULT_TAG_RE_PAIR: u8 = 5;
const RESULT_TAG_COMMIT: u8 = 6;

impl TypedResult {
    /// Canonical private encoding into the sealed exact result. Envelope, receive, and
    /// acknowledgement results are references into authenticated successor records.
    fn encode(&self) -> Result<ExactResult, PersistenceError> {
        Ok(match self {
            Self::Empty => ExactResult::EmptySuccess,
            Self::Envelope(record) => ExactResult::EnvelopeReference(record.operation_id),
            Self::Plaintext(plaintext) => ExactResult::Receive {
                operation_id: plaintext.operation_id,
                plaintext: plaintext.plaintext.clone(),
            },
            Self::Accepted(record) => ExactResult::Receive {
                operation_id: record.operation_id,
                plaintext: Vec::new(),
            },
            Self::Commit(commit) => {
                let mut out = vec![RESULT_TAG_COMMIT];
                out.extend_from_slice(&commit.commit_id);
                out.extend_from_slice(&commit.target_epoch.to_be_bytes());
                out.extend_from_slice(&commit.epoch_authenticator);
                ExactResult::Lifecycle(out)
            }
            Self::OutboxAcknowledged(record) => {
                ExactResult::AcknowledgementReference(record.operation_id)
            }
            Self::ReceiveAcknowledged(record) => {
                ExactResult::AcknowledgementReference(record.operation_id)
            }
            Self::Invitation(publication) => ExactResult::PairingPublication(tagged(
                RESULT_TAG_INVITATION,
                &pairing_lifecycle::encode_invitation_publication(publication)?,
            )),
            Self::PreJoin(publication) => ExactResult::PairingPublication(tagged(
                RESULT_TAG_PRE_JOIN,
                &pairing_lifecycle::encode_prejoin_publication(publication)?,
            )),
            Self::Welcome(publication) => ExactResult::PairingPublication(tagged(
                RESULT_TAG_WELCOME,
                &pairing_lifecycle::encode_welcome_publication(publication)?,
            )),
            Self::LegacyWelcome(bytes) => {
                ExactResult::PairingPublication(tagged(RESULT_TAG_LEGACY_WELCOME, bytes))
            }
            Self::KeyPackage(bytes) => {
                ExactResult::PairingPublication(tagged(RESULT_TAG_KEY_PACKAGE, bytes))
            }
            Self::Claim(submission) => ExactResult::PairingDecision(tagged(
                RESULT_TAG_CLAIM,
                &pairing_lifecycle::encode_claim_submission(submission)?,
            )),
            Self::Reservation(outcome) => ExactResult::PairingDecision(tagged(
                RESULT_TAG_RESERVATION,
                &pairing_lifecycle::encode_reservation_outcome(outcome)?,
            )),
            Self::Activation(acceptance) => ExactResult::ProtectedAcceptance(tagged(
                RESULT_TAG_ACTIVATION,
                &pairing_lifecycle::encode_activation_acceptance(acceptance),
            )),
            Self::EpochReady(acceptance) => ExactResult::ProtectedAcceptance(tagged(
                RESULT_TAG_EPOCH_READY,
                &pairing_lifecycle::encode_epoch_ready_acceptance(acceptance),
            )),
            Self::InvitationLifecycle(state) => {
                ExactResult::Lifecycle(vec![RESULT_TAG_INVITATION_LIFECYCLE, *state as u8])
            }
            Self::PreJoinLifecycle(state) => {
                ExactResult::Lifecycle(vec![RESULT_TAG_PRE_JOIN_LIFECYCLE, *state as u8])
            }
            Self::PairLifecycle(state) => {
                ExactResult::Lifecycle(vec![RESULT_TAG_PAIR_LIFECYCLE, *state as u8])
            }
            Self::Removal(outcome) => ExactResult::Lifecycle(tagged(
                RESULT_TAG_REMOVAL,
                &pairing_lifecycle::encode_removal_outcome(outcome)?,
            )),
            Self::RePair(requirement) => ExactResult::Lifecycle(tagged(
                RESULT_TAG_RE_PAIR,
                &pairing_lifecycle::encode_re_pair_requirement(requirement),
            )),
        })
    }
}

fn tagged(tag: u8, bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 1);
    out.push(tag);
    out.extend_from_slice(bytes);
    out
}

/// Decode the exact typed result. References resolve through the authenticated outbox and
/// accepted-message tables of the same committed successor.
fn decode_typed_result(
    operation_kind: u16,
    exact: &ExactResult,
    values: &BTreeMap<Vec<u8>, Vec<u8>>,
    read: &redb::ReadTransaction,
    crypto_session_id: Id,
) -> Result<TypedResult, PersistenceError> {
    let outbox_row = |operation_id: Id| -> Result<OutboxRecord, PersistenceError> {
        let table = read.open_table(OUTBOX).map_err(map_table_error)?;
        let record = table
            .get(operation_id.as_slice())
            .map_err(map_storage_error)?
            .map(|value| decode_outbox(value.value()))
            .transpose()?
            .ok_or(PersistenceError::Corrupt)?;
        if record.operation_id != operation_id || record.crypto_session_id != crypto_session_id {
            return Err(PersistenceError::IdentityMismatch);
        }
        Ok(record)
    };
    let accepted_row = |operation_id: Id| -> Result<AcceptedMessageRecord, PersistenceError> {
        let table = read.open_table(ACCEPTED).map_err(map_table_error)?;
        let record = table
            .get(operation_id.as_slice())
            .map_err(map_storage_error)?
            .map(|value| decode_accepted(value.value()))
            .transpose()?
            .ok_or(PersistenceError::Corrupt)?;
        if record.operation_id != operation_id || record.crypto_session_id != crypto_session_id {
            return Err(PersistenceError::IdentityMismatch);
        }
        Ok(record)
    };
    let _ = values;
    Ok(match exact {
        ExactResult::EmptySuccess => TypedResult::Empty,
        ExactResult::EnvelopeReference(operation_id) => {
            TypedResult::Envelope(outbox_row(*operation_id)?)
        }
        ExactResult::Receive {
            operation_id,
            plaintext,
        } => {
            let record = accepted_row(*operation_id)?;
            if operation_kind == op_kind::APPLICATION_RECEIVE {
                TypedResult::Plaintext(DurablePlaintext {
                    operation_id: *operation_id,
                    logical_message_id: record.logical_message_id,
                    epoch: record.epoch,
                    plaintext: plaintext.clone(),
                })
            } else if plaintext.is_empty() {
                TypedResult::Accepted(record)
            } else {
                return Err(PersistenceError::Corrupt);
            }
        }
        ExactResult::AcknowledgementReference(operation_id) => match operation_kind {
            op_kind::OUTBOX_ACK => TypedResult::OutboxAcknowledged(outbox_row(*operation_id)?),
            op_kind::RECEIVE_ACK => TypedResult::ReceiveAcknowledged(accepted_row(*operation_id)?),
            _ => return Err(PersistenceError::Corrupt),
        },
        ExactResult::PairingPublication(bytes) => {
            let (tag, body) = bytes.split_first().ok_or(PersistenceError::Corrupt)?;
            match *tag {
                RESULT_TAG_INVITATION => {
                    TypedResult::Invitation(pairing_lifecycle::decode_invitation_publication(body)?)
                }
                RESULT_TAG_PRE_JOIN => {
                    TypedResult::PreJoin(pairing_lifecycle::decode_prejoin_publication(body)?)
                }
                RESULT_TAG_WELCOME => {
                    TypedResult::Welcome(pairing_lifecycle::decode_welcome_publication(body)?)
                }
                RESULT_TAG_LEGACY_WELCOME if !body.is_empty() => {
                    TypedResult::LegacyWelcome(body.to_vec())
                }
                RESULT_TAG_KEY_PACKAGE if !body.is_empty() => {
                    TypedResult::KeyPackage(body.to_vec())
                }
                _ => return Err(PersistenceError::Corrupt),
            }
        }
        ExactResult::PairingDecision(bytes) => {
            let (tag, body) = bytes.split_first().ok_or(PersistenceError::Corrupt)?;
            match *tag {
                RESULT_TAG_CLAIM => {
                    TypedResult::Claim(pairing_lifecycle::decode_claim_submission(body)?)
                }
                RESULT_TAG_RESERVATION => {
                    TypedResult::Reservation(pairing_lifecycle::decode_reservation_outcome(body)?)
                }
                _ => return Err(PersistenceError::Corrupt),
            }
        }
        ExactResult::ProtectedAcceptance(bytes) => {
            let (tag, body) = bytes.split_first().ok_or(PersistenceError::Corrupt)?;
            match *tag {
                RESULT_TAG_ACTIVATION => {
                    TypedResult::Activation(pairing_lifecycle::decode_activation_acceptance(body)?)
                }
                RESULT_TAG_EPOCH_READY => {
                    TypedResult::EpochReady(pairing_lifecycle::decode_epoch_ready_acceptance(body)?)
                }
                _ => return Err(PersistenceError::Corrupt),
            }
        }
        ExactResult::Lifecycle(bytes) => {
            let (tag, body) = bytes.split_first().ok_or(PersistenceError::Corrupt)?;
            match (*tag, body) {
                (RESULT_TAG_INVITATION_LIFECYCLE, [value]) => TypedResult::InvitationLifecycle(
                    pairing_lifecycle::decode_invitation_lifecycle(*value)?,
                ),
                (RESULT_TAG_PRE_JOIN_LIFECYCLE, [value]) => TypedResult::PreJoinLifecycle(
                    pairing_lifecycle::decode_prejoin_lifecycle(*value)?,
                ),
                (RESULT_TAG_PAIR_LIFECYCLE, [value]) => {
                    TypedResult::PairLifecycle(pairing_lifecycle::decode_pair_lifecycle(*value)?)
                }
                (RESULT_TAG_REMOVAL, body) => {
                    TypedResult::Removal(pairing_lifecycle::decode_removal_outcome(body)?)
                }
                (RESULT_TAG_RE_PAIR, body) => {
                    TypedResult::RePair(pairing_lifecycle::decode_re_pair_requirement(body)?)
                }
                (RESULT_TAG_COMMIT, body) if body.len() == 48 + 8 + 48 => {
                    TypedResult::Commit(CommitMetadata {
                        commit_id: body[..48]
                            .try_into()
                            .map_err(|_| PersistenceError::Corrupt)?,
                        target_epoch: u64::from_be_bytes(
                            body[48..56]
                                .try_into()
                                .map_err(|_| PersistenceError::Corrupt)?,
                        ),
                        epoch_authenticator: body[56..]
                            .try_into()
                            .map_err(|_| PersistenceError::Corrupt)?,
                    })
                }
                _ => return Err(PersistenceError::Corrupt),
            }
        }
    })
}

macro_rules! typed_result_conversion {
    ($type:ty, $variant:ident) => {
        impl TryFrom<TypedResult> for $type {
            type Error = PersistenceError;

            fn try_from(value: TypedResult) -> Result<Self, PersistenceError> {
                match value {
                    TypedResult::$variant(inner) => Ok(inner),
                    _ => Err(PersistenceError::Corrupt),
                }
            }
        }
    };
}

typed_result_conversion!(DurablePlaintext, Plaintext);
typed_result_conversion!(InvitationPublication, Invitation);
typed_result_conversion!(PreJoinPublication, PreJoin);
typed_result_conversion!(ClaimSubmission, Claim);
typed_result_conversion!(ReservationOutcome, Reservation);
typed_result_conversion!(EpochReadyAcceptance, EpochReady);
typed_result_conversion!(InvitationLifecycle, InvitationLifecycle);
typed_result_conversion!(PreJoinLifecycle, PreJoinLifecycle);
typed_result_conversion!(PairLifecycle, PairLifecycle);
typed_result_conversion!(RePairRequirement, RePair);
typed_result_conversion!(CommitMetadata, Commit);

impl TryFrom<TypedResult> for OutboxRecord {
    type Error = PersistenceError;

    fn try_from(value: TypedResult) -> Result<Self, PersistenceError> {
        match value {
            TypedResult::Envelope(inner) | TypedResult::OutboxAcknowledged(inner) => Ok(inner),
            _ => Err(PersistenceError::Corrupt),
        }
    }
}

impl TryFrom<TypedResult> for AcceptedMessageRecord {
    type Error = PersistenceError;

    fn try_from(value: TypedResult) -> Result<Self, PersistenceError> {
        match value {
            TypedResult::Accepted(inner) | TypedResult::ReceiveAcknowledged(inner) => Ok(inner),
            _ => Err(PersistenceError::Corrupt),
        }
    }
}

impl TryFrom<TypedResult> for Vec<u8> {
    type Error = PersistenceError;

    fn try_from(value: TypedResult) -> Result<Self, PersistenceError> {
        match value {
            TypedResult::LegacyWelcome(inner) | TypedResult::KeyPackage(inner) => Ok(inner),
            _ => Err(PersistenceError::Corrupt),
        }
    }
}

impl TryFrom<TypedResult> for () {
    type Error = PersistenceError;

    fn try_from(value: TypedResult) -> Result<Self, PersistenceError> {
        match value {
            TypedResult::Empty => Ok(()),
            _ => Err(PersistenceError::Corrupt),
        }
    }
}

#[derive(Debug)]
struct SealedState {
    key_id: [u8; 16],
    nonce: [u8; 12],
    ciphertext: Vec<u8>,
}

impl SealedState {
    fn encode(&self) -> Result<Vec<u8>, PersistenceError> {
        let mut out = Vec::with_capacity(2 + 16 + 12 + 4 + self.ciphertext.len());
        out.extend_from_slice(&STATE_FORMAT_VERSION.to_be_bytes());
        out.extend_from_slice(&self.key_id);
        out.extend_from_slice(&self.nonce);
        put_bytes(&mut out, &self.ciphertext)?;
        Ok(out)
    }

    fn decode(bytes: &[u8]) -> Result<Self, PersistenceError> {
        let mut cursor = BinaryCursor::new(bytes);
        if cursor.u16()? != STATE_FORMAT_VERSION {
            return Err(PersistenceError::UnsupportedSchema);
        }
        let value = Self {
            key_id: cursor.array()?,
            nonce: cursor.array()?,
            ciphertext: cursor.bytes()?.to_vec(),
        };
        cursor.finish()?;
        Ok(value)
    }
}

fn configure_transaction(write: &mut WriteTransaction) -> Result<(), PersistenceError> {
    write
        .set_durability(Durability::Immediate)
        .map_err(|_| PersistenceError::Storage)?;
    write.set_two_phase_commit(true);
    Ok(())
}

fn map_current_key_error(error: PersistenceError) -> PersistenceError {
    match error {
        PersistenceError::KeyRecordMissing => PersistenceError::StateLoss,
        other => other,
    }
}

fn require_dependencies(envelope_keys: &dyn EnvelopeKeyStore) -> Result<(), PersistenceError> {
    if !envelope_keys.available() {
        return Err(PersistenceError::KeyUnavailable);
    }
    Ok(())
}

struct SessionLifecycleClaim {
    _file: File,
}

fn prepare_storage_root(root: &Path, create: bool) -> Result<PathBuf, PersistenceError> {
    if create {
        if root.exists()
            && fs::symlink_metadata(root)
                .map_err(|_| PersistenceError::Io)?
                .file_type()
                .is_symlink()
        {
            return Err(PersistenceError::IdentityMismatch);
        }
        fs::create_dir_all(root).map_err(|_| PersistenceError::Io)?;
        restrict_directory(root)?;
    }
    canonical_storage_root(root)
}

fn acquire_session_lifecycle_claim(
    root: &Path,
    session: Id,
) -> Result<SessionLifecycleClaim, PersistenceError> {
    let path = root.join(format!("{}.redb.lifecycle.lock", hex_id(session)));
    let (file, created) = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => (file, true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_regular_file(&path, PersistenceError::Io)?;
            (
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&path)
                    .map_err(|_| PersistenceError::Io)?,
                false,
            )
        }
        Err(_) => return Err(PersistenceError::Io),
    };
    restrict_file(&path)?;
    if created {
        sync_parent_directory(&path)?;
    }
    file.try_lock().map_err(|error| match error {
        fs::TryLockError::WouldBlock => PersistenceError::LifecycleBusy,
        fs::TryLockError::Error(_) => PersistenceError::Io,
    })?;
    Ok(SessionLifecycleClaim { _file: file })
}

fn database_path(
    root: &Path,
    session: Id,
    create: bool,
    faults: Option<&dyn FaultInjector>,
) -> Result<PathBuf, PersistenceError> {
    let root = canonical_storage_root(root)?;
    let filename = format!("{}.redb", hex_id(session));
    let path = root.join(filename);
    let initialization_marker = initializing_marker_for_database(&path);
    let database_exists = regular_file_exists(&path)?;
    let marker_exists = regular_file_exists(&initialization_marker)?;
    if database_exists {
        if create {
            return if marker_exists {
                Err(PersistenceError::InitializationIncomplete)
            } else {
                Err(PersistenceError::AlreadyExists)
            };
        }
        let canonical = path.canonicalize().map_err(|_| PersistenceError::Io)?;
        if canonical.parent() != Some(root.as_path()) {
            return Err(PersistenceError::IdentityMismatch);
        }
        restrict_file(&canonical)?;
        Ok(canonical)
    } else if create {
        if marker_exists {
            return Err(PersistenceError::InitializationIncomplete);
        }
        create_private_file(&initialization_marker)?;
        sync_parent_directory(&initialization_marker)?;
        if let Some(faults) = faults {
            faults.check(FaultPoint::AfterInitializationMarkerCreation)?;
        }
        create_private_file(&path)?;
        sync_parent_directory(&path)?;
        Ok(path)
    } else if marker_exists {
        Err(PersistenceError::InitializationIncomplete)
    } else {
        Err(PersistenceError::NotFound)
    }
}

fn initializing_marker_for_database(database: &Path) -> PathBuf {
    database.with_extension("redb.initializing")
}

fn canonical_storage_root(root: &Path) -> Result<PathBuf, PersistenceError> {
    let metadata = fs::symlink_metadata(root).map_err(|_| PersistenceError::Io)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(PersistenceError::IdentityMismatch);
    }
    #[cfg(target_os = "windows")]
    windows_fs::validate_path_handle(root, true)?;
    root.canonicalize().map_err(|_| PersistenceError::Io)
}

fn regular_file_exists(path: &Path) -> Result<bool, PersistenceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(PersistenceError::IdentityMismatch)
        }
        Ok(_) => {
            #[cfg(target_os = "windows")]
            windows_fs::validate_path_handle(path, false)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(PersistenceError::Io),
    }
}

fn validate_regular_file(path: &Path, missing: PersistenceError) -> Result<(), PersistenceError> {
    if regular_file_exists(path)? {
        Ok(())
    } else {
        Err(missing)
    }
}

fn inspect_database_lifecycle(
    database: &impl ReadableDatabase,
    crypto_session_id: Id,
) -> Result<u8, PersistenceError> {
    let read = database.begin_read().map_err(map_transaction_error)?;
    let meta = read.open_table(META).map_err(map_table_error)?;
    if read_u16(&meta, META_SCHEMA)? != STORAGE_SCHEMA_VERSION {
        return Err(PersistenceError::UnsupportedSchema);
    }
    if read_bytes(&meta, META_SESSION)? != crypto_session_id
        || read_bytes(&meta, META_PROFILE)? != PROFILE_ID.as_bytes()
        || read_u16(&meta, META_PROFILE_REVISION)? != PROFILE_REVISION
    {
        return Err(PersistenceError::IdentityMismatch);
    }
    match read_bytes(&meta, META_LIFECYCLE)?.as_slice() {
        [
            lifecycle @ (LIFECYCLE_INITIALIZING
            | LIFECYCLE_READY
            | LIFECYCLE_QUARANTINED
            | LIFECYCLE_REVOKED),
        ] => Ok(*lifecycle),
        _ => Err(PersistenceError::Corrupt),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InitializationState {
    Pristine,
    Committed,
    Inconsistent,
}

fn inspect_initialization_state(
    database: &impl ReadableDatabase,
    crypto_session_id: Id,
) -> Result<InitializationState, PersistenceError> {
    let read = database.begin_read().map_err(map_transaction_error)?;
    let expected_tables = BTreeSet::from([
        META.name().to_owned(),
        STATE.name().to_owned(),
        OPERATIONS.name().to_owned(),
        OUTBOX.name().to_owned(),
        ACCEPTED.name().to_owned(),
        PENDING_WITNESS.name().to_owned(),
    ]);
    let actual_tables = read
        .list_tables()
        .map_err(map_storage_error)?
        .map(|table| table.name().to_owned())
        .collect::<BTreeSet<_>>();
    if actual_tables != expected_tables
        || read
            .list_multimap_tables()
            .map_err(map_storage_error)?
            .next()
            .is_some()
    {
        return Ok(InitializationState::Inconsistent);
    }

    let meta = read.open_table(META).map_err(map_table_error)?;
    let mut metadata_entries = 0_usize;
    for entry in meta.iter().map_err(map_storage_error)? {
        entry.map_err(map_storage_error)?;
        metadata_entries += 1;
    }
    let generation = read_u64(&meta, META_GENERATION)?;
    let rollback_counter = read_u64(&meta, META_ROLLBACK_COUNTER)?;
    let epoch = read_u64(&meta, META_EPOCH)?;
    let authenticator = read_bytes(&meta, META_EPOCH_AUTHENTICATOR)?;
    let pending_erase = read_bytes(&meta, META_PENDING_ERASE)?;
    drop(meta);

    let state_entries = read
        .open_table(STATE)
        .map_err(map_table_error)?
        .iter()
        .map_err(map_storage_error)?
        .count();
    let operation_entries = read
        .open_table(OPERATIONS)
        .map_err(map_table_error)?
        .iter()
        .map_err(map_storage_error)?
        .count();
    let outbox_entries = read
        .open_table(OUTBOX)
        .map_err(map_table_error)?
        .iter()
        .map_err(map_storage_error)?
        .count();
    let accepted_entries = read
        .open_table(ACCEPTED)
        .map_err(map_table_error)?
        .iter()
        .map_err(map_storage_error)?
        .count();
    let pending_witness_entries = read
        .open_table(PENDING_WITNESS)
        .map_err(map_table_error)?
        .iter()
        .map_err(map_storage_error)?
        .count();

    if metadata_entries == 16
        && generation == 0
        && rollback_counter == 0
        && epoch == 0
        && authenticator.is_empty()
        && pending_erase.is_empty()
        && state_entries == 0
        && operation_entries == 0
        && outbox_entries == 0
        && accepted_entries == 0
        && pending_witness_entries == 0
    {
        return Ok(InitializationState::Pristine);
    }

    let creation_operation = if operation_entries == 1 {
        let operations = read.open_table(OPERATIONS).map_err(map_table_error)?;
        let mut entries = operations.iter().map_err(map_storage_error)?;
        let Some(entry) = entries.next() else {
            return Ok(InitializationState::Inconsistent);
        };
        let (key, value) = entry.map_err(map_storage_error)?;
        let (index, operation) = decode_operation_index(value.value())?;
        Some((
            key.value().to_vec(),
            index.operation_kind,
            index.generation,
            operation,
        ))
    } else {
        None
    };

    let valid_creation_shape = match creation_operation {
        Some((key, kind, 1, CommittedOperation::Envelope(record))) => {
            let outbox = read.open_table(OUTBOX).map_err(map_table_error)?;
            let persisted = outbox
                .get(record.operation_id.as_slice())
                .map_err(map_storage_error)?
                .map(|value| decode_outbox(value.value()))
                .transpose()?;
            epoch == 0
                && authenticator.is_empty()
                && outbox_entries == 1
                && accepted_entries == 0
                && key.as_slice() == record.operation_id
                && kind == op_kind::LEGACY_CREATE
                && record.crypto_session_id == crypto_session_id
                && record.logical_message_id == record.operation_id
                && record.class == MessageClass::PairActivation
                && record.epoch == 0
                && record.profile_revision == PROFILE_REVISION
                && record.retry_state == RetryState::Pending
                && !record.ciphertext.is_empty()
                && record.commit.is_none()
                && persisted.as_ref() == Some(&record)
        }
        Some((key, kind, 1, CommittedOperation::Accepted(record))) => {
            let accepted = read.open_table(ACCEPTED).map_err(map_table_error)?;
            let persisted = accepted
                .get(record.operation_id.as_slice())
                .map_err(map_storage_error)?
                .map(|value| decode_accepted(value.value()))
                .transpose()?;
            authenticator.len() == 48
                && outbox_entries == 0
                && accepted_entries == 1
                && key.as_slice() == record.operation_id
                && kind == op_kind::LEGACY_CREATE
                && record == initialized_record(record.operation_id, crypto_session_id)
                && persisted.as_ref() == Some(&record)
        }
        Some((key, kind, 1, CommittedOperation::Pairing(record))) => {
            matches!(kind, op_kind::DAEMON_INVITATION | op_kind::DEVICE_PRE_JOIN)
                && epoch == 0
                && authenticator.is_empty()
                && outbox_entries == 0
                && accepted_entries == 0
                && key.as_slice() == record.operation_id
                && record.crypto_session_id == crypto_session_id
                && matches!(record.kind, 1 | 2)
        }
        _ => false,
    };

    let group_state_candidate = generation > 0
        && rollback_counter == generation
        && authenticator.len() == 48
        && matches!(pending_erase.len(), 0 | 16)
        && state_entries == 1
        && operation_entries > 0
        && outbox_entries + accepted_entries > 0;
    let initial_state_candidate = generation == 1
        && rollback_counter == 1
        && pending_erase.is_empty()
        && state_entries == 1
        && valid_creation_shape;

    if metadata_entries == 16
        && pending_witness_entries <= 1
        && (group_state_candidate || initial_state_candidate)
    {
        Ok(InitializationState::Committed)
    } else {
        Ok(InitializationState::Inconsistent)
    }
}

fn create_private_file(path: &Path) -> Result<(), PersistenceError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_WRITE_THROUGH;
        options.custom_flags(FILE_FLAG_WRITE_THROUGH);
    }
    let file = options.open(path).map_err(|_| PersistenceError::Io)?;
    #[cfg(target_os = "windows")]
    windows_fs::flush_file(&file)?;
    drop(file);
    restrict_file(path)
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> Result<(), PersistenceError> {
    let parent = path.parent().ok_or(PersistenceError::Io)?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| PersistenceError::Io)
}

#[cfg(target_os = "windows")]
fn sync_parent_directory(path: &Path) -> Result<(), PersistenceError> {
    let parent = path.parent().ok_or(PersistenceError::Io)?;
    windows_fs::sync_directory(parent)
}

#[cfg(all(not(unix), not(target_os = "windows")))]
fn sync_parent_directory(_path: &Path) -> Result<(), PersistenceError> {
    Err(PersistenceError::Io)
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> Result<(), PersistenceError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| PersistenceError::Io)
}
#[cfg(target_os = "windows")]
fn restrict_directory(path: &Path) -> Result<(), PersistenceError> {
    windows_fs::validate_path_handle(path, true)?;
    windows_fs::harden_path(path)
}
#[cfg(all(not(unix), not(target_os = "windows")))]
fn restrict_directory(_path: &Path) -> Result<(), PersistenceError> {
    Err(PersistenceError::Io)
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> Result<(), PersistenceError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|_| PersistenceError::Io)
}
#[cfg(target_os = "windows")]
fn restrict_file(path: &Path) -> Result<(), PersistenceError> {
    windows_fs::validate_path_handle(path, false)?;
    windows_fs::harden_path(path)
}
#[cfg(all(not(unix), not(target_os = "windows")))]
fn restrict_file(_path: &Path) -> Result<(), PersistenceError> {
    Err(PersistenceError::Io)
}

fn state_aad(meta: &impl ReadableTable<u8, &'static [u8]>) -> Result<Vec<u8>, PersistenceError> {
    let session: Id = read_bytes(meta, META_SESSION)?
        .try_into()
        .map_err(|_| PersistenceError::Corrupt)?;
    let profile = read_bytes(meta, META_PROFILE)?;
    let profile_length = u8::try_from(profile.len()).map_err(|_| PersistenceError::Corrupt)?;
    let epoch_authenticator = read_bytes(meta, META_EPOCH_AUTHENTICATOR)?;
    if !matches!(epoch_authenticator.len(), 0 | 48) {
        return Err(PersistenceError::Corrupt);
    }
    let registration = read_bytes(meta, META_WITNESS_REGISTRATION)?;
    if !matches!(registration.as_slice(), [0] | [1]) {
        return Err(PersistenceError::Corrupt);
    }
    let confirmed_commitment = read_bytes(meta, META_CONFIRMED_WITNESS_COMMITMENT)?;
    let previous_certificate_hash = read_bytes(meta, META_PREVIOUS_CERTIFICATE_HASH)?;
    let current_key = read_bytes(meta, META_CURRENT_KEY_ID)?;
    let obsolete_key = read_bytes(meta, META_OBSOLETE_KEY_ID)?;
    if confirmed_commitment.len() != 48
        || previous_certificate_hash.len() != 48
        || !matches!(current_key.len(), 0 | 16)
        || !matches!(obsolete_key.len(), 0 | 16)
    {
        return Err(PersistenceError::Corrupt);
    }

    let mut aad = Vec::with_capacity(STATE_AAD_LABEL.len() + 256);
    aad.extend_from_slice(STATE_AAD_LABEL);
    aad.extend_from_slice(&STORAGE_SCHEMA_VERSION.to_be_bytes());
    aad.push(profile_length);
    aad.extend_from_slice(&profile);
    aad.extend_from_slice(&read_u16(meta, META_PROFILE_REVISION)?.to_be_bytes());
    aad.extend_from_slice(&session);
    aad.extend_from_slice(&read_u64(meta, META_GENERATION)?.to_be_bytes());
    aad.extend_from_slice(&read_u64(meta, META_ROLLBACK_COUNTER)?.to_be_bytes());
    aad.extend_from_slice(&read_u64(meta, META_EPOCH)?.to_be_bytes());
    aad.push(epoch_authenticator.len() as u8);
    aad.extend_from_slice(&epoch_authenticator);
    aad.extend_from_slice(&read_u64(meta, META_CONFIRMED_WITNESS_COUNTER)?.to_be_bytes());
    aad.extend_from_slice(&confirmed_commitment);
    aad.extend_from_slice(&previous_certificate_hash);
    aad.extend_from_slice(&registration);
    put_aad_optional_id(&mut aad, &current_key)?;
    put_aad_optional_id(&mut aad, &obsolete_key)?;
    Ok(aad)
}

fn put_aad_optional_id(out: &mut Vec<u8>, value: &[u8]) -> Result<(), PersistenceError> {
    match value.len() {
        0 => out.push(0),
        16 => {
            out.push(1);
            out.extend_from_slice(value);
        }
        _ => return Err(PersistenceError::Corrupt),
    }
    Ok(())
}

fn encode_storage_image(values: &BTreeMap<Vec<u8>, Vec<u8>>) -> Result<Vec<u8>, PersistenceError> {
    if values.len() > MAX_STATE_ENTRIES {
        return Err(PersistenceError::Corrupt);
    }
    let mut out = Vec::new();
    out.extend_from_slice(&STATE_FORMAT_VERSION.to_be_bytes());
    out.extend_from_slice(&(values.len() as u32).to_be_bytes());
    for (key, value) in values {
        put_bytes(&mut out, key)?;
        put_bytes(&mut out, value)?;
        if out.len() > MAX_STATE_BYTES {
            return Err(PersistenceError::Corrupt);
        }
    }
    Ok(out)
}

fn decode_storage_image(bytes: &[u8]) -> Result<BTreeMap<Vec<u8>, Vec<u8>>, PersistenceError> {
    if bytes.len() > MAX_STATE_BYTES {
        return Err(PersistenceError::Corrupt);
    }
    let mut cursor = BinaryCursor::new(bytes);
    if cursor.u16()? != STATE_FORMAT_VERSION {
        return Err(PersistenceError::UnsupportedSchema);
    }
    let count = cursor.u32()? as usize;
    if count > MAX_STATE_ENTRIES {
        return Err(PersistenceError::Corrupt);
    }
    let mut values = BTreeMap::new();
    for _ in 0..count {
        let key = cursor.bytes()?.to_vec();
        let value = cursor.bytes()?.to_vec();
        if values.insert(key, value).is_some() {
            return Err(PersistenceError::Corrupt);
        }
    }
    cursor.finish()?;
    Ok(values)
}

fn encode_outbox(record: &OutboxRecord) -> Result<Vec<u8>, PersistenceError> {
    let mut out = Vec::new();
    out.extend_from_slice(&record.operation_id);
    out.extend_from_slice(&record.crypto_session_id);
    out.extend_from_slice(&record.logical_message_id);
    out.push(record.class as u8);
    out.extend_from_slice(&record.epoch.to_be_bytes());
    out.extend_from_slice(&record.hosted_generation.to_be_bytes());
    out.extend_from_slice(&record.profile_revision.to_be_bytes());
    out.push(record.retry_state as u8);
    put_bytes(&mut out, &record.ciphertext)?;
    match &record.commit {
        Some(commit) => {
            out.push(1);
            out.extend_from_slice(&commit.commit_id);
            out.extend_from_slice(&commit.target_epoch.to_be_bytes());
            out.extend_from_slice(&commit.epoch_authenticator);
        }
        None => out.push(0),
    }
    Ok(out)
}

fn decode_outbox(bytes: &[u8]) -> Result<OutboxRecord, PersistenceError> {
    let mut cursor = BinaryCursor::new(bytes);
    let operation_id = cursor.array()?;
    let crypto_session_id = cursor.array()?;
    let logical_message_id = cursor.array()?;
    let class = cursor
        .u8()?
        .try_into()
        .map_err(|_| PersistenceError::Corrupt)?;
    let epoch = cursor.u64()?;
    let hosted_generation = cursor.u64()?;
    let profile_revision = cursor.u16()?;
    let retry_state = match cursor.u8()? {
        1 => RetryState::Pending,
        2 => RetryState::Acknowledged,
        _ => return Err(PersistenceError::Corrupt),
    };
    let ciphertext = cursor.bytes()?.to_vec();
    let commit = match cursor.u8()? {
        0 => None,
        1 => Some(CommitMetadata {
            commit_id: cursor.array()?,
            target_epoch: cursor.u64()?,
            epoch_authenticator: cursor.array()?,
        }),
        _ => return Err(PersistenceError::Corrupt),
    };
    cursor.finish()?;
    if crypto_session_id == [0; 16] || profile_revision != PROFILE_REVISION {
        return Err(PersistenceError::Corrupt);
    }
    Ok(OutboxRecord::new(OutboxRecordFields {
        operation_id,
        crypto_session_id,
        logical_message_id,
        class,
        epoch,
        hosted_generation,
        profile_revision,
        retry_state,
        ciphertext,
        commit,
    }))
}

fn encode_accepted(record: &AcceptedMessageRecord) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 * 3 + 1 + 8 + 2 + 1);
    out.extend_from_slice(&record.operation_id);
    out.extend_from_slice(&record.crypto_session_id);
    out.extend_from_slice(&record.logical_message_id);
    out.push(record.class as u8);
    out.extend_from_slice(&record.epoch.to_be_bytes());
    out.extend_from_slice(&record.profile_revision.to_be_bytes());
    out.push(u8::from(record.acknowledged));
    out
}

fn decode_accepted(bytes: &[u8]) -> Result<AcceptedMessageRecord, PersistenceError> {
    let mut cursor = BinaryCursor::new(bytes);
    let record = AcceptedMessageRecord {
        operation_id: cursor.array()?,
        crypto_session_id: cursor.array()?,
        logical_message_id: cursor.array()?,
        class: cursor
            .u8()?
            .try_into()
            .map_err(|_| PersistenceError::Corrupt)?,
        epoch: cursor.u64()?,
        profile_revision: cursor.u16()?,
        acknowledged: match cursor.u8()? {
            0 => false,
            1 => true,
            _ => return Err(PersistenceError::Corrupt),
        },
    };
    cursor.finish()?;
    if record.crypto_session_id == [0; 16] || record.profile_revision != PROFILE_REVISION {
        return Err(PersistenceError::Corrupt);
    }
    Ok(record)
}

fn durable_manifest(
    write: &WriteTransaction,
    crypto: &impl openmls_traits::crypto::OpenMlsCrypto,
) -> Result<[u8; 48], PersistenceError> {
    let mut canonical = b"Axl durable record manifest v1".to_vec();
    {
        let table = write.open_table(META).map_err(map_table_error)?;
        for entry in table.iter().map_err(map_storage_error)? {
            let (key, value) = entry.map_err(map_storage_error)?;
            if key.value() == META_LIFECYCLE {
                continue;
            }
            append_manifest_entry(
                &mut canonical,
                crypto,
                b"meta",
                &[key.value()],
                value.value(),
            )?;
        }
    }
    for (label, definition) in [
        (b"operations".as_slice(), OPERATIONS),
        (b"outbox".as_slice(), OUTBOX),
        (b"accepted".as_slice(), ACCEPTED),
    ] {
        let table = write.open_table(definition).map_err(map_table_error)?;
        for entry in table.iter().map_err(map_storage_error)? {
            let (key, value) = entry.map_err(map_storage_error)?;
            append_manifest_entry(&mut canonical, crypto, label, key.value(), value.value())?;
        }
    }
    crypto
        .hash(SUITE.hash_algorithm(), &canonical)
        .map_err(|_| PersistenceError::Storage)?
        .try_into()
        .map_err(|_| PersistenceError::Storage)
}

fn durable_manifest_read(
    read: &redb::ReadTransaction,
    crypto: &impl openmls_traits::crypto::OpenMlsCrypto,
) -> Result<[u8; 48], PersistenceError> {
    let mut canonical = b"Axl durable record manifest v1".to_vec();
    {
        let table = read.open_table(META).map_err(map_table_error)?;
        for entry in table.iter().map_err(map_storage_error)? {
            let (key, value) = entry.map_err(map_storage_error)?;
            if key.value() == META_LIFECYCLE {
                continue;
            }
            append_manifest_entry(
                &mut canonical,
                crypto,
                b"meta",
                &[key.value()],
                value.value(),
            )?;
        }
    }
    for (label, definition) in [
        (b"operations".as_slice(), OPERATIONS),
        (b"outbox".as_slice(), OUTBOX),
        (b"accepted".as_slice(), ACCEPTED),
    ] {
        let table = read.open_table(definition).map_err(map_table_error)?;
        for entry in table.iter().map_err(map_storage_error)? {
            let (key, value) = entry.map_err(map_storage_error)?;
            append_manifest_entry(&mut canonical, crypto, label, key.value(), value.value())?;
        }
    }
    crypto
        .hash(SUITE.hash_algorithm(), &canonical)
        .map_err(|_| PersistenceError::Storage)?
        .try_into()
        .map_err(|_| PersistenceError::Storage)
}

fn append_manifest_entry(
    canonical: &mut Vec<u8>,
    crypto: &impl openmls_traits::crypto::OpenMlsCrypto,
    label: &[u8],
    key: &[u8],
    value: &[u8],
) -> Result<(), PersistenceError> {
    let mut entry = Vec::with_capacity(label.len() + key.len() + value.len() + 8);
    put_bytes(&mut entry, label)?;
    put_bytes(&mut entry, key)?;
    put_bytes(&mut entry, value)?;
    let digest = crypto
        .hash(SUITE.hash_algorithm(), &entry)
        .map_err(|_| PersistenceError::Storage)?;
    canonical.extend_from_slice(&digest);
    Ok(())
}

fn load_accepted_ids(
    write: &WriteTransaction,
    crypto_session_id: Id,
) -> Result<BTreeSet<Id>, PersistenceError> {
    let table = write.open_table(ACCEPTED).map_err(map_table_error)?;
    let mut ids = BTreeSet::new();
    for entry in table.iter().map_err(map_storage_error)? {
        let (key, value) = entry.map_err(map_storage_error)?;
        let operation_id: Id = key
            .value()
            .try_into()
            .map_err(|_| PersistenceError::Corrupt)?;
        let record = decode_accepted(value.value())?;
        if record.operation_id != operation_id || record.crypto_session_id != crypto_session_id {
            return Err(PersistenceError::IdentityMismatch);
        }
        if matches!(
            record.class,
            MessageClass::ApplicationRequest | MessageClass::ApplicationDelivery
        ) {
            ids.insert(record.logical_message_id);
        }
    }
    Ok(ids)
}

fn prune_durable_records(
    write: &mut WriteTransaction,
    next_generation: u64,
) -> Result<Vec<Id>, PersistenceError> {
    let cutoff = next_generation.saturating_sub(IDEMPOTENCY_RETENTION_GENERATIONS);
    let entries = {
        let operations = write.open_table(OPERATIONS).map_err(map_table_error)?;
        let mut entries = Vec::new();
        for entry in operations.iter().map_err(map_storage_error)? {
            let (key, value) = entry.map_err(map_storage_error)?;
            entries.push((
                key.value().to_vec(),
                decode_operation_generation(value.value())?,
                decode_operation(value.value())?,
            ));
        }
        entries
    };
    let mut pending = 0usize;
    let mut remove = Vec::new();
    for (key, generation, operation) in entries {
        let acknowledged = match &operation {
            CommittedOperation::Envelope(record) => {
                let outbox = write.open_table(OUTBOX).map_err(map_table_error)?;
                outbox
                    .get(record.operation_id.as_slice())
                    .map_err(map_storage_error)?
                    .map(|value| decode_outbox(value.value()))
                    .transpose()?
                    .is_some_and(|stored| stored.retry_state == RetryState::Acknowledged)
            }
            CommittedOperation::Accepted(record) => {
                let accepted = write.open_table(ACCEPTED).map_err(map_table_error)?;
                accepted
                    .get(record.operation_id.as_slice())
                    .map_err(map_storage_error)?
                    .map(|value| decode_accepted(value.value()))
                    .transpose()?
                    .is_some_and(|stored| stored.acknowledged)
            }
            CommittedOperation::OutboxAcknowledged(_)
            | CommittedOperation::ReceiveAcknowledged(_)
            | CommittedOperation::Pairing(_) => true,
        };
        if acknowledged && generation <= cutoff {
            remove.push((key, operation));
        } else if !acknowledged {
            pending = pending.saturating_add(1);
        }
    }
    if pending > IDEMPOTENCY_RETENTION_GENERATIONS as usize {
        return Err(PersistenceError::RetentionExceeded);
    }
    let mut pruned = Vec::with_capacity(remove.len());
    for (key, operation) in remove {
        write
            .open_table(OPERATIONS)
            .map_err(map_table_error)?
            .remove(key.as_slice())
            .map_err(map_storage_error)?;
        pruned.push(
            key.as_slice()
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?,
        );
        match operation {
            CommittedOperation::Envelope(record) => {
                write
                    .open_table(OUTBOX)
                    .map_err(map_table_error)?
                    .remove(record.operation_id.as_slice())
                    .map_err(map_storage_error)?;
            }
            CommittedOperation::Accepted(record) => {
                write
                    .open_table(ACCEPTED)
                    .map_err(map_table_error)?
                    .remove(record.operation_id.as_slice())
                    .map_err(map_storage_error)?;
            }
            CommittedOperation::OutboxAcknowledged(_)
            | CommittedOperation::ReceiveAcknowledged(_)
            | CommittedOperation::Pairing(_) => {}
        }
    }
    Ok(pruned)
}

fn read_outbox_in_transaction(
    transaction: &NativeGroupTransaction<'_>,
    operation_id: Id,
) -> Result<Option<OutboxRecord>, PersistenceError> {
    let write = transaction
        .write
        .as_ref()
        .ok_or(PersistenceError::Storage)?;
    let table = write.open_table(OUTBOX).map_err(map_table_error)?;
    let record = table
        .get(operation_id.as_slice())
        .map_err(map_storage_error)?
        .map(|value| decode_outbox(value.value()))
        .transpose()?;
    if let Some(record) = &record
        && (record.operation_id != operation_id
            || record.crypto_session_id != transaction.owner.crypto_session_id)
    {
        return Err(PersistenceError::IdentityMismatch);
    }
    Ok(record)
}

fn read_accepted_in_transaction(
    transaction: &NativeGroupTransaction<'_>,
    operation_id: Id,
) -> Result<Option<AcceptedMessageRecord>, PersistenceError> {
    let write = transaction
        .write
        .as_ref()
        .ok_or(PersistenceError::Storage)?;
    let table = write.open_table(ACCEPTED).map_err(map_table_error)?;
    let record = table
        .get(operation_id.as_slice())
        .map_err(map_storage_error)?
        .map(|value| decode_accepted(value.value()))
        .transpose()?;
    if let Some(record) = &record
        && (record.operation_id != operation_id
            || record.crypto_session_id != transaction.owner.crypto_session_id)
    {
        return Err(PersistenceError::IdentityMismatch);
    }
    Ok(record)
}

fn validate_operation_binding(
    operation: &CommittedOperation,
    operation_id: Id,
    crypto_session_id: Id,
) -> Result<(), PersistenceError> {
    let (stored_operation_id, stored_session_id) = match operation {
        CommittedOperation::Envelope(record) | CommittedOperation::OutboxAcknowledged(record) => {
            (record.operation_id, record.crypto_session_id)
        }
        CommittedOperation::Accepted(record) | CommittedOperation::ReceiveAcknowledged(record) => {
            (record.operation_id, record.crypto_session_id)
        }
        CommittedOperation::Pairing(record) => (record.operation_id, record.crypto_session_id),
    };
    if stored_operation_id != operation_id || stored_session_id != crypto_session_id {
        return Err(PersistenceError::IdentityMismatch);
    }
    Ok(())
}

fn encode_pairing_operation(record: &PairingOperationRecord) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + 16 + 1 + 1 + 48);
    out.extend_from_slice(&record.operation_id);
    out.extend_from_slice(&record.crypto_session_id);
    out.push(record.kind);
    out.push(record.outcome);
    out.extend_from_slice(&record.artifact_hash);
    out
}

fn decode_pairing_operation(bytes: &[u8]) -> Result<PairingOperationRecord, PersistenceError> {
    let mut cursor = BinaryCursor::new(bytes);
    let record = PairingOperationRecord {
        operation_id: cursor.array()?,
        crypto_session_id: cursor.array()?,
        kind: cursor.u8()?,
        outcome: cursor.u8()?,
        artifact_hash: cursor.array()?,
    };
    cursor.finish()?;
    if record.crypto_session_id == [0; 16] {
        return Err(PersistenceError::Corrupt);
    }
    pairing_lifecycle::validate_pairing_operation_kind(record.kind, record.outcome)?;
    Ok(record)
}

#[cfg(test)]
pub(crate) fn validate_pairing_operation_discriminants_for_test(
    kind: u8,
    outcome: u8,
) -> Result<(), PersistenceError> {
    pairing_lifecycle::validate_pairing_operation_kind(kind, outcome)
}

/// `operations_v1` value: the version-2 witness operation index followed by the bounded legacy
/// record locator that identifies which outbox, accepted-message, or pairing rows belong to it.
fn encode_operation_index(
    index: &WitnessOperationIndex,
    operation: &CommittedOperation,
) -> Result<Vec<u8>, PersistenceError> {
    let (kind, result) = match operation {
        CommittedOperation::Envelope(record) => (1, encode_outbox(record)?),
        CommittedOperation::Accepted(record) => (2, encode_accepted(record)),
        CommittedOperation::OutboxAcknowledged(record) => (3, encode_outbox(record)?),
        CommittedOperation::ReceiveAcknowledged(record) => (4, encode_accepted(record)),
        CommittedOperation::Pairing(record) => (5, encode_pairing_operation(record)),
    };
    let mut out = index.encode()?;
    out.push(kind);
    put_bytes(&mut out, &result)?;
    Ok(out)
}

fn decode_operation_index(
    bytes: &[u8],
) -> Result<(WitnessOperationIndex, CommittedOperation), PersistenceError> {
    let (index, consumed) = WitnessOperationIndex::decode_prefix(bytes)?;
    let mut cursor = BinaryCursor::new(bytes.get(consumed..).ok_or(PersistenceError::Corrupt)?);
    let kind = cursor.u8()?;
    let result = cursor.bytes()?;
    cursor.finish()?;
    let operation = match kind {
        1 => CommittedOperation::Envelope(decode_outbox(result)?),
        2 => CommittedOperation::Accepted(decode_accepted(result)?),
        3 => CommittedOperation::OutboxAcknowledged(decode_outbox(result)?),
        4 => CommittedOperation::ReceiveAcknowledged(decode_accepted(result)?),
        5 => CommittedOperation::Pairing(decode_pairing_operation(result)?),
        _ => return Err(PersistenceError::Corrupt),
    };
    Ok((index, operation))
}

fn decode_operation(bytes: &[u8]) -> Result<CommittedOperation, PersistenceError> {
    decode_operation_index(bytes).map(|(_, operation)| operation)
}

fn decode_operation_generation(bytes: &[u8]) -> Result<u64, PersistenceError> {
    decode_operation_index(bytes).map(|(index, _)| index.generation)
}

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), PersistenceError> {
    let len = u32::try_from(bytes.len()).map_err(|_| PersistenceError::Corrupt)?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

struct BinaryCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> BinaryCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    fn take(&mut self, len: usize) -> Result<&'a [u8], PersistenceError> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or(PersistenceError::Corrupt)?;
        let result = self
            .bytes
            .get(self.offset..end)
            .ok_or(PersistenceError::Corrupt)?;
        self.offset = end;
        Ok(result)
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
    fn bytes(&mut self) -> Result<&'a [u8], PersistenceError> {
        let len = self.u32()? as usize;
        self.take(len)
    }
    fn finish(self) -> Result<(), PersistenceError> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(PersistenceError::Corrupt)
        }
    }
}

fn read_bytes(
    table: &impl ReadableTable<u8, &'static [u8]>,
    key: u8,
) -> Result<Vec<u8>, PersistenceError> {
    let value = table
        .get(key)
        .map_err(map_storage_error)?
        .ok_or(PersistenceError::Corrupt)?;
    Ok(value.value().to_vec())
}

fn read_u16(
    table: &impl ReadableTable<u8, &'static [u8]>,
    key: u8,
) -> Result<u16, PersistenceError> {
    let bytes = table
        .get(key)
        .map_err(map_storage_error)?
        .ok_or(PersistenceError::Corrupt)?;
    Ok(u16::from_be_bytes(
        bytes
            .value()
            .try_into()
            .map_err(|_| PersistenceError::Corrupt)?,
    ))
}

fn read_u64(
    table: &impl ReadableTable<u8, &'static [u8]>,
    key: u8,
) -> Result<u64, PersistenceError> {
    let bytes = table
        .get(key)
        .map_err(map_storage_error)?
        .ok_or(PersistenceError::Corrupt)?;
    Ok(u64::from_be_bytes(
        bytes
            .value()
            .try_into()
            .map_err(|_| PersistenceError::Corrupt)?,
    ))
}

fn hex_id(id: Id) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(32);
    for byte in id {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn map_database_error(_error: redb::DatabaseError) -> PersistenceError {
    PersistenceError::Corrupt
}
fn map_transaction_error(_error: redb::TransactionError) -> PersistenceError {
    PersistenceError::Storage
}
fn map_table_error(_error: redb::TableError) -> PersistenceError {
    PersistenceError::Corrupt
}
fn map_storage_error(_error: redb::StorageError) -> PersistenceError {
    PersistenceError::Storage
}
