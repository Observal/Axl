// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { defineConfig, devices } from "@playwright/test";

// Phone remote control against a local deployment-test stack; run through scripts/remote-e2e.ts,
// which prepares AXL_REMOTE_E2E_DIRECTORY. One worker: the scenarios share one pairing and inject
// failures into it in order.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "../../dist/remote-e2e-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    ...devices["Pixel 7"],
    // The stack's origin uses a certificate made for this run.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "phone",
      use: {
        browserName: "chromium",
        // Local runs without Google Chrome can use Playwright's bundled Chromium instead.
        channel: process.env.AXL_REMOTE_E2E_BUNDLED_CHROMIUM === "1" ? undefined : "chrome",
      },
    },
  ],
});
