// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

//! Test-only fresh-randomness browser execution of the complete in-memory OpenMLS lifecycle.
//!
//! This module is compiled only for the browser fixture artifact. It supplies no persistence,
//! rollback anchor, or production endpoint capability.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use openmls::prelude::{GroupId, MlsGroup, MlsMessageOut};
use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::OpenMlsProvider as _;
use tls_codec::Serialize as _;

use crate::{
    Clock, CoreProvider, Daemon, ENVELOPE_MAX_BYTES, Error, Identity, MessageClass, PairContext,
    Phone, Role, SUITE, SUITE_VALUE, TransactionOutcome,
};

struct FixedClock(u64);

impl Clock for FixedClock {
    fn now_ms(&self) -> Result<u64, Error> {
        Ok(self.0)
    }
}

/// Non-secret evidence returned after a complete fresh OpenMLS lifecycle succeeds.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserLifecycleEvidence {
    pub suite: u16,
    pub key_package_bytes: usize,
    pub welcome_bytes: usize,
    pub activation_bytes: usize,
    pub application_bytes: usize,
    pub delivery_bytes: usize,
    pub proposal_bytes: usize,
    pub commit_bytes: usize,
    pub epoch_ready_bytes: usize,
    pub initial_epoch: u64,
    pub updated_epoch: u64,
}

/// Non-secret evidence from focused negative OpenMLS operations in the browser artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserNegativeEvidence {
    pub mls_replay: &'static str,
    pub duplicate_ciphertext: &'static str,
    pub mutation_corruption: &'static str,
    pub aad_mismatch: &'static str,
    pub identity_mismatch: &'static str,
    pub profile_mismatch: &'static str,
    pub competing_commit: &'static str,
}

fn id(value: u8) -> [u8; 16] {
    [value; 16]
}

fn committed_daemon(daemon: &mut Daemon) -> Result<(), Error> {
    daemon.finish_transaction(TransactionOutcome::Committed)
}

fn committed_phone(phone: &mut Phone) -> Result<(), Error> {
    phone.finish_transaction(TransactionOutcome::Committed)
}

fn require(condition: bool, message: &'static str) -> Result<(), Error> {
    if condition {
        Ok(())
    } else {
        Err(Error::Crypto(message))
    }
}

fn pair(now_ms: u64, marker: u8) -> Result<(Daemon, Phone, PairContext, usize, usize), Error> {
    let context = PairContext {
        crypto_session_id: id(marker),
        group_id: [marker.wrapping_add(1); 32],
        account_id: id(marker.wrapping_add(2)),
        installation_id: id(marker.wrapping_add(3)),
        device_id: id(marker.wrapping_add(4)),
    };
    let daemon_identity = Identity::daemon(context.account_id, context.installation_id);
    let device_identity = Identity::device(
        context.account_id,
        context.installation_id,
        context.device_id,
    )?;
    let clock = FixedClock(now_ms);
    let (mut device, key_package) = Phone::create_with_clock(device_identity, &clock)?;
    let key_package_bytes = key_package.bytes().len();
    let mut daemon = Daemon::create_with_clock(
        daemon_identity,
        context.clone(),
        Arc::new(FixedClock(now_ms)),
    )?;
    let welcome = daemon.consume_key_package(key_package)?;
    let welcome_bytes = welcome.bytes().len();
    committed_daemon(&mut daemon)?;
    device.join_with_clock(welcome, &context, Arc::new(FixedClock(now_ms)))?;
    committed_phone(&mut device)?;
    Ok((daemon, device, context, key_package_bytes, welcome_bytes))
}

fn error_name<T>(result: Result<T, Error>) -> &'static str {
    match result {
        Ok(_) => "unexpected_success",
        Err(Error::DuplicateCiphertext) => "duplicate_ciphertext",
        Err(Error::InvalidCiphertext) => "invalid_ciphertext",
        Err(Error::InvalidAad) => "invalid_aad",
        Err(Error::InvalidIdentity(_)) => "invalid_identity",
        Err(Error::WrongProfile) => "wrong_profile",
        Err(Error::CompetingCommit) => "competing_commit",
        Err(_) => "unexpected_error",
    }
}

