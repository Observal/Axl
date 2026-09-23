// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { ModelChoice, ThinkingLevel } from "@axl/sdk";
import { filterModelChoices } from "./model-picker-state.ts";

export function ModelPicker({
  choices,
  provider,
  model,
  thinking,
  disabled,
  error,
  unavailableReason,
  openRequest,
  initialFocus = "model",
  onModel,
  onThinking,
}: {
  readonly choices: readonly ModelChoice[];
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly thinking: ThinkingLevel | undefined;
  readonly disabled: boolean;
  readonly error?: string;
  readonly unavailableReason?: string;
  readonly openRequest?: number;
  readonly initialFocus?: "model" | "thinking";
  readonly onModel: (choice: ModelChoice) => void;
  readonly onThinking: (level: ThinkingLevel) => void;
}): JSX.Element {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = choices.find(
    (choice) => choice.providerId === provider && choice.modelId === model,
  );
  const levels = selected?.thinkingLevels ?? [];
  const groups = useMemo(() => filterModelChoices(choices, query), [choices, query]);
  const visibleCount = [...groups.values()].reduce((count, models) => count + models.length, 0);
  const close = (): void => {
    details.current?.removeAttribute("open");
    setQuery("");
  };
  const focusPicker = (): void => {
    queueMicrotask(() => {
      const target =
        initialFocus === "thinking"
          ? (details.current?.querySelector<HTMLButtonElement>(".effort-options button") ??
            search.current)
          : search.current;
      target?.focus();
    });
  };
  useEffect(() => {
    if (openRequest === undefined || openRequest === 0) return;
    details.current?.setAttribute("open", "");
    focusPicker();
  }, [openRequest, initialFocus]);
  useEffect(() => {
    if (!open) return;
    // Close the menu when the pointer goes down outside it, like the usage panel.
    const onPointerDown = (event: PointerEvent): void => {
      if (details.current !== null && !details.current.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  return (
    <span className="model-picker-shell">
    <details
      className="model-picker"
      ref={details}
      onToggle={(event) => {
        const isOpen = event.currentTarget.open;
        if (disabled && isOpen) {
          close();
          return;
        }
        setOpen(isOpen);
        if (isOpen) focusPicker();
        else setQuery("");
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !event.currentTarget.open) return;
        event.preventDefault();
        event.stopPropagation();
        close();
        summary.current?.focus();
      }}
    >
      <summary
        ref={summary}
        aria-label="Choose model and effort"
        aria-disabled={disabled}
        aria-keyshortcuts="Control+L Meta+L"
        title={unavailableReason ?? "Choose model (Ctrl/⌘+L)"}
        onClick={(event) => {
          if (!disabled) return;
          event.preventDefault();
        }}
      >
        <span>{model ?? "Daemon default"}</span>
        {thinking && (
          <>
            <i>·</i>
            <span>{thinking}</span>
          </>
        )}
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" />
        </svg>
      </summary>
      <div
        className="model-menu"
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const focusables = Array.from(
            details.current?.querySelectorAll<HTMLElement>(
              ".model-options button:not([disabled]), .effort-options button:not([disabled])",
            ) ?? [],
          );
          if (focusables.length === 0) return;
          event.preventDefault();
          const activeIndex = focusables.indexOf(document.activeElement as HTMLElement);
          if (event.key === "ArrowDown") {
            (activeIndex < 0
              ? focusables[0]
              : focusables[Math.min(activeIndex + 1, focusables.length - 1)]
            )?.focus();
          } else if (activeIndex <= 0) {
            search.current?.focus();
          } else {
            focusables[activeIndex - 1]?.focus();
          }
        }}
      >
        <label className="model-search">
          <span className="sr-only">Search models</span>
          <input
            ref={search}
            type="search"
            value={query}
            placeholder="Search models"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="model-options" aria-label="Models">
          {visibleCount === 0 && (
            <p className="model-empty">{choices.length === 0 ? "No models available" : "No matching models"}</p>
          )}
          {[...groups].map(([providerId, models]) => (
            <section className="model-provider-group" key={providerId}>
              <p className="model-menu-label">
                {models[0]?.providerDisplayName ?? providerId}
              </p>
              {models.map((choice) => {
                const active = choice.providerId === provider && choice.modelId === model;
                const unavailable = choice.availability.status === "unavailable";
                return (
                  <button
                    key={`${choice.providerId}:${choice.modelId}`}
                    type="button"
                    className={active ? "selected" : ""}
                    disabled={disabled || unavailable}
                    onClick={() => {
                      onModel(choice);
                      close();
                    }}
                  >
                    <i aria-hidden="true">{active ? "✓" : ""}</i>
                    <span>
                      <strong>{choice.displayName}</strong>
                      <small>
                        {unavailable ? choice.availability.reason ?? "Unavailable" : choice.modelId}
                      </small>
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
        {levels.length > 0 && (
          <>
            <div className="model-menu-rule" />
            <p className="model-menu-label">Reasoning effort</p>
            <div className="effort-options">
              {levels.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={level === thinking ? "selected" : ""}
                  disabled={disabled}
                  onClick={() => {
                    onThinking(level);
                    close();
                  }}
                >
                  <i aria-hidden="true">{level === thinking ? "✓" : ""}</i>
                  <span>{level}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </details>
      {error && (
        <span className="model-error-toast" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
