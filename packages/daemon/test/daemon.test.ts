// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { type ModelPort, ToolRegistry } from "@axl/kernel";
import type {
  CanonicalEvent,
  ModelStreamEvent,
  SessionActivityFrame,
  SessionForkResult,
  SessionHistoryPage,
  SessionSummary,
  Usage,
} from "@axl/protocol";
import {
  encodeWireMessage,
  parseEventId,
  parseServerMessage,
  parseSessionId,
  type ServerMessage,
  WIRE_PROTOCOL_VERSION,
  type WireRequest,
} from "@axl/protocol";

import {
  AxlDaemon,
  DaemonClient,
  type SessionSnapshot,
  WireClientError,
  type WireEvent,
} from "../src/index.ts";

const usage: Usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const execute = promisify(execFile);

function replyPort(): ModelPort {
  let calls = 0;
  return {
    stream(request) {
      calls += 1;
      const turn = calls;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (request.signal?.aborted) {
          yield { type: "aborted" };
          return;
        }
        yield { type: "text_delta", text: `reply ${turn}` };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
}

/** A port that streams nothing until aborted, for interruption tests. */
function hangingPort(): ModelPort {
  return {
    stream(request) {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        await new Promise<void>((resolvePromise) => {
          if (request.signal?.aborted) return resolvePromise();
          request.signal?.addEventListener("abort", () => resolvePromise(), { once: true });
        });
        yield { type: "aborted" };
      })();
    },
  };
}

async function startDaemon(
  context: TestContext,
  port: ModelPort = replyPort(),
  securityMode: "sandboxed" | "unsafe" = "sandboxed",
  sandboxProvider?: string,
  sandboxImage?: string,
): Promise<{ daemon: AxlDaemon; socketPath: string; dataDirectory: string; cwd: string }> {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    securityMode,
    ...(sandboxProvider === undefined ? {} : { sandboxProvider }),
    ...(sandboxImage === undefined ? {} : { sandboxImage }),
    runtime: () => ({ model: port, tools: new ToolRegistry(), system: "You are Axl." }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  return { daemon, socketPath, dataDirectory: join(directory, "data"), cwd: directory };
}

function types(events: readonly CanonicalEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

function rawConnection(socketPath: string): {
  readonly socket: Socket;
  readonly next: () => Promise<ServerMessage>;
  readonly send: (request: WireRequest) => void;
} {
  const socket = createConnection(socketPath);
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const queued: ServerMessage[] = [];
  const waiters: Array<(message: ServerMessage) => void> = [];
  socket.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = parseServerMessage(JSON.parse(line) as unknown);
      const waiter = waiters.shift();
      if (waiter === undefined) queued.push(message);
      else waiter(message);
    }
  });
  return {
    socket,
    next: () => {
      const message = queued.shift();
      return message === undefined
        ? new Promise((resolvePromise) => waiters.push(resolvePromise))
        : Promise.resolve(message);
    },
    send: (request) => socket.write(encodeWireMessage(request)),
  };
}

test("requires version-4 initialization before session access", async (context) => {
  const fixture = await startDaemon(context);
  const raw = rawConnection(fixture.socketPath);
  context.after(() => raw.socket.destroy());

  const hello = await raw.next();
  assert.equal(hello.kind, "hello");
  if (hello.kind !== "hello") return;
  assert.equal(hello.wireVersion, WIRE_PROTOCOL_VERSION);
  assert.equal(hello.limits.maxMessageBytes, 1_048_576);
  assert.equal(hello.limits.maxPendingRequests, 64);

  raw.send({ kind: "request", id: 0, method: "daemon.info", params: {} });
  const info = await raw.next();
  assert.equal(info.kind, "success");
  if (info.kind === "success" && info.method === "daemon.info") {
    assert.equal(info.result.securityMode, "sandboxed");
  }

  raw.send({ kind: "request", id: 1, method: "session.list", params: {} });
  const beforeInitialization = await raw.next();
  assert.equal(beforeInitialization.kind, "error");
  if (beforeInitialization.kind === "error") {
    assert.equal(beforeInitialization.method, "session.list");
    assert.deepEqual(beforeInitialization.error, {
      code: "connection_not_initialized",
      message: "Initialize the connection before accessing sessions",
      retryable: false,
    });
  }

  raw.send({
    kind: "request",
    id: 2,
    method: "connection.initialize",
    params: {
      client: { kind: "future_client", version: "9.1.0", instanceId: "fixture-client" },
      requestedCapabilities: ["session.create", "future.capability"],
    },
  });
  const initialized = await raw.next();
  assert.equal(initialized.kind, "success");
  if (initialized.kind === "success" && initialized.method === "connection.initialize") {
    assert.equal(initialized.result.daemonInstanceId, hello.daemonInstanceId);
    assert.equal(initialized.result.scope, "local_control");
    assert.deepEqual(initialized.result.grantedCapabilities, ["session.create"]);
  }

  raw.send({ kind: "request", id: 4, method: "session.list", params: {} });
  const unsupported = await raw.next();
  assert.equal(unsupported.kind, "error");
  if (unsupported.kind === "error") {
    assert.equal(unsupported.error.code, "unsupported_capability");
  }

  raw.send({
    kind: "request",
    id: 3,
    method: "connection.initialize",
    params: {
      client: { kind: "future_client", version: "9.1.0", instanceId: "fixture-client" },
      requestedCapabilities: [],
    },
  });
  const repeated = await raw.next();
  assert.equal(repeated.kind, "error");
  if (repeated.kind === "error") {
    assert.equal(repeated.error.code, "connection_already_initialized");
  }
});

