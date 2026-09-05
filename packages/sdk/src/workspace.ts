// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type {
  DiffLine,
  GitStatusEntry,
  RpcParams,
  RpcResult,
  SessionId,
  WorkspaceEntry,
  WorkspaceStatusScope,
} from "@axl/protocol";

import { AxlClientError, type AxlClient } from "./client.ts";

export const WORKSPACE_LIMITS = {
  directoryEntries: 200,
  fileLines: 2_000,
  fileBytes: 1_048_576,
  diffContextLines: 3,
  diffBytes: 4_194_304,
} as const;

export type WorkspacePresentationErrorKind =
  | "denied"
  | "unsupported"
  | "binary"
  | "invalid_encoding"
  | "missing"
  | "stale_workspace"
  | "stale_repository"
  | "unavailable"
  | "failed";

export interface WorkspacePresentationError {
  readonly kind: WorkspacePresentationErrorKind;
  readonly code: string;
  readonly message: string;
}

export interface WorkspaceDirectoryState {
  readonly path: string;
  readonly entries: readonly WorkspaceEntry[];
  readonly nextPageCursor?: string;
  readonly loading: boolean;
  readonly error?: WorkspacePresentationError;
}

export interface WorkspacePreviewState {
  readonly path: string;
  readonly loading: boolean;
  readonly result?: RpcResult<"session.workspace.read">;
  readonly error?: WorkspacePresentationError;
}

export interface WorkspaceStatusState {
  readonly scope: WorkspaceStatusScope;
  readonly loading: boolean;
  readonly result?: RpcResult<"session.workspace.status">;
  readonly error?: WorkspacePresentationError;
}

export interface WorkspaceDiffState {
  readonly entryId: string;
  readonly loading: boolean;
  readonly result?: RpcResult<"session.workspace.diff">;
  readonly error?: WorkspacePresentationError;
}

export interface WorkspaceState {
  readonly sessionId?: SessionId;
  readonly workspaceGeneration?: string;
  readonly repositoryGeneration?: string;
  readonly directories: Readonly<Record<string, WorkspaceDirectoryState>>;
  readonly previews: Readonly<Record<string, WorkspacePreviewState>>;
  readonly statuses: Readonly<Partial<Record<WorkspaceStatusScope, WorkspaceStatusState>>>;
  readonly diffs: Readonly<Record<string, WorkspaceDiffState>>;
  readonly checkpoint?: RpcResult<"session.workspace.checkpoint">;
  readonly transition?: WorkspacePresentationError;
}

export function emptyWorkspaceState(sessionId?: SessionId): WorkspaceState {
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    directories: {},
    previews: {},
    statuses: {},
    diffs: {},
  };
}

export function workspaceError(error: unknown): WorkspacePresentationError {
  const code = error instanceof AxlClientError ? error.code : "workspace_request_failed";
  const message = error instanceof Error ? error.message : "Workspace request failed";
  if (code === "path_denied" || code === "symlink_escape") return { kind: "denied", code, message };
  if (code === "binary_file") return { kind: "binary", code, message };
  if (code === "invalid_encoding" || code === "unsupported_filename_encoding") {
    return { kind: "invalid_encoding", code, message };
  }
  if (code === "not_found") return { kind: "missing", code, message };
  if (code === "workspace_changed") return { kind: "stale_workspace", code, message };
  if (code === "repository_changed") return { kind: "stale_repository", code, message };
  if (
    code === "unsupported_file_type" ||
    code === "unsupported_git_state" ||
    code === "not_git_repository" ||
    code === "git_unavailable"
  ) {
    return { kind: "unsupported", code, message };
  }
  if (code === "workspace_unavailable") return { kind: "unavailable", code, message };
  return { kind: "failed", code, message };
}

const encoder = new TextEncoder();

/** Protocol ordering is bytewise UTF-8, independent of locale. */
export function compareWorkspaceEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
  const a = encoder.encode(left.name);
  const b = encoder.encode(right.name);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

export interface UnifiedDiffRow {
  readonly kind: DiffLine["kind"];
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly prefix: " " | "+" | "-" | "\\";
  readonly text: string;
}

export interface SideBySideDiffRow {
  readonly old?: DiffLine;
  readonly new?: DiffLine;
}

export function projectUnifiedDiff(lines: readonly DiffLine[]): readonly UnifiedDiffRow[] {
  return lines.map((line) => ({
    kind: line.kind,
    ...(line.oldLine === undefined ? {} : { oldLine: line.oldLine }),
    ...(line.newLine === undefined ? {} : { newLine: line.newLine }),
    prefix:
      line.kind === "addition"
        ? "+"
        : line.kind === "deletion"
          ? "-"
          : line.kind === "marker"
            ? "\\"
            : " ",
    text: line.text,
  }));
}

