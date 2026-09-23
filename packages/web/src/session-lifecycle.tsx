// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@axl/sdk";
import { trapDialogFocus } from "./dialog-focus.ts";

export function SessionLifecycle({
  session,
  busy,
  capabilities,
  error,
  onRename,
  onClone,
  onExport,
  onDispose,
  onDelete,
  onClose,
}: {
  readonly session: SessionSummary;
  readonly busy: boolean;
  readonly capabilities: ReadonlySet<string>;
  readonly error?: string;
  readonly onRename: (title: string) => void;
  readonly onClone: () => void;
  readonly onExport: () => void;
  readonly onDispose: () => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const panel = useRef<HTMLElement>(null);
  const canonicalTitle = session.title ?? session.firstUserMessage ?? "";
  const [title, setTitle] = useState(canonicalTitle);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const operationActive = ["running", "waiting_interaction", "disposing"].includes(session.runtime.state);
  const lastCanonical = useRef(canonicalTitle);

  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    panel.current?.querySelector<HTMLElement>("input")?.focus();
    return () => prior?.focus();
  }, []);

  // Another attached client can rename the session while this dialog is open.
  // Resync the untouched field to the new name; warn instead of silently
  // reverting when the user has unsaved edits.
  useEffect(() => {
    if (canonicalTitle === lastCanonical.current) return;
    lastCanonical.current = canonicalTitle;
    if (dirty) setConflict(true);
    else setTitle(canonicalTitle);
  }, [canonicalTitle, dirty]);

  const trapFocus = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    trapDialogFocus(event, panel.current);
  };

  return <div className="control-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="session-lifecycle" ref={panel} role="dialog" aria-modal="true" aria-labelledby="session-lifecycle-title" onKeyDown={trapFocus}>
      <header><div><strong id="session-lifecycle-title">Session controls</strong><small>{session.sessionId}</small></div><button className="control-close" aria-label="Close" onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button></header>
      <form onSubmit={(event) => { event.preventDefault(); onRename(title.trim()); }}>
        <label htmlFor="session-title">Name</label>
        <div><input id="session-title" value={title} maxLength={256} onChange={(event) => { setTitle(event.target.value); setDirty(true); }} /><button title={capabilities.has("session.rename") ? undefined : "Unavailable because session rename was not granted"} disabled={busy || operationActive || !title.trim() || title.trim() === canonicalTitle || !capabilities.has("session.rename")}>Save</button></div>
      </form>
      {conflict && <p className="lifecycle-conflict" role="alert">Renamed to "{canonicalTitle}" from another client. Saving replaces it.<button type="button" onClick={() => { setTitle(canonicalTitle); setDirty(false); setConflict(false); }}>Use latest</button></p>}
      {error && <p className="lifecycle-error" role="alert">{error}</p>}
      <div className="lifecycle-actions">
        <button title={capabilities.has("session.clone") ? undefined : "Unavailable because session clone was not granted"} disabled={busy || operationActive || !capabilities.has("session.clone")} onClick={onClone}><span><strong>Clone session</strong><small>Create a complete independent copy.</small></span></button>
        <button title={capabilities.has("session.export") ? undefined : "Unavailable because session export was not granted"} disabled={busy || operationActive || !capabilities.has("session.export")} onClick={onExport}><span><strong>Export artifact</strong><small>Download durable history and attachments.</small></span></button>
        <button title={capabilities.has("session.dispose") ? undefined : "Unavailable because session disposal was not granted"} disabled={busy || ["inactive", "disposing"].includes(session.runtime.state) || !capabilities.has("session.dispose")} onClick={onDispose}><span><strong>End runtime</strong><small>Stop execution while preserving durable history.</small></span></button>
        {!confirmDelete ? <button className="danger" title={capabilities.has("session.delete") ? undefined : "Unavailable because session deletion was not granted"} disabled={busy || operationActive || !capabilities.has("session.delete")} onClick={() => setConfirmDelete(true)}><span><strong>Delete history</strong><small>Permanently remove this session from the daemon.</small></span></button> : <div className="delete-confirm" role="alert"><p><strong>Delete this session permanently?</strong><span>This removes its durable history and cannot be undone.</span></p><div><button disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button><button className="danger" disabled={busy || operationActive} onClick={onDelete}>Delete permanently</button></div></div>}
      </div>
    </section>
  </div>;
}
