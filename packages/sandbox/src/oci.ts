// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  makeShellTool,
  type KernelTool,
  type ShellToolOptions,
  type WorkspacePolicy,
} from "@axl/kernel";
import type { EventPayloadMap } from "@axl/protocol";

import { allowlistedEnvironmentRecord, definedEnvironment } from "./environment.ts";
import { type SandboxedProcess, SandboxUnavailableError } from "./bubblewrap.ts";

const run = promisify(execFile);
const ENGINE_PROBE_TIMEOUT_MS = 5_000;
const ENGINE_OPERATION_TIMEOUT_MS = 15_000;
const DIGEST_SEPARATOR = "@sha256:";
const CLEANUP_WRAPPER = `
engine=$1
name=$2
shift 2
cleanup() {
  "$engine" rm -f "$name" >/dev/null 2>&1 || true
}
trap 'cleanup; exit 143' HUP INT TERM
"$@"
status=$?
cleanup
if "$engine" container inspect "$name" >/dev/null 2>&1; then
  echo "axl: failed to remove OCI container $name" >&2
  exit 125
fi
exit "$status"
`.trim();

export type OciEngine = "podman" | "docker";

export interface OciCapabilities {
  readonly engine: OciEngine;
  readonly available: boolean;
  readonly version?: string;
  readonly rootless?: boolean;
  readonly vmIsolation?: boolean;
  readonly seccomp?: boolean;
  readonly cgroupsV2?: boolean;
  readonly resourceLimitsVerified?: boolean;
  readonly runtime?: string;
  readonly reason?: string;
}

export interface OciLimits {
  readonly cpus: number;
  readonly memoryBytes: number;
  readonly pids: number;
  readonly temporaryBytes: number;
  readonly openFiles: number;
  readonly fileSizeBytes: number;
}

export const DEFAULT_OCI_LIMITS: OciLimits = {
  cpus: 2,
  memoryBytes: 4 * 1024 * 1024 * 1024,
  pids: 256,
  temporaryBytes: 512 * 1024 * 1024,
  openFiles: 1024,
  fileSizeBytes: 256 * 1024 * 1024,
};

export const OCI_CONTROLS: readonly string[] = [
  "filesystem.read-allowlist",
  "filesystem.readonly-root",
  "filesystem.workspace-writes",
  "filesystem.masked-protected-paths",
  "network.none",
  "environment.cleared",
  "process.namespaces",
  "process.capabilities-dropped",
  "process.no-new-privileges",
  "process.seccomp",
  "resources.cgroups-v2",
  "resources.rlimits",
  "runtime.oci",
  "runtime.entrypoint-overridden",
  "termination.remove-on-exit",
  "termination.verified",
];

