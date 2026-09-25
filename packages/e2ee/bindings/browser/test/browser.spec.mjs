// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { test } from "@playwright/test";

import {
  assertBoundaryScenario,
  assertLifecycleScenario,
  assertNegativeOpenMlsScenario,
  assertPersistenceScenario,
  assertDeviceBarrierScenario,
  assertDeviceTerminationScenario,
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

test("runs every browser device mutation through the witness barrier in the worker", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const result = await page.evaluate(() => window.axlBrowserTest.runDeviceBarrierScenario());
  assertDeviceBarrierScenario(result);
});

test("recovers the exact pending request after real worker termination", async ({ page }) => {
  const result = await page.evaluate(() => window.axlBrowserTest.runDeviceTerminationScenario());
  assertDeviceTerminationScenario(result);
});

test("persists prepare-and-compare transitions in real IndexedDB under Web Locks", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const result = await page.evaluate(() => window.axlBrowserTest.runPersistenceScenario());
  assertPersistenceScenario(result);
});
