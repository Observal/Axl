// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  DiffHunk,
  DiffLine,
  GitChangeKind,
  GitStatusEntry,
  SessionId,
  WorkspaceDiffParams,
  WorkspaceDiffResult,
  WorkspaceEntry,
  WorkspaceListParams,
  WorkspaceListResult,
  WorkspaceReadParams,
  WorkspaceReadResult,
  WorkspaceStatusParams,
  WorkspaceStatusResult,
} from "@axl/protocol";

import { WorkspaceCheckpointError, type WorkspaceCheckpointStore } from "./workspace-checkpoint.ts";
import { GitExecutionError, runGit } from "./workspace-git.ts";

const STATUS_LIMIT = 4 * 1024 * 1024;
const DIFF_LIMIT = 4 * 1024 * 1024;
const READ_SCAN_LIMIT = 32 * 1024 * 1024;
const CURSOR_LIFETIME_MS = 5 * 60_000;

export class WorkspaceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

interface WorkspaceIdentity {
  readonly root: string;
  readonly generation: string;
  readonly stats: Stats;
}

interface GuardedPath {
  readonly handle: FileHandle;
  readonly components: readonly {
    readonly path: string;
    readonly handle: FileHandle;
    readonly stats: Stats;
  }[];
}

interface DirectoryCursor {
  readonly owner: string;
  readonly sessionId: SessionId;
  readonly path: string;
  readonly workspaceGeneration: string;
  readonly directoryRevision: string;
  readonly offset: number;
  readonly expiresAt: number;
}

interface StatusSnapshot {
  readonly sessionId: SessionId;
  readonly result: WorkspaceStatusResult;
  readonly entries: ReadonlyMap<string, GitStatusEntry>;
  readonly repositoryRoot: string;
  readonly scope: WorkspaceStatusParams["scope"];
  readonly checkpointTree?: string;
  readonly currentTree?: string;
}

function digest(...values: readonly (string | Buffer)[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function normalizedPath(path: string, allowRoot: boolean): string {
  if (
    typeof path !== "string" ||
    (path === "" && !allowRoot) ||
    path.startsWith("/") ||
    path.startsWith("//") ||
    /^[a-zA-Z]:/u.test(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    (path.split("/").some((part) => part === "." || part === ".." || part === "") && path !== "")
  ) {
    throw new WorkspaceError("invalid_path", "Path must be normalized and workspace-relative");
  }
  return path;
}

function normalizedGitPath(path: string): string {
  try {
    return normalizedPath(path, false);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "invalid_path") {
      throw new WorkspaceError(
        "unsupported_filename_encoding",
        "Git returned a filename that cannot be represented as a workspace path",
        { cause: error },
      );
    }
    throw error;
  }
}

function statusKind(code: string, binary: boolean, submodule: boolean): GitChangeKind {
  if (submodule) return "submodule";
  if (binary) return "binary";
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R" || code === "C") return "renamed";
  return "modified";
}

function fatalUtf8(
  buffer: Buffer,
  code: "invalid_encoding" | "unsupported_filename_encoding",
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (cause) {
    throw new WorkspaceError(
      code,
      code === "invalid_encoding"
        ? "File content is not valid UTF-8"
        : "A filename is not valid UTF-8",
      { cause },
    );
  }
}

function mapGitError(error: unknown): never {
  if (error instanceof WorkspaceError || error instanceof WorkspaceCheckpointError) throw error;
  if (error instanceof GitExecutionError) {
    const code = error.code === "git_failed" ? "unsupported_git_state" : error.code;
    throw new WorkspaceError(code, error.message, { cause: error });
  }
  throw error;
}

function parseNumstat(buffer: Buffer): ReadonlySet<string> {
  const text = fatalUtf8(buffer, "unsupported_filename_encoding");
  const fields = text.split("\0");
  const binary = new Set<string>();
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/su.exec(field);
    if (!match) continue;
    let path = match[3] ?? "";
    if (path === "") {
      index += 2;
      path = fields[index] ?? "";
    }
    if ((match[1] === "-" || match[2] === "-") && path) binary.add(path);
  }
  return binary;
}

function parseRawSubmodules(buffer: Buffer): ReadonlySet<string> {
  const records = fatalUtf8(buffer, "unsupported_filename_encoding").split("\0");
  const submodules = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const header = records[index];
    if (!header) continue;
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([ACDMRT])(\d*)$/u.exec(header);
    if (!match) throw new WorkspaceError("unsupported_git_state", "Cannot parse raw Git status");
    let path = records[++index];
    if (match[3] === "R" || match[3] === "C") path = records[++index];
    if (!path) throw new WorkspaceError("unsupported_git_state", "Raw Git status omitted a path");
    if (match[1] === "160000" || match[2] === "160000") submodules.add(path);
  }
  return submodules;
}

