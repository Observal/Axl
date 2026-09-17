// SPDX-FileCopyrightText: 2026 Tanvi Reddy
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject } from "@axl/protocol";

import type { KernelTool, ToolExecutionResult } from "@axl/kernel";
import {
  optionalPositiveInteger,
  optionalString,
  rejectUnknownFields,
  requiredString,
  ToolInputError,
} from "@axl/kernel";

import type { BrowserSession, PageState } from "./session.ts";
import { validateNavigationUrl } from "./policy.ts";

const MAX_READ_CHARACTERS = 40_000;

function pageStateText(state: PageState): string {
  return `Title: ${state.title}\nURL: ${state.url}\n\n${state.excerpt}`;
}

function pageResult(state: PageState): ToolExecutionResult {
  return {
    content: [{ type: "text", text: `[browser page]\n${pageStateText(state)}` }],
    isError: false,
    details: { url: state.url, title: state.title },
  };
}

export interface BrowserToolsOptions {
  readonly session: BrowserSession;
  /** Directory to save screenshot files. When set, screenshots are saved as PNGs. */
  readonly screenshotDirectory?: string;
  /** Called after a screenshot is saved. Used to auto-open the file. */
  readonly onScreenshotSaved?: (path: string) => void;
}

/** Prompt section for the model when browser tools are available. */
export const BROWSER_PROMPT_SECTION =
  "Browser tools are available for pages that require JavaScript rendering " +
  "or interaction (clicking, typing, filling forms). Prefer web_fetch for " +
  "simple static pages since it is faster. Use browser_navigate when the " +
  "page needs JavaScript to load content, when you need to interact with " +
  "the page, or when web_fetch returns unhelpful raw HTML. After navigating, " +
  "use browser_read to extract text or browser_screenshot to see the page. " +
  "The browser runs headless inside the session sandbox.";

export function makeBrowserNavigateTool(options: BrowserToolsOptions): KernelTool {
  return {
    name: "browser_navigate",
    description:
      "Navigate the browser to a URL. Returns the page title and a readable text excerpt.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public HTTP or HTTPS URL to visit" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "browser_navigate", ["url"]);
      const url = requiredString(input, "browser_navigate", "url");
      validateNavigationUrl(url);
      const state = await options.session.navigate(url, signal);
      return pageResult(state);
    },
  };
}

export function makeBrowserScreenshotTool(options: BrowserToolsOptions): KernelTool {
  return {
    name: "browser_screenshot",
    description:
      "Capture a PNG screenshot of the current browser viewport." +
      (options.screenshotDirectory
        ? " The screenshot is saved to disk and opened automatically."
        : ""),
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "browser_screenshot", []);
      const png = await options.session.screenshot(signal);

      let savedPath: string | undefined;
      if (options.screenshotDirectory !== undefined) {
        await mkdir(options.screenshotDirectory, { recursive: true });
        const filename = `screenshot-${Date.now()}.png`;
        savedPath = join(options.screenshotDirectory, filename);
        await writeFile(savedPath, png);
        options.onScreenshotSaved?.(savedPath);
      }

      // When saved to disk, return just the path — avoids bloating the model
      // context with hundreds of KB of base64. The model can use browser_read
      // or take another screenshot if it needs to see the page content.
      if (savedPath !== undefined) {
        return {
          content: [
            {
              type: "text",
              text: `[screenshot saved: ${savedPath} \u00b7 ${png.byteLength} bytes]\nThe screenshot has been saved and opened for the user to view. Describe what you expected to see or use browser_read to extract text content.`,
            },
          ],
          isError: false,
          details: { bytes: png.byteLength, path: savedPath },
        };
      }

      const base64 = png.toString("base64");
      return {
        content: [
          {
            type: "text",
            text: `[screenshot captured: ${png.byteLength} bytes, image/png]\n<image>data:image/png;base64,${base64}</image>`,
          },
        ],
        isError: false,
        details: { bytes: png.byteLength },
      };
    },
  };
}

