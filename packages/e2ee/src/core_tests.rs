// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

use crate::{
    APPLICATION_MAX_BYTES, Aad, Daemon, Error, Identity, MessageClass, PROFILE_ID,
    PROFILE_REVISION, PairContext, Phone, SUITE_VALUE, TransactionOutcome,
};

fn id(value: u8) -> [u8; 16] {
    [value; 16]
}

fn context(seed: u8) -> PairContext {
    PairContext {
        crypto_session_id: id(seed),
        group_id: [seed; 32],
        account_id: id(seed + 1),
        installation_id: id(seed + 2),
        device_id: id(seed + 3),
    }
}

fn pair(seed: u8) -> (Daemon, Phone, PairContext, usize) {
    let context = context(seed);
    let daemon_identity = Identity::daemon(context.account_id, context.installation_id);
    let phone_identity = Identity::device(
        context.account_id,
        context.installation_id,
        context.device_id,
    )
    .unwrap();
    let (mut phone, key_package) = Phone::create(phone_identity).unwrap();
    let mut daemon = Daemon::create(daemon_identity, context.clone()).unwrap();
    let welcome = daemon.consume_key_package(key_package).unwrap();
    let welcome_size = welcome.bytes().len();
    daemon
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    phone.join(welcome, &context).unwrap();
    phone
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    assert_eq!(
        daemon.epoch_authenticator().unwrap(),
        phone.epoch_authenticator().unwrap()
    );
    (daemon, phone, context, welcome_size)
}

fn update(daemon: &mut Daemon, phone: &mut Phone, seed: u8) -> Vec<u8> {
    let proposal_id = id(seed);
    let proposal = phone.prepare_self_update(proposal_id, 7).unwrap();
    phone
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    daemon
        .receive_update_proposal(proposal.ciphertext(), proposal_id, 7)
        .unwrap();
    daemon
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    let commit_id = id(seed.wrapping_add(1));
    let commit = daemon.prepare_commit(commit_id, 7).unwrap();
    let metadata = commit.commit_metadata().unwrap();
    assert_eq!(metadata.target_epoch, commit.epoch() + 1);
    assert_eq!(metadata.commit_id.len(), 48);
    assert_eq!(metadata.epoch_authenticator.len(), 48);
    let bytes = commit.ciphertext().to_vec();
    daemon
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    phone.apply_commit(&bytes, commit_id, 7).unwrap();
    phone
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    assert_eq!(
        daemon.epoch_authenticator().unwrap(),
        phone.epoch_authenticator().unwrap()
    );
    bytes
}

#[test]
fn profile_and_canonical_aad_are_exact() {
    assert_eq!(PROFILE_ID, "axl-e2ee-mls-pq-v1");
    assert_eq!(PROFILE_REVISION, 1);
    assert_eq!(SUITE_VALUE, 0x004e);

    let expected = Aad {
        crypto_session_id: id(1),
        group_id: [2; 32],
        source_device_id: id(3),
        destination_device_id: id(4),
        installation_id: id(5),
        message_class: MessageClass::ApplicationRequest,
        logical_message_id: id(6),
        hosted_grant_generation: 9,
    };
    let bytes = expected.encode();
    assert_eq!(Aad::decode(&bytes).unwrap(), expected);
    assert!(bytes.len() <= 512);

    let mut wrong_profile = bytes.clone();
    wrong_profile[3] ^= 1;
    assert_eq!(Aad::decode(&wrong_profile), Err(Error::WrongProfile));
    let mut noncanonical = bytes.clone();
    noncanonical.push(0);
    assert_eq!(
        Aad::validate_exact(&noncanonical, &expected),
        Err(Error::InvalidAad)
    );
}

#[test]
fn key_package_welcome_membership_and_identity_are_bounded() {
    let expected = context(10);
    let daemon_identity = Identity::daemon(expected.account_id, expected.installation_id);
    let expected_phone = Identity::device(
        expected.account_id,
        expected.installation_id,
        expected.device_id,
    )
    .unwrap();
    let wrong_phone =
        Identity::device(expected.account_id, expected.installation_id, id(99)).unwrap();

    let (_, wrong_package) = Phone::create(wrong_phone).unwrap();
    let mut daemon = Daemon::create(daemon_identity.clone(), expected.clone()).unwrap();
    assert_eq!(
        daemon.consume_key_package(wrong_package).unwrap_err(),
        Error::InvalidIdentity("KeyPackage identity does not match pair")
    );

    let (mut phone, package) = Phone::create(expected_phone).unwrap();
    let welcome = daemon.consume_key_package(package).unwrap();
    assert!(welcome.bytes().len() <= 16 * 1024);
    let mut wrong_group = expected.clone();
    wrong_group.group_id[0] ^= 1;
    assert_eq!(phone.join(welcome, &wrong_group), Err(Error::WrongGroup));
}

#[test]
fn application_roundtrip_reorders_and_rejects_duplicates_and_mutation() {
    let (mut daemon, mut phone, _, welcome_size) = pair(20);
    let first = phone.prepare_application(id(1), 3, b"first").unwrap();
    phone
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    let second = phone.prepare_application(id(2), 3, b"second").unwrap();
    phone
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();

    assert_eq!(
        daemon
            .receive_application(second.ciphertext(), id(2), 3)
            .unwrap()
            .plaintext(),
        b"second"
    );
    daemon
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    assert_eq!(
        daemon
            .receive_application(first.ciphertext(), id(1), 3)
            .unwrap()
            .plaintext(),
        b"first"
    );
    daemon
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    assert_eq!(
        daemon
            .receive_application(first.ciphertext(), id(1), 3)
            .unwrap_err(),
        Error::DuplicateCiphertext
    );

    let fresh = phone.prepare_application(id(3), 3, b"mutate me").unwrap();
    phone
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    let mut mutated = fresh.ciphertext().to_vec();
    *mutated.last_mut().unwrap() ^= 1;
    assert_eq!(
        daemon.receive_application(&mutated, id(3), 3).unwrap_err(),
        Error::InvalidCiphertext
    );

    let reply = daemon.prepare_application(id(4), 3, b"reply").unwrap();
    daemon
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    assert_eq!(
        phone
            .receive_application(reply.ciphertext(), id(4), 3)
            .unwrap()
            .plaintext(),
        b"reply"
    );
    phone
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();

    eprintln!(
        "measured sizes: welcome={welcome_size}, small_application={}, mutated_application={}",
        first.ciphertext().len(),
        fresh.ciphertext().len()
    );
}

