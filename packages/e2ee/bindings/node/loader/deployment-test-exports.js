
// ---- Deployment-test additions (appended to the production loader by `build.mjs deployment-test`)

/** Map every rejection or synchronous throw of a native handle method to an AxlE2eeError. */
function wrapEndpoint(endpoint) {
  return new Proxy(endpoint, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        try {
          return Promise.resolve(value.apply(target, args)).catch((cause) => {
            throw mapError(cause);
          });
        } catch (cause) {
          return Promise.reject(mapError(cause));
        }
      };
    },
  });
}

/**
 * Hosted deployment-test daemon endpoint. It verifies certificates against the replica trust
 * pinned into this build and keeps envelope keys in an owner-only file under `root`. Not for
 * production use.
 */
export const deploymentTestDaemonEndpoint = (root, accountId, installationId, cryptoSessionId) => {
  try {
    return wrapEndpoint(
      native.deploymentTestDaemonEndpoint(root, accountId, installationId, cryptoSessionId),
    );
  } catch (cause) {
    throw mapError(cause);
  }
};
