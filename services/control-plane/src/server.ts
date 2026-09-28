// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import {
  encodeInternalConsumeRelayTicketResult,
  encodePairingLinkPublication,
  encodePairingReservation,
  encodePairingWelcomePublication,
  PAIRING_LINK_FETCH_PATH,
  PAIRING_LINK_PUBLISH_PATH,
  ProtocolValidationError,
  parseAcknowledgePairingWelcomeRequest,
  parseFetchPairingLinkRequest,
  parseFetchPairingWelcomeRequest,
  parseInternalConsumeRelayTicketRequest,
  parsePublishPairingClaimRequest,
  parsePublishPairingLinkRequest,
  parsePublishPairingWelcomeRequest,
  parseReservePairingClaimRequest,
  REMOTE_DEVICE_ENROLLMENT_PATH,
  REMOTE_DEVICE_INVITATION_PATH,
  REMOTE_DEVICE_REVOCATION_PATH,
  WITNESS_HTTP_CONTENT_TYPE,
  WITNESS_HTTP_PATH,
  WITNESS_REQUEST_MAX_BYTES,
} from "@axl/protocol";

import { RemoteDeviceError, type RemoteDeviceService } from "./devices.ts";
import { PairingRendezvousError, type PairingRendezvousService } from "./pairing.ts";
import type { PairingLinkService } from "./pairing-links.ts";
import { type AccountPrincipal, RelayTicketError, type RelayTicketService } from "./tickets.ts";
import { type WitnessGateway, WitnessServiceError } from "./witness.ts";

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
  readonly witness?: WitnessGateway;
  readonly pairing?: PairingRendezvousService;
  readonly pairingLinks?: PairingLinkService;
  readonly devices?: RemoteDeviceService;
}

class HttpRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = "bad_request") {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
    this.code = code;
  }
}

/** The routes a phone sign-in may call: pairing and running a device, nothing the daemon does. */
const PHONE_PATHS: ReadonlySet<string> = new Set([
  "/v1/relay/tickets",
  "/v1/e2ee/pairing/claims",
  "/v1/e2ee/pairing/welcomes/fetch",
  "/v1/e2ee/pairing/welcomes/acknowledge",
  REMOTE_DEVICE_ENROLLMENT_PATH,
  WITNESS_HTTP_PATH,
]);