test("reports the daemon security mode", async (context) => {
  const sandboxed = await startDaemon(context);
  const sandboxedClient = await DaemonClient.connect(sandboxed.socketPath, {
    identity: { kind: "future_client", version: "1.0.0", instanceId: "future-client-1" },
    requestedCapabilities: ["session.create", "future.capability"],
  });
  context.after(() => sandboxedClient.close());
  assert.equal(sandboxedClient.connection.wireVersion, WIRE_PROTOCOL_VERSION);
  assert.equal(sandboxedClient.connection.scope, "local_control");
  assert.deepEqual(sandboxedClient.connection.grantedCapabilities, ["session.create"]);
  assert.deepEqual(await sandboxedClient.request("connection.ping", {}), {});
  await assert.rejects(
    sandboxedClient.request("session.list", {}),
    (error) => error instanceof WireClientError && error.code === "unsupported_capability",
  );
  assert.deepEqual(await sandboxedClient.request("daemon.info", {}), {
    securityMode: "sandboxed",
    sandboxProvider: "unknown",
  });

  const unsafe = await startDaemon(context, replyPort(), "unsafe");
  const unsafeClient = await DaemonClient.connect(unsafe.socketPath);
  context.after(() => unsafeClient.close());
  assert.deepEqual(await unsafeClient.request("daemon.info", {}), {
    securityMode: "unsafe",
    sandboxProvider: "unknown",
  });

  const image = `example.invalid/image@sha256:${"a".repeat(64)}`;
  const oci = await startDaemon(context, replyPort(), "sandboxed", "podman", image);
  const ociClient = await DaemonClient.connect(oci.socketPath);
  context.after(() => ociClient.close());
  assert.deepEqual(await ociClient.request("daemon.info", {}), {
    securityMode: "sandboxed",
    sandboxProvider: "podman",
    sandboxImage: image,
  });
});

test("creates a session, streams the live tail, and answers sends", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  const client = await DaemonClient.connect(socketPath);
  context.after(() => client.close());

  const created = (await client.request("session.create", { cwd })) as SessionSnapshot;
  assert.equal(types(created.events)[0], "session.created");

  const pushed: WireEvent[] = [];
  client.onEvent((event) => pushed.push(event));
  const { snapshot } = (await client.request("session.subscribe", {
    sessionId: created.sessionId,
  })) as { snapshot: CanonicalEvent[] };
  assert.deepEqual(types(snapshot), ["session.created"]);

  const sent = (await client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "hello" }],
  })) as { stopReason: string };
  assert.equal(sent.stopReason, "stop");
  assert.deepEqual(
    pushed.map((event) => event.event.type),
    ["user.message", "assistant.message"],
  );
  assert.equal(pushed[0]?.sessionId, created.sessionId);
});

test("streams transient deltas and resumes the latest accumulated activity", async (context) => {
  let release = (): void => undefined;
  const streaming: ModelPort = {
    stream() {
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "thinking_delta", text: "checking " };
        yield { type: "text_delta", text: "x".repeat(65_535) };
        yield { type: "text_delta", text: "partial" };
        await new Promise<void>((resolvePromise) => {
          release = resolvePromise;
        });
        yield { type: "text_delta", text: " answer" };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const { socketPath, cwd } = await startDaemon(context, streaming);
  const first = await DaemonClient.connect(socketPath);
  const second = await DaemonClient.connect(socketPath);
  context.after(() => {
    first.close();
    second.close();
  });
  const created = (await first.request("session.create", { cwd })) as SessionSnapshot;
  const frames: string[] = [];
  first.onActivity((message) => frames.push(message.frame.type));
  await first.request("session.subscribe", { sessionId: created.sessionId });
  const sending = first.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "go" }],
  });
  for (let attempt = 0; frames.length < 3 && attempt < 100; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.deepEqual(frames, ["thinking_delta", "text_delta", "text_delta"]);
  const resumed = (await second.request("session.subscribe", {
    sessionId: created.sessionId,
  })) as { activity?: SessionActivityFrame };
  assert.equal(resumed.activity?.type, "snapshot");
  assert.ok(resumed.activity?.operationId);
  assert.equal(resumed.activity?.sequence, 3);
  assert.equal(resumed.activity?.type, "snapshot");
  if (resumed.activity?.type === "snapshot") {
    assert.equal(resumed.activity.text.length, 65_536);
    assert.equal(resumed.activity.text.endsWith("partial"), true);
    assert.equal(resumed.activity.thinking, "checking ");
    assert.deepEqual(resumed.activity.toolCalls, []);
  }
  release();
  await sending;
  assert.equal(frames.at(-1), "clear");
});

