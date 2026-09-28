// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Production assembly of the hosted control plane.
 *
 * It fails unless AXL_ENVIRONMENT=production. It holds no account credential: people sign in
 * through the Cognito user pool (the daemon with `axl remote login`, the phone on its page), each
 * daemon installation registers its own P-256 key, and each device enrolls its own. A relay ticket
 * is issued only for an installation registered to the caller's account, and admitted only with a
 * signature by that installation's or device's key. Remote access is opt-in: only members of the
 * pool's remote group are accepted. State lives in DynamoDB.
 *
 * The witness keeps its in-process shape: three replicas with their own keys and records, not yet
 * independently administered (see docs/architecture/remote-production-wsl.md).
 */

import {
  createControlPlaneHandler,
  PairingLinkService,
  PairingRendezvousService,
  RelayTicketService,
  RemoteDeviceService,
  RemoteInstallationService,
} from "@axl/control-plane";

import {
  CognitoAccountAuthenticator,
  DynamoPairingLinkStore,
  DynamoPairingRendezvousStore,
  DynamoRelayTicketStore,
  DynamoRemoteDeviceStore,
  DynamoRemoteInstallationStore,
} from "./aws.ts";
import { required, secretEqual, serve, witnessFromEnvironment } from "./runtime-common.ts";

if (required("AXL_ENVIRONMENT") !== "production") {
  throw new Error("The production control plane requires AXL_ENVIRONMENT=production");
}

const tableName = required("AXL_TICKET_TABLE");
// The relay's service credential for consuming tickets; no client ever holds it.
const relayToken = required("AXL_RELAY_TOKEN");
const accounts = new CognitoAccountAuthenticator({
  issuer: required("AXL_COGNITO_ISSUER"),
  daemonClientId: required("AXL_DAEMON_CLIENT_ID"),
  phoneClientId: required("AXL_PHONE_CLIENT_ID"),
  group: required("AXL_REMOTE_GROUP"),
});

const installations = new RemoteInstallationService({
  store: new DynamoRemoteInstallationStore({ tableName }),
});
const devices = new RemoteDeviceService({ store: new DynamoRemoteDeviceStore({ tableName }) });

const tickets = new RelayTicketService({
  store: new DynamoRelayTicketStore({ tableName }),
  relayUrl: required("AXL_RELAY_URL"),
  authorizer: {
    async currentGeneration(principal, request) {
      // The relay routes by installation, so both roles need the installation to be the account's.
      if (!(await installations.owns(principal, request.installationId))) return undefined;
      if (request.role === "daemon") return request.deviceId === undefined ? 1 : undefined;
      return request.deviceId === undefined
        ? undefined
        : devices.generation(principal, request.installationId, request.deviceId);
    },
  },
  proofVerifier: {
    async verify(ticket, request) {
      return ticket.role === "device"
        ? devices.verifyPossession(ticket, request)
        : installations.verifyPossession(ticket, request);
    },
  },
});

const witness = await witnessFromEnvironment({ durable: true });

serve(
  createControlPlaneHandler({
    tickets,
    pairing: new PairingRendezvousService({
      store: new DynamoPairingRendezvousStore({ tableName }),
    }),
    pairingLinks: new PairingLinkService({ store: new DynamoPairingLinkStore({ tableName }) }),
    devices,
    installations,
    ...(witness === undefined ? {} : { witness }),
    publicAuthentication: accounts,
    internalAuthentication: {
      async authenticate(request) {
        return secretEqual(request.headers.authorization, `Bearer ${relayToken}`);
      },
    },
  }),
  "production",
  witness !== undefined,
);
