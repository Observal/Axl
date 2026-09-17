// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser session abstraction. The concrete implementation drives a real
 * headless Chromium process; tests inject a fake.
 */

export interface PageState {
  readonly url: string;
  readonly title: string;
  readonly excerpt: string;
}

export interface BrowserSession {
  navigate(url: string, signal: AbortSignal): Promise<PageState>;
  screenshot(signal: AbortSignal): Promise<Buffer>;
  click(selector: string, signal: AbortSignal): Promise<PageState>;
  clickCoordinates(x: number, y: number, signal: AbortSignal): Promise<PageState>;
  type(selector: string, text: string, signal: AbortSignal): Promise<PageState>;
  scroll(direction: "up" | "down", amount: number, signal: AbortSignal): Promise<PageState>;
  readPage(selector: string | undefined, signal: AbortSignal): Promise<string>;
  /** Navigate back one entry in session history. */
  back(signal: AbortSignal): Promise<PageState>;
  /** Navigate forward one entry in session history. */
  forward(signal: AbortSignal): Promise<PageState>;
  /** Wait for an element matching the selector to appear, up to timeoutMs. */
  waitForSelector(selector: string, timeoutMs: number, signal: AbortSignal): Promise<PageState>;
  /** Evaluate a JavaScript expression in the page and return a JSON-safe result. */
  evaluate(expression: string, signal: AbortSignal): Promise<unknown>;
  /** Choose an option by value in a <select> element. */
  selectOption(selector: string, value: string, signal: AbortSignal): Promise<PageState>;
  close(): Promise<void>;
}

export interface BrowserSessionOptions {
  readonly downloadDirectory: string;
  readonly signal: AbortSignal;
}
