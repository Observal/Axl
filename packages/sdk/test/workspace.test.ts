// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { parseSessionId, type RpcMethod, type RpcParams, type RpcResult } from "@axl/protocol";
import {
  AxlClientError,
  compareWorkspaceEntries,
  projectSideBySideDiff,
  projectUnifiedDiff,
  SessionWorkspace,
  WORKSPACE_LIMITS,
} from "../src/index.ts";
import type { AxlClient } from "../src/client.ts";

const sessionId = parseSessionId("123e4567-e89b-42d3-a456-426614174000");

class FakeWorkspaceClient {
  readonly calls: { readonly method: RpcMethod; readonly params: unknown }[] = [];
  workspaceGeneration = "workspace-1";
  repositoryGeneration = "repository-1";
  error: Error | undefined;

  async request<Method extends RpcMethod>(
    method: Method,
    params: RpcParams<Method>,
  ): Promise<RpcResult<Method>> {
    this.calls.push({ method, params });
    if (this.error !== undefined) {
      const error = this.error;
      this.error = undefined;
      throw error;
    }
    let result: unknown;
    if (method === "session.workspace.list") {
      result = {
        workspaceGeneration: this.workspaceGeneration,
        entries: [
          { path: "z", name: "z", type: "file" },
          { path: "A", name: "A", type: "directory" },
          { path: "é", name: "é", type: "symlink", linkTargetType: "outside_workspace" },
        ],
        nextPageCursor: "next-page",
      };
    } else if (method === "session.workspace.read") {
      result = {
        workspaceGeneration: this.workspaceGeneration,
        fileRevision: "file-1",
        path: "z",
        encoding: "utf-8",
        text: "safe <script>text</script>\n",
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: true,
        truncationReason: "byte_limit",
      };
    } else if (method === "session.workspace.status") {
      result = {
        workspaceGeneration: this.workspaceGeneration,
        repositoryGeneration: this.repositoryGeneration,
        repositoryRoot: "",
        branch: { state: "detached", head: "abc" },
        sparseCheckout: true,
        entries: [
          {
            entryId: "entry-1",
            path: "z",
            area: "unstaged",
            kind: "modified",
            binary: false,
            submodule: false,
          },
        ],
      };
    } else if (method === "session.workspace.diff") {
      result = {
        workspaceGeneration: this.workspaceGeneration,
        repositoryGeneration: this.repositoryGeneration,
        entry: {
          entryId: "entry-1",
          path: "z",
          area: "unstaged",
          kind: "modified",
          binary: false,
          submodule: false,
        },
        hunks: [
          {
            header: "@@ -1 +1 @@",
            lines: [
              { kind: "deletion", oldLine: 1, text: "old" },
              { kind: "addition", newLine: 1, text: "new" },
            ],
          },
        ],
        binary: false,
      };
    } else if (method === "session.workspace.checkpoint") {
      result = { enabled: true, checkpointId: "checkpoint-1" };
    } else {
      throw new Error(`Unexpected method ${method}`);
    }
    return result as RpcResult<Method>;
  }
}

function workspace(client: FakeWorkspaceClient): SessionWorkspace {
  return new SessionWorkspace(client as unknown as Pick<AxlClient, "request">, sessionId);
}

test("workspace projection uses bounded session-scoped requests and deterministic ordering", async () => {
  const client = new FakeWorkspaceClient();
  const projection = workspace(client);
  await projection.list("");
  await projection.read("z");
  await projection.status("working");
  const entry = projection.state.statuses.working?.result?.entries[0];
  assert.ok(entry);
  await projection.diff(entry);
  await projection.checkpoint(true);

  assert.deepEqual(
    projection.state.directories[""]?.entries.map((item) => item.name),
    ["A", "z", "é"],
  );
  assert.equal(projection.state.previews.z?.result?.truncated, true);
  assert.equal(projection.state.statuses.working?.result?.branch.state, "detached");
  assert.equal(projection.state.diffs["entry-1"]?.result?.repositoryGeneration, "repository-1");
  assert.equal(projection.state.checkpoint?.enabled, true);
  assert.deepEqual(
    client.calls.map((call) => call.method),
    [
      "session.workspace.list",
      "session.workspace.read",
      "session.workspace.status",
      "session.workspace.diff",
      "session.workspace.checkpoint",
    ],
  );
  assert.deepEqual(client.calls[0]?.params, {
    sessionId,
    path: "",
    pageSize: WORKSPACE_LIMITS.directoryEntries,
  });
  assert.equal("root" in (client.calls[0]?.params as object), false);
  assert.equal("gitArgs" in (client.calls[3]?.params as object), false);
  assert.equal("revision" in (client.calls[3]?.params as object), false);
});

test("stale generations replace workspace and repository caches safely", async () => {
  const client = new FakeWorkspaceClient();
  const projection = workspace(client);
  await projection.list("");
  await projection.read("z");
  await projection.status("working");
  assert.ok(projection.state.previews.z);

  client.error = new AxlClientError("workspace_changed", "root replaced");
  await assert.rejects(projection.list(""), /root replaced/);
  assert.equal(Object.keys(projection.state.previews).length, 0);
  assert.equal(Object.keys(projection.state.statuses).length, 0);
  assert.equal(projection.state.transition?.kind, "stale_workspace");

  await projection.status("working");
  const entry = projection.state.statuses.working?.result?.entries[0];
  assert.ok(entry);
  await projection.diff(entry);
  client.error = new AxlClientError("repository_changed", "index replaced");
  await assert.rejects(projection.diff(entry), /index replaced/);
  assert.equal(projection.state.diffs["entry-1"]?.error?.kind, "stale_repository");
  assert.equal(Object.keys(projection.state.statuses).length, 0);
  assert.equal(projection.state.transition?.kind, "stale_repository");

  projection.clear();
  assert.equal(projection.state.sessionId, undefined);
  assert.deepEqual(projection.state.directories, {});
});

test("diff layout projections preserve structured lines deterministically", () => {
  const lines = [
    { kind: "context" as const, oldLine: 1, newLine: 1, text: "same" },
    { kind: "deletion" as const, oldLine: 2, text: "old one" },
    { kind: "deletion" as const, oldLine: 3, text: "old two" },
    { kind: "addition" as const, newLine: 2, text: "new" },
    { kind: "marker" as const, text: "No newline" },
  ];
  assert.deepEqual(
    projectUnifiedDiff(lines).map((line) => line.prefix),
    [" ", "-", "-", "+", "\\"],
  );
  assert.deepEqual(projectSideBySideDiff(lines), [
    { old: lines[0], new: lines[0] },
    { old: lines[1], new: lines[3] },
    { old: lines[2] },
    { old: lines[4], new: lines[4] },
  ]);
  const entries = [
    { path: "é", name: "é", type: "file" as const },
    { path: "z", name: "z", type: "file" as const },
  ];
  const first = entries[0];
  const second = entries[1];
  assert.ok(first && second);
  assert.ok(compareWorkspaceEntries(first, second) > 0);
});