#[test]
fn maximum_application_fits_the_relay_payload() {
    let (mut daemon, mut phone, _, _) = pair(30);
    let plaintext = vec![0x41; APPLICATION_MAX_BYTES];
    let envelope = phone.prepare_application(id(1), 1, &plaintext).unwrap();
    phone
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    assert!(envelope.ciphertext().len() <= 65_497);
    assert_eq!(
        daemon
            .receive_application(envelope.ciphertext(), id(1), 1)
            .unwrap()
            .plaintext(),
        plaintext
    );
    eprintln!(
        "measured size: 60000-byte application={}",
        envelope.ciphertext().len()
    );
}

#[test]
fn phone_proposes_daemon_commits_and_previous_epoch_is_receive_only() {
    let (mut daemon, mut phone, _, _) = pair(40);
    let delayed = phone.prepare_application(id(1), 8, b"old epoch").unwrap();
    phone
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    let old_epoch = delayed.epoch();

    let commit = update(&mut daemon, &mut phone, 10);
    assert_eq!(daemon.epoch().unwrap(), old_epoch + 1);
    assert_eq!(
        daemon
            .receive_application(delayed.ciphertext(), id(1), 8)
            .unwrap()
            .plaintext(),
        b"old epoch"
    );
    daemon
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();

    assert_eq!(
        phone.apply_commit(&commit, id(11), 7),
        Err(Error::CompetingCommit)
    );
    eprintln!("measured size: self-update commit={}", commit.len());
}

#[test]
fn stale_and_future_epochs_are_rejected() {
    let (mut daemon, mut phone, _, _) = pair(50);
    let stale = phone
        .prepare_application(id(1), 1, b"eventually stale")
        .unwrap();
    phone
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    update(&mut daemon, &mut phone, 20);
    update(&mut daemon, &mut phone, 22);
    update(&mut daemon, &mut phone, 24);
    assert_eq!(
        daemon
            .receive_application(stale.ciphertext(), id(1), 1)
            .unwrap_err(),
        Error::StaleEpoch
    );

    let current = phone
        .prepare_application(id(2), 1, b"future marker")
        .unwrap();
    phone
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    let mut future = current.ciphertext().to_vec();
    // MLSMessage.version (2), wire_format (2), group_id vector length (1), group_id (32), epoch (8).
    let epoch_offset = 2 + 2 + 1 + 32;
    let future_epoch = daemon.epoch().unwrap() + 2;
    future[epoch_offset..epoch_offset + 8].copy_from_slice(&future_epoch.to_be_bytes());
    assert_eq!(
        daemon.receive_application(&future, id(2), 1).unwrap_err(),
        Error::FutureEpoch
    );
}

#[test]
fn aad_identity_and_group_mismatches_are_rejected() {
    let (mut daemon_a, mut phone_a, _, _) = pair(60);
    let (mut daemon_b, mut phone_b, _, _) = pair(70);

    let foreign = phone_b.prepare_application(id(1), 1, b"foreign").unwrap();
    phone_b
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    assert_eq!(
        daemon_a
            .receive_application(foreign.ciphertext(), id(1), 1)
            .unwrap_err(),
        Error::WrongGroup
    );

    let message = phone_a.prepare_application(id(2), 4, b"bound aad").unwrap();
    phone_a
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    assert_eq!(
        daemon_a
            .receive_application(message.ciphertext(), id(2), 5)
            .unwrap_err(),
        Error::InvalidAad
    );
    // The failed authenticated-data check can consume receive ratchet state. The core therefore
    // invalidates the in-memory endpoint immediately and requires a durable adapter to reload it.
    assert_eq!(daemon_a.epoch(), Err(Error::InactiveAfterRollback));

    let outbound = daemon_b
        .prepare_application(id(3), 1, b"other direction")
        .unwrap();
    daemon_b
        .finish_transaction(TransactionOutcome::Committed)
        .unwrap();
    assert_eq!(
        phone_a
            .receive_application(outbound.ciphertext(), id(3), 1)
            .unwrap_err(),
        Error::WrongGroup
    );
}

#[test]
fn prepared_output_is_immutable_and_retry_is_byte_identical() {
    let (_, mut phone, context, _) = pair(80);
    let prepared = phone
        .prepare_application(id(1), 2, b"retry exactly")
        .unwrap();
    let first_attempt = prepared.ciphertext().to_vec();
    let second_attempt = prepared.ciphertext().to_vec();
    assert_eq!(first_attempt, second_attempt);
    assert_eq!(prepared.crypto_session_id(), context.crypto_session_id);
    assert_eq!(
        phone
            .prepare_application(id(2), 2, b"must wait")
            .unwrap_err(),
        Error::TransactionPending
    );
    phone
        .finish_transaction(TransactionOutcome::RolledBack)
        .unwrap();
    assert_eq!(phone.epoch(), Err(Error::InactiveAfterRollback));
}
