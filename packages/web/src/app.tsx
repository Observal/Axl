// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CapabilityId, SessionProfile, ThinkingLevel } from "@axl/sdk";

import { ConversationPresentation } from "./conversation.tsx";
import type { ApplicationShell, ApplicationShellState } from "./shell.ts";
import { WorkspacePresentation } from "./workspace.tsx";

const CONNECTION_LABELS = {
  connecting: "Connecting",
  negotiating: "Negotiating capabilities",
  loading_snapshot: "Loading session history",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  incompatible: "Incompatible daemon",
} as const;

export type PrimaryDestination = "chat" | "explorer" | "changes";

export function escapeDestination(
  overlayOpen: boolean,
  destination: PrimaryDestination,
): "close-overlay" | "show-chat" | "none" {
  if (overlayOpen) return "close-overlay";
  if (destination !== "chat") return "show-chat";
  return "none";
}

function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)");
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

function CapabilityButton({
  shell,
  capability,
  children,
  onClick,
  disabled = false,
}: {
  readonly shell: ApplicationShell;
  readonly capability: CapabilityId;
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}) {
  const available = shell.supports(capability);
  return (
    <button
      type="button"
      disabled={!available || disabled}
      title={available ? undefined : `${capability} is unavailable`}
      onClick={onClick}
    >
      {children}
      {available ? null : <span className="sr-only"> (Unavailable)</span>}
    </button>
  );
}

function LiveAnnouncements({ state }: { readonly state: ApplicationShellState }) {
  const previousConnection = useRef(state.connection);
  const previousTransition = useRef<string | undefined>(undefined);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const transition = state.workspace.transition?.message;
    if (transition !== undefined && transition !== previousTransition.current) {
      setMessage(transition);
    } else if (state.connection !== previousConnection.current) {
      setMessage(`Connection: ${CONNECTION_LABELS[state.connection]}`);
    }
    previousConnection.current = state.connection;
    previousTransition.current = transition;
  }, [state.connection, state.workspace.transition?.message]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}

