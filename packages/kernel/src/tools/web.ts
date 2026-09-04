// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";

import type { JsonObject } from "@axl/protocol";

import type { KernelTool, ToolExecutionResult } from "../tools.ts";
import {
  optionalPositiveInteger,
  optionalString,
  rejectUnknownFields,
  requiredString,
  ToolInputError,
} from "./validate.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_CHARACTERS = 40_000;
const MAX_REDIRECTS = 5;

interface WebResponse {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

export type WebRequest = (
  url: string,
  options?: {
    readonly signal?: AbortSignal;
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
  },
) => Promise<WebResponse>;

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) return privateIpv4(address);
  const normalized = address.toLowerCase().split("%")[0] as string;
  if (normalized.startsWith("::ffff:")) return privateIpv4(normalized.slice(7));
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

async function resolvePublicAddress(hostname: string): Promise<{
  readonly address: string;
  readonly family: 4 | 6;
}> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new ToolInputError(`web: ${hostname} resolved to no addresses`);
  if (addresses.some((entry) => privateAddress(entry.address))) {
    throw new ToolInputError(`web: ${hostname} resolves to a private or reserved address`);
  }
  const selected = addresses[0] as { address: string; family: 4 | 6 };
  return selected;
}

function parsePublicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ToolInputError(`web: invalid URL ${JSON.stringify(input)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolInputError("web: URL must use http or https");
  }
  if (url.username || url.password)
    throw new ToolInputError("web: URL credentials are not allowed");
  return url;
}

async function requestOnce(
  url: URL,
  options: {
    readonly signal?: AbortSignal;
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxBytes: number;
  },
): Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}> {
  options.signal?.throwIfAborted();
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  const target = await resolvePublicAddress(hostname);
  return new Promise((resolvePromise, rejectPromise) => {
    const request = (url.protocol === "https:" ? requestHttps : requestHttp)(
      {
        protocol: url.protocol,
        hostname: target.address,
        family: target.family,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: isIP(hostname) === 0 ? hostname : undefined,
        headers: {
          accept:
            "text/html, text/plain, application/json, application/xml, text/xml;q=0.9, */*;q=0.1",
          "accept-encoding": "identity",
          "user-agent": "Axl/0.0 (+https://github.com/Observal/Axl)",
          host: url.host,
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > options.maxBytes) {
            response.destroy(new ToolInputError(`web: response exceeds ${options.maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.once("error", rejectPromise);
      },
    );
    const timeout = setTimeout(
      () =>
        request.destroy(new ToolInputError(`web: request timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
    timeout.unref();
    const onAbort = (): void => {
      request.destroy(options.signal?.reason as Error | undefined);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    request.once("close", () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    });
    request.once("error", rejectPromise);
    request.end();
  });
}

export const requestPublicUrl: WebRequest = async (input, options = {}) => {
  let url = parsePublicUrl(input);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await requestOnce(url, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (typeof location !== "string") throw new ToolInputError("web: redirect has no location");
      if (redirect === MAX_REDIRECTS) throw new ToolInputError("web: too many redirects");
      url = parsePublicUrl(new URL(location, url).toString());
      continue;
    }
    const contentType = String(response.headers["content-type"] ?? "application/octet-stream")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase() as string;
    return { url: url.toString(), status: response.status, contentType, body: response.body };
  }
  throw new ToolInputError("web: too many redirects");
};

function decodeEntities(text: string): string {
  const entities: Readonly<Record<string, string>> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&nbsp;": " ",
  };
  let output = "";
  for (let index = 0; index < text.length; ) {
    if (text[index] !== "&") {
      output += text[index];
      index += 1;
      continue;
    }
    const semicolon = text.indexOf(";", index + 1);
    const candidate =
      semicolon >= 0 && semicolon - index <= 6 ? text.slice(index, semicolon + 1) : undefined;
    const decoded = candidate === undefined ? undefined : entities[candidate];
    if (decoded === undefined) {
      output += "&";
      index += 1;
    } else {
      output += decoded;
      index = semicolon + 1;
    }
  }
  return output;
}

function readableHtml(html: string): string {
  let output = "";
  let index = 0;
  let skipped: string | undefined;
  const blocks = new Set([
    "article",
    "blockquote",
    "br",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "main",
    "p",
    "pre",
    "section",
    "table",
    "tr",
  ]);
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) {
      if (skipped === undefined) output += html.slice(index);
      break;
    }
    if (skipped === undefined) output += html.slice(index, open);
    const close = html.indexOf(">", open + 1);
    if (close < 0) break;
    const raw = html
      .slice(open + 1, close)
      .trim()
      .toLowerCase();
    const closing = raw.startsWith("/");
    const nameStart = closing ? 1 : 0;
    let nameEnd = nameStart;
    while (nameEnd < raw.length) {
      const code = raw.charCodeAt(nameEnd);
      if (!((code >= 97 && code <= 122) || (code >= 48 && code <= 57))) break;
      nameEnd += 1;
    }
    const name = raw.slice(nameStart, nameEnd);
    if (skipped !== undefined) {
      if (closing && name === skipped) skipped = undefined;
    } else if (!closing && ["script", "style", "noscript", "svg"].includes(name)) {
      skipped = name;
    } else if (blocks.has(name)) {
      output += "\n";
    }
    index = close + 1;
  }
  return decodeEntities(output)
    .split("\n")
    .map((line) => line.replaceAll("\t", " ").trim().split(" ").filter(Boolean).join(" "))
    .filter((line, position, lines) => line.length > 0 || lines[position - 1]?.length !== 0)
    .join("\n")
    .trim();
}

function textual(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType.endsWith("+json") ||
    contentType === "application/xml" ||
    contentType.endsWith("+xml")
  );
}

export function makeWebFetchTool(options: { readonly request?: WebRequest } = {}): KernelTool {
  const request = options.request ?? requestPublicUrl;
  return {
    name: "web_fetch",
    description:
      "Fetch a public HTTP or HTTPS page with private-network blocking and return readable text.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public HTTP or HTTPS URL" },
        mode: { type: "string", enum: ["readable", "raw"] },
        maxCharacters: { type: "integer", description: "Maximum returned characters" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "web_fetch", ["url", "mode", "maxCharacters"]);
      const url = requiredString(input, "web_fetch", "url");
      const mode = optionalString(input, "web_fetch", "mode") ?? "readable";
      if (mode !== "readable" && mode !== "raw") {
        throw new ToolInputError("web_fetch: mode must be readable or raw");
      }
      const maxCharacters = Math.min(
        optionalPositiveInteger(input, "web_fetch", "maxCharacters") ?? DEFAULT_MAX_CHARACTERS,
        100_000,
      );
      const parsed = parsePublicUrl(url);
      if (parsed.hostname === "github.com") {
        throw new ToolInputError("web_fetch: use bash and git for GitHub repositories");
      }
      const response = await request(parsed.toString(), { signal });
      if (response.status < 200 || response.status >= 300) {
        throw new ToolInputError(`web_fetch: ${response.url} returned HTTP ${response.status}`);
      }
      if (!textual(response.contentType)) {
        throw new ToolInputError(`web_fetch: unsupported content type ${response.contentType}`);
      }
      const decoded = response.body.toString("utf8");
      const content =
        mode === "readable" && response.contentType === "text/html"
          ? readableHtml(decoded)
          : decoded;
      const truncated = content.length > maxCharacters;
      const shown = content.slice(0, maxCharacters);
      return {
        content: [
          {
            type: "text",
            text: `[untrusted web content from ${response.url}]\n${shown}${
              truncated ? `\n[truncated at ${maxCharacters} characters]` : ""
            }`,
          },
        ],
        isError: false,
        details: {
          url: response.url,
          status: response.status,
          contentType: response.contentType,
          bytes: response.body.byteLength,
          truncated,
        },
      };
    },
  };
}

interface BraveSearchResult {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly description?: unknown;
}

interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly description?: string;
}

function duckDuckGoResults(payload: unknown): SearchResult[] {
  if (typeof payload !== "object" || payload === null) return [];
  const root = payload as Record<string, unknown>;
  const results: SearchResult[] = [];
  if (typeof root.AbstractURL === "string" && typeof root.Heading === "string") {
    results.push({
      title: root.Heading,
      url: root.AbstractURL,
      ...(typeof root.AbstractText === "string" ? { description: root.AbstractText } : {}),
    });
  }
  const visit = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const candidate = item as Record<string, unknown>;
      if (Array.isArray(candidate.Topics)) {
        visit(candidate.Topics);
      } else if (typeof candidate.FirstURL === "string" && typeof candidate.Text === "string") {
        results.push({
          title: candidate.Text.split(" - ", 1)[0] as string,
          url: candidate.FirstURL,
          description: candidate.Text,
        });
      }
    }
  };
  visit(root.Results);
  visit(root.RelatedTopics);
  return results;
}

export function makeWebSearchTool(options: {
  readonly apiKey?: string;
  readonly request?: WebRequest;
}): KernelTool {
  const request = options.request ?? requestPublicUrl;
  return {
    name: "web_search",
    description:
      "Search the public web and return result titles, URLs, and descriptions. Uses Brave when configured and keyless DuckDuckGo otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "integer", description: "Number of results from 1 to 10" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "web_search", ["query", "count"]);
      const query = requiredString(input, "web_search", "query");
      const count = Math.min(optionalPositiveInteger(input, "web_search", "count") ?? 5, 10);
      const provider = options.apiKey ? "brave" : "duckduckgo";
      const endpoint = new URL(
        options.apiKey
          ? "https://api.search.brave.com/res/v1/web/search"
          : "https://api.duckduckgo.com/",
      );
      endpoint.searchParams.set("q", query);
      if (options.apiKey) endpoint.searchParams.set("count", String(count));
      else {
        endpoint.searchParams.set("format", "json");
        endpoint.searchParams.set("no_html", "1");
        endpoint.searchParams.set("skip_disambig", "1");
      }
      const response = await request(endpoint.toString(), {
        signal,
        ...(options.apiKey === undefined
          ? { headers: { accept: "application/json" } }
          : {
              headers: {
                accept: "application/json",
                "x-subscription-token": options.apiKey,
              },
            }),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new ToolInputError(`web_search: provider returned HTTP ${response.status}`);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(response.body.toString("utf8"));
      } catch {
        throw new ToolInputError("web_search: provider returned invalid JSON");
      }
      const results: SearchResult[] =
        provider === "duckduckgo"
          ? duckDuckGoResults(payload)
          : typeof payload === "object" &&
              payload !== null &&
              typeof (payload as { web?: unknown }).web === "object" &&
              (payload as { web: { results?: unknown } }).web !== null &&
              Array.isArray((payload as { web: { results?: unknown } }).web.results)
            ? (payload as { web: { results: BraveSearchResult[] } }).web.results.flatMap(
                (result) =>
                  typeof result.title === "string" && typeof result.url === "string"
                    ? [
                        {
                          title: result.title,
                          url: result.url,
                          ...(typeof result.description === "string"
                            ? { description: result.description }
                            : {}),
                        },
                      ]
                    : [],
              )
            : [];
      const lines = results.slice(0, count).map((result, index) => {
        const description =
          typeof result.description === "string" ? `\n   ${readableHtml(result.description)}` : "";
        return `${index + 1}. ${readableHtml(result.title)}\n   ${result.url}${description}`;
      });
      return {
        content: [
          {
            type: "text",
            text: `[untrusted web search results from ${provider}]\n${
              lines.length > 0 ? lines.join("\n\n") : "No results."
            }`,
          },
        ],
        isError: false,
        details: { provider, query, resultCount: lines.length },
      };
    },
  };
}
