// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { type ModelPort, ToolRegistry } from "@axl/kernel";
import {
  type ModelStreamEvent,
  hashCanonicalRequest,
  parseDeviceId,
  parseInstallationId,
  parseOperationId,
  parseSessionId,
} from "@axl/protocol";

import { DeterministicFakeRemoteCryptoAdapter } from "../../protocol/test/support/fake-remote-crypto.ts";
import { CommandJournal, CommandJournalError } from "../src/command-journal.ts";
import { AxlDaemon } from "../src/daemon.ts";
import { RemoteAuthorityError, RemoteDeviceAuthorityStore } from "../src/remote-authority.ts";
import { remoteRpcMethods, requiredRemoteScope } from "../src/remote-rpc.ts";

const installationId = parseInstallationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const deviceId = parseDeviceId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const daemonEndpointId = parseDeviceId("cccccccc-cccc-4ccc-8ccc-cccccccccccc");

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "axl-remote-authority-"));
}

function replyPort(): ModelPort {
  return {
    stream() {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield {
          type: "completed",
          stopReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      })();
    },
  };
}

async function startDaemon(
  context: TestContext,
  securityMode: "sandboxed" | "unsafe" = "sandboxed",
) {
  const root = await directory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const cwd = await realpath(root);
  const dataDirectory = join(root, "data");
  const daemon = new AxlDaemon({
    socketPath: join(root, "daemon.sock"),
    dataDirectory,
    securityMode,
    sandboxProvider: "fixture",
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry(), system: "test" }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  return { daemon, dataDirectory, cwd };
}

test("remote RPC scope mapping is explicit and excludes dangerous surfaces", () => {
  assert.equal(requiredRemoteScope("daemon.info"), "observe");
  assert.equal(requiredRemoteScope("session.send"), "steer");
  assert.equal(requiredRemoteScope("session.shell"), undefined);
  assert.equal(requiredRemoteScope("session.interaction.respond"), undefined);
  assert.equal(requiredRemoteScope("provider.auth.login"), undefined);
  assert.ok(remoteRpcMethods().length > 0);
});

test("intersects local and hosted grants without allowing hosted widening", async () => {
  const dataDirectory = await directory();
  const store = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);

  await store.registerLocalDevice(deviceId, ["steer", "observe"]);
  assert.throws(
    () => store.authorize(deviceId, "observe"),
    (error) => error instanceof RemoteAuthorityError && error.code === "hosted_grant_missing",
  );

  const snapshot = await store.applyHostedGrant(deviceId, 1, [
    "manage_sessions",
    "observe",
    "steer",
  ]);
  assert.deepEqual(snapshot.effectiveScopes, ["observe", "steer"]);
  assert.deepEqual(store.authorize(deviceId, "steer"), {
    installationId,
    deviceId,
    localGrantGeneration: 1,
    hostedGrantGeneration: 1,
    effectiveScopes: ["observe", "steer"],
  });
  assert.throws(
    () => store.authorize(deviceId, "manage_sessions"),
    (error) => error instanceof RemoteAuthorityError && error.code === "scope_forbidden",
  );

  const narrowed = await store.narrowLocalGrant(deviceId, ["observe"]);
  assert.equal(narrowed.localGeneration, 2);
  assert.deepEqual(narrowed.effectiveScopes, ["observe"]);
  await assert.rejects(
    store.narrowLocalGrant(deviceId, ["observe", "steer"]),
    (error) => error instanceof RemoteAuthorityError && error.code === "grant_conflict",
  );

  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
});