test("uploads image blobs in chunks without persisting bytes in JSONL", async (context) => {
  const { socketPath, cwd, dataDirectory } = await startDaemon(context);
  const orphanDirectory = join(dataDirectory, "blobs", "uploads");
  const orphan = join(orphanDirectory, "orphaned-upload");
  await mkdir(orphanDirectory, { recursive: true });
  await writeFile(orphan, "partial");
  const client = await DaemonClient.connect(socketPath);
  context.after(() => client.close());
  const created = (await client.request("session.create", { cwd })) as SessionSnapshot;
  const bytes = Buffer.alloc(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
  bytes.set(Buffer.from("IHDR"), 12);
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  const started = (await client.request("session.blob.start", {
    sessionId: created.sessionId,
    mediaType: "image/png",
    sizeBytes: bytes.length,
    name: "pixel.png",
  })) as { uploadId: string };
  await assert.rejects(readFile(orphan), { code: "ENOENT" });
  await client.request("session.blob.chunk", {
    sessionId: created.sessionId,
    uploadId: started.uploadId,
    offset: 0,
    data: bytes.toString("base64"),
  });
  const blob = (await client.request("session.blob.commit", {
    sessionId: created.sessionId,
    uploadId: started.uploadId,
  })) as { sha256: string; mediaType: string; sizeBytes: number; name: string };
  assert.equal(blob.mediaType, "image/png");
  await client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "blob", blob }],
  });
  const range = (await client.request("session.blob.read", {
    sessionId: created.sessionId,
    sha256: blob.sha256,
    offset: 0,
    length: bytes.length,
  })) as { data: string; eof: boolean };
  assert.deepEqual(Buffer.from(range.data, "base64"), bytes);
  assert.equal(range.eof, true);
  const log = await readFile(join(dataDirectory, "sessions", `${created.sessionId}.jsonl`), "utf8");
  assert.equal(log.includes(bytes.toString("base64")), false);
  assert.match(log, new RegExp(blob.sha256));

  const other = (await client.request("session.create", { cwd })) as SessionSnapshot;
  await assert.rejects(
    client.request("session.blob.read", {
      sessionId: other.sessionId,
      sha256: blob.sha256,
      offset: 0,
      length: bytes.length,
    }),
    (error) => error instanceof WireClientError && error.code === "blob_not_owned",
  );

  const invalid = Buffer.from("not an image");
  const rejected = (await client.request("session.blob.start", {
    sessionId: created.sessionId,
    mediaType: "image/png",
    sizeBytes: invalid.length,
  })) as { uploadId: string };
  await assert.rejects(
    client.request("session.blob.chunk", {
      sessionId: created.sessionId,
      uploadId: rejected.uploadId,
      offset: 1,
      data: invalid.toString("base64"),
    }),
    (error) => error instanceof WireClientError && error.code === "blob_offset_mismatch",
  );
  await client.request("session.blob.chunk", {
    sessionId: created.sessionId,
    uploadId: rejected.uploadId,
    offset: 0,
    data: invalid.toString("base64"),
  });
  await assert.rejects(
    client.request("session.blob.commit", {
      sessionId: created.sessionId,
      uploadId: rejected.uploadId,
    }),
    (error) => error instanceof WireClientError && error.code === "invalid_image",
  );

  const concurrent = (await client.request("session.blob.start", {
    sessionId: created.sessionId,
    mediaType: "application/octet-stream",
    sizeBytes: 6,
  })) as { uploadId: string };
  const writes = await Promise.allSettled([
    client.request("session.blob.chunk", {
      sessionId: created.sessionId,
      uploadId: concurrent.uploadId,
      offset: 0,
      data: Buffer.from("abc").toString("base64"),
    }),
    client.request("session.blob.chunk", {
      sessionId: created.sessionId,
      uploadId: concurrent.uploadId,
      offset: 0,
      data: Buffer.from("def").toString("base64"),
    }),
  ]);
  assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
  const rejectedWrite = writes.find((result) => result.status === "rejected");
  assert.ok(rejectedWrite?.status === "rejected");
  assert.equal(rejectedWrite.reason instanceof WireClientError, true);
  assert.equal((rejectedWrite.reason as WireClientError).code, "blob_offset_mismatch");
  await client.request("session.blob.chunk", {
    sessionId: created.sessionId,
    uploadId: concurrent.uploadId,
    offset: 3,
    data: Buffer.from("ghi").toString("base64"),
  });
  await client.request("session.blob.commit", {
    sessionId: created.sessionId,
    uploadId: concurrent.uploadId,
  });

  const starts = await Promise.allSettled(
    Array.from({ length: 17 }, () =>
      client.request("session.blob.start", {
        sessionId: created.sessionId,
        mediaType: "application/octet-stream",
        sizeBytes: 1,
      }),
    ),
  );
  assert.equal(starts.filter((result) => result.status === "fulfilled").length, 16);
  const rejectedStart = starts.find((result) => result.status === "rejected");
  assert.ok(rejectedStart?.status === "rejected");
  assert.equal(rejectedStart.reason instanceof WireClientError, true);
  assert.equal((rejectedStart.reason as WireClientError).code, "too_many_uploads");

  const active = starts.find(
    (result): result is PromiseFulfilledResult<{ uploadId: string; chunkBytes: number }> =>
      result.status === "fulfilled",
  );
  assert.ok(active);
  assert.deepEqual(
    await client.request("session.blob.abort", {
      sessionId: created.sessionId,
      uploadId: active.value.uploadId,
    }),
    { aborted: true },
  );
  assert.deepEqual(
    await client.request("session.blob.abort", {
      sessionId: created.sessionId,
      uploadId: active.value.uploadId,
    }),
    { aborted: false },
  );
  await client.request("session.blob.start", {
    sessionId: created.sessionId,
    mediaType: "application/octet-stream",
    sizeBytes: 1,
  });
});

