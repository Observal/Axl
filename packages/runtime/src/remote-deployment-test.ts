// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Remote access through the hosted deployment-test stack.
 *
 * It is enabled only when `AXL_REMOTE_DEPLOYMENT_TEST` names a configuration file, and it is not
 * production remote access: the stack has one account and one installation with shared test
 * credentials, and the daemon endpoint comes from the deployment-test Node artifact (build-pinned
 * hosted witness trust, owner-only file keys).
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { type InstallationId, parseInstallationId } from "@axl/protocol";

import { type HostedDaemonEndpoint, HostedRemoteHost } from "./remote-host.ts";

const CONFIG_VERSION = 1;

export interface DeploymentTestRemoteConfig {
  /** HTTPS origin of the stack: control plane, witness, relay tickets, and the device page. */
  readonly origin: string;
  /** Path of the device page under `origin`, for example `/remote/`. */
  readonly pagePath: string;
  readonly accountId: string;
  readonly installationId: InstallationId;
  readonly accessToken: string;
  /**
   * The phone page signs in (Google through the stack's user pool), so pairing links leave out
   * `accessToken` and the phone never holds the account credential.
   */
  readonly phoneSignIn: boolean;
  /** The daemon's relay possession proof. Each device proves its own key instead. */
  readonly possessionProof: Uint8Array;
  /** Path of the deployment-test Node binding loader (`dist/deployment-test/loader/index.js`). */
  readonly binding: string;
}

function text(value: unknown, name: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`Remote deployment-test configuration ${name} is invalid`);
  }
  return value;
}

export async function loadDeploymentTestRemoteConfig(
  path: string,
): Promise<DeploymentTestRemoteConfig> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (value.version !== CONFIG_VERSION) {
    throw new TypeError("Remote deployment-test configuration version is unsupported");
  }
  const origin = new URL(text(value.origin, "origin"));
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TypeError("Remote deployment-test origin must be a bare HTTPS origin");
  }
  const pagePath = text(value.pagePath, "pagePath");
  if (!pagePath.startsWith("/") || !pagePath.endsWith("/")) {
    throw new TypeError("Remote deployment-test pagePath must start and end with /");
  }
  const binding = text(value.binding, "binding");
  return {
    origin: origin.origin,
    pagePath,
    accountId: text(value.accountId, "accountId", 36),
    installationId: parseInstallationId(value.installationId),
    accessToken: text(value.accessToken, "accessToken"),
    phoneSignIn: value.phoneSignIn === true,
    possessionProof: new Uint8Array(
      Buffer.from(text(value.possessionProof, "possessionProof"), "base64"),
    ),
    binding: isAbsolute(binding) ? binding : resolve(path, "..", binding),
  };
}

interface DeploymentTestBinding {
  deploymentTestDaemonEndpoint(
    root: string,
    accountId: Uint8Array,
    installationId: Uint8Array,
    cryptoSessionId: Uint8Array,
  ): HostedDaemonEndpoint;
}

/** The remote host for the deployment-test stack, with its state beside the daemon's. */
export function openDeploymentTestRemoteHost(
  config: DeploymentTestRemoteConfig,
  stateDirectory: string,
  log?: (message: string) => void,
): Promise<HostedRemoteHost> {
  let binding: Promise<DeploymentTestBinding> | undefined;
  return HostedRemoteHost.open(
    {
      origin: config.origin,
      pagePath: config.pagePath,
      accountId: config.accountId,
      installationId: config.installationId,
      accessToken: async () => config.accessToken,
      possession: async () => ({
        connectionNonce: randomUUID(),
        possessionProof: config.possessionProof.slice(),
      }),
      ...(config.phoneSignIn ? {} : { linkAccessToken: config.accessToken }),
      async endpoint(root, accountId, installationId, cryptoSessionId) {
        binding ??= import(pathToFileURL(config.binding).href) as Promise<DeploymentTestBinding>;
        return (await binding).deploymentTestDaemonEndpoint(
          root,
          accountId,
          installationId,
          cryptoSessionId,
        );
      },
    },
    join(stateDirectory, "remote-deployment-test"),
    log,
  );
}