fn profile_mismatch_message(
    phone: &mut Phone,
    logical_message_id: [u8; 16],
    generation: u64,
) -> Result<Vec<u8>, Error> {
    let endpoint = phone.endpoint_mut()?;
    endpoint.ensure_ready()?;
    let mut aad = endpoint
        .context
        .aad(
            Role::Device,
            MessageClass::ApplicationRequest,
            logical_message_id,
            generation,
        )
        .encode();
    // TLS u16 profile version, TLS u8 profile-name length, then the profile bytes.
    aad[3] ^= 1;
    let provider = &endpoint.provider;
    let signer = &endpoint.signer;
    let group = endpoint
        .group
        .as_mut()
        .ok_or(Error::InactiveAfterRollback)?;
    group.set_aad(aad);
    let message: MlsMessageOut = group
        .create_message(provider, signer, b"wrong profile")
        .map_err(|_| Error::Crypto("profile mismatch encryption failed"))?;
    let bytes = message
        .tls_serialize_detached()
        .map_err(|_| Error::Crypto("profile mismatch serialization failed"))?;
    require(
        bytes.len() <= ENVELOPE_MAX_BYTES,
        "profile mismatch envelope exceeds relay bound",
    )?;
    endpoint.transaction_pending = true;
    Ok(bytes)
}

/// Executes KeyPackage creation, Welcome join, activation, application traffic, a self-Update
/// proposal, daemon commit, device apply, and epoch-ready delivery with fresh browser randomness.
pub fn run_openmls_lifecycle(now_ms: u64) -> Result<BrowserLifecycleEvidence, Error> {
    let (mut daemon, mut device, context, key_package_bytes, welcome_bytes) = pair(now_ms, 0x31)?;

    let initial_epoch = daemon.epoch()?;
    require(initial_epoch == device.epoch()?, "initial epoch mismatch")?;
    require(
        daemon.epoch_authenticator()? == device.epoch_authenticator()?,
        "initial epoch authenticator mismatch",
    )?;

    let mut activation_plaintext = b"Axl pair activation v1".to_vec();
    activation_plaintext.extend_from_slice(&crate::PROFILE_REVISION.to_be_bytes());
    activation_plaintext.extend_from_slice(&context.crypto_session_id);
    activation_plaintext.extend_from_slice(&context.group_id);
    activation_plaintext.extend_from_slice(&[0x36; 48]);
    let activation = device.prepare_pair_activation(id(0x40), &activation_plaintext)?;
    let activation_bytes = activation.ciphertext().len();
    let activation_ciphertext = activation.ciphertext().to_vec();
    committed_phone(&mut device)?;
    let received_activation = daemon.receive_pair_activation(&activation_ciphertext, id(0x40))?;
    require(
        received_activation.plaintext() == activation_plaintext,
        "activation plaintext mismatch",
    )?;
    committed_daemon(&mut daemon)?;

    let application_plaintext = b"browser OpenMLS application v1";
    let application = device.prepare_application(id(0x41), 7, application_plaintext)?;
    let application_bytes = application.ciphertext().len();
    let application_ciphertext = application.ciphertext().to_vec();
    committed_phone(&mut device)?;
    let received_application = daemon.receive_application(&application_ciphertext, id(0x41), 7)?;
    require(
        received_application.plaintext() == application_plaintext,
        "application plaintext mismatch",
    )?;
    committed_daemon(&mut daemon)?;

    let delivery_plaintext = b"browser OpenMLS delivery v1";
    let delivery = daemon.prepare_application(id(0x45), 7, delivery_plaintext)?;
    let delivery_bytes = delivery.ciphertext().len();
    let delivery_ciphertext = delivery.ciphertext().to_vec();
    committed_daemon(&mut daemon)?;
    let received_delivery = device.receive_application(&delivery_ciphertext, id(0x45), 7)?;
    require(
        received_delivery.plaintext() == delivery_plaintext,
        "delivery plaintext mismatch",
    )?;
    committed_phone(&mut device)?;

    let proposal = device.prepare_self_update(id(0x42), 7)?;
    let proposal_bytes = proposal.ciphertext().len();
    let proposal_ciphertext = proposal.ciphertext().to_vec();
    committed_phone(&mut device)?;
    daemon.receive_update_proposal(&proposal_ciphertext, id(0x42), 7)?;
    committed_daemon(&mut daemon)?;

    let commit = daemon.prepare_commit(id(0x43), 7)?;
    let commit_bytes = commit.ciphertext().len();
    let commit_ciphertext = commit.ciphertext().to_vec();
    let commit_metadata = commit
        .commit_metadata()
        .ok_or(Error::Crypto("commit metadata missing"))?
        .clone();
    committed_daemon(&mut daemon)?;
    device.apply_commit(&commit_ciphertext, id(0x43), 7)?;
    committed_phone(&mut device)?;

    let updated_epoch = daemon.epoch()?;
    require(updated_epoch == initial_epoch + 1, "epoch did not advance")?;
    require(updated_epoch == device.epoch()?, "updated epoch mismatch")?;
    require(
        daemon.epoch_authenticator()? == device.epoch_authenticator()?,
        "updated epoch authenticator mismatch",
    )?;
    require(
        commit_metadata.target_epoch == updated_epoch,
        "commit target epoch mismatch",
    )?;

    let mut epoch_ready_plaintext = Vec::with_capacity(18 + 2 + 16 + 32 + 48 + 8 + 48);
    epoch_ready_plaintext.extend_from_slice(b"Axl epoch ready v1");
    epoch_ready_plaintext.extend_from_slice(&crate::PROFILE_REVISION.to_be_bytes());
    epoch_ready_plaintext.extend_from_slice(&context.crypto_session_id);
    epoch_ready_plaintext.extend_from_slice(&context.group_id);
    epoch_ready_plaintext.extend_from_slice(&commit_metadata.commit_id);
    epoch_ready_plaintext.extend_from_slice(&commit_metadata.target_epoch.to_be_bytes());
    epoch_ready_plaintext.extend_from_slice(&commit_metadata.epoch_authenticator);
    let epoch_ready = device.prepare_epoch_ready(id(0x44), 0, &epoch_ready_plaintext)?;
    let epoch_ready_bytes = epoch_ready.ciphertext().len();
    let epoch_ready_ciphertext = epoch_ready.ciphertext().to_vec();
    committed_phone(&mut device)?;
    let received_ready = daemon.receive_epoch_ready(&epoch_ready_ciphertext, id(0x44), 0)?;
    require(
        received_ready.plaintext() == epoch_ready_plaintext,
        "epoch-ready plaintext mismatch",
    )?;
    committed_daemon(&mut daemon)?;

    Ok(BrowserLifecycleEvidence {
        suite: SUITE_VALUE,
        key_package_bytes,
        welcome_bytes,
        activation_bytes,
        application_bytes,
        delivery_bytes,
        proposal_bytes,
        commit_bytes,
        epoch_ready_bytes,
        initial_epoch,
        updated_epoch,
    })
}

