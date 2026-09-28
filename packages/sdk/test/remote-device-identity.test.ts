// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import test from "node:test";

import {
  parseDeviceId,
  parseInstallationId,
  parseRemoteDeviceEnrollmentRequest,
  parseRemoteDeviceInvitationRequest,
  parseRemoteDeviceRevocationRequest,
  REMOTE_DEVICE_ENROLLMENT_PATH,
  REMOTE_DEVICE_INVITATION_PATH,
  REMOTE_DEVICE_REVOCATION_PATH,
  remoteDevicePossessionMessage,
} from "@axl/protocol";

import {
  createRemoteDeviceEnrollmentSecret,
  createRemoteDeviceKeyPair,
  type RemoteDeviceCryptoKeyPair,
  RemoteDeviceControlPlane,
  RemoteDeviceIdentityError,
  remoteDeviceKeyFromPair,
  remoteDevicePossession,
} from "../src/remote-device-identity.ts";
import type { RemoteFetch } from "../src/remote-relay.ts";

const installationId = parseInstallationId("01890a5d-ac96-774b-bcce-b302099a8057");
const deviceId = parseDeviceId("01890a5d-ac96-774b-bcce-b302099a8058");

test("a device key signs relay admissions the control plane can verify", async () => {
  const key = await remoteDeviceKeyFromPair(await createRemoteDeviceKeyPair());
  assert.equal(key.privateKey.extractable, false);
  const provider = remoteDevicePossession(key);
  const ticket = { ticket: "ticket-value" } as Parameters<typeof provider.create>[0];
  const first = await provider.create(ticket);
  const second = await provider.create(ticket);
  assert.notEqual(first.connectionNonce, second.connectionNonce, "every connection is fresh");
  assert.equal(first.possessionProof.byteLength, 64);

  const publicKey = createPublicKey({
    key: Buffer.from(key.publicKey),
    format: "der",
    type: "spki",
  });
  const verifies = (nonce: string, proof: Uint8Array) =>
    verify(
      "sha256",
      remoteDevicePossessionMessage("ticket-value", nonce),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      proof,
    );
  assert.equal(verifies(first.connectionNonce, first.possessionProof), true);
  assert.equal(verifies(second.connectionNonce, first.possessionProof), false);
});

test("an extractable key is refused as a device key", async () => {
  const extractable = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as RemoteDeviceCryptoKeyPair;
  await assert.rejects(remoteDeviceKeyFromPair(extractable), /extractable/u);
});

test("the control-plane client sends the wire requests and surfaces refusals", async () => {
  const requests: { readonly url: string; readonly body: unknown; readonly auth?: string }[] = [];
  let refusal: { readonly status: number; readonly body: string } | undefined;
  const fetch: RemoteFetch = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      ...(headers.authorization === undefined ? {} : { auth: headers.authorization }),
    });
    if (refusal !== undefined) return new Response(refusal.body, { status: refusal.status });
    return new Response(JSON.stringify({ version: 1, accepted: true }), { status: 200 });
  };
  const client = new RemoteDeviceControlPlane({
    controlPlaneOrigin: "https://stack.example/ignored/path",
    authenticationHeaders: async () => ({ authorization: "Bearer token" }),
    fetch,
  });
  const secret = createRemoteDeviceEnrollmentSecret();
  assert.equal(secret.byteLength, 32);
  const key = await remoteDeviceKeyFromPair(await createRemoteDeviceKeyPair());

  await client.invite(installationId, deviceId, secret);
  await client.enroll(installationId, deviceId, secret, key);
  await client.revoke(installationId, deviceId);
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      REMOTE_DEVICE_INVITATION_PATH,
      REMOTE_DEVICE_ENROLLMENT_PATH,
      REMOTE_DEVICE_REVOCATION_PATH,
    ].map((path) => `https://stack.example${path}`),
  );
  assert.ok(requests.every((request) => request.auth === "Bearer token"));
  const invitation = parseRemoteDeviceInvitationRequest(requests[0]?.body);
  assert.deepEqual(
    invitation.secretDigest,
    new Uint8Array(createHash("sha256").update(secret).digest()),
    "the daemon sends only the secret's digest",
  );
  const enrollment = parseRemoteDeviceEnrollmentRequest(requests[1]?.body);
  assert.deepEqual(enrollment.secret, secret);
  assert.deepEqual(enrollment.publicKey, key.publicKey);
  assert.equal(parseRemoteDeviceRevocationRequest(requests[2]?.body).deviceId, deviceId);

  refusal = {
    status: 409,
    body: JSON.stringify({ error: { code: "device_conflict", message: "taken" } }),
  };
  await assert.rejects(client.enroll(installationId, deviceId, secret, key), (error) => {
    assert.ok(error instanceof RemoteDeviceIdentityError);
    assert.equal(error.code, "device_conflict");
    assert.equal(error.status, 409);
    return true;
  });
  refusal = { status: 502, body: "<html>bad gateway</html>" };
  await assert.rejects(client.revoke(installationId, deviceId), {
    code: "request_failed",
    status: 502,
  });
});

test("the control-plane origin must be HTTPS without credentials", () => {
  const options = { authenticationHeaders: async () => ({}), fetch: async () => new Response() };
  assert.throws(
    () => new RemoteDeviceControlPlane({ ...options, controlPlaneOrigin: "http://stack.example" }),
    /HTTPS/u,
  );
  assert.throws(
    () =>
      new RemoteDeviceControlPlane({ ...options, controlPlaneOrigin: "https://u:p@stack.example" }),
    /HTTPS/u,
  );
});
