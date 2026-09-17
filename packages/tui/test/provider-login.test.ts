// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { PLAIN_PALETTE, ProviderLoginOverlay, visibleWidth } from "../src/index.ts";

function fixture() {
  const controller = new AbortController();
  const overlay = new ProviderLoginOverlay({
    title: "Login to GitHub Copilot",
    palette: () => PLAIN_PALETTE,
    signal: controller.signal,
    cancel: () => controller.abort(),
    refresh: () => {},
  });
  return { overlay, controller };
}

test("inline login accepts blank text, masks secrets, and places the cursor after wrapped input", async () => {
  const { overlay } = fixture();
  const domain = overlay.prompt({
    message: "GitHub Enterprise domain (blank for github.com)",
    placeholder: "company.ghe.com",
    allowEmpty: true,
  });
  const rendered = overlay.render(60);
  assert.match(rendered.join("\n"), /company.ghe.com\n {2}> /);
  overlay.handleKey("\r");
  assert.equal(await domain, "");
  const secret = overlay.prompt({ message: "API key", mask: true });
  overlay.paste("obviously-fake-secret");
  const rows = overlay.render(30);
  assert.doesNotMatch(rows.join("\n"), /obviously-fake-secret/);
  assert.match(rows.join("\n"), /\*{21}/);
  assert.equal(
    rows.every((row) => visibleWidth(row) <= 30),
    true,
  );
  const cursor = overlay.cursor();
  assert.ok(cursor);
  assert.equal(cursor.column, visibleWidth(rows[cursor.row] ?? ""));
  overlay.handleKey("\r");
  assert.equal(await secret, "obviously-fake-secret");
  assert.doesNotMatch(overlay.render(60).join("\n"), /\*{21}|obviously-fake-secret/);
  overlay.dispose();
});

test("inline login retains authorization instructions and cancels pending prompts", async () => {
  const { overlay, controller } = fixture();
  overlay.notify("Open https://example.com/authorize\nCode: EXAMPLE");
  const prompt = overlay.prompt({ message: "Paste code", mask: true });
  assert.match(overlay.render(60).join("\n"), /https:\/\/example.com\/authorize/);
  controller.abort();
  await assert.rejects(prompt, /Login cancelled/);
  overlay.dispose();
  const next = fixture();
  const selected = next.overlay.prompt({
    message: "Choose account",
    options: [
      { value: "one", label: "First" },
      { value: "two", label: "Second" },
    ],
  });
  next.overlay.handleKey("\x1b[B\r");
  assert.equal(await selected, "two");
  const cancelled = next.overlay.prompt({ message: "Account" });
  next.overlay.handleKey("\x1b");
  await assert.rejects(cancelled, /Login cancelled/);
});