/// Executes rejection paths against fresh OpenMLS state inside browser WASM.
pub fn run_openmls_negative_cases(now_ms: u64) -> Result<BrowserNegativeEvidence, Error> {
    let (mut replay_daemon, mut replay_phone, _, _, _) = pair(now_ms, 0x51)?;
    let replay_message = replay_phone.prepare_application(id(0x11), 3, b"replay")?;
    let replay_ciphertext = replay_message.ciphertext().to_vec();
    committed_phone(&mut replay_phone)?;
    replay_daemon.receive_application(&replay_ciphertext, id(0x11), 3)?;
    committed_daemon(&mut replay_daemon)?;
    let duplicate_ciphertext =
        error_name(replay_daemon.receive_application(&replay_ciphertext, id(0x11), 3));
    let mls_replay = error_name(replay_daemon.receive_application(&replay_ciphertext, id(0x12), 3));

    let (mut mutation_daemon, mut mutation_phone, _, _, _) = pair(now_ms, 0x61)?;
    let mutation_message =
        mutation_phone.prepare_application(id(0x21), 4, b"authenticated mutation")?;
    let mut mutation_ciphertext = mutation_message.ciphertext().to_vec();
    committed_phone(&mut mutation_phone)?;
    let last = mutation_ciphertext
        .last_mut()
        .ok_or(Error::Crypto("empty mutation ciphertext"))?;
    *last ^= 1;
    let mutation_corruption =
        error_name(mutation_daemon.receive_application(&mutation_ciphertext, id(0x21), 4));

    let (mut aad_daemon, mut aad_phone, _, _, _) = pair(now_ms, 0x71)?;
    let aad_message = aad_phone.prepare_application(id(0x31), 5, b"AAD mismatch")?;
    let aad_ciphertext = aad_message.ciphertext().to_vec();
    committed_phone(&mut aad_phone)?;
    let aad_mismatch = error_name(aad_daemon.receive_application(&aad_ciphertext, id(0x31), 6));

    let (mut identity_daemon, mut identity_phone, _, _, _) = pair(now_ms, 0x81)?;
    let identity_message = identity_phone.prepare_application(id(0x41), 6, b"identity mismatch")?;
    let identity_ciphertext = identity_message.ciphertext().to_vec();
    committed_phone(&mut identity_phone)?;
    identity_daemon.endpoint.peer.device_id[0] ^= 1;
    let identity_mismatch =
        error_name(identity_daemon.receive_application(&identity_ciphertext, id(0x41), 6));

    let (mut profile_daemon, mut profile_phone, _, _, _) = pair(now_ms, 0x91)?;
    let profile_ciphertext = profile_mismatch_message(&mut profile_phone, id(0x51), 7)?;
    committed_phone(&mut profile_phone)?;
    let profile_mismatch =
        error_name(profile_daemon.receive_application(&profile_ciphertext, id(0x51), 7));

    let (mut commit_daemon, mut commit_phone, _, _, _) = pair(now_ms, 0xa1)?;
    let proposal = commit_phone.prepare_self_update(id(0x61), 8)?;
    let proposal_ciphertext = proposal.ciphertext().to_vec();
    committed_phone(&mut commit_phone)?;
    commit_daemon.receive_update_proposal(&proposal_ciphertext, id(0x61), 8)?;
    committed_daemon(&mut commit_daemon)?;
    let commit = commit_daemon.prepare_commit(id(0x62), 8)?;
    let commit_ciphertext = commit.ciphertext().to_vec();
    committed_daemon(&mut commit_daemon)?;
    commit_phone.apply_commit(&commit_ciphertext, id(0x62), 8)?;
    committed_phone(&mut commit_phone)?;
    let competing_commit = error_name(commit_phone.apply_commit(&commit_ciphertext, id(0x62), 8));

    Ok(BrowserNegativeEvidence {
        mls_replay,
        duplicate_ciphertext,
        mutation_corruption,
        aad_mismatch,
        identity_mismatch,
        profile_mismatch,
        competing_commit,
    })
}

