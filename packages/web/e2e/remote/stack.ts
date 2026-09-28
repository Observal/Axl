// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

// A local copy of the hosted stack for phone remote-control evidence: the control plane with its
// in-process witness, keeping all of its state (tickets, installations, devices, pairing, and
// witness replicas) in a fake DynamoDB process like the stack's tables; the Elixir relay; one HTTPS
// origin that serves the phone page and forwards to both (like the stack's CloudFront); a scripted
// model; and a real sandboxed daemon. The origin can drop or stall every relay socket, and the
// relay, control plane, and daemon can be restarted, so tests inject the failures phones see.
// A fake of the stack's Cognito user pool signs the phone in, so the link carries no account token.
//
// By default the stack runs in production mode (AXL_REMOTE_E2E_MODE=production): the production
// control plane, a daemon signed in through `~/.axl/remote/account.json` with its secrets sealed by
// a stand-in for the Windows DPAPI helper, the installation's own key admitting its relay
// connections, and the hosted WSL Node binding. AXL_REMOTE_E2E_MODE=deployment-test runs the
// deployment-test control plane and daemon configuration instead.

import { spawn } from "node:child_process";
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createNetServer } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { connectUnixClient } from "@axl/sdk/unix";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const RELAY_TOKEN = "internal-fixture";
const production = (process.env.AXL_REMOTE_E2E_MODE ?? "production") === "production";
const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cross-origin-opener-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

/** Pairing identities are UUIDv7: a millisecond timestamp, version 7, variant 10. */
function uuidV7() {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A stand-in for `axl-dpapi-helper.exe` with the same frames: "sealing" is a keyed XOR behind a
 * tag, and the Windows user is a fixed SID. Enough for the daemon's stores to run on Linux.
 */
const FAKE_DPAPI_HELPER = `#!/usr/bin/env node
const TAG = Buffer.from("e2e-sealed:");
let buffer = Buffer.alloc(0);
const respond = (status, payload = Buffer.alloc(0)) => {
  const header = Buffer.alloc(5);
  header[0] = status;
  header.writeUInt32BE(payload.length, 1);
  process.stdout.write(Buffer.concat([header, payload]));
};
const xor = (value) => Buffer.from(value.map((byte) => byte ^ 0x5a));
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
    const op = buffer[0];
    const payload = buffer.subarray(5, 5 + buffer.readUInt32BE(1));
    buffer = buffer.subarray(5 + payload.length);
    if (op === 0) respond(0, Buffer.from("axl-dpapi-helper-v1"));
    else if (op === 1) respond(0, Buffer.from("S-1-5-21-1000-1000-1000-1001"));
    else if (op === 2 && payload.length > 0) respond(0, Buffer.concat([TAG, xor(payload)]));
    else if (op === 3 && payload.subarray(0, TAG.length).equals(TAG)) {
      respond(0, xor(payload.subarray(TAG.length)));
    } else if (op === 3) respond(2);
    else respond(3);
  }
});
`;

async function freePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function until(description, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // Not ready yet.
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(100);
  }
}

/** A child process whose output goes to a log file and is watched for a ready line. */
class Service {
  #child;
  #output = "";

