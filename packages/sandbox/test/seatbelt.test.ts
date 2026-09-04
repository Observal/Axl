// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { WorkspacePolicy } from "@axl/kernel";

import {
  buildSeatbeltArgv,
  buildSeatbeltProcess,
  buildSeatbeltProfile,
  detectPlatformSandbox,
  detectSeatbelt,
  makeSeatbeltShellTool,
  SandboxUnavailableError,
  SEATBELT_CONTROLS,
  seatbeltConfiguredPayload,
} from "../src/index.ts";

const policy: WorkspacePolicy = {
  workspace: "/Users/dev/repo",
  readableRoots: ["/Users/dev/repo"],
  protectedPaths: ["/Users/dev/.axl"],
};

test("the profile allows by default and denies network, writes, and protected paths", () => {
  const profile = buildSeatbeltProfile(policy);
  const lines = profile.split("\n");
  assert.equal(lines[0], "(version 1)");
  assert.equal(lines[1], "(allow default)");
  assert.equal(lines[2], "(deny network*)");
  assert.equal(lines[3], "(deny file-write*)");
  assert.match(lines[4] ?? "", /^\(allow file-write\* \(subpath "\/Users\/dev\/repo"\)/);
  assert.match(lines[4] ?? "", /"\/private\/tmp"/);
  // Protected denies come last, so nothing re-allows them.
  assert.equal(lines[5], '(deny file-write* (subpath "/Users/dev/.axl"))');
  assert.equal(lines[6], '(deny file-read* (subpath "/Users/dev/.axl"))');
});

test("profile paths with quotes and backslashes are escaped", () => {
  const tricky = buildSeatbeltProfile({
    workspace: '/Users/we"ird\\path',
    readableRoots: ['/Users/we"ird\\path'],
    protectedPaths: [],
  });
  assert.match(tricky, /\(subpath "\/Users\/we\\"ird\\\\path"\)/);
});

test("the argv confines through sandbox-exec and rebuilds env from the allowlist", () => {
  const argv = buildSeatbeltArgv(policy, "echo hi", {
    PATH: "/usr/bin",
    HOME: "/Users/dev",
    AZURE_OPENAI_API_KEY: "leak-me-not",
  });
  assert.equal(argv[0], "sandbox-exec");
  assert.equal(argv[1], "-p");
  assert.match(argv[2] ?? "", /\(deny network\*\)/);
  const envIndex = argv.indexOf("/usr/bin/env");
  assert.equal(argv[envIndex + 1], "-i");
  assert.deepEqual(argv.slice(-3), ["bash", "-c", "echo hi"]);
  assert.equal(
    argv.some((part) => part.includes("leak-me-not")),
    false,
  );
  assert.equal(argv.includes("PATH=/usr/bin"), true);
});

test("wraps extension processes without exposing environment values in argv", () => {
  const process = buildSeatbeltProcess(policy, "node", ["server.mjs"], policy.workspace, {
    PATH: "/usr/bin",
    MCP_TOKEN: "secret",
  });
  assert.equal(process.command, "sandbox-exec");
  assert.deepEqual(process.args.slice(-2), ["node", "server.mjs"]);
  assert.deepEqual(process.env, { PATH: "/usr/bin", MCP_TOKEN: "secret" });
  assert.equal(process.args.includes("secret"), false);
});

test("failIfUnavailable: constructing the tool without seatbelt throws", () => {
  assert.throws(
    () =>
      makeSeatbeltShellTool({
        cwd: "/repo",
        overflowDirectory: "/tmp/overflow",
        policy,
        capabilities: { available: false, reason: "Seatbelt requires macOS, not linux" },
      }),
    SandboxUnavailableError,
  );
});

test("the configured payload reports controls honestly, without namespaces", () => {
  const enforced = seatbeltConfiguredPayload({ available: true });
  assert.equal(enforced.provider, "seatbelt");
  assert.deepEqual(enforced.controls, [...SEATBELT_CONTROLS]);
  assert.equal(enforced.controls.includes("process.namespaces"), false);
  assert.deepEqual(seatbeltConfiguredPayload({ available: false, reason: "x" }), {
    provider: "seatbelt",
    enforced: false,
    controls: [],
  });
});

test("detection refuses non-macOS hosts with the platform named", async () => {
  if (process.platform === "darwin") return;
  const capabilities = await detectSeatbelt();
  assert.equal(capabilities.available, false);
  assert.match(capabilities.reason ?? "", /requires macOS/);
});

test("the platform selector picks the host's provider", async () => {
  const sandbox = await detectPlatformSandbox();
  if (process.platform === "linux") assert.equal(sandbox.provider, "bubblewrap");
  else if (process.platform === "darwin") assert.equal(sandbox.provider, "seatbelt");
  else assert.equal(sandbox.provider, "none");
  const payload = sandbox.configuredPayload();
  assert.equal(payload.enforced, sandbox.available);
});

// Real-confinement integration tests; they run only on a Mac with sandbox-exec.
const darwin = await detectSeatbelt();
const integration = { skip: darwin.available ? false : "seatbelt unavailable on this host" };

async function makeLayout(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "axl-seatbelt-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const axlHome = join(root, "axl-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(axlHome, { recursive: true });
  await writeFile(join(axlHome, "credentials.json"), '{"secret":"topsecret"}\n');
  const tool = makeSeatbeltShellTool({
    cwd: workspace,
    overflowDirectory: join(root, "overflow"),
    policy: { workspace, readableRoots: [workspace], protectedPaths: [axlHome] },
    capabilities: darwin,
  });
  return { root, workspace, axlHome, tool };
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
}

test("seatbelt: workspace writes work, outside writes fail", integration, async (context) => {
  const { workspace, tool } = await makeLayout(context);
  const signal = new AbortController().signal;
  const ok = await tool.execute({ command: "echo made > made.txt && cat made.txt" }, signal);
  assert.equal(ok.isError, false);
  assert.equal(await readFile(join(workspace, "made.txt"), "utf8"), "made\n");

  const denied = await tool.execute({ command: "touch /usr/local/seatbelt-probe" }, signal);
  assert.equal(denied.isError, true);
});

test(
  "seatbelt: protected paths are unreadable and network is denied",
  integration,
  async (context) => {
    const { axlHome, tool } = await makeLayout(context);
    const signal = new AbortController().signal;
    const secret = await tool.execute(
      { command: `cat ${join(axlHome, "credentials.json")} || true` },
      signal,
    );
    assert.equal(text(secret).includes("topsecret"), false);

    const network = await tool.execute(
      { command: "(exec 3<>/dev/tcp/127.0.0.1/1 && echo CONNECTED) 2>&1 || true" },
      signal,
    );
    assert.equal(text(network).includes("CONNECTED"), false);
  },
);
