// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  PANE_IDS,
  PANE_LABELS,
  type PaneId,
  type PaneLayout,
  closePane,
  paneFractions,
  resizePane,
  toggleZoom,
} from "./panes.ts";

/** Keep in sync with --dock-motion in styles.css. */
const TILE_MOTION_MS = 360;

interface DockProps {
  readonly layout: PaneLayout;
  readonly onLayout: (layout: PaneLayout) => void;
  readonly renderPane: (pane: PaneId) => ReactNode;
  readonly renderControls?: (pane: PaneId) => ReactNode;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/**
 * Tiles open panes vertically. Tiles keep a stable canonical order and animate
 * their share of the column through flex-grow so opening, closing, zooming, and
 * resizing all move along one path.
 */
export function Dock({ layout, onLayout, renderPane, renderControls }: DockProps): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion();
  const dock = useRef<HTMLElement>(null);
  const [mounted, setMounted] = useState<ReadonlySet<PaneId>>(() => new Set(layout.panes));
  const [entered, setEntered] = useState<ReadonlySet<PaneId>>(() => new Set(layout.panes));
  const [resizing, setResizing] = useState(false);
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const exitTimers = useRef(new Map<PaneId, ReturnType<typeof setTimeout>>());

  useLayoutEffect(() => {
    const open = new Set(layout.panes);
    const opening = layout.panes.filter((pane) => !mountedRef.current.has(pane) || exitTimers.current.has(pane));
    for (const pane of opening) {
      const timer = exitTimers.current.get(pane);
      if (timer !== undefined) {
        clearTimeout(timer);
        exitTimers.current.delete(pane);
      }
    }
    if (opening.length > 0) setMounted((current) => new Set([...current, ...opening]));
    for (const pane of mountedRef.current) {
      if (open.has(pane) || exitTimers.current.has(pane)) continue;
      const remove = (): void => {
        exitTimers.current.delete(pane);
        setMounted((current) => {
          if (!current.has(pane)) return current;
          const next = new Set(current);
          next.delete(pane);
          return next;
        });
        setEntered((current) => {
          if (!current.has(pane)) return current;
          const next = new Set(current);
          next.delete(pane);
          return next;
        });
      };
      exitTimers.current.set(pane, setTimeout(remove, reducedMotion ? 0 : TILE_MOTION_MS));
    }
  }, [layout.panes, reducedMotion]);

  useEffect(() => {
    const pending = layout.panes.filter((pane) => !entered.has(pane));
    if (pending.length === 0) return;
    const frame = requestAnimationFrame(() => {
      setEntered((current) => new Set([...current, ...pending]));
    });
    return () => cancelAnimationFrame(frame);
  }, [layout.panes, entered]);

  useEffect(() => () => {
    for (const timer of exitTimers.current.values()) clearTimeout(timer);
  }, []);

  const fractions = new Map<PaneId, number>();
  paneFractions(layout).forEach((fraction, index) => {
    const pane = layout.panes[index];
    if (pane !== undefined) fractions.set(pane, fraction);
  });
  const visible = PANE_IDS.filter((pane) => mounted.has(pane));
  const tiled = layout.zoomed === undefined ? layout.panes : [];

  const dockHeight = (): number => dock.current?.getBoundingClientRect().height ?? 0;

  const startResize = (index: number, event: React.PointerEvent): void => {
    event.preventDefault();
    const startY = event.clientY;
    const start = layout;
    const height = dockHeight();
    let next = layout;
    setResizing(true);
    document.body.classList.add("resizing-panes", "resizing-rows");
    const move = (pointer: PointerEvent): void => {
      next = resizePane(start, index, pointer.clientY - startY, height);
      onLayout(next);
    };
    const stop = (): void => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", stop);
      removeEventListener("pointercancel", stop);
      document.body.classList.remove("resizing-panes", "resizing-rows");
      setResizing(false);
      onLayout(next);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", stop, { once: true });
    addEventListener("pointercancel", stop, { once: true });
  };

  return (
    <section
      ref={dock}
      className={`dock${resizing ? " resizing" : ""}`}
      aria-label="Panes"
    >
      {visible.map((pane) => {
        const open = layout.panes.includes(pane);
        const grow = open && entered.has(pane) ? (fractions.get(pane) ?? 0) : 0;
        const zoomed = layout.zoomed === pane;
        const tileIndex = tiled.indexOf(pane);
        const showSeparator = tileIndex >= 0 && tileIndex < tiled.length - 1;
        return (
          <article
            key={pane}
            className={`pane${open ? "" : " closing"}${grow === 0 ? " collapsed" : ""}${zoomed ? " zoomed" : ""}`}
            style={{ "--grow": grow } as CSSProperties}
            aria-label={`${PANE_LABELS[pane]} pane`}
            aria-hidden={!open}
            data-pane={pane}
          >
            <div className="pane-surface">
              <header className="pane-header">
                <h2>{PANE_LABELS[pane]}</h2>
                <div className="pane-controls">
                  {renderControls?.(pane)}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={zoomed ? `Restore ${PANE_LABELS[pane]} tile` : `Zoom ${PANE_LABELS[pane]} pane`}
                    aria-pressed={zoomed}
                    disabled={layout.panes.length < 2}
                    onClick={() => onLayout(toggleZoom(layout, pane))}
                  >
                    {zoomed ? (
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M2.5 6.5 6 3M13.5 9.5 10 13" /></svg>
                    ) : (
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9.5 6.5M2.5 13.5l4-4" /></svg>
                    )}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Close ${PANE_LABELS[pane]} pane`}
                    onClick={() => onLayout(closePane(layout, pane))}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
                  </button>
                </div>
              </header>
              <div className="pane-body">{renderPane(pane)}</div>
            </div>
            {showSeparator && (
              <div
                className="pane-resizer"
                role="separator"
                aria-orientation="horizontal"
                aria-label={`Resize ${PANE_LABELS[pane]} pane`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round((fractions.get(pane) ?? 0) * 100)}
                tabIndex={0}
                onPointerDown={(event) => startResize(tileIndex, event)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  onLayout(resizePane(layout, tileIndex, event.key === "ArrowUp" ? -24 : 24, dockHeight()));
                }}
              />
            )}
          </article>
        );
      })}
    </section>
  );
}
