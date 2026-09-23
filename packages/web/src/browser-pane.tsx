// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";

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
  const externalPreview = url !== undefined && parseBrowserTarget(url).mode === "external";
  const [input, setInput] = useState(url ?? "");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(url !== undefined);
  const [externalUrl, setExternalUrl] = useState<string>();

  useEffect(() => {
    setInput(url ?? "");
    setLoading(url !== undefined);
    setExternalUrl(undefined);
  }, [url, state.generation]);

  const navigate = (value: string): void => {
    setError(undefined);
    try {
      const target = parseBrowserTarget(value);
      if (target.mode === "external") {
        setInput(url ?? "");
        setExternalUrl(target.url);
        window.open(target.url, "_blank", "noopener,noreferrer");
        return;
      }
      setExternalUrl(undefined);
      onState(browserNavigate(state, target.url));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid URL");
    }
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
          aria-label="Back in Preview"
          disabled={state.index <= 0}
          onClick={() => onState({ ...state, index: state.index - 1, generation: state.generation + 1 })}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9.5 3.5-4.5 4.5 4.5 4.5" /></svg>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Forward in Preview"
          disabled={state.index < 0 || state.index >= state.history.length - 1}
          onClick={() => onState({ ...state, index: state.index + 1, generation: state.generation + 1 })}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6.5 3.5 4.5 4.5-4.5 4.5" /></svg>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Reload Preview"
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
          aria-label="Preview address"
          aria-invalid={error !== undefined}
          placeholder="localhost:3000"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setError(undefined);
            setExternalUrl(undefined);
          }}
          onFocus={(event) => event.target.select()}
        />
        {url !== undefined && (
          <a
            className="icon-button"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open preview in a new tab"
            title="Open preview in a new tab"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11 9.5v4H2.5V5h4" /></svg>
          </a>
        )}
      </form>
      {error !== undefined && <p className="browser-note error" role="alert">{error}</p>}
      {externalUrl !== undefined && (
        <p className="browser-note" role="status">
          External pages open in a browser tab. <a href={externalUrl} target="_blank" rel="noopener noreferrer">Open again</a> or <button type="button" onClick={() => { onState(browserNavigate(state, externalUrl)); setExternalUrl(undefined); }}>preview here</button> if the page allows embedding.
        </p>
      )}
      {externalPreview && externalUrl === undefined && (
        <p className="browser-note" role="status">
          This external page may block embedded previews. <a href={url} target="_blank" rel="noopener noreferrer">Open in a browser tab</a>
        </p>
      )}
      {url === undefined ? (
        <div className="pane-empty">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></svg>
          <strong>Preview a development server</strong>
          <span>Localhost and embeddable development pages open here. Other external URLs open in a normal browser tab.</span>
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
          {/*
            Embedded pages are cross-origin dev servers, so allow-same-origin
            only grants same-origin privileges relative to the framed page's own
            origin, never the gateway origin. no-referrer plus the random gateway
            path keep the launch credentials unreachable. Framing of the gateway
            itself is refused by frame-ancestors 'none'. See
            docs/architecture/web-gateway-security.md.
          */}
          <iframe
            key={`${url}#${state.generation}`}
            title="Development preview"
            src={url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            referrerPolicy="no-referrer"
            allow="clipboard-read; clipboard-write; fullscreen"
            onLoad={() => setLoading(false)}
          />
          {loading && <div className="browser-loading" role="status"><i className="loading-ring" />Loading preview…</div>}
        </div>
      )}
    </div>
  );
}
