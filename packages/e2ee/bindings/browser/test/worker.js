// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import initializeWasm, {
  get_binding_info_json as bindingInfoJson,
  inspect_pairing_claim as inspectClaim,
  inspect_pairing_invitation as inspectInvitation,
  test_browser_persistence_receive as testBrowserPersistenceReceive,
  test_browser_persistence_seed as testBrowserPersistenceSeed,
  test_browser_persistence_send as testBrowserPersistenceSend,
  test_openmls_lifecycle_json as testOpenmlsLifecycleJson,
  test_openmls_negative_cases_json as testOpenmlsNegativeCasesJson,
  test_secure_random_probe as testSecureRandomProbe,
} from "../wasm/axl_e2ee_browser.js";
import { runProductionBarrierScenario } from "./barrier-scenario.js";
import {
  BrowserPersistenceEndpoint,
  createNewerStateDatabase,
  deleteTestDatabases,
  parseSeed,
  schemaUpgradeEvidence,
} from "./browser-storage.js";

const BYTE_OPERATION_LIMITS = new Map([
  ["inspect_invitation_rust_bound", 2_048],
  ["inspect_claim_rust_bound", 17_320],
]);
const CREATE_FAULTS = new Set([null, "terminate_before_commit", "ambiguous_after_commit", "terminate_after_commit"]);
const OPERATION_FAULTS = new Set([
  null,
  "terminate_before_commit",
  "generation_conflict",
  "abort_before_commit",
  "quota",
  "ambiguous_after_commit",
  "terminate_after_commit",
  "observe_completion",
]);
const TAMPER_KINDS = new Set([
  "forced_close",
  "manifest",
  "state",
  "missing",
  "schema",
  "rollback",
  "malformed",
  "unexpected",
  "cyclic",
  "oversized",
  "excessive",
]);
const OPERATION_ID_PATTERN = /^[0-9a-f]{32}$/u;
const textEncoder = new TextEncoder();

function codeFrom(cause, fallback = "internal_error") {
  if (typeof cause?.code === "string" && /^[a-z0-9_]+$/u.test(cause.code)) return cause.code;
  const match = /AXL_E2EE:([a-z0-9_]+)/u.exec(String(cause));
  return match?.[1] ?? fallback;
}

function hex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactByteArray(value) {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (
      !Object.hasOwn(value, index) ||
      !Number.isInteger(value[index]) ||
      value[index] < 0 ||
      value[index] > 255
    ) {
      return false;
    }
  }
  return true;
}

function persistenceRequest(data) {
  const { operation } = data;
  if (operation === "persistence_create") {
    if (
      !exactKeys(data, ["fault", "id", "operation", "receive"]) ||
      typeof data.receive !== "boolean" ||
      !CREATE_FAULTS.has(data.fault)
    ) {
      throw new Error("AXL_E2EE:invalid_argument");
    }
    return data;
  }
  if (
    [
      "persistence_open",
      "persistence_delete",
      "persistence_upgrade",
      "persistence_newer_schema",
    ].includes(operation)
  ) {
    if (!exactKeys(data, ["id", "operation", "receive"]) || typeof data.receive !== "boolean") {
      throw new Error("AXL_E2EE:invalid_argument");
    }
    return data;
  }
  if (operation === "persistence_operate") {
    if (
      !exactKeys(data, ["fault", "id", "operation", "operationId", "payload"]) ||
      typeof data.operationId !== "string" ||
      !OPERATION_ID_PATTERN.test(data.operationId) ||
      !(typeof data.payload === "string" || Array.isArray(data.payload)) ||
      !OPERATION_FAULTS.has(data.fault)
    ) {
      throw new Error("AXL_E2EE:invalid_argument");
    }
    if (typeof data.payload === "string") {
      if (data.payload.length === 0 || data.payload.length > 60_000) {
        throw new Error("AXL_E2EE:bound_exceeded");
      }
      const length = textEncoder.encode(data.payload).byteLength;
      if (length === 0 || length > 60_000) throw new Error("AXL_E2EE:bound_exceeded");
    } else {
      if (data.payload.length === 0) throw new Error("AXL_E2EE:invalid_argument");
      if (data.payload.length > 65_497) throw new Error("AXL_E2EE:bound_exceeded");
      if (!exactByteArray(data.payload)) throw new Error("AXL_E2EE:invalid_argument");
    }
    return data;
  }
  if (operation === "persistence_tamper") {
    if (
      !exactKeys(data, ["id", "kind", "operation"]) ||
      typeof data.kind !== "string" ||
      !TAMPER_KINDS.has(data.kind)
    ) {
      throw new Error("AXL_E2EE:invalid_argument");
    }
    return data;
  }
  if (operation === "persistence_callback_exception" || operation === "persistence_close") {
    if (!exactKeys(data, ["id", "operation"])) throw new Error("AXL_E2EE:invalid_argument");
    return data;
  }
  return undefined;
}

