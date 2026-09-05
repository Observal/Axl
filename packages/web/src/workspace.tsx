// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
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

export type WorkspaceTab =
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

export function closeWorkspaceTab(
  tabs: readonly WorkspaceTab[],
  key: string,
): { readonly tabs: readonly WorkspaceTab[]; readonly activeKey: string | undefined } {
  const index = tabs.findIndex((tab) => tab.key === key);
  if (index === -1) return { tabs, activeKey: tabs[0]?.key };
  const remaining = tabs.filter((tab) => tab.key !== key);
  return { tabs: remaining, activeKey: remaining[Math.min(index, remaining.length - 1)]?.key };
}

export function replaceStaleTabs(
  tabs: readonly WorkspaceTab[],
  scope: "workspace" | "repository",
): readonly WorkspaceTab[] {
  return scope === "workspace" ? [] : tabs.filter((tab) => tab.type !== "diff");
}

export function tabKeyTarget(
  index: number,
  key: string,
  count: number,
): number | undefined {
  if (count === 0) return undefined;
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
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
  return <p className={`workspace-error workspace-error-${error.kind}`}><strong>{labels[error.kind]}:</strong> {error.message}</p>;
}

function EntryLabel({ entry }: { readonly entry: WorkspaceEntry }) {
  return (
    <>
      <span className="bounded-label">{entry.name}</span>
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
    <section className="changes" aria-labelledby="changes-heading">
      <header><h2 id="changes-heading">Changes</h2></header>
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
                  <span className="bounded-label">{entry.path}{entry.previousPath === undefined ? "" : ` ← ${entry.previousPath}`}</span>
                  <small>{entry.kind}{entry.kind === "conflicted" ? " · conflict" : ""}{entry.binary ? " · binary" : ""}{entry.submodule ? " · submodule" : ""}</small>
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
      {preview.result.truncated ? <p className="warning-inline">Preview truncated by {preview.result.truncationReason?.replaceAll("_", " ") ?? "daemon limit"}.</p> : null}
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
      <p>{result.entry.kind}{result.entry.kind === "conflicted" ? " · conflict" : ""}{result.binary ? " · binary" : ""}{result.entry.submodule ? " · submodule" : ""}</p>
      {result.binary ? <p>Binary content has no textual hunks.</p> : result.entry.submodule ? <p>Submodule change. Commit metadata only.</p> : (
        result.hunks.map((hunk, hunkIndex) => {
          const lines = hunk.lines.slice(0, DISPLAY_LINE_LIMIT);
          return <section className="diff-hunk" key={`${hunk.header}:${hunkIndex}`}><h3>{boundedLine(hunk.header)}</h3>{layout === "unified" ? (
            <table><tbody>{projectUnifiedDiff(lines).map((line, index) => <tr className={`diff-${line.kind}`} key={index}><td>{line.oldLine ?? ""}</td><td>{line.newLine ?? ""}</td><td><pre><span className="sr-only">{line.kind}: </span>{line.prefix}{boundedLine(line.text)}</pre></td></tr>)}</tbody></table>
          ) : (
            <table><thead><tr><th colSpan={2}>Old</th><th colSpan={2}>New</th></tr></thead><tbody>{projectSideBySideDiff(lines).map((row, index) => <tr key={index}><td>{row.old?.oldLine ?? ""}</td><td><pre><span className="sr-only">{row.old?.kind === undefined ? "" : `${row.old.kind}: `}</span>{boundedLine(row.old?.text ?? "")}</pre></td><td>{row.new?.newLine ?? ""}</td><td><pre><span className="sr-only">{row.new?.kind === undefined ? "" : `${row.new.kind}: `}</span>{boundedLine(row.new?.text ?? "")}</pre></td></tr>)}</tbody></table>
          )}{hunk.lines.length > lines.length ? <p className="warning-inline">Display limited to {DISPLAY_LINE_LIMIT} lines for this hunk.</p> : null}</section>;
        })
      )}
    </section>
  );
}

