// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_RELAY_LIMITS,
  encodeInternalConsumeRelayTicketRequest,
  INTERNAL_RELAY_API_VERSION,
  parseInstallationId,
  parseRelayRevocationNotification,
} from "@axl/protocol";

import {
  createControlPlaneHandler,
  InMemoryRelayTicketStore,
  RelayRevocationNotifier,
  RelayTicketError,
  RelayTicketService,
} from "../src/index.ts";

const installationId = parseInstallationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const deviceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as const;
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../packages/protocol/test/fixtures/internal-relay-api-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly revocation: { readonly request: unknown; readonly result: unknown };
};

function createTicketService(
  clock: { now(): number } = { now: () => 1_900_000_000_000 },
  currentGeneration: () => number | undefined = () => 1,
): RelayTicketService {
  let routeCounter = 0;
  return new RelayTicketService({
    store: new InMemoryRelayTicketStore(),
    authorizer: {
      async currentGeneration(principal, request) {
        return principal.accountId === "account-fixture" &&
          request.installationId === installationId
          ? currentGeneration()
          : undefined;
      },
    },
    proofVerifier: {
      async verify(_ticket, request) {
        return Buffer.from(request.possessionProof).equals(Buffer.from([0, 1, 2, 3, 255]));
      },
    },
    relayUrl: "wss://relay.invalid/v1/connect",
    clock,
    randomToken: () => "fixture-ticket-never-valid-outside-tests",
    randomId: () => {
      routeCounter += 1;
      return `cccccccc-cccc-4ccc-8ccc-${routeCounter.toString().padStart(12, "0")}`;
    },
  });
}

test("atomically consumes a relay ticket once under concurrent calls", async () => {
  const service = createTicketService();
  const issued = await service.issue(
    { accountId: "account-fixture" },
    { installationId, deviceId, role: "device" },
  );
  const request = {
    ticket: issued.ticket,
    relayInstanceId: "relay-fixture-1",
    connectionNonce: "fixture-nonce",
    possessionProof: Uint8Array.of(0, 1, 2, 3, 255),
  };

  const results = await Promise.allSettled([service.consume(request), service.consume(request)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(rejection?.status === "rejected");
  assert.ok(rejection.reason instanceof RelayTicketError);
  assert.equal(rejection.reason.code, "ticket_consumed");
});

test("rejects unauthorized issuance, invalid proof, and expired tickets", async () => {
  const service = createTicketService();
  await assert.rejects(
    service.issue({ accountId: "another-account" }, { installationId, deviceId, role: "device" }),
    (error) => error instanceof RelayTicketError && error.code === "forbidden_route",
  );
  const issued = await service.issue(
    { accountId: "account-fixture" },
    { installationId, deviceId, role: "device" },
  );
  await assert.rejects(
    service.consume({
      ticket: issued.ticket,
      relayInstanceId: "relay-fixture-1",
      connectionNonce: "fixture-nonce",
      possessionProof: Uint8Array.of(9),
    }),
    (error) => error instanceof RelayTicketError && error.code === "unauthorized",
  );

  let now = 1_900_000_000_000;
  const expiringService = createTicketService({ now: () => now });
  const expiring = await expiringService.issue(
    { accountId: "account-fixture" },
    { installationId, deviceId, role: "device" },
  );
  now += 60_000;
  await assert.rejects(
    expiringService.consume({
      ticket: expiring.ticket,
      relayInstanceId: "relay-fixture-1",
      connectionNonce: "fixture-nonce",
      possessionProof: Uint8Array.of(0, 1, 2, 3, 255),
    }),
    (error) => error instanceof RelayTicketError && error.code === "ticket_expired",
  );
});

test("rejects a ticket when its grant generation changes before consumption", async () => {
  let generation: number | undefined = 7;
  const service = createTicketService(undefined, () => generation);
  const issued = await service.issue(
    { accountId: "account-fixture" },
    { installationId, deviceId, role: "device" },
  );
  generation = 8;
  await assert.rejects(
    service.consume({
      ticket: issued.ticket,
      relayInstanceId: "relay-fixture-1",
      connectionNonce: "fixture-nonce",
      possessionProof: Uint8Array.of(0, 1, 2, 3, 255),
    }),
    (error) => error instanceof RelayTicketError && error.code === "ticket_revoked",
  );
});

test("serves authenticated public issuance and internal consumption without URL credentials", async (context) => {
  const service = createTicketService();
  const handler = createControlPlaneHandler({
    tickets: service,
    publicAuthentication: {
      async authenticate(request) {
        return request.headers.authorization === "Bearer public-fixture"
          ? { accountId: "account-fixture" }
          : undefined;
      },
    },
    internalAuthentication: {
      async authenticate(request) {
        return request.headers.authorization === "Bearer internal-fixture";
      },
    },
  });
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const issueResponse = await fetch(`${origin}/v1/relay/tickets`, {
    method: "POST",
    headers: { authorization: "Bearer public-fixture", "content-type": "application/json" },
    body: JSON.stringify({ installationId, deviceId, role: "device" }),
  });
  assert.equal(issueResponse.status, 201);
  const issued = (await issueResponse.json()) as { readonly ticket: string };

  const unauthorized = await fetch(`${origin}/internal/v1/relay/tickets/consume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      encodeInternalConsumeRelayTicketRequest({
        ticket: issued.ticket,
        relayInstanceId: "relay-fixture-1",
        connectionNonce: "fixture-nonce",
        possessionProof: Uint8Array.of(0, 1, 2, 3, 255),
      }),
    ),
  });
  assert.equal(unauthorized.status, 401);

  const consumeResponse = await fetch(`${origin}/internal/v1/relay/tickets/consume`, {
    method: "POST",
    headers: { authorization: "Bearer internal-fixture", "content-type": "application/json" },
    body: JSON.stringify(
      encodeInternalConsumeRelayTicketRequest({
        ticket: issued.ticket,
        relayInstanceId: "relay-fixture-1",
        connectionNonce: "fixture-nonce",
        possessionProof: Uint8Array.of(0, 1, 2, 3, 255),
      }),
    ),
  });
  assert.equal(consumeResponse.status, 200);
  assert.deepEqual(await consumeResponse.json(), {
    version: INTERNAL_RELAY_API_VERSION,
    installationId,
    deviceId,
    sourceRouteId: "cccccccc-cccc-4ccc-8ccc-000000000001",
    role: "device",
    grantGeneration: 1,
    leaseExpiresAt: 1_900_000_060_000,
    limits: DEFAULT_RELAY_LIMITS,
  });
});

test("validates the authenticated relay revocation boundary", async () => {
  let observedPath: string | undefined;
  let observedBody: unknown;
  const notifier = new RelayRevocationNotifier({
    async post(path, body) {
      observedPath = path;
      observedBody = body;
      return fixture.revocation.result;
    },
  });
  const notification = parseRelayRevocationNotification(fixture.revocation.request);
  assert.deepEqual(await notifier.notify(notification), fixture.revocation.result);
  assert.equal(observedPath, "/internal/v1/revocations");
  assert.deepEqual(observedBody, notification);
});
