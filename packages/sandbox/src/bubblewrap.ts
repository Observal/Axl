// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  grantArgs,
  launcherPath,
  type LandlockEnforcement,
  probe as probeLandlock,
} from "@deepseek-ai/node-addon-landlock-run";

import {
  makeShellTool,
  type KernelTool,
  type ShellToolOptions,
  type WorkspacePolicy,
} from "@axl/kernel";
import type { EventPayloadMap } from "@axl/protocol";

import { allowlistedEnvironment, definedEnvironment } from "./environment.ts";
import { ensureSeccompFilterFile, SECCOMP_POLICY_VERSION } from "./seccomp.ts";

const run = promisify(execFile);

export class SandboxUnavailableError extends Error {
  constructor(reason: string) {
    super(`Sandbox unavailable: ${reason}. Axl does not run tools unsandboxed.`);
    this.name = "SandboxUnavailableError";
  }
}

const LANDLOCK_MOUNT_PATH = "/run/axl/landlock-run";
const SECCOMP_FD = 3;
const SECCOMP_WRAPPER = 'exec 3<"$1"; shift; exec "$@"';
const SYSTEM_READ_ROOTS = [
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib64",
  "/etc/alternatives",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/ssl",
  "/proc",
] as const;
const DEVICE_GRANTS = ["/dev/null", "/dev/random", "/dev/urandom", "/dev/tty"] as const;
const NATIVE_LIMITS = {
  addressSpaceBytes: 4_294_967_296,
  cpuSeconds: 120,
  fileSizeBytes: 268_435_456,
  openFiles: 1024,
  processes: 256,
} as const;

/** Controls enforced whenever the Linux native provider is available. */
export const BUBBLEWRAP_CONTROLS: readonly string[] = [
  "filesystem.read-allowlist",
  "filesystem.readonly-root",
  "filesystem.workspace-writes",
  "filesystem.masked-protected-paths",
  "filesystem.user-home-masked",
  "network.none",
  "environment.cleared",
  "process.namespaces",
  "process.userns-disabled",
  "process.capabilities-dropped",
  "process.landlock",
  `process.seccomp.${SECCOMP_POLICY_VERSION}`,
  "resources.rlimits",
];

export interface BubblewrapCapabilities {
  readonly available: boolean;
  readonly version?: string;
  readonly landlock?: LandlockEnforcement;
  readonly landlockFilesystemComplete?: boolean;
  readonly landlockLauncher?: string;
  readonly seccompPolicyPath?: string;
  readonly reason?: string;
}

