// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { ProtocolValidationError } from "./event-envelope.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const methodPattern = /^[a-z][a-z0-9]*(?:[._-][a-zA-Z0-9]+)*$/;
const frameMagic = Uint8Array.of(0x41, 0x58, 0x4c, 0x52);
const routedFrameHeaderBytes = 38;
const shortFrameBytes = 23;

declare const installationIdBrand: unique symbol;
declare const deviceIdBrand: unique symbol;
declare const cryptoSessionIdBrand: unique symbol;
declare const axlSessionIdBrand: unique symbol;
declare const routeIdBrand: unique symbol;
declare const transportAttemptIdBrand: unique symbol;
declare const envelopeIdBrand: unique symbol;
declare const requestIdBrand: unique symbol;
declare const idempotencyKeyBrand: unique symbol;
declare const objectIdBrand: unique symbol;

type Nominal<Brand extends symbol> = string & { readonly [Key in Brand]: true };

export type InstallationId = Nominal<typeof installationIdBrand>;
export type DeviceId = Nominal<typeof deviceIdBrand>;
export type CryptoSessionId = Nominal<typeof cryptoSessionIdBrand>;
export type AxlSessionId = Nominal<typeof axlSessionIdBrand>;
export type RouteId = Nominal<typeof routeIdBrand>;
export type TransportAttemptId = Nominal<typeof transportAttemptIdBrand>;
export type EnvelopeId = Nominal<typeof envelopeIdBrand>;
export type RequestId = Nominal<typeof requestIdBrand>;
export type IdempotencyKey = Nominal<typeof idempotencyKeyBrand>;
export type ObjectId = Nominal<typeof objectIdBrand>;

export const REMOTE_TRANSPORT_VERSION = 1 as const;
export const INTERNAL_RELAY_API_VERSION = 1 as const;
export const MAX_RELAY_FRAME_BYTES = 65_535;
export const MAX_RELAY_QUEUED_BYTES = 512 * 1024;
export const RELAY_HEARTBEAT_INTERVAL_MS = 20_000;
export const RELAY_IDLE_TIMEOUT_MS = 60_000;
export const RELAY_TICKET_LIFETIME_MS = 60_000;
export const MAX_RELAY_OPAQUE_PAYLOAD_BYTES = MAX_RELAY_FRAME_BYTES - routedFrameHeaderBytes;

