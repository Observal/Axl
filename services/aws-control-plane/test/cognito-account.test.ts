// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";

import { CognitoAccountAuthenticator } from "../src/aws.ts";

const issuer = "https://cognito-idp.ap-south-2.amazonaws.com/ap-south-2_Example";
const daemonClientId = "daemon-client";
const phoneClientId = "phone-page-client";
const sub = "4f1c2a3b-5d6e-4f70-8192-a3b4c5d6e7f8";

async function keys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "pool-key", alg: "RS256", use: "sig" };
  const sign = (
    payload: JWTPayload,
    options: { issuer?: string; expires?: string; subject?: string } = {},
  ) =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: "pool-key" })
      .setIssuer(options.issuer ?? issuer)
      .setSubject(options.subject ?? sub)
      .setIssuedAt()
      .setExpirationTime(options.expires ?? "1h")
      .sign(privateKey);
  return { jwks: createLocalJWKSet({ keys: [jwk] }), sign };
}

function request(token: string | undefined) {
  return { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } } as never;
}

test("the daemon client gets the account and the phone client the phone scope", async () => {
  const { jwks, sign } = await keys();
  const authenticator = new CognitoAccountAuthenticator({
    issuer,
    daemonClientId,
    phoneClientId,
    group: "remote",
    keys: jwks,
  });
  const groups = { "cognito:groups": ["remote"] };
  assert.deepEqual(
    await authenticator.authenticate(
      request(await sign({ token_use: "access", client_id: daemonClientId, ...groups })),
    ),
    { accountId: sub },
  );
  assert.deepEqual(
    await authenticator.authenticate(
      request(await sign({ token_use: "access", client_id: phoneClientId, ...groups })),
    ),
    { accountId: sub, scope: "phone" },
  );

  for (const token of [
    // Signed in, but not opted in to remote access.
    await sign({ token_use: "access", client_id: daemonClientId }),
    await sign({ token_use: "access", client_id: daemonClientId, "cognito:groups": ["other"] }),
    await sign({ token_use: "access", client_id: daemonClientId, "cognito:groups": "remote" }),
    // An ID token, another client's token, another pool's, or an expired one.
    await sign({ token_use: "id", aud: daemonClientId, ...groups }),
    await sign({ token_use: "access", client_id: "another-client", ...groups }),
    await sign(
      { token_use: "access", client_id: daemonClientId, ...groups },
      { issuer: `${issuer}Other` },
    ),
    await sign({ token_use: "access", client_id: daemonClientId, ...groups }, { expires: "-1m" }),
    // An account that is not a UUID cannot bind a witness lineage.
    await sign(
      { token_use: "access", client_id: daemonClientId, ...groups },
      { subject: "google_123" },
    ),
  ]) {
    assert.equal(await authenticator.authenticate(request(token)), undefined);
  }
  const other = await keys();
  const forged = await other.sign({ token_use: "access", client_id: daemonClientId, ...groups });
  assert.equal(await authenticator.authenticate(request(forged)), undefined);
  assert.equal(await authenticator.authenticate(request(undefined)), undefined);
  assert.equal(await authenticator.authenticate(request("not-a-jwt")), undefined);
});

test("the daemon and phone clients must differ", () => {
  assert.throws(
    () =>
      new CognitoAccountAuthenticator({
        issuer,
        daemonClientId: "same",
        phoneClientId: "same",
        group: "remote",
      }),
    TypeError,
  );
});
