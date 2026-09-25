// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { WorkerWitnessBarrier } from "./barrier.js";
import { BrowserDeviceEndpoint } from "./endpoint.js";
import { loadReplicaTrust } from "./trust.js";
import initializeWasm, {
  get_binding_info_json as bindingInfoJson,
  inspect_pairing_claim as inspectClaim,
  inspect_pairing_invitation as inspectInvitation,
  secure_random_check as secureRandomCheck,
} from "../wasm/axl_e2ee_browser.js";

// Replica trust comes only from `trust.js`. The production build ships a module that returns no
// trust, because build-pinned production replica trust is a later production gate; every endpoint
// operation then fails with `rollback_anchor_unavailable`. The endpoint module accepts only
// Rust-owned replica trust and Rust-finalized transitions, and the witness barrier runs inside
// this worker, so page code never receives storage, key, transition, witness, or verifier
// authority: only exact released results.

const BYTE_OPERATIONS = Object.freeze({
  inspect_invitation: 2048,
  inspect_claim: 17320,
});

const ID = Object.freeze({ kind: "bytes", min: 16, max: 16 });
const HASH = Object.freeze({ kind: "bytes", min: 48, max: 48 });
const ENVELOPE = Object.freeze({ kind: "bytes", min: 1, max: 65_497 });
const COUNTER = Object.freeze({ kind: "counter" });

/**
 * Parameters of every endpoint operation the page may request. Each mutation runs the complete
 * witness barrier inside this worker and answers with the exact released result only.
 */
const ENDPOINT_OPERATIONS = Object.freeze({
  authorize_witness: { authorization: { kind: "text", max: 16_384 } },
  create_device_endpoint: {
    accountId: ID,
    installationId: ID,
    deviceId: ID,
    cryptoSessionId: ID,
    operationId: ID,
  },
  open_device_endpoint: { cryptoSessionId: ID },
  close_device_endpoint: {},
  pairing_claim: { invitation: { kind: "bytes", min: 1, max: 2048 } },
  join_published: { operationId: ID, welcome: { kind: "bytes", min: 1, max: 16 * 1024 } },
  prepare_pair_activation: {
    operationId: ID,
    logicalMessageId: ID,
    claim: { kind: "bytes", min: 1, max: 17_320 },
  },
  prepare_application: {
    operationId: ID,
    logicalMessageId: ID,
    hostedGeneration: COUNTER,
    plaintext: { kind: "bytes", min: 1, max: 60_000 },
  },
  receive_application: {
    operationId: ID,
    logicalMessageId: ID,
    hostedGeneration: COUNTER,
    ciphertext: ENVELOPE,
  },
  prepare_replacement: { operationId: ID, logicalMessageId: ID, hostedGeneration: COUNTER },
  apply_update_commit: {
    operationId: ID,
    logicalMessageId: ID,
    hostedGeneration: COUNTER,
    ciphertext: ENVELOPE,
  },
  prepare_epoch_ready: {
    operationId: ID,
    logicalMessageId: ID,
    hostedGeneration: COUNTER,
    commitId: HASH,
    targetEpoch: COUNTER,
    epochAuthenticator: HASH,
  },
  accept_epoch_ready_confirmation: {
    operationId: ID,
    logicalMessageId: ID,
    hostedGeneration: COUNTER,
    ciphertext: ENVELOPE,
  },
  apply_removal: {
    operationId: ID,
    logicalMessageId: ID,
    hostedGeneration: COUNTER,
    ciphertext: ENVELOPE,
  },
});
/** Daemon endpoints never run in a browser. */
const DAEMON_OPERATIONS = new Set(["create_daemon_endpoint", "open_daemon_endpoint"]);
const FATAL_CODES = new Set([
  "artifact_integrity_failed",
  "internal_error",
  "secure_random_unavailable",
]);

function codeFrom(cause, fallback = "internal_error") {
  const message = String(cause);
  const match = /AXL_E2EE:([a-z0-9_]+)/u.exec(message);
  return match?.[1] ?? fallback;
}

function hex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function invalid() {
  return new Error("AXL_E2EE:invalid_argument");
}