/** Pairs contiguous deletion and addition runs without changing daemon-provided content. */
export function projectSideBySideDiff(lines: readonly DiffLine[]): readonly SideBySideDiffRow[] {
  const rows: SideBySideDiffRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.kind !== "deletion") {
      rows.push(line.kind === "addition" ? { new: line } : { old: line, new: line });
      index += 1;
      continue;
    }
    const deleted: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (lines[index]?.kind === "deletion") deleted.push(lines[index++] as DiffLine);
    while (lines[index]?.kind === "addition") added.push(lines[index++] as DiffLine);
    const count = Math.max(deleted.length, added.length);
    for (let pair = 0; pair < count; pair += 1) {
      rows.push({
        ...(deleted[pair] === undefined ? {} : { old: deleted[pair] }),
        ...(added[pair] === undefined ? {} : { new: added[pair] }),
      });
    }
  }
  return rows;
}

interface WorkspaceRequester {
  request<
    Method extends
      | "session.workspace.list"
      | "session.workspace.read"
      | "session.workspace.status"
      | "session.workspace.diff"
      | "session.workspace.checkpoint",
  >(method: Method, params: RpcParams<Method>): Promise<RpcResult<Method>>;
}

/** Reusable generation-aware cache over the public session-scoped workspace RPCs. */
export class SessionWorkspace {
  private stateValue: WorkspaceState;
  private epoch = 0;
  private readonly client: WorkspaceRequester;
  private readonly onChange: ((state: WorkspaceState) => void) | undefined;

  constructor(
    client: Pick<AxlClient, "request">,
    sessionId: SessionId,
    onChange?: (state: WorkspaceState) => void,
  ) {
    this.client = client as WorkspaceRequester;
    this.stateValue = emptyWorkspaceState(sessionId);
    this.onChange = onChange;
  }

  get state(): WorkspaceState {
    return this.stateValue;
  }

  clear(): void {
    this.epoch += 1;
    this.replace(emptyWorkspaceState());
  }

  async refresh(): Promise<void> {
    const sessionId = this.requireSession();
    this.epoch += 1;
    this.replace(emptyWorkspaceState(sessionId));
    await this.list("", false);
    await Promise.all([this.status("working"), this.status("last-turn")]);
  }

  async list(path: string, nextPage = false): Promise<void> {
    const sessionId = this.requireSession();
    const current = this.stateValue.directories[path];
    const epoch = this.epoch;
    this.setDirectory(path, {
      path,
      entries: current?.entries ?? [],
      loading: true,
      ...(nextPage && current?.nextPageCursor !== undefined
        ? { nextPageCursor: current.nextPageCursor }
        : {}),
    });
    try {
      const result = await this.client.request("session.workspace.list", {
        sessionId,
        path,
        pageSize: WORKSPACE_LIMITS.directoryEntries,
        ...(nextPage && current?.nextPageCursor !== undefined
          ? { pageCursor: current.nextPageCursor }
          : {}),
        ...(this.stateValue.workspaceGeneration === undefined
          ? {}
          : { ifWorkspaceGeneration: this.stateValue.workspaceGeneration }),
      });
      if (epoch !== this.epoch) return;
      this.acceptWorkspaceGeneration(result.workspaceGeneration);
      const prior = nextPage ? (this.stateValue.directories[path]?.entries ?? []) : [];
      const entries = [
        ...prior,
        ...result.entries.filter((entry) => !prior.some((item) => item.path === entry.path)),
      ].sort(compareWorkspaceEntries);
      this.setDirectory(path, {
        path,
        entries,
        loading: false,
        ...(result.nextPageCursor === undefined ? {} : { nextPageCursor: result.nextPageCursor }),
      });
    } catch (error) {
      if (epoch !== this.epoch) return;
      const presentation = this.handleError(error);
      this.setDirectory(path, { path, entries: [], loading: false, error: presentation });
      throw error;
    }
  }

  async read(path: string): Promise<void> {
    const sessionId = this.requireSession();
    const current = this.stateValue.previews[path];
    const epoch = this.epoch;
    this.setPreview(path, {
      path,
      loading: true,
      ...(current?.result === undefined ? {} : { result: current.result }),
    });
    try {
      const result = await this.client.request("session.workspace.read", {
        sessionId,
        path,
        maxLines: WORKSPACE_LIMITS.fileLines,
        maxBytes: WORKSPACE_LIMITS.fileBytes,
        ...(this.stateValue.workspaceGeneration === undefined
          ? {}
          : { ifWorkspaceGeneration: this.stateValue.workspaceGeneration }),
        ...(current?.result?.fileRevision === undefined
          ? {}
          : { ifFileRevision: current.result.fileRevision }),
      });
      if (epoch !== this.epoch) return;
      this.acceptWorkspaceGeneration(result.workspaceGeneration);
      this.setPreview(path, { path, loading: false, result });
    } catch (error) {
      if (epoch !== this.epoch) return;
      const presentation = this.handleError(error);
      this.setPreview(path, { path, loading: false, error: presentation });
      throw error;
    }
  }

