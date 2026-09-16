// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class AxlE2eeError extends Error {
  constructor(code, detail = "The E2EE operation failed safely.") {
    super(detail);
    this.name = "AxlE2eeError";
    this.code = code;
    Object.freeze(this);
  }
}

function createError(code) {
  return new AxlE2eeError(code);
}

const target = (() => {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64-gnu";
  throw createError("unsupported_platform");
})();

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let native;
try {
  const manifest = JSON.parse(readFileSync(join(root, "integrity.json"), "utf8"));
  const artifact = manifest.artifacts.find((entry) => entry.target === target);
  if (!artifact) throw createError("unsupported_platform");
  const nativePath = join(root, artifact.path);
  const digest = createHash("sha256").update(readFileSync(nativePath)).digest("hex");
  if (digest !== artifact.sha256) throw createError("artifact_integrity_failed");
  native = createRequire(import.meta.url)(nativePath);
} catch (cause) {
  if (cause instanceof AxlE2eeError) throw cause;
  throw createError("artifact_integrity_failed");
}

function mapError(cause) {
  if (cause instanceof AxlE2eeError) return cause;
  const message = typeof cause?.message === "string" ? cause.message : "";
  const marker = "AXL_E2EE:";
  const index = message.indexOf(marker);
  const candidate = index < 0 ? "internal_error" : message.slice(index + marker.length).split(/[^a-z0-9_]/u, 1)[0];
  const code = ERROR_CODES.includes(candidate) ? candidate : "internal_error";
  return createError(code);
}

async function invoke(callback) {
  try { return await callback(); } catch (cause) { throw mapError(cause); }
}

export const ERROR_CODES = Object.freeze(native.errorCodes());
export const getBindingInfo = () => Object.freeze(native.getBindingInfo());
export const inspectPairingInvitation = (bytes) => invoke(() => native.inspectPairingInvitation(bytes));
export const inspectPairingClaim = (bytes) => invoke(() => native.inspectPairingClaim(bytes));
export const createDaemonEndpoint = () => invoke(() => native.createDaemonEndpoint());
export const openDaemonEndpoint = () => invoke(() => native.openDaemonEndpoint());
export const createDeviceEndpoint = () => invoke(() => native.createDeviceEndpoint());
export const openDeviceEndpoint = () => invoke(() => native.openDeviceEndpoint());
