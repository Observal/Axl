// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  TerminalExtension,
  TerminalToolRenderInput,
  TerminalToolRenderResult,
} from "@axl/extension-api";

/**
 * TUI extension that renders browser tool calls with clean labels instead of
 * raw output. Screenshot results include inline terminal images when the
 * terminal supports it (iTerm2, Kitty, WezTerm, Ghostty).
 */
export const browserTerminalExtension: TerminalExtension = {
  manifest: {
    id: "axl.browser",
    name: "Browser tools",
    capabilities: ["terminal.tool-renderers"],
  },
  activate(api) {
    api.registerToolRenderer("browser_navigate", renderNavigate);
    api.registerToolRenderer("browser_screenshot", renderScreenshot);
    api.registerToolRenderer("browser_click", renderClick);
    api.registerToolRenderer("browser_type", renderType);
    api.registerToolRenderer("browser_scroll", renderScroll);
    api.registerToolRenderer("browser_read", renderRead);
  },
};

function renderNavigate(input: TerminalToolRenderInput): TerminalToolRenderResult | undefined {
  const url = (input.arguments as Record<string, unknown>).url;
  if (typeof url !== "string") return undefined;
  if (input.status === "running" || input.status === "pending") {
    return { label: `Navigating to ${url}` };
  }
  if (input.status === "succeeded") {
    const lines = input.result ? extractTitle(input.result) : undefined;
    return {
      label: `Navigated to ${url}`,
      ...(lines === undefined ? {} : { lines: [{ text: lines, tone: "muted" as const }] }),
      hideWhenSuccessfulInFocus: false,
    };
  }
  return { label: `Navigate to ${url}` };
}

function renderScreenshot(input: TerminalToolRenderInput): TerminalToolRenderResult | undefined {
  if (input.status === "running" || input.status === "pending") {
    return { label: "Taking screenshot…" };
  }
  if (input.status === "succeeded" && input.result) {
    const pathMatch = input.result.match(/screenshot saved: ([^\s·]+)/);
    const bytesMatch = input.result.match(/(\d+) bytes/);
    const path = pathMatch?.[1];
    const bytes = bytesMatch?.[1];
    if (path !== undefined) {
      return { label: `Screenshot saved to ${path}`, target: path, hideWhenSuccessfulInFocus: false };
    }
    return {
      label: `Screenshot captured${bytes ? ` · ${bytes} bytes` : ""}`,
      hideWhenSuccessfulInFocus: false,
    };
  }
  return { label: "Screenshot" };
}

function renderClick(input: TerminalToolRenderInput): TerminalToolRenderResult | undefined {
  const args = input.arguments as Record<string, unknown>;
  const target = typeof args.selector === "string" ? args.selector : `(${args.x}, ${args.y})`;
  if (input.status === "running" || input.status === "pending") {
    return { label: `Clicking ${target}` };
  }
  if (input.status === "succeeded") {
    return { label: `Clicked ${target}`, hideWhenSuccessfulInFocus: true };
  }
  return { label: `Click ${target}` };
}

function renderType(input: TerminalToolRenderInput): TerminalToolRenderResult | undefined {
  const args = input.arguments as Record<string, unknown>;
  const selector = typeof args.selector === "string" ? args.selector : "element";
  const text = typeof args.text === "string" ? args.text : "";
  const preview = text.length > 30 ? `${text.slice(0, 30)}…` : text;
  if (input.status === "running" || input.status === "pending") {
    return { label: `Typing into ${selector}` };
  }
  if (input.status === "succeeded") {
    return {
      label: `Typed "${preview}" into ${selector}`,
      hideWhenSuccessfulInFocus: true,
    };
  }
  return { label: `Type into ${selector}` };
}

function renderScroll(input: TerminalToolRenderInput): TerminalToolRenderResult | undefined {
  const args = input.arguments as Record<string, unknown>;
  const direction = typeof args.direction === "string" ? args.direction : "down";
  if (input.status === "running" || input.status === "pending") {
    return { label: `Scrolling ${direction}` };
  }
  if (input.status === "succeeded") {
    return { label: `Scrolled ${direction}`, hideWhenSuccessfulInFocus: true };
  }
  return { label: `Scroll ${direction}` };
}

function renderRead(input: TerminalToolRenderInput): TerminalToolRenderResult | undefined {
  const args = input.arguments as Record<string, unknown>;
  const selector = typeof args.selector === "string" ? args.selector : "full page";
  if (input.status === "running" || input.status === "pending") {
    return { label: `Reading ${selector}` };
  }
  if (input.status === "succeeded") {
    const chars = input.result?.length ?? 0;
    return {
      label: `Read ${selector} · ${chars > 1000 ? `${(chars / 1000).toFixed(1)}k` : chars} chars`,
      hideWhenSuccessfulInFocus: false,
    };
  }
  return { label: `Read ${selector}` };
}

function extractTitle(result: string): string | undefined {
  const match = result.match(/Title: (.+)/);
  return match?.[1];
}
