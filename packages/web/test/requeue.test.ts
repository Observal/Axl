// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { type ProjectedQueueItem, parseEventId } from "@axl/sdk";

import { pausedQueueItems, queueItemLabel } from "../src/requeue.ts";

const queue: readonly ProjectedQueueItem[] = [
  {
    queueItemId: parseEventId("00000000-0000-4000-8000-000000000001"),
    content: [{ type: "text", text: "Resume this prompt" }],
    priority: "back",
    status: "paused",
  },
  {
    queueItemId: parseEventId("00000000-0000-4000-8000-000000000002"),
    content: [{ type: "text", text: "Already queued" }],
    priority: "front",
    status: "queued",
  },
];

test("selects only paused prompts and presents their content", () => {
  const paused = pausedQueueItems(queue);

  assert.deepEqual(
    paused.map((item) => item.queueItemId),
    [queue[0]?.queueItemId],
  );
  assert.equal(queueItemLabel(paused[0] as ProjectedQueueItem), "Resume this prompt");
});
