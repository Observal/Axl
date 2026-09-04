<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Workspace and Git RPC specification

Status: workspace specification supporting [the local web client architecture](web-client.md)

## Scope

This document defines the daemon API for read-only Explorer, file tabs, Git status and diffs, plus daemon-owned last-turn checkpoint configuration.

## Invariants

- Every request is bound to a daemon-owned session and its canonical workspace.
- The browser never supplies an absolute root or executes filesystem or Git operations.
- The daemon canonicalizes paths and applies policy before access.
- Responses are bounded and explicitly report truncation or rejection.
- Git is invoked without a shell or client-supplied arguments.
- Workspace and repository generations detect inconsistent views.

## Methods

```text
session.workspace.list
session.workspace.read
session.workspace.status
session.workspace.diff
session.workspace.checkpoint
```

List, read, status, and diff are read-only feature capabilities. Checkpoint configuration is a daemon-owned session operation. None grants model tools or changes the session profile.

Wire version 7 provides batch `session.workspace.diff` results for working and last-turn review. Wire version 8 preserves checkpoint capture but replaces that batch result with status plus per-entry diff so the TUI and web app use one generation-checked contract. The TUI migrates through `packages/sdk`; no version-7 compatibility shim remains.

## Workspace identity and path policy

Every method includes `sessionId`. The daemon resolves the root from that session's canonical `cwd` and recorded worktree identity. A client cannot select a different root.

Paths use normalized forward-slash workspace-relative form. The empty string identifies the root where allowed. Reject:

- absolute paths
- drive and UNC prefixes
- NUL bytes
- empty internal segments
- `.` and `..` segments
- backslash separators
- non-normalized equivalent forms

The daemon resolves the candidate against the canonical root, canonicalizes existing ancestors and the final object as appropriate, and then applies policy. It rejects:

- symlink escapes
- protected Axl configuration, credential, and session paths
- configured secret and denied files
- unsupported special-file traversal
- repository roots outside the authorized workspace

Lexical containment alone is not sufficient.

## Filename representation

Protocol paths are Unicode JSON strings containing valid UTF-8. On filesystems that permit names with invalid UTF-8 byte sequences, the daemon returns `unsupported_filename_encoding` for the affected listing or Git operation. It does not insert replacement characters or expose a lossy path that could target a different file.

Tabs, newlines, non-ASCII characters, and option-like prefixes are valid when they have exact UTF-8 representation. Git parsing uses NUL-delimited output so these names remain unambiguous.

## Generations and revisions

Every response includes `workspaceGeneration`. It changes when the daemon observes root deletion, replacement, or identity change.

Git responses also include `repositoryGeneration`. It identifies the repository root, worktree, index state, HEAD state, and status snapshot used to produce entry IDs.

File reads include an opaque `fileRevision` based on stable file identity and content metadata, with a content hash when metadata cannot prove consistency.

Requests may supply expected generations or revisions. A mismatch returns `workspace_changed` or `repository_changed`. The client replaces stale state instead of merging it.

## Limits, timeout, and cancellation

Requests state desired limits within daemon maxima. The daemon reports applied limits. Initial defaults are:

- directory entries: 200 per page
- file read: 2,000 lines and 1 MiB
- Git status entries: 5,000
- Git parsed output: 4 MiB
- one structured diff: 4 MiB
- operation timeout: 10 seconds

`request.cancel` can cancel outstanding workspace calls owned by the same attachment. Cancellation is best effort for an operating-system call already in progress and returns the structured `cancelled` error when completed before a result.

Closing an attachment requests cancellation of its read-only workspace calls. It does not cancel session operations.

## `session.workspace.list`

The initial Explorer loads exactly one directory level per request. It does not use a recursive `maxDepth` option.

