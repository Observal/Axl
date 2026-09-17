// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { WITNESS_HTTP_CONTENT_TYPE } from "@axl/protocol";

import {
  HostedWitnessClient,
  HostedWitnessError,
  type PendingWitnessContinuation,
  type WitnessFetchResponse,
} from "../src/witness.ts";

const fixtures = new URL("../../e2ee/fixtures/v1/", import.meta.url);

async function pending(): Promise<{
  readonly value: PendingWitnessContinuation;
  readonly certificate: Uint8Array;
  readonly completed: Uint8Array[];
}> {
  const request = new Uint8Array(await readFile(new URL("witness-advance-v1.bin", fixtures)));
  const certificate = new Uint8Array(await readFile(new URL("witness-quorum-v1.bin", fixtures)));
  const operationId = request.slice(89, 105);
  const completed: Uint8Array[] = [];
  return {
    certificate,
    completed,
    value: {
      operationId,
      witnessRequest: request,
      requestHash: new Uint8Array(48).fill(7),
      status: "pending_quorum",
      async continueWitness(receivedOperation, receivedCertificate) {
        assert.deepEqual(receivedOperation, operationId);
        assert.deepEqual(receivedCertificate, certificate);
        completed.push(receivedCertificate.slice());
        return new TextEncoder().encode("committed");
      },
    },
  };
}

test("submits the exact witness request and continues with the bounded certificate", async () => {
  const fixture = await pending();
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
          return fixture.certificate.slice().buffer;
        },
        async json() {
          throw new Error("not JSON");
        },
      };
    },
  });
  assert.equal(new TextDecoder().decode(await client.complete(fixture.value)), "committed");
  assert.deepEqual(body, fixture.value.witnessRequest);
  assert.equal(fixture.completed.length, 1);
});

test("fails closed for transport, service, content-type, and size errors", async () => {
  const fixture = await pending();
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
    }).complete(fixture.value),
    (cause) => cause instanceof HostedWitnessError && cause.code === "witness_conflict",
  );
  await assert.rejects(
    create({
      ok: true,
      status: 200,
      headers: { get: () => "application/octet-stream" },
      async arrayBuffer() {
        return fixture.certificate.slice().buffer;
      },
      async json() {
        return {};
      },
    }).complete(fixture.value),
    (cause) => cause instanceof HostedWitnessError && cause.code === "witness_receipt_invalid",
  );
});