export interface RelayLimits {
  readonly maxFrameBytes: number;
  readonly maxQueuedBytes: number;
  readonly heartbeatIntervalMs: number;
  readonly idleTimeoutMs: number;
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = Object.freeze({
  maxFrameBytes: MAX_RELAY_FRAME_BYTES,
  maxQueuedBytes: MAX_RELAY_QUEUED_BYTES,
  heartbeatIntervalMs: RELAY_HEARTBEAT_INTERVAL_MS,
  idleTimeoutMs: RELAY_IDLE_TIMEOUT_MS,
});

export interface IssueRelayTicketRequest {
  readonly installationId: InstallationId;
  readonly deviceId?: DeviceId;
  readonly role: "daemon" | "device";
}

export interface IssueRelayTicketResult {
  readonly ticket: string;
  readonly relayUrl: string;
  readonly expiresAt: number;
  readonly proofSchemeVersion: number;
  readonly limits: RelayLimits;
}

export interface ConsumeRelayTicketRequest {
  readonly ticket: string;
  readonly relayInstanceId: string;
  readonly connectionNonce: string;
  readonly possessionProof: Uint8Array;
}

export interface ConsumeRelayTicketResult {
  readonly installationId: InstallationId;
  readonly deviceId?: DeviceId;
  readonly sourceRouteId: RouteId;
  readonly role: "daemon" | "device";
  readonly grantGeneration: number;
  readonly leaseExpiresAt: number;
  readonly limits: RelayLimits;
}

export interface RelaySendFrame {
  readonly transportVersion: typeof REMOTE_TRANSPORT_VERSION;
  readonly attemptId: TransportAttemptId;
  readonly destinationRouteId: RouteId;
  readonly opaquePayload: Uint8Array;
}

export interface RelayDelivery {
  readonly transportVersion: typeof REMOTE_TRANSPORT_VERSION;
  readonly attemptId: TransportAttemptId;
  readonly sourceRouteId: RouteId;
  readonly opaquePayload: Uint8Array;
}

export type RelayReceiptStatus = "admitted" | "forwarded";

export interface RelayReceipt {
  readonly transportVersion: typeof REMOTE_TRANSPORT_VERSION;
  readonly attemptId: TransportAttemptId;
  readonly status: RelayReceiptStatus;
}

export const RELAY_FAILURE_CODE_VALUES = Object.freeze({
  bad_frame: 1,
  unsupported_transport_version: 2,
  unauthorized: 3,
  forbidden_route: 4,
  ticket_expired: 5,
  ticket_consumed: 6,
  destination_offline: 7,
  rate_limited: 8,
  queue_full: 9,
  slow_consumer: 10,
  service_unavailable: 11,
  ticket_revoked: 12,
} as const);

export type RelayFailureCode = keyof typeof RELAY_FAILURE_CODE_VALUES;
export const RELAY_FAILURE_CODES = Object.freeze(
  Object.keys(RELAY_FAILURE_CODE_VALUES) as RelayFailureCode[],
);

export interface RelayFailure {
  readonly transportVersion: typeof REMOTE_TRANSPORT_VERSION;
  readonly attemptId: TransportAttemptId;
  readonly code: RelayFailureCode;
}

export type RelayBinaryFrame = RelaySendFrame | RelayDelivery | RelayReceipt | RelayFailure;

export const REMOTE_DEVICE_SCOPES = [
  "observe",
  "steer",
  "approve_within_policy",
  "manage_sessions",
] as const;

export type RemoteDeviceScope = (typeof REMOTE_DEVICE_SCOPES)[number];

export interface AuthenticatedRemoteRequest {
  readonly deviceId: DeviceId;
  readonly requestId: RequestId;
  readonly idempotencyKey?: IdempotencyKey;
  readonly method: string;
  readonly params: unknown;
}

export type RemoteDeliveryState =
  | "queued_local"
  | "sending"
  | "relay_admitted"
  | "relay_forwarded"
  | "daemon_accepted"
  | "operation_running"
  | "completed"
  | "failed";

export interface OpaqueOutboxRecord {
  readonly requestId: RequestId;
  readonly idempotencyKey: IdempotencyKey;
  readonly destinationRouteId: RouteId;
  readonly opaqueEnvelope: Uint8Array;
  readonly createdAt: number;
  readonly state: "queued_local" | "sending" | "daemon_accepted";
}

export interface RelayPeerRoute {
  readonly routeId: RouteId;
  readonly role: "daemon" | "device";
  readonly deviceId?: DeviceId;
}

export interface RelayDiscoveryMessage {
  readonly version: typeof REMOTE_TRANSPORT_VERSION;
  readonly type: "route_snapshot" | "route_available" | "route_unavailable";
  readonly sourceRoute?: RelayPeerRoute;
  readonly peers: readonly RelayPeerRoute[];
}

export interface RelayRevocationNotification {
  readonly version: typeof INTERNAL_RELAY_API_VERSION;
  readonly installationId: InstallationId;
  readonly deviceId?: DeviceId;
  readonly generation: number;
  readonly effectiveAt: number;
}

export interface RelayRevocationResult {
  readonly version: typeof INTERNAL_RELAY_API_VERSION;
  readonly accepted: true;
}

export type InternalConsumeRelayTicketWireRequest = Omit<
  ConsumeRelayTicketRequest,
  "possessionProof"
> & {
  readonly version: typeof INTERNAL_RELAY_API_VERSION;
  readonly possessionProof: string;
};

export type InternalConsumeRelayTicketWireResult = ConsumeRelayTicketResult & {
  readonly version: typeof INTERNAL_RELAY_API_VERSION;
};

function fail(path: string, message: string): never {
  throw new ProtocolValidationError(path, message);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "must be a plain object");
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, "is unknown");
  for (const key of required) if (!(key in value)) fail(`${path}.${key}`, "is required");
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    fail(path, `must be a non-empty string no longer than ${maximum} characters`);
  }
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function timestamp(value: unknown, path: string): number {
  return integer(value, path, 0, Number.MAX_SAFE_INTEGER);
}

function role(value: unknown, path: string): "daemon" | "device" {
  if (value !== "daemon" && value !== "device") fail(path, "must be daemon or device");
  return value;
}

