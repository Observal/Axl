// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertAllScenarios } from "../test/scenario-assertions.mjs";

if (process.platform !== "darwin") throw new Error("Safari WebDriver requires macOS");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const driverPort = 4179;
const serverPort = 4180;
const server = spawn(process.execPath, [join(root, "test/server.mjs")], {
  cwd: root,
  env: { ...process.env, AXL_E2EE_BROWSER_PORT: String(serverPort) },
  stdio: "inherit",
});
const driver = spawn("safaridriver", ["-p", String(driverPort)], { stdio: "inherit" });
const endpoint = `http://127.0.0.1:${driverPort}`;
let sessionId;

async function command(path, method = "GET", body) {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok || value.value?.error) throw new Error(`Safari WebDriver command failed: ${JSON.stringify(value.value)}`);
  return value.value;
}

async function waitForDriver() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await command("/status");
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error("Safari WebDriver did not start");
}

try {
  await waitForDriver();
  const session = await command("/session", "POST", {
    capabilities: { alwaysMatch: { browserName: "safari" } },
  });
  sessionId = session.sessionId;
  await command(`/session/${sessionId}/timeouts`, "POST", { script: 600_000 });
  await command(`/session/${sessionId}/url`, "POST", { url: `http://127.0.0.1:${serverPort}/` });
  const result = await command(`/session/${sessionId}/execute/async`, "POST", {
    script: `
      const done = arguments[arguments.length - 1];
      (async () => {
        for (let i = 0; i < 100 && !window.axlBrowserTest; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        done({ scenarios: await window.axlBrowserTest.runAllScenarios() });
      })().catch((error) => done({ error: String(error) }));
    `,
    args: [],
  });
  assert.equal(result.error, undefined);
  assertAllScenarios(result.scenarios);
  console.log("Actual Safari WebDriver browser/WASM evidence passed.");
} finally {
  if (sessionId) {
    try {
      await command(`/session/${sessionId}`, "DELETE");
    } catch {}
  }
  driver.kill("SIGTERM");
  server.kill("SIGTERM");
}
