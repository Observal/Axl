// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type JSX } from "react";

import { paneChoices, type PaneId } from "./panes.ts";

const PANE_ICONS: Readonly<Record<PaneId, JSX.Element>> = {
  browser: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 6h12M4.5 4.5h.01M6.5 4.5h.01" /></svg>,
  files: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h4l1.2 1.5h5.8v7h-11z" /></svg>,
  changes: <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><circle cx="12" cy="5.5" r="1.5" /><path d="M4 5v6M5.5 10.5c4 0 6.5-1 6.5-3.5" /></svg>,
  terminal: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 4.5 3.5 3.5L3 11.5M8 12h5" /></svg>,
};

export function PanePicker({
  openPanes,
  unavailableReasons,
  badges = {},
  onToggle,
}: {
  readonly openPanes: readonly PaneId[];
  readonly unavailableReasons: Readonly<Record<PaneId, string | undefined>>;
  readonly badges?: Readonly<Partial<Record<PaneId, number>>>;
  readonly onToggle: (pane: PaneId) => void;
}): JSX.Element {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);

  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !details.current?.contains(event.target)) {
        details.current?.removeAttribute("open");
      }
    };
    addEventListener("pointerdown", dismiss);
    return () => removeEventListener("pointerdown", dismiss);
  }, []);

  return (
    <details
      className="pane-picker"
      ref={details}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !event.currentTarget.open) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.removeAttribute("open");
        summary.current?.focus();
      }}
    >
      <summary
        ref={summary}
        aria-label={`Choose visible panes, ${openPanes.length} open`}
        title="Choose visible panes"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M8 2.5v11" /></svg>
        <span>Panes</span>
        <b>{openPanes.length}</b>
        <svg className="pane-picker-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
      </summary>
      <fieldset className="pane-picker-options">
        <legend className="sr-only">Visible panes</legend>
        {paneChoices(openPanes, unavailableReasons).map((choice) => {
          const badge = badges[choice.id];
          return (
            <label
              key={choice.id}
              className={`pane-picker-option${choice.unavailableReason === undefined ? "" : " unavailable"}`}
              title={choice.unavailableReason}
            >
              <input
                type="checkbox"
                checked={choice.open}
                disabled={choice.disabled}
                aria-describedby={`pane-${choice.id}-state`}
                onChange={() => onToggle(choice.id)}
              />
              {PANE_ICONS[choice.id]}
              <span>
                <strong>{choice.label}</strong>
                <small id={`pane-${choice.id}-state`}>{choice.state}</small>
              </span>
              {badge !== undefined && badge > 0 && <b>{badge}</b>}
            </label>
          );
        })}
      </fieldset>
    </details>
  );
}
