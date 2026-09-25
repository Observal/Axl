// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

const path = process.env.AXL_E2EE_NODE_TEST_ARTIFACT;
if (!path) throw new Error("AXL_E2EE_NODE_TEST_ARTIFACT is required");
const native = createRequire(import.meta.url)(path);

export class AxlE2eeError extends Error {
  constructor(code) {
    super("The E2EE operation failed safely.");
    this.name = "AxlE2eeError";
    this.code = code;
    Object.freeze(this);
  }
}

export function mapError(cause) {
  if (cause instanceof AxlE2eeError) return cause;
  const message = typeof cause?.message === "string" ? cause.message : "";
  const marker = "AXL_E2EE:";
  const index = message.indexOf(marker);
  const code = index < 0 ? "internal_error" : message.slice(index + marker.length).split(/[^a-z0-9_]/u, 1)[0];
  return new AxlE2eeError(code);
}

const targets = new WeakMap();
function wrap(endpoint) {
  const proxy = new Proxy(endpoint, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        try {
          return Promise.resolve(value.apply(target, args)).catch((cause) => { throw mapError(cause); });
        } catch (cause) {
          return Promise.reject(mapError(cause));
        }
      };
    },
  });
  targets.set(proxy, endpoint);
  return proxy;
}

const useWindowsDpapi =
  process.platform === "win32" && process.env.AXL_RUN_WINDOWS_DPAPI_TESTS === "1";
const daemonFactory = useWindowsDpapi
  ? native.testWindowsDaemonEndpoint
  : native.testDaemonEndpoint;
const deviceFactory = useWindowsDpapi
  ? native.testWindowsDeviceEndpoint
  : native.testDeviceEndpoint;

const witnessHandles = new WeakMap();

/** Deterministic in-process three-replica witness. Its methods are synchronous. */
export const testWitness = () => {
  const witness = new native.TestWitness();
  const facade = {
    respond(request) {
      try {
        return witness.respond(request);
      } catch (cause) {
        throw mapError(cause);
      }
    },
    setUnavailable: (value) => witness.setUnavailable(value),
    setForgeSignature: (value) => witness.setForgeSignature(value),
    rollBackAll: (request) => witness.rollBackAll(request),
    advanceForeign: (request) => witness.advanceForeign(request),
    revoke: (request) => witness.revoke(request),
    get responses() {
      return witness.responses;
    },
    get trustConfig() {
      return witness.trustConfig;
    },
  };
  witnessHandles.set(facade, witness);
  return facade;
};
export const testDaemonEndpoint = (root, account, installation, session, witness) =>
  wrap(daemonFactory(root, account, installation, session, targetsWitness(witness)));
export const testDeviceEndpoint = (root, account, installation, session, device, witness) =>
  wrap(deviceFactory(root, account, installation, session, device, targetsWitness(witness)));
/** Test storage certified by the replicas named in a canonical trust configuration. */
export const configuredDaemonEndpoint = (root, account, installation, session, trust) =>
  wrap(native.configuredDaemonEndpoint(root, account, installation, session, trust));
export const configuredDeviceEndpoint = (root, account, installation, session, device, trust) =>
  wrap(native.configuredDeviceEndpoint(root, account, installation, session, device, trust));
export const testPanic = (endpoint) => Promise.resolve(native.testPanic(targets.get(endpoint))).catch((cause) => { throw mapError(cause); });
export const nativeExports = Object.freeze(Object.keys(native).sort());

function targetsWitness(witness) {
  const handle = witnessHandles.get(witness);
  if (!handle) throw new TypeError("a witness from testWitness() is required");
  return handle;
}
