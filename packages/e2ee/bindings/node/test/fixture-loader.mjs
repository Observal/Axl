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

function mapError(cause) {
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
      const value = Reflect.get(target, property, receiver);
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

export const testDaemonEndpoint = (...args) => wrap(native.testDaemonEndpoint(...args));
export const testDeviceEndpoint = (...args) => wrap(native.testDeviceEndpoint(...args));
export const testPanic = (endpoint) => Promise.resolve(native.testPanic(targets.get(endpoint))).catch((cause) => { throw mapError(cause); });
export const nativeExports = Object.freeze(Object.keys(native).sort());
