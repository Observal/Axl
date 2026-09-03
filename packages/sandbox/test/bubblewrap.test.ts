// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { WorkspacePolicy } from "@axl/kernel";

import {
  BUBBLEWRAP_CONTROLS,
  bubblewrapConfiguredPayload,
  buildBubblewrapArgv,
  buildBubblewrapProcess,
  createUnsafePlatformExecution,
  detectBubblewrap,
  makeBubblewrapShellTool,
  SandboxUnavailableError,
} from "../src/index.ts";

const capabilities = await detectBubblewrap();
const integration = {
  skip: capabilities.available ? false : "bubblewrap unavailable on this host",
};
const noSignal = new AbortController().signal;

async function makeLayout(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "axl-bwrap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const axlHome = join(root, "axl-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(axlHome, { recursive: true });
  await writeFile(join(axlHome, "credentials.json"), '{"secret":"topsecret"}\n');
  await writeFile(join(root, "outside.txt"), "outside\n");
  const policy: WorkspacePolicy = {
    workspace,
    readableRoots: [workspace],
    protectedPaths: [axlHome],
  };
  const tool = makeBubblewrapShellTool({
    cwd: workspace,
    overflowDirectory: join(root, "overflow"),
    policy,
    capabilities,
  });
  return { root, workspace, axlHome, policy, tool };
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
}

test("builds the confinement argv: namespaces, masks, cleared environment", () => {
  const policy: WorkspacePolicy = {
    workspace: "/repo",
    readableRoots: ["/repo"],
    protectedPaths: ["/home/user/.axl"],
  };
  const argv = buildBubblewrapArgv(
    policy,
    "echo hi",
    "/repo",
    {
      PATH: "/usr/bin",
      HOME: "/home/user",
    },
    "/test/landlock-run",
    "/test/seccomp.bpf",
  );
  assert.equal(argv[0], "/bin/sh");
  assert.equal(argv.includes("bwrap"), true);
  assert.equal(argv.includes("--seccomp"), true);
  assert.equal(argv.includes("/test/seccomp.bpf"), true);
  assert.equal(argv.includes("--unshare-all"), true);
  assert.equal(argv.includes("--die-with-parent"), true);
  assert.equal(argv.includes("--clearenv"), true);
  const homeMask = argv.findIndex(
    (part, index) => part === "--tmpfs" && argv[index + 1] === "/home/user",
  );
  assert.equal(homeMask >= 0, true);
  assert.equal(homeMask < argv.indexOf("--bind"), true);
  assert.deepEqual(argv.slice(argv.indexOf("--bind"), argv.indexOf("--bind") + 3), [
    "--bind",
    "/repo",
    "/repo",
  ]);
  const maskIndex = argv.indexOf("--tmpfs", argv.indexOf("--bind"));
  assert.deepEqual(argv.slice(maskIndex, maskIndex + 2), ["--tmpfs", "/home/user/.axl"]);
  assert.equal(argv.includes("/run/axl/landlock-run"), true);
  assert.equal(argv.includes("/test/landlock-run"), true);
  assert.deepEqual(argv.slice(-3), ["bash", "-c", "echo hi"]);
  // No environment value leaks without an allowlist entry.
  assert.equal(argv.includes("AZURE_OPENAI_API_KEY"), false);
});

test("wraps long-lived processes with fixed seccomp arguments and no interpolation", () => {
  const policy: WorkspacePolicy = {
    workspace: "/repo",
    readableRoots: ["/repo"],
    protectedPaths: ["/home/user/.axl"],
  };
  const process = buildBubblewrapProcess(
    policy,
    "node",
    ["server.mjs"],
    "/repo",
    {
      PATH: "/usr/bin",
      HOME: "/home/user",
      MCP_TOKEN: "secret",
    },
    "/test/landlock-run",
    "/test/seccomp.bpf",
  );
  assert.equal(process.command, "/bin/sh");
  assert.equal(process.args.includes("bwrap"), true);
  assert.equal(process.args.includes("--seccomp"), true);
  assert.equal(process.args.includes("/test/seccomp.bpf"), true);
  assert.equal(process.args.includes("/run/axl/landlock-run"), true);
  assert.equal(process.args.includes("/test/landlock-run"), true);
  assert.deepEqual(process.args.slice(-2), ["node", "server.mjs"]);
  const homeMask = process.args.findIndex(
    (part, index) => part === "--tmpfs" && process.args[index + 1] === "/home/user",
  );
  assert.equal(homeMask >= 0, true);
  assert.deepEqual(process.env, {
    PATH: "/usr/bin",
    HOME: "/home/user",
    MCP_TOKEN: "secret",
  });
  assert.equal(process.args.includes("secret"), false);
});

