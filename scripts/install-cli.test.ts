// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { WIRE_PROTOCOL_VERSION } from "../packages/protocol/src/version.ts";
import { daemonRestartNotice } from "./install-cli.ts";

const oldWireVersion = WIRE_PROTOCOL_VERSION - 1;

test("reports the safe restart command for an outdated daemon", () => {
  assert.equal(
    daemonRestartNotice({
      wireVersion: WIRE_PROTOCOL_VERSION,
      busy: false,
      confirmationRequired: false,
    }),
    undefined,
  );
  assert.match(
    daemonRestartNotice({
      wireVersion: oldWireVersion,
      busy: false,
      confirmationRequired: false,
    }) ?? "",
    /axl daemon restart$/,
  );
  assert.match(
    daemonRestartNotice({ wireVersion: oldWireVersion, busy: true, confirmationRequired: true }) ??
      "",
    /axl daemon restart --interrupt --yes$/,
  );
});
