// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import type {
  GitStatusEntry,
  WorkspaceDirectoryState,
  WorkspaceEntry,
  WorkspacePresentationError,
  WorkspaceState,
} from "@axl/sdk";
import { projectSideBySideDiff, projectUnifiedDiff } from "@axl/sdk";

import type { ApplicationShell } from "./shell.ts";

const DISPLAY_LINE_LIMIT = 5_000;
const DISPLAY_LINE_CHARACTER_LIMIT = 16_384;

type WorkspaceTab =
  | { readonly type: "file"; readonly key: string; readonly path: string; readonly pinned: boolean }
  | { readonly type: "diff"; readonly key: string; readonly entry: GitStatusEntry; readonly pinned: boolean };

function boundedLine(text: string): string {
  return text.length <= DISPLAY_LINE_CHARACTER_LIMIT
    ? text
    : `${text.slice(0, DISPLAY_LINE_CHARACTER_LIMIT)}…`;
}

export function openReusableTab(tabs: readonly WorkspaceTab[], next: WorkspaceTab): readonly WorkspaceTab[] {
  if (tabs.some((tab) => tab.key === next.key)) return tabs;
  const unpinned = tabs.findIndex((tab) => !tab.pinned);
  if (unpinned === -1) return [...tabs, next];
  return tabs.map((tab, index) => (index === unpinned ? next : tab));
}

export function WorkspaceErrorState({ error }: { readonly error: WorkspacePresentationError }) {
  const labels: Record<WorkspacePresentationError["kind"], string> = {
    denied: "Access denied",
    unsupported: "Unsupported",
    binary: "Binary file",
    invalid_encoding: "Invalid filename or file encoding",
    missing: "Missing",
    stale_workspace: "Stale workspace generation",
    stale_repository: "Stale repository generation",
    unavailable: "Workspace unavailable",
    failed: "Workspace request failed",
  };
  return <p className={`workspace-error workspace-error-${error.kind}`} role="status"><strong>{labels[error.kind]}:</strong> {error.message}</p>;
}

function EntryLabel({ entry }: { readonly entry: WorkspaceEntry }) {
  return (
    <>
      <span>{entry.name}</span>
      <small>
        {entry.type}
        {entry.type === "symlink" ? ` · ${entry.linkTargetType ?? "unknown target"}` : ""}
        {entry.type === "other" ? " · preview unsupported" : ""}
      </small>
    </>
  );
}

function Directory({ shell, workspace, directory, expanded, onToggle, onFile }: {
  readonly shell: ApplicationShell;
  readonly workspace: WorkspaceState;
  readonly directory: WorkspaceDirectoryState;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (entry: WorkspaceEntry) => void;
  readonly onFile: (entry: WorkspaceEntry) => void;
}) {
  return (
    <ul className="explorer-list">
      {directory.entries.map((entry) => (
        <li key={entry.path}>
          {entry.type === "directory" ? (
            <button type="button" aria-expanded={expanded.has(entry.path)} onClick={() => onToggle(entry)}><EntryLabel entry={entry} /></button>
          ) : entry.type === "file" ? (
            <button type="button" onClick={() => onFile(entry)}><EntryLabel entry={entry} /></button>
          ) : (
            <div className={`explorer-entry explorer-${entry.type}`}><EntryLabel entry={entry} /></div>
          )}
          {entry.type === "directory" && expanded.has(entry.path) ? (() => {
            const child = workspace.directories[entry.path];
            return child === undefined ? <p>Loading directory…</p> : (
              <Directory shell={shell} workspace={workspace} directory={child} expanded={expanded} onToggle={onToggle} onFile={onFile} />
            );
          })() : null}
        </li>
      ))}
      {directory.nextPageCursor === undefined ? null : (
        <li><button type="button" disabled={directory.loading} onClick={() => void shell.listWorkspace(directory.path, true).catch(() => undefined)}>Load more</button></li>
      )}
      {directory.error === undefined ? null : <li><WorkspaceErrorState error={directory.error} /></li>}
    </ul>
  );
}

const CHANGE_GROUPS = ["staged", "unstaged", "untracked", "conflict", "last-turn"] as const;

