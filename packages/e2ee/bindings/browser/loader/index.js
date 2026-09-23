// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

export class AxlE2eeError extends Error {
  constructor(code) {
    super("The E2EE operation failed safely.");
    this.name = "AxlE2eeError";
    this.code = code;
    Object.freeze(this);
  }
}

export const ERROR_CODES = Object.freeze([
  "already_exists",
  "artifact_integrity_failed",
  "bound_exceeded",
  "clock_rollback",
  "conflict",
  "consumed",
  "corrupt_state",
  "endpoint_closed",
  "endpoint_revoked",
  "expired",
  "fresh_witness_required",
  "identity_mismatch",
  "internal_error",
  "invalid_argument",
  "key_record_missing",
  "lifecycle_busy",
  "not_found",
  "profile_mismatch",
  "rollback_anchor_unavailable",
  "rollback_detected",
  "secure_random_unavailable",
  "state_loss",
  "storage_unavailable",
  "strict_durability_unavailable",
  "unsupported_schema",
  "witness_auth_failed",
  "witness_conflict",
  "witness_invalid_expected",
  "witness_operation_conflict",
  "witness_receipt_invalid",
  "witness_registration_conflict",
  "witness_unavailable",
]);

const bounds = Object.freeze({ invitation: 2048, claim: 17320 });
const fatalCodes = new Set([
  "artifact_integrity_failed",
  "internal_error",
  "secure_random_unavailable",
]);
let worker;
let state = "open";
let terminalCode;
let nextRequestId = 1;
const pending = new Map();

function failure(code) {
  return new AxlE2eeError(ERROR_CODES.includes(code) ? code : "internal_error");
}

function rejectPending(code) {
  for (const entry of pending.values()) entry.reject(failure(code));
  pending.clear();
}

function terminate(code, nextState) {
  if (state === "closed") return;
  state = nextState;
  terminalCode = code;
  rejectPending(code);
  worker?.terminate();
  worker = undefined;
}

function ensureUsable() {
  if (state === "closed") throw failure("endpoint_closed");
  if (state === "fatal") throw failure(terminalCode ?? "internal_error");
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function bindingInfo(value) {
  if (
    !exactKeys(value, [
      "abiVersion",
      "productionStorageReady",
      "profileId",
      "profileRevision",
      "workerRequired",
    ]) ||
    value.abiVersion !== 1 ||
    value.profileId !== "axl-e2ee-mls-pq-v1" ||
    value.profileRevision !== 1 ||
    value.productionStorageReady !== false ||
    value.workerRequired !== true
  ) {
    throw failure("internal_error");
  }
  return Object.freeze(value);
}

function inspectionResult(value, kind) {
  if (
    !exactKeys(value, ["cryptoSessionIdHex", "kind", "profileId", "profileRevision"]) ||
    value.kind !== kind ||
    value.profileId !== "axl-e2ee-mls-pq-v1" ||
    value.profileRevision !== 1
  ) {
    throw failure("internal_error");
  }
  return Object.freeze({
    kind: value.kind,
    profileId: value.profileId,
    profileRevision: value.profileRevision,
    cryptoSessionId: fromHex(value.cryptoSessionIdHex),
  });
}

function response(data) {
  if (
    !data ||
    typeof data !== "object" ||
    !Number.isSafeInteger(data.id) ||
    data.id < 1 ||
    typeof data.ok !== "boolean"
  ) {
    throw failure("internal_error");
  }
  if (data.ok === true) {
    if (!exactKeys(data, ["id", "ok", "value"])) throw failure("internal_error");
  } else if (
    !exactKeys(data, ["code", "fatal", "id", "ok"]) ||
    typeof data.code !== "string" ||
    typeof data.fatal !== "boolean" ||
    !ERROR_CODES.includes(data.code) ||
    data.fatal !== fatalCodes.has(data.code)
  ) {
    throw failure("internal_error");
  }
  return data;
}

function handleMessage(data) {
  let validated;
  try {
    validated = response(data);
  } catch {
    terminate("internal_error", "fatal");
    return;
  }
  const entry = pending.get(validated.id);
  if (!entry) {
    terminate("internal_error", "fatal");
    return;
  }
  if (validated.ok === false && validated.fatal) {
    terminate(validated.code, "fatal");
    return;
  }
  if (validated.ok === false) {
    pending.delete(validated.id);
    entry.reject(failure(validated.code));
    return;
  }
  let value;
  try {
    value = entry.validate(validated.value);
  } catch {
    terminate("internal_error", "fatal");
    return;
  }
  pending.delete(validated.id);
  entry.resolve(value);
}

function bindingWorker() {
  ensureUsable();
  if (worker) return worker;
  try {
    worker = new Worker(new URL("../worker/index.js", import.meta.url), {
      type: "module",
      name: "axl-e2ee-browser-v1",
    });
    worker.addEventListener("message", ({ data }) => handleMessage(data));
    worker.addEventListener("error", () => terminate("internal_error", "fatal"));
    worker.addEventListener("messageerror", () => terminate("internal_error", "fatal"));
    return worker;
  } catch {
    terminate("internal_error", "fatal");
    throw failure("internal_error");
  }
}

function request(operation, bytes, validate) {
  try {
    ensureUsable();
  } catch (cause) {
    return Promise.reject(cause);
  }
  const id = nextRequestId;
  nextRequestId += 1;
  if (!Number.isSafeInteger(nextRequestId)) {
    terminate("internal_error", "fatal");
    return Promise.reject(failure("internal_error"));
  }
  const message = { id, operation };
  const transfer = [];
  if (bytes !== undefined) {
    message.bytes = bytes;
    transfer.push(bytes.buffer);
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, validate });
    try {
      bindingWorker().postMessage(message, transfer);
    } catch {
      terminate("internal_error", "fatal");
    }
  });
}

function boundedBytes(value, maximum) {
  if (!(value instanceof Uint8Array)) throw failure("invalid_argument");
  if (value.byteLength > maximum) throw failure("bound_exceeded");
  return new Uint8Array(value);
}

function fromHex(value) {
  if (typeof value !== "string" || value.length !== 32 || !/^[0-9a-f]+$/u.test(value)) {
    throw failure("internal_error");
  }
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function inspection(operation, kind, value, maximum) {
  try {
    ensureUsable();
    return request(operation, boundedBytes(value, maximum), (result) =>
      inspectionResult(result, kind),
    );
  } catch (cause) {
    return Promise.reject(cause);
  }
}

const unreachableSuccess = () => {
  throw failure("internal_error");
};

export const getBindingInfo = () => request("binding_info", undefined, bindingInfo);
export const inspectPairingInvitation = (bytes) =>
  inspection("inspect_invitation", "pairing_invitation", bytes, bounds.invitation);
export const inspectPairingClaim = (bytes) =>
  inspection("inspect_claim", "pairing_claim", bytes, bounds.claim);
export const createDaemonEndpoint = () =>
  request("create_daemon_endpoint", undefined, unreachableSuccess);
export const openDaemonEndpoint = () => request("open_daemon_endpoint", undefined, unreachableSuccess);
export const createDeviceEndpoint = () =>
  request("create_device_endpoint", undefined, unreachableSuccess);
export const openDeviceEndpoint = () => request("open_device_endpoint", undefined, unreachableSuccess);
export const closeBrowserBinding = () => {
  if (state === "closed") return;
  state = "closed";
  terminalCode = "endpoint_closed";
  rejectPending("endpoint_closed");
  worker?.terminate();
  worker = undefined;
};