async function readBody(
  request: IncomingMessage,
  maximumBytes = MAX_REQUEST_BYTES,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > maximumBytes) throw new HttpRequestError(413, "Request body is too large");
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
  if (error instanceof RemoteDeviceError) {
    respond(response, error.httpStatus, {
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof PairingRendezvousError) {
    respond(response, error.httpStatus, {
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof WitnessServiceError) {
    respond(response, error.httpStatus, {
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof RelayTicketError) {
    respond(response, error.httpStatus, {
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof ProtocolValidationError) {
    respond(response, 400, {
      error: {
        code: "bad_request",
        message: "Request validation failed",
        path: error.path,
      },
    });
    return;
  }
  if (error instanceof HttpRequestError) {
    respond(response, error.status, {
      error: { code: error.code, message: error.message },
    });
    return;
  }
  respond(response, 503, {
    error: {
      code: "service_unavailable",
      message: "Control plane is unavailable",
    },
  });
}

/** Parse a request body, answering 400 rather than 503 when it is malformed. */
function parseRequest<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch (cause) {
    if (cause instanceof TypeError) throw new HttpRequestError(400, "Request validation failed");
    throw cause;
  }
}

function requestPath(request: IncomingMessage): string | undefined {
  if (request.url === undefined) return undefined;
  const url = new URL(request.url, "http://control-plane.invalid");
  return url.search === "" ? url.pathname : undefined;
}

export function createControlPlaneHandler(options: ControlPlaneHandlerOptions): RequestListener {
  const authenticate = async (
    request: IncomingMessage,
    path: string,
  ): Promise<AccountPrincipal | undefined> => {
    const principal = await options.publicAuthentication.authenticate(request);
    if (principal?.scope === "phone" && !PHONE_PATHS.has(path)) {
      throw new HttpRequestError(403, "A phone sign-in cannot call this route", "scope_forbidden");
    }
    return principal;
  };
  return (request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        respond(response, 405, { error: { code: "method_not_allowed" } });
        return;
      }
      const path = requestPath(request);
      if (path === "/v1/relay/tickets") {
        const principal = await authenticate(request, path);
        if (principal === undefined) {
          respond(response, 401, { error: { code: "unauthorized" } });
          return;
        }
        const result = await options.tickets.issue(principal, parseJson(await readBody(request)));
        respond(response, 201, result);
        return;
      }
      if (path === "/v1/e2ee/pairing/claims" && options.pairing !== undefined) {
        const principal = await authenticate(request, path);
        if (principal === undefined) {
          respond(response, 401, { error: { code: "unauthorized" } });
          return;
        }
        await options.pairing.publishClaim(
          principal,
          parsePublishPairingClaimRequest(parseJson(await readBody(request, 24 * 1024))),
        );
        respond(response, 201, { version: 1, accepted: true });
        return;
      }
      if (path === "/v1/e2ee/pairing/claims/reserve" && options.pairing !== undefined) {
        const principal = await authenticate(request, path);
        if (principal === undefined) {
          respond(response, 401, { error: { code: "unauthorized" } });
          return;
        }
        const result = await options.pairing.reserveClaim(
          principal,
          parseReservePairingClaimRequest(parseJson(await readBody(request))),
        );
        respond(response, 200, encodePairingReservation(result));
        return;
      }
      if (path === "/v1/e2ee/pairing/welcomes" && options.pairing !== undefined) {
        const principal = await authenticate(request, path);
        if (principal === undefined) {
          respond(response, 401, { error: { code: "unauthorized" } });
          return;
        }
        const result = await options.pairing.publishWelcome(
          principal,
          parsePublishPairingWelcomeRequest(parseJson(await readBody(request, 24 * 1024))),
        );
        respond(response, 201, encodePairingWelcomePublication(result));
        return;
      }
      if (path === "/v1/e2ee/pairing/welcomes/fetch" && options.pairing !== undefined) {
        const principal = await authenticate(request, path);
        if (principal === undefined) {
          respond(response, 401, { error: { code: "unauthorized" } });
          return;
        }
        const result = await options.pairing.fetchWelcome(
          principal,
          parseFetchPairingWelcomeRequest(parseJson(await readBody(request))),
        );
        respond(response, 200, encodePairingWelcomePublication(result));
        return;
      }
      if (path === "/v1/e2ee/pairing/welcomes/acknowledge" && options.pairing !== undefined) {
        const principal = await authenticate(request, path);
        if (principal === undefined) {
          respond(response, 401, { error: { code: "unauthorized" } });
          return;
        }
        await options.pairing.acknowledgeWelcome(
          principal,
          parseAcknowledgePairingWelcomeRequest(parseJson(await readBody(request))),
        );
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (path === PAIRING_LINK_PUBLISH_PATH && options.pairingLinks !== undefined) {
        const principal = await authenticate(request, path);
        if (principal === undefined) {
          respond(response, 401, { error: { code: "unauthorized" } });
          return;
        }
        await options.pairingLinks.publish(
          principal,
          parseRequest(
            parsePublishPairingLinkRequest,
            parseJson(await readBody(request, 8 * 1024)),
          ),
        );
        respond(response, 201, { version: 1, accepted: true });
        return;
      }
      if (path === PAIRING_LINK_FETCH_PATH && options.pairingLinks !== undefined) {
        // The phone opening a short link has no credential yet; see pairing-links.ts.
        const result = await options.pairingLinks.fetch(
          parseRequest(parseFetchPairingLinkRequest, parseJson(await readBody(request))),
        );
        respond(response, 200, encodePairingLinkPublication(result));
        return;
      }
      const devices = options.devices;
      const deviceAction =
        devices === undefined
          ? undefined
          : path === REMOTE_DEVICE_INVITATION_PATH
            ? devices.invite.bind(devices)
            : path === REMOTE_DEVICE_ENROLLMENT_PATH
              ? devices.enroll.bind(devices)
              : path === REMOTE_DEVICE_REVOCATION_PATH
                ? devices.revoke.bind(devices)
                : undefined;
      if (deviceAction !== undefined && path !== undefined) {
        const principal = await authenticate(request, path);
        if (principal === undefined) {
          respond(response, 401, { error: { code: "unauthorized" } });
          return;
        }
        await deviceAction(principal, parseJson(await readBody(request)));
        respond(response, 200, { version: 1, accepted: true });
        return;
      }
      if (path === WITNESS_HTTP_PATH && options.witness !== undefined) {
        const principal = await authenticate(request, path);
        if (principal === undefined) {
          respond(response, 401, { error: { code: "unauthorized" } });
          return;
        }
        if (request.headers["content-type"] !== WITNESS_HTTP_CONTENT_TYPE) {
          throw new HttpRequestError(415, "Witness request has an unsupported content type");
        }
        const certificate = await options.witness.submit(
          principal,
          await readBody(request, WITNESS_REQUEST_MAX_BYTES),
        );
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-length": certificate.byteLength,
          "content-type": WITNESS_HTTP_CONTENT_TYPE,
          "x-content-type-options": "nosniff",
        });
        response.end(certificate);
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