function firstLine(error: unknown): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : "unknown error";
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function readEngineInfo(
  engine: OciEngine,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, unknown>> {
  const args =
    engine === "podman" ? ["info", "--format", "json"] : ["info", "--format", "{{json .}}"];
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await run(engine, args, {
        env: definedEnvironment(env),
        maxBuffer: 4 * 1024 * 1024,
        timeout: ENGINE_PROBE_TIMEOUT_MS,
      });
      return object(JSON.parse(result.stdout));
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  throw lastError;
}

/** Probes the actual engine daemon, privilege mode, seccomp, cgroups, and runtime. */
export async function detectOciEngine(
  engine: OciEngine,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<OciCapabilities> {
  let version: string;
  try {
    const result = await run(engine, ["--version"], {
      env: definedEnvironment(env),
      timeout: ENGINE_PROBE_TIMEOUT_MS,
    });
    version = result.stdout.trim();
  } catch {
    return { engine, available: false, reason: `${engine} executable is missing or unusable` };
  }

  try {
    const info = await readEngineInfo(engine, env);
    if (engine === "podman") {
      const host = object(info.host);
      const security = object(host.security);
      const runtime = object(host.ociRuntime);
      const rootless = bool(security.rootless) ?? false;
      if (!rootless) {
        return { engine, available: false, version, rootless, reason: "Podman is not rootless" };
      }
      const seccomp = bool(security.seccompEnabled) ?? false;
      const cgroupsV2 = host.cgroupVersion === "v2";
      if (!seccomp || !cgroupsV2) {
        return {
          engine,
          available: false,
          version,
          rootless,
          seccomp,
          cgroupsV2,
          reason: `Podman lacks required ${!seccomp ? "seccomp" : "cgroups v2"} enforcement`,
        };
      }
      const runtimeName = text(runtime.name);
      return {
        engine,
        available: true,
        version,
        rootless,
        seccomp,
        cgroupsV2,
        resourceLimitsVerified: false,
        ...(runtimeName === undefined ? {} : { runtime: runtimeName }),
      };
    }

    const securityOptions = Array.isArray(info.SecurityOptions)
      ? info.SecurityOptions.filter((item): item is string => typeof item === "string")
      : [];
    const operatingSystem = text(info.OperatingSystem) ?? "";
    const rootless = securityOptions.some((option) => option.includes("rootless"));
    const vmIsolation = /docker desktop/i.test(operatingSystem);
    const seccomp = securityOptions.some((option) => option.includes("seccomp"));
    const cgroupsV2 = String(info.CgroupVersion) === "2";
    if (!seccomp || !cgroupsV2) {
      return {
        engine,
        available: false,
        version,
        rootless,
        vmIsolation,
        seccomp,
        cgroupsV2,
        reason: `Docker lacks required ${!seccomp ? "seccomp" : "cgroups v2"} enforcement`,
      };
    }
    const runtimeName = text(info.DefaultRuntime);
    return {
      engine,
      available: true,
      version,
      rootless,
      vmIsolation,
      seccomp,
      cgroupsV2,
      resourceLimitsVerified: false,
      ...(runtimeName === undefined ? {} : { runtime: runtimeName }),
    };
  } catch (error) {
    return {
      engine,
      available: false,
      version,
      reason: `${engine} daemon probe failed: ${firstLine(error)}`,
    };
  }
}

function lowercaseHexDigest(value: string): boolean {
  if (value.length !== 64) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
  }
  return true;
}

export function assertDigestPinnedImage(image: string): void {
  const separator = image.lastIndexOf(DIGEST_SEPARATOR);
  const name = separator < 1 ? "" : image.slice(0, separator);
  const digest = separator < 0 ? "" : image.slice(separator + DIGEST_SEPARATOR.length);
  const validName =
    name.length > 0 &&
    !name.includes("@") &&
    ![...name].some((character) => character.trim() === "");
  if (!validName || !lowercaseHexDigest(digest)) {
    throw new SandboxUnavailableError(
      `OCI image must be pinned to a sha256 digest, received ${JSON.stringify(image)}`,
    );
  }
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    throw new SandboxUnavailableError(
      `OCI mount path ${resolve(path)} cannot be canonicalized: ${firstLine(error)}`,
    );
  }
}

function containerWorkingDirectory(policy: WorkspacePolicy, cwd: string): string {
  const workspace = canonicalExistingPath(validateMountPath(resolve(policy.workspace)));
  const requested = canonicalExistingPath(validateMountPath(resolve(cwd)));
  const fromWorkspace = relative(workspace, requested);
  if (fromWorkspace === "" || (!fromWorkspace.startsWith(`..${sep}`) && fromWorkspace !== "..")) {
    return requested;
  }
  throw new SandboxUnavailableError(`working directory ${requested} is outside ${workspace}`);
}

function validateMountPath(path: string): string {
  if (path.includes(",") || path.includes("\0")) {
    throw new SandboxUnavailableError(`OCI mount path contains an unsupported character: ${path}`);
  }
  return path;
}

function mountPath(path: string): string {
  return canonicalExistingPath(validateMountPath(resolve(path)));
}

