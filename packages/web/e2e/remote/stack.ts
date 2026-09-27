// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

// A local copy of the deployment-test stack for phone remote-control evidence: the deployment-test
// control plane with its in-process witness, the Elixir relay, one HTTPS origin that serves the
// phone page and forwards to both (like the stack's CloudFront), a scripted model, and a real
// sandboxed daemon. The origin can drop or stall every relay socket, and the relay and daemon can
// be restarted, so tests inject the failures phones see.

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createNetServer } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { connectUnixClient } from "@axl/sdk/unix";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const RELAY_TOKEN = "internal-fixture";
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
 * asked to answer, so a test can prove each prompt reached the model exactly once.
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
      const user = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
      const text = (
        typeof user?.content === "string"
          ? user.content
          : (user?.content ?? []).map((part) => part.text ?? "").join("")
      ).trim();
      prompts.set(text, (prompts.get(text) ?? 0) + 1);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish = null) =>
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      for (const word of `Echo: ${text}`.split(/(?<= )/u)) {
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
 * The stack's single HTTPS origin: `/remote/` is the phone page, `/v1/connect` upgrades to the
 * relay, and everything else goes to the control plane. Relay sockets pass through here so a test
 * can close them all (a dropped network) or stop forwarding without closing (a dead path).
 */
async function startOrigin({ port, tls, pageDirectory, controlPlanePort, relayPort }) {
  const tunnels = new Set();
  const server = createHttpsServer(tls, (request, response) => {
    const path = new URL(request.url, "https://origin.invalid").pathname;
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
  const [originPort, controlPlanePort, relayPort] = [
    await freePort(),
    await freePort(),
    await freePort(),
  ];
  const origin = `https://127.0.0.1:${originPort}`;
  const accountId = randomUUID();
  const installationId = uuidV7();
  const deviceId = uuidV7();
  const accessToken = randomBytes(24).toString("base64url");
  const possessionProof = randomBytes(32).toString("base64");
  const keys = readFileSync(join(directory, "keys.json"), "utf8");

  const model = await startModel();
  const controlPlane = new Service(
    "control-plane",
    process.execPath,
    [join(repositoryRoot, "services/aws-control-plane/dist/deployment-test-runtime.js")],
    {
      env: {
        PATH: process.env.PATH,
        AXL_ENVIRONMENT: "deployment-test",
        AXL_TEST_IN_MEMORY: "1",
        AXL_TEST_ACCOUNT_ID: accountId,
        AXL_TEST_INSTALLATION_ID: installationId,
        AXL_TEST_DEVICE_ID: deviceId,
        AXL_TEST_PUBLIC_TOKEN: accessToken,
        AXL_TEST_RELAY_TOKEN: RELAY_TOKEN,
        AXL_TEST_POSSESSION_PROOF: possessionProof,
        AXL_TEST_RELAY_URL: `wss://127.0.0.1:${originPort}/v1/connect`,
        AXL_TEST_WITNESS_KEYS: keys,
        PORT: String(controlPlanePort),
      },
    },
    logs,
  );
  await controlPlane.ready(/listening on/u, 30_000);

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
      deviceId,
      accessToken,
      possessionProof,
      binding: join(
        repositoryRoot,
        "packages/e2ee/bindings/node/dist/deployment-test/loader/index.js",
      ),
    }),
    { mode: 0o600 },
  );
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
          AXL_REMOTE_DEPLOYMENT_TEST: remoteConfig,
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
    /** A fresh pairing link, as `/remote` prints it. */
    pair: () => client(async (connected) => (await connected.startRemotePairing()).link),
    remoteStatus: () => client((connected) => connected.remoteStatus()),
    createSession: () =>
      client((connected) =>
        connected.request("session.create", { cwd: workspace }, { idempotencyKey: randomUUID() }),
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
    async stop() {
      await daemon.stop();
      await relay.stop();
      await controlPlane.stop();
      originServer.server.closeAllConnections();
      originServer.server.close();
      model.server.close();
    },
  };
}

export type RemoteStack = Awaited<ReturnType<typeof startStack>>;
