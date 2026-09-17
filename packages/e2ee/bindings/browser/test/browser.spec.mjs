// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { test } from "@playwright/test";

import {
  assertBoundaryScenario,
  assertLifecycleScenario,
  assertNegativeOpenMlsScenario,
  assertPersistenceScenario,
  assertStateScenario,
} from "./scenario-assertions.mjs";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.axlBrowserTest !== undefined);
});

test("executes the fresh OpenMLS pairing, traffic, and epoch lifecycle", async ({ page }) => {
  const result = await page.evaluate(() => window.axlBrowserTest.runLifecycleScenario());
  assertLifecycleScenario(result);
});

test("rejects replay, corruption, binding mismatches, and competing commits in OpenMLS", async ({
  page,
}) => {
  const result = await page.evaluate(() => window.axlBrowserTest.runNegativeOpenMlsScenario());
  assertNegativeOpenMlsScenario(result);
});

test("enforces bounds independently in the loader, worker, and Rust", async ({ page }) => {
  const result = await page.evaluate(() => window.axlBrowserTest.runBoundaryScenario());
  assertBoundaryScenario(result);
});

test("fails closed for randomness, close, fatal state, and malformed responses", async ({ page }) => {
  const result = await page.evaluate(() => window.axlBrowserTest.runStateScenario());
  assertStateScenario(result);
});

test("verifies unanimous witness certificates in production WASM", async ({ page }) => {
  const result = await page.evaluate(() =>
    window.axlBrowserTest.runProductionWitnessVerifierScenario(),
  );
  test.expect(result).toEqual({ invalid: "witness_receipt_invalid", requestBytes: 414 });
});

test("persists production witness-pending envelopes without exposing key handles", async ({ page }) => {
  const result = await page.evaluate(() => window.axlBrowserTest.runProductionStorageScenario());
  test.expect(result).toEqual({
    contention: "lifecycle_busy",
    pendingStatus: "pending_quorum",
    recoveredStatus: "pending_quorum",
    restartStatus: "committed",
    exact: "committed browser output",
    repeated: "committed browser output",
    verificationCount: 2,
  });
});

test("persists prepare-and-compare transitions in real IndexedDB under Web Locks", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const result = await page.evaluate(() => window.axlBrowserTest.runPersistenceScenario());
  assertPersistenceScenario(result);
});