async function probeLandlockFilesystem(landlockBinary: string): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "axl-landlock-probe-"));
  const allowed = join(root, "allowed");
  const allowedFile = join(allowed, "allowed");
  const outside = join(root, "outside");
  try {
    if (!existsSync("/usr/bin/truncate")) return false;
    await mkdir(allowed);
    await writeFile(allowedFile, "allowed");
    await writeFile(outside, "must-remain");
    const grants = grantArgs({
      readOnly: SYSTEM_READ_ROOTS.filter((path) => existsSync(path)),
      readWrite: [allowed],
    });
    await run(landlockBinary, [...grants, "--", "/usr/bin/truncate", "-s", "0", allowedFile], {
      timeout: 2_000,
    });
    if ((await readFile(allowedFile)).byteLength !== 0) return false;
    try {
      await run(landlockBinary, [...grants, "--", "/usr/bin/truncate", "-s", "0", outside], {
        timeout: 2_000,
      });
      return false;
    } catch {
      return (await readFile(outside, "utf8")) === "must-remain";
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Detects Bubblewrap by actually exercising it: version, then a probe that
 * builds the same namespace set the real wrapper uses. A kernel that forbids
 * unprivileged user namespaces fails here, not mid-session.
 */
export async function detectBubblewrap(): Promise<BubblewrapCapabilities> {
  if (!existsSync("/usr/bin/prlimit")) {
    return { available: false, reason: "/usr/bin/prlimit is required for resource limits" };
  }
  let version: string;
  try {
    const { stdout } = await run("bwrap", ["--version"], { timeout: 2_000 });
    version = stdout.trim();
  } catch {
    return { available: false, reason: "bwrap binary not found" };
  }
  let seccompPolicyPath: string;
  try {
    seccompPolicyPath = ensureSeccompFilterFile();
    await run(
      "/bin/sh",
      [
        "-c",
        SECCOMP_WRAPPER,
        "axl-seccomp",
        seccompPolicyPath,
        "bwrap",
        "--seccomp",
        String(SECCOMP_FD),
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        "--unshare-user",
        "--disable-userns",
        "--cap-drop",
        "ALL",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        "true",
      ],
      { timeout: 2_000 },
    );
  } catch (error) {
    return {
      available: false,
      version,
      reason: `native confinement probe failed: ${error instanceof Error ? error.message.split("\n")[0] : "unknown"}`,
    };
  }
  const landlockLauncher = launcherPath();
  const landlock = probeLandlock(landlockLauncher);
  if (landlock === "unusable") {
    return {
      available: false,
      version,
      landlock,
      landlockLauncher,
      reason: "Landlock launcher is missing or the kernel cannot enforce Landlock",
    };
  }
  const landlockFilesystemComplete = await probeLandlockFilesystem(landlockLauncher);
  if (!landlockFilesystemComplete) {
    return {
      available: false,
      version,
      landlock,
      landlockFilesystemComplete,
      landlockLauncher,
      seccompPolicyPath,
      reason: "Landlock does not mediate every filesystem operation required by Axl",
    };
  }
  return {
    available: true,
    version,
    landlock,
    landlockFilesystemComplete,
    landlockLauncher,
    seccompPolicyPath,
  };
}

function withSeccomp(argv: readonly string[], seccompPolicyPath: string): readonly string[] {
  return [
    "/bin/sh",
    "-c",
    SECCOMP_WRAPPER,
    "axl-seccomp",
    seccompPolicyPath,
    argv[0] as string,
    "--seccomp",
    String(SECCOMP_FD),
    ...argv.slice(1),
  ];
}

function landlockGrantArguments(policy: WorkspacePolicy): readonly string[] {
  const readOnly = [
    ...SYSTEM_READ_ROOTS.filter((path) => existsSync(path)),
    ...policy.readableRoots
      .map((path) => resolve(path))
      .filter((path) => path !== resolve(policy.workspace)),
  ];
  const readWrite = [
    resolve(policy.workspace),
    "/tmp",
    ...DEVICE_GRANTS.filter((path) => existsSync(path)),
  ];
  return grantArgs({ readOnly: [...new Set(readOnly)], readWrite: [...new Set(readWrite)] });
}

function appendReadableRootMounts(argv: string[], policy: WorkspacePolicy): void {
  const workspace = resolve(policy.workspace);
  for (const root of policy.readableRoots) {
    const canonical = resolve(root);
    if (canonical !== workspace) argv.push("--ro-bind", canonical, canonical);
  }
}

function appendLandlockCommand(
  argv: string[],
  policy: WorkspacePolicy,
  command: string,
  args: readonly string[],
  landlockBinary: string,
  longLived: boolean,
): void {
  argv.push("--dir", "/run/axl", "--ro-bind", landlockBinary, LANDLOCK_MOUNT_PATH);
  const limits = [
    `--as=${NATIVE_LIMITS.addressSpaceBytes}`,
    `--nproc=${NATIVE_LIMITS.processes}`,
    `--nofile=${NATIVE_LIMITS.openFiles}`,
    `--fsize=${NATIVE_LIMITS.fileSizeBytes}`,
    ...(longLived ? [] : [`--cpu=${NATIVE_LIMITS.cpuSeconds}`]),
  ];
  argv.push(
    LANDLOCK_MOUNT_PATH,
    ...landlockGrantArguments(policy),
    "--",
    "/usr/bin/prlimit",
    ...limits,
    "--",
    command,
    ...args,
  );
}

/**
 * Builds the Bubblewrap argv for one command: full namespace isolation, a
 * read-only view of the host, writable workspace, protected paths masked with
 * empty tmpfs, no network, a Landlock read allowlist, and a cleared environment.
 */
export function buildBubblewrapArgv(
  policy: WorkspacePolicy,
  command: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  landlockBinary = launcherPath(),
  seccompPolicyPath = ensureSeccompFilterFile(),
): readonly string[] {
  const home = resolve(env.HOME ?? homedir());
  if (home === "/") throw new SandboxUnavailableError("cannot mask a root home directory");
  const argv: string[] = [
    "bwrap",
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--tmpfs",
    home,
    "--bind",
    policy.workspace,
    policy.workspace,
  ];
  appendReadableRootMounts(argv, policy);
  for (const protectedPath of policy.protectedPaths) {
    argv.push("--tmpfs", protectedPath);
  }
  argv.push("--clearenv");
  for (const pair of allowlistedEnvironment(env)) {
    const separator = pair.indexOf("=");
    argv.push("--setenv", pair.slice(0, separator), pair.slice(separator + 1));
  }
  argv.push("--chdir", cwd);
  appendLandlockCommand(argv, policy, "bash", ["-c", command], landlockBinary, false);
  return withSeccomp(argv, seccompPolicyPath);
}

export interface SandboxedProcess {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cleanup?: () => Promise<void>;
}

/** Builds a direct argv wrapper for a long-lived extension process. */
export function buildBubblewrapProcess(
  policy: WorkspacePolicy,
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  landlockBinary = launcherPath(),
  seccompPolicyPath = ensureSeccompFilterFile(),
): SandboxedProcess {
  const home = resolve(env.HOME ?? homedir());
  if (home === "/") throw new SandboxUnavailableError("cannot mask a root home directory");
  const argv = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--tmpfs",
    home,
    "--bind",
    policy.workspace,
    policy.workspace,
  ];
  appendReadableRootMounts(argv, policy);
  for (const protectedPath of policy.protectedPaths) argv.push("--tmpfs", protectedPath);
  argv.push("--chdir", cwd);
  appendLandlockCommand(argv, policy, command, args, landlockBinary, true);
  const [wrappedCommand, ...wrappedArgs] = withSeccomp(["bwrap", ...argv], seccompPolicyPath) as [
    string,
    ...string[],
  ];
  return { command: wrappedCommand, args: wrappedArgs, cwd, env: definedEnvironment(env) };
}

export interface BubblewrapShellOptions extends Omit<ShellToolOptions, "wrapCommand"> {
  readonly policy: WorkspacePolicy;
  readonly capabilities: BubblewrapCapabilities;
}

/**
 * The sandboxed canonical shell tool. `failIfUnavailable` is not optional:
 * constructing this without a working Bubblewrap throws, and there is no flag
 * to run the command unwrapped.
 */
export function makeBubblewrapShellTool(options: BubblewrapShellOptions): KernelTool {
  if (!options.capabilities.available) {
    throw new SandboxUnavailableError(options.capabilities.reason ?? "unknown");
  }
  const { policy, capabilities, ...shellOptions } = options;
  return makeShellTool({
    ...shellOptions,
    policy,
    wrapCommand: (command, cwd) =>
      buildBubblewrapArgv(
        policy,
        command,
        cwd,
        process.env,
        capabilities.landlockLauncher ?? launcherPath(),
        capabilities.seccompPolicyPath ?? ensureSeccompFilterFile(),
      ),
  });
}

/** The `sandbox.configured` payload for this provider. */
export function bubblewrapConfiguredPayload(
  capabilities: BubblewrapCapabilities,
): EventPayloadMap["sandbox.configured"] {
  return {
    provider: "bubblewrap",
    enforced: capabilities.available,
    controls: capabilities.available
      ? [
          ...BUBBLEWRAP_CONTROLS,
          ...(capabilities.landlock === undefined
            ? []
            : [`process.landlock.${capabilities.landlock}`]),
        ]
      : [],
    ...(capabilities.available
      ? {
          details: {
            bubblewrapVersion: capabilities.version ?? "unknown",
            landlock: capabilities.landlock ?? "unknown",
            landlockFilesystemComplete: capabilities.landlockFilesystemComplete ?? false,
            seccompPolicy: SECCOMP_POLICY_VERSION,
            limits: { ...NATIVE_LIMITS },
          },
        }
      : {}),
  };
}