```ts
interface WorkspaceListParams {
  readonly sessionId: SessionId;
  readonly path: string;
  readonly pageSize: number;
  readonly pageCursor?: string;
  readonly ifWorkspaceGeneration?: string;
}

interface WorkspaceEntry {
  readonly path: string;
  readonly name: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly sizeBytes?: number;
  readonly mtimeMs?: number;
  readonly linkTargetType?: "inside_workspace" | "outside_workspace" | "missing";
}

interface WorkspaceListResult {
  readonly workspaceGeneration: string;
  readonly entries: readonly WorkspaceEntry[];
  readonly nextPageCursor?: string;
}
```

Entries use deterministic bytewise filename ordering. Pagination cursors bind session, directory identity, workspace generation, and ordering. Directory mutation invalidates the cursor with `workspace_changed`.

Symlinks are reported but not followed by listing. Unsupported special files are `other` and cannot be read.

A page never silently drops an entry. `nextPageCursor` means more entries exist.

## `session.workspace.read`

```ts
interface WorkspaceReadParams {
  readonly sessionId: SessionId;
  readonly path: string;
  readonly startLine?: number;
  readonly maxLines: number;
  readonly maxBytes: number;
  readonly ifWorkspaceGeneration?: string;
  readonly ifFileRevision?: string;
}

interface WorkspaceReadResult {
  readonly workspaceGeneration: string;
  readonly fileRevision: string;
  readonly path: string;
  readonly encoding: "utf-8";
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines?: number;
  readonly truncated: boolean;
  readonly truncationReason?: "line_limit" | "byte_limit";
}
```

The daemon reads bytes, detects binary content, and validates UTF-8 strictly. NUL content returns `binary_file`. Invalid UTF-8 returns `invalid_encoding`. It never inserts replacement characters silently.

A file that changes during the read returns `workspace_changed` unless the daemon can prove the returned revision is internally consistent.

The response never exceeds the requested or daemon byte ceiling. Truncation ends at a valid UTF-8 and line boundary and reports its reason.

## `session.workspace.status`

```ts
type GitChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "conflicted"
  | "untracked"
  | "binary"
  | "submodule";

interface GitStatusEntry {
  readonly entryId: string;
  readonly path: string;
  readonly previousPath?: string;
  readonly area: "staged" | "unstaged" | "untracked" | "conflict" | "last-turn";
  readonly kind: GitChangeKind;
  readonly binary: boolean;
  readonly submodule: boolean;
}

interface WorkspaceStatusParams {
  readonly sessionId: SessionId;
  readonly scope: "working" | "last-turn";
  readonly ifWorkspaceGeneration?: string;
}

interface WorkspaceStatusResult {
  readonly workspaceGeneration: string;
  readonly repositoryGeneration: string;
  readonly repositoryRoot: string;
  readonly checkpointId?: string;
  readonly branch: {
    readonly state: "branch" | "detached" | "unborn";
    readonly name?: string;
    readonly head?: string;
  };
  readonly sparseCheckout: boolean;
  readonly entries: readonly GitStatusEntry[];
}
```

`repositoryRoot` is workspace-relative and may be empty. A repository whose root is outside the authorized workspace returns `not_git_repository` for this initial API.

For `working`, staged and unstaged changes to one path are separate entries. Conflicts, renames, binary changes, untracked files, and submodules are explicit. For `last-turn`, entries compare the current workspace with the daemon-owned pre-turn checkpoint and use `area: "last-turn"`. Submodules are not recursively inspected.

Sparse checkout, detached HEAD, unborn branch, and linked worktree state are represented. A state that cannot be represented fails with `unsupported_git_state`.

Status that exceeds an entry or output limit returns `git_output_too_large`. It does not return a partial list as complete.

## `session.workspace.diff`

The daemon returns structured hunks. There is no `format` request field. Unified and side-by-side layouts are deterministic SDK or UI projections of the same result.

```ts
interface WorkspaceDiffParams {
  readonly sessionId: SessionId;
  readonly entryId: string;
  readonly contextLines: number;
  readonly repositoryGeneration: string;
  readonly maxBytes: number;
}

interface DiffLine {
  readonly kind: "context" | "addition" | "deletion" | "marker";
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
}

interface DiffHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

interface WorkspaceDiffResult {
  readonly workspaceGeneration: string;
  readonly repositoryGeneration: string;
  readonly entry: GitStatusEntry;
  readonly oldRevision?: string;
  readonly newRevision?: string;
  readonly hunks: readonly DiffHunk[];
  readonly binary: boolean;
}
```

