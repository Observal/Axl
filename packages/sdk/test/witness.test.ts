// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { WITNESS_HTTP_CONTENT_TYPE } from "@axl/protocol";

import {
  HostedWitnessClient,
  HostedWitnessError,
  WitnessBarrierError,
  WitnessedEndpoint,
  type WitnessEndpointOperations,
  type WitnessFetchResponse,
  type WitnessMutationOutcome,
  type WitnessPendingOperation,
  type WitnessReconciliation,
  type WitnessTypedResult,
} from "../src/witness.ts";

const fixtures = new URL("../../e2ee/fixtures/v1/", import.meta.url);

async function fixture(): Promise<{
  readonly request: Uint8Array;
  readonly certificate: Uint8Array;
}> {
  return {
    request: new Uint8Array(await readFile(new URL("witness-advance-v1.bin", fixtures))),
    certificate: new Uint8Array(await readFile(new URL("witness-quorum-v1.bin", fixtures))),
  };
}

test("submits the exact witness request and returns the bounded certificate", async () => {
  const { request, certificate } = await fixture();
  let body: Uint8Array | undefined;
  const client = new HostedWitnessClient({
    controlPlaneOrigin: "http://127.0.0.1:43123",
    allowInsecureLoopbackForTests: true,
    authenticationHeaders: async () => ({ authorization: "Bearer local" }),
    fetch: async (url, init) => {
      assert.equal(url, "http://127.0.0.1:43123/v1/e2ee/witness");
      assert.equal(init.headers["content-type"], WITNESS_HTTP_CONTENT_TYPE);
      body = init.body.slice();
      return {
        ok: true,
        status: 200,
        headers: { get: () => WITNESS_HTTP_CONTENT_TYPE },
        async arrayBuffer() {
          return certificate.slice().buffer;
        },
        async json() {
          throw new Error("not JSON");
        },
      };
    },
  });
  const input = request.slice();
  const received = await client.respond(input);
  assert.deepEqual(body, request);
  assert.deepEqual(input, request, "the caller's request bytes are left untouched");
  assert.deepEqual(received, certificate);
});

test("fails closed for transport, service, content-type, and size errors", async () => {
  const { request, certificate } = await fixture();
  const create = (response: WitnessFetchResponse) =>
    new HostedWitnessClient({
      controlPlaneOrigin: "https://witness.invalid",
      authenticationHeaders: async () => ({}),
      fetch: async () => response,
    });
  await assert.rejects(
    create({
      ok: false,
      status: 409,
      headers: { get: () => "application/json" },
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
      async json() {
        return { error: { code: "witness_conflict" } };
      },
    }).respond(request),
    (cause) => cause instanceof HostedWitnessError && cause.code === "witness_conflict",
  );
  await assert.rejects(
    create({
      ok: true,
      status: 200,
      headers: { get: () => "application/octet-stream" },
      async arrayBuffer() {
        return certificate.slice().buffer;
      },
      async json() {
        return {};
      },
    }).respond(request),
    (cause) => cause instanceof HostedWitnessError && cause.code === "witness_receipt_invalid",
  );
  await assert.rejects(
    create({
      ok: true,
      status: 200,
      headers: { get: () => WITNESS_HTTP_CONTENT_TYPE },
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
      async json() {
        return {};
      },
    }).respond(new Uint8Array()),
    (cause) => cause instanceof HostedWitnessError && cause.code === "witness_receipt_invalid",
  );
});

interface ScriptedEndpoint extends WitnessEndpointOperations {
  readonly calls: string[];
  mutateOnce(): Promise<WitnessMutationOutcome>;
}

function scripted(
  reconciliations: WitnessReconciliation[],
  pending: WitnessPendingOperation | null,
  outcome: WitnessMutationOutcome,
): ScriptedEndpoint {
  const calls: string[] = [];
  return {
    calls,
    async witnessReadRequest() {
      calls.push("read");
      return Uint8Array.of(1, 2, 3);
    },
    async reconcileWitness(certificate) {
      calls.push(`reconcile:${certificate.join(",")}`);
      const next = reconciliations.shift();
      if (next === undefined) throw new Error("unexpected reconciliation");
      return next;
    },
    async pendingWitness() {
      calls.push("pending");
      return pending;
    },
    async continueWitness(operationId, certificate) {
      calls.push(`continue:${operationId.join(",")}:${certificate.join(",")}`);
      return { tag: "outbox", outbox: { operationId } };
    },
    async mutateOnce() {
      calls.push("mutate");
      return outcome;
    },
  };
}

