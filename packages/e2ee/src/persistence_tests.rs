// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use redb::{Database, Durability, ReadableTable, TableDefinition};

use crate::{
    Clock, Error, Identity, PairContext, SystemClock, TransactionalProvider,
    persistence::{
        DurableDaemon, DurablePhone, EnvelopeKeyStore, FaultInjector, FaultPoint,
        NativeTransactionalProvider, NoFaults, PersistenceError, RollbackAnchor, RollbackState,
        RuntimeHooks, discard_interrupted_creation,
    },
};

fn id(value: u8) -> [u8; 16] {
    [value; 16]
}

struct ManualClock(AtomicU64);

impl ManualClock {
    fn new(now_ms: u64) -> Arc<Self> {
        Arc::new(Self(AtomicU64::new(now_ms)))
    }

    fn advance(&self, milliseconds: u64) {
        self.0.fetch_add(milliseconds, Ordering::SeqCst);
    }

    fn set(&self, milliseconds: u64) {
        self.0.store(milliseconds, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> Result<u64, Error> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}

fn sequence_id(tag: u8, value: u64) -> [u8; 16] {
    let mut id = [tag; 16];
    id[8..].copy_from_slice(&value.to_be_bytes());
    id
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

fn tamper_record(path: &std::path::Path, table_name: &'static str, key: [u8; 16]) {
    let database = Database::open(path).unwrap();
    let mut write = database.begin_write().unwrap();
    write.set_durability(Durability::Immediate).unwrap();
    write.set_two_phase_commit(true);
    {
        let definition: TableDefinition<&[u8], &[u8]> = TableDefinition::new(table_name);
        let mut table = write.open_table(definition).unwrap();
        let mut bytes = table.get(key.as_slice()).unwrap().unwrap().value().to_vec();
        let index = bytes.len() / 2;
        bytes[index] ^= 1;
        table.insert(key.as_slice(), bytes.as_slice()).unwrap();
    }
    write.commit().unwrap();
}

fn temp_root(label: &str) -> PathBuf {
    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "axl-e2ee-{label}-{}-{nonce}-{}",
        std::process::id(),
        NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path).unwrap();
    path
}

struct TestKeyRecord {
    crypto_session_id: [u8; 16],
    data_key: [u8; 32],
    context: Vec<u8>,
    active: bool,
}

#[derive(Default)]
struct TestKeys {
    keys: Mutex<BTreeMap<[u8; 16], TestKeyRecord>>,
    available: Mutex<bool>,
}

impl TestKeys {
    fn enabled() -> Arc<Self> {
        Arc::new(Self {
            keys: Mutex::new(BTreeMap::new()),
            available: Mutex::new(true),
        })
    }

    fn data_keys(&self) -> Vec<[u8; 32]> {
        self.keys
            .lock()
            .unwrap()
            .values()
            .map(|record| record.data_key)
            .collect()
    }

    fn activity_counts(&self) -> (usize, usize) {
        let keys = self.keys.lock().unwrap();
        let active = keys.values().filter(|record| record.active).count();
        (active, keys.len() - active)
    }
}

impl EnvelopeKeyStore for TestKeys {
    fn available(&self) -> bool {
        *self.available.lock().unwrap()
    }

    fn prepare(
        &self,
        crypto_session_id: [u8; 16],
        key_id: [u8; 16],
        data_key: &[u8; 32],
        context: &[u8],
    ) -> Result<(), PersistenceError> {
        let mut keys = self.keys.lock().unwrap();
        if keys
            .insert(
                key_id,
                TestKeyRecord {
                    crypto_session_id,
                    data_key: *data_key,
                    context: context.to_vec(),
                    active: false,
                },
            )
            .is_some()
        {
            return Err(PersistenceError::Conflict);
        }
        Ok(())
    }

    fn load(
        &self,
        crypto_session_id: [u8; 16],
        key_id: [u8; 16],
        context: &[u8],
    ) -> Result<[u8; 32], PersistenceError> {
        let keys = self.keys.lock().unwrap();
        let record = keys.get(&key_id).ok_or(PersistenceError::KeyUnavailable)?;
        if record.crypto_session_id != crypto_session_id || record.context != context {
            return Err(PersistenceError::IdentityMismatch);
        }
        if !record.active {
            return Err(PersistenceError::KeyUnavailable);
        }
        Ok(record.data_key)
    }

    fn activate(
        &self,
        crypto_session_id: [u8; 16],
        key_id: [u8; 16],
        context: &[u8],
    ) -> Result<(), PersistenceError> {
        let mut keys = self.keys.lock().unwrap();
        let record = keys
            .get_mut(&key_id)
            .ok_or(PersistenceError::KeyUnavailable)?;
        if record.crypto_session_id != crypto_session_id || record.context != context {
            return Err(PersistenceError::IdentityMismatch);
        }
        record.active = true;
        Ok(())
    }

    fn reconcile_prepared(
        &self,
        crypto_session_id: [u8; 16],
        committed_current: Option<([u8; 16], Vec<u8>)>,
    ) -> Result<(), PersistenceError> {
        let mut keys = self.keys.lock().unwrap();
        if let Some((key_id, context)) = committed_current {
            let record = keys
                .get_mut(&key_id)
                .ok_or(PersistenceError::KeyUnavailable)?;
            if record.crypto_session_id != crypto_session_id || record.context != context {
                return Err(PersistenceError::IdentityMismatch);
            }
            record.active = true;
        }
        keys.retain(|_, record| record.crypto_session_id != crypto_session_id || record.active);
        Ok(())
    }

    fn erase(&self, crypto_session_id: [u8; 16], key_id: [u8; 16]) -> Result<(), PersistenceError> {
        let mut keys = self.keys.lock().unwrap();
        if let Some(record) = keys.get(&key_id)
            && record.crypto_session_id != crypto_session_id
        {
            return Err(PersistenceError::IdentityMismatch);
        }
        keys.remove(&key_id);
        Ok(())
    }

    fn destroy_session(&self, crypto_session_id: [u8; 16]) -> Result<(), PersistenceError> {
        self.keys
            .lock()
            .unwrap()
            .retain(|_, record| record.crypto_session_id != crypto_session_id);
        Ok(())
    }
}

struct TestAnchor {
    state: Mutex<RollbackState>,
    available: Mutex<bool>,
}

impl TestAnchor {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(RollbackState {
                counter: 0,
                epoch: 0,
                epoch_authenticator: Vec::new(),
            }),
            available: Mutex::new(true),
        })
    }
}