test("failIfUnavailable: constructing the tool without bubblewrap throws", () => {
  assert.throws(
    () =>
      makeBubblewrapShellTool({
        cwd: "/repo",
        overflowDirectory: "/tmp/overflow",
        policy: { workspace: "/repo", readableRoots: ["/repo"], protectedPaths: [] },
        capabilities: { available: false, reason: "bwrap binary not found" },
      }),
    (error) =>
      error instanceof SandboxUnavailableError &&
      /does not run tools unsandboxed/.test(error.message),
  );
});

test("unsafe execution is explicit, unconfined, and reported as unenforced", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "axl-unsafe-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(workspace);
  const execution = createUnsafePlatformExecution();
  const tool = execution.makeShellTool({
    cwd: workspace,
    overflowDirectory: join(workspace, ".output"),
    policy: { workspace, readableRoots: [workspace], protectedPaths: [] },
  });
  const result = await tool.execute({ command: `echo unsafe > ${outside}` }, noSignal);
  assert.equal(result.isError, false);
  assert.equal(await readFile(outside, "utf8"), "unsafe\n");
  assert.deepEqual(execution.configuredPayload(), {
    provider: "none",
    enforced: false,
    controls: [],
  });
  const process = execution.wrapProcess({
    policy: { workspace, readableRoots: [workspace], protectedPaths: [] },
    command: "node",
    args: ["server.mjs"],
    cwd: workspace,
    env: { PATH: "/usr/bin", TOKEN: "value" },
  });
  assert.deepEqual(process, {
    command: "node",
    args: ["server.mjs"],
    cwd: workspace,
    env: { PATH: "/usr/bin", TOKEN: "value" },
  });
});

test("functional detection requires complete Landlock filesystem mediation", integration, () => {
  assert.equal(capabilities.landlockFilesystemComplete, true);
  assert.equal(capabilities.seccompPolicyPath?.endsWith(".bpf"), true);
});

test("the configured payload reports provider and controls honestly", () => {
  const enforced = bubblewrapConfiguredPayload({ available: true, version: "x" });
  assert.equal(enforced.provider, "bubblewrap");
  assert.equal(enforced.enforced, true);
  assert.deepEqual(enforced.controls, [...BUBBLEWRAP_CONTROLS]);
  assert.equal(enforced.details?.seccompPolicy, "axl-linux-deny-v1");
  assert.equal(enforced.details?.landlock, "unknown");
  const missing = bubblewrapConfiguredPayload({ available: false, reason: "nope" });
  assert.deepEqual(missing, { provider: "bubblewrap", enforced: false, controls: [] });
});

test("sandboxed commands run and workspace writes work", integration, async (context) => {
  const { workspace, tool } = await makeLayout(context);
  const result = await tool.execute({ command: "echo made > made.txt && cat made.txt" }, noSignal);
  assert.equal(result.isError, false);
  assert.match(text(result), /made/);
  assert.equal(await readFile(join(workspace, "made.txt"), "utf8"), "made\n");
});

