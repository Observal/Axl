// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, type CSSProperties, type ReactNode } from "react";

export interface SplitState {
  /** Width of the primary (left) side in pixels. */
  readonly size: number;
  readonly collapsed: boolean;
}

export const MIN_SPLIT_PRIMARY = 140;
const MIN_SPLIT_SECONDARY = 220;
const MAX_SPLIT_PRIMARY = 1_000;

export function clampSplit(size: number, containerWidth: number): number {
  if (containerWidth <= 0) return Math.max(MIN_SPLIT_PRIMARY, size);
  return Math.round(
    Math.max(MIN_SPLIT_PRIMARY, Math.min(size, containerWidth - MIN_SPLIT_SECONDARY)),
  );
}

/**
 * Two-column split with a draggable divider. The primary column can collapse to zero;
 * the column track animates so collapse and expand read as one motion.
 */
export function SplitPane({
  state,
  onState,
  label,
  primary,
  secondary,
}: {
  readonly state: SplitState;
  readonly onState: (state: SplitState) => void;
  readonly label: string;
  readonly primary: ReactNode;
  readonly secondary: ReactNode;
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const containerWidth = (): number => container.current?.getBoundingClientRect().width ?? 0;

  const startDrag = (event: React.PointerEvent): void => {
    event.preventDefault();
    const left = container.current?.getBoundingClientRect().left ?? 0;
    let next = state;
    setDragging(true);
    document.body.classList.add("resizing-panels");
    const move = (pointer: PointerEvent): void => {
      next = { size: clampSplit(pointer.clientX - left, containerWidth()), collapsed: false };
      onState(next);
    };
    const stop = (): void => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", stop);
      removeEventListener("pointercancel", stop);
      document.body.classList.remove("resizing-panels");
      setDragging(false);
      onState(next);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", stop, { once: true });
    addEventListener("pointercancel", stop, { once: true });
  };

  return (
    <div
      ref={container}
      className={`split${state.collapsed ? " collapsed" : ""}${dragging ? " dragging" : ""}`}
      style={{ "--split": `${state.size}px` } as CSSProperties}
    >
      <div className="split-primary">{primary}</div>
      {!state.collapsed && (
        <div
          className="split-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label}`}
          aria-valuemin={MIN_SPLIT_PRIMARY}
          aria-valuemax={MAX_SPLIT_PRIMARY}
          aria-valuenow={state.size}
          aria-valuetext={`${state.size} pixels wide`}
          aria-keyshortcuts="ArrowLeft ArrowRight Home End"
          tabIndex={0}
          onPointerDown={startDrag}
          onDoubleClick={() => onState({ ...state, collapsed: true })}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const size = event.key === "Home"
              ? MIN_SPLIT_PRIMARY
              : event.key === "End"
                ? Number.MAX_SAFE_INTEGER
                : state.size + (event.key === "ArrowLeft" ? -16 : 16);
            onState({ size: clampSplit(size, containerWidth()), collapsed: false });
          }}
        />
      )}
      <div className="split-secondary">{secondary}</div>
    </div>
  );
}

export function SplitToggle({
  state,
  onState,
  label,
}: {
  readonly state: SplitState;
  readonly onState: (state: SplitState) => void;
  readonly label: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={state.collapsed ? "icon-button" : "icon-button active"}
      aria-pressed={!state.collapsed}
      aria-label={state.collapsed ? `Show ${label}` : `Hide ${label}`}
      title={state.collapsed ? `Show ${label}` : `Hide ${label}`}
      onClick={() => onState({ ...state, collapsed: !state.collapsed })}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6.5 2.5v11" /></svg>
    </button>
  );
}
