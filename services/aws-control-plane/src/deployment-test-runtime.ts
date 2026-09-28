// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * Explicitly non-production assembly used for hosted-path deployment tests.
 *
 * It fails unless AXL_ENVIRONMENT=deployment-test. Production identity, durable ticket storage,
 * pairing rendezvous, and witness replica storage must use separate reviewed assemblies.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
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
import {
  createDeploymentTestWitness,
  parseDeploymentTestWitnessKeys,
} from "./witness-deployment-test.ts";
import { DynamoWitnessHighWaterJournal, DynamoWitnessReplicaStorage } from "./witness-dynamo.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function secretEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

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
const port = Number.parseInt(process.env.PORT ?? "8080", 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is invalid");

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

// Optional: without witness keys the witness path stays unrouted and E2EE endpoints fail closed.
const witnessKeys = process.env.AXL_TEST_WITNESS_KEYS;
// Witness replica records and their high-water journals, in two tables. Required with DynamoDB
// state, so a restart never silently empties the witness; optional in the in-memory mode.
const witnessTable = process.env.AXL_WITNESS_TABLE;
const journalTable = process.env.AXL_WITNESS_JOURNAL_TABLE;
if ((witnessTable === undefined) !== (journalTable === undefined)) {
  throw new Error("AXL_WITNESS_TABLE and AXL_WITNESS_JOURNAL_TABLE go together");
}
if (tableName !== undefined && witnessTable === undefined) {
  throw new Error("AXL_WITNESS_TABLE is required with DynamoDB state");
}
const witnessStores =
  witnessTable === undefined || journalTable === undefined
    ? undefined
    : (key: { readonly replicaId: Uint8Array }) => ({
        storage: new DynamoWitnessReplicaStorage({
          tableName: witnessTable,
          replicaId: key.replicaId,
        }),
        journal: new DynamoWitnessHighWaterJournal({
          tableName: journalTable,
          replicaId: key.replicaId,
        }),
      });
const witness =
  witnessKeys === undefined || witnessKeys.length === 0
    ? undefined
    : await createDeploymentTestWitness({
        keys: parseDeploymentTestWitnessKeys(witnessKeys),
        accountId,
        ...(witnessStores === undefined ? {} : { stores: witnessStores }),
        onFailure({ stage, kind, lineageHash, cause }) {
          const error = cause as { readonly code?: unknown; readonly message?: unknown };
          process.stdout.write(
            `${JSON.stringify({
              witnessFailure: {
                stage,
                kind,
                ...(lineageHash === undefined ? {} : { lineageHash: lineageHash.slice(0, 16) }),
                code: typeof error.code === "string" ? error.code : "internal",
                message: typeof error.message === "string" ? error.message : String(cause),
              },
            })}\n`,
          );
        },
        audit(event) {
          process.stdout.write(`${JSON.stringify({ witnessAudit: event })}
`);
        },
      });

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

const handler = createControlPlaneHandler({
  tickets,
  pairing,
  pairingLinks,
  devices,
  ...(witness === undefined ? {} : { witness }),
  publicAuthentication: {
    async authenticate(request): Promise<AccountPrincipal | undefined> {
      if (secretEqual(request.headers.authorization, `Bearer ${publicToken}`)) return { accountId };
      return phoneSignIn?.authenticate(request);
    },
  },
  internalAuthentication: {
    async authenticate(request) {
      return secretEqual(request.headers.authorization, `Bearer ${relayToken}`);
    },
  },
});

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(
      JSON.stringify({ status: "ok", mode: "deployment-test", witness: witness !== undefined }),
    );
    return;
  }
  handler(request, response);
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Axl deployment-test control plane listening on ${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
