// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SessionId } from "@axl/protocol";

import { decodeGit, GitExecutionError, runGit } from "./workspace-git.ts";

const WORKSPACE_BYTE_LIMIT = 256 * 1024 * 1024;

export class WorkspaceCheckpointError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceCheckpointError";
    this.code = code;
  }
}

export interface CheckpointRecord {
  readonly version: 1;
  readonly checkpointId: string;
  readonly tree: string;
}

/** Disposable Git-object checkpoints used only for daemon-owned workspace review. */
export class WorkspaceCheckpointStore {
  private readonly directory: string;
  private readonly operations = new Map<SessionId, Promise<unknown>>();

  constructor(directory: string) {
    this.directory = directory;
  }

  async has(sessionId: SessionId): Promise<boolean> {
    try {
      await stat(this.paths(sessionId).record);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  capture(sessionId: SessionId, cwd: string): Promise<CheckpointRecord> {
    return this.serialized(sessionId, () => this.captureUnlocked(sessionId, cwd));
  }

  private async captureUnlocked(sessionId: SessionId, cwd: string): Promise<CheckpointRecord> {
    const paths = this.paths(sessionId);
    await this.assertGitWorkspace(cwd);
    await this.assertBoundedWorkspace(cwd);
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    try {
      await stat(paths.git);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.git(cwd, ["init", "--quiet", "--bare", paths.git]);
      await this.snapshotGit(cwd, paths.git, ["config", "core.autocrlf", "false"]);
      await this.snapshotGit(cwd, paths.git, ["config", "core.hooksPath", "/dev/null"]);
    }
    await this.snapshotGit(cwd, paths.git, ["add", "-A", "--", "."]);
    const tree = decodeGit((await this.snapshotGit(cwd, paths.git, ["write-tree"])).stdout).trim();
    const record: CheckpointRecord = { version: 1, checkpointId: randomUUID(), tree };
    const temporary = `${paths.record}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await rename(temporary, paths.record);
    } finally {
      await rm(temporary, { force: true });
    }
    return record;
  }

  async read(sessionId: SessionId): Promise<CheckpointRecord> {
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(this.paths(sessionId).record, "utf8")) as unknown;
    } catch (cause) {
      const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
      throw new WorkspaceCheckpointError(
        missing ? "checkpoint_unavailable" : "checkpoint_corrupt",
        missing
          ? "No completed prompt checkpoint is available for this session"
          : "The last-turn checkpoint is invalid",
        { cause },
      );
    }
    if (
      typeof stored !== "object" ||
      stored === null ||
      (stored as Partial<CheckpointRecord>).version !== 1 ||
      typeof (stored as Partial<CheckpointRecord>).tree !== "string" ||
      !/^[0-9a-f]{40,64}$/u.test((stored as Partial<CheckpointRecord>).tree as string) ||
      typeof (stored as Partial<CheckpointRecord>).checkpointId !== "string" ||
      !/^[0-9a-f-]{36}$/u.test((stored as Partial<CheckpointRecord>).checkpointId as string)
    ) {
      throw new WorkspaceCheckpointError(
        "checkpoint_corrupt",
        "The last-turn checkpoint is invalid",
      );
    }
    return stored as CheckpointRecord;
  }

  currentTree(sessionId: SessionId, cwd: string, signal?: AbortSignal): Promise<string> {
    return this.serialized(sessionId, async () => {
      await this.assertGitWorkspace(cwd, signal);
      await this.assertBoundedWorkspace(cwd, signal);
      const gitDirectory = this.paths(sessionId).git;
      await this.snapshotGit(cwd, gitDirectory, ["add", "-A", "--", "."], signal);
      return decodeGit(
        (await this.snapshotGit(cwd, gitDirectory, ["write-tree"], signal)).stdout,
      ).trim();
    });
  }

  gitDirectory(sessionId: SessionId): string {
    return this.paths(sessionId).git;
  }

  private async serialized<Result>(
    sessionId: SessionId,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.operations.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.operations.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.operations.get(sessionId) === current) this.operations.delete(sessionId);
    }
  }

  private paths(sessionId: SessionId): { root: string; git: string; record: string } {
    const root = join(this.directory, "checkpoints", sessionId);
    return { root, git: join(root, "git"), record: join(root, "last-turn.json") };
  }

  private async assertGitWorkspace(cwd: string, signal?: AbortSignal): Promise<void> {
    try {
      const result = decodeGit(
        (await this.git(cwd, ["rev-parse", "--is-inside-work-tree"], signal)).stdout,
      ).trim();
      if (result !== "true") throw new Error("not a work tree");
    } catch (cause) {
      if (cause instanceof WorkspaceCheckpointError && cause.code !== "git_failed") throw cause;
      if (cause instanceof GitExecutionError && cause.code !== "git_failed") throw cause;
      throw new WorkspaceCheckpointError(
        "not_git_repository",
        "Workspace review requires a Git worktree",
        { cause },
      );
    }
  }

  private async assertBoundedWorkspace(cwd: string, signal?: AbortSignal): Promise<void> {
    const files = decodeGit(
      (
        await this.git(
          cwd,
          ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
          signal,
          4 * 1024 * 1024,
        )
      ).stdout,
    )
      .split("\0")
      .filter(Boolean);
    if (files.length > 20_000) {
      throw new WorkspaceCheckpointError(
        "checkpoint_too_large",
        "Workspace checkpoint exceeds the 20,000 file safety limit",
      );
    }
    let bytes = 0;
    for (const path of files) {
      let info: Stats;
      try {
        info = await lstat(join(cwd, path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!info.isFile()) continue;
      bytes += info.size;
      if (bytes > WORKSPACE_BYTE_LIMIT) {
        throw new WorkspaceCheckpointError(
          "checkpoint_too_large",
          "Workspace checkpoint exceeds the 256 MiB safety limit",
        );
      }
    }
  }

  private snapshotGit(
    cwd: string,
    gitDirectory: string,
    args: readonly string[],
    signal?: AbortSignal,
  ) {
    return this.git(cwd, [`--git-dir=${gitDirectory}`, `--work-tree=${cwd}`, ...args], signal);
  }

  private async git(cwd: string, args: readonly string[], signal?: AbortSignal, maxBytes?: number) {
    try {
      return await runGit(cwd, args, { signal, maxBytes });
    } catch (cause) {
      if (cause instanceof GitExecutionError) {
        throw new WorkspaceCheckpointError(cause.code, cause.message, { cause });
      }
      throw cause;
    }
  }
}
