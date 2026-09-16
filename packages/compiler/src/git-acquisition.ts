// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ArchiveLimits, ExtractedArchive } from "./archive.ts";
import { extractBoundedTar } from "./archive.ts";
import { AcquisitionError } from "./remote-errors.ts";
import { normalizeGitRepositoryUri } from "./source-locator.ts";
import { isUnsupportedNativeSourcePath, sensitiveSourceReason } from "./source-security.ts";

const MAX_GIT_OUTPUT = 96 * 1024 * 1024;
const MAX_GIT_DIAGNOSTIC = 16 * 1024;

export interface GitLocator {
  readonly kind: "git";
  readonly repositoryUri: string;
  readonly requestedRef: string;
}

export interface GitSourceLock {
  readonly kind: "git";
  readonly repositoryUri: string;
  readonly commit: string;
  readonly treeSha256: string;
  readonly repositoryTreeObject: string;
}

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface GitCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly maximumOutputBytes: number;
      readonly signal?: AbortSignal;
      readonly timeoutMs: number;
    },
  ): Promise<GitCommandResult>;
}

export interface GitAcquisitionOptions {
  readonly destination: string;
  /** Administrator-selected absolute path to the vetted Git executable. */
  readonly gitExecutable: string;
  readonly temporaryDirectory?: string;
  readonly archiveLimits?: ArchiveLimits;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface GitUnsupportedSurface {
  readonly kind: "submodule" | "git-lfs" | "symlink";
  readonly relativePath: string;
  readonly reason: string;
}

export interface GitAcquisitionResult {
  readonly lock: GitSourceLock;
  readonly snapshot: ExtractedArchive;
  readonly sourceUri: string;
  readonly unsupportedSurfaces: readonly GitUnsupportedSurface[];
}

function validateRef(input: string): string {
  if (
    input === "" ||
    Buffer.byteLength(input, "utf8") > 512 ||
    input.startsWith("-") ||
    /[\0-\x20~^:?*\\[\]]/.test(input) ||
    input.includes("..") ||
    input.includes("@{") ||
    input.endsWith(".") ||
    input.endsWith("/")
  ) {
    throw new AcquisitionError("git_invalid", "Git ref is invalid");
  }
  return input;
}

function safeEnvironment(home: string, gitExecutable: string): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    AXL_GIT_EXECUTABLE: gitExecutable,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GCM_INTERACTIVE: "Never",
    GIT_PROTOCOL_FROM_USER: "0",
    LC_ALL: "C",
  };
  if (process.env.SystemRoot !== undefined) environment.SystemRoot = process.env.SystemRoot;
  return Object.freeze(environment);
}

export const nodeGitCommandRunner: GitCommandRunner = {
  run(executable, args, options) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: { ...options.env },
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let exceeded = false;
      let cancelled = false;
      let timedOut = false;
      const terminate = (): void => {
        if (child.pid !== undefined && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // Fall back to terminating the direct child.
          }
        }
        child.kill("SIGKILL");
      };
      const onAbort = (): void => {
        cancelled = true;
        terminate();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
      const collect = (chunks: Buffer[], chunk: Buffer): void => {
        bytes += chunk.byteLength;
        if (bytes > options.maximumOutputBytes) {
          exceeded = true;
          terminate();
          return;
        }
        chunks.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        reject(new AcquisitionError("source_unavailable", "Git process could not start"));
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        if (cancelled) {
          reject(new AcquisitionError("acquisition_cancelled", "Git acquisition was cancelled"));
          return;
        }
        if (timedOut) {
          reject(new AcquisitionError("acquisition_timed_out", "Git acquisition timed out"));
          return;
        }
        if (exceeded) {
          reject(new AcquisitionError("source_unavailable", "Git output exceeded its byte limit"));
          return;
        }
        resolvePromise({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).subarray(0, MAX_GIT_DIAGNOSTIC),
        });
      });
    });
  },
};

