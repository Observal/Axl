// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

//! Native durable storage for the endpoint E2EE core.
//!
//! One database is permanently bound to one crypto session. Database values contain encrypted
//! OpenMLS storage images, exact ciphertext, and non-secret routing-independent metadata. Wrapping
//! keys and rollback anchors are supplied by the platform and never enter redb.

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

use crate::{
    Clock, CommitMetadata, CoreProvider, Daemon, Endpoint, Error as CoreError, GroupTransaction,
    Id, Identity, MAX_PAST_EPOCHS, MessageClass, PROFILE_ID, PROFILE_REVISION, PairContext,
    PairWelcome, Phone, PhoneKeyPackage, PreparedEnvelope, Role, SUITE, SystemClock,
    TransactionalProvider,
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
pub use pairing_lifecycle::{
    ActivationAcceptance, ActivationOutcome, ClaimFailure, ClaimSubmission,
    DurablePendingInvitation, DurablePreJoinDevice, EpochReadyAcceptance, InvitationLifecycle,
    InvitationPublication, PairLifecycle, PreJoinLifecycle, PreJoinPublication, RePairRequirement,
    RemovalOutcome, ReservationIntent, ReservationOutcome, WelcomeOutcome, WelcomePublication,
};

/// Current Axl native E2EE storage schema.
pub const STORAGE_SCHEMA_VERSION: u16 = 1;
const STATE_FORMAT_VERSION: u16 = 1;
const MAX_STATE_ENTRIES: usize = 8192;
const MAX_STATE_BYTES: usize = 16 * 1024 * 1024;
const STATE_AAD_LABEL: &[u8] = b"Axl encrypted OpenMLS state v1";

const META: TableDefinition<u8, &[u8]> = TableDefinition::new("metadata_v1");
const STATE: TableDefinition<u8, &[u8]> = TableDefinition::new("encrypted_state_v1");
const OPERATIONS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("operations_v1");
const OUTBOX: TableDefinition<&[u8], &[u8]> = TableDefinition::new("outbox_v1");
const ACCEPTED: TableDefinition<&[u8], &[u8]> = TableDefinition::new("accepted_messages_v1");

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
const LIFECYCLE_INITIALIZING: u8 = 1;
const LIFECYCLE_READY: u8 = 2;
const STATE_CURRENT: u8 = 1;
const ENDPOINT_METADATA_KEY: &[u8] = b"\0axl-endpoint-metadata-v1";
const PENDING_PLAINTEXT_PREFIX: &[u8] = b"\0axl-pending-plaintext-v1";
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
    DuringWrappingRecordReplacement,
    DuringWrappingRecordErasure,
    DuringCurrentKeyActivation,
    DuringPreparedKeyReconciliation,
    BeforeAnchorRecovery,
    AfterAnchorRecoveryBeforeErasure,
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

/// State held outside the redb snapshot domain by a monotonic platform service.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RollbackState {
    pub counter: u64,
    pub epoch: u64,
    pub epoch_authenticator: Vec<u8>,
}