impl RollbackAnchor for TestAnchor {
    fn available(&self) -> bool {
        *self.available.lock().unwrap()
    }

    fn read(&self, _session: [u8; 16]) -> Result<RollbackState, PersistenceError> {
        if !self.available() {
            return Err(PersistenceError::AnchorUnavailable);
        }
        Ok(self.state.lock().unwrap().clone())
    }

    fn advance(
        &self,
        _session: [u8; 16],
        expected: &RollbackState,
        next: &RollbackState,
        _operation_id: [u8; 16],
    ) -> Result<(), PersistenceError> {
        if !self.available() {
            return Err(PersistenceError::AnchorUnavailable);
        }
        let mut state = self.state.lock().unwrap();
        if *state != *expected || next.counter != expected.counter + 1 {
            return Err(PersistenceError::Quarantined);
        }
        *state = next.clone();
        Ok(())
    }
}

#[derive(Default)]
struct OneShotFault {
    point: Mutex<Option<FaultPoint>>,
    block: Mutex<Option<(FaultPoint, bool, bool)>>,
    changed: Condvar,
}

impl OneShotFault {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn arm(&self, point: FaultPoint) {
        *self.point.lock().unwrap() = Some(point);
    }

    fn block_at(&self, point: FaultPoint) {
        *self.block.lock().unwrap() = Some((point, false, false));
    }

    fn wait_until_blocked(&self) {
        let mut state = self.block.lock().unwrap();
        while state.as_ref().is_some_and(|(_, reached, _)| !reached) {
            state = self.changed.wait(state).unwrap();
        }
    }

    fn release(&self) {
        let mut state = self.block.lock().unwrap();
        if let Some((_, _, released)) = state.as_mut() {
            *released = true;
        }
        self.changed.notify_all();
    }
}

impl FaultInjector for OneShotFault {
    fn check(&self, point: FaultPoint) -> Result<(), PersistenceError> {
        {
            let mut armed = self.point.lock().unwrap();
            if *armed == Some(point) {
                *armed = None;
                return Err(PersistenceError::InjectedFault);
            }
        }
        let mut block = self.block.lock().unwrap();
        if block
            .as_ref()
            .is_some_and(|(blocked, _, _)| *blocked == point)
        {
            if let Some((_, reached, _)) = block.as_mut() {
                *reached = true;
            }
            self.changed.notify_all();
            while block.as_ref().is_some_and(|(_, _, released)| !released) {
                block = self.changed.wait(block).unwrap();
            }
            *block = None;
        }
        Ok(())
    }
}

struct DurablePair {
    daemon: DurableDaemon,
    phone: DurablePhone,
    phone_keys: Arc<TestKeys>,
    daemon_anchor: Arc<TestAnchor>,
    phone_anchor: Arc<TestAnchor>,
    daemon_faults: Arc<OneShotFault>,
    phone_faults: Arc<OneShotFault>,
    clock: Arc<ManualClock>,
}

