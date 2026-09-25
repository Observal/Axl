// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "@playwright/test";

// Real-browser pairing of the deployment-test artifact with a native daemon. Needs
// `dist/deployment-test` and AXL_E2EE_NODE_TEST_ARTIFACT; run through `scripts/test-deployment.mjs`.
export default defineConfig({
  testDir: "./test",
  testMatch: "deployment.spec.mjs",
  outputDir: "./dist/test-results-deployment",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4179",
    headless: true,
  },
  webServer: {
    command: "node test/deployment-server.mjs",
    port: 4179,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chrome",
      use: {
        browserName: "chromium",
        // Local runs without Google Chrome can use Playwright's bundled Chromium instead.
        channel: process.env.AXL_E2EE_BUNDLED_CHROMIUM === "1" ? undefined : "chrome",
      },
    },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
