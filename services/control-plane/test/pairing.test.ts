// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  parseCryptoSessionId,
  parseDeviceId,
  parseInstallationId,
  parseOperationId,
} from "@axl/protocol";

import {
  InMemoryPairingRendezvousStore,
  PairingRendezvousError,
  PairingRendezvousService,
} from "../src/pairing.ts";

const installationId = parseInstallationId("11111111-1111-4111-8111-111111111111");
const deviceId = parseDeviceId("22222222-2222-4222-8222-222222222222");
const cryptoSessionId = parseCryptoSessionId("33333333-3333-4333-8333-333333333333");
const reservationId = parseOperationId("44444444-4444-4444-8444-444444444444");
const principal = { accountId: "account-a" };
const claim = Uint8Array.of(1, 2, 3);
const claimHash = createHash("sha384").update(claim).digest();
const welcome = Uint8Array.of(4, 5, 6);
const welcomeHash = createHash("sha384").update(welcome).digest();

function request() {
  return {
    version: 1 as const,
    installationId,
    deviceId,
    cryptoSessionId,
    claimHash,
  };
}

test("pairing rendezvous reserves once, preserves exact bytes, and deletes after activation", async () => {
  const now = 1_900_000_000_000;
  const service = new PairingRendezvousService({
    store: new InMemoryPairingRendezvousStore(),
    clock: { now: () => now },
  });

  await service.publishClaim(principal, { ...request(), claim });
  await service.publishClaim(principal, { ...request(), claim });
  const reservation = await service.reserveClaim(principal, {
    ...request(),
    reservationId,
  });
  assert.deepEqual(reservation.claim, claim);
  assert.deepEqual(reservation.claimHash, claimHash);

  await assert.rejects(
    service.reserveClaim(principal, {
      ...request(),
      reservationId: parseOperationId("55555555-5555-4555-8555-555555555555"),
    }),
    (error) => error instanceof PairingRendezvousError && error.code === "reservation_busy",
  );

  const publication = await service.publishWelcome(principal, {
    ...request(),
    reservationId,
    welcome,
    welcomeHash,
  });
  assert.deepEqual(publication.welcome, welcome);
  assert.deepEqual(await service.fetchWelcome(principal, request()), publication);
  await service.acknowledgeWelcome(principal, { ...request(), welcomeHash });
  await service.acknowledgeWelcome(principal, { ...request(), welcomeHash });
  await assert.rejects(
    service.fetchWelcome(principal, request()),
    (error) => error instanceof PairingRendezvousError && error.code === "not_found",
  );
});

test("pairing rendezvous rejects tampering, cross-account access, and expired claims", async () => {
  let now = 1_900_000_000_000;
  const service = new PairingRendezvousService({
    store: new InMemoryPairingRendezvousStore(),
    clock: { now: () => now },
  });
  await assert.rejects(
    service.publishClaim(principal, { ...request(), claim: Uint8Array.of(9) }),
    (error) => error instanceof PairingRendezvousError && error.code === "conflict",
  );
  await service.publishClaim(principal, { ...request(), claim });
  await assert.rejects(
    service.reserveClaim({ accountId: "account-b" }, { ...request(), reservationId }),
    (error) => error instanceof PairingRendezvousError && error.code === "unauthorized",
  );
  now += 10 * 60 * 1000;
  await assert.rejects(
    service.reserveClaim(principal, { ...request(), reservationId }),
    (error) => error instanceof PairingRendezvousError && error.code === "expired",
  );
});
