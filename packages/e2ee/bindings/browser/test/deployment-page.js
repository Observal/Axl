// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

// Real-browser pairing against a native daemon through the deployment-test artifact. The page only
// sees the public loader surface; the worker runs every witness barrier against the same-origin
// gateway, exactly as a deployed phone client would.

import * as binding from "/deployment-test/loader/index.js";

const WITNESS_AUTHORIZATION = "Bearer deployment-test-witness";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytes = (text) => Uint8Array.from(text.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
const id = (seed) => new Uint8Array(16).fill(seed);

async function daemon(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function rejection(promise) {
  try {
    await promise;
    return "resolved";
  } catch (cause) {
    return cause?.code ?? String(cause);
  }
}

async function send(endpoint, operation, logical, text) {
  const sent = await endpoint.prepareApplication(id(operation), id(logical), 1n, encoder.encode(text));
  const received = await daemon("/daemon/receive", {
    ciphertext: hex(sent.bytes),
    logicalMessageId: hex(sent.logicalMessageId),
  });
  return received.plaintext;
}

async function runDeploymentPairing() {
  const result = {};
  let step = "start";
  try {
    return await pair(result, (name) => {
      step = name;
    });
  } catch (cause) {
    throw new Error(`${step} failed with ${cause?.code ?? cause}`);
  }
}

async function pair(result, at) {
  at("invitation");
  const info = await daemon("/daemon/invitation");
  const invitation = bytes(info.invitation);
  const identity = {
    accountId: bytes(info.accountId),
    installationId: bytes(info.installationId),
    deviceId: bytes(info.deviceId),
    cryptoSessionId: bytes(info.cryptoSessionId),
  };

  // The witness credential gates every certificate: a wrong one fails closed before registration.
  at("unauthorized create");
  await binding.authorizeWitness("Bearer wrong");
  result.unauthorized = await rejection(
    binding.createDeviceEndpoint({ ...identity, operationId: id(1) }),
  );
  at("create");
  await binding.authorizeWitness(WITNESS_AUTHORIZATION);
  // The unauthorized attempt committed the endpoint with its registration pending. It is reopened,
  // not recreated, and the first call after reopening completes the registration.
  result.recreate = await rejection(
    binding.createDeviceEndpoint({ ...identity, operationId: id(1) }),
  );
  const endpoint = await binding.openDeviceEndpoint({
    cryptoSessionId: identity.cryptoSessionId,
  });

  at("claim");
  const claim = await endpoint.pairingClaim(invitation);
  result.claimDeterministic = hex(await endpoint.pairingClaim(invitation)) === hex(claim);
  const inspected = await binding.inspectPairingClaim(claim);
  result.claimSession = hex(inspected.cryptoSessionId) === info.cryptoSessionId;

  at("daemon claim");
  const { welcome } = await daemon("/daemon/claim", { claim: hex(claim) });
  at("join");
  const joined = await endpoint.joinPublished(id(2), bytes(welcome));
  result.joined = { tag: joined.tag, epoch: String(joined.epoch) };
  const repeated = await endpoint.joinPublished(id(2), bytes(welcome));
  result.joinRetryExact = repeated.tag === joined.tag && repeated.epoch === joined.epoch;

  at("activation");
  const activation = await endpoint.preparePairActivation(id(3), id(4), claim);
  result.activationClass = activation.messageClass;
  result.activated = (
    await daemon("/daemon/activation", {
      ciphertext: hex(activation.bytes),
      logicalMessageId: hex(activation.logicalMessageId),
    })
  ).activated;

  at("send");
  result.phoneToDaemon = await send(endpoint, 5, 6, "hello from the phone");
  at("receive");
  const delivered = await daemon("/daemon/deliver", { text: "hello from the daemon" });
  const received = await endpoint.receiveApplication(
    id(7),
    bytes(delivered.logicalMessageId),
    1n,
    bytes(delivered.ciphertext),
  );
  result.daemonToPhone = decoder.decode(received.bytes);

  // A reloaded page reopens the committed endpoint and keeps the session.
  at("close");
  await endpoint.close();
  result.closed = await rejection(endpoint.prepareApplication(id(8), id(9), 1n, encoder.encode("x")));
  at("reopen");
  const reopened = await binding.openDeviceEndpoint({ cryptoSessionId: identity.cryptoSessionId });
  result.afterReopen = await send(reopened, 10, 11, "after reopen");
  await reopened.close();
  return result;
}

window.axlDeploymentTest = Object.freeze({ runDeploymentPairing });
