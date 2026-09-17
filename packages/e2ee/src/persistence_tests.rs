// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{BTreeMap, VecDeque},
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
        ActivationOutcome, ClaimSubmission, CommittedOperation, DurableDaemon,
        DurablePendingInvitation, DurablePhone, DurablePreJoinDevice, EnvelopeKeyStore,
        FaultInjector, FaultPoint, InvitationLifecycle, NativeTransactionalProvider, NoFaults,
        PairLifecycle, PersistenceError, PreJoinLifecycle, RemovalOutcome, ReservationOutcome,
        RollbackAnchor, RollbackState, RuntimeHooks, WelcomeOutcome, discard_interrupted_creation,
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

struct ScriptedClock(Mutex<VecDeque<u64>>);

impl ScriptedClock {
    fn new(values: impl IntoIterator<Item = u64>) -> Arc<Self> {
        Arc::new(Self(Mutex::new(values.into_iter().collect())))
    }
}

impl Clock for ScriptedClock {
    fn now_ms(&self) -> Result<u64, Error> {
        self.0
            .lock()
            .unwrap()
            .pop_front()
            .ok_or(Error::ClockRollback)
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
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let clock = ManualClock::new(now_ms);
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
    let opener_clock = pair.clock.clone();
    let opener = thread::spawn(move || {
        DurablePhone::open_with_runtime(
            &opener_root,
            session,
            opener_keys,
            opener_anchor,
            RuntimeHooks {
                faults: opener_faults,
                clock: opener_clock,
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

#[derive(Clone)]
struct PairingIds {
    account: [u8; 16],
    installation: [u8; 16],
    session: [u8; 16],
    device: [u8; 16],
}

fn uuid_v7(seed: u8) -> [u8; 16] {
    let mut value = [seed; 16];
    value[6] = 0x70 | (seed & 0x0f);
    value[8] = 0x80 | (seed & 0x3f);
    value
}

fn pairing_ids(seed: u8) -> PairingIds {
    PairingIds {
        account: [seed; 16],
        installation: uuid_v7(seed.wrapping_add(1)),
        session: uuid_v7(seed.wrapping_add(2)),
        device: uuid_v7(seed.wrapping_add(3)),
    }
}

struct PendingFixture {
    root: PathBuf,
    endpoint: DurablePendingInvitation,
    publication: crate::persistence::InvitationPublication,
    keys: Arc<TestKeys>,
    anchor: Arc<TestAnchor>,
    clock: Arc<ManualClock>,
    ids: PairingIds,
}

fn pending_fixture(seed: u8) -> PendingFixture {
    let ids = pairing_ids(seed);
    let root = temp_root("pending-invitation");
    let keys = TestKeys::enabled();
    let anchor = TestAnchor::new();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let clock = ManualClock::new(now_ms);
    let (endpoint, publication) = DurablePendingInvitation::issue_with_runtime(
        &root,
        Identity::daemon(ids.account, ids.installation),
        ids.session,
        sequence_id(90, u64::from(seed)),
        keys.clone(),
        anchor.clone(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: clock.clone(),
        },
    )
    .unwrap();
    PendingFixture {
        root,
        endpoint,
        publication,
        keys,
        anchor,
        clock,
        ids,
    }
}

fn prepare_prejoin(
    fixture: &PendingFixture,
    seed: u8,
) -> (
    PathBuf,
    DurablePreJoinDevice,
    crate::persistence::PreJoinPublication,
    Arc<TestKeys>,
    Arc<TestAnchor>,
) {
    let root = temp_root("device-prejoin");
    let keys = TestKeys::enabled();
    let anchor = TestAnchor::new();
    let (device, publication) = DurablePreJoinDevice::prepare_with_runtime(
        &root,
        Identity::device(
            fixture.ids.account,
            fixture.ids.installation,
            fixture.ids.device,
        )
        .unwrap(),
        fixture.publication.bytes(),
        sequence_id(91, u64::from(seed)),
        keys.clone(),
        anchor.clone(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    (root, device, publication, keys, anchor)
}

#[test]
fn invitation_is_committed_before_publication_and_recovers_after_ambiguous_return() {
    let ids = pairing_ids(170);
    let root = temp_root("invitation-ambiguous-return");
    let keys = TestKeys::enabled();
    let anchor = TestAnchor::new();
    let faults = OneShotFault::new();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let clock = ManualClock::new(now_ms);
    faults.arm(FaultPoint::AfterCommitBeforeNetworkSend);
    assert!(matches!(
        DurablePendingInvitation::issue_with_runtime(
            &root,
            Identity::daemon(ids.account, ids.installation),
            ids.session,
            id(171),
            keys.clone(),
            anchor.clone(),
            RuntimeHooks {
                faults,
                clock: clock.clone(),
            },
        ),
        Err(PersistenceError::InjectedFault)
    ));
    assert!(!marker_path(&root, ids.session).exists());

    let mut recovered = DurablePendingInvitation::open_with_runtime(
        &root,
        ids.session,
        keys,
        anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock,
        },
    )
    .unwrap();
    let publication = recovered.publication().unwrap();
    assert_eq!(
        crate::pairing::PairingInvitation::decode(publication.bytes())
            .unwrap()
            .invitation_hash()
            .unwrap(),
        publication.invitation_hash()
    );
    assert_eq!(recovered.store().generation().unwrap(), 1);
}

#[test]
fn prejoin_creation_samples_the_clock_once_and_anchors_the_observed_time() {
    let fixture = pending_fixture(170);
    let observed = fixture.publication.expires_at_ms() - 1;
    let clock = ScriptedClock::new([observed]);
    let root = temp_root("device-prejoin-single-clock-sample");
    let keys = TestKeys::enabled();
    let anchor = TestAnchor::new();
    let (device, publication) = DurablePreJoinDevice::prepare_with_runtime(
        &root,
        Identity::device(
            fixture.ids.account,
            fixture.ids.installation,
            fixture.ids.device,
        )
        .unwrap(),
        fixture.publication.bytes(),
        id(172),
        keys,
        anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock,
        },
    )
    .unwrap();
    assert!(!publication.key_package().is_empty());
    assert_eq!(device.last_now_ms_for_test().unwrap(), observed);
}

#[test]
fn invitation_expiry_is_exclusive_durable_and_restart_safe() {
    let mut fixture = pending_fixture(171);
    fixture.clock.set(fixture.publication.expires_at_ms() - 1);
    assert_eq!(
        fixture.endpoint.lifecycle().unwrap(),
        InvitationLifecycle::Issued
    );
    let generation = fixture.endpoint.store().generation().unwrap();
    fixture.clock.set(fixture.publication.expires_at_ms());
    assert_eq!(
        fixture.endpoint.lifecycle().unwrap(),
        InvitationLifecycle::Expired
    );
    assert_eq!(
        fixture.endpoint.store().generation().unwrap(),
        generation + 1
    );
    fixture.endpoint.store().close().unwrap();
    drop(fixture.endpoint);
    let mut reopened = DurablePendingInvitation::open_with_runtime(
        &fixture.root,
        fixture.ids.session,
        fixture.keys,
        fixture.anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock,
        },
    )
    .unwrap();
    assert_eq!(reopened.lifecycle().unwrap(), InvitationLifecycle::Expired);
}

#[test]
fn pending_claim_and_device_prejoin_recover_exact_bytes() {
    let mut fixture = pending_fixture(172);
    let (device_root, device, publication, device_keys, device_anchor) =
        prepare_prejoin(&fixture, 172);
    let expected = publication.clone();
    let pending = fixture
        .endpoint
        .submit_claim(id(173), publication.claim())
        .unwrap();
    assert!(matches!(pending, ClaimSubmission::Pending { .. }));

    fixture.endpoint.store().close().unwrap();
    drop(fixture.endpoint);
    let mut reopened_daemon = DurablePendingInvitation::open_with_runtime(
        &fixture.root,
        fixture.ids.session,
        fixture.keys,
        fixture.anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        reopened_daemon.lifecycle().unwrap(),
        InvitationLifecycle::ClaimPending
    );
    assert_eq!(
        reopened_daemon
            .submit_claim(id(174), expected.claim())
            .unwrap(),
        pending
    );

    device.store().close().unwrap();
    drop(device);
    let mut reopened_device = DurablePreJoinDevice::open_with_runtime(
        &device_root,
        fixture.ids.session,
        device_keys,
        device_anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock,
        },
    )
    .unwrap();
    assert_eq!(reopened_device.publication().unwrap(), expected);
    assert_eq!(
        reopened_device.lifecycle().unwrap(),
        PreJoinLifecycle::PreJoin
    );
}

#[test]
fn failed_claims_are_idempotent_across_restart_and_fifth_cancels_atomically() {
    let mut fixture = pending_fixture(173);
    let (_, _, publication, _, _) = prepare_prejoin(&fixture, 173);
    let mut failed_claims = Vec::new();
    for index in 0..5_u8 {
        let mut bytes = publication.claim().to_vec();
        let last = bytes.len() - 1 - usize::from(index);
        bytes[last] ^= index + 1;
        failed_claims.push(bytes);
    }

    assert_eq!(
        fixture
            .endpoint
            .submit_claim(id(180), &failed_claims[0])
            .unwrap(),
        ClaimSubmission::Rejected {
            reason: Some(crate::persistence::ClaimFailure::Signature)
        }
    );
    assert_eq!(fixture.endpoint.failed_claim_count().unwrap(), 1);
    fixture.endpoint.store().close().unwrap();
    drop(fixture.endpoint);
    let mut endpoint = DurablePendingInvitation::open_with_runtime(
        &fixture.root,
        fixture.ids.session,
        fixture.keys,
        fixture.anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock,
        },
    )
    .unwrap();
    assert_eq!(
        endpoint.submit_claim(id(181), &failed_claims[0]).unwrap(),
        ClaimSubmission::Rejected {
            reason: Some(crate::persistence::ClaimFailure::Signature)
        }
    );
    assert_eq!(endpoint.failed_claim_count().unwrap(), 1);
    for (index, bytes) in failed_claims.iter().enumerate().skip(1) {
        let result = endpoint
            .submit_claim(sequence_id(92, index as u64), bytes)
            .unwrap();
        if index == 4 {
            assert_eq!(result, ClaimSubmission::Cancelled);
        } else {
            assert!(matches!(result, ClaimSubmission::Rejected { .. }));
        }
    }
    assert_eq!(endpoint.failed_claim_count().unwrap(), 5);
    assert_eq!(
        endpoint.lifecycle().unwrap(),
        InvitationLifecycle::Cancelled
    );
    assert_eq!(
        endpoint.submit_claim(id(182), &failed_claims[0]).unwrap(),
        ClaimSubmission::Rejected {
            reason: Some(crate::persistence::ClaimFailure::Signature)
        }
    );
}

#[test]
fn malformed_and_wrong_binding_claims_do_not_count() {
    let mut fixture = pending_fixture(174);
    let (_, _, publication, _, _) = prepare_prejoin(&fixture, 174);
    assert_eq!(
        fixture
            .endpoint
            .submit_claim(id(183), b"malformed")
            .unwrap(),
        ClaimSubmission::Rejected { reason: None }
    );
    let mut wrong_binding = publication.claim().to_vec();
    let account_offset = 2 + 1 + crate::PROFILE_ID.len() + 2;
    wrong_binding[account_offset] ^= 1;
    assert_eq!(
        fixture
            .endpoint
            .submit_claim(id(184), &wrong_binding)
            .unwrap(),
        ClaimSubmission::Rejected { reason: None }
    );
    assert_eq!(fixture.endpoint.failed_claim_count().unwrap(), 0);
    assert_eq!(
        fixture.endpoint.lifecycle().unwrap(),
        InvitationLifecycle::Issued
    );
}

#[test]
fn cancellation_is_terminal_and_recovers() {
    let mut fixture = pending_fixture(175);
    assert_eq!(
        fixture.endpoint.cancel(id(185)).unwrap(),
        InvitationLifecycle::Cancelled
    );
    fixture.endpoint.store().close().unwrap();
    drop(fixture.endpoint);
    let mut reopened = DurablePendingInvitation::open_with_runtime(
        &fixture.root,
        fixture.ids.session,
        fixture.keys,
        fixture.anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock,
        },
    )
    .unwrap();
    assert_eq!(
        reopened.lifecycle().unwrap(),
        InvitationLifecycle::Cancelled
    );
}

#[test]
fn malformed_and_missing_encrypted_invitation_records_fail_closed_after_restart() {
    let fixture = pending_fixture(176);
    let mut malformed = fixture.endpoint.record_bytes_for_test().unwrap();
    let state_offset = 2 + 1 + crate::PROFILE_ID.len() + 2;
    malformed[state_offset] = 99;
    fixture
        .endpoint
        .replace_record_for_test(id(186), &malformed)
        .unwrap();
    fixture.endpoint.store().close().unwrap();
    drop(fixture.endpoint);
    assert!(matches!(
        DurablePendingInvitation::open_with_runtime(
            &fixture.root,
            fixture.ids.session,
            fixture.keys,
            fixture.anchor,
            RuntimeHooks {
                faults: Arc::new(NoFaults),
                clock: fixture.clock,
            },
        ),
        Err(PersistenceError::Corrupt)
    ));

    let fixture = pending_fixture(177);
    fixture.endpoint.remove_record_for_test(id(187)).unwrap();
    fixture.endpoint.store().close().unwrap();
    drop(fixture.endpoint);
    assert!(matches!(
        DurablePendingInvitation::open_with_runtime(
            &fixture.root,
            fixture.ids.session,
            fixture.keys,
            fixture.anchor,
            RuntimeHooks {
                faults: Arc::new(NoFaults),
                clock: fixture.clock,
            },
        ),
        Err(PersistenceError::Corrupt)
    ));
}

#[test]
fn pairing_secrets_and_prejoin_private_material_are_not_plaintext_redb_values() {
    let fixture = pending_fixture(178);
    let (_, device, publication, _, _) = prepare_prejoin(&fixture, 178);
    let invitation =
        crate::pairing::PairingInvitation::decode(fixture.publication.bytes()).unwrap();
    let nonce_start = fixture.publication.bytes().len() - 64 - 32;
    let nonce = &fixture.publication.bytes()[nonce_start..nonce_start + 32];

    fixture.endpoint.store().close().unwrap();
    let daemon_file = fs::read(fixture.endpoint.store().path()).unwrap();
    assert!(
        !daemon_file
            .windows(fixture.publication.bytes().len())
            .any(|window| window == fixture.publication.bytes())
    );
    assert!(
        !daemon_file
            .windows(nonce.len())
            .any(|window| window == nonce)
    );
    assert_eq!(
        invitation.invitation_hash().unwrap(),
        fixture.publication.invitation_hash()
    );

    device.store().close().unwrap();
    let device_file = fs::read(device.store().path()).unwrap();
    assert!(
        !device_file
            .windows(publication.claim().len())
            .any(|window| window == publication.claim())
    );
    assert!(
        !device_file
            .windows(publication.key_package().len())
            .any(|window| window == publication.key_package())
    );
}

#[allow(clippy::type_complexity)]
fn confirmed_pairing(
    seed: u8,
) -> (
    PendingFixture,
    PathBuf,
    DurablePreJoinDevice,
    crate::persistence::PreJoinPublication,
    Arc<TestKeys>,
    Arc<TestAnchor>,
    [u8; 48],
    [u8; 16],
) {
    let mut fixture = pending_fixture(seed);
    let (device_root, device, publication, device_keys, device_anchor) =
        prepare_prejoin(&fixture, seed);
    let claim_hash = match fixture
        .endpoint
        .submit_claim(sequence_id(100, u64::from(seed)), publication.claim())
        .unwrap()
    {
        ClaimSubmission::Pending { claim_hash, .. } => claim_hash,
        other => panic!("unexpected claim result: {other:?}"),
    };
    let reservation_id = sequence_id(101, u64::from(seed));
    assert!(matches!(
        fixture
            .endpoint
            .confirm_claim(
                sequence_id(102, u64::from(seed)),
                claim_hash,
                reservation_id,
            )
            .unwrap(),
        ReservationOutcome::Reserved(_)
    ));
    (
        fixture,
        device_root,
        device,
        publication,
        device_keys,
        device_anchor,
        claim_hash,
        reservation_id,
    )
}

#[test]
fn one_reservation_wins_and_expired_reservation_can_be_replaced() {
    let mut fixture = pending_fixture(179);
    let (_, _, publication, _, _) = prepare_prejoin(&fixture, 179);
    let claim_hash = match fixture
        .endpoint
        .submit_claim(id(188), publication.claim())
        .unwrap()
    {
        ClaimSubmission::Pending { claim_hash, .. } => claim_hash,
        other => panic!("unexpected claim result: {other:?}"),
    };
    let mut first = fixture.endpoint.clone();
    let mut second = fixture.endpoint.clone();
    let first_handle = thread::spawn(move || first.confirm_claim(id(189), claim_hash, id(190)));
    let second_handle = thread::spawn(move || second.confirm_claim(id(191), claim_hash, id(192)));
    let outcomes = [
        first_handle.join().unwrap().unwrap(),
        second_handle.join().unwrap().unwrap(),
    ];
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, ReservationOutcome::Reserved(_)))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, ReservationOutcome::Busy))
            .count(),
        1
    );
    fixture.clock.advance(60_000);
    assert!(matches!(
        fixture
            .endpoint
            .confirm_claim(id(193), claim_hash, id(194))
            .unwrap(),
        ReservationOutcome::Reserved(_)
    ));
}

