// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    process::Command,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use redb::{Database, Durability, ReadableDatabase, ReadableTable, TableDefinition};

use crate::{
    Clock, Error, Identity, PairContext, SystemClock, TransactionalProvider,
    persistence::{
        CommittedOperation, DurableDaemon, DurablePhone, EnvelopeKeyStore, FaultInjector,
        FaultPoint, NativeTransactionalProvider, NoFaults, PersistenceError, RollbackAnchor,
        RollbackState, RuntimeHooks, discard_interrupted_creation,
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

fn database_path(root: &std::path::Path, session: [u8; 16]) -> PathBuf {
    root.join(format!(
        "{}.redb",
        session
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn marker_path(root: &std::path::Path, session: [u8; 16]) -> PathBuf {
    database_path(root, session).with_extension("redb.initializing")
}

fn lifecycle_claim_path(root: &std::path::Path, session: [u8; 16]) -> PathBuf {
    database_path(root, session).with_extension("redb.lifecycle.lock")
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

type TestKeySnapshot = ([u8; 16], [u8; 16], [u8; 32], Vec<u8>, bool);

#[derive(Default)]
struct TestKeys {
    keys: Mutex<BTreeMap<[u8; 16], TestKeyRecord>>,
    available: Mutex<bool>,
    destroy_calls: AtomicU64,
}

impl TestKeys {
    fn enabled() -> Arc<Self> {
        Arc::new(Self {
            keys: Mutex::new(BTreeMap::new()),
            available: Mutex::new(true),
            destroy_calls: AtomicU64::new(0),
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

    fn snapshot(&self) -> Vec<TestKeySnapshot> {
        self.keys
            .lock()
            .unwrap()
            .iter()
            .map(|(key_id, record)| {
                (
                    *key_id,
                    record.crypto_session_id,
                    record.data_key,
                    record.context.clone(),
                    record.active,
                )
            })
            .collect()
    }

    fn destroy_calls(&self) -> u64 {
        self.destroy_calls.load(Ordering::SeqCst)
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
        self.destroy_calls.fetch_add(1, Ordering::SeqCst);
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
fn ready_commit_fault_recovers_without_losing_database_or_external_state() {
    let root = temp_root("ready-marker-crash");
    let pair_context = context(140);
    let operation_id = id(150);
    let keys = TestKeys::enabled();
    let anchor = TestAnchor::new();
    let faults = OneShotFault::new();
    let clock = ManualClock::new(1_000_000);
    faults.arm(FaultPoint::AfterInitializationReadyCommit);

    assert!(matches!(
        DurableDaemon::create_with_runtime(
            &root,
            Identity::daemon(pair_context.account_id, pair_context.installation_id),
            pair_context.clone(),
            operation_id,
            keys.clone(),
            anchor.clone(),
            RuntimeHooks {
                faults: faults.clone(),
                clock: clock.clone(),
            },
        ),
        Err(PersistenceError::InjectedFault)
    ));

    let database = database_path(&root, pair_context.crypto_session_id);
    let marker = marker_path(&root, pair_context.crypto_session_id);
    let database_bytes = fs::read(&database).unwrap();
    assert!(!database_bytes.is_empty());
    let key_records = keys.snapshot();
    let rollback_anchor = anchor.state.lock().unwrap().clone();
    assert!(marker.is_file());
    assert_eq!(keys.activity_counts(), (1, 0));
    assert_eq!(keys.destroy_calls(), 0);

    assert_eq!(
        discard_interrupted_creation(&root, pair_context.crypto_session_id, keys.clone())
            .unwrap_err(),
        PersistenceError::AlreadyExists
    );
    assert!(database.is_file());
    assert!(!fs::read(&database).unwrap().is_empty());
    assert_eq!(keys.snapshot(), key_records);
    assert_eq!(*anchor.state.lock().unwrap(), rollback_anchor);
    assert_eq!(keys.destroy_calls(), 0);

    let opened = DurableDaemon::open_with_runtime(
        &root,
        pair_context.crypto_session_id,
        keys.clone(),
        anchor.clone(),
        RuntimeHooks { faults, clock },
    )
    .unwrap();
    assert!(!marker.exists());
    assert!(database.is_file());
    assert!(!fs::read(&database).unwrap().is_empty());
    assert_eq!(keys.snapshot(), key_records);
    assert_eq!(*anchor.state.lock().unwrap(), rollback_anchor);
    let exact_operation = opened.store().operation(operation_id).unwrap().unwrap();
    let CommittedOperation::Accepted(initialized) = &exact_operation else {
        panic!("creation operation must remain the exact accepted result");
    };
    assert_eq!(initialized.operation_id, operation_id);
    assert_eq!(
        initialized.crypto_session_id,
        pair_context.crypto_session_id
    );
    assert_eq!(initialized.logical_message_id, operation_id);
    assert_eq!(initialized.epoch, rollback_anchor.epoch);
    assert_eq!(
        opened.store().rollback_counter().unwrap(),
        rollback_anchor.counter
    );
    assert_eq!(opened.store().rollback_state().unwrap(), rollback_anchor);
    assert_eq!(rollback_anchor.epoch_authenticator.len(), 48);

    opened.store().close().unwrap();
    let reopened = DurableDaemon::open(
        &root,
        pair_context.crypto_session_id,
        keys.clone(),
        anchor.clone(),
    )
    .unwrap();
    assert_eq!(
        reopened.store().operation(operation_id).unwrap(),
        Some(exact_operation)
    );
    assert!(database.is_file());
    assert!(!fs::read(&database).unwrap().is_empty());
    assert_eq!(keys.snapshot(), key_records);
    assert_eq!(*anchor.state.lock().unwrap(), rollback_anchor);
}

#[test]
fn injected_marker_cannot_authorize_ready_database_cleanup() {
    let pair = durable_pair(141);
    pair.phone.store().close().unwrap();
    let database = pair.phone.store().path().to_path_buf();
    let marker = database.with_extension("redb.initializing");
    fs::write(&marker, []).unwrap();
    let database_bytes = fs::read(&database).unwrap();
    assert!(!database_bytes.is_empty());
    let key_records = pair.phone_keys.snapshot();

    for _ in 0..2 {
        assert_eq!(
            discard_interrupted_creation(
                database.parent().unwrap(),
                pair.phone.store().crypto_session_id(),
                pair.phone_keys.clone(),
            )
            .unwrap_err(),
            PersistenceError::AlreadyExists
        );
        assert!(database.is_file());
        assert!(!fs::read(&database).unwrap().is_empty());
        assert_eq!(pair.phone_keys.snapshot(), key_records);
        assert_eq!(pair.phone_keys.destroy_calls(), 0);
    }

    let opened = DurablePhone::open(
        database.parent().unwrap(),
        pair.phone.store().crypto_session_id(),
        pair.phone_keys.clone(),
        pair.phone_anchor.clone(),
    )
    .unwrap();
    assert!(!marker.exists());
    assert!(database.is_file());
    assert!(!fs::read(&database).unwrap().is_empty());
    assert_eq!(pair.phone_keys.snapshot(), key_records);
    opened.store().close().unwrap();
    DurablePhone::open(
        database.parent().unwrap(),
        pair.phone.store().crypto_session_id(),
        pair.phone_keys.clone(),
        pair.phone_anchor.clone(),
    )
    .unwrap();
}

#[test]
fn committed_prejoin_phone_initialization_recovers_exact_key_package() {
    const META: TableDefinition<u8, &[u8]> = TableDefinition::new("metadata_v1");
    const OPERATIONS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("operations_v1");
    const OUTBOX: TableDefinition<&[u8], &[u8]> = TableDefinition::new("outbox_v1");
    const META_LIFECYCLE: u8 = 10;
    const META_EPOCH: u8 = 7;
    const META_AUTHENTICATOR: u8 = 8;

    let pair_context = context(159);
    let session = pair_context.crypto_session_id;
    let operation_id = id(160);
    let root = temp_root("prejoin-phone-recovery");
    let keys = TestKeys::enabled();
    let anchor = TestAnchor::new();
    let faults = OneShotFault::new();
    faults.arm(FaultPoint::BeforeInitializationReady);
    assert!(matches!(
        DurablePhone::create_with_runtime(
            &root,
            Identity::device(
                pair_context.account_id,
                pair_context.installation_id,
                pair_context.device_id,
            )
            .unwrap(),
            session,
            operation_id,
            keys.clone(),
            anchor.clone(),
            RuntimeHooks {
                faults,
                clock: ManualClock::new(1_000_000),
            },
        ),
        Err(PersistenceError::InjectedFault)
    ));

    let database_path = database_path(&root, session);
    let marker = marker_path(&root, session);
    let database = Database::open(&database_path).unwrap();
    let read = database.begin_read().unwrap();
    let meta = read.open_table(META).unwrap();
    assert_eq!(meta.get(META_LIFECYCLE).unwrap().unwrap().value(), &[1]);
    assert_eq!(
        meta.get(META_EPOCH).unwrap().unwrap().value(),
        0_u64.to_be_bytes()
    );
    assert!(
        meta.get(META_AUTHENTICATOR)
            .unwrap()
            .unwrap()
            .value()
            .is_empty()
    );
    drop(meta);
    let operation_bytes = read
        .open_table(OPERATIONS)
        .unwrap()
        .get(operation_id.as_slice())
        .unwrap()
        .unwrap()
        .value()
        .to_vec();
    let outbox_bytes = read
        .open_table(OUTBOX)
        .unwrap()
        .get(operation_id.as_slice())
        .unwrap()
        .unwrap()
        .value()
        .to_vec();
    drop(read);
    drop(database);
    assert!(!operation_bytes.is_empty());
    assert!(!outbox_bytes.is_empty());

    assert_eq!(
        discard_interrupted_creation(&root, session, keys.clone()).unwrap_err(),
        PersistenceError::InitializationIncomplete
    );
    assert_eq!(keys.destroy_calls(), 0);
    assert!(database_path.is_file());
    assert!(marker.is_file());

    let opened = DurablePhone::open(&root, session, keys.clone(), anchor.clone()).unwrap();
    let outbox = opened.store().outbox(operation_id).unwrap().unwrap();
    let operation = opened.store().operation(operation_id).unwrap().unwrap();
    assert_eq!(operation, CommittedOperation::Envelope(outbox.clone()));
    assert!(!outbox.ciphertext.is_empty());
    assert_eq!(outbox.class, crate::MessageClass::PairActivation);
    assert_eq!(outbox.epoch, 0);
    assert_eq!(
        opened.store().rollback_state().unwrap(),
        RollbackState {
            counter: 1,
            epoch: 0,
            epoch_authenticator: Vec::new(),
        }
    );
    assert!(!marker.exists());
    assert_eq!(keys.destroy_calls(), 0);
    opened.store().close().unwrap();
    drop(opened);

    let database = Database::open(&database_path).unwrap();
    let read = database.begin_read().unwrap();
    assert_eq!(
        read.open_table(OPERATIONS)
            .unwrap()
            .get(operation_id.as_slice())
            .unwrap()
            .unwrap()
            .value(),
        operation_bytes
    );
    assert_eq!(
        read.open_table(OUTBOX)
            .unwrap()
            .get(operation_id.as_slice())
            .unwrap()
            .unwrap()
            .value(),
        outbox_bytes
    );
    drop(read);
    drop(database);

    let reopened = DurablePhone::open(&root, session, keys, anchor).unwrap();
    assert_eq!(reopened.store().outbox(operation_id).unwrap(), Some(outbox));
    assert_eq!(
        reopened.store().rollback_state().unwrap(),
        RollbackState {
            counter: 1,
            epoch: 0,
            epoch_authenticator: Vec::new(),
        }
    );
    reopened.store().close().unwrap();
}

#[test]
fn malformed_prejoin_phone_state_fails_authenticated_recovery() {
    const STATE: TableDefinition<u8, &[u8]> = TableDefinition::new("encrypted_state_v1");
    const STATE_CURRENT: u8 = 1;

    let pair_context = context(161);
    let session = pair_context.crypto_session_id;
    let root = temp_root("malformed-prejoin-phone");
    let keys = TestKeys::enabled();
    let anchor = TestAnchor::new();
    let faults = OneShotFault::new();
    faults.arm(FaultPoint::BeforeInitializationReady);
    assert!(matches!(
        DurablePhone::create_with_runtime(
            &root,
            Identity::device(
                pair_context.account_id,
                pair_context.installation_id,
                pair_context.device_id,
            )
            .unwrap(),
            session,
            id(162),
            keys.clone(),
            anchor.clone(),
            RuntimeHooks {
                faults,
                clock: ManualClock::new(1_000_000),
            },
        ),
        Err(PersistenceError::InjectedFault)
    ));

    let database_path = database_path(&root, session);
    let database = Database::open(&database_path).unwrap();
    let mut write = database.begin_write().unwrap();
    write.set_durability(Durability::Immediate).unwrap();
    write.set_two_phase_commit(true);
    let mut state = write.open_table(STATE).unwrap();
    let mut sealed = state.get(STATE_CURRENT).unwrap().unwrap().value().to_vec();
    let last = sealed.last_mut().unwrap();
    *last ^= 0x01;
    state.insert(STATE_CURRENT, sealed.as_slice()).unwrap();
    drop(state);
    write.commit().unwrap();
    drop(database);

    assert_eq!(
        discard_interrupted_creation(&root, session, keys.clone()).unwrap_err(),
        PersistenceError::InitializationIncomplete
    );
    assert_eq!(keys.destroy_calls(), 0);
    assert!(matches!(
        DurablePhone::open(&root, session, keys.clone(), anchor),
        Err(PersistenceError::Corrupt) | Err(PersistenceError::Quarantined)
    ));
    assert_eq!(keys.destroy_calls(), 0);
    assert!(database_path.is_file());
    assert!(marker_path(&root, session).is_file());
}

#[test]
fn altered_ready_lifecycle_cannot_authorize_destructive_cleanup() {
    const META: TableDefinition<u8, &[u8]> = TableDefinition::new("metadata_v1");
    const META_LIFECYCLE: u8 = 10;
    const LIFECYCLE_INITIALIZING: u8 = 1;

    let pair = durable_pair(149);
    let root = pair.phone.store().path().parent().unwrap().to_path_buf();
    let session = pair.phone.store().crypto_session_id();
    let database_path = pair.phone.store().path().to_path_buf();
    let marker = marker_path(&root, session);
    pair.phone.store().close().unwrap();

    let database = Database::open(&database_path).unwrap();
    let mut write = database.begin_write().unwrap();
    write.set_durability(Durability::Immediate).unwrap();
    write.set_two_phase_commit(true);
    write
        .open_table(META)
        .unwrap()
        .insert(META_LIFECYCLE, &[LIFECYCLE_INITIALIZING] as &[u8])
        .unwrap();
    write.commit().unwrap();
    drop(database);
    fs::write(&marker, []).unwrap();

    let database_bytes = fs::read(&database_path).unwrap();
    assert!(!database_bytes.is_empty());
    let key_records = pair.phone_keys.snapshot();
    assert_eq!(
        discard_interrupted_creation(&root, session, pair.phone_keys.clone()).unwrap_err(),
        PersistenceError::InitializationIncomplete
    );
    assert!(!fs::read(&database_path).unwrap().is_empty());
    assert_eq!(pair.phone_keys.snapshot(), key_records);
    assert_eq!(pair.phone_keys.destroy_calls(), 0);

    let opened = DurablePhone::open(
        &root,
        session,
        pair.phone_keys.clone(),
        pair.phone_anchor.clone(),
    )
    .unwrap();
    assert!(database_path.is_file());
    assert!(!marker.exists());
    assert_eq!(pair.phone_keys.destroy_calls(), 0);
    opened.store().close().unwrap();
}

#[test]
fn lifecycle_claim_serializes_ready_publication_against_cleanup() {
    let root = temp_root("ready-publication-claim");
    let pair_context = context(150);
    let session = pair_context.crypto_session_id;
    let creator_identity = Identity::daemon(pair_context.account_id, pair_context.installation_id);
    let keys = TestKeys::enabled();
    let anchor = TestAnchor::new();
    let faults = OneShotFault::new();
    faults.block_at(FaultPoint::BeforeInitializationReady);

    let creator_root = root.clone();
    let creator_keys = keys.clone();
    let creator_anchor = anchor.clone();
    let creator_faults = faults.clone();
    let creator = thread::spawn(move || {
        DurableDaemon::create_with_runtime(
            &creator_root,
            creator_identity,
            pair_context,
            id(152),
            creator_keys,
            creator_anchor,
            RuntimeHooks {
                faults: creator_faults,
                clock: ManualClock::new(1_000_000),
            },
        )
    });

    faults.wait_until_blocked();
    assert!(marker_path(&root, session).is_file());
    assert!(database_path(&root, session).is_file());
    assert_eq!(
        discard_interrupted_creation(&root, session, keys.clone()).unwrap_err(),
        PersistenceError::LifecycleBusy
    );
    assert_eq!(keys.destroy_calls(), 0);
    assert!(marker_path(&root, session).is_file());
    assert!(database_path(&root, session).is_file());

    faults.release();
    let daemon = creator.join().unwrap().unwrap();
    assert!(!marker_path(&root, session).exists());
    assert!(database_path(&root, session).is_file());
    assert_eq!(keys.destroy_calls(), 0);
    daemon.store().close().unwrap();
    drop(daemon);
    DurableDaemon::open(&root, session, keys, anchor).unwrap();
}

#[test]
fn lifecycle_claim_serializes_marker_publication_against_cleanup() {
    let root = temp_root("marker-publication-claim");
    let pair_context = context(153);
    let session = pair_context.crypto_session_id;
    let creator_identity = Identity::device(
        pair_context.account_id,
        pair_context.installation_id,
        pair_context.device_id,
    )
    .unwrap();
    let keys = TestKeys::enabled();
    let anchor = TestAnchor::new();
    let faults = OneShotFault::new();
    faults.block_at(FaultPoint::AfterInitializationMarkerCreation);

    let creator_root = root.clone();
    let creator_keys = keys.clone();
    let creator_anchor = anchor.clone();
    let creator_faults = faults.clone();
    let creator = thread::spawn(move || {
        DurablePhone::create_with_runtime(
            &creator_root,
            creator_identity,
            session,
            id(155),
            creator_keys,
            creator_anchor,
            RuntimeHooks {
                faults: creator_faults,
                clock: ManualClock::new(1_000_000),
            },
        )
    });

    faults.wait_until_blocked();
    assert!(marker_path(&root, session).is_file());
    assert!(!database_path(&root, session).exists());
    assert_eq!(
        discard_interrupted_creation(&root, session, keys.clone()).unwrap_err(),
        PersistenceError::LifecycleBusy
    );
    assert_eq!(keys.destroy_calls(), 0);
    assert!(marker_path(&root, session).is_file());

    faults.release();
    let (phone, _) = creator.join().unwrap().unwrap();
    assert!(!marker_path(&root, session).exists());
    assert!(database_path(&root, session).is_file());
    assert_eq!(keys.destroy_calls(), 0);
    phone.store().close().unwrap();
    drop(phone);
    DurablePhone::open(&root, session, keys, anchor).unwrap();
}

#[test]
fn stale_marker_recovery_holds_lifecycle_claim_against_cleanup() {
    let pair = durable_pair(156);
    let root = pair.phone.store().path().parent().unwrap().to_path_buf();
    let session = pair.phone.store().crypto_session_id();
    let marker = marker_path(&root, session);
    pair.phone.store().close().unwrap();
    fs::write(&marker, []).unwrap();

    let faults = OneShotFault::new();
    faults.block_at(FaultPoint::DuringRestartReload);
    let opener_root = root.clone();
    let opener_keys = pair.phone_keys.clone();
    let opener_anchor = pair.phone_anchor.clone();
    let opener_faults = faults.clone();
    let opener = thread::spawn(move || {
        DurablePhone::open_with_runtime(
            &opener_root,
            session,
            opener_keys,
            opener_anchor,
            RuntimeHooks {
                faults: opener_faults,
                clock: ManualClock::new(1_000_000),
            },
        )
    });

    faults.wait_until_blocked();
    assert_eq!(
        discard_interrupted_creation(&root, session, pair.phone_keys.clone()).unwrap_err(),
        PersistenceError::LifecycleBusy
    );
    assert_eq!(pair.phone_keys.destroy_calls(), 0);
    assert!(marker.is_file());
    assert!(database_path(&root, session).is_file());

    faults.release();
    let opened = opener.join().unwrap().unwrap();
    assert!(!marker.exists());
    assert!(database_path(&root, session).is_file());
    assert_eq!(pair.phone_keys.destroy_calls(), 0);
    opened.store().close().unwrap();
}

#[test]
fn lifecycle_claim_recovers_after_process_death() {
    const CHILD_ROOT: &str = "AXL_E2EE_LIFECYCLE_CLAIM_CHILD_ROOT";
    let session = id(158);
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        let root = PathBuf::from(root);
        let _store = NativeTransactionalProvider::create(
            &root,
            session,
            TestKeys::enabled(),
            TestAnchor::new(),
            Arc::new(NoFaults),
            Arc::new(SystemClock),
        )
        .unwrap();
        fs::write(root.join("child-holds-claim"), []).unwrap();
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }

    let root = temp_root("process-lifecycle-claim");
    let signal = root.join("child-holds-claim");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "persistence_tests::lifecycle_claim_recovers_after_process_death",
            "--nocapture",
        ])
        .env(CHILD_ROOT, &root)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !signal.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(signal.exists());

    let keys = TestKeys::enabled();
    assert_eq!(
        discard_interrupted_creation(&root, session, keys.clone()).unwrap_err(),
        PersistenceError::LifecycleBusy
    );
    assert_eq!(keys.destroy_calls(), 0);
    child.kill().unwrap();
    child.wait().unwrap();
    fs::remove_file(signal).unwrap();

    discard_interrupted_creation(&root, session, keys.clone()).unwrap();
    assert_eq!(keys.destroy_calls(), 1);
    assert!(!database_path(&root, session).exists());
    assert!(!marker_path(&root, session).exists());
    assert!(lifecycle_claim_path(&root, session).is_file());
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
    drop(store);
    discard_interrupted_creation(&root, session, keys).unwrap();
}

#[test]
fn initialization_boundaries_clean_or_recover_by_committed_state() {
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
    discard_interrupted_creation(&marker_only_root, marker_only_session, marker_keys.clone())
        .unwrap();
    assert_eq!(marker_keys.destroy_calls(), 1);
    assert_eq!(
        discard_interrupted_creation(&marker_only_root, marker_only_session, marker_keys)
            .unwrap_err(),
        PersistenceError::NotFound
    );

    let malformed_root = temp_root("pre-schema-boundary");
    let malformed_context = context(128);
    let malformed_keys = TestKeys::enabled();
    let malformed_faults = OneShotFault::new();
    malformed_faults.arm(FaultPoint::AfterInitializationFileCreation);
    assert!(matches!(
        DurableDaemon::create_with_runtime(
            &malformed_root,
            Identity::daemon(
                malformed_context.account_id,
                malformed_context.installation_id,
            ),
            malformed_context.clone(),
            id(127),
            malformed_keys.clone(),
            TestAnchor::new(),
            RuntimeHooks {
                faults: malformed_faults,
                clock: ManualClock::new(1_000_000),
            },
        ),
        Err(PersistenceError::InjectedFault)
    ));
    let malformed_database = database_path(&malformed_root, malformed_context.crypto_session_id);
    let malformed_bytes = fs::read(&malformed_database).unwrap();
    assert!(!malformed_bytes.is_empty());
    malformed_keys
        .prepare(
            malformed_context.crypto_session_id,
            id(126),
            &[7; 32],
            b"unproven",
        )
        .unwrap();
    let malformed_key_records = malformed_keys.snapshot();
    assert_eq!(
        discard_interrupted_creation(
            &malformed_root,
            malformed_context.crypto_session_id,
            malformed_keys.clone(),
        )
        .unwrap_err(),
        PersistenceError::Corrupt
    );
    assert!(malformed_database.is_file());
    assert!(!fs::read(malformed_database).unwrap().is_empty());
    assert_eq!(malformed_keys.snapshot(), malformed_key_records);
    assert_eq!(malformed_keys.destroy_calls(), 0);

    for (index, point) in [
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
        if matches!(
            point,
            FaultPoint::DuringCurrentKeyActivation
                | FaultPoint::BeforeAnchorRecovery
                | FaultPoint::AfterAnchorRecoveryBeforeErasure
                | FaultPoint::BeforeInitializationReady
        ) {
            assert_eq!(
                discard_interrupted_creation(&root, context.crypto_session_id, keys.clone())
                    .unwrap_err(),
                PersistenceError::InitializationIncomplete
            );
            assert_eq!(keys.destroy_calls(), 0);
            let opened =
                DurableDaemon::open(&root, context.crypto_session_id, keys.clone(), anchor)
                    .unwrap();
            assert!(!marker_path(&root, context.crypto_session_id).exists());
            assert_eq!(keys.destroy_calls(), 0);
            opened.store().close().unwrap();
        } else {
            assert!(matches!(
                DurableDaemon::open(&root, context.crypto_session_id, keys.clone(), anchor,),
                Err(PersistenceError::InitializationIncomplete)
            ));
            discard_interrupted_creation(&root, context.crypto_session_id, keys).unwrap();
        }
    }
}

#[test]
fn interrupted_creation_is_explicitly_cleanable() {
    let root = temp_root("initializing");
    let context = context(84);
    let keys = TestKeys::enabled();
    let anchor = TestAnchor::new();
    let faults = OneShotFault::new();
    faults.arm(FaultPoint::AfterInitializationSchemaCommit);
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
    assert_eq!(
        fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>(),
        vec![lifecycle_claim_path(&root, context.crypto_session_id)]
    );
    assert!(keys.keys.lock().unwrap().is_empty());
    assert_eq!(keys.destroy_calls(), 1);
    assert_eq!(
        discard_interrupted_creation(&root, context.crypto_session_id, keys).unwrap_err(),
        PersistenceError::NotFound
    );
}

#[test]
fn cleanup_rejects_unsupported_wrong_session_unreadable_and_symlinked_databases() {
    const META: TableDefinition<u8, &[u8]> = TableDefinition::new("metadata_v1");

    let unsupported = durable_pair(142);
    unsupported.phone.store().close().unwrap();
    let unsupported_database = unsupported.phone.store().path().to_path_buf();
    fs::write(unsupported_database.with_extension("redb.initializing"), []).unwrap();
    let database = Database::open(&unsupported_database).unwrap();
    let mut write = database.begin_write().unwrap();
    write.set_durability(Durability::Immediate).unwrap();
    write.set_two_phase_commit(true);
    {
        let mut meta = write.open_table(META).unwrap();
        meta.insert(1, 99_u16.to_be_bytes().as_slice()).unwrap();
    }
    write.commit().unwrap();
    drop(database);
    let unsupported_bytes = fs::read(&unsupported_database).unwrap();
    assert!(!unsupported_bytes.is_empty());
    let unsupported_keys = unsupported.phone_keys.snapshot();
    assert_eq!(
        discard_interrupted_creation(
            unsupported_database.parent().unwrap(),
            unsupported.phone.store().crypto_session_id(),
            unsupported.phone_keys.clone(),
        )
        .unwrap_err(),
        PersistenceError::UnsupportedSchema
    );
    assert!(unsupported_database.is_file());
    assert!(!fs::read(&unsupported_database).unwrap().is_empty());
    assert_eq!(unsupported.phone_keys.snapshot(), unsupported_keys);
    assert_eq!(unsupported.phone_keys.destroy_calls(), 0);

    let wrong = durable_pair(143);
    wrong.phone.store().close().unwrap();
    let wrong_session = id(200);
    let wrong_database = database_path(wrong.phone.store().path().parent().unwrap(), wrong_session);
    fs::copy(wrong.phone.store().path(), &wrong_database).unwrap();
    fs::write(wrong_database.with_extension("redb.initializing"), []).unwrap();
    let wrong_bytes = fs::read(&wrong_database).unwrap();
    assert!(!wrong_bytes.is_empty());
    let wrong_keys = wrong.phone_keys.snapshot();
    for _ in 0..2 {
        assert_eq!(
            discard_interrupted_creation(
                wrong_database.parent().unwrap(),
                wrong_session,
                wrong.phone_keys.clone(),
            )
            .unwrap_err(),
            PersistenceError::IdentityMismatch
        );
        assert!(wrong_database.is_file());
        assert!(!fs::read(&wrong_database).unwrap().is_empty());
        assert_eq!(wrong.phone_keys.snapshot(), wrong_keys);
        assert_eq!(wrong.phone_keys.destroy_calls(), 0);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let unreadable = durable_pair(144);
        unreadable.phone.store().close().unwrap();
        let unreadable_database = unreadable.phone.store().path().to_path_buf();
        fs::write(unreadable_database.with_extension("redb.initializing"), []).unwrap();
        let unreadable_bytes = fs::read(&unreadable_database).unwrap();
        assert!(!unreadable_bytes.is_empty());
        let unreadable_keys = unreadable.phone_keys.snapshot();
        fs::set_permissions(&unreadable_database, fs::Permissions::from_mode(0o000)).unwrap();
        assert_eq!(
            discard_interrupted_creation(
                unreadable_database.parent().unwrap(),
                unreadable.phone.store().crypto_session_id(),
                unreadable.phone_keys.clone(),
            )
            .unwrap_err(),
            PersistenceError::Corrupt
        );
        fs::set_permissions(&unreadable_database, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(unreadable_database.is_file());
        assert!(!fs::read(&unreadable_database).unwrap().is_empty());
        assert_eq!(unreadable.phone_keys.snapshot(), unreadable_keys);
        assert_eq!(unreadable.phone_keys.destroy_calls(), 0);

        let symlinked = durable_pair(145);
        symlinked.phone.store().close().unwrap();
        let symlink_session = id(201);
        let symlink_database = database_path(
            symlinked.phone.store().path().parent().unwrap(),
            symlink_session,
        );
        symlink(symlinked.phone.store().path(), &symlink_database).unwrap();
        fs::write(symlink_database.with_extension("redb.initializing"), []).unwrap();
        let symlink_keys = symlinked.phone_keys.snapshot();
        assert_eq!(
            discard_interrupted_creation(
                symlink_database.parent().unwrap(),
                symlink_session,
                symlinked.phone_keys.clone(),
            )
            .unwrap_err(),
            PersistenceError::IdentityMismatch
        );
        assert!(symlinked.phone.store().path().exists());
        assert_eq!(symlinked.phone_keys.snapshot(), symlink_keys);
        assert_eq!(symlinked.phone_keys.destroy_calls(), 0);
    }
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
