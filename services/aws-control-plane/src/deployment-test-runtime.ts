// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Explicitly non-production assembly used for hosted-path deployment tests.
 *
 * It fails unless AXL_ENVIRONMENT=deployment-test. The production assembly is
 * production-runtime.ts, which holds no shared account credential.
 */

import { timingSafeEqual } from "node:crypto";

import {
  type AccountPrincipal,
  createControlPlaneHandler,
  InMemoryPairingLinkStore,
  InMemoryPairingRendezvousStore,
  InMemoryRelayTicketStore,
  InMemoryRemoteDeviceStore,
  PairingLinkService,
  PairingRendezvousService,
  type RelayTicketRecord,
  RelayTicketService,
  RemoteDeviceService,
} from "@axl/control-plane";
import { type ConsumeRelayTicketRequest, parseInstallationId } from "@axl/protocol";

import {
  CognitoPhoneAuthenticator,
  DynamoPairingLinkStore,
  DynamoPairingRendezvousStore,
  DynamoRelayTicketStore,
  DynamoRemoteDeviceStore,
} from "./aws.ts";
import { required, secretEqual, serve, witnessFromEnvironment } from "./runtime-common.ts";

if (required("AXL_ENVIRONMENT") !== "deployment-test") {
  throw new Error("The deployment-test control plane cannot run as a production environment");
}

const accountId = required("AXL_TEST_ACCOUNT_ID");
const installationId = parseInstallationId(required("AXL_TEST_INSTALLATION_ID"));
const publicToken = required("AXL_TEST_PUBLIC_TOKEN");
const relayToken = required("AXL_TEST_RELAY_TOKEN");
// The daemon's relay possession proof. Devices never share it: each proves its own enrolled key.
const possessionProof = Buffer.from(required("AXL_TEST_POSSESSION_PROOF"), "base64");
if (possessionProof.byteLength < 32 || possessionProof.byteLength > 1024) {
  throw new Error("AXL_TEST_POSSESSION_PROOF must decode to 32 through 1024 bytes");
}

const tableName = process.env.AXL_TEST_IN_MEMORY === "1" ? undefined : required("AXL_TICKET_TABLE");
const ticketStore =
  tableName === undefined
    ? new InMemoryRelayTicketStore()
    : new DynamoRelayTicketStore({ tableName });
const pairing = new PairingRendezvousService({
  store:
    tableName === undefined
      ? new InMemoryPairingRendezvousStore()
      : new DynamoPairingRendezvousStore({ tableName }),
});
const pairingLinks = new PairingLinkService({
  store:
    tableName === undefined
      ? new InMemoryPairingLinkStore()
      : new DynamoPairingLinkStore({ tableName }),
});
const devices = new RemoteDeviceService({
  store:
    tableName === undefined
      ? new InMemoryRemoteDeviceStore()
      : new DynamoRemoteDeviceStore({ tableName }),
});

const tickets = new RelayTicketService({
  store: ticketStore,
  relayUrl: required("AXL_TEST_RELAY_URL"),
  authorizer: {
    async currentGeneration(principal, request) {
      if (principal.accountId !== accountId || request.installationId !== installationId)
        return undefined;
      if (request.role === "daemon") return request.deviceId === undefined ? 1 : undefined;
      return request.deviceId === undefined
        ? undefined
        : devices.generation(principal, request.installationId, request.deviceId);
    },
  },
  proofVerifier: {
    async verify(ticket: Readonly<RelayTicketRecord>, request: ConsumeRelayTicketRequest) {
      if (ticket.role === "device") return devices.verifyPossession(ticket, request);
      return (
        request.possessionProof.byteLength === possessionProof.byteLength &&
        timingSafeEqual(Buffer.from(request.possessionProof), possessionProof)
      );
    },
  },
});

const witness = await witnessFromEnvironment({ durable: tableName !== undefined, accountId });

// Optional: a Cognito user pool the phone page signs in with. Its tokens get the phone scope.
const phoneIssuer = process.env.AXL_TEST_PHONE_ISSUER;
const phoneClientId = process.env.AXL_TEST_PHONE_CLIENT_ID;
if ((phoneIssuer === undefined) !== (phoneClientId === undefined)) {
  throw new Error("AXL_TEST_PHONE_ISSUER and AXL_TEST_PHONE_CLIENT_ID go together");
}
const phoneSignIn =
  phoneIssuer === undefined || phoneClientId === undefined
    ? undefined
    : new CognitoPhoneAuthenticator({ issuer: phoneIssuer, clientId: phoneClientId, accountId });

serve(
  createControlPlaneHandler({
    tickets,
    pairing,
    pairingLinks,
    devices,
    ...(witness === undefined ? {} : { witness }),
    publicAuthentication: {
      async authenticate(request): Promise<AccountPrincipal | undefined> {
        if (secretEqual(request.headers.authorization, `Bearer ${publicToken}`)) {
          return { accountId };
        }
        return phoneSignIn?.authenticate(request);
      },
    },
    internalAuthentication: {
      async authenticate(request) {
        return secretEqual(request.headers.authorization, `Bearer ${relayToken}`);
      },
    },
  }),
  "deployment-test",
  witness !== undefined,
);