A diff larger than the limit returns `git_output_too_large`. It is never clipped inside a hunk or returned as complete.

Binary entries return metadata and no hunks. Untracked text files compare against an empty old side under normal read limits. Deleted files compare against an empty new side. Submodule entries return commit metadata only. Conflicts return ordinary textual hunks when Git can produce them; unsupported combined formats fail explicitly.

The `entryId` binds the complete status entry, scope, checkpoint when present, and repository generation. An old generation or changed entry returns `repository_changed`.

## `session.workspace.checkpoint`

```ts
interface WorkspaceCheckpointParams {
  readonly sessionId: SessionId;
  readonly enabled: boolean;
}

interface WorkspaceCheckpointResult {
  readonly enabled: boolean;
  readonly checkpointId?: string;
}
```

Enabling checkpoint capture records daemon-owned pre-operation workspace baselines for `scope: "last-turn"`. Repeating the same requested state is naturally idempotent. Capture failures are explicit and do not prevent ordinary session operation when review is disabled.

## Git execution policy

The daemon invokes Git directly with an argument array and no shell. It uses explicit configuration and a sanitized environment to:

- disable prompts and credential helpers
- disable pagers and color
- disable aliases
- disable external diff and merge helpers
- disable textconv and external filters for display operations
- prevent hooks and config-defined programs
- disable optional locks for read-only commands
- avoid submodule recursion
- select stable machine-readable output
- use NUL delimiters for paths
- avoid localized output
- bound stdout and stderr
- enforce timeout and cancellation

Repository configuration is untrusted. The browser never supplies Git arguments, environment, revisions, pathspec syntax, or configuration.

## Refresh and consistency

The first slice supports explicit refresh. The web client may also refresh after canonical tool results that are known to affect files, but tool metadata is not treated as a complete change detector.

Working and last-turn status entries bind one repository generation and, when applicable, one checkpoint. File tabs compare revisions. Switching sessions clears:

- workspace and repository generations
- Explorer pages and expansion state
- preview file and diff state
- selected Changes entries
- branch display
- workspace errors

Repository deletion, `.git` replacement, worktree replacement, or canonical-root replacement changes a generation and invalidates outstanding cursors and entries.

## Error behavior

Relevant errors include:

```text
workspace_unavailable
workspace_changed
invalid_path
path_denied
symlink_escape
not_found
not_a_file
unsupported_file_type
unsupported_filename_encoding
binary_file
invalid_encoding
content_too_large
not_git_repository
git_unavailable
git_timeout
git_output_too_large
unsupported_git_state
repository_changed
checkpoint_unavailable
checkpoint_too_large
checkpoint_corrupt
cancelled
```

Errors do not expose absolute protected paths, file contents, Git configuration values, or raw stderr that may contain secrets.

## Acceptance tests

Tests cover:

- absolute, traversal, non-normalized, drive, UNC, NUL, and backslash paths
- symlink escapes and time-of-check/time-of-use replacement
- protected Axl paths and configured secret paths
- unsupported special files
- oversized, binary, invalid UTF-8, replaced, and deleted files
- invalid-byte filenames with explicit rejection
- tabs, newlines, non-ASCII, and option-like valid filenames
- one-level pagination and directory mutation
- staged and unstaged changes to one file
- working and last-turn status from the shared checkpoint contract
- added, modified, deleted, renamed, conflicted, untracked, binary, and submodule entries
- sparse checkout, linked worktrees, detached HEAD, and unborn branches
- repository roots outside the workspace
- malicious aliases, hooks, pagers, diff drivers, textconv, filters, and external helpers
- Git timeout, cancellation, and oversized output
- repository and worktree deletion or replacement
- generation mismatch between status and diff
- explicit failure for unsupported states
