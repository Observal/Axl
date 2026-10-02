// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decodeBase64,
  decodeRemoteDaemonMessage,
  DEFAULT_DAEMON_RELAY_LIMITS,
  DEFAULT_RELAY_LIMITS,
  encodeBase64,
  encodeRemoteDaemonMessage,
  encodeRemoteDaemonMessageFrames,
  MAX_REMOTE_APPLICATION_PLAINTEXT_BYTES,
  MAX_REMOTE_REASSEMBLED_MESSAGE_BYTES,
  parseEnvelopeId,
  parseRelayLimits,
  RemoteDaemonMessageAssembler,
  encodeRemoteE2eeEnvelope,
  encodeInternalConsumeRelayTicketRequest,
  encodeRelayBinaryFrame,
  MAX_E2EE_CIPHERTEXT_BYTES,
  MAX_RELAY_FRAME_BYTES,
  MAX_RELAY_OPAQUE_PAYLOAD_BYTES,
  parseInternalConsumeRelayTicketRequest,
  parseDeviceId,
  parseIdempotencyKey,
  parseInternalConsumeRelayTicketResult,
  parseIssueRelayTicketRequest,
  parseOpaqueOutboxRecord,
  parseOperationId,
  parseRelayBinaryFrame,
  parseRelayDiscoveryMessage,
  parseRelayRevocationNotification,
  parseRemoteDeviceScopes,
  parseRemoteE2eeEnvelope,
  parseRemoteRequestId,
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
  readonly discovery: { readonly deviceSnapshot: unknown };
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
    ticket_revoked: 12,
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

test("validates role-scoped route discovery messages", () => {
  assert.deepEqual(
    parseRelayDiscoveryMessage(internalFixtures.discovery.deviceSnapshot),
    internalFixtures.discovery.deviceSnapshot,
  );
  assert.throws(
    () =>
      parseRelayDiscoveryMessage({
        version: 1,
        type: "route_available",
        sourceRoute: { routeId: "11111111-1111-4111-8111-111111111111", role: "daemon" },
        peers: [],
      }),
    (error) => error instanceof ProtocolValidationError && error.path === "discovery.sourceRoute",
  );
});

test("encodes authenticated E2EE routing metadata inside the opaque relay payload", () => {
  const envelope = {
    operationId: parseOperationId("11111111-1111-4111-8111-111111111111"),
    logicalMessageId: parseOperationId("22222222-2222-4222-8222-222222222222"),
    messageClass: "application_request" as const,
    hostedGrantGeneration: Number.MAX_SAFE_INTEGER,
    ciphertext: Uint8Array.of(0, 1, 2, 255),
  };
  const encoded = encodeRemoteE2eeEnvelope(envelope);
  assert.deepEqual(parseRemoteE2eeEnvelope(encoded), envelope);
  assert.throws(
    () =>
      encodeRemoteE2eeEnvelope({
        ...envelope,
        ciphertext: new Uint8Array(MAX_E2EE_CIPHERTEXT_BYTES + 1),
      }),
    (error) => error instanceof ProtocolValidationError && error.path === "e2eeEnvelope.ciphertext",
  );
  const modified = encoded.slice();
  modified[5] = 0;
  assert.throws(
    () => parseRemoteE2eeEnvelope(modified),
    (error) =>
      error instanceof ProtocolValidationError && error.path === "e2eeEnvelope.messageClass",
  );
});

test("keeps durable outbox destinations stable and relay routes ephemeral", () => {
  const opaqueEnvelope = Uint8Array.of(1, 2, 3);
  assert.deepEqual(
    parseOpaqueOutboxRecord({
      requestId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      destinationCryptoSessionId: "33333333-3333-4333-8333-333333333333",
      opaqueEnvelope,
      createdAt: 1_900_000_000_000,
      state: "queued_local",
    }),
    {
      requestId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      destinationCryptoSessionId: "33333333-3333-4333-8333-333333333333",
      opaqueEnvelope,
      createdAt: 1_900_000_000_000,
      state: "queued_local",
    },
  );
  assert.throws(
    () =>
      parseOpaqueOutboxRecord({
        requestId: "11111111-1111-4111-8111-111111111111",
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
        destinationRouteId: "33333333-3333-4333-8333-333333333333",
        opaqueEnvelope,
        createdAt: 1_900_000_000_000,
        state: "queued_local",
      }),
    (error) =>
      error instanceof ProtocolValidationError && error.path === "outboxRecord.destinationRouteId",
  );
});

