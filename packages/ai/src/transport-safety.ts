// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

import { currentProviderHooks } from "./provider-hooks.ts";

export const MAX_ENDPOINT_LENGTH = 4_096;
export const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;

export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function normalizedHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

export function isLoopback(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  if (isIP(host) !== 4) return false;
  return Number(host.split(".")[0]) === 127;
}

export function isDisallowedIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const octets = hostname.split(".").map(Number);
  const [a = 0, b = 0, c = 0] = octets;
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
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export function isDisallowedIpv6(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  if (isIP(host) !== 6) return false;
  if (host === "::" || host === "::1" || host.startsWith("ff")) return true;
  if (host.startsWith("::ffff:")) return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(host)) return true;
  if (host.startsWith("2001:db8:")) return true;
  const hextets = host.split(":");
  if (hextets[0] === "2001" && Number.parseInt(hextets[1] ?? "0", 16) < 0x200) return true;
  return !/^[23][0-9a-f]{3}:/.test(host);
}

export interface EndpointPolicyOptions {
  readonly label: string;
  readonly allowLoopbackHttp?: boolean;
  readonly allowQuery?: boolean;
  readonly expectedOrigin?: string;
}

/** Validates and normalizes an endpoint before credentials or prompts can reach it. */
export function safeEndpoint(value: string, options: EndpointPolicyOptions): string {
  if (value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) {
    throw new TypeError(`${options.label} has an invalid length`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${options.label} is not a valid URL`);
  }
  if (url.username || url.password || (url.search && options.allowQuery !== true) || url.hash) {
    throw new TypeError(`${options.label} must not contain credentials, a query, or a fragment`);
  }
  const loopback = isLoopback(url.hostname);
  if (url.protocol !== "https:" && !(options.allowLoopbackHttp === true && loopback)) {
    throw new TypeError(`${options.label} must use HTTPS, except for explicit loopback HTTP`);
  }
  const hostname = normalizedHostname(url.hostname);
  if (
    (loopback && options.allowLoopbackHttp !== true) ||
    (!loopback && (isDisallowedIpv4(hostname) || isDisallowedIpv6(hostname))) ||
    hostname.endsWith(".local")
  ) {
    throw new TypeError(`${options.label} resolves to a disallowed destination`);
  }
  if (options.expectedOrigin !== undefined) {
    const expected = safeEndpoint(options.expectedOrigin, {
      label: `${options.label} source`,
      ...(options.allowLoopbackHttp === undefined
        ? {}
        : { allowLoopbackHttp: options.allowLoopbackHttp }),
    });
    if (url.origin !== new URL(expected).origin) {
      throw new TypeError(`${options.label} changed to an unapproved origin`);
    }
  }
  return stripTrailingSlashes(url.toString());
}

export interface SafeFetchOptions extends EndpointPolicyOptions {
  readonly fetch?: typeof fetch;
  readonly maximumRedirects?: number;
  readonly idleTimeoutMs?: number;
  readonly resolve?: (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;
}

function allowedAddress(address: string, allowLoopbackHttp: boolean): boolean {
  if (isLoopback(address)) return allowLoopbackHttp;
  return !isDisallowedIpv4(address) && !isDisallowedIpv6(address);
}

async function validatedAddresses(
  url: URL,
  options: SafeFetchOptions,
): Promise<readonly { address: string; family: 4 | 6 }[]> {
  const literalFamily = isIP(url.hostname.replace(/^\[|\]$/g, ""));
  const addresses =
    literalFamily === 0
      ? options.fetch !== undefined && options.resolve === undefined
        ? [{ address: "8.8.8.8", family: 4 as const }]
        : await (
            options.resolve ??
            (async (hostname) =>
              (await lookup(hostname, { all: true, verbatim: true })).map((entry) => ({
                address: entry.address,
                family: entry.family as 4 | 6,
              })))
          )(url.hostname)
      : [{ address: url.hostname.replace(/^\[|\]$/g, ""), family: literalFamily as 4 | 6 }];
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !allowedAddress(address, options.allowLoopbackHttp === true))
  ) {
    throw new TypeError(`${options.label} resolves to a disallowed destination`);
  }
  return addresses;
}

function responseWithAgent(response: Response, agent: Agent): Response {
  if (response.body === null) {
    void agent.close();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await agent.close();
        } else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
        await agent.close();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await agent.close();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Resolves and pins each destination, and validates every bounded redirect before dispatch. */
export async function safeFetch(
  input: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions,
): Promise<Response> {
  const maximumRedirects = options.maximumRedirects ?? 3;
  let url = new URL(
    safeEndpoint(String(input), {
      label: options.label,
      ...(options.allowLoopbackHttp === undefined
        ? {}
        : { allowLoopbackHttp: options.allowLoopbackHttp }),
      allowQuery: true,
      ...(options.expectedOrigin === undefined ? {} : { expectedOrigin: options.expectedOrigin }),
    }),
  );
  const approvedOrigin = options.expectedOrigin ?? url.origin;
  for (let redirects = 0; ; redirects += 1) {
    if (redirects > maximumRedirects)
      throw new TypeError(`${options.label} redirected too many times`);
    const addresses = await validatedAddresses(url, options);
    const pinned = addresses[0];
    if (pinned === undefined) throw new TypeError(`${options.label} has no approved destination`);
    const hooks = currentProviderHooks();
    const signal = init.signal ?? new AbortController().signal;
    let requestInit = { ...init, redirect: "manual" as const };
    if (hooks?.beforeHeaders !== undefined) {
      const headers = await hooks.beforeHeaders(
        { url: url.href, headers: Object.fromEntries(new Headers(requestInit.headers).entries()) },
        signal,
      );
      requestInit = { ...requestInit, headers };
    }
    if (hooks?.beforeRequest !== undefined && typeof requestInit.body === "string") {
      try {
        const payload = JSON.parse(requestInit.body) as unknown;
        requestInit = {
          ...requestInit,
          body: JSON.stringify(await hooks.beforeRequest({ url: url.href, payload }, signal)),
        };
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new TypeError(`${options.label} request body is not valid JSON`, { cause: error });
        }
        throw error;
      }
    }
    let response: Response;
    if (options.fetch !== undefined) {
      response = await options.fetch(url, requestInit);
    } else {
      const agent = new Agent({
        ...(options.idleTimeoutMs === undefined
          ? {}
          : { headersTimeout: options.idleTimeoutMs, bodyTimeout: options.idleTimeoutMs }),
        connect: {
          lookup: (_hostname, lookupOptions, callback) =>
            lookupOptions.all
              ? callback(null, [pinned])
              : callback(null, pinned.address, pinned.family),
        },
      });
      try {
        response = responseWithAgent(
          (await undiciFetch(url, {
            ...requestInit,
            dispatcher: agent,
          } as unknown as Parameters<typeof undiciFetch>[1])) as unknown as Response,
          agent,
        );
      } catch (error) {
        await agent.close();
        throw error;
      }
    }
    await hooks?.afterResponse?.(
      {
        url: url.href,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      },
      signal,
    );
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (location === null)
      throw new TypeError(`${options.label} returned a redirect without a location`);
    url = new URL(
      safeEndpoint(new URL(location, url).toString(), {
        label: `${options.label} redirect`,
        ...(options.allowLoopbackHttp === undefined
          ? {}
          : { allowLoopbackHttp: options.allowLoopbackHttp }),
        allowQuery: true,
        expectedOrigin: approvedOrigin,
      }),
    );
  }
}

export function delayWithSignal(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function raceWithSignal<Result>(
  operation: Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export async function readBoundedBody(
  response: Pick<Response, "body" | "headers">,
  maximumBytes = MAX_JSON_RESPONSE_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new TypeError(`Provider response exceeds ${maximumBytes} bytes`);
  }
  if (response.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const result =
        signal === undefined ? await reader.read() : await raceWithSignal(reader.read(), signal);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes)
        throw new TypeError(`Provider response exceeds ${maximumBytes} bytes`);
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedJson(
  response: Pick<Response, "body" | "headers">,
  maximumBytes = MAX_JSON_RESPONSE_BYTES,
  signal?: AbortSignal,
): Promise<unknown> {
  const bytes = await readBoundedBody(response, maximumBytes, signal);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw new TypeError("Provider response is not valid bounded JSON", { cause });
  }
}
