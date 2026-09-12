// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import type {
  WorkspaceEntry,
  WorkspaceReadResult,
  WorkspaceReviewSnapshot,
  WorkspaceStatusScope,
} from "@axl/sdk";
import { highlightLine, languageForPath } from "@axl/ui";
import { workspaceTotals } from "./view-state.ts";

export type WorkspacePanelTab = "files" | "changes";

export interface WorkspaceBrowserState {
  readonly path: string;
  readonly entries: readonly WorkspaceEntry[];
  readonly loaded: boolean;
  readonly nextPageCursor?: string;
  readonly file?: WorkspaceReadResult;
}

interface WorkspacePanelProps {
  readonly tab: WorkspacePanelTab;
  readonly canBrowse: boolean;
  readonly canReview: boolean;
  readonly canCheckpoint: boolean;
  readonly browser: WorkspaceBrowserState;
  readonly review?: WorkspaceReviewSnapshot | undefined;
  readonly scope: WorkspaceStatusScope;
  readonly checkpointEnabled?: boolean | undefined;
  readonly checkpointDisabled: boolean;
  readonly loading: boolean;
  readonly error?: string | undefined;
  readonly view: "files" | "all";
  readonly onTab: (tab: WorkspacePanelTab) => void;
  readonly onOpenDirectory: (path: string) => void;
  readonly onOpenFile: (path: string) => void;
  readonly onLoadMoreEntries: () => void;
  readonly onLoadMoreFile: () => void;
  readonly onScope: (scope: WorkspaceStatusScope) => void;
  readonly onCheckpoint: (enabled: boolean) => void;
  readonly onViewChange: (view: "files" | "all") => void;
  readonly onClose: () => void;
  readonly onRetry: () => void;
}

function DiffContent({ diff }: { readonly diff: WorkspaceReviewSnapshot["diffs"][number] }): React.JSX.Element {
  const language = languageForPath(diff.entry.path);
  const additions = diff.hunks
    .flatMap((hunk) => hunk.lines)
    .filter((line) => line.kind === "addition").length;
  const deletions = diff.hunks
    .flatMap((hunk) => hunk.lines)
    .filter((line) => line.kind === "deletion").length;
  return (
    <section className="selected-diff" aria-label={`Changes in ${diff.entry.path}`}>
      <header>
        <div>
          <strong>{diff.entry.path.split("/").at(-1)}</strong>
          <span>
            {diff.entry.path.includes("/")
              ? diff.entry.path.slice(0, diff.entry.path.lastIndexOf("/"))
              : ""}
          </span>
        </div>
        <ChangeStats additions={additions} deletions={deletions} />
      </header>
      {diff.binary ? (
        <p className="binary-change">Binary file changed</p>
      ) : (
        <div className="workspace-diff" role="table">
          {diff.hunks.flatMap((hunk, hunkIndex) => [
            <div className="workspace-hunk" role="row" key={`${hunkIndex}:header`}>
              <code role="cell">{hunk.header}</code>
            </div>,
            ...hunk.lines.map((line, lineIndex) => (
              <div
                className={`workspace-diff-row ${line.kind}`}
                role="row"
                key={`${hunkIndex}:${lineIndex}`}
              >
                <span role="cell">{line.oldLine ?? ""}</span>
                <span role="cell">{line.newLine ?? ""}</span>
                <i aria-hidden="true">
                  {line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : ""}
                </i>
                <code
                  role="cell"
                  dangerouslySetInnerHTML={{ __html: highlightLine(line.text || " ", language) }}
                />
              </div>
            )),
          ])}
        </div>
      )}
    </section>
  );
}

function ChangeStats({
  additions,
  deletions,
}: {
  readonly additions: number;
  readonly deletions: number;
}): React.JSX.Element {
  return (
    <span className="diff-stats">
      {additions > 0 && <b>+{additions}</b>}
      {deletions > 0 && <i>−{deletions}</i>}
    </span>
  );
}

function EntryIcon({ type }: { readonly type: WorkspaceEntry["type"] }): React.JSX.Element {
  return type === "directory" ? (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 4h4l1.2 1.5h5.8v7h-11z" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3" />
    </svg>
  );
}