test("validates daemon acceptance only inside the authenticated payload", () => {
  const message = {
    version: REMOTE_TRANSPORT_VERSION,
    type: "daemon_accepted" as const,
    requestId: parseRemoteRequestId("11111111-1111-4111-8111-111111111111"),
    idempotencyKey: parseIdempotencyKey("22222222-2222-4222-8222-222222222222"),
  };
  assert.deepEqual(decodeRemoteDaemonMessage(encodeRemoteDaemonMessage(message)), message);
  assert.throws(
    () =>
      decodeRemoteDaemonMessage(
        new TextEncoder().encode(
          JSON.stringify({ ...message, idempotencyKey: "not-an-idempotency-key" }),
        ),
      ),
    (error) =>
      error instanceof ProtocolValidationError &&
      error.path === "remoteDaemonMessage.idempotencyKey",
  );
});

function largeResult(bytes: number) {
  return {
    version: REMOTE_TRANSPORT_VERSION,
    type: "daemon_result" as const,
    requestId: parseRemoteRequestId("11111111-1111-4111-8111-111111111111"),
    method: "session.history",
    result: { text: "x".repeat(bytes) },
  };
}

function fragmentIds() {
  let counter = 0;
  return () => `33333333-3333-4333-8333-${(++counter).toString().padStart(12, "0")}`;
}

test("fits one envelope per message and fragments larger messages within the plaintext cap", () => {
  const small = largeResult(100);
  const [single, ...none] = encodeRemoteDaemonMessageFrames(small, fragmentIds());
  assert.deepEqual(none, []);
  assert.deepEqual(decodeRemoteDaemonMessage(single ?? new Uint8Array()), small);

  const large = largeResult(150_000);
  const frames = encodeRemoteDaemonMessageFrames(large, fragmentIds());
  assert.equal(frames.length, 4);
  for (const frame of frames) {
    assert.ok(frame.byteLength <= MAX_REMOTE_APPLICATION_PLAINTEXT_BYTES);
  }
  assert.throws(() => encodeRemoteDaemonMessage(large), /no more than 60000 bytes/u);
  assert.throws(
    () =>
      decodeRemoteDaemonMessage(
        new Uint8Array(MAX_REMOTE_APPLICATION_PLAINTEXT_BYTES + 1).fill(32),
      ),
    /1 through 60000 bytes/u,
  );
  assert.throws(
    () =>
      encodeRemoteDaemonMessageFrames(
        largeResult(MAX_REMOTE_REASSEMBLED_MESSAGE_BYTES),
        fragmentIds(),
      ),
    /no more than 4194304 bytes/u,
  );

  // Out of order and duplicated delivery reassembles the exact message once.
  const assembler = new RemoteDaemonMessageAssembler();
  const fragments = frames.map((frame) => decodeRemoteDaemonMessage(frame));
  const order = [3, 0, 0, 2, 1];
  const results = order.map((index) => {
    const fragment = fragments[index];
    assert.ok(fragment?.type === "daemon_fragment");
    return assembler.accept(fragment);
  });
  assert.deepEqual(results.slice(0, 4), [undefined, undefined, undefined, undefined]);
  assert.deepEqual(results[4], large);
  assert.equal(assembler.pendingMessages, 0);
});

