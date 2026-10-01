// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { AttachmentPresence } from "@axl/sdk";

export function presenceDescription(peers: readonly AttachmentPresence[]): string {
  const kinds = peers.map((peer) => peer.clientKind).join(", ");
  return `${peers.length} other client${peers.length === 1 ? "" : "s"} attached${kinds ? `: ${kinds}` : ""}`;
}