fn durable_pair(seed: u8) -> DurablePair {
    let context = context(seed);
    let daemon_root = temp_root("daemon");
    let phone_root = temp_root("phone");
    let daemon_keys = TestKeys::enabled();
    let phone_keys = TestKeys::enabled();
    let daemon_anchor = TestAnchor::new();
    let phone_anchor = TestAnchor::new();
    let daemon_faults = OneShotFault::new();
    let phone_faults = OneShotFault::new();
    let clock = ManualClock::new(1_000_000);
    let daemon_identity = Identity::daemon(context.account_id, context.installation_id);
    let phone_identity = Identity::device(
        context.account_id,
        context.installation_id,
        context.device_id,
    )
    .unwrap();
    let mut daemon = DurableDaemon::create_with_runtime(
        &daemon_root,
        daemon_identity,
        context.clone(),
        id(100),
        daemon_keys.clone(),
        daemon_anchor.clone(),
        RuntimeHooks {
            faults: daemon_faults.clone(),
            clock: clock.clone(),
        },
    )
    .unwrap();
    let (mut phone, package) = DurablePhone::create_with_runtime(
        &phone_root,
        phone_identity,
        context.crypto_session_id,
        id(101),
        phone_keys.clone(),
        phone_anchor.clone(),
        RuntimeHooks {
            faults: phone_faults.clone(),
            clock: clock.clone(),
        },
    )
    .unwrap();
    let welcome = daemon.consume_key_package(id(102), package).unwrap();
    phone.join(id(103), welcome, &context).unwrap();
    DurablePair {
        daemon,
        phone,
        phone_keys,
        daemon_anchor,
        phone_anchor,
        daemon_faults,
        phone_faults,
        clock,
    }
}

#[test]
fn durable_send_receive_reopens_and_retries_exact_bytes() {
    let mut pair = durable_pair(20);
    let sent = pair
        .phone
        .prepare_application(id(1), id(2), 7, b"persist me")
        .unwrap();
    let exact = sent.ciphertext.clone();

    pair.phone.store().close().unwrap();
    pair.phone.store().reopen().unwrap();
    let retry = pair
        .phone
        .prepare_application(id(1), id(2), 7, b"persist me")
        .unwrap();
    assert_eq!(retry.ciphertext, exact);

    let received = pair
        .daemon
        .receive_application(id(3), &exact, id(2), 7)
        .unwrap();
    assert_eq!(received.plaintext(), b"persist me");

    pair.daemon.store().close().unwrap();
    pair.daemon.store().reopen().unwrap();
    let recovered = pair
        .daemon
        .receive_application(id(3), &exact, id(2), 7)
        .unwrap();
    assert_eq!(recovered.plaintext(), b"persist me");
}

#[test]
fn outbox_acknowledgement_is_durable_and_idempotent() {
    let mut pair = durable_pair(29);
    let sent = pair
        .phone
        .prepare_application(id(52), id(53), 2, b"acknowledge")
        .unwrap();
    assert_eq!(sent.retry_state, crate::persistence::RetryState::Pending);
    let acknowledged = pair.phone.acknowledge_outbox(id(54), id(52)).unwrap();
    assert_eq!(
        acknowledged.retry_state,
        crate::persistence::RetryState::Acknowledged
    );
    pair.phone.store().close().unwrap();
    pair.phone.store().reopen().unwrap();
    let retry = pair.phone.acknowledge_outbox(id(54), id(52)).unwrap();
    assert_eq!(retry, acknowledged);
    let send_retry = pair
        .phone
        .prepare_application(id(52), id(53), 2, b"acknowledge")
        .unwrap();
    assert_eq!(
        send_retry.retry_state,
        crate::persistence::RetryState::Acknowledged
    );
    assert_eq!(send_retry.ciphertext, sent.ciphertext);
    assert_eq!(
        pair.phone
            .store()
            .outbox(id(52))
            .unwrap()
            .unwrap()
            .retry_state,
        crate::persistence::RetryState::Acknowledged
    );
}

#[test]
fn durable_update_commit_reloads_epoch_and_authenticator() {
    let mut pair = durable_pair(30);
    let proposal = pair.phone.prepare_self_update(id(60), id(61), 9).unwrap();
    pair.daemon
        .receive_update_proposal(id(62), &proposal.ciphertext, id(61), 9)
        .unwrap();
    let commit = pair.daemon.prepare_commit(id(63), id(64), 9).unwrap();
    let metadata = commit.commit.as_ref().unwrap().clone();
    pair.phone
        .apply_commit(id(65), &commit.ciphertext, id(64), 9)
        .unwrap();
    pair.daemon.store().close().unwrap();
    pair.daemon.store().reopen().unwrap();
    pair.phone.store().close().unwrap();
    pair.phone.store().reopen().unwrap();
    assert_eq!(
        pair.daemon.store().outbox(id(63)).unwrap().unwrap().commit,
        Some(metadata)
    );
    let post_commit = pair
        .phone
        .prepare_application(id(66), id(67), 9, b"new epoch")
        .unwrap();
    assert_eq!(post_commit.epoch, commit.commit.unwrap().target_epoch);
}

#[test]
fn previous_epoch_window_survives_restart_and_rejects_clock_rollback() {
    let mut pair = durable_pair(31);
    let delayed = pair
        .phone
        .prepare_application(id(80), id(81), 3, b"previous epoch")
        .unwrap();
    let proposal = pair.phone.prepare_self_update(id(82), id(83), 3).unwrap();
    pair.daemon
        .receive_update_proposal(id(84), &proposal.ciphertext, id(83), 3)
        .unwrap();
    let commit = pair.daemon.prepare_commit(id(85), id(86), 3).unwrap();
    pair.phone
        .apply_commit(id(87), &commit.ciphertext, id(86), 3)
        .unwrap();
    pair.daemon.store().close().unwrap();
    pair.daemon.store().reopen().unwrap();
    assert_eq!(
        pair.daemon
            .receive_application(id(88), &delayed.ciphertext, id(81), 3)
            .unwrap()
            .plaintext(),
        b"previous epoch"
    );

    let prior = pair.clock.now_ms().unwrap();
    pair.clock.set(prior - 1);
    pair.daemon.store().close().unwrap();
    pair.daemon.store().reopen().unwrap();
    assert_eq!(
        pair.daemon
            .prepare_application(id(89), id(90), 3, b"clock rollback")
            .unwrap_err(),
        PersistenceError::Core(Error::ClockRollback)
    );
}

