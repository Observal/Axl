// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decodeBase64,
  DEFAULT_RELAY_LIMITS,
  encodeBase64,
  encodeInternalConsumeRelayTicketRequest,
  encodeRelayBinaryFrame,
  MAX_RELAY_FRAME_BYTES,
  MAX_RELAY_OPAQUE_PAYLOAD_BYTES,
  parseInternalConsumeRelayTicketRequest,
  parseDeviceId,
  parseInternalConsumeRelayTicketResult,
  parseIssueRelayTicketRequest,
  parseRelayBinaryFrame,
  parseRelayRevocationNotification,
  ProtocolValidationError,
  RELAY_FAILURE_CODE_VALUES,
  REMOTE_TRANSPORT_VERSION,
  type RelayBinaryFrame,
} from "../src/index.ts";
import { DeterministicFakeRemoteCryptoAdapter } from "./support/fake-remote-crypto.ts";

interface BinaryFixture {
  readonly accepted: readonly {
    readonly name: string;
    readonly base64: string;
    readonly frame: Readonly<Record<string, unknown>>;
  }[];
  readonly rejected: readonly {
    readonly name: string;
    readonly base64: string;
    readonly errorPath: string;
  }[];
}

const binaryFixtures = JSON.parse(
  readFileSync(new URL("./fixtures/remote-transport-v1.json", import.meta.url), "utf8"),
) as BinaryFixture;
const internalFixtures = JSON.parse(
  readFileSync(new URL("./fixtures/internal-relay-api-v1.json", import.meta.url), "utf8"),
) as {
  readonly consumeTicket: { readonly request: unknown; readonly result: unknown };
  readonly revocation: { readonly request: unknown; readonly result: unknown };
};

function fixtureShape(frame: RelayBinaryFrame): Readonly<Record<string, unknown>> {
  if ("destinationRouteId" in frame) {
    return {
      kind: "send",
      attemptId: frame.attemptId,
      routeId: frame.destinationRouteId,
      opaquePayloadBase64: encodeBase64(frame.opaquePayload),
    };
  }
  if ("sourceRouteId" in frame) {
    return {
      kind: "delivery",
      attemptId: frame.attemptId,
      routeId: frame.sourceRouteId,
      opaquePayloadBase64: encodeBase64(frame.opaquePayload),
    };
  }
  if ("status" in frame)
    return { kind: "receipt", attemptId: frame.attemptId, status: frame.status };
  return { kind: "failure", attemptId: frame.attemptId, code: frame.code };
}

test("accepts and reproduces every canonical relay frame", () => {
  for (const fixture of binaryFixtures.accepted) {
    const bytes = decodeBase64(fixture.base64, `${fixture.name}.base64`, MAX_RELAY_FRAME_BYTES);
    const parsed = parseRelayBinaryFrame(bytes);
    assert.deepEqual(fixtureShape(parsed), fixture.frame, fixture.name);
    assert.deepEqual(encodeRelayBinaryFrame(parsed), bytes, fixture.name);
  }
});

test("rejects every malformed canonical relay frame", () => {
  for (const fixture of binaryFixtures.rejected) {
    const bytes = decodeBase64(fixture.base64, `${fixture.name}.base64`, MAX_RELAY_FRAME_BYTES);
    assert.throws(
      () => parseRelayBinaryFrame(bytes),
      (error) => error instanceof ProtocolValidationError && error.path === fixture.errorPath,
      fixture.name,
    );
  }
});

test("keeps relay failure byte assignments stable", () => {
  assert.deepEqual(RELAY_FAILURE_CODE_VALUES, {
    bad_frame: 1,
    unsupported_transport_version: 2,
    unauthorized: 3,
    forbidden_route: 4,
    ticket_expired: 5,
    ticket_consumed: 6,
    destination_offline: 7,
    rate_limited: 8,
    queue_full: 9,
    slow_consumer: 10,
    service_unavailable: 11,
  });
});

test("enforces the complete frame bound before encoding", () => {
  const attemptId = "11111111-1111-4111-8111-111111111111" as const;
  const destinationRouteId = "22222222-2222-4222-8222-222222222222" as const;
  const frame = {
    transportVersion: REMOTE_TRANSPORT_VERSION,
    attemptId,
    destinationRouteId,
    opaquePayload: new Uint8Array(MAX_RELAY_OPAQUE_PAYLOAD_BYTES + 1),
  } as RelayBinaryFrame;
  assert.throws(
    () => encodeRelayBinaryFrame(frame),
    (error) => error instanceof ProtocolValidationError && error.path === "frame.opaquePayload",
  );
});

test("keeps the deterministic fake E2EE adapter in test support", async () => {
  const daemonId = parseDeviceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const deviceId = parseDeviceId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const daemon = new DeterministicFakeRemoteCryptoAdapter(daemonId, deviceId);
  const device = new DeterministicFakeRemoteCryptoAdapter(deviceId, daemonId);
  const plaintext = Uint8Array.of(0, 1, 2, 255);

  const opaque = await device.seal(daemonId, plaintext);
  assert.match(new TextDecoder().decode(opaque), /TEST_ONLY_NOT_ENCRYPTED/);
  assert.deepEqual(await daemon.open(opaque), {
    authenticatedDeviceId: deviceId,
    plaintext,
  });

  const modified = JSON.parse(new TextDecoder().decode(opaque)) as Record<string, unknown>;
  modified.sourceDeviceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await assert.rejects(daemon.open(new TextEncoder().encode(JSON.stringify(modified))));
});

test("validates ticket roles and the language-neutral internal contract", () => {
  assert.deepEqual(
    parseIssueRelayTicketRequest({
      installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      role: "device",
    }),
    {
      installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      role: "device",
    },
  );
  assert.throws(
    () =>
      parseIssueRelayTicketRequest({
        installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        role: "device",
      }),
    (error) => error instanceof ProtocolValidationError && error.path === "request.deviceId",
  );

  const request = parseInternalConsumeRelayTicketRequest(internalFixtures.consumeTicket.request);
  assert.deepEqual([...request.possessionProof], [0, 1, 2, 3, 255]);
  assert.deepEqual(
    encodeInternalConsumeRelayTicketRequest(request),
    internalFixtures.consumeTicket.request,
  );
  assert.deepEqual(parseInternalConsumeRelayTicketResult(internalFixtures.consumeTicket.result), {
    installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sourceRouteId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    role: "device",
    leaseExpiresAt: 2_000_000_000_000,
    limits: DEFAULT_RELAY_LIMITS,
  });
  assert.deepEqual(
    parseRelayRevocationNotification(internalFixtures.revocation.request),
    internalFixtures.revocation.request,
  );
});
