// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  SessionId,
  WorkspaceDiffResult,
  WorkspaceListResult,
  WorkspaceReadResult,
  WorkspaceStatusResult,
  WorkspaceStatusScope,
} from "@axl/protocol";

import { AxlClientError, type AxlClient } from "./client.ts";

const PAGE_SIZE = 200;
const READ_LINES = 2_000;
const READ_BYTES = 1024 * 1024;
const DIFF_BYTES = 512 * 1024;

export interface WorkspaceReviewSnapshot {
  readonly status: WorkspaceStatusResult;
  readonly diffs: readonly WorkspaceDiffResult[];
  readonly truncated?: boolean;
}

export interface WorkspaceOperations {
  reset(): void;
  list(path: string, pageCursor?: string): Promise<WorkspaceListResult>;
  read(path: string, startLine?: number, fileRevision?: string): Promise<WorkspaceReadResult>;
  review(scope: WorkspaceStatusScope): Promise<WorkspaceReviewSnapshot>;
  checkpoint(
    enabled: boolean,
  ): Promise<{ readonly enabled: boolean; readonly checkpointId?: string }>;
}

/** Keeps one session's bounded workspace reads on a consistent daemon generation. */
export class WorkspaceController implements WorkspaceOperations {
  private readonly client: AxlClient;
  private readonly sessionId: SessionId;
  private workspaceGeneration: string | undefined;

  constructor(client: AxlClient, sessionId: SessionId) {
    this.client = client;
    this.sessionId = sessionId;
  }

  reset(): void {
    this.workspaceGeneration = undefined;
  }

  async list(path: string, pageCursor?: string): Promise<WorkspaceListResult> {
    const result = await this.client.request("session.workspace.list", {
      sessionId: this.sessionId,
      path,
      pageSize: PAGE_SIZE,
      ...(pageCursor === undefined ? {} : { pageCursor }),
      ...(this.workspaceGeneration === undefined
        ? {}
        : { ifWorkspaceGeneration: this.workspaceGeneration }),
    });
    this.acceptGeneration(result.workspaceGeneration);
    return result;
  }

  async read(path: string, startLine = 1, fileRevision?: string): Promise<WorkspaceReadResult> {
    const result = await this.client.request("session.workspace.read", {
      sessionId: this.sessionId,
      path,
      startLine,
      maxLines: READ_LINES,
      maxBytes: READ_BYTES,
      ...(this.workspaceGeneration === undefined
        ? {}
        : { ifWorkspaceGeneration: this.workspaceGeneration }),
      ...(fileRevision === undefined ? {} : { ifFileRevision: fileRevision }),
    });
    this.acceptGeneration(result.workspaceGeneration);
    return result;
  }

  async review(scope: WorkspaceStatusScope): Promise<WorkspaceReviewSnapshot> {
    const status = await this.client.request("session.workspace.status", {
      sessionId: this.sessionId,
      scope,
      ...(this.workspaceGeneration === undefined
        ? {}
        : { ifWorkspaceGeneration: this.workspaceGeneration }),
    });
    this.acceptGeneration(status.workspaceGeneration);
    const diffs: WorkspaceDiffResult[] = [];
    for (const entry of status.entries.slice(0, 100)) {
      const diff = await this.client.request("session.workspace.diff", {
        sessionId: this.sessionId,
        entryId: entry.entryId,
        contextLines: 3,
        repositoryGeneration: status.repositoryGeneration,
        maxBytes: DIFF_BYTES,
      });
      this.acceptGeneration(diff.workspaceGeneration);
      diffs.push(diff);
    }
    return {
      status,
      diffs,
      ...(status.entries.length > diffs.length ? { truncated: true } : {}),
    };
  }

  checkpoint(
    enabled: boolean,
  ): Promise<{ readonly enabled: boolean; readonly checkpointId?: string }> {
    return this.client.request("session.workspace.checkpoint", {
      sessionId: this.sessionId,
      enabled,
    });
  }

  private acceptGeneration(generation: string): void {
    if (this.workspaceGeneration !== undefined && this.workspaceGeneration !== generation) {
      throw new AxlClientError(
        "workspace_changed",
        "The workspace changed. Refresh it before continuing.",
      );
    }
    this.workspaceGeneration = generation;
  }
}