#[test]
fn group_welcome_join_and_activation_are_durable_and_exact() {
    let (
        mut fixture,
        device_root,
        mut device,
        _,
        device_keys,
        device_anchor,
        claim_hash,
        reservation_id,
    ) = confirmed_pairing(180);
    let welcome = match fixture
        .endpoint
        .create_welcome(id(195), reservation_id)
        .unwrap()
    {
        WelcomeOutcome::Committed(welcome) => welcome,
        other => panic!("unexpected Welcome result: {other:?}"),
    };
    assert_ne!(welcome.group_id(), [0; 32]);
    let duplicate = fixture.endpoint.recover_welcome(claim_hash).unwrap();
    assert_eq!(duplicate, WelcomeOutcome::Duplicate(welcome.clone()));

    assert_eq!(
        device.join(id(196), &welcome).unwrap(),
        PreJoinLifecycle::Joined
    );
    device.store().close().unwrap();
    drop(device);
    let mut device = DurablePreJoinDevice::open_with_runtime(
        &device_root,
        fixture.ids.session,
        device_keys,
        device_anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    assert_eq!(device.lifecycle().unwrap(), PreJoinLifecycle::Joined);

    let activation = match device.prepare_activation(id(197), id(198)).unwrap() {
        ActivationOutcome::Prepared(record) => record,
        other => panic!("unexpected activation result: {other:?}"),
    };
    let retry = match device.prepare_activation(id(197), id(198)).unwrap() {
        ActivationOutcome::Prepared(record) => record,
        other => panic!("unexpected activation retry: {other:?}"),
    };
    assert_eq!(retry.ciphertext, activation.ciphertext);
    let acceptance = match fixture
        .endpoint
        .accept_activation(id(199), id(198), &activation.ciphertext)
        .unwrap()
    {
        ActivationOutcome::Activated(acceptance) => acceptance,
        other => panic!("unexpected activation acceptance: {other:?}"),
    };
    assert_eq!(
        fixture
            .endpoint
            .accept_activation(id(200), id(198), &activation.ciphertext)
            .unwrap(),
        ActivationOutcome::Duplicate(acceptance.clone())
    );
    assert_eq!(
        device.acknowledge_activation(id(201), &acceptance).unwrap(),
        PairLifecycle::Active
    );
    assert_eq!(
        fixture.endpoint.recover_welcome(claim_hash).unwrap(),
        WelcomeOutcome::Consumed
    );
}

#[test]
fn group_creation_precommit_fault_retries_and_postcommit_fault_recovers_exact_welcome() {
    let (precommit, _, _, _, _, _, _, reservation_id) = confirmed_pairing(181);
    // The fixture uses NoFaults. Reopen with the same protected state and an injected fault.
    precommit.endpoint.store().close().unwrap();
    drop(precommit.endpoint);
    let faults = OneShotFault::new();
    faults.arm(FaultPoint::BeforeCommit);
    let mut endpoint = DurablePendingInvitation::open_with_runtime(
        &precommit.root,
        precommit.ids.session,
        precommit.keys.clone(),
        precommit.anchor.clone(),
        RuntimeHooks {
            faults: faults.clone(),
            clock: precommit.clock.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        endpoint
            .create_welcome(id(201), reservation_id)
            .unwrap_err(),
        PersistenceError::InjectedFault
    );
    endpoint.store().close().unwrap();
    drop(endpoint);
    let mut endpoint = DurablePendingInvitation::open_with_runtime(
        &precommit.root,
        precommit.ids.session,
        precommit.keys,
        precommit.anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: precommit.clock,
        },
    )
    .unwrap();
    assert!(matches!(
        endpoint.create_welcome(id(201), reservation_id).unwrap(),
        WelcomeOutcome::Committed(_)
    ));

    let (postcommit, _, _, _, _, _, _, reservation_id) = confirmed_pairing(182);
    postcommit.endpoint.store().close().unwrap();
    drop(postcommit.endpoint);
    let faults = OneShotFault::new();
    faults.arm(FaultPoint::AfterCommitBeforeNetworkSend);
    let mut endpoint = DurablePendingInvitation::open_with_runtime(
        &postcommit.root,
        postcommit.ids.session,
        postcommit.keys,
        postcommit.anchor,
        RuntimeHooks {
            faults,
            clock: postcommit.clock,
        },
    )
    .unwrap();
    assert_eq!(
        endpoint
            .create_welcome(id(202), reservation_id)
            .unwrap_err(),
        PersistenceError::InjectedFault
    );
    let recovered = endpoint.create_welcome(id(202), reservation_id).unwrap();
    assert!(matches!(recovered, WelcomeOutcome::Duplicate(_)));
}

#[test]
fn conflicting_claim_cannot_replace_confirmed_or_consumed_pairing() {
    let (mut fixture, _, _, publication, _, _, claim_hash, reservation_id) = confirmed_pairing(183);
    let mut conflict = publication.claim().to_vec();
    let last = conflict.len() - 1;
    conflict[last] ^= 1;
    assert_eq!(
        fixture.endpoint.submit_claim(id(203), &conflict).unwrap(),
        ClaimSubmission::Conflict
    );
    let welcome = fixture
        .endpoint
        .create_welcome(id(204), reservation_id)
        .unwrap();
    assert!(matches!(welcome, WelcomeOutcome::Committed(_)));
    assert_eq!(
        fixture.endpoint.submit_claim(id(205), &conflict).unwrap(),
        ClaimSubmission::Conflict
    );
    assert!(matches!(
        fixture.endpoint.recover_welcome(claim_hash).unwrap(),
        WelcomeOutcome::Duplicate(_)
    ));
}

fn activated_pair(
    seed: u8,
) -> (
    PendingFixture,
    PathBuf,
    DurablePreJoinDevice,
    Arc<TestKeys>,
    Arc<TestAnchor>,
) {
    let (mut fixture, device_root, mut device, _, device_keys, device_anchor, _, reservation_id) =
        confirmed_pairing(seed);
    let welcome = match fixture
        .endpoint
        .create_welcome(sequence_id(110, u64::from(seed)), reservation_id)
        .unwrap()
    {
        WelcomeOutcome::Committed(welcome) => welcome,
        other => panic!("unexpected Welcome result: {other:?}"),
    };
    device
        .join(sequence_id(111, u64::from(seed)), &welcome)
        .unwrap();
    let activation = match device
        .prepare_activation(
            sequence_id(112, u64::from(seed)),
            sequence_id(113, u64::from(seed)),
        )
        .unwrap()
    {
        ActivationOutcome::Prepared(record) => record,
        other => panic!("unexpected activation result: {other:?}"),
    };
    let acceptance = match fixture
        .endpoint
        .accept_activation(
            sequence_id(114, u64::from(seed)),
            sequence_id(113, u64::from(seed)),
            &activation.ciphertext,
        )
        .unwrap()
    {
        ActivationOutcome::Activated(acceptance) => acceptance,
        other => panic!("unexpected activation acceptance: {other:?}"),
    };
    device
        .acknowledge_activation(sequence_id(115, u64::from(seed)), &acceptance)
        .unwrap();
    (fixture, device_root, device, device_keys, device_anchor)
}

#[test]
fn replacement_commit_and_epoch_ready_complete_in_order_across_restart() {
    let (mut fixture, device_root, mut device, device_keys, device_anchor) = activated_pair(184);
    let proposal = device.prepare_replacement(id(210), id(211), 7).unwrap();
    assert_eq!(
        device.pair_lifecycle().unwrap(),
        Some(PairLifecycle::ReplacementProposed)
    );
    fixture
        .endpoint
        .receive_replacement_proposal(id(212), &proposal.ciphertext, id(211), 7)
        .unwrap();
    let commit = fixture
        .endpoint
        .create_update_commit(id(213), id(214), 7)
        .unwrap();
    assert_eq!(
        fixture.endpoint.pair_lifecycle().unwrap(),
        Some(PairLifecycle::WaitingForEpochReady)
    );
    assert!(
        fixture
            .endpoint
            .prepare_application(id(209), id(208), 7, b"daemon barrier")
            .is_err()
    );
    let ready = device
        .apply_update_commit(id(215), &commit, id(214), 7, id(216))
        .unwrap();
    assert_eq!(
        device.pair_lifecycle().unwrap(),
        Some(PairLifecycle::WaitingForEpochReady)
    );
    assert!(
        device
            .prepare_application(id(218), id(219), 7, b"blocked before acknowledgement")
            .is_err()
    );
    assert!(
        device
            .receive_application(id(207), &[], id(206), 7)
            .is_err()
    );
    let acceptance = fixture
        .endpoint
        .accept_epoch_ready(id(217), id(216), 7, &ready.ciphertext)
        .unwrap();
    assert_eq!(
        device
            .acknowledge_epoch_ready(id(218), &acceptance)
            .unwrap(),
        PairLifecycle::Active
    );
    assert!(
        device
            .prepare_application(id(219), id(220), 7, b"enabled after acknowledgement")
            .is_ok()
    );

    fixture.endpoint.store().close().unwrap();
    device.store().close().unwrap();
    drop(fixture.endpoint);
    drop(device);
    let daemon = DurablePendingInvitation::open_with_runtime(
        &fixture.root,
        fixture.ids.session,
        fixture.keys,
        fixture.anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    let phone = DurablePreJoinDevice::open_with_runtime(
        &device_root,
        fixture.ids.session,
        device_keys,
        device_anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock,
        },
    )
    .unwrap();
    assert_eq!(
        daemon.pair_lifecycle().unwrap(),
        Some(PairLifecycle::Active)
    );
    assert_eq!(phone.pair_lifecycle().unwrap(), Some(PairLifecycle::Active));
}

#[test]
fn daemon_only_removal_precedes_device_terminal_state() {
    let (mut fixture, _, mut device, _, _) = activated_pair(185);
    let removal = match fixture.endpoint.revoke_device(id(220), id(221), 8).unwrap() {
        RemovalOutcome::Commit(record) => record,
        other => panic!("unexpected removal result: {other:?}"),
    };
    assert_eq!(
        fixture.endpoint.pair_lifecycle().unwrap(),
        Some(PairLifecycle::Revoked)
    );
    assert_eq!(
        device.apply_removal(id(222), &removal, id(221), 8).unwrap(),
        RemovalOutcome::Removed
    );
    assert_eq!(
        device.pair_lifecycle().unwrap(),
        Some(PairLifecycle::Removed)
    );
    assert!(device.prepare_replacement(id(223), id(224), 8).is_err());
}

#[test]
fn reset_requires_fresh_device_session_and_group_identifiers() {
    let (mut fixture, _, mut device, _, _) = activated_pair(186);
    let requirement = device.reset(id(230)).unwrap();
    assert_eq!(device.pair_lifecycle().unwrap(), Some(PairLifecycle::Reset));
    assert!(
        requirement
            .validate_fresh(requirement.device_id(), uuid_v7(240), [240; 32], [240; 48],)
            .is_err()
    );
    assert!(
        requirement
            .validate_fresh(
                uuid_v7(241),
                requirement.crypto_session_id(),
                [241; 32],
                [241; 48],
            )
            .is_err()
    );
    assert!(
        requirement
            .validate_fresh(
                uuid_v7(242),
                uuid_v7(243),
                requirement.group_id().unwrap(),
                [242; 48],
            )
            .is_err()
    );
    requirement
        .validate_fresh(uuid_v7(244), uuid_v7(245), [246; 32], [246; 48])
        .unwrap();
    assert!(fixture.endpoint.reset(id(231)).is_ok());
    assert_eq!(
        fixture.endpoint.pair_lifecycle().unwrap(),
        Some(PairLifecycle::Reset)
    );
}

#[test]
fn accepted_claim_retries_recover_reservation_welcome_and_expiry_state() {
    let (mut fixture, _, mut device, publication, _, _, claim_hash, reservation_id) =
        confirmed_pairing(187);
    fixture.endpoint.close().unwrap();
    fixture.endpoint = DurablePendingInvitation::open_with_runtime(
        &fixture.root,
        fixture.ids.session,
        fixture.keys.clone(),
        fixture.anchor.clone(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        fixture.endpoint.lifecycle().unwrap(),
        InvitationLifecycle::Confirmed
    );
    assert!(matches!(
        fixture
            .endpoint
            .submit_claim(id(232), publication.claim())
            .unwrap(),
        ClaimSubmission::Confirmed(_)
    ));
    let welcome = match fixture
        .endpoint
        .create_welcome(id(233), reservation_id)
        .unwrap()
    {
        WelcomeOutcome::Committed(welcome) => welcome,
        other => panic!("unexpected Welcome result: {other:?}"),
    };
    assert_eq!(
        fixture
            .endpoint
            .submit_claim(id(234), publication.claim())
            .unwrap(),
        ClaimSubmission::Accepted(welcome.clone())
    );
    device.join(id(235), &welcome).unwrap();
    let activation = match device.prepare_activation(id(236), id(237)).unwrap() {
        ActivationOutcome::Prepared(record) => record,
        other => panic!("unexpected activation result: {other:?}"),
    };
    fixture.clock.set(welcome.expires_at_ms());
    assert_eq!(
        fixture
            .endpoint
            .submit_claim(id(238), publication.claim())
            .unwrap(),
        ClaimSubmission::Expired
    );
    assert_eq!(
        fixture
            .endpoint
            .create_welcome(id(233), reservation_id)
            .unwrap(),
        WelcomeOutcome::Expired
    );
    assert_eq!(
        fixture
            .endpoint
            .accept_activation(id(239), id(237), activation.ciphertext())
            .unwrap(),
        ActivationOutcome::Rejected
    );
    assert_eq!(
        fixture.endpoint.recover_welcome(claim_hash).unwrap(),
        WelcomeOutcome::Expired
    );
    fixture.endpoint.store().close().unwrap();
    drop(fixture.endpoint);
    let mut reopened = DurablePendingInvitation::open_with_runtime(
        &fixture.root,
        fixture.ids.session,
        fixture.keys,
        fixture.anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock,
        },
    )
    .unwrap();
    assert_eq!(
        reopened.recover_welcome(claim_hash).unwrap(),
        WelcomeOutcome::Expired
    );
}

#[test]
fn safe_facade_allows_active_messages_and_blocks_after_reset() {
    let (mut fixture, _, mut device, _, _) = activated_pair(188);
    let sent = device
        .prepare_application(id(240), id(241), 9, b"facade message")
        .unwrap();
    assert_eq!(
        fixture
            .endpoint
            .receive_application(id(242), &sent.ciphertext, id(241), 9)
            .unwrap()
            .plaintext(),
        b"facade message"
    );
    device.reset(id(243)).unwrap();
    assert_eq!(
        device
            .prepare_application(id(244), id(245), 9, b"blocked")
            .unwrap_err(),
        PersistenceError::Conflict
    );
}

#[test]
fn welcome_remains_joinable_after_invitation_expiry_until_its_own_deadline() {
    let mut fixture = pending_fixture(189);
    let (device_root, device, publication, device_keys, device_anchor) =
        prepare_prejoin(&fixture, 189);
    let claim_hash = match fixture
        .endpoint
        .submit_claim(id(10), publication.claim())
        .unwrap()
    {
        ClaimSubmission::Pending { claim_hash, .. } => claim_hash,
        other => panic!("unexpected claim result: {other:?}"),
    };
    fixture
        .clock
        .set(fixture.publication.expires_at_ms() - 1_000);
    let reservation_id = id(11);
    fixture
        .endpoint
        .confirm_claim(id(12), claim_hash, reservation_id)
        .unwrap();
    let welcome = match fixture
        .endpoint
        .create_welcome(id(13), reservation_id)
        .unwrap()
    {
        WelcomeOutcome::Committed(welcome) => welcome,
        other => panic!("unexpected Welcome result: {other:?}"),
    };
    device.store().close().unwrap();
    drop(device);
    fixture.clock.set(fixture.publication.expires_at_ms() + 1);
    assert!(fixture.clock.0.load(Ordering::SeqCst) < welcome.expires_at_ms());
    let mut device = DurablePreJoinDevice::open_with_runtime(
        &device_root,
        fixture.ids.session,
        device_keys,
        device_anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    assert_eq!(device.lifecycle().unwrap(), PreJoinLifecycle::Expired);
    assert_eq!(
        device.join(id(14), &welcome).unwrap(),
        PreJoinLifecycle::Joined
    );
    device.store().close().unwrap();
    drop(device);
    fs::remove_dir_all(device_root).unwrap();
}

#[test]
fn reservation_release_retry_returns_exact_result_without_releasing_replacement() {
    let (mut fixture, _, _, _, _, _, claim_hash, first_reservation) = confirmed_pairing(190);
    assert_eq!(
        fixture
            .endpoint
            .release_reservation(id(20), first_reservation)
            .unwrap(),
        ReservationOutcome::Unavailable
    );
    let replacement = id(21);
    assert!(matches!(
        fixture
            .endpoint
            .confirm_claim(id(22), claim_hash, replacement)
            .unwrap(),
        ReservationOutcome::Reserved(_)
    ));
    assert_eq!(
        fixture
            .endpoint
            .release_reservation(id(20), first_reservation)
            .unwrap(),
        ReservationOutcome::Unavailable
    );
    assert!(matches!(
        fixture
            .endpoint
            .create_welcome(id(23), replacement)
            .unwrap(),
        WelcomeOutcome::Committed(_)
    ));
}

#[test]
fn revocation_preempts_a_pending_device_replacement() {
    let (mut fixture, _, mut device, _, _) = activated_pair(191);
    let proposal = device.prepare_replacement(id(30), id(31), 4).unwrap();
    fixture
        .endpoint
        .receive_replacement_proposal(id(32), proposal.ciphertext(), id(31), 4)
        .unwrap();
    let removal = match fixture.endpoint.revoke_device(id(33), id(34), 4).unwrap() {
        RemovalOutcome::Commit(record) => record,
        other => panic!("unexpected removal result: {other:?}"),
    };
    assert_eq!(
        device.apply_removal(id(35), &removal, id(34), 4).unwrap(),
        RemovalOutcome::Removed
    );
}

#[test]
fn prejoin_reset_preserves_material_and_repair_enforces_fresh_inputs() {
    let fixture = pending_fixture(192);
    let (_, mut device, publication, _, _) = prepare_prejoin(&fixture, 192);
    let requirement = device.reset(id(40)).unwrap();
    assert_eq!(requirement.group_id(), None);
    assert_eq!(
        requirement.key_package_hash(),
        crate::pairing::sha384(publication.key_package()).unwrap()
    );

    let fresh_ids = pairing_ids(193);
    let daemon_root = temp_root("repair-daemon");
    let daemon_keys = TestKeys::enabled();
    let daemon_anchor = TestAnchor::new();
    let (daemon, invitation) = DurablePendingInvitation::issue_with_runtime(
        &daemon_root,
        Identity::daemon(fixture.ids.account, fixture.ids.installation),
        fresh_ids.session,
        id(41),
        daemon_keys,
        daemon_anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    let same_device_root = temp_root("repair-same-device");
    assert!(matches!(
        DurablePreJoinDevice::prepare_repair_with_runtime(
            &same_device_root,
            Identity::device(
                fixture.ids.account,
                fixture.ids.installation,
                fixture.ids.device,
            )
            .unwrap(),
            invitation.bytes(),
            id(42),
            TestKeys::enabled(),
            TestAnchor::new(),
            (
                RuntimeHooks {
                    faults: Arc::new(NoFaults),
                    clock: fixture.clock.clone(),
                },
                &requirement,
            ),
        ),
        Err(PersistenceError::IdentityMismatch)
    ));
    let repair_root = temp_root("repair-fresh-device");
    let (_, repaired) = DurablePreJoinDevice::prepare_repair_with_runtime(
        &repair_root,
        Identity::device(
            fixture.ids.account,
            fixture.ids.installation,
            fresh_ids.device,
        )
        .unwrap(),
        invitation.bytes(),
        id(43),
        TestKeys::enabled(),
        TestAnchor::new(),
        (
            RuntimeHooks {
                faults: Arc::new(NoFaults),
                clock: fixture.clock,
            },
            &requirement,
        ),
    )
    .unwrap();
    assert_ne!(
        crate::pairing::sha384(repaired.key_package()).unwrap(),
        requirement.key_package_hash()
    );
    daemon.close().unwrap();
}

#[test]
fn pairing_operation_discriminants_are_exhaustive() {
    use crate::persistence::validate_pairing_operation_discriminants_for_test;

    assert!(validate_pairing_operation_discriminants_for_test(1, 1).is_ok());
    assert!(validate_pairing_operation_discriminants_for_test(21, 5).is_ok());
    assert!(validate_pairing_operation_discriminants_for_test(22, 14).is_ok());
    assert_eq!(
        validate_pairing_operation_discriminants_for_test(0, 1),
        Err(PersistenceError::Corrupt)
    );
    assert_eq!(
        validate_pairing_operation_discriminants_for_test(255, 1),
        Err(PersistenceError::Corrupt)
    );
    assert_eq!(
        validate_pairing_operation_discriminants_for_test(1, 255),
        Err(PersistenceError::Corrupt)
    );
    assert_eq!(
        validate_pairing_operation_discriminants_for_test(8, 13),
        Err(PersistenceError::Corrupt)
    );
}

#[test]
fn strict_daemon_record_validation_rejects_impossible_shapes_for_every_state() {
    let issued = pending_fixture(194);
    assert!(issued.endpoint.rejects_shape_mutation_for_test(1).unwrap());

    let mut pending = pending_fixture(195);
    let (_, _, publication, _, _) = prepare_prejoin(&pending, 195);
    pending
        .endpoint
        .submit_claim(id(50), publication.claim())
        .unwrap();
    assert!(pending.endpoint.rejects_shape_mutation_for_test(1).unwrap());

    let (confirmed, _, _, _, _, _, _, _) = confirmed_pairing(196);
    assert!(
        confirmed
            .endpoint
            .rejects_shape_mutation_for_test(2)
            .unwrap()
    );

    let (mut consumed, _, _, _, _, _, _, reservation) = confirmed_pairing(197);
    consumed
        .endpoint
        .create_welcome(id(51), reservation)
        .unwrap();
    assert!(
        consumed
            .endpoint
            .rejects_shape_mutation_for_test(4)
            .unwrap()
    );

    let (active, _, _, _, _) = activated_pair(198);
    assert!(active.endpoint.rejects_shape_mutation_for_test(5).unwrap());

    let mut cancelled = pending_fixture(199);
    cancelled.endpoint.cancel(id(52)).unwrap();
    assert!(
        cancelled
            .endpoint
            .rejects_shape_mutation_for_test(3)
            .unwrap()
    );

    let mut expired = pending_fixture(200);
    expired.clock.set(expired.publication.expires_at_ms());
    assert_eq!(
        expired.endpoint.lifecycle().unwrap(),
        InvitationLifecycle::Expired
    );
    assert!(expired.endpoint.rejects_shape_mutation_for_test(3).unwrap());
}

#[test]
fn device_expiry_persists_when_first_observed_after_the_deadline() {
    for (seed, delay) in [(201, 1), (202, 86_400_000)] {
        let fixture = pending_fixture(seed);
        let (root, mut device, _, keys, anchor) = prepare_prejoin(&fixture, seed);
        fixture
            .clock
            .set(fixture.publication.expires_at_ms() + delay);
        assert_eq!(device.lifecycle().unwrap(), PreJoinLifecycle::Expired);
        device.store().close().unwrap();
        drop(device);
        let mut reopened = DurablePreJoinDevice::open_with_runtime(
            &root,
            fixture.ids.session,
            keys,
            anchor,
            RuntimeHooks {
                faults: Arc::new(NoFaults),
                clock: fixture.clock,
            },
        )
        .unwrap();
        assert_eq!(reopened.lifecycle().unwrap(), PreJoinLifecycle::Expired);
    }
}

#[allow(clippy::type_complexity)]
fn joined_pair(
    seed: u8,
) -> (
    PendingFixture,
    PathBuf,
    DurablePreJoinDevice,
    Arc<TestKeys>,
    Arc<TestAnchor>,
    crate::persistence::WelcomePublication,
) {
    let (mut fixture, root, mut device, _, keys, anchor, _, reservation_id) =
        confirmed_pairing(seed);
    let welcome = match fixture
        .endpoint
        .create_welcome(sequence_id(120, u64::from(seed)), reservation_id)
        .unwrap()
    {
        WelcomeOutcome::Committed(welcome) => welcome,
        other => panic!("unexpected Welcome result: {other:?}"),
    };
    device
        .join(sequence_id(121, u64::from(seed)), &welcome)
        .unwrap();
    (fixture, root, device, keys, anchor, welcome)
}

#[test]
fn activation_preparation_rejects_at_and_after_welcome_expiry() {
    for (seed, offset) in [(203, 0), (204, 1)] {
        let (fixture, _, mut device, _, _, welcome) = joined_pair(seed);
        fixture.clock.set(welcome.expires_at_ms() + offset);
        assert_eq!(
            device
                .prepare_activation(sequence_id(122, u64::from(seed)), id(seed))
                .unwrap(),
            ActivationOutcome::Rejected
        );
        assert_eq!(device.lifecycle().unwrap(), PreJoinLifecycle::Joined);
        assert_eq!(
            device.pair_lifecycle().unwrap(),
            Some(PairLifecycle::AwaitingActivation)
        );
    }
}

#[test]
fn pending_activation_survives_restart_and_opens_only_after_daemon_acceptance() {
    let (mut fixture, root, mut device, keys, anchor, welcome) = joined_pair(205);
    fixture.clock.set(welcome.expires_at_ms() - 1);
    let activation = match device.prepare_activation(id(60), id(61)).unwrap() {
        ActivationOutcome::Prepared(record) => record,
        other => panic!("unexpected activation result: {other:?}"),
    };
    assert_eq!(device.lifecycle().unwrap(), PreJoinLifecycle::Joined);
    assert_eq!(
        device.pair_lifecycle().unwrap(),
        Some(PairLifecycle::AwaitingActivation)
    );
    assert!(
        device
            .prepare_application(id(62), id(63), 1, b"blocked")
            .is_err()
    );
    assert!(device.receive_application(id(64), &[], id(65), 1).is_err());

    device.store().close().unwrap();
    drop(device);
    let mut device = DurablePreJoinDevice::open_with_runtime(
        &root,
        fixture.ids.session,
        keys,
        anchor,
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    assert_eq!(device.lifecycle().unwrap(), PreJoinLifecycle::Joined);
    let retry = match device.prepare_activation(id(60), id(61)).unwrap() {
        ActivationOutcome::Prepared(record) => record,
        other => panic!("unexpected activation retry: {other:?}"),
    };
    assert_eq!(retry.ciphertext(), activation.ciphertext());
    let acceptance = match fixture
        .endpoint
        .accept_activation(id(66), id(61), activation.ciphertext())
        .unwrap()
    {
        ActivationOutcome::Activated(acceptance) => acceptance,
        other => panic!("unexpected daemon activation result: {other:?}"),
    };
    assert_eq!(
        device.acknowledge_activation(id(67), &acceptance).unwrap(),
        PairLifecycle::Active
    );
    assert!(
        device
            .prepare_application(id(68), id(69), 1, b"enabled")
            .is_ok()
    );
}

#[test]
fn delayed_activation_rejection_never_opens_the_device() {
    let (mut fixture, _, mut device, _, _, welcome) = joined_pair(206);
    fixture.clock.set(welcome.expires_at_ms() - 1);
    let activation = match device.prepare_activation(id(70), id(71)).unwrap() {
        ActivationOutcome::Prepared(record) => record,
        other => panic!("unexpected activation result: {other:?}"),
    };
    fixture.clock.set(welcome.expires_at_ms());
    assert_eq!(
        fixture
            .endpoint
            .accept_activation(id(72), id(71), activation.ciphertext())
            .unwrap(),
        ActivationOutcome::Rejected
    );
    assert_eq!(device.lifecycle().unwrap(), PreJoinLifecycle::Joined);
    assert_eq!(
        device.pair_lifecycle().unwrap(),
        Some(PairLifecycle::AwaitingActivation)
    );
    assert!(
        device
            .prepare_application(id(73), id(74), 1, b"still blocked")
            .is_err()
    );
}
