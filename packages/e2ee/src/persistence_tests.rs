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

use openmls_basic_credential::SignatureKeyPair;
use redb::{Database, Durability, ReadableDatabase, ReadableTable, TableDefinition};

use crate::{
    Clock, Error, Identity, PairContext, PairWelcome, SUITE, SystemClock, TransactionalProvider,
    pairing::PairingCredential,
    persistence::{
        ActivationOutcome, ClaimSubmission, CommittedOperation, DurableDaemon,
        DurablePendingInvitation, DurablePhone, DurablePreJoinDevice, EnvelopeKeyStore,
        FaultInjector, FaultPoint, InvitationLifecycle, NativeTransactionalProvider, NoFaults,
        PairLifecycle, PendingWitnessRequest, PersistenceError, PreJoinLifecycle, RemovalOutcome,
        ReservationOutcome, RuntimeHooks, TypedResult, WelcomeOutcome, WitnessEndpoint,
        WitnessOutcome, discard_interrupted_creation,
    },
    witness::{
        EndpointReconciliation, QuorumCertificate, ReplicaKey, ReplicaReceipt, ReplicaTrust,
        ReplicaTrustSet, StoredWitnessOperation, TestReceiptFields, WitnessHead, WitnessHistory,
        WitnessLedgerPosition, WitnessRequest, WitnessRequestKind, WitnessResult,
        WitnessRevocationEvent, evaluate_witness_request,
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

fn uuid_v7(seed: u8) -> [u8; 16] {
    let mut value = [seed; 16];
    value[6] = 0x70 | (seed & 0x0f);
    value[8] = 0x80 | (seed & 0x3f);
    value
}

/// Legacy pair context. Witness lineages require UUIDv7 installation, device, and session IDs.
fn context(seed: u8) -> PairContext {
    PairContext {
        crypto_session_id: uuid_v7(seed),
        group_id: [seed; 32],
        account_id: id(seed.wrapping_add(1)),
        installation_id: uuid_v7(seed.wrapping_add(2)),
        device_id: uuid_v7(seed.wrapping_add(3)),
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
    /// When set, `erase` succeeds without removing the record: deletion failure evidence.
    erase_noop: Mutex<bool>,
}

impl TestKeys {
    fn enabled() -> Arc<Self> {
        Arc::new(Self {
            keys: Mutex::new(BTreeMap::new()),
            available: Mutex::new(true),
            destroy_calls: AtomicU64::new(0),
            erase_noop: Mutex::new(false),
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

    fn contains(&self, key_id: [u8; 16]) -> bool {
        self.keys.lock().unwrap().contains_key(&key_id)
    }

    fn is_active(&self, key_id: [u8; 16]) -> bool {
        self.keys
            .lock()
            .unwrap()
            .get(&key_id)
            .is_some_and(|record| record.active)
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
        if *self.erase_noop.lock().unwrap() {
            return Ok(());
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

/// Deterministic in-process three-replica witness.
///
/// Each replica signs its own receipt with its own key. Decisions come from the shared
/// `evaluate_witness_request` logic over an append-only per-lineage history. Byte-identical
/// certificates are returned for duplicate accepted operations. Fault switches simulate an
/// unavailable quorum, a rolled-back replica, and a forged receipt.
struct TestWitness {
    signers: [SignatureKeyPair; 3],
    trust: Arc<ReplicaTrustSet>,
    lineages: Mutex<BTreeMap<[u8; 48], Lineage>>,
    sequence: AtomicU64,
    unavailable: Mutex<bool>,
    forge_signature: Mutex<bool>,
    respond_count: AtomicU64,
}

struct Lineage {
    history: WitnessHistory,
    credential: PairingCredential,
    head_predecessor: [u8; 48],
    certificates: BTreeMap<[u8; 16], Vec<u8>>,
    revocation_generation: u64,
}

impl TestWitness {
    fn new() -> Arc<Self> {
        let signers: [SignatureKeyPair; 3] =
            std::array::from_fn(|_| SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap());
        let trust = ReplicaTrustSet::new(
            (0..3)
                .map(|index| {
                    ReplicaTrust::new(
                        id(200 + index as u8),
                        vec![
                            ReplicaKey::new(
                                id(210 + index as u8),
                                signers[index].public().try_into().unwrap(),
                            )
                            .unwrap(),
                        ],
                    )
                    .unwrap()
                })
                .collect(),
        )
        .unwrap();
        Arc::new(Self {
            signers,
            trust: Arc::new(trust),
            lineages: Mutex::new(BTreeMap::new()),
            sequence: AtomicU64::new(0),
            unavailable: Mutex::new(false),
            forge_signature: Mutex::new(false),
            respond_count: AtomicU64::new(0),
        })
    }

    fn trust(&self) -> Arc<ReplicaTrustSet> {
        Arc::clone(&self.trust)
    }

    fn set_unavailable(&self, value: bool) {
        *self.unavailable.lock().unwrap() = value;
    }

    fn set_forge_signature(&self, value: bool) {
        *self.forge_signature.lock().unwrap() = value;
    }

    fn responses(&self) -> u64 {
        self.respond_count.load(Ordering::SeqCst)
    }

    fn head(&self, request_bytes: &[u8]) -> Option<WitnessHead> {
        let request = WitnessRequest::decode(request_bytes).unwrap();
        let hash = request.lineage().hash().unwrap();
        self.lineages
            .lock()
            .unwrap()
            .get(&hash)
            .map(|lineage| lineage.history.head.clone())
    }

    /// Roll every replica back to the previous head (correlated three-replica rollback).
    fn roll_back_all(&self, request_bytes: &[u8]) {
        let request = WitnessRequest::decode(request_bytes).unwrap();
        let hash = request.lineage().hash().unwrap();
        let mut lineages = self.lineages.lock().unwrap();
        let lineage = lineages.get_mut(&hash).unwrap();
        let predecessor = lineage.head_predecessor;
        let counter = lineage.history.head.counter - 1;
        lineage.history.head = WitnessHead {
            counter,
            commitment: predecessor,
        };
        lineage.history.successors.retain(|(c, _), _| *c < counter);
        lineage
            .history
            .operations
            .retain(|_, op| op.successor.as_ref().is_none_or(|s| s.counter <= counter));
    }

    /// Advance the lineage by one foreign successor (a clone won the race).
    fn advance_foreign(&self, request_bytes: &[u8]) {
        let request = WitnessRequest::decode(request_bytes).unwrap();
        let hash = request.lineage().hash().unwrap();
        let mut lineages = self.lineages.lock().unwrap();
        let lineage = lineages.get_mut(&hash).unwrap();
        let old = lineage.history.head.clone();
        let next = WitnessHead {
            counter: old.counter + 1,
            commitment: [0xEE; 48],
        };
        lineage
            .history
            .successors
            .insert((old.counter, old.commitment), next.clone());
        lineage.head_predecessor = old.commitment;
        lineage.history.head = next;
    }

    fn revoke(&self, request_bytes: &[u8]) {
        let request = WitnessRequest::decode(request_bytes).unwrap();
        let hash = request.lineage().hash().unwrap();
        let mut lineages = self.lineages.lock().unwrap();
        let lineage = lineages.get_mut(&hash).unwrap();
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        lineage.revocation_generation += 1;
        lineage.history.revocation = Some(WitnessRevocationEvent {
            position: WitnessLedgerPosition {
                sequence,
                revocation_generation: lineage.revocation_generation,
            },
        });
    }

    fn respond(&self, request_bytes: &[u8]) -> Result<Vec<u8>, PersistenceError> {
        self.respond_count.fetch_add(1, Ordering::SeqCst);
        if *self.unavailable.lock().unwrap() {
            return Err(PersistenceError::WitnessUnavailable);
        }
        let request = WitnessRequest::decode(request_bytes).unwrap();
        let lineage_hash = request.lineage().hash().unwrap();
        let mut lineages = self.lineages.lock().unwrap();
        if request.kind() == WitnessRequestKind::Register && !lineages.contains_key(&lineage_hash) {
            let credential = PairingCredential::decode(request.credential().unwrap()).unwrap();
            request.verify(request.lineage(), &credential).unwrap();
            lineages.insert(
                lineage_hash,
                Lineage {
                    history: WitnessHistory {
                        head: WitnessHead {
                            counter: 0,
                            commitment: [0; 48],
                        },
                        successors: BTreeMap::new(),
                        operations: BTreeMap::new(),
                        revocation: None,
                        forked: false,
                    },
                    credential,
                    head_predecessor: [0; 48],
                    certificates: BTreeMap::new(),
                    revocation_generation: 0,
                },
            );
        }
        let Some(lineage) = lineages.get_mut(&lineage_hash) else {
            // Absent lineage: a read answers with an empty head; anything else cannot exist.
            assert_eq!(request.kind(), WitnessRequestKind::Read);
            return Ok(self.certificate(
                &request,
                WitnessResult::Head,
                WitnessHead {
                    counter: 0,
                    commitment: [0; 48],
                },
                [0; 48],
                0,
            ));
        };
        request
            .verify(request.lineage(), &lineage.credential)
            .unwrap();
        let decision = evaluate_witness_request(&lineage.history, &request).unwrap();
        if decision.exact_receipt.is_some() {
            return Ok(lineage.certificates[&request.operation_id()].clone());
        }
        let (head, predecessor) = match request.kind() {
            WitnessRequestKind::Read => (lineage.history.head.clone(), lineage.head_predecessor),
            _ => (
                WitnessHead {
                    counter: request.proposed_counter().unwrap(),
                    commitment: request.proposed_commitment().unwrap(),
                },
                request.expected_commitment().unwrap_or([0; 48]),
            ),
        };
        let certificate = self.certificate(
            &request,
            decision.result,
            head.clone(),
            predecessor,
            lineage.revocation_generation,
        );
        match decision.result {
            WitnessResult::Registered | WitnessResult::Advanced => {
                let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
                let old = lineage.history.head.clone();
                lineage
                    .history
                    .successors
                    .insert((old.counter, old.commitment), head.clone());
                lineage.head_predecessor = old.commitment;
                lineage.history.head = head.clone();
                let receipt = QuorumCertificate::decode(&certificate).unwrap().receipts()[0]
                    .encode()
                    .unwrap();
                lineage.history.operations.insert(
                    request.operation_id(),
                    StoredWitnessOperation {
                        request_hash: request.request_hash().unwrap(),
                        result: decision.result,
                        successor: Some(head),
                        exact_receipt: receipt,
                        accepted_at: Some(WitnessLedgerPosition {
                            sequence,
                            revocation_generation: lineage.revocation_generation,
                        }),
                    },
                );
                lineage
                    .certificates
                    .insert(request.operation_id(), certificate.clone());
            }
            WitnessResult::ConflictingSuccessor | WitnessResult::HistoricalFork => {
                lineage.history.forked = true;
            }
            _ => {}
        }
        Ok(certificate)
    }

    fn certificate(
        &self,
        request: &WitnessRequest,
        result: WitnessResult,
        head: WitnessHead,
        predecessor: [u8; 48],
        revocation_generation: u64,
    ) -> Vec<u8> {
        let forge = *self.forge_signature.lock().unwrap();
        let receipts = (0..3)
            .map(|index| {
                let forged;
                let signer = if forge && index == 1 {
                    forged = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
                    &forged
                } else {
                    &self.signers[index]
                };
                ReplicaReceipt::sign_for_test(
                    TestReceiptFields {
                        result,
                        replica_id: self.trust.replicas()[index].replica_id(),
                        witness_key_id: self.trust.replicas()[index].keys()[0].key_id(),
                        lineage_hash: request.lineage().hash().unwrap(),
                        counter: head.counter,
                        commitment: head.commitment,
                        predecessor_commitment: predecessor,
                        operation_id: request.operation_id(),
                        request_hash: request.request_hash().unwrap(),
                        ledger_sequence: self.sequence.load(Ordering::SeqCst) + 1,
                        issued_at_ms: 1_000,
                        revocation_generation,
                    },
                    signer,
                )
                .unwrap()
            })
            .collect();
        QuorumCertificate::from_receipts_for_test(receipts)
            .unwrap()
            .encode()
            .unwrap()
    }
}

/// Obtain a fresh unanimous head and reconcile. Returns the reconciliation outcome.
fn reconcile<E: WitnessEndpoint>(
    endpoint: &E,
    witness: &TestWitness,
) -> Result<EndpointReconciliation, PersistenceError> {
    let read = endpoint.witness_read_request()?;
    let certificate = witness.respond(&read)?;
    endpoint.reconcile_witness(&certificate)
}

/// Send the exact pending request to the witness and complete the barrier.
fn complete<E: WitnessEndpoint>(
    endpoint: &E,
    witness: &TestWitness,
    request: &PendingWitnessRequest,
) -> Result<TypedResult, PersistenceError> {
    let certificate = witness.respond(request.request())?;
    endpoint.continue_witness(request.operation_id(), &certificate)
}

/// Reconcile until a mutation is authorized, finishing any resend or accepted-recovery of the
/// one pending operation exactly as restart recovery requires.
fn authorize<E: WitnessEndpoint>(
    endpoint: &E,
    witness: &TestWitness,
) -> Result<(), PersistenceError> {
    for _ in 0..3 {
        match reconcile(endpoint, witness)? {
            EndpointReconciliation::Ready => return Ok(()),
            EndpointReconciliation::ResendPending | EndpointReconciliation::RecoverAccepted => {
                let pending = endpoint
                    .pending_witness()?
                    .ok_or(PersistenceError::FreshWitnessRequired)?;
                complete(endpoint, witness, &pending)?;
            }
            EndpointReconciliation::WitnessUnavailable => {
                return Err(PersistenceError::WitnessUnavailable);
            }
            EndpointReconciliation::Quarantined(_) => return Err(PersistenceError::Quarantined),
            EndpointReconciliation::Revoked => return Err(PersistenceError::EndpointRevoked),
        }
    }
    Err(PersistenceError::WitnessUnavailable)
}

/// Full barrier for one mutation: fresh read, reconcile, mutate, and continue.
fn witnessed<E, T>(
    endpoint: &mut E,
    witness: &TestWitness,
    mutate: impl FnOnce(&mut E) -> Result<WitnessOutcome<T>, PersistenceError>,
) -> Result<T, PersistenceError>
where
    E: WitnessEndpoint,
    T: TryFrom<TypedResult, Error = PersistenceError>,
{
    authorize(endpoint, witness)?;
    match mutate(endpoint)? {
        WitnessOutcome::Released(value) => Ok(value),
        WitnessOutcome::Pending(request) => complete(endpoint, witness, &request)?.try_into(),
    }
}

/// Like `witnessed`, but retries while another racing operation holds the authorization or the
/// pending slot. Used only by contention tests.
fn witnessed_retry<E, T>(
    endpoint: &mut E,
    witness: &TestWitness,
    mutate: impl Fn(&mut E) -> Result<WitnessOutcome<T>, PersistenceError>,
) -> Result<T, PersistenceError>
where
    E: WitnessEndpoint,
    T: TryFrom<TypedResult, Error = PersistenceError>,
{
    loop {
        match witnessed(endpoint, witness, &mutate) {
            Err(PersistenceError::FreshWitnessRequired | PersistenceError::WitnessUnavailable) => {
                thread::yield_now();
            }
            other => return other,
        }
    }
}

/// Complete an interrupted creation: the register certificate publishes the endpoint.
fn finish_creation<E: WitnessEndpoint>(
    endpoint: &E,
    witness: &TestWitness,
    request: &PendingWitnessRequest,
) -> TypedResult {
    assert_eq!(request.kind(), WitnessRequestKind::Register);
    complete(endpoint, witness, request).unwrap()
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
    context: PairContext,
    daemon_keys: Arc<TestKeys>,
    phone_keys: Arc<TestKeys>,
    daemon_witness: Arc<TestWitness>,
    phone_witness: Arc<TestWitness>,
    daemon_faults: Arc<OneShotFault>,
    phone_faults: Arc<OneShotFault>,
    clock: Arc<ManualClock>,
}

impl DurablePair {
    fn phone_send(
        &mut self,
        op: [u8; 16],
        logical: [u8; 16],
        generation: u64,
        plaintext: &[u8],
    ) -> Result<crate::persistence::OutboxRecord, PersistenceError> {
        let witness = Arc::clone(&self.phone_witness);
        witnessed(&mut self.phone, &witness, |phone| {
            phone.prepare_application(op, logical, generation, plaintext)
        })
    }

    fn daemon_send(
        &mut self,
        op: [u8; 16],
        logical: [u8; 16],
        generation: u64,
        plaintext: &[u8],
    ) -> Result<crate::persistence::OutboxRecord, PersistenceError> {
        let witness = Arc::clone(&self.daemon_witness);
        witnessed(&mut self.daemon, &witness, |daemon| {
            daemon.prepare_application(op, logical, generation, plaintext)
        })
    }

    fn daemon_receive(
        &mut self,
        op: [u8; 16],
        ciphertext: &[u8],
        logical: [u8; 16],
        generation: u64,
    ) -> Result<crate::persistence::DurablePlaintext, PersistenceError> {
        let witness = Arc::clone(&self.daemon_witness);
        witnessed(&mut self.daemon, &witness, |daemon| {
            daemon.receive_application(op, ciphertext, logical, generation)
        })
    }
}

fn durable_pair(seed: u8) -> DurablePair {
    let context = context(seed);
    let daemon_root = temp_root("daemon");
    let phone_root = temp_root("phone");
    let daemon_keys = TestKeys::enabled();
    let phone_keys = TestKeys::enabled();
    let daemon_witness = TestWitness::new();
    let phone_witness = TestWitness::new();
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
    let (mut daemon, request) = DurableDaemon::create_with_runtime(
        &daemon_root,
        daemon_identity.clone(),
        context.clone(),
        id(100),
        daemon_keys.clone(),
        daemon_witness.trust(),
        RuntimeHooks {
            faults: daemon_faults.clone(),
            clock: clock.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        finish_creation(&daemon, &daemon_witness, &request),
        TypedResult::Empty
    );
    let (mut phone, request) = DurablePhone::create_with_runtime(
        &phone_root,
        phone_identity.clone(),
        context.crypto_session_id,
        id(101),
        phone_keys.clone(),
        phone_witness.trust(),
        RuntimeHooks {
            faults: phone_faults.clone(),
            clock: clock.clone(),
        },
    )
    .unwrap();
    let TypedResult::KeyPackage(package_bytes) = finish_creation(&phone, &phone_witness, &request)
    else {
        panic!("expected key package");
    };
    let package = crate::PhoneKeyPackage {
        bytes: package_bytes.into_boxed_slice(),
        identity: phone_identity.clone(),
    };
    let welcome_bytes: Vec<u8> = witnessed(&mut daemon, &daemon_witness, |daemon| {
        daemon.consume_key_package(id(102), package)
    })
    .unwrap();
    let welcome = PairWelcome {
        bytes: welcome_bytes.into_boxed_slice(),
        context: context.clone(),
        daemon_identity,
        device_identity: phone_identity,
    };
    witnessed(&mut phone, &phone_witness, |phone| {
        phone.join(id(103), welcome, &context)
    })
    .unwrap();
    DurablePair {
        daemon,
        phone,
        context,
        daemon_keys,
        phone_keys,
        daemon_witness,
        phone_witness,
        daemon_faults,
        phone_faults,
        clock,
    }
}

#[test]
fn durable_send_receive_reopens_and_retries_exact_bytes() {
    let mut pair = durable_pair(20);
    let sent = pair.phone_send(id(1), id(2), 7, b"persist me").unwrap();
    let exact = sent.ciphertext.clone();

    pair.phone.store().close().unwrap();
    pair.phone.store().reopen().unwrap();
    // After restart the completed cache is not authority: the duplicate ID is refused until a
    // fresh head (and the exact duplicate certificate) confirms the transition again.
    assert_eq!(
        pair.phone
            .prepare_application(id(1), id(2), 7, b"persist me")
            .unwrap_err(),
        PersistenceError::FreshWitnessRequired
    );
    let retry = pair.phone_send(id(1), id(2), 7, b"persist me").unwrap();
    assert_eq!(retry.ciphertext, exact);

    let received = pair.daemon_receive(id(3), &exact, id(2), 7).unwrap();
    assert_eq!(received.plaintext(), b"persist me");

    pair.daemon.store().close().unwrap();
    pair.daemon.store().reopen().unwrap();
    let recovered = pair.daemon_receive(id(3), &exact, id(2), 7).unwrap();
    assert_eq!(recovered.plaintext(), b"persist me");
}

#[test]
fn outbox_acknowledgement_is_durable_and_idempotent() {
    let mut pair = durable_pair(29);
    let sent = pair.phone_send(id(52), id(53), 2, b"acknowledge").unwrap();
    assert_eq!(sent.retry_state, crate::persistence::RetryState::Pending);
    let witness = Arc::clone(&pair.phone_witness);
    let acknowledged = witnessed(&mut pair.phone, &witness, |phone| {
        phone.acknowledge_outbox(id(54), id(52))
    })
    .unwrap();
    assert_eq!(
        acknowledged.retry_state,
        crate::persistence::RetryState::Acknowledged
    );
    pair.phone.store().close().unwrap();
    pair.phone.store().reopen().unwrap();
    let retry = witnessed(&mut pair.phone, &witness, |phone| {
        phone.acknowledge_outbox(id(54), id(52))
    })
    .unwrap();
    assert_eq!(retry, acknowledged);
    let send_retry = pair.phone_send(id(52), id(53), 2, b"acknowledge").unwrap();
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
    let commit = legacy_update_cycle(&mut pair, 60, 9);
    let metadata = commit.commit.as_ref().unwrap().clone();
    pair.daemon.store().close().unwrap();
    pair.daemon.store().reopen().unwrap();
    pair.phone.store().close().unwrap();
    pair.phone.store().reopen().unwrap();
    assert_eq!(
        pair.daemon.store().outbox(id(63)).unwrap().unwrap().commit,
        Some(metadata)
    );
    let post_commit = pair.phone_send(id(66), id(67), 9, b"new epoch").unwrap();
    assert_eq!(post_commit.epoch, commit.commit.unwrap().target_epoch);
}

/// Legacy proposal, commit, and apply cycle using operation IDs `base..base+5`.
fn legacy_update_cycle(
    pair: &mut DurablePair,
    base: u8,
    generation: u64,
) -> crate::persistence::OutboxRecord {
    let phone_witness = Arc::clone(&pair.phone_witness);
    let daemon_witness = Arc::clone(&pair.daemon_witness);
    let proposal = witnessed(&mut pair.phone, &phone_witness, |phone| {
        phone.prepare_self_update(id(base), id(base + 1), generation)
    })
    .unwrap();
    let _: crate::persistence::AcceptedMessageRecord =
        witnessed(&mut pair.daemon, &daemon_witness, |daemon| {
            daemon.receive_update_proposal(
                id(base + 2),
                &proposal.ciphertext,
                id(base + 1),
                generation,
            )
        })
        .unwrap();
    let commit = witnessed(&mut pair.daemon, &daemon_witness, |daemon| {
        daemon.prepare_commit(id(base + 3), id(base + 4), generation)
    })
    .unwrap();
    let _: crate::persistence::AcceptedMessageRecord =
        witnessed(&mut pair.phone, &phone_witness, |phone| {
            phone.apply_commit(id(base + 5), &commit.ciphertext, id(base + 4), generation)
        })
        .unwrap();
    commit
}

#[test]
fn previous_epoch_window_survives_restart_and_rejects_clock_rollback() {
    let mut pair = durable_pair(31);
    let delayed = pair
        .phone_send(id(80), id(81), 3, b"previous epoch")
        .unwrap();
    legacy_update_cycle(&mut pair, 82, 3);
    pair.daemon.store().close().unwrap();
    pair.daemon.store().reopen().unwrap();
    assert_eq!(
        pair.daemon_receive(id(88), &delayed.ciphertext, id(81), 3)
            .unwrap()
            .plaintext(),
        b"previous epoch"
    );

    let prior = pair.clock.now_ms().unwrap();
    pair.clock.set(prior - 1);
    pair.daemon.store().close().unwrap();
    pair.daemon.store().reopen().unwrap();
    assert_eq!(
        pair.daemon_send(id(89), id(90), 3, b"clock rollback")
            .unwrap_err(),
        PersistenceError::Core(Error::ClockRollback)
    );
}

#[test]
fn previous_epoch_window_expires_from_the_persisted_deadline() {
    let mut pair = durable_pair(32);
    let delayed = pair
        .phone_send(id(90), id(91), 3, b"expired epoch")
        .unwrap();
    legacy_update_cycle(&mut pair, 92, 3);
    pair.clock.advance(5 * 60 * 1000 + 1);
    pair.daemon.store().close().unwrap();
    pair.daemon.store().reopen().unwrap();
    assert_eq!(
        pair.daemon_receive(id(98), &delayed.ciphertext, id(91), 3)
            .unwrap_err(),
        PersistenceError::Core(Error::StaleEpoch)
    );
}

#[test]
fn acknowledged_idempotency_records_are_compacted_beyond_the_retry_horizon() {
    let mut pair = durable_pair(33);
    let first_operation = sequence_id(1, 0);
    let witness = Arc::clone(&pair.phone_witness);
    for index in 0..(crate::persistence::IDEMPOTENCY_RETENTION_GENERATIONS + 8) {
        let operation_id = sequence_id(1, index);
        let logical_id = sequence_id(2, index);
        pair.phone_send(operation_id, logical_id, 3, b"bounded history")
            .unwrap();
        witnessed(&mut pair.phone, &witness, |phone| {
            phone.acknowledge_outbox(sequence_id(3, index), operation_id)
        })
        .unwrap();
    }
    assert!(
        pair.phone
            .store()
            .operation(first_operation)
            .unwrap()
            .is_none()
    );
    pair.phone_send(sequence_id(4, 1), sequence_id(5, 1), 3, b"still usable")
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
            .phone_send(send_id, logical_id, 3, b"bounded accepted history")
            .unwrap();
        pair.daemon_receive(receive_id, &sent.ciphertext, logical_id, 3)
            .unwrap();
        let daemon_witness = Arc::clone(&pair.daemon_witness);
        witnessed(&mut pair.daemon, &daemon_witness, |daemon| {
            daemon.acknowledge_receive(sequence_id(13, index), receive_id)
        })
        .unwrap();
        let phone_witness = Arc::clone(&pair.phone_witness);
        witnessed(&mut pair.phone, &phone_witness, |phone| {
            phone.acknowledge_outbox(sequence_id(14, index), send_id)
        })
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
        .phone_send(
            sequence_id(15, 1),
            sequence_id(16, 1),
            3,
            b"still receiving",
        )
        .unwrap();
    assert_eq!(
        pair.daemon_receive(sequence_id(17, 1), &sent.ciphertext, sequence_id(16, 1), 3)
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
        FaultPoint::BeforeTransitionSealing,
        FaultPoint::AfterTransitionSealingBeforeCommit,
        FaultPoint::BeforeCommit,
    ]
    .into_iter()
    .enumerate()
    {
        let mut pair = durable_pair(40 + index as u8);
        let generation = pair.phone.store().generation().unwrap();
        let keys_before = pair.phone_keys.snapshot();
        pair.phone_faults.arm(point);
        assert_eq!(
            pair.phone_send(id(10), id(11), 1, b"atomic").unwrap_err(),
            PersistenceError::InjectedFault
        );
        // No request was ever sent for the failed attempt: the witness saw only the read.
        assert!(pair.phone.pending_witness().unwrap().is_none());
        assert_eq!(
            pair.phone_keys.snapshot(),
            keys_before,
            "prepared key removed at {point:?}"
        );
        pair.phone.store().close().unwrap();
        pair.phone.store().reopen().unwrap();
        assert_eq!(pair.phone.store().generation().unwrap(), generation);
        let sent = pair.phone_send(id(10), id(11), 1, b"atomic").unwrap();
        assert!(!sent.ciphertext.is_empty());
    }
}

#[test]
fn uncertain_recovery_activates_current_key_before_erasing_obsolete_key() {
    let mut pair = durable_pair(58);
    assert_eq!(pair.phone_keys.activity_counts(), (1, 0));
    let responses = pair.phone_witness.responses();
    pair.phone_faults
        .arm(FaultPoint::DuringCurrentKeyActivation);
    assert_eq!(
        pair.phone_send(id(18), id(19), 1, b"activation order")
            .unwrap_err(),
        PersistenceError::InjectedFault
    );
    // Committed but not activated: the request is not exposed and nothing reached the witness
    // beyond the fresh read.
    assert_eq!(pair.phone_keys.activity_counts(), (1, 1));
    assert_eq!(pair.phone_witness.responses(), responses + 1);

    pair.phone_faults
        .arm(FaultPoint::DuringPreparedKeyReconciliation);
    assert_eq!(
        pair.phone_send(id(18), id(19), 1, b"activation order")
            .unwrap_err(),
        PersistenceError::InjectedFault
    );
    assert_eq!(pair.phone_keys.activity_counts(), (1, 1));

    // Recovery activates the successor, resends the exact request, and only then erases.
    let recovered = pair
        .phone_send(id(18), id(19), 1, b"activation order")
        .unwrap();
    assert!(!recovered.ciphertext.is_empty());
    assert_eq!(pair.phone_keys.activity_counts(), (1, 0));
}

#[test]
fn postcommit_faults_recover_the_committed_exact_result() {
    for (index, point) in [
        FaultPoint::DuringCurrentKeyActivation,
        FaultPoint::AfterDurableCommit,
        FaultPoint::AfterCommitBeforeNetworkSend,
        FaultPoint::BeforeCertificateVerification,
        FaultPoint::AfterCertificateVerificationBeforeErasure,
        FaultPoint::DuringWrappingRecordErasure,
        FaultPoint::AfterErasureBeforeRelease,
    ]
    .into_iter()
    .enumerate()
    {
        let mut pair = durable_pair(60 + index as u8);
        pair.phone_faults.arm(point);
        let first = pair.phone_send(id(20), id(21), 1, b"uncertain");
        let retry = pair.phone_send(id(20), id(21), 1, b"uncertain").unwrap();
        if let Ok(first) = first {
            assert_eq!(first.ciphertext, retry.ciphertext);
        }
        assert_eq!(pair.phone_keys.activity_counts(), (1, 0), "{point:?}");
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
    let sent = pair.phone_send(id(30), id(31), 4, b"one").unwrap();
    // Same operation ID with another canonical input: fail closed and quarantine the endpoint.
    assert_eq!(
        pair.phone_send(id(30), id(31), 4, b"different")
            .unwrap_err(),
        PersistenceError::WitnessOperationConflict
    );
    assert_eq!(
        pair.phone_send(id(33), id(34), 4, b"after conflict")
            .unwrap_err(),
        PersistenceError::Quarantined
    );
    pair.phone.store().close().unwrap();
    pair.phone.store().reopen().unwrap();
    assert_eq!(
        pair.phone_send(id(33), id(34), 4, b"after restart")
            .unwrap_err(),
        PersistenceError::Quarantined
    );

    pair.daemon_faults
        .arm(FaultPoint::DuringReceiverStateWrites);
    assert_eq!(
        pair.daemon_receive(id(32), &sent.ciphertext, id(31), 4)
            .unwrap_err(),
        PersistenceError::InjectedFault
    );
    pair.daemon.store().close().unwrap();
    pair.daemon.store().reopen().unwrap();
    let plaintext = pair
        .daemon_receive(id(32), &sent.ciphertext, id(31), 4)
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
    let sent = pair.phone_send(id(40), id(41), 5, b"ack recovery").unwrap();
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
        pair.daemon_receive(id(42), &sent.ciphertext, id(41), 5)
            .unwrap_err(),
        PersistenceError::InjectedFault
    );
    // The receive committed but nothing was released; recovery resends the exact request.
    assert!(pair.daemon.pending_witness().unwrap().is_some());
    let recovered = pair
        .daemon_receive(id(42), &sent.ciphertext, id(41), 5)
        .unwrap();
    assert_eq!(recovered.plaintext(), b"ack recovery");

    let witness = Arc::clone(&pair.daemon_witness);
    pair.daemon_faults.arm(FaultPoint::AfterAcknowledgementLoss);
    assert_eq!(
        witnessed(&mut pair.daemon, &witness, |daemon| daemon
            .acknowledge_receive(id(43), id(42)))
        .unwrap_err(),
        PersistenceError::InjectedFault
    );
    let acknowledgement = witnessed(&mut pair.daemon, &witness, |daemon| {
        daemon.acknowledge_receive(id(43), id(42))
    })
    .unwrap();
    assert!(acknowledgement.acknowledged);
    assert_eq!(
        pair.daemon_receive(id(42), &sent.ciphertext, id(41), 5)
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
    pair.phone_send(id(50), id(51), 6, marker).unwrap();
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
    pair.phone_send(id(110), id(111), 2, b"authenticated metadata")
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
        .phone_send(id(112), id(113), 2, b"operation manifest")
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
        .phone_send(id(114), id(115), 2, b"accepted manifest")
        .unwrap();
    accepted_pair
        .daemon_receive(id(116), &sent.ciphertext, id(115), 2)
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
            pair.phone_witness.trust(),
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

    // Rollback of the witness behind the confirmed local head is not a local open failure; the
    // fresh unanimous read quarantines the endpoint and freezes every later mutation.
    let mut pair = durable_pair(90);
    let read = pair.daemon.witness_read_request().unwrap();
    pair.daemon_witness.roll_back_all(&read);
    pair.daemon_witness.roll_back_all(&read);
    let certificate = pair.daemon_witness.respond(&read).unwrap();
    assert!(matches!(
        pair.daemon.reconcile_witness(&certificate).unwrap(),
        EndpointReconciliation::Quarantined(_)
    ));
    assert_eq!(
        pair.daemon
            .prepare_application(id(1), id(2), 1, b"frozen")
            .unwrap_err(),
        PersistenceError::Quarantined
    );
    pair.daemon.store().close().unwrap();
    pair.daemon.store().reopen().unwrap();
    assert_eq!(
        pair.daemon_send(id(1), id(2), 1, b"still frozen")
            .unwrap_err(),
        PersistenceError::Quarantined
    );
}

#[test]
fn ready_commit_fault_recovers_without_losing_database_or_external_state() {
    let root = temp_root("ready-marker-crash");
    let pair_context = context(140);
    let operation_id = id(150);
    let keys = TestKeys::enabled();
    let witness = TestWitness::new();
    let faults = OneShotFault::new();
    let clock = ManualClock::new(1_000_000);
    faults.arm(FaultPoint::AfterInitializationReadyCommit);

    let (daemon, request) = DurableDaemon::create_with_runtime(
        &root,
        Identity::daemon(pair_context.account_id, pair_context.installation_id),
        pair_context.clone(),
        operation_id,
        keys.clone(),
        witness.trust(),
        RuntimeHooks {
            faults: faults.clone(),
            clock: clock.clone(),
        },
    )
    .unwrap();
    // The register certificate is verified and the ready lifecycle commits, then the marker
    // removal is interrupted before the creation result is released.
    assert_eq!(
        complete(&daemon, &witness, &request).unwrap_err(),
        PersistenceError::InjectedFault
    );
    drop(daemon);

    let database = database_path(&root, pair_context.crypto_session_id);
    let marker = marker_path(&root, pair_context.crypto_session_id);
    let database_bytes = fs::read(&database).unwrap();
    assert!(!database_bytes.is_empty());
    let key_records = keys.snapshot();
    let witness_head = witness.head(request.request()).unwrap();
    assert_eq!(witness_head.counter, 1);
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
    assert_eq!(witness.head(request.request()).unwrap(), witness_head);
    assert_eq!(keys.destroy_calls(), 0);

    let opened = DurableDaemon::open_with_runtime(
        &root,
        pair_context.crypto_session_id,
        keys.clone(),
        witness.trust(),
        RuntimeHooks { faults, clock },
    )
    .unwrap();
    assert!(!marker.exists());
    assert!(database.is_file());
    assert!(!fs::read(&database).unwrap().is_empty());
    assert_eq!(keys.snapshot(), key_records);
    assert_eq!(witness.head(request.request()).unwrap(), witness_head);
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
    assert_eq!(initialized.epoch, 0);
    assert_eq!(opened.store().rollback_counter().unwrap(), 1);
    // After restart the completed register is confirmed again from a fresh head and the exact
    // duplicate certificate before another mutation is authorized.
    assert_eq!(
        reconcile(&opened, &witness).unwrap(),
        EndpointReconciliation::RecoverAccepted
    );
    let pending = opened.pending_witness().unwrap().unwrap();
    assert_eq!(pending.request(), request.request());
    assert_eq!(
        complete(&opened, &witness, &pending).unwrap(),
        TypedResult::Empty
    );
    assert_eq!(
        reconcile(&opened, &witness).unwrap(),
        EndpointReconciliation::Ready
    );

    opened.store().close().unwrap();
    let reopened = DurableDaemon::open(
        &root,
        pair_context.crypto_session_id,
        keys.clone(),
        witness.trust(),
    )
    .unwrap();
    assert_eq!(
        reopened.store().operation(operation_id).unwrap(),
        Some(exact_operation)
    );
    assert!(database.is_file());
    assert!(!fs::read(&database).unwrap().is_empty());
    assert_eq!(keys.snapshot(), key_records);
    assert_eq!(witness.head(request.request()).unwrap(), witness_head);
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
        pair.phone_witness.trust(),
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
        pair.phone_witness.trust(),
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
    let witness = TestWitness::new();
    let faults = OneShotFault::new();
    faults.arm(FaultPoint::BeforeInitializationReady);
    let (phone, request) = DurablePhone::create_with_runtime(
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
        witness.trust(),
        RuntimeHooks {
            faults,
            clock: ManualClock::new(1_000_000),
        },
    )
    .unwrap();
    // The register certificate is confirmed, then the process dies before `ready` publication.
    // The exact KeyPackage stays withheld: the caller received only the pending request.
    assert_eq!(
        complete(&phone, &witness, &request).unwrap_err(),
        PersistenceError::InjectedFault
    );
    drop(phone);

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

    let opened = DurablePhone::open(&root, session, keys.clone(), witness.trust()).unwrap();
    let outbox = opened.store().outbox(operation_id).unwrap().unwrap();
    let operation = opened.store().operation(operation_id).unwrap().unwrap();
    assert_eq!(operation, CommittedOperation::Envelope(outbox.clone()));
    assert!(!outbox.ciphertext.is_empty());
    assert_eq!(outbox.class, crate::MessageClass::PairActivation);
    assert_eq!(outbox.epoch, 0);
    assert_eq!(opened.store().rollback_counter().unwrap(), 1);
    assert_eq!(opened.store().generation().unwrap(), 1);
    // Recovery re-verifies the exact register and releases the exact KeyPackage bytes.
    assert_eq!(
        reconcile(&opened, &witness).unwrap(),
        EndpointReconciliation::RecoverAccepted
    );
    let pending = opened.pending_witness().unwrap().unwrap();
    assert_eq!(pending.request(), request.request());
    assert_eq!(
        complete(&opened, &witness, &pending).unwrap(),
        TypedResult::KeyPackage(outbox.ciphertext.clone())
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

    let reopened = DurablePhone::open(&root, session, keys, witness.trust()).unwrap();
    assert_eq!(reopened.store().outbox(operation_id).unwrap(), Some(outbox));
    assert_eq!(reopened.store().rollback_counter().unwrap(), 1);
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
    let witness = TestWitness::new();
    let faults = OneShotFault::new();
    faults.arm(FaultPoint::BeforeInitializationReady);
    let (phone, request) = DurablePhone::create_with_runtime(
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
        witness.trust(),
        RuntimeHooks {
            faults,
            clock: ManualClock::new(1_000_000),
        },
    )
    .unwrap();
    assert_eq!(
        complete(&phone, &witness, &request).unwrap_err(),
        PersistenceError::InjectedFault
    );
    drop(phone);

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
        DurablePhone::open(&root, session, keys.clone(), witness.trust()),
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
        pair.phone_witness.trust(),
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
    let witness = TestWitness::new();
    let faults = OneShotFault::new();
    faults.block_at(FaultPoint::BeforeInitializationReady);

    let creator_root = root.clone();
    let creator_keys = keys.clone();
    let creator_witness = Arc::clone(&witness);
    let creator_faults = faults.clone();
    let creator = thread::spawn(move || {
        let (daemon, request) = DurableDaemon::create_with_runtime(
            &creator_root,
            creator_identity,
            pair_context,
            id(152),
            creator_keys,
            creator_witness.trust(),
            RuntimeHooks {
                faults: creator_faults,
                clock: ManualClock::new(1_000_000),
            },
        )?;
        complete(&daemon, &creator_witness, &request)?;
        Ok::<_, PersistenceError>(daemon)
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
    DurableDaemon::open(&root, session, keys, witness.trust()).unwrap();
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
    let witness = TestWitness::new();
    let faults = OneShotFault::new();
    faults.block_at(FaultPoint::AfterInitializationMarkerCreation);

    let creator_root = root.clone();
    let creator_keys = keys.clone();
    let creator_witness = Arc::clone(&witness);
    let creator_faults = faults.clone();
    let creator = thread::spawn(move || {
        let (phone, request) = DurablePhone::create_with_runtime(
            &creator_root,
            creator_identity,
            session,
            id(155),
            creator_keys,
            creator_witness.trust(),
            RuntimeHooks {
                faults: creator_faults,
                clock: ManualClock::new(1_000_000),
            },
        )?;
        complete(&phone, &creator_witness, &request)?;
        Ok::<_, PersistenceError>(phone)
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
    let phone = creator.join().unwrap().unwrap();
    assert!(!marker_path(&root, session).exists());
    assert!(database_path(&root, session).is_file());
    assert_eq!(keys.destroy_calls(), 0);
    phone.store().close().unwrap();
    drop(phone);
    DurablePhone::open(&root, session, keys, witness.trust()).unwrap();
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
    let opener_anchor = pair.phone_witness.trust();
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
            TestWitness::new().trust(),
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
    let session = uuid_v7(83);
    let keys = TestKeys::enabled();
    let store = NativeTransactionalProvider::create(
        &root,
        session,
        keys.clone(),
        TestWitness::new().trust(),
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
            TestWitness::new().trust(),
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
            TestWitness::new().trust(),
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
        FaultPoint::BeforeTransitionSealing,
        FaultPoint::AfterTransitionSealingBeforeCommit,
        FaultPoint::BeforeCommit,
        FaultPoint::DuringCurrentKeyActivation,
        FaultPoint::BeforeCertificateVerification,
        FaultPoint::AfterCertificateVerificationBeforeErasure,
        FaultPoint::AfterErasureBeforeRelease,
        FaultPoint::BeforeInitializationReady,
    ]
    .into_iter()
    .enumerate()
    {
        let root = temp_root("initialization-boundary");
        let context = context(130 + index as u8);
        let keys = TestKeys::enabled();
        let witness = TestWitness::new();
        let faults = OneShotFault::new();
        faults.arm(point);
        let creation = DurableDaemon::create_with_runtime(
            &root,
            Identity::daemon(context.account_id, context.installation_id),
            context.clone(),
            sequence_id(20, index as u64),
            keys.clone(),
            witness.trust(),
            RuntimeHooks {
                faults,
                clock: ManualClock::new(1_000_000),
            },
        );
        let committed = match creation {
            Err(PersistenceError::InjectedFault) => point == FaultPoint::DuringCurrentKeyActivation,
            Ok((daemon, request)) => {
                // The register request exists locally; the barrier is interrupted after it.
                assert_eq!(
                    complete(&daemon, &witness, &request).unwrap_err(),
                    PersistenceError::InjectedFault,
                    "{point:?}"
                );
                drop(daemon);
                true
            }
            Err(other) => panic!("unexpected creation error at {point:?}: {other:?}"),
        };
        if committed {
            // Complete cryptographic state is never discarded; it is recovered as a pending
            // registration and published only after the barrier completes.
            assert_eq!(
                discard_interrupted_creation(&root, context.crypto_session_id, keys.clone())
                    .unwrap_err(),
                PersistenceError::InitializationIncomplete
            );
            assert_eq!(keys.destroy_calls(), 0);
            let opened = DurableDaemon::open(
                &root,
                context.crypto_session_id,
                keys.clone(),
                witness.trust(),
            )
            .unwrap();
            if marker_path(&root, context.crypto_session_id).exists() {
                // Registration was not confirmed locally: the marker stays until it is.
                authorize(&opened, &witness).unwrap();
            }
            assert!(
                !marker_path(&root, context.crypto_session_id).exists(),
                "{point:?}"
            );
            assert_eq!(keys.destroy_calls(), 0);
            assert_eq!(keys.activity_counts(), (1, 0), "{point:?}");
            opened.store().close().unwrap();
        } else {
            assert!(matches!(
                DurableDaemon::open(
                    &root,
                    context.crypto_session_id,
                    keys.clone(),
                    witness.trust(),
                ),
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
    let witness = TestWitness::new();
    let faults = OneShotFault::new();
    faults.arm(FaultPoint::AfterInitializationSchemaCommit);
    assert!(matches!(
        DurableDaemon::create_with_runtime(
            &root,
            Identity::daemon(context.account_id, context.installation_id),
            context.clone(),
            id(120),
            keys.clone(),
            witness.trust(),
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
        DurableDaemon::open(
            &root,
            context.crypto_session_id,
            keys.clone(),
            witness.trust()
        ),
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
fn unavailable_keys_witness_identity_and_symlinks_fail_closed() {
    let mut pair = durable_pair(88);
    let generation = pair.phone.store().generation().unwrap();
    *pair.phone_keys.available.lock().unwrap() = false;
    assert_eq!(
        pair.phone_send(id(118), id(119), 1, b"unavailable key store")
            .unwrap_err(),
        PersistenceError::KeyUnavailable
    );
    assert_eq!(pair.phone.store().generation().unwrap(), generation);
    *pair.phone_keys.available.lock().unwrap() = true;

    // No fresh unanimous head: no mutation authority, no write transaction, no state change.
    pair.phone_witness.set_unavailable(true);
    assert_eq!(
        pair.phone_send(id(120), id(121), 1, b"unavailable witness")
            .unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    assert_eq!(
        pair.phone
            .prepare_application(id(120), id(121), 1, b"no authorization")
            .unwrap_err(),
        PersistenceError::FreshWitnessRequired
    );
    assert_eq!(pair.phone.store().generation().unwrap(), generation);
    pair.phone_witness.set_unavailable(false);

    // A witness outage after local commit leaves the exact request retryable and nothing
    // released; the same bytes are resent once the quorum is reachable again.
    authorize(&pair.phone, &pair.phone_witness).unwrap();
    let WitnessOutcome::Pending(request) = pair
        .phone
        .prepare_application(id(122), id(123), 1, b"outage after commit")
        .unwrap()
    else {
        panic!("expected pending request");
    };
    pair.phone_witness.set_unavailable(true);
    assert_eq!(
        complete(&pair.phone, &pair.phone_witness, &request).unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    assert_eq!(
        pair.phone_send(id(124), id(125), 1, b"blocked")
            .unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    pair.phone_witness.set_unavailable(false);
    let pending = pair.phone.pending_witness().unwrap().unwrap();
    assert_eq!(pending.request(), request.request());
    assert!(matches!(
        complete(&pair.phone, &pair.phone_witness, &pending).unwrap(),
        TypedResult::Envelope(_)
    ));

    let root = temp_root("closed");
    let keys = TestKeys::enabled();
    *keys.available.lock().unwrap() = false;
    assert!(matches!(
        NativeTransactionalProvider::create(
            &root,
            uuid_v7(90),
            keys,
            TestWitness::new().trust(),
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
                uuid_v7(91),
                TestKeys::enabled(),
                TestWitness::new().trust(),
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
    let first_witness = Arc::clone(&pair.phone_witness);
    let first = thread::spawn(move || {
        witnessed(&mut first_phone, &first_witness, |phone| {
            phone.prepare_application(id(70), id(71), 1, b"first")
        })
    });
    pair.phone_faults.wait_until_blocked();

    let (sender, receiver) = mpsc::channel();
    let mut second_phone = pair.phone.clone();
    let second_witness = Arc::clone(&pair.phone_witness);
    let second_handle = thread::spawn(move || {
        sender
            .send(witnessed(&mut second_phone, &second_witness, |phone| {
                phone.prepare_application(id(72), id(73), 1, b"second")
            }))
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
                uuid_v7(120 + index as u8),
                TestKeys::enabled(),
                TestWitness::new().trust(),
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
    witness: Arc<TestWitness>,
    clock: Arc<ManualClock>,
    ids: PairingIds,
}

impl PendingFixture {
    /// Run one witnessed daemon mutation through the full barrier.
    fn run<T>(
        &mut self,
        mutate: impl FnOnce(
            &mut DurablePendingInvitation,
        ) -> Result<WitnessOutcome<T>, PersistenceError>,
    ) -> Result<T, PersistenceError>
    where
        T: TryFrom<TypedResult, Error = PersistenceError>,
    {
        let witness = Arc::clone(&self.witness);
        witnessed(&mut self.endpoint, &witness, mutate)
    }
}

fn pending_fixture(seed: u8) -> PendingFixture {
    let ids = pairing_ids(seed);
    let root = temp_root("pending-invitation");
    let keys = TestKeys::enabled();
    let witness = TestWitness::new();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let clock = ManualClock::new(now_ms);
    let (mut endpoint, request) = DurablePendingInvitation::issue_with_runtime(
        &root,
        Identity::daemon(ids.account, ids.installation),
        ids.session,
        sequence_id(90, u64::from(seed)),
        keys.clone(),
        witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: clock.clone(),
        },
    )
    .unwrap();
    // The invitation is withheld until the counter-1 register certificate completes.
    assert_eq!(
        endpoint.publication().unwrap_err(),
        PersistenceError::InitializationIncomplete
    );
    let TypedResult::Invitation(publication) = finish_creation(&endpoint, &witness, &request)
    else {
        panic!("expected invitation publication");
    };
    assert_eq!(endpoint.publication().unwrap(), publication);
    PendingFixture {
        root,
        endpoint,
        publication,
        keys,
        witness,
        clock,
        ids,
    }
}

struct DeviceFixture {
    root: PathBuf,
    device: DurablePreJoinDevice,
    publication: crate::persistence::PreJoinPublication,
    keys: Arc<TestKeys>,
    witness: Arc<TestWitness>,
}

impl DeviceFixture {
    fn run<T>(
        &mut self,
        mutate: impl FnOnce(&mut DurablePreJoinDevice) -> Result<WitnessOutcome<T>, PersistenceError>,
    ) -> Result<T, PersistenceError>
    where
        T: TryFrom<TypedResult, Error = PersistenceError>,
    {
        let witness = Arc::clone(&self.witness);
        witnessed(&mut self.device, &witness, mutate)
    }
}

fn prepare_prejoin(fixture: &PendingFixture, seed: u8) -> DeviceFixture {
    let root = temp_root("device-prejoin");
    let keys = TestKeys::enabled();
    let witness = TestWitness::new();
    let (mut device, request) = DurablePreJoinDevice::prepare_with_runtime(
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
        witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        device.publication().unwrap_err(),
        PersistenceError::InitializationIncomplete
    );
    let TypedResult::PreJoin(publication) = finish_creation(&device, &witness, &request) else {
        panic!("expected pre-join publication");
    };
    assert_eq!(device.publication().unwrap(), publication);
    DeviceFixture {
        root,
        device,
        publication,
        keys,
        witness,
    }
}

#[test]
fn invitation_is_committed_before_publication_and_recovers_after_ambiguous_return() {
    let ids = pairing_ids(170);
    let root = temp_root("invitation-ambiguous-return");
    let keys = TestKeys::enabled();
    let witness = TestWitness::new();
    let faults = OneShotFault::new();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let clock = ManualClock::new(now_ms);
    faults.arm(FaultPoint::AfterCommitBeforeNetworkSend);
    // The register request is committed and the key activated, then the process dies before the
    // request reaches the caller. Nothing was sent to the witness.
    assert!(matches!(
        DurablePendingInvitation::issue_with_runtime(
            &root,
            Identity::daemon(ids.account, ids.installation),
            ids.session,
            id(171),
            keys.clone(),
            witness.trust(),
            RuntimeHooks {
                faults,
                clock: clock.clone(),
            },
        ),
        Err(PersistenceError::InjectedFault)
    ));
    assert!(marker_path(&root, ids.session).is_file());
    assert_eq!(witness.responses(), 0);

    let mut recovered = DurablePendingInvitation::open_with_runtime(
        &root,
        ids.session,
        keys,
        witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock,
        },
    )
    .unwrap();
    // Opening never creates a successor and never publishes an unregistered invitation.
    assert!(marker_path(&root, ids.session).is_file());
    assert_eq!(
        recovered.publication().unwrap_err(),
        PersistenceError::InitializationIncomplete
    );
    assert_eq!(
        reconcile(&recovered, &witness).unwrap(),
        EndpointReconciliation::ResendPending
    );
    let pending = recovered.pending_witness().unwrap().unwrap();
    assert_eq!(pending.kind(), WitnessRequestKind::Register);
    let TypedResult::Invitation(released) = complete(&recovered, &witness, &pending).unwrap()
    else {
        panic!("expected invitation");
    };
    assert!(!marker_path(&root, ids.session).exists());
    let publication = recovered.publication().unwrap();
    assert_eq!(publication, released);
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
    let witness = TestWitness::new();
    let (device, request) = DurablePreJoinDevice::prepare_with_runtime(
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
        witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock,
        },
    )
    .unwrap();
    // Completing the register barrier samples no further clock value.
    let TypedResult::PreJoin(publication) = finish_creation(&device, &witness, &request) else {
        panic!("expected pre-join publication");
    };
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
    assert!(fixture.endpoint.expire_if_needed().unwrap().is_none());
    let generation = fixture.endpoint.store().generation().unwrap();
    fixture.clock.set(fixture.publication.expires_at_ms());
    // Expiry is a witnessed mutation with its deterministic operation ID. Reads never persist it.
    assert_eq!(
        fixture.endpoint.lifecycle().unwrap(),
        InvitationLifecycle::Issued
    );
    assert_eq!(fixture.endpoint.store().generation().unwrap(), generation);
    assert_eq!(
        fixture.endpoint.expire_if_needed().unwrap_err(),
        PersistenceError::FreshWitnessRequired
    );
    authorize(&fixture.endpoint, &fixture.witness).unwrap();
    let expiry = fixture.endpoint.expire_if_needed().unwrap().unwrap();
    // Nothing is released: typed state is withheld and every other mutation is blocked until
    // the expiry certificate is confirmed.
    assert_eq!(
        fixture.endpoint.lifecycle().unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    assert_eq!(
        fixture.endpoint.mark_revoked(id(175)).unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    assert_eq!(
        fixture.endpoint.cancel(id(175)).unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    // The deterministic expiry operation is byte-identical while pending.
    let again = fixture.endpoint.pending_witness().unwrap().unwrap();
    assert_eq!(again, expiry);
    assert!(fixture.endpoint.pending_outbox().unwrap().is_empty());
    assert_eq!(
        complete(&fixture.endpoint, &fixture.witness, &expiry).unwrap(),
        TypedResult::InvitationLifecycle(InvitationLifecycle::Expired)
    );
    assert_eq!(
        fixture.endpoint.lifecycle().unwrap(),
        InvitationLifecycle::Expired
    );
    assert_eq!(
        fixture.endpoint.store().generation().unwrap(),
        generation + 1
    );
    authorize(&fixture.endpoint, &fixture.witness).unwrap();
    assert!(fixture.endpoint.expire_if_needed().unwrap().is_none());
    fixture.endpoint.store().close().unwrap();
    drop(fixture.endpoint);
    let mut reopened = DurablePendingInvitation::open_with_runtime(
        &fixture.root,
        fixture.ids.session,
        fixture.keys,
        fixture.witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock,
        },
    )
    .unwrap();
    // Restart: the cached completion is withheld until a fresh unanimous head confirms it.
    assert_eq!(
        reopened.lifecycle().unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    authorize(&reopened, &fixture.witness).unwrap();
    assert_eq!(reopened.lifecycle().unwrap(), InvitationLifecycle::Expired);
    assert_eq!(reopened.store().generation().unwrap(), generation + 1);
}

#[test]
fn pending_claim_and_device_prejoin_recover_exact_bytes() {
    let mut fixture = pending_fixture(172);
    let device = prepare_prejoin(&fixture, 172);
    let expected = device.publication.clone();
    let claim = expected.claim().to_vec();
    let pending = fixture
        .run(|endpoint| endpoint.submit_claim(id(173), &claim))
        .unwrap();
    assert!(matches!(pending, ClaimSubmission::Pending { .. }));

    fixture.endpoint.store().close().unwrap();
    drop(fixture.endpoint);
    let mut reopened_daemon = DurablePendingInvitation::open_with_runtime(
        &fixture.root,
        fixture.ids.session,
        fixture.keys,
        fixture.witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    // Restart: the cached completion is withheld until a fresh unanimous head confirms it.
    assert_eq!(
        reopened_daemon.lifecycle().unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    authorize(&reopened_daemon, &fixture.witness).unwrap();
    assert_eq!(
        reopened_daemon.lifecycle().unwrap(),
        InvitationLifecycle::ClaimPending
    );
    assert_eq!(
        witnessed(&mut reopened_daemon, &fixture.witness, |endpoint| endpoint
            .submit_claim(id(174), expected.claim()))
        .unwrap(),
        pending
    );

    device.device.store().close().unwrap();
    let DeviceFixture {
        root: device_root,
        keys: device_keys,
        witness: device_witness,
        ..
    } = device;
    let mut reopened_device = DurablePreJoinDevice::open_with_runtime(
        &device_root,
        fixture.ids.session,
        device_keys,
        device_witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock,
        },
    )
    .unwrap();
    // Restart: the exact KeyPackage is withheld until a fresh unanimous head confirms it.
    assert_eq!(
        reopened_device.publication().unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    authorize(&reopened_device, &device_witness).unwrap();
    assert_eq!(reopened_device.publication().unwrap(), expected);
    assert_eq!(
        reopened_device.lifecycle().unwrap(),
        PreJoinLifecycle::PreJoin
    );
}

#[test]
fn failed_claims_are_idempotent_across_restart_and_fifth_cancels_atomically() {
    let mut fixture = pending_fixture(173);
    let publication = prepare_prejoin(&fixture, 173).publication;
    let mut failed_claims = Vec::new();
    for index in 0..5_u8 {
        let mut bytes = publication.claim().to_vec();
        let last = bytes.len() - 1 - usize::from(index);
        bytes[last] ^= index + 1;
        failed_claims.push(bytes);
    }

    assert_eq!(
        fixture
            .run(|endpoint| endpoint.submit_claim(id(180), &failed_claims[0]))
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
        Arc::clone(&fixture.keys) as Arc<dyn EnvelopeKeyStore>,
        fixture.witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock,
        },
    )
    .unwrap();
    assert_eq!(
        witnessed(&mut endpoint, &fixture.witness, |endpoint| endpoint
            .submit_claim(id(181), &failed_claims[0]))
        .unwrap(),
        ClaimSubmission::Rejected {
            reason: Some(crate::persistence::ClaimFailure::Signature)
        }
    );
    assert_eq!(endpoint.failed_claim_count().unwrap(), 1);
    for (index, bytes) in failed_claims.iter().enumerate().skip(1) {
        let result = witnessed(&mut endpoint, &fixture.witness, |endpoint| {
            endpoint.submit_claim(sequence_id(92, index as u64), bytes)
        })
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
        witnessed(&mut endpoint, &fixture.witness, |endpoint| endpoint
            .submit_claim(id(182), &failed_claims[0]))
        .unwrap(),
        ClaimSubmission::Rejected {
            reason: Some(crate::persistence::ClaimFailure::Signature)
        }
    );
}

#[test]
fn malformed_and_wrong_binding_claims_do_not_count() {
    let mut fixture = pending_fixture(174);
    let publication = prepare_prejoin(&fixture, 174).publication;
    assert_eq!(
        fixture
            .run(|endpoint| endpoint.submit_claim(id(183), b"malformed"))
            .unwrap(),
        ClaimSubmission::Rejected { reason: None }
    );
    let mut wrong_binding = publication.claim().to_vec();
    let account_offset = 2 + 1 + crate::PROFILE_ID.len() + 2;
    wrong_binding[account_offset] ^= 1;
    assert_eq!(
        fixture
            .run(|endpoint| endpoint.submit_claim(id(184), &wrong_binding))
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
        fixture.run(|endpoint| endpoint.cancel(id(185))).unwrap(),
        InvitationLifecycle::Cancelled
    );
    fixture.endpoint.store().close().unwrap();
    drop(fixture.endpoint);
    let mut reopened = DurablePendingInvitation::open_with_runtime(
        &fixture.root,
        fixture.ids.session,
        fixture.keys,
        fixture.witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock,
        },
    )
    .unwrap();
    // Restart: the cached completion is withheld until a fresh unanimous head confirms it.
    assert_eq!(
        reopened.lifecycle().unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    authorize(&reopened, &fixture.witness).unwrap();
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
    authorize(&fixture.endpoint, &fixture.witness).unwrap();
    let request = fixture
        .endpoint
        .replace_record_for_test(id(186), &malformed)
        .unwrap();
    complete(&fixture.endpoint, &fixture.witness, &request).unwrap();
    fixture.endpoint.store().close().unwrap();
    drop(fixture.endpoint);
    assert!(matches!(
        DurablePendingInvitation::open_with_runtime(
            &fixture.root,
            fixture.ids.session,
            fixture.keys,
            fixture.witness.trust(),
            RuntimeHooks {
                faults: Arc::new(NoFaults),
                clock: fixture.clock,
            },
        ),
        Err(PersistenceError::Corrupt)
    ));

    let fixture = pending_fixture(177);
    authorize(&fixture.endpoint, &fixture.witness).unwrap();
    let request = fixture.endpoint.remove_record_for_test(id(187)).unwrap();
    complete(&fixture.endpoint, &fixture.witness, &request).unwrap();
    fixture.endpoint.store().close().unwrap();
    drop(fixture.endpoint);
    assert!(matches!(
        DurablePendingInvitation::open_with_runtime(
            &fixture.root,
            fixture.ids.session,
            fixture.keys,
            fixture.witness.trust(),
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
    let device = prepare_prejoin(&fixture, 178);
    let publication = device.publication.clone();
    let device = device.device;
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

fn confirmed_pairing(seed: u8) -> (PendingFixture, DeviceFixture, [u8; 48], [u8; 16]) {
    let mut fixture = pending_fixture(seed);
    let device = prepare_prejoin(&fixture, seed);
    let publication = device.publication.clone();
    let claim_hash = match fixture
        .run(|endpoint| {
            endpoint.submit_claim(sequence_id(100, u64::from(seed)), publication.claim())
        })
        .unwrap()
    {
        ClaimSubmission::Pending { claim_hash, .. } => claim_hash,
        other => panic!("unexpected claim result: {other:?}"),
    };
    let reservation_id = sequence_id(101, u64::from(seed));
    assert!(matches!(
        fixture
            .run(|endpoint| endpoint.confirm_claim(
                sequence_id(102, u64::from(seed)),
                claim_hash,
                reservation_id,
            ))
            .unwrap(),
        ReservationOutcome::Reserved(_)
    ));
    (fixture, device, claim_hash, reservation_id)
}

#[test]
fn one_reservation_wins_and_expired_reservation_can_be_replaced() {
    let mut fixture = pending_fixture(179);
    let publication = prepare_prejoin(&fixture, 179).publication;
    let claim_hash = match fixture
        .run(|endpoint| endpoint.submit_claim(id(188), publication.claim()))
        .unwrap()
    {
        ClaimSubmission::Pending { claim_hash, .. } => claim_hash,
        other => panic!("unexpected claim result: {other:?}"),
    };
    let mut first = fixture.endpoint.clone();
    let mut second = fixture.endpoint.clone();
    let first_witness = Arc::clone(&fixture.witness);
    let second_witness = Arc::clone(&fixture.witness);
    let first_handle = thread::spawn(move || {
        witnessed_retry(&mut first, &first_witness, |endpoint| {
            endpoint.confirm_claim(id(189), claim_hash, id(190))
        })
    });
    let second_handle = thread::spawn(move || {
        witnessed_retry(&mut second, &second_witness, |endpoint| {
            endpoint.confirm_claim(id(191), claim_hash, id(192))
        })
    });
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
            .run(|endpoint| endpoint.confirm_claim(id(193), claim_hash, id(194)))
            .unwrap(),
        ReservationOutcome::Reserved(_)
    ));
}

#[test]
fn group_welcome_join_and_activation_are_durable_and_exact() {
    let (mut fixture, mut device, claim_hash, reservation_id) = confirmed_pairing(180);
    let welcome = match fixture
        .run(|endpoint| endpoint.create_welcome(id(195), reservation_id))
        .unwrap()
    {
        WelcomeOutcome::Committed(welcome) => welcome,
        other => panic!("unexpected Welcome result: {other:?}"),
    };
    assert_ne!(welcome.group_id(), [0; 32]);
    let duplicate = fixture.endpoint.recover_welcome(claim_hash).unwrap();
    assert_eq!(duplicate, WelcomeOutcome::Duplicate(welcome.clone()));

    assert_eq!(
        device.run(|device| device.join(id(196), &welcome)).unwrap(),
        PreJoinLifecycle::Joined
    );
    device.device.store().close().unwrap();
    device.device = DurablePreJoinDevice::open_with_runtime(
        &device.root,
        fixture.ids.session,
        Arc::clone(&device.keys) as Arc<dyn EnvelopeKeyStore>,
        device.witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    // Restart: the cached completion is withheld until a fresh unanimous head confirms it.
    assert_eq!(
        device.device.lifecycle().unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    authorize(&device.device, &device.witness).unwrap();
    assert_eq!(device.device.lifecycle().unwrap(), PreJoinLifecycle::Joined);

    let activation = match device
        .run(|device| device.prepare_activation(id(197), id(198)))
        .unwrap()
    {
        ActivationOutcome::Prepared(record) => record,
        other => panic!("unexpected activation result: {other:?}"),
    };
    let retry = match device
        .run(|device| device.prepare_activation(id(197), id(198)))
        .unwrap()
    {
        ActivationOutcome::Prepared(record) => record,
        other => panic!("unexpected activation retry: {other:?}"),
    };
    assert_eq!(retry.ciphertext, activation.ciphertext);
    let acceptance = match fixture
        .run(|endpoint| endpoint.accept_activation(id(199), id(198), &activation.ciphertext))
        .unwrap()
    {
        ActivationOutcome::Activated(acceptance) => acceptance,
        other => panic!("unexpected activation acceptance: {other:?}"),
    };
    assert_eq!(
        fixture
            .run(|endpoint| endpoint.accept_activation(id(200), id(198), &activation.ciphertext))
            .unwrap(),
        ActivationOutcome::Duplicate(acceptance.clone())
    );
    assert_eq!(
        device
            .run(|device| device.acknowledge_activation(id(201), &acceptance))
            .unwrap(),
        PairLifecycle::Active
    );
    assert_eq!(
        fixture.endpoint.recover_welcome(claim_hash).unwrap(),
        WelcomeOutcome::Consumed
    );
}

#[test]
fn group_creation_precommit_fault_retries_and_postcommit_fault_recovers_exact_welcome() {
    let (precommit, _, _, reservation_id) = confirmed_pairing(181);
    // The fixture uses NoFaults. Reopen with the same protected state and an injected fault.
    precommit.endpoint.store().close().unwrap();
    drop(precommit.endpoint);
    let faults = OneShotFault::new();
    faults.arm(FaultPoint::BeforeCommit);
    let mut endpoint = DurablePendingInvitation::open_with_runtime(
        &precommit.root,
        precommit.ids.session,
        precommit.keys.clone(),
        precommit.witness.trust(),
        RuntimeHooks {
            faults: faults.clone(),
            clock: precommit.clock.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        witnessed(&mut endpoint, &precommit.witness, |endpoint| endpoint
            .create_welcome(id(201), reservation_id))
        .unwrap_err(),
        PersistenceError::InjectedFault
    );
    endpoint.store().close().unwrap();
    drop(endpoint);
    let mut endpoint = DurablePendingInvitation::open_with_runtime(
        &precommit.root,
        precommit.ids.session,
        precommit.keys,
        precommit.witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: precommit.clock,
        },
    )
    .unwrap();
    assert!(matches!(
        witnessed(&mut endpoint, &precommit.witness, |endpoint| endpoint
            .create_welcome(id(201), reservation_id))
        .unwrap(),
        WelcomeOutcome::Committed(_)
    ));

    let (postcommit, _, _, reservation_id) = confirmed_pairing(182);
    postcommit.endpoint.store().close().unwrap();
    drop(postcommit.endpoint);
    let faults = OneShotFault::new();
    faults.arm(FaultPoint::AfterCommitBeforeNetworkSend);
    let mut endpoint = DurablePendingInvitation::open_with_runtime(
        &postcommit.root,
        postcommit.ids.session,
        postcommit.keys,
        postcommit.witness.trust(),
        RuntimeHooks {
            faults,
            clock: postcommit.clock,
        },
    )
    .unwrap();
    // Committed and activated, but the request never reached the caller: the exact Welcome
    // stays sealed until the exact request is resent and confirmed.
    assert_eq!(
        witnessed(&mut endpoint, &postcommit.witness, |endpoint| endpoint
            .create_welcome(id(202), reservation_id))
        .unwrap_err(),
        PersistenceError::InjectedFault
    );
    assert_eq!(
        endpoint.recover_welcome([0; 48]).unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    let recovered = witnessed(&mut endpoint, &postcommit.witness, |endpoint| {
        endpoint.create_welcome(id(202), reservation_id)
    })
    .unwrap();
    assert!(matches!(recovered, WelcomeOutcome::Committed(_)));
    let WelcomeOutcome::Committed(welcome) = recovered else {
        unreachable!()
    };
    // A later operation ID for the consumed reservation is a read-only duplicate.
    assert_eq!(
        witnessed(&mut endpoint, &postcommit.witness, |endpoint| endpoint
            .create_welcome(id(203), reservation_id))
        .unwrap(),
        WelcomeOutcome::Duplicate(welcome)
    );
}

#[test]
fn conflicting_claim_cannot_replace_confirmed_or_consumed_pairing() {
    let (mut fixture, device, claim_hash, reservation_id) = confirmed_pairing(183);
    let mut conflict = device.publication.claim().to_vec();
    let last = conflict.len() - 1;
    conflict[last] ^= 1;
    assert_eq!(
        fixture
            .run(|endpoint| endpoint.submit_claim(id(203), &conflict))
            .unwrap(),
        ClaimSubmission::Conflict
    );
    let welcome = fixture
        .run(|endpoint| endpoint.create_welcome(id(204), reservation_id))
        .unwrap();
    assert!(matches!(welcome, WelcomeOutcome::Committed(_)));
    assert_eq!(
        fixture
            .run(|endpoint| endpoint.submit_claim(id(205), &conflict))
            .unwrap(),
        ClaimSubmission::Conflict
    );
    assert!(matches!(
        fixture.endpoint.recover_welcome(claim_hash).unwrap(),
        WelcomeOutcome::Duplicate(_)
    ));
}

fn activated_pair(seed: u8) -> (PendingFixture, DeviceFixture) {
    let (mut fixture, mut device, _, reservation_id) = confirmed_pairing(seed);
    let welcome = match fixture
        .run(|endpoint| endpoint.create_welcome(sequence_id(110, u64::from(seed)), reservation_id))
        .unwrap()
    {
        WelcomeOutcome::Committed(welcome) => welcome,
        other => panic!("unexpected Welcome result: {other:?}"),
    };
    device
        .run(|device| device.join(sequence_id(111, u64::from(seed)), &welcome))
        .unwrap();
    let activation = match device
        .run(|device| {
            device.prepare_activation(
                sequence_id(112, u64::from(seed)),
                sequence_id(113, u64::from(seed)),
            )
        })
        .unwrap()
    {
        ActivationOutcome::Prepared(record) => record,
        other => panic!("unexpected activation result: {other:?}"),
    };
    let acceptance = match fixture
        .run(|endpoint| {
            endpoint.accept_activation(
                sequence_id(114, u64::from(seed)),
                sequence_id(113, u64::from(seed)),
                &activation.ciphertext,
            )
        })
        .unwrap()
    {
        ActivationOutcome::Activated(acceptance) => acceptance,
        other => panic!("unexpected activation acceptance: {other:?}"),
    };
    device
        .run(|device| device.acknowledge_activation(sequence_id(115, u64::from(seed)), &acceptance))
        .unwrap();
    (fixture, device)
}

#[test]
fn replacement_commit_and_epoch_ready_complete_in_order_across_restart() {
    let (mut fixture, mut device) = activated_pair(184);
    let proposal = device
        .run(|device| device.prepare_replacement(id(210), id(211), 7))
        .unwrap();
    assert_eq!(
        device.device.pair_lifecycle().unwrap(),
        Some(PairLifecycle::ReplacementProposed)
    );
    fixture
        .run(|endpoint| {
            endpoint.receive_replacement_proposal(id(212), &proposal.ciphertext, id(211), 7)
        })
        .unwrap();
    let commit = fixture
        .run(|endpoint| endpoint.create_update_commit(id(213), id(214), 7))
        .unwrap();
    assert_eq!(
        fixture.endpoint.pair_lifecycle().unwrap(),
        Some(PairLifecycle::WaitingForEpochReady)
    );
    assert!(
        fixture
            .run(|endpoint| endpoint.prepare_application(id(209), id(208), 7, b"daemon barrier"))
            .is_err()
    );
    // Received commit application and epoch-ready creation are two witnessed operations, each
    // performing exactly one OpenMLS transition.
    let applied = device
        .run(|device| device.apply_update_commit(id(215), &commit, id(214), 7))
        .unwrap();
    assert_eq!(Some(&applied), commit.commit.as_ref());
    assert_eq!(
        device.device.pair_lifecycle().unwrap(),
        Some(PairLifecycle::WaitingForEpochReady)
    );
    let ready = device
        .run(|device| device.prepare_epoch_ready(id(225), id(216), 7, &applied))
        .unwrap();
    assert_eq!(ready.class, crate::MessageClass::EpochReady);
    // A second epoch-ready under another operation ID is refused; the exact retry is returned.
    assert_eq!(
        device
            .run(|device| device.prepare_epoch_ready(id(226), id(216), 7, &applied))
            .unwrap_err(),
        PersistenceError::Conflict
    );
    assert_eq!(
        device
            .run(|device| device.prepare_epoch_ready(id(225), id(216), 7, &applied))
            .unwrap()
            .ciphertext,
        ready.ciphertext
    );
    assert!(
        device
            .run(|device| device.prepare_application(
                id(218),
                id(219),
                7,
                b"blocked before acknowledgement"
            ))
            .is_err()
    );
    assert!(
        device
            .run(|device| device.receive_application(id(207), &[], id(206), 7))
            .is_err()
    );
    let acceptance = fixture
        .run(|endpoint| endpoint.accept_epoch_ready(id(217), id(216), 7, &ready.ciphertext))
        .unwrap();
    assert_eq!(
        device
            .run(|device| device.acknowledge_epoch_ready(id(218), &acceptance))
            .unwrap(),
        PairLifecycle::Active
    );
    assert!(
        device
            .run(|device| device.prepare_application(
                id(219),
                id(220),
                7,
                b"enabled after acknowledgement"
            ))
            .is_ok()
    );

    fixture.endpoint.store().close().unwrap();
    device.device.store().close().unwrap();
    drop(fixture.endpoint);
    let daemon = DurablePendingInvitation::open_with_runtime(
        &fixture.root,
        fixture.ids.session,
        fixture.keys,
        fixture.witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    let phone = DurablePreJoinDevice::open_with_runtime(
        &device.root,
        fixture.ids.session,
        Arc::clone(&device.keys) as Arc<dyn EnvelopeKeyStore>,
        device.witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock,
        },
    )
    .unwrap();
    // Restart: the cached completion is withheld until a fresh unanimous head confirms it.
    assert_eq!(
        daemon.pair_lifecycle().unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    authorize(&daemon, &fixture.witness).unwrap();
    // Restart: the cached completion is withheld until a fresh unanimous head confirms it.
    assert_eq!(
        phone.pair_lifecycle().unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    authorize(&phone, &device.witness).unwrap();
    assert_eq!(
        daemon.pair_lifecycle().unwrap(),
        Some(PairLifecycle::Active)
    );
    assert_eq!(phone.pair_lifecycle().unwrap(), Some(PairLifecycle::Active));
}

#[test]
fn daemon_only_removal_precedes_device_terminal_state() {
    let (mut fixture, mut device) = activated_pair(185);
    let removal = match fixture
        .run(|endpoint| endpoint.revoke_device(id(220), id(221), 8))
        .unwrap()
    {
        RemovalOutcome::Commit(record) => record,
        other => panic!("unexpected removal result: {other:?}"),
    };
    assert_eq!(
        fixture.endpoint.pair_lifecycle().unwrap(),
        Some(PairLifecycle::Revoked)
    );
    assert_eq!(
        device
            .run(|device| device.apply_removal(id(222), &removal, id(221), 8))
            .unwrap(),
        RemovalOutcome::Removed
    );
    assert_eq!(
        device.device.pair_lifecycle().unwrap(),
        Some(PairLifecycle::Removed)
    );
    assert!(
        device
            .run(|device| device.prepare_replacement(id(223), id(224), 8))
            .is_err()
    );
}

#[test]
fn reset_requires_fresh_device_session_and_group_identifiers() {
    let (mut fixture, mut device) = activated_pair(186);
    let requirement = device.run(|device| device.reset(id(230))).unwrap();
    assert_eq!(
        device.device.pair_lifecycle().unwrap(),
        Some(PairLifecycle::Reset)
    );
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
    assert!(fixture.run(|endpoint| endpoint.reset(id(231))).is_ok());
    assert_eq!(
        fixture.endpoint.pair_lifecycle().unwrap(),
        Some(PairLifecycle::Reset)
    );
}

#[test]
fn accepted_claim_retries_recover_reservation_welcome_and_expiry_state() {
    let (mut fixture, mut device, claim_hash, reservation_id) = confirmed_pairing(187);
    let publication = device.publication.clone();
    fixture.endpoint.close().unwrap();
    fixture.endpoint = DurablePendingInvitation::open_with_runtime(
        &fixture.root,
        fixture.ids.session,
        fixture.keys.clone(),
        fixture.witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    // Restart: the cached completion is withheld until a fresh unanimous head confirms it.
    assert_eq!(
        fixture.endpoint.lifecycle().unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    authorize(&fixture.endpoint, &fixture.witness).unwrap();
    assert_eq!(
        fixture.endpoint.lifecycle().unwrap(),
        InvitationLifecycle::Confirmed
    );
    assert!(matches!(
        fixture
            .run(|endpoint| endpoint.submit_claim(id(232), publication.claim()))
            .unwrap(),
        ClaimSubmission::Confirmed(_)
    ));
    let welcome = match fixture
        .run(|endpoint| endpoint.create_welcome(id(233), reservation_id))
        .unwrap()
    {
        WelcomeOutcome::Committed(welcome) => welcome,
        other => panic!("unexpected Welcome result: {other:?}"),
    };
    assert_eq!(
        fixture
            .run(|endpoint| endpoint.submit_claim(id(234), publication.claim()))
            .unwrap(),
        ClaimSubmission::Accepted(welcome.clone())
    );
    device.run(|device| device.join(id(235), &welcome)).unwrap();
    let activation = match device
        .run(|device| device.prepare_activation(id(236), id(237)))
        .unwrap()
    {
        ActivationOutcome::Prepared(record) => record,
        other => panic!("unexpected activation result: {other:?}"),
    };
    fixture.clock.set(welcome.expires_at_ms());
    assert_eq!(
        fixture
            .run(|endpoint| endpoint.submit_claim(id(238), publication.claim()))
            .unwrap(),
        ClaimSubmission::Expired
    );
    // The same operation ID returns the exact committed result; a new operation observes expiry.
    assert_eq!(
        fixture
            .run(|endpoint| endpoint.create_welcome(id(233), reservation_id))
            .unwrap(),
        WelcomeOutcome::Committed(welcome.clone())
    );
    assert_eq!(
        fixture
            .run(|endpoint| endpoint.create_welcome(id(250), reservation_id))
            .unwrap(),
        WelcomeOutcome::Expired
    );
    assert_eq!(
        fixture
            .run(|endpoint| endpoint.accept_activation(id(239), id(237), activation.ciphertext()))
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
        fixture.witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock,
        },
    )
    .unwrap();
    // Restart: even a Welcome is withheld until a fresh unanimous head confirms the snapshot.
    assert_eq!(
        reopened.recover_welcome(claim_hash).unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    authorize(&reopened, &fixture.witness).unwrap();
    assert_eq!(
        reopened.recover_welcome(claim_hash).unwrap(),
        WelcomeOutcome::Expired
    );
}

#[test]
fn safe_facade_allows_active_messages_and_blocks_after_reset() {
    let (mut fixture, mut device) = activated_pair(188);
    let sent = device
        .run(|device| device.prepare_application(id(240), id(241), 9, b"facade message"))
        .unwrap();
    assert_eq!(
        fixture
            .run(|endpoint| endpoint.receive_application(id(242), &sent.ciphertext, id(241), 9))
            .unwrap()
            .plaintext(),
        b"facade message"
    );
    device.run(|device| device.reset(id(243))).unwrap();
    assert_eq!(
        device
            .run(|device| device.prepare_application(id(244), id(245), 9, b"blocked"))
            .unwrap_err(),
        PersistenceError::Conflict
    );
}

#[test]
fn welcome_remains_joinable_after_invitation_expiry_until_its_own_deadline() {
    let mut fixture = pending_fixture(189);
    let device = prepare_prejoin(&fixture, 189);
    let publication = device.publication.clone();
    let claim_hash = match fixture
        .run(|endpoint| endpoint.submit_claim(id(10), publication.claim()))
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
        .run(|endpoint| endpoint.confirm_claim(id(12), claim_hash, reservation_id))
        .unwrap();
    let welcome = match fixture
        .run(|endpoint| endpoint.create_welcome(id(13), reservation_id))
        .unwrap()
    {
        WelcomeOutcome::Committed(welcome) => welcome,
        other => panic!("unexpected Welcome result: {other:?}"),
    };
    device.device.store().close().unwrap();
    let DeviceFixture {
        root: device_root,
        keys: device_keys,
        witness: device_witness,
        ..
    } = device;
    fixture.clock.set(fixture.publication.expires_at_ms() + 1);
    assert!(fixture.clock.0.load(Ordering::SeqCst) < welcome.expires_at_ms());
    let mut device = DurablePreJoinDevice::open_with_runtime(
        &device_root,
        fixture.ids.session,
        device_keys,
        device_witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    // Restart: the cached completion is withheld until a fresh unanimous head confirms it.
    assert_eq!(
        device.lifecycle().unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    authorize(&device, &device_witness).unwrap();
    // Opening never creates a successor: the due expiry is the next witnessed mutation.
    assert_eq!(device.lifecycle().unwrap(), PreJoinLifecycle::PreJoin);
    authorize(&device, &device_witness).unwrap();
    let expiry = device.expire_if_needed().unwrap().unwrap();
    assert_eq!(
        complete(&device, &device_witness, &expiry).unwrap(),
        TypedResult::PreJoinLifecycle(PreJoinLifecycle::Expired)
    );
    assert_eq!(device.lifecycle().unwrap(), PreJoinLifecycle::Expired);
    assert_eq!(
        witnessed(&mut device, &device_witness, |device| device
            .join(id(14), &welcome))
        .unwrap(),
        PreJoinLifecycle::Joined
    );
    device.store().close().unwrap();
    drop(device);
    fs::remove_dir_all(device_root).unwrap();
}

#[test]
fn reservation_release_retry_returns_exact_result_without_releasing_replacement() {
    let (mut fixture, _, claim_hash, first_reservation) = confirmed_pairing(190);
    assert_eq!(
        fixture
            .run(|endpoint| endpoint.release_reservation(id(20), first_reservation))
            .unwrap(),
        ReservationOutcome::Unavailable
    );
    let replacement = id(21);
    assert!(matches!(
        fixture
            .run(|endpoint| endpoint.confirm_claim(id(22), claim_hash, replacement))
            .unwrap(),
        ReservationOutcome::Reserved(_)
    ));
    assert_eq!(
        fixture
            .run(|endpoint| endpoint.release_reservation(id(20), first_reservation))
            .unwrap(),
        ReservationOutcome::Unavailable
    );
    assert!(matches!(
        fixture
            .run(|endpoint| endpoint.create_welcome(id(23), replacement))
            .unwrap(),
        WelcomeOutcome::Committed(_)
    ));
}

#[test]
fn revocation_preempts_a_pending_device_replacement() {
    let (mut fixture, mut device) = activated_pair(191);
    let proposal = device
        .run(|device| device.prepare_replacement(id(30), id(31), 4))
        .unwrap();
    fixture
        .run(|endpoint| {
            endpoint.receive_replacement_proposal(id(32), proposal.ciphertext(), id(31), 4)
        })
        .unwrap();
    let removal = match fixture
        .run(|endpoint| endpoint.revoke_device(id(33), id(34), 4))
        .unwrap()
    {
        RemovalOutcome::Commit(record) => record,
        other => panic!("unexpected removal result: {other:?}"),
    };
    assert_eq!(
        device
            .run(|device| device.apply_removal(id(35), &removal, id(34), 4))
            .unwrap(),
        RemovalOutcome::Removed
    );
}

#[test]
fn prejoin_reset_preserves_material_and_repair_enforces_fresh_inputs() {
    let fixture = pending_fixture(192);
    let mut device = prepare_prejoin(&fixture, 192);
    let publication = device.publication.clone();
    let requirement = device.run(|device| device.reset(id(40))).unwrap();
    assert_eq!(requirement.group_id(), None);
    assert_eq!(
        requirement.key_package_hash(),
        crate::pairing::sha384(publication.key_package()).unwrap()
    );

    let fresh_ids = pairing_ids(193);
    let daemon_root = temp_root("repair-daemon");
    let daemon_keys = TestKeys::enabled();
    let daemon_witness = TestWitness::new();
    let (daemon, request) = DurablePendingInvitation::issue_with_runtime(
        &daemon_root,
        Identity::daemon(fixture.ids.account, fixture.ids.installation),
        fresh_ids.session,
        id(41),
        daemon_keys,
        daemon_witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    let TypedResult::Invitation(invitation) = finish_creation(&daemon, &daemon_witness, &request)
    else {
        panic!("expected invitation");
    };
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
            TestWitness::new().trust(),
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
    let repair_witness = TestWitness::new();
    let (repaired, request) = DurablePreJoinDevice::prepare_repair_with_runtime(
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
        repair_witness.trust(),
        (
            RuntimeHooks {
                faults: Arc::new(NoFaults),
                clock: fixture.clock,
            },
            &requirement,
        ),
    )
    .unwrap();
    let TypedResult::PreJoin(repaired) = finish_creation(&repaired, &repair_witness, &request)
    else {
        panic!("expected pre-join publication");
    };
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
    let publication = prepare_prejoin(&pending, 195).publication;
    pending
        .run(|endpoint| endpoint.submit_claim(id(50), publication.claim()))
        .unwrap();
    assert!(pending.endpoint.rejects_shape_mutation_for_test(1).unwrap());

    let (confirmed, _, _, _) = confirmed_pairing(196);
    assert!(
        confirmed
            .endpoint
            .rejects_shape_mutation_for_test(2)
            .unwrap()
    );

    let (mut consumed, _, _, reservation) = confirmed_pairing(197);
    consumed
        .run(|endpoint| endpoint.create_welcome(id(51), reservation))
        .unwrap();
    assert!(
        consumed
            .endpoint
            .rejects_shape_mutation_for_test(4)
            .unwrap()
    );

    let (active, _) = activated_pair(198);
    assert!(active.endpoint.rejects_shape_mutation_for_test(5).unwrap());

    let mut cancelled = pending_fixture(199);
    cancelled.run(|endpoint| endpoint.cancel(id(52))).unwrap();
    assert!(
        cancelled
            .endpoint
            .rejects_shape_mutation_for_test(3)
            .unwrap()
    );

    let mut expired = pending_fixture(200);
    expired.clock.set(expired.publication.expires_at_ms());
    authorize(&expired.endpoint, &expired.witness).unwrap();
    let expiry = expired.endpoint.expire_if_needed().unwrap().unwrap();
    complete(&expired.endpoint, &expired.witness, &expiry).unwrap();
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
        let mut device = prepare_prejoin(&fixture, seed);
        fixture
            .clock
            .set(fixture.publication.expires_at_ms() + delay);
        // Expiry first observed long after the deadline records the actual observation time.
        authorize(&device.device, &device.witness).unwrap();
        let expiry = device.device.expire_if_needed().unwrap().unwrap();
        assert_eq!(
            complete(&device.device, &device.witness, &expiry).unwrap(),
            TypedResult::PreJoinLifecycle(PreJoinLifecycle::Expired)
        );
        assert_eq!(
            device.device.lifecycle().unwrap(),
            PreJoinLifecycle::Expired
        );
        assert_eq!(
            device.device.last_now_ms_for_test().unwrap(),
            fixture.publication.expires_at_ms() + delay
        );
        device.device.store().close().unwrap();
        let mut reopened = DurablePreJoinDevice::open_with_runtime(
            &device.root,
            fixture.ids.session,
            Arc::clone(&device.keys) as Arc<dyn EnvelopeKeyStore>,
            device.witness.trust(),
            RuntimeHooks {
                faults: Arc::new(NoFaults),
                clock: fixture.clock,
            },
        )
        .unwrap();
        // Restart: the cached completion is withheld until a fresh unanimous head confirms it.
        assert_eq!(
            reopened.lifecycle().unwrap_err(),
            PersistenceError::WitnessUnavailable
        );
        authorize(&reopened, &device.witness).unwrap();
        assert_eq!(reopened.lifecycle().unwrap(), PreJoinLifecycle::Expired);
    }
}

fn joined_pair(
    seed: u8,
) -> (
    PendingFixture,
    DeviceFixture,
    crate::persistence::WelcomePublication,
) {
    let (mut fixture, mut device, _, reservation_id) = confirmed_pairing(seed);
    let welcome = match fixture
        .run(|endpoint| endpoint.create_welcome(sequence_id(120, u64::from(seed)), reservation_id))
        .unwrap()
    {
        WelcomeOutcome::Committed(welcome) => welcome,
        other => panic!("unexpected Welcome result: {other:?}"),
    };
    device
        .run(|device| device.join(sequence_id(121, u64::from(seed)), &welcome))
        .unwrap();
    (fixture, device, welcome)
}

#[test]
fn activation_preparation_rejects_at_and_after_welcome_expiry() {
    for (seed, offset) in [(203, 0), (204, 1)] {
        let (fixture, mut device, welcome) = joined_pair(seed);
        fixture.clock.set(welcome.expires_at_ms() + offset);
        assert_eq!(
            device.run(|device| device.prepare_activation(sequence_id(122, u64::from(seed)), id(seed)))
                .unwrap(),
            ActivationOutcome::Rejected
        );
        assert_eq!(device.device.lifecycle().unwrap(), PreJoinLifecycle::Joined);
        assert_eq!(
            device.device.pair_lifecycle().unwrap(),
            Some(PairLifecycle::AwaitingActivation)
        );
    }
}

#[test]
fn pending_activation_survives_restart_and_opens_only_after_daemon_acceptance() {
    let (mut fixture, mut device, welcome) = joined_pair(205);
    fixture.clock.set(welcome.expires_at_ms() - 1);
    let activation = match device
        .run(|device| device.prepare_activation(id(60), id(61)))
        .unwrap()
    {
        ActivationOutcome::Prepared(record) => record,
        other => panic!("unexpected activation result: {other:?}"),
    };
    assert_eq!(device.device.lifecycle().unwrap(), PreJoinLifecycle::Joined);
    assert_eq!(
        device.device.pair_lifecycle().unwrap(),
        Some(PairLifecycle::AwaitingActivation)
    );
    assert!(
        device
            .run(|device| device.prepare_application(id(62), id(63), 1, b"blocked"))
            .is_err()
    );
    assert!(
        device
            .run(|device| device.receive_application(id(64), &[], id(65), 1))
            .is_err()
    );

    device.device.store().close().unwrap();
    device.device = DurablePreJoinDevice::open_with_runtime(
        &device.root,
        fixture.ids.session,
        Arc::clone(&device.keys) as Arc<dyn EnvelopeKeyStore>,
        device.witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: fixture.clock.clone(),
        },
    )
    .unwrap();
    // Restart: the cached completion is withheld until a fresh unanimous head confirms it.
    assert_eq!(
        device.device.lifecycle().unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    authorize(&device.device, &device.witness).unwrap();
    assert_eq!(device.device.lifecycle().unwrap(), PreJoinLifecycle::Joined);
    let retry = match device
        .run(|device| device.prepare_activation(id(60), id(61)))
        .unwrap()
    {
        ActivationOutcome::Prepared(record) => record,
        other => panic!("unexpected activation retry: {other:?}"),
    };
    assert_eq!(retry.ciphertext(), activation.ciphertext());
    let acceptance = match fixture
        .run(|endpoint| endpoint.accept_activation(id(66), id(61), activation.ciphertext()))
        .unwrap()
    {
        ActivationOutcome::Activated(acceptance) => acceptance,
        other => panic!("unexpected daemon activation result: {other:?}"),
    };
    assert_eq!(
        device
            .run(|device| device.acknowledge_activation(id(67), &acceptance))
            .unwrap(),
        PairLifecycle::Active
    );
    assert!(
        device
            .run(|device| device.prepare_application(id(68), id(69), 1, b"enabled"))
            .is_ok()
    );
}

#[test]
fn delayed_activation_rejection_never_opens_the_device() {
    let (mut fixture, mut device, welcome) = joined_pair(206);
    fixture.clock.set(welcome.expires_at_ms() - 1);
    let activation = match device
        .run(|device| device.prepare_activation(id(70), id(71)))
        .unwrap()
    {
        ActivationOutcome::Prepared(record) => record,
        other => panic!("unexpected activation result: {other:?}"),
    };
    fixture.clock.set(welcome.expires_at_ms());
    assert_eq!(
        fixture
            .run(|endpoint| endpoint.accept_activation(id(72), id(71), activation.ciphertext()))
            .unwrap(),
        ActivationOutcome::Rejected
    );
    assert_eq!(device.device.lifecycle().unwrap(), PreJoinLifecycle::Joined);
    assert_eq!(
        device.device.pair_lifecycle().unwrap(),
        Some(PairLifecycle::AwaitingActivation)
    );
    assert!(
        device
            .run(|device| device.prepare_application(id(73), id(74), 1, b"still blocked"))
            .is_err()
    );
}

#[test]
fn version_one_and_unknown_newer_stores_are_rejected_without_migration_or_recreation() {
    const META: TableDefinition<u8, &[u8]> = TableDefinition::new("metadata_v1");
    const META_SCHEMA: u8 = 1;

    for version in [1_u16, crate::persistence::STORAGE_SCHEMA_VERSION + 1] {
        let pair = durable_pair(210_u8.wrapping_add(version as u8));
        pair.phone.store().close().unwrap();
        let path = pair.phone.store().path().to_path_buf();
        let session = pair.phone.store().crypto_session_id();
        let root = path.parent().unwrap().to_path_buf();
        let key_snapshot = pair.phone_keys.snapshot();
        let database = Database::open(&path).unwrap();
        let mut write = database.begin_write().unwrap();
        write.set_durability(Durability::Immediate).unwrap();
        write.set_two_phase_commit(true);
        write
            .open_table(META)
            .unwrap()
            .insert(META_SCHEMA, version.to_be_bytes().as_slice())
            .unwrap();
        write.commit().unwrap();
        drop(database);
        let original_length = fs::metadata(&path).unwrap().len();

        assert!(matches!(
            NativeTransactionalProvider::open(
                &root,
                session,
                pair.phone_keys.clone(),
                pair.phone_witness.trust(),
                Arc::new(NoFaults),
                Arc::new(SystemClock),
            ),
            Err(PersistenceError::UnsupportedSchema)
        ));
        assert!(path.is_file());
        assert_eq!(fs::metadata(&path).unwrap().len(), original_length);
        let database = Database::open(&path).unwrap();
        let read = database.begin_read().unwrap();
        assert_eq!(
            read.open_table(META)
                .unwrap()
                .get(META_SCHEMA)
                .unwrap()
                .unwrap()
                .value(),
            version.to_be_bytes()
        );
        drop(read);
        drop(database);
        assert_eq!(pair.phone_keys.snapshot(), key_snapshot);
        assert_eq!(pair.phone_keys.destroy_calls(), 0);
        assert!(!marker_path(&root, session).exists());
    }
}

#[test]
fn schema_v2_round_trips_confirmed_head_key_references_and_completed_pending_slot() {
    const META: TableDefinition<u8, &[u8]> = TableDefinition::new("metadata_v1");
    const PENDING: TableDefinition<&[u8], &[u8]> = TableDefinition::new("pending_witness_v2");
    let pair = durable_pair(214);
    // The phone committed two witnessed transitions (register and join): the clear header names
    // the confirmed predecessor head and the completed successor row stays as a cache.
    pair.phone.store().close().unwrap();
    let database = Database::open(pair.phone.store().path()).unwrap();
    let read = database.begin_read().unwrap();
    let meta = read.open_table(META).unwrap();
    assert_eq!(meta.get(1).unwrap().unwrap().value(), 2_u16.to_be_bytes());
    assert_eq!(meta.get(5).unwrap().unwrap().value(), 2_u64.to_be_bytes());
    assert_eq!(meta.get(6).unwrap().unwrap().value(), 2_u64.to_be_bytes());
    assert_eq!(meta.get(11).unwrap().unwrap().value(), 1_u64.to_be_bytes());
    assert_ne!(meta.get(12).unwrap().unwrap().value(), &[0_u8; 48]);
    assert_ne!(meta.get(13).unwrap().unwrap().value(), &[0_u8; 48]);
    assert_eq!(meta.get(14).unwrap().unwrap().value(), &[1_u8]);
    let current = meta.get(15).unwrap().unwrap().value().to_vec();
    let obsolete = meta.get(16).unwrap().unwrap().value().to_vec();
    assert_eq!(current.len(), 16);
    assert_eq!(obsolete.len(), 16);
    assert_ne!(current, obsolete);
    drop(meta);
    assert_eq!(read.open_table(PENDING).unwrap().iter().unwrap().count(), 1);
    drop(read);
    drop(database);
    pair.phone.store().reopen().unwrap();
    // Only the current key remains; the obsolete key named by the header was erased after the
    // certificate for the completed successor was verified.
    assert_eq!(pair.phone_keys.activity_counts(), (1, 0));
    assert!(pair.phone_keys.is_active(current.try_into().unwrap()));
    assert!(!pair.phone_keys.contains(obsolete.try_into().unwrap()));
}

// ---- Atomic witness barrier evidence ---------------------------------------------------------

/// One logical endpoint operation performs exactly one witness advance: one fresh read plus one
/// advance request reach the replicas, and the generation grows by exactly one.
fn assert_single_advance<E: WitnessEndpoint, T>(
    endpoint: &mut E,
    witness: &TestWitness,
    store: &Arc<NativeTransactionalProvider>,
    mutate: impl FnOnce(&mut E) -> Result<WitnessOutcome<T>, PersistenceError>,
) -> T
where
    T: TryFrom<TypedResult, Error = PersistenceError>,
{
    let responses = witness.responses();
    let generation = store.generation().unwrap();
    let value = witnessed(endpoint, witness, mutate).unwrap();
    assert_eq!(
        witness.responses(),
        responses + 2,
        "one read and one advance"
    );
    assert_eq!(store.generation().unwrap(), generation + 1);
    assert_eq!(store.rollback_counter().unwrap(), generation + 1);
    value
}

#[test]
fn every_pairing_mutation_family_advances_the_witness_exactly_once() {
    let (mut fixture, mut device, claim_hash, reservation_id) = confirmed_pairing(215);
    let daemon_witness = Arc::clone(&fixture.witness);
    let device_witness = Arc::clone(&device.witness);
    let daemon_store = Arc::clone(fixture.endpoint.store());
    let device_store = Arc::clone(device.device.store());

    // Reservation release and confirmation: zero OpenMLS transitions, one advance each.
    assert_eq!(
        assert_single_advance(&mut fixture.endpoint, &daemon_witness, &daemon_store, |e| e
            .release_reservation(id(1), reservation_id)),
        ReservationOutcome::Unavailable
    );
    assert!(matches!(
        assert_single_advance(&mut fixture.endpoint, &daemon_witness, &daemon_store, |e| e
            .confirm_claim(id(2), claim_hash, reservation_id)),
        ReservationOutcome::Reserved(_)
    ));
    // Welcome creation: one add-member transition.
    let WelcomeOutcome::Committed(welcome) =
        assert_single_advance(&mut fixture.endpoint, &daemon_witness, &daemon_store, |e| {
            e.create_welcome(id(3), reservation_id)
        })
    else {
        panic!("expected committed welcome");
    };
    // Join: one Welcome transition.
    assert_eq!(
        assert_single_advance(&mut device.device, &device_witness, &device_store, |d| d
            .join(id(4), &welcome)),
        PreJoinLifecycle::Joined
    );
    // Activation send and receive: one application transition each.
    let ActivationOutcome::Prepared(activation) =
        assert_single_advance(&mut device.device, &device_witness, &device_store, |d| {
            d.prepare_activation(id(5), id(6))
        })
    else {
        panic!("expected prepared activation");
    };
    let ActivationOutcome::Activated(acceptance) =
        assert_single_advance(&mut fixture.endpoint, &daemon_witness, &daemon_store, |e| {
            e.accept_activation(id(7), id(6), &activation.ciphertext)
        })
    else {
        panic!("expected activation acceptance");
    };
    // Protected acknowledgement: zero transitions, one advance.
    assert_eq!(
        assert_single_advance(&mut device.device, &device_witness, &device_store, |d| d
            .acknowledge_activation(id(8), &acceptance)),
        PairLifecycle::Active
    );
    // Application send, receive, receive acknowledgement, outbox acknowledgement.
    let sent = assert_single_advance(&mut device.device, &device_witness, &device_store, |d| {
        d.prepare_application(id(9), id(10), 3, b"family")
    });
    let plaintext =
        assert_single_advance(&mut fixture.endpoint, &daemon_witness, &daemon_store, |e| {
            e.receive_application(id(11), &sent.ciphertext, id(10), 3)
        });
    assert_eq!(plaintext.plaintext(), b"family");
    let acknowledged: crate::persistence::AcceptedMessageRecord =
        assert_single_advance(&mut fixture.endpoint, &daemon_witness, &daemon_store, |e| {
            e.acknowledge_receive(id(12), id(11))
        });
    assert!(acknowledged.acknowledged);
    let outbox: crate::persistence::OutboxRecord =
        assert_single_advance(&mut device.device, &device_witness, &device_store, |d| {
            d.acknowledge_outbox(id(13), id(9))
        });
    assert_eq!(
        outbox.retry_state,
        crate::persistence::RetryState::Acknowledged
    );
    // Daemon to device application and its acknowledgements.
    let delivery =
        assert_single_advance(&mut fixture.endpoint, &daemon_witness, &daemon_store, |e| {
            e.prepare_application(id(14), id(15), 3, b"delivery")
        });
    let received = assert_single_advance(&mut device.device, &device_witness, &device_store, |d| {
        d.receive_application(id(16), &delivery.ciphertext, id(15), 3)
    });
    assert_eq!(received.plaintext(), b"delivery");
    // Self-Update proposal send and receive.
    let proposal = assert_single_advance(&mut device.device, &device_witness, &device_store, |d| {
        d.prepare_replacement(id(17), id(18), 3)
    });
    let _: crate::persistence::AcceptedMessageRecord =
        assert_single_advance(&mut fixture.endpoint, &daemon_witness, &daemon_store, |e| {
            e.receive_replacement_proposal(id(19), &proposal.ciphertext, id(18), 3)
        });
    // Daemon commit: one commit-and-merge transition.
    let commit =
        assert_single_advance(&mut fixture.endpoint, &daemon_witness, &daemon_store, |e| {
            e.create_update_commit(id(20), id(21), 3)
        });
    let metadata = commit.commit.clone().unwrap();
    // Received commit application and epoch-ready creation are separate single-transition
    // operations: the first changes the epoch, the second does not.
    let epoch_before = device_store.rollback_counter().unwrap();
    let _ = epoch_before;
    let applied = assert_single_advance(&mut device.device, &device_witness, &device_store, |d| {
        d.apply_received_update_commit(id(22), &commit.ciphertext, id(21), 3)
    });
    assert_eq!(applied, metadata);
    let ready = assert_single_advance(&mut device.device, &device_witness, &device_store, |d| {
        d.prepare_epoch_ready(id(23), id(24), 3, &applied)
    });
    assert_eq!(ready.epoch, metadata.target_epoch);
    // Epoch-ready receive, confirmation send, confirmation receive.
    let acceptance =
        assert_single_advance(&mut fixture.endpoint, &daemon_witness, &daemon_store, |e| {
            e.accept_epoch_ready(id(25), id(24), 3, &ready.ciphertext)
        });
    assert_eq!(acceptance.commit_id(), metadata.commit_id);
    let confirmation =
        assert_single_advance(&mut fixture.endpoint, &daemon_witness, &daemon_store, |e| {
            e.prepare_epoch_ready_confirmation(id(26), id(27), 3, &acceptance)
        });
    assert_eq!(
        assert_single_advance(&mut device.device, &device_witness, &device_store, |d| d
            .accept_epoch_ready_confirmation(id(28), id(27), 3, &confirmation.ciphertext)),
        PairLifecycle::Active
    );
    // Removal commit and received removal, then local terminal operations.
    let RemovalOutcome::Commit(removal) =
        assert_single_advance(&mut fixture.endpoint, &daemon_witness, &daemon_store, |e| {
            e.remove_device(id(29), id(30), 3)
        })
    else {
        panic!("expected removal commit");
    };
    assert_eq!(
        assert_single_advance(&mut device.device, &device_witness, &device_store, |d| d
            .apply_removal(id(31), &removal, id(30), 3)),
        RemovalOutcome::Removed
    );
    assert_eq!(
        assert_single_advance(&mut fixture.endpoint, &daemon_witness, &daemon_store, |e| e
            .mark_revoked(id(32))),
        RemovalOutcome::Revoked
    );
    let requirement =
        assert_single_advance(&mut device.device, &device_witness, &device_store, |d| {
            d.reset(id(33))
        });
    assert_eq!(requirement.group_id(), Some(welcome.group_id()));
}

#[test]
fn cancellation_and_welcome_expiry_advance_the_witness_exactly_once() {
    let mut cancelled = pending_fixture(216);
    let witness = Arc::clone(&cancelled.witness);
    let store = Arc::clone(cancelled.endpoint.store());
    assert_eq!(
        assert_single_advance(&mut cancelled.endpoint, &witness, &store, |e| e
            .cancel(id(1))),
        InvitationLifecycle::Cancelled
    );

    let (mut fixture, _, claim_hash, reservation_id) = confirmed_pairing(217);
    let welcome = fixture
        .run(|e| e.create_welcome(id(2), reservation_id))
        .unwrap();
    let WelcomeOutcome::Committed(welcome) = welcome else {
        panic!("expected welcome");
    };
    fixture.clock.set(welcome.expires_at_ms());
    assert!(matches!(
        fixture.endpoint.recover_welcome(claim_hash).unwrap(),
        WelcomeOutcome::Expired
    ));
    let responses = fixture.witness.responses();
    let generation = fixture.endpoint.store().generation().unwrap();
    authorize(&fixture.endpoint, &fixture.witness).unwrap();
    let expiry = fixture
        .endpoint
        .expire_welcome_if_needed()
        .unwrap()
        .unwrap();
    assert_eq!(
        complete(&fixture.endpoint, &fixture.witness, &expiry).unwrap(),
        TypedResult::InvitationLifecycle(InvitationLifecycle::Consumed)
    );
    assert_eq!(fixture.witness.responses(), responses + 2);
    assert_eq!(
        fixture.endpoint.store().generation().unwrap(),
        generation + 1
    );
    authorize(&fixture.endpoint, &fixture.witness).unwrap();
    assert!(
        fixture
            .endpoint
            .expire_welcome_if_needed()
            .unwrap()
            .is_none()
    );
}

#[test]
fn pending_operation_blocks_later_mutations_and_automatic_expiry() {
    let (mut fixture, device, claim_hash, reservation_id) = confirmed_pairing(218);
    let publication = device.publication.clone();
    authorize(&fixture.endpoint, &fixture.witness).unwrap();
    let WitnessOutcome::Pending(pending) = fixture
        .endpoint
        .release_reservation(id(1), reservation_id)
        .unwrap()
    else {
        panic!("expected pending release");
    };
    // Every later mutation is refused without opening a write transaction or evaluating input.
    let generation = fixture.endpoint.store().generation().unwrap();
    assert_eq!(
        fixture.endpoint.cancel(id(2)).unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    assert_eq!(
        fixture.endpoint.mark_revoked(id(3)).unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    assert_eq!(
        fixture
            .endpoint
            .prepare_application(id(4), id(5), 1, b"blocked")
            .unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    // Reads that would expose the locally committed successor are withheld.
    assert_eq!(
        fixture.endpoint.lifecycle().unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    assert_eq!(
        fixture.endpoint.pair_lifecycle().unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    // Automatic expiry is due but stays frozen behind the pending operation.
    fixture.clock.set(fixture.publication.expires_at_ms() + 1);
    assert_eq!(
        fixture.endpoint.expire_if_needed().unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    assert_eq!(
        fixture
            .endpoint
            .submit_claim(id(6), publication.claim())
            .unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    assert_eq!(fixture.endpoint.store().generation().unwrap(), generation);
    // A fresh read while pending reports resend, not a new authorization.
    assert_eq!(
        reconcile(&fixture.endpoint, &fixture.witness).unwrap(),
        EndpointReconciliation::ResendPending
    );
    assert_eq!(
        fixture
            .endpoint
            .prepare_application(id(4), id(5), 1, b"blocked")
            .unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    // Completion releases the exact release result and unblocks the endpoint. The invitation
    // is now past its deadline, so the next mutation is the deterministic expiry.
    assert_eq!(
        complete(&fixture.endpoint, &fixture.witness, &pending).unwrap(),
        TypedResult::Reservation(ReservationOutcome::Unavailable)
    );
    assert_eq!(
        fixture.endpoint.lifecycle().unwrap(),
        InvitationLifecycle::ClaimPending
    );
    authorize(&fixture.endpoint, &fixture.witness).unwrap();
    let WitnessOutcome::Pending(expiry) = fixture
        .endpoint
        .confirm_claim(id(7), claim_hash, reservation_id)
        .unwrap()
    else {
        panic!("expected pending expiry");
    };
    assert_eq!(
        complete(&fixture.endpoint, &fixture.witness, &expiry).unwrap(),
        TypedResult::InvitationLifecycle(InvitationLifecycle::Expired)
    );
    assert_eq!(
        fixture
            .run(|e| e.confirm_claim(id(8), claim_hash, reservation_id))
            .unwrap(),
        ReservationOutcome::Expired
    );
    let _ = device;
}

#[test]
fn duplicate_pending_and_completed_operations_recover_exactly_and_conflicts_quarantine() {
    let mut pair = durable_pair(219);
    let witness = Arc::clone(&pair.phone_witness);
    authorize(&pair.phone, &witness).unwrap();
    let WitnessOutcome::Pending(first) = pair
        .phone
        .prepare_application(id(1), id(2), 4, b"exact")
        .unwrap()
    else {
        panic!("expected pending");
    };
    assert_eq!(first.kind(), WitnessRequestKind::Advance);
    // Same ID and fingerprint while pending: byte-identical request, no OpenMLS call.
    let generation = pair.phone.store().generation().unwrap();
    let WitnessOutcome::Pending(again) = pair
        .phone
        .prepare_application(id(1), id(2), 4, b"exact")
        .unwrap()
    else {
        panic!("expected pending duplicate");
    };
    assert_eq!(again, first);
    assert_eq!(again.request(), first.request());
    assert_eq!(pair.phone.store().generation().unwrap(), generation);
    assert_eq!(pair.phone.pending_witness().unwrap(), Some(first.clone()));
    // Another operation ID while pending is refused before any input is evaluated.
    assert_eq!(
        pair.phone
            .prepare_application(id(9), id(2), 4, b"exact")
            .unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    // The request never carries plaintext, and the outbox withholds the unconfirmed record.
    assert!(!first.request().windows(5).any(|window| window == b"exact"));
    assert!(
        !pair
            .phone
            .pending_outbox()
            .unwrap()
            .iter()
            .any(|record| record.operation_id == id(1))
    );
    let TypedResult::Envelope(record) = complete(&pair.phone, &witness, &first).unwrap() else {
        panic!("expected envelope");
    };
    assert!(pair.phone.pending_outbox().unwrap().contains(&record));
    // Same ID and fingerprint after completion: the exact result, no new advance.
    let responses = witness.responses();
    assert_eq!(
        pair.phone
            .prepare_application(id(1), id(2), 4, b"exact")
            .unwrap(),
        WitnessOutcome::Released(record.clone())
    );
    assert_eq!(witness.responses(), responses);
    assert_eq!(pair.phone.store().generation().unwrap(), generation);
    // Same ID with every differing input field fails closed and quarantines.
    for (logical, hosted, plaintext) in [
        (id(3), 4_u64, b"exact".as_slice()),
        (id(2), 5, b"exact"),
        (id(2), 4, b"exact!"),
    ] {
        let mut probe = durable_pair(219);
        let probe_witness = Arc::clone(&probe.phone_witness);
        probe.phone_send(id(1), id(2), 4, b"exact").unwrap();
        assert_eq!(
            witnessed(&mut probe.phone, &probe_witness, |phone| phone
                .prepare_application(id(1), logical, hosted, plaintext))
            .unwrap_err(),
            PersistenceError::WitnessOperationConflict
        );
        assert_eq!(
            probe.phone_send(id(8), id(8), 4, b"frozen").unwrap_err(),
            PersistenceError::Quarantined
        );
    }
    assert_ne!(pair.context.crypto_session_id, [0; 16]);
}

#[test]
fn exact_request_and_result_survive_restart_byte_identically() {
    let mut pair = durable_pair(220);
    let witness = Arc::clone(&pair.phone_witness);
    authorize(&pair.phone, &witness).unwrap();
    let WitnessOutcome::Pending(request) = pair
        .phone
        .prepare_application(id(1), id(2), 6, b"restart me")
        .unwrap()
    else {
        panic!("expected pending");
    };
    let keys_before = pair.phone_keys.snapshot();
    // Restart before the request was ever sent.
    pair.phone.store().close().unwrap();
    pair.phone.store().reopen().unwrap();
    // No prepared key is erased and the obsolete key survives until confirmation.
    assert_eq!(pair.phone_keys.snapshot(), keys_before);
    assert_eq!(pair.phone_keys.activity_counts(), (2, 0));
    let recovered = pair.phone.pending_witness().unwrap().unwrap();
    assert_eq!(recovered, request);
    assert_eq!(
        reconcile(&pair.phone, &witness).unwrap(),
        EndpointReconciliation::ResendPending
    );
    let TypedResult::Envelope(record) = complete(&pair.phone, &witness, &recovered).unwrap() else {
        panic!("expected envelope");
    };
    assert_eq!(pair.phone_keys.activity_counts(), (1, 0));
    assert_eq!(record.operation_id, id(1));

    // Restart after the witness accepted but before the response was applied locally.
    authorize(&pair.phone, &witness).unwrap();
    let WitnessOutcome::Pending(second) = pair
        .phone
        .prepare_application(id(3), id(4), 6, b"lost response")
        .unwrap()
    else {
        panic!("expected pending");
    };
    let certificate = witness.respond(second.request()).unwrap();
    pair.phone.store().close().unwrap();
    pair.phone.store().reopen().unwrap();
    assert_eq!(pair.phone.pending_witness().unwrap(), Some(second.clone()));
    assert_eq!(
        reconcile(&pair.phone, &witness).unwrap(),
        EndpointReconciliation::RecoverAccepted
    );
    // The duplicate certificate is byte-identical and completes the exact result.
    assert_eq!(witness.respond(second.request()).unwrap(), certificate);
    let released = pair
        .phone
        .continue_witness(second.operation_id(), &certificate)
        .unwrap();
    let TypedResult::Envelope(second_record) = released else {
        panic!("expected envelope");
    };
    assert_eq!(
        pair.phone.store().outbox(id(3)).unwrap().unwrap(),
        second_record
    );
    assert_eq!(
        reconcile(&pair.phone, &witness).unwrap(),
        EndpointReconciliation::Ready
    );
}

#[test]
fn received_commit_and_epoch_ready_are_separate_single_transitions() {
    let (mut fixture, mut device) = activated_pair(221);
    let proposal = device
        .run(|d| d.prepare_replacement(id(1), id(2), 2))
        .unwrap();
    let _: crate::persistence::AcceptedMessageRecord = fixture
        .run(|e| e.receive_replacement_proposal(id(3), &proposal.ciphertext, id(2), 2))
        .unwrap();
    let commit = fixture
        .run(|e| e.create_update_commit(id(4), id(5), 2))
        .unwrap();
    let metadata = commit.commit.clone().unwrap();
    let store = Arc::clone(device.device.store());
    let generation = store.generation().unwrap();
    let witness = Arc::clone(&device.witness);
    authorize(&device.device, &witness).unwrap();
    let WitnessOutcome::Pending(apply) = device
        .device
        .apply_update_commit(id(6), &commit, id(5), 2)
        .unwrap()
    else {
        panic!("expected pending apply");
    };
    // Nothing epoch-ready exists before the apply barrier completes; the epoch-ready send is
    // refused while the apply is pending.
    let no_epoch_ready = |device: &DurablePreJoinDevice| {
        !device
            .pending_outbox()
            .unwrap()
            .iter()
            .any(|record| record.class == crate::MessageClass::EpochReady)
    };
    assert!(no_epoch_ready(&device.device));
    assert_eq!(
        device
            .device
            .prepare_epoch_ready(id(7), id(8), 2, &metadata)
            .unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    assert_eq!(
        complete(&device.device, &witness, &apply).unwrap(),
        TypedResult::Commit(metadata.clone())
    );
    assert_eq!(store.generation().unwrap(), generation + 1);
    assert!(no_epoch_ready(&device.device));
    // The epoch-ready operation requires the exact applied commit metadata.
    let mut wrong = metadata.clone();
    wrong.target_epoch += 1;
    assert_eq!(
        device
            .run(|d| d.prepare_epoch_ready(id(9), id(8), 2, &wrong))
            .unwrap_err(),
        PersistenceError::Conflict
    );
    let ready = device
        .run(|d| d.prepare_epoch_ready(id(7), id(8), 2, &metadata))
        .unwrap();
    assert_eq!(store.generation().unwrap(), generation + 2);
    assert_eq!(ready.class, crate::MessageClass::EpochReady);
    assert_eq!(ready.epoch, metadata.target_epoch);
    assert!(device.device.pending_outbox().unwrap().contains(&ready));
    // Restart keeps both operations recoverable and the epoch-ready exact.
    device.device.store().close().unwrap();
    device.device.store().reopen().unwrap();
    authorize(&device.device, &witness).unwrap();
    assert_eq!(
        device
            .device
            .prepare_epoch_ready(id(7), id(8), 2, &metadata)
            .unwrap(),
        WitnessOutcome::Released(ready.clone())
    );
    let acceptance = fixture
        .run(|e| e.accept_epoch_ready(id(10), id(8), 2, &ready.ciphertext))
        .unwrap();
    assert_eq!(
        device
            .run(|d| d.acknowledge_epoch_ready(id(11), &acceptance))
            .unwrap(),
        PairLifecycle::Active
    );
}

#[test]
fn nothing_is_released_before_the_barrier_completes() {
    let mut pair = durable_pair(222);
    let phone_witness = Arc::clone(&pair.phone_witness);
    let daemon_witness = Arc::clone(&pair.daemon_witness);
    // Send: the request reveals neither plaintext nor ciphertext; the outbox withholds the row.
    authorize(&pair.phone, &phone_witness).unwrap();
    let WitnessOutcome::Pending(send) = pair
        .phone
        .prepare_application(id(1), id(2), 1, b"withheld plaintext")
        .unwrap()
    else {
        panic!("expected pending");
    };
    let hidden_record = pair.phone.store().outbox(id(1)).unwrap().unwrap();
    assert!(
        !send
            .request()
            .windows(hidden_record.ciphertext.len())
            .any(|window| window == hidden_record.ciphertext.as_slice())
    );
    let withheld = |phone: &DurablePhone| {
        !phone
            .pending_outbox()
            .unwrap()
            .iter()
            .any(|record| record.operation_id == id(1))
    };
    assert!(withheld(&pair.phone));
    // A forged replica signature releases nothing and quarantines the endpoint.
    phone_witness.set_forge_signature(true);
    assert_eq!(
        complete(&pair.phone, &phone_witness, &send).unwrap_err(),
        PersistenceError::WitnessReceiptInvalid
    );
    phone_witness.set_forge_signature(false);
    assert!(withheld(&pair.phone));
    assert_eq!(
        pair.phone
            .continue_witness(
                send.operation_id(),
                &phone_witness.respond(send.request()).unwrap()
            )
            .unwrap_err(),
        PersistenceError::Quarantined
    );
    pair.phone.store().close().unwrap();
    pair.phone.store().reopen().unwrap();
    assert_eq!(
        pair.phone_send(id(3), id(4), 1, b"still quarantined")
            .unwrap_err(),
        PersistenceError::Quarantined
    );

    // Receive: plaintext is sealed until the daemon's own barrier completes.
    let mut sender = durable_pair(223);
    let sender_witness = Arc::clone(&sender.phone_witness);
    let sent = witnessed(&mut sender.phone, &sender_witness, |phone| {
        phone.prepare_application(id(1), id(2), 1, b"sealed until confirmed")
    })
    .unwrap();
    let receiver_witness = Arc::clone(&sender.daemon_witness);
    authorize(&sender.daemon, &receiver_witness).unwrap();
    let WitnessOutcome::Pending(receive) = sender
        .daemon
        .receive_application(id(5), &sent.ciphertext, id(2), 1)
        .unwrap()
    else {
        panic!("expected pending receive");
    };
    assert!(
        !receive
            .request()
            .windows(22)
            .any(|window| window == b"sealed until confirmed")
    );
    // Deletion failure of the obsolete key blocks output after certificate verification.
    *sender.daemon_keys.erase_noop.lock().unwrap() = true;
    assert_eq!(
        complete(&sender.daemon, &receiver_witness, &receive).unwrap_err(),
        PersistenceError::SecureStoreUnavailable
    );
    assert_eq!(sender.daemon_keys.activity_counts(), (2, 0));
    *sender.daemon_keys.erase_noop.lock().unwrap() = false;
    // Idempotent completion after the deletion succeeds releases the exact plaintext once.
    let TypedResult::Plaintext(plaintext) =
        complete(&sender.daemon, &receiver_witness, &receive).unwrap()
    else {
        panic!("expected plaintext");
    };
    assert_eq!(plaintext.plaintext(), b"sealed until confirmed");
    assert_eq!(sender.daemon_keys.activity_counts(), (1, 0));
    let _ = daemon_witness;
}

#[test]
fn witness_ahead_and_revoked_lineages_freeze_the_endpoint() {
    // A foreign successor (a clone won the race) is stale local state: quarantine, no output.
    let mut pair = durable_pair(224);
    let witness = Arc::clone(&pair.phone_witness);
    let read = pair.phone.witness_read_request().unwrap();
    witness.advance_foreign(&read);
    let certificate = witness.respond(&read).unwrap();
    assert!(matches!(
        pair.phone.reconcile_witness(&certificate).unwrap(),
        EndpointReconciliation::Quarantined(crate::witness::EndpointQuarantineReason::StateLoss)
    ));
    assert_eq!(
        pair.phone
            .prepare_application(id(1), id(2), 1, b"stale")
            .unwrap_err(),
        PersistenceError::Quarantined
    );

    // Revocation that reaches the quorum first: no new operation may complete.
    let mut revoked = durable_pair(225);
    let witness = Arc::clone(&revoked.phone_witness);
    authorize(&revoked.phone, &witness).unwrap();
    let WitnessOutcome::Pending(request) = revoked
        .phone
        .prepare_application(id(1), id(2), 1, b"revoked before advance")
        .unwrap()
    else {
        panic!("expected pending");
    };
    witness.revoke(request.request());
    assert_eq!(
        complete(&revoked.phone, &witness, &request).unwrap_err(),
        PersistenceError::EndpointRevoked
    );
    assert!(
        !revoked
            .phone
            .pending_outbox()
            .unwrap()
            .iter()
            .any(|record| record.operation_id == id(1))
    );
    assert_eq!(
        revoked
            .phone_send(id(3), id(4), 1, b"after revocation")
            .unwrap_err(),
        PersistenceError::EndpointRevoked
    );
    revoked.phone.store().close().unwrap();
    revoked.phone.store().reopen().unwrap();
    assert_eq!(
        revoked
            .phone_send(id(3), id(4), 1, b"after restart")
            .unwrap_err(),
        PersistenceError::EndpointRevoked
    );
}

#[test]
fn legacy_creation_and_invitation_issue_register_before_publication() {
    // Registration is the counter-1 request; the database stays initializing until confirmed.
    let root = temp_root("register-barrier");
    let ids = pairing_ids(226);
    let keys = TestKeys::enabled();
    let witness = TestWitness::new();
    let (endpoint, request) = DurablePendingInvitation::issue_with_runtime(
        &root,
        Identity::daemon(ids.account, ids.installation),
        ids.session,
        id(1),
        keys.clone(),
        witness.trust(),
        RuntimeHooks {
            faults: Arc::new(NoFaults),
            clock: ManualClock::new(1_000_000),
        },
    )
    .unwrap();
    assert_eq!(request.kind(), WitnessRequestKind::Register);
    assert!(marker_path(&root, ids.session).is_file());
    assert_eq!(witness.responses(), 0);
    assert_eq!(keys.activity_counts(), (1, 0));
    // A register conflict (another registration already owns the lineage) is terminal.
    let stolen = WitnessRequest::decode(request.request()).unwrap();
    let _ = stolen;
    let TypedResult::Invitation(publication) = complete(&endpoint, &witness, &request).unwrap()
    else {
        panic!("expected invitation");
    };
    assert!(!marker_path(&root, ids.session).exists());
    assert_eq!(witness.head(request.request()).unwrap().counter, 1);
    assert_eq!(
        witness.head(request.request()).unwrap().commitment,
        stolen.proposed_commitment().unwrap()
    );
    assert!(!publication.bytes().is_empty());
    // The live endpoint keeps its OS lifecycle claim after publication: a competing creator is
    // refused at the claim. Once the endpoint is gone the session is still never reusable.
    assert!(matches!(
        DurablePendingInvitation::issue_with_runtime(
            &root,
            Identity::daemon(ids.account, ids.installation),
            ids.session,
            id(2),
            keys.clone(),
            witness.trust(),
            RuntimeHooks {
                faults: Arc::new(NoFaults),
                clock: ManualClock::new(1_000_000),
            },
        ),
        Err(PersistenceError::LifecycleBusy)
    ));
    assert_eq!(
        discard_interrupted_creation(&root, ids.session, keys.clone()).unwrap_err(),
        PersistenceError::LifecycleBusy
    );
    drop(endpoint);
    assert!(matches!(
        DurablePendingInvitation::issue_with_runtime(
            &root,
            Identity::daemon(ids.account, ids.installation),
            ids.session,
            id(2),
            keys,
            witness.trust(),
            RuntimeHooks {
                faults: Arc::new(NoFaults),
                clock: ManualClock::new(1_000_000),
            },
        ),
        Err(PersistenceError::AlreadyExists)
    ));
}

// ---- Audit regressions -----------------------------------------------------------------------

#[test]
fn restarted_endpoint_releases_nothing_before_fresh_witness_reconciliation() {
    let mut pair = durable_pair(227);
    let witness = Arc::clone(&pair.phone_witness);
    let first = pair
        .phone_send(id(1), id(2), 1, b"confirmed earlier")
        .unwrap();
    let second = pair
        .phone_send(id(3), id(4), 1, b"completed cache")
        .unwrap();
    let applications = |phone: &DurablePhone| {
        phone
            .pending_outbox()
            .unwrap()
            .into_iter()
            .filter(|record| record.class == crate::MessageClass::ApplicationRequest)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        applications(&pair.phone),
        vec![first.clone(), second.clone()]
    );
    // Restart with a `Completed` pending row: the marker is a cache, not witness authority.
    pair.phone.store().close().unwrap();
    pair.phone.store().reopen().unwrap();
    assert_eq!(
        applications(&pair.phone),
        vec![first.clone()],
        "the cached completion's ciphertext is withheld until a fresh head confirms it"
    );
    assert_eq!(
        pair.phone
            .prepare_application(id(1), id(2), 1, b"confirmed earlier")
            .unwrap_err(),
        PersistenceError::FreshWitnessRequired,
        "an older exact result is not reusable from an unvalidated snapshot"
    );
    assert_eq!(
        pair.phone
            .prepare_application(id(3), id(4), 1, b"completed cache")
            .unwrap_err(),
        PersistenceError::FreshWitnessRequired
    );
    assert_eq!(
        pair.phone.acknowledge_outbox(id(5), id(1)).unwrap_err(),
        PersistenceError::WitnessUnavailable
    );
    let responses = witness.responses();
    assert_eq!(
        reconcile(&pair.phone, &witness).unwrap(),
        EndpointReconciliation::RecoverAccepted
    );
    let pending = pair.phone.pending_witness().unwrap().unwrap();
    assert_eq!(pending.operation_id(), id(3));
    assert_eq!(
        complete(&pair.phone, &witness, &pending).unwrap(),
        TypedResult::Envelope(second.clone())
    );
    assert_eq!(witness.responses(), responses + 2);
    assert_eq!(applications(&pair.phone), vec![first.clone(), second]);
    assert_eq!(
        pair.phone
            .prepare_application(id(1), id(2), 1, b"confirmed earlier")
            .unwrap(),
        WitnessOutcome::Released(first)
    );

    // The same rule holds for pairing facades: lifecycle, publication, and pair state stay
    // withheld after restart until the fresh read confirms the cached completion.
    let (mut fixture, mut device) = activated_pair(228);
    fixture.endpoint.store().close().unwrap();
    fixture.endpoint.store().reopen().unwrap();
    device.device.store().close().unwrap();
    device.device.store().reopen().unwrap();
    for error in [
        fixture.endpoint.lifecycle().unwrap_err(),
        fixture.endpoint.pair_lifecycle().unwrap_err(),
        fixture.endpoint.publication().unwrap_err(),
        device.device.lifecycle().unwrap_err(),
        device.device.pair_lifecycle().unwrap_err(),
        device.device.publication().unwrap_err(),
    ] {
        assert_eq!(error, PersistenceError::WitnessUnavailable);
    }
    authorize(&fixture.endpoint, &fixture.witness).unwrap();
    authorize(&device.device, &device.witness).unwrap();
    assert_eq!(
        fixture.endpoint.pair_lifecycle().unwrap(),
        Some(PairLifecycle::Active)
    );
    assert_eq!(
        device.device.pair_lifecycle().unwrap(),
        Some(PairLifecycle::Active)
    );
}

#[test]
fn quarantine_during_initial_registration_is_durable() {
    // Local fingerprint conflict on the registration operation ID before registration completes.
    let root = temp_root("register-conflict");
    let ids = pairing_ids(229);
    let keys = TestKeys::enabled();
    let witness = TestWitness::new();
    let hooks = || RuntimeHooks {
        faults: Arc::new(NoFaults),
        clock: ManualClock::new(1_000_000),
    };
    let (mut endpoint, request) = DurablePendingInvitation::issue_with_runtime(
        &root,
        Identity::daemon(ids.account, ids.installation),
        ids.session,
        id(1),
        keys.clone(),
        witness.trust(),
        hooks(),
    )
    .unwrap();
    assert_eq!(
        endpoint.cancel(request.operation_id()).unwrap_err(),
        PersistenceError::WitnessOperationConflict
    );
    assert_eq!(
        endpoint.pending_witness().unwrap_err(),
        PersistenceError::Quarantined
    );
    assert_eq!(
        endpoint
            .continue_witness(
                request.operation_id(),
                &witness.respond(request.request()).unwrap()
            )
            .unwrap_err(),
        PersistenceError::Quarantined
    );
    assert_eq!(witness.responses(), 1);
    endpoint.store().close().unwrap();
    drop(endpoint);
    // The conflicting request never reached the witness, so only the durable marker can keep the
    // endpoint frozen across restart. Cleanup never deletes committed state of a terminal endpoint.
    assert_eq!(
        discard_interrupted_creation(&root, ids.session, keys.clone()).unwrap_err(),
        PersistenceError::Quarantined
    );
    let mut reopened = DurablePendingInvitation::open_with_runtime(
        &root,
        ids.session,
        keys.clone(),
        witness.trust(),
        hooks(),
    )
    .unwrap();
    assert!(!marker_path(&root, ids.session).exists());
    assert_eq!(
        reopened.pending_witness().unwrap_err(),
        PersistenceError::Quarantined
    );
    assert_eq!(
        reopened.publication().unwrap_err(),
        PersistenceError::Quarantined
    );
    assert_eq!(
        reopened
            .continue_witness(
                request.operation_id(),
                &witness.respond(request.request()).unwrap()
            )
            .unwrap_err(),
        PersistenceError::Quarantined
    );
    assert_eq!(
        reopened.cancel(id(2)).unwrap_err(),
        PersistenceError::Quarantined
    );
    assert_eq!(keys.destroy_calls(), 0);

    // A forged registration certificate is equally terminal and equally durable.
    let root = temp_root("register-forged");
    let ids = pairing_ids(230);
    let keys = TestKeys::enabled();
    let witness = TestWitness::new();
    let (endpoint, request) = DurablePendingInvitation::issue_with_runtime(
        &root,
        Identity::daemon(ids.account, ids.installation),
        ids.session,
        id(1),
        keys.clone(),
        witness.trust(),
        hooks(),
    )
    .unwrap();
    witness.set_forge_signature(true);
    assert_eq!(
        complete(&endpoint, &witness, &request).unwrap_err(),
        PersistenceError::WitnessReceiptInvalid
    );
    witness.set_forge_signature(false);
    endpoint.store().close().unwrap();
    drop(endpoint);
    let reopened = DurablePendingInvitation::open_with_runtime(
        &root,
        ids.session,
        keys,
        witness.trust(),
        hooks(),
    )
    .unwrap();
    assert_eq!(
        reopened
            .continue_witness(
                request.operation_id(),
                &witness.respond(request.request()).unwrap()
            )
            .unwrap_err(),
        PersistenceError::Quarantined
    );
}

#[test]
fn native_endpoint_holds_its_lifecycle_claim_for_its_whole_open_lifetime() {
    let fixture = pending_fixture(231);
    let hooks = || RuntimeHooks {
        faults: Arc::new(NoFaults),
        clock: fixture.clock.clone(),
    };
    // Published and live: a competing opener or cleanup is refused at the OS claim.
    assert!(matches!(
        DurablePendingInvitation::open_with_runtime(
            &fixture.root,
            fixture.ids.session,
            fixture.keys.clone(),
            fixture.witness.trust(),
            hooks(),
        ),
        Err(PersistenceError::LifecycleBusy)
    ));
    assert_eq!(
        discard_interrupted_creation(&fixture.root, fixture.ids.session, fixture.keys.clone())
            .unwrap_err(),
        PersistenceError::LifecycleBusy
    );
    // Closing releases the claim; reopening acquires it again and excludes others again.
    fixture.endpoint.store().close().unwrap();
    let second = DurablePendingInvitation::open_with_runtime(
        &fixture.root,
        fixture.ids.session,
        fixture.keys.clone(),
        fixture.witness.trust(),
        hooks(),
    )
    .unwrap();
    assert_eq!(
        fixture.endpoint.store().reopen().unwrap_err(),
        PersistenceError::LifecycleBusy
    );
    drop(second);
    fixture.endpoint.store().reopen().unwrap();
    assert!(matches!(
        DurablePendingInvitation::open_with_runtime(
            &fixture.root,
            fixture.ids.session,
            fixture.keys.clone(),
            fixture.witness.trust(),
            hooks(),
        ),
        Err(PersistenceError::LifecycleBusy)
    ));
    // Dropping the endpoint releases the claim.
    drop(fixture.endpoint);
    let reopened = DurablePendingInvitation::open_with_runtime(
        &fixture.root,
        fixture.ids.session,
        fixture.keys.clone(),
        fixture.witness.trust(),
        hooks(),
    )
    .unwrap();
    authorize(&reopened, &fixture.witness).unwrap();
}

#[test]
fn advance_accepted_before_revocation_is_recoverable_after_a_fresh_read() {
    let mut pair = durable_pair(232);
    let witness = Arc::clone(&pair.phone_witness);
    authorize(&pair.phone, &witness).unwrap();
    let WitnessOutcome::Pending(request) = pair
        .phone
        .prepare_application(id(1), id(2), 1, b"accepted then revoked")
        .unwrap()
    else {
        panic!("expected pending");
    };
    // The quorum accepts the advance, the response is lost, and revocation follows.
    let accepted = witness.respond(request.request()).unwrap();
    witness.revoke(request.request());
    pair.phone.store().close().unwrap();
    pair.phone.store().reopen().unwrap();
    // A read certificate carries no acceptance evidence, so the exact resent request is the query.
    assert_eq!(
        reconcile(&pair.phone, &witness).unwrap(),
        EndpointReconciliation::RecoverAccepted
    );
    let pending = pair.phone.pending_witness().unwrap().unwrap();
    assert_eq!(pending, request);
    let recovered = witness.respond(pending.request()).unwrap();
    assert_eq!(
        recovered, accepted,
        "replicas answer with the recovered receipts"
    );
    let TypedResult::Envelope(record) = pair
        .phone
        .continue_witness(pending.operation_id(), &recovered)
        .unwrap()
    else {
        panic!("expected envelope");
    };
    assert_eq!(record.operation_id, id(1));
    assert!(pair.phone.pending_outbox().unwrap().contains(&record));
    // The lineage is revoked afterwards: no later mutation is authorized.
    assert_eq!(
        reconcile(&pair.phone, &witness).unwrap(),
        EndpointReconciliation::Revoked
    );
    assert_eq!(
        pair.phone
            .prepare_application(id(3), id(4), 1, b"after revocation")
            .unwrap_err(),
        PersistenceError::EndpointRevoked
    );
    pair.phone.store().close().unwrap();
    pair.phone.store().reopen().unwrap();
    assert_eq!(
        pair.phone.pending_witness().unwrap_err(),
        PersistenceError::EndpointRevoked
    );

    // Revocation that wins before acceptance: the fresh read reports the predecessor head, and
    // the endpoint is revoked without releasing the pending result.
    let mut lost = durable_pair(233);
    let witness = Arc::clone(&lost.phone_witness);
    authorize(&lost.phone, &witness).unwrap();
    let WitnessOutcome::Pending(request) = lost
        .phone
        .prepare_application(id(1), id(2), 1, b"never accepted")
        .unwrap()
    else {
        panic!("expected pending");
    };
    witness.revoke(request.request());
    lost.phone.store().close().unwrap();
    lost.phone.store().reopen().unwrap();
    assert_eq!(
        reconcile(&lost.phone, &witness).unwrap(),
        EndpointReconciliation::Revoked
    );
    assert_eq!(
        lost.phone.pending_witness().unwrap_err(),
        PersistenceError::EndpointRevoked
    );
    assert!(
        !lost
            .phone
            .pending_outbox()
            .unwrap()
            .iter()
            .any(|record| record.operation_id == id(1))
    );
}
