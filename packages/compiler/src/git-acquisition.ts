// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchiveLimits, ExtractedArchive } from "./archive.ts";
import { extractBoundedTar } from "./archive.ts";
import { AcquisitionError } from "./remote-errors.ts";

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
    },
  ): Promise<GitCommandResult>;
}

export interface GitAcquisitionOptions {
  readonly destination: string;
  readonly temporaryDirectory?: string;
  readonly archiveLimits?: ArchiveLimits;
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

export function normalizeGitRepositoryUri(input: string): string {
  if (/^(?:git@|[^/:\s]+@[^/:\s]+:|ext::)/i.test(input)) {
    throw new AcquisitionError(
      "git_unsupported",
      "SCP-like and remote-helper Git sources are unsupported",
    );
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AcquisitionError("git_invalid", "Git repository URI is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new AcquisitionError(
      "git_unsupported",
      "Git repository URI must be credential-free HTTPS without query or fragment",
    );
  }
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  if (url.pathname === "")
    throw new AcquisitionError("git_invalid", "Git repository URI omits a repository path");
  return url.href;
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

function safeEnvironment(home: string): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GCM_INTERACTIVE: "Never",
    GIT_PROTOCOL_FROM_USER: "0",
    LC_ALL: "C",
  };
  if (process.env.PATH !== undefined) environment.PATH = process.env.PATH;
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
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let exceeded = false;
      const collect = (chunks: Buffer[], chunk: Buffer): void => {
        bytes += chunk.byteLength;
        if (bytes > options.maximumOutputBytes) {
          exceeded = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", () =>
        reject(new AcquisitionError("source_unavailable", "Git process could not start")),
      );
      child.once("close", (code) => {
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
): Promise<GitCommandResult> {
  const result = await runner.run("git", args, { cwd, env, maximumOutputBytes });
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
  const { readFile } = await import("node:fs/promises");
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
  const repositoryUri = normalizeGitRepositoryUri(locator.repositoryUri);
  const requestedRef = validateRef(locator.requestedRef);
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
  const env = safeEnvironment(home);
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