function endpointParameters(schema, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw invalid();
  if (!exactKeys(params, Object.keys(schema))) throw invalid();
  for (const [name, rule] of Object.entries(schema)) {
    const value = params[name];
    if (rule.kind === "text") {
      if (typeof value !== "string" || value.length === 0 || value.length > rule.max) throw invalid();
    } else if (rule.kind === "counter") {
      if (typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn) throw invalid();
    } else {
      if (!(value instanceof Uint8Array)) throw invalid();
      if (value.byteLength < rule.min || value.byteLength > rule.max) {
        throw new Error("AXL_E2EE:bound_exceeded");
      }
    }
  }
  return params;
}

function request(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid();
  const { id, operation } = data;
  if (!Number.isSafeInteger(id) || id < 1 || typeof operation !== "string") throw invalid();
  const maximum = Object.hasOwn(BYTE_OPERATIONS, operation) ? BYTE_OPERATIONS[operation] : undefined;
  if (maximum !== undefined) {
    if (!exactKeys(data, ["bytes", "id", "operation"])) throw invalid();
    if (!(data.bytes instanceof Uint8Array)) throw invalid();
    if (data.bytes.byteLength > maximum) throw new Error("AXL_E2EE:bound_exceeded");
    return { id, operation, bytes: data.bytes };
  }
  if (Object.hasOwn(ENDPOINT_OPERATIONS, operation)) {
    if (!exactKeys(data, ["id", "operation", "params"])) throw invalid();
    // Parameters are validated after the trust check, so a build without trust answers every
    // endpoint operation with `rollback_anchor_unavailable` regardless of its input.
    return { id, operation, params: data.params };
  }
  if (!exactKeys(data, ["id", "operation"])) throw invalid();
  if (operation !== "binding_info" && !DAEMON_OPERATIONS.has(operation)) throw invalid();
  return { id, operation };
}

