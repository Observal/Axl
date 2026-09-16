// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { buildChromiumFlags, validateNavigationUrl } from "../src/policy.ts";

test("chromium flags include hardening defaults without sandbox flag", () => {
  const flags = buildChromiumFlags({
    userDataDir: "/tmp/browser-data",
    downloadDirectory: "/workspace/.downloads",
    outerSandboxActive: false,
  });
  assert.ok(flags.includes("--disable-gpu"));
  assert.ok(flags.includes("--disable-dev-shm-usage"));
  assert.ok(flags.includes("--disable-extensions"));
  assert.ok(!flags.includes("--no-sandbox"));
  assert.ok(!flags.some((f) => f.startsWith("--user-data-dir")));
  assert.ok(!flags.some((f) => f.startsWith("--headless")));
});

test("chromium flags disable internal sandbox when outer sandbox is active", () => {
  const flags = buildChromiumFlags({
    userDataDir: "/tmp/browser-data",
    downloadDirectory: "/workspace/.downloads",
    outerSandboxActive: true,
  });
  assert.ok(flags.includes("--no-sandbox"));
});

test("chromium flags include proxy when configured", () => {
  const flags = buildChromiumFlags({
    userDataDir: "/tmp/browser-data",
    downloadDirectory: "/workspace/.downloads",
    outerSandboxActive: true,
    proxyUrl: "http://localhost:8080",
  });
  assert.ok(flags.includes("--proxy-server=http://localhost:8080"));
});

test("chromium flags omit proxy when not configured", () => {
  const flags = buildChromiumFlags({
    userDataDir: "/tmp/browser-data",
    downloadDirectory: "/workspace/.downloads",
    outerSandboxActive: false,
  });
  assert.ok(!flags.some((f) => f.startsWith("--proxy-server")));
});

test("validateNavigationUrl accepts public http and https", () => {
  const http = validateNavigationUrl("http://example.com/page");
  assert.equal(http.protocol, "http:");
  const https = validateNavigationUrl("https://example.com/page?q=1");
  assert.equal(https.protocol, "https:");
});

test("validateNavigationUrl rejects non-http schemes", () => {
  assert.throws(() => validateNavigationUrl("ftp://example.com"), /http or https/);
  assert.throws(() => validateNavigationUrl("file:///etc/passwd"), /http or https/);
  assert.throws(() => validateNavigationUrl("javascript:alert(1)"), /http or https/);
});

test("validateNavigationUrl rejects credentials in URL", () => {
  assert.throws(() => validateNavigationUrl("https://user:pass@example.com"), /credentials/);
  assert.throws(() => validateNavigationUrl("https://user@example.com"), /credentials/);
});

test("validateNavigationUrl rejects invalid URLs", () => {
  assert.throws(() => validateNavigationUrl("not a url"), /invalid URL/);
  assert.throws(() => validateNavigationUrl(""), /invalid URL/);
});
