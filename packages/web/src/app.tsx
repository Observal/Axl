// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type { FormEvent, ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { CapabilityId, ConversationRecord, SessionProfile, ThinkingLevel } from "@axl/sdk";

import type { ApplicationShell } from "./shell.ts";

const CONNECTION_LABELS = {
  connecting: "Connecting",
  negotiating: "Negotiating capabilities",
  loading_snapshot: "Loading session history",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  incompatible: "Incompatible daemon",
} as const;

function eventText(record: ConversationRecord): ReactNode {
  if (record.kind === "unknown_event") return `Unknown event: ${record.event.type}`;
  const event = record.event;
  if (event.type === "user.message" || event.type === "assistant.message") {
    return event.payload.content
      .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
      .join("\n");
  }
  if (event.type === "session.error") return event.payload.message;
  if (event.type === "context.compacted") return "Context compacted";
  if (event.type === "user.shell") return `Shell: ${event.payload.command}`;
  return event.type;
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
    </button>
  );
}

export function App({ shell }: { readonly shell: ApplicationShell }) {
  const state = useSyncExternalStore(
    (listener) => shell.subscribe(listener),
    () => shell.state,
  );
  const [newCwd, setNewCwd] = useState("");
  const [modelDraft, setModelDraft] = useState("");

  useEffect(() => {
    void shell.start();
    return () => shell.detach();
  }, [shell]);

  useEffect(() => {
    setModelDraft(state.conversation.model ?? "");
  }, [state.conversation.model, state.selected?.sessionId]);

  const create = (event: FormEvent) => {
    event.preventDefault();
    const cwd = newCwd.trim();
    if (cwd !== "") void shell.createSession({ cwd }).catch(() => undefined);
  };
  const search = (event: FormEvent) => {
    event.preventDefault();
    void shell.searchSessions().catch(() => undefined);
  };
  const selected = state.selected;
  const projection = state.conversation;
  const active = projection.activeOperationId !== undefined;

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <strong>Axl</strong>
          <span className={`connection connection-${state.connection}`} role="status" aria-live="polite">
            {CONNECTION_LABELS[state.connection]}
          </span>
        </div>
        <div className="actions">
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

      {state.error === undefined ? null : <p role="alert" className="error">{state.error}</p>}
      {state.cursorPersistence.state === "unavailable" ? (
        <p role="status" className="warning">
          Session storage is unavailable. Reconnect will load a fresh authoritative snapshot.
        </p>
      ) : null}

      <div className="workspace">
        <aside aria-label="Sessions" className="sessions">
          <h2>Sessions</h2>
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
              onChange={(event) => setNewCwd(event.currentTarget.value)}
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
              {state.sessions.map((session) => (
                <li key={session.sessionId}>
                  <button
                    type="button"
                    className={selected?.sessionId === session.sessionId ? "selected" : undefined}
                    disabled={!shell.supports("session.resume") || state.busy}
                    onClick={() => void shell.selectSession(session.sessionId).catch(() => undefined)}
                  >
                    <strong>{session.lastUserMessage ?? session.firstUserMessage ?? "Untitled session"}</strong>
                    <span>{session.cwd}</span>
                    <small>
                      {session.runtime.state} · {session.attachmentCount} attached
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          {state.nextPageCursor === undefined ? null : (
            <button type="button" onClick={() => void shell.loadMoreSessions().catch(() => undefined)}>
              Load more
            </button>
          )}
        </aside>

        <main className="conversation" aria-label="Conversation">
          {selected === undefined ? (
            <section className="empty-state">
              <h1>Select or create a session</h1>
              <p>The browser attaches to the same daemon-owned sessions as the terminal.</p>
            </section>
          ) : (
            <>
              <section className="session-heading">
                <div>
                  <h1>{selected.cwd}</h1>
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

              <section aria-label="Session configuration" className="configuration">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const modelId = modelDraft.trim();
                    if (modelId !== "") void shell.configure({ modelId }).catch(() => undefined);
                  }}
                >
                  <label htmlFor="model-id">Model ID</label>
                  <input
                    id="model-id"
                    name="model-id"
                    list="known-models"
                    value={modelDraft}
                    disabled={!shell.supports("session.configure") || state.busy}
                    onChange={(event) => setModelDraft(event.currentTarget.value)}
                  />
                  <datalist id="known-models">
                    {projection.model === undefined ? null : (
                      <option value={projection.model}>{projection.model}</option>
                    )}
                  </datalist>
                  <button
                    type="submit"
                    disabled={
                      !shell.supports("session.configure") ||
                      state.busy ||
                      modelDraft.trim() === "" ||
                      modelDraft.trim() === projection.model
                    }
                  >
                    Select model
                  </button>
                </form>
                <label>
                  Profile
                  <select
                    value={projection.profile ?? selected.profile}
                    disabled={!shell.supports("session.configure") || state.busy}
                    onChange={(event) => void shell.configure({ profile: event.currentTarget.value as SessionProfile }).catch(() => undefined)}
                  >
                    <option value="minimal">Minimal</option>
                    <option value="standard">Standard</option>
                    <option value="chat">Chat</option>
                    <option value="exec">Exec</option>
                  </select>
                </label>
                <label>
                  Thinking
                  <select
                    value={projection.thinking ?? "medium"}
                    disabled={!shell.supports("session.configure") || state.busy}
                    onChange={(event) => void shell.configure({ thinkingLevel: event.currentTarget.value as ThinkingLevel }).catch(() => undefined)}
                  >
                    <option value="off">Off</option>
                    <option value="minimal">Minimal</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={projection.webSearch ?? false}
                    disabled={!shell.supports("session.configure") || state.busy}
                    onChange={(event) => void shell.configure({ webSearch: event.currentTarget.checked }).catch(() => undefined)}
                  />
                  Web search
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={projection.webFetch ?? false}
                    disabled={!shell.supports("session.configure") || state.busy}
                    onChange={(event) => void shell.configure({ webFetch: event.currentTarget.checked }).catch(() => undefined)}
                  />
                  Web fetch
                </label>
              </section>

              <ol className="records" aria-label="Conversation events">
                {projection.records.map((record) => (
                  <li key={record.event.id} className={`record record-${record.event.type.replaceAll(".", "-")}`}>
                    <small>{record.event.type}</small>
                    <div>{eventText(record)}</div>
                  </li>
                ))}
              </ol>

              {projection.activity === undefined ? null : (
                <section className="activity" role="status" aria-live="polite">
                  <strong>Working</strong>
                  {projection.activity.thinking === "" ? null : <pre>{projection.activity.thinking}</pre>}
                  {projection.activity.text === "" ? null : <pre>{projection.activity.text}</pre>}
                </section>
              )}

              {projection.interactions.filter((item) => item.resolution === undefined).map((interaction) => (
                <section className="interaction" key={interaction.interactionId}>
                  <h2>Response needed</h2>
                  <p>{interaction.request.payload.message}</p>
                  <div className="actions">
                    {(["accept", "decline", "cancel"] as const).map((action) => (
                      <CapabilityButton key={action} shell={shell} capability="session.interaction.respond" onClick={() => void shell.respondToInteraction(interaction.interactionId, action).catch(() => undefined)}>{action}</CapabilityButton>
                    ))}
                  </div>
                </section>
              ))}

              {projection.queue.length === 0 ? null : (
                <section aria-label="Prompt queue" className="queue">
                  <h2>Queue</h2>
                  <ul>
                    {projection.queue.map((item) => (
                      <li key={item.queueItemId}>
                        <span>{item.status} · {item.content.map((part) => part.type === "text" ? part.text : `[${part.type}]`).join(" ")}</span>
                        {item.status === "paused" ? (
                          <CapabilityButton shell={shell} capability="session.queue.requeue" disabled={state.busy} onClick={() => void shell.requeue(item.queueItemId, "back").catch(() => undefined)}>Requeue</CapabilityButton>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <form className="composer" onSubmit={(event) => { event.preventDefault(); void shell.send().catch(() => undefined); }}>
                <label htmlFor="prompt">Message</label>
                <textarea id="prompt" rows={4} value={state.draft} onChange={(event) => shell.setDraft(event.currentTarget.value)} />
                <div className="actions">
                  <button type="submit" disabled={!shell.supports("session.send.prompt") || state.busy || state.draft.trim() === ""}>Send</button>
                  <CapabilityButton shell={shell} capability="session.queue.enqueue" disabled={state.draft.trim() === ""} onClick={() => void shell.send("back").catch(() => undefined)}>Queue</CapabilityButton>
                  <CapabilityButton shell={shell} capability="session.interrupt" disabled={!active} onClick={() => void shell.interrupt().catch(() => undefined)}>Interrupt</CapabilityButton>
                </div>
              </form>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
