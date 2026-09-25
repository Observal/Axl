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

import { HostedPairingClient, HostedPairingError } from "../src/remote-pairing.ts";

const installationId = parseInstallationId("11111111-1111-4111-8111-111111111111");
const deviceId = parseDeviceId("22222222-2222-4222-8222-222222222222");
const cryptoSessionId = parseCryptoSessionId("33333333-3333-4333-8333-333333333333");
const reservationId = parseOperationId("44444444-4444-4444-8444-444444444444");
const claim = Uint8Array.of(1, 2, 3);
const claimHash = new Uint8Array(createHash("sha384").update(claim).digest());
const welcome = Uint8Array.of(4, 5, 6);
const welcomeHash = new Uint8Array(createHash("sha384").update(welcome).digest());
const binding = { version: 1 as const, installationId, deviceId, cryptoSessionId, claimHash };

test("hosted pairing client transports exact claim and Welcome bytes", async () => {
  const paths: string[] = [];
  const client = new HostedPairingClient({
    origin: "https://control.example",
    authorization: async () => "token",
    fetch: async (input, init) => {
      const url = String(input);
      paths.push(new URL(url).pathname);
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer token");
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("/claims/reserve")) {
        return Response.json({
          version: 1,
          reservationId,
          claim: Buffer.from(claim).toString("base64"),
          claimHash: Buffer.from(claimHash).toString("base64"),
          expiresAt: 1_900_000_000_000,
        });
      }
      if (url.endsWith("/welcomes") || url.endsWith("/welcomes/fetch")) {
        assert.equal(body.claimHash, Buffer.from(claimHash).toString("base64"));
        return Response.json({
          version: 1,
          welcome: Buffer.from(welcome).toString("base64"),
          welcomeHash: Buffer.from(welcomeHash).toString("base64"),
          expiresAt: 1_900_000_000_000,
        });
      }
      if (url.endsWith("/acknowledge")) return new Response(undefined, { status: 204 });
      return Response.json({ version: 1, accepted: true }, { status: 201 });
    },
  });

  await client.publishClaim({ ...binding, claim });
  assert.deepEqual(await client.reserveClaim({ ...binding, reservationId }), {
    version: 1,
    reservationId,
    claim,
    claimHash,
    expiresAt: 1_900_000_000_000,
  });
  const publication = await client.publishWelcome({
    ...binding,
    reservationId,
    welcome,
    welcomeHash,
  });
  assert.deepEqual(await client.fetchWelcome(binding), publication);
  await client.acknowledgeWelcome({ ...binding, welcomeHash });
  assert.deepEqual(paths, [
    "/v1/e2ee/pairing/claims",
    "/v1/e2ee/pairing/claims/reserve",
    "/v1/e2ee/pairing/welcomes",
    "/v1/e2ee/pairing/welcomes/fetch",
    "/v1/e2ee/pairing/welcomes/acknowledge",
  ]);
});

test("hosted pairing client requires HTTPS and redacts service failures", async () => {
  assert.throws(
    () =>
      new HostedPairingClient({
        origin: "http://control.example",
        authorization: async () => "token",
      }),
    /HTTPS/u,
  );
  const client = new HostedPairingClient({
    origin: "https://control.example",
    authorization: async () => "token",
    fetch: async () =>
      Response.json({ error: { code: "expired", message: "sensitive" } }, { status: 410 }),
  });
  await assert.rejects(
    client.fetchWelcome(binding),
    (error) =>
      error instanceof HostedPairingError &&
      error.code === "expired" &&
      !error.message.includes("sensitive"),
  );
});