async function start() {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("AXL_E2EE:secure_random_unavailable");
  }
  if (typeof globalThis.crypto?.subtle?.digest !== "function") {
    throw new Error("AXL_E2EE:artifact_integrity_failed");
  }
  const root = new URL("../", import.meta.url);
  const manifestResponse = await fetch(new URL("integrity.json", root), {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!manifestResponse.ok) throw new Error("AXL_E2EE:artifact_integrity_failed");
  const manifest = await manifestResponse.json();
  const wasmEntry = manifest.artifacts?.find((entry) => entry.kind === "wasm");
  if (
    !wasmEntry ||
    typeof wasmEntry.path !== "string" ||
    !/^wasm\/[a-z0-9_.-]+\.wasm$/u.test(wasmEntry.path) ||
    typeof wasmEntry.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(wasmEntry.sha256)
  ) {
    throw new Error("AXL_E2EE:artifact_integrity_failed");
  }
  const wasmResponse = await fetch(new URL(wasmEntry.path, root), {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!wasmResponse.ok) throw new Error("AXL_E2EE:artifact_integrity_failed");
  const wasmBytes = await wasmResponse.arrayBuffer();
  const digest = hex(await globalThis.crypto.subtle.digest("SHA-256", wasmBytes));
  if (digest !== wasmEntry.sha256) throw new Error("AXL_E2EE:artifact_integrity_failed");
  await initializeWasm({ module_or_path: wasmBytes });
  secureRandomCheck();
  return loadReplicaTrust(manifest, root);
}

const ready = start().then(
  (trust) => ({ ok: true, trust }),
  (cause) => ({ ok: false, code: codeFrom(cause, "artifact_integrity_failed") }),
);
let fatalCode;
/** The one device endpoint this worker owns, and the serialization of every call into it. */
let endpoint;
let endpointTail = Promise.resolve();
const barrier = new WorkerWitnessBarrier();

function openEndpoint() {
  if (!endpoint) throw new Error("AXL_E2EE:endpoint_closed");
  return endpoint;
}

function mutate(run) {
  return barrier.mutate(openEndpoint(), run);
}

async function runEndpoint(operation, input, trust) {
  if (trust === undefined) throw new Error("AXL_E2EE:rollback_anchor_unavailable");
  const params = endpointParameters(ENDPOINT_OPERATIONS[operation], input);
  switch (operation) {
    case "authorize_witness":
      barrier.authorize(params.authorization);
      return null;
    case "create_device_endpoint": {
      if (endpoint) throw new Error("AXL_E2EE:already_exists");
      const created = await BrowserDeviceEndpoint.create({ ...params, trust });
      endpoint = created.endpoint;
      try {
        await barrier.register(endpoint, created.pending);
      } catch (cause) {
        // The pending registration stays committed. Release the endpoint so the page can reopen
        // it; the first call after reopening recovers and completes the registration.
        const current = endpoint;
        endpoint = undefined;
        await current.close().catch(() => undefined);
        throw cause;
      }
      return null;
    }
    case "open_device_endpoint":
      if (endpoint) throw new Error("AXL_E2EE:already_exists");
      endpoint = await BrowserDeviceEndpoint.open({ cryptoSessionId: params.cryptoSessionId, trust });
      return null;
    case "close_device_endpoint": {
      const current = endpoint;
      endpoint = undefined;
      await current?.close();
      return null;
    }
    case "pairing_claim": {
      const current = openEndpoint();
      // A claim is signed only by an endpoint whose confirmed head is witness authority.
      await barrier.recover(current);
      return current.pairingClaim(params.invitation);
    }
    case "join_published":
      return mutate((current) => current.joinPublished(params.operationId, params.welcome));
    case "prepare_pair_activation":
      return mutate((current) =>
        current.preparePairActivation(params.operationId, params.logicalMessageId, params.claim),
      );
    case "prepare_application":
      return mutate((current) =>
        current.prepareApplication(
          params.operationId,
          params.logicalMessageId,
          params.hostedGeneration,
          params.plaintext,
        ),
      );
    case "receive_application":
      return mutate((current) =>
        current.receiveApplication(
          params.operationId,
          params.logicalMessageId,
          params.hostedGeneration,
          params.ciphertext,
        ),
      );
    case "prepare_replacement":
      return mutate((current) =>
        current.prepareReplacement(
          params.operationId,
          params.logicalMessageId,
          params.hostedGeneration,
        ),
      );
    case "apply_update_commit":
      return mutate((current) =>
        current.applyUpdateCommit(
          params.operationId,
          params.logicalMessageId,
          params.hostedGeneration,
          params.ciphertext,
        ),
      );
    case "prepare_epoch_ready":
      return mutate((current) =>
        current.prepareEpochReady(
          params.operationId,
          params.logicalMessageId,
          params.hostedGeneration,
          {
            commitId: params.commitId,
            targetEpoch: params.targetEpoch,
            epochAuthenticator: params.epochAuthenticator,
          },
        ),
      );
    case "accept_epoch_ready_confirmation":
      return mutate((current) =>
        current.acceptEpochReadyConfirmation(
          params.operationId,
          params.logicalMessageId,
          params.hostedGeneration,
          params.ciphertext,
        ),
      );
    case "apply_removal":
      return mutate((current) =>
        current.applyRemoval(
          params.operationId,
          params.logicalMessageId,
          params.hostedGeneration,
          params.ciphertext,
        ),
      );
    default:
      throw new Error("AXL_E2EE:invalid_argument");
  }
}

function scrub(value) {
  if (value instanceof Uint8Array) {
    value.fill(0);
    return;
  }
  if (value && typeof value === "object") for (const entry of Object.values(value)) scrub(entry);
}

self.addEventListener("message", async ({ data }) => {
  let id = Number.isSafeInteger(data?.id) && data.id > 0 ? data.id : 0;
  let validated;
  try {
    if (fatalCode) throw new Error(`AXL_E2EE:${fatalCode}`);
    validated = request(data);
    ({ id } = validated);
    const initialization = await ready;
    if (!initialization.ok) throw new Error(`AXL_E2EE:${initialization.code}`);
    let value;
    if (validated.operation === "binding_info") value = JSON.parse(bindingInfoJson());
    else if (validated.operation === "inspect_invitation") {
      value = JSON.parse(inspectInvitation(validated.bytes));
    } else if (validated.operation === "inspect_claim") {
      value = JSON.parse(inspectClaim(validated.bytes));
    } else if (DAEMON_OPERATIONS.has(validated.operation)) {
      throw new Error("AXL_E2EE:rollback_anchor_unavailable");
    } else {
      const run = endpointTail.then(() =>
        runEndpoint(validated.operation, validated.params, initialization.trust),
      );
      endpointTail = run.catch(() => undefined);
      value = await run;
    }
    self.postMessage({ id, ok: true, value });
  } catch (cause) {
    const code = codeFrom(cause);
    const fatal = FATAL_CODES.has(code);
    if (fatal) fatalCode = code;
    self.postMessage({ id, ok: false, code, fatal });
    if (fatal) self.close();
  } finally {
    // Page-provided inputs were copied by the endpoint; clear the transferred originals.
    scrub(validated?.bytes);
    scrub(validated?.params);
    validated = undefined;
  }
});
