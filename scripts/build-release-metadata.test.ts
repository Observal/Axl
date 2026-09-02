// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { renderOpenVex } from "./build-release-metadata.ts";

test("renders deterministic OpenVEX metadata without unreviewed claims", () => {
  const timestamp = "2026-09-02T11:00:00+00:00";
  const first = renderOpenVex("0.2.1-rc.1", timestamp);
  const second = renderOpenVex("0.2.1-rc.1", timestamp);
  const vex = JSON.parse(first) as {
    readonly "@context": string;
    readonly "@id": string;
    readonly timestamp: string;
    readonly statements: readonly unknown[];
  };

  assert.equal(first, second);
  assert.equal(vex["@context"], "https://openvex.dev/ns/v0.2.0");
  assert.equal(vex["@id"], "https://github.com/Observal/Axl/releases/tag/v0.2.1-rc.1#vex");
  assert.equal(vex.timestamp, timestamp);
  assert.deepEqual(vex.statements, []);
});

test("rejects invalid OpenVEX release metadata", () => {
  assert.throws(() => renderOpenVex("0.2", "2026-09-02T11:00:00Z"), /Invalid release version/);
  assert.throws(() => renderOpenVex("0.2.1", "not-a-date"), /Invalid release timestamp/);
});
