// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";

import {
  encodeInternalConsumeRelayTicketRequest,
  encodeRemoteDeviceEnrollmentRequest,
  encodeRemoteDeviceInvitationRequest,
  encodeRemoteDeviceRevocationRequest,
  parseDeviceId,
  parseInstallationId,
  REMOTE_DEVICE_ENROLLMENT_PATH,
  REMOTE_DEVICE_ENROLLMENT_WINDOW_MS,
  REMOTE_DEVICE_INVITATION_PATH,
  REMOTE_DEVICE_REVOCATION_PATH,
  remoteDevicePossessionMessage,
} from "@axl/protocol";

import {
  createControlPlaneHandler,
  InMemoryRelayTicketStore,
  InMemoryRemoteDeviceStore,
  RelayTicketService,
  RemoteDeviceService,
} from "../src/index.ts";

const installationId = parseInstallationId("01890a5d-ac96-774b-bcce-b302099a8057");
const phone = parseDeviceId("01890a5d-ac96-774b-bcce-b302099a8058");
const tablet = parseDeviceId("01890a5d-ac96-774b-bcce-b302099a8059");
const TOKEN = "account-token";

/** A device key the way the phone page makes one: non-extractable P-256 in WebCrypto. */
async function deviceKey() {
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
  let now = 1_900_000_000_000;
  const clock = { now: () => now };
  const devices = new RemoteDeviceService({ store: new InMemoryRemoteDeviceStore(), clock });
  const tickets = new RelayTicketService({
    store: new InMemoryRelayTicketStore(),
    relayUrl: "wss://relay.invalid/v1/connect",
    clock,
    authorizer: {
      async currentGeneration(principal, request) {
        if (request.role === "daemon") return 1;
        return request.deviceId === undefined
          ? undefined
          : devices.generation(principal, request.installationId, request.deviceId);
      },
    },
    proofVerifier: { verify: (ticket, request) => devices.verifyPossession(ticket, request) },
  });
  const server = createServer(
    createControlPlaneHandler({
      tickets,
      devices,
      publicAuthentication: {
        async authenticate(request) {
          return request.headers.authorization === `Bearer ${TOKEN}`
            ? { accountId: "account-fixture" }
            : undefined;
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
  const post = async (path: string, body: unknown, authorization = `Bearer ${TOKEN}`) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const code = (result: { readonly body: Record<string, unknown> }) =>
    (result.body.error as { readonly code?: string } | undefined)?.code;
  const invite = (deviceId = phone, secret = randomBytes(32)) =>
    post(
      REMOTE_DEVICE_INVITATION_PATH,
      encodeRemoteDeviceInvitationRequest({
        version: 1,
        installationId,
        deviceId,
        secretDigest: createHash("sha256").update(secret).digest(),
      }),
    ).then((result) => ({ ...result, secret }));
  const enroll = (secret: Uint8Array, publicKey: Uint8Array, deviceId = phone) =>
    post(
      REMOTE_DEVICE_ENROLLMENT_PATH,
      encodeRemoteDeviceEnrollmentRequest({
        version: 1,
        installationId,
        deviceId,
        secret,
        publicKey,
      }),
    );
  const revoke = (deviceId = phone) =>
    post(
      REMOTE_DEVICE_REVOCATION_PATH,
      encodeRemoteDeviceRevocationRequest({ version: 1, installationId, deviceId }),
    );
  const ticket = (deviceId = phone) =>
    post("/v1/relay/tickets", { installationId, role: "device", deviceId });
  const consume = (ticketValue: string, connectionNonce: string, possessionProof: Uint8Array) =>
    post(
      "/internal/v1/relay/tickets/consume",
      encodeInternalConsumeRelayTicketRequest({
        ticket: ticketValue,
        relayInstanceId: "relay-a",
        connectionNonce,
        possessionProof,
      }),
      "Bearer internal",
    );
  return {
    post,
    invite,
    enroll,
    revoke,
    ticket,
    consume,
    code,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

test("an enrolled device is admitted only with a signature by its own key", async (context) => {
  const stack = await start(context);
  const key = await deviceKey();
  const { secret, status } = await stack.invite();
  assert.equal(status, 200);
  assert.equal(stack.code(await stack.ticket()), "forbidden_route", "invited is not enrolled");
  assert.equal((await stack.enroll(secret, key.publicKey)).status, 200);

  const issued = await stack.ticket();
  assert.equal(issued.status, 201);
  const ticketValue = issued.body.ticket as string;
  const nonce = "nonce-1";
  const signature = await key.sign(remoteDevicePossessionMessage(ticketValue, nonce));

  const otherKey = await deviceKey();
  const forged = await otherKey.sign(remoteDevicePossessionMessage(ticketValue, nonce));
  assert.equal(stack.code(await stack.consume(ticketValue, nonce, forged)), "unauthorized");
  assert.equal(
    stack.code(await stack.consume(ticketValue, "nonce-2", signature)),
    "unauthorized",
    "a signature binds its connection nonce",
  );
  const admitted = await stack.consume(ticketValue, nonce, signature);
  assert.equal(admitted.status, 200);
  assert.equal(admitted.body.deviceId, phone);
  assert.equal(admitted.body.role, "device");
});

test("enrollment needs the invitation's secret and binds exactly one key", async (context) => {
  const stack = await start(context);
  const [first, second] = [await deviceKey(), await deviceKey()];
  assert.equal(
    stack.code(await stack.enroll(randomBytes(32), first.publicKey)),
    "device_not_found",
  );
  const { secret } = await stack.invite();
  assert.equal(stack.code(await stack.invite(phone)), "device_conflict", "one invitation per ID");
  assert.equal((await stack.invite(phone, secret)).status, 200, "a retried invitation is fine");

  assert.equal(
    stack.code(await stack.enroll(randomBytes(32), first.publicKey)),
    "enrollment_denied",
  );
  assert.equal((await stack.enroll(secret, first.publicKey)).status, 200);
  assert.equal((await stack.enroll(secret, first.publicKey)).status, 200, "a retry is fine");
  assert.equal(
    stack.code(await stack.enroll(secret, second.publicKey)),
    "device_conflict",
    "a copied link cannot enroll a second key",
  );
});

test("enrollment closes with the pairing window and rejects keys that are not P-256", async (context) => {
  const stack = await start(context);
  const key = await deviceKey();
  const late = await stack.invite();
  stack.advance(REMOTE_DEVICE_ENROLLMENT_WINDOW_MS + 1);
  assert.equal(stack.code(await stack.enroll(late.secret, key.publicKey)), "enrollment_expired");

  const { secret } = await stack.invite(tablet);
  const ed25519 = new Uint8Array(
    generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }),
  );
  assert.equal(stack.code(await stack.enroll(secret, ed25519, tablet)), "invalid_device_key");
  assert.equal(
    stack.code(await stack.enroll(secret, Uint8Array.of(1, 2, 3), tablet)),
    "invalid_device_key",
  );
});

test("a malformed device request is a bad request, not an outage", async (context) => {
  const stack = await start(context);
  const { secret } = await stack.invite();
  const valid = encodeRemoteDeviceEnrollmentRequest({
    version: 1,
    installationId,
    deviceId: phone,
    secret,
    publicKey: (await deviceKey()).publicKey,
  });
  const empty = await stack.post(REMOTE_DEVICE_ENROLLMENT_PATH, { ...valid, publicKey: "" });
  assert.equal(empty.status, 400);
  assert.equal(stack.code(empty), "bad_request");
  const unauthenticated = await stack.post(REMOTE_DEVICE_ENROLLMENT_PATH, valid, "Bearer wrong");
  assert.deepEqual(unauthenticated, { status: 401, body: { error: { code: "unauthorized" } } });
});

test("revoking a device stops new tickets and ones already issued", async (context) => {
  const stack = await start(context);
  const key = await deviceKey();
  const { secret } = await stack.invite();
  await stack.enroll(secret, key.publicKey);
  const issued = (await stack.ticket()).body.ticket as string;

  assert.equal((await stack.revoke()).status, 200);
  assert.equal((await stack.revoke()).status, 200, "revoking twice is fine");
  assert.equal(stack.code(await stack.ticket()), "forbidden_route");
  const signature = await key.sign(remoteDevicePossessionMessage(issued, "nonce"));
  assert.equal(stack.code(await stack.consume(issued, "nonce", signature)), "unauthorized");
  assert.equal(
    stack.code(await stack.enroll(secret, key.publicKey)),
    "device_revoked",
    "a revoked device cannot enroll again",
  );
  assert.equal(stack.code(await stack.revoke(tablet)), "device_not_found");
});

test("devices are separate: one device's key cannot admit another", async (context) => {
  const stack = await start(context);
  const [phoneKey, tabletKey] = [await deviceKey(), await deviceKey()];
  await stack.enroll((await stack.invite(phone)).secret, phoneKey.publicKey);
  await stack.enroll((await stack.invite(tablet)).secret, tabletKey.publicKey, tablet);

  const tabletTicket = (await stack.ticket(tablet)).body.ticket as string;
  const withPhoneKey = await phoneKey.sign(remoteDevicePossessionMessage(tabletTicket, "n"));
  assert.equal(stack.code(await stack.consume(tabletTicket, "n", withPhoneKey)), "unauthorized");
  const withTabletKey = await tabletKey.sign(remoteDevicePossessionMessage(tabletTicket, "n"));
  assert.equal((await stack.consume(tabletTicket, "n", withTabletKey)).body.deviceId, tablet);
});

test("concurrent enrollments with different keys leave exactly one", async () => {
  const devices = new RemoteDeviceService({ store: new InMemoryRemoteDeviceStore() });
  const principal = { accountId: "account-fixture" };
  const secret = randomBytes(32);
  await devices.invite(
    principal,
    encodeRemoteDeviceInvitationRequest({
      version: 1,
      installationId,
      deviceId: phone,
      secretDigest: createHash("sha256").update(secret).digest(),
    }),
  );
  const keys = await Promise.all([deviceKey(), deviceKey(), deviceKey()]);
  const results = await Promise.allSettled(
    keys.map((key) =>
      devices.enroll(
        principal,
        encodeRemoteDeviceEnrollmentRequest({
          version: 1,
          installationId,
          deviceId: phone,
          secret,
          publicKey: key.publicKey,
        }),
      ),
    ),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
});