function uuid<Brand extends symbol>(value: unknown, path: string): Nominal<Brand> {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    fail(path, "must be a lowercase RFC 9562 UUID");
  }
  return value as Nominal<Brand>;
}

export function parseInstallationId(value: unknown, path = "installationId"): InstallationId {
  return uuid<typeof installationIdBrand>(value, path);
}

export function parseDeviceId(value: unknown, path = "deviceId"): DeviceId {
  return uuid<typeof deviceIdBrand>(value, path);
}

export function parseCryptoSessionId(value: unknown, path = "cryptoSessionId"): CryptoSessionId {
  return uuid<typeof cryptoSessionIdBrand>(value, path);
}

export function parseAxlSessionId(value: unknown, path = "axlSessionId"): AxlSessionId {
  return uuid<typeof axlSessionIdBrand>(value, path);
}

export function parseRouteId(value: unknown, path = "routeId"): RouteId {
  return uuid<typeof routeIdBrand>(value, path);
}

export function parseTransportAttemptId(value: unknown, path = "attemptId"): TransportAttemptId {
  return uuid<typeof transportAttemptIdBrand>(value, path);
}

export function parseEnvelopeId(value: unknown, path = "envelopeId"): EnvelopeId {
  return uuid<typeof envelopeIdBrand>(value, path);
}

export function parseRemoteRequestId(value: unknown, path = "requestId"): RequestId {
  return uuid<typeof requestIdBrand>(value, path);
}

export function parseIdempotencyKey(value: unknown, path = "idempotencyKey"): IdempotencyKey {
  return uuid<typeof idempotencyKeyBrand>(value, path);
}

export function parseObjectId(value: unknown, path = "objectId"): ObjectId {
  return uuid<typeof objectIdBrand>(value, path);
}

export function parseRelayLimits(value: unknown, path = "limits"): RelayLimits {
  const candidate = object(value, path);
  exact(candidate, path, [
    "maxFrameBytes",
    "maxQueuedBytes",
    "heartbeatIntervalMs",
    "idleTimeoutMs",
  ]);
  return {
    maxFrameBytes: integer(
      candidate.maxFrameBytes,
      `${path}.maxFrameBytes`,
      1,
      MAX_RELAY_FRAME_BYTES,
    ),
    maxQueuedBytes: integer(
      candidate.maxQueuedBytes,
      `${path}.maxQueuedBytes`,
      1,
      MAX_RELAY_QUEUED_BYTES,
    ),
    heartbeatIntervalMs: integer(
      candidate.heartbeatIntervalMs,
      `${path}.heartbeatIntervalMs`,
      1,
      300_000,
    ),
    idleTimeoutMs: integer(candidate.idleTimeoutMs, `${path}.idleTimeoutMs`, 1, 600_000),
  };
}

export function parseIssueRelayTicketRequest(value: unknown): IssueRelayTicketRequest {
  const candidate = object(value, "request");
  exact(candidate, "request", ["installationId", "role"], ["deviceId"]);
  const parsedRole = role(candidate.role, "request.role");
  const deviceId =
    candidate.deviceId === undefined
      ? undefined
      : parseDeviceId(candidate.deviceId, "request.deviceId");
  if (parsedRole === "device" && deviceId === undefined) {
    fail("request.deviceId", "is required for the device role");
  }
  if (parsedRole === "daemon" && deviceId !== undefined) {
    fail("request.deviceId", "is not allowed for the daemon role");
  }
  return {
    installationId: parseInstallationId(candidate.installationId, "request.installationId"),
    ...(deviceId === undefined ? {} : { deviceId }),
    role: parsedRole,
  };
}

