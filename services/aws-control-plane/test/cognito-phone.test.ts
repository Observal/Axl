// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";

import { CognitoPhoneAuthenticator } from "../src/aws.ts";

const issuer = "https://cognito-idp.ap-south-2.amazonaws.com/ap-south-2_Example";
const clientId = "phone-page-client";

async function keys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "pool-key", alg: "RS256", use: "sig" };
  const sign = (payload: JWTPayload, options: { issuer?: string; expires?: string } = {}) =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: "pool-key" })
      .setIssuer(options.issuer ?? issuer)
      .setSubject("google-user")
      .setIssuedAt()
      .setExpirationTime(options.expires ?? "1h")
      .sign(privateKey);
  return { jwks: createLocalJWKSet({ keys: [jwk] }), sign };
}

function request(token: string | undefined) {
  return { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } } as never;
}

test("Cognito access tokens for the phone client authenticate with the phone scope", async () => {
  const { jwks, sign } = await keys();
  const authenticator = new CognitoPhoneAuthenticator({
    issuer,
    clientId,
    accountId: "account-a",
    keys: jwks,
  });
  const access = await sign({ token_use: "access", client_id: clientId });
  assert.deepEqual(await authenticator.authenticate(request(access)), {
    accountId: "account-a",
    scope: "phone",
  });

  // An ID token, another client's token, another pool's, or an expired one is refused.
  for (const token of [
    await sign({ token_use: "id", aud: clientId }),
    await sign({ token_use: "access", client_id: "another-client" }),
    await sign({ token_use: "access", client_id: clientId }, { issuer: `${issuer}Other` }),
    await sign({ token_use: "access", client_id: clientId }, { expires: "-1m" }),
  ]) {
    assert.equal(await authenticator.authenticate(request(token)), undefined);
  }
  // A token signed by a key outside the pool's JWKS is refused.
  const other = await keys();
  const forged = await other.sign({ token_use: "access", client_id: clientId });
  assert.equal(await authenticator.authenticate(request(forged)), undefined);
  assert.equal(await authenticator.authenticate(request(undefined)), undefined);
  assert.equal(await authenticator.authenticate(request("not-a-jwt")), undefined);
});
