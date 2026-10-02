// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

// Opt-in server for the deployment-test artifact. It pins the trust of one Node test witness into
// the built artifact, answers the same-origin witness path with that witness, and runs a real
// native daemon endpoint behind small JSON routes so a real browser can pair with it.
//
// Requires `dist/deployment-test` and AXL_E2EE_NODE_TEST_ARTIFACT (the Node test artifact).

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const nodeTests = resolve(packageRoot, "../node/test");
const fixture = await import(join(nodeTests, "fixture-loader.mjs"));
const { complete, witnessed } = await import(join(nodeTests, "witness-driver.mjs"));

const port = Number(process.env.AXL_E2EE_DEPLOYMENT_PORT ?? "4179");
const authorization = "Bearer deployment-test-witness";
const artifact = join(packageRoot, "dist/deployment-test");
const csp =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'";

// Pin this process's witness into the artifact exactly as a deployment build would.
const witness = fixture.testWitness();
const trust = witness.trustConfig;
writeFileSync(join(artifact, "trust/replica-trust.bin"), trust);
const manifestPath = join(artifact, "integrity.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
for (const entry of manifest.artifacts) {
  if (entry.kind === "replica-trust") {
    entry.sha256 = createHash("sha256").update(trust).digest("hex");
  }
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

let seed = 0;
function uuidV7() {
  seed += 1;
  const value = Buffer.alloc(16, seed);
  value[6] = 0x70 | (seed & 0x0f);
  value[8] = 0x80 | (seed & 0x3f);
  return value;
}
let operationSeed = 0;
const operation = () => {
  operationSeed += 1;
  const value = Buffer.alloc(16, 0);
  value.writeUInt32BE(operationSeed, 12);
  return value;
};

/** Each page run pairs a fresh browser profile with its own daemon and crypto session. */
let current;
async function freshPairing() {
  const ids = {
    account: Buffer.alloc(16, 90),
    installation: uuidV7(),
    session: uuidV7(),
    device: uuidV7(),
  };
  const daemon = fixture.configuredDaemonEndpoint(
    mkdtempSync(join(tmpdir(), "axl-deployment-daemon-")),
    ids.account,
    ids.installation,
    ids.session,
    trust,
  );
  const invitation = (await complete(daemon, witness, await daemon.issue(operation()))).publication;
  current = { ids, daemon, invitation };
  return current;
}

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".bin", "application/octet-stream"],
]);
const hex = (bytes) => Buffer.from(bytes).toString("hex");

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function route(pathname, request) {
  if (pathname === "/daemon/invitation") {
    const { ids, invitation } = await freshPairing();
    return {
      invitation: hex(invitation.bytes),
      accountId: hex(ids.account),
      installationId: hex(ids.installation),
      deviceId: hex(ids.device),
      cryptoSessionId: hex(ids.session),
    };
  }
  if (current === undefined) return undefined;
  const { daemon } = current;
  const input = JSON.parse((await body(request)).toString("utf8"));
  if (pathname === "/daemon/claim") {
    const claim = Buffer.from(input.claim, "hex");
    const pending = await witnessed(daemon, witness, () => daemon.submitClaim(operation(), claim));
    const reservationId = operation();
    await witnessed(daemon, witness, () =>
      daemon.confirmClaim(operation(), pending.publication.hash, reservationId),
    );
    const { welcome } = await witnessed(daemon, witness, () =>
      daemon.createWelcome(operation(), reservationId),
    );
    return { welcome: hex(welcome.bytes) };
  }
  if (pathname === "/daemon/activation") {
    const accepted = await witnessed(daemon, witness, () =>
      daemon.acceptActivation(
        operation(),
        Buffer.from(input.logicalMessageId, "hex"),
        Buffer.from(input.ciphertext, "hex"),
      ),
    );
    return { activated: accepted.activation !== undefined };
  }
  if (pathname === "/daemon/receive") {
    const received = await witnessed(daemon, witness, () =>
      daemon.receiveApplication(
        operation(),
        Buffer.from(input.ciphertext, "hex"),
        Buffer.from(input.logicalMessageId, "hex"),
        1n,
      ),
    );
    return { plaintext: Buffer.from(received.plaintext.plaintext ?? received.plaintext).toString("utf8") };
  }
  if (pathname === "/daemon/deliver") {
    const logicalMessageId = operation();
    const sent = await witnessed(daemon, witness, () =>
      daemon.prepareApplication(operation(), logicalMessageId, 1n, Buffer.from(input.text, "utf8")),
    );
    return { ciphertext: hex(sent.outbox.ciphertext), logicalMessageId: hex(logicalMessageId) };
  }
  return undefined;
}

createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
    if (pathname === "/v1/e2ee/witness" && request.method === "POST") {
      if (request.headers.authorization !== authorization) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end('{"error":{"code":"unauthorized"}}');
        return;
      }
      const certificate = witness.respond(await body(request));
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": certificate.byteLength,
        "content-type": "application/vnd.axl.rollback-witness-v1",
      });
      response.end(certificate);
      return;
    }
    if (pathname.startsWith("/daemon/")) {
      const value = await route(pathname, request);
      if (value === undefined) throw new Error("not found");
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
      return;
    }
    const [root, relative] =
      pathname === "/"
        ? [join(packageRoot, "test"), "deployment.html"]
        : pathname.startsWith("/deployment-test/")
          ? [artifact, pathname.slice("/deployment-test/".length)]
          : pathname.startsWith("/test/")
            ? [join(packageRoot, "test"), pathname.slice("/test/".length)]
            : [undefined, undefined];
    if (root === undefined) throw new Error("not found");
    const path = resolve(root, normalize(relative));
    if (path !== root && !path.startsWith(`${root}/`)) throw new Error("invalid path");
    if (!statSync(path).isFile()) throw new Error("not found");
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": csp,
      "Content-Type": types.get(extname(path)) ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(readFileSync(path));
  } catch (cause) {
    response.writeHead(cause?.code ? 500 : 404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(cause?.code ? `daemon error ${cause.code}` : "Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`READY http://127.0.0.1:${port}`));