test("rejects conflicting, stale, and nested fragments", () => {
  const frames = encodeRemoteDaemonMessageFrames(largeResult(100_000), fragmentIds()).map((frame) =>
    decodeRemoteDaemonMessage(frame),
  );
  const [first, second] = frames;
  assert.ok(first?.type === "daemon_fragment" && second?.type === "daemon_fragment");

  const conflicting = new RemoteDaemonMessageAssembler();
  conflicting.accept(first);
  assert.throws(() => conflicting.accept({ ...first, data: second.data }), /conflicts/u);
  assert.equal(conflicting.pendingMessages, 0, "a conflict discards the message");

  let now = 0;
  const expiring = new RemoteDaemonMessageAssembler({ lifetimeMs: 1_000, now: () => now });
  expiring.accept(first);
  now = 1_000;
  expiring.accept({
    ...second,
    fragmentId: parseEnvelopeId("44444444-4444-4444-8444-444444444444"),
  });
  assert.equal(expiring.pendingMessages, 1, "the incomplete message expired");

  const bounded = new RemoteDaemonMessageAssembler({ maxPending: 1 });
  bounded.accept(first);
  bounded.accept({
    ...second,
    fragmentId: parseEnvelopeId("44444444-4444-4444-8444-444444444444"),
  });
  assert.equal(bounded.pendingMessages, 1, "the oldest incomplete message was evicted");

  // A fragment never carries another fragment, in either direction.
  assert.throws(
    () => encodeRemoteDaemonMessageFrames(first, fragmentIds()),
    /must not be a fragment/u,
  );
  const inner = new TextEncoder().encode(
    JSON.stringify({ ...first, data: encodeBase64(Uint8Array.of(1)) }),
  );
  const nested = new RemoteDaemonMessageAssembler();
  const parts = [inner.subarray(0, 10), inner.subarray(10)].map((part, index) => ({
    version: REMOTE_TRANSPORT_VERSION,
    type: "daemon_fragment" as const,
    fragmentId: parseEnvelopeId("55555555-5555-4555-8555-555555555555"),
    index,
    count: 2,
    data: encodeBase64(part),
  }));
  assert.equal(nested.accept(parts[0] ?? first), undefined);
  assert.throws(() => nested.accept(parts[1] ?? first), /must not reassemble into a fragment/u);
});

test("validates delivery batches and grant rejections", () => {
  const delivery = { kind: "sessions_changed", generation: 1 } as const;
  const batch = {
    version: REMOTE_TRANSPORT_VERSION,
    type: "daemon_deliveries" as const,
    messages: [delivery, { ...delivery, generation: 2 }],
  };
  assert.deepEqual(decodeRemoteDaemonMessage(encodeRemoteDaemonMessage(batch)), batch);
  assert.throws(
    () => encodeRemoteDaemonMessage({ ...batch, messages: [] }),
    /1 through 512 messages/u,
  );
  const rejection = {
    version: REMOTE_TRANSPORT_VERSION,
    type: "daemon_rejected" as const,
    operationId: parseOperationId("66666666-6666-4666-8666-666666666666"),
    code: "stale_grant_generation" as const,
    hostedGrantGeneration: 3,
  };
  assert.deepEqual(decodeRemoteDaemonMessage(encodeRemoteDaemonMessage(rejection)), rejection);
  assert.throws(
    () =>
      encodeRemoteDaemonMessage({
        ...rejection,
        code: "unauthorized" as unknown as "stale_grant_generation",
      }),
    (error) =>
      error instanceof ProtocolValidationError && error.path === "remoteDaemonMessage.code",
  );
});

test("carries the relay frame budget in the limits, with a larger daemon budget", () => {
  assert.ok(
    DEFAULT_DAEMON_RELAY_LIMITS.maxFramesPerWindow > DEFAULT_RELAY_LIMITS.maxFramesPerWindow,
  );
  assert.deepEqual(parseRelayLimits(DEFAULT_DAEMON_RELAY_LIMITS), DEFAULT_DAEMON_RELAY_LIMITS);
  const { maxFramesPerWindow: _omitted, ...missing } = DEFAULT_RELAY_LIMITS;
  assert.throws(
    () => parseRelayLimits(missing),
    (error) =>
      error instanceof ProtocolValidationError && error.path === "limits.maxFramesPerWindow",
  );
  assert.throws(
    () => parseRelayLimits({ ...DEFAULT_RELAY_LIMITS, rateWindowMs: 10 }),
    (error) => error instanceof ProtocolValidationError && error.path === "limits.rateWindowMs",
  );
});

test("validates and canonicalizes remote device scopes", () => {
  assert.deepEqual(parseRemoteDeviceScopes(["steer", "observe"]), ["observe", "steer"]);
  assert.throws(
    () => parseRemoteDeviceScopes(["observe", "observe"]),
    (error) => error instanceof ProtocolValidationError && error.path === "scopes",
  );
  assert.throws(
    () => parseRemoteDeviceScopes(["unsafe"]),
    (error) => error instanceof ProtocolValidationError && error.path === "scopes[0]",
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
    grantGeneration: 7,
    leaseExpiresAt: 2_000_000_000_000,
    limits: DEFAULT_RELAY_LIMITS,
  });
  assert.deepEqual(
    parseRelayRevocationNotification(internalFixtures.revocation.request),
    internalFixtures.revocation.request,
  );
});