const PERSISTENCE_SNAPSHOT_MAGIC: &[u8; 8] = b"AXLBPS01";
const PERSISTENCE_SEED_MAGIC: &[u8; 8] = b"AXLBSE01";
const PERSISTENCE_MUTATION_MAGIC: &[u8; 8] = b"AXLBPM01";
const PERSISTENCE_IMAGE_MAX_BYTES: usize = 16 * 1024 * 1024;

/// Test-only seed returned to the dedicated persistence worker. It contains opaque OpenMLS state
/// and, for receive tests, two ordered inbound ciphertexts. It is never part of the production WASM.
pub fn browser_persistence_seed(now_ms: u64, receive: bool) -> Result<Vec<u8>, Error> {
    let (daemon, mut phone, context, _, _) = pair(now_ms, if receive { 0xb2 } else { 0xb1 })?;
    let (role, snapshot, input, additional_input) = if receive {
        let first = phone.prepare_application([0xc1; 16], 7, b"committed browser plaintext")?;
        let first_ciphertext = first.ciphertext().to_vec();
        committed_phone(&mut phone)?;
        let second =
            phone.prepare_application([0xc2; 16], 7, b"second committed browser plaintext")?;
        let second_ciphertext = second.ciphertext().to_vec();
        committed_phone(&mut phone)?;
        (
            Role::Daemon,
            encode_daemon_snapshot(&daemon)?,
            first_ciphertext,
            second_ciphertext,
        )
    } else {
        (
            Role::Device,
            encode_phone_snapshot(&phone)?,
            Vec::new(),
            Vec::new(),
        )
    };
    let mut output =
        Vec::with_capacity(8 + 1 + 16 + 12 + snapshot.len() + input.len() + additional_input.len());
    output.extend_from_slice(PERSISTENCE_SEED_MAGIC);
    output.push(role as u8);
    output.extend_from_slice(&context.crypto_session_id);
    put_blob(&mut output, &snapshot)?;
    put_blob(&mut output, &input)?;
    put_blob(&mut output, &additional_input)?;
    Ok(output)
}

