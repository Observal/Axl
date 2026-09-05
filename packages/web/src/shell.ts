// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import {
  type AttachmentPresence,
  type AxlClient,
  AxlClientError,
  type CapabilityId,
  type ConnectionState,
  ConversationProjector,
  type ConversationState,
  type CursorPersistenceStatus,
  type CursorStore,
  type EventId,
  type InteractionAction,
  type JsonObject,
  type RpcParams,
  type SessionOpenResult,
  type SessionProfile,
  type SessionSubscription,
  type SessionSummary,
  SessionWorkspace,
  subscribeSession,
  type ThinkingLevel,
  type WorkspaceState,
  emptyWorkspaceState,
  type GitStatusEntry,
} from "@axl/sdk";

export const BROWSER_CAPABILITIES = [
  "session.create",
  "session.list",
  "session.resume",
  "session.fork",
  "session.clone",
  "session.send.prompt",
  "session.queue.enqueue",
  "session.queue.requeue",
  "session.interrupt",
  "session.configure",
  "session.interaction.respond",
  "session.dispose",
  "session.subscribe",
  "session.activity",
  "session.presence",
  "session.workspace.list",
  "session.workspace.read",
  "session.workspace.status",
  "session.workspace.diff",
  "session.workspace.checkpoint",
] as const satisfies readonly CapabilityId[];

const PAGE_SIZE = 30;

export interface WebClientConnector {
  connect(onStateChange: (state: ConnectionState) => void): Promise<AxlClient>;
}

export interface ApplicationShellState {
  readonly connection: ConnectionState;
  readonly grantedCapabilities: readonly CapabilityId[];
  readonly sessions: readonly SessionSummary[];
  readonly nextPageCursor: string | undefined;
  readonly search: string;
  readonly selected: SessionOpenResult | undefined;
  readonly conversation: ConversationState;
  readonly workspace: WorkspaceState;
  readonly draft: string;
  readonly cursorPersistence: CursorPersistenceStatus;
  readonly presence: readonly AttachmentPresence[];
  readonly busy: boolean;
  readonly detached: boolean;
  readonly error: string | undefined;
}