function Changes({ workspace, onDiff }: {
  readonly workspace: WorkspaceState;
  readonly onDiff: (entry: GitStatusEntry) => void;
}) {
  const statuses = [workspace.statuses.working, workspace.statuses["last-turn"]];
  const entries = statuses.flatMap((status) => status?.result?.entries ?? []);
  const repository = workspace.statuses.working?.result ?? workspace.statuses["last-turn"]?.result;
  return (
    <section className="changes" aria-label="Changes">
      <header><h2>Changes</h2></header>
      {repository === undefined ? <p>Refresh to inspect repository state.</p> : (
        <dl className="repository-state">
          <div><dt>Repository</dt><dd>{repository.repositoryRoot || "workspace root"}</dd></div>
          <div><dt>HEAD</dt><dd>{repository.branch.state}{repository.branch.name === undefined ? "" : ` · ${repository.branch.name}`}{repository.branch.head === undefined ? "" : ` · ${repository.branch.head}`}</dd></div>
          <div><dt>Sparse checkout</dt><dd>{repository.sparseCheckout ? "enabled" : "disabled"}</dd></div>
        </dl>
      )}
      {statuses.map((status) => status?.error === undefined ? null : <WorkspaceErrorState key={status.scope} error={status.error} />)}
      {CHANGE_GROUPS.map((area) => {
        const group = entries.filter((entry) => entry.area === area);
        return (
          <section className="change-group" key={area}>
            <h3>{area}</h3>
            {group.length === 0 ? <p>None</p> : <ul>{group.map((entry) => (
              <li key={`${entry.area}:${entry.entryId}`}>
                <button type="button" onClick={() => onDiff(entry)}>
                  <span>{entry.path}{entry.previousPath === undefined ? "" : ` ← ${entry.previousPath}`}</span>
                  <small>{entry.kind}{entry.binary ? " · binary" : ""}{entry.submodule ? " · submodule" : ""}</small>
                </button>
              </li>
            ))}</ul>}
          </section>
        );
      })}
    </section>
  );
}

export function FilePreview({ workspace, path }: { readonly workspace: WorkspaceState; readonly path: string }) {
  const preview = workspace.previews[path];
  if (preview === undefined || preview.loading) return <p>Loading file preview…</p>;
  if (preview.error !== undefined) return <WorkspaceErrorState error={preview.error} />;
  if (preview.result === undefined) return <p>File preview unavailable.</p>;
  return (
    <section className="file-preview">
      <p>{preview.result.startLine}–{preview.result.endLine}{preview.result.totalLines === undefined ? "" : ` of ${preview.result.totalLines}`} lines · UTF-8 · read-only</p>
      {preview.result.truncated ? <p className="warning">Preview truncated by {preview.result.truncationReason?.replaceAll("_", " ") ?? "daemon limit"}.</p> : null}
      <pre>{preview.result.text}</pre>
    </section>
  );
}

export function DiffPreview({ workspace, entry, layout, onLayout }: {
  readonly workspace: WorkspaceState;
  readonly entry: GitStatusEntry;
  readonly layout: "unified" | "side-by-side";
  readonly onLayout: (layout: "unified" | "side-by-side") => void;
}) {
  const diff = workspace.diffs[entry.entryId];
  if (diff === undefined || diff.loading) return <p>Loading generation-bound diff…</p>;
  if (diff.error !== undefined) return <WorkspaceErrorState error={diff.error} />;
  if (diff.result === undefined) return <p>Diff unavailable.</p>;
  const result = diff.result;
  return (
    <section className="diff-preview">
      <div className="actions" role="group" aria-label="Diff layout">
        <button type="button" aria-pressed={layout === "unified"} onClick={() => onLayout("unified")}>Unified</button>
        <button type="button" aria-pressed={layout === "side-by-side"} onClick={() => onLayout("side-by-side")}>Side by side</button>
      </div>
      <p>{result.entry.kind}{result.binary ? " · binary" : ""}{result.entry.submodule ? " · submodule" : ""}</p>
      {result.binary ? <p>Binary content has no textual hunks.</p> : result.entry.submodule ? <p>Submodule change. Commit metadata only.</p> : (
        result.hunks.map((hunk, hunkIndex) => {
          const lines = hunk.lines.slice(0, DISPLAY_LINE_LIMIT);
          return <section className="diff-hunk" key={`${hunk.header}:${hunkIndex}`}><h3>{boundedLine(hunk.header)}</h3>{layout === "unified" ? (
            <table><tbody>{projectUnifiedDiff(lines).map((line, index) => <tr className={`diff-${line.kind}`} key={index}><td>{line.oldLine ?? ""}</td><td>{line.newLine ?? ""}</td><td><pre>{line.prefix}{boundedLine(line.text)}</pre></td></tr>)}</tbody></table>
          ) : (
            <table><thead><tr><th colSpan={2}>Old</th><th colSpan={2}>New</th></tr></thead><tbody>{projectSideBySideDiff(lines).map((row, index) => <tr key={index}><td>{row.old?.oldLine ?? ""}</td><td><pre>{boundedLine(row.old?.text ?? "")}</pre></td><td>{row.new?.newLine ?? ""}</td><td><pre>{boundedLine(row.new?.text ?? "")}</pre></td></tr>)}</tbody></table>
          )}{hunk.lines.length > lines.length ? <p className="warning">Display limited to {DISPLAY_LINE_LIMIT} lines for this hunk.</p> : null}</section>;
        })
      )}
    </section>
  );
}

