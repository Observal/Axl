// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";

import { parseBrowserTarget } from "./panes.ts";

export interface BrowserPaneState {
  /** Pages visited in this pane. The iframe's own navigation is opaque to us. */
  readonly history: readonly string[];
  /** Index into history, or -1 when nothing is open. */
  readonly index: number;
  /** Bumps to reload the frame without changing the URL. */
  readonly generation: number;
}

export const EMPTY_BROWSER_STATE: BrowserPaneState = { history: [], index: -1, generation: 0 };

export function browserUrl(state: BrowserPaneState): string | undefined {
  return state.history[state.index];
}

export function browserNavigate(state: BrowserPaneState, url: string): BrowserPaneState {
  const history = [...state.history.slice(0, state.index + 1), url];
  return { history, index: history.length - 1, generation: state.generation + 1 };
}

const SUGGESTIONS = ["localhost:3000", "localhost:5173", "localhost:8080"] as const;

export function BrowserPane({
  state,
  onState,
}: {
  readonly state: BrowserPaneState;
  readonly onState: (state: BrowserPaneState) => void;
}): React.JSX.Element {
  const url = browserUrl(state);
  const [input, setInput] = useState(url ?? "");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(url !== undefined);
  const [showEmbedHint, setShowEmbedHint] = useState(false);
  const hintedOrigins = useRef(new Set<string>());

  useEffect(() => {
    setInput(url ?? "");
    setLoading(url !== undefined);
    setShowEmbedHint(false);
  }, [url, state.generation]);

  useEffect(() => {
    if (!showEmbedHint) return;
    const timer = setTimeout(() => setShowEmbedHint(false), 8000);
    return () => clearTimeout(timer);
  }, [showEmbedHint]);

  const navigate = (value: string): void => {
    setError(undefined);
    try {
      const target = parseBrowserTarget(value);
      onState(browserNavigate(state, target.url));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid URL");
    }
  };

  const loaded = (): void => {
    setLoading(false);
    // Cross-origin frames give no signal when a site refuses embedding, so surface the escape
    // hatch once per origin.
    if (url === undefined) return;
    const target = parseBrowserTarget(url);
    const origin = new URL(target.url).origin;
    if (target.loopback || hintedOrigins.current.has(origin)) return;
    hintedOrigins.current.add(origin);
    setShowEmbedHint(true);
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
          aria-label="Back"
          disabled={state.index <= 0}
          onClick={() => onState({ ...state, index: state.index - 1, generation: state.generation + 1 })}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9.5 3.5-4.5 4.5 4.5 4.5" /></svg>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Forward"
          disabled={state.index < 0 || state.index >= state.history.length - 1}
          onClick={() => onState({ ...state, index: state.index + 1, generation: state.generation + 1 })}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6.5 3.5 4.5 4.5-4.5 4.5" /></svg>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Reload"
          disabled={url === undefined}
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
          placeholder="Enter a URL"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onFocus={(event) => event.target.select()}
        />
        {url !== undefined && (
          <a
            className="icon-button"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in a new tab"
            title="Open in a new tab"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11 9.5v4H2.5V5h4" /></svg>
          </a>
        )}
      </form>
      {error !== undefined && <p className="browser-note error" role="alert">{error}</p>}
      {url === undefined ? (
        <div className="pane-empty">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></svg>
          <strong>Open a page</strong>
          <span>Preview a dev server or any web page. Sites that refuse embedding stay blank; use ↗ to open them in a tab.</span>
          <div className="pane-chips">
            {SUGGESTIONS.map((suggestion) => (
              <button type="button" key={suggestion} onClick={() => navigate(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className={`browser-frame${loading ? " loading" : ""}`}>
          <iframe
            key={`${url}#${state.generation}`}
            title="Browser preview"
            src={url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            referrerPolicy="no-referrer"
            allow="clipboard-read; clipboard-write; fullscreen"
            onLoad={loaded}
          />
          {loading && <div className="browser-loading" role="status"><i className="loading-ring" />Loading…</div>}
          {showEmbedHint && !loading && (
            <div className="browser-embed-hint" role="status">
              <span>Blank page? The site refuses to be embedded.</span>
              <a href={url} target="_blank" rel="noopener noreferrer">Open in a new tab</a>
              <button type="button" aria-label="Dismiss" onClick={() => setShowEmbedHint(false)}>×</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
