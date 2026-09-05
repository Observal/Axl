// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  emptyWorkspaceState,
  parseSessionId,
  type GitStatusEntry,
  type WorkspacePresentationError,
  type WorkspaceState,
} from "@axl/sdk";

import type { ApplicationShell } from "../dist/shell.js";
import {
  DiffPreview,
  FilePreview,
  openReusableTab,
  WorkspaceErrorState,
  WorkspacePresentation,
} from "../dist/workspace.js";

const entries: readonly GitStatusEntry[] = [
  {
    entryId: "added",
    path: "<added>.ts",
    area: "staged",
    kind: "added",
    binary: false,
    submodule: false,
  },
  {
    entryId: "modified",
    path: "modified.ts",
    area: "unstaged",
    kind: "modified",
    binary: false,
    submodule: false,
  },
  {
    entryId: "deleted",
    path: "deleted.ts",
    area: "unstaged",
    kind: "deleted",
    binary: false,
    submodule: false,
  },
  {
    entryId: "renamed",
    path: "renamed.ts",
    previousPath: "old.ts",
    area: "staged",
    kind: "renamed",
    binary: false,
    submodule: false,
  },
  {
    entryId: "conflict",
    path: "conflict.ts",
    area: "conflict",
    kind: "conflicted",
    binary: false,
    submodule: false,
  },
  {
    entryId: "binary",
    path: "asset.bin",
    area: "untracked",
    kind: "binary",
    binary: true,
    submodule: false,
  },
  {
    entryId: "submodule",
    path: "vendor",
    area: "last-turn",
    kind: "submodule",
    binary: false,
    submodule: true,
  },
];

function entry(index: number): GitStatusEntry {
  const value = entries[index];
  if (value === undefined) throw new Error(`Missing fixture entry ${index}`);
  return value;
}

function fixtureState(): WorkspaceState {
  return {
    ...emptyWorkspaceState(parseSessionId("123e4567-e89b-42d3-a456-426614174000")),
    workspaceGeneration: "workspace-1",
    repositoryGeneration: "repository-1",
    directories: {
      "": {
        path: "",
        loading: false,
        entries: [
          { path: "safe.ts", name: "safe.ts", type: "file", sizeBytes: 10 },
          { path: "link", name: "link", type: "symlink", linkTargetType: "outside_workspace" },
          { path: "socket", name: "socket", type: "other" },
        ],
      },
    },
    previews: {
      "safe.ts": {
        path: "safe.ts",
        loading: false,
        result: {
          workspaceGeneration: "workspace-1",
          fileRevision: "file-1",
          path: "safe.ts",
          encoding: "utf-8",
          text: "<script>alert('file')</script>\n",
          startLine: 1,
          endLine: 1,
          totalLines: 10,
          truncated: true,
          truncationReason: "line_limit",
        },
      },
    },
    statuses: {
      working: {
        scope: "working",
        loading: false,
        result: {
          workspaceGeneration: "workspace-1",
          repositoryGeneration: "repository-1",
          repositoryRoot: "",
          branch: { state: "unborn" },
          sparseCheckout: true,
          entries: entries.filter((entry) => entry.area !== "last-turn"),
        },
      },
      "last-turn": {
        scope: "last-turn",
        loading: false,
        result: {
          workspaceGeneration: "workspace-1",
          repositoryGeneration: "repository-1",
          repositoryRoot: "",
          checkpointId: "checkpoint-1",
          branch: { state: "unborn" },
          sparseCheckout: true,
          entries: entries.filter((entry) => entry.area === "last-turn"),
        },
      },
    },
    diffs: {
      modified: {
        entryId: "modified",
        loading: false,
        result: {
          workspaceGeneration: "workspace-1",
          repositoryGeneration: "repository-1",
          entry: entry(1),
          hunks: [
            {
              header: "@@ <unsafe> @@",
              lines: [
                { kind: "deletion", oldLine: 1, text: "<old>" },
                { kind: "addition", newLine: 1, text: "<script>new</script>" },
              ],
            },
          ],
          binary: false,
        },
      },
      binary: {
        entryId: "binary",
        loading: false,
        result: {
          workspaceGeneration: "workspace-1",
          repositoryGeneration: "repository-1",
          entry: entry(5),
          hunks: [],
          binary: true,
        },
      },
      submodule: {
        entryId: "submodule",
        loading: false,
        result: {
          workspaceGeneration: "workspace-1",
          repositoryGeneration: "repository-1",
          entry: entry(6),
          hunks: [],
          binary: false,
        },
      },
    },
  };
}

