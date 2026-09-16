// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { test } from "@playwright/test";

import {
  assertBoundaryScenario,
  assertLifecycleScenario,
  assertNegativeOpenMlsScenario,
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
