// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

//! Test-only fresh-randomness browser execution of the complete in-memory OpenMLS lifecycle.
//!
//! This module is compiled only for the browser fixture artifact. It supplies no persistence,
//! rollback anchor, or production endpoint capability.

use std::sync::Arc;

use openmls::prelude::MlsMessageOut;
use tls_codec::Serialize as _;

use crate::{
    Clock, Daemon, ENVELOPE_MAX_BYTES, Error, Identity, MessageClass, PairContext, Phone, Role,
    SUITE_VALUE, TransactionOutcome,
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
    let epoch_ready = device.prepare_epoch_ready(id(0x44), &epoch_ready_plaintext)?;
    let epoch_ready_bytes = epoch_ready.ciphertext().len();
    let epoch_ready_ciphertext = epoch_ready.ciphertext().to_vec();
    committed_phone(&mut device)?;
    let received_ready = daemon.receive_epoch_ready(&epoch_ready_ciphertext, id(0x44))?;
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

#[cfg(test)]
mod tests {
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
