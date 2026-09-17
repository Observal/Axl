// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { BrowserContext, Page } from "playwright";

import type { BrowserSession, BrowserSessionOptions, PageState } from "./session.ts";
import { buildChromiumFlags, type BrowserLaunchPolicy, validateNavigationUrl } from "./policy.ts";

const PAGE_LOAD_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const MAX_EXCERPT_LENGTH = 2_000;

async function pageState(page: Page): Promise<PageState> {
  const title = await page.title();
  const url = page.url();
  const excerpt = await page
    .evaluate("document.body ? document.body.innerText : ''")
    .then((value) => (typeof value === "string" ? value : ""))
    .catch(() => "");
  return {
    url,
    title,
    excerpt: excerpt.length > MAX_EXCERPT_LENGTH ? excerpt.slice(0, MAX_EXCERPT_LENGTH) : excerpt,
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
}

export interface PlaywrightSessionOptions extends BrowserSessionOptions {
  readonly launchPolicy: BrowserLaunchPolicy;
  readonly playwrightModule?: {
    chromium: {
      launchPersistentContext(
        userDataDir: string,
        options: unknown,
      ): Promise<BrowserContext>;
    };
  };
}

export async function createPlaywrightSession(
  options: PlaywrightSessionOptions,
): Promise<BrowserSession> {
  const pw =
    options.playwrightModule ?? ((await import("playwright")) as typeof import("playwright"));

  const flags = buildChromiumFlags(options.launchPolicy);

  const context: BrowserContext = await pw.chromium.launchPersistentContext(
    options.launchPolicy.userDataDir,
    {
      headless: true,
      args: [...flags],
      acceptDownloads: true,
      viewport: { width: 1280, height: 720 },
    },
  );
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(PAGE_LOAD_TIMEOUT_MS);

  const page: Page = await context.newPage();

  page.on("download", (download) => {
    void download.saveAs(`${options.downloadDirectory}/${download.suggestedFilename()}`).catch(() => {});
  });

  const session: BrowserSession = {
    async navigate(url: string, signal: AbortSignal): Promise<PageState> {
      throwIfAborted(signal);
      validateNavigationUrl(url);
      const response = await page.goto(url, { waitUntil: "domcontentloaded" });
      if (response !== null && response.status() >= 400) {
        throw new Error(`browser: navigation to ${url} returned HTTP ${String(response.status())}`);
      }
      return pageState(page);
    },

    async screenshot(signal: AbortSignal): Promise<Buffer> {
      throwIfAborted(signal);
      const bytes = await page.screenshot({ type: "png", fullPage: false });
      return Buffer.from(bytes);
    },

    async click(selector: string, signal: AbortSignal): Promise<PageState> {
      throwIfAborted(signal);
      await page.click(selector, { timeout: ACTION_TIMEOUT_MS });
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      return pageState(page);
    },

    async clickCoordinates(x: number, y: number, signal: AbortSignal): Promise<PageState> {
      throwIfAborted(signal);
      await page.mouse.click(x, y);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      return pageState(page);
    },

    async type(selector: string, text: string, signal: AbortSignal): Promise<PageState> {
      throwIfAborted(signal);
      await page.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
      return pageState(page);
    },

    async scroll(
      direction: "up" | "down",
      amount: number,
      signal: AbortSignal,
    ): Promise<PageState> {
      throwIfAborted(signal);
      const delta = direction === "down" ? amount : -amount;
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(200);
      return pageState(page);
    },

    async readPage(selector: string | undefined, signal: AbortSignal): Promise<string> {
      throwIfAborted(signal);
      if (selector !== undefined) {
        const element = page.locator(selector).first();
        return element.innerText({ timeout: ACTION_TIMEOUT_MS });
      }
      return page
        .evaluate("document.body ? document.body.innerText : ''")
        .then((value) => (typeof value === "string" ? value : ""));
    },

    async back(signal: AbortSignal): Promise<PageState> {
      throwIfAborted(signal);
      const response = await page.goBack({ waitUntil: "domcontentloaded" });
      if (response === null) throw new Error("browser: no earlier page in history");
      return pageState(page);
    },

    async forward(signal: AbortSignal): Promise<PageState> {
      throwIfAborted(signal);
      const response = await page.goForward({ waitUntil: "domcontentloaded" });
      if (response === null) throw new Error("browser: no later page in history");
      return pageState(page);
    },

    async waitForSelector(
      selector: string,
      timeoutMs: number,
      signal: AbortSignal,
    ): Promise<PageState> {
      throwIfAborted(signal);
      await page.locator(selector).first().waitFor({ state: "visible", timeout: timeoutMs });
      return pageState(page);
    },

    async evaluate(expression: string, signal: AbortSignal): Promise<unknown> {
      throwIfAborted(signal);
      // Playwright serializes the result as JSON; non-serializable values throw.
      return page.evaluate(expression);
    },

    async selectOption(selector: string, value: string, signal: AbortSignal): Promise<PageState> {
      throwIfAborted(signal);
      await page.selectOption(selector, value, { timeout: ACTION_TIMEOUT_MS });
      return pageState(page);
    },

    async close(): Promise<void> {
      await context.close().catch(() => {});
    },
  };

  if (options.signal.aborted) {
    await session.close();
    throw options.signal.reason ?? new Error("aborted");
  }
  options.signal.addEventListener("abort", () => void session.close(), { once: true });

  return session;
}
