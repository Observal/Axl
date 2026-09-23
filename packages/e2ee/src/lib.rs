// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

//! Transport-independent endpoint encryption for the Axl private OpenMLS profile.
//!
//! This crate intentionally owns no transport, account, authorization, presentation, or
//! persistence-engine behavior. It does not claim interoperability with an IETF PQ MLS draft.

use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error as StdError,
    fmt,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_libcrux_crypto::CryptoProvider;
use openmls_memory_storage::MemoryStorage;
use openmls_traits::OpenMlsProvider;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

pub mod pairing;
pub mod witness;

#[cfg(feature = "browser-test-fixtures")]
pub mod browser_test_fixtures;

#[cfg(not(target_arch = "wasm32"))]
pub mod persistence;
#[cfg(any(test, feature = "node-test-fixtures"))]
#[doc(hidden)]
pub mod test_witness;

/// The only profile accepted by revision 1.
pub const PROFILE_ID: &str = "axl-e2ee-mls-pq-v1";
/// The only supported profile revision.
pub const PROFILE_REVISION: u16 = 1;
/// The private OpenMLS suite code fixed by the profile.
pub const SUITE_VALUE: u16 = 0x004e;
/// Maximum encoded KeyPackage and Welcome length.
pub const HANDSHAKE_MAX_BYTES: usize = 16 * 1024;
/// KeyPackage lifetime fixed by the pairing profile.
pub const KEY_PACKAGE_LIFETIME_SECONDS: u64 = 10 * 60;
/// Maximum authenticated-data length.
pub const AAD_MAX_BYTES: usize = 512;
/// Maximum application plaintext length.
pub const APPLICATION_MAX_BYTES: usize = 60_000;
/// Maximum complete opaque MLS envelope length accepted by the relay contract.
pub const ENVELOPE_MAX_BYTES: usize = 65_497;
/// Number of previous epochs retained for receive-only processing.
pub const MAX_PAST_EPOCHS: u32 = 2;
/// Maximum local grace period for a retained previous epoch.
pub const PAST_EPOCH_MAX_AGE: Duration = Duration::from_secs(5 * 60);

/// Wall-clock source used to preserve bounded previous-epoch receive windows across restarts.
pub(crate) trait Clock: Send + Sync {
    fn now_ms(&self) -> Result<u64, Error>;
}

/// Host wall clock. Durable state rejects clock rollback instead of extending a grace window.
pub(crate) struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> Result<u64, Error> {
        let duration = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::ClockRollback)?;
        u64::try_from(duration.as_millis()).map_err(|_| Error::ClockRollback)
    }
}

const SUITE: Ciphersuite = Ciphersuite::MLS_128_MLKEM768X25519_AES256GCM_SHA384_Ed25519;
const ZERO_ID: [u8; 16] = [0; 16];

/// The libcrux cryptographic provider paired with Axl-owned replaceable storage.
///
/// Durable operations clone the committed storage image into this provider only after opening
/// their native transaction. The image is staged back into that same transaction before commit.
pub(crate) struct CoreProvider {
    crypto: CryptoProvider,
    storage: MemoryStorage,
}

impl CoreProvider {
    fn new() -> Result<Self, openmls_traits::types::CryptoError> {
        Ok(Self {
            crypto: CryptoProvider::new()?,
            storage: MemoryStorage::default(),
        })
    }

    #[cfg(any(not(target_arch = "wasm32"), feature = "browser-test-fixtures"))]
    pub(crate) fn from_storage_values(
        values: BTreeMap<Vec<u8>, Vec<u8>>,
    ) -> Result<Self, openmls_traits::types::CryptoError> {
        Ok(Self {
            crypto: CryptoProvider::new()?,
            storage: MemoryStorage {
                values: std::sync::RwLock::new(values.into_iter().collect()),
            },
        })
    }

    #[cfg(any(not(target_arch = "wasm32"), feature = "browser-test-fixtures"))]
    pub(crate) fn storage_values(&self) -> BTreeMap<Vec<u8>, Vec<u8>> {
        self.storage
            .values
            .read()
            .expect("OpenMLS memory storage lock poisoned")
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn insert_internal(&self, key: Vec<u8>, value: Vec<u8>) {
        self.storage
            .values
            .write()
            .expect("OpenMLS memory storage lock poisoned")
            .insert(key, value);
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn internal(&self, key: &[u8]) -> Option<Vec<u8>> {
        self.storage
            .values
            .read()
            .expect("OpenMLS memory storage lock poisoned")
            .get(key)
            .cloned()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn remove_internal(&self, key: &[u8]) {
        self.storage
            .values
            .write()
            .expect("OpenMLS memory storage lock poisoned")
            .remove(key);
    }
}

impl OpenMlsProvider for CoreProvider {
    type CryptoProvider = CryptoProvider;
    type RandProvider = CryptoProvider;
    type StorageProvider = MemoryStorage;

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }

    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }

    fn rand(&self) -> &Self::RandProvider {
        &self.crypto
    }
}

/// A stable 16-byte UUID representation. Canonical UUID validation belongs to the caller that
/// parses textual UUIDs; this core accepts only the already-canonical bytes.
pub type Id = [u8; 16];
/// A random, never-reused 32-byte MLS group identifier.
pub type GroupIdBytes = [u8; 32];

/// Endpoint role encoded in an Axl MLS basic credential.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum Role {
    Daemon = 1,
    Device = 2,
}

/// Identity fields authenticated by an MLS basic credential.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Identity {
    pub role: Role,
    pub account_id: Id,
    pub installation_id: Id,
    pub device_id: Id,
}

impl Identity {
    pub fn daemon(account_id: Id, installation_id: Id) -> Self {
        Self {
            role: Role::Daemon,
            account_id,
            installation_id,
            device_id: ZERO_ID,
        }
    }

    pub fn device(account_id: Id, installation_id: Id, device_id: Id) -> Result<Self, Error> {
        if device_id == ZERO_ID {
            return Err(Error::InvalidIdentity("device id must not be zero"));
        }
        Ok(Self {
            role: Role::Device,
            account_id,
            installation_id,
            device_id,
        })
    }

    fn validate(&self) -> Result<(), Error> {
        match self.role {
            Role::Daemon if self.device_id != ZERO_ID => {
                Err(Error::InvalidIdentity("daemon device id must be zero"))
            }
            Role::Device if self.device_id == ZERO_ID => {
                Err(Error::InvalidIdentity("device id must not be zero"))
            }
            _ => Ok(()),
        }
    }

    fn credential_bytes(&self, signature_key: &[u8]) -> Result<Vec<u8>, Error> {
        self.validate()?;
        if signature_key.len() != 32 {
            return Err(Error::InvalidIdentity(
                "Ed25519 public key must be 32 bytes",
            ));
        }
        let mut out = Vec::with_capacity(2 + 1 + 16 * 3 + 1 + PROFILE_ID.len() + 2 + 32);
        put_u16(&mut out, 1);
        out.push(self.role as u8);
        out.extend_from_slice(&self.account_id);
        out.extend_from_slice(&self.installation_id);
        out.extend_from_slice(&self.device_id);
        put_u8_vector(&mut out, PROFILE_ID.as_bytes())?;
        put_u16(&mut out, PROFILE_REVISION);
        out.extend_from_slice(signature_key);
        Ok(out)
    }

    fn parse_credential(bytes: &[u8]) -> Result<Self, Error> {
        let mut cursor = Cursor::new(bytes);
        if cursor.u16()? != 1 {
            return Err(Error::WrongProfile);
        }
        let role = match cursor.u8()? {
            1 => Role::Daemon,
            2 => Role::Device,
            _ => return Err(Error::InvalidIdentity("unknown credential role")),
        };
        let account_id = cursor.array()?;
        let installation_id = cursor.array()?;
        let device_id = cursor.array()?;
        let profile = cursor.u8_vector()?;
        if profile != PROFILE_ID.as_bytes() || cursor.u16()? != PROFILE_REVISION {
            return Err(Error::WrongProfile);
        }
        let _: [u8; 32] = cursor.array()?;
        cursor.finish()?;
        let identity = Self {
            role,
            account_id,
            installation_id,
            device_id,
        };
        identity.validate()?;
        Ok(identity)
    }
}