/// Runs exactly one application-send OpenMLS transition from one committed test snapshot.
pub fn browser_persistence_send(
    snapshot: &[u8],
    operation_id: [u8; 16],
    plaintext: &[u8],
    now_ms: u64,
) -> Result<Vec<u8>, Error> {
    let mut phone = decode_phone_snapshot(snapshot, now_ms)?;
    let envelope = phone.prepare_application(operation_id, 7, plaintext)?;
    let result = envelope.ciphertext().to_vec();
    committed_phone(&mut phone)?;
    encode_pending_mutation(&encode_phone_snapshot(&phone)?, &result)
}

/// Runs exactly one application-receive OpenMLS transition from one committed test snapshot.
pub fn browser_persistence_receive(
    snapshot: &[u8],
    operation_id: [u8; 16],
    ciphertext: &[u8],
    now_ms: u64,
) -> Result<Vec<u8>, Error> {
    let mut daemon = decode_daemon_snapshot(snapshot, now_ms)?;
    let plaintext = daemon.receive_application(ciphertext, operation_id, 7)?;
    let result = plaintext.plaintext().to_vec();
    committed_daemon(&mut daemon)?;
    encode_pending_mutation(&encode_daemon_snapshot(&daemon)?, &result)
}

fn encode_pending_mutation(snapshot: &[u8], result: &[u8]) -> Result<Vec<u8>, Error> {
    let mut output = Vec::with_capacity(8 + 8 + snapshot.len() + result.len());
    output.extend_from_slice(PERSISTENCE_MUTATION_MAGIC);
    put_blob(&mut output, snapshot)?;
    put_blob(&mut output, result)?;
    Ok(output)
}

fn encode_daemon_snapshot(daemon: &Daemon) -> Result<Vec<u8>, Error> {
    encode_endpoint_snapshot(&daemon.endpoint, Role::Daemon)
}

fn encode_phone_snapshot(phone: &Phone) -> Result<Vec<u8>, Error> {
    encode_endpoint_snapshot(phone.endpoint()?, Role::Device)
}

fn encode_endpoint_snapshot(endpoint: &crate::Endpoint, role: Role) -> Result<Vec<u8>, Error> {
    let values = endpoint.provider.storage_values();
    let mut output = Vec::new();
    output.extend_from_slice(PERSISTENCE_SNAPSHOT_MAGIC);
    output.push(role as u8);
    encode_identity(&mut output, &endpoint.identity);
    encode_identity(&mut output, &endpoint.peer);
    output.extend_from_slice(&endpoint.context.crypto_session_id);
    output.extend_from_slice(&endpoint.context.group_id);
    output.extend_from_slice(&endpoint.context.account_id);
    output.extend_from_slice(&endpoint.context.installation_id);
    output.extend_from_slice(&endpoint.context.device_id);
    put_blob(&mut output, endpoint.signer.public())?;
    put_u32(&mut output, endpoint.previous_epoch_deadlines.len())?;
    for (epoch, deadline) in &endpoint.previous_epoch_deadlines {
        output.extend_from_slice(&epoch.to_be_bytes());
        output.extend_from_slice(&deadline.to_be_bytes());
    }
    output.extend_from_slice(&endpoint.last_wall_time_ms.to_be_bytes());
    put_u32(&mut output, endpoint.accepted.len())?;
    for accepted in &endpoint.accepted {
        output.extend_from_slice(accepted);
    }
    put_u32(&mut output, values.len())?;
    for (key, value) in values {
        put_blob(&mut output, &key)?;
        put_blob(&mut output, &value)?;
    }
    if output.len() > PERSISTENCE_IMAGE_MAX_BYTES {
        return Err(Error::BoundExceeded("browser persistence image"));
    }
    Ok(output)
}

