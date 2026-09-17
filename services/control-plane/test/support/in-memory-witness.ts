// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { type WitnessReplicaReceipt, witnessBytesEqual, witnessBytesHex } from "@axl/protocol";
import type {
  WitnessHighWaterEntry,
  WitnessHighWaterJournal,
  WitnessReplicaRecord,
  WitnessReplicaStorage,
  WitnessReplicaTransaction,
} from "../../src/witness.ts";

export type InMemoryDurabilityFault = "fail" | "uncertain_before" | "uncertain_after";

function cloneBytes(value: Uint8Array): Uint8Array {
  return value.slice();
}

function cloneRecord(record: WitnessReplicaRecord): WitnessReplicaRecord {
  return structuredClone(record) as WitnessReplicaRecord;
}

export class InMemoryWitnessReplicaStorage implements WitnessReplicaStorage {
  readonly #records = new Map<string, WitnessReplicaRecord>();
  readonly #queues = new Map<string, Promise<void>>();
  #nextFault: InMemoryDurabilityFault | undefined;

  failNext(fault: InMemoryDurabilityFault): void {
    this.#nextFault = fault;
  }

  async transact<T>(
    lineageHash: Uint8Array,
    transaction: (current: WitnessReplicaRecord | undefined) => WitnessReplicaTransaction<T>,
  ): Promise<T> {
    const key = witnessBytesHex(lineageHash);
    const prior = this.#queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => next);
    this.#queues.set(key, queued);
    await prior;
    try {
      const current = this.#records.get(key);
      const outcome = transaction(current === undefined ? undefined : cloneRecord(current));
      const fault = this.#nextFault;
      this.#nextFault = undefined;
      if (fault === "fail" || fault === "uncertain_before")
        throw new Error(`in-memory storage ${fault}`);
      if (outcome.next !== undefined) this.#records.set(key, cloneRecord(outcome.next));
      if (fault === "uncertain_after") throw new Error("in-memory storage uncertain_after");
      return structuredClone(outcome.value) as T;
    } finally {
      release();
      if (this.#queues.get(key) === queued) this.#queues.delete(key);
    }
  }

  async listLineageHashes(): Promise<readonly Uint8Array[]> {
    return [...this.#records.values()].map((record) => cloneBytes(record.lineageHash));
  }

  async read(lineageHash: Uint8Array): Promise<WitnessReplicaRecord | undefined> {
    const record = this.#records.get(witnessBytesHex(lineageHash));
    return record === undefined ? undefined : cloneRecord(record);
  }

  corruptDerivedHead(lineageHash: Uint8Array, receipt: WitnessReplicaReceipt): void {
    const key = witnessBytesHex(lineageHash);
    const record = this.#records.get(key);
    if (record === undefined) throw new Error("lineage is absent");
    this.#records.set(key, {
      ...record,
      derivedHead: {
        counter: receipt.counter + 1n,
        commitment: cloneBytes(receipt.commitment),
        predecessorCommitment: cloneBytes(receipt.predecessorCommitment),
      },
    });
  }

  removeLastLedgerEvent(lineageHash: Uint8Array): void {
    const key = witnessBytesHex(lineageHash);
    const record = this.#records.get(key);
    if (record === undefined) throw new Error("lineage is absent");
    this.#records.set(key, { ...record, ledger: record.ledger.slice(0, -1) });
  }
}

export class InMemoryWitnessHighWaterJournal implements WitnessHighWaterJournal {
  readonly #entries = new Map<string, WitnessHighWaterEntry[]>();
  #nextFault: InMemoryDurabilityFault | undefined;

  failNext(fault: InMemoryDurabilityFault): void {
    this.#nextFault = fault;
  }

  async append(entry: WitnessHighWaterEntry): Promise<void> {
    const key = witnessBytesHex(entry.lineageHash);
    const entries = this.#entries.get(key) ?? [];
    const existing = entries.find((candidate) => candidate.sequence === entry.sequence);
    if (existing !== undefined) {
      if (
        existing.counter !== entry.counter ||
        existing.revocationGeneration !== entry.revocationGeneration ||
        !witnessBytesEqual(existing.commitment, entry.commitment) ||
        !witnessBytesEqual(existing.eventHash, entry.eventHash)
      ) {
        throw new Error("immutable journal conflict");
      }
      return;
    }
    const previous = entries.at(-1);
    if (entry.sequence !== (previous?.sequence ?? 0n) + 1n)
      throw new Error("immutable journal gap");
    const fault = this.#nextFault;
    this.#nextFault = undefined;
    if (fault === "fail" || fault === "uncertain_before")
      throw new Error(`in-memory journal ${fault}`);
    entries.push(structuredClone(entry) as WitnessHighWaterEntry);
    this.#entries.set(key, entries);
    if (fault === "uncertain_after") throw new Error("in-memory journal uncertain_after");
  }

  async latest(lineageHash: Uint8Array): Promise<WitnessHighWaterEntry | undefined> {
    const entry = this.#entries.get(witnessBytesHex(lineageHash))?.at(-1);
    return entry === undefined ? undefined : (structuredClone(entry) as WitnessHighWaterEntry);
  }

  corruptLatest(lineageHash: Uint8Array): void {
    const entries = this.#entries.get(witnessBytesHex(lineageHash));
    if (entries === undefined) throw new Error("journal is empty");
    const latest = entries.at(-1);
    if (latest === undefined) throw new Error("journal is empty");
    entries[entries.length - 1] = {
      ...latest,
      commitment: Uint8Array.from(latest.commitment, (byte, index) =>
        index === 0 ? byte ^ 1 : byte,
      ),
    };
  }
}
