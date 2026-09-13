// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";

import { parseBrowserTarget } from "./panes.ts";

export interface BrowserPaneState {
  /** Currently framed loopback URL. */
  readonly url?: string;
  /** Bumps to reload the frame without changing the URL. */
  readonly generation: number;
}

const SUGGESTED_PORTS = [3000, 5173, 8080] as const;

export function BrowserPane({
  state,
  onState,
}: {
  readonly state: BrowserPaneState;
  readonly onState: (state: BrowserPaneState) => void;
}): React.JSX.Element {
  const [input, setInput] = useState(state.url ?? "");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [loading, setLoading] = useState(state.url !== undefined);

  useEffect(() => {
    setInput(state.url ?? "");
    setLoading(state.url !== undefined);
  }, [state.url, state.generation]);

  const navigate = (value: string): void => {
    setError(undefined);
    setNotice(undefined);
    let target: ReturnType<typeof parseBrowserTarget>;
    try {
      target = parseBrowserTarget(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid URL");
      return;
    }
    if (target.kind === "external") {
      window.open(target.url, "_blank", "noopener,noreferrer");
      setNotice("Only loopback servers can be shown here. That page opened in a new tab.");
      return;
    }
    onState({ url: target.url, generation: state.generation + 1 });
  };

  return (
    <div className="browser-pane">
      <form
        className="browser-bar"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(input);
        }}
      >
        <button
          type="button"
          className="icon-button"
          aria-label="Reload"
          disabled={state.url === undefined}
          onClick={() => onState({ ...state, generation: state.generation + 1 })}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 6a5 5 0 1 0 .2 3M13 2.5V6H9.5" /></svg>
        </button>
        <input
          type="text"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          aria-label="Browser address"
          aria-invalid={error !== undefined}
          placeholder="localhost:5173"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onFocus={(event) => event.target.select()}
        />
        {state.url !== undefined && (
          <a
            className="icon-button"
            href={state.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in a new tab"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11 9.5v4H2.5V5h4" /></svg>
          </a>
        )}
      </form>
      {(error ?? notice) !== undefined && (
        <p className={error === undefined ? "browser-note" : "browser-note error"} role={error === undefined ? "status" : "alert"}>
          {error ?? notice}
        </p>
      )}
      {state.url === undefined ? (
        <div className="pane-empty">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></svg>
          <strong>Preview a local server</strong>
          <span>Loopback pages render here. Other sites open in a new tab.</span>
          <div className="pane-chips">
            {SUGGESTED_PORTS.map((port) => (
              <button type="button" key={port} onClick={() => navigate(`localhost:${port}`)}>
                localhost:{port}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className={`browser-frame${loading ? " loading" : ""}`}>
          <iframe
            key={`${state.url}#${state.generation}`}
            title="Browser preview"
            src={state.url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            referrerPolicy="no-referrer"
            onLoad={() => setLoading(false)}
          />
          {loading && <div className="browser-loading" role="status"><i className="loading-ring" />Loading…</div>}
        </div>
      )}
    </div>
  );
}
