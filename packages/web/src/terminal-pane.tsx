// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";

import type { TerminalEntry } from "./panes.ts";

export interface TerminalRun {
  readonly command: string;
  readonly cancelling: boolean;
}

export function TerminalPane({
  entries,
  running,
  error,
  disabled,
  cwd,
  onRun,
  onCancel,
}: {
  readonly entries: readonly TerminalEntry[];
  readonly running?: TerminalRun | undefined;
  readonly error?: string | undefined;
  readonly disabled: boolean;
  readonly cwd: string;
  readonly onRun: (command: string, excluded: boolean) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const [input, setInput] = useState("");
  const [excluded, setExcluded] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number>();
  /** Entries before this id are hidden after Ctrl+L; the canonical log is untouched. */
  const [clearedBefore, setClearedBefore] = useState<string>();
  const output = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const history = entries.map((entry) => entry.command);
  const clearedIndex = clearedBefore === undefined ? -1 : entries.findIndex((entry) => entry.id === clearedBefore);
  const visible = clearedIndex < 0 ? entries : entries.slice(clearedIndex + 1);

  useEffect(() => {
    output.current?.scrollTo({ top: output.current.scrollHeight });
  }, [entries.length, running?.command]);

  useEffect(() => {
    if (running === undefined) field.current?.focus({ preventScroll: true });
  }, [running]);

  const submit = (): void => {
    const command = input.trim();
    if (command === "" || running !== undefined || disabled) return;
    setInput("");
    setHistoryIndex(undefined);
    onRun(command, excluded);
  };

  const recall = (direction: -1 | 1): void => {
    if (history.length === 0) return;
    const current = historyIndex ?? history.length;
    const next = Math.max(0, Math.min(history.length, current + direction));
    setHistoryIndex(next === history.length ? undefined : next);
    setInput(next === history.length ? "" : (history[next] ?? ""));
  };

  const prompt = cwd.split("/").filter(Boolean).at(-1) ?? "/";

  return (
    <div className="terminal-pane" onClick={(event) => { if (event.target === event.currentTarget) field.current?.focus(); }}>
      <div className="terminal-output" ref={output} aria-live="polite" aria-label="Shell output">
        {visible.length === 0 && running === undefined && (
          <p className="terminal-hint">
            {entries.length === 0
              ? "Commands run in the session sandbox through the daemon. Output joins the transcript unless you exclude it. ↑↓ history · Ctrl+C cancel · Ctrl+L clear"
              : "Cleared. Earlier output stays in the transcript."}
          </p>
        )}
        {visible.map((entry) => (
          <article key={entry.id} className={`terminal-entry${entry.isError ? " failed" : ""}`}>
            <div className="terminal-command">
              <span className="terminal-prompt" aria-hidden="true">{prompt} ❯</span>
              <code>{entry.command}</code>
              {entry.excluded && <small title="Output was excluded from the model context">excluded</small>}
            </div>
            {entry.output !== "" && <pre>{entry.output}</pre>}
          </article>
        ))}
        {running && (
          <article className="terminal-entry running">
            <div className="terminal-command">
              <span className="terminal-prompt" aria-hidden="true">{prompt} ❯</span>
              <code>{running.command}</code>
              <button type="button" onClick={onCancel} disabled={running.cancelling}>
                {running.cancelling ? "Cancelling…" : "Cancel"}
              </button>
            </div>
            <div className="terminal-running"><i className="loading-ring" />Running</div>
          </article>
        )}
        {error && <p className="terminal-error" role="alert">{error}</p>}
      </div>
      <form
        className="terminal-input"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <span className="terminal-prompt" aria-hidden="true">{prompt} ❯</span>
        <input
          ref={field}
          type="text"
          value={input}
          spellCheck={false}
          autoComplete="off"
          aria-label="Shell command"
          placeholder={disabled ? "Shell is unavailable" : "Run a command"}
          disabled={disabled}
          readOnly={running !== undefined}
          onChange={(event) => {
            setInput(event.target.value);
            setHistoryIndex(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault();
              recall(-1);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              recall(1);
            } else if (event.ctrlKey && event.key.toLocaleLowerCase() === "l") {
              event.preventDefault();
              setClearedBefore(entries.at(-1)?.id);
            } else if (event.ctrlKey && event.key.toLocaleLowerCase() === "c" && running !== undefined) {
              event.preventDefault();
              onCancel();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setInput("");
              setHistoryIndex(undefined);
            }
          }}
        />
        <button
          type="button"
          className={excluded ? "terminal-toggle active" : "terminal-toggle"}
          aria-pressed={excluded}
          title={excluded ? "Output stays out of the model context" : "Output is shared with the model"}
          onClick={() => setExcluded((value) => !value)}
        >
          {excluded ? "private" : "shared"}
        </button>
      </form>
    </div>
  );
}