export function makeBrowserClickTool(options: BrowserToolsOptions): KernelTool {
  return {
    name: "browser_click",
    description:
      "Click an element on the current page by CSS selector or viewport coordinates. Returns the updated page state.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the element to click" },
        x: {
          type: "integer",
          description: "Viewport X coordinate (use with y instead of selector)",
        },
        y: {
          type: "integer",
          description: "Viewport Y coordinate (use with x instead of selector)",
        },
      },
      additionalProperties: false,
    },
    async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "browser_click", ["selector", "x", "y"]);
      const selector = optionalString(input, "browser_click", "selector");
      const x = optionalPositiveInteger(input, "browser_click", "x");
      const y = optionalPositiveInteger(input, "browser_click", "y");
      if (selector !== undefined && (x !== undefined || y !== undefined)) {
        throw new ToolInputError("browser_click: provide selector or coordinates, not both");
      }
      if (selector === undefined && (x === undefined || y === undefined)) {
        throw new ToolInputError("browser_click: provide selector or both x and y coordinates");
      }
      const state =
        selector !== undefined
          ? await options.session.click(selector, signal)
          : await options.session.clickCoordinates(x as number, y as number, signal);
      return pageResult(state);
    },
  };
}

export function makeBrowserTypeTool(options: BrowserToolsOptions): KernelTool {
  return {
    name: "browser_type",
    description: "Type text into an element on the current page identified by CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the input element" },
        text: { type: "string", description: "Text to type" },
      },
      required: ["selector", "text"],
      additionalProperties: false,
    },
    async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "browser_type", ["selector", "text"]);
      const selector = requiredString(input, "browser_type", "selector");
      const text = requiredString(input, "browser_type", "text");
      const state = await options.session.type(selector, text, signal);
      return pageResult(state);
    },
  };
}

export function makeBrowserScrollTool(options: BrowserToolsOptions): KernelTool {
  return {
    name: "browser_scroll",
    description:
      "Scroll the browser viewport up or down. Returns the visible text after scrolling.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"], description: "Scroll direction" },
        amount: {
          type: "integer",
          description: "Pixels to scroll (default 600)",
        },
      },
      required: ["direction"],
      additionalProperties: false,
    },
    async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "browser_scroll", ["direction", "amount"]);
      const direction = requiredString(input, "browser_scroll", "direction");
      if (direction !== "up" && direction !== "down") {
        throw new ToolInputError("browser_scroll: direction must be up or down");
      }
      const amount = optionalPositiveInteger(input, "browser_scroll", "amount") ?? 600;
      const state = await options.session.scroll(direction, amount, signal);
      return pageResult(state);
    },
  };
}

export function makeBrowserReadTool(options: BrowserToolsOptions): KernelTool {
  return {
    name: "browser_read",
    description: "Extract readable text content from the current page or a specific element.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to extract text from (omit for full page)",
        },
        maxCharacters: {
          type: "integer",
          description: "Maximum characters to return",
        },
      },
      additionalProperties: false,
    },
    async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "browser_read", ["selector", "maxCharacters"]);
      const selector = optionalString(input, "browser_read", "selector");
      const maxCharacters = Math.min(
        optionalPositiveInteger(input, "browser_read", "maxCharacters") ?? MAX_READ_CHARACTERS,
        100_000,
      );
      const content = await options.session.readPage(selector, signal);
      const truncated = content.length > maxCharacters;
      const shown = content.slice(0, maxCharacters);
      return {
        content: [
          {
            type: "text",
            text: `[browser page content]\n${shown}${
              truncated ? `\n[truncated at ${maxCharacters} characters]` : ""
            }`,
          },
        ],
        isError: false,
        details: { selector: selector ?? "full page", characters: shown.length, truncated },
      };
    },
  };
}

const MAX_EVAL_CHARACTERS = 40_000;
const MAX_WAIT_MS = 30_000;
const DEFAULT_WAIT_MS = 10_000;