test("Landlock denies shell reads outside explicit roots", integration, async (context) => {
  const root = await mkdtemp(join("/var/tmp", "axl-landlock-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(workspace);
  await writeFile(outside, "host-private-data\n");
  const tool = makeBubblewrapShellTool({
    cwd: workspace,
    overflowDirectory: join(workspace, ".output"),
    policy: { workspace, readableRoots: [workspace], protectedPaths: [] },
    capabilities,
  });
  const denied = await tool.execute({ command: `cat ${outside}` }, noSignal);
  assert.equal(denied.isError, true);
  assert.equal(text(denied).includes("host-private-data"), false);
  assert.match(text(denied), /Permission denied/);
});

test(
  "writes outside the workspace fail on a read-only filesystem",
  integration,
  async (context) => {
    const { tool } = await makeLayout(context);
    // The host filesystem outside the workspace is a read-only bind.
    const readOnly = await tool.execute({ command: "echo pwned > /usr/bwrap-probe" }, noSignal);
    assert.equal(readOnly.isError, true);
    assert.match(text(readOnly), /[Rr]ead-only file system/);
  },
);

test(
  "host /tmp is invisible: scratch writes never reach host files",
  integration,
  async (context) => {
    const { root, tool } = await makeLayout(context);
    // Inside the sandbox /tmp is a fresh private tmpfs, so this write succeeds —
    // into the sandbox, not the host.
    const result = await tool.execute(
      { command: `echo pwned > ${join(root, "outside.txt")}; cat ${join(root, "outside.txt")}` },
      noSignal,
    );
    assert.equal(result.isError, false);
    assert.match(text(result), /pwned/);
    assert.equal(await readFile(join(root, "outside.txt"), "utf8"), "outside\n");
  },
);

test("protected paths are invisible inside the sandbox", integration, async (context) => {
  const { axlHome, tool } = await makeLayout(context);
  const result = await tool.execute(
    { command: `cat ${join(axlHome, "credentials.json")}; ls -A ${axlHome}` },
    noSignal,
  );
  assert.equal(text(result).includes("topsecret"), false);
  assert.match(text(result), /No such file|^\s*$/m);
});

test(
  "the host home is masked while a nested workspace remains available",
  integration,
  async (context) => {
    const root = await mkdtemp(join(homedir(), ".axl-bwrap-test-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const readable = join(root, "readable");
    const outside = join(root, "outside.txt");
    await mkdir(workspace);
    await mkdir(readable);
    await writeFile(join(workspace, "inside.txt"), "inside\n");
    await writeFile(join(readable, "allowed.txt"), "allowed\n");
    await writeFile(outside, "private-home-data\n");
    const tool = makeBubblewrapShellTool({
      cwd: workspace,
      overflowDirectory: join(workspace, ".output"),
      policy: { workspace, readableRoots: [workspace, readable], protectedPaths: [] },
      capabilities,
    });
    const result = await tool.execute(
      {
        command: `cat inside.txt; cat ${join(readable, "allowed.txt")}; cat ${outside} 2>/dev/null || true`,
      },
      noSignal,
    );
    assert.match(text(result), /inside/);
    assert.match(text(result), /allowed/);
    assert.equal(text(result).includes("private-home-data"), false);
  },
);

test(
  "seccomp, no-new-privileges, capabilities, and rlimits are active",
  integration,
  async (context) => {
    const { tool } = await makeLayout(context);
    const result = await tool.execute(
      {
        command:
          "printf 'nofile=%s\\n' \"$(ulimit -n)\"; grep -E '^(NoNewPrivs|Seccomp|CapEff):' /proc/self/status",
      },
      noSignal,
    );
    assert.equal(result.isError, false);
    assert.match(text(result), /nofile=1024/);
    assert.match(text(result), /NoNewPrivs:\s+1/);
    assert.match(text(result), /Seccomp:\s+2/);
    assert.match(text(result), /CapEff:\s+0+/);
  },
);

test("the sandbox has no network", integration, async (context) => {
  const { tool } = await makeLayout(context);
  const result = await tool.execute(
    {
      command:
        "cat /proc/net/route | tail -n +2 | wc -l; (exec 3<>/dev/tcp/127.0.0.1/1 && echo CONNECTED) 2>&1 || true",
    },
    noSignal,
  );
  assert.equal(text(result).includes("CONNECTED"), false);
});

test("the environment is cleared to the allowlist", integration, async (context) => {
  const { tool } = await makeLayout(context);
  process.env.KEPLER_TEST_SECRET = "leaky-value";
  context.after(() => {
    delete process.env.KEPLER_TEST_SECRET;
  });
  const result = await tool.execute({ command: "env" }, noSignal);
  assert.equal(text(result).includes("leaky-value"), false);
  assert.match(text(result), /PATH=/);
});
