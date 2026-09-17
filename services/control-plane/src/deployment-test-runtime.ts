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
  parseDeviceId,
  parseInstallationId,
  type ConsumeRelayTicketRequest,
} from "@axl/protocol";

import { createControlPlaneHandler } from "./server.ts";
import {
  InMemoryRelayTicketStore,
  RelayTicketService,
  type AccountPrincipal,
  type RelayTicketRecord,
} from "./tickets.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
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
  throw new Error(
    "The deployment-test control plane cannot run as a production environment",
  );
}

const accountId = required("AXL_TEST_ACCOUNT_ID");
const installationId = parseInstallationId(
  required("AXL_TEST_INSTALLATION_ID"),
);
const deviceId = parseDeviceId(required("AXL_TEST_DEVICE_ID"));
const publicToken = required("AXL_TEST_PUBLIC_TOKEN");
const relayToken = required("AXL_TEST_RELAY_TOKEN");
const possessionProof = Buffer.from(
  required("AXL_TEST_POSSESSION_PROOF"),
  "base64",
);
if (possessionProof.byteLength < 32 || possessionProof.byteLength > 1024) {
  throw new Error(
    "AXL_TEST_POSSESSION_PROOF must decode to 32 through 1024 bytes",
  );
}
const port = Number.parseInt(process.env.PORT ?? "8080", 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
  throw new Error("PORT is invalid");

const tickets = new RelayTicketService({
  store: new InMemoryRelayTicketStore(),
  relayUrl: required("AXL_TEST_RELAY_URL"),
  authorizer: {
    async currentGeneration(principal, request) {
      if (
        principal.accountId !== accountId ||
        request.installationId !== installationId
      )
        return undefined;
      if (request.role === "daemon")
        return request.deviceId === undefined ? 1 : undefined;
      return request.deviceId === deviceId ? 1 : undefined;
    },
  },
  proofVerifier: {
    async verify(
      _ticket: Readonly<RelayTicketRecord>,
      request: ConsumeRelayTicketRequest,
    ) {
      return (
        request.possessionProof.byteLength === possessionProof.byteLength &&
        timingSafeEqual(Buffer.from(request.possessionProof), possessionProof)
      );
    },
  },
});

const handler = createControlPlaneHandler({
  tickets,
  publicAuthentication: {
    async authenticate(request): Promise<AccountPrincipal | undefined> {
      return secretEqual(request.headers.authorization, `Bearer ${publicToken}`)
        ? { accountId }
        : undefined;
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
    response.end('{"status":"ok","mode":"deployment-test"}');
    return;
  }
  handler(request, response);
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(
    `Axl deployment-test control plane listening on ${port}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