const shell = {
  supports: () => true,
  refreshWorkspace: async () => undefined,
  listWorkspace: async () => undefined,
  readWorkspaceFile: async () => undefined,
  loadWorkspaceDiff: async () => undefined,
  configureWorkspaceCheckpoint: async () => undefined,
} as unknown as ApplicationShell;

test("Explorer and Changes render explicit repository, link, and change states as text", () => {
  const html = renderToStaticMarkup(
    createElement(WorkspacePresentation, {
      shell,
      workspace: fixtureState(),
      sessionId: "session-1",
    }),
  );
  for (const label of [
    "symlink",
    "outside_workspace",
    "preview unsupported",
    "staged",
    "unstaged",
    "untracked",
    "conflict",
    "last-turn",
    "added",
    "modified",
    "deleted",
    "renamed",
    "conflicted",
    "binary",
    "submodule",
    "unborn",
    "Sparse checkout",
    "enabled",
  ]) {
    assert.match(html, new RegExp(label));
  }
  assert.doesNotMatch(html, /<added>/);
  assert.match(html, /&lt;added&gt;/);
});

test("file and structured diff previews are bounded read-only escaped text", () => {
  const state = fixtureState();
  const file = renderToStaticMarkup(
    createElement(FilePreview, { workspace: state, path: "safe.ts" }),
  );
  assert.match(file, /read-only/);
  assert.match(file, /Preview truncated by line limit/);
  assert.doesNotMatch(file, /<script>/);
  assert.match(file, /&lt;script&gt;/);

  for (const layout of ["unified", "side-by-side"] as const) {
    const diff = renderToStaticMarkup(
      createElement(DiffPreview, {
        workspace: state,
        entry: entry(1),
        layout,
        onLayout: () => undefined,
      }),
    );
    assert.match(diff, /modified/);
    assert.match(diff, /&lt;script&gt;new&lt;\/script&gt;/);
    assert.doesNotMatch(diff, /<script>/);
  }
  assert.match(
    renderToStaticMarkup(
      createElement(DiffPreview, {
        workspace: state,
        entry: entry(5),
        layout: "unified",
        onLayout: () => undefined,
      }),
    ),
    /Binary content has no textual hunks/,
  );
  assert.match(
    renderToStaticMarkup(
      createElement(DiffPreview, {
        workspace: state,
        entry: entry(6),
        layout: "unified",
        onLayout: () => undefined,
      }),
    ),
    /Submodule change/,
  );
});

test("all explicit workspace errors and reusable pinned preview behavior remain visible", () => {
  const errors: readonly WorkspacePresentationError[] = [
    { kind: "denied", code: "path_denied", message: "denied" },
    { kind: "unsupported", code: "unsupported_file_type", message: "unsupported" },
    { kind: "binary", code: "binary_file", message: "binary" },
    { kind: "invalid_encoding", code: "invalid_encoding", message: "encoding" },
    { kind: "missing", code: "not_found", message: "missing" },
    { kind: "stale_workspace", code: "workspace_changed", message: "workspace stale" },
    { kind: "stale_repository", code: "repository_changed", message: "repository stale" },
  ];
  const html = errors
    .map((error) => renderToStaticMarkup(createElement(WorkspaceErrorState, { error })))
    .join("\n");
  for (const label of [
    "Access denied",
    "Unsupported",
    "Binary file",
    "Invalid filename or file encoding",
    "Missing",
    "Stale workspace generation",
    "Stale repository generation",
  ])
    assert.match(html, new RegExp(label));

  const pinned = { type: "file" as const, key: "file:a", path: "a", pinned: true };
  const transient = { type: "file" as const, key: "file:b", path: "b", pinned: false };
  const replacement = { type: "file" as const, key: "file:c", path: "c", pinned: false };
  assert.deepEqual(openReusableTab([pinned, transient], replacement), [pinned, replacement]);
  assert.deepEqual(openReusableTab([pinned], pinned), [pinned]);
});