function request(data) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !Number.isSafeInteger(data.id) ||
    data.id < 1 ||
    typeof data.operation !== "string"
  ) {
    throw new Error("AXL_E2EE:invalid_argument");
  }
  const persistence = persistenceRequest(data);
  if (persistence) return persistence;
  if (BYTE_OPERATION_LIMITS.has(data.operation)) {
    if (
      !exactKeys(data, ["bytes", "id", "operation"]) ||
      !(data.bytes instanceof Uint8Array) ||
      data.bytes.byteLength > BYTE_OPERATION_LIMITS.get(data.operation)
    ) {
      throw new Error(
        data.bytes instanceof Uint8Array ? "AXL_E2EE:bound_exceeded" : "AXL_E2EE:invalid_argument",
      );
    }
  } else if (data.bytes !== undefined || !exactKeys(data, ["id", "operation"])) {
    throw new Error("AXL_E2EE:invalid_argument");
  }
  if (
    !BYTE_OPERATION_LIMITS.has(data.operation) &&
    ![
      "binding_info",
      "openmls_lifecycle",
      "openmls_negative_cases",
      "production_barrier_scenario",
      "secure_random_probe",
    ].includes(data.operation)
  ) {
    throw new Error("AXL_E2EE:invalid_argument");
  }
  return data;
}

async function start() {
  const root = new URL("../", import.meta.url);
  const manifest = await (await fetch(new URL("integrity.json", root))).json();
  const wasmEntry = manifest.artifacts.find((entry) => entry.kind === "wasm");
  const wasmBytes = await (await fetch(new URL(wasmEntry.path, root))).arrayBuffer();
  const digest = hex(await crypto.subtle.digest("SHA-256", wasmBytes));
  if (digest !== wasmEntry.sha256) throw new Error("AXL_E2EE:artifact_integrity_failed");
  const exports = await initializeWasm({ module_or_path: wasmBytes });
  if (new URL(import.meta.url).searchParams.get("secureRandom") === "unavailable") {
    Object.defineProperty(globalThis.crypto, "getRandomValues", { value: undefined });
  }
  return exports;
}

const ready = start();
let persistenceEndpoint;
let persistenceReceive;

function sessionId(receive) {
  return new Uint8Array(16).fill(receive ? 0xb2 : 0xb1);
}

function endpoint(receive) {
  if (persistenceEndpoint) {
    if (persistenceReceive !== receive) throw new Error("AXL_E2EE:invalid_argument");
    return persistenceEndpoint;
  }
  persistenceReceive = receive;
  persistenceEndpoint = new BrowserPersistenceEndpoint({
    sessionId: sessionId(receive),
    receive,
    unavailable: new URL(import.meta.url).searchParams.get("indexedDb") === "unavailable",
    seedFactory: () => parseSeed(testBrowserPersistenceSeed(Date.now(), receive)),
    transition: receive ? testBrowserPersistenceReceive : testBrowserPersistenceSend,
    notify: (value) => self.postMessage(value),
    terminate: () => self.close(),
  });
  return persistenceEndpoint;
}

self.addEventListener("message", async ({ data }) => {
  const id = Number.isSafeInteger(data?.id) ? data.id : 0;
  let bytes;
  try {
    const validated = request(data);
    bytes = validated.bytes;
    const exports = await ready;
    let value;
    if (validated.operation === "binding_info") value = JSON.parse(bindingInfoJson());
    else if (validated.operation === "inspect_invitation_rust_bound") {
      value = JSON.parse(inspectInvitation(bytes));
    } else if (validated.operation === "inspect_claim_rust_bound") {
      value = JSON.parse(inspectClaim(bytes));
    } else if (validated.operation === "openmls_lifecycle") {
      value = JSON.parse(testOpenmlsLifecycleJson(Date.now()));
    } else if (validated.operation === "openmls_negative_cases") {
      value = JSON.parse(testOpenmlsNegativeCasesJson(Date.now()));
    } else if (validated.operation === "secure_random_probe") {
      testSecureRandomProbe();
      value = {
        sharedMemory:
          typeof SharedArrayBuffer !== "undefined" &&
          exports.memory.buffer instanceof SharedArrayBuffer,
      };
    } else if (validated.operation === "production_barrier_scenario") {
      value = await runProductionBarrierScenario();
    } else if (validated.operation === "persistence_delete") {
      await deleteTestDatabases(sessionId(validated.receive));
      value = { deleted: true };
    } else if (validated.operation === "persistence_upgrade") {
      value = await schemaUpgradeEvidence(sessionId(validated.receive));
    } else if (validated.operation === "persistence_newer_schema") {
      await createNewerStateDatabase(sessionId(validated.receive));
      value = { upgraded: true };
    } else if (validated.operation === "persistence_create") {
      value = await endpoint(validated.receive).create(validated.fault);
    } else if (validated.operation === "persistence_open") {
      value = await endpoint(validated.receive).open();
    } else if (validated.operation === "persistence_operate") {
      if (!persistenceEndpoint) throw new Error("AXL_E2EE:endpoint_closed");
      value = await persistenceEndpoint.operate(
        validated.operationId,
        validated.payload,
        validated.fault,
      );
    } else if (validated.operation === "persistence_tamper") {
      if (!persistenceEndpoint) throw new Error("AXL_E2EE:endpoint_closed");
      value = await persistenceEndpoint.tamper(validated.kind);
    } else if (validated.operation === "persistence_callback_exception") {
      if (!persistenceEndpoint) throw new Error("AXL_E2EE:endpoint_closed");
      value = await persistenceEndpoint.callbackException();
    } else if (validated.operation === "persistence_close") {
      if (!persistenceEndpoint) throw new Error("AXL_E2EE:endpoint_closed");
      await persistenceEndpoint.close();
      value = { closed: true };
    }
    self.postMessage({ id, ok: true, value });
  } catch (cause) {
    self.postMessage({ id, ok: false, code: codeFrom(cause), fatal: false });
  } finally {
    if (bytes instanceof Uint8Array) bytes.fill(0);
    bytes = undefined;
  }
});