fn decode_phone_snapshot(bytes: &[u8], now_ms: u64) -> Result<Phone, Error> {
    let decoded = decode_endpoint_snapshot(bytes, Role::Device, now_ms)?;
    let provider = decoded.provider;
    let group = MlsGroup::load(
        provider.storage(),
        &GroupId::from_slice(&decoded.context.group_id),
    )
    .map_err(|_| Error::Crypto("browser group load failed"))?
    .ok_or(Error::Crypto("browser group state missing"))?;
    let signer = SignatureKeyPair::read(
        provider.storage(),
        &decoded.signer_public,
        SUITE.signature_algorithm(),
    )
    .ok_or(Error::Crypto("browser signer state missing"))?;
    let identity = decoded.identity.clone();
    Ok(Phone {
        endpoint: Some(crate::Endpoint {
            provider,
            signer,
            group: Some(group),
            identity: decoded.identity,
            peer: decoded.peer,
            context: decoded.context,
            accepted: decoded.accepted,
            previous_epoch_deadlines: decoded.previous_epoch_deadlines,
            last_wall_time_ms: now_ms,
            clock: Arc::new(FixedClock(now_ms)),
            transaction_pending: false,
        }),
        provider: CoreProvider::new()
            .map_err(|_| Error::Crypto("provider initialization failed"))?,
        signer: SignatureKeyPair::new(SUITE.signature_algorithm())
            .map_err(|_| Error::Crypto("signer initialization failed"))?,
        identity,
    })
}

fn decode_daemon_snapshot(bytes: &[u8], now_ms: u64) -> Result<Daemon, Error> {
    let decoded = decode_endpoint_snapshot(bytes, Role::Daemon, now_ms)?;
    let provider = decoded.provider;
    let group = MlsGroup::load(
        provider.storage(),
        &GroupId::from_slice(&decoded.context.group_id),
    )
    .map_err(|_| Error::Crypto("browser group load failed"))?
    .ok_or(Error::Crypto("browser group state missing"))?;
    let signer = SignatureKeyPair::read(
        provider.storage(),
        &decoded.signer_public,
        SUITE.signature_algorithm(),
    )
    .ok_or(Error::Crypto("browser signer state missing"))?;
    Ok(Daemon {
        endpoint: crate::Endpoint {
            provider,
            signer,
            group: Some(group),
            identity: decoded.identity,
            peer: decoded.peer,
            context: decoded.context,
            accepted: decoded.accepted,
            previous_epoch_deadlines: decoded.previous_epoch_deadlines,
            last_wall_time_ms: now_ms,
            clock: Arc::new(FixedClock(now_ms)),
            transaction_pending: false,
        },
        key_package_consumed: true,
    })
}

struct DecodedEndpoint {
    provider: CoreProvider,
    identity: Identity,
    peer: Identity,
    context: PairContext,
    signer_public: Vec<u8>,
    accepted: BTreeSet<[u8; 16]>,
    previous_epoch_deadlines: BTreeMap<u64, u64>,
}