test("a session survives daemon termination and resumes with full history", async (context) => {
  const first = await startDaemon(context);
  const client = await DaemonClient.connect(first.socketPath);
  const created = (await client.request("session.create", { cwd: first.cwd })) as SessionSnapshot;
  await client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "before restart" }],
  });
  client.close();
  await first.daemon.stop();

  // A new daemon over the same data directory owns the same sessions.
  const daemon = new AxlDaemon({
    socketPath: first.socketPath,
    dataDirectory: first.dataDirectory,
    runtime: ({ cwd }) => {
      assert.equal(cwd, first.cwd);
      return { model: replyPort(), tools: new ToolRegistry() };
    },
  });
  await daemon.start();
  context.after(() => daemon.stop());

  const reconnected = await DaemonClient.connect(first.socketPath);
  context.after(() => reconnected.close());
  const resumed = (await reconnected.request("session.resume", {
    sessionId: created.sessionId,
  })) as SessionSnapshot;
  assert.deepEqual(types(resumed.events), ["session.created", "user.message", "assistant.message"]);
  const bounded = (await reconnected.request("session.resume", {
    sessionId: created.sessionId,
    includeEvents: false,
  })) as SessionSnapshot;
  assert.deepEqual(bounded, { sessionId: created.sessionId, events: [] });

  const firstPage = (await reconnected.request("session.history", {
    sessionId: created.sessionId,
    limit: 2,
  })) as SessionHistoryPage;
  assert.deepEqual(types(firstPage.events), ["session.created", "user.message"]);
  assert.equal(firstPage.done, false);
  const firstPageCursor = firstPage.events.at(-1)?.id;
  assert.ok(firstPageCursor);
  const secondPage = (await reconnected.request("session.history", {
    sessionId: created.sessionId,
    afterEventId: firstPageCursor,
    limit: 2,
  })) as SessionHistoryPage;
  assert.deepEqual(types(secondPage.events), ["assistant.message"]);
  assert.equal(secondPage.done, true);
  await assert.rejects(
    reconnected.request("session.history", {
      sessionId: created.sessionId,
      afterEventId: parseEventId("00000000-0000-4000-8000-000000000099"),
    }),
    (error) => error instanceof WireClientError && error.code === "unknown_cursor",
  );

  const sent = (await reconnected.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "after restart" }],
  })) as { stopReason: string };
  assert.equal(sent.stopReason, "stop");
});

test("an exec profile survives daemon restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-profile-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const dataDirectory = join(directory, "data");
  const observed: Array<string | undefined> = [];
  const makeDaemon = (): AxlDaemon =>
    new AxlDaemon({
      socketPath,
      dataDirectory,
      runtime: ({ selection }) => {
        observed.push(selection.profile);
        return {
          model: replyPort(),
          tools: new ToolRegistry(),
          configProfile: { profile: selection.profile ?? "standard" },
        };
      },
    });

  const first = makeDaemon();
  await first.start();
  const client = await DaemonClient.connect(socketPath);
  const created = (await client.request("session.create", {
    cwd: directory,
    profile: "exec",
  })) as SessionSnapshot;
  client.close();
  await first.stop();

  const second = makeDaemon();
  await second.start();
  context.after(() => second.stop());
  const resumedClient = await DaemonClient.connect(socketPath);
  context.after(() => resumedClient.close());
  const resumed = (await resumedClient.request("session.resume", {
    sessionId: created.sessionId,
  })) as SessionSnapshot;

  assert.deepEqual(observed, ["exec", "exec"]);
  assert.equal(
    resumed.events
      .flatMap((event) => (event.type === "config.profile" ? [event.payload.profile] : []))
      .at(-1),
    "exec",
  );
});

