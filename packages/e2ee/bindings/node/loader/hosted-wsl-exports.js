
// ---- Hosted WSL additions (appended to the production loader by `build.mjs hosted-wsl`)

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
 * Hosted daemon endpoint for a daemon in WSL 2. Envelope keys under `root` are sealed by Windows
 * DPAPI for the Windows user through `helper`, that user's `axl-dpapi-helper.exe`, and certificates
 * are verified against the replica trust pinned into this build.
 */
export const hostedWslDaemonEndpoint = (root, helper, accountId, installationId, cryptoSessionId) => {
  try {
    return wrapEndpoint(
      native.hostedWslDaemonEndpoint(root, helper, accountId, installationId, cryptoSessionId),
    );
  } catch (cause) {
    throw mapError(cause);
  }
};
