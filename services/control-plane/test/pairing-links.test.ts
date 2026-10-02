// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";

import {
  encodeBase64,
  encodePublishPairingLinkRequest,
  PAIRING_LINK_FETCH_PATH,
  PAIRING_LINK_PUBLISH_PATH,
} from "@axl/protocol";

import {
  createControlPlaneHandler,
  InMemoryPairingLinkStore,
  InMemoryRelayTicketStore,
  PAIRING_LINK_LIFETIME_MS,
  PairingLinkService,
  RelayTicketService,
} from "../src/index.ts";

const principal = { accountId: "account-a" };
const linkId = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const sealed = Uint8Array.from({ length: 64 }, (_, index) => 255 - index);

function publication(
  overrides: Partial<{ linkId: Uint8Array; sealed: Uint8Array; expiresAt: number }>,
) {
  return {
    version: 1 as const,
    linkId,
    sealed,
    expiresAt: 1_900_000_600_000,
    ...overrides,
  };
}

test("pairing links publish once, fetch until they expire, and refuse another link under the ID", async () => {
  let now = 1_900_000_000_000;
  const service = new PairingLinkService({
    store: new InMemoryPairingLinkStore(),
    clock: { now: () => now },
  });

  await service.publish(principal, publication({}));
  // A retried publish of the same link is accepted.
  await service.publish(principal, publication({}));
  const fetched = await service.fetch({ version: 1, linkId });
  assert.deepEqual(fetched.sealed, sealed);
  assert.equal(fetched.expiresAt, 1_900_000_600_000);

  await assert.rejects(
    service.publish(principal, publication({ sealed: sealed.slice(1) })),
    (error: Error & { httpStatus?: number }) => error.httpStatus === 409,
  );
  await assert.rejects(
    service.publish({ accountId: "account-b" }, publication({})),
    (error: Error & { httpStatus?: number }) => error.httpStatus === 409,
  );
  await assert.rejects(
    service.fetch({ version: 1, linkId: new Uint8Array(16) }),
    (error: Error & { httpStatus?: number }) => error.httpStatus === 404,
  );

  now = 1_900_000_600_000;
  await assert.rejects(
    service.fetch({ version: 1, linkId }),
    (error: Error & { httpStatus?: number }) => error.httpStatus === 404,
  );
});

test("pairing links live at most fifteen minutes and never start expired", async () => {
  const now = 1_900_000_000_000;
  const service = new PairingLinkService({
    store: new InMemoryPairingLinkStore(),
    clock: { now: () => now },
  });
  await service.publish(principal, publication({ expiresAt: now + 24 * 60 * 60_000 }));
  const fetched = await service.fetch({ version: 1, linkId });
  assert.equal(fetched.expiresAt, now + PAIRING_LINK_LIFETIME_MS);
  await assert.rejects(
    service.publish(principal, publication({ linkId: new Uint8Array(16).fill(9), expiresAt: now })),
    (error: Error & { httpStatus?: number }) => error.httpStatus === 400,
  );
});

async function startServer(context: TestContext) {
  const server = createServer(
    createControlPlaneHandler({
      tickets: new RelayTicketService({
        store: new InMemoryRelayTicketStore(),
        relayUrl: "wss://relay.invalid/v1/connect",
        authorizer: { currentGeneration: async () => 1 },
        proofVerifier: { verify: async () => false },
      }),
      pairingLinks: new PairingLinkService({ store: new InMemoryPairingLinkStore() }),
      publicAuthentication: {
        async authenticate(request) {
          return request.headers.authorization === "Bearer token" ? principal : undefined;
        },
      },
      internalAuthentication: { authenticate: async () => false },
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return async (path: string, body: unknown, authorization?: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: {
        ...(authorization === undefined ? {} : { authorization }),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
}

test("publishing a pairing link needs the account's credential; fetching one does not", async (context) => {
  const post = await startServer(context);
  const body = encodePublishPairingLinkRequest(publication({ expiresAt: Date.now() + 60_000 }));
  assert.equal((await post(PAIRING_LINK_PUBLISH_PATH, body)).status, 401);
  assert.equal((await post(PAIRING_LINK_PUBLISH_PATH, body, "Bearer wrong")).status, 401);
  assert.equal((await post(PAIRING_LINK_PUBLISH_PATH, body, "Bearer token")).status, 201);

  const fetched = await post(PAIRING_LINK_FETCH_PATH, { version: 1, linkId: encodeBase64(linkId) });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.sealed, encodeBase64(sealed));
  const missing = await post(PAIRING_LINK_FETCH_PATH, {
    version: 1,
    linkId: encodeBase64(new Uint8Array(16)),
  });
  assert.equal(missing.status, 404);
  const malformed = await post(PAIRING_LINK_FETCH_PATH, { version: 1, linkId: "AAAA" });
  assert.equal(malformed.status, 400);
});
