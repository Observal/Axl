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
import { SplitPane, type SplitState, SplitToggle } from "./split-pane.tsx";
import { workspaceTotals } from "./view-state.ts";

export interface WorkspaceBrowserState {
  readonly path: string;
  readonly entries: readonly WorkspaceEntry[];
  readonly loaded: boolean;
  readonly nextPageCursor?: string;
  readonly file?: WorkspaceReadResult;
}

interface WorkspacePanelProps {
  readonly canCheckpoint: boolean;
  readonly browser: WorkspaceBrowserState;
  readonly review?: WorkspaceReviewSnapshot | undefined;
  readonly scope: WorkspaceStatusScope;
  readonly checkpointEnabled?: boolean | undefined;
  readonly checkpointDisabled: boolean;
  readonly loading: boolean;
  readonly error?: string | undefined;
  readonly view: "files" | "all";
  readonly onOpenDirectory: (path: string) => void;
  readonly onOpenFile: (path: string) => void;
  readonly onLoadMoreEntries: () => void;
  readonly onLoadMoreFile: () => void;
  readonly onScope: (scope: WorkspaceStatusScope) => void;
  readonly onCheckpoint: (enabled: boolean) => void;
  readonly onViewChange: (view: "files" | "all") => void;
  readonly onRetry: () => void;
  /** Inserts a workspace path into the composer. */
  readonly onMentionPath: (path: string) => void;
  /** Opens a changed file in the Files pane. */
  readonly onOpenInFiles: (path: string) => void;
  /** Tree | preview split in the Files pane. */
  readonly filesSplit: SplitState;
  readonly onFilesSplit: (state: SplitState) => void;
  /** File list | diff split in the Changes pane. */
  readonly changesSplit: SplitState;
  readonly onChangesSplit: (state: SplitState) => void;
}

export type WorkspaceExplorerProps = Pick<
  WorkspacePanelProps,
  | "browser"
  | "loading"
  | "error"
  | "onOpenDirectory"
  | "onOpenFile"
  | "onLoadMoreEntries"
  | "onLoadMoreFile"
  | "onRetry"
  | "onMentionPath"
  | "filesSplit"
  | "onFilesSplit"
>;

export type WorkspaceChangesProps = Pick<
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
  | "onMentionPath"
  | "onOpenInFiles"
  | "changesSplit"
  | "onChangesSplit"
>;

function MentionButton({ path, onMentionPath }: { readonly path: string; readonly onMentionPath: (path: string) => void }): React.JSX.Element {
  return (
    <button type="button" className="icon-button" aria-label={`Insert ${path} into the prompt`} title="Insert path into prompt" onClick={() => onMentionPath(path)}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12.5h10M4.5 9.5 8 3l3.5 6.5M5.6 7.5h4.8" /></svg>
    </button>
  );
}