/// Message classes fixed by revision 1.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum MessageClass {
    ApplicationRequest = 1,
    ApplicationDelivery = 2,
    UpdateProposal = 3,
    Commit = 4,
    EpochReady = 5,
    PairActivation = 6,
    ResyncControl = 7,
}

impl TryFrom<u8> for MessageClass {
    type Error = Error;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::ApplicationRequest),
            2 => Ok(Self::ApplicationDelivery),
            3 => Ok(Self::UpdateProposal),
            4 => Ok(Self::Commit),
            5 => Ok(Self::EpochReady),
            6 => Ok(Self::PairActivation),
            7 => Ok(Self::ResyncControl),
            _ => Err(Error::InvalidAad),
        }
    }
}

/// Canonical authenticated data for every private MLS message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Aad {
    pub crypto_session_id: Id,
    pub group_id: GroupIdBytes,
    pub source_device_id: Id,
    pub destination_device_id: Id,
    pub installation_id: Id,
    pub message_class: MessageClass,
    pub logical_message_id: Id,
    pub hosted_grant_generation: u64,
}

impl Aad {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(2 + 1 + PROFILE_ID.len() + 2 + 16 + 32 + 16 * 3 + 1 + 8);
        put_u16(&mut out, 1);
        // The fixed profile fits the one-byte TLS vector length by construction.
        out.push(PROFILE_ID.len() as u8);
        out.extend_from_slice(PROFILE_ID.as_bytes());
        put_u16(&mut out, PROFILE_REVISION);
        out.extend_from_slice(&self.crypto_session_id);
        out.extend_from_slice(&self.group_id);
        out.extend_from_slice(&self.source_device_id);
        out.extend_from_slice(&self.destination_device_id);
        out.extend_from_slice(&self.installation_id);
        out.push(self.message_class as u8);
        out.extend_from_slice(&self.logical_message_id);
        out.extend_from_slice(&self.hosted_grant_generation.to_be_bytes());
        debug_assert!(out.len() <= AAD_MAX_BYTES);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > AAD_MAX_BYTES {
            return Err(Error::BoundExceeded("AAD"));
        }
        let mut cursor = Cursor::new(bytes);
        if cursor.u16()? != 1 {
            return Err(Error::WrongProfile);
        }
        let profile = cursor.u8_vector()?;
        if profile != PROFILE_ID.as_bytes() || cursor.u16()? != PROFILE_REVISION {
            return Err(Error::WrongProfile);
        }
        let result = Self {
            crypto_session_id: cursor.array()?,
            group_id: cursor.array()?,
            source_device_id: cursor.array()?,
            destination_device_id: cursor.array()?,
            installation_id: cursor.array()?,
            message_class: cursor.u8()?.try_into()?,
            logical_message_id: cursor.array()?,
            hosted_grant_generation: cursor.u64()?,
        };
        cursor.finish()?;
        Ok(result)
    }

    pub fn validate_exact(bytes: &[u8], expected: &Self) -> Result<(), Error> {
        let decoded = Self::decode(bytes)?;
        if decoded != *expected || bytes != expected.encode() {
            return Err(Error::InvalidAad);
        }
        Ok(())
    }
}

/// Stable pair metadata used to reconstruct expected AAD. It contains no relay route.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PairContext {
    pub crypto_session_id: Id,
    pub group_id: GroupIdBytes,
    pub account_id: Id,
    pub installation_id: Id,
    pub device_id: Id,
}

impl PairContext {
    fn aad(
        &self,
        sender: Role,
        class: MessageClass,
        logical_message_id: Id,
        generation: u64,
    ) -> Aad {
        let (source_device_id, destination_device_id) = match sender {
            Role::Daemon => (ZERO_ID, self.device_id),
            Role::Device => (self.device_id, ZERO_ID),
        };
        Aad {
            crypto_session_id: self.crypto_session_id,
            group_id: self.group_id,
            source_device_id,
            destination_device_id,
            installation_id: self.installation_id,
            message_class: class,
            logical_message_id,
            hosted_grant_generation: generation,
        }
    }
}

/// An immutable output prepared for one future platform transaction.
///
/// An adapter must atomically commit the OpenMLS provider writes and these exact bytes before
/// transmission. Retrying uses [`PreparedEnvelope::ciphertext`] again and never invokes MLS.
#[derive(Debug)]
pub struct PreparedEnvelope {
    crypto_session_id: Id,
    logical_message_id: Id,
    class: MessageClass,
    epoch: u64,
    hosted_generation: u64,
    commit: Option<CommitMetadata>,
    ciphertext: Box<[u8]>,
}

/// Metadata persisted with a daemon-created commit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitMetadata {
    pub commit_id: [u8; 48],
    pub target_epoch: u64,
    pub epoch_authenticator: [u8; 48],
}

impl PreparedEnvelope {
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
    pub fn commit_metadata(&self) -> Option<&CommitMetadata> {
        self.commit.as_ref()
    }
    pub fn ciphertext(&self) -> &[u8] {
        &self.ciphertext
    }
}

/// Outcome reported by the platform transaction enclosing one prepared operation.
#[cfg(any(test, feature = "browser-test-fixtures"))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TransactionOutcome {
    Committed,
    #[cfg(test)]
    RolledBack,
}

/// Platform-neutral provider contract Session 40B must implement with durable storage.
///
/// The transaction's provider is the provider passed to OpenMLS while it advances state. The
/// adapter then stages the immutable envelope or accepted-message identity in that same
/// transaction. Network transmission and plaintext release are forbidden until `commit` returns.
/// No relay route appears in this contract.
#[cfg(all(test, not(target_arch = "wasm32")))]
pub(crate) trait TransactionalProvider {
    type TransactionError: StdError + Send + Sync + 'static;
    type Transaction<'a>: GroupTransaction<Error = Self::TransactionError>
    where
        Self: 'a;

    fn begin_transaction(
        &self,
        crypto_session_id: Id,
        expected_generation: u64,
        expected_rollback_counter: u64,
    ) -> Result<Self::Transaction<'_>, Self::TransactionError>;
}

/// One strict read-write transaction around OpenMLS state and Axl delivery metadata.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) trait GroupTransaction {
    type Error: StdError + Send + Sync + 'static;

    fn stage_envelope(&mut self, envelope: &PreparedEnvelope) -> Result<(), Self::Error>;
    fn rollback(self) -> Result<(), Self::Error>;
}

/// Opaque, bounded phone KeyPackage tied to its expected credential.
#[derive(Debug)]
pub struct PhoneKeyPackage {
    bytes: Box<[u8]>,
    identity: Identity,
}

impl PhoneKeyPackage {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// Opaque, immutable Welcome and the authenticated pair metadata needed before joining.
#[derive(Debug)]
pub struct PairWelcome {
    bytes: Box<[u8]>,
    context: PairContext,
    daemon_identity: Identity,
    device_identity: Identity,
}

impl PairWelcome {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn context(&self) -> &PairContext {
        &self.context
    }
}

/// Successfully decrypted application data. Receive-state durability must be confirmed before
/// the caller releases this plaintext to authorization or presentation code.
#[derive(Debug)]
pub struct PreparedPlaintext {
    pub logical_message_id: Id,
    pub epoch: u64,
    plaintext: Box<[u8]>,
}

impl PreparedPlaintext {
    pub fn plaintext(&self) -> &[u8] {
        &self.plaintext
    }
}

/// A typed, bounded failure from the core boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    BoundExceeded(&'static str),
    ConsumedKeyPackage,
    ClockRollback,
    CompetingCommit,
    Crypto(&'static str),
    DuplicateCiphertext,
    FutureEpoch,
    InactiveAfterRollback,
    InvalidAad,
    InvalidCiphertext,
    InvalidIdentity(&'static str),
    InvalidMessageClass,
    NoPreparedTransaction,
    NotTwoMembers,
    StaleEpoch,
    TransactionPending,
    UnexpectedMessage,
    WrongGroup,
    WrongProfile,
    WrongSuite,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BoundExceeded(name) => write!(f, "{name} exceeds the revision 1 bound"),
            Self::InvalidIdentity(reason) => write!(f, "invalid identity: {reason}"),
            other => write!(f, "{other:?}"),
        }
    }
}
impl StdError for Error {}

