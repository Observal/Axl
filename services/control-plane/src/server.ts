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
  parseIssueRelayTicketRequest,
  parsePublishPairingClaimRequest,
  parsePublishPairingLinkRequest,
  parsePublishPairingWelcomeRequest,
  parseRemoteDeviceEnrollmentRequest,
  parseRemoteDeviceInvitationRequest,
  parseRemoteDeviceRevocationRequest,
  parseRemoteInstallationRegistrationRequest,
  parseReservePairingClaimRequest,
  REMOTE_DEVICE_ENROLLMENT_PATH,
  REMOTE_DEVICE_INVITATION_PATH,
  REMOTE_DEVICE_REVOCATION_PATH,
  REMOTE_INSTALLATION_REGISTRATION_PATH,
  WITNESS_HTTP_CONTENT_TYPE,
  WITNESS_HTTP_PATH,
  WITNESS_REQUEST_MAX_BYTES,
} from "@axl/protocol";

import { RemoteDeviceError, type RemoteDeviceService } from "./devices.ts";
import type { RemoteInstallationService } from "./installations.ts";
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
  readonly installations?: RemoteInstallationService;
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
      error:
        error.message === "" ? { code: error.code } : { code: error.code, message: error.message },
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

/** Read a JSON body and parse it, answering 400 rather than 503 when it is malformed. */
async function readRequest<T>(
  request: IncomingMessage,
  parse: (value: unknown) => T,
  maximumBytes?: number,
): Promise<T> {
  const value = parseJson(await readBody(request, maximumBytes));
  try {
    return parse(value);
  } catch (cause) {
    if (cause instanceof TypeError) throw new HttpRequestError(400, "Request validation failed");
    throw cause;
  }
}

/** For a service that parses its own input: check the body first, then hand it over unchanged. */
function checked(parse: (value: unknown) => unknown): (value: unknown) => unknown {
  return (value) => {
    parse(value);
    return value;
  };
}

const ACCEPTED = { version: 1, accepted: true } as const;

/** A route that acts for a signed-in principal, answering with a status and a JSON body. */
type PrincipalRoute = (
  principal: AccountPrincipal,
  request: IncomingMessage,
) => Promise<readonly [status: number, body?: unknown]>;

function requestPath(request: IncomingMessage): string | undefined {
  if (request.url === undefined) return undefined;
  const url = new URL(request.url, "http://control-plane.invalid");
  return url.search === "" ? url.pathname : undefined;
}

export function createControlPlaneHandler(options: ControlPlaneHandlerOptions): RequestListener {
  /** The caller's principal: 401 without one, 403 for a phone sign-in off the phone routes. */
  const principalFor = async (
    request: IncomingMessage,
    path: string,
  ): Promise<AccountPrincipal> => {
    const principal = await options.publicAuthentication.authenticate(request);
    if (principal === undefined) throw new HttpRequestError(401, "", "unauthorized");
    if (principal.scope === "phone" && !PHONE_PATHS.has(path)) {
      throw new HttpRequestError(403, "A phone sign-in cannot call this route", "scope_forbidden");
    }
    return principal;
  };
  const { tickets, pairing, pairingLinks, devices, installations } = options;
  const routes = new Map<string, PrincipalRoute>([
    [
      "/v1/relay/tickets",
      async (principal, request) => [
        201,
        await tickets.issue(
          principal,
          await readRequest(request, checked(parseIssueRelayTicketRequest)),
        ),
      ],
    ],
  ]);
  if (pairing !== undefined) {
    routes.set("/v1/e2ee/pairing/claims", async (principal, request) => {
      const claim = await readRequest(request, parsePublishPairingClaimRequest, 24 * 1024);
      await pairing.publishClaim(principal, claim);
      return [201, ACCEPTED];
    });
    routes.set("/v1/e2ee/pairing/claims/reserve", async (principal, request) => {
      const binding = await readRequest(request, parseReservePairingClaimRequest);
      return [200, encodePairingReservation(await pairing.reserveClaim(principal, binding))];
    });
    routes.set("/v1/e2ee/pairing/welcomes", async (principal, request) => {
      const welcome = await readRequest(request, parsePublishPairingWelcomeRequest, 24 * 1024);
      return [
        201,
        encodePairingWelcomePublication(await pairing.publishWelcome(principal, welcome)),
      ];
    });
    routes.set("/v1/e2ee/pairing/welcomes/fetch", async (principal, request) => {
      const binding = await readRequest(request, parseFetchPairingWelcomeRequest);
      return [200, encodePairingWelcomePublication(await pairing.fetchWelcome(principal, binding))];
    });
    routes.set("/v1/e2ee/pairing/welcomes/acknowledge", async (principal, request) => {
      const binding = await readRequest(request, parseAcknowledgePairingWelcomeRequest);
      await pairing.acknowledgeWelcome(principal, binding);
      return [204];
    });
  }
  if (pairingLinks !== undefined) {
    routes.set(PAIRING_LINK_PUBLISH_PATH, async (principal, request) => {
      const link = await readRequest(request, parsePublishPairingLinkRequest, 8 * 1024);
      await pairingLinks.publish(principal, link);
      return [201, ACCEPTED];
    });
  }
  if (installations !== undefined) {
    routes.set(REMOTE_INSTALLATION_REGISTRATION_PATH, async (principal, request) => {
      const body = await readRequest(request, checked(parseRemoteInstallationRegistrationRequest));
      await installations.register(principal, body);
      return [201, ACCEPTED];
    });
  }
  if (devices !== undefined) {
    for (const [path, parse, action] of [
      [REMOTE_DEVICE_INVITATION_PATH, parseRemoteDeviceInvitationRequest, devices.invite],
      [REMOTE_DEVICE_ENROLLMENT_PATH, parseRemoteDeviceEnrollmentRequest, devices.enroll],
      [REMOTE_DEVICE_REVOCATION_PATH, parseRemoteDeviceRevocationRequest, devices.revoke],
    ] as const) {
      routes.set(path, async (principal, request) => {
        await action.call(devices, principal, await readRequest(request, checked(parse)));
        return [200, ACCEPTED];
      });
    }
  }
  return (request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        respond(response, 405, { error: { code: "method_not_allowed" } });
        return;
      }
      const path = requestPath(request);
      const route = path === undefined ? undefined : routes.get(path);
      if (route !== undefined && path !== undefined) {
        const [status, body] = await route(await principalFor(request, path), request);
        if (body === undefined) {
          response.writeHead(status, { "cache-control": "no-store" });
          response.end();
        } else {
          respond(response, status, body);
        }
        return;
      }
      if (path === PAIRING_LINK_FETCH_PATH && pairingLinks !== undefined) {
        // The phone opening a short link has no credential yet; see pairing-links.ts.
        const link = await readRequest(request, parseFetchPairingLinkRequest);
        respond(response, 200, encodePairingLinkPublication(await pairingLinks.fetch(link)));
        return;
      }
      if (path === WITNESS_HTTP_PATH && options.witness !== undefined) {
        const principal = await principalFor(request, path);
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
        const result = await tickets.consume(
          parseInternalConsumeRelayTicketRequest(parseJson(body)),
        );
        respond(response, 200, encodeInternalConsumeRelayTicketResult(result));
        return;
      }
      respond(response, 404, { error: { code: "not_found" } });
    })().catch((error: unknown) => respondError(response, error));
  };
}