export function parseIssueRelayTicketResult(value: unknown): IssueRelayTicketResult {
  const candidate = object(value, "result");
  exact(candidate, "result", ["ticket", "relayUrl", "expiresAt", "proofSchemeVersion", "limits"]);
  const relayUrl = boundedString(candidate.relayUrl, "result.relayUrl", 2_048);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(relayUrl);
  } catch {
    fail("result.relayUrl", "must be an absolute URL");
  }
  if (parsedUrl.protocol !== "wss:") {
    fail("result.relayUrl", "must use wss");
  }
  return {
    ticket: boundedString(candidate.ticket, "result.ticket", 1_024),
    relayUrl,
    expiresAt: timestamp(candidate.expiresAt, "result.expiresAt"),
    proofSchemeVersion: integer(candidate.proofSchemeVersion, "result.proofSchemeVersion", 1, 255),
    limits: parseRelayLimits(candidate.limits, "result.limits"),
  };
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let offset = 0; offset < binary.length; offset += 3) {
    const first = binary.charCodeAt(offset);
    const hasSecond = offset + 1 < binary.length;
    const hasThird = offset + 2 < binary.length;
    const second = hasSecond ? binary.charCodeAt(offset + 1) : 0;
    const third = hasThird ? binary.charCodeAt(offset + 2) : 0;
    const bits = (first << 16) | (second << 8) | third;
    encoded += alphabet[(bits >>> 18) & 63];
    encoded += alphabet[(bits >>> 12) & 63];
    encoded += hasSecond ? alphabet[(bits >>> 6) & 63] : "=";
    encoded += hasThird ? alphabet[bits & 63] : "=";
  }
  return encoded;
}

export function decodeBase64(value: unknown, path: string, maximumBytes: number): Uint8Array {
  const encoded = boundedString(value, path, Math.ceil(maximumBytes / 3) * 4);
  if (!base64Pattern.test(encoded)) fail(path, "must be canonical base64");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const output: number[] = [];
  for (let offset = 0; offset < encoded.length; offset += 4) {
    const chars = encoded.slice(offset, offset + 4);
    const values = [...chars].map((character) =>
      character === "=" ? 0 : alphabet.indexOf(character),
    );
    if (values.some((entry) => entry < 0)) fail(path, "must be canonical base64");
    const [first, second, third, fourth] = values;
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      fail(path, "must be canonical base64");
    }
    const bits = (first << 18) | (second << 12) | (third << 6) | fourth;
    output.push((bits >>> 16) & 0xff);
    if (chars[2] !== "=") output.push((bits >>> 8) & 0xff);
    if (chars[3] !== "=") output.push(bits & 0xff);
  }
  if (output.length > maximumBytes || encodeBase64(Uint8Array.from(output)) !== encoded) {
    fail(path, `must encode no more than ${maximumBytes} bytes`);
  }
  return Uint8Array.from(output);
}

export function parseInternalConsumeRelayTicketRequest(value: unknown): ConsumeRelayTicketRequest {
  const candidate = object(value, "request");
  exact(candidate, "request", [
    "version",
    "ticket",
    "relayInstanceId",
    "connectionNonce",
    "possessionProof",
  ]);
  if (candidate.version !== INTERNAL_RELAY_API_VERSION) {
    fail("request.version", `must equal ${INTERNAL_RELAY_API_VERSION}`);
  }
  return {
    ticket: boundedString(candidate.ticket, "request.ticket", 1_024),
    relayInstanceId: boundedString(candidate.relayInstanceId, "request.relayInstanceId", 128),
    connectionNonce: boundedString(candidate.connectionNonce, "request.connectionNonce", 256),
    possessionProof: decodeBase64(candidate.possessionProof, "request.possessionProof", 1_024),
  };
}

export function encodeInternalConsumeRelayTicketRequest(
  request: ConsumeRelayTicketRequest,
): InternalConsumeRelayTicketWireRequest {
  return {
    version: INTERNAL_RELAY_API_VERSION,
    ticket: request.ticket,
    relayInstanceId: request.relayInstanceId,
    connectionNonce: request.connectionNonce,
    possessionProof: encodeBase64(request.possessionProof),
  };
}