fn decode_endpoint_snapshot(
    bytes: &[u8],
    expected_role: Role,
    now_ms: u64,
) -> Result<DecodedEndpoint, Error> {
    if bytes.len() > PERSISTENCE_IMAGE_MAX_BYTES {
        return Err(Error::BoundExceeded("browser persistence image"));
    }
    let mut cursor = FixtureCursor::new(bytes);
    if cursor.take(8)? != PERSISTENCE_SNAPSHOT_MAGIC {
        return Err(Error::Crypto("browser snapshot magic mismatch"));
    }
    let role = decode_role(cursor.u8()?)?;
    if role != expected_role {
        return Err(Error::InvalidIdentity("browser snapshot role mismatch"));
    }
    let identity = decode_identity(&mut cursor)?;
    let peer = decode_identity(&mut cursor)?;
    if identity.role != role || identity.role == peer.role {
        return Err(Error::InvalidIdentity("browser snapshot identity mismatch"));
    }
    let context = PairContext {
        crypto_session_id: cursor.array()?,
        group_id: cursor.array()?,
        account_id: cursor.array()?,
        installation_id: cursor.array()?,
        device_id: cursor.array()?,
    };
    if context.crypto_session_id == [0; 16]
        || context.account_id != identity.account_id
        || context.installation_id != identity.installation_id
        || context.account_id != peer.account_id
        || context.installation_id != peer.installation_id
    {
        return Err(Error::InvalidIdentity("browser snapshot context mismatch"));
    }
    let signer_public = cursor.blob(64)?.to_vec();
    if signer_public.len() != 32 {
        return Err(Error::Crypto("browser snapshot signer mismatch"));
    }
    let deadline_count = cursor.u32()? as usize;
    if deadline_count > crate::MAX_PAST_EPOCHS as usize {
        return Err(Error::Crypto("browser snapshot deadline bound"));
    }
    let mut previous_epoch_deadlines = BTreeMap::new();
    for _ in 0..deadline_count {
        if previous_epoch_deadlines
            .insert(cursor.u64()?, cursor.u64()?)
            .is_some()
        {
            return Err(Error::Crypto("browser snapshot duplicate deadline"));
        }
    }
    let committed_now = cursor.u64()?;
    if now_ms < committed_now {
        return Err(Error::ClockRollback);
    }
    let accepted_count = cursor.u32()? as usize;
    if accepted_count > 4096 {
        return Err(Error::BoundExceeded("browser accepted-message records"));
    }
    let mut accepted = BTreeSet::new();
    for _ in 0..accepted_count {
        if !accepted.insert(cursor.array()?) {
            return Err(Error::Crypto("browser snapshot duplicate accepted message"));
        }
    }
    let value_count = cursor.u32()? as usize;
    if value_count > 65_536 {
        return Err(Error::BoundExceeded("browser provider records"));
    }
    let mut values = BTreeMap::new();
    for _ in 0..value_count {
        let key = cursor.blob(PERSISTENCE_IMAGE_MAX_BYTES)?.to_vec();
        let value = cursor.blob(PERSISTENCE_IMAGE_MAX_BYTES)?.to_vec();
        if values.insert(key, value).is_some() {
            return Err(Error::Crypto("browser snapshot duplicate provider key"));
        }
    }
    cursor.finish()?;
    let provider = CoreProvider::from_storage_values(values)
        .map_err(|_| Error::Crypto("provider initialization failed"))?;
    Ok(DecodedEndpoint {
        provider,
        identity,
        peer,
        context,
        signer_public,
        accepted,
        previous_epoch_deadlines,
    })
}

fn encode_identity(output: &mut Vec<u8>, identity: &Identity) {
    output.push(identity.role as u8);
    output.extend_from_slice(&identity.account_id);
    output.extend_from_slice(&identity.installation_id);
    output.extend_from_slice(&identity.device_id);
}

fn decode_identity(cursor: &mut FixtureCursor<'_>) -> Result<Identity, Error> {
    let identity = Identity {
        role: decode_role(cursor.u8()?)?,
        account_id: cursor.array()?,
        installation_id: cursor.array()?,
        device_id: cursor.array()?,
    };
    identity.validate()?;
    Ok(identity)
}

fn decode_role(value: u8) -> Result<Role, Error> {
    match value {
        1 => Ok(Role::Daemon),
        2 => Ok(Role::Device),
        _ => Err(Error::InvalidIdentity("browser snapshot role invalid")),
    }
}

fn put_u32(output: &mut Vec<u8>, value: usize) -> Result<(), Error> {
    output.extend_from_slice(
        &u32::try_from(value)
            .map_err(|_| Error::BoundExceeded("browser persistence field"))?
            .to_be_bytes(),
    );
    Ok(())
}

fn put_blob(output: &mut Vec<u8>, value: &[u8]) -> Result<(), Error> {
    put_u32(output, value.len())?;
    output.extend_from_slice(value);
    Ok(())
}