function WorkspaceExplorer({
  browser,
  loading,
  error,
  onOpenDirectory,
  onOpenFile,
  onLoadMoreEntries,
  onLoadMoreFile,
  onRetry,
}: Pick<
  WorkspacePanelProps,
  | "browser"
  | "loading"
  | "error"
  | "onOpenDirectory"
  | "onOpenFile"
  | "onLoadMoreEntries"
  | "onLoadMoreFile"
  | "onRetry"
>): React.JSX.Element {
  const crumbs = browser.path ? browser.path.split("/") : [];
  const file = browser.file;
  const lines = file?.text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  return (
    <div className="workspace-browser">
      <section className="workspace-tree" aria-label="Workspace files">
        <div className="workspace-breadcrumbs">
          <button type="button" onClick={() => onOpenDirectory("")} aria-label="Workspace root">
            root
          </button>
          {crumbs.map((part, index) => (
            <span key={`${index}:${part}`}>
              <i aria-hidden="true">/</i>
              <button
                type="button"
                onClick={() => onOpenDirectory(crumbs.slice(0, index + 1).join("/"))}
              >
                {part}
              </button>
            </span>
          ))}
          <button className="workspace-refresh" type="button" onClick={onRetry} aria-label="Refresh files">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M13 6a5 5 0 1 0 .2 3M13 2.5V6H9.5" />
            </svg>
          </button>
        </div>
        {error && (
          <div className="changes-state error">
            <span>{error}</span>
            <button type="button" onClick={onRetry}>Retry</button>
          </div>
        )}
        {!error && browser.loaded && browser.entries.length === 0 && (
          <div className="changes-state"><span>This directory is empty</span></div>
        )}
        {!error && browser.entries.length > 0 && (
          <nav className="workspace-entry-list">
            {browser.entries.map((entry) => {
              const available = entry.type === "directory" || entry.type === "file";
              return (
                <button
                  type="button"
                  key={entry.path}
                  disabled={!available}
                  aria-label={`${entry.name}, ${entry.type}`}
                  title={
                    entry.type === "symlink"
                      ? `Symlink target: ${entry.linkTargetType?.replaceAll("_", " ") ?? "unknown"}`
                      : entry.name
                  }
                  onClick={() =>
                    entry.type === "directory"
                      ? onOpenDirectory(entry.path)
                      : entry.type === "file"
                        ? onOpenFile(entry.path)
                        : undefined
                  }
                >
                  <EntryIcon type={entry.type} />
                  <span>{entry.name}</span>
                  <small>
                    {entry.type === "directory"
                      ? "folder"
                      : entry.type === "file" && entry.sizeBytes !== undefined
                        ? `${Math.max(1, Math.ceil(entry.sizeBytes / 1024))} KB`
                        : entry.type}
                  </small>
                </button>
              );
            })}
            {browser.nextPageCursor && (
              <button className="workspace-load-more" type="button" onClick={onLoadMoreEntries}>
                Load more files
              </button>
            )}
          </nav>
        )}
        {loading && <div className="workspace-progress" role="status"><i className="loading-ring" />Loading workspace…</div>}
      </section>
      <section className="workspace-file" aria-label="File preview">
        {file ? (
          <>
            <header>
              <strong>{file.path.split("/").at(-1)}</strong>
              <span>{file.path}</span>
            </header>
            {lines.length === 0 ? (
              <div className="changes-state"><span>This file is empty</span></div>
            ) : (
              <div className="workspace-source" role="table" aria-label={browser.file.path}>
                {lines.map((line, index) => (
                  <div role="row" key={file.startLine + index}>
                    <span role="cell">{file.startLine + index}</span>
                    <code role="cell">{line.endsWith("\n") ? line.slice(0, -1) || " " : line || " "}</code>
                  </div>
                ))}
              </div>
            )}
            {file.truncated && (
              <button className="workspace-load-more file" type="button" onClick={onLoadMoreFile}>
                Load next lines
              </button>
            )}
          </>
        ) : (
          <div className="workspace-file-empty">
            <EntryIcon type="file" />
            <strong>Select a file</strong>
            <span>Text files open here through the daemon.</span>
          </div>
        )}
      </section>
    </div>
  );
}

