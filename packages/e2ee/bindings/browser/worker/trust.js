// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

// Build-pinned production replica trust is a later production gate. Until it exists, no production
// endpoint can be created or opened: the worker receives no trust and refuses every endpoint
// operation with `rollback_anchor_unavailable`.
export async function loadReplicaTrust() {
  return undefined;
}
