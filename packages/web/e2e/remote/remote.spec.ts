// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

// A phone-emulated browser pairs with a sandboxed daemon through a local deployment-test stack,
// then each scenario injects one failure a phone meets and sends a prompt through it. Every prompt
// must reach the model exactly once and its reply must appear exactly once, within a bound.

import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Page,
  test,
} from "@playwright/test";

import { type RemoteStack, startStack } from "./stack.ts";

const directory = process.env.AXL_REMOTE_E2E_DIRECTORY;
/** How long a reply may take after a failure clears. Detection itself is bounded separately. */
const RECOVERY_MS = 30_000;
/** The daemon notices a dead path through its 30 s heartbeat and a 5 s probe. */
const DAEMON_DETECTION_MS = 40_000;

test.describe.configure({ mode: "serial" });

let stack: RemoteStack;
let context: BrowserContext;
let page: Page;
const prompts: string[] = [];
const timings: Record<string, number> = {};

async function send(target: Page, text: string) {
  prompts.push(text);
  await target.locator("#prompt").fill(text);
  await target.locator("#send").click();
}

function replies(target: Page, text: string) {
  return target.locator("#records .message.assistant", { hasText: `Echo: ${text}` });
}

/** Send a prompt after a failure and record how long its reply took. */
async function through(name: string, target: Page, text: string, timeout = RECOVERY_MS) {
  const started = Date.now();
  await send(target, text);
  await expect(replies(target, text)).toHaveCount(1, { timeout });
  timings[name] = Date.now() - started;
}

/** A separate phone: its own storage, so its own device key. */
async function phone(browser: Browser, name: string): Promise<BrowserContext> {
  const created = await browser.newContext({ ...devices["Pixel 7"], ignoreHTTPSErrors: true });
  // The page's debug trace, for diagnosing a failed run from the stack logs.
  created.on("console", (message) =>
    appendFileSync(
      join(directory ?? ".", "logs/page.log"),
      `${new Date().toISOString()} ${name} ${message.type()} ${message.text()}
`,
    ),
  );
  return created;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  if (directory === undefined) throw new Error("Run through scripts/remote-e2e.ts");
  stack = await startStack(directory);
  await stack.createSession();
  context = await phone(browser, "phone");
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  await stack?.stop();
  if (directory !== undefined) {
    writeFileSync(join(directory, "logs/timings.json"), `${JSON.stringify(timings, null, 2)}\n`);
  }
  console.log(`Reply times after each failure (ms): ${JSON.stringify(timings)}`);
});