function decodeMountPath(path: string): string {
  return path.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function rejectNestedMounts(roots: readonly string[]): void {
  let source: string;
  try {
    source = readFileSync("/proc/self/mountinfo", "utf8");
  } catch (error) {
    throw new SandboxUnavailableError(`cannot inspect host mount topology: ${firstLine(error)}`);
  }
  const mountPoints = source
    .split("\n")
    .filter(Boolean)
    .map((line) => decodeMountPath(line.split(" ")[4] ?? ""));
  for (const root of roots) {
    const prefix = `${root}${sep}`;
    const nested = mountPoints.find((mount) => mount.startsWith(prefix));
    if (nested !== undefined) {
      throw new SandboxUnavailableError(
        `OCI bind root ${root} contains nested host mount ${nested}`,
      );
    }
  }
}

function mountArguments(engine: OciEngine, policy: WorkspacePolicy): string[] {
  const workspace = mountPath(policy.workspace);
  const readableRoots = policy.readableRoots.map(mountPath);
  rejectNestedMounts([workspace, ...readableRoots]);
  const args = ["--mount", `type=bind,src=${workspace},dst=${workspace}`];
  for (const canonical of readableRoots) {
    if (canonical === workspace) continue;
    args.push("--mount", `type=bind,src=${canonical},dst=${canonical},readonly`);
  }
  for (const path of policy.protectedPaths) {
    args.push("--tmpfs", `${validateMountPath(resolve(path))}:rw,nosuid,nodev,noexec,size=1m`);
  }
  if (engine === "podman") args.push("--userns=keep-id");
  return args;
}

const ENGINE_ENVIRONMENT = [
  "PATH",
  "HOME",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "DOCKER_HOST",
  "CONTAINER_HOST",
] as const;

function engineEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    ENGINE_ENVIRONMENT.flatMap((name) => {
      const value = source[name];
      return value === undefined ? [] : [[name, value] as const];
    }),
  );
}

export interface OciRunOptions {
  readonly engine: OciEngine;
  readonly image: string;
  readonly policy: WorkspacePolicy;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly includeConfiguredEnvironment?: boolean;
  readonly limits?: OciLimits;
  readonly name?: string;
}