#[test]
fn previous_epoch_window_expires_from_the_persisted_deadline() {
    let mut pair = durable_pair(32);
    let delayed = pair
        .phone
        .prepare_application(id(90), id(91), 3, b"expired epoch")
        .unwrap();
    let proposal = pair.phone.prepare_self_update(id(92), id(93), 3).unwrap();
    pair.daemon
        .receive_update_proposal(id(94), &proposal.ciphertext, id(93), 3)
        .unwrap();
    let commit = pair.daemon.prepare_commit(id(95), id(96), 3).unwrap();
    pair.phone
        .apply_commit(id(97), &commit.ciphertext, id(96), 3)
        .unwrap();
    pair.clock.advance(5 * 60 * 1000 + 1);
    pair.daemon.store().close().unwrap();
    pair.daemon.store().reopen().unwrap();
    assert_eq!(
        pair.daemon
            .receive_application(id(98), &delayed.ciphertext, id(91), 3)
            .unwrap_err(),
        PersistenceError::Core(Error::StaleEpoch)
    );
}

#[test]
fn acknowledged_idempotency_records_are_compacted_beyond_the_retry_horizon() {
    let mut pair = durable_pair(33);
    let first_operation = sequence_id(1, 0);
    for index in 0..(crate::persistence::IDEMPOTENCY_RETENTION_GENERATIONS + 8) {
        let operation_id = sequence_id(1, index);
        let logical_id = sequence_id(2, index);
        pair.phone
            .prepare_application(operation_id, logical_id, 3, b"bounded history")
            .unwrap();
        pair.phone
            .acknowledge_outbox(sequence_id(3, index), operation_id)
            .unwrap();
    }
    assert!(
        pair.phone
            .store()
            .operation(first_operation)
            .unwrap()
            .is_none()
    );
    pair.phone
        .prepare_application(sequence_id(4, 1), sequence_id(5, 1), 3, b"still usable")
        .unwrap();
}

#[test]
fn acknowledged_receive_identities_are_compacted_beyond_the_retry_horizon() {
    let mut pair = durable_pair(34);
    let first_receive = sequence_id(12, 0);
    for index in 0..(crate::persistence::IDEMPOTENCY_RETENTION_GENERATIONS + 4) {
        let send_id = sequence_id(10, index);
        let logical_id = sequence_id(11, index);
        let receive_id = sequence_id(12, index);
        let sent = pair
            .phone
            .prepare_application(send_id, logical_id, 3, b"bounded accepted history")
            .unwrap();
        pair.daemon
            .receive_application(receive_id, &sent.ciphertext, logical_id, 3)
            .unwrap();
        pair.daemon
            .acknowledge_receive(sequence_id(13, index), receive_id)
            .unwrap();
        pair.phone
            .acknowledge_outbox(sequence_id(14, index), send_id)
            .unwrap();
    }
    assert!(
        pair.daemon
            .store()
            .operation(first_receive)
            .unwrap()
            .is_none()
    );
    let sent = pair
        .phone
        .prepare_application(
            sequence_id(15, 1),
            sequence_id(16, 1),
            3,
            b"still receiving",
        )
        .unwrap();
    assert_eq!(
        pair.daemon
            .receive_application(sequence_id(17, 1), &sent.ciphertext, sequence_id(16, 1), 3)
            .unwrap()
            .plaintext(),
        b"still receiving"
    );
}

#[test]
fn precommit_faults_leave_complete_old_state_and_retry_once() {
    for (index, point) in [
        FaultPoint::DuringPreparedKeyReconciliation,
        FaultPoint::BeforeOpenMlsStateWrites,
        FaultPoint::DuringOpenMlsProviderWrites,
        FaultPoint::BeforeCiphertextInsertion,
        FaultPoint::AfterCiphertextInsertion,
        FaultPoint::BeforeCommit,
    ]
    .into_iter()
    .enumerate()
    {
        let mut pair = durable_pair(40 + index as u8);
        let generation = pair.phone.store().generation().unwrap();
        pair.phone_faults.arm(point);
        assert_eq!(
            pair.phone
                .prepare_application(id(10), id(11), 1, b"atomic")
                .unwrap_err(),
            PersistenceError::InjectedFault
        );
        pair.phone.store().close().unwrap();
        pair.phone.store().reopen().unwrap();
        assert_eq!(pair.phone.store().generation().unwrap(), generation);
        let sent = pair
            .phone
            .prepare_application(id(10), id(11), 1, b"atomic")
            .unwrap();
        assert!(!sent.ciphertext.is_empty());
    }
}

