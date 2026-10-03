
// ---- Hosted macOS additions (appended to the production loader by `build.mjs hosted-macos`)

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
 * Hosted daemon endpoint for a macOS daemon. Envelope keys under `root` are sealed under a key in
 * the data-protection Keychain through `helper`, the user's signed `axl-keychain-helper`, and
 * certificates are verified against the replica trust pinned into this build.
 */
export const hostedMacosDaemonEndpoint = (root, helper, accountId, installationId, cryptoSessionId) => {
  try {
    return wrapEndpoint(
      native.hostedMacosDaemonEndpoint(root, helper, accountId, installationId, cryptoSessionId),
    );
  } catch (cause) {
    throw mapError(cause);
  }
};
