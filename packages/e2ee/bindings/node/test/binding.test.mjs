// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const packageRoot = new URL("../", import.meta.url);
const production = await import(
  new URL("dist/package/loader/index.js", packageRoot)
);
const fixture = await import("./fixture-loader.mjs");

function uuid(seed) {
  const value = Buffer.alloc(16, seed);
  value[6] = 0x70 | (seed & 0x0f);
  value[8] = 0x80 | (seed & 0x3f);
  return value;
}
const operation = (value) => Buffer.alloc(16, value);

async function activatedPair(seed = 20) {
  const root = mkdtempSync(join(tmpdir(), "axl-e2ee-node-"));
  const account = Buffer.alloc(16, seed);
  const installation = uuid(seed + 1);
  const session = uuid(seed + 2);
  const deviceId = uuid(seed + 3);
  const daemon = fixture.testDaemonEndpoint(
    join(root, "daemon"),
    account,
    installation,
    session,
  );
  const invitation = await daemon.issue(operation(1));
  const device = fixture.testDeviceEndpoint(
    join(root, "device"),
    account,
    installation,
    session,
    deviceId,
  );
  const prejoin = await device.prepare(invitation.bytes, operation(2));
  const pending = await daemon.submitClaim(operation(3), prejoin.bytes);
  assert.equal(pending.tag, "pending");
  const reservationId = operation(4);
  assert.equal(
    (await daemon.confirmClaim(operation(5), pending.hash, reservationId)).tag,
    "reserved",
  );
  const welcome = await daemon.createWelcome(operation(6), reservationId);
  assert.equal(
    await device.joinPublishedWelcome(
      operation(7),
      welcome.bytes,
      welcome.claimHash,
      createHash("sha384").update(welcome.bytes).digest(),
      welcome.expiresAtMs,
    ),
    "joined",
  );
  const activation = await device.prepareActivation(operation(8), operation(9));
  assert.rejects(
    device.prepareApplication(
      operation(10),
      operation(11),
      1n,
      Buffer.from("blocked"),
    ),
    { code: "conflict" },
  );
  const acceptance = await daemon.acceptActivation(
    operation(12),
    operation(9),
    activation.ciphertext,
  );
  assert.equal(
    await device.acknowledgeActivation(operation(13), acceptance),
    "active",
  );
  return { root, daemon, device };
}

test("production artifact reports its ABI and fails closed", async () => {
  assert.deepEqual(production.getBindingInfo(), {
    abiVersion: 1,
    profileId: "axl-e2ee-mls-pq-v1",
    profileRevision: 1,
    nodeApi: 9,
    productionStorageReady: false,
  });
  await assert.rejects(production.createDaemonEndpoint(), (value) => {
    assert.equal(value.name, "AxlE2eeError");
    assert.equal(value.code, "secure_store_unavailable");
    assert.equal(value.message, "The E2EE operation failed safely.");
    assert(!/redb|openmls|rust|\/private\//iu.test(value.message));
    return true;
  });
  await assert.rejects(production.openDeviceEndpoint(), {
    name: "AxlE2eeError",
    code: "rollback_anchor_unavailable",
  });
  await assert.rejects(production.openDaemonEndpoint(), {
    name: "AxlE2eeError",
    code: "rollback_anchor_unavailable",
  });
});

test("checked-in pairing fixtures are consumed and bounds precede decoding", async () => {
  const fixtures = new URL("../../../fixtures/v1/", import.meta.url);
  const invitation = readFileSync(new URL("pairing-invitation.tls", fixtures));
  const claim = readFileSync(new URL("pairing-claim-v1.tls", fixtures));
  const maximumClaim = readFileSync(
    new URL("pairing-claim-v1-maximum.tls", fixtures),
  );
  const expected = Object.fromEntries(
    readFileSync(new URL("expected.txt", fixtures), "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=")),
  );
  const invitationResult =
    await production.inspectPairingInvitation(invitation);
  const claimResult = await production.inspectPairingClaim(claim);
  assert.equal(invitationResult.kind, "pairing_invitation");
  assert.equal(claimResult.kind, "pairing_claim");
  assert.equal(
    createHash("sha384").update(invitation).digest("hex"),
    expected.invitation_sha384,
  );
  assert.equal(
    createHash("sha384").update(claim).digest("hex"),
    expected.claim_sha384,
  );
  assert.equal(maximumClaim.length, Number(expected.maximum_claim_bytes));
  await assert.rejects(
    production.inspectPairingInvitation(Buffer.alloc(2049)),
    { code: "bound_exceeded" },
  );
  await assert.rejects(production.inspectPairingClaim(Buffer.alloc(17321)), {
    code: "bound_exceeded",
  });
});