export function parseInternalConsumeRelayTicketResult(value: unknown): ConsumeRelayTicketResult {
  const candidate = object(value, "result");
  exact(
    candidate,
    "result",
    [
      "version",
      "installationId",
      "sourceRouteId",
      "role",
      "grantGeneration",
      "leaseExpiresAt",
      "limits",
    ],
    ["deviceId"],
  );
  if (candidate.version !== INTERNAL_RELAY_API_VERSION) {
    fail("result.version", `must equal ${INTERNAL_RELAY_API_VERSION}`);
  }
  const parsedRole = role(candidate.role, "result.role");
  const deviceId =
    candidate.deviceId === undefined
      ? undefined
      : parseDeviceId(candidate.deviceId, "result.deviceId");
  if (parsedRole === "device" && deviceId === undefined) fail("result.deviceId", "is required");
  if (parsedRole === "daemon" && deviceId !== undefined) fail("result.deviceId", "is not allowed");
  return {
    installationId: parseInstallationId(candidate.installationId, "result.installationId"),
    ...(deviceId === undefined ? {} : { deviceId }),
    sourceRouteId: parseRouteId(candidate.sourceRouteId, "result.sourceRouteId"),
    role: parsedRole,
    grantGeneration: integer(
      candidate.grantGeneration,
      "result.grantGeneration",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    leaseExpiresAt: timestamp(candidate.leaseExpiresAt, "result.leaseExpiresAt"),
    limits: parseRelayLimits(candidate.limits, "result.limits"),
  };
}

export function encodeInternalConsumeRelayTicketResult(
  result: ConsumeRelayTicketResult,
): InternalConsumeRelayTicketWireResult {
  return { version: INTERNAL_RELAY_API_VERSION, ...result };
}

function parseRelayPeerRoute(value: unknown, path: string): RelayPeerRoute {
  const candidate = object(value, path);
  exact(candidate, path, ["routeId", "role"], ["deviceId"]);
  const parsedRole = role(candidate.role, `${path}.role`);
  const deviceId =
    candidate.deviceId === undefined
      ? undefined
      : parseDeviceId(candidate.deviceId, `${path}.deviceId`);
  if (parsedRole === "device" && deviceId === undefined) fail(`${path}.deviceId`, "is required");
  if (parsedRole === "daemon" && deviceId !== undefined) fail(`${path}.deviceId`, "is not allowed");
  return {
    routeId: parseRouteId(candidate.routeId, `${path}.routeId`),
    role: parsedRole,
    ...(deviceId === undefined ? {} : { deviceId }),
  };
}

export function parseRelayDiscoveryMessage(value: unknown): RelayDiscoveryMessage {
  const candidate = object(value, "discovery");
  exact(candidate, "discovery", ["version", "type", "peers"], ["sourceRoute"]);
  if (candidate.version !== REMOTE_TRANSPORT_VERSION) {
    fail("discovery.version", `must equal ${REMOTE_TRANSPORT_VERSION}`);
  }
  if (
    candidate.type !== "route_snapshot" &&
    candidate.type !== "route_available" &&
    candidate.type !== "route_unavailable"
  ) {
    fail("discovery.type", "is invalid");
  }
  if (!Array.isArray(candidate.peers) || candidate.peers.length > 256) {
    fail("discovery.peers", "must be an array of at most 256 routes");
  }
  if (candidate.type === "route_snapshot" && candidate.sourceRoute === undefined) {
    fail("discovery.sourceRoute", "is required for a snapshot");
  }
  if (candidate.type !== "route_snapshot" && candidate.sourceRoute !== undefined) {
    fail("discovery.sourceRoute", "is allowed only for a snapshot");
  }
  return {
    version: REMOTE_TRANSPORT_VERSION,
    type: candidate.type,
    ...(candidate.sourceRoute === undefined
      ? {}
      : { sourceRoute: parseRelayPeerRoute(candidate.sourceRoute, "discovery.sourceRoute") }),
    peers: candidate.peers.map((peer, index) =>
      parseRelayPeerRoute(peer, `discovery.peers[${index}]`),
    ),
  };
}

export function parseRelayRevocationNotification(value: unknown): RelayRevocationNotification {
  const candidate = object(value, "request");
  exact(
    candidate,
    "request",
    ["version", "installationId", "generation", "effectiveAt"],
    ["deviceId"],
  );
  if (candidate.version !== INTERNAL_RELAY_API_VERSION) {
    fail("request.version", `must equal ${INTERNAL_RELAY_API_VERSION}`);
  }
  return {
    version: INTERNAL_RELAY_API_VERSION,
    installationId: parseInstallationId(candidate.installationId, "request.installationId"),
    ...(candidate.deviceId === undefined
      ? {}
      : { deviceId: parseDeviceId(candidate.deviceId, "request.deviceId") }),
    generation: integer(candidate.generation, "request.generation", 1, Number.MAX_SAFE_INTEGER),
    effectiveAt: timestamp(candidate.effectiveAt, "request.effectiveAt"),
  };
}

export function parseOpaqueOutboxRecord(value: unknown): OpaqueOutboxRecord {
  const candidate = object(value, "outboxRecord");
  exact(candidate, "outboxRecord", [
    "requestId",
    "idempotencyKey",
    "destinationRouteId",
    "opaqueEnvelope",
    "createdAt",
    "state",
  ]);
  if (!(candidate.opaqueEnvelope instanceof Uint8Array)) {
    fail("outboxRecord.opaqueEnvelope", "must be bytes");
  }
  if (
    candidate.opaqueEnvelope.byteLength === 0 ||
    candidate.opaqueEnvelope.byteLength > MAX_RELAY_OPAQUE_PAYLOAD_BYTES
  ) {
    fail(
      "outboxRecord.opaqueEnvelope",
      `must contain 1 through ${MAX_RELAY_OPAQUE_PAYLOAD_BYTES} bytes`,
    );
  }
  if (
    candidate.state !== "queued_local" &&
    candidate.state !== "sending" &&
    candidate.state !== "daemon_accepted"
  ) {
    fail("outboxRecord.state", "is invalid");
  }
  return {
    requestId: parseRemoteRequestId(candidate.requestId, "outboxRecord.requestId"),
    idempotencyKey: parseIdempotencyKey(candidate.idempotencyKey, "outboxRecord.idempotencyKey"),
    destinationRouteId: parseRouteId(
      candidate.destinationRouteId,
      "outboxRecord.destinationRouteId",
    ),
    opaqueEnvelope: candidate.opaqueEnvelope.slice(),
    createdAt: timestamp(candidate.createdAt, "outboxRecord.createdAt"),
    state: candidate.state,
  };
}

export function parseRelayRevocationResult(value: unknown): RelayRevocationResult {
  const candidate = object(value, "result");
  exact(candidate, "result", ["version", "accepted"]);
  if (candidate.version !== INTERNAL_RELAY_API_VERSION) {
    fail("result.version", `must equal ${INTERNAL_RELAY_API_VERSION}`);
  }
  if (candidate.accepted !== true) fail("result.accepted", "must be true");
  return { version: INTERNAL_RELAY_API_VERSION, accepted: true };
}

export function parseRemoteDeviceScopes(
  value: unknown,
  path = "scopes",
): readonly RemoteDeviceScope[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  const scopes = value.map((candidate, index) => {
    if (
      typeof candidate !== "string" ||
      !(REMOTE_DEVICE_SCOPES as readonly string[]).includes(candidate)
    ) {
      fail(`${path}[${index}]`, "is not a known remote device scope");
    }
    return candidate as RemoteDeviceScope;
  });
  if (new Set(scopes).size !== scopes.length) fail(path, "must not contain duplicate scopes");
  return [...scopes].sort();
}

export function parseAuthenticatedRemoteRequest(value: unknown): AuthenticatedRemoteRequest {
  const candidate = object(value, "request");
  exact(candidate, "request", ["deviceId", "requestId", "method", "params"], ["idempotencyKey"]);
  const method = boundedString(candidate.method, "request.method", 128);
  if (!methodPattern.test(method)) fail("request.method", "has an invalid method name");
  return {
    deviceId: parseDeviceId(candidate.deviceId, "request.deviceId"),
    requestId: parseRemoteRequestId(candidate.requestId, "request.requestId"),
    ...(candidate.idempotencyKey === undefined
      ? {}
      : {
          idempotencyKey: parseIdempotencyKey(candidate.idempotencyKey, "request.idempotencyKey"),
        }),
    method,
    params: candidate.params,
  };
}

function uuidBytes(value: string): Uint8Array {
  const hexadecimal = value.replaceAll("-", "");
  return Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(hexadecimal.slice(index * 2, index * 2 + 2), 16),
  );
}

