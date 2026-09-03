// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

export class GitExecutionError extends Error {
  readonly code:
    | "cancelled"
    | "git_unavailable"
    | "git_timeout"
    | "git_output_too_large"
    | "unsupported_filename_encoding"
    | "git_failed";

  constructor(code: GitExecutionError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitExecutionError";
    this.code = code;
  }
}

export interface GitResult {
  readonly stdout: Buffer;
  readonly exitCode: number;
}

interface GitOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly allowedExitCodes?: readonly number[] | undefined;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    LANG: "C",
  };
}

const SAFE_CONFIG = [
  "-c",
  "alias.status=",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.pager=cat",
  "-c",
  "credential.helper=",
  "-c",
  "diff.external=",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "interactive.diffFilter=",
  "-c",
  "pager.diff=false",
  "-c",
  "pager.status=false",
  "-c",
  "color.ui=false",
] as const;

function spawnGit(cwd: string, args: readonly string[], options: GitOptions): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const allowed = new Set(options.allowedExitCodes ?? [0]);
  if (options.signal?.aborted) {
    return Promise.reject(new GitExecutionError("cancelled", "Workspace request was cancelled"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: gitEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let tooLarge = false;

    const finish = (error?: Error, result?: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(result as GitResult);
    };
    const abort = (): void => {
      child.kill("SIGKILL");
      finish(new GitExecutionError("cancelled", "Workspace request was cancelled"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();

    const collect =
      (target: Buffer[]) =>
      (chunk: Buffer): void => {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          tooLarge = true;
          child.kill("SIGKILL");
          return;
        }
        target.push(chunk);
      };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (cause: NodeJS.ErrnoException) => {
      finish(
        new GitExecutionError(
          cause.code === "ENOENT" ? "git_unavailable" : "git_failed",
          cause.code === "ENOENT" ? "Git is not installed" : "Git workspace operation failed",
          { cause },
        ),
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      if (tooLarge) {
        finish(new GitExecutionError("git_output_too_large", "Git output exceeded its limit"));
        return;
      }
      if (timedOut) {
        finish(new GitExecutionError("git_timeout", "Git workspace operation timed out"));
        return;
      }
      const exitCode = code ?? -1;
      if (!allowed.has(exitCode)) {
        finish(new GitExecutionError("git_failed", "Git workspace operation failed"));
        return;
      }
      finish(undefined, { stdout: Buffer.concat(stdout), exitCode });
    });
  });
}

function filterOverrides(config: Buffer): string[] {
  const text = decodeGit(config);
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/u.exec(line.trim());
    const name = match?.[1];
    if (name === undefined) continue;
    if (name.length > 256 || name.includes("\0") || name.includes("\n")) {
      throw new GitExecutionError("git_failed", "Repository filter configuration is invalid");
    }
    names.add(name);
  }
  return [...names]
    .sort()
    .flatMap((name) => [
      "-c",
      `filter.${name}.clean=cat`,
      "-c",
      `filter.${name}.smudge=cat`,
      "-c",
      `filter.${name}.process=`,
      "-c",
      `filter.${name}.required=false`,
    ]);
}

/** Runs one bounded, non-shell Git command under a configuration-neutral environment. */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> {
  const discovered = await spawnGit(
    cwd,
    [...SAFE_CONFIG, "config", "--local", "--name-only", "--get-regexp", "^filter\\."],
    {
      ...options,
      maxBytes: 64 * 1024,
      allowedExitCodes: [0, 1, 128],
    },
  );
  return spawnGit(cwd, [...SAFE_CONFIG, ...filterOverrides(discovered.stdout), ...args], options);
}

export function decodeGit(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (cause) {
    throw new GitExecutionError(
      "unsupported_filename_encoding",
      "Git returned a filename or value that is not valid UTF-8",
      { cause },
    );
  }
}
