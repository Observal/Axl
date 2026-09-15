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
    time::{Duration, Instant},
};

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_libcrux_crypto::Provider;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

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

const SUITE: Ciphersuite = Ciphersuite::MLS_128_MLKEM768X25519_AES256GCM_SHA384_Ed25519;
const ZERO_ID: [u8; 16] = [0; 16];

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
    pub fn commit_metadata(&self) -> Option<&CommitMetadata> {
        self.commit.as_ref()
    }
    pub fn ciphertext(&self) -> &[u8] {
        &self.ciphertext
    }
}

/// Outcome reported by the platform transaction enclosing one prepared operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransactionOutcome {
    Committed,
    RolledBack,
}

/// Platform-neutral provider contract Session 40B must implement with durable storage.
///
/// The transaction's provider is the provider passed to OpenMLS while it advances state. The
/// adapter then stages the immutable envelope or accepted-message identity in that same
/// transaction. Network transmission and plaintext release are forbidden until `commit` returns.
/// No relay route appears in this contract.
pub trait TransactionalProvider: OpenMlsProvider {
    type TransactionError: StdError + Send + Sync + 'static;
    type Transaction<'a>: GroupTransaction<Provider = Self, Error = Self::TransactionError>
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
pub trait GroupTransaction {
    type Provider: OpenMlsProvider;
    type Error: StdError + Send + Sync + 'static;

    fn provider(&self) -> &Self::Provider;
    fn stage_envelope(&mut self, envelope: &PreparedEnvelope) -> Result<(), Self::Error>;
    fn stage_received(
        &mut self,
        crypto_session_id: Id,
        logical_message_id: Id,
        epoch: u64,
    ) -> Result<(), Self::Error>;
    fn commit(self) -> Result<(), Self::Error>;
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
    provider: Provider,
    signer: SignatureKeyPair,
    group: Option<MlsGroup>,
    identity: Identity,
    peer: Identity,
    context: PairContext,
    accepted: BTreeSet<Id>,
    previous_epoch_deadlines: BTreeMap<u64, Instant>,
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

    fn validate_incoming(&self, message: &ProtocolMessage) -> Result<(), Error> {
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
                .is_none_or(|deadline| Instant::now() > *deadline)
        {
            return Err(Error::StaleEpoch);
        }
        Ok(())
    }

    fn mark_epoch_advanced(&mut self, old_epoch: u64) {
        let current = self
            .group
            .as_ref()
            .map_or(old_epoch, |group| group.epoch().as_u64());
        self.previous_epoch_deadlines
            .insert(old_epoch, Instant::now() + PAST_EPOCH_MAX_AGE);
        self.previous_epoch_deadlines
            .retain(|epoch, _| current.saturating_sub(*epoch) <= u64::from(MAX_PAST_EPOCHS));
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
        )?;
        self.transaction_pending = true;
        Ok(envelope)
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

    fn finish_transaction(&mut self, outcome: TransactionOutcome) -> Result<(), Error> {
        if !self.transaction_pending {
            return Err(Error::NoPreparedTransaction);
        }
        match outcome {
            TransactionOutcome::Committed => self.transaction_pending = false,
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
pub struct Daemon {
    endpoint: Endpoint,
    key_package_consumed: bool,
}

impl Daemon {
    pub fn create(identity: Identity, context: PairContext) -> Result<Self, Error> {
        if identity.role != Role::Daemon
            || identity.account_id != context.account_id
            || identity.installation_id != context.installation_id
        {
            return Err(Error::InvalidIdentity("daemon does not match pair context"));
        }
        let provider =
            Provider::new().map_err(|_| Error::Crypto("provider initialization failed"))?;
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
                transaction_pending: false,
            },
            key_package_consumed: false,
        })
    }

