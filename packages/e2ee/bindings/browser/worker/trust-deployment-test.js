// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

// Deployment-test replica trust. The build copies this module to `worker/trust.js` only in a
// deployment-test artifact. The trust configuration is a same-origin file whose SHA-256 the build
// pinned in the integrity manifest next to the WASM digest, so the served trust is exactly the
// trust the build named. It carries public verification keys only.

import { deployment_test_replica_trust as replicaTrust } from "../wasm/axl_e2ee_browser.js";

const MAX_TRUST_BYTES = 3 + 3 * (16 + 1 + 4 * 48);

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadReplicaTrust(manifest, root) {
  const entry = manifest.artifacts?.find((candidate) => candidate.kind === "replica-trust");
  if (
    !entry ||
    entry.path !== "trust/replica-trust.bin" ||
    typeof entry.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(entry.sha256)
  ) {
    throw new Error("AXL_E2EE:artifact_integrity_failed");
  }
  const response = await fetch(new URL(entry.path, root), {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("AXL_E2EE:artifact_integrity_failed");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_TRUST_BYTES) {
    throw new Error("AXL_E2EE:artifact_integrity_failed");
  }
  if (hex(await globalThis.crypto.subtle.digest("SHA-256", bytes)) !== entry.sha256) {
    throw new Error("AXL_E2EE:artifact_integrity_failed");
  }
  return replicaTrust(bytes);
}