test("native witness continuation binds operation, certificate, and exact committed output", async () => {
  const fixtures = new URL("../../../fixtures/v1/", import.meta.url);
  const request = readFileSync(new URL("witness-advance-v1.bin", fixtures));
  const certificate = readFileSync(new URL("witness-quorum-v1.bin", fixtures));
  const exact = Buffer.from("exact committed output");
  const pending = fixture.testWitnessPending(request, exact);
  assert.equal(pending.status, "pending_quorum");
  assert.deepEqual(pending.witnessRequest, request);
  assert.deepEqual(
    pending.requestHash,
    createHash("sha384").update(request).digest(),
  );
  const wrongOperation = Buffer.from(pending.operationId);
  wrongOperation[0] ^= 1;
  await assert.rejects(pending.continueWitness(wrongOperation, certificate), {
    code: "witness_operation_conflict",
  });
  const copiedCertificate = Buffer.from(certificate);
  const completion = pending.continueWitness(
    pending.operationId,
    copiedCertificate,
  );
  copiedCertificate.fill(0);
  assert.deepEqual(await completion, exact);
  assert.equal(pending.status, "committed");
  assert.deepEqual(
    await pending.continueWitness(pending.operationId, certificate),
    exact,
  );

  const recovered = fixture.testWitnessPending(request, exact);
  assert.deepEqual(recovered.witnessRequest, request);
  await assert.rejects(
    recovered.continueWitness(recovered.operationId, Buffer.alloc(32)),
    {
      code: "witness_receipt_invalid",
    },
  );
  await assert.rejects(
    recovered.continueWitness(
      recovered.operationId,
      Buffer.alloc(3 * 1024 + 1),
    ),
    { code: "bound_exceeded" },
  );
  assert.deepEqual(
    await recovered.continueWitness(recovered.operationId, certificate),
    exact,
  );
  pending.close();
  recovered.close();
});

test("fresh lifecycle preserves barriers, exact retries, copied input, and close semantics", async () => {
  const pair = await activatedPair(30);
  try {
    const input = Buffer.from("copied before async work");
    const sendPromise = pair.device.prepareApplication(
      operation(20),
      operation(21),
      7n,
      input,
    );
    input.fill(0);
    const sent = await sendPromise;
    const duplicate = await pair.device.prepareApplication(
      operation(20),
      operation(21),
      7n,
      Buffer.from("copied before async work"),
    );
    assert.deepEqual(duplicate.ciphertext, sent.ciphertext);
    const pendingBeforeAcknowledgement = await pair.device.pendingOutbox();
    assert.deepEqual(
      pendingBeforeAcknowledgement.map((record) => record.operationId),
      [operation(8), operation(20)],
    );
    await assert.rejects(
      pair.device.prepareApplication(
        operation(20),
        operation(21),
        7n,
        Buffer.from("conflict"),
      ),
      { code: "conflict" },
    );
    const received = await pair.daemon.receiveApplication(
      operation(22),
      sent.ciphertext,
      operation(21),
      7n,
    );
    assert.equal(received.plaintext.toString(), "copied before async work");
    const recovered = await pair.daemon.receiveApplication(
      operation(22),
      sent.ciphertext,
      operation(21),
      7n,
    );
    assert.equal(recovered.plaintext.toString(), "copied before async work");
    await assert.rejects(
      pair.daemon.receiveApplication(
        operation(70),
        sent.ciphertext,
        operation(21),
        7n,
      ),
      { code: "replay_rejected" },
    );
    assert.equal(
      (await pair.device.acknowledgeOutbox(operation(71), operation(20)))
        .retryState,
      "acknowledged",
    );
    assert.deepEqual(
      (await pair.device.pendingOutbox()).map((record) => record.operationId),
      [operation(8)],
    );
    assert.equal(
      await pair.daemon.acknowledgeReceive(operation(72), operation(22)),
      "acknowledged",
    );

    const delivered = await pair.daemon.prepareApplication(
      operation(73),
      operation(74),
      7n,
      Buffer.from("return path"),
    );
    const deliveredPlaintext = await pair.device.receiveApplication(
      operation(75),
      delivered.ciphertext,
      operation(74),
      7n,
    );
    assert.equal(deliveredPlaintext.plaintext.toString(), "return path");

    const pending = pair.device.pairStatus();
    await assert.rejects(pair.device.pairStatus(), { code: "lifecycle_busy" });
    assert.equal(await pending, "active");
    const proposal = await pair.device.prepareReplacement(
      operation(23),
      operation(24),
      7n,
    );
    await pair.daemon.receiveReplacementProposal(
      operation(25),
      proposal.ciphertext,
      operation(24),
      7n,
    );
    const commit = await pair.daemon.createUpdateCommit(
      operation(26),
      operation(27),
      7n,
    );
    await assert.rejects(
      pair.daemon.prepareApplication(
        operation(28),
        operation(29),
        7n,
        Buffer.from("barrier"),
      ),
      { code: "conflict" },
    );
    const ready = await pair.device.applyReceivedUpdateCommit(
      operation(30),
      commit.ciphertext,
      operation(27),
      7n,
      operation(31),
    );
    await assert.rejects(
      pair.device.prepareApplication(
        operation(32),
        operation(33),
        7n,
        Buffer.from("barrier"),
      ),
      { code: "conflict" },
    );
    const epochAcceptance = await pair.daemon.acceptEpochReady(
      operation(34),
      operation(31),
      7n,
      ready.ciphertext,
    );
    const confirmation = await pair.daemon.prepareEpochReadyConfirmation(
      operation(35),
      operation(38),
      7n,
      epochAcceptance,
    );
    assert.equal(
      await pair.device.acceptEpochReadyConfirmation(
        operation(39),
        operation(38),
        7n,
        confirmation.ciphertext,
      ),
      "active",
    );

    const retryBeforeClose = await pair.device.prepareApplication(
      operation(36),
      operation(37),
      8n,
      Buffer.from("reopen retry"),
    );
    await pair.device.close();
    await assert.rejects(pair.device.pairStatus(), { code: "endpoint_closed" });
    assert.equal(await pair.device.reopen(), "opened");
    const retryAfterClose = await pair.device.prepareApplication(
      operation(36),
      operation(37),
      8n,
      Buffer.from("reopen retry"),
    );
    assert.deepEqual(retryAfterClose.ciphertext, retryBeforeClose.ciphertext);
    await pair.device.close();
    await pair.device.close();
  } finally {
    try {
      await pair.daemon.close();
    } catch {}
    rmSync(pair.root, { recursive: true, force: true });
  }
});

