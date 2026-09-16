// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type { AxlE2eeErrorCode, BindingInfo, PairingInspection } from "../index.js";

const errors = [
  "secure_random_unavailable",
  "rollback_anchor_unavailable",
  "bound_exceeded",
  "endpoint_closed",
] as const satisfies readonly AxlE2eeErrorCode[];

const acceptsTypes = (info: BindingInfo, inspection: PairingInspection): void => {
  const id: Uint8Array = inspection.cryptoSessionId;
  void [errors, id, info.productionStorageReady, info.workerRequired];
};
void acceptsTypes;