test("the phone pairs from the link and completes a turn", async () => {
  test.setTimeout(240_000);
  const link = await stack.pair();
  // `/remote` shows a short link naming the sealed full link, so its QR code stays small.
  expect(link).toMatch(/\/remote\/#p=[\w-]{22}\.[\w-]{43}$/u);
  const started = Date.now();
  await page.goto(link.replace("#", "?debug#"));
  await expect(page.locator(".remote-session")).toHaveCount(1, { timeout: 180_000 });
  timings.pairing = Date.now() - started;
  await page.locator(".remote-session").click();
  await expect(page.locator("#thread")).toBeVisible();
  await through("first turn", page, "p1 first turn", 120_000);
  const status = await stack.remoteStatus();
  assert.equal(status.phase, "paired");
  assert.equal(status.relay, "connected");
  assert.equal(status.deviceOnline, true);
});

test("dropped connections on both sides lose nothing", async () => {
  assert.equal(stack.dropConnections("all"), 2, "the phone and the daemon were connected");
  await through("both dropped", page, "p2 after drop");
});

test("a silent phone connection is replaced as soon as the page wakes", async () => {
  assert.equal(stack.stallConnections("phone"), 1);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await through("phone stalled", page, "p3 after phone stall");
});

test("a silent daemon connection is replaced by its heartbeat", async () => {
  test.setTimeout(120_000);
  assert.equal(stack.stallConnections("daemon"), 1);
  await through("daemon stalled", page, "p4 after daemon stall", DAEMON_DETECTION_MS + RECOVERY_MS);
});

test("a prompt sent while offline is delivered once the phone is back", async () => {
  await context.setOffline(true);
  stack.dropConnections("phone");
  await send(page, "p5 while offline");
  await delay(5_000);
  const started = Date.now();
  await context.setOffline(false);
  await expect(replies(page, "p5 while offline")).toHaveCount(1, { timeout: RECOVERY_MS });
  timings["back online"] = Date.now() - started;
});

test("a frozen page catches up after it resumes", async () => {
  const lifecycle = await context.newCDPSession(page);
  await lifecycle.send("Page.setWebLifecycleState", { state: "frozen" });
  stack.dropConnections("phone");
  await delay(5_000);
  await lifecycle.send("Page.setWebLifecycleState", { state: "active" });
  await lifecycle.detach();
  await through("page resumed", page, "p6 after freeze");
});

test("the open thread keeps working across a daemon restart", async () => {
  test.setTimeout(180_000);
  await stack.restartDaemon();
  await through("daemon restarted", page, "p7 after daemon restart", 90_000);
});

test("the pairing keeps working across a relay restart", async () => {
  test.setTimeout(420_000);
  await stack.restartRelay();
  await through("relay restarted", page, "p8 after relay restart", 60_000);
});

test("the pairing keeps working across a control-plane restart", async () => {
  test.setTimeout(180_000);
  // The witness resumes from its tables: the next fresh read of each lineage recovers it.
  await stack.restartControlPlane();
  await through("control plane restarted", page, "p8b after control-plane restart", 90_000);
});

test("the phone answers the agent's question and the turn finishes", async () => {
  // Two model turns around the question, each a few encrypted round trips.
  test.setTimeout(120_000);
  const started = Date.now();
  // Answered with the question's answer, not an echo, so it is checked here rather than in prompts.
  await page.locator("#prompt").fill("ask: the sky");
  await page.locator("#send").click();
  const card = page.locator(".interaction-card.questionnaire");
  await expect(card).toContainText("Which color for the sky?", { timeout: 60_000 });
  await expect(page.locator("#activity")).toContainText("Waiting for your answer");
  await card.getByRole("button", { name: /Blue/u }).click();
  await card.locator("footer button.primary").click();
  await expect(
    page.locator("#records .message.assistant", { hasText: "Echo: answered" }),
  ).toContainText("Blue", { timeout: 60_000 });
  timings["question answered"] = Date.now() - started;
  assert.equal(stack.model.prompts.get("ask: the sky"), 1, "the question's prompt ran once");
});

test("a second tab takes over and sees every reply exactly once", async () => {
  test.setTimeout(120_000);
  const second = await context.newPage();
  await second.goto(`${stack.origin}/remote/?debug`);
  await expect(page.locator("#status")).toHaveText(/moved to another tab/u, { timeout: 30_000 });
  await expect(second.locator(".remote-session")).toHaveCount(1, { timeout: 60_000 });
  await second.locator(".remote-session").click();
  await through("second tab", second, "p9 in the second tab", 60_000);
  for (const prompt of prompts) {
    await expect(replies(second, prompt), prompt).toHaveCount(1);
  }
  await second.close();
});

test("pairing again moves the daemon to the new phone and locks the old one out", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const link = await stack.pair();
  const next = await phone(browser, "new-phone");
  const copy = await phone(browser, "copied-link");
  try {
    const nextPage = await next.newPage();
    const started = Date.now();
    await nextPage.goto(link.replace("#", "?debug#"));
    await expect(nextPage.locator(".remote-session")).toHaveCount(1, { timeout: 180_000 });
    timings["pairing again"] = Date.now() - started;
    await nextPage.locator(".remote-session").click();
    await through("new phone", nextPage, "p10 on the new phone", 120_000);

    // The link enrolled the new phone's key, so a copy of it opened anywhere else enrolls nothing.
    const copied = await copy.newPage();
    await copied.goto(link.replace("#", "?debug#"));
    await expect(copied.locator("#status")).toHaveText(/already used on another device/u, {
      timeout: 60_000,
    });

    // The old phone's device was revoked, so the control plane will not let it reach the relay.
    await page.reload();
    await expect(page.locator("#status")).toHaveText(/no longer paired/u, { timeout: 60_000 });
  } finally {
    await copy.close();
    await next.close();
  }
});

test("every prompt reached the model exactly once", () => {
  assert.deepEqual(
    Object.fromEntries(prompts.map((prompt) => [prompt, stack.model.prompts.get(prompt) ?? 0])),
    Object.fromEntries(prompts.map((prompt) => [prompt, 1])),
  );
});
