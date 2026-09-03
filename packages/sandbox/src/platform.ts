// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import {
  makeShellTool,
  type KernelTool,
  type ShellToolOptions,
  type WorkspacePolicy,
} from "@axl/kernel";
import type { EventPayloadMap } from "@axl/protocol";

import {
  bubblewrapConfiguredPayload,
  buildBubblewrapProcess,
  detectBubblewrap,
  makeBubblewrapShellTool,
  type SandboxedProcess,
  SandboxUnavailableError,
} from "./bubblewrap.ts";
import {
  buildSeatbeltProcess,
  detectSeatbelt,
  makeSeatbeltShellTool,
  seatbeltConfiguredPayload,
} from "./seatbelt.ts";
import { definedEnvironment } from "./environment.ts";

export interface PlatformShellOptions extends Omit<ShellToolOptions, "wrapCommand"> {
  readonly policy: WorkspacePolicy;
}

/** The host's sandbox provider: detection result plus the tool factory. */
export interface PlatformSandbox {
  readonly provider: "bubblewrap" | "seatbelt" | "podman" | "docker" | "none";
  readonly available: boolean;
  readonly reason?: string;
  /** Throws SandboxUnavailableError when the provider is unavailable. */
  makeShellTool(options: PlatformShellOptions): KernelTool;
  wrapProcess(input: {
    readonly policy: WorkspacePolicy;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  }): SandboxedProcess;
  configuredPayload(): EventPayloadMap["sandbox.configured"];
}

/** Explicit unconfined execution for the `--unsafe` startup mode. */
export function createUnsafePlatformExecution(): PlatformSandbox {
  return {
    provider: "none",
    available: true,
    reason: "operating-system isolation disabled by --unsafe",
    makeShellTool: ({ policy: _policy, ...options }) => makeShellTool(options),
    wrapProcess: ({ command, args, cwd, env = process.env }) => ({
      command,
      args,
      cwd,
      env: definedEnvironment(env),
    }),
    configuredPayload: () => ({ provider: "none", enforced: false, controls: [] }),
  };
}

/**
 * Detects the platform's sandbox provider: Bubblewrap on Linux, Seatbelt on
 * macOS. There is no unsandboxed fallback — an unsupported or unprovisioned
 * host gets a provider whose tool factory fails loudly.
 */
export async function detectPlatformSandbox(): Promise<PlatformSandbox> {
  if (process.platform === "linux") {
    const capabilities = await detectBubblewrap();
    return {
      provider: "bubblewrap",
      available: capabilities.available,
      ...(capabilities.reason === undefined ? {} : { reason: capabilities.reason }),
      makeShellTool: (options) => makeBubblewrapShellTool({ ...options, capabilities }),
      wrapProcess: ({ policy, command, args, cwd, env }) =>
        buildBubblewrapProcess(
          policy,
          command,
          args,
          cwd,
          env,
          capabilities.landlockLauncher,
          capabilities.seccompPolicyPath,
        ),
      configuredPayload: () => bubblewrapConfiguredPayload(capabilities),
    };
  }
  if (process.platform === "darwin") {
    const capabilities = await detectSeatbelt();
    return {
      provider: "seatbelt",
      available: capabilities.available,
      ...(capabilities.reason === undefined ? {} : { reason: capabilities.reason }),
      makeShellTool: (options) => makeSeatbeltShellTool({ ...options, capabilities }),
      wrapProcess: ({ policy, command, args, cwd, env }) =>
        buildSeatbeltProcess(policy, command, args, cwd, env),
      configuredPayload: () => seatbeltConfiguredPayload(capabilities),
    };
  }
  const reason = `no sandbox provider for platform ${process.platform}`;
  return {
    provider: "none",
    available: false,
    reason,
    makeShellTool: () => {
      throw new SandboxUnavailableError(reason);
    },
    wrapProcess: () => {
      throw new SandboxUnavailableError(reason);
    },
    configuredPayload: () => ({ provider: "none", enforced: false, controls: [] }),
  };
}
