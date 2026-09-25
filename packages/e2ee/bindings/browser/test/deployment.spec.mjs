// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { test } from "@playwright/test";

test("a browser device pairs with a native daemon through the deployment-test artifact", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.waitForFunction(() => window.axlDeploymentTest !== undefined);
  const result = await page.evaluate(() => window.axlDeploymentTest.runDeploymentPairing());
  assert.deepEqual(result, {
    unauthorized: "witness_auth_failed",
    recreate: "already_exists",
    claimDeterministic: true,
    claimSession: true,
    joined: { tag: "joined", epoch: "1" },
    joinRetryExact: true,
    activationClass: 6,
    activated: true,
    phoneToDaemon: "hello from the phone",
    daemonToPhone: "hello from the daemon",
    closed: "endpoint_closed",
    afterReopen: "after reopen",
  });
});