  constructor(name, command, args, options, logDirectory) {
    this.name = name;
    const log = createWriteStream(join(logDirectory, `${name}.log`), { flags: "a" });
    this.#child = spawn(command, args, { ...options, detached: true, stdio: "pipe" });
    for (const stream of [this.#child.stdout, this.#child.stderr]) {
      stream.on("data", (chunk) => {
        this.#output = (this.#output + chunk.toString()).slice(-64_000);
        log.write(chunk);
      });
    }
    this.exited = once(this.#child, "exit");
  }

  ready(pattern, timeoutMs) {
    return until(
      `${this.name} to start`,
      () => {
        if (this.#child.exitCode !== null) {
          throw new Error(`${this.name} exited early:\n${this.#output}`);
        }
        return pattern.test(this.#output);
      },
      timeoutMs,
    ).catch((cause) => {
      throw new Error(`${cause.message}\n${this.#output}`);
    });
  }

  async stop() {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    // The whole process group: mix starts the BEAM as a child.
    try {
      process.kill(-this.#child.pid, "SIGTERM");
    } catch {
      return;
    }
    const killed = setTimeout(() => {
      try {
        process.kill(-this.#child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, 5_000);
    await this.exited;
    clearTimeout(killed);
  }
}

/**
 * An OpenAI chat-completions stand-in that streams `Echo: <prompt>` and counts every prompt it is
 * asked to answer, so a test can prove each prompt reached the model exactly once. A prompt that
 * starts with `ask:` first calls `ask_user_question`; the request carrying the tool's answer is
 * answered with `Echo: answered <answer>` and not counted as a new prompt.
 */
async function startModel() {
  const prompts = new Map();
  const server = createHttpServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", async () => {
      const body = JSON.parse(raw || "{}");
      const messages = body.messages ?? [];
      const last = messages.at(-1);
      const user = [...messages].reverse().find((message) => message.role === "user");
      const text = (
        typeof user?.content === "string"
          ? user.content
          : (user?.content ?? []).map((part) => part.text ?? "").join("")
      ).trim();
      const answering = last?.role === "tool";
      if (!answering) prompts.set(text, (prompts.get(text) ?? 0) + 1);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish = null) =>
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      if (text.startsWith("ask:") && !answering) {
        const question = {
          questions: [
            {
              header: "Color",
              question: `Which color for ${text.slice(4).trim()}?`,
              options: [
                { label: "Red", description: "A warm color" },
                { label: "Blue", description: "A cool color" },
              ],
            },
          ],
        };
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call_${prompts.size}`,
              type: "function",
              function: { name: "ask_user_question", arguments: JSON.stringify(question) },
            },
          ],
        });
        chunk({}, "tool_calls");
        response.end(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      const toolText =
        typeof last?.content === "string"
          ? last.content
          : (last?.content ?? []).map((part) => part.text ?? "").join("");
      const reply = answering
        ? `Echo: answered ${toolText.replace(/\s+/gu, " ").trim()}`
        : `Echo: ${text}`;
      for (const word of reply.split(/(?<= )/u)) {
        chunk({ content: word });
        await delay(40);
      }
      chunk({}, "stop");
      response.end(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: server.address().port, prompts };
}

/**
 * A stand-in for the stack's Cognito user pool with Google behind it: `/oauth2/authorize` signs in
 * at once and redirects back with a code, `/oauth2/token` checks PKCE and issues RS256 access
 * tokens shaped like Cognito's, and the pool's JWKS is served over plain HTTP for the control plane.
 * One person (`accountId`), in the remote group, signs in with the phone page's client and the
 * daemon's.
 */
async function startAuthority(accountId) {
  const clientId = "e2e-phone-page";
  const daemonClientId = "e2e-daemon";
  const clients = new Set([clientId, daemonClientId]);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "e2e", alg: "RS256", use: "sig" };
  const codes = new Map();
  const refreshTokens = new Map();
  let signIns = 0;
  const keys = createHttpServer((request, response) => {
    if (request.url === "/pool/.well-known/jwks.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    response.writeHead(404).end();
  });
  keys.listen(0, "127.0.0.1");
  await once(keys, "listening");
  const issuer = `http://127.0.0.1:${keys.address().port}/pool`;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = (client) => {
    const now = Math.floor(Date.now() / 1000);
    const signed = `${encode({ alg: "RS256", kid: "e2e", typ: "JWT" })}.${encode({
      iss: issuer,
      sub: accountId,
      "cognito:groups": ["remote"],
      token_use: "access",
      client_id: client,
      scope: "openid email",
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign("RSA-SHA256").update(signed).sign(privateKey, "base64url");
    return `${signed}.${signature}`;
  };
  const json = (response, status, body) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  const grant = (client) => {
    const refresh = randomBytes(24).toString("base64url");
    refreshTokens.set(refresh, client);
    return {
      access_token: accessToken(client),
      refresh_token: refresh,
      expires_in: 3600,
      token_type: "Bearer",
    };
  };
  return {
    issuer,
    clientId,
    daemonClientId,
    /** Tokens for the daemon's client, as `axl remote login` would get them. */
    daemonTokens: () => grant(daemonClientId),
    get signIns() {
      return signIns;
    },
    close: () => keys.close(),
    /** Answer the pool's routes on the origin; false for any other request. */
    handle(request, response, path) {
      if (path === "/oauth2/authorize") {
        const query = new URL(request.url, "https://origin.invalid").searchParams;
        if (
          !clients.has(query.get("client_id")) ||
          query.get("code_challenge_method") !== "S256" ||
          query.get("identity_provider") !== "Google"
        ) {
          json(response, 400, { error: "invalid_request" });
          return true;
        }
        const code = randomBytes(16).toString("hex");
        const redirect = query.get("redirect_uri");
        codes.set(code, {
          challenge: query.get("code_challenge"),
          redirect,
          client: query.get("client_id"),
        });
        const back = new URL(redirect);
        back.search = new URLSearchParams({ code, state: query.get("state") ?? "" }).toString();
        response.writeHead(302, { location: back.toString() });
        response.end();
        return true;
      }
      if (path === "/oauth2/token" && request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const form = new URLSearchParams(body);
          const client = form.get("client_id");
          if (!clients.has(client)) return json(response, 400, { error: "invalid_client" });
          if (form.get("grant_type") === "authorization_code") {
            const pending = codes.get(form.get("code"));
            codes.delete(form.get("code"));
            const challenge = createHash("sha256")
              .update(form.get("code_verifier") ?? "")
              .digest("base64url");
            if (
              pending === undefined ||
              pending.challenge !== challenge ||
              pending.redirect !== form.get("redirect_uri") ||
              pending.client !== client
            ) {
              return json(response, 400, { error: "invalid_grant" });
            }
            signIns += 1;
            return json(response, 200, grant(client));
          }
          if (
            form.get("grant_type") === "refresh_token" &&
            refreshTokens.get(form.get("refresh_token")) === client
          ) {
            return json(response, 200, {
              access_token: accessToken(client),
              expires_in: 3600,
              token_type: "Bearer",
            });
          }
          return json(response, 400, { error: "invalid_grant" });
        });
        return true;
      }
      return false;
    },
  };
}

/**
 * The stack's single HTTPS origin: `/remote/` is the phone page, `/v1/connect` upgrades to the
 * relay, and everything else goes to the control plane. Relay sockets pass through here so a test
 * can close them all (a dropped network) or stop forwarding without closing (a dead path).
 */
async function startOrigin({ port, tls, pageDirectory, controlPlanePort, relayPort, authority }) {
  const tunnels = new Set();
  const server = createHttpsServer(tls, (request, response) => {
    const path = new URL(request.url, "https://origin.invalid").pathname;
    if (authority.handle(request, response, path)) return;
    if (path === "/remote/sign-in.json") {
      // The deployed page learns its authority the same way; here it is this origin.
      response.writeHead(200, { ...PAGE_HEADERS, "content-type": CONTENT_TYPES[".json"] });
      response.end(
        JSON.stringify({
          authority: `https://127.0.0.1:${port}`,
          clientId: authority.clientId,
          provider: "Google",
        }),
      );
      return;
    }
    if (path === "/remote") {
      response.writeHead(302, { location: "/remote/" });
      response.end();
      return;
    }
    if (path.startsWith("/remote/")) {
      const relative = normalize(decodeURIComponent(path.slice("/remote/".length)) || "index.html");
      const file = resolve(
        pageDirectory,
        relative.endsWith(sep) ? `${relative}index.html` : relative,
      );
      if (!file.startsWith(pageDirectory + sep)) {
        response.writeHead(404, PAGE_HEADERS).end();
        return;
      }
      try {
        const body = readFileSync(statSync(file).isDirectory() ? join(file, "index.html") : file);
        response.writeHead(200, {
          ...PAGE_HEADERS,
          "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        });
        response.end(body);
      } catch {
        response.writeHead(404, PAGE_HEADERS).end();
      }
      return;
    }
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: controlPlanePort,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  server.on("upgrade", (request, socket, head) => {
    if (!request.url.startsWith("/v1/connect")) {
      socket.destroy();
      return;
    }
    const upstream = connect(relayPort, "127.0.0.1");
    // Browsers send an Origin header on WebSocket upgrades; the daemon's Node client does not.
    const side = request.headers.origin === undefined ? "daemon" : "phone";
    const tunnel = { socket, upstream, side, stalled: false };
    tunnels.add(tunnel);
    const close = () => {
      tunnels.delete(tunnel);
      socket.destroy();
      upstream.destroy();
    };
    for (const end of [socket, upstream]) {
      end.on("error", close);
      end.on("close", close);
    }
    upstream.on("connect", () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.byteLength > 0) upstream.write(head);
      socket.on("data", (chunk) => {
        if (!tunnel.stalled) upstream.write(chunk);
      });
      upstream.on("data", (chunk) => {
        if (!tunnel.stalled) socket.write(chunk);
      });
    });
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const matching = (side) =>
    [...tunnels].filter((tunnel) => side === "all" || tunnel.side === side);
  return {
    server,
    /** Close the relay sockets of one side ("phone", "daemon") or "all", like a lost network. */
    drop(side) {
      const dropped = matching(side);
      for (const tunnel of dropped) {
        tunnel.socket.destroy();
        tunnel.upstream.destroy();
      }
      return dropped.length;
    },
    /** Keep the matching relay sockets open but deliver nothing, like a dead network path. */
    stall(side) {
      const stalled = matching(side);
      for (const tunnel of stalled) tunnel.stalled = true;
      return stalled.length;
    },
  };
}

/**
 * Start the stack. `directory` holds what `scripts/remote-e2e.ts` prepared: `keys.json` (the
 * witness keys the artifacts are pinned to), `tls/` (a throwaway certificate for 127.0.0.1), and
 * `page/` (the phone page with the deployment-test browser binding under `e2ee/`).
 */
export async function startStack(directory) {
  const logs = join(directory, "logs");
  mkdirSync(logs, { recursive: true });
  const tls = {
    key: readFileSync(join(directory, "tls/key.pem")),
    cert: readFileSync(join(directory, "tls/cert.pem")),
  };
  const [originPort, controlPlanePort, relayPort, dynamoPort] = [
    await freePort(),
    await freePort(),
    await freePort(),
    await freePort(),
  ];
  const origin = `https://127.0.0.1:${originPort}`;
  const accountId = randomUUID();
  const installationId = uuidV7();
  const accessToken = randomBytes(24).toString("base64url");
  const possessionProof = randomBytes(32).toString("base64");
  const keys = readFileSync(join(directory, "keys.json"), "utf8");

  const model = await startModel();
  const authority = await startAuthority(accountId);
  const dynamo = new Service(
    "dynamodb",
    process.execPath,
    [
      join(repositoryRoot, "services/aws-control-plane/test/support/fake-dynamodb.ts"),
      String(dynamoPort),
    ],
    { env: { PATH: process.env.PATH } },
    logs,
  );
  await dynamo.ready(/fake DynamoDB listening/u, 30_000);
  const startControlPlane = async () => {
    const shared = {
      PATH: process.env.PATH,
      AWS_ENDPOINT_URL_DYNAMODB: `http://127.0.0.1:${dynamoPort}`,
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "fake",
      AWS_SECRET_ACCESS_KEY: "fake",
      AXL_TICKET_TABLE: "state",
      AXL_WITNESS_TABLE: "witness",
      AXL_WITNESS_JOURNAL_TABLE: "witness-journal",
      AXL_TEST_WITNESS_KEYS: keys,
      PORT: String(controlPlanePort),
    };
    const controlPlane = new Service(
      "control-plane",
      process.execPath,
      [
        join(
          repositoryRoot,
          "services/aws-control-plane/dist",
          production ? "production-runtime.js" : "deployment-test-runtime.js",
        ),
      ],
      {
        env: production
          ? {
              ...shared,
              AXL_ENVIRONMENT: "production",
              AXL_RELAY_TOKEN: RELAY_TOKEN,
              AXL_RELAY_URL: `wss://127.0.0.1:${originPort}/v1/connect`,
              AXL_COGNITO_ISSUER: authority.issuer,
              AXL_DAEMON_CLIENT_ID: authority.daemonClientId,
              AXL_PHONE_CLIENT_ID: authority.clientId,
              AXL_REMOTE_GROUP: "remote",
            }
          : {
              ...shared,
              AXL_ENVIRONMENT: "deployment-test",
              AXL_TEST_ACCOUNT_ID: accountId,
              AXL_TEST_INSTALLATION_ID: installationId,
              AXL_TEST_PUBLIC_TOKEN: accessToken,
              AXL_TEST_RELAY_TOKEN: RELAY_TOKEN,
              AXL_TEST_POSSESSION_PROOF: possessionProof,
              AXL_TEST_RELAY_URL: `wss://127.0.0.1:${originPort}/v1/connect`,
              AXL_TEST_PHONE_ISSUER: authority.issuer,
              AXL_TEST_PHONE_CLIENT_ID: authority.clientId,
            },
      },
      logs,
    );
    await controlPlane.ready(/listening on/u, 30_000);
    return controlPlane;
  };
  let controlPlane = await startControlPlane();

  const startRelay = async () => {
    const relay = new Service(
      "relay",
      "mix",
      ["run", "--no-halt", "test/support/hosted_path_server.exs"],
      {
        cwd: join(repositoryRoot, "services/relay"),
        env: {
          ...process.env,
          MIX_ENV: "test",
          AXL_RELAY_TEST_PORT: String(relayPort),
          AXL_CONTROL_PLANE_TEST_ORIGIN: `http://127.0.0.1:${controlPlanePort}`,
        },
      },
      logs,
    );
    await relay.ready(/AXL_RELAY_TEST_READY/u, 300_000);
    return relay;
  };
  let relay = await startRelay();

  const originServer = await startOrigin({
    port: originPort,
    tls,
    pageDirectory: resolve(directory, "page"),
    controlPlanePort,
    relayPort,
    authority,
  });

  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  mkdirSync(join(home, ".axl"), { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(home, ".axl/models.json"),
    JSON.stringify({
      providers: {
        local: {
          baseUrl: `http://127.0.0.1:${model.port}/v1`,
          models: [
            {
              modelId: "echo",
              displayName: "Local echo",
              apiDialect: "openai-chat",
              compatibility: { dialect: "openai-chat", supportsDeveloperRole: false },
              capabilities: { toolUse: true, structuredOutput: false, imageInput: false },
              reasoning: false,
              contextWindow: 8192,
              maxOutputTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  const remoteConfig = join(directory, "remote.json");
  writeFileSync(
    remoteConfig,
    JSON.stringify({
      version: 1,
      origin,
      pagePath: "/remote/",
      accountId,
      installationId,
      accessToken,
      phoneSignIn: true,
      possessionProof,
      binding: join(
        repositoryRoot,
        "packages/e2ee/bindings/node/dist/deployment-test/loader/index.js",
      ),
    }),
    { mode: 0o600 },
  );
  if (production) {
    // What `axl remote login` leaves behind, signed in through the fake pool's daemon client.
    const helper = join(directory, "dpapi-helper.mjs");
    writeFileSync(helper, FAKE_DPAPI_HELPER);
    chmodSync(helper, 0o755);
    const { saveRemoteAccount } = await import(
      join(repositoryRoot, "packages/runtime/dist/index.js")
    );
    const tokens = authority.daemonTokens();
    await saveRemoteAccount({
      axlHome: join(home, ".axl"),
      origin,
      pagePath: "/remote/",
      config: { authority: origin, clientId: authority.daemonClientId, provider: "Google" },
      tokens: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
      },
      helper,
      binding: join(repositoryRoot, "packages/e2ee/bindings/node/dist/hosted-wsl/loader/index.js"),
    });
  }
  const socketPath = join(home, ".axl/axl.sock");
  const startDaemon = async () => {
    const daemon = new Service(
      "daemon",
      process.execPath,
      [
        join(repositoryRoot, "packages/cli/dist/main.js"),
        "daemon",
        "--provider",
        "local",
        "--model",
        "echo",
        "--thinking",
        "off",
      ],
      {
        env: {
          HOME: home,
          PATH: process.env.PATH,
          ...(production ? {} : { AXL_REMOTE_DEPLOYMENT_TEST: remoteConfig }),
          // The daemon reaches the origin over HTTPS; trust only this run's certificate.
          NODE_EXTRA_CA_CERTS: join(directory, "tls/cert.pem"),
        },
      },
      logs,
    );
    await until(
      "the daemon socket",
      async () => {
        const client = await connectUnixClient(socketPath);
        client.close();
        return true;
      },
      30_000,
    );
    return daemon;
  };
  let daemon = await startDaemon();

  const client = async (work) => {
    const connected = await connectUnixClient(socketPath);
    try {
      return await work(connected);
    } finally {
      connected.close();
    }
  };

  return {
    origin,
    model,
    logs,
    /** How many times a phone signed in with the fake user pool. */
    signIns: () => authority.signIns,
    /** A fresh pairing link, as `/remote` prints it. */
    pair: () => client(async (connected) => (await connected.startRemotePairing()).link),
    remoteStatus: () => client((connected) => connected.remoteStatus()),
    createSession: () =>
      client((connected) =>
        connected.request(
          "session.create",
          // The agent may ask the user questions, which the phone answers.
          { cwd: workspace, userQuestions: true },
          { idempotencyKey: randomUUID() },
        ),
      ),
    dropConnections: (side = "all") => originServer.drop(side),
    stallConnections: (side = "all") => originServer.stall(side),
    async restartDaemon() {
      await daemon.stop();
      daemon = await startDaemon();
    },
    async restartRelay() {
      await relay.stop();
      originServer.drop("all");
      relay = await startRelay();
    },
    /** A new control-plane process over the same tables, as a redeploy starts one. */
    async restartControlPlane() {
      await controlPlane.stop();
      controlPlane = await startControlPlane();
    },
    async stop() {
      await daemon.stop();
      await relay.stop();
      await controlPlane.stop();
      await dynamo.stop();
      originServer.server.closeAllConnections();
      originServer.server.close();
      model.server.close();
      authority.close();
    },
  };
}

export type RemoteStack = Awaited<ReturnType<typeof startStack>>;