function emptyConversation(): ConversationState {
  return new ConversationProjector().state;
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Browser-local orchestration over the public SDK. It owns no canonical session state. */
export class ApplicationShell {
  private stateValue: ApplicationShellState = {
    connection: "connecting",
    grantedCapabilities: [],
    sessions: [],
    nextPageCursor: undefined,
    search: "",
    selected: undefined,
    conversation: emptyConversation(),
    workspace: emptyWorkspaceState(),
    draft: "",
    cursorPersistence: { state: "not_configured" },
    presence: [],
    busy: false,
    detached: false,
    error: undefined,
  };
  private readonly listeners = new Set<() => void>();
  private readonly drafts = new Map<string, string>();
  private client: AxlClient | undefined;
  private subscription: SessionSubscription | undefined;
  private sessionWorkspace: SessionWorkspace | undefined;
  private removePresence: (() => void) | undefined;
  private selectionGeneration = 0;
  private pendingOperations = 0;

  private readonly connector: WebClientConnector;
  private readonly cursorStore: CursorStore;

  constructor(connector: WebClientConnector, cursorStore: CursorStore) {
    this.connector = connector;
    this.cursorStore = cursorStore;
  }

  get state(): ApplicationShellState {
    return this.stateValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  supports(capability: CapabilityId): boolean {
    return this.stateValue.grantedCapabilities.includes(capability);
  }

  async start(): Promise<void> {
    try {
      await this.connect();
      await this.loadSessions(true);
    } catch (error) {
      this.update({
        connection: "disconnected",
        error: safeMessage(error, "Could not start the browser client"),
      });
    }
  }

  setSearch(search: string): void {
    this.update({ search });
  }

  setDraft(draft: string): void {
    const sessionId = this.stateValue.selected?.sessionId;
    if (sessionId !== undefined) this.drafts.set(sessionId, draft);
    this.update({ draft });
  }

  async searchSessions(): Promise<void> {
    await this.loadSessions(true);
  }

  async loadMoreSessions(): Promise<void> {
    if (this.stateValue.nextPageCursor !== undefined) await this.loadSessions(false);
  }

  async createSession(params: RpcParams<"session.create">): Promise<void> {
    await this.run(async (client) => {
      const opened = await client.request("session.create", params);
      await this.clearSelection();
      await this.selectOpened(opened);
      await this.loadSessions(true);
    });
  }

  async selectSession(sessionId: SessionSummary["sessionId"]): Promise<void> {
    await this.run(async (client) => {
      await this.clearSelection();
      const opened = await client.request("session.resume", { sessionId });
      await this.selectOpened(opened);
    });
  }

  async fork(fromEventId?: EventId): Promise<void> {
    const selected = this.requireSelected();
    await this.run(async (client) => {
      const eventId = this.forkPoint(fromEventId);
      if (eventId === undefined) throw new Error("This session has no user message to fork from");
      const opened = await client.request("session.fork", {
        sessionId: selected.sessionId,
        fromEventId: eventId,
      });
      await this.clearSelection();
      await this.selectOpened(opened);
      await this.loadSessions(true);
    });
  }

  async clone(): Promise<void> {
    const selected = this.requireSelected();
    await this.run(async (client) => {
      const opened = await client.request("session.clone", { sessionId: selected.sessionId });
      await this.clearSelection();
      await this.selectOpened(opened);
      await this.loadSessions(true);
    });
  }

  async send(priority?: "front" | "back"): Promise<void> {
    const selected = this.requireSelected();
    const draft = this.stateValue.draft.trim();
    if (draft.length === 0) return;
    const content = [{ type: "text" as const, text: draft }];
    await this.run(async (client) => {
      if (priority !== undefined) {
        await client.request("session.queue.enqueue", {
          sessionId: selected.sessionId,
          content,
          priority,
        });
      } else {
        await client.request("session.send", {
          sessionId: selected.sessionId,
          content,
          delivery: "prompt",
        });
      }
      if (this.drafts.get(selected.sessionId) === draft) {
        this.drafts.delete(selected.sessionId);
        if (this.stateValue.selected?.sessionId === selected.sessionId) this.update({ draft: "" });
      }
    });
  }

  async requeue(queueItemId: EventId, priority: "front" | "back"): Promise<void> {
    const selected = this.requireSelected();
    await this.run((client) =>
      client.request("session.queue.requeue", {
        sessionId: selected.sessionId,
        queueItemId,
        priority,
      }),
    );
  }

  async interrupt(): Promise<void> {
    const selected = this.requireSelected();
    await this.run((client) =>
      client.request("session.interrupt", { sessionId: selected.sessionId }),
    );
  }

  async configure(update: {
    readonly modelId?: string;
    readonly thinkingLevel?: ThinkingLevel;
    readonly profile?: SessionProfile;
    readonly webFetch?: boolean;
    readonly webSearch?: boolean;
  }): Promise<void> {
    const selected = this.requireSelected();
    await this.run((client) =>
      client.request("session.configure", { sessionId: selected.sessionId, ...update }),
    );
  }

  async respondToInteraction(
    interactionId: string,
    action: InteractionAction,
    content?: JsonObject,
  ): Promise<void> {
    const selected = this.requireSelected();
    await this.run((client) =>
      client.request("session.interaction.respond", {
        sessionId: selected.sessionId,
        interactionId,
        action,
        ...(content === undefined ? {} : { content }),
      }),
    );
  }

  async refreshWorkspace(): Promise<void> {
    await this.requireWorkspace().refresh();
  }

  async listWorkspace(path: string, nextPage = false): Promise<void> {
    await this.requireWorkspace().list(path, nextPage);
  }

  async readWorkspaceFile(path: string): Promise<void> {
    await this.requireWorkspace().read(path);
  }

  async loadWorkspaceDiff(entry: GitStatusEntry): Promise<void> {
    await this.requireWorkspace().diff(entry);
  }

  async configureWorkspaceCheckpoint(enabled: boolean): Promise<void> {
    await this.requireWorkspace().checkpoint(enabled);
  }

  async disposeSession(): Promise<void> {
    const selected = this.requireSelected();
    await this.run(async (client) => {
      await client.request("session.dispose", { sessionId: selected.sessionId });
      await this.loadSessions(true);
    });
  }

  detach(): void {
    this.selectionGeneration += 1;
    this.subscription?.detach();
    this.subscription = undefined;
    this.sessionWorkspace?.clear();
    this.sessionWorkspace = undefined;
    this.removePresence?.();
    this.removePresence = undefined;
    this.client?.close();
    this.client = undefined;
    const { activity, ...conversation } = this.stateValue.conversation;
    void activity;
    this.update({
      connection: "disconnected",
      detached: true,
      presence: [],
      busy: false,
      conversation,
      workspace: emptyWorkspaceState(),
    });
  }

  async reconnect(): Promise<void> {
    const selectedSessionId = this.stateValue.selected?.sessionId;
    this.selectionGeneration += 1;
    this.subscription?.detach();
    this.subscription = undefined;
    this.sessionWorkspace?.clear();
    this.sessionWorkspace = undefined;
    this.removePresence?.();
    this.removePresence = undefined;
    this.client?.close();
    this.client = undefined;
    this.update({
      selected: undefined,
      conversation: emptyConversation(),
      workspace: emptyWorkspaceState(),
      draft: "",
      cursorPersistence: { state: "not_configured" },
      presence: [],
    });
    try {
      await this.connect();
      if (selectedSessionId !== undefined) {
        const opened = await this.requireClient().request("session.resume", {
          sessionId: selectedSessionId,
        });
        await this.selectOpened(opened);
      }
      await this.loadSessions(true);
    } catch (error) {
      this.update({ error: safeMessage(error, "Could not reconnect") });
      throw error;
    }
  }

  private async connect(): Promise<void> {
    this.update({ detached: false, error: undefined, connection: "connecting" });
    const client = await this.connector.connect((connection) => this.update({ connection }));
    this.client = client;
    this.update({
      connection: client.state,
      grantedCapabilities: client.connection.grantedCapabilities,
    });
    this.removePresence?.();
    this.removePresence = client.onPresence((delivery) => {
      this.update({ presence: delivery.attachments });
    });
  }

  private async loadSessions(replace: boolean): Promise<void> {
    const client = this.requireClient();
    if (!this.supports("session.list")) {
      this.update({ error: "Session listing is unavailable on this connection" });
      return;
    }
    const result = await client.request("session.list", {
      scope: "all_local",
      order: "recent",
      pageSize: PAGE_SIZE,
      ...(this.stateValue.search.trim() === "" ? {} : { query: this.stateValue.search.trim() }),
      ...(replace || this.stateValue.nextPageCursor === undefined
        ? {}
        : { pageCursor: this.stateValue.nextPageCursor }),
    });
    const sessions = replace
      ? result.sessions
      : [
          ...this.stateValue.sessions,
          ...result.sessions.filter(
            (candidate) =>
              !this.stateValue.sessions.some(
                (existing) => existing.sessionId === candidate.sessionId,
              ),
          ),
        ];
    this.update({
      sessions,
      nextPageCursor: result.nextPageCursor,
      error: undefined,
    });
  }

  private async clearSelection(): Promise<void> {
    this.selectionGeneration += 1;
    const old = this.subscription;
    this.subscription = undefined;
    this.sessionWorkspace?.clear();
    this.sessionWorkspace = undefined;
    this.update({
      selected: undefined,
      conversation: emptyConversation(),
      workspace: emptyWorkspaceState(),
      draft: "",
      cursorPersistence: { state: "not_configured" },
    });
    await old?.close();
  }

  private async selectOpened(opened: SessionOpenResult): Promise<void> {
    const client = this.requireClient();
    const generation = ++this.selectionGeneration;
    const workspace = new SessionWorkspace(client, opened.sessionId, (workspaceState) => {
      if (generation === this.selectionGeneration) this.update({ workspace: workspaceState });
    });
    this.sessionWorkspace = workspace;
    this.update({
      selected: opened,
      conversation: new ConversationProjector(opened.sessionId).state,
      workspace: workspace.state,
      draft: this.drafts.get(opened.sessionId) ?? "",
      cursorPersistence: { state: "available" },
    });
    const subscription = await subscribeSession(client, opened.sessionId, {
      cursorStore: this.cursorStore,
      onChange: (projector) => {
        if (generation === this.selectionGeneration) {
          this.update({ conversation: projector.state });
        }
      },
      onCursorPersistenceChange: (cursorPersistence) => {
        if (generation === this.selectionGeneration) this.update({ cursorPersistence });
      },
      onResyncRequired: (error) => {
        if (generation === this.selectionGeneration) {
          this.update({ error: `Session resync failed: ${error.message}` });
        }
      },
    });
    if (generation !== this.selectionGeneration) {
      await subscription.close();
      return;
    }
    this.subscription = subscription;
    this.update({
      conversation: subscription.projector.state,
      cursorPersistence: subscription.cursorPersistence,
    });
  }

  private forkPoint(requested?: EventId): EventId | undefined {
    const records = this.stateValue.conversation.records;
    if (requested !== undefined) {
      const selected = records.find((record) => record.event.id === requested);
      return selected?.kind === "event" && selected.event.type === "user.message"
        ? requested
        : undefined;
    }
    return records.findLast(
      (record) => record.kind === "event" && record.event.type === "user.message",
    )?.event.id as EventId | undefined;
  }

  private requireClient(): AxlClient {
    if (this.client === undefined) throw new AxlClientError("disconnected", "Browser is detached");
    return this.client;
  }

  private requireSelected(): SessionOpenResult {
    if (this.stateValue.selected === undefined) throw new Error("Select a session first");
    return this.stateValue.selected;
  }

  private requireWorkspace(): SessionWorkspace {
    if (this.sessionWorkspace === undefined) throw new Error("Select a session workspace first");
    return this.sessionWorkspace;
  }

  private async run<Result>(operation: (client: AxlClient) => Promise<Result>): Promise<Result> {
    this.pendingOperations += 1;
    this.update({ busy: true, error: undefined });
    try {
      return await operation(this.requireClient());
    } catch (error) {
      this.update({ error: safeMessage(error, "Operation failed") });
      throw error;
    } finally {
      this.pendingOperations -= 1;
      this.update({ busy: this.pendingOperations > 0 });
    }
  }

  private update(change: Partial<ApplicationShellState>): void {
    this.stateValue = { ...this.stateValue, ...change };
    for (const listener of this.listeners) listener();
  }
}
