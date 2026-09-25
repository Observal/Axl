#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

profile="${AWS_PROFILE:-axl-deploy}"
region="ap-south-2"
root="$(git rev-parse --show-toplevel)"
stack="$root/infra/aws/hosted-path-test"
origin="$(terraform -chdir="$stack" output -raw control_plane_url)"
secret_json="$(aws secretsmanager get-secret-value \
  --profile "$profile" --region "$region" \
  --secret-id axl/hosted-path/deployment-test \
  --query SecretString --output text)"

for _attempt in $(seq 1 60); do
  if curl --fail --silent --show-error "$origin/healthz" >/dev/null; then
    break
  fi
  sleep 5
done
curl --fail --silent --show-error "$origin/healthz" | grep -q '"witness":true' || {
  echo "The control plane is not serving the rollback witness." >&2
  exit 1
}

AXL_TEST_ORIGIN="$origin" AXL_TEST_SECRET_JSON="$secret_json" node --input-type=module <<'NODE'
import { createHash, randomUUID } from "node:crypto";

const origin = process.env.AXL_TEST_ORIGIN;
const config = JSON.parse(process.env.AXL_TEST_SECRET_JSON);

async function post(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.publicToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}

async function verifyPairingRendezvous() {
  const cryptoSessionId = randomUUID();
  const claim = Buffer.from("opaque-pairing-claim");
  const claimHash = createHash("sha384").update(claim).digest("base64");
  const binding = {
    version: 1,
    installationId: config.installationId,
    deviceId: config.deviceId,
    cryptoSessionId,
    claimHash,
  };
  await post("/v1/e2ee/pairing/claims", { ...binding, claim: claim.toString("base64") });
  const reservationId = randomUUID();
  const reservation = await post("/v1/e2ee/pairing/claims/reserve", {
    ...binding,
    reservationId,
  });
  if (reservation.claim !== claim.toString("base64")) throw new Error("pairing claim changed");
  const welcome = Buffer.from("opaque-pairing-welcome");
  const welcomeHash = createHash("sha384").update(welcome).digest("base64");
  const publication = await post("/v1/e2ee/pairing/welcomes", {
    ...binding,
    reservationId,
    welcome: welcome.toString("base64"),
    welcomeHash,
  });
  const fetched = await post("/v1/e2ee/pairing/welcomes/fetch", binding);
  if (publication.welcome !== fetched.welcome) throw new Error("pairing Welcome changed");
  await post("/v1/e2ee/pairing/welcomes/acknowledge", { ...binding, welcomeHash });
}

async function issue(role) {
  const response = await fetch(`${origin}/v1/relay/tickets`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.publicToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      installationId: config.installationId,
      ...(role === "device" ? { deviceId: config.deviceId } : {}),
      role,
    }),
  });
  if (response.status !== 201) throw new Error(`ticket issuance failed: ${response.status}`);
  return response.json();
}

function connect(ticket) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(ticket.relayUrl);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => reject(new Error("relay admission timed out")), 15_000);
    socket.addEventListener("open", () => {
      socket.send(
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            ticket: ticket.ticket,
            connectionNonce: randomUUID(),
            possessionProof: config.possessionProof,
          }),
        ),
      );
    });
    socket.addEventListener("message", (event) => {
      const bytes = new Uint8Array(event.data);
      if (bytes[0] === 0x7b) {
        const message = JSON.parse(new TextDecoder().decode(bytes));
        if (message.type === "route_snapshot") {
          clearTimeout(timer);
          resolve({ socket, snapshot: message });
        }
      }
    });
    socket.addEventListener("error", () => reject(new Error("relay WebSocket failed")));
  });
}

await verifyPairingRendezvous();
const daemonTicket = await issue("daemon");
const deviceTicket = await issue("device");
const daemon = await connect(daemonTicket);
const device = await connect(deviceTicket);

const daemonRoute = daemon.snapshot.sourceRoute.routeId;
const payload = new TextEncoder().encode("opaque-smoke-test");
const uuidBytes = (value) => Uint8Array.from(Buffer.from(value.replaceAll("-", ""), "hex"));
const attempt = randomUUID();
const destination = uuidBytes(daemonRoute);
const attemptBytes = uuidBytes(attempt);
const frame = new Uint8Array(38 + payload.byteLength);
frame.set(new TextEncoder().encode("AXLR"));
frame[4] = 1;
frame[5] = 1;
frame.set(attemptBytes, 6);
frame.set(destination, 22);
frame.set(payload, 38);

const delivery = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("opaque relay delivery timed out")), 15_000);
  daemon.socket.addEventListener("message", (event) => {
    const bytes = new Uint8Array(event.data);
    if (bytes[0] === 0x41 && bytes[5] === 2) {
      clearTimeout(timer);
      resolve(bytes.subarray(38));
    }
  });
});
device.socket.send(frame);
const delivered = await delivery;
if (new TextDecoder().decode(delivered) !== "opaque-smoke-test") {
  throw new Error("relay changed opaque payload bytes");
}
daemon.socket.close();
device.socket.close();
process.stdout.write(JSON.stringify({ region: "ap-south-2", controlPlane: "healthy", pairing: "passed", relay: "opaque-delivery-passed" }) + "\n");
NODE