function Sidebar({
  shell,
  state,
  destination,
  onNavigate,
  onClose,
  overlay,
  sidebarRef,
  newCwd,
  onNewCwd,
}: {
  readonly shell: ApplicationShell;
  readonly state: ApplicationShellState;
  readonly destination: PrimaryDestination;
  readonly onNavigate: (destination: PrimaryDestination) => void;
  readonly onClose: () => void;
  readonly overlay: boolean;
  readonly sidebarRef: React.RefObject<HTMLElement | null>;
  readonly newCwd: string;
  readonly onNewCwd: (value: string) => void;
}) {
  const selected = state.selected;
  const create = (event: FormEvent) => {
    event.preventDefault();
    const cwd = newCwd.trim();
    if (cwd !== "") void shell.createSession({ cwd }).catch(() => undefined);
  };
  const search = (event: FormEvent) => {
    event.preventDefault();
    void shell.searchSessions().catch(() => undefined);
  };

  return (
    <aside
      ref={sidebarRef}
      aria-label="Application sidebar"
      className={`sidebar${overlay ? " sidebar-overlay" : ""}`}
      tabIndex={overlay ? -1 : undefined}
    >
      <div className="sidebar-heading">
        <h2>Navigate</h2>
        <button type="button" onClick={onClose} aria-label={overlay ? "Close navigation" : "Collapse sidebar"}>
          {overlay ? "Close" : "Collapse"}
        </button>
      </div>
      <nav aria-label="Primary">
        <ul className="destination-list">
          {(["chat", "explorer", "changes"] as const).map((item) => (
            <li key={item}>
              <button
                type="button"
                aria-current={destination === item ? "page" : undefined}
                disabled={item !== "chat" && selected === undefined}
                onClick={() => onNavigate(item)}
              >
                {item[0]?.toUpperCase()}{item.slice(1)}
                {destination === item ? <span className="state-label">Selected</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section aria-labelledby="sessions-heading" className="sessions-panel">
        <h2 id="sessions-heading">Sessions</h2>
        <form onSubmit={search} className="search">
          <label htmlFor="session-search">Search all local sessions</label>
          <div>
            <input
              id="session-search"
              type="search"
              value={state.search}
              onChange={(event) => shell.setSearch(event.currentTarget.value)}
            />
            <button type="submit" disabled={!shell.supports("session.list")}>Search</button>
          </div>
        </form>
        <form onSubmit={create} className="create-session">
          <label htmlFor="new-cwd">New session working directory</label>
          <input
            id="new-cwd"
            value={newCwd}
            placeholder="/path/to/project"
            onChange={(event) => onNewCwd(event.currentTarget.value)}
          />
          <button
            type="submit"
            disabled={!shell.supports("session.create") || newCwd.trim() === "" || state.busy}
          >
            Create
          </button>
        </form>
        <nav aria-label="Local sessions">
          <ul className="session-list">
            {state.sessions.map((session) => {
              const isSelected = selected?.sessionId === session.sessionId;
              return (
                <li key={session.sessionId}>
                  <button
                    type="button"
                    className={isSelected ? "selected" : undefined}
                    aria-current={isSelected ? "true" : undefined}
                    disabled={!shell.supports("session.resume") || state.busy}
                    onClick={() => void shell.selectSession(session.sessionId).catch(() => undefined)}
                  >
                    <strong>{session.lastUserMessage ?? session.firstUserMessage ?? "Untitled session"}</strong>
                    <span>{session.cwd}</span>
                    <small>
                      {isSelected ? "Selected · " : ""}{session.runtime.state} · {session.attachmentCount} attached
                    </small>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        {state.nextPageCursor === undefined ? null : (
          <button type="button" onClick={() => void shell.loadMoreSessions().catch(() => undefined)}>
            Load more
          </button>
        )}
      </section>
    </aside>
  );
}

export function App({ shell }: { readonly shell: ApplicationShell }) {
  const state = useSyncExternalStore(
    (listener) => shell.subscribe(listener),
    () => shell.state,
    () => shell.state,
  );
  const [newCwd, setNewCwd] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [destination, setDestination] = useState<PrimaryDestination>("chat");
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const narrow = useNarrowScreen();
  const sidebarRef = useRef<HTMLElement>(null);
  const overlayOpener = useRef<HTMLElement | undefined>(undefined);

  useEffect(() => {
    void shell.start();
    return () => shell.detach();
  }, [shell]);

  useEffect(() => {
    setModelDraft(state.conversation.model ?? "");
  }, [state.conversation.model, state.selected?.sessionId]);

  useEffect(() => {
    setDestination("chat");
    setOverlayOpen(false);
  }, [state.selected?.sessionId]);

  const closeOverlay = (restoreFocus = true) => {
    setOverlayOpen(false);
    if (restoreFocus) requestAnimationFrame(() => overlayOpener.current?.focus());
  };

  useEffect(() => {
    if (!overlayOpen) return;
    const sidebar = sidebarRef.current;
    const target = sidebar?.querySelector<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
    );
    (target ?? sidebar)?.focus();
  }, [overlayOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (overlayOpen && event.key === "Tab") {
        const focusable = Array.from(
          sidebarRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ) ?? [],
        );
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first !== undefined && last !== undefined) {
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const action = escapeDestination(overlayOpen, destination);
      if (action === "close-overlay") {
        event.preventDefault();
        closeOverlay();
      } else if (action === "show-chat") {
        event.preventDefault();
        setDestination("chat");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [destination, overlayOpen]);

  const openSidebar = (opener: HTMLElement) => {
    if (narrow) {
      overlayOpener.current = opener;
      setOverlayOpen(true);
    } else {
      setDesktopSidebarOpen(true);
    }
  };
  const navigate = (next: PrimaryDestination) => {
    setDestination(next);
    if (narrow && overlayOpen) closeOverlay();
  };

  const selected = state.selected;
  const projection = state.conversation;
  const active = projection.activeOperationId !== undefined;
  const sidebarVisible = narrow ? overlayOpen : desktopSidebarOpen;

  return (
    <div className="shell">
      <LiveAnnouncements state={state} />
      <header className="topbar">
        <div className="brand-status">
          <strong>Axl</strong>
          <span className={`connection connection-${state.connection}`}>
            Connection: {CONNECTION_LABELS[state.connection]}
          </span>
          <span className="session-status">
            Session: {selected === undefined ? "None selected" : selected.runtime.state}
          </span>
        </div>
        <nav aria-label="Quick navigation" className="quick-navigation">
          <button type="button" aria-current={destination === "chat" ? "page" : undefined} onClick={() => navigate("chat")}>Chat</button>
          <button
            type="button"
            aria-expanded={sidebarVisible}
            aria-controls="application-sidebar-container"
            onClick={(event) => {
              if (sidebarVisible && narrow) closeOverlay();
              else if (sidebarVisible) setDesktopSidebarOpen(false);
              else openSidebar(event.currentTarget);
            }}
          >
            {narrow ? "Menu" : desktopSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          </button>
        </nav>
        <div className="actions connection-actions">
          <button
            type="button"
            disabled={state.connection !== "disconnected"}
            onClick={() => void shell.reconnect().catch(() => undefined)}
          >
            Reconnect
          </button>
          <button type="button" disabled={state.detached} onClick={() => shell.detach()}>
            Detach browser
          </button>
        </div>
      </header>

      {state.error === undefined ? null : <p role="alert" className="error"><strong>Error:</strong> {state.error}</p>}
      {state.cursorPersistence.state === "unavailable" ? (
        <p className="warning">
          <strong>Storage unavailable:</strong> reconnect will load a fresh authoritative snapshot.
        </p>
      ) : null}

      <div id="application-sidebar-container" className={`application-layout${desktopSidebarOpen ? "" : " sidebar-collapsed"}`}>
        {!narrow && sidebarVisible ? (
          <Sidebar shell={shell} state={state} destination={destination} onNavigate={navigate} onClose={() => setDesktopSidebarOpen(false)} overlay={false} sidebarRef={sidebarRef} newCwd={newCwd} onNewCwd={setNewCwd} />
        ) : null}
        {narrow && overlayOpen ? (
          <div className="overlay-layer">
            <button className="overlay-backdrop" type="button" aria-label="Close navigation" onClick={() => closeOverlay()} />
            <div role="dialog" aria-modal="true" aria-label="Navigation and sessions">
              <Sidebar shell={shell} state={state} destination={destination} onNavigate={navigate} onClose={() => closeOverlay()} overlay sidebarRef={sidebarRef} newCwd={newCwd} onNewCwd={setNewCwd} />
            </div>
          </div>
        ) : null}

        <main className="primary-pane" aria-label={destination === "chat" ? "Chat" : destination === "explorer" ? "Explorer" : "Changes"}>
          {selected === undefined ? (
            <section className="empty-state">
              <h1>Select or create a session</h1>
              <p>The browser attaches to the same daemon-owned sessions as the terminal.</p>
            </section>
          ) : (
            <>
              <section className="session-heading">
                <div className="bounded-heading">
                  <h1>{destination === "chat" ? selected.cwd : destination === "explorer" ? "Explorer" : "Changes"}</h1>
                  <p>{selected.sessionId}</p>
                </div>
                <div className="actions">
                  <CapabilityButton shell={shell} capability="session.fork" disabled={state.busy} onClick={() => void shell.fork().catch(() => undefined)}>Fork</CapabilityButton>
                  <CapabilityButton shell={shell} capability="session.clone" disabled={state.busy} onClick={() => void shell.clone().catch(() => undefined)}>Clone</CapabilityButton>
                  <CapabilityButton shell={shell} capability="session.dispose" disabled={state.busy} onClick={() => void shell.disposeSession().catch(() => undefined)}>End runtime</CapabilityButton>
                </div>
              </section>

              <section className="status-grid" aria-label="Session status">
                <span>Profile: {projection.profile ?? selected.profile}</span>
                <span>Model: {projection.model ?? "Not recorded"}</span>
                <span>Thinking: {projection.thinking ?? "Not recorded"}</span>
                <span>Sandbox: {projection.sandbox ? `${projection.sandbox.provider} (${projection.sandbox.enforced ? "enforced" : "not enforced"})` : "Not recorded"}</span>
                <span>Usage: {projection.usage.inputTokens + projection.usage.outputTokens} tokens</span>
                <span>Cost: ${projection.usage.costUsd.toFixed(4)}</span>
                <span>Attachments: {state.presence.filter((item) => item.subscribedSessionIds.includes(selected.sessionId)).length}</span>
              </section>

              <div hidden={destination !== "chat"}>
                <section aria-label="Session configuration" className="configuration">
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const modelId = modelDraft.trim();
                      if (modelId !== "") void shell.configure({ modelId }).catch(() => undefined);
                    }}
                  >
                    <label htmlFor="model-id">Model ID</label>
                    <input id="model-id" name="model-id" list="known-models" value={modelDraft} disabled={!shell.supports("session.configure") || state.busy} onChange={(event) => setModelDraft(event.currentTarget.value)} />
                    <datalist id="known-models">{projection.model === undefined ? null : <option value={projection.model}>{projection.model}</option>}</datalist>
                    <button type="submit" disabled={!shell.supports("session.configure") || state.busy || modelDraft.trim() === "" || modelDraft.trim() === projection.model}>Select model</button>
                  </form>
                  <label>Profile<select value={projection.profile ?? selected.profile} disabled={!shell.supports("session.configure") || state.busy} onChange={(event) => void shell.configure({ profile: event.currentTarget.value as SessionProfile }).catch(() => undefined)}><option value="minimal">Minimal</option><option value="standard">Standard</option><option value="chat">Chat</option><option value="exec">Exec</option></select></label>
                  <label>Thinking<select value={projection.thinking ?? "medium"} disabled={!shell.supports("session.configure") || state.busy} onChange={(event) => void shell.configure({ thinkingLevel: event.currentTarget.value as ThinkingLevel }).catch(() => undefined)}><option value="off">Off</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
                  <label><input type="checkbox" checked={projection.webSearch ?? false} disabled={!shell.supports("session.configure") || state.busy} onChange={(event) => void shell.configure({ webSearch: event.currentTarget.checked }).catch(() => undefined)} />Web search</label>
                  <label><input type="checkbox" checked={projection.webFetch ?? false} disabled={!shell.supports("session.configure") || state.busy} onChange={(event) => void shell.configure({ webFetch: event.currentTarget.checked }).catch(() => undefined)} />Web fetch</label>
                </section>

                <ConversationPresentation state={projection} interactionDisabled={!shell.supports("session.interaction.respond") || state.busy} queueDisabled={!shell.supports("session.queue.requeue") || state.busy} onRespond={(interactionId, action, content) => void shell.respondToInteraction(interactionId, action, content).catch(() => undefined)} onRequeue={(queueItemId) => { if (shell.supports("session.queue.requeue") && !state.busy) void shell.requeue(queueItemId, "back").catch(() => undefined); }} />

                <form className="composer" onSubmit={(event) => { event.preventDefault(); void shell.send().catch(() => undefined); }}>
                  <label htmlFor="prompt">Message</label>
                  <textarea id="prompt" rows={4} value={state.draft} onChange={(event) => shell.setDraft(event.currentTarget.value)} />
                  <div className="actions">
                    <button type="submit" disabled={!shell.supports("session.send.prompt") || state.busy || state.draft.trim() === ""}>Send</button>
                    <CapabilityButton shell={shell} capability="session.queue.enqueue" disabled={state.draft.trim() === ""} onClick={() => void shell.send("back").catch(() => undefined)}>Queue</CapabilityButton>
                    <CapabilityButton shell={shell} capability="session.interrupt" disabled={!active} onClick={() => void shell.interrupt().catch(() => undefined)}>Interrupt</CapabilityButton>
                  </div>
                </form>
              </div>

              <WorkspacePresentation shell={shell} workspace={state.workspace} sessionId={selected.sessionId} activePane={destination === "chat" ? undefined : destination} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