/// Platform-owned monotonic rollback anchor.
pub trait RollbackAnchor: Send + Sync {
    fn available(&self) -> bool;
    fn read(&self, crypto_session_id: Id) -> Result<RollbackState, PersistenceError>;
    fn advance(
        &self,
        crypto_session_id: Id,
        expected: &RollbackState,
        next: &RollbackState,
        operation_id: Id,
    ) -> Result<(), PersistenceError>;
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
    AnchorUnavailable,
    Conflict,
    Corrupt,
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

/// Native transactional provider backed by one redb file per pairwise group.
pub(crate) struct NativeTransactionalProvider {
    path: PathBuf,
    initialization_marker: PathBuf,
    crypto_session_id: Id,
    lifecycle_claim: Mutex<Option<SessionLifecycleClaim>>,
    database: Mutex<Option<Database>>,
    operation_lock: Mutex<()>,
    envelope_keys: Arc<dyn EnvelopeKeyStore>,
    rollback_anchor: Arc<dyn RollbackAnchor>,
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
        rollback_anchor: Arc<dyn RollbackAnchor>,
        faults: Arc<dyn FaultInjector>,
        clock: Arc<dyn Clock>,
    ) -> Result<Arc<Self>, PersistenceError> {
        require_dependencies(&*envelope_keys, &*rollback_anchor)?;
        let initial_anchor = rollback_anchor.read(crypto_session_id)?;
        if initial_anchor
            != (RollbackState {
                counter: 0,
                epoch: 0,
                epoch_authenticator: Vec::new(),
            })
        {
            return Err(PersistenceError::IdentityMismatch);
        }
        let root = prepare_storage_root(root, true)?;
        let lifecycle_claim = acquire_session_lifecycle_claim(&root, crypto_session_id)?;
        let path = database_path(&root, crypto_session_id, true, Some(&*faults))?;
        let database = Database::create(&path).map_err(map_database_error)?;
        restrict_file(&path)?;
        let initialization_marker = initializing_marker_for_database(&path);
        let this = Arc::new(Self {
            path,
            initialization_marker,
            crypto_session_id,
            lifecycle_claim: Mutex::new(Some(lifecycle_claim)),
            database: Mutex::new(Some(database)),
            operation_lock: Mutex::new(()),
            envelope_keys,
            rollback_anchor,
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
        rollback_anchor: Arc<dyn RollbackAnchor>,
        faults: Arc<dyn FaultInjector>,
        clock: Arc<dyn Clock>,
    ) -> Result<Arc<Self>, PersistenceError> {
        require_dependencies(&*envelope_keys, &*rollback_anchor)?;
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
        } else if lifecycle != LIFECYCLE_READY {
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
            rollback_anchor,
            faults,
            clock,
        });
        this.recover_storage()?;
        if lifecycle == LIFECYCLE_READY {
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

    fn finish_opening(&self) -> Result<(), PersistenceError> {
        let lifecycle = {
            let database = self.database_lock()?;
            let database = database.as_ref().ok_or(PersistenceError::Storage)?;
            inspect_database_lifecycle(database, self.crypto_session_id)?
        };
        if lifecycle == LIFECYCLE_INITIALIZING {
            self.mark_ready()
        } else if lifecycle == LIFECYCLE_READY {
            self.remove_stale_initialization_marker()?;
            self.release_lifecycle_claim()
        } else {
            Err(PersistenceError::Corrupt)
        }
    }

    fn release_lifecycle_claim(&self) -> Result<(), PersistenceError> {
        self.lifecycle_claim
            .lock()
            .map_err(|_| PersistenceError::Storage)?
            .take();
        Ok(())
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
        sync_parent_directory(&self.path)?;
        self.release_lifecycle_claim()
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
            [LIFECYCLE_READY] => Ok(()),
            [LIFECYCLE_INITIALIZING] => Err(PersistenceError::InitializationIncomplete),
            _ => Err(PersistenceError::Corrupt),
        }
    }

    #[cfg(test)]
    pub(crate) fn crypto_session_id(&self) -> Id {
        self.crypto_session_id
    }

    #[cfg(test)]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Close the database handle. Existing transactions retain their own engine handle and must
    /// finish before a reopen is attempted.
    pub(crate) fn close(&self) -> Result<(), PersistenceError> {
        *self
            .database
            .lock()
            .map_err(|_| PersistenceError::Storage)? = None;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn reopen(&self) -> Result<(), PersistenceError> {
        self.faults.check(FaultPoint::DuringRestartReload)?;
        self.reopen_database_only()?;
        self.recover_storage()?;
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

    fn recover_storage(&self) -> Result<(), PersistenceError> {
        require_dependencies(&*self.envelope_keys, &*self.rollback_anchor)?;
        self.validate_binding()?;
        self.faults
            .check(FaultPoint::DuringPreparedKeyReconciliation)?;
        self.activate_and_validate_current_state()?;
        self.reconcile_anchor_only()?;
        self.finish_pending_erasure()
    }

    pub(crate) fn generation(&self) -> Result<u64, PersistenceError> {
        self.read_u64_meta(META_GENERATION)
    }

    pub(crate) fn rollback_counter(&self) -> Result<u64, PersistenceError> {
        self.read_u64_meta(META_ROLLBACK_COUNTER)
    }

    #[cfg(test)]
    pub(crate) fn rollback_state(&self) -> Result<RollbackState, PersistenceError> {
        self.database_rollback_state()
    }

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
            if record.retry_state == RetryState::Pending {
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
            write.open_table(STATE).map_err(map_table_error)?;
            write.open_table(OPERATIONS).map_err(map_table_error)?;
            write.open_table(OUTBOX).map_err(map_table_error)?;
            write.open_table(ACCEPTED).map_err(map_table_error)?;
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
        Ok(())
    }

    fn activate_and_validate_current_state(&self) -> Result<(), PersistenceError> {
        let database = self.database_lock()?;
        let read = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_read()
            .map_err(map_transaction_error)?;
        let meta = read.open_table(META).map_err(map_table_error)?;
        let generation = read_u64(&meta, META_GENERATION)?;
        let rollback_counter = read_u64(&meta, META_ROLLBACK_COUNTER)?;
        let epoch = read_u64(&meta, META_EPOCH)?;
        drop(meta);
        let state = read.open_table(STATE).map_err(map_table_error)?;
        let state_blob = state
            .get(STATE_CURRENT)
            .map_err(map_storage_error)?
            .map(|value| value.value().to_vec());
        drop(state);
        let Some(blob) = state_blob else {
            self.envelope_keys
                .reconcile_prepared(self.crypto_session_id, None)?;
            return Ok(());
        };
        let sealed = SealedState::decode(&blob)?;
        let aad = state_aad(self.crypto_session_id, generation, rollback_counter, epoch);
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
        key.fill(0);
        let values = decode_storage_image(&decrypted.map_err(|_| PersistenceError::Corrupt)?)?;
        let expected_manifest = values
            .get(DURABLE_MANIFEST_KEY)
            .ok_or(PersistenceError::Corrupt)?;
        let actual_manifest = durable_manifest_read(&read, crypto.crypto())?;
        if expected_manifest.as_slice() != actual_manifest {
            return Err(PersistenceError::Quarantined);
        }
        Ok(())
    }

    fn reconcile_anchor_only(&self) -> Result<(), PersistenceError> {
        if !self.rollback_anchor.available() {
            return Err(PersistenceError::AnchorUnavailable);
        }
        let database_state = self.database_rollback_state()?;
        let anchor_state = self.rollback_anchor.read(self.crypto_session_id)?;
        if database_state == anchor_state {
            return Ok(());
        }
        if database_state.counter == anchor_state.counter.saturating_add(1) {
            let operation_id = self
                .latest_operation_id()?
                .ok_or(PersistenceError::Corrupt)?;
            self.faults.check(FaultPoint::BeforeAnchorRecovery)?;
            self.rollback_anchor.advance(
                self.crypto_session_id,
                &anchor_state,
                &database_state,
                operation_id,
            )?;
            self.faults
                .check(FaultPoint::AfterAnchorRecoveryBeforeErasure)?;
            return Ok(());
        }
        Err(PersistenceError::Quarantined)
    }

    fn finish_pending_erasure(&self) -> Result<(), PersistenceError> {
        let pending = {
            let database = self.database_lock()?;
            let read = database
                .as_ref()
                .ok_or(PersistenceError::Storage)?
                .begin_read()
                .map_err(map_transaction_error)?;
            let meta = read.open_table(META).map_err(map_table_error)?;
            read_bytes(&meta, META_PENDING_ERASE)?
        };
        if pending.is_empty() {
            return Ok(());
        }
        let key_id: [u8; 16] = pending.try_into().map_err(|_| PersistenceError::Corrupt)?;
        let current_key_id = {
            let database = self.database_lock()?;
            let read = database
                .as_ref()
                .ok_or(PersistenceError::Storage)?
                .begin_read()
                .map_err(map_transaction_error)?;
            let state = read.open_table(STATE).map_err(map_table_error)?;
            state
                .get(STATE_CURRENT)
                .map_err(map_storage_error)?
                .map(|value| SealedState::decode(value.value()).map(|sealed| sealed.key_id))
                .transpose()?
        };
        if current_key_id == Some(key_id) {
            return Err(PersistenceError::Quarantined);
        }
        self.faults.check(FaultPoint::DuringWrappingRecordErasure)?;
        self.envelope_keys.erase(self.crypto_session_id, key_id)
    }

    fn latest_operation_id(&self) -> Result<Option<Id>, PersistenceError> {
        let database = self.database_lock()?;
        let read = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_read()
            .map_err(map_transaction_error)?;
        let table = read.open_table(OPERATIONS).map_err(map_table_error)?;
        let mut latest: Option<(u64, Id)> = None;
        for entry in table.iter().map_err(map_storage_error)? {
            let (key, value) = entry.map_err(map_storage_error)?;
            let generation = decode_operation_generation(value.value())?;
            let id: Id = key
                .value()
                .try_into()
                .map_err(|_| PersistenceError::Corrupt)?;
            let operation = decode_operation(value.value())?;
            validate_operation_binding(&operation, id, self.crypto_session_id)?;
            if latest.is_none_or(|(current, _)| generation > current) {
                latest = Some((generation, id));
            }
        }
        Ok(latest.map(|(_, id)| id))
    }

    fn database_rollback_state(&self) -> Result<RollbackState, PersistenceError> {
        let database = self.database_lock()?;
        let read = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_read()
            .map_err(map_transaction_error)?;
        let meta = read.open_table(META).map_err(map_table_error)?;
        Ok(RollbackState {
            counter: read_u64(&meta, META_ROLLBACK_COUNTER)?,
            epoch: read_u64(&meta, META_EPOCH)?,
            epoch_authenticator: read_bytes(&meta, META_EPOCH_AUTHENTICATOR)?.to_vec(),
        })
    }

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

    fn recover_uncertain(
        &self,
        operation_id: Id,
        prepared_key: Option<[u8; 16]>,
    ) -> Result<CommittedOperation, PersistenceError> {
        self.close()?;
        self.reopen_database_only()?;
        self.recover_storage()?;
        if let Some(operation) = self.operation(operation_id)? {
            return Ok(operation);
        }
        if let Some(key_id) = prepared_key {
            self.faults.check(FaultPoint::DuringWrappingRecordErasure)?;
            self.envelope_keys.erase(self.crypto_session_id, key_id)?;
        }
        Err(PersistenceError::Storage)
    }
}

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
        self.recover_storage()?;
        if crypto_session_id != self.crypto_session_id {
            return Err(PersistenceError::IdentityMismatch);
        }
        require_dependencies(&*self.envelope_keys, &*self.rollback_anchor)?;
        let database = self.database_lock()?;
        let mut write = database
            .as_ref()
            .ok_or(PersistenceError::Storage)?
            .begin_write()
            .map_err(map_transaction_error)?;
        configure_transaction(&mut write)?;
        let (generation, rollback_counter, epoch, authenticator, state_blob) = {
            let meta = write.open_table(META).map_err(map_table_error)?;
            let generation = read_u64(&meta, META_GENERATION)?;
            let rollback_counter = read_u64(&meta, META_ROLLBACK_COUNTER)?;
            if generation != expected_generation || rollback_counter != expected_rollback_counter {
                self.faults.check(FaultPoint::DuringGenerationConflict)?;
                return Err(PersistenceError::GenerationConflict);
            }
            let epoch = read_u64(&meta, META_EPOCH)?;
            let authenticator = read_bytes(&meta, META_EPOCH_AUTHENTICATOR)?.to_vec();
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
                state_blob,
            )
        };
        let anchor = self.rollback_anchor.read(self.crypto_session_id)?;
        if anchor.counter != rollback_counter
            || anchor.epoch != epoch
            || anchor.epoch_authenticator != authenticator
        {
            return Err(PersistenceError::Quarantined);
        }
        let (provider, old_key_id) = if let Some(blob) = state_blob {
            let sealed = SealedState::decode(&blob)?;
            let aad = state_aad(self.crypto_session_id, generation, rollback_counter, epoch);
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
    /// Bind an idempotency key and canonical input hash before mutation.
    fn bind_operation(
        &mut self,
        operation_id: Id,
        fingerprint: [u8; 48],
    ) -> Result<Option<CommittedOperation>, PersistenceError> {
        let write = self.write.as_ref().ok_or(PersistenceError::Storage)?;
        let table = write.open_table(OPERATIONS).map_err(map_table_error)?;
        let existing = table
            .get(operation_id.as_slice())
            .map_err(map_storage_error)?
            .map(|value| value.value().to_vec());
        drop(table);
        if let Some(bytes) = existing {
            self.owner
                .faults
                .check(FaultPoint::DuringDuplicateOperation)?;
            let (stored_fingerprint, operation) = decode_operation_with_fingerprint(&bytes)?;
            validate_operation_binding(&operation, operation_id, self.owner.crypto_session_id)?;
            if stored_fingerprint != fingerprint {
                return Err(PersistenceError::Conflict);
            }
            return Ok(Some(operation));
        }
        self.operation_id = Some(operation_id);
        self.operation_fingerprint = Some(fingerprint);
        Ok(None)
    }

    fn set_successor_epoch(&mut self, epoch: u64, authenticator: &[u8]) {
        self.next_epoch = epoch;
        self.next_authenticator.clear();
        self.next_authenticator.extend_from_slice(authenticator);
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
        let (fingerprint, generation, existing) = decode_operation_record(bytes.value())?;
        validate_operation_binding(&existing, operation_id, self.owner.crypto_session_id)?;
        drop(bytes);
        drop(table);
        self.operation_updates.push((
            operation_id,
            encode_operation(fingerprint, generation, &operation)?,
        ));
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

    fn commit_inner(mut self) -> Result<CommittedOperation, PersistenceError> {
        let operation_id = self.operation_id.ok_or(PersistenceError::Conflict)?;
        let fingerprint = self
            .operation_fingerprint
            .ok_or(PersistenceError::Conflict)?;
        let operation = self.staged.clone().ok_or(PersistenceError::Conflict)?;
        let next_generation = self
            .expected_generation
            .checked_add(1)
            .ok_or(PersistenceError::Corrupt)?;
        let next_counter = self
            .expected_rollback_counter
            .checked_add(1)
            .ok_or(PersistenceError::Corrupt)?;

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
        {
            let write = self.write()?;
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
            let bytes = encode_operation(fingerprint, next_generation, &operation)?;
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
        }
        self.owner
            .faults
            .check(FaultPoint::AfterCiphertextInsertion)?;
        prune_durable_records(self.write()?, next_generation)?;
        let manifest_crypto = CoreProvider::new().map_err(|_| PersistenceError::Storage)?;
        let manifest = durable_manifest(self.write()?, manifest_crypto.crypto())?;
        self.provider
            .insert_internal(DURABLE_MANIFEST_KEY.to_vec(), manifest.to_vec());

        let plaintext = encode_storage_image(&self.provider.storage_values())?;
        let crypto = self.provider.crypto();
        let mut data_key = self
            .provider
            .rand()
            .random_array::<32>()
            .map_err(|_| PersistenceError::Storage)?;
        let key_id = self
            .provider
            .rand()
            .random_array::<16>()
            .map_err(|_| PersistenceError::Storage)?;
        let nonce = self
            .provider
            .rand()
            .random_array::<12>()
            .map_err(|_| PersistenceError::Storage)?;
        let aad = state_aad(
            self.owner.crypto_session_id,
            next_generation,
            next_counter,
            self.next_epoch,
        );
        self.owner
            .envelope_keys
            .prepare(self.owner.crypto_session_id, key_id, &data_key, &aad)?;
        self.prepared_key_id = Some(key_id);
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
        {
            let write = self.write()?;
            let mut state = write.open_table(STATE).map_err(map_table_error)?;
            state
                .insert(STATE_CURRENT, sealed.as_slice())
                .map_err(map_storage_error)?;
        }
        self.owner.faults.check(FaultPoint::BeforeCommit)?;
        let write = self.write.take().ok_or(PersistenceError::Storage)?;
        self.prepared_key_id = None;
        if write.commit().is_err() {
            return self.owner.recover_uncertain(operation_id, Some(key_id));
        }
        self.owner
            .faults
            .check(FaultPoint::DuringCurrentKeyActivation)?;
        self.owner
            .envelope_keys
            .activate(self.owner.crypto_session_id, key_id, &aad)
            .map_err(map_current_key_error)?;
        if self
            .owner
            .faults
            .check(FaultPoint::AfterDurableCommit)
            .is_err()
        {
            return self.owner.recover_uncertain(operation_id, None);
        }
        let expected_anchor = RollbackState {
            counter: self.expected_rollback_counter,
            epoch: self.old_epoch,
            epoch_authenticator: self.old_authenticator.clone(),
        };
        let next_anchor = RollbackState {
            counter: next_counter,
            epoch: self.next_epoch,
            epoch_authenticator: self.next_authenticator.clone(),
        };
        self.owner.faults.check(FaultPoint::BeforeAnchorRecovery)?;
        self.owner.rollback_anchor.advance(
            self.owner.crypto_session_id,
            &expected_anchor,
            &next_anchor,
            operation_id,
        )?;
        self.owner
            .faults
            .check(FaultPoint::AfterAnchorRecoveryBeforeErasure)?;
        if self.old_key_id.is_some() {
            self.owner
                .faults
                .check(FaultPoint::DuringWrappingRecordReplacement)?;
            self.owner.finish_pending_erasure()?;
        }
        Ok(operation)
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

impl NativeGroupTransaction<'_> {
    fn commit_operation(self) -> Result<CommittedOperation, PersistenceError> {
        self.commit_inner()
    }
}

/// Durable daemon endpoint. Every method reloads committed MLS state after opening its redb
/// transaction; no `MlsGroup` survives a failed or completed operation.
#[derive(Clone)]
pub(crate) struct DurableDaemon {
    store: Arc<NativeTransactionalProvider>,
}

/// Durable phone endpoint with the same transaction and reload guarantees as [`DurableDaemon`].
#[derive(Clone)]
pub(crate) struct DurablePhone {
    store: Arc<NativeTransactionalProvider>,
}

/// Plaintext released only after receive-state and accepted-message commit complete.
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

#[allow(dead_code)]
impl DurableDaemon {
    pub fn create(
        root: &Path,
        identity: Identity,
        context: PairContext,
        operation_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        rollback_anchor: Arc<dyn RollbackAnchor>,
    ) -> Result<Self, PersistenceError> {
        Self::create_with_runtime(
            root,
            identity,
            context,
            operation_id,
            envelope_keys,
            rollback_anchor,
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
        rollback_anchor: Arc<dyn RollbackAnchor>,
        runtime: RuntimeHooks,
    ) -> Result<Self, PersistenceError> {
        let store = NativeTransactionalProvider::create(
            root,
            context.crypto_session_id,
            envelope_keys,
            rollback_anchor,
            runtime.faults,
            runtime.clock,
        )?;
        let mut transaction = store.begin_transaction(context.crypto_session_id, 0, 0)?;
        transaction.bind_operation(operation_id, operation_fingerprint(1, &[])?)?;
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
        transaction.commit_operation()?;
        store.faults.check(FaultPoint::BeforeInitializationReady)?;
        store.mark_ready()?;
        Ok(Self { store })
    }

    pub fn open(
        root: &Path,
        crypto_session_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        rollback_anchor: Arc<dyn RollbackAnchor>,
    ) -> Result<Self, PersistenceError> {
        Self::open_with_runtime(
            root,
            crypto_session_id,
            envelope_keys,
            rollback_anchor,
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
        rollback_anchor: Arc<dyn RollbackAnchor>,
        runtime: RuntimeHooks,
    ) -> Result<Self, PersistenceError> {
        let store = NativeTransactionalProvider::open(
            root,
            crypto_session_id,
            envelope_keys,
            rollback_anchor,
            runtime.faults,
            runtime.clock,
        )?;
        // Loading inside a read-write transaction validates all committed OpenMLS and signer state.
        let generation = store.generation()?;
        let rollback = store.rollback_counter()?;
        let transaction = store.begin_transaction(crypto_session_id, generation, rollback)?;
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

    pub fn consume_key_package(
        &mut self,
        operation_id: Id,
        package: PhoneKeyPackage,
    ) -> Result<PairWelcome, PersistenceError> {
        let fingerprint = operation_fingerprint(2, package.bytes())?;
        let mut transaction = self.begin_current()?;
        if let Some(existing) = transaction.bind_operation(operation_id, fingerprint)? {
            transaction.rollback()?;
            return welcome_from_operation(existing, transaction_metadata_from_store(&self.store)?);
        }
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
        transaction.commit_operation()?;
        self.store
            .faults
            .check(FaultPoint::AfterCommitBeforeNetworkSend)?;
        Ok(welcome)
    }

    pub fn prepare_application(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        plaintext: &[u8],
    ) -> Result<OutboxRecord, PersistenceError> {
        self.send_operation(
            operation_id,
            operation_fingerprint_parts(
                3,
                &[
                    &logical_message_id,
                    &hosted_generation.to_be_bytes(),
                    plaintext,
                ],
            )?,
            |daemon| daemon.prepare_application(logical_message_id, hosted_generation, plaintext),
        )
    }

    pub fn receive_application(
        &mut self,
        operation_id: Id,
        ciphertext: &[u8],
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<DurablePlaintext, PersistenceError> {
        self.receive_operation(
            operation_id,
            operation_fingerprint_parts(
                4,
                &[
                    &logical_message_id,
                    &hosted_generation.to_be_bytes(),
                    ciphertext,
                ],
            )?,
            MessageClass::ApplicationRequest,
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
    ) -> Result<AcceptedMessageRecord, PersistenceError> {
        let fingerprint = operation_fingerprint_parts(
            5,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                ciphertext,
            ],
        )?;
        let mut transaction = self.begin_current()?;
        if let Some(existing) = transaction.bind_operation(operation_id, fingerprint)? {
            transaction.rollback()?;
            return match existing {
                CommittedOperation::Accepted(record) => Ok(record),
                _ => Err(PersistenceError::Conflict),
            };
        }
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
        transaction.commit_operation()?;
        Ok(record)
    }

    pub fn acknowledge_receive(
        &mut self,
        acknowledgement_operation_id: Id,
        receive_operation_id: Id,
    ) -> Result<AcceptedMessageRecord, PersistenceError> {
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
    ) -> Result<OutboxRecord, PersistenceError> {
        acknowledge_outbox(
            &self.store,
            acknowledgement_operation_id,
            outbox_operation_id,
        )
    }

    pub fn prepare_resync_control(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        plaintext: &[u8],
    ) -> Result<OutboxRecord, PersistenceError> {
        self.send_operation(
            operation_id,
            operation_fingerprint_parts(
                30,
                &[
                    &logical_message_id,
                    &hosted_generation.to_be_bytes(),
                    plaintext,
                ],
            )?,
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
    ) -> Result<OutboxRecord, PersistenceError> {
        self.send_operation(
            operation_id,
            operation_fingerprint_parts(
                6,
                &[&logical_message_id, &hosted_generation.to_be_bytes()],
            )?,
            |daemon| daemon.prepare_commit(logical_message_id, hosted_generation),
        )
    }

    fn begin_current(&self) -> Result<NativeGroupTransaction<'_>, PersistenceError> {
        begin_current(&self.store)
    }

    fn send_operation(
        &mut self,
        operation_id: Id,
        fingerprint: [u8; 48],
        operation: impl FnOnce(&mut Daemon) -> Result<PreparedEnvelope, CoreError>,
    ) -> Result<OutboxRecord, PersistenceError> {
        let mut transaction = self.begin_current()?;
        if let Some(existing) = transaction.bind_operation(operation_id, fingerprint)? {
            transaction.rollback()?;
            return match existing {
                CommittedOperation::Envelope(record) => Ok(record),
                _ => Err(PersistenceError::Conflict),
            };
        }
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
        let committed = transaction.commit_operation()?;
        self.store
            .faults
            .check(FaultPoint::AfterCommitBeforeNetworkSend)?;
        match committed {
            CommittedOperation::Envelope(record) => Ok(record),
            _ => Err(PersistenceError::Corrupt),
        }
    }

    fn receive_operation(
        &mut self,
        operation_id: Id,
        fingerprint: [u8; 48],
        class: MessageClass,
        operation: impl FnOnce(&mut Daemon) -> Result<crate::PreparedPlaintext, CoreError>,
    ) -> Result<DurablePlaintext, PersistenceError> {
        let mut transaction = self.begin_current()?;
        if let Some(existing) = transaction.bind_operation(operation_id, fingerprint)? {
            let plaintext = pending_plaintext(&transaction.provider, operation_id)?;
            transaction.rollback()?;
            return durable_plaintext(existing, plaintext);
        }
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
        daemon.endpoint.provider.insert_internal(
            pending_plaintext_key(operation_id),
            prepared.plaintext.to_vec(),
        );
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
        transaction.stage_accepted_record(record.clone())?;
        transaction.commit_operation()?;
        self.store
            .faults
            .check(FaultPoint::BeforeReceiverAcknowledgement)?;
        self.store
            .faults
            .check(FaultPoint::AfterAcknowledgementLoss)?;
        Ok(DurablePlaintext {
            operation_id,
            logical_message_id: prepared.logical_message_id,
            epoch: prepared.epoch,
            plaintext: prepared.plaintext.to_vec(),
        })
    }
}

#[allow(dead_code)]
impl DurablePhone {
    pub fn create(
        root: &Path,
        identity: Identity,
        crypto_session_id: Id,
        operation_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        rollback_anchor: Arc<dyn RollbackAnchor>,
    ) -> Result<(Self, PhoneKeyPackage), PersistenceError> {
        Self::create_with_runtime(
            root,
            identity,
            crypto_session_id,
            operation_id,
            envelope_keys,
            rollback_anchor,
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
        rollback_anchor: Arc<dyn RollbackAnchor>,
        runtime: RuntimeHooks,
    ) -> Result<(Self, PhoneKeyPackage), PersistenceError> {
        let store = NativeTransactionalProvider::create(
            root,
            crypto_session_id,
            envelope_keys,
            rollback_anchor,
            runtime.faults,
            runtime.clock,
        )?;
        let mut transaction = store.begin_transaction(crypto_session_id, 0, 0)?;
        transaction.bind_operation(operation_id, operation_fingerprint(10, &[])?)?;
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
        transaction.commit_operation()?;
        store.faults.check(FaultPoint::BeforeInitializationReady)?;
        store.mark_ready()?;
        Ok((Self { store }, package))
    }

    pub fn open(
        root: &Path,
        crypto_session_id: Id,
        envelope_keys: Arc<dyn EnvelopeKeyStore>,
        rollback_anchor: Arc<dyn RollbackAnchor>,
    ) -> Result<Self, PersistenceError> {
        Self::open_with_runtime(
            root,
            crypto_session_id,
            envelope_keys,
            rollback_anchor,
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
        rollback_anchor: Arc<dyn RollbackAnchor>,
        runtime: RuntimeHooks,
    ) -> Result<Self, PersistenceError> {
        let store = NativeTransactionalProvider::open(
            root,
            crypto_session_id,
            envelope_keys,
            rollback_anchor,
            runtime.faults,
            runtime.clock,
        )?;
        let transaction = store.begin_transaction(
            crypto_session_id,
            store.generation()?,
            store.rollback_counter()?,
        )?;
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

    pub fn join(
        &mut self,
        operation_id: Id,
        welcome: PairWelcome,
        expected: &PairContext,
    ) -> Result<(), PersistenceError> {
        let fingerprint = operation_fingerprint(11, welcome.bytes())?;
        let mut transaction = self.begin_current()?;
        if transaction
            .bind_operation(operation_id, fingerprint)?
            .is_some()
        {
            transaction.rollback()?;
            return Ok(());
        }
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
        transaction.commit_operation()?;
        Ok(())
    }

    pub fn prepare_application(
        &mut self,
        operation_id: Id,
        logical_message_id: Id,
        hosted_generation: u64,
        plaintext: &[u8],
    ) -> Result<OutboxRecord, PersistenceError> {
        self.send_operation(
            operation_id,
            operation_fingerprint_parts(
                12,
                &[
                    &logical_message_id,
                    &hosted_generation.to_be_bytes(),
                    plaintext,
                ],
            )?,
            |phone| phone.prepare_application(logical_message_id, hosted_generation, plaintext),
        )
    }

    pub fn acknowledge_receive(
        &mut self,
        acknowledgement_operation_id: Id,
        receive_operation_id: Id,
    ) -> Result<AcceptedMessageRecord, PersistenceError> {
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
    ) -> Result<OutboxRecord, PersistenceError> {
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
    ) -> Result<OutboxRecord, PersistenceError> {
        self.send_operation(
            operation_id,
            operation_fingerprint_parts(
                13,
                &[&logical_message_id, &hosted_generation.to_be_bytes()],
            )?,
            |phone| phone.prepare_self_update(logical_message_id, hosted_generation),
        )
    }

    pub fn apply_commit(
        &mut self,
        operation_id: Id,
        ciphertext: &[u8],
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<AcceptedMessageRecord, PersistenceError> {
        let fingerprint = operation_fingerprint_parts(
            14,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                ciphertext,
            ],
        )?;
        let mut transaction = self.begin_current()?;
        if let Some(existing) = transaction.bind_operation(operation_id, fingerprint)? {
            transaction.rollback()?;
            return match existing {
                CommittedOperation::Accepted(record) => Ok(record),
                _ => Err(PersistenceError::Conflict),
            };
        }
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
        transaction.commit_operation()?;
        Ok(record)
    }

    pub fn receive_application(
        &mut self,
        operation_id: Id,
        ciphertext: &[u8],
        logical_message_id: Id,
        hosted_generation: u64,
    ) -> Result<DurablePlaintext, PersistenceError> {
        let fingerprint = operation_fingerprint_parts(
            15,
            &[
                &logical_message_id,
                &hosted_generation.to_be_bytes(),
                ciphertext,
            ],
        )?;
        let mut transaction = self.begin_current()?;
        if let Some(existing) = transaction.bind_operation(operation_id, fingerprint)? {
            let plaintext = pending_plaintext(&transaction.provider, operation_id)?;
            transaction.rollback()?;
            return durable_plaintext(existing, plaintext);
        }
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
        endpoint.provider.insert_internal(
            pending_plaintext_key(operation_id),
            prepared.plaintext.to_vec(),
        );
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
        transaction.commit_operation()?;
        self.store
            .faults
            .check(FaultPoint::BeforeReceiverAcknowledgement)?;
        self.store
            .faults
            .check(FaultPoint::AfterAcknowledgementLoss)?;
        Ok(DurablePlaintext {
            operation_id,
            logical_message_id: prepared.logical_message_id,
            epoch: prepared.epoch,
            plaintext: prepared.plaintext.to_vec(),
        })
    }

    fn begin_current(&self) -> Result<NativeGroupTransaction<'_>, PersistenceError> {
        begin_current(&self.store)
    }

    fn send_operation(
        &mut self,
        operation_id: Id,
        fingerprint: [u8; 48],
        operation: impl FnOnce(&mut Phone) -> Result<PreparedEnvelope, CoreError>,
    ) -> Result<OutboxRecord, PersistenceError> {
        let mut transaction = self.begin_current()?;
        if let Some(existing) = transaction.bind_operation(operation_id, fingerprint)? {
            transaction.rollback()?;
            return match existing {
                CommittedOperation::Envelope(record) => Ok(record),
                _ => Err(PersistenceError::Conflict),
            };
        }
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
        let committed = transaction.commit_operation()?;
        self.store
            .faults
            .check(FaultPoint::AfterCommitBeforeNetworkSend)?;
        match committed {
            CommittedOperation::Envelope(record) => Ok(record),
            _ => Err(PersistenceError::Corrupt),
        }
    }
}

fn begin_current(
    store: &Arc<NativeTransactionalProvider>,
) -> Result<NativeGroupTransaction<'_>, PersistenceError> {
    loop {
        let generation = store.generation()?;
        let rollback = store.rollback_counter()?;
        match store.begin_transaction(store.crypto_session_id, generation, rollback) {
            Err(PersistenceError::GenerationConflict) => continue,
            result => return result,
        }
    }
}

fn acknowledge_outbox(
    store: &Arc<NativeTransactionalProvider>,
    acknowledgement_operation_id: Id,
    outbox_operation_id: Id,
) -> Result<OutboxRecord, PersistenceError> {
    let fingerprint = operation_fingerprint_parts(19, &[&outbox_operation_id])?;
    let mut transaction = begin_current(store)?;
    if let Some(existing) = transaction.bind_operation(acknowledgement_operation_id, fingerprint)? {
        transaction.rollback()?;
        return match existing {
            CommittedOperation::OutboxAcknowledged(mut record) => {
                record.operation_id = outbox_operation_id;
                Ok(record)
            }
            _ => Err(PersistenceError::Conflict),
        };
    }
    let mut record = read_outbox_in_transaction(&transaction, outbox_operation_id)?
        .ok_or(PersistenceError::NotFound)?;
    if record.retry_state == RetryState::Acknowledged {
        return Err(PersistenceError::Conflict);
    }
    record.retry_state = RetryState::Acknowledged;
    transaction.update_operation(
        outbox_operation_id,
        CommittedOperation::Envelope(record.clone()),
    )?;
    transaction.set_successor_epoch(
        transaction.old_epoch,
        &transaction.old_authenticator.clone(),
    );
    transaction.update_outbox(outbox_operation_id, record.clone());
    let mut result = record.clone();
    result.operation_id = acknowledgement_operation_id;
    transaction.stage_operation(CommittedOperation::OutboxAcknowledged(result))?;
    transaction.commit_operation()?;
    Ok(record)
}

fn acknowledge_receive(
    store: &Arc<NativeTransactionalProvider>,
    acknowledgement_operation_id: Id,
    receive_operation_id: Id,
) -> Result<AcceptedMessageRecord, PersistenceError> {
    store
        .faults
        .check(FaultPoint::BeforeReceiverAcknowledgement)?;
    let fingerprint = operation_fingerprint_parts(20, &[&receive_operation_id])?;
    let mut transaction = begin_current(store)?;
    if let Some(existing) = transaction.bind_operation(acknowledgement_operation_id, fingerprint)? {
        transaction.rollback()?;
        return match existing {
            CommittedOperation::ReceiveAcknowledged(record) => Ok(record),
            _ => Err(PersistenceError::Conflict),
        };
    }
    let mut accepted = read_accepted_in_transaction(&transaction, receive_operation_id)?
        .ok_or(PersistenceError::NotFound)?;
    if accepted.acknowledged {
        return Err(PersistenceError::Conflict);
    }
    accepted.acknowledged = true;
    transaction.update_operation(
        receive_operation_id,
        CommittedOperation::Accepted(accepted.clone()),
    )?;
    transaction
        .provider
        .remove_internal(&pending_plaintext_key(receive_operation_id));
    transaction.set_successor_epoch(
        transaction.old_epoch,
        &transaction.old_authenticator.clone(),
    );
    transaction.update_accepted(receive_operation_id, accepted.clone());
    let acknowledgement = AcceptedMessageRecord {
        operation_id: acknowledgement_operation_id,
        ..accepted
    };
    transaction.stage_operation(CommittedOperation::ReceiveAcknowledged(
        acknowledgement.clone(),
    ))?;
    transaction.commit_operation()?;
    store.faults.check(FaultPoint::AfterAcknowledgementLoss)?;
    Ok(acknowledgement)
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

fn operation_fingerprint(kind: u8, bytes: &[u8]) -> Result<[u8; 48], PersistenceError> {
    operation_fingerprint_parts(kind, &[bytes])
}

fn operation_fingerprint_parts(kind: u8, parts: &[&[u8]]) -> Result<[u8; 48], PersistenceError> {
    let provider = CoreProvider::new().map_err(|_| PersistenceError::Storage)?;
    let mut input = vec![kind];
    for part in parts {
        put_bytes(&mut input, part)?;
    }
    provider
        .crypto()
        .hash(SUITE.hash_algorithm(), &input)
        .map_err(|_| PersistenceError::Storage)?
        .try_into()
        .map_err(|_| PersistenceError::Storage)
}

fn pending_plaintext_key(operation_id: Id) -> Vec<u8> {
    let mut key = PENDING_PLAINTEXT_PREFIX.to_vec();
    key.extend_from_slice(&operation_id);
    key
}

fn pending_plaintext(
    provider: &CoreProvider,
    operation_id: Id,
) -> Result<Vec<u8>, PersistenceError> {
    provider
        .internal(&pending_plaintext_key(operation_id))
        .ok_or(PersistenceError::AlreadyAcknowledged)
}

fn durable_plaintext(
    operation: CommittedOperation,
    plaintext: Vec<u8>,
) -> Result<DurablePlaintext, PersistenceError> {
    match operation {
        CommittedOperation::Accepted(record) => Ok(DurablePlaintext {
            operation_id: record.operation_id,
            logical_message_id: record.logical_message_id,
            epoch: record.epoch,
            plaintext,
        }),
        _ => Err(PersistenceError::Conflict),
    }
}

#[allow(dead_code)]
fn welcome_from_operation(
    operation: CommittedOperation,
    metadata: EndpointMetadata,
) -> Result<PairWelcome, PersistenceError> {
    let CommittedOperation::Envelope(record) = operation else {
        return Err(PersistenceError::Conflict);
    };
    Ok(PairWelcome {
        bytes: record.ciphertext.into_boxed_slice(),
        context: metadata.context.ok_or(PersistenceError::Corrupt)?,
        daemon_identity: metadata.identity,
        device_identity: metadata.peer,
    })
}

#[allow(dead_code)]
fn transaction_metadata_from_store(
    store: &Arc<NativeTransactionalProvider>,
) -> Result<EndpointMetadata, PersistenceError> {
    let transaction = store.begin_transaction(
        store.crypto_session_id,
        store.generation()?,
        store.rollback_counter()?,
    )?;
    let metadata = decode_endpoint_metadata(
        &transaction
            .provider
            .internal(ENDPOINT_METADATA_KEY)
            .ok_or(PersistenceError::Corrupt)?,
    )?;
    transaction.rollback()?;
    Ok(metadata)
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

fn require_dependencies(
    envelope_keys: &dyn EnvelopeKeyStore,
    rollback_anchor: &dyn RollbackAnchor,
) -> Result<(), PersistenceError> {
    if !envelope_keys.available() {
        return Err(PersistenceError::KeyUnavailable);
    }
    if !rollback_anchor.available() {
        return Err(PersistenceError::AnchorUnavailable);
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
        [lifecycle @ (LIFECYCLE_INITIALIZING | LIFECYCLE_READY)] => Ok(*lifecycle),
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

    if metadata_entries == 10
        && generation == 0
        && rollback_counter == 0
        && epoch == 0
        && authenticator.is_empty()
        && pending_erase.is_empty()
        && state_entries == 0
        && operation_entries == 0
        && outbox_entries == 0
        && accepted_entries == 0
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
        let (fingerprint, operation_generation, operation) =
            decode_operation_record(value.value())?;
        Some((
            key.value().to_vec(),
            fingerprint,
            operation_generation,
            operation,
        ))
    } else {
        None
    };

    let valid_creation_shape = match creation_operation {
        Some((key, fingerprint, 1, CommittedOperation::Envelope(record))) => {
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
                && fingerprint == operation_fingerprint(10, &[])?
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
        Some((key, fingerprint, 1, CommittedOperation::Accepted(record))) => {
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
                && fingerprint == operation_fingerprint(1, &[])?
                && record == initialized_record(record.operation_id, crypto_session_id)
                && persisted.as_ref() == Some(&record)
        }
        Some((key, _, 1, CommittedOperation::Pairing(record))) => {
            epoch == 0
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

    if metadata_entries == 10 && (group_state_candidate || initial_state_candidate) {
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

fn state_aad(session: Id, generation: u64, rollback: u64, epoch: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(STATE_AAD_LABEL.len() + 16 + 2 + 2 + 8 * 3);
    aad.extend_from_slice(STATE_AAD_LABEL);
    aad.extend_from_slice(&session);
    aad.extend_from_slice(&STORAGE_SCHEMA_VERSION.to_be_bytes());
    aad.extend_from_slice(&PROFILE_REVISION.to_be_bytes());
    aad.extend_from_slice(&generation.to_be_bytes());
    aad.extend_from_slice(&rollback.to_be_bytes());
    aad.extend_from_slice(&epoch.to_be_bytes());
    aad
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
) -> Result<(), PersistenceError> {
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
    for (key, operation) in remove {
        write
            .open_table(OPERATIONS)
            .map_err(map_table_error)?
            .remove(key.as_slice())
            .map_err(map_storage_error)?;
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
    Ok(())
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

fn encode_operation(
    fingerprint: [u8; 48],
    generation: u64,
    operation: &CommittedOperation,
) -> Result<Vec<u8>, PersistenceError> {
    let (kind, result) = match operation {
        CommittedOperation::Envelope(record) => (1, encode_outbox(record)?),
        CommittedOperation::Accepted(record) => (2, encode_accepted(record)),
        CommittedOperation::OutboxAcknowledged(record) => (3, encode_outbox(record)?),
        CommittedOperation::ReceiveAcknowledged(record) => (4, encode_accepted(record)),
        CommittedOperation::Pairing(record) => (5, encode_pairing_operation(record)),
    };
    let mut out = Vec::new();
    out.extend_from_slice(&fingerprint);
    out.extend_from_slice(&generation.to_be_bytes());
    out.push(kind);
    put_bytes(&mut out, &result)?;
    Ok(out)
}

fn decode_operation_record(
    bytes: &[u8],
) -> Result<([u8; 48], u64, CommittedOperation), PersistenceError> {
    let mut cursor = BinaryCursor::new(bytes);
    let fingerprint = cursor.array()?;
    let generation = cursor.u64()?;
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
    Ok((fingerprint, generation, operation))
}

fn decode_operation_with_fingerprint(
    bytes: &[u8],
) -> Result<([u8; 48], CommittedOperation), PersistenceError> {
    decode_operation_record(bytes).map(|(fingerprint, _, operation)| (fingerprint, operation))
}

fn decode_operation(bytes: &[u8]) -> Result<CommittedOperation, PersistenceError> {
    decode_operation_record(bytes).map(|(_, _, operation)| operation)
}

fn decode_operation_generation(bytes: &[u8]) -> Result<u64, PersistenceError> {
    let mut cursor = BinaryCursor::new(bytes);
    let _: [u8; 48] = cursor.array()?;
    cursor.u64()
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