export function PreviewTabs({ tabs, activeKey, workspace, layout, onActivate, onPin, onClose, onLayout }: {
  readonly tabs: readonly WorkspaceTab[];
  readonly activeKey: string | undefined;
  readonly workspace: WorkspaceState;
  readonly layout: "unified" | "side-by-side";
  readonly onActivate: (key: string) => void;
  readonly onPin: (key: string) => void;
  readonly onClose: (key: string) => void;
  readonly onLayout: (layout: "unified" | "side-by-side") => void;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId().replaceAll(":", "");
  const active = tabs.find((tab) => tab.key === activeKey);
  const activeIndex = tabs.findIndex((tab) => tab.key === activeKey);
  const panelId = `${id}-workspace-tabpanel`;
  const activate = (index: number) => {
    const tab = tabs[index];
    if (tab === undefined) return;
    onActivate(tab.key);
    tabRefs.current[index]?.focus();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = tabKeyTarget(index, event.key, tabs.length);
    if (target === undefined) return;
    event.preventDefault();
    activate(target);
  };

  return (
    <section className="workspace-tabs" aria-label="Open previews">
      <div className="tab-list" role="tablist" aria-label="File and diff previews">{tabs.map((tab, index) => {
        const label = tab.type === "file" ? tab.path : tab.entry.path;
        const selected = tab.key === activeKey;
        const tabId = `${id}-workspace-tab-${index}`;
        return <span key={tab.key} role="presentation"><button ref={(element) => { tabRefs.current[index] = element; }} id={tabId} type="button" role="tab" aria-selected={selected} aria-controls={panelId} tabIndex={selected || activeIndex === -1 && index === 0 ? 0 : -1} onKeyDown={(event) => onKeyDown(event, index)} onClick={() => onActivate(tab.key)}><span className="bounded-label">{label}</span><span className="state-label">{selected ? "Selected" : ""}{tab.pinned ? `${selected ? " · " : ""}Pinned` : ""}</span></button><button type="button" aria-label={`${tab.pinned ? "Unpin" : "Pin"} ${label}`} aria-pressed={tab.pinned} onClick={() => onPin(tab.key)}>{tab.pinned ? "Pinned" : "Pin"}</button><button type="button" aria-label={`Close ${label}`} onClick={() => onClose(tab.key)}>Close</button></span>;
      })}</div>
      <div id={panelId} className="tab-panel" role="tabpanel" aria-labelledby={activeIndex < 0 ? undefined : `${id}-workspace-tab-${activeIndex}`} tabIndex={0}>{active?.type === "file" ? <FilePreview workspace={workspace} path={active.path} /> : active?.type === "diff" ? <DiffPreview workspace={workspace} entry={active.entry} layout={layout} onLayout={onLayout} /> : <p>Select a preview tab.</p>}</div>
    </section>
  );
}

export function WorkspacePresentation({ shell, workspace, sessionId, activePane }: {
  readonly shell: ApplicationShell;
  readonly workspace: WorkspaceState;
  readonly sessionId: string;
  readonly activePane: "explorer" | "changes" | undefined;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [tabs, setTabs] = useState<readonly WorkspaceTab[]>([]);
  const [activeKey, setActiveKey] = useState<string>();
  const [layout, setLayout] = useState<"unified" | "side-by-side">("unified");
  const priorWorkspaceGeneration = useRef<string | undefined>(undefined);
  const priorRepositoryGeneration = useRef<string | undefined>(undefined);

  useEffect(() => {
    setExpanded(new Set());
    setTabs([]);
    setActiveKey(undefined);
    setLayout("unified");
    priorWorkspaceGeneration.current = undefined;
    priorRepositoryGeneration.current = undefined;
    if (shell.supports("session.workspace.list") && shell.supports("session.workspace.status")) {
      void shell.refreshWorkspace().catch(() => undefined);
    }
  }, [sessionId, shell]);

  useEffect(() => {
    const generation = workspace.workspaceGeneration;
    if (generation !== undefined && priorWorkspaceGeneration.current !== undefined && generation !== priorWorkspaceGeneration.current) {
      setExpanded(new Set());
      setTabs((current) => replaceStaleTabs(current, "workspace"));
      setActiveKey(undefined);
      setLayout("unified");
    }
    if (generation !== undefined) priorWorkspaceGeneration.current = generation;
  }, [workspace.workspaceGeneration]);

  useEffect(() => {
    const generation = workspace.repositoryGeneration;
    if (generation !== undefined && priorRepositoryGeneration.current !== undefined && generation !== priorRepositoryGeneration.current) {
      setTabs((current) => {
        const remaining = replaceStaleTabs(current, "repository");
        setActiveKey((currentKey) => remaining.some((tab) => tab.key === currentKey) ? currentKey : remaining[0]?.key);
        return remaining;
      });
      setLayout("unified");
    }
    if (generation !== undefined) priorRepositoryGeneration.current = generation;
  }, [workspace.repositoryGeneration]);

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
  const closeTab = (key: string) => {
    setTabs((current) => {
      const closed = closeWorkspaceTab(current, key);
      if (key === activeKey) setActiveKey(closed.activeKey);
      return closed.tabs;
    });
  };
  const root = workspace.directories[""];
  const allCapabilities = ["session.workspace.list", "session.workspace.read", "session.workspace.status", "session.workspace.diff"] as const;
  const unavailable = allCapabilities.filter((capability) => !shell.supports(capability));
  return (
    <section className="workspace-review" aria-label="Workspace review" hidden={activePane === undefined}>
      <header className="workspace-toolbar">
        <h2>{activePane === "changes" ? "Changes" : "Explorer"}</h2>
        <button type="button" disabled={unavailable.length > 0} onClick={() => void shell.refreshWorkspace().catch(() => undefined)}>Refresh Explorer and Changes</button>
        <label><input type="checkbox" checked={workspace.checkpoint?.enabled ?? false} disabled={!shell.supports("session.workspace.checkpoint")} onChange={(event) => void shell.configureWorkspaceCheckpoint(event.currentTarget.checked).catch(() => undefined)} />Last-turn checkpoints</label>
      </header>
      {unavailable.length === 0 ? null : <p className="warning-inline"><strong>Unavailable:</strong> {unavailable.join(", ")}</p>}
      {workspace.transition === undefined ? null : <WorkspaceErrorState error={workspace.transition} />}
      <div className="workspace-source-pane">
        {activePane === "explorer" ? (
          <section className="explorer" aria-labelledby="explorer-heading">
            <h2 id="explorer-heading">Explorer</h2>
            {root === undefined || root.loading ? <p>Loading one workspace level…</p> : <Directory shell={shell} workspace={workspace} directory={root} expanded={expanded} onToggle={(entry) => {
              const opening = !expanded.has(entry.path);
              setExpanded((current) => { const next = new Set(current); if (opening) next.add(entry.path); else next.delete(entry.path); return next; });
              if (opening && workspace.directories[entry.path] === undefined) void shell.listWorkspace(entry.path).catch(() => undefined);
            }} onFile={openFile} />}
          </section>
        ) : activePane === "changes" ? <Changes workspace={workspace} onDiff={openDiff} /> : null}
      </div>
      {tabs.length === 0 ? null : (
        <PreviewTabs
          tabs={tabs}
          activeKey={activeKey}
          workspace={workspace}
          layout={layout}
          onActivate={setActiveKey}
          onPin={(key) => setTabs((current) => current.map((item) => item.key === key ? { ...item, pinned: !item.pinned } : item))}
          onClose={closeTab}
          onLayout={setLayout}
        />
      )}
    </section>
  );
}