test("serves bounded working and last-turn workspace diffs", async (context) => {
  const fixture = await startDaemon(context);
  const workspace = join(fixture.cwd, "workspace");
  await mkdir(workspace);
  await execute("git", ["init", "--quiet"], { cwd: workspace });
  await execute("git", ["config", "user.name", "Axl Test"], { cwd: workspace });
  await execute("git", ["config", "user.email", "axl@example.invalid"], { cwd: workspace });
  const textconvMarker = join(fixture.cwd, "textconv-ran");
  const textconvHelper = join(fixture.cwd, "textconv.cjs");
  await writeFile(
    textconvHelper,
    `require("node:fs").writeFileSync(${JSON.stringify(textconvMarker)}, "ran");\n`,
  );
  const textconvCommand = `"${process.execPath.replaceAll("\\", "/")}" "${textconvHelper.replaceAll("\\", "/")}"`;
  await execute("git", ["config", "diff.axl.textconv", textconvCommand], { cwd: workspace });
  await writeFile(join(workspace, ".gitattributes"), "tracked.txt diff=axl\n");
  await writeFile(join(workspace, "tracked.txt"), "before\n");
  await execute("git", ["add", ".gitattributes", "tracked.txt"], { cwd: workspace });
  await execute("git", ["commit", "--quiet", "-m", "fixture"], { cwd: workspace });

  const client = await DaemonClient.connect(fixture.socketPath);
  context.after(() => client.close());
  const created = (await client.request("session.create", { cwd: workspace })) as SessionSnapshot;
  await assert.rejects(
    client.request("session.workspace.diff", {
      sessionId: created.sessionId,
      scope: "last-turn",
    }),
    (error) => error instanceof WireClientError && error.code === "checkpoint_unavailable",
  );
  await client.request("session.workspace.checkpoint", {
    sessionId: created.sessionId,
    enabled: true,
  });
  await client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "checkpoint" }],
  });
  await writeFile(join(workspace, "tracked.txt"), "after\n");
  await writeFile(join(workspace, "new.txt"), "new\n");

  const lastTurn = (await client.request("session.workspace.diff", {
    sessionId: created.sessionId,
    scope: "last-turn",
  })) as { files: readonly { path: string; status: string; additions: number }[] };
  assert.deepEqual(
    lastTurn.files.map((file) => [file.path, file.status, file.additions]),
    [
      ["new.txt", "added", 1],
      ["tracked.txt", "modified", 1],
    ],
  );

  const previousGitDirectory = process.env.GIT_DIR;
  process.env.GIT_DIR = join(workspace, "attacker-controlled-git-directory");
  let working: { files: readonly { path: string }[] };
  try {
    working = (await client.request("session.workspace.diff", {
      sessionId: created.sessionId,
      scope: "working",
    })) as { files: readonly { path: string }[] };
  } finally {
    if (previousGitDirectory === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDirectory;
  }
  assert.deepEqual(
    working.files.map((file) => file.path),
    ["new.txt", "tracked.txt"],
  );
  await assert.rejects(readFile(textconvMarker), { code: "ENOENT" });

  const oversized = join(workspace, "too-large.bin");
  await writeFile(oversized, "");
  await truncate(oversized, 256 * 1024 * 1024 + 1);
  await client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "bounded checkpoint" }],
  });
  await assert.rejects(
    client.request("session.workspace.diff", {
      sessionId: created.sessionId,
      scope: "last-turn",
    }),
    (error) => error instanceof WireClientError && error.code === "checkpoint_too_large",
  );
});

test("lists, forks, clones, and resumes sessions", async (context) => {
  const first = await startDaemon(context);
  const client = await DaemonClient.connect(first.socketPath);
  const created = (await client.request("session.create", { cwd: first.cwd })) as SessionSnapshot;
  await client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "first prompt" }],
  });
  await client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "second prompt" }],
  });

  const listed = (await client.request("session.list", {})) as SessionSummary[];
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.cwd, first.cwd);
  assert.equal(listed[0]?.userMessageCount, 2);
  assert.equal(listed[0]?.firstUserMessage, "first prompt");
  assert.equal(listed[0]?.lastUserMessage, "second prompt");

  const source = (await client.request("session.resume", {
    sessionId: created.sessionId,
  })) as SessionSnapshot;
  const secondMessage = source.events.filter((event) => event.type === "user.message")[1];
  assert.ok(secondMessage);
  const forked = (await client.request("session.fork", {
    sessionId: created.sessionId,
    fromEventId: secondMessage.id,
  })) as SessionForkResult;
  assert.equal(forked.selectedText, "second prompt");
  assert.equal(forked.events[0]?.type, "session.created");
  assert.equal(
    forked.events[0]?.type === "session.created" && forked.events[0].payload.parentSessionId,
    created.sessionId,
  );
  assert.deepEqual(
    forked.events
      .filter((event) => event.type === "user.message")
      .map((event) => {
        const content = event.type === "user.message" ? event.payload.content[0] : undefined;
        return content?.type === "text" ? content.text : undefined;
      }),
    ["first prompt"],
  );

  const cloned = (await client.request("session.clone", {
    sessionId: created.sessionId,
  })) as SessionForkResult;
  assert.deepEqual(
    cloned.events
      .filter((event) => event.type === "user.message")
      .map((event) => {
        const content = event.type === "user.message" ? event.payload.content[0] : undefined;
        return content?.type === "text" ? content.text : undefined;
      }),
    ["first prompt", "second prompt"],
  );

  client.close();
  await first.daemon.stop();
  const daemon = new AxlDaemon({
    socketPath: first.socketPath,
    dataDirectory: first.dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const resumedClient = await DaemonClient.connect(first.socketPath);
  context.after(() => resumedClient.close());
  const resumedFork = (await resumedClient.request("session.resume", {
    sessionId: forked.sessionId,
  })) as SessionSnapshot;
  const resumedClone = (await resumedClient.request("session.resume", {
    sessionId: cloned.sessionId,
  })) as SessionSnapshot;
  assert.equal(resumedFork.events[0]?.type, "session.created");
  assert.equal(resumedClone.events[0]?.type, "session.created");
});