struct FixtureCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> FixtureCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], Error> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(Error::Crypto("browser snapshot overflow"))?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(Error::Crypto("browser snapshot truncated"))?;
        self.offset = end;
        Ok(value)
    }

    fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_be_bytes(self.array()?))
    }

    fn u64(&mut self) -> Result<u64, Error> {
        Ok(u64::from_be_bytes(self.array()?))
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        self.take(N)?
            .try_into()
            .map_err(|_| Error::Crypto("browser snapshot fixed field"))
    }

    fn blob(&mut self, maximum: usize) -> Result<&'a [u8], Error> {
        let length = self.u32()? as usize;
        if length > maximum {
            return Err(Error::BoundExceeded("browser persistence field"));
        }
        self.take(length)
    }

    fn finish(self) -> Result<(), Error> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(Error::Crypto("browser snapshot trailing data"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executes_the_complete_in_memory_lifecycle() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let evidence = super::run_openmls_lifecycle(now_ms).unwrap();
        assert_eq!(evidence.suite, 0x004e);
        assert_eq!(evidence.updated_epoch, evidence.initial_epoch + 1);
    }

    #[test]
    fn reloads_browser_snapshots_for_one_transition() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let send_seed = browser_persistence_seed(now_ms, false).unwrap();
        let mut send_cursor = FixtureCursor::new(&send_seed);
        assert_eq!(send_cursor.take(8).unwrap(), PERSISTENCE_SEED_MAGIC);
        assert_eq!(send_cursor.u8().unwrap(), Role::Device as u8);
        let _: [u8; 16] = send_cursor.array().unwrap();
        let send_snapshot = send_cursor.blob(PERSISTENCE_IMAGE_MAX_BYTES).unwrap();
        assert!(send_cursor.blob(ENVELOPE_MAX_BYTES).unwrap().is_empty());
        assert!(send_cursor.blob(ENVELOPE_MAX_BYTES).unwrap().is_empty());
        send_cursor.finish().unwrap();
        let mutation = browser_persistence_send(
            send_snapshot,
            [0xd1; 16],
            b"browser persistence send",
            now_ms,
        )
        .unwrap();
        assert!(mutation.starts_with(PERSISTENCE_MUTATION_MAGIC));

        let receive_seed = browser_persistence_seed(now_ms, true).unwrap();
        let mut receive_cursor = FixtureCursor::new(&receive_seed);
        assert_eq!(receive_cursor.take(8).unwrap(), PERSISTENCE_SEED_MAGIC);
        assert_eq!(receive_cursor.u8().unwrap(), Role::Daemon as u8);
        let _: [u8; 16] = receive_cursor.array().unwrap();
        let receive_snapshot = receive_cursor.blob(PERSISTENCE_IMAGE_MAX_BYTES).unwrap();
        let ciphertext = receive_cursor.blob(ENVELOPE_MAX_BYTES).unwrap();
        let additional_ciphertext = receive_cursor.blob(ENVELOPE_MAX_BYTES).unwrap();
        receive_cursor.finish().unwrap();
        let mutation =
            browser_persistence_receive(receive_snapshot, [0xc1; 16], ciphertext, now_ms).unwrap();
        assert!(mutation.ends_with(b"committed browser plaintext"));
        let mut mutation_cursor = FixtureCursor::new(&mutation);
        assert_eq!(mutation_cursor.take(8).unwrap(), PERSISTENCE_MUTATION_MAGIC);
        let next_snapshot = mutation_cursor.blob(PERSISTENCE_IMAGE_MAX_BYTES).unwrap();
        assert_eq!(
            mutation_cursor.blob(crate::APPLICATION_MAX_BYTES).unwrap(),
            b"committed browser plaintext"
        );
        mutation_cursor.finish().unwrap();
        let second_mutation =
            browser_persistence_receive(next_snapshot, [0xc2; 16], additional_ciphertext, now_ms)
                .unwrap();
        assert!(second_mutation.ends_with(b"second committed browser plaintext"));
    }

    #[test]
    fn rejects_negative_openmls_cases() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let evidence = super::run_openmls_negative_cases(now_ms).unwrap();
        assert_eq!(evidence.mls_replay, "invalid_ciphertext");
        assert_eq!(evidence.duplicate_ciphertext, "duplicate_ciphertext");
        assert_eq!(evidence.mutation_corruption, "invalid_ciphertext");
        assert_eq!(evidence.aad_mismatch, "invalid_aad");
        assert_eq!(evidence.identity_mismatch, "invalid_identity");
        assert_eq!(evidence.profile_mismatch, "wrong_profile");
        assert_eq!(evidence.competing_commit, "competing_commit");
    }
}
