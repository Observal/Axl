// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import type { WorkspacePolicy } from "@axl/kernel";

import {
  assertDigestPinnedImage,
  buildOciRunArgv,
  createOciPlatformExecution,
  detectOciEngine,
  prepareOciPlatformExecution,
  SandboxUnavailableError,
} from "../src/index.ts";

const run = promisify(execFile);
const image =
  "docker.io/library/bash@sha256:3bee76a96d86d5d2d5efc7c1c570e5a7c95db22348a26944e0e546fa174e3324";
const noSignal = new AbortController().signal;

function output(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
}

async function layout(context: TestContext): Promise<{
  root: string;
  workspace: string;
  readable: string;
  policy: WorkspacePolicy;
}> {
  const root = await mkdtemp(join(tmpdir(), "axl-oci-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const readable = join(root, "readable");
  const protectedPath = join(root, "protected");
  await mkdir(workspace);
  await mkdir(readable);
  await mkdir(protectedPath);
  await writeFile(join(readable, "reference.txt"), "reference\n");
  await writeFile(join(protectedPath, "secret.txt"), "host-secret\n");
  return {
    root,
    workspace,
    readable,
    policy: {
      workspace,
      readableRoots: [workspace, readable],
      protectedPaths: [protectedPath],
    },
  };
}

test("requires a digest-pinned OCI image", () => {
  assert.doesNotThrow(() => assertDigestPinnedImage(image));
  assert.throws(
    () => assertDigestPinnedImage("docker.io/library/bash:5.2.37"),
    SandboxUnavailableError,
  );
});

test("reports the selected image, privilege mode, runtime, and limits", () => {
  const sandbox = createOciPlatformExecution({
    image,
    capabilities: {
      engine: "podman",
      available: true,
      version: "podman version test",
      rootless: true,
      seccomp: true,
      cgroupsV2: true,
      resourceLimitsVerified: true,
      runtime: "crun",
    },
  });
  const payload = sandbox.configuredPayload();
  assert.equal(payload.provider, "podman");
  assert.equal(payload.enforced, true);
  assert.equal(payload.controls.includes("runtime.rootless"), true);
  assert.equal(payload.details?.image, image);
  assert.equal(payload.details?.runtime, "crun");
  assert.equal(typeof payload.details?.limits, "object");

  const workspace = process.cwd();
  const wrapped = sandbox.wrapProcess({
    policy: { workspace, readableRoots: [workspace], protectedPaths: [] },
    command: "node",
    args: ["server.mjs"],
    cwd: workspace,
    env: { PATH: "/usr/bin", HOME: "/home/user", MCP_TOKEN: "secret-value" },
  });
  assert.equal(
    wrapped.args.some((part) => part.includes("secret-value")),
    false,
  );
  assert.equal(wrapped.args.includes("MCP_TOKEN"), true);
  assert.equal(wrapped.env.MCP_TOKEN, "secret-value");
});

test("rejects ambiguous mount paths", () => {
  assert.throws(
    () =>
      buildOciRunArgv({
        engine: "podman",
        image,
        policy: {
          workspace: "/repo,other",
          readableRoots: ["/repo,other"],
          protectedPaths: [],
        },
        command: "true",
        args: [],
        cwd: "/repo,other",
      }),
    /unsupported character/,
  );
});

test("builds equivalent hardened Podman and Docker invocations", () => {
  const workspace = process.cwd();
  const policy: WorkspacePolicy = {
    workspace,
    readableRoots: [workspace, "/etc/passwd"],
    protectedPaths: [join(workspace, ".axl")],
  };
  for (const engine of ["podman", "docker"] as const) {
    const argv = buildOciRunArgv({
      engine,
      image,
      policy,
      command: "bash",
      args: ["-c", "echo hi"],
      cwd: workspace,
      env: { PATH: "/host/bin", HOME: "/host/home", LANG: "C.UTF-8", TOKEN: "secret" },
      name: `axl-test-${engine}`,
    });
    assert.equal(argv[0], "/bin/sh");
    assert.equal(argv.includes(engine), true);
    assert.equal(argv.includes("--pull=never"), true);
    assert.equal(argv.includes("--network=none"), true);
    assert.equal(argv.includes("--read-only"), true);
    assert.equal(argv.includes("--cap-drop=ALL"), true);
    assert.equal(argv.includes("--security-opt=no-new-privileges"), true);
    assert.equal(argv.includes("--pids-limit"), true);
    assert.equal(argv.includes("--memory"), true);
    assert.equal(argv.includes("--cpus"), true);
    assert.equal(argv.includes(`type=bind,src=${workspace},dst=${workspace}`), true);
    assert.equal(argv.includes("type=bind,src=/etc/passwd,dst=/etc/passwd,readonly"), true);
    assert.equal(argv.includes(`${join(workspace, ".axl")}:rw,nosuid,nodev,noexec,size=1m`), true);
    assert.equal(argv.includes("LANG=C.UTF-8"), true);
    assert.equal(
      argv.some((part) => part.includes("secret")),
      false,
    );
    assert.equal(
      argv.some((part) => part.includes("/host/home")),
      false,
    );
    assert.equal(argv.includes("--entrypoint"), true);
    assert.deepEqual(argv.slice(-3), [image, "-c", "echo hi"]);
    assert.equal(argv.includes("--userns=keep-id"), engine === "podman");
  }
});

for (const engine of ["podman", "docker"] as const) {
  const capabilities = await detectOciEngine(engine);
  let backendReady = false;
  let unavailableReason = capabilities.reason;
  if (capabilities.available) {
    try {
      await prepareOciPlatformExecution({ engine, image });
      backendReady = true;
    } catch (error) {
      unavailableReason = error instanceof Error ? error.message : String(error);
    }
  }
  const integration = {
    skip: backendReady
      ? false
      : `${engine} unavailable for integration tests: ${unavailableReason ?? "unknown"}`,
  };

  test(`${engine}: reports real engine security capabilities`, integration, () => {
    assert.equal(capabilities.available, true);
    assert.equal(capabilities.seccomp, true);
    assert.equal(capabilities.cgroupsV2, true);
    if (engine === "podman") assert.equal(capabilities.rootless, true);
  });

  test(`${engine}: confines execution and removes the container`, integration, async (context) => {
    const { root, workspace, readable, policy } = await layout(context);
    const sandbox = await prepareOciPlatformExecution({ engine, image });
    const tool = sandbox.makeShellTool({
      cwd: workspace,
      overflowDirectory: join(workspace, ".output"),
      policy,
    });
    const result = await tool.execute(
      {
        command: `echo container > made.txt; cat made.txt; cat ${readable}/reference.txt; (echo changed > ${readable}/reference.txt) 2>/dev/null || true; cat ${root}/protected/secret.txt 2>/dev/null || true; cat /etc/shadow 2>/dev/null || true; printf 'nofile=%s\\n' "$(ulimit -n)"; grep -E '^(NoNewPrivs|Seccomp|CapEff):' /proc/self/status; printf 'memory='; cat /sys/fs/cgroup/memory.max; printf 'pids='; cat /sys/fs/cgroup/pids.max; printf 'cpu='; cat /sys/fs/cgroup/cpu.max; (exec 3<>/dev/tcp/1.1.1.1/80 && echo CONNECTED) 2>/dev/null || true`,
      },
      noSignal,
    );
    assert.equal(result.isError, false);
    assert.match(output(result), /container/);
    assert.match(output(result), /reference/);
    assert.equal(output(result).includes("CONNECTED"), false);
    assert.equal(output(result).includes("host-secret"), false);
    assert.equal(output(result).includes("root:"), false);
    assert.match(output(result), /nofile=1024/);
    assert.match(output(result), /NoNewPrivs:\s+1/);
    assert.match(output(result), /Seccomp:\s+2/);
    assert.match(output(result), /CapEff:\s+0+/);
    assert.match(output(result), /memory=4294967296/);
    assert.match(output(result), /pids=256/);
    assert.match(output(result), /cpu=200000 100000/);
    assert.equal(await readFile(join(workspace, "made.txt"), "utf8"), "container\n");
    assert.equal(await readFile(join(readable, "reference.txt"), "utf8"), "reference\n");
    assert.equal(output(result).includes(root), false);
    const listed = await run(engine, ["ps", "-aq", "--filter", "name=axl-"]);
    assert.equal(listed.stdout.trim(), "");
  });

  test(
    `${engine}: cancellation and timeout remove running containers`,
    integration,
    async (context) => {
      const { workspace, policy } = await layout(context);
      const sandbox = await prepareOciPlatformExecution({ engine, image });
      const tool = sandbox.makeShellTool({
        cwd: workspace,
        overflowDirectory: join(workspace, ".output"),
        policy,
      });
      const controller = new AbortController();
      const executing = tool.execute({ command: "sleep 30" }, controller.signal);
      setTimeout(() => controller.abort(), 250);
      const aborted = await executing;
      assert.equal(aborted.isError, true);
      assert.match(output(aborted), /aborted/);

      const timedOut = await tool.execute({ command: "sleep 30", timeoutMs: 250 }, noSignal);
      assert.equal(timedOut.isError, true);
      assert.match(output(timedOut), /timed out/);

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const listed = await run(engine, ["ps", "-aq", "--filter", "name=axl-"]);
        if (listed.stdout.trim() === "") return;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      assert.fail(`${engine} left an axl container behind after cancellation`);
    },
  );
}