test("interrupt aborts the active operation from another connection", async (context) => {
  const { socketPath, cwd } = await startDaemon(context, hangingPort());
  const sender = await DaemonClient.connect(socketPath);
  const interrupter = await DaemonClient.connect(socketPath);
  context.after(() => {
    sender.close();
    interrupter.close();
  });

  const created = (await sender.request("session.create", { cwd })) as SessionSnapshot;
  const sending = sender.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "hang" }],
  });

  // Wait until the operation is active, then interrupt from the other client.
  for (;;) {
    const { interrupted } = (await interrupter.request("session.interrupt", {
      sessionId: created.sessionId,
    })) as { interrupted: boolean };
    if (interrupted) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  const result = (await sending) as { stopReason: string };
  assert.equal(result.stopReason, "aborted");

  const idle = (await interrupter.request("session.interrupt", {
    sessionId: created.sessionId,
  })) as { interrupted: boolean };
  assert.equal(idle.interrupted, false);
});

test("a queued follow-up continues after the current model call is interrupted", async (context) => {
  let calls = 0;
  const prompts: string[] = [];
  const model: ModelPort = {
    stream(request) {
      calls += 1;
      const call = calls;
      const lastUser = request.messages.findLast((message) => message.role === "user");
      prompts.push(lastUser?.content[0]?.type === "text" ? lastUser.content[0].text : "<missing>");
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (call === 1) {
          await new Promise<void>((resolvePromise) => {
            if (request.signal?.aborted) resolvePromise();
            else request.signal?.addEventListener("abort", () => resolvePromise(), { once: true });
          });
          yield { type: "aborted" };
          return;
        }
        yield { type: "text_delta", text: "follow-up answer" };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const { socketPath, cwd } = await startDaemon(context, model);
  const sender = await DaemonClient.connect(socketPath);
  const controller = await DaemonClient.connect(socketPath);
  context.after(() => {
    sender.close();
    controller.close();
  });
  const created = (await sender.request("session.create", { cwd })) as SessionSnapshot;
  const sending = sender.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "start" }],
  });
  while (calls === 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  await controller.request("session.followUp", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "continue afterward" }],
  });
  await controller.request("session.interrupt", { sessionId: created.sessionId });

  assert.deepEqual(await sending, { stopReason: "stop" });
  assert.deepEqual(prompts, ["start", "continue afterward"]);
});

test("concurrent sends conflict loudly instead of interleaving", async (context) => {
  const { socketPath, cwd } = await startDaemon(context, hangingPort());
  const client = await DaemonClient.connect(socketPath);
  context.after(() => client.close());

  const created = (await client.request("session.create", { cwd })) as SessionSnapshot;
  const first = client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "one" }],
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  await assert.rejects(
    client.request("session.send", {
      sessionId: created.sessionId,
      content: [{ type: "text", text: "two" }],
    }),
    (error) => error instanceof WireClientError && error.code === "operation_active",
  );
  await client.request("session.interrupt", { sessionId: created.sessionId });
  await first;
});

test("steering and follow-ups cross clients through the daemon", async (context) => {
  let releaseFirst = (): void => undefined;
  context.after(() => releaseFirst());
  let calls = 0;
  const prompts: string[] = [];
  const model: ModelPort = {
    stream(request) {
      calls += 1;
      const call = calls;
      const lastUser = request.messages.findLast((message) => message.role === "user");
      prompts.push(lastUser?.content[0]?.type === "text" ? lastUser.content[0].text : "<missing>");
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (call === 1) {
          await new Promise<void>((resolvePromise) => {
            releaseFirst = resolvePromise;
          });
        }
        yield { type: "text_delta", text: `reply ${call}` };
        yield { type: "completed", stopReason: "stop", usage };
      })();
    },
  };
  const { socketPath, cwd } = await startDaemon(context, model);
  const sender = await DaemonClient.connect(socketPath);
  const controller = await DaemonClient.connect(socketPath);
  context.after(() => {
    sender.close();
    controller.close();
  });
  const created = (await sender.request("session.create", { cwd })) as SessionSnapshot;
  const sending = sender.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "start" }],
  });
  while (calls === 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));

  assert.deepEqual(
    await controller.request("session.steer", {
      sessionId: created.sessionId,
      content: [{ type: "text", text: "adjust" }],
    }),
    { queued: true },
  );
  await controller.request("session.followUp", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "then summarize" }],
  });
  await controller.request("session.followUp", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "then verify" }],
  });
  releaseFirst();
  await sending;

  assert.deepEqual(prompts, ["start", "adjust", "then summarize", "then verify"]);
  const history = (await controller.request("session.resume", {
    sessionId: created.sessionId,
  })) as SessionSnapshot;
  assert.deepEqual(
    history.events
      .filter((event) => event.type === "user.message")
      .map((event) =>
        event.type === "user.message" && event.payload.content[0]?.type === "text"
          ? event.payload.content[0].text
          : undefined,
      ),
    prompts,
  );
  await assert.rejects(
    controller.request("session.steer", {
      sessionId: created.sessionId,
      content: [{ type: "text", text: "too late" }],
    }),
    (error) => error instanceof WireClientError && error.code === "operation_inactive",
  );
});

