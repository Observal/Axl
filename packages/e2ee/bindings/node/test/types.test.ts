// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type {
  AxlE2eeErrorCode,
  BindingInfo,
  DaemonEndpoint,
  DeviceEndpoint,
  NativeOutbox,
  NativePlaintext,
  PairState,
  Publication,
} from "../index.js";

const codes = [
  "lifecycle_busy",
  "secure_store_unavailable",
  "rollback_anchor_unavailable",
] as const satisfies readonly AxlE2eeErrorCode[];
const acceptsBigint = (_value: bigint): void => {};
const inspectTypes = (
  info: BindingInfo,
  daemon: DaemonEndpoint,
  device: DeviceEndpoint,
  outbox: NativeOutbox,
  plaintext: NativePlaintext,
  publication: Publication,
  state: PairState,
): void => {
  acceptsBigint(outbox.epoch);
  acceptsBigint(plaintext.epoch);
  if ("expiresAtMs" in publication) acceptsBigint(publication.expiresAtMs);
  void [info, daemon, device, publication, state, codes];
};
void inspectTypes;
