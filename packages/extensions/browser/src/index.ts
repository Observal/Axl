// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

export type { BrowserSession, BrowserSessionOptions, PageState } from "./session.ts";
export {
  createPlaywrightSession,
  type PlaywrightSessionOptions,
} from "./playwright-session.ts";
export { buildChromiumFlags, validateNavigationUrl, type BrowserLaunchPolicy } from "./policy.ts";
export {
  makeBrowserTools,
  makeBrowserNavigateTool,
  makeBrowserScreenshotTool,
  makeBrowserClickTool,
  makeBrowserTypeTool,
  makeBrowserScrollTool,
  makeBrowserReadTool,
  BROWSER_PROMPT_SECTION,
  type BrowserToolsOptions,
} from "./tools.ts";
export { browserTerminalExtension } from "./tui-renderer.ts";