function bytesUuid(bytes: Uint8Array, offset: number, path: string): string {
  const hexadecimal = [...bytes.subarray(offset, offset + 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return uuidPattern.test(
    `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`,
  )
    ? `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`
    : fail(path, "contains an invalid RFC 9562 UUID");
}

function writePrefix(output: Uint8Array, kind: number, attemptId: TransportAttemptId): void {
  output.set(frameMagic, 0);
  output[4] = REMOTE_TRANSPORT_VERSION;
  output[5] = kind;
  output.set(uuidBytes(attemptId), 6);
}

function encodeRoutedFrame(
  kind: 1 | 2,
  attemptId: TransportAttemptId,
  routeId: RouteId,
  payload: Uint8Array,
): Uint8Array {
  if (payload.byteLength > MAX_RELAY_OPAQUE_PAYLOAD_BYTES) {
    fail("frame.opaquePayload", `must not exceed ${MAX_RELAY_OPAQUE_PAYLOAD_BYTES} bytes`);
  }
  const output = new Uint8Array(routedFrameHeaderBytes + payload.byteLength);
  writePrefix(output, kind, attemptId);
  output.set(uuidBytes(routeId), 22);
  output.set(payload, routedFrameHeaderBytes);
  return output;
}

export function encodeRelayBinaryFrame(frame: RelayBinaryFrame): Uint8Array {
  switch (
    "destinationRouteId" in frame
      ? "send"
      : "sourceRouteId" in frame
        ? "delivery"
        : "status" in frame
          ? "receipt"
          : "failure"
  ) {
    case "send":
      return encodeRoutedFrame(
        1,
        frame.attemptId,
        (frame as RelaySendFrame).destinationRouteId,
        (frame as RelaySendFrame).opaquePayload,
      );
    case "delivery":
      return encodeRoutedFrame(
        2,
        frame.attemptId,
        (frame as RelayDelivery).sourceRouteId,
        (frame as RelayDelivery).opaquePayload,
      );
    case "receipt": {
      const output = new Uint8Array(shortFrameBytes);
      writePrefix(output, 3, frame.attemptId);
      const status = (frame as RelayReceipt).status;
      if (status !== "admitted" && status !== "forwarded") fail("frame.status", "is invalid");
      output[22] = status === "admitted" ? 1 : 2;
      return output;
    }
    case "failure": {
      const output = new Uint8Array(shortFrameBytes);
      writePrefix(output, 4, frame.attemptId);
      const failureCode = RELAY_FAILURE_CODE_VALUES[(frame as RelayFailure).code];
      if (failureCode === undefined) fail("frame.code", "is invalid");
      output[22] = failureCode;
      return output;
    }
  }
}

export function parseRelayBinaryFrame(value: Uint8Array): RelayBinaryFrame {
  if (!(value instanceof Uint8Array)) fail("frame", "must be bytes");
  if (value.byteLength < 6 || value.byteLength > MAX_RELAY_FRAME_BYTES) {
    fail("frame", `must contain 6 through ${MAX_RELAY_FRAME_BYTES} bytes`);
  }
  if (!frameMagic.every((byte, index) => value[index] === byte)) fail("frame.magic", "is invalid");
  if (value[4] !== REMOTE_TRANSPORT_VERSION) {
    fail("frame.transportVersion", `must equal ${REMOTE_TRANSPORT_VERSION}`);
  }
  const kind = value[5];
  const attemptId = parseTransportAttemptId(bytesUuid(value, 6, "frame.attemptId"));
  if (kind === 1 || kind === 2) {
    if (value.byteLength < routedFrameHeaderBytes) fail("frame", "has a truncated routed header");
    const routeId = parseRouteId(bytesUuid(value, 22, "frame.routeId"));
    const opaquePayload = value.slice(routedFrameHeaderBytes);
    return kind === 1
      ? {
          transportVersion: REMOTE_TRANSPORT_VERSION,
          attemptId,
          destinationRouteId: routeId,
          opaquePayload,
        }
      : {
          transportVersion: REMOTE_TRANSPORT_VERSION,
          attemptId,
          sourceRouteId: routeId,
          opaquePayload,
        };
  }
  if (value.byteLength !== shortFrameBytes) fail("frame", "has an invalid control-frame size");
  if (kind === 3) {
    const status = value[22] === 1 ? "admitted" : value[22] === 2 ? "forwarded" : undefined;
    if (status === undefined) fail("frame.status", "is invalid");
    return { transportVersion: REMOTE_TRANSPORT_VERSION, attemptId, status };
  }
  if (kind === 4) {
    const failureByte = value[22];
    if (failureByte === undefined) fail("frame.code", "is missing");
    const code = RELAY_FAILURE_CODES.find(
      (candidate) => RELAY_FAILURE_CODE_VALUES[candidate] === failureByte,
    );
    if (code === undefined) fail("frame.code", "is invalid");
    return { transportVersion: REMOTE_TRANSPORT_VERSION, attemptId, code };
  }
  return fail("frame.kind", "is invalid");
}