test("subscribe supports an afterEventId cursor and multiple attached clients", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  const one = await DaemonClient.connect(socketPath);
  const two = await DaemonClient.connect(socketPath);
  context.after(() => {
    one.close();
    two.close();
  });

  const created = (await one.request("session.create", { cwd })) as SessionSnapshot;
  await one.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "first" }],
  });

  const cursor = created.events[0]?.id;
  const { snapshot } = (await two.request("session.subscribe", {
    sessionId: created.sessionId,
    ...(cursor === undefined ? {} : { afterEventId: cursor }),
  })) as { snapshot: CanonicalEvent[] };
  assert.deepEqual(types(snapshot), ["user.message", "assistant.message"]);

  const oneEvents: string[] = [];
  const twoEvents: string[] = [];
  one.onEvent((event) => oneEvents.push(event.event.type));
  two.onEvent((event) => twoEvents.push(event.event.type));
  await one.request("session.subscribe", { sessionId: created.sessionId });
  await one.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "second" }],
  });
  assert.deepEqual(oneEvents, ["user.message", "assistant.message"]);
  assert.deepEqual(twoEvents, ["user.message", "assistant.message"]);

  await assert.rejects(
    two.request("session.subscribe", {
      sessionId: created.sessionId,
      afterEventId: parseEventId("00000000-0000-4000-8000-00000000dead"),
    }),
    (error) => error instanceof WireClientError && error.code === "unknown_cursor",
  );
});

test("dispose removes the session and errors surface typed codes", async (context) => {
  const { socketPath, cwd } = await startDaemon(context);
  const client = await DaemonClient.connect(socketPath);
  context.after(() => client.close());

  const created = (await client.request("session.create", { cwd })) as SessionSnapshot;
  await client.request("session.dispose", { sessionId: created.sessionId });
  await assert.rejects(
    client.request("session.send", { sessionId: created.sessionId, content: [] }),
    (error) => error instanceof WireClientError && error.code === "unknown_session",
  );

  await assert.rejects(
    client.request("session.resume", {
      sessionId: parseSessionId("123e4567-e89b-42d3-a456-42661417ffff"),
    }),
    (error) => error instanceof WireClientError && error.code === "unknown_session",
  );

  await assert.rejects(
    (
      client.request as unknown as (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>
    )("bogus.method", {}),
    (error) => error instanceof WireClientError && error.code === "bad_request",
  );
});

test("refuses to unlink a live daemon socket or a regular file", async (context) => {
  const first = await startDaemon(context);
  const competing = new AxlDaemon({
    socketPath: first.socketPath,
    dataDirectory: first.dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await assert.rejects(competing.start(), /already listening/);

  const regularPath = join(first.cwd, "not-a-socket");
  await writeFile(regularPath, "keep me");
  const regular = new AxlDaemon({
    socketPath: regularPath,
    dataDirectory: first.dataDirectory,
    runtime: () => ({ model: replyPort(), tools: new ToolRegistry() }),
  });
  await assert.rejects(regular.start(), /Refusing to remove non-socket/);
});

test("routes runtime interaction requests to an attached client", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  let call = 0;
  const model: ModelPort = {
    stream() {
      call += 1;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (call === 1) {
          yield { type: "tool_call", callId: "approval-1", name: "approve", input: {} };
          yield { type: "completed", stopReason: "tool_use", usage };
        } else {
          yield { type: "text_delta", text: "approved" };
          yield { type: "completed", stopReason: "stop", usage };
        }
      })();
    },
  };
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    runtime: ({ interact }) => {
      const tools = new ToolRegistry();
      tools.register({
        name: "approve",
        description: "Ask for approval",
        inputSchema: { type: "object" },
        async execute(_input, signal) {
          const response = await interact(
            {
              kind: "mcp_tool",
              source: "mcp:test",
              message: "Allow test tool?",
            },
            signal,
          );
          return {
            content: [{ type: "text", text: response.action }],
            isError: response.action !== "accept",
          };
        },
      });
      return { model, tools };
    },
  });
  await daemon.start();
  context.after(() => daemon.stop());
  const client = await DaemonClient.connect(socketPath);
  context.after(() => client.close());
  const created = (await client.request("session.create", { cwd: directory })) as SessionSnapshot;
  const events: CanonicalEvent[] = [];
  client.onEvent((message) => events.push(message.event));
  await client.request("session.subscribe", { sessionId: created.sessionId });
  const sending = client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "ask" }],
  });

  let interaction: Extract<CanonicalEvent, { type: "interaction.requested" }> | undefined;
  for (let attempt = 0; attempt < 100 && !interaction; attempt += 1) {
    interaction = events.find(
      (event): event is Extract<CanonicalEvent, { type: "interaction.requested" }> =>
        event.type === "interaction.requested",
    );
    if (!interaction) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.ok(interaction);
  await client.request("session.interaction.respond", {
    sessionId: created.sessionId,
    interactionId: interaction.payload.interactionId,
    action: "accept",
  });
  await sending;
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("interaction.")).map((event) => event.type),
    ["interaction.requested", "interaction.resolved"],
  );
});

