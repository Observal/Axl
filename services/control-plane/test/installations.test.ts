// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";

import {
  encodeInternalConsumeRelayTicketRequest,
  encodeRemoteInstallationRegistrationRequest,
  parseInstallationId,
  REMOTE_INSTALLATION_REGISTRATION_PATH,
  remoteDevicePossessionMessage,
} from "@axl/protocol";

import {
  createControlPlaneHandler,
  InMemoryRelayTicketStore,
  InMemoryRemoteInstallationStore,
  RelayTicketService,
  RemoteInstallationService,
} from "../src/index.ts";

const installationId = parseInstallationId("01890a5d-ac96-774b-bcce-b302099a8057");
const other = parseInstallationId("01890a5d-ac96-774b-bcce-b302099a8059");

/** A daemon installation key: P-256, signing with the same proof a device gives. */
async function installationKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return {
    publicKey,
    sign: async (message: Uint8Array) =>
      new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, message),
      ),
  };
}

async function start(context: TestContext) {
  const installations = new RemoteInstallationService({
    store: new InMemoryRemoteInstallationStore(),
  });
  const tickets = new RelayTicketService({
    store: new InMemoryRelayTicketStore(),
    relayUrl: "wss://relay.invalid/v1/connect",
    authorizer: {
      async currentGeneration(principal, request) {
        if (request.role !== "daemon") return undefined;
        return (await installations.owns(principal, request.installationId)) ? 1 : undefined;
      },
    },
    proofVerifier: { verify: (ticket, request) => installations.verifyPossession(ticket, request) },
  });
  const server = createServer(
    createControlPlaneHandler({
      tickets,
      installations,
      publicAuthentication: {
        async authenticate(request) {
          switch (request.headers.authorization) {
            case "Bearer alice":
              return { accountId: "alice" };
            case "Bearer bob":
              return { accountId: "bob" };
            case "Bearer alice-phone":
              return { accountId: "alice", scope: "phone" };
            default:
              return undefined;
          }
        },
      },
      internalAuthentication: {
        async authenticate(request) {
          return request.headers.authorization === "Bearer internal";
        },
      },
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const post = async (path: string, body: unknown, token: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
    return {
      status: response.status,
      body: parsed,
      code: (parsed.error as { readonly code?: string } | undefined)?.code,
    };
  };
  return {
    register: (publicKey: Uint8Array, token = "alice", id = installationId) =>
      post(
        REMOTE_INSTALLATION_REGISTRATION_PATH,
        encodeRemoteInstallationRegistrationRequest({
          version: 1,
          installationId: id,
          publicKey,
        }),
        token,
      ),
    ticket: (token = "alice", id = installationId) =>
      post("/v1/relay/tickets", { installationId: id, role: "daemon" }, token),
    consume: (ticket: string, connectionNonce: string, possessionProof: Uint8Array) =>
      post(
        "/internal/v1/relay/tickets/consume",
        encodeInternalConsumeRelayTicketRequest({
          ticket,
          relayInstanceId: "relay-a",
          connectionNonce,
          possessionProof,
        }),
        "internal",
      ),
  };
}

test("a registered daemon is admitted only with a signature by its installation key", async (context) => {
  const stack = await start(context);
  const key = await installationKey();
  assert.equal((await stack.ticket()).code, "forbidden_route", "unregistered is not admitted");
  assert.equal((await stack.register(key.publicKey)).status, 201);

  const issued = await stack.ticket();
  assert.equal(issued.status, 201);
  const ticket = issued.body.ticket as string;
  const nonce = "nonce-1";
  const signature = await key.sign(remoteDevicePossessionMessage(ticket, nonce));

  const forged = await (await installationKey()).sign(remoteDevicePossessionMessage(ticket, nonce));
  assert.equal((await stack.consume(ticket, nonce, forged)).code, "unauthorized");
  assert.equal(
    (await stack.consume(ticket, "nonce-2", signature)).code,
    "unauthorized",
    "a signature binds its connection nonce",
  );
  const admitted = await stack.consume(ticket, nonce, signature);
  assert.equal(admitted.status, 200);
  assert.equal(admitted.body.role, "daemon");
  assert.equal(admitted.body.installationId, installationId);
});

test("an installation belongs to one account and one key", async (context) => {
  const stack = await start(context);
  const [first, second] = [await installationKey(), await installationKey()];
  assert.equal((await stack.register(first.publicKey)).status, 201);
  assert.equal((await stack.register(first.publicKey)).status, 201, "a retry is fine");
  assert.equal((await stack.register(second.publicKey)).code, "installation_conflict");
  assert.equal((await stack.register(first.publicKey, "bob")).code, "installation_conflict");
  assert.equal(
    (await stack.ticket("bob")).code,
    "forbidden_route",
    "another account cannot ask for this daemon's tickets",
  );
  assert.equal((await stack.register(second.publicKey, "bob", other)).status, 201);
  assert.equal((await stack.ticket("alice", other)).code, "forbidden_route");
});

test("registration refuses phones, anonymous callers, and keys that are not P-256", async (context) => {
  const stack = await start(context);
  const key = await installationKey();
  assert.equal((await stack.register(key.publicKey, "nobody")).status, 401);
  assert.equal((await stack.register(key.publicKey, "alice-phone")).code, "scope_forbidden");
  const ed25519 = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  assert.equal((await stack.register(new Uint8Array(ed25519))).code, "invalid_device_key");
  assert.equal((await stack.register(new Uint8Array([1, 2, 3]))).code, "invalid_device_key");
  assert.equal((await stack.ticket()).code, "forbidden_route", "nothing was registered");
});
