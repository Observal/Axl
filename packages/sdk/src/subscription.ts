// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type {
  CanonicalEvent,
  EventId,
  RpcResult,
  SessionId,
  WireActivity,
  WireEvent,
} from "@axl/protocol";

import { type AxlClient, AxlClientError, cursorStoreKey, type CursorStore } from "./client.ts";
import { ConversationProjector, ProjectionError } from "./projector.ts";

export type CursorPersistenceStatus =
  | { readonly state: "not_configured" }
  | { readonly state: "available" }
  | { readonly state: "unavailable"; readonly reason: "cursor_store_failed" };

export interface SessionSubscription {
  readonly subscriptionId: string;
  readonly projector: ConversationProjector;
  readonly resumable: boolean;
  readonly cursorPersistence: CursorPersistenceStatus;
  /** Rebinds this view to a newly initialized attachment and resumes from its last ack. */
  reconnect(client: AxlClient): Promise<void>;
  /** Stops local delivery immediately. Closing the attachment releases daemon state. */
  detach(): void;
  close(): Promise<void>;
}

function isCursorRecoveryError(error: unknown): error is AxlClientError {
  return (
    error instanceof AxlClientError &&
    (error.code === "unknown_cursor" || error.code === "snapshot_required")
  );
}

export interface SessionSubscriptionOptions {
  readonly fromNodeId?: EventId;
  readonly cursorStore?: CursorStore;
  readonly projector?: ConversationProjector;
  readonly onEvent?: (
    event: CanonicalEvent,
    projector: ConversationProjector,
  ) => void | Promise<void>;
  readonly onChange?: (projector: ConversationProjector) => void;
  readonly onResyncRequired?: (error: Error) => void;
}

class ResumableSessionSubscription implements SessionSubscription {
  readonly projector: ConversationProjector;
  private client: AxlClient;
  private currentSubscriptionId = "";
  private currentStoreKey: string | undefined;
  private acknowledgedCursor: string | undefined;
  private daemonInstanceId: string | undefined;
  private sequence = 0;
  private closed = false;
  private resumableState: boolean;
  private cursorStoreFailed = false;
  private generation = 0;
  private delivery: Promise<void> = Promise.resolve();
  private recovery: Promise<void> | undefined;
  private removeEvent: () => void = () => undefined;
  private removeActivity: () => void = () => undefined;
  private removeDisconnect: () => void = () => undefined;
  private removeReconnect: () => void = () => undefined;
  private readonly sessionId: SessionId;
  private readonly options: SessionSubscriptionOptions;

  constructor(client: AxlClient, sessionId: SessionId, options: SessionSubscriptionOptions) {
    this.client = client;
    this.sessionId = sessionId;
    this.options = options;
    this.projector = options.projector ?? new ConversationProjector(sessionId, options.fromNodeId);
    this.resumableState = options.cursorStore !== undefined;
  }

  get subscriptionId(): string {
    return this.currentSubscriptionId;
  }

  get resumable(): boolean {
    return this.resumableState;
  }

  get cursorPersistence(): CursorPersistenceStatus {
    if (this.options.cursorStore === undefined) return { state: "not_configured" };
    return this.cursorStoreFailed
      ? { state: "unavailable", reason: "cursor_store_failed" }
      : { state: "available" };
  }

  async start(): Promise<void> {
    await this.establish(this.client);
  }

  async reconnect(client: AxlClient): Promise<void> {
    if (this.closed) throw new AxlClientError("disconnected", "Subscription is closed");
    await this.delivery;
    await this.recovery;
    if (this.closed) throw new AxlClientError("disconnected", "Subscription is closed");
    await this.establish(client);
  }

  detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.unbind();
    this.removeReconnect();
    this.removeReconnect = () => undefined;
    this.projector.resetActivity();
    this.options.onChange?.(this.projector);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.detach();
    await this.delivery;
    await this.recovery;
    this.unbind();
    const subscriptionId = this.currentSubscriptionId;
    this.currentSubscriptionId = "";
    if (subscriptionId === "") return;
    try {
      await this.client.request("session.unsubscribe", { subscriptionId });
    } catch (error) {
      if (!(error instanceof AxlClientError) || error.code !== "disconnected") throw error;
    }
  }

  private async establish(client: AxlClient, forceSnapshot = false): Promise<void> {
    const generation = ++this.generation;
    this.unbind();
    this.removeReconnect();
    this.removeReconnect = () => undefined;
    this.client = client;
    this.sequence = 0;
    this.projector.resetActivity();
    this.options.onChange?.(this.projector);

    const pendingEvents: WireEvent[] = [];
    const pendingActivity: WireActivity[] = [];
    let loading = true;
    this.removeEvent = client.onEvent((delivery) => {
      if (delivery.sessionId !== this.sessionId || this.closed || generation !== this.generation) {
        return;
      }
      if (loading) pendingEvents.push(delivery);
      else if (delivery.subscriptionId === this.currentSubscriptionId) {
        this.enqueueEvent(delivery, generation);
      }
    });
    this.removeActivity = client.onActivity((delivery) => {
      if (delivery.sessionId !== this.sessionId || this.closed || generation !== this.generation) {
        return;
      }
      if (loading) pendingActivity.push(delivery);
      else if (delivery.subscriptionId === this.currentSubscriptionId) {
        this.applyActivity(delivery);
      }
    });
    this.removeDisconnect = client.onDisconnect(() => {
      if (this.closed || generation !== this.generation) return;
      this.projector.resetActivity();
      this.options.onChange?.(this.projector);
    });

    const nextDaemonInstanceId = client.connection.daemonInstanceId;
    const nextStoreKey = cursorStoreKey(
      nextDaemonInstanceId,
      this.sessionId,
      this.options.fromNodeId,
    );
    const sameLineage =
      this.daemonInstanceId === undefined || this.daemonInstanceId === nextDaemonInstanceId;
    const cursorAvailable = this.options.cursorStore === undefined || this.resumableState;
    let cursor =
      !forceSnapshot && sameLineage && cursorAvailable && this.projector.state.records.length > 0
        ? this.acknowledgedCursor
        : undefined;
    if (
      cursor === undefined &&
      !forceSnapshot &&
      sameLineage &&
      this.projector.state.records.length > 0 &&
      this.options.cursorStore !== undefined &&
      this.resumableState
    ) {
      try {
        cursor = await this.options.cursorStore.load(nextStoreKey);
      } catch {
        this.disableCursorStore();
      }
    }
    if (!sameLineage) {
      this.projector.reset(this.sessionId, this.options.fromNodeId);
      this.acknowledgedCursor = undefined;
      this.options.onChange?.(this.projector);
    }

    let subscription: RpcResult<"session.subscribe">;
    try {
      subscription = await this.requestSubscription(client, cursor);
    } catch (error) {
      if (
        cursor === undefined ||
        !(error instanceof AxlClientError) ||
        error.code !== "snapshot_required"
      ) {
        this.unbind();
        throw error;
      }
      this.projector.reset(this.sessionId, this.options.fromNodeId);
      this.acknowledgedCursor = undefined;
      this.options.onChange?.(this.projector);
      await this.deleteCursor(nextStoreKey);
      subscription = await this.requestSubscription(client);
    }

    this.currentSubscriptionId = subscription.subscriptionId;
    try {
      this.validateSubscription(subscription);
      this.currentStoreKey = nextStoreKey;
      this.daemonInstanceId = nextDaemonInstanceId;
      await client.loadingSnapshot(async () => {
        const descriptor = subscription.snapshot;
        if (descriptor !== undefined) {
          this.projector.reset(this.sessionId, this.options.fromNodeId);
          this.options.onChange?.(this.projector);
          let page = descriptor.page;
          for (;;) {
            for (const event of page.events) await this.reduceEvent(event);
            if (page.complete) break;
            const pageCursor = page.nextPageCursor;
            if (pageCursor === undefined) {
              throw new ProjectionError(
                "invalid_snapshot",
                "Incomplete snapshot omitted its page cursor",
              );
            }
            const result = await client.request("session.history", {
              snapshotId: descriptor.snapshotId,
              pageCursor,
            });
            if (result.snapshotId !== descriptor.snapshotId) {
              throw new ProjectionError(
                "invalid_snapshot",
                "Snapshot identity changed while paging",
              );
            }
            page = result.page;
          }
          await this.persist(
            descriptor.boundaryCursor,
            generation,
            client,
            subscription.subscriptionId,
          );
        } else if (subscription.resumedFrom !== cursor || cursor === undefined) {
          throw new ProjectionError(
            "invalid_subscription",
            "Daemon neither resumed the requested cursor nor returned a snapshot",
          );
        }
      });
      if (this.closed || generation !== this.generation) return;
      loading = false;
      for (const delivery of pendingEvents) {
        if (delivery.subscriptionId === this.currentSubscriptionId) {
          await this.applyEvent(delivery, generation);
        }
      }
      for (const delivery of pendingActivity) {
        if (delivery.subscriptionId === this.currentSubscriptionId) this.applyActivity(delivery);
      }
      if (this.closed || generation !== this.generation) return;
      this.removeReconnect = client.onReconnect(() => this.reconnect(client));
    } catch (error) {
      this.unbind();
      const failedSubscriptionId = this.currentSubscriptionId;
      this.currentSubscriptionId = "";
      try {
        await client.request("session.unsubscribe", {
          subscriptionId: failedSubscriptionId,
        });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Subscription loading and cleanup failed");
      }
      if (!forceSnapshot && isCursorRecoveryError(error) && !this.closed) {
        this.projector.reset(this.sessionId, this.options.fromNodeId);
        this.acknowledgedCursor = undefined;
        this.options.onChange?.(this.projector);
        await this.deleteCursor(nextStoreKey);
        return this.establish(client, true);
      }
      throw error;
    }
  }

  private requestSubscription(
    client: AxlClient,
    cursor?: string,
  ): Promise<RpcResult<"session.subscribe">> {
    return client.request("session.subscribe", {
      sessionId: this.sessionId,
      ...(this.options.fromNodeId === undefined ? {} : { fromNodeId: this.options.fromNodeId }),
      ...(cursor === undefined ? {} : { after: cursor }),
    });
  }

  private validateSubscription(subscription: RpcResult<"session.subscribe">): void {
    if (
      subscription.sessionId !== this.sessionId ||
      subscription.fromNodeId !== this.options.fromNodeId
    ) {
      throw new ProjectionError(
        "invalid_subscription",
        "Daemon returned a subscription for another session or selected node",
      );
    }
  }

  private enqueueEvent(delivery: WireEvent, generation: number): void {
    this.delivery = this.delivery
      .then(() => this.applyEvent(delivery, generation))
      .catch((error: unknown) => {
        if (generation === this.generation) this.handleDeliveryFailure(error);
      });
  }

  private async applyEvent(delivery: WireEvent, generation: number): Promise<void> {
    if (
      this.closed ||
      generation !== this.generation ||
      delivery.subscriptionId !== this.currentSubscriptionId
    ) {
      return;
    }
    if (delivery.sequence !== this.sequence + 1) {
      throw new ProjectionError("event_sequence_gap", "Canonical event delivery is out of order");
    }
    await this.reduceEvent(delivery.event);
    this.sequence = delivery.sequence;
    await this.persist(delivery.cursor, generation, this.client, delivery.subscriptionId);
  }

  private async reduceEvent(event: CanonicalEvent): Promise<void> {
    if (!this.projector.applyEvent(event)) return;
    await this.options.onEvent?.(event, this.projector);
    this.options.onChange?.(this.projector);
  }

  private applyActivity(delivery: WireActivity): void {
    try {
      if (this.projector.applyActivity(delivery.frame)) this.options.onChange?.(this.projector);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.options.onResyncRequired?.(normalized);
      this.scheduleRecovery(false);
    }
  }

  private async persist(
    cursor: string,
    generation: number,
    client: AxlClient,
    subscriptionId: string,
  ): Promise<void> {
    if (this.closed || generation !== this.generation) return;
    await client.request("session.ack", { subscriptionId, cursor });
    if (this.closed || generation !== this.generation) return;
    this.acknowledgedCursor = cursor;
    if (this.options.cursorStore !== undefined && this.resumableState && this.currentStoreKey) {
      try {
        await this.options.cursorStore.save(this.currentStoreKey, cursor);
      } catch {
        this.disableCursorStore();
      }
    }
  }

  private async deleteCursor(key: string): Promise<void> {
    if (this.options.cursorStore === undefined) return;
    try {
      await this.options.cursorStore.delete(key);
    } catch {
      this.disableCursorStore();
    }
  }

  private disableCursorStore(): void {
    this.resumableState = false;
    this.cursorStoreFailed = true;
  }

  private handleDeliveryFailure(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.options.onResyncRequired?.(normalized);
    if (normalized instanceof ProjectionError && normalized.code === "event_sequence_gap") {
      this.scheduleRecovery(false);
    } else if (
      (normalized instanceof ProjectionError && normalized.code === "missing_parent") ||
      isCursorRecoveryError(normalized)
    ) {
      this.scheduleRecovery(true);
    } else {
      this.unbind();
    }
  }

  private scheduleRecovery(forceSnapshot: boolean): void {
    if (this.closed || this.recovery !== undefined) return;
    const client = this.client;
    const oldSubscriptionId = this.currentSubscriptionId;
    this.generation += 1;
    this.unbind();
    this.recovery = (async () => {
      if (oldSubscriptionId !== "") {
        await client
          .request("session.unsubscribe", { subscriptionId: oldSubscriptionId })
          .catch(() => undefined);
      }
      await this.establish(client, forceSnapshot);
    })()
      .catch((error: unknown) => {
        this.options.onResyncRequired?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.recovery = undefined;
      });
  }

  private unbind(): void {
    this.removeEvent();
    this.removeActivity();
    this.removeDisconnect();
    this.removeEvent = () => undefined;
    this.removeActivity = () => undefined;
    this.removeDisconnect = () => undefined;
  }
}

/** Loads one atomic snapshot and owns ordered acknowledgement across later attachments. */
export async function subscribeSession(
  client: AxlClient,
  sessionId: SessionId,
  options: SessionSubscriptionOptions = {},
): Promise<SessionSubscription> {
  const subscription = new ResumableSessionSubscription(client, sessionId, options);
  await subscription.start();
  return subscription;
}