/** Builds a fail-closed OCI invocation with a fixed cleanup trap and positional arguments. */
export function buildOciRunArgv(options: OciRunOptions): readonly string[] {
  assertDigestPinnedImage(options.image);
  const limits = options.limits ?? DEFAULT_OCI_LIMITS;
  const name = options.name ?? `axl-${randomUUID()}`;
  const engineArgv = [
    options.engine,
    "run",
    "--rm",
    "--name",
    name,
    "--pull=never",
    "--stop-timeout=1",
    "--network=none",
    "--ipc=private",
    "--hostname=axl-sandbox",
    "--init",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit",
    String(limits.pids),
    "--memory",
    String(limits.memoryBytes),
    "--cpus",
    String(limits.cpus),
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${limits.temporaryBytes}`,
    "--ulimit",
    `nofile=${limits.openFiles}:${limits.openFiles}`,
    "--ulimit",
    `fsize=${limits.fileSizeBytes}:${limits.fileSizeBytes}`,
    "--user",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "--workdir",
    containerWorkingDirectory(options.policy, options.cwd),
    ...mountArguments(options.engine, options.policy),
    "--entrypoint",
    options.command,
  ];
  const environment = options.includeConfiguredEnvironment
    ? definedEnvironment(options.env ?? process.env)
    : allowlistedEnvironmentRecord(options.env ?? process.env);
  for (const [name, value] of Object.entries(environment)) {
    if (name === "HOME" || name === "PATH" || name === "SHELL" || name === "USER") continue;
    engineArgv.push("--env", options.includeConfiguredEnvironment ? name : `${name}=${value}`);
  }
  engineArgv.push(options.image, ...options.args);
  return ["/bin/sh", "-c", CLEANUP_WRAPPER, "axl-oci-cleanup", options.engine, name, ...engineArgv];
}

function missingContainer(error: unknown): boolean {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "")
      : "";
  return /no such (container|object)|not found/i.test(stderr);
}

async function containerExists(
  engine: OciEngine,
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  try {
    await run(engine, ["container", "inspect", name], {
      env: definedEnvironment(env),
      maxBuffer: 1024 * 1024,
      timeout: ENGINE_OPERATION_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    if (missingContainer(error)) return false;
    throw error;
  }
}

/** Idempotently removes a container, then asks the engine to prove it is absent. */
export async function removeOciContainer(
  engine: OciEngine,
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  if (!(await containerExists(engine, name, env))) return;
  await run(engine, ["rm", "-f", name], {
    env: definedEnvironment(env),
    maxBuffer: 1024 * 1024,
    timeout: ENGINE_OPERATION_TIMEOUT_MS,
  });
  if (await containerExists(engine, name, env)) {
    throw new Error(`${engine} did not remove OCI container ${name}`);
  }
}

export interface OciPlatformOptions {
  readonly capabilities: OciCapabilities;
  readonly image: string;
  readonly engineEnv?: Readonly<Record<string, string | undefined>>;
  readonly limits?: OciLimits;
}

export interface OciShellOptions extends Omit<ShellToolOptions, "wrapCommand"> {
  readonly policy: WorkspacePolicy;
}

/** Creates a PlatformSandbox-compatible OCI execution backend. */
export function createOciPlatformExecution(options: OciPlatformOptions): {
  readonly provider: OciEngine;
  readonly available: boolean;
  readonly reason?: string;
  makeShellTool(input: OciShellOptions): KernelTool;
  wrapProcess(input: {
    readonly policy: WorkspacePolicy;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  }): SandboxedProcess;
  configuredPayload(): EventPayloadMap["sandbox.configured"];
} {
  const { capabilities, image, limits } = options;
  const engineEnv = engineEnvironment(options.engineEnv ?? process.env);
  assertDigestPinnedImage(image);
  if (!capabilities.available) {
    throw new SandboxUnavailableError(capabilities.reason ?? `${capabilities.engine} unavailable`);
  }
  if (capabilities.resourceLimitsVerified !== true) {
    throw new SandboxUnavailableError(
      `${capabilities.engine} cgroup resource limits have not been functionally verified`,
    );
  }
  const common = (input: {
    readonly policy: WorkspacePolicy;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly includeConfiguredEnvironment?: boolean;
  }): { readonly argv: readonly string[]; readonly cleanup: () => Promise<void> } => {
    const name = `axl-${randomUUID()}`;
    const containerEnv = input.env ?? process.env;
    let cleanupPromise: Promise<void> | undefined;
    return {
      argv: buildOciRunArgv({
        engine: capabilities.engine,
        image,
        policy: input.policy,
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        env: containerEnv,
        ...(input.includeConfiguredEnvironment === undefined
          ? {}
          : { includeConfiguredEnvironment: input.includeConfiguredEnvironment }),
        ...(limits === undefined ? {} : { limits }),
        name,
      }),
      cleanup: () => {
        cleanupPromise ??= removeOciContainer(capabilities.engine, name, engineEnv);
        return cleanupPromise;
      },
    };
  };
  return {
    provider: capabilities.engine,
    available: true,
    makeShellTool: ({ policy, ...shellOptions }) =>
      makeShellTool({
        ...shellOptions,
        policy,
        wrapCommand: (command, cwd) =>
          common({ policy, command: "bash", args: ["-c", command], cwd }),
      }),
    wrapProcess: (input) => {
      const invocation = common({ ...input, includeConfiguredEnvironment: true });
      const [command, ...args] = invocation.argv as [string, ...string[]];
      return {
        command,
        args,
        cwd: input.cwd,
        env: { ...engineEnv, ...definedEnvironment(input.env ?? {}) },
        cleanup: invocation.cleanup,
      };
    },
    configuredPayload: () => ({
      provider: capabilities.engine,
      enforced: true,
      controls: [
        ...OCI_CONTROLS,
        capabilities.rootless ? "runtime.rootless" : "runtime.rootful",
        ...(capabilities.vmIsolation ? ["runtime.vm-isolation"] : []),
        ...(capabilities.runtime === undefined ? [] : [`runtime.oci.${capabilities.runtime}`]),
      ],
      details: {
        engineVersion: capabilities.version ?? "unknown",
        image,
        rootless: capabilities.rootless ?? false,
        vmIsolation: capabilities.vmIsolation ?? false,
        seccomp: capabilities.seccomp ?? false,
        cgroupsV2: capabilities.cgroupsV2 ?? false,
        resourceLimitsVerified: capabilities.resourceLimitsVerified ?? false,
        runtime: capabilities.runtime ?? "unknown",
        limits: {
          cpus: (limits ?? DEFAULT_OCI_LIMITS).cpus,
          memoryBytes: (limits ?? DEFAULT_OCI_LIMITS).memoryBytes,
          pids: (limits ?? DEFAULT_OCI_LIMITS).pids,
          temporaryBytes: (limits ?? DEFAULT_OCI_LIMITS).temporaryBytes,
          openFiles: (limits ?? DEFAULT_OCI_LIMITS).openFiles,
          fileSizeBytes: (limits ?? DEFAULT_OCI_LIMITS).fileSizeBytes,
        },
      },
    }),
  };
}

async function verifyOciResourceLimits(
  engine: OciEngine,
  image: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const name = `axl-probe-${randomUUID()}`;
  try {
    const result = await run(
      engine,
      [
        "run",
        "--rm",
        "--name",
        name,
        "--pull=never",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--memory",
        "67108864",
        "--cpus",
        "0.5",
        "--pids-limit",
        "32",
        "--entrypoint",
        "bash",
        image,
        "-c",
        "printf 'memory=%s\\n' \"$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo missing)\"; printf 'pids=%s\\n' \"$(cat /sys/fs/cgroup/pids.max 2>/dev/null || echo missing)\"; printf 'cpu=%s\\n' \"$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo missing)\"",
      ],
      {
        env: definedEnvironment(env),
        maxBuffer: 1024 * 1024,
        timeout: ENGINE_OPERATION_TIMEOUT_MS,
      },
    );
    if (
      !/memory=67108864(?:\r?\n)/.test(result.stdout) ||
      !/pids=32(?:\r?\n)/.test(result.stdout) ||
      !/cpu=50000 100000(?:\r?\n|$)/.test(result.stdout)
    ) {
      throw new Error(
        `reported cgroup values do not match the requested limits: ${result.stdout.trim()}`,
      );
    }
  } finally {
    await removeOciContainer(engine, name, env);
  }
}

/** Requires a functional engine, local digest-pinned image, and enforced limits. */
export async function prepareOciPlatformExecution(input: {
  readonly engine: OciEngine;
  readonly image: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly limits?: OciLimits;
}): Promise<ReturnType<typeof createOciPlatformExecution>> {
  assertDigestPinnedImage(input.image);
  const env = input.env ?? process.env;
  const capabilities = await detectOciEngine(input.engine, env);
  if (!capabilities.available) {
    throw new SandboxUnavailableError(capabilities.reason ?? `${input.engine} unavailable`);
  }
  try {
    await run(input.engine, ["image", "inspect", input.image], {
      env: definedEnvironment(env),
      maxBuffer: 4 * 1024 * 1024,
      timeout: ENGINE_OPERATION_TIMEOUT_MS,
    });
  } catch (error) {
    throw new SandboxUnavailableError(
      `${input.engine} image ${input.image} is not available locally: ${firstLine(error)}`,
    );
  }
  try {
    await verifyOciResourceLimits(input.engine, input.image, env);
  } catch (error) {
    throw new SandboxUnavailableError(
      `${input.engine} could not prove cgroup resource limits: ${firstLine(error)}`,
    );
  }
  return createOciPlatformExecution({
    capabilities: { ...capabilities, resourceLimitsVerified: true },
    image: input.image,
    engineEnv: env,
    ...(input.limits === undefined ? {} : { limits: input.limits }),
  });
}