function parseHunks(patch: string): DiffHunk[] {
  const hunks: Array<{ header: string; lines: DiffLine[] }> = [];
  let current: { header: string; lines: DiffLine[] } | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@@")) {
      throw new WorkspaceError("unsupported_git_state", "Combined Git diffs are not supported");
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+")) {
      current.lines.push({ kind: "addition", newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      current.lines.push({ kind: "deletion", oldLine, text: raw.slice(1) });
      oldLine += 1;
    } else if (raw.startsWith(" ")) {
      current.lines.push({ kind: "context", oldLine, newLine, text: raw.slice(1) });
      oldLine += 1;
      newLine += 1;
    } else if (raw.startsWith("\\")) {
      current.lines.push({ kind: "marker", text: raw });
    }
  }
  return hunks;
}

function lineRecords(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

/** Session-scoped, bounded filesystem and Git read surface. */
export class WorkspaceService {
  private readonly dataDirectory: string;
  private readonly checkpoints: WorkspaceCheckpointStore;
  private readonly deniedPaths: readonly string[];
  private readonly cursors = new Map<string, DirectoryCursor>();
  private readonly statusScopes = new Map<
    string,
    { readonly sessionId: SessionId; readonly scope: WorkspaceStatusParams["scope"] }
  >();

  constructor(
    dataDirectory: string,
    checkpoints: WorkspaceCheckpointStore,
    deniedPaths: readonly string[] = [],
  ) {
    this.dataDirectory = resolve(dataDirectory);
    this.checkpoints = checkpoints;
    this.deniedPaths = deniedPaths.map((path) => resolve(path));
  }

  async list(
    owner: string,
    sessionId: SessionId,
    cwd: string,
    params: Omit<WorkspaceListParams, "sessionId">,
    signal?: AbortSignal,
  ): Promise<WorkspaceListResult> {
    this.assertActive(signal);
    const identity = await this.workspaceIdentity(cwd);
    this.expectWorkspace(identity, params.ifWorkspaceGeneration);
    const path = normalizedPath(params.path, true);
    this.assertPathAllowed(identity.root, path);
    const target = await this.resolveExisting(identity, path);
    if (!target.stats.isDirectory()) {
      throw new WorkspaceError("unsupported_file_type", "Workspace path is not a directory");
    }
    const directoryRevision = `${target.stats.dev}:${target.stats.ino}:${target.stats.size}:${target.stats.mtimeMs}`;
    let offset = 0;
    if (params.pageCursor !== undefined) {
      const cursor = this.cursors.get(params.pageCursor);
      if (
        cursor === undefined ||
        cursor.owner !== owner ||
        cursor.sessionId !== sessionId ||
        cursor.path !== path ||
        cursor.workspaceGeneration !== identity.generation ||
        cursor.directoryRevision !== directoryRevision ||
        cursor.expiresAt < Date.now()
      ) {
        throw new WorkspaceError("workspace_changed", "Directory page is no longer valid");
      }
      offset = cursor.offset;
      this.cursors.delete(params.pageCursor);
    }
    const guard = await this.guardExisting(identity, path, target.stats);
    let named: Array<{ readonly entry: Dirent<Buffer>; readonly name: string }>;
    let entries: WorkspaceEntry[];
    try {
      let rawEntries: Dirent<Buffer>[];
      try {
        rawEntries = await readdir(target.canonical, { withFileTypes: true, encoding: "buffer" });
      } catch (cause) {
        throw this.fileError(cause, "workspace_unavailable", "Cannot list workspace directory");
      }
      named = rawEntries.map((entry) => ({
        entry,
        name: fatalUtf8(entry.name, "unsupported_filename_encoding"),
      }));
      named.sort((left, right) => Buffer.compare(left.entry.name, right.entry.name));
      const page = named.slice(offset, offset + params.pageSize);
      entries = [];
      for (const { name } of page) {
        this.assertActive(signal);
        const childPath = path ? `${path}/${name}` : name;
        const child = join(identity.root, ...childPath.split("/"));
        let info: Stats;
        try {
          info = await lstat(child);
        } catch (cause) {
          throw this.fileError(cause, "workspace_changed", "Directory changed while it was listed");
        }
        let type: WorkspaceEntry["type"] = "other";
        if (info.isFile()) type = "file";
        else if (info.isDirectory()) type = "directory";
        else if (info.isSymbolicLink()) type = "symlink";
        let linkTargetType: WorkspaceEntry["linkTargetType"];
        if (type === "symlink") {
          try {
            const targetPath = await realpath(child);
            linkTargetType = isWithin(identity.root, targetPath)
              ? "inside_workspace"
              : "outside_workspace";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") linkTargetType = "missing";
            else throw error;
          }
        }
        entries.push({
          path: childPath,
          name,
          type,
          ...(type === "file" ? { sizeBytes: info.size } : {}),
          mtimeMs: Math.max(0, Math.floor(info.mtimeMs)),
          ...(linkTargetType === undefined ? {} : { linkTargetType }),
        });
      }
      await this.assertGuardStable(guard);
    } finally {
      await this.closeGuard(guard);
    }
    const pageLength = Math.min(params.pageSize, named.length - offset);
    let nextPageCursor: string | undefined;
    if (offset + pageLength < named.length) {
      nextPageCursor = randomUUID();
      this.cursors.set(nextPageCursor, {
        owner,
        sessionId,
        path,
        workspaceGeneration: identity.generation,
        directoryRevision,
        offset: offset + pageLength,
        expiresAt: Date.now() + CURSOR_LIFETIME_MS,
      });
    }
    return {
      workspaceGeneration: identity.generation,
      entries,
      ...(nextPageCursor === undefined ? {} : { nextPageCursor }),
    };
  }

  async read(
    _owner: string,
    _sessionId: SessionId,
    cwd: string,
    params: Omit<WorkspaceReadParams, "sessionId">,
    signal?: AbortSignal,
  ): Promise<WorkspaceReadResult> {
    this.assertActive(signal);
    const identity = await this.workspaceIdentity(cwd);
    this.expectWorkspace(identity, params.ifWorkspaceGeneration);
    const path = normalizedPath(params.path, false);
    this.assertPathAllowed(identity.root, path);
    const target = await this.resolveExisting(identity, path);
    if (!target.stats.isFile()) {
      throw new WorkspaceError(
        target.stats.isDirectory() ? "not_a_file" : "unsupported_file_type",
        "Workspace path is not a regular file",
      );
    }
    if (target.stats.size > READ_SCAN_LIMIT) {
      throw new WorkspaceError("content_too_large", "File exceeds the bounded read scan limit");
    }
    const guard = await this.guardExisting(identity, path, target.stats);
    let bytes: Buffer;
    let after: Stats;
    try {
      await this.assertGuardStable(guard);
      bytes = await guard.handle.readFile();
      after = await guard.handle.stat();
      await this.assertGuardStable(guard);
    } catch (cause) {
      if (cause instanceof WorkspaceError) throw cause;
      throw this.fileError(cause, "workspace_changed", "File changed while it was read");
    } finally {
      await this.closeGuard(guard);
    }
    this.assertActive(signal);
    const afterIdentity = await this.workspaceIdentity(cwd);
    if (
      afterIdentity.generation !== identity.generation ||
      after.dev !== target.stats.dev ||
      after.ino !== target.stats.ino ||
      after.size !== target.stats.size ||
      after.mtimeMs !== target.stats.mtimeMs
    ) {
      throw new WorkspaceError("workspace_changed", "File changed while it was read");
    }
    if (bytes.includes(0)) throw new WorkspaceError("binary_file", "File contains binary data");
    const text = fatalUtf8(bytes, "invalid_encoding");
    const fileRevision = digest(`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}`, bytes);
    if (params.ifFileRevision !== undefined && params.ifFileRevision !== fileRevision) {
      throw new WorkspaceError("workspace_changed", "File revision changed");
    }
    const records = lineRecords(text);
    const startLine = params.startLine ?? 1;
    const remaining = records.slice(startLine - 1);
    const selected: string[] = [];
    let selectedBytes = 0;
    let byteLimited = false;
    for (const line of remaining.slice(0, params.maxLines)) {
      const lineBytes = Buffer.byteLength(line);
      if (selectedBytes + lineBytes > params.maxBytes) {
        byteLimited = true;
        break;
      }
      selected.push(line);
      selectedBytes += lineBytes;
    }
    const lineLimited = !byteLimited && remaining.length > selected.length;
    const truncated = byteLimited || lineLimited;
    return {
      workspaceGeneration: identity.generation,
      fileRevision,
      path,
      encoding: "utf-8",
      text: selected.join(""),
      startLine,
      endLine: startLine + selected.length - 1,
      totalLines: records.length,
      truncated,
      ...(truncated
        ? { truncationReason: byteLimited ? ("byte_limit" as const) : ("line_limit" as const) }
        : {}),
    };
  }

  async status(
    sessionId: SessionId,
    cwd: string,
    params: Omit<WorkspaceStatusParams, "sessionId">,
    signal?: AbortSignal,
  ): Promise<WorkspaceStatusResult> {
    return (await this.statusSnapshot(sessionId, cwd, params, signal)).result;
  }

  async diff(
    sessionId: SessionId,
    cwd: string,
    params: Omit<WorkspaceDiffParams, "sessionId">,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffResult> {
    const known = this.statusScopes.get(params.repositoryGeneration);
    if (known === undefined || known.sessionId !== sessionId) {
      throw new WorkspaceError(
        "repository_changed",
        "Git status changed before the diff was loaded",
      );
    }
    const snapshot = await this.statusSnapshot(sessionId, cwd, { scope: known.scope }, signal);
    const entry = snapshot.entries.get(params.entryId);
    if (
      snapshot.result.repositoryGeneration !== params.repositoryGeneration ||
      entry === undefined
    ) {
      throw new WorkspaceError(
        "repository_changed",
        "Git status changed before the diff was loaded",
      );
    }
    let patch = "";
    if (!entry.binary && !entry.submodule) {
      const args = this.diffArguments(snapshot, entry, params.contextLines);
      try {
        patch = fatalUtf8(
          (
            await runGit(snapshot.repositoryRoot, args, {
              signal,
              maxBytes: Math.min(params.maxBytes, DIFF_LIMIT) + 64 * 1024,
              allowedExitCodes: entry.area === "untracked" ? [0, 1] : [0],
            })
          ).stdout,
          "unsupported_filename_encoding",
        );
      } catch (error) {
        mapGitError(error);
      }
    }
    if (Buffer.byteLength(patch) > params.maxBytes) {
      throw new WorkspaceError("git_output_too_large", "Structured diff exceeds its byte limit");
    }
    const hunks = entry.binary || entry.submodule ? [] : parseHunks(patch);
    if (Buffer.byteLength(JSON.stringify(hunks)) > params.maxBytes) {
      throw new WorkspaceError("git_output_too_large", "Structured diff exceeds its byte limit");
    }
    const revisions = await this.diffRevisions(snapshot, entry, signal);
    const current = await this.statusSnapshot(sessionId, cwd, { scope: snapshot.scope }, signal);
    if (
      current.result.repositoryGeneration !== snapshot.result.repositoryGeneration ||
      !current.entries.has(entry.entryId)
    ) {
      throw new WorkspaceError(
        "repository_changed",
        "Repository changed while the diff was loaded",
      );
    }
    return {
      workspaceGeneration: snapshot.result.workspaceGeneration,
      repositoryGeneration: snapshot.result.repositoryGeneration,
      entry,
      ...revisions,
      hunks,
      binary: entry.binary,
    };
  }

  private async statusSnapshot(
    sessionId: SessionId,
    cwd: string,
    params: Omit<WorkspaceStatusParams, "sessionId">,
    signal?: AbortSignal,
  ): Promise<StatusSnapshot> {
    this.assertActive(signal);
    const workspace = await this.workspaceIdentity(cwd);
    this.expectWorkspace(workspace, params.ifWorkspaceGeneration);
    const repositoryRoot = await this.repositoryRoot(workspace, signal);
    const branch = await this.branch(repositoryRoot, signal);
    const sparseCheckout = await this.sparse(repositoryRoot, signal);
    const repositoryIdentity = await this.repositoryIdentity(repositoryRoot, signal);
    let checkpointId: string | undefined;
    let checkpointTree: string | undefined;
    let currentTree: string | undefined;
    let raw: Buffer;
    let indexState: Buffer = Buffer.alloc(0);
    let binary: ReadonlySet<string> = new Set<string>();
    let submodules: ReadonlySet<string> = new Set<string>();
    if (params.scope === "working") {
      try {
        raw = (
          await runGit(
            repositoryRoot,
            [
              "status",
              "--porcelain=v2",
              "--branch",
              "-z",
              "--untracked-files=all",
              "--ignore-submodules=none",
            ],
            { signal, maxBytes: STATUS_LIMIT },
          )
        ).stdout;
        const [staged, unstaged, index] = await Promise.all([
          runGit(
            repositoryRoot,
            ["diff", "--cached", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--"],
            {
              signal,
              maxBytes: STATUS_LIMIT,
            },
          ),
          runGit(
            repositoryRoot,
            ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--"],
            {
              signal,
              maxBytes: STATUS_LIMIT,
            },
          ),
          runGit(repositoryRoot, ["ls-files", "--stage", "-z", "--"], {
            signal,
            maxBytes: STATUS_LIMIT,
          }),
        ]);
        indexState = index.stdout;
        fatalUtf8(indexState, "unsupported_filename_encoding");
        binary = new Set([...parseNumstat(staged.stdout), ...parseNumstat(unstaged.stdout)]);
      } catch (error) {
        mapGitError(error);
      }
    } else {
      const checkpoint = await this.checkpoints.read(sessionId);
      checkpointId = checkpoint.checkpointId;
      checkpointTree = checkpoint.tree;
      currentTree = await this.checkpoints.currentTree(sessionId, repositoryRoot, signal);
      const context = [
        `--git-dir=${this.checkpoints.gitDirectory(sessionId)}`,
        `--work-tree=${repositoryRoot}`,
      ];
      try {
        raw = (
          await runGit(
            repositoryRoot,
            [
              ...context,
              "diff",
              "--name-status",
              "--find-renames",
              "-z",
              checkpoint.tree,
              currentTree,
              "--",
            ],
            { signal, maxBytes: STATUS_LIMIT },
          )
        ).stdout;
        const [numstat, rawStatus] = await Promise.all([
          runGit(
            repositoryRoot,
            [...context, "diff", "--numstat", "-z", checkpoint.tree, currentTree, "--"],
            { signal, maxBytes: STATUS_LIMIT },
          ),
          runGit(
            repositoryRoot,
            [
              ...context,
              "diff",
              "--raw",
              "--find-renames",
              "-z",
              checkpoint.tree,
              currentTree,
              "--",
            ],
            { signal, maxBytes: STATUS_LIMIT },
          ),
        ]);
        binary = parseNumstat(numstat.stdout);
        submodules = parseRawSubmodules(rawStatus.stdout);
      } catch (error) {
        mapGitError(error);
      }
    }
    const decoded = fatalUtf8(raw, "unsupported_filename_encoding");
    const bareEntries =
      params.scope === "working"
        ? await this.parseWorkingStatus(decoded, binary, repositoryRoot)
        : this.parseLastTurnStatus(decoded, binary, submodules);
    for (const entry of bareEntries) {
      this.assertPathAllowed(workspace.root, entry.path);
      if (entry.previousPath !== undefined)
        this.assertPathAllowed(workspace.root, entry.previousPath);
    }
    const worktreeState = await this.worktreeState(repositoryRoot, bareEntries);
    const generation = digest(
      workspace.generation,
      repositoryIdentity,
      JSON.stringify(branch),
      String(sparseCheckout),
      params.scope,
      checkpointId ?? "",
      checkpointTree ?? "",
      currentTree ?? "",
      raw,
      indexState,
      worktreeState,
      [...binary].sort().join("\0"),
    );
    if (bareEntries.length > 5_000) {
      throw new WorkspaceError("git_output_too_large", "Git status exceeds the 5000 entry limit");
    }
    const entries = bareEntries.map(
      (entry): GitStatusEntry => ({
        ...entry,
        entryId: digest(generation, JSON.stringify(entry)),
      }),
    );
    const entryMap = new Map(entries.map((entry) => [entry.entryId, entry]));
    const repositoryRelative = relative(workspace.root, repositoryRoot).split(sep).join("/");
    const result: WorkspaceStatusResult = {
      workspaceGeneration: workspace.generation,
      repositoryGeneration: generation,
      repositoryRoot: repositoryRelative,
      ...(checkpointId === undefined ? {} : { checkpointId }),
      branch,
      sparseCheckout,
      entries,
    };
    this.statusScopes.set(generation, { sessionId, scope: params.scope });
    if (this.statusScopes.size > 1_024) {
      const oldest = this.statusScopes.keys().next().value;
      if (oldest !== undefined) this.statusScopes.delete(oldest);
    }
    return {
      sessionId,
      result,
      entries: entryMap,
      repositoryRoot,
      scope: params.scope,
      ...(checkpointTree === undefined ? {} : { checkpointTree }),
      ...(currentTree === undefined ? {} : { currentTree }),
    };
  }

  private async parseWorkingStatus(
    output: string,
    binary: ReadonlySet<string>,
    repositoryRoot: string,
  ): Promise<Omit<GitStatusEntry, "entryId">[]> {
    const records = output.split("\0");
    const entries: Omit<GitStatusEntry, "entryId">[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || record.startsWith("# ") || record.startsWith("! ")) continue;
      if (record.startsWith("? ")) {
        const path = record.slice(2);
        normalizedGitPath(path);
        const isBinary = await this.fileLooksBinary(join(repositoryRoot, ...path.split("/")));
        entries.push({
          path,
          area: "untracked",
          kind: isBinary ? "binary" : "untracked",
          binary: isBinary,
          submodule: false,
        });
        continue;
      }
      if (record.startsWith("u ")) {
        const match = /^u (..) (....) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/su.exec(record);
        if (!match)
          throw new WorkspaceError("unsupported_git_state", "Cannot parse conflicted Git status");
        const path = match[3] as string;
        normalizedGitPath(path);
        entries.push({
          path,
          area: "conflict",
          kind: "conflicted",
          binary: binary.has(path),
          submodule: false,
        });
        continue;
      }
      const ordinary = /^1 (..) (....) \S+ \S+ \S+ \S+ \S+ (.*)$/su.exec(record);
      const renamed = /^2 (..) (....) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/su.exec(record);
      if (!ordinary && !renamed) {
        throw new WorkspaceError("unsupported_git_state", "Cannot parse Git status entry");
      }
      const match = ordinary ?? renamed;
      const xy = match?.[1] as string;
      const sub = match?.[2] as string;
      const path = match?.[3] as string;
      const previousPath = renamed ? records[++index] : undefined;
      normalizedGitPath(path);
      if (previousPath !== undefined) normalizedGitPath(previousPath);
      const submodule = sub.startsWith("S");
      for (const [at, area] of [
        [0, "staged"],
        [1, "unstaged"],
      ] as const) {
        const code = xy[at] as string;
        if (code === ".") continue;
        if (code === "U" || xy === "AA" || xy === "DD") {
          if (!entries.some((entry) => entry.path === path && entry.area === "conflict")) {
            entries.push({
              path,
              area: "conflict",
              kind: "conflicted",
              binary: binary.has(path),
              submodule,
            });
          }
          continue;
        }
        const isBinary = binary.has(path);
        entries.push({
          path,
          ...((code === "R" || code === "C") && previousPath !== undefined ? { previousPath } : {}),
          area,
          kind: statusKind(code, isBinary, submodule),
          binary: isBinary,
          submodule,
        });
      }
    }
    return entries.toSorted((left, right) =>
      Buffer.compare(
        Buffer.from(`${left.path}\0${left.area}`),
        Buffer.from(`${right.path}\0${right.area}`),
      ),
    );
  }

  private parseLastTurnStatus(
    output: string,
    binary: ReadonlySet<string>,
    submodules: ReadonlySet<string>,
  ): Omit<GitStatusEntry, "entryId">[] {
    const records = output.split("\0");
    const entries: Omit<GitStatusEntry, "entryId">[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const code = records[index];
      if (!code) continue;
      if (!/^[ACDMRT]/u.test(code)) {
        throw new WorkspaceError("unsupported_git_state", "Cannot parse checkpoint Git status");
      }
      let path = records[++index];
      let previousPath: string | undefined;
      if (code.startsWith("R") || code.startsWith("C")) {
        previousPath = path;
        path = records[++index];
      }
      if (!path)
        throw new WorkspaceError("unsupported_git_state", "Checkpoint status omitted a path");
      normalizedGitPath(path);
      if (previousPath !== undefined) normalizedGitPath(previousPath);
      const isBinary = binary.has(path);
      const submodule = submodules.has(path);
      entries.push({
        path,
        ...(previousPath === undefined ? {} : { previousPath }),
        area: "last-turn",
        kind: statusKind(code[0] as string, isBinary, submodule),
        binary: isBinary,
        submodule,
      });
    }
    return entries.toSorted((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    );
  }

  private async diffRevisions(
    snapshot: StatusSnapshot,
    entry: GitStatusEntry,
    signal?: AbortSignal,
  ): Promise<{ readonly oldRevision?: string; readonly newRevision?: string }> {
    const parseRevision = async (
      args: readonly string[],
      cwd = snapshot.repositoryRoot,
    ): Promise<string | undefined> => {
      try {
        const result = await runGit(cwd, args, {
          signal,
          maxBytes: 1024,
          allowedExitCodes: [0, 128],
        });
        const value = fatalUtf8(result.stdout, "unsupported_filename_encoding").trim();
        return /^[0-9a-f]{40,64}$/u.test(value) ? value : undefined;
      } catch (error) {
        mapGitError(error);
      }
    };
    const oldPath = entry.previousPath ?? entry.path;
    if (snapshot.scope === "last-turn") {
      const context = [
        `--git-dir=${this.checkpoints.gitDirectory(snapshot.sessionId)}`,
        `--work-tree=${snapshot.repositoryRoot}`,
      ];
      const [oldRevision, newRevision] = await Promise.all([
        parseRevision([...context, "rev-parse", `${snapshot.checkpointTree as string}:${oldPath}`]),
        parseRevision([...context, "rev-parse", `${snapshot.currentTree as string}:${entry.path}`]),
      ]);
      return {
        ...(oldRevision === undefined ? {} : { oldRevision }),
        ...(newRevision === undefined ? {} : { newRevision }),
      };
    }
    if (entry.area === "conflict") return {};
    const oldSpec = entry.area === "staged" ? `HEAD:${oldPath}` : `:${oldPath}`;
    const oldRevision =
      entry.area === "untracked" ? undefined : await parseRevision(["rev-parse", oldSpec]);
    let newRevision: string | undefined;
    if (entry.area === "staged") newRevision = await parseRevision(["rev-parse", `:${entry.path}`]);
    else if (entry.kind !== "deleted" && !entry.submodule) {
      newRevision = await parseRevision(["hash-object", "--no-filters", "--", entry.path]);
    }
    return {
      ...(oldRevision === undefined ? {} : { oldRevision }),
      ...(newRevision === undefined ? {} : { newRevision }),
    };
  }

  private diffArguments(
    snapshot: StatusSnapshot,
    entry: GitStatusEntry,
    contextLines: number,
  ): string[] {
    const common = [
      "diff",
      `--unified=${contextLines}`,
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
    ];
    if (snapshot.scope === "last-turn") {
      return [
        `--git-dir=${this.checkpoints.gitDirectory(snapshot.sessionId)}`,
        `--work-tree=${snapshot.repositoryRoot}`,
        ...common,
        "--find-renames",
        snapshot.checkpointTree as string,
        snapshot.currentTree as string,
        "--",
        entry.previousPath ?? entry.path,
        entry.path,
      ];
    }
    if (entry.area === "staged") return [...common, "--cached", "--", entry.path];
    if (entry.area === "untracked") {
      return [
        ...common,
        "--no-index",
        "--",
        process.platform === "win32" ? "NUL" : "/dev/null",
        entry.path,
      ];
    }
    return [...common, "--", entry.path];
  }

  private async repositoryRoot(
    workspace: WorkspaceIdentity,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const raw = (
        await runGit(workspace.root, ["rev-parse", "--show-toplevel"], {
          signal,
          maxBytes: 16 * 1024,
        })
      ).stdout;
      const root = await realpath(fatalUtf8(raw, "unsupported_filename_encoding").trim());
      if (!isWithin(workspace.root, root)) {
        throw new WorkspaceError("not_git_repository", "Repository root is outside the workspace");
      }
      return root;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (error instanceof GitExecutionError && error.code !== "git_failed") mapGitError(error);
      throw new WorkspaceError("not_git_repository", "Workspace is not a supported Git worktree", {
        cause: error,
      });
    }
  }

  private async repositoryIdentity(root: string, signal?: AbortSignal): Promise<string> {
    try {
      const [gitDirectory, commonDirectory] = await Promise.all([
        runGit(root, ["rev-parse", "--absolute-git-dir"], { signal, maxBytes: 16 * 1024 }),
        runGit(root, ["rev-parse", "--git-common-dir"], { signal, maxBytes: 16 * 1024 }),
      ]);
      const git = await realpath(
        fatalUtf8(gitDirectory.stdout, "unsupported_filename_encoding").trim(),
      );
      const commonRaw = fatalUtf8(commonDirectory.stdout, "unsupported_filename_encoding").trim();
      const common = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw));
      const [gitStat, commonStat] = await Promise.all([stat(git), stat(common)]);
      return `${git}:${gitStat.dev}:${gitStat.ino}:${common}:${commonStat.dev}:${commonStat.ino}`;
    } catch (error) {
      mapGitError(error);
    }
  }

  private async branch(
    root: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceStatusResult["branch"]> {
    try {
      const symbolic = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        signal,
        maxBytes: 16 * 1024,
        allowedExitCodes: [0, 1],
      });
      const headResult = await runGit(root, ["rev-parse", "--verify", "HEAD"], {
        signal,
        maxBytes: 16 * 1024,
        allowedExitCodes: [0, 128],
      });
      const name = fatalUtf8(symbolic.stdout, "unsupported_filename_encoding").trim();
      const head = fatalUtf8(headResult.stdout, "unsupported_filename_encoding").trim();
      if (!head) return { state: "unborn", ...(name ? { name } : {}) };
      if (!name) return { state: "detached", head };
      return { state: "branch", name, head };
    } catch (error) {
      mapGitError(error);
    }
  }

  private async sparse(root: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const result = await runGit(root, ["config", "--bool", "core.sparseCheckout"], {
        signal,
        maxBytes: 1024,
        allowedExitCodes: [0, 1],
      });
      return fatalUtf8(result.stdout, "unsupported_filename_encoding").trim() === "true";
    } catch (error) {
      mapGitError(error);
    }
  }

  private async workspaceIdentity(cwd: string): Promise<WorkspaceIdentity> {
    let root: string;
    let stats: Stats;
    try {
      root = await realpath(cwd);
      stats = await stat(root);
    } catch (cause) {
      throw new WorkspaceError("workspace_unavailable", "Workspace is unavailable", { cause });
    }
    if (!stats.isDirectory())
      throw new WorkspaceError("workspace_unavailable", "Workspace is unavailable");
    return { root, stats, generation: digest(root, `${stats.dev}:${stats.ino}`) };
  }

  private expectWorkspace(identity: WorkspaceIdentity, expected?: string): void {
    if (expected !== undefined && expected !== identity.generation) {
      throw new WorkspaceError("workspace_changed", "Workspace identity changed");
    }
  }

  private assertPathAllowed(root: string, path: string): void {
    const segments = path.split("/");
    if (
      segments.includes(".axl") ||
      segments.includes(".git") ||
      segments.some((segment) => segment === ".env" || segment.startsWith(".env."))
    ) {
      throw new WorkspaceError("path_denied", "Workspace path is protected");
    }
    const candidate = resolve(root, ...segments);
    if (
      (isWithin(root, this.dataDirectory) && isWithin(this.dataDirectory, candidate)) ||
      this.deniedPaths.some((denied) => isWithin(denied, candidate))
    ) {
      throw new WorkspaceError("path_denied", "Workspace path is protected");
    }
  }

  private async resolveExisting(
    identity: WorkspaceIdentity,
    path: string,
  ): Promise<{ readonly canonical: string; readonly stats: Stats }> {
    const segments = path === "" ? [] : path.split("/");
    let ancestor = identity.root;
    for (const segment of segments.slice(0, -1)) {
      ancestor = join(ancestor, segment);
      let info: Stats;
      try {
        info = await lstat(ancestor);
      } catch (cause) {
        throw this.fileError(cause, "not_found", "Workspace path does not exist");
      }
      if (info.isSymbolicLink()) {
        const target = await realpath(ancestor).catch((cause: unknown) => {
          throw this.fileError(cause, "not_found", "Workspace path does not exist");
        });
        if (!isWithin(identity.root, target)) {
          throw new WorkspaceError("symlink_escape", "Workspace path escapes the workspace");
        }
      }
    }
    const candidate = path === "" ? identity.root : join(identity.root, ...segments);
    let linkStats: Stats;
    try {
      linkStats = await lstat(candidate);
    } catch (cause) {
      throw this.fileError(cause, "not_found", "Workspace path does not exist");
    }
    if (linkStats.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(candidate);
      } catch (cause) {
        throw this.fileError(cause, "not_found", "Workspace path does not exist");
      }
      throw new WorkspaceError(
        isWithin(identity.root, target) ? "unsupported_file_type" : "symlink_escape",
        isWithin(identity.root, target)
          ? "Reading symbolic links is not supported"
          : "Symbolic link escapes the workspace",
      );
    }
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch (cause) {
      throw this.fileError(cause, "not_found", "Workspace path does not exist");
    }
    if (!isWithin(identity.root, canonical)) {
      throw new WorkspaceError("symlink_escape", "Workspace path escapes the workspace");
    }
    this.assertPathAllowed(identity.root, relative(identity.root, canonical).split(sep).join("/"));
    const stats = await stat(canonical);
    return { canonical, stats };
  }

  /**
   * Bind every path component to an open descriptor. A rename or replacement
   * changes the held object's ctime, so validation before and after the
   * operation detects parent-directory swaps even if the pathname is restored.
   */
  private async guardExisting(
    identity: WorkspaceIdentity,
    path: string,
    expectedTarget: Stats,
  ): Promise<GuardedPath> {
    const segments = path === "" ? [] : path.split("/");
    const paths = [
      identity.root,
      ...segments.map((_, index) => join(identity.root, ...segments.slice(0, index + 1))),
    ];
    const components: Array<{ path: string; handle: FileHandle; stats: Stats }> = [];
    try {
      for (const [index, candidate] of paths.entries()) {
        const info = await lstat(candidate).catch((cause: unknown) => {
          throw this.fileError(cause, "workspace_changed", "Workspace path changed");
        });
        if (info.isSymbolicLink()) {
          const target = await realpath(candidate).catch((cause: unknown) => {
            throw this.fileError(cause, "workspace_changed", "Workspace path changed");
          });
          throw new WorkspaceError(
            isWithin(identity.root, target) ? "unsupported_file_type" : "symlink_escape",
            isWithin(identity.root, target)
              ? "Traversing symbolic links is not supported"
              : "Workspace path escapes the workspace",
          );
        }
        const final = index === paths.length - 1;
        if (!final && !info.isDirectory()) {
          throw new WorkspaceError("workspace_changed", "Workspace parent is not a directory");
        }
        const flags =
          constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (info.isDirectory() ? constants.O_DIRECTORY : 0);
        const handle = await open(candidate, flags).catch((cause: unknown) => {
          throw this.fileError(cause, "workspace_changed", "Workspace path changed");
        });
        const opened = await handle.stat();
        if (
          opened.dev !== info.dev ||
          opened.ino !== info.ino ||
          opened.mode !== info.mode ||
          opened.ctimeMs !== info.ctimeMs
        ) {
          await handle.close();
          throw new WorkspaceError("workspace_changed", "Workspace path changed while opening");
        }
        components.push({ path: candidate, handle, stats: opened });
      }
      const handle = components.at(-1)?.handle;
      const openedTarget = components.at(-1)?.stats;
      if (
        handle === undefined ||
        openedTarget === undefined ||
        openedTarget.dev !== expectedTarget.dev ||
        openedTarget.ino !== expectedTarget.ino ||
        openedTarget.mode !== expectedTarget.mode ||
        openedTarget.ctimeMs !== expectedTarget.ctimeMs
      ) {
        throw new WorkspaceError("workspace_changed", "Workspace path changed while opening");
      }
      return { handle, components };
    } catch (error) {
      await Promise.allSettled(components.map((component) => component.handle.close()));
      throw error;
    }
  }

  private async assertGuardStable(guard: GuardedPath): Promise<void> {
    for (const component of guard.components) {
      const [opened, current] = await Promise.all([
        component.handle.stat(),
        lstat(component.path).catch((cause: unknown) => {
          throw this.fileError(cause, "workspace_changed", "Workspace path changed");
        }),
      ]);
      if (
        opened.dev !== component.stats.dev ||
        opened.ino !== component.stats.ino ||
        opened.mode !== component.stats.mode ||
        opened.mtimeMs !== component.stats.mtimeMs ||
        opened.ctimeMs !== component.stats.ctimeMs ||
        current.dev !== component.stats.dev ||
        current.ino !== component.stats.ino ||
        current.mode !== component.stats.mode ||
        current.mtimeMs !== component.stats.mtimeMs ||
        current.ctimeMs !== component.stats.ctimeMs
      ) {
        throw new WorkspaceError("workspace_changed", "Workspace path changed during access");
      }
    }
  }

  private async closeGuard(guard: GuardedPath): Promise<void> {
    for (const component of [...guard.components].reverse()) await component.handle.close();
  }

  private async worktreeState(
    root: string,
    entries: readonly Omit<GitStatusEntry, "entryId">[],
  ): Promise<string> {
    const values: string[] = [];
    for (const path of new Set(entries.map((entry) => entry.path))) {
      try {
        const info = await lstat(join(root, ...path.split("/")));
        values.push(
          `${path}:${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") values.push(`${path}:missing`);
        else throw error;
      }
    }
    return values.sort().join("\0");
  }

  private async fileLooksBinary(path: string): Promise<boolean> {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || !info.isFile()) return false;
    if (info.size > READ_SCAN_LIMIT) return true;
    const bytes = await readFile(path);
    return bytes.subarray(0, 8 * 1024).includes(0);
  }

  private assertActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new WorkspaceError("cancelled", "Workspace request was cancelled");
  }

  private fileError(cause: unknown, fallbackCode: string, message: string): WorkspaceError {
    const code = (cause as NodeJS.ErrnoException).code;
    return new WorkspaceError(code === "ENOENT" ? "not_found" : fallbackCode, message, { cause });
  }
}
