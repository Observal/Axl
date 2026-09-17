// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { ProjectedQueueItem } from "@axl/sdk";

export function pausedQueueItems(
  queue: readonly ProjectedQueueItem[],
): readonly ProjectedQueueItem[] {
  return queue.filter((item) => item.status === "paused");
}

export function queueItemLabel(item: ProjectedQueueItem): string {
  return (
    item.content
      .map((content) =>
        content.type === "text" ? content.text : (content.blob.name ?? "Attachment"),
      )
      .join(" ")
      .trim() || "Prompt with attachments"
  );
}
