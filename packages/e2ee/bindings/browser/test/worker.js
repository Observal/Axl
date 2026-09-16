// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import initializeWasm, {
  get_binding_info_json as bindingInfoJson,
  inspect_pairing_claim as inspectClaim,
  inspect_pairing_invitation as inspectInvitation,
  test_openmls_lifecycle_json as testOpenmlsLifecycleJson,
  test_openmls_negative_cases_json as testOpenmlsNegativeCasesJson,
  test_secure_random_probe as testSecureRandomProbe,
} from "../wasm/axl_e2ee_browser.js";

const BYTE_OPERATIONS = new Set(["inspect_invitation_rust_bound", "inspect_claim_rust_bound"]);

function codeFrom(cause, fallback = "internal_error") {
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
  if (BYTE_OPERATIONS.has(data.operation)) {
    if (!exactKeys(data, ["bytes", "id", "operation"]) || !(data.bytes instanceof Uint8Array)) {
      throw new Error("AXL_E2EE:invalid_argument");
    }
  } else if (data.bytes !== undefined || !exactKeys(data, ["id", "operation"])) {
    throw new Error("AXL_E2EE:invalid_argument");
  }
  if (
    !BYTE_OPERATIONS.has(data.operation) &&
    ![
      "binding_info",
      "openmls_lifecycle",
      "openmls_negative_cases",
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
    }
    self.postMessage({ id, ok: true, value });
  } catch (cause) {
    self.postMessage({ id, ok: false, code: codeFrom(cause), fatal: false });
  } finally {
    if (bytes instanceof Uint8Array) bytes.fill(0);
    bytes = undefined;
  }
});