export function WorkspacePresentation({ shell, workspace, sessionId }: {
  readonly shell: ApplicationShell;
  readonly workspace: WorkspaceState;
  readonly sessionId: string;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [tabs, setTabs] = useState<readonly WorkspaceTab[]>([]);
  const [activeKey, setActiveKey] = useState<string>();
  const [layout, setLayout] = useState<"unified" | "side-by-side">("unified");

  useEffect(() => {
    setExpanded(new Set());
    setTabs([]);
    setActiveKey(undefined);
    if (shell.supports("session.workspace.list") && shell.supports("session.workspace.status")) {
      void shell.refreshWorkspace().catch(() => undefined);
    }
  }, [sessionId, shell]);

  const openFile = (entry: WorkspaceEntry) => {
    const next: WorkspaceTab = { type: "file", key: `file:${entry.path}`, path: entry.path, pinned: false };
    setTabs((current) => openReusableTab(current, next));
    setActiveKey(next.key);
    void shell.readWorkspaceFile(entry.path).catch(() => undefined);
  };
  const openDiff = (entry: GitStatusEntry) => {
    const next: WorkspaceTab = { type: "diff", key: `diff:${entry.entryId}`, entry, pinned: false };
    setTabs((current) => openReusableTab(current, next));
    setActiveKey(next.key);
    void shell.loadWorkspaceDiff(entry).catch(() => undefined);
  };
  const active = tabs.find((tab) => tab.key === activeKey);
  const root = workspace.directories[""];
  const allCapabilities = ["session.workspace.list", "session.workspace.read", "session.workspace.status", "session.workspace.diff"] as const;
  const unavailable = allCapabilities.filter((capability) => !shell.supports(capability));

  return (
    <section className="workspace-review" aria-label="Workspace review">
      <header className="workspace-toolbar">
        <h2>Workspace</h2>
        <button type="button" disabled={unavailable.length > 0} onClick={() => void shell.refreshWorkspace().catch(() => undefined)}>Refresh Explorer and Changes</button>
        <label><input type="checkbox" checked={workspace.checkpoint?.enabled ?? false} disabled={!shell.supports("session.workspace.checkpoint")} onChange={(event) => void shell.configureWorkspaceCheckpoint(event.currentTarget.checked).catch(() => undefined)} />Last-turn checkpoints</label>
      </header>
      {unavailable.length === 0 ? null : <p className="warning">Workspace capabilities unavailable: {unavailable.join(", ")}</p>}
      {workspace.transition === undefined ? null : <WorkspaceErrorState error={workspace.transition} />}
      <div className="workspace-columns">
        <section className="explorer" aria-label="Explorer">
          <h2>Explorer</h2>
          {root === undefined || root.loading ? <p>Loading one workspace level…</p> : <Directory shell={shell} workspace={workspace} directory={root} expanded={expanded} onToggle={(entry) => {
            const opening = !expanded.has(entry.path);
            setExpanded((current) => { const next = new Set(current); if (opening) next.add(entry.path); else next.delete(entry.path); return next; });
            if (opening && workspace.directories[entry.path] === undefined) void shell.listWorkspace(entry.path).catch(() => undefined);
          }} onFile={openFile} />}
        </section>
        <Changes workspace={workspace} onDiff={openDiff} />
      </div>
      {tabs.length === 0 ? null : (
        <section className="workspace-tabs">
          <div className="tab-list" role="tablist" aria-label="File and diff previews">{tabs.map((tab) => <span key={tab.key}><button type="button" role="tab" aria-selected={tab.key === activeKey} onClick={() => setActiveKey(tab.key)}>{tab.type === "file" ? tab.path : tab.entry.path}</button><button type="button" aria-label={`${tab.pinned ? "Unpin" : "Pin"} ${tab.type === "file" ? tab.path : tab.entry.path}`} aria-pressed={tab.pinned} onClick={() => setTabs((current) => current.map((item) => item.key === tab.key ? { ...item, pinned: !item.pinned } : item))}>{tab.pinned ? "Pinned" : "Pin"}</button></span>)}</div>
          <div className="tab-panel" role="tabpanel">{active?.type === "file" ? <FilePreview workspace={workspace} path={active.path} /> : active?.type === "diff" ? <DiffPreview workspace={workspace} entry={active.entry} layout={layout} onLayout={setLayout} /> : null}</div>
        </section>
      )}
    </section>
  );
}