#[test]
fn uncertain_recovery_activates_current_key_before_erasing_obsolete_key() {
    let mut pair = durable_pair(58);
    assert_eq!(pair.phone_keys.activity_counts(), (1, 0));
    pair.phone_faults
        .arm(FaultPoint::DuringCurrentKeyActivation);
    assert_eq!(
        pair.phone
            .prepare_application(id(18), id(19), 1, b"activation order")
            .unwrap_err(),
        PersistenceError::InjectedFault
    );
    assert_eq!(pair.phone_keys.activity_counts(), (1, 1));

    pair.phone_faults
        .arm(FaultPoint::DuringPreparedKeyReconciliation);
    assert_eq!(
        pair.phone
            .prepare_application(id(18), id(19), 1, b"activation order")
            .unwrap_err(),
        PersistenceError::InjectedFault
    );
    assert_eq!(pair.phone_keys.activity_counts(), (1, 1));

    let recovered = pair
        .phone
        .prepare_application(id(18), id(19), 1, b"activation order")
        .unwrap();
    assert!(!recovered.ciphertext.is_empty());
    assert_eq!(pair.phone_keys.activity_counts(), (1, 0));
}

#[test]
fn postcommit_faults_recover_the_committed_exact_result() {
    for (index, point) in [
        FaultPoint::DuringCurrentKeyActivation,
        FaultPoint::AfterDurableCommit,
        FaultPoint::BeforeAnchorRecovery,
        FaultPoint::AfterAnchorRecoveryBeforeErasure,
        FaultPoint::AfterCommitBeforeNetworkSend,
        FaultPoint::DuringWrappingRecordReplacement,
        FaultPoint::DuringWrappingRecordErasure,
    ]
    .into_iter()
    .enumerate()
    {
        let mut pair = durable_pair(60 + index as u8);
        pair.phone_faults.arm(point);
        let first = pair
            .phone
            .prepare_application(id(20), id(21), 1, b"uncertain");
        let retry = pair
            .phone
            .prepare_application(id(20), id(21), 1, b"uncertain")
            .unwrap();
        if let Ok(first) = first {
            assert_eq!(first.ciphertext, retry.ciphertext);
        }
        assert_eq!(
            pair.phone
                .store()
                .outbox(id(20))
                .unwrap()
                .unwrap()
                .ciphertext,
            retry.ciphertext
        );
    }
}

#[test]
fn duplicate_ids_conflicts_and_receive_faults_fail_closed() {
    let mut pair = durable_pair(80);
    let sent = pair
        .phone
        .prepare_application(id(30), id(31), 4, b"one")
        .unwrap();
    assert_eq!(
        pair.phone
            .prepare_application(id(30), id(31), 4, b"different")
            .unwrap_err(),
        PersistenceError::Conflict
    );

    pair.daemon_faults
        .arm(FaultPoint::DuringReceiverStateWrites);
    assert_eq!(
        pair.daemon
            .receive_application(id(32), &sent.ciphertext, id(31), 4)
            .unwrap_err(),
        PersistenceError::InjectedFault
    );
    pair.daemon.store().close().unwrap();
    pair.daemon.store().reopen().unwrap();
    let plaintext = pair
        .daemon
        .receive_application(id(32), &sent.ciphertext, id(31), 4)
        .unwrap();
    assert_eq!(plaintext.plaintext(), b"one");

    pair.daemon_faults.arm(FaultPoint::DuringDuplicateOperation);
    assert_eq!(
        pair.daemon
            .receive_application(id(32), &sent.ciphertext, id(31), 4)
            .unwrap_err(),
        PersistenceError::InjectedFault
    );
}

#[test]
fn restart_generation_and_acknowledgement_faults_recover_deterministically() {
    let mut pair = durable_pair(85);
    let sent = pair
        .phone
        .prepare_application(id(40), id(41), 5, b"ack recovery")
        .unwrap();
    let generation = pair.daemon.store().generation().unwrap();
    let rollback = pair.daemon.store().rollback_counter().unwrap();
    pair.daemon_faults.arm(FaultPoint::DuringGenerationConflict);
    assert!(matches!(
        pair.daemon.store().begin_transaction(
            pair.daemon.store().crypto_session_id(),
            generation.saturating_sub(1),
            rollback,
        ),
        Err(PersistenceError::InjectedFault)
    ));
    assert!(matches!(
        pair.daemon.store().begin_transaction(
            pair.daemon.store().crypto_session_id(),
            generation.saturating_sub(1),
            rollback,
        ),
        Err(PersistenceError::GenerationConflict)
    ));

    pair.daemon_faults
        .arm(FaultPoint::BeforeReceiverAcknowledgement);
    assert_eq!(
        pair.daemon
            .receive_application(id(42), &sent.ciphertext, id(41), 5)
            .unwrap_err(),
        PersistenceError::InjectedFault
    );
    let recovered = pair
        .daemon
        .receive_application(id(42), &sent.ciphertext, id(41), 5)
        .unwrap();
    assert_eq!(recovered.plaintext(), b"ack recovery");

    pair.daemon_faults.arm(FaultPoint::AfterAcknowledgementLoss);
    assert_eq!(
        pair.daemon.acknowledge_receive(id(43), id(42)).unwrap_err(),
        PersistenceError::InjectedFault
    );
    let acknowledgement = pair.daemon.acknowledge_receive(id(43), id(42)).unwrap();
    assert!(acknowledgement.acknowledged);
    assert_eq!(
        pair.daemon
            .receive_application(id(42), &sent.ciphertext, id(41), 5)
            .unwrap_err(),
        PersistenceError::AlreadyAcknowledged
    );

    pair.daemon_faults.arm(FaultPoint::DuringRestartReload);
    pair.daemon.store().close().unwrap();
    assert_eq!(
        pair.daemon.store().reopen().unwrap_err(),
        PersistenceError::InjectedFault
    );
    pair.daemon.store().reopen().unwrap();
}