export function makeBrowserBackTool(options: BrowserToolsOptions): KernelTool {
  return {
    name: "browser_back",
    description: "Navigate back one entry in the browser history. Returns the updated page state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "browser_back", []);
      const state = await options.session.back(signal);
      return pageResult(state);
    },
  };
}

export function makeBrowserForwardTool(options: BrowserToolsOptions): KernelTool {
  return {
    name: "browser_forward",
    description:
      "Navigate forward one entry in the browser history. Returns the updated page state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "browser_forward", []);
      const state = await options.session.forward(signal);
      return pageResult(state);
    },
  };
}

export function makeBrowserWaitTool(options: BrowserToolsOptions): KernelTool {
  return {
    name: "browser_wait",
    description:
      "Wait for an element matching a CSS selector to become visible before continuing. Useful for pages that load content after the initial load.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to wait for" },
        timeoutMs: {
          type: "integer",
          description: "Maximum time to wait in milliseconds (default 10000)",
        },
      },
      required: ["selector"],
      additionalProperties: false,
    },
    async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "browser_wait", ["selector", "timeoutMs"]);
      const selector = requiredString(input, "browser_wait", "selector");
      const timeoutMs = Math.min(
        optionalPositiveInteger(input, "browser_wait", "timeoutMs") ?? DEFAULT_WAIT_MS,
        MAX_WAIT_MS,
      );
      const state = await options.session.waitForSelector(selector, timeoutMs, signal);
      return pageResult(state);
    },
  };
}

export function makeBrowserEvalTool(options: BrowserToolsOptions): KernelTool {
  return {
    name: "browser_eval",
    description:
      "Evaluate a JavaScript expression in the current page and return its JSON-serializable result. Use for extracting structured data the other tools cannot reach.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "JavaScript expression to evaluate in the page",
        },
      },
      required: ["expression"],
      additionalProperties: false,
    },
    async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "browser_eval", ["expression"]);
      const expression = requiredString(input, "browser_eval", "expression");
      const result = await options.session.evaluate(expression, signal);
      let serialized: string;
      try {
        serialized = result === undefined ? "undefined" : JSON.stringify(result, null, 2);
      } catch {
        serialized = String(result);
      }
      if (serialized === undefined) serialized = "undefined";
      const truncated = serialized.length > MAX_EVAL_CHARACTERS;
      const shown = serialized.slice(0, MAX_EVAL_CHARACTERS);
      return {
        content: [
          {
            type: "text",
            text: `[browser eval result]\n${shown}${
              truncated ? `\n[truncated at ${MAX_EVAL_CHARACTERS} characters]` : ""
            }`,
          },
        ],
        isError: false,
        details: { truncated },
      };
    },
  };
}

export function makeBrowserSelectTool(options: BrowserToolsOptions): KernelTool {
  return {
    name: "browser_select",
    description: "Choose an option by its value in a <select> dropdown element.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the <select> element" },
        value: { type: "string", description: "Value of the option to select" },
      },
      required: ["selector", "value"],
      additionalProperties: false,
    },
    async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "browser_select", ["selector", "value"]);
      const selector = requiredString(input, "browser_select", "selector");
      const value = requiredString(input, "browser_select", "value");
      const state = await options.session.selectOption(selector, value, signal);
      return pageResult(state);
    },
  };
}

export function makeBrowserTools(options: BrowserToolsOptions): readonly KernelTool[] {
  return [
    makeBrowserNavigateTool(options),
    makeBrowserScreenshotTool(options),
    makeBrowserClickTool(options),
    makeBrowserTypeTool(options),
    makeBrowserScrollTool(options),
    makeBrowserReadTool(options),
    makeBrowserBackTool(options),
    makeBrowserForwardTool(options),
    makeBrowserWaitTool(options),
    makeBrowserEvalTool(options),
    makeBrowserSelectTool(options),
  ];
}