test("configuration changes preserve the selected profile", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const configured: Array<{
    boundary: string;
    model?: string;
    thinking?: string;
    profile?: string;
    webFetch?: boolean;
    webSearch?: boolean;
  }> = [];
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    runtime: ({ boundary, selection }) => {
      configured.push({
        boundary,
        ...(selection.modelId === undefined ? {} : { model: selection.modelId }),
        ...(selection.thinkingLevel === undefined ? {} : { thinking: selection.thinkingLevel }),
        ...(selection.profile === undefined ? {} : { profile: selection.profile }),
        ...(selection.webFetch === undefined ? {} : { webFetch: selection.webFetch }),
        ...(selection.webSearch === undefined ? {} : { webSearch: selection.webSearch }),
      });
      return {
        model: replyPort(),
        tools: new ToolRegistry(),
        ...(selection.modelId === undefined ? {} : { configModel: { modelId: selection.modelId } }),
        ...(selection.thinkingLevel === undefined
          ? {}
          : {
              configThinking: {
                requested: selection.thinkingLevel,
                effective: selection.thinkingLevel,
                clamped: false,
              },
            }),
        ...(selection.profile === undefined
          ? {}
          : { configProfile: { profile: selection.profile } }),
        ...(selection.webFetch === undefined || selection.webSearch === undefined
          ? {}
          : {
              configTools: {
                webFetch: selection.webFetch,
                webSearch: selection.webSearch,
              },
            }),
      };
    },
  });
  await daemon.start();
  context.after(() => daemon.stop());

  const client = await DaemonClient.connect(socketPath);
  context.after(() => client.close());
  const created = (await client.request("session.create", {
    cwd: directory,
    modelId: "gpt-5",
    thinkingLevel: "medium",
    profile: "exec",
    webFetch: true,
    webSearch: true,
  })) as SessionSnapshot;
  const changed = (await client.request("session.configure", {
    sessionId: created.sessionId,
    modelId: "gpt-4.1",
    thinkingLevel: "high",
  })) as { events: CanonicalEvent[] };

  const toolsChanged = (await client.request("session.configure", {
    sessionId: created.sessionId,
    webSearch: false,
  })) as { events: CanonicalEvent[] };

  assert.deepEqual(configured, [
    {
      boundary: "session_start",
      model: "gpt-5",
      thinking: "medium",
      profile: "exec",
      webFetch: true,
      webSearch: true,
    },
    {
      boundary: "model_switch",
      model: "gpt-4.1",
      thinking: "high",
      profile: "exec",
      webFetch: true,
      webSearch: true,
    },
    {
      boundary: "tool_change",
      model: "gpt-4.1",
      thinking: "high",
      profile: "exec",
      webFetch: true,
      webSearch: false,
    },
  ]);
  assert.deepEqual(types(changed.events), [
    "config.model",
    "config.thinking",
    "config.profile",
    "config.tools",
  ]);
  assert.deepEqual(types(toolsChanged.events), [
    "config.model",
    "config.thinking",
    "config.profile",
    "config.tools",
  ]);
});

test("reload rebuilds the runtime as a logged boundary with live subscriptions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "axl-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const boundaries: string[] = [];
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    runtime: ({ boundary }) => {
      boundaries.push(boundary);
      return {
        model: replyPort(),
        tools: new ToolRegistry(),
        ...(boundary === "config_change"
          ? {}
          : {
              configDialect: {
                dialectId: "generic" as const,
                rosterFingerprint: "f".repeat(64),
                reason: boundary,
              },
            }),
      };
    },
  });
  await daemon.start();
  context.after(() => daemon.stop());

  const client = await DaemonClient.connect(socketPath);
  context.after(() => client.close());
  const created = (await client.request("session.create", { cwd: directory })) as SessionSnapshot;
  const pushed: string[] = [];
  client.onEvent((message) => pushed.push(message.event.type));
  await client.request("session.subscribe", { sessionId: created.sessionId });

  const reloaded = (await client.request("session.reload", { sessionId: created.sessionId })) as {
    events: CanonicalEvent[];
  };
  assert.deepEqual(boundaries, ["session_start", "reload"]);
  const dialect = reloaded.events.find((event) => event.type === "config.dialect");
  assert.equal(dialect?.type === "config.dialect" && dialect.payload.reason, "reload");
  assert.equal(pushed.includes("config.dialect"), true); // streamed to subscribers

  // The session still works after the reload, on the same log.
  const sent = (await client.request("session.send", {
    sessionId: created.sessionId,
    content: [{ type: "text", text: "after reload" }],
  })) as { stopReason: string };
  assert.equal(sent.stopReason, "stop");
});