#[test]
fn database_contains_neither_plaintext_nor_data_encryption_keys() {
    let mut pair = durable_pair(88);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(pair.phone.store().path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(pair.phone.store().path().parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    let marker = b"plaintext-must-not-appear-in-redb";
    pair.phone
        .prepare_application(id(50), id(51), 6, marker)
        .unwrap();
    pair.phone.store().close().unwrap();
    let bytes = fs::read(pair.phone.store().path()).unwrap();
    assert!(!bytes.windows(marker.len()).any(|window| window == marker));
    let data_keys = pair.phone_keys.data_keys();
    assert_eq!(
        data_keys.len(),
        1,
        "obsolete wrapping records must be erased"
    );
    for key in data_keys {
        assert!(!bytes.windows(key.len()).any(|window| window == key));
    }

    // The deterministic test key store exposes DEKs only for this negative file scan. Production
    // key implementations remain outside this crate and never expose wrapping keys.
    pair.phone.store().reopen().unwrap();
}

#[test]
fn tampered_durable_metadata_is_quarantined() {
    const OUTBOX: TableDefinition<&[u8], &[u8]> = TableDefinition::new("outbox_v1");
    let mut pair = durable_pair(86);
    pair.phone
        .prepare_application(id(110), id(111), 2, b"authenticated metadata")
        .unwrap();
    pair.phone.store().close().unwrap();
    let database = Database::open(pair.phone.store().path()).unwrap();
    let mut write = database.begin_write().unwrap();
    write.set_durability(Durability::Immediate).unwrap();
    write.set_two_phase_commit(true);
    {
        let mut table = write.open_table(OUTBOX).unwrap();
        let mut bytes = table
            .get(id(110).as_slice())
            .unwrap()
            .unwrap()
            .value()
            .to_vec();
        bytes[50] ^= 1;
        table.insert(id(110).as_slice(), bytes.as_slice()).unwrap();
    }
    write.commit().unwrap();
    drop(database);
    assert_eq!(
        pair.phone.store().reopen().unwrap_err(),
        PersistenceError::Quarantined
    );
}

#[test]
fn tampered_operation_and_accepted_records_are_quarantined() {
    let mut operation_pair = durable_pair(85);
    operation_pair
        .phone
        .prepare_application(id(112), id(113), 2, b"operation manifest")
        .unwrap();
    operation_pair.phone.store().close().unwrap();
    tamper_record(
        operation_pair.phone.store().path(),
        "operations_v1",
        id(112),
    );
    assert_eq!(
        operation_pair.phone.store().reopen().unwrap_err(),
        PersistenceError::Quarantined
    );

    let mut accepted_pair = durable_pair(84);
    let sent = accepted_pair
        .phone
        .prepare_application(id(114), id(115), 2, b"accepted manifest")
        .unwrap();
    accepted_pair
        .daemon
        .receive_application(id(116), &sent.ciphertext, id(115), 2)
        .unwrap();
    accepted_pair.daemon.store().close().unwrap();
    tamper_record(
        accepted_pair.daemon.store().path(),
        "accepted_messages_v1",
        id(116),
    );
    assert_eq!(
        accepted_pair.daemon.store().reopen().unwrap_err(),
        PersistenceError::Quarantined
    );
}

#[test]
fn unsupported_schema_identity_mismatch_and_rollback_quarantine() {
    const META: TableDefinition<u8, &[u8]> = TableDefinition::new("metadata_v1");

    let pair = durable_pair(87);
    pair.phone.store().close().unwrap();
    let wrong_session = id(199);
    let wrong_name = format!(
        "{}.redb",
        wrong_session
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    let wrong_path = pair.phone.store().path().parent().unwrap().join(wrong_name);
    fs::copy(pair.phone.store().path(), &wrong_path).unwrap();
    assert!(matches!(
        NativeTransactionalProvider::open(
            wrong_path.parent().unwrap(),
            wrong_session,
            Arc::clone(&pair.phone_keys) as Arc<dyn EnvelopeKeyStore>,
            TestAnchor::new(),
            Arc::new(NoFaults),
            Arc::new(SystemClock),
        ),
        Err(PersistenceError::IdentityMismatch)
    ));

    let pair = durable_pair(89);
    pair.phone.store().close().unwrap();
    let database = Database::open(pair.phone.store().path()).unwrap();
    let mut write = database.begin_write().unwrap();
    write.set_durability(Durability::Immediate).unwrap();
    write.set_two_phase_commit(true);
    {
        let mut meta = write.open_table(META).unwrap();
        meta.insert(1, 99_u16.to_be_bytes().as_slice()).unwrap();
    }
    write.commit().unwrap();
    drop(database);
    assert_eq!(
        pair.phone.store().reopen().unwrap_err(),
        PersistenceError::UnsupportedSchema
    );

    let pair = durable_pair(90);
    pair.daemon.store().close().unwrap();
    *pair.daemon_anchor.state.lock().unwrap() = RollbackState {
        counter: 0,
        epoch: 0,
        epoch_authenticator: Vec::new(),
    };
    assert_eq!(
        pair.daemon.store().reopen().unwrap_err(),
        PersistenceError::Quarantined
    );
}

#[test]
fn orphan_prepared_keys_are_reconciled_on_restart() {
    let root = temp_root("orphan-key");
    let session = id(83);
    let keys = TestKeys::enabled();
    let anchor = TestAnchor::new();
    let store = NativeTransactionalProvider::create(
        &root,
        session,
        keys.clone(),
        anchor,
        Arc::new(NoFaults),
        Arc::new(SystemClock),
    )
    .unwrap();
    keys.prepare(session, id(122), &[7; 32], b"orphan").unwrap();
    assert_eq!(keys.activity_counts(), (0, 1));
    store.close().unwrap();
    // The schema is still initializing, but restart reconciliation removes the orphan first.
    assert_eq!(
        store.reopen().unwrap_err(),
        PersistenceError::InitializationIncomplete
    );
    assert_eq!(keys.activity_counts(), (0, 0));
    store.close().unwrap();
    discard_interrupted_creation(&root, session, keys).unwrap();
}

#[test]
fn initialization_boundaries_reopen_as_incomplete_and_are_cleanable() {
    let marker_only_root = temp_root("marker-only");
    let marker_only_session = id(129);
    let marker_name = format!(
        "{}.redb.initializing",
        marker_only_session
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    fs::write(marker_only_root.join(marker_name), []).unwrap();
    let marker_keys = TestKeys::enabled();
    assert!(matches!(
        DurableDaemon::open(
            &marker_only_root,
            marker_only_session,
            marker_keys.clone(),
            TestAnchor::new(),
        ),
        Err(PersistenceError::InitializationIncomplete)
    ));
    discard_interrupted_creation(&marker_only_root, marker_only_session, marker_keys).unwrap();

    for (index, point) in [
        FaultPoint::AfterInitializationFileCreation,
        FaultPoint::AfterInitializationSchemaCommit,
        FaultPoint::DuringPreparedKeyReconciliation,
        FaultPoint::BeforeOpenMlsStateWrites,
        FaultPoint::DuringOpenMlsProviderWrites,
        FaultPoint::BeforeCiphertextInsertion,
        FaultPoint::AfterCiphertextInsertion,
        FaultPoint::BeforeCommit,
        FaultPoint::DuringCurrentKeyActivation,
        FaultPoint::BeforeAnchorRecovery,
        FaultPoint::AfterAnchorRecoveryBeforeErasure,
        FaultPoint::BeforeInitializationReady,
    ]
    .into_iter()
    .enumerate()
    {
        let root = temp_root("initialization-boundary");
        let context = context(130 + index as u8);
        let keys = TestKeys::enabled();
        let anchor = TestAnchor::new();
        let faults = OneShotFault::new();
        faults.arm(point);
        assert!(matches!(
            DurableDaemon::create_with_runtime(
                &root,
                Identity::daemon(context.account_id, context.installation_id),
                context.clone(),
                sequence_id(20, index as u64),
                keys.clone(),
                anchor.clone(),
                RuntimeHooks {
                    faults,
                    clock: ManualClock::new(1_000_000),
                },
            ),
            Err(PersistenceError::InjectedFault)
        ));
        assert!(matches!(
            DurableDaemon::open(&root, context.crypto_session_id, keys.clone(), anchor,),
            Err(PersistenceError::InitializationIncomplete)
        ));
        discard_interrupted_creation(&root, context.crypto_session_id, keys).unwrap();
    }
}

#[test]
fn interrupted_creation_is_explicitly_cleanable() {
    let root = temp_root("initializing");
    let context = context(84);
    let keys = TestKeys::enabled();
    let anchor = TestAnchor::new();
    let faults = OneShotFault::new();
    faults.arm(FaultPoint::BeforeInitializationReady);
    assert!(matches!(
        DurableDaemon::create_with_runtime(
            &root,
            Identity::daemon(context.account_id, context.installation_id),
            context.clone(),
            id(120),
            keys.clone(),
            anchor.clone(),
            RuntimeHooks {
                faults,
                clock: ManualClock::new(1_000_000),
            },
        ),
        Err(PersistenceError::InjectedFault)
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let marker = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "initializing")
            })
            .unwrap();
        assert_eq!(
            fs::metadata(marker).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(matches!(
        DurableDaemon::open(&root, context.crypto_session_id, keys.clone(), anchor,),
        Err(PersistenceError::InitializationIncomplete) | Err(PersistenceError::Quarantined)
    ));
    discard_interrupted_creation(&root, context.crypto_session_id, keys.clone()).unwrap();
    assert!(fs::read_dir(&root).unwrap().next().is_none());
    assert!(keys.keys.lock().unwrap().is_empty());
}

#[test]
fn unavailable_keys_anchor_identity_and_symlinks_fail_closed() {
    let mut pair = durable_pair(88);
    let generation = pair.phone.store().generation().unwrap();
    *pair.phone_keys.available.lock().unwrap() = false;
    assert_eq!(
        pair.phone
            .prepare_application(id(118), id(119), 1, b"unavailable key store")
            .unwrap_err(),
        PersistenceError::KeyUnavailable
    );
    assert_eq!(pair.phone.store().generation().unwrap(), generation);
    *pair.phone_keys.available.lock().unwrap() = true;
    *pair.phone_anchor.available.lock().unwrap() = false;
    assert_eq!(
        pair.phone
            .prepare_application(id(120), id(121), 1, b"unavailable anchor")
            .unwrap_err(),
        PersistenceError::AnchorUnavailable
    );
    assert_eq!(pair.phone.store().generation().unwrap(), generation);

    let nonzero_root = temp_root("nonzero-anchor");
    let nonzero_anchor = TestAnchor::new();
    nonzero_anchor.state.lock().unwrap().counter = 1;
    assert!(matches!(
        NativeTransactionalProvider::create(
            &nonzero_root,
            id(89),
            TestKeys::enabled(),
            nonzero_anchor,
            Arc::new(NoFaults),
            Arc::new(SystemClock),
        ),
        Err(PersistenceError::IdentityMismatch)
    ));
    assert!(fs::read_dir(nonzero_root).unwrap().next().is_none());

    let root = temp_root("closed");
    let keys = TestKeys::enabled();
    let anchor = TestAnchor::new();
    *keys.available.lock().unwrap() = false;
    assert!(matches!(
        NativeTransactionalProvider::create(
            &root,
            id(90),
            keys,
            anchor,
            Arc::new(NoFaults),
            Arc::new(SystemClock),
        ),
        Err(PersistenceError::KeyUnavailable)
    ));

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let target = temp_root("target");
        let link = target.with_extension("link");
        symlink(&target, &link).unwrap();
        assert!(matches!(
            NativeTransactionalProvider::create(
                &link,
                id(91),
                TestKeys::enabled(),
                TestAnchor::new(),
                Arc::new(NoFaults),
                Arc::new(SystemClock),
            ),
            Err(PersistenceError::IdentityMismatch)
        ));
    }
}

#[test]
fn operations_against_one_group_reload_after_the_first_writer_commits() {
    let pair = durable_pair(95);
    let initial_generation = pair.phone.store().generation().unwrap();
    pair.phone_faults.block_at(FaultPoint::BeforeCommit);
    let mut first_phone = pair.phone.clone();
    let first = thread::spawn(move || first_phone.prepare_application(id(70), id(71), 1, b"first"));
    pair.phone_faults.wait_until_blocked();

    let (sender, receiver) = mpsc::channel();
    let mut second_phone = pair.phone.clone();
    let second_handle = thread::spawn(move || {
        sender
            .send(second_phone.prepare_application(id(72), id(73), 1, b"second"))
            .unwrap();
    });
    assert!(
        receiver
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err()
    );
    pair.phone_faults.release();
    let first = first.join().unwrap().unwrap();
    let second = receiver
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap()
        .unwrap();
    second_handle.join().unwrap();

    assert_ne!(first.ciphertext, second.ciphertext);
    assert_eq!(
        pair.phone.store().generation().unwrap(),
        initial_generation + 2
    );
    assert_eq!(
        pair.phone
            .store()
            .outbox(id(70))
            .unwrap()
            .unwrap()
            .ciphertext,
        first.ciphertext
    );
    assert_eq!(
        pair.phone
            .store()
            .outbox(id(72))
            .unwrap()
            .unwrap()
            .ciphertext,
        second.ciphertext
    );
}

#[test]
fn unrelated_groups_make_progress_on_separate_databases() {
    let roots = [temp_root("parallel-a"), temp_root("parallel-b")];
    let handles = roots.into_iter().enumerate().map(|(index, root)| {
        thread::spawn(move || {
            let pair = durable_pair(100 + index as u8);
            // Opening separate per-session files does not share a writer transaction or lock.
            let _extra = NativeTransactionalProvider::create(
                &root,
                id(120 + index as u8),
                TestKeys::enabled(),
                TestAnchor::new(),
                Arc::new(NoFaults),
                Arc::new(SystemClock),
            )
            .unwrap();
            pair.phone.store().generation().unwrap()
        })
    });
    for handle in handles {
        assert!(handle.join().unwrap() > 0);
    }
}
