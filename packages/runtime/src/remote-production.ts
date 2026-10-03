// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Production remote access for the account `axl remote login` stored.
 *
 * The daemon signs control-plane requests with the account's access tokens, admits its relay
 * connections with the installation's own key, registers that key before its first pairing or
 * restore, and runs its E2EE endpoints from the hosted Node artifact for its platform: in WSL,
 * envelope keys Windows DPAPI seals; on a Linux desktop, envelope keys in the session's Secret
 * Service. Nothing here holds a shared credential.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadRemoteAccount,
  type RemoteAccountFile,
  RemoteAccountSession,
} from "./remote-account.ts";
import { type HostedDaemonEndpoint, HostedRemoteHost } from "./remote-host.ts";

interface HostedBinding {
  hostedWslDaemonEndpoint?(
    root: string,
    helper: string,
    accountId: Uint8Array,
    installationId: Uint8Array,
    cryptoSessionId: Uint8Array,
  ): HostedDaemonEndpoint;
  hostedLinuxDaemonEndpoint?(
    root: string,
    implementation: string,
    accountId: Uint8Array,
    installationId: Uint8Array,
    cryptoSessionId: Uint8Array,
  ): HostedDaemonEndpoint;
}

/** The host for a stored account. Secrets are unsealed on first use, not at daemon start. */
export function openProductionRemoteHost(
  axlHome: string,
  account: RemoteAccountFile,
  stateDirectory: string,
  log?: (message: string) => void,
): Promise<HostedRemoteHost> {
  let session: Promise<RemoteAccountSession> | undefined;
  const credentials = () => {
    session ??= RemoteAccountSession.open(axlHome, account).catch((cause: unknown) => {
      // A helper that was briefly unavailable is asked again next time.
      session = undefined;
      throw cause;
    });
    return session;
  };
  let binding: Promise<HostedBinding> | undefined;
  return HostedRemoteHost.open(
    {
      origin: account.origin,
      pagePath: account.pagePath,
      accountId: account.accountId,
      installationId: account.installationId,
      accessToken: async () => (await credentials()).accessToken(),
      possession: async (ticket) => (await credentials()).proof(ticket),
      prepare: async () => (await credentials()).register(),
      async endpoint(root, accountId, installationId, cryptoSessionId) {
        binding ??= import(pathToFileURL(account.binding).href) as Promise<HostedBinding>;
        const loaded = await binding;
        const sealer = account.sealer;
        const endpoint =
          sealer.kind === "dpapi"
            ? loaded.hostedWslDaemonEndpoint?.(
                root,
                sealer.helper,
                accountId,
                installationId,
                cryptoSessionId,
              )
            : loaded.hostedLinuxDaemonEndpoint?.(
                root,
                sealer.implementation,
                accountId,
                installationId,
                cryptoSessionId,
              );
        if (endpoint === undefined) {
          throw new Error(`The binding at ${account.binding} does not serve this account's keys`);
        }
        return endpoint;
      },
    },
    // Per account and installation, so signing in as someone else never reuses a pairing.
    remoteRoot(stateDirectory, account),
    log,
  );
}

/** Where the production host for `account` keeps its pairing under one daemon state directory. */
function remoteRoot(stateDirectory: string, account: RemoteAccountFile): string {
  return join(stateDirectory, "remote", `${account.accountId}.${account.installationId}`);
}

/**
 * Forget the account's pairing under a daemon state directory whose daemon is not serving it,
 * which ends every share. Resolves whether a phone had paired there.
 */
export function forgetProductionRemotePairing(
  stateDirectory: string,
  account: RemoteAccountFile,
): Promise<boolean> {
  return HostedRemoteHost.forget(remoteRoot(stateDirectory, account), account.installationId);
}

/** The production host when this machine has a stored account; undefined otherwise. */
export async function openStoredRemoteHost(
  axlHome: string,
  stateDirectory: string,
  log: (message: string) => void,
): Promise<HostedRemoteHost | undefined> {
  let account: RemoteAccountFile | undefined;
  try {
    account = await loadRemoteAccount(axlHome);
  } catch (cause) {
    log(`remote: the stored account is unusable, run axl remote login: ${String(cause)}`);
    return undefined;
  }
  return account === undefined
    ? undefined
    : openProductionRemoteHost(axlHome, account, stateDirectory, log);
}
