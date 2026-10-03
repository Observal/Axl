
// ---- Hosted Linux desktop additions (appended to the production loader by `build.mjs hosted-linux`)

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
 * Hosted daemon endpoint for a Linux desktop daemon. Envelope keys live in the session's Secret
 * Service as served by `implementation` (`gnome-keyring` or `kwallet6`), and certificates are
 * verified against the replica trust pinned into this build.
 */
export const hostedLinuxDaemonEndpoint = (
  root,
  implementation,
  accountId,
  installationId,
  cryptoSessionId,
) => {
  try {
    return wrapEndpoint(
      native.hostedLinuxDaemonEndpoint(root, implementation, accountId, installationId, cryptoSessionId),
    );
  } catch (cause) {
    throw mapError(cause);
  }
};

/** The tested Secret Service implementation serving this desktop session. */
export const hostedLinuxSecretService = () => {
  try {
    return native.hostedLinuxSecretService();
  } catch (cause) {
    throw mapError(cause);
  }
};

/** The key that seals the remote account file, from the session's Secret Service. */
export const hostedLinuxAccountKey = (implementation, create) => {
  try {
    return new Uint8Array(native.hostedLinuxAccountKey(implementation, create));
  } catch (cause) {
    throw mapError(cause);
  }
};