function outputText(result: GitCommandResult): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim();
  } catch {
    throw new AcquisitionError("source_unavailable", "Git returned non-UTF-8 metadata");
  }
}

async function requireGit(
  runner: GitCommandRunner,
  cwd: string,
  env: Readonly<Record<string, string>>,
  args: readonly string[],
  maximumOutputBytes = MAX_GIT_DIAGNOSTIC,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<GitCommandResult> {
  const executable = env.AXL_GIT_EXECUTABLE;
  if (executable === undefined)
    throw new AcquisitionError("git_unsupported", "Git executable was not configured");
  if (signal?.aborted)
    throw new AcquisitionError("acquisition_cancelled", "Git acquisition was cancelled");
  const result = await runner.run(executable, args, {
    cwd,
    env,
    maximumOutputBytes,
    ...(signal === undefined ? {} : { signal }),
    timeoutMs,
  });
  if (result.exitCode !== 0) throw new AcquisitionError("source_unavailable", "Git command failed");
  return result;
}

function parseTreeInventory(bytes: Uint8Array): readonly GitUnsupportedSurface[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AcquisitionError("source_unavailable", "Git tree inventory is not valid UTF-8");
  }
  const unsupported: GitUnsupportedSurface[] = [];
  for (const record of text.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0)
      throw new AcquisitionError("source_unavailable", "Git tree inventory is malformed");
    const metadata = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (
      path.includes("\0") ||
      path.startsWith("/") ||
      path.split("/").some((part) => part === ".." || part === ".")
    ) {
      throw new AcquisitionError("source_unavailable", "Git tree contains an invalid path");
    }
    const mode = metadata[0];
    if (mode === "160000" || path === ".gitmodules")
      unsupported.push({
        kind: "submodule",
        relativePath: path,
        reason: "Git submodules are not materialized in v1",
      });
    if (mode === "120000")
      unsupported.push({
        kind: "symlink",
        relativePath: path,
        reason: "Git symlinks are not materialized in v1",
      });
  }
  return unsupported;
}

async function findLfsPointers(
  snapshot: ExtractedArchive,
  destination: string,
): Promise<readonly GitUnsupportedSurface[]> {
  const surfaces: GitUnsupportedSurface[] = [];
  for (const file of snapshot.files) {
    if (file.sizeBytes > 4096) continue;
    const bytes = await readFile(join(destination, ...file.relativePath.split("/")));
    if (bytes.toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1\n")) {
      surfaces.push({
        kind: "git-lfs",
        relativePath: file.relativePath,
        reason: "Git LFS objects are not materialized in v1",
      });
    }
  }
  return surfaces;
}

