// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import initializeWasm, {
  get_binding_info_json as bindingInfoJson,
  inspect_pairing_claim as inspectClaim,
  inspect_pairing_invitation as inspectInvitation,
  secure_random_check as secureRandomCheck,
} from "../wasm/axl_e2ee_browser.js";

const BYTE_OPERATIONS = Object.freeze({
  inspect_invitation: 2048,
  inspect_claim: 17320,
});
const ENDPOINT_OPERATIONS = new Set([
  "create_daemon_endpoint",
  "open_daemon_endpoint",
  "create_device_endpoint",
  "open_device_endpoint",
]);
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
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function request(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("AXL_E2EE:invalid_argument");
  }
  const { id, operation } = data;
  if (!Number.isSafeInteger(id) || id < 1 || typeof operation !== "string") {
    throw new Error("AXL_E2EE:invalid_argument");
  }
  const maximum = Object.hasOwn(BYTE_OPERATIONS, operation) ? BYTE_OPERATIONS[operation] : undefined;
  if (maximum !== undefined) {
    if (!exactKeys(data, ["bytes", "id", "operation"])) {
      throw new Error("AXL_E2EE:invalid_argument");
    }
    if (!(data.bytes instanceof Uint8Array)) throw new Error("AXL_E2EE:invalid_argument");
    if (data.bytes.byteLength > maximum) throw new Error("AXL_E2EE:bound_exceeded");
  } else if (data.bytes !== undefined || !exactKeys(data, ["id", "operation"])) {
    throw new Error("AXL_E2EE:invalid_argument");
  }
  if (operation !== "binding_info" && maximum === undefined && !ENDPOINT_OPERATIONS.has(operation)) {
    throw new Error("AXL_E2EE:invalid_argument");
  }
  return { id, operation, bytes: data.bytes };
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
}

const ready = start().then(
  () => ({ ok: true }),
  (cause) => ({ ok: false, code: codeFrom(cause, "artifact_integrity_failed") }),
);
let fatalCode;

self.addEventListener("message", async ({ data }) => {
  let id = Number.isSafeInteger(data?.id) && data.id > 0 ? data.id : 0;
  let bytes;
  try {
    if (fatalCode) throw new Error(`AXL_E2EE:${fatalCode}`);
    const validated = request(data);
    ({ id, bytes } = validated);
    const initialization = await ready;
    if (!initialization.ok) throw new Error(`AXL_E2EE:${initialization.code}`);
    let value;
    if (validated.operation === "binding_info") value = JSON.parse(bindingInfoJson());
    else if (validated.operation === "inspect_invitation") {
      value = JSON.parse(inspectInvitation(bytes));
    } else if (validated.operation === "inspect_claim") value = JSON.parse(inspectClaim(bytes));
    else if (ENDPOINT_OPERATIONS.has(validated.operation)) {
      throw new Error("AXL_E2EE:rollback_anchor_unavailable");
    }
    self.postMessage({ id, ok: true, value });
  } catch (cause) {
    const code = codeFrom(cause);
    const fatal = FATAL_CODES.has(code);
    if (fatal) fatalCode = code;
    self.postMessage({ id, ok: false, code, fatal });
    if (fatal) self.close();
  } finally {
    if (bytes instanceof Uint8Array) bytes.fill(0);
    bytes = undefined;
  }
});
