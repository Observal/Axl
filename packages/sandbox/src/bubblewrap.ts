// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  makeShellTool,
  type KernelTool,
  type ShellToolOptions,
  type WorkspacePolicy,
} from "@axl/kernel";
import type { EventPayloadMap } from "@axl/protocol";

import { allowlistedEnvironment, definedEnvironment } from "./environment.ts";

const run = promisify(execFile);

export class SandboxUnavailableError extends Error {
  constructor(reason: string) {
    super(`Sandbox unavailable: ${reason}. Axl does not run tools unsandboxed.`);
    this.name = "SandboxUnavailableError";
  }
}

/** The controls the Phase 4 Bubblewrap provider actually enforces. */
export const BUBBLEWRAP_CONTROLS: readonly string[] = [
  "filesystem.readonly-root",
  "filesystem.workspace-writes",
  "filesystem.masked-protected-paths",
  "filesystem.user-home-masked",
  "network.none",
  "environment.cleared",
  "process.namespaces",
];

export interface BubblewrapCapabilities {
  readonly available: boolean;
  readonly version?: string;
  readonly reason?: string;
}

/**
 * Detects Bubblewrap by actually exercising it: version, then a probe that
 * builds the same namespace set the real wrapper uses. A kernel that forbids
 * unprivileged user namespaces fails here, not mid-session.
 */
export async function detectBubblewrap(): Promise<BubblewrapCapabilities> {
  let version: string;
  try {
    const { stdout } = await run("bwrap", ["--version"]);
    version = stdout.trim();
  } catch {
    return { available: false, reason: "bwrap binary not found" };
  }
  try {
    await run("bwrap", [
      "--die-with-parent",
      "--unshare-all",
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
    ]);
  } catch (error) {
    return {
      available: false,
      version,
      reason: `namespace probe failed: ${error instanceof Error ? error.message.split("\n")[0] : "unknown"}`,
    };
  }
  return { available: true, version };
}

/**
 * Builds the Bubblewrap argv for one command: full namespace isolation, a
 * read-only view of the host, writable workspace, protected paths masked with
 * empty tmpfs, no network, and a cleared environment with a short allowlist.
 */
export function buildBubblewrapArgv(
  policy: WorkspacePolicy,
  command: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const home = resolve(env.HOME ?? homedir());
  if (home === "/") throw new SandboxUnavailableError("cannot mask a root home directory");
  const argv: string[] = [
    "bwrap",
    "--die-with-parent",
    "--unshare-all",
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
    home,
    "--bind",
    policy.workspace,
    policy.workspace,
  ];
  for (const protectedPath of policy.protectedPaths) {
    argv.push("--tmpfs", protectedPath);
  }
  argv.push("--clearenv");
  for (const pair of allowlistedEnvironment(env)) {
    const separator = pair.indexOf("=");
    argv.push("--setenv", pair.slice(0, separator), pair.slice(separator + 1));
  }
  argv.push("--chdir", cwd, "bash", "-c", command);
  return argv;
}

export interface SandboxedProcess {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Builds a direct argv wrapper for a long-lived extension process. */
export function buildBubblewrapProcess(
  policy: WorkspacePolicy,
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SandboxedProcess {
  const home = resolve(env.HOME ?? homedir());
  if (home === "/") throw new SandboxUnavailableError("cannot mask a root home directory");
  const argv = [
    "--die-with-parent",
    "--unshare-all",
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
    home,
    "--bind",
    policy.workspace,
    policy.workspace,
  ];
  for (const protectedPath of policy.protectedPaths) argv.push("--tmpfs", protectedPath);
  argv.push("--chdir", cwd, command, ...args);
  return { command: "bwrap", args: argv, cwd, env: definedEnvironment(env) };
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
  const { policy, capabilities: _capabilities, ...shellOptions } = options;
  return makeShellTool({
    ...shellOptions,
    policy,
    wrapCommand: (command, cwd) => buildBubblewrapArgv(policy, command, cwd),
  });
}

/** The `sandbox.configured` payload for this provider. */
export function bubblewrapConfiguredPayload(
  capabilities: BubblewrapCapabilities,
): EventPayloadMap["sandbox.configured"] {
  return {
    provider: "bubblewrap",
    enforced: capabilities.available,
    controls: capabilities.available ? [...BUBBLEWRAP_CONTROLS] : [],
  };
}
