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
const { authorize, complete, reconcile, witnessed, witnessedFacade } = await import(
  "./witness-driver.mjs"
);

function uuid(seed) {
  const value = Buffer.alloc(16, seed);
  value[6] = 0x70 | (seed & 0x0f);
  value[8] = 0x80 | (seed & 0x3f);
  return value;
}
const operation = (value) => Buffer.alloc(16, value);
const contains = (haystack, needle) =>
  Buffer.from(haystack).includes(Buffer.from(needle));

async function activatedPair(seed = 20) {
  const root = mkdtempSync(join(tmpdir(), "axl-e2ee-node-"));
  const account = Buffer.alloc(16, seed);
  const installation = uuid(seed + 1);
  const session = uuid(seed + 2);
  const deviceId = uuid(seed + 3);
  const witness = fixture.testWitness();
  const daemon = fixture.testDaemonEndpoint(
    join(root, "daemon"),
    account,
    installation,
    session,
    witness,
  );
  // Creation is the counter-1 registration. Nothing is published before it completes.
  const register = await daemon.issue(operation(1));
  assert.equal(register.kind, "register");
  await assert.rejects(daemon.invitation(), { code: "initialization_incomplete" });
  const issued = await complete(daemon, witness, register);
  assert.equal(issued.tag, "invitation");
  const invitation = issued.publication;
  assert.equal(invitation.tag, "issued");
  assert.deepEqual(await daemon.invitation(), invitation);

  const device = fixture.testDeviceEndpoint(
    join(root, "device"),
    account,
    installation,
    session,
    deviceId,
    witness,
  );
  const prepared = await device.prepare(invitation.bytes, operation(2));
  assert.equal(prepared.kind, "register");
  await assert.rejects(device.publication(), { code: "initialization_incomplete" });
  const prejoin = (await complete(device, witness, prepared)).publication;
  assert.equal(prejoin.tag, "prepared");

  const pending = await witnessed(daemon, witness, () =>
    daemon.submitClaim(operation(3), prejoin.bytes),
  );
  assert.equal(pending.tag, "claim");
  assert.equal(pending.publication.tag, "pending");
  const reservationId = operation(4);
  // Hash length is checked before any asynchronous work is scheduled, with a declared ABI code.
  await assert.rejects(daemon.confirmClaim(operation(5), Buffer.alloc(47), reservationId), {
    code: "invalid_hash",
  });
  const reserved = await witnessed(daemon, witness, () =>
    daemon.confirmClaim(operation(5), pending.publication.hash, reservationId),
  );
  assert.equal(reserved.status, "reserved");
  // The complete exact reservation intent crosses the boundary, not a lossy summary.
  const intent = reserved.publication.reservation;
  assert.deepEqual(reserved.publication, { tag: "reserved", reservation: intent });
  assert.deepEqual(Buffer.from(intent.reservationId), reservationId);
  assert.deepEqual(Buffer.from(intent.cryptoSessionId), session);
  assert.deepEqual(Buffer.from(intent.accountId), account);
  assert.deepEqual(Buffer.from(intent.installationId), installation);
  assert.deepEqual(Buffer.from(intent.deviceId), deviceId);
  assert.deepEqual(Buffer.from(intent.claimHash), Buffer.from(pending.publication.hash));
  assert.deepEqual(
    Buffer.from(intent.keyPackageHash),
    createHash("sha384").update(prejoin.secondaryBytes).digest(),
  );
  assert.equal(typeof intent.expiresAtMs, "bigint");
  assert(intent.expiresAtMs > 0n);
  const welcome = (
    await witnessed(daemon, witness, () => daemon.createWelcome(operation(6), reservationId))
  ).welcome;
  assert.equal(
    (
      await witnessed(device, witness, () =>
        device.joinPublishedWelcome(
          operation(7),
          welcome.bytes,
          welcome.claimHash,
          createHash("sha384").update(welcome.bytes).digest(),
          welcome.expiresAtMs,
        ),
      )
    ).status,
    "joined",
  );
  const activation = (
    await witnessed(device, witness, () => device.prepareActivation(operation(8), operation(9)))
  ).outbox;
  await assert.rejects(
    witnessed(device, witness, () =>
      device.prepareApplication(operation(10), operation(11), 1n, Buffer.from("blocked")),
    ),
    { code: "conflict" },
  );
  const acceptance = (
    await witnessed(daemon, witness, () =>
      daemon.acceptActivation(operation(12), operation(9), activation.ciphertext),
    )
  ).activation;
  assert.equal(
    (await witnessed(device, witness, () => device.acknowledgeActivation(operation(13), acceptance)))
      .status,
    "active",
  );
  return { root, daemon, device, witness, session };
}