struct Endpoint {
    provider: CoreProvider,
    signer: SignatureKeyPair,
    group: Option<MlsGroup>,
    identity: Identity,
    peer: Identity,
    context: PairContext,
    accepted: BTreeSet<Id>,
    previous_epoch_deadlines: BTreeMap<u64, u64>,
    last_wall_time_ms: u64,
    clock: Arc<dyn Clock>,
    transaction_pending: bool,
}

impl Endpoint {
    fn group(&self) -> Result<&MlsGroup, Error> {
        self.group.as_ref().ok_or(Error::InactiveAfterRollback)
    }
    fn invalidate(&mut self) {
        self.group = None;
        self.transaction_pending = false;
    }
    fn ensure_ready(&self) -> Result<(), Error> {
        if self.transaction_pending {
            Err(Error::TransactionPending)
        } else {
            self.group()?;
            Ok(())
        }
    }

    fn checked_now_ms(&mut self) -> Result<u64, Error> {
        let now = self.clock.now_ms()?;
        if now < self.last_wall_time_ms {
            self.invalidate();
            return Err(Error::ClockRollback);
        }
        self.last_wall_time_ms = now;
        Ok(now)
    }

    fn validate_incoming(&mut self, message: &ProtocolMessage) -> Result<(), Error> {
        let now = self.checked_now_ms()?;
        let group = self.group()?;
        if message.group_id() != group.group_id() {
            return Err(Error::WrongGroup);
        }
        let current = group.epoch().as_u64();
        let incoming = message.epoch().as_u64();
        if incoming > current {
            return Err(Error::FutureEpoch);
        }
        if incoming < current
            && self
                .previous_epoch_deadlines
                .get(&incoming)
                .is_none_or(|deadline| now > *deadline)
        {
            return Err(Error::StaleEpoch);
        }
        Ok(())
    }

    fn mark_epoch_advanced(&mut self, old_epoch: u64) -> Result<(), Error> {
        let now = self.checked_now_ms()?;
        let current = self
            .group
            .as_ref()
            .map_or(old_epoch, |group| group.epoch().as_u64());
        self.previous_epoch_deadlines.insert(
            old_epoch,
            now.checked_add(PAST_EPOCH_MAX_AGE.as_millis() as u64)
                .ok_or(Error::ClockRollback)?,
        );
        self.previous_epoch_deadlines
            .retain(|epoch, _| current.saturating_sub(*epoch) <= u64::from(MAX_PAST_EPOCHS));
        Ok(())
    }

    fn expected_aad(&self, class: MessageClass, id: Id, generation: u64) -> Aad {
        self.context.aad(self.peer.role, class, id, generation)
    }

    fn prepare_application(
        &mut self,
        class: MessageClass,
        logical_message_id: Id,
        generation: u64,
        plaintext: &[u8],
    ) -> Result<PreparedEnvelope, Error> {
        self.ensure_ready()?;
        if plaintext.len() > APPLICATION_MAX_BYTES {
            return Err(Error::BoundExceeded("application plaintext"));
        }
        let expected_class = match self.identity.role {
            Role::Daemon => MessageClass::ApplicationDelivery,
            Role::Device => MessageClass::ApplicationRequest,
        };
        if class != expected_class {
            return Err(Error::InvalidMessageClass);
        }
        let aad = self
            .context
            .aad(self.identity.role, class, logical_message_id, generation)
            .encode();
        let provider = &self.provider;
        let signer = &self.signer;
        let group = self.group.as_mut().ok_or(Error::InactiveAfterRollback)?;
        let epoch = group.epoch().as_u64();
        group.set_aad(aad);
        let bytes = group
            .create_message(provider, signer, plaintext)
            .map_err(|_| Error::Crypto("application encryption failed"))?
            .tls_serialize_detached()
            .map_err(|_| Error::Crypto("application serialization failed"))?;
        let envelope = bounded_envelope(
            bytes,
            self.context.crypto_session_id,
            logical_message_id,
            class,
            epoch,
            generation,
        )?;
        self.transaction_pending = true;
        Ok(envelope)
    }

    fn prepare_control(
        &mut self,
        class: MessageClass,
        logical_message_id: Id,
        generation: u64,
        plaintext: &[u8],
    ) -> Result<PreparedEnvelope, Error> {
        self.ensure_ready()?;
        if plaintext.len() > 2 * 1024 {
            return Err(Error::BoundExceeded("control plaintext"));
        }
        if !matches!(
            class,
            MessageClass::PairActivation | MessageClass::EpochReady | MessageClass::ResyncControl
        ) {
            return Err(Error::InvalidMessageClass);
        }
        let aad = self
            .context
            .aad(self.identity.role, class, logical_message_id, generation)
            .encode();
        let group = self.group.as_mut().ok_or(Error::InactiveAfterRollback)?;
        let epoch = group.epoch().as_u64();
        group.set_aad(aad);
        let bytes = group
            .create_message(&self.provider, &self.signer, plaintext)
            .map_err(|_| Error::Crypto("control encryption failed"))?
            .tls_serialize_detached()
            .map_err(|_| Error::Crypto("control serialization failed"))?;
        let envelope = bounded_envelope(
            bytes,
            self.context.crypto_session_id,
            logical_message_id,
            class,
            epoch,
            generation,
        )?;
        self.transaction_pending = true;
        Ok(envelope)
    }

    fn receive_control(
        &mut self,
        envelope: &[u8],
        class: MessageClass,
        logical_message_id: Id,
        generation: u64,
    ) -> Result<PreparedPlaintext, Error> {
        self.ensure_ready()?;
        if envelope.len() > ENVELOPE_MAX_BYTES {
            return Err(Error::BoundExceeded("MLS envelope"));
        }
        if self.accepted.contains(&logical_message_id) {
            return Err(Error::DuplicateCiphertext);
        }
        let protocol = decode_protocol(envelope)?;
        self.validate_incoming(&protocol)?;
        let processed = self
            .group
            .as_mut()
            .ok_or(Error::InactiveAfterRollback)?
            .process_message(&self.provider, protocol)
            .map_err(|_| Error::InvalidCiphertext)?;
        if let Err(error) = Aad::validate_exact(
            processed.aad(),
            &self.expected_aad(class, logical_message_id, generation),
        ) {
            self.invalidate();
            return Err(error);
        }
        if let Err(error) = validate_sender(&processed, &self.peer) {
            self.invalidate();
            return Err(error);
        }
        let epoch = processed.epoch().as_u64();
        let ProcessedMessageContent::ApplicationMessage(application) = processed.into_content()
        else {
            self.invalidate();
            return Err(Error::UnexpectedMessage);
        };
        let plaintext = application.into_bytes();
        if plaintext.len() > 2 * 1024 {
            self.invalidate();
            return Err(Error::BoundExceeded("control plaintext"));
        }
        self.accepted.insert(logical_message_id);
        self.transaction_pending = true;
        Ok(PreparedPlaintext {
            logical_message_id,
            epoch,
            plaintext: plaintext.into_boxed_slice(),
        })
    }

    fn receive_application(
        &mut self,
        envelope: &[u8],
        class: MessageClass,
        logical_message_id: Id,
        generation: u64,
    ) -> Result<PreparedPlaintext, Error> {
        self.ensure_ready()?;
        if envelope.len() > ENVELOPE_MAX_BYTES {
            return Err(Error::BoundExceeded("MLS envelope"));
        }
        if self.accepted.contains(&logical_message_id) {
            return Err(Error::DuplicateCiphertext);
        }
        let protocol = decode_protocol(envelope)?;
        self.validate_incoming(&protocol)?;
        let provider = &self.provider;
        let processed = self
            .group
            .as_mut()
            .ok_or(Error::InactiveAfterRollback)?
            .process_message(provider, protocol)
            .map_err(|_| Error::InvalidCiphertext)?;
        if let Err(error) = Aad::validate_exact(
            processed.aad(),
            &self.expected_aad(class, logical_message_id, generation),
        ) {
            self.invalidate();
            return Err(error);
        }
        if let Err(error) = validate_sender(&processed, &self.peer) {
            self.invalidate();
            return Err(error);
        }
        let epoch = processed.epoch().as_u64();
        let ProcessedMessageContent::ApplicationMessage(application) = processed.into_content()
        else {
            self.invalidate();
            return Err(Error::UnexpectedMessage);
        };
        self.accepted.insert(logical_message_id);
        self.transaction_pending = true;
        Ok(PreparedPlaintext {
            logical_message_id,
            epoch,
            plaintext: application.into_bytes().into_boxed_slice(),
        })
    }

