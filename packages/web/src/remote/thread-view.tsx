// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * The phone's conversation view: the shared transcript renderer the desktop client uses, followed
 * by prompts still on their way to the daemon and the reply the model is producing right now.
 *
 * Model output arrives as sequenced activity frames long before its durable event, so the live
 * reply shows text, thinking, and tool calls as they stream. React reconciles by event ID, so each
 * update touches only what changed instead of rebuilding the transcript.
 */

import type { ConversationState } from "@axl/sdk";
import { Conversation, type InteractionResponder, Markdown } from "@axl/ui/react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import "@axl/ui/conversation.css";

import { elapsed, phoneCanAnswer, turnStage, turnStartedAt } from "./turn.ts";

/** A prompt the phone sent that the transcript does not show yet. */
export interface PendingPrompt {
  readonly id: string;
  readonly text: string;
  readonly failed?: string;
}

export interface ThreadSnapshot {
  readonly state: ConversationState;
  readonly pending: readonly PendingPrompt[];
  readonly now: number;
}

function Dots(): React.JSX.Element {
  return (
    <span className="remote-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function LiveReply({ state, now }: { readonly state: ConversationState; readonly now: number }) {
  const operation = state.activeOperationId;
  if (operation === undefined) return null;
  const activity = state.activity?.operationId === operation ? state.activity : undefined;
  const started = turnStartedAt(state);
  const running = state.tools.filter(
    (tool) => tool.operationId === operation && tool.result === undefined,
  );
  // Tool calls stream as activity before their durable event; show each once.
  const streamed = (activity?.toolCalls ?? []).filter(
    (call) => !state.tools.some((tool) => tool.callId === call.callId),
  );
  return (
    <article className="message assistant live" aria-busy="true">
      <span className="avatar axl">◆</span>
      <div>
        <header>
          <strong>Axl</strong>
          <time>
            {turnStage(state)}
            {started === undefined ? "" : ` · ${elapsed(now - started)}`}
          </time>
        </header>
        {activity !== undefined && activity.thinking.length > 0 ? (
          <details className="thinking remote-live-thinking">
            <summary>Thinking</summary>
            <p>{activity.thinking}</p>
          </details>
        ) : null}
        {activity !== undefined && activity.text.length > 0 ? (
          <div className="remote-live-text">
            <Markdown text={activity.text} />
          </div>
        ) : running.length === 0 && streamed.length === 0 ? (
          <p className="remote-waiting">
            {activity !== undefined && activity.thinking.length > 0 ? "Thinking" : "Working"}
            <Dots />
          </p>
        ) : null}
        {running.length + streamed.length > 0 ? (
          <ul className="remote-live-tools">
            {[...running.map((tool) => tool.name), ...streamed.map((call) => call.name)].map(
              (name, index) => (
                <li key={`${name}:${String(index)}`}>
                  <span className="remote-spinner" aria-hidden="true" />
                  {name}
                </li>
              ),
            )}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

function Pending({ prompt }: { readonly prompt: PendingPrompt }) {
  return (
    <article className={`message user remote-pending${prompt.failed ? " failed" : ""}`}>
      <span className="avatar">Y</span>
      <div>
        <header>
          <strong>You</strong>
          <time>{prompt.failed === undefined ? "Sending" : "Not sent"}</time>
        </header>
        <p>{prompt.text}</p>
        {prompt.failed === undefined ? null : <p className="remote-pending-error">{prompt.failed}</p>}
      </div>
    </article>
  );
}

function Thread({
  snapshot,
  respond,
}: {
  readonly snapshot: ThreadSnapshot;
  readonly respond: InteractionResponder;
}) {
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined);
  return (
    <>
      <div id="records" className="remote-records">
        <Conversation
          conversation={snapshot.state}
          onCopyMessage={copy}
          onRespondInteraction={respond}
          canRespondInteraction={phoneCanAnswer}
        />
      </div>
      <div className="remote-tail">
        {snapshot.pending.map((prompt) => (
          <Pending key={prompt.id} prompt={prompt} />
        ))}
        <LiveReply state={snapshot.state} now={snapshot.now} />
      </div>
    </>
  );
}

/** Renders the thread into `container`, at most once per animation frame. */
export class ThreadRenderer {
  readonly #root: Root;
  readonly #scroller: HTMLElement;
  readonly #onFollowChange: (following: boolean) => void;
  readonly #respond: InteractionResponder;
  #snapshot: ThreadSnapshot | undefined;
  #frame: number | undefined;
  #following = true;

  constructor(
    container: HTMLElement,
    scroller: HTMLElement,
    onFollowChange: (following: boolean) => void,
    respond: InteractionResponder,
  ) {
    this.#root = createRoot(container);
    this.#respond = respond;
    this.#scroller = scroller;
    this.#onFollowChange = onFollowChange;
    scroller.addEventListener("scroll", () => this.#setFollowing(this.#atBottom()), {
      passive: true,
    });
  }

  /** Show `snapshot` on the next frame; later calls in the same frame replace it. */
  render(snapshot: ThreadSnapshot): void {
    this.#snapshot = snapshot;
    this.#frame ??= requestAnimationFrame(() => {
      this.#frame = undefined;
      const next = this.#snapshot;
      if (next === undefined) return;
      const follow = this.#following;
      flushSync(() => this.#root.render(<Thread snapshot={next} respond={this.#respond} />));
      // Stay pinned to the newest output unless the reader scrolled up to read something.
      if (follow) this.#scroller.scrollTop = this.#scroller.scrollHeight;
    });
  }

  clear(): void {
    this.#snapshot = undefined;
    flushSync(() => this.#root.render(null));
    this.jumpToLatest();
  }

  jumpToLatest(): void {
    this.#scroller.scrollTop = this.#scroller.scrollHeight;
    this.#setFollowing(true);
  }

  #atBottom(): boolean {
    const { scrollHeight, scrollTop, clientHeight } = this.#scroller;
    return scrollHeight - scrollTop - clientHeight < 48;
  }

  #setFollowing(following: boolean): void {
    if (this.#following === following) return;
    this.#following = following;
    this.#onFollowChange(following);
  }
}
