// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import {
  BrowserReplicaTrust,
  create_device_endpoint as createDeviceEndpoint,
  open_device_endpoint as openDeviceEndpoint,
} from "../wasm/axl_e2ee_browser.js";
import { ProductionBrowserStore } from "./storage.js";

const MAX_CERTIFICATE_BYTES = 3_072;
const MAX_ENVELOPE_BYTES = 65_497;
const MAX_APPLICATION_BYTES = 60_000;
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_CONTROL_BYTES = 2 * 1024;

function failure(code) {
  return new Error(`AXL_E2EE:${code}`);
}

function bytes(value, minimum, maximum) {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw failure(value instanceof Uint8Array ? "bound_exceeded" : "invalid_argument");
  }
  return new Uint8Array(value);
}

function id(value) {
  return bytes(value, 16, 16);
}

function counter(value) {
  if (typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw failure("invalid_argument");
  }
  return value;
}

function same(left, right) {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function now() {
  const value = Date.now();
  if (!Number.isSafeInteger(value) || value < 0) throw failure("clock_rollback");
  return value;
}

function pendingView(pending) {
  try {
    return Object.freeze({
      operationId: pending.operation_id(),
      witnessRequest: pending.witness_request(),
      requestHash: pending.request_hash(),
      kind: pending.kind(),
      status: "pending_quorum",
    });
  } finally {
    pending.free();
  }
}

function resultView(result) {
  try {
    const tag = result.tag();
    const view = { tag, status: "completed" };
    const bytesValue = result.bytes();
    if (bytesValue !== undefined) view.bytes = bytesValue;
    const logicalMessageId = result.logical_message_id();
    if (logicalMessageId !== undefined) view.logicalMessageId = logicalMessageId;
    const messageClass = result.message_class();
    if (messageClass !== undefined) view.messageClass = messageClass;
    const epoch = result.epoch();
    if (epoch !== undefined) view.epoch = epoch;
    const hostedGeneration = result.hosted_generation();
    if (hostedGeneration !== undefined) view.hostedGeneration = hostedGeneration;
    const commitId = result.commit_id();
    if (commitId !== undefined) view.commitId = commitId;
    const epochAuthenticator = result.epoch_authenticator();
    if (epochAuthenticator !== undefined) view.epochAuthenticator = epochAuthenticator;
    const removal = result.removal();
    if (removal !== undefined) view.removal = removal;
    return Object.freeze(view);
  } finally {
    result.free();
  }
}

/**
 * Worker-private browser device endpoint over the atomic witness barrier.
 *
 * The Rust endpoint owns the witness state machine, the authenticated committed image, duplicate
 * lookup, the exact-result index, and the output gate. The store owns IndexedDB and WebCrypto.
 * This class only sequences them: every mutation yields zero or one Rust transition, the store
 * seals and durably commits it, the Rust endpoint adopts it, and the exact typed result leaves
 * Rust only after the certificate verified, the successor key was rechecked active, and the
 * obsolete key was erased and observed absent.
 *
 * Any failure or uncertainty after a durable transaction may have started destroys this object.
 * Later calls fail with `recovery_required`; recovery reopens from committed IndexedDB data.
 */
export class BrowserDeviceEndpoint {
  #store;
  #endpoint;
  #closedCode;

  static async create({ accountId, installationId, deviceId, cryptoSessionId, trust, operationId }) {
    if (!(trust instanceof BrowserReplicaTrust)) throw failure("invalid_argument");
    const session = id(cryptoSessionId);
    const instance = new BrowserDeviceEndpoint();
    instance.#store = new ProductionBrowserStore(session, () => instance.#lost());
    await instance.#store.create();
    let created;
    let transition;
    try {
      created = createDeviceEndpoint(
        id(accountId),
        id(installationId),
        id(deviceId),
        session,
        trust,
        id(operationId),
        now(),
      );
      instance.#endpoint = created.take_endpoint();
      transition = created.take_transition();
    } catch (cause) {
      await instance.#destroy("endpoint_closed");
      throw cause;
    } finally {
      created?.free();
    }
    return { endpoint: instance, pending: await instance.#commit(transition) };
  }

  static async open({ cryptoSessionId, trust }) {
    if (!(trust instanceof BrowserReplicaTrust)) throw failure("invalid_argument");
    const session = id(cryptoSessionId);
    const instance = new BrowserDeviceEndpoint();
    instance.#store = new ProductionBrowserStore(session, () => instance.#lost());
    try {
      await instance.#store.open();
      instance.#endpoint = openDeviceEndpoint(session, trust);
      await instance.#restore();
    } catch (cause) {
      await instance.#destroy("endpoint_closed");
      throw cause;
    }
    return instance;
  }

  /** Decrypt the one committed record and let Rust authenticate and adopt it. */
  async #restore() {
    const unsealed = await this.#store.unsealCurrent();
    let pending;
    try {
      pending = this.#endpoint.restore(
        unsealed.record,
        unsealed.innerPlaintext,
        unsealed.outerPlaintext,
        unsealed.operation.disposition,
        unsealed.metadata.generation,
        unsealed.metadata.confirmedCounter,
        unsealed.metadata.confirmedCommitment,
        unsealed.metadata.previousCertificateHash,
      );
      if ((pending !== undefined) !== (unsealed.operation.disposition === "pending")) {
        throw failure("corrupt_state");
      }
      if (pending !== undefined) {
        // The stored row is a cache of the signed request inside the authenticated record. It is
        // never transported unless it matches that record byte for byte.
        if (
          !same(pending.operation_id(), unsealed.operation.operationId) ||
          !same(pending.witness_request(), unsealed.operation.witnessRequest) ||
          !same(pending.request_hash(), unsealed.operation.requestHash)
        ) {
          throw failure("corrupt_state");
        }
        // The store activated or verified the successor key before decrypting anything.
        this.#endpoint.mark_current_key_active();
      }
    } finally {
      pending?.free();
      unsealed.innerPlaintext.fill(0);
      unsealed.outerPlaintext.fill(0);
    }
  }

  #guard() {
    if (this.#closedCode) throw failure(this.#closedCode);
    if (!this.#endpoint || !this.#store) throw failure("endpoint_closed");
  }

  #lost() {
    if (!this.#closedCode) void this.#destroy("recovery_required");
  }

  async #destroy(code) {
    if (this.#closedCode) return;
    this.#closedCode = code;
    this.#endpoint?.free();
    this.#endpoint = undefined;
    const store = this.#store;
    this.#store = undefined;
    await store?.close();
  }

  /** After a Rust error, persist any terminal decision it recorded. */
  async #persistTerminal() {
    const terminal = this.#endpoint?.take_unpersisted_terminal();
    if (terminal === undefined) return;
    await this.#store.quarantine(terminal);
  }

  async #rust(run) {
    this.#guard();
    try {
      return run();
    } catch (cause) {
      await this.#persistTerminal();
      throw cause;
    }
  }

  /** Seal, durably commit, adopt, and activate one fresh transition. */
  async #commit(transition) {
    let committed;
    try {
      try {
        committed = await this.#store.commit(transition);
      } catch (cause) {
        // Abort, conflict, lock loss, or ambiguous completion: the durable outcome is unknown to
        // this object. Destroy the transient endpoint; recovery reloads committed data.
        this.#endpoint?.discard_candidate();
        await this.#destroy("recovery_required");
        throw cause;
      }
      try {
        this.#endpoint.local_commit_complete(committed);
        this.#endpoint.mark_current_key_active();
      } catch (cause) {
        await this.#destroy("recovery_required");
        throw cause;
      }
      const pending = this.#endpoint.pending_witness();
      if (pending === undefined) throw failure("internal_error");
      return pendingView(pending);
    } finally {
      committed?.free();
    }
  }

  /** Run one mutation: exact duplicate pending, exact duplicate released, or a fresh commit. */
  async #mutate(run) {
    const outcome = await this.#rust(run);
    try {
      const kind = outcome.kind();
      if (kind === "pending") return pendingView(outcome.take_pending());
      if (kind === "released") return resultView(outcome.take_result());
      return await this.#commit(outcome.take_transition());
    } finally {
      outcome.free();
    }
  }

  async witnessReadRequest() {
    return this.#rust(() => this.#endpoint.witness_read_request());
  }

  async reconcileWitness(certificate) {
    const certificateBytes = bytes(certificate, 1, MAX_CERTIFICATE_BYTES);
    const json = await this.#rust(() => this.#endpoint.reconcile_witness(certificateBytes));
    await this.#persistTerminal();
    return Object.freeze(JSON.parse(json));
  }

  async pendingWitness() {
    const pending = await this.#rust(() => this.#endpoint.pending_witness());
    return pending === undefined ? null : pendingView(pending);
  }

  /**
   * Fixed order: certificate verified against the exact pending request in Rust, successor key
   * rechecked active and obsolete key erased and observed absent in one strict transaction,
   * erasure reported to Rust, and only then the exact typed result.
   */
  async continueWitness(operationId, certificate) {
    const operation = id(operationId);
    const certificateBytes = bytes(certificate, 1, MAX_CERTIFICATE_BYTES);
    this.#guard();
    const pending = this.#endpoint.pending_witness();
    if (pending === undefined) throw failure("fresh_witness_required");
    try {
      if (!same(pending.operation_id(), operation)) throw failure("not_found");
    } finally {
      pending.free();
    }
    await this.#rust(() => this.#endpoint.confirm_quorum(certificateBytes));
    let head;
    try {
      head = this.#endpoint.completion_head();
      await this.#store.complete(operation, {
        confirmedCounter: head.counter(),
        confirmedCommitment: head.commitment(),
        previousCertificateHash: head.certificate_hash(),
      });
    } catch (cause) {
      // The completion transaction may or may not have committed. Recovery reopens and either
      // finds the row completed or resends the exact pending request.
      await this.#destroy("recovery_required");
      throw cause;
    } finally {
      head?.free();
    }
    this.#endpoint.mark_obsolete_key_erased();
    return resultView(this.#endpoint.release());
  }

  async join(operationId, welcome, groupId) {
    const operation = id(operationId);
    const welcomeBytes = bytes(welcome, 1, MAX_HANDSHAKE_BYTES);
    const group = bytes(groupId, 32, 32);
    return this.#mutate(() => this.#endpoint.join(operation, welcomeBytes, group, now()));
  }

  async prepareActivation(operationId, logicalMessageId, plaintext) {
    const operation = id(operationId);
    const logical = id(logicalMessageId);
    const payload = bytes(plaintext, 1, MAX_CONTROL_BYTES);
    return this.#mutate(() =>
      this.#endpoint.prepare_activation(operation, logical, payload, now()),
    );
  }

  async prepareApplication(operationId, logicalMessageId, hostedGeneration, plaintext) {
    const operation = id(operationId);
    const logical = id(logicalMessageId);
    const generation = counter(hostedGeneration);
    const payload = bytes(plaintext, 1, MAX_APPLICATION_BYTES);
    return this.#mutate(() =>
      this.#endpoint.prepare_application(operation, logical, generation, payload, now()),
    );
  }

  async receiveApplication(operationId, logicalMessageId, hostedGeneration, ciphertext) {
    const operation = id(operationId);
    const logical = id(logicalMessageId);
    const generation = counter(hostedGeneration);
    const envelope = bytes(ciphertext, 1, MAX_ENVELOPE_BYTES);
    return this.#mutate(() =>
      this.#endpoint.receive_application(operation, logical, generation, envelope, now()),
    );
  }

  async prepareReplacement(operationId, logicalMessageId, hostedGeneration) {
    const operation = id(operationId);
    const logical = id(logicalMessageId);
    const generation = counter(hostedGeneration);
    return this.#mutate(() =>
      this.#endpoint.prepare_replacement(operation, logical, generation, now()),
    );
  }

  async applyUpdateCommit(operationId, logicalMessageId, hostedGeneration, ciphertext) {
    const operation = id(operationId);
    const logical = id(logicalMessageId);
    const generation = counter(hostedGeneration);
    const envelope = bytes(ciphertext, 1, MAX_ENVELOPE_BYTES);
    return this.#mutate(() =>
      this.#endpoint.apply_update_commit(operation, logical, generation, envelope, now()),
    );
  }

  async prepareEpochReady(operationId, logicalMessageId, hostedGeneration, commit) {
    const operation = id(operationId);
    const logical = id(logicalMessageId);
    const generation = counter(hostedGeneration);
    if (commit === null || typeof commit !== "object") {
      throw failure("invalid_argument");
    }
    const commitId = bytes(commit.commitId, 48, 48);
    const targetEpoch = counter(commit.targetEpoch);
    const epochAuthenticator = bytes(commit.epochAuthenticator, 48, 48);
    return this.#mutate(() =>
      this.#endpoint.prepare_epoch_ready(
        operation,
        logical,
        generation,
        commitId,
        targetEpoch,
        epochAuthenticator,
        now(),
      ),
    );
  }

  async acceptEpochReadyConfirmation(operationId, logicalMessageId, hostedGeneration, ciphertext) {
    const operation = id(operationId);
    const logical = id(logicalMessageId);
    const generation = counter(hostedGeneration);
    const envelope = bytes(ciphertext, 1, MAX_ENVELOPE_BYTES);
    return this.#mutate(() =>
      this.#endpoint.accept_epoch_ready_confirmation(
        operation,
        logical,
        generation,
        envelope,
        now(),
      ),
    );
  }

  async applyRemoval(operationId, logicalMessageId, hostedGeneration, ciphertext) {
    const operation = id(operationId);
    const logical = id(logicalMessageId);
    const generation = counter(hostedGeneration);
    const envelope = bytes(ciphertext, 1, MAX_ENVELOPE_BYTES);
    return this.#mutate(() =>
      this.#endpoint.apply_removal(operation, logical, generation, envelope, now()),
    );
  }

  async close() {
    await this.#destroy("endpoint_closed");
  }
}