test("serializes hosted generations and rejects stale or conflicting updates", async () => {
  const store = await RemoteDeviceAuthorityStore.open(await directory(), installationId);
  await store.registerLocalDevice(deviceId, ["observe", "steer"]);

  const competing = await Promise.allSettled([
    store.applyHostedGrant(deviceId, 1, ["observe"]),
    store.applyHostedGrant(deviceId, 1, ["steer"]),
  ]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = competing.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(rejected.reason instanceof RemoteAuthorityError);
  assert.equal(rejected.reason.code, "grant_conflict");

  await assert.rejects(
    store.applyHostedGrant(deviceId, 0, ["observe"]),
    /generation must be positive/,
  );

  await store.applyHostedGrant(deviceId, 2, ["observe", "steer"]);
  await assert.rejects(
    store.applyHostedGrant(deviceId, 1, ["observe"]),
    (error) => error instanceof RemoteAuthorityError && error.code === "stale_grant_generation",
  );
});

test("persists irreversible revocation and rechecks it after fake E2EE authentication", async () => {
  const dataDirectory = await directory();
  const store = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await store.registerLocalDevice(deviceId, ["observe", "steer"]);
  await store.applyHostedGrant(deviceId, 1, ["observe", "steer"]);

  const deviceCrypto = new DeterministicFakeRemoteCryptoAdapter(deviceId, daemonEndpointId);
  const daemonCrypto = new DeterministicFakeRemoteCryptoAdapter(daemonEndpointId, deviceId);
  const envelope = await deviceCrypto.seal(
    daemonEndpointId,
    new TextEncoder().encode('{"method":"test.ping"}'),
  );
  const authenticated = await daemonCrypto.open(envelope);
  assert.equal(authenticated.authenticatedDeviceId, deviceId);
  assert.equal(store.authorize(authenticated.authenticatedDeviceId, "steer").deviceId, deviceId);

  await store.revokeLocalDevice(deviceId, 1_900_000_000_000);
  assert.throws(
    () => store.authorize(authenticated.authenticatedDeviceId, "steer"),
    (error) => error instanceof RemoteAuthorityError && error.code === "device_revoked",
  );

  const restored = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  assert.equal(restored.snapshot(deviceId)?.locallyRevoked, true);
  assert.throws(
    () => restored.authorize(deviceId, "observe"),
    (error) => error instanceof RemoteAuthorityError && error.code === "device_revoked",
  );
  await assert.rejects(
    restored.registerLocalDevice(deviceId, ["observe", "steer"]),
    (error) => error instanceof RemoteAuthorityError && error.code === "grant_conflict",
  );
});

test("authorizes before applying durable command idempotency behind fake E2EE", async () => {
  const dataDirectory = await directory();
  const store = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await store.registerLocalDevice(deviceId, ["observe", "steer"]);
  await store.applyHostedGrant(deviceId, 1, ["observe", "steer"]);

  const deviceCrypto = new DeterministicFakeRemoteCryptoAdapter(deviceId, daemonEndpointId);
  const daemonCrypto = new DeterministicFakeRemoteCryptoAdapter(daemonEndpointId, deviceId);
  const sessionId = parseSessionId("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  const idempotencyKey = parseOperationId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  const params = { sessionId };
  const envelope = await deviceCrypto.seal(
    daemonEndpointId,
    new TextEncoder().encode(JSON.stringify({ method: "session.interrupt", params })),
  );
  const opened = await daemonCrypto.open(envelope);
  const journal = await CommandJournal.open(dataDirectory);
  let executions = 0;
  const execute = () =>
    store.runAuthorizedUntilAccepted(opened.authenticatedDeviceId, "steer", () =>
      journal.start(
        {
          idempotencyKey,
          method: "session.interrupt",
          requestHash: hashCanonicalRequest("session.interrupt", params),
          targetSessionId: sessionId,
        },
        async () => {
          executions += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { interrupted: false };
        },
      ),
    );

  assert.deepEqual(await Promise.all([execute(), execute()]), [
    { interrupted: false },
    { interrupted: false },
  ]);
  assert.equal(executions, 1);
  await assert.rejects(
    store.runAuthorizedUntilAccepted(opened.authenticatedDeviceId, "steer", () =>
      journal.start(
        {
          idempotencyKey,
          method: "session.interrupt",
          requestHash: hashCanonicalRequest("session.interrupt", {
            sessionId: parseSessionId("ffffffff-ffff-4fff-8fff-ffffffffffff"),
          }),
        },
        async () => ({ interrupted: false }),
      ),
    ),
    (error) => error instanceof CommandJournalError && error.code === "idempotency_conflict",
  );
});

test("revocation waits for durable acceptance but not operation completion", async () => {
  const dataDirectory = await directory();
  const store = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await store.registerLocalDevice(deviceId, ["steer"]);
  await store.applyHostedGrant(deviceId, 1, ["steer"]);
  const journal = await CommandJournal.open(dataDirectory);
  const sessionId = parseSessionId("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  const idempotencyKey = parseOperationId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;

  const completion = store
    .runAuthorizedUntilAccepted(deviceId, "steer", () =>
      journal.start(
        {
          idempotencyKey,
          method: "session.interrupt",
          requestHash: hashCanonicalRequest("session.interrupt", { sessionId }),
          targetSessionId: sessionId,
        },
        async () => {
          await hold;
          return { interrupted: false };
        },
      ),
    )
    .finally(() => {
      completed = true;
    });
  await store.revokeLocalDevice(deviceId, 1_900_000_000_000);
  assert.equal(completed, false);
  assert.throws(
    () => store.authorize(deviceId, "steer"),
    (error) => error instanceof RemoteAuthorityError && error.code === "device_revoked",
  );

  release();
  assert.deepEqual(await completion, { interrupted: false });
});

test("makes hosted revocation irreversible for one device identity", async () => {
  const store = await RemoteDeviceAuthorityStore.open(await directory(), installationId);
  await store.registerLocalDevice(deviceId, ["observe", "steer"]);
  await store.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
  await store.applyHostedGrant(deviceId, 2, ["observe", "steer"], 1_900_000_000_000);

  assert.throws(
    () => store.authorize(deviceId, "observe"),
    (error) => error instanceof RemoteAuthorityError && error.code === "device_revoked",
  );
  await assert.rejects(
    store.applyHostedGrant(deviceId, 3, ["observe", "steer"]),
    (error) => error instanceof RemoteAuthorityError && error.code === "grant_conflict",
  );
});

test("internal dispatcher enforces scope, method allowlist, identity, and active revocation", async (context) => {
  const { daemon, dataDirectory } = await startDaemon(context);
  const authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await authority.registerLocalDevice(deviceId, ["observe"]);
  await authority.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
  const deliveries: unknown[] = [];
  const attachment = daemon.attachAuthenticatedRemoteDevice({
    deviceId,
    authority,
    send: (message) => deliveries.push(message),
  });

  const info = await attachment.request({
    deviceId,
    requestId: "11111111-1111-4111-8111-111111111111",
    method: "daemon.info",
    params: {},
  });
  assert.equal(info.method, "daemon.info");
  assert.deepEqual(info.result, {
    securityMode: "sandboxed",
    sandboxProvider: "fixture",
  });
  assert.deepEqual(deliveries, []);

  await assert.rejects(
    attachment.request({
      deviceId,
      requestId: "22222222-2222-4222-8222-222222222222",
      method: "session.interrupt",
      params: { sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      idempotencyKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    }),
    (error) => error instanceof RemoteAuthorityError && error.code === "scope_forbidden",
  );
  await assert.rejects(
    attachment.request({
      deviceId,
      requestId: "33333333-3333-4333-8333-333333333333",
      method: "connection.ping",
      params: {},
    }),
    (error) => error instanceof RemoteAuthorityError && error.code === "remote_method_forbidden",
  );
  await assert.rejects(
    attachment.request({
      deviceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      requestId: "44444444-4444-4444-8444-444444444444",
      method: "daemon.info",
      params: {},
    }),
    (error) => error instanceof RemoteAuthorityError && error.code === "device_identity_mismatch",
  );

  await authority.revokeLocalDevice(deviceId);
  await assert.rejects(
    attachment.request({
      deviceId,
      requestId: "55555555-5555-4555-8555-555555555555",
      method: "daemon.info",
      params: {},
    }),
    (error) => error instanceof RemoteAuthorityError && error.code === "device_revoked",
  );
});

test("internal dispatcher rejects remote mutations in unsafe mode", async (context) => {
  const { daemon, dataDirectory } = await startDaemon(context, "unsafe");
  const authority = await RemoteDeviceAuthorityStore.open(dataDirectory, installationId);
  await authority.registerLocalDevice(deviceId, ["observe", "steer"]);
  await authority.applyHostedGrant(deviceId, 1, ["observe", "steer"]);
  const attachment = daemon.attachAuthenticatedRemoteDevice({
    deviceId,
    authority,
    send: () => undefined,
  });

  await assert.rejects(
    attachment.request({
      deviceId,
      requestId: "66666666-6666-4666-8666-666666666666",
      method: "session.interrupt",
      params: { sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      idempotencyKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    }),
    (error) => error instanceof RemoteAuthorityError && error.code === "unsafe_remote_forbidden",
  );
});

test("rejects an oversized authority store before parsing", async () => {
  const dataDirectory = await directory();
  await writeFile(join(dataDirectory, "remote-authority.json"), new Uint8Array(1024 * 1024 + 1));

  await assert.rejects(
    RemoteDeviceAuthorityStore.open(dataDirectory, installationId),
    /exceeds 1048576 bytes/,
  );
});

test("rejects a symlinked authority store", async () => {
  const dataDirectory = await directory();
  const target = join(dataDirectory, "outside.json");
  await writeFile(target, "{}\n");
  await symlink(target, join(dataDirectory, "remote-authority.json"));

  await assert.rejects(
    RemoteDeviceAuthorityStore.open(dataDirectory, installationId),
    /must be a regular file/,
  );
});
