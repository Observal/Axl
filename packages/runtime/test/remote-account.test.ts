// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { remoteDevicePossessionMessage } from "@axl/protocol";

import {
  DpapiHelper,
  loadRemoteAccount,
  parseRemoteAccountFile,
  RemoteAccountError,
  RemoteAccountSession,
  remoteAccountPath,
  saveRemoteAccount,
  startRemoteSignIn,
} from "../src/remote-account.ts";

const accountId = "4f1c2a3b-5d6e-4f70-8192-a3b4c5d6e7f8";
const config = {
  authority: "https://auth.stack.invalid",
  clientId: "daemon-client",
  provider: "Google",
};

/**
 * A stand-in for axl-dpapi-helper.exe: the same frames, with "sealing" that is a keyed XOR plus a
 * tag, so a value sealed under another key (another Windows user) is refused as denied.
 */
async function fakeHelper(directory: string, key = 0x5a): Promise<string> {
  const path = join(directory, `helper-${key}.mjs`);
  await writeFile(
    path,
    `#!/usr/bin/env node
let buffer = Buffer.alloc(0);
const TAG = Buffer.from("sealed-${key}:");
const respond = (status, payload = Buffer.alloc(0)) => {
  const header = Buffer.alloc(5);
  header[0] = status;
  header.writeUInt32BE(payload.length, 1);
  process.stdout.write(Buffer.concat([header, payload]));
};
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
    const op = buffer[0];
    const payload = buffer.subarray(5, 5 + buffer.readUInt32BE(1));
    buffer = buffer.subarray(5 + payload.length);
    const xor = (value) => Buffer.from(value.map((byte) => byte ^ ${key}));
    if (op === 0) respond(0, Buffer.from("axl-dpapi-helper-v1"));
    else if (op === 2) respond(0, Buffer.concat([TAG, xor(payload)]));
    else if (op === 3) {
      if (!payload.subarray(0, TAG.length).equals(TAG)) respond(2);
      else respond(0, xor(payload.subarray(TAG.length)));
    } else respond(3);
  }
});
`,
  );
  await chmod(path, 0o755);
  return path;
}

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.signature`;
}

async function directory(context: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "axl-remote-account-"));
  context.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function signedIn(context: TestContext) {
  const home = await directory(context);
  const helper = await fakeHelper(home);
  const account = await saveRemoteAccount({
    axlHome: home,
    origin: "https://stack.invalid",
    pagePath: "/remote/",
    config,
    tokens: {
      accessToken: jwt({ sub: accountId, token_use: "access" }),
      expiresAt: Date.now() + 3_600_000,
      refreshToken: "refresh-one",
      idToken: jwt({ sub: accountId, email: "person@example.com" }),
    },
    helper,
    binding: "/nowhere/loader/index.js",
  });
  return { home, helper, account };
}

test("login stores an owner-only account whose secrets are sealed, not written", async (context) => {
  const { home, account } = await signedIn(context);
  assert.equal(account.accountId, accountId);
  assert.equal(account.email, "person@example.com");
  const path = remoteAccountPath(home);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const raw = await readFile(path, "utf8");
  assert(!raw.includes("refresh-one"), "the refresh token is sealed");
  assert(!raw.includes("PRIVATE KEY"));
  assert.deepEqual(await loadRemoteAccount(home), parseRemoteAccountFile(JSON.parse(raw)));
});

test("a session refreshes access tokens, proves possession, and registers once", async (context) => {
  const { home, account } = await signedIn(context);
  const requests: { url: string; body: string }[] = [];
  let now = 1_900_000_000_000;
  let registerStatus = 401;
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/oauth2/token")) {
      return Response.json({
        access_token: jwt({ sub: accountId, n: requests.length }),
        expires_in: 3600,
      });
    }
    return new Response(registerStatus === 201 ? "{}" : "", { status: registerStatus });
  }) as typeof fetch;
  const session = await RemoteAccountSession.open(home, account, {
    fetch: fetcher,
    now: () => now,
  });

  const first = await session.accessToken();
  assert.equal(await session.accessToken(), first, "cached until close to expiry");
  assert.match(requests[0]?.body ?? "", /grant_type=refresh_token/u);
  assert.match(requests[0]?.body ?? "", /refresh_token=refresh-one/u);
  now += 56 * 60_000;
  assert.notEqual(await session.accessToken(), first, "refreshed before it expires");

  // Not in the remote group yet: reported, and the next attempt gets a fresh token.
  await assert.rejects(session.register(), (error: unknown) => {
    assert(error instanceof RemoteAccountError);
    assert.equal(error.code, "not_enabled");
    return true;
  });
  const tokenRequests = requests.filter((request) => request.url.endsWith("/oauth2/token")).length;
  registerStatus = 201;
  await session.register();
  await session.register();
  assert.equal(
    requests.filter((request) => request.url.endsWith("/oauth2/token")).length,
    tokenRequests + 1,
  );
  const registrations = requests.filter((request) =>
    request.url.endsWith("/v1/installations/register"),
  );
  assert.equal(registrations.length, 2, "registered once after the refusal");
  const registered = JSON.parse(registrations[1]?.body ?? "{}") as Record<string, string>;
  assert.equal(registered.installationId, account.installationId);

  const publicKey = createPublicKey({
    key: Buffer.from(registered.publicKey as string, "base64"),
    format: "der",
    type: "spki",
  });
  const { connectionNonce, possessionProof } = session.proof("ticket-value");
  assert(
    verify(
      "sha256",
      remoteDevicePossessionMessage("ticket-value", connectionNonce),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      possessionProof,
    ),
  );
});

test("sealed values open only for their purpose, account, and Windows user", async (context) => {
  const { home, account } = await signedIn(context);
  const swapped = {
    ...account,
    refreshToken: account.installationKey,
    installationKey: account.refreshToken,
  };
  await assert.rejects(RemoteAccountSession.open(home, swapped), /belongs elsewhere/u);
  const otherUser = { ...account, helper: await fakeHelper(home, 0x33) };
  await assert.rejects(RemoteAccountSession.open(home, otherUser), (error: unknown) => {
    assert(error instanceof RemoteAccountError);
    assert.equal(error.code, "sign_in_required");
    return true;
  });
  await assert.rejects(
    DpapiHelper.open(join(home, "missing-helper.exe")),
    (error: unknown) => error instanceof RemoteAccountError && error.code === "helper_unavailable",
  );
});

test("signing in again as the same person keeps the installation", async (context) => {
  const { home, helper, account } = await signedIn(context);
  const again = await saveRemoteAccount({
    axlHome: home,
    origin: account.origin,
    pagePath: account.pagePath,
    config,
    tokens: {
      accessToken: jwt({ sub: accountId }),
      expiresAt: Date.now() + 3_600_000,
      refreshToken: "refresh-two",
    },
    helper,
    binding: account.binding,
  });
  assert.equal(again.installationId, account.installationId);
  assert.equal(again.installationKey, account.installationKey);
  assert.notEqual(again.refreshToken, account.refreshToken);
  const someoneElse = await saveRemoteAccount({
    axlHome: home,
    origin: account.origin,
    pagePath: account.pagePath,
    config,
    tokens: {
      accessToken: jwt({ sub: "7a1c2a3b-5d6e-4f70-8192-a3b4c5d6e7f9" }),
      expiresAt: Date.now() + 3_600_000,
      refreshToken: "refresh-three",
    },
    helper,
    binding: account.binding,
  });
  assert.notEqual(someoneElse.installationId, account.installationId);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

test("the loopback sign-in exchanges the code with its PKCE verifier", async () => {
  const port = await freePort();
  let exchanged: URLSearchParams | undefined;
  const fetcher = (async (_input: string | URL, init?: RequestInit) => {
    exchanged = new URLSearchParams(String(init?.body));
    return Response.json({
      access_token: jwt({ sub: accountId }),
      refresh_token: "refresh",
      expires_in: 3600,
    });
  }) as typeof fetch;
  const pending = await startRemoteSignIn({ config, fetch: fetcher, port });
  const authorize = new URL(pending.url);
  assert.equal(authorize.origin, config.authority);
  assert.equal(authorize.searchParams.get("redirect_uri"), `http://localhost:${port}/callback`);
  assert.equal(authorize.searchParams.get("identity_provider"), "Google");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  const state = authorize.searchParams.get("state") as string;

  const completed = pending.complete(10_000);
  // Another page cannot answer for this sign-in.
  const forged = await fetch(`http://127.0.0.1:${port}/callback?code=evil&state=other`);
  assert.equal(forged.status, 400);
  const answer = await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=${state}`);
  assert.equal(answer.status, 200);
  const tokens = await completed;
  assert.equal(tokens.refreshToken, "refresh");
  assert.equal(exchanged?.get("code"), "the-code");
  assert.equal(exchanged?.get("grant_type"), "authorization_code");
  const verifier = exchanged?.get("code_verifier") as string;
  const { createHash } = await import("node:crypto");
  assert.equal(
    createHash("sha256").update(verifier).digest("base64url"),
    authorize.searchParams.get("code_challenge"),
  );
});

test(
  "the real Windows helper seals the account for this Windows user",
  { skip: process.env.AXL_WSL_DPAPI_HELPER === undefined && "set AXL_WSL_DPAPI_HELPER in WSL" },
  async (context) => {
    const home = await directory(context);
    const account = await saveRemoteAccount({
      axlHome: home,
      origin: "https://stack.invalid",
      pagePath: "/remote/",
      config,
      tokens: {
        accessToken: jwt({ sub: accountId }),
        expiresAt: Date.now() + 3_600_000,
        refreshToken: "refresh-real",
      },
      helper: process.env.AXL_WSL_DPAPI_HELPER as string,
      binding: "/nowhere/loader/index.js",
    });
    const session = await RemoteAccountSession.open(home, account);
    assert.equal(session.publicKey().byteLength, 91);
  },
);