    pub fn consume_key_package(&mut self, package: PhoneKeyPackage) -> Result<PairWelcome, Error> {
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
        let key_package_in = KeyPackageIn::tls_deserialize_exact(package.bytes.as_ref())
            .map_err(|_| Error::Crypto("invalid KeyPackage encoding"))?;
        let unverified = key_package_in.unverified_credential();
        if Identity::parse_credential(unverified.credential.serialized_content())?
            != package.identity
        {
            return Err(Error::InvalidIdentity(
                "KeyPackage credential does not match claim",
            ));
        }
        let key_package = key_package_in
            .validate(self.endpoint.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|_| Error::Crypto("KeyPackage validation failed"))?;
        if key_package.ciphersuite() != SUITE {
            return Err(Error::WrongSuite);
        }
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

    pub fn prepare_application(
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

    pub fn receive_application(
        &mut self,
        bytes: &[u8],
        id: Id,
        generation: u64,
    ) -> Result<PreparedPlaintext, Error> {
        self.endpoint
            .receive_application(bytes, MessageClass::ApplicationRequest, id, generation)
    }

    pub fn receive_update_proposal(
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

    pub fn prepare_commit(&mut self, id: Id, generation: u64) -> Result<PreparedEnvelope, Error> {
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
        self.endpoint.mark_epoch_advanced(epoch);
        let mut envelope = bounded_envelope(
            bytes,
            self.endpoint.context.crypto_session_id,
            id,
            MessageClass::Commit,
            epoch,
        )?;
        envelope.commit = Some(CommitMetadata {
            commit_id,
            target_epoch,
            epoch_authenticator,
        });
        self.endpoint.transaction_pending = true;
        Ok(envelope)
    }

    pub fn finish_transaction(&mut self, outcome: TransactionOutcome) -> Result<(), Error> {
        self.endpoint.finish_transaction(outcome)
    }
    pub fn epoch(&self) -> Result<u64, Error> {
        self.endpoint.epoch()
    }
    pub fn epoch_authenticator(&self) -> Result<Vec<u8>, Error> {
        self.endpoint.epoch_authenticator()
    }
}

/// Phone member. It may create self-Update proposals but cannot create commits.
pub struct Phone {
    endpoint: Option<Endpoint>,
    provider: Provider,
    signer: SignatureKeyPair,
    identity: Identity,
}

impl Phone {
    pub fn create(identity: Identity) -> Result<(Self, PhoneKeyPackage), Error> {
        if identity.role != Role::Device {
            return Err(Error::InvalidIdentity("phone must use device role"));
        }
        identity.validate()?;
        let provider =
            Provider::new().map_err(|_| Error::Crypto("provider initialization failed"))?;
        ensure_suite(&provider)?;
        let (credential, signer) = make_credential(&provider, &identity)?;
        let bundle = KeyPackage::builder()
            .key_package_lifetime(Lifetime::new(KEY_PACKAGE_LIFETIME_SECONDS))
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

    pub fn join(&mut self, welcome: PairWelcome, expected: &PairContext) -> Result<(), Error> {
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
        let endpoint = Endpoint {
            provider: std::mem::replace(
                &mut self.provider,
                Provider::new().map_err(|_| Error::Crypto("provider initialization failed"))?,
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
            transaction_pending: true,
        };
        self.endpoint = Some(endpoint);
        Ok(())
    }

    fn endpoint(&self) -> Result<&Endpoint, Error> {
        self.endpoint.as_ref().ok_or(Error::WrongGroup)
    }
    fn endpoint_mut(&mut self) -> Result<&mut Endpoint, Error> {
        self.endpoint.as_mut().ok_or(Error::WrongGroup)
    }

    pub fn prepare_application(
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
    pub fn receive_application(
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
    pub fn prepare_self_update(
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
        )?;
        endpoint.transaction_pending = true;
        Ok(envelope)
    }
    pub fn apply_commit(&mut self, bytes: &[u8], id: Id, generation: u64) -> Result<(), Error> {
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
        validate_members(endpoint.group()?, &endpoint.peer, &endpoint.identity)?;
        endpoint.mark_epoch_advanced(old_epoch);
        endpoint.transaction_pending = true;
        Ok(())
    }
    pub fn finish_transaction(&mut self, outcome: TransactionOutcome) -> Result<(), Error> {
        self.endpoint_mut()?.finish_transaction(outcome)
    }
    pub fn epoch(&self) -> Result<u64, Error> {
        self.endpoint()?.epoch()
    }
    pub fn epoch_authenticator(&self) -> Result<Vec<u8>, Error> {
        self.endpoint()?.epoch_authenticator()
    }
}

fn make_credential(
    provider: &Provider,
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

fn ensure_suite(provider: &Provider) -> Result<(), Error> {
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
        let provider = Provider::new().unwrap();
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