    #[cfg(any(test, feature = "browser-test-fixtures"))]
    fn finish_transaction(&mut self, outcome: TransactionOutcome) -> Result<(), Error> {
        if !self.transaction_pending {
            return Err(Error::NoPreparedTransaction);
        }
        match outcome {
            TransactionOutcome::Committed => self.transaction_pending = false,
            #[cfg(test)]
            TransactionOutcome::RolledBack => self.invalidate(),
        }
        Ok(())
    }

    fn epoch(&self) -> Result<u64, Error> {
        Ok(self.group()?.epoch().as_u64())
    }

    fn epoch_authenticator(&self) -> Result<Vec<u8>, Error> {
        Ok(self.group()?.epoch_authenticator().as_slice().to_vec())
    }
}

/// Daemon member. This is the only type that exposes commit creation.
pub(crate) struct Daemon {
    endpoint: Endpoint,
    key_package_consumed: bool,
}

impl Daemon {
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn create(identity: Identity, context: PairContext) -> Result<Self, Error> {
        Self::create_with_clock(identity, context, Arc::new(SystemClock))
    }

    fn create_with_clock(
        identity: Identity,
        context: PairContext,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, Error> {
        if identity.role != Role::Daemon
            || identity.account_id != context.account_id
            || identity.installation_id != context.installation_id
        {
            return Err(Error::InvalidIdentity("daemon does not match pair context"));
        }
        let provider =
            CoreProvider::new().map_err(|_| Error::Crypto("provider initialization failed"))?;
        ensure_suite(&provider)?;
        let (credential, signer) = make_credential(&provider, &identity)?;
        let group = MlsGroup::builder()
            .with_group_id(GroupId::from_slice(&context.group_id))
            .ciphersuite(SUITE)
            .use_ratchet_tree_extension(true)
            .sender_ratchet_configuration(SenderRatchetConfiguration::new(32, 1000))
            .max_past_epochs(MAX_PAST_EPOCHS as usize)
            .build(&provider, &signer, credential)
            .map_err(|_| Error::Crypto("group creation failed"))?;
        let peer = Identity::device(
            context.account_id,
            context.installation_id,
            context.device_id,
        )?;
        let last_wall_time_ms = clock.now_ms()?;
        Ok(Self {
            endpoint: Endpoint {
                provider,
                signer,
                group: Some(group),
                identity,
                peer,
                context,
                accepted: BTreeSet::new(),
                previous_epoch_deadlines: BTreeMap::new(),
                last_wall_time_ms,
                clock,
                transaction_pending: false,
            },
            key_package_consumed: false,
        })
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn create_from_pairing_state(
        values: BTreeMap<Vec<u8>, Vec<u8>>,
        identity: Identity,
        context: PairContext,
        signer_public: &[u8],
        clock: Arc<dyn Clock>,
    ) -> Result<Self, Error> {
        if identity.role != Role::Daemon
            || identity.account_id != context.account_id
            || identity.installation_id != context.installation_id
        {
            return Err(Error::InvalidIdentity("daemon does not match pair context"));
        }
        let provider = CoreProvider::from_storage_values(values)
            .map_err(|_| Error::Crypto("provider initialization failed"))?;
        ensure_suite(&provider)?;
        let signer = SignatureKeyPair::read(
            provider.storage(),
            signer_public,
            SUITE.signature_algorithm(),
        )
        .ok_or(Error::Crypto("daemon signer state missing"))?;
        let credential = BasicCredential::new(identity.credential_bytes(signer.public())?);
        let credential = CredentialWithKey {
            credential: credential.into(),
            signature_key: signer.public().into(),
        };
        let group = MlsGroup::builder()
            .with_group_id(GroupId::from_slice(&context.group_id))
            .ciphersuite(SUITE)
            .use_ratchet_tree_extension(true)
            .sender_ratchet_configuration(SenderRatchetConfiguration::new(32, 1000))
            .max_past_epochs(MAX_PAST_EPOCHS as usize)
            .build(&provider, &signer, credential)
            .map_err(|_| Error::Crypto("group creation failed"))?;
        let peer = Identity::device(
            context.account_id,
            context.installation_id,
            context.device_id,
        )?;
        let last_wall_time_ms = clock.now_ms()?;
        Ok(Self {
            endpoint: Endpoint {
                provider,
                signer,
                group: Some(group),
                identity,
                peer,
                context,
                accepted: BTreeSet::new(),
                previous_epoch_deadlines: BTreeMap::new(),
                last_wall_time_ms,
                clock,
                transaction_pending: false,
            },
            key_package_consumed: false,
        })
    }

    pub(crate) fn consume_key_package(
        &mut self,
        package: PhoneKeyPackage,
    ) -> Result<PairWelcome, Error> {
        if self.key_package_consumed {
            return Err(Error::ConsumedKeyPackage);
        }
        if package.bytes.len() > HANDSHAKE_MAX_BYTES {
            return Err(Error::BoundExceeded("KeyPackage"));
        }
        if package.identity != self.endpoint.peer {
            return Err(Error::InvalidIdentity(
                "KeyPackage identity does not match pair",
            ));
        }
        let now_ms = self.endpoint.checked_now_ms()?;
        let key_package = validate_phone_key_package(
            &self.endpoint.provider,
            package.bytes.as_ref(),
            &package.identity,
            now_ms,
        )?;
        let provider = &self.endpoint.provider;
        let signer = &self.endpoint.signer;
        let group = self
            .endpoint
            .group
            .as_mut()
            .ok_or(Error::InactiveAfterRollback)?;
        let (_, welcome, _) = group
            .add_members(provider, signer, &[key_package])
            .map_err(|_| Error::Crypto("member addition failed"))?;
        group
            .merge_pending_commit(provider)
            .map_err(|_| Error::Crypto("initial commit merge failed"))?;
        validate_members(group, &self.endpoint.identity, &self.endpoint.peer)?;
        let bytes = welcome
            .tls_serialize_detached()
            .map_err(|_| Error::Crypto("Welcome serialization failed"))?;
        if bytes.len() > HANDSHAKE_MAX_BYTES {
            return Err(Error::BoundExceeded("Welcome"));
        }
        self.key_package_consumed = true;
        self.endpoint.transaction_pending = true;
        Ok(PairWelcome {
            bytes: bytes.into_boxed_slice(),
            context: self.endpoint.context.clone(),
            daemon_identity: self.endpoint.identity.clone(),
            device_identity: self.endpoint.peer.clone(),
        })
    }

    pub(crate) fn prepare_application(
        &mut self,
        id: Id,
        generation: u64,
        plaintext: &[u8],
    ) -> Result<PreparedEnvelope, Error> {
        self.endpoint.prepare_application(
            MessageClass::ApplicationDelivery,
            id,
            generation,
            plaintext,
        )
    }

    pub(crate) fn receive_application(
        &mut self,
        bytes: &[u8],
        id: Id,
        generation: u64,
    ) -> Result<PreparedPlaintext, Error> {
        self.endpoint
            .receive_application(bytes, MessageClass::ApplicationRequest, id, generation)
    }

    pub(crate) fn receive_pair_activation(
        &mut self,
        bytes: &[u8],
        id: Id,
    ) -> Result<PreparedPlaintext, Error> {
        self.endpoint
            .receive_control(bytes, MessageClass::PairActivation, id, 0)
    }

    pub(crate) fn receive_update_proposal(
        &mut self,
        bytes: &[u8],
        id: Id,
        generation: u64,
    ) -> Result<(), Error> {
        self.endpoint.ensure_ready()?;
        let protocol = decode_protocol(bytes)?;
        self.endpoint.validate_incoming(&protocol)?;
        let provider = &self.endpoint.provider;
        let processed = self
            .endpoint
            .group
            .as_mut()
            .ok_or(Error::InactiveAfterRollback)?
            .process_message(provider, protocol)
            .map_err(|_| Error::InvalidCiphertext)?;
        if let Err(error) = Aad::validate_exact(
            processed.aad(),
            &self
                .endpoint
                .expected_aad(MessageClass::UpdateProposal, id, generation),
        ) {
            self.endpoint.invalidate();
            return Err(error);
        }
        if let Err(error) = validate_sender(&processed, &self.endpoint.peer) {
            self.endpoint.invalidate();
            return Err(error);
        }
        let ProcessedMessageContent::ProposalMessage(proposal) = processed.into_content() else {
            self.endpoint.invalidate();
            return Err(Error::UnexpectedMessage);
        };
        self.endpoint
            .group
            .as_mut()
            .ok_or(Error::InactiveAfterRollback)?
            .store_pending_proposal(self.endpoint.provider.storage(), *proposal)
            .map_err(|_| Error::Crypto("proposal storage failed"))?;
        self.endpoint.transaction_pending = true;
        Ok(())
    }

    pub(crate) fn prepare_commit(
        &mut self,
        id: Id,
        generation: u64,
    ) -> Result<PreparedEnvelope, Error> {
        self.endpoint.ensure_ready()?;
        let aad = self
            .endpoint
            .context
            .aad(Role::Daemon, MessageClass::Commit, id, generation)
            .encode();
        let provider = &self.endpoint.provider;
        let signer = &self.endpoint.signer;
        let group = self
            .endpoint
            .group
            .as_mut()
            .ok_or(Error::InactiveAfterRollback)?;
        let epoch = group.epoch().as_u64();
        if group.pending_proposals().count() != 1 {
            return Err(Error::CompetingCommit);
        }
        group.set_aad(aad);
        let (commit, _, _) = group
            .commit_to_pending_proposals(provider, signer)
            .map_err(|_| Error::Crypto("commit creation failed"))?;
        let bytes = commit
            .tls_serialize_detached()
            .map_err(|_| Error::Crypto("commit serialization failed"))?;
        group
            .merge_pending_commit(provider)
            .map_err(|_| Error::Crypto("commit merge failed"))?;
        validate_members(group, &self.endpoint.identity, &self.endpoint.peer)?;
        let commit_id: [u8; 48] = provider
            .crypto()
            .hash(SUITE.hash_algorithm(), &bytes)
            .map_err(|_| Error::Crypto("commit hash failed"))?
            .try_into()
            .map_err(|_| Error::Crypto("unexpected commit hash length"))?;
        let epoch_authenticator = group
            .epoch_authenticator()
            .as_slice()
            .try_into()
            .map_err(|_| Error::Crypto("unexpected epoch authenticator length"))?;
        let target_epoch = group.epoch().as_u64();
        if let Err(error) = self.endpoint.mark_epoch_advanced(epoch) {
            self.endpoint.invalidate();
            return Err(error);
        }
        let mut envelope = bounded_envelope(
            bytes,
            self.endpoint.context.crypto_session_id,
            id,
            MessageClass::Commit,
            epoch,
            generation,
        )?;
        envelope.commit = Some(CommitMetadata {
            commit_id,
            target_epoch,
            epoch_authenticator,
        });
        self.endpoint.transaction_pending = true;
        Ok(envelope)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn prepare_removal(
        &mut self,
        id: Id,
        generation: u64,
    ) -> Result<PreparedEnvelope, Error> {
        self.endpoint.ensure_ready()?;
        let aad = self
            .endpoint
            .context
            .aad(Role::Daemon, MessageClass::Commit, id, generation)
            .encode();
        let provider = &self.endpoint.provider;
        let signer = &self.endpoint.signer;
        let group = self
            .endpoint
            .group
            .as_mut()
            .ok_or(Error::InactiveAfterRollback)?;
        let epoch = group.epoch().as_u64();
        let target = group
            .members()
            .find_map(|member| {
                (Identity::parse_credential(member.credential.serialized_content()).ok()
                    == Some(self.endpoint.peer.clone()))
                .then_some(member.index)
            })
            .ok_or(Error::NotTwoMembers)?;
        group.set_aad(aad);
        let (commit, _, _) = group
            .remove_members(provider, signer, &[target])
            .map_err(|_| Error::Crypto("member removal failed"))?;
        let bytes = commit
            .tls_serialize_detached()
            .map_err(|_| Error::Crypto("removal serialization failed"))?;
        group
            .merge_pending_commit(provider)
            .map_err(|_| Error::Crypto("removal merge failed"))?;
        if group.members().count() != 1 {
            return Err(Error::NotTwoMembers);
        }
        let commit_id: [u8; 48] = provider
            .crypto()
            .hash(SUITE.hash_algorithm(), &bytes)
            .map_err(|_| Error::Crypto("commit hash failed"))?
            .try_into()
            .map_err(|_| Error::Crypto("unexpected commit hash length"))?;
        let epoch_authenticator = group
            .epoch_authenticator()
            .as_slice()
            .try_into()
            .map_err(|_| Error::Crypto("unexpected epoch authenticator length"))?;
        let target_epoch = group.epoch().as_u64();
        if let Err(error) = self.endpoint.mark_epoch_advanced(epoch) {
            self.endpoint.invalidate();
            return Err(error);
        }
        let mut envelope = bounded_envelope(
            bytes,
            self.endpoint.context.crypto_session_id,
            id,
            MessageClass::Commit,
            epoch,
            generation,
        )?;
        envelope.commit = Some(CommitMetadata {
            commit_id,
            target_epoch,
            epoch_authenticator,
        });
        self.endpoint.transaction_pending = true;
        Ok(envelope)
    }

    pub(crate) fn receive_epoch_ready(
        &mut self,
        bytes: &[u8],
        id: Id,
        generation: u64,
    ) -> Result<PreparedPlaintext, Error> {
        self.endpoint
            .receive_control(bytes, MessageClass::EpochReady, id, generation)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn prepare_resync_control(
        &mut self,
        id: Id,
        generation: u64,
        plaintext: &[u8],
    ) -> Result<PreparedEnvelope, Error> {
        self.endpoint
            .prepare_control(MessageClass::ResyncControl, id, generation, plaintext)
    }

    #[cfg(any(test, feature = "browser-test-fixtures"))]
    pub(crate) fn finish_transaction(&mut self, outcome: TransactionOutcome) -> Result<(), Error> {
        self.endpoint.finish_transaction(outcome)
    }
    #[cfg(any(test, feature = "browser-test-fixtures"))]
    pub(crate) fn epoch(&self) -> Result<u64, Error> {
        self.endpoint.epoch()
    }
    #[cfg(any(test, feature = "browser-test-fixtures"))]
    pub(crate) fn epoch_authenticator(&self) -> Result<Vec<u8>, Error> {
        self.endpoint.epoch_authenticator()
    }
}

/// Phone member. It may create self-Update proposals but cannot create commits.
pub(crate) struct Phone {
    endpoint: Option<Endpoint>,
    provider: CoreProvider,
    signer: SignatureKeyPair,
    identity: Identity,
}

impl Phone {
    #[cfg(test)]
    pub(crate) fn create(identity: Identity) -> Result<(Self, PhoneKeyPackage), Error> {
        Self::create_with_clock(identity, &SystemClock)
    }

    pub(crate) fn create_with_clock(
        identity: Identity,
        clock: &dyn Clock,
    ) -> Result<(Self, PhoneKeyPackage), Error> {
        let now_ms = clock.now_ms()?;
        Self::create_at(identity, now_ms)
    }

    pub(crate) fn create_at(
        identity: Identity,
        now_ms: u64,
    ) -> Result<(Self, PhoneKeyPackage), Error> {
        if identity.role != Role::Device {
            return Err(Error::InvalidIdentity("phone must use device role"));
        }
        identity.validate()?;
        let provider =
            CoreProvider::new().map_err(|_| Error::Crypto("provider initialization failed"))?;
        ensure_suite(&provider)?;
        let (credential, signer) = make_credential(&provider, &identity)?;
        let now_seconds = now_ms / 1_000;
        let not_after = now_seconds
            .checked_add(KEY_PACKAGE_LIFETIME_SECONDS)
            .ok_or(Error::ClockRollback)?;
        let bundle = KeyPackage::builder()
            .key_package_lifetime(Lifetime::init(now_seconds, not_after))
            .build(SUITE, &provider, &signer, credential)
            .map_err(|_| Error::Crypto("KeyPackage creation failed"))?;
        let bytes = bundle
            .key_package()
            .tls_serialize_detached()
            .map_err(|_| Error::Crypto("KeyPackage serialization failed"))?;
        if bytes.len() > HANDSHAKE_MAX_BYTES {
            return Err(Error::BoundExceeded("KeyPackage"));
        }
        Ok((
            Self {
                endpoint: None,
                provider,
                signer,
                identity: identity.clone(),
            },
            PhoneKeyPackage {
                bytes: bytes.into_boxed_slice(),
                identity,
            },
        ))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn join(
        &mut self,
        welcome: PairWelcome,
        expected: &PairContext,
    ) -> Result<(), Error> {
        self.join_with_clock(welcome, expected, Arc::new(SystemClock))
    }

    fn join_with_clock(
        &mut self,
        welcome: PairWelcome,
        expected: &PairContext,
        clock: Arc<dyn Clock>,
    ) -> Result<(), Error> {
        if &welcome.context != expected {
            return Err(Error::WrongGroup);
        }
        if welcome.device_identity != self.identity {
            return Err(Error::InvalidIdentity("Welcome device identity mismatch"));
        }
        if welcome.bytes.len() > HANDSHAKE_MAX_BYTES {
            return Err(Error::BoundExceeded("Welcome"));
        }
        let message = MlsMessageIn::tls_deserialize_exact(welcome.bytes.as_ref())
            .map_err(|_| Error::Crypto("invalid Welcome encoding"))?;
        let MlsMessageBodyIn::Welcome(welcome_message) = message.extract() else {
            return Err(Error::UnexpectedMessage);
        };
        if welcome_message.ciphersuite() != SUITE {
            return Err(Error::WrongSuite);
        }
        let staged =
            StagedWelcome::new_from_welcome(&self.provider, &join_config(), welcome_message, None)
                .map_err(|_| Error::Crypto("Welcome join failed"))?;
        if staged.group_context().group_id().as_slice() != expected.group_id {
            return Err(Error::WrongGroup);
        }
        validate_members_iter(staged.members(), &welcome.daemon_identity, &self.identity)?;
        let group = staged
            .into_group(&self.provider)
            .map_err(|_| Error::Crypto("Welcome persistence failed"))?;
        let last_wall_time_ms = clock.now_ms()?;
        let endpoint = Endpoint {
            provider: std::mem::replace(
                &mut self.provider,
                CoreProvider::new().map_err(|_| Error::Crypto("provider initialization failed"))?,
            ),
            signer: std::mem::replace(
                &mut self.signer,
                SignatureKeyPair::new(SUITE.signature_algorithm())
                    .map_err(|_| Error::Crypto("signer initialization failed"))?,
            ),
            group: Some(group),
            identity: self.identity.clone(),
            peer: welcome.daemon_identity,
            context: expected.clone(),
            accepted: BTreeSet::new(),
            previous_epoch_deadlines: BTreeMap::new(),
            last_wall_time_ms,
            clock,
            transaction_pending: true,
        };
        self.endpoint = Some(endpoint);
        Ok(())
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn join_published_welcome(
        &mut self,
        bytes: &[u8],
        crypto_session_id: Id,
        daemon_identity: Identity,
        clock: Arc<dyn Clock>,
    ) -> Result<PairContext, Error> {
        if bytes.len() > HANDSHAKE_MAX_BYTES {
            return Err(Error::BoundExceeded("Welcome"));
        }
        if daemon_identity.role != Role::Daemon
            || daemon_identity.account_id != self.identity.account_id
            || daemon_identity.installation_id != self.identity.installation_id
        {
            return Err(Error::InvalidIdentity("Welcome daemon identity mismatch"));
        }
        let message = MlsMessageIn::tls_deserialize_exact(bytes)
            .map_err(|_| Error::Crypto("invalid Welcome encoding"))?;
        let MlsMessageBodyIn::Welcome(welcome_message) = message.extract() else {
            return Err(Error::UnexpectedMessage);
        };
        if welcome_message.ciphersuite() != SUITE {
            return Err(Error::WrongSuite);
        }
        let staged =
            StagedWelcome::new_from_welcome(&self.provider, &join_config(), welcome_message, None)
                .map_err(|_| Error::Crypto("Welcome join failed"))?;
        let group_id: GroupIdBytes = staged
            .group_context()
            .group_id()
            .as_slice()
            .try_into()
            .map_err(|_| Error::WrongGroup)?;
        validate_members_iter(staged.members(), &daemon_identity, &self.identity)?;
        let context = PairContext {
            crypto_session_id,
            group_id,
            account_id: self.identity.account_id,
            installation_id: self.identity.installation_id,
            device_id: self.identity.device_id,
        };
        let group = staged
            .into_group(&self.provider)
            .map_err(|_| Error::Crypto("Welcome persistence failed"))?;
        let last_wall_time_ms = clock.now_ms()?;
        self.endpoint = Some(Endpoint {
            provider: std::mem::replace(
                &mut self.provider,
                CoreProvider::new().map_err(|_| Error::Crypto("provider initialization failed"))?,
            ),
            signer: std::mem::replace(
                &mut self.signer,
                SignatureKeyPair::new(SUITE.signature_algorithm())
                    .map_err(|_| Error::Crypto("signer initialization failed"))?,
            ),
            group: Some(group),
            identity: self.identity.clone(),
            peer: daemon_identity,
            context: context.clone(),
            accepted: BTreeSet::new(),
            previous_epoch_deadlines: BTreeMap::new(),
            last_wall_time_ms,
            clock,
            transaction_pending: true,
        });
        Ok(context)
    }

    #[cfg(any(test, feature = "browser-test-fixtures"))]
    fn endpoint(&self) -> Result<&Endpoint, Error> {
        self.endpoint.as_ref().ok_or(Error::WrongGroup)
    }
    fn endpoint_mut(&mut self) -> Result<&mut Endpoint, Error> {
        self.endpoint.as_mut().ok_or(Error::WrongGroup)
    }

    pub(crate) fn prepare_application(
        &mut self,
        id: Id,
        generation: u64,
        plaintext: &[u8],
    ) -> Result<PreparedEnvelope, Error> {
        self.endpoint_mut()?.prepare_application(
            MessageClass::ApplicationRequest,
            id,
            generation,
            plaintext,
        )
    }
    pub(crate) fn receive_application(
        &mut self,
        bytes: &[u8],
        id: Id,
        generation: u64,
    ) -> Result<PreparedPlaintext, Error> {
        self.endpoint_mut()?.receive_application(
            bytes,
            MessageClass::ApplicationDelivery,
            id,
            generation,
        )
    }
    pub(crate) fn prepare_pair_activation(
        &mut self,
        id: Id,
        plaintext: &[u8],
    ) -> Result<PreparedEnvelope, Error> {
        self.endpoint_mut()?
            .prepare_control(MessageClass::PairActivation, id, 0, plaintext)
    }

    pub(crate) fn prepare_self_update(
        &mut self,
        id: Id,
        generation: u64,
    ) -> Result<PreparedEnvelope, Error> {
        let endpoint = self.endpoint_mut()?;
        endpoint.ensure_ready()?;
        let aad = endpoint
            .context
            .aad(Role::Device, MessageClass::UpdateProposal, id, generation)
            .encode();
        let provider = &endpoint.provider;
        let signer = &endpoint.signer;
        let group = endpoint
            .group
            .as_mut()
            .ok_or(Error::InactiveAfterRollback)?;
        let epoch = group.epoch().as_u64();
        group.set_aad(aad);
        let (proposal, _) = group
            .propose_self_update(provider, signer, LeafNodeParameters::default())
            .map_err(|_| Error::Crypto("self-Update proposal failed"))?;
        let bytes = proposal
            .tls_serialize_detached()
            .map_err(|_| Error::Crypto("proposal serialization failed"))?;
        let envelope = bounded_envelope(
            bytes,
            endpoint.context.crypto_session_id,
            id,
            MessageClass::UpdateProposal,
            epoch,
            generation,
        )?;
        endpoint.transaction_pending = true;
        Ok(envelope)
    }
    pub(crate) fn apply_commit(
        &mut self,
        bytes: &[u8],
        id: Id,
        generation: u64,
    ) -> Result<CommitMetadata, Error> {
        self.apply_commit_inner(bytes, id, generation, false)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn apply_removal(
        &mut self,
        bytes: &[u8],
        id: Id,
        generation: u64,
    ) -> Result<CommitMetadata, Error> {
        self.apply_commit_inner(bytes, id, generation, true)
    }

    fn apply_commit_inner(
        &mut self,
        bytes: &[u8],
        id: Id,
        generation: u64,
        removal: bool,
    ) -> Result<CommitMetadata, Error> {
        let endpoint = self.endpoint_mut()?;
        endpoint.ensure_ready()?;
        let protocol = decode_protocol(bytes)?;
        if protocol.group_id() != endpoint.group()?.group_id() {
            return Err(Error::WrongGroup);
        }
        if protocol.epoch() != endpoint.group()?.epoch() {
            return Err(Error::CompetingCommit);
        }
        let old_epoch = endpoint.group()?.epoch().as_u64();
        let provider = &endpoint.provider;
        let processed = endpoint
            .group
            .as_mut()
            .ok_or(Error::InactiveAfterRollback)?
            .process_message(provider, protocol)
            .map_err(|_| Error::CompetingCommit)?;
        if let Err(error) = Aad::validate_exact(
            processed.aad(),
            &endpoint.expected_aad(MessageClass::Commit, id, generation),
        ) {
            endpoint.invalidate();
            return Err(error);
        }
        if let Err(error) = validate_sender(&processed, &endpoint.peer) {
            endpoint.invalidate();
            return Err(error);
        }
        let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
            endpoint.invalidate();
            return Err(Error::UnexpectedMessage);
        };
        endpoint
            .group
            .as_mut()
            .ok_or(Error::InactiveAfterRollback)?
            .merge_staged_commit(provider, *staged)
            .map_err(|_| Error::CompetingCommit)?;
        if removal {
            if endpoint.group()?.is_active() || endpoint.group()?.members().count() != 1 {
                endpoint.invalidate();
                return Err(Error::NotTwoMembers);
            }
        } else {
            validate_members(endpoint.group()?, &endpoint.peer, &endpoint.identity)?;
        }
        let commit_id = provider
            .crypto()
            .hash(SUITE.hash_algorithm(), bytes)
            .map_err(|_| Error::Crypto("commit hash failed"))?
            .try_into()
            .map_err(|_| Error::Crypto("unexpected commit hash length"))?;
        if let Err(error) = endpoint.mark_epoch_advanced(old_epoch) {
            endpoint.invalidate();
            return Err(error);
        }
        let target_epoch = endpoint.group()?.epoch().as_u64();
        let epoch_authenticator = endpoint
            .group()?
            .epoch_authenticator()
            .as_slice()
            .try_into()
            .map_err(|_| Error::Crypto("unexpected epoch authenticator length"))?;
        endpoint.transaction_pending = true;
        Ok(CommitMetadata {
            commit_id,
            target_epoch,
            epoch_authenticator,
        })
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn continue_pending_transaction(&mut self) -> Result<(), Error> {
        let endpoint = self.endpoint_mut()?;
        if !endpoint.transaction_pending {
            return Err(Error::NoPreparedTransaction);
        }
        endpoint.transaction_pending = false;
        Ok(())
    }

    pub(crate) fn prepare_epoch_ready(
        &mut self,
        id: Id,
        generation: u64,
        plaintext: &[u8],
    ) -> Result<PreparedEnvelope, Error> {
        self.endpoint_mut()?
            .prepare_control(MessageClass::EpochReady, id, generation, plaintext)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn receive_resync_control(
        &mut self,
        bytes: &[u8],
        id: Id,
        generation: u64,
    ) -> Result<PreparedPlaintext, Error> {
        self.endpoint_mut()?
            .receive_control(bytes, MessageClass::ResyncControl, id, generation)
    }

    #[cfg(any(test, feature = "browser-test-fixtures"))]
    pub(crate) fn finish_transaction(&mut self, outcome: TransactionOutcome) -> Result<(), Error> {
        self.endpoint_mut()?.finish_transaction(outcome)
    }
    #[cfg(any(test, feature = "browser-test-fixtures"))]
    pub(crate) fn epoch(&self) -> Result<u64, Error> {
        self.endpoint()?.epoch()
    }
    #[cfg(any(test, feature = "browser-test-fixtures"))]
    pub(crate) fn epoch_authenticator(&self) -> Result<Vec<u8>, Error> {
        self.endpoint()?.epoch_authenticator()
    }
}

fn make_credential(
    provider: &CoreProvider,
    identity: &Identity,
) -> Result<(CredentialWithKey, SignatureKeyPair), Error> {
    let signer = SignatureKeyPair::new(SUITE.signature_algorithm())
        .map_err(|_| Error::Crypto("signing key generation failed"))?;
    signer
        .store(provider.storage())
        .map_err(|_| Error::Crypto("signing key storage failed"))?;
    let credential = BasicCredential::new(identity.credential_bytes(signer.public())?);
    Ok((
        CredentialWithKey {
            credential: credential.into(),
            signature_key: signer.public().into(),
        },
        signer,
    ))
}

fn validate_phone_key_package(
    provider: &CoreProvider,
    bytes: &[u8],
    identity: &Identity,
    now_ms: u64,
) -> Result<KeyPackage, Error> {
    if bytes.is_empty() || bytes.len() > HANDSHAKE_MAX_BYTES {
        return Err(Error::BoundExceeded("KeyPackage"));
    }
    let package_in = KeyPackageIn::tls_deserialize_exact(bytes)
        .map_err(|_| Error::Crypto("invalid KeyPackage encoding"))?;
    let unverified = package_in.unverified_credential();
    let pairing_credential =
        pairing::PairingCredential::decode(unverified.credential.serialized_content())
            .map_err(|_| Error::InvalidIdentity("invalid KeyPackage credential"))?;
    if pairing_credential.identity() != identity
        || unverified.signature_key.as_slice() != pairing_credential.verification_key()
    {
        return Err(Error::InvalidIdentity(
            "KeyPackage credential does not match claim",
        ));
    }
    let package = package_in
        .validate(provider.crypto(), ProtocolVersion::Mls10)
        .map_err(|_| Error::Crypto("KeyPackage validation failed"))?;
    if package.ciphersuite() != SUITE {
        return Err(Error::WrongSuite);
    }
    let lifetime = package.life_time();
    let now_seconds = now_ms / 1_000;
    if lifetime.not_after().checked_sub(lifetime.not_before()) != Some(KEY_PACKAGE_LIFETIME_SECONDS)
        || now_seconds < lifetime.not_before()
        || now_seconds >= lifetime.not_after()
    {
        return Err(Error::Crypto("invalid KeyPackage lifetime"));
    }
    let capabilities = package.leaf_node().capabilities();
    if !capabilities.versions().contains(&ProtocolVersion::Mls10)
        || !capabilities
            .ciphersuites()
            .contains(&VerifiableCiphersuite::from(SUITE))
        || !capabilities.credentials().contains(&CredentialType::Basic)
    {
        return Err(Error::Crypto("invalid KeyPackage capabilities"));
    }
    Ok(package)
}

fn ensure_suite(provider: &CoreProvider) -> Result<(), Error> {
    if u16::from(SUITE) != SUITE_VALUE {
        return Err(Error::WrongSuite);
    }
    provider
        .crypto()
        .supports(SUITE)
        .map_err(|_| Error::WrongSuite)
}

fn join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(true)
        .sender_ratchet_configuration(SenderRatchetConfiguration::new(32, 1000))
        .max_past_epochs(MAX_PAST_EPOCHS as usize)
        .build()
}

fn decode_protocol(bytes: &[u8]) -> Result<ProtocolMessage, Error> {
    if bytes.len() > ENVELOPE_MAX_BYTES {
        return Err(Error::BoundExceeded("MLS envelope"));
    }
    MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(|_| Error::InvalidCiphertext)?
        .try_into_protocol_message()
        .map_err(|_| Error::UnexpectedMessage)
}

fn validate_sender(processed: &ProcessedMessage, expected: &Identity) -> Result<(), Error> {
    if Identity::parse_credential(processed.credential().serialized_content())? != *expected {
        return Err(Error::InvalidIdentity(
            "authenticated sender does not match pair",
        ));
    }
    Ok(())
}

fn validate_members(group: &MlsGroup, daemon: &Identity, device: &Identity) -> Result<(), Error> {
    validate_members_iter(group.members(), daemon, device)
}

fn validate_members_iter(
    members: impl Iterator<Item = Member>,
    daemon: &Identity,
    device: &Identity,
) -> Result<(), Error> {
    let identities = members
        .map(|member| Identity::parse_credential(member.credential.serialized_content()))
        .collect::<Result<Vec<_>, _>>()?;
    if identities.len() != 2 || !identities.contains(daemon) || !identities.contains(device) {
        return Err(Error::NotTwoMembers);
    }
    Ok(())
}

fn bounded_envelope(
    bytes: Vec<u8>,
    crypto_session_id: Id,
    logical_message_id: Id,
    class: MessageClass,
    epoch: u64,
    hosted_generation: u64,
) -> Result<PreparedEnvelope, Error> {
    let class_limit = match class {
        MessageClass::ApplicationRequest | MessageClass::ApplicationDelivery => ENVELOPE_MAX_BYTES,
        MessageClass::UpdateProposal | MessageClass::Commit => HANDSHAKE_MAX_BYTES,
        MessageClass::EpochReady | MessageClass::PairActivation | MessageClass::ResyncControl => {
            2 * 1024
        }
    };
    if bytes.len() > class_limit {
        return Err(Error::BoundExceeded("MLS envelope"));
    }
    Ok(PreparedEnvelope {
        crypto_session_id,
        logical_message_id,
        class,
        epoch,
        hosted_generation,
        commit: None,
        ciphertext: bytes.into_boxed_slice(),
    })
}

fn put_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_be_bytes());
}
fn put_u8_vector(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), Error> {
    let len = u8::try_from(bytes.len()).map_err(|_| Error::BoundExceeded("TLS vector"))?;
    out.push(len);
    out.extend_from_slice(bytes);
    Ok(())
}

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    fn take(&mut self, len: usize) -> Result<&'a [u8], Error> {
        let end = self.offset.checked_add(len).ok_or(Error::InvalidAad)?;
        let result = self.bytes.get(self.offset..end).ok_or(Error::InvalidAad)?;
        self.offset = end;
        Ok(result)
    }
    fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, Error> {
        Ok(u16::from_be_bytes(self.array()?))
    }
    fn u64(&mut self) -> Result<u64, Error> {
        Ok(u64::from_be_bytes(self.array()?))
    }
    fn array<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        self.take(N)?.try_into().map_err(|_| Error::InvalidAad)
    }
    fn u8_vector(&mut self) -> Result<&'a [u8], Error> {
        let len = usize::from(self.u8()?);
        self.take(len)
    }
    fn finish(self) -> Result<(), Error> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(Error::InvalidAad)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_key_package_lifetime_and_capabilities() {
        let context = PairContext {
            crypto_session_id: [11; 16],
            group_id: [12; 32],
            account_id: [13; 16],
            installation_id: [14; 16],
            device_id: [15; 16],
        };
        let identity = Identity::device(
            context.account_id,
            context.installation_id,
            context.device_id,
        )
        .unwrap();
        let provider = CoreProvider::new().unwrap();
        let (credential, signer) = make_credential(&provider, &identity).unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let expired = KeyPackage::builder()
            .key_package_lifetime(Lifetime::init(now.saturating_sub(601), now))
            .build(SUITE, &provider, &signer, credential.clone())
            .unwrap();
        let long_lived = KeyPackage::builder()
            .key_package_lifetime(Lifetime::init(
                now.saturating_sub(3_600),
                now + KEY_PACKAGE_LIFETIME_SECONDS,
            ))
            .build(SUITE, &provider, &signer, credential.clone())
            .unwrap();
        let empty_capabilities = KeyPackage::builder()
            .key_package_lifetime(Lifetime::init(now, now + KEY_PACKAGE_LIFETIME_SECONDS))
            .leaf_node_capabilities(Capabilities::empty())
            .build(SUITE, &provider, &signer, credential)
            .unwrap();
        let daemon_identity = Identity::daemon(context.account_id, context.installation_id);
        let mut daemon = Daemon::create(daemon_identity, context.clone()).unwrap();
        assert!(matches!(
            daemon.consume_key_package(PhoneKeyPackage {
                bytes: expired
                    .key_package()
                    .tls_serialize_detached()
                    .unwrap()
                    .into_boxed_slice(),
                identity: identity.clone(),
            }),
            Err(Error::Crypto("KeyPackage validation failed"))
        ));
        let mut daemon = Daemon::create(
            Identity::daemon(context.account_id, context.installation_id),
            context.clone(),
        )
        .unwrap();
        assert!(matches!(
            daemon.consume_key_package(PhoneKeyPackage {
                bytes: long_lived
                    .key_package()
                    .tls_serialize_detached()
                    .unwrap()
                    .into_boxed_slice(),
                identity: identity.clone(),
            }),
            Err(Error::Crypto("invalid KeyPackage lifetime"))
        ));
        let mut daemon = Daemon::create(
            Identity::daemon(context.account_id, context.installation_id),
            context,
        )
        .unwrap();
        assert!(matches!(
            daemon.consume_key_package(PhoneKeyPackage {
                bytes: empty_capabilities
                    .key_package()
                    .tls_serialize_detached()
                    .unwrap()
                    .into_boxed_slice(),
                identity,
            }),
            Err(Error::Crypto("invalid KeyPackage capabilities"))
        ));
    }

    #[test]
    fn rejects_a_valid_key_package_from_another_suite() {
        let context = PairContext {
            crypto_session_id: [1; 16],
            group_id: [2; 32],
            account_id: [3; 16],
            installation_id: [4; 16],
            device_id: [5; 16],
        };
        let identity = Identity::device(
            context.account_id,
            context.installation_id,
            context.device_id,
        )
        .unwrap();
        let provider = CoreProvider::new().unwrap();
        let other_suite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
        let signer = SignatureKeyPair::new(other_suite.signature_algorithm()).unwrap();
        signer.store(provider.storage()).unwrap();
        let credential = BasicCredential::new(identity.credential_bytes(signer.public()).unwrap());
        let credential = CredentialWithKey {
            credential: credential.into(),
            signature_key: signer.public().into(),
        };
        let bundle = KeyPackage::builder()
            .build(other_suite, &provider, &signer, credential)
            .unwrap();
        let package = PhoneKeyPackage {
            bytes: bundle
                .key_package()
                .tls_serialize_detached()
                .unwrap()
                .into_boxed_slice(),
            identity,
        };
        let daemon_identity = Identity::daemon(context.account_id, context.installation_id);
        let mut daemon = Daemon::create(daemon_identity, context).unwrap();
        assert_eq!(
            daemon.consume_key_package(package).unwrap_err(),
            Error::WrongSuite
        );
    }
}

#[cfg(test)]
mod core_tests;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod persistence_tests;
