// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState, type JSX } from "react";
import type {
  ModelChoice,
  NewSessionDraft,
  NewSessionDraftUpdate,
  ThinkingLevel,
} from "@axl/sdk";
import { trapDialogFocus } from "./dialog-focus.ts";
import type { ProjectFolderValidation } from "./environment.ts";
import { ModelPicker } from "./model-picker.tsx";
import { WebToolControls } from "./web-tool-controls.tsx";

export function NewSessionDialog({
  draft,
  models,
  modelPickerOpenRequest,
  busy,
  error,
  unavailableReason,
  projectFolders,
  onChange,
  onValidateProjectFolder,
  onSubmit,
  onClose,
}: {
  readonly draft: NewSessionDraft;
  readonly models: readonly ModelChoice[];
  readonly modelPickerOpenRequest: number;
  readonly busy: boolean;
  readonly error?: string;
  readonly unavailableReason?: string;
  readonly projectFolders: readonly string[];
  readonly onChange: (update: NewSessionDraftUpdate) => void;
  readonly onValidateProjectFolder?: (
    path: string,
    signal: AbortSignal,
  ) => Promise<ProjectFolderValidation>;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const dialog = useRef<HTMLElement>(null);
  const projectFolder = draft.workspace?.trim() ?? "";
  const [folderValidation, setFolderValidation] = useState<
    ProjectFolderValidation | "checking"
  >();
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => prior?.focus();
  }, []);

  useEffect(() => {
    if (draft.mode !== "code" || projectFolder === "") {
      setFolderValidation(undefined);
      return;
    }
    if (onValidateProjectFolder === undefined) {
      setFolderValidation({ valid: false, error: "Project folder validation is unavailable" });
      return;
    }
    const controller = new AbortController();
    setFolderValidation("checking");
    const timer = setTimeout(() => {
      void onValidateProjectFolder(projectFolder, controller.signal).then(
        setFolderValidation,
        (cause: unknown) => {
          if (!controller.signal.aborted)
            setFolderValidation({
              valid: false,
              error: cause instanceof Error ? cause.message : "Could not validate project folder",
            });
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draft.mode, projectFolder, onValidateProjectFolder]);

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onClose();
      return;
    }
    trapDialogFocus(event, dialog.current);
  };

  const selected = models.find(
    (model) => model.providerId === draft.providerId && model.modelId === draft.modelId,
  );
  const updateModel = (model: ModelChoice): void => {
    onChange({
      providerId: model.providerId,
      modelId: model.modelId,
      ...(draft.thinkingLevel !== undefined && !model.thinkingLevels.includes(draft.thinkingLevel)
        ? { thinkingLevel: undefined }
        : {}),
    });
  };
  const updateThinking = (thinkingLevel: ThinkingLevel): void => onChange({ thinkingLevel });
  const projectFolderReady =
    draft.mode !== "code" ||
    (folderValidation !== undefined &&
      folderValidation !== "checking" &&
      folderValidation.valid);

  return <div className="control-scrim">
    <section className="new-session-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="new-session-title" onKeyDown={handleKeyDown}>
      <header>
        <span><strong id="new-session-title">New session</strong><small>Set the working context before Axl starts.</small></span>
        <button type="button" aria-label="Close" disabled={busy} onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button>
      </header>
      <div className="new-session-body">
        <section className="new-session-step" aria-labelledby="session-mode-label">
          <header><strong id="session-mode-label">Choose a session type</strong><small>Chat stays focused. Code adds a project folder and tools.</small></header>
          <div className="session-mode" role="group" aria-label="Session mode">
            <button type="button" disabled={busy} aria-pressed={draft.mode === "chat"} onClick={() => onChange({ mode: "chat" })}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 4.5h13v8h-7l-4 3v-3h-2z" /></svg><span><strong>Chat</strong><small>Talk without project files</small></span></button>
            <button type="button" disabled={busy} aria-pressed={draft.mode === "code"} onClick={() => onChange({ mode: "code" })}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5-5 5 5 5m6-10 5 5-5 5m-2-12L9 17" /></svg><span><strong>Code</strong><small>Work inside one project folder</small></span></button>
          </div>
        </section>
        {draft.mode === "code" && <section className="new-session-step"><div className="new-session-workspace"><label htmlFor="project-folder"><strong>Project folder</strong><small>Axl can read and modify files here through granted tools.</small></label><div className="project-folder-field"><input id="project-folder" list="project-folder-paths" value={draft.workspace ?? ""} disabled={busy} aria-describedby="project-folder-status" aria-invalid={folderValidation !== undefined && folderValidation !== "checking" && !folderValidation.valid} onChange={(event) => onChange({ workspace: event.target.value })} placeholder="/path/to/project" autoComplete="off" spellCheck={false} /><datalist id="project-folder-paths">{projectFolders.map((path) => <option value={path} key={path} />)}</datalist>{projectFolders.length > 0 && <div className="project-folder-suggestions" role="group" aria-label="Suggested project folders">{projectFolders.map((path, index) => <button type="button" key={path} title={path} disabled={busy} onClick={() => onChange({ workspace: path })}>{index === 0 ? "Current" : "Recent"}: {path}</button>)}</div>}<small id="project-folder-status" className={folderValidation !== undefined && folderValidation !== "checking" && !folderValidation.valid ? "error" : ""} role="status">{folderValidation === "checking" ? "Checking folder…" : folderValidation?.valid === true ? `Ready: ${folderValidation.path}` : folderValidation?.error}</small></div></div></section>}
        <section className="new-session-step">
          <div className="new-session-model"><span><strong>Model and effort</strong><small>{selected === undefined ? "Use the daemon defaults or choose now" : `${selected.providerDisplayName} · ${selected.displayName}`}</small></span><ModelPicker choices={models} provider={draft.providerId} model={draft.modelId} thinking={draft.thinkingLevel} openRequest={modelPickerOpenRequest} disabled={busy} onModel={updateModel} onThinking={updateThinking} /></div>
        </section>
        {draft.mode === "code" && <section className="new-session-step"><WebToolControls webSearch={draft.webSearch} webFetch={draft.webFetch} staged disabled={busy} onChange={(field, value) => onChange(field === "webSearch" ? { webSearch: value } : { webFetch: value })} /></section>}
        {error && <p className="new-session-error" role="alert">{error}</p>}
        {unavailableReason && <p className="new-session-error" role="status">{unavailableReason}</p>}
      </div>
      <footer><span>Your choices are applied together when the session starts.</span><div><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="primary" title={unavailableReason} disabled={busy || unavailableReason !== undefined || !projectFolderReady} onClick={onSubmit}>{busy ? "Creating…" : `Create ${draft.mode === "chat" ? "Chat" : "Code"}`}</button></div></footer>
    </section>
  </div>;
}