test("panic containment releases operation ownership", async () => {
  const pair = await activatedPair(25);
  try {
    await assert.rejects(fixture.testPanic(pair.daemon), {
      code: "internal_error",
    });
    await assert.rejects(pair.daemon.pairStatus(), { code: "internal_error" });
  } finally {
    try {
      await pair.device.close();
    } catch {}
    rmSync(pair.root, { recursive: true, force: true });
  }
});

test("daemon-only removal and device reset become terminal", async () => {
  const pair = await activatedPair(60);
  try {
    const removal = await pair.daemon.revokeDevice(
      operation(80),
      operation(81),
      9n,
    );
    assert.equal(await pair.daemon.pairStatus(), "revoked");
    assert.equal(
      await pair.device.applyRemoval(operation(82), removal, operation(81), 9n),
      "removed",
    );
    assert.equal(await pair.device.pairStatus(), "removed");
    const requirement = await pair.device.reset(operation(83));
    assert.equal(requirement.cryptoSessionId.length, 16);
    assert.equal(requirement.keyPackageHash.length, 48);
  } finally {
    try {
      await pair.daemon.close();
    } catch {}
    try {
      await pair.device.close();
    } catch {}
    rmSync(pair.root, { recursive: true, force: true });
  }
});

test("state loss and corrupt storage fail closed", async () => {
  const lost = await activatedPair(40);
  await lost.device.close();
  const sessionHex = uuid(42).toString("hex");
  rmSync(join(lost.root, "device", `${sessionHex}.redb`));
  await assert.rejects(lost.device.reopen(), { code: "state_loss" });
  try {
    await lost.daemon.close();
  } catch {}
  rmSync(lost.root, { recursive: true, force: true });

  const corrupt = await activatedPair(50);
  await corrupt.device.close();
  const corruptPath = join(
    corrupt.root,
    "device",
    `${uuid(52).toString("hex")}.redb`,
  );
  const bytes = readFileSync(corruptPath);
  bytes.fill(0, 0, Math.min(64, bytes.length));
  writeFileSync(corruptPath, bytes);
  await assert.rejects(corrupt.device.reopen(), { code: "corrupt_state" });
  try {
    await corrupt.daemon.close();
  } catch {}
  rmSync(corrupt.root, { recursive: true, force: true });
});

test("test-only exports exist only in the fixture artifact", () => {
  assert(fixture.nativeExports.includes("testDaemonEndpoint"));
  assert(!Object.keys(production).some((name) => name.startsWith("test")));
});
