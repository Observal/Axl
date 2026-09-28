// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  PhoneSignIn,
  parseSignInConfig,
  pkceChallenge,
  SignInRequiredError,
  type SignInStorage,
} from "../src/remote/sign-in.ts";

const config = {
  authority: "https://auth.example",
  clientId: "phone-page",
  provider: "Google",
};

function storage(): SignInStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

interface Call {
  readonly url: string;
  readonly form: URLSearchParams;
}

function harness(answers: Array<() => Response>) {
  let now = 1_900_000_000_000;
  const calls: Call[] = [];
  const local = storage();
  const session = storage();
  const signIn = new PhoneSignIn({
    config,
    redirectUri: "https://remote.example/remote/",
    local,
    session,
    now: () => now,
    fetch: async (input, init) => {
      calls.push({ url: String(input), form: new URLSearchParams(String(init?.body ?? "")) });
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected request");
      return answer();
    },
  });
  return {
    signIn,
    calls,
    local,
    session,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const token = (access: string, refresh?: string) => () =>
  Response.json({
    access_token: access,
    expires_in: 3600,
    token_type: "Bearer",
    ...(refresh === undefined ? {} : { refresh_token: refresh }),
  });

test("sign-in config needs an HTTPS authority and a client", () => {
  assert.deepEqual(parseSignInConfig({ authority: "https://auth.example/", clientId: "c" }), {
    authority: "https://auth.example",
    clientId: "c",
    provider: "Google",
  });
  assert.equal(parseSignInConfig({ authority: "http://auth.example", clientId: "c" }), undefined);
  assert.equal(parseSignInConfig({ authority: "https://auth.example" }), undefined);
  assert.equal(parseSignInConfig({ authority: "not a url", clientId: "c" }), undefined);
  assert.equal(parseSignInConfig(null), undefined);
});

test("the code flow keeps the pairing fragment and exchanges the code with its verifier", async () => {
  const { signIn, calls, local, session } = harness([token("access-1", "refresh-1")]);
  assert.equal(signIn.signedIn, false);
  const url = new URL(await signIn.authorizeUrl("#p=abc.def"));
  assert.equal(url.origin + url.pathname, "https://auth.example/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), "phone-page");
  assert.equal(url.searchParams.get("identity_provider"), "Google");
  assert.equal(url.searchParams.get("redirect_uri"), "https://remote.example/remote/");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  // The pairing fragment waits in session storage, never in the provider's URL.
  assert.equal(url.toString().includes("abc.def"), false);
  const state = url.searchParams.get("state") ?? "";

  const seen: string[] = [];
  signIn.onToken((access) => seen.push(access));
  const returned = await signIn.complete(`?code=the-code&state=${state}`);
  assert.deepEqual(returned, { fragment: "#p=abc.def" });
  const exchange = calls[0];
  assert.equal(exchange?.url, "https://auth.example/oauth2/token");
  assert.equal(exchange?.form.get("grant_type"), "authorization_code");
  assert.equal(exchange?.form.get("code"), "the-code");
  const verifier = exchange?.form.get("code_verifier") ?? "";
  assert.equal(await pkceChallenge(verifier), url.searchParams.get("code_challenge"));
  assert.equal(signIn.signedIn, true);
  assert.equal(await signIn.accessToken(), "access-1");
  assert.deepEqual(seen, ["access-1"]);
  assert.equal(session.values.size, 0, "the pending sign-in is forgotten");
  assert.ok([...local.values.values()].some((value) => value.includes("refresh-1")));
  // Nothing to finish on a plain load.
  assert.equal(await signIn.complete(""), undefined);
});

test("an answer that this page did not ask for is refused", async () => {
  const { signIn, calls } = harness([]);
  await signIn.authorizeUrl("");
  await assert.rejects(signIn.complete("?code=x&state=forged"), SignInRequiredError);
  assert.equal(calls.length, 0);
  // The pending sign-in is gone, so replaying the right state later is refused too.
  await assert.rejects(signIn.complete("?code=x&state=anything"), SignInRequiredError);
  const cancelled = harness([]);
  const url = new URL(await cancelled.signIn.authorizeUrl(""));
  await assert.rejects(
    cancelled.signIn.complete(`?error=access_denied&state=${url.searchParams.get("state")}`),
    /cancelled/u,
  );
});

test("access tokens refresh before they expire and a dead session asks to sign in", async () => {
  const { signIn, calls, local, advance } = harness([
    token("access-1", "refresh-1"),
    token("access-2"),
    () => Response.json({ error: "invalid_grant" }, { status: 400 }),
  ]);
  const url = new URL(await signIn.authorizeUrl(""));
  await signIn.complete(`?code=c&state=${url.searchParams.get("state")}`);
  advance(30 * 60_000);
  assert.equal(await signIn.accessToken(), "access-1", "still fresh");
  advance(26 * 60_000);
  // Within five minutes of expiry: two callers share one refresh.
  const [first, second] = await Promise.all([signIn.accessToken(), signIn.accessToken()]);
  assert.deepEqual([first, second], ["access-2", "access-2"]);
  assert.equal(calls[1]?.form.get("grant_type"), "refresh_token");
  assert.equal(calls[1]?.form.get("refresh_token"), "refresh-1");
  assert.equal(calls.length, 2);

  advance(58 * 60_000);
  await assert.rejects(signIn.accessToken(), SignInRequiredError);
  assert.equal(signIn.signedIn, false);
  assert.equal(local.values.size, 0);
});

test("a refresh that fails for the network keeps a token that is still good", async () => {
  const { signIn, advance } = harness([
    token("access-1", "refresh-1"),
    () => {
      throw new TypeError("network down");
    },
  ]);
  const url = new URL(await signIn.authorizeUrl(""));
  await signIn.complete(`?code=c&state=${url.searchParams.get("state")}`);
  advance(56 * 60_000);
  assert.equal(await signIn.accessToken(), "access-1");
});