/** Resolves one HTTPS Git ref in an isolated bare repository and snapshots its committed tree. */
export async function acquireGitSource(
  locator: GitLocator,
  options: GitAcquisitionOptions,
  runner: GitCommandRunner = nodeGitCommandRunner,
): Promise<GitAcquisitionResult> {
  let repositoryUri: string;
  try {
    repositoryUri = normalizeGitRepositoryUri(locator.repositoryUri);
  } catch {
    throw new AcquisitionError("git_unsupported", "Git repository URI is unsupported");
  }
  if (!isAbsolute(options.gitExecutable) || options.gitExecutable.includes("\0")) {
    throw new AcquisitionError(
      "git_unsupported",
      "Git acquisition requires an administrator-selected absolute executable path",
    );
  }
  const requestedRef = validateRef(locator.requestedRef);
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000)
    throw new AcquisitionError("git_invalid", "Git acquisition timeout is invalid");
  const temporaryRoot = await mkdtemp(
    join(options.temporaryDirectory ?? tmpdir(), "axl-git-acquire-"),
  );
  const repository = join(temporaryRoot, "repository.git");
  const home = join(temporaryRoot, "home");
  const hooks = join(temporaryRoot, "hooks-disabled");
  await mkdir(home, { mode: 0o700 });
  await mkdir(hooks, { mode: 0o700 });
  await writeFile(
    join(home, ".gitconfig"),
    "[credential]\n\thelper =\n[protocol]\n\tallow = never\n",
    { mode: 0o600 },
  );
  const env = safeEnvironment(home, options.gitExecutable);
  const configuredRunner = runner;
  runner = {
    run(executable, args, commandOptions) {
      return configuredRunner.run(executable, args, {
        ...commandOptions,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs,
      });
    },
  };
  try {
    await requireGit(runner, temporaryRoot, env, ["init", "--bare", repository]);
    await requireGit(runner, temporaryRoot, env, [
      "-C",
      repository,
      "config",
      "core.hooksPath",
      hooks,
    ]);
    await requireGit(runner, temporaryRoot, env, [
      "-C",
      repository,
      "remote",
      "add",
      "origin",
      repositoryUri,
    ]);
    const secureConfig = [
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
      "-c",
      "http.followRedirects=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "protocol.file.allow=never",
      "-c",
      "submodule.recurse=false",
    ];
    await requireGit(runner, temporaryRoot, env, [
      "-C",
      repository,
      ...secureConfig,
      "fetch",
      "--no-tags",
      "--depth=1",
      "origin",
      requestedRef,
    ]);
    const commit = outputText(
      await requireGit(runner, temporaryRoot, env, [
        "-C",
        repository,
        "rev-parse",
        "--verify",
        "FETCH_HEAD^{commit}",
      ]),
    );
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
      throw new AcquisitionError("source_unavailable", "Git did not resolve a full commit ID");
    const repositoryTreeObject = outputText(
      await requireGit(runner, temporaryRoot, env, [
        "-C",
        repository,
        "show",
        "-s",
        "--format=%T",
        commit,
      ]),
    );
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(repositoryTreeObject))
      throw new AcquisitionError("source_unavailable", "Git did not resolve a tree object ID");
    const inventory = await requireGit(
      runner,
      temporaryRoot,
      env,
      ["-C", repository, "ls-tree", "-rz", "-r", commit],
      MAX_GIT_OUTPUT,
    );
    const unsupported = [...parseTreeInventory(inventory.stdout)];
    if (unsupported.some((surface) => surface.kind === "submodule" || surface.kind === "symlink")) {
      throw new AcquisitionError(
        "git_unsupported",
        "Git tree contains submodules or symlinks that v1 cannot snapshot",
      );
    }
    const archive = await requireGit(
      runner,
      temporaryRoot,
      env,
      ["-C", repository, "archive", "--format=tar", commit],
      MAX_GIT_OUTPUT,
    );
    const snapshot = await extractBoundedTar(
      archive.stdout,
      options.destination,
      options.archiveLimits === undefined ? {} : { limits: options.archiveLimits },
    );
    unsupported.push(...(await findLfsPointers(snapshot, options.destination)));
    for (const file of snapshot.files) {
      const bytes = await readFile(join(options.destination, ...file.relativePath.split("/")));
      if (
        sensitiveSourceReason(file.relativePath, bytes) !== undefined ||
        isUnsupportedNativeSourcePath(file.relativePath)
      ) {
        await rm(options.destination, { recursive: true, force: true });
        throw new AcquisitionError(
          "git_unsupported",
          "Git tree contains a blocked, secret-bearing, or native-add-on file",
        );
      }
    }
    if (unsupported.some((surface) => surface.kind === "git-lfs")) {
      await rm(options.destination, { recursive: true, force: true });
      throw new AcquisitionError(
        "git_unsupported",
        "Git tree contains LFS pointers that v1 cannot materialize",
      );
    }
    return Object.freeze({
      lock: Object.freeze({
        kind: "git",
        repositoryUri,
        commit,
        treeSha256: snapshot.treeSha256,
        repositoryTreeObject,
      }),
      snapshot,
      sourceUri: repositoryUri,
      unsupportedSurfaces: Object.freeze(unsupported),
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
