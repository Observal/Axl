// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { claimRemoteAccess, RemoteAccessBusyError } from "../src/remote-claim.ts";

async function scratch(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "axl-remote-claim-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A claim file as another daemon process would leave it. */
async function foreign(path: string, pid: number, stateDirectory: string): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({ version: 1, token: "other", pid, stateDirectory })}\n`,
    { mode: 0o600 },
  );
}

test("a daemon claims remote access, and releasing it lets the next one in", async (context) => {
  const path = join(await scratch(context), "remote", "installation.lock");
  const claim = await claimRemoteAccess(path, "/home/user/.axl");
  const record = JSON.parse(await readFile(path, "utf8"));
  assert.equal(record.pid, process.pid);
  assert.equal(record.stateDirectory, "/home/user/.axl");
  await claim.release();
  await assert.rejects(readFile(path), { code: "ENOENT" });
  const next = await claimRemoteAccess(path, "/home/user/.axl/unsafe");
  await next.release();
});

test("a live daemon's claim refuses another, naming it", async (context) => {
  const path = join(await scratch(context), "installation.lock");
  const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
  context.after(() => owner.kill());
  await once(owner, "spawn");
  await foreign(path, owner.pid as number, "/home/user/.axl/unsafe");
  await assert.rejects(
    claimRemoteAccess(path, "/home/user/.axl"),
    (error) =>
      error instanceof RemoteAccessBusyError &&
      error.code === "remote_busy" &&
      error.pid === owner.pid &&
      error.message.includes("/home/user/.axl/unsafe"),
  );
});

test("a claim left by a daemon that exited is taken over", async (context) => {
  const path = join(await scratch(context), "installation.lock");
  const owner = spawn(process.execPath, ["-e", ""]);
  await once(owner, "exit");
  await foreign(path, owner.pid as number, "/home/user/.axl/unsafe");
  const claim = await claimRemoteAccess(path, "/home/user/.axl");
  assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
  await claim.release();
});

test("releasing never removes a claim another daemon took since", async (context) => {
  const path = join(await scratch(context), "installation.lock");
  const claim = await claimRemoteAccess(path, "/home/user/.axl");
  await foreign(path, 999_999, "/home/user/.axl/unsafe");
  await claim.release();
  assert.equal(JSON.parse(await readFile(path, "utf8")).token, "other");
});
