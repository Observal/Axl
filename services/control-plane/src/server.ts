// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import {
  encodeInternalConsumeRelayTicketResult,
  parseInternalConsumeRelayTicketRequest,
  ProtocolValidationError,
} from "@axl/protocol";

import { RelayTicketError, type AccountPrincipal, type RelayTicketService } from "./tickets.ts";

const MAX_REQUEST_BYTES = 4_096;

export interface PublicPrincipalAuthenticator {
  authenticate(request: IncomingMessage): Promise<AccountPrincipal | undefined>;
}

export interface InternalRelayAuthenticator {
  authenticate(request: IncomingMessage, exactBody: Uint8Array): Promise<boolean>;
}

export interface ControlPlaneHandlerOptions {
  readonly tickets: RelayTicketService;
  readonly publicAuthentication: PublicPrincipalAuthenticator;
  readonly internalAuthentication: InternalRelayAuthenticator;
}

class HttpRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
  }
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new HttpRequestError(413, "Request body is too large");
    chunks.push(bytes);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseJson(body: Uint8Array): unknown {
  if (body.byteLength === 0) throw new HttpRequestError(400, "Request body is required");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new HttpRequestError(400, "Request body must be valid UTF-8 JSON");
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": bytes.byteLength,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}

function respondError(response: ServerResponse, error: unknown): void {
  if (error instanceof RelayTicketError) {
    respond(response, error.httpStatus, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ProtocolValidationError) {
    respond(response, 400, {
      error: { code: "bad_request", message: "Request validation failed", path: error.path },
    });
    return;
  }
  if (error instanceof HttpRequestError) {
    respond(response, error.status, { error: { code: "bad_request", message: error.message } });
    return;
  }
  respond(response, 503, {
    error: { code: "service_unavailable", message: "Control plane is unavailable" },
  });
}

function requestPath(request: IncomingMessage): string | undefined {
  if (request.url === undefined) return undefined;
  const url = new URL(request.url, "http://control-plane.invalid");
  return url.search === "" ? url.pathname : undefined;
}

export function createControlPlaneHandler(options: ControlPlaneHandlerOptions): RequestListener {
  return (request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        respond(response, 405, { error: { code: "method_not_allowed" } });
        return;
      }
      const path = requestPath(request);
      if (path === "/v1/relay/tickets") {
        const principal = await options.publicAuthentication.authenticate(request);
        if (principal === undefined) {
          respond(response, 401, { error: { code: "unauthorized" } });
          return;
        }
        const result = await options.tickets.issue(principal, parseJson(await readBody(request)));
        respond(response, 201, result);
        return;
      }
      if (path === "/internal/v1/relay/tickets/consume") {
        const body = await readBody(request);
        if (!(await options.internalAuthentication.authenticate(request, body))) {
          respond(response, 401, { error: { code: "unauthorized" } });
          return;
        }
        const result = await options.tickets.consume(
          parseInternalConsumeRelayTicketRequest(parseJson(body)),
        );
        respond(response, 200, encodeInternalConsumeRelayTicketResult(result));
        return;
      }
      respond(response, 404, { error: { code: "not_found" } });
    })().catch((error: unknown) => respondError(response, error));
  };
}
