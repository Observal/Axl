// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";

import {
  PAIRING_LINK_PUBLISH_PATH,
  REMOTE_DEVICE_ENROLLMENT_PATH,
  REMOTE_DEVICE_INVITATION_PATH,
  REMOTE_DEVICE_REVOCATION_PATH,
} from "@axl/protocol";

import {
  createControlPlaneHandler,
  InMemoryPairingLinkStore,
  InMemoryPairingRendezvousStore,
  InMemoryRelayTicketStore,
  InMemoryRemoteDeviceStore,
  PairingLinkService,
  PairingRendezvousService,
  RelayTicketService,
  RemoteDeviceService,
} from "../src/index.ts";

const installationId = "01890a5d-ac96-774b-bcce-b302099a8057";
const deviceId = "01890a5d-ac96-774b-bcce-b302099a8058";

async function start(context: TestContext) {
  const server = createServer(
    createControlPlaneHandler({
      tickets: new RelayTicketService({
        store: new InMemoryRelayTicketStore(),
        relayUrl: "wss://relay.invalid/v1/connect",
        authorizer: { currentGeneration: async () => 1 },
        proofVerifier: { verify: async () => false },
      }),
      pairing: new PairingRendezvousService({ store: new InMemoryPairingRendezvousStore() }),
      pairingLinks: new PairingLinkService({ store: new InMemoryPairingLinkStore() }),
      devices: new RemoteDeviceService({ store: new InMemoryRemoteDeviceStore() }),
      publicAuthentication: {
        async authenticate(request) {
          if (request.headers.authorization === "Bearer account") return { accountId: "a" };
          if (request.headers.authorization === "Bearer phone") {
            return { accountId: "a", scope: "phone" };
          }
          return undefined;
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
  return async (path: string, body: unknown, token: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
    return {
      status: response.status,
      code: (parsed.error as { readonly code?: string } | undefined)?.code,
    };
  };
}

test("a phone sign-in is refused every route only the daemon calls", async (context) => {
  const post = await start(context);
  for (const path of [
    "/v1/e2ee/pairing/claims/reserve",
    "/v1/e2ee/pairing/welcomes",
    PAIRING_LINK_PUBLISH_PATH,
    REMOTE_DEVICE_INVITATION_PATH,
    REMOTE_DEVICE_REVOCATION_PATH,
  ]) {
    const result = await post(path, {}, "phone");
    assert.deepEqual(result, { status: 403, code: "scope_forbidden" }, path);
    // The account's own credential reaches the route, and fails only on the empty body.
    assert.notEqual((await post(path, {}, "account")).status, 403, path);
  }
});

test("a phone sign-in reaches the routes a phone calls", async (context) => {
  const post = await start(context);
  for (const path of [
    "/v1/e2ee/pairing/claims",
    "/v1/e2ee/pairing/welcomes/fetch",
    "/v1/e2ee/pairing/welcomes/acknowledge",
    REMOTE_DEVICE_ENROLLMENT_PATH,
  ]) {
    const result = await post(path, {}, "phone");
    assert.notEqual(result.code, "scope_forbidden", path);
    assert.notEqual(result.status, 401, path);
  }
});

test("a phone sign-in gets device relay tickets and never the daemon's", async (context) => {
  const post = await start(context);
  const device = await post(
    "/v1/relay/tickets",
    { installationId, role: "device", deviceId },
    "phone",
  );
  assert.equal(device.status, 201);
  const daemon = await post("/v1/relay/tickets", { installationId, role: "daemon" }, "phone");
  assert.deepEqual(daemon, { status: 403, code: "forbidden_route" });
  assert.equal(
    (await post("/v1/relay/tickets", { installationId, role: "daemon" }, "account")).status,
    201,
  );
});
