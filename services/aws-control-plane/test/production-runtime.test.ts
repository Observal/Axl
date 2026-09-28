// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  encodeInternalConsumeRelayTicketRequest,
  encodeRemoteInstallationRegistrationRequest,
  parseInstallationId,
  REMOTE_INSTALLATION_REGISTRATION_PATH,
  remoteDevicePossessionMessage,
} from "@axl/protocol";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";

import { startFakeDynamoDb } from "./support/fake-dynamodb.ts";

const runtime = fileURLToPath(new URL("../src/production-runtime.ts", import.meta.url));
const installationId = parseInstallationId("01890a5d-ac96-774b-bcce-b302099a8057");
const alice = "4f1c2a3b-5d6e-4f70-8192-a3b4c5d6e7f8";
const bob = "7a1c2a3b-5d6e-4f70-8192-a3b4c5d6e7f9";
const RELAY_TOKEN = "relay-service-token";

/** A user pool's JWKS on a local port, and access tokens it signs. */
async function startPool() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "pool-key", alg: "RS256", use: "sig" };
  const server = createServer((request, response) => {
    if (request.url === "/pool/.well-known/jwks.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pool`;
  const sign = (subject: string, payload: JWTPayload) =>
    new SignJWT({ token_use: "access", ...payload })
      .setProtectedHeader({ alg: "RS256", kid: "pool-key" })
      .setIssuer(issuer)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  return { issuer, sign, close: () => server.close() };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  return port;
}

async function installationKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
    sign: async (message: Uint8Array) =>
      new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, message),
      ),
  };
}

test("the production runtime admits only opted-in accounts, each to its own installations", async (context) => {
  const db = await startFakeDynamoDb();
  const pool = await startPool();
  const port = await freePort();
  const child = spawn(process.execPath, [runtime], {
    env: {
      PATH: process.env.PATH,
      AXL_ENVIRONMENT: "production",
      AWS_ENDPOINT_URL_DYNAMODB: db.endpoint,
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "fake",
      AWS_SECRET_ACCESS_KEY: "fake",
      AXL_TICKET_TABLE: "state",
      AXL_WITNESS_TABLE: "witness",
      AXL_WITNESS_JOURNAL_TABLE: "witness-journal",
      AXL_RELAY_TOKEN: RELAY_TOKEN,
      AXL_RELAY_URL: "wss://relay.invalid/v1/connect",
      AXL_COGNITO_ISSUER: pool.issuer,
      AXL_DAEMON_CLIENT_ID: "daemon",
      AXL_PHONE_CLIENT_ID: "phone",
      AXL_REMOTE_GROUP: "remote",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  context.after(async () => {
    child.kill();
    pool.close();
    await db.close();
  });
  for (let attempt = 0; !output.includes("listening on"); attempt += 1) {
    assert.ok(attempt < 200 && child.exitCode === null, `runtime did not start:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const origin = `http://127.0.0.1:${port}`;
  const post = async (path: string, body: unknown, token: string) => {
    const response = await fetch(`${origin}${path}`, {
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
  const groups = { "cognito:groups": ["remote"] };
  const aliceDaemon = await pool.sign(alice, { client_id: "daemon", ...groups });
  const alicePhone = await pool.sign(alice, { client_id: "phone", ...groups });
  const bobDaemon = await pool.sign(bob, { client_id: "daemon", ...groups });
  const notOptedIn = await pool.sign(alice, { client_id: "daemon" });
  const key = await installationKey();
  const register = (token: string) =>
    post(
      REMOTE_INSTALLATION_REGISTRATION_PATH,
      encodeRemoteInstallationRegistrationRequest({
        version: 1,
        installationId,
        publicKey: key.publicKey,
      }),
      token,
    );
  const ticket = (token: string) =>
    post("/v1/relay/tickets", { installationId, role: "daemon" }, token);

  const health = (await (await fetch(`${origin}/healthz`)).json()) as Record<string, unknown>;
  assert.equal(health.mode, "production");

  assert.equal((await register(notOptedIn)).status, 401, "sign-in alone is not remote access");
  assert.equal((await register(alicePhone)).code, "scope_forbidden");
  assert.equal((await ticket(aliceDaemon)).code, "forbidden_route", "not registered yet");
  assert.equal((await register(aliceDaemon)).status, 201);
  assert.equal((await register(bobDaemon)).code, "installation_conflict");
  assert.equal((await ticket(bobDaemon)).code, "forbidden_route");
  assert.equal(
    (
      await post(
        "/v1/relay/tickets",
        { installationId, role: "device", deviceId: installationId },
        bobDaemon,
      )
    ).code,
    "forbidden_route",
    "another account's device cannot join this installation's routes",
  );

  const issued = await ticket(aliceDaemon);
  assert.equal(issued.status, 201);
  const value = issued.body.ticket as string;
  const consume = (proof: Uint8Array) =>
    post(
      "/internal/v1/relay/tickets/consume",
      encodeInternalConsumeRelayTicketRequest({
        ticket: value,
        relayInstanceId: "relay-a",
        connectionNonce: "nonce-1",
        possessionProof: proof,
      }),
      RELAY_TOKEN,
    );
  const forged = await (await installationKey()).sign(
    remoteDevicePossessionMessage(value, "nonce-1"),
  );
  assert.equal((await consume(forged)).code, "unauthorized");
  const admitted = await consume(await key.sign(remoteDevicePossessionMessage(value, "nonce-1")));
  assert.equal(admitted.status, 200);
  assert.equal(admitted.body.role, "daemon");
});