test("configured trust certifies only through the named replicas", async () => {
  const root = mkdtempSync(join(tmpdir(), "axl-e2ee-node-"));
  try {
    const account = Buffer.alloc(16, 60);
    const installation = uuid(61);
    const session = uuid(62);
    const witness = fixture.testWitness();
    const other = fixture.testWitness();
    const config = witness.trustConfig;
    assert.equal(config.byteLength, 3 + 3 * (16 + 1 + 48));

    const daemon = fixture.configuredDaemonEndpoint(
      join(root, "daemon"),
      account,
      installation,
      session,
      config,
    );
    const issued = await complete(daemon, witness, await daemon.issue(operation(1)));
    assert.equal(issued.publication.tag, "issued");
    const device = fixture.configuredDeviceEndpoint(
      join(root, "device"),
      account,
      installation,
      session,
      uuid(63),
      config,
    );
    const prejoin = await complete(
      device,
      witness,
      await device.prepare(issued.publication.bytes, operation(2)),
    );
    assert.equal(prejoin.publication.tag, "prepared");

    // Receipts from replicas the configuration does not name never complete an operation.
    const foreign = fixture.configuredDaemonEndpoint(
      join(root, "foreign"),
      account,
      installation,
      uuid(64),
      other.trustConfig,
    );
    const pending = await foreign.issue(operation(1));
    await assert.rejects(foreign.continueWitness(pending.operationId, witness.respond(pending.request)), {
      code: "witness_receipt_invalid",
    });

    for (const malformed of [Buffer.alloc(0), Buffer.concat([config, Buffer.alloc(1)]), config.subarray(1)]) {
      assert.throws(
        () => fixture.configuredDaemonEndpoint(join(root, "bad"), account, installation, session, malformed),
        /invalid_argument|bound_exceeded/u,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production artifact reports its ABI and fails closed", async () => {
  assert.deepEqual(production.getBindingInfo(), {
    abiVersion: 2,
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

test("witness barrier withholds every result until the exact certificate completes", async () => {
  const pair = await activatedPair(30);
  try {
    const { device, witness } = pair;
    const plaintext = Buffer.from("withheld until the quorum answers");
    // Mutation without a fresh unanimous read is refused before any input is evaluated.
    await assert.rejects(
      device.prepareApplication(operation(20), operation(21), 7n, plaintext),
      { code: "fresh_witness_required" },
    );
    await authorize(device, witness);
    const outcome = await device.prepareApplication(operation(20), operation(21), 7n, plaintext);
    assert.equal(outcome.tag, "pending");
    assert.equal(outcome.result, null);
    const pending = outcome.pending;
    assert.equal(pending.kind, "advance");
    assert.deepEqual(pending.operationId, operation(20));
    assert.deepEqual(pending.requestHash, createHash("sha384").update(pending.request).digest());
    assert(!contains(pending.request, plaintext), "request carries no plaintext");
    // The durable pending request is reloaded, byte-identical, on every call.
    assert.deepEqual(await device.pendingWitness(), pending);
    // A duplicate call returns the same request without a second transition.
    const duplicate = await device.prepareApplication(operation(20), operation(21), 7n, plaintext);
    assert.equal(duplicate.tag, "pending");
    assert.deepEqual(duplicate.pending, pending);
    // Nothing typed leaves the binding while the barrier is open.
    assert(
      !(await device.pendingOutbox()).some((record) => record.operationId.equals(operation(20))),
    );
    await assert.rejects(device.pairStatus(), { code: "witness_unavailable" });
    await assert.rejects(
      device.prepareApplication(operation(22), operation(23), 7n, Buffer.from("later")),
      { code: "witness_unavailable" },
    );
    // Bounds and identity are checked before any work.
    await assert.rejects(device.continueWitness(pending.operationId, Buffer.alloc(3 * 1024 + 1)), {
      code: "bound_exceeded",
    });
    const wrongOperation = Buffer.from(pending.operationId);
    wrongOperation[0] ^= 1;
    await assert.rejects(device.continueWitness(wrongOperation, Buffer.alloc(32)), {
      code: "not_found",
    });
    // Certificate bytes are copied before async work.
    const certificate = Buffer.from(witness.respond(pending.request));
    const completion = device.continueWitness(pending.operationId, certificate);
    certificate.fill(0);
    const released = await completion;
    assert.equal(released.tag, "outbox");
    assert.deepEqual(released.outbox.operationId, operation(20));
    assert(!contains(released.outbox.ciphertext, plaintext));
    assert(
      (await device.pendingOutbox()).some((record) =>
        record.ciphertext.equals(released.outbox.ciphertext),
      ),
    );
    assert.equal(await device.pendingWitness(), null);
    assert.equal(await device.pairStatus(), "active");
    // Completed operations replay the exact result without a new advance.
    const responses = witness.responses;
    const replay = await device.prepareApplication(operation(20), operation(21), 7n, plaintext);
    assert.equal(replay.tag, "released");
    assert.deepEqual(replay.result.outbox.ciphertext, released.outbox.ciphertext);
    assert.equal(witness.responses, responses);

    // A forged replica signature releases nothing and quarantines the endpoint durably.
    await authorize(device, witness);
    const forged = (
      await device.prepareApplication(operation(24), operation(25), 7n, Buffer.from("forged"))
    ).pending;
    witness.setForgeSignature(true);
    await assert.rejects(complete(device, witness, forged), { code: "witness_receipt_invalid" });
    witness.setForgeSignature(false);
    await assert.rejects(complete(device, witness, forged), { code: "rollback_detected" });
    await assert.rejects(device.pendingWitness(), { code: "rollback_detected" });
    await device.close();
    assert.equal(await device.reopen(), "opened");
    await assert.rejects(device.pendingWitness(), { code: "rollback_detected" });
    // A fresh read still runs: the terminal state is rediscovered, never cleared.
    assert.equal((await reconcile(device, witness)).tag, "quarantined");
    await assert.rejects(
      device.prepareApplication(operation(26), operation(27), 7n, Buffer.from("frozen")),
      { code: "rollback_detected" },
    );
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

test("fresh lifecycle preserves barriers, exact retries, copied input, and close semantics", async () => {
  const pair = await activatedPair(31);
  const daemon = witnessedFacade(pair.daemon, pair.witness);
  const device = witnessedFacade(pair.device, pair.witness);
  try {
    // Input buffers are copied synchronously, before the async work starts.
    await authorize(pair.device, pair.witness);
    const input = Buffer.from("copied before async work");
    const sendPromise = pair.device.prepareApplication(operation(20), operation(21), 7n, input);
    input.fill(0);
    const sent = (await complete(pair.device, pair.witness, (await sendPromise).pending)).outbox;
    const duplicate = await device.prepareApplication(
      operation(20),
      operation(21),
      7n,
      Buffer.from("copied before async work"),
    );
    assert.deepEqual(duplicate.ciphertext, sent.ciphertext);
    assert.deepEqual(
      (await device.pendingOutbox()).map((record) => record.operationId),
      [operation(8), operation(20)],
    );
    const received = await daemon.receiveApplication(operation(22), sent.ciphertext, operation(21), 7n);
    assert.equal(received.plaintext.toString(), "copied before async work");
    const recovered = await daemon.receiveApplication(operation(22), sent.ciphertext, operation(21), 7n);
    assert.equal(recovered.plaintext.toString(), "copied before async work");
    await assert.rejects(
      daemon.receiveApplication(operation(70), sent.ciphertext, operation(21), 7n),
      { code: "replay_rejected" },
    );
    assert.equal(
      (await device.acknowledgeOutbox(operation(71), operation(20))).retryState,
      "acknowledged",
    );
    assert.deepEqual(
      (await device.pendingOutbox()).map((record) => record.operationId),
      [operation(8)],
    );
    assert.equal(await daemon.acknowledgeReceive(operation(72), operation(22)), "acknowledged");

    const delivered = await daemon.prepareApplication(
      operation(73),
      operation(74),
      7n,
      Buffer.from("return path"),
    );
    const deliveredPlaintext = await device.receiveApplication(
      operation(75),
      delivered.ciphertext,
      operation(74),
      7n,
    );
    assert.equal(deliveredPlaintext.plaintext.toString(), "return path");

    // One operation owner per endpoint: an overlapping call is refused, not queued.
    const status = pair.device.pairStatus();
    await assert.rejects(pair.device.pairStatus(), { code: "lifecycle_busy" });
    assert.equal(await status, "active");

    const proposal = await device.prepareReplacement(operation(23), operation(24), 7n);
    assert.equal(
      await daemon.receiveReplacementProposal(operation(25), proposal.ciphertext, operation(24), 7n),
      "accepted",
    );
    const commit = await daemon.createUpdateCommit(operation(26), operation(27), 7n);
    await assert.rejects(
      daemon.prepareApplication(operation(28), operation(29), 7n, Buffer.from("barrier")),
      { code: "conflict" },
    );
    // Received commit application and epoch-ready creation are separate operations.
    const applied = await witnessed(pair.device, pair.witness, () =>
      pair.device.applyReceivedUpdateCommit(operation(30), commit.ciphertext, operation(27), 7n),
    );
    assert.equal(applied.tag, "commit");
    assert.deepEqual(applied.commit.commitId, commit.commitId);
    assert.equal(applied.commit.targetEpoch, commit.targetEpoch);
    await assert.rejects(
      device.prepareApplication(operation(32), operation(33), 7n, Buffer.from("barrier")),
      { code: "conflict" },
    );
    const ready = await witnessed(pair.device, pair.witness, () =>
      pair.device.prepareEpochReady(operation(31), operation(34), 7n, applied.commit),
    );
    assert.equal(ready.outbox.messageClass, "epoch_ready");
    const epochAcceptance = await daemon.acceptEpochReady(
      operation(35),
      operation(34),
      7n,
      ready.outbox.ciphertext,
    );
    assert.deepEqual(epochAcceptance.commitId, commit.commitId);
    const confirmation = await daemon.prepareEpochReadyConfirmation(
      operation(36),
      operation(38),
      7n,
      epochAcceptance,
    );
    assert.equal(
      await device.acceptEpochReadyConfirmation(operation(39), operation(38), 7n, confirmation.ciphertext),
      "active",
    );

    // Restart: the completed cache is not authority until a fresh unanimous head confirms it.
    const retryBeforeClose = await device.prepareApplication(
      operation(40),
      operation(41),
      8n,
      Buffer.from("reopen retry"),
    );
    await pair.device.close();
    await assert.rejects(pair.device.pairStatus(), { code: "endpoint_closed" });
    assert.equal(await pair.device.reopen(), "opened");
    await assert.rejects(pair.device.pairStatus(), { code: "witness_unavailable" });
    await assert.rejects(
      pair.device.prepareApplication(operation(40), operation(41), 8n, Buffer.from("reopen retry")),
      { code: "fresh_witness_required" },
    );
    assert.equal((await reconcile(pair.device, pair.witness)).tag, "recover_accepted");
    const recoveredPending = await pair.device.pendingWitness();
    assert.deepEqual(recoveredPending.operationId, operation(40));
    const recoveredResult = await complete(pair.device, pair.witness, recoveredPending);
    assert.deepEqual(recoveredResult.outbox.ciphertext, retryBeforeClose.ciphertext);
    const retryAfterClose = await device.prepareApplication(
      operation(40),
      operation(41),
      8n,
      Buffer.from("reopen retry"),
    );
    assert.deepEqual(retryAfterClose.ciphertext, retryBeforeClose.ciphertext);
    assert.equal(await pair.device.pairStatus(), "active");

    // Same operation ID with different input is a fingerprint conflict: fail closed and freeze.
    await assert.rejects(
      device.prepareApplication(operation(40), operation(41), 8n, Buffer.from("conflict")),
      { code: "witness_operation_conflict" },
    );
    await assert.rejects(
      device.prepareApplication(operation(42), operation(43), 8n, Buffer.from("frozen")),
      { code: "rollback_detected" },
    );
    await pair.device.close();
    await pair.device.close();
  } finally {
    try {
      await pair.daemon.close();
    } catch {}
    rmSync(pair.root, { recursive: true, force: true });
  }
});

test("restart before transmission resends the byte-identical request", async () => {
  const pair = await activatedPair(32);
  try {
    const { device, witness } = pair;
    await authorize(device, witness);
    const pending = (
      await device.prepareApplication(operation(50), operation(51), 3n, Buffer.from("resend me"))
    ).pending;
    const responses = witness.responses;
    await device.close();
    assert.equal(await device.reopen(), "opened");
    assert.deepEqual(await device.pendingWitness(), pending);
    assert.equal((await reconcile(device, witness)).tag, "resend_pending");
    const released = await complete(device, witness, pending);
    assert.equal(released.tag, "outbox");
    assert.deepEqual(released.outbox.operationId, operation(50));
    assert.equal(witness.responses, responses + 2n, "one read and one exact resend");
    assert(
      (await device.pendingOutbox()).some((record) => record.operationId.equals(operation(50))),
    );
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

test("unavailable and revoking quorums release nothing", async () => {
  const pair = await activatedPair(33);
  try {
    const { daemon, witness } = pair;
    witness.setUnavailable(true);
    assert.throws(() => witness.respond(Buffer.alloc(0)), { code: "bound_exceeded" });
    await assert.rejects(authorize(daemon, witness), { code: "witness_unavailable" });
    witness.setUnavailable(false);
    await authorize(daemon, witness);
    const pending = (
      await daemon.prepareApplication(operation(60), operation(61), 2n, Buffer.from("revoked"))
    ).pending;
    // Revocation that wins before the advance: the exact request now answers `Revoked`.
    witness.revoke(pending.request);
    await assert.rejects(complete(daemon, witness, pending), { code: "endpoint_revoked" });
    assert(
      !(await daemon.pendingOutbox()).some((record) => record.operationId.equals(operation(60))),
    );
    await assert.rejects(daemon.pairStatus(), { code: "endpoint_revoked" });
    await daemon.close();
    assert.equal(await daemon.reopen(), "opened");
    await assert.rejects(daemon.pendingWitness(), { code: "endpoint_revoked" });
    assert.equal((await reconcile(daemon, witness)).tag, "revoked");
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
    const { daemon, device, witness } = pair;
    const removal = await witnessed(daemon, witness, () =>
      daemon.revokeDevice(operation(80), operation(81), 9n),
    );
    assert.equal(removal.tag, "outbox");
    assert.equal(removal.outbox.messageClass, "commit");
    assert.equal(await daemon.pairStatus(), "revoked");
    const removed = await witnessed(device, witness, () =>
      device.applyRemoval(operation(82), removal.outbox, operation(81), 9n),
    );
    assert.equal(removed.status, "removed");
    assert.equal(await device.pairStatus(), "removed");
    const requirement = (await witnessed(device, witness, () => device.reset(operation(83)))).rePair;
    assert.equal(requirement.cryptoSessionId.length, 16);
    assert.equal(requirement.keyPackageHash.length, 48);
    assert.equal(await device.pairStatus(), "reset");
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
  rmSync(join(lost.root, "device", `${lost.session.toString("hex")}.redb`));
  await assert.rejects(lost.device.reopen(), { code: "state_loss" });
  try {
    await lost.daemon.close();
  } catch {}
  rmSync(lost.root, { recursive: true, force: true });

  const corrupt = await activatedPair(50);
  await corrupt.device.close();
  const corruptPath = join(corrupt.root, "device", `${corrupt.session.toString("hex")}.redb`);
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
  assert(fixture.nativeExports.includes("TestWitness"));
  assert(!Object.keys(production).some((name) => /^test/iu.test(name)));
});