function WorkspaceChanges({
  review,
  loading,
  error,
  view,
  scope,
  canCheckpoint,
  checkpointEnabled,
  checkpointDisabled,
  onScope,
  onCheckpoint,
  onViewChange,
  onRetry,
}: Pick<
  WorkspacePanelProps,
  | "review"
  | "loading"
  | "error"
  | "view"
  | "scope"
  | "canCheckpoint"
  | "checkpointEnabled"
  | "checkpointDisabled"
  | "onScope"
  | "onCheckpoint"
  | "onViewChange"
  | "onRetry"
>): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>();
  const totals = workspaceTotals(review?.diffs ?? []);
  const selected =
    review?.diffs.find((diff) => diff.entry.entryId === selectedId) ?? review?.diffs[0];
  return (
    <>
      <div className="workspace-review-toolbar">
        <div role="group" aria-label="Change scope">
          <button className={scope === "working" ? "active" : ""} type="button" onClick={() => onScope("working")}>Working tree</button>
          <button className={scope === "last-turn" ? "active" : ""} type="button" onClick={() => onScope("last-turn")}>Last turn</button>
        </div>
        <div className="workspace-toolbar-actions" role="group" aria-label="Changes layout">
          <button className={view === "files" ? "active" : ""} type="button" onClick={() => onViewChange("files")} aria-label="File picker view">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3h4v10h-4zM6.5 3h7v10h-7" /></svg>
          </button>
          <button className={view === "all" ? "active" : ""} type="button" onClick={() => onViewChange("all")} aria-label="All files view">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10M3 8h10M3 12.5h10" /></svg>
          </button>
          <button className="workspace-refresh" type="button" onClick={onRetry} aria-label="Refresh changes">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 6a5 5 0 1 0 .2 3M13 2.5V6H9.5" /></svg>
          </button>
        </div>
      </div>
      {canCheckpoint && (
        <div className="checkpoint-bar">
          <span>
            <strong>{review?.status.checkpointId ? "Checkpoint available" : "Last-turn checkpoints"}</strong>
            <small>
              {review?.status.checkpointId
                ? `Baseline ${review.status.checkpointId.slice(0, 8)} · captured before a session operation`
                : "Capture a bounded baseline before each session operation."}
            </small>
          </span>
          <button type="button" disabled={loading || checkpointDisabled} onClick={() => onCheckpoint(checkpointEnabled !== true)}>
            {checkpointEnabled === true ? "Stop capture" : "Start checkpoints"}
          </button>
        </div>
      )}
      {review && (
        <div className="changes-summary">
          <span className="branch-name">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="4" cy="3" r="1.5" />
              <circle cx="4" cy="13" r="1.5" />
              <circle cx="12" cy="5.5" r="1.5" />
              <path d="M4 4.5v7M5.5 10c4 0 6.5-1 6.5-3" />
            </svg>
            {review.status.branch.name ?? review.status.branch.state}
          </span>
          <ChangeStats additions={totals.additions} deletions={totals.deletions} />
        </div>
      )}
      {loading && <div className="changes-state"><i className="loading-ring" /><span>Loading workspace changes…</span></div>}
      {error && <div className="changes-state error"><span>{error}</span><button type="button" onClick={onRetry}>Retry</button></div>}
      {!loading && !error && review?.diffs.length === 0 && <div className="changes-state"><span>{scope === "last-turn" ? "No changes since the checkpoint" : "No workspace changes"}</span></div>}
      {review && selected && view === "files" && (
        <div className="changes-layout">
          <nav aria-label="Changed files">
            {review.diffs.map((diff) => {
              const fileTotals = workspaceTotals([diff]);
              return (
                <button
                  type="button"
                  key={diff.entry.entryId}
                  className={diff.entry.entryId === selected.entry.entryId ? "active" : ""}
                  onClick={() => setSelectedId(diff.entry.entryId)}
                >
                  <span className="changed-file-name">
                    <strong>{diff.entry.path.split("/").at(-1)}</strong>
                    <ChangeStats additions={fileTotals.additions} deletions={fileTotals.deletions} />
                  </span>
                  <span>{diff.entry.path.includes("/") ? diff.entry.path.slice(0, diff.entry.path.lastIndexOf("/")) : ""}</span>
                </button>
              );
            })}
          </nav>
          <DiffContent diff={selected} />
        </div>
      )}
      {review && view === "all" && <div className="all-diffs">{review.diffs.map((diff) => <DiffContent key={diff.entry.entryId} diff={diff} />)}</div>}
      {review?.truncated && <p className="changes-limit">Showing the first 100 changed files.</p>}
    </>
  );
}

export function WorkspacePanel(props: WorkspacePanelProps): React.JSX.Element {
  return (
    <aside className="changes-panel" aria-label="Workspace">
      <header className="changes-header">
        <nav aria-label="Workspace views">
          {props.canBrowse && <button className={props.tab === "files" ? "active" : ""} type="button" onClick={() => props.onTab("files")}>Files</button>}
          {props.canReview && <button className={props.tab === "changes" ? "active" : ""} type="button" onClick={() => props.onTab("changes")}>Changes</button>}
        </nav>
        <button type="button" aria-label="Close workspace" onClick={props.onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      {props.tab === "files" ? (
        <WorkspaceExplorer {...props} />
      ) : (
        <WorkspaceChanges {...props} />
      )}
    </aside>
  );
}
