// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

//! Deterministic in-process three-replica witness for tests and test-only bindings.
//!
//! This module is compiled only for unit tests and for the Node and browser test artifacts. It is
//! never part of a production binding. It signs receipts with process-local keys and applies the
//! shared `evaluate_witness_request` decision logic over an append-only per-lineage history.

use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use openmls_basic_credential::SignatureKeyPair;

use crate::{
    SUITE,
    pairing::PairingCredential,
    witness::{
        QuorumCertificate, ReplicaKey, ReplicaReceipt, ReplicaTrust, ReplicaTrustSet,
        StoredWitnessOperation, TestReceiptFields, WitnessHead, WitnessHistory,
        WitnessLedgerPosition, WitnessRequest, WitnessRequestKind, WitnessResult,
        WitnessRevocationEvent, evaluate_witness_request,
    },
};

/// The simulated quorum is switched off; no replica answers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TestWitnessUnavailable;

#[cfg(not(target_arch = "wasm32"))]
impl From<TestWitnessUnavailable> for crate::persistence::PersistenceError {
    fn from(_: TestWitnessUnavailable) -> Self {
        Self::WitnessUnavailable
    }
}

/// Deterministic in-process three-replica witness.
///
/// Each replica signs its own receipt with its own key. Decisions come from the shared
/// `evaluate_witness_request` logic over an append-only per-lineage history. Byte-identical
/// certificates are returned for duplicate accepted operations. Fault switches simulate an
/// unavailable quorum, a rolled-back replica, and a forged receipt.
pub struct TestWitness {
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
    pub fn new() -> Arc<Self> {
        let signers: [SignatureKeyPair; 3] =
            std::array::from_fn(|_| SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap());
        let trust = ReplicaTrustSet::new(
            (0..3)
                .map(|index| {
                    ReplicaTrust::new(
                        [200 + index as u8; 16],
                        vec![
                            ReplicaKey::new(
                                [210 + index as u8; 16],
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

    pub fn trust(&self) -> Arc<ReplicaTrustSet> {
        Arc::clone(&self.trust)
    }

    pub fn set_unavailable(&self, value: bool) {
        *self.unavailable.lock().unwrap() = value;
    }

    pub fn set_forge_signature(&self, value: bool) {
        *self.forge_signature.lock().unwrap() = value;
    }

    pub fn responses(&self) -> u64 {
        self.respond_count.load(Ordering::SeqCst)
    }

    /// Current `(counter, commitment)` head of the lineage named by a request, if registered.
    pub fn head(&self, request_bytes: &[u8]) -> Option<(u64, [u8; 48])> {
        let request = WitnessRequest::decode(request_bytes).unwrap();
        let hash = request.lineage().hash().unwrap();
        self.lineages.lock().unwrap().get(&hash).map(|lineage| {
            (
                lineage.history.head.counter,
                lineage.history.head.commitment,
            )
        })
    }

    /// Roll every replica back to the previous head (correlated three-replica rollback).
    pub fn roll_back_all(&self, request_bytes: &[u8]) {
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
    pub fn advance_foreign(&self, request_bytes: &[u8]) {
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

    pub fn revoke(&self, request_bytes: &[u8]) {
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

    pub fn respond(&self, request_bytes: &[u8]) -> Result<Vec<u8>, TestWitnessUnavailable> {
        self.respond_count.fetch_add(1, Ordering::SeqCst);
        if *self.unavailable.lock().unwrap() {
            return Err(TestWitnessUnavailable);
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