function transport(certificates: Uint8Array[]) {
  const requests: Uint8Array[] = [];
  return {
    requests,
    async respond(request: Uint8Array) {
      requests.push(request.slice());
      const next = certificates.shift();
      if (next === undefined) throw new Error("unexpected witness request");
      return next.slice();
    },
  };
}

const pendingOperation: WitnessPendingOperation = {
  operationId: Uint8Array.of(9),
  request: Uint8Array.of(7, 7),
  requestHash: new Uint8Array(48),
  kind: "advance",
};

test("the witnessed endpoint recovers a pending operation, reads fresh, mutates, and continues", async () => {
  const endpoint = scripted([{ tag: "resend_pending" }, { tag: "ready" }], pendingOperation, {
    tag: "pending",
    pending: { ...pendingOperation, operationId: Uint8Array.of(4) },
  });
  const witness = transport([
    Uint8Array.of(10),
    Uint8Array.of(11),
    Uint8Array.of(12),
    Uint8Array.of(13),
  ]);
  const witnessed = new WitnessedEndpoint(endpoint, witness);
  const result: WitnessTypedResult = await witnessed.mutate((value) => value.mutateOnce());
  assert.equal(result.tag, "outbox");
  assert.deepEqual(endpoint.calls, [
    "read",
    "reconcile:10",
    "pending",
    "continue:9:11",
    "read",
    "reconcile:12",
    "mutate",
    "continue:4:13",
  ]);
  assert.deepEqual(
    witness.requests.map((request) => [...request]),
    [
      [1, 2, 3],
      [7, 7],
      [1, 2, 3],
      [7, 7],
    ],
    "the transport receives the exact read and pending request bytes",
  );
});

test("a released duplicate skips the continuation and quarantine or revocation fail closed", async () => {
  const released = scripted([{ tag: "ready" }], null, {
    tag: "released",
    result: { tag: "plaintext", plaintext: { plaintext: Uint8Array.of(1) } },
  });
  const result = await new WitnessedEndpoint(released, transport([Uint8Array.of(1)])).mutate(
    (value) => value.mutateOnce(),
  );
  assert.equal(result.tag, "plaintext");
  assert.deepEqual(released.calls, ["read", "reconcile:1", "mutate"]);

  const quarantined = scripted([{ tag: "quarantined", reason: "historical_fork" }], null, {
    tag: "released",
  });
  await assert.rejects(
    new WitnessedEndpoint(quarantined, transport([Uint8Array.of(1)])).mutate((value) =>
      value.mutateOnce(),
    ),
    (cause) =>
      cause instanceof WitnessBarrierError &&
      cause.code === "witness_quarantined" &&
      cause.reason === "historical_fork",
  );
  assert.ok(!quarantined.calls.includes("mutate"));

  const revoked = scripted([{ tag: "revoked" }], null, { tag: "released" });
  await assert.rejects(
    new WitnessedEndpoint(revoked, transport([Uint8Array.of(1)])).recover(),
    (cause) => cause instanceof WitnessBarrierError && cause.code === "endpoint_revoked",
  );

  const unavailable = scripted([{ tag: "witness_unavailable" }], null, { tag: "released" });
  await assert.rejects(
    new WitnessedEndpoint(unavailable, transport([Uint8Array.of(1)])).recover(),
    (cause) => cause instanceof WitnessBarrierError && cause.code === "witness_unavailable",
  );

  const empty = scripted([{ tag: "ready" }], null, { tag: "released" });
  await assert.rejects(
    new WitnessedEndpoint(empty, transport([Uint8Array.of(1)])).mutate((value) =>
      value.mutateOnce(),
    ),
    (cause) => cause instanceof WitnessBarrierError && cause.code === "witness_result_mismatch",
  );
});

test("concurrent barriers on one endpoint never interleave", async () => {
  const endpoint = scripted([{ tag: "ready" }, { tag: "ready" }], null, {
    tag: "pending",
    pending: pendingOperation,
  });
  const witness = transport([
    Uint8Array.of(1),
    Uint8Array.of(2),
    Uint8Array.of(3),
    Uint8Array.of(4),
  ]);
  const witnessed = new WitnessedEndpoint(endpoint, witness);
  await Promise.all([
    witnessed.mutate((value) => value.mutateOnce()),
    witnessed.mutate((value) => value.mutateOnce()),
  ]);
  assert.deepEqual(endpoint.calls, [
    "read",
    "reconcile:1",
    "mutate",
    "continue:9:2",
    "read",
    "reconcile:3",
    "mutate",
    "continue:9:4",
  ]);
});
