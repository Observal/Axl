// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import {
  parseSessionId,
  type EventId,
  type RpcResult,
  type SessionId,
  type WireActivity,
  type WireEvent,
} from "@axl/protocol";

import { type AxlClient, AxlClientError, cursorStoreKey, type CursorStore } from "./client.ts";
import { ConversationProjector, ProjectionError } from "./projector.ts";

export async function loadSessionSnapshot(
  client: AxlClient,
  sessionId: SessionId | string,
  onSubscription: (subscriptionId: string) => void,
  applyEvent: (event: import("@axl/protocol").CanonicalEvent) => void | Promise<void>,
  fromNodeId?: EventId,
): Promise<void> {
  const validatedSessionId = parseSessionId(sessionId);
  const subscription = await client.request("session.subscribe", {
    sessionId: validatedSessionId,
    ...(fromNodeId === undefined ? {} : { fromNodeId }),
  });
  onSubscription(subscription.subscriptionId);
  const descriptor = subscription.snapshot;
  if (descriptor === undefined) return;
  await client.loadingSnapshot(async () => {
    let page = descriptor.page;
    for (;;) {
      for (const event of page.events) await applyEvent(event);
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
        throw new ProjectionError("invalid_snapshot", "Snapshot identity changed while paging");
      }
      page = result.page;
    }
    await client.request("session.ack", {
      subscriptionId: subscription.subscriptionId,
      cursor: descriptor.boundaryCursor,
    });
  });
}

export interface SessionSubscription {
  readonly subscriptionId: string;
  readonly projector: ConversationProjector;
  readonly resumable: boolean;
  close(): Promise<void>;
}

/** Loads one atomic paged snapshot and then reduces its acknowledged live tail. */
export async function subscribeSession(
  client: AxlClient,
  sessionId: SessionId,
  options: {
    readonly fromNodeId?: EventId;
    readonly cursorStore?: CursorStore;
    readonly projector?: ConversationProjector;
    readonly onChange?: (projector: ConversationProjector) => void;
    readonly onResyncRequired?: (error: Error) => void;
  } = {},
): Promise<SessionSubscription> {
  const projector = options.projector ?? new ConversationProjector(sessionId, options.fromNodeId);
  const storeKey = cursorStoreKey(
    client.connection.daemonInstanceId,
    sessionId,
    options.fromNodeId,
  );
  let cursor: string | undefined;
  let resumable = options.cursorStore !== undefined;
  if (options.cursorStore !== undefined) {
    try {
      cursor = await options.cursorStore.load(storeKey);
    } catch {
      resumable = false;
    }
  }

  let subscription: RpcResult<"session.subscribe">;
  try {
    subscription = await client.request("session.subscribe", {
      sessionId,
      ...(options.fromNodeId === undefined ? {} : { fromNodeId: options.fromNodeId }),
      ...(cursor === undefined ? {} : { after: cursor }),
    });
  } catch (error) {
    if (
      cursor === undefined ||
      !(error instanceof AxlClientError) ||
      error.code !== "snapshot_required"
    ) {
      throw error;
    }
    projector.reset(sessionId, options.fromNodeId);
    await options.cursorStore?.delete(storeKey).catch(() => {
      resumable = false;
    });
    subscription = await client.request("session.subscribe", {
      sessionId,
      ...(options.fromNodeId === undefined ? {} : { fromNodeId: options.fromNodeId }),
    });
  }

  const { subscriptionId } = subscription;
  let sequence = 0;
  let closed = false;
  let loading = subscription.snapshot !== undefined;
  const pendingEvents: WireEvent[] = [];
  const pendingActivity: WireActivity[] = [];

  const persist = async (nextCursor: string): Promise<void> => {
    await client.request("session.ack", { subscriptionId, cursor: nextCursor });
    if (options.cursorStore !== undefined && resumable) {
      try {
        await options.cursorStore.save(storeKey, nextCursor);
      } catch {
        resumable = false;
      }
    }
  };

  const applyEvent = async (delivery: WireEvent): Promise<void> => {
    if (delivery.subscriptionId !== subscriptionId || delivery.sessionId !== sessionId || closed) {
      return;
    }
    if (delivery.sequence !== sequence + 1) {
      const error = new ProjectionError(
        "event_sequence_gap",
        "Canonical event delivery is out of order",
      );
      options.onResyncRequired?.(error);
      throw error;
    }
    projector.applyEvent(delivery.event);
    sequence = delivery.sequence;
    await persist(delivery.cursor);
    options.onChange?.(projector);
  };

  const removeEvent = client.onEvent((delivery) => {
    if (delivery.subscriptionId !== subscriptionId) return;
    if (loading) pendingEvents.push(delivery);
    else
      void applyEvent(delivery).catch((error: unknown) => {
        options.onResyncRequired?.(error instanceof Error ? error : new Error(String(error)));
      });
  });
  const removeActivity = client.onActivity((delivery) => {
    if (delivery.subscriptionId !== subscriptionId || delivery.sessionId !== sessionId || closed) {
      return;
    }
    if (loading) {
      pendingActivity.push(delivery);
      return;
    }
    try {
      projector.applyActivity(delivery.frame);
      options.onChange?.(projector);
    } catch (error) {
      options.onResyncRequired?.(error instanceof Error ? error : new Error(String(error)));
    }
  });

  const removeDisconnect = client.onDisconnect(() => {
    projector.clearActivity();
    options.onChange?.(projector);
  });
  await client.loadingSnapshot(async () => {
    const descriptor = subscription.snapshot;
    if (descriptor !== undefined) {
      projector.reset(sessionId, options.fromNodeId);
      let page = descriptor.page;
      for (;;) {
        for (const event of page.events) projector.applyEvent(event);
        options.onChange?.(projector);
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
          throw new ProjectionError("invalid_snapshot", "Snapshot identity changed while paging");
        }
        page = result.page;
      }
      await persist(descriptor.boundaryCursor);
    }
    loading = false;
    for (const delivery of pendingEvents) await applyEvent(delivery);
    for (const delivery of pendingActivity) {
      projector.applyActivity(delivery.frame);
      options.onChange?.(projector);
    }
  });

  return {
    subscriptionId,
    projector,
    get resumable() {
      return resumable;
    },
    async close() {
      if (closed) return;
      closed = true;
      removeEvent();
      removeActivity();
      removeDisconnect();
      projector.clearActivity();
      await client.request("session.unsubscribe", { subscriptionId });
    },
  };
}
