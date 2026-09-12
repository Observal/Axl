// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  AxlClientError,
  parseSessionId,
  type AxlClient,
  WorkspaceController,
} from "../src/index.ts";

const sessionId = parseSessionId("00000000-0000-4000-8000-000000000001");

test("workspace controller carries generations through reads and reviews", async () => {
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const client = {
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "session.workspace.list") {
        return { workspaceGeneration: "workspace-1", entries: [] };
      }
      if (method === "session.workspace.read") {
        const startLine = (params as { readonly startLine: number }).startLine;
        return {
          workspaceGeneration: "workspace-1",
          fileRevision: "file-1",
          path: "README.md",
          encoding: "utf-8",
          text: "Axl\n",
          startLine,
          endLine: startLine,
          totalLines: 2,
          truncated: false,
        };
      }
      if (method === "session.workspace.status") {
        return {
          workspaceGeneration: "workspace-1",
          repositoryGeneration: "repository-1",
          repositoryRoot: "",
          checkpointId: "checkpoint-1",
          branch: { state: "branch", name: "main", head: "abc" },
          sparseCheckout: false,
          entries: [
            {
              entryId: "entry-1",
              path: "README.md",
              area: "last-turn",
              kind: "modified",
              binary: false,
              submodule: false,
            },
          ],
        };
      }
      if (method === "session.workspace.diff") {
        return {
          workspaceGeneration: "workspace-1",
          repositoryGeneration: "repository-1",
          entry: {
            entryId: "entry-1",
            path: "README.md",
            area: "last-turn",
            kind: "modified",
            binary: false,
            submodule: false,
          },
          hunks: [],
          binary: false,
        };
      }
      if (method === "session.workspace.checkpoint") {
        return { enabled: true, checkpointId: "checkpoint-1" };
      }
      throw new Error(`Unexpected request ${method}`);
    },
  } as unknown as AxlClient;
  const workspace = new WorkspaceController(client, sessionId);

  await workspace.list("");
  await workspace.read("README.md");
  await workspace.read("README.md", 2, "file-1");
  const review = await workspace.review("last-turn");
  assert.equal(review.status.checkpointId, "checkpoint-1");
  assert.deepEqual(await workspace.checkpoint(true), {
    enabled: true,
    checkpointId: "checkpoint-1",
  });
  assert.deepEqual(requests, [
    {
      method: "session.workspace.list",
      params: { sessionId, path: "", pageSize: 200 },
    },
    {
      method: "session.workspace.read",
      params: {
        sessionId,
        path: "README.md",
        startLine: 1,
        maxLines: 2_000,
        maxBytes: 1024 * 1024,
        ifWorkspaceGeneration: "workspace-1",
      },
    },
    {
      method: "session.workspace.read",
      params: {
        sessionId,
        path: "README.md",
        startLine: 2,
        maxLines: 2_000,
        maxBytes: 1024 * 1024,
        ifWorkspaceGeneration: "workspace-1",
        ifFileRevision: "file-1",
      },
    },
    {
      method: "session.workspace.status",
      params: {
        sessionId,
        scope: "last-turn",
        ifWorkspaceGeneration: "workspace-1",
      },
    },
    {
      method: "session.workspace.diff",
      params: {
        sessionId,
        entryId: "entry-1",
        contextLines: 3,
        repositoryGeneration: "repository-1",
        maxBytes: 512 * 1024,
      },
    },
    {
      method: "session.workspace.checkpoint",
      params: { sessionId, enabled: true },
    },
  ]);
});

test("workspace controller rejects inconsistent response generations and can reset", async () => {
  let generation = "workspace-1";
  const client = {
    request: async () => ({ workspaceGeneration: generation, entries: [] }),
  } as unknown as AxlClient;
  const workspace = new WorkspaceController(client, sessionId);

  await workspace.list("");
  generation = "workspace-2";
  await assert.rejects(
    workspace.list("src"),
    (error) => error instanceof AxlClientError && error.code === "workspace_changed",
  );
  workspace.reset();
  assert.equal((await workspace.list("src")).workspaceGeneration, "workspace-2");
});