function DiffContent({
  diff,
  onMentionPath,
  onOpenInFiles,
  leading,
}: {
  readonly diff: WorkspaceReviewSnapshot["diffs"][number];
  readonly onMentionPath: (path: string) => void;
  readonly onOpenInFiles: (path: string) => void;
  readonly leading?: React.ReactNode;
}): React.JSX.Element {
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
        {leading}
        <div>
          <strong>{diff.entry.path.split("/").at(-1)}</strong>
          <span>
            {diff.entry.path.includes("/")
              ? diff.entry.path.slice(0, diff.entry.path.lastIndexOf("/"))
              : ""}
          </span>
        </div>
        <span className="selected-diff-actions">
          <ChangeStats additions={additions} deletions={deletions} />
          {diff.entry.kind !== "deleted" && (
            <button type="button" className="icon-button" aria-label={`Open ${diff.entry.path} in Files`} title="Open in Files" onClick={() => onOpenInFiles(diff.entry.path)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h4l1.2 1.5h5.8v7h-11z" /></svg>
            </button>
          )}
          <MentionButton path={diff.entry.path} onMentionPath={onMentionPath} />
        </span>
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

export function WorkspaceExplorer({
  browser,
  loading,
  error,
  onOpenDirectory,
  onOpenFile,
  onLoadMoreEntries,
  onLoadMoreFile,
  onRetry,
  onMentionPath,
  filesSplit,
  onFilesSplit,
}: WorkspaceExplorerProps): React.JSX.Element {
  const crumbs = browser.path ? browser.path.split("/") : [];
  const file = browser.file;
  const lines = file?.text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const language = file === undefined ? undefined : languageForPath(file.path);
  const tree = (
      <section className="workspace-tree" aria-label="Workspace files">
        <div className="workspace-breadcrumbs">
          <SplitToggle state={filesSplit} onState={onFilesSplit} label="file tree" />
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
  );
  const preview = (
      <section className="workspace-file" aria-label="File preview">
        {file ? (
          <>
            <header>
              {filesSplit.collapsed && <SplitToggle state={filesSplit} onState={onFilesSplit} label="file tree" />}
              <div>
                <strong>{file.path.split("/").at(-1)}</strong>
                <span>
                  {file.path}
                  {file.totalLines !== undefined ? ` · ${file.totalLines} lines` : ""}
                </span>
              </div>
              <MentionButton path={file.path} onMentionPath={onMentionPath} />
            </header>
            {lines.length === 0 ? (
              <div className="changes-state"><span>This file is empty</span></div>
            ) : (
              <div className="workspace-source" role="table" aria-label={browser.file.path}>
                {lines.map((line, index) => (
                  <div role="row" key={file.startLine + index}>
                    <span role="cell">{file.startLine + index}</span>
                    <code
                      role="cell"
                      dangerouslySetInnerHTML={{
                        __html: highlightLine((line.endsWith("\n") ? line.slice(0, -1) : line) || " ", language),
                      }}
                    />
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
            {filesSplit.collapsed && <SplitToggle state={filesSplit} onState={onFilesSplit} label="file tree" />}
            <EntryIcon type="file" />
            <strong>Select a file</strong>
            <span>Text files open here through the daemon.</span>
          </div>
        )}
      </section>
  );
  return (
    <div className="workspace-browser">
      <SplitPane state={filesSplit} onState={onFilesSplit} label="file tree" primary={tree} secondary={preview} />
    </div>
  );
}

export function WorkspaceChanges({
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
  onMentionPath,
  onOpenInFiles,
  changesSplit,
  onChangesSplit,
}: WorkspaceChangesProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>();
  const totals = workspaceTotals(review?.diffs ?? []);
  const diffs = review?.diffs ?? [];
  const selectedIndex = Math.max(0, diffs.findIndex((diff) => diff.entry.entryId === selectedId));
  const selected = diffs[selectedIndex];
  const step = (direction: -1 | 1): void => {
    const next = diffs[(selectedIndex + direction + diffs.length) % diffs.length];
    if (next !== undefined) setSelectedId(next.entry.entryId);
  };
  const checkpointLabel = checkpointEnabled === true
    ? "Checkpoints on: a baseline is captured before each session operation. Click to stop."
    : "Start last-turn checkpoints: capture a baseline before each session operation.";
  const list = (
    <nav aria-label="Changed files" className="changed-files">
      {diffs.map((diff) => {
        const fileTotals = workspaceTotals([diff]);
        return (
          <button
            type="button"
            key={diff.entry.entryId}
            className={diff.entry.entryId === selected?.entry.entryId ? "active" : ""}
            title={diff.entry.path}
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
  );
  const navigation = (
    <span className="diff-navigation">
      {changesSplit.collapsed && <SplitToggle state={changesSplit} onState={onChangesSplit} label="changed files" />}
      {diffs.length > 1 && (
        <>
          <button type="button" className="icon-button" aria-label="Previous changed file" onClick={() => step(-1)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3.5-4.5 4.5 4.5 4.5" /></svg>
          </button>
          <small>{selectedIndex + 1}/{diffs.length}</small>
          <button type="button" className="icon-button" aria-label="Next changed file" onClick={() => step(1)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
          </button>
        </>
      )}
    </span>
  );
  return (
    <div className="workspace-changes">
      <div className="workspace-review-toolbar">
        <div role="group" aria-label="Change scope">
          <button className={scope === "working" ? "active" : ""} type="button" aria-pressed={scope === "working"} onClick={() => onScope("working")}>Working tree</button>
          <button className={scope === "last-turn" ? "active" : ""} type="button" aria-pressed={scope === "last-turn"} onClick={() => onScope("last-turn")}>Last turn</button>
        </div>
        {review && (
          <span className="changes-summary">
            <span className="branch-name" title={review.status.branch.head ?? ""}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="4" cy="3" r="1.5" />
                <circle cx="4" cy="13" r="1.5" />
                <circle cx="12" cy="5.5" r="1.5" />
                <path d="M4 4.5v7M5.5 10c4 0 6.5-1 6.5-3" />
              </svg>
              {review.status.branch.name ?? review.status.branch.state}
            </span>
            <ChangeStats additions={totals.additions} deletions={totals.deletions} />
          </span>
        )}
        <div className="workspace-toolbar-actions" role="group" aria-label="Changes layout">
          {canCheckpoint && (
            <button
              type="button"
              className={checkpointEnabled === true ? "icon-button active checkpoint-toggle" : "icon-button checkpoint-toggle"}
              aria-pressed={checkpointEnabled === true}
              aria-label={checkpointLabel}
              title={review?.status.checkpointId ? `${checkpointLabel} Baseline ${review.status.checkpointId.slice(0, 8)}.` : checkpointLabel}
              disabled={loading || checkpointDisabled}
              onClick={() => onCheckpoint(checkpointEnabled !== true)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3" /><circle cx="8" cy="8" r="2.25" /></svg>
            </button>
          )}
          {view === "files" && <SplitToggle state={changesSplit} onState={onChangesSplit} label="changed files" />}
          <button className={view === "files" ? "icon-button active" : "icon-button"} type="button" aria-pressed={view === "files"} onClick={() => onViewChange("files")} aria-label="One file at a time" title="One file at a time">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3h4v10h-4zM6.5 3h7v10h-7" /></svg>
          </button>
          <button className={view === "all" ? "icon-button active" : "icon-button"} type="button" aria-pressed={view === "all"} onClick={() => onViewChange("all")} aria-label="All files stacked" title="All files stacked">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10M3 8h10M3 12.5h10" /></svg>
          </button>
        </div>
      </div>
      {loading && <div className="changes-state"><i className="loading-ring" /><span>Loading workspace changes…</span></div>}
      {error && <div className="changes-state error"><span>{error}</span><button type="button" onClick={onRetry}>Retry</button></div>}
      {!loading && !error && review !== undefined && diffs.length === 0 && <div className="changes-state"><span>{scope === "last-turn" ? "No changes since the checkpoint" : "No workspace changes"}</span></div>}
      {review && selected && view === "files" && (
        <div className="changes-layout">
          <SplitPane
            state={changesSplit}
            onState={onChangesSplit}
            label="changed files list"
            primary={list}
            secondary={<DiffContent diff={selected} onMentionPath={onMentionPath} onOpenInFiles={onOpenInFiles} leading={navigation} />}
          />
        </div>
      )}
      {review && view === "all" && <div className="all-diffs">{diffs.map((diff) => <DiffContent key={diff.entry.entryId} diff={diff} onMentionPath={onMentionPath} onOpenInFiles={onOpenInFiles} />)}</div>}
      {review?.truncated && <p className="changes-limit">Showing the first 100 changed files.</p>}
    </div>
  );
}