  async status(scope: WorkspaceStatusScope): Promise<void> {
    const sessionId = this.requireSession();
    const epoch = this.epoch;
    this.setStatus(scope, { scope, loading: true });
    try {
      const result = await this.client.request("session.workspace.status", {
        sessionId,
        scope,
        ...(this.stateValue.workspaceGeneration === undefined
          ? {}
          : { ifWorkspaceGeneration: this.stateValue.workspaceGeneration }),
      });
      if (epoch !== this.epoch) return;
      this.acceptWorkspaceGeneration(result.workspaceGeneration);
      this.acceptRepositoryGeneration(result.repositoryGeneration);
      this.setStatus(scope, { scope, loading: false, result });
    } catch (error) {
      if (epoch !== this.epoch) return;
      const presentation = this.handleError(error);
      this.setStatus(scope, { scope, loading: false, error: presentation });
      throw error;
    }
  }

  async diff(entry: GitStatusEntry): Promise<void> {
    const sessionId = this.requireSession();
    const repositoryGeneration = this.stateValue.repositoryGeneration;
    if (repositoryGeneration === undefined)
      throw new AxlClientError("repository_changed", "Refresh Changes before opening a diff");
    const epoch = this.epoch;
    this.setDiff(entry.entryId, { entryId: entry.entryId, loading: true });
    try {
      const result = await this.client.request("session.workspace.diff", {
        sessionId,
        entryId: entry.entryId,
        contextLines: WORKSPACE_LIMITS.diffContextLines,
        repositoryGeneration,
        maxBytes: WORKSPACE_LIMITS.diffBytes,
      });
      if (epoch !== this.epoch) return;
      this.acceptWorkspaceGeneration(result.workspaceGeneration);
      this.acceptRepositoryGeneration(result.repositoryGeneration);
      this.setDiff(entry.entryId, { entryId: entry.entryId, loading: false, result });
    } catch (error) {
      if (epoch !== this.epoch) return;
      const presentation = this.handleError(error);
      this.setDiff(entry.entryId, { entryId: entry.entryId, loading: false, error: presentation });
      throw error;
    }
  }

  async checkpoint(enabled: boolean): Promise<void> {
    const result = await this.client.request("session.workspace.checkpoint", {
      sessionId: this.requireSession(),
      enabled,
    });
    this.replace({ ...this.stateValue, checkpoint: result });
  }

  private acceptWorkspaceGeneration(generation: string): void {
    const previous = this.stateValue.workspaceGeneration;
    if (previous !== undefined && previous !== generation) {
      const sessionId = this.requireSession();
      this.epoch += 1;
      this.stateValue = {
        ...emptyWorkspaceState(sessionId),
        workspaceGeneration: generation,
        transition: {
          kind: "stale_workspace",
          code: "workspace_changed",
          message: "Workspace changed. Cached files and changes were replaced.",
        },
      };
      return;
    }
    this.stateValue = { ...this.stateValue, workspaceGeneration: generation };
  }

  private acceptRepositoryGeneration(generation: string): void {
    const previous = this.stateValue.repositoryGeneration;
    if (previous !== undefined && previous !== generation) {
      this.stateValue = {
        ...this.stateValue,
        repositoryGeneration: generation,
        statuses: {},
        diffs: {},
        transition: {
          kind: "stale_repository",
          code: "repository_changed",
          message: "Repository changed. Cached Changes and diffs were replaced.",
        },
      };
      return;
    }
    this.stateValue = { ...this.stateValue, repositoryGeneration: generation };
  }

  private handleError(error: unknown): WorkspacePresentationError {
    const presentation = workspaceError(error);
    if (presentation.kind === "stale_workspace") {
      const sessionId = this.requireSession();
      this.epoch += 1;
      this.stateValue = { ...emptyWorkspaceState(sessionId), transition: presentation };
    } else if (presentation.kind === "stale_repository") {
      const { repositoryGeneration, ...workspace } = this.stateValue;
      void repositoryGeneration;
      this.stateValue = { ...workspace, statuses: {}, diffs: {}, transition: presentation };
    }
    return presentation;
  }

  private requireSession(): SessionId {
    if (this.stateValue.sessionId === undefined)
      throw new AxlClientError("workspace_unavailable", "No session workspace is selected");
    return this.stateValue.sessionId;
  }

  private setDirectory(path: string, value: WorkspaceDirectoryState): void {
    this.replace({
      ...this.stateValue,
      directories: { ...this.stateValue.directories, [path]: value },
    });
  }

  private setPreview(path: string, value: WorkspacePreviewState): void {
    this.replace({ ...this.stateValue, previews: { ...this.stateValue.previews, [path]: value } });
  }

  private setStatus(scope: WorkspaceStatusScope, value: WorkspaceStatusState): void {
    this.replace({ ...this.stateValue, statuses: { ...this.stateValue.statuses, [scope]: value } });
  }

  private setDiff(entryId: string, value: WorkspaceDiffState): void {
    this.replace({ ...this.stateValue, diffs: { ...this.stateValue.diffs, [entryId]: value } });
  }

  private replace(state: WorkspaceState): void {
    this.stateValue = state;
    this.onChange?.(state);
  }
}
