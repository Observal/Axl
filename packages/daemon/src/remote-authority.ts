// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM049
// SPDX-License-Identifier: Apache-2.0

import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  isRemoteEndpointQuarantineReason,
  isRemoteEndpointWitnessState,
  parseDeviceId,
  parseInstallationId,
  parseRemoteDeviceScopes,
  type DeviceId,
  type InstallationId,
  type RemoteDeviceScope,
  type RemoteEndpointQuarantineReason,
  type RemoteEndpointWitnessState,
  type RemoteEndpointWitnessStatus,
} from "@axl/protocol";

const AUTHORITY_FORMAT_VERSION = 2 as const;
const AUTHORITY_FILE_NAME = "remote-authority.json";
const MAX_REMOTE_AUTHORITY_BYTES = 1024 * 1024;
const MAX_REMOTE_DEVICES = 256;
const MAX_AUTHORITY_AUDIT_EVENTS = 4_096;

interface GrantState {
  readonly generation: number;
  readonly scopes: readonly RemoteDeviceScope[];
  readonly revokedAt?: number;
}

/** Last witness lifecycle transition the daemon recorded for a device endpoint. */
interface WitnessRecordState {
  readonly state: RemoteEndpointWitnessState;
  readonly reason?: RemoteEndpointQuarantineReason;
  readonly changedAt: number;
}

interface DeviceAuthorityRecord {
  readonly deviceId: DeviceId;
  readonly createdAt: number;
  readonly local: GrantState;
  readonly hosted?: GrantState;
  readonly witness?: WitnessRecordState;
}

export type RemoteAuthorityAuditCode =
  | "device_registered"
  | "local_grant_narrowed"
  | "hosted_grant_narrowed"
  | "local_device_revoked"
  | "hosted_device_revoked"
  | "authorization_denied"
  | "endpoint_recovering"
  | "endpoint_ready"
  | "endpoint_quarantined"
  | "endpoint_revoked";

const WITNESS_AUDIT_CODES: Readonly<Record<RemoteEndpointWitnessState, RemoteAuthorityAuditCode>> =
  Object.freeze({
    recovering: "endpoint_recovering",
    ready: "endpoint_ready",
    quarantined: "endpoint_quarantined",
    revoked: "endpoint_revoked",
  });

type RemoteAuthorityAuditDraft = Omit<RemoteAuthorityAuditEvent, "sequence">;

export interface RemoteAuthorityAuditEvent {
  readonly sequence: number;
  readonly occurredAt: number;
  readonly code: RemoteAuthorityAuditCode;
  readonly actorDeviceId: DeviceId;
  readonly localGeneration?: number;
  readonly hostedGeneration?: number;
  readonly scope?: RemoteDeviceScope;
  readonly reason?: RemoteAuthorityErrorCode;
  /** Present exactly on `endpoint_quarantined`. */
  readonly quarantineReason?: RemoteEndpointQuarantineReason;
}

interface PersistedAuthorityState {
  readonly version: typeof AUTHORITY_FORMAT_VERSION;
  readonly installationId: InstallationId;
  readonly devices: readonly DeviceAuthorityRecord[];
  readonly audit: readonly RemoteAuthorityAuditEvent[];
}

export interface RemoteDeviceAuthoritySnapshot {
  readonly deviceId: DeviceId;
  readonly createdAt: number;
  readonly localGeneration: number;
  readonly hostedGeneration?: number;
  readonly localScopes: readonly RemoteDeviceScope[];
  readonly hostedScopes?: readonly RemoteDeviceScope[];
  readonly effectiveScopes: readonly RemoteDeviceScope[];
  readonly locallyRevoked: boolean;
  readonly hostedRevoked: boolean;
  /** Absent until the daemon records the endpoint's first witness transition. */
  readonly witness?: WitnessRecordState;
}

export interface RemoteAuthorizationContext {
  readonly installationId: InstallationId;
  readonly deviceId: DeviceId;
  readonly localGrantGeneration: number;
  readonly hostedGrantGeneration: number;
  readonly effectiveScopes: readonly RemoteDeviceScope[];
}

export interface StartedAuthorizedOperation<Result> {
  /** Resolves only after durable command acceptance. */
  readonly acceptance: Promise<unknown>;
  readonly completion: Promise<Result>;
}

export type RemoteAuthorityErrorCode =
  | "unknown_device"
  | "device_revoked"
  | "hosted_grant_missing"
  | "scope_forbidden"
  | "grant_conflict"
  | "stale_grant_generation"
  | "device_limit_reached"
  | "device_identity_mismatch"
  | "remote_method_forbidden"
  | "unsafe_remote_forbidden";

const REMOTE_AUTHORITY_ERROR_CODES: readonly RemoteAuthorityErrorCode[] = [
  "unknown_device",
  "device_revoked",
  "hosted_grant_missing",
  "scope_forbidden",
  "grant_conflict",
  "stale_grant_generation",
  "device_limit_reached",
  "device_identity_mismatch",
  "remote_method_forbidden",
  "unsafe_remote_forbidden",
];

export class RemoteAuthorityError extends Error {
  readonly code: RemoteAuthorityErrorCode;

  constructor(code: RemoteAuthorityErrorCode, message: string) {
    super(message);
    this.name = "RemoteAuthorityError";
    this.code = code;
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is unknown`);
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`${path}.${key} is required`);
  }
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, path: string): number {
  const parsed = nonNegativeInteger(value, path);
  if (parsed === 0) throw new Error(`${path} must be positive`);
  return parsed;
}

function parseGrant(value: unknown, path: string): GrantState {
  const grant = object(value, path);
  exact(grant, path, ["generation", "scopes"], ["revokedAt"]);
  return {
    generation: positiveInteger(grant.generation, `${path}.generation`),
    scopes: parseRemoteDeviceScopes(grant.scopes, `${path}.scopes`),
    ...(grant.revokedAt === undefined
      ? {}
      : {
          revokedAt: nonNegativeInteger(grant.revokedAt, `${path}.revokedAt`),
        }),
  };
}

function parseWitnessState(value: unknown, path: string): WitnessRecordState {
  const witness = object(value, path);
  exact(witness, path, ["state", "changedAt"], ["reason"]);
  if (!isRemoteEndpointWitnessState(witness.state)) throw new Error(`${path}.state is invalid`);
  if (witness.state === "quarantined") {
    if (!isRemoteEndpointQuarantineReason(witness.reason)) {
      throw new Error(`${path}.reason must name a quarantine class`);
    }
  } else if (witness.reason !== undefined) {
    throw new Error(`${path}.reason is only allowed when quarantined`);
  }
  return {
    state: witness.state,
    ...(witness.state === "quarantined"
      ? { reason: witness.reason as RemoteEndpointQuarantineReason }
      : {}),
    changedAt: nonNegativeInteger(witness.changedAt, `${path}.changedAt`),
  };
}

function parseAuditEvent(value: unknown, index: number): RemoteAuthorityAuditEvent {
  const path = `remote authority.audit[${index}]`;
  const event = object(value, path);
  exact(
    event,
    path,
    ["sequence", "occurredAt", "code", "actorDeviceId"],
    ["localGeneration", "hostedGeneration", "scope", "reason", "quarantineReason"],
  );
  const codes: readonly RemoteAuthorityAuditCode[] = [
    "device_registered",
    "local_grant_narrowed",
    "hosted_grant_narrowed",
    "local_device_revoked",
    "hosted_device_revoked",
    "authorization_denied",
    "endpoint_recovering",
    "endpoint_ready",
    "endpoint_quarantined",
    "endpoint_revoked",
  ];
  if (typeof event.code !== "string" || !codes.includes(event.code as RemoteAuthorityAuditCode)) {
    throw new Error(`${path}.code is invalid`);
  }
  const scopes =
    event.scope === undefined
      ? undefined
      : parseRemoteDeviceScopes([event.scope], `${path}.scope`)[0];
  const reason = event.reason;
  if (
    reason !== undefined &&
    (typeof reason !== "string" ||
      !REMOTE_AUTHORITY_ERROR_CODES.includes(reason as RemoteAuthorityErrorCode))
  ) {
    throw new Error(`${path}.reason is invalid`);
  }
  if (event.code === "endpoint_quarantined") {
    if (!isRemoteEndpointQuarantineReason(event.quarantineReason)) {
      throw new Error(`${path}.quarantineReason must name a quarantine class`);
    }
  } else if (event.quarantineReason !== undefined) {
    throw new Error(`${path}.quarantineReason is only allowed on endpoint_quarantined`);
  }
  return {
    sequence: positiveInteger(event.sequence, `${path}.sequence`),
    occurredAt: nonNegativeInteger(event.occurredAt, `${path}.occurredAt`),
    code: event.code as RemoteAuthorityAuditCode,
    actorDeviceId: parseDeviceId(event.actorDeviceId, `${path}.actorDeviceId`),
    ...(event.localGeneration === undefined
      ? {}
      : {
          localGeneration: positiveInteger(event.localGeneration, `${path}.localGeneration`),
        }),
    ...(event.hostedGeneration === undefined
      ? {}
      : {
          hostedGeneration: positiveInteger(event.hostedGeneration, `${path}.hostedGeneration`),
        }),
    ...(scopes === undefined ? {} : { scope: scopes }),
    ...(reason === undefined ? {} : { reason: reason as RemoteAuthorityErrorCode }),
    ...(event.quarantineReason === undefined
      ? {}
      : { quarantineReason: event.quarantineReason as RemoteEndpointQuarantineReason }),
  };
}

function parseAuthorityState(value: unknown): PersistedAuthorityState {
  const state = object(value, "remote authority");
  exact(state, "remote authority", ["version", "installationId", "devices", "audit"]);
  if (state.version !== AUTHORITY_FORMAT_VERSION) {
    throw new Error(`remote authority.version must be ${AUTHORITY_FORMAT_VERSION}`);
  }
  if (!Array.isArray(state.devices)) throw new Error("remote authority.devices must be an array");
  if (!Array.isArray(state.audit) || state.audit.length > MAX_AUTHORITY_AUDIT_EVENTS) {
    throw new Error(
      `remote authority.audit must contain at most ${MAX_AUTHORITY_AUDIT_EVENTS} entries`,
    );
  }
  if (state.devices.length > MAX_REMOTE_DEVICES) {
    throw new Error(`remote authority.devices must not exceed ${MAX_REMOTE_DEVICES} entries`);
  }
  const seen = new Set<string>();
  const devices = state.devices.map((value, index): DeviceAuthorityRecord => {
    const path = `remote authority.devices[${index}]`;
    const device = object(value, path);
    exact(device, path, ["deviceId", "createdAt", "local"], ["hosted", "witness"]);
    const deviceId = parseDeviceId(device.deviceId, `${path}.deviceId`);
    if (seen.has(deviceId)) throw new Error(`${path}.deviceId is duplicated`);
    seen.add(deviceId);
    return {
      deviceId,
      createdAt: nonNegativeInteger(device.createdAt, `${path}.createdAt`),
      local: parseGrant(device.local, `${path}.local`),
      ...(device.hosted === undefined
        ? {}
        : { hosted: parseGrant(device.hosted, `${path}.hosted`) }),
      ...(device.witness === undefined
        ? {}
        : { witness: parseWitnessState(device.witness, `${path}.witness`) }),
    };
  });
  const audit = state.audit.map(parseAuditEvent);
  for (const [index, event] of audit.entries()) {
    if (event.sequence !== index + 1) throw new Error("remote authority.audit sequence is invalid");
  }
  return {
    version: AUTHORITY_FORMAT_VERSION,
    installationId: parseInstallationId(state.installationId, "remote authority.installationId"),
    devices,
    audit,
  };
}

function canonicalScopes(scopes: readonly RemoteDeviceScope[]): readonly RemoteDeviceScope[] {
  return parseRemoteDeviceScopes(scopes);
}

function nextGeneration(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new RemoteAuthorityError("grant_conflict", "Local grant generation is exhausted");
  }
  return current + 1;
}

function sameScopes(
  left: readonly RemoteDeviceScope[],
  right: readonly RemoteDeviceScope[],
): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

function effectiveScopes(record: DeviceAuthorityRecord): readonly RemoteDeviceScope[] {
  if (record.local.revokedAt !== undefined || record.hosted?.revokedAt !== undefined) return [];
  const hosted = new Set(record.hosted?.scopes ?? []);
  return record.local.scopes.filter((scope) => hosted.has(scope));
}

async function readExisting(path: string): Promise<Uint8Array | undefined> {
  let status: Stats;
  try {
    status = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`Remote authority path ${JSON.stringify(path)} must be a regular file`);
  }
  if (status.size > MAX_REMOTE_AUTHORITY_BYTES) {
    throw new Error(`Remote authority store exceeds ${MAX_REMOTE_AUTHORITY_BYTES} bytes`);
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const openedStatus = await handle.stat();
    if (!openedStatus.isFile())
      throw new Error("Remote authority store must remain a regular file");
    if (openedStatus.size > MAX_REMOTE_AUTHORITY_BYTES) {
      throw new Error(`Remote authority store exceeds ${MAX_REMOTE_AUTHORITY_BYTES} bytes`);
    }
    await handle.chmod(0o600);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(path: string, state: PersistedAuthorityState): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const bytes = new TextEncoder().encode(`${JSON.stringify(state)}\n`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Durable local and hosted device-grant intersection for remote daemon requests. */
export class RemoteDeviceAuthorityStore {
  readonly path: string;
  readonly installationId: InstallationId;
  private devices: Map<DeviceId, DeviceAuthorityRecord>;
  private audit: RemoteAuthorityAuditEvent[];
  private readonly revocationListeners = new Set<(deviceId: DeviceId) => void>();
  private readonly witnessListeners = new Set<(deviceId: DeviceId) => void>();
  private tail: Promise<void> = Promise.resolve();

  private constructor(path: string, state: PersistedAuthorityState) {
    this.path = path;
    this.installationId = state.installationId;
    this.devices = new Map(state.devices.map((record) => [record.deviceId, record]));
    this.audit = [...state.audit];
  }

  static async open(
    dataDirectory: string,
    installationId: InstallationId,
  ): Promise<RemoteDeviceAuthorityStore> {
    const path = resolve(dataDirectory, AUTHORITY_FILE_NAME);
    const bytes = await readExisting(path);
    if (bytes === undefined) {
      const initial: PersistedAuthorityState = {
        version: AUTHORITY_FORMAT_VERSION,
        installationId,
        devices: [],
        audit: [],
      };
      await writeAtomic(path, initial);
      return new RemoteDeviceAuthorityStore(path, initial);
    }
    let state: PersistedAuthorityState;
    try {
      state = parseAuthorityState(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } catch (cause) {
      throw new Error(`Corrupt remote authority store ${JSON.stringify(path)}`, { cause });
    }
    if (state.installationId !== installationId) {
      throw new Error("Remote authority installation identity does not match this daemon");
    }
    return new RemoteDeviceAuthorityStore(path, state);
  }

  auditEntries(): readonly RemoteAuthorityAuditEvent[] {
    return this.audit.map((event) => ({ ...event }));
  }

  snapshot(deviceId: DeviceId): RemoteDeviceAuthoritySnapshot | undefined {
    const record = this.devices.get(deviceId);
    if (record === undefined) return undefined;
    return {
      deviceId: record.deviceId,
      createdAt: record.createdAt,
      localGeneration: record.local.generation,
      ...(record.hosted === undefined ? {} : { hostedGeneration: record.hosted.generation }),
      localScopes: [...record.local.scopes],
      ...(record.hosted === undefined ? {} : { hostedScopes: [...record.hosted.scopes] }),
      effectiveScopes: effectiveScopes(record),
      locallyRevoked: record.local.revokedAt !== undefined,
      hostedRevoked: record.hosted?.revokedAt !== undefined,
      ...(record.witness === undefined ? {} : { witness: { ...record.witness } }),
    };
  }

  /** Witness lifecycle of every device whose endpoint has reported a transition. */
  endpointWitnessStatuses(): readonly RemoteEndpointWitnessStatus[] {
    const statuses: RemoteEndpointWitnessStatus[] = [];
    for (const record of this.devices.values()) {
      if (record.witness === undefined) continue;
      statuses.push({ deviceId: record.deviceId, ...record.witness });
    }
    return statuses.sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  }

  /**
   * Record one endpoint witness transition. A transition into the state the record already holds
   * (with the same reason) changes nothing and appends no audit event, so retries while
   * recovering never grow the audit. Every real transition is one durable audit event.
   */
  recordEndpointWitnessState(
    deviceId: DeviceId,
    state: RemoteEndpointWitnessState,
    reason?: RemoteEndpointQuarantineReason,
    now = Date.now(),
  ): Promise<RemoteEndpointWitnessStatus> {
    const occurredAt = nonNegativeInteger(now, "now");
    if (state === "quarantined") {
      if (reason === undefined) throw new TypeError("A quarantine transition requires a reason");
    } else if (reason !== undefined) {
      throw new TypeError("Only a quarantine transition carries a reason");
    }
    const current = this.devices.get(deviceId);
    if (current === undefined) {
      return Promise.reject(new RemoteAuthorityError("unknown_device", "Device is not registered"));
    }
    if (current.witness?.state === state && current.witness.reason === reason) {
      return Promise.resolve({ deviceId, ...current.witness });
    }
    let changed = false;
    return this.mutate(
      (devices) => {
        const existing = devices.get(deviceId);
        if (existing === undefined) {
          throw new RemoteAuthorityError("unknown_device", "Device is not registered");
        }
        if (existing.witness?.state === state && existing.witness.reason === reason) {
          return devices;
        }
        changed = true;
        devices.set(deviceId, {
          ...existing,
          witness: {
            state,
            ...(reason === undefined ? {} : { reason }),
            changedAt: occurredAt,
          },
        });
        return devices;
      },
      () =>
        changed
          ? {
              occurredAt,
              code: WITNESS_AUDIT_CODES[state],
              actorDeviceId: deviceId,
              ...(reason === undefined ? {} : { quarantineReason: reason }),
            }
          : undefined,
    ).then(() => {
      if (changed) for (const listener of this.witnessListeners) listener(deviceId);
      const witness = this.devices.get(deviceId)?.witness;
      if (witness === undefined)
        throw new Error("Remote authority mutation lost its witness state");
      return { deviceId, ...witness };
    });
  }

  onEndpointWitnessChanged(listener: (deviceId: DeviceId) => void): () => void {
    this.witnessListeners.add(listener);
    return () => this.witnessListeners.delete(listener);
  }

  registerLocalDevice(
    deviceId: DeviceId,
    scopes: readonly RemoteDeviceScope[],
    now = Date.now(),
  ): Promise<RemoteDeviceAuthoritySnapshot> {
    const occurredAt = nonNegativeInteger(now, "now");
    return this.mutate(
      (devices) => {
        const normalizedScopes = canonicalScopes(scopes);
        const existing = devices.get(deviceId);
        if (existing === undefined && devices.size >= MAX_REMOTE_DEVICES) {
          throw new RemoteAuthorityError("device_limit_reached", "Device limit has been reached");
        }
        if (existing !== undefined) {
          if (
            existing.local.revokedAt !== undefined ||
            !sameScopes(existing.local.scopes, normalizedScopes)
          ) {
            throw new RemoteAuthorityError(
              "grant_conflict",
              "Device identity is already bound to another local grant",
            );
          }
          return devices;
        }
        devices.set(deviceId, {
          deviceId,
          createdAt: occurredAt,
          local: { generation: 1, scopes: normalizedScopes },
        });
        return devices;
      },
      (before, after) => {
        const record = after.get(deviceId);
        return before.has(deviceId) || record === undefined
          ? undefined
          : {
              occurredAt,
              code: "device_registered",
              actorDeviceId: deviceId,
              localGeneration: record.local.generation,
            };
      },
    ).then(() => this.requiredSnapshot(deviceId));
  }

  narrowLocalGrant(
    deviceId: DeviceId,
    scopes: readonly RemoteDeviceScope[],
  ): Promise<RemoteDeviceAuthoritySnapshot> {
    const occurredAt = Date.now();
    return this.mutate(
      (devices) => {
        const record = devices.get(deviceId);
        if (record === undefined) {
          throw new RemoteAuthorityError("unknown_device", "Device is not locally paired");
        }
        if (record.local.revokedAt !== undefined) {
          throw new RemoteAuthorityError("device_revoked", "Device is revoked");
        }
        const normalizedScopes = canonicalScopes(scopes);
        const currentScopes = new Set(record.local.scopes);
        if (normalizedScopes.some((scope) => !currentScopes.has(scope))) {
          throw new RemoteAuthorityError(
            "grant_conflict",
            "A local grant update may only narrow current scopes",
          );
        }
        if (sameScopes(record.local.scopes, normalizedScopes)) return devices;
        devices.set(deviceId, {
          ...record,
          local: {
            generation: nextGeneration(record.local.generation),
            scopes: normalizedScopes,
          },
        });
        return devices;
      },
      (before, after) => {
        const previous = before.get(deviceId);
        const record = after.get(deviceId);
        return previous === record || record === undefined
          ? undefined
          : {
              occurredAt,
              code: "local_grant_narrowed",
              actorDeviceId: deviceId,
              localGeneration: record.local.generation,
            };
      },
    ).then(() => this.requiredSnapshot(deviceId));
  }

  onDeviceRevoked(listener: (deviceId: DeviceId) => void): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  applyHostedGrant(
    deviceId: DeviceId,
    generation: number,
    scopes: readonly RemoteDeviceScope[],
    revokedAt?: number,
  ): Promise<RemoteDeviceAuthoritySnapshot> {
    const occurredAt = Date.now();
    return this.mutate(
      (devices) => {
        const record = devices.get(deviceId);
        if (record === undefined) {
          throw new RemoteAuthorityError("unknown_device", "Device is not locally paired");
        }
        const normalizedGeneration = positiveInteger(generation, "generation");
        const normalizedScopes = canonicalScopes(scopes);
        const normalizedRevokedAt =
          revokedAt === undefined ? undefined : nonNegativeInteger(revokedAt, "revokedAt");
        const hosted = record.hosted;
        if (hosted !== undefined && normalizedGeneration < hosted.generation) {
          throw new RemoteAuthorityError(
            "stale_grant_generation",
            "Hosted grant generation is stale",
          );
        }
        if (hosted?.revokedAt !== undefined && normalizedRevokedAt === undefined) {
          throw new RemoteAuthorityError(
            "grant_conflict",
            "Revoked device identity cannot be restored",
          );
        }
        if (hosted !== undefined && normalizedGeneration === hosted.generation) {
          if (
            !sameScopes(hosted.scopes, normalizedScopes) ||
            hosted.revokedAt !== normalizedRevokedAt
          ) {
            throw new RemoteAuthorityError(
              "grant_conflict",
              "Hosted grant generation is bound to another value",
            );
          }
          return devices;
        }
        devices.set(deviceId, {
          ...record,
          hosted: {
            generation: normalizedGeneration,
            scopes: normalizedScopes,
            ...(normalizedRevokedAt === undefined ? {} : { revokedAt: normalizedRevokedAt }),
          },
        });
        return devices;
      },
      (before, after) => {
        const previous = before.get(deviceId)?.hosted;
        const record = after.get(deviceId);
        return previous === record?.hosted || record?.hosted === undefined
          ? undefined
          : {
              occurredAt,
              code:
                record.hosted.revokedAt === undefined
                  ? "hosted_grant_narrowed"
                  : "hosted_device_revoked",
              actorDeviceId: deviceId,
              hostedGeneration: record.hosted.generation,
            };
      },
    ).then(() => {
      const snapshot = this.requiredSnapshot(deviceId);
      if (snapshot.hostedRevoked) this.publishRevocation(deviceId);
      return snapshot;
    });
  }

  revokeLocalDevice(deviceId: DeviceId, now = Date.now()): Promise<RemoteDeviceAuthoritySnapshot> {
    const occurredAt = nonNegativeInteger(now, "now");
    return this.mutate(
      (devices) => {
        const record = devices.get(deviceId);
        if (record === undefined) {
          throw new RemoteAuthorityError("unknown_device", "Device is not locally paired");
        }
        if (record.local.revokedAt !== undefined) return devices;
        devices.set(deviceId, {
          ...record,
          local: {
            generation: nextGeneration(record.local.generation),
            scopes: record.local.scopes,
            revokedAt: occurredAt,
          },
        });
        return devices;
      },
      (before, after) => {
        const previous = before.get(deviceId);
        const record = after.get(deviceId);
        return previous === record || record === undefined
          ? undefined
          : {
              occurredAt,
              code: "local_device_revoked",
              actorDeviceId: deviceId,
              localGeneration: record.local.generation,
            };
      },
    ).then(() => {
      const snapshot = this.requiredSnapshot(deviceId);
      this.publishRevocation(deviceId);
      return snapshot;
    });
  }

  authorize(deviceId: DeviceId, requiredScope: RemoteDeviceScope): RemoteAuthorizationContext {
    const record = this.devices.get(deviceId);
    if (record === undefined) {
      throw new RemoteAuthorityError("unknown_device", "Device is not locally paired");
    }
    if (record.local.revokedAt !== undefined || record.hosted?.revokedAt !== undefined) {
      throw new RemoteAuthorityError("device_revoked", "Device is revoked");
    }
    if (record.hosted === undefined) {
      throw new RemoteAuthorityError("hosted_grant_missing", "Hosted device grant is unavailable");
    }
    const scopes = effectiveScopes(record);
    if (!scopes.includes(requiredScope)) {
      throw new RemoteAuthorityError("scope_forbidden", "Device does not hold the required scope");
    }
    return {
      installationId: this.installationId,
      deviceId,
      localGrantGeneration: record.local.generation,
      hostedGrantGeneration: record.hosted.generation,
      effectiveScopes: scopes,
    };
  }

  authorizeAudited(
    deviceId: DeviceId,
    requiredScope: RemoteDeviceScope,
  ): Promise<RemoteAuthorizationContext> {
    return this.serialize(async () => {
      try {
        return this.authorize(deviceId, requiredScope);
      } catch (cause) {
        if (cause instanceof RemoteAuthorityError) {
          await this.appendAuditLocked({
            occurredAt: Date.now(),
            code: "authorization_denied",
            actorDeviceId: deviceId,
            scope: requiredScope,
            reason: cause.code,
          });
        }
        throw cause;
      }
    });
  }

  runAuthorizedUntilAccepted<Result>(
    deviceId: DeviceId,
    requiredScope: RemoteDeviceScope,
    start: (context: RemoteAuthorizationContext) => StartedAuthorizedOperation<Result>,
  ): Promise<Result> {
    const admitted = this.serialize(async () => {
      let context: RemoteAuthorizationContext;
      try {
        context = this.authorize(deviceId, requiredScope);
      } catch (cause) {
        if (cause instanceof RemoteAuthorityError) {
          await this.appendAuditLocked({
            occurredAt: Date.now(),
            code: "authorization_denied",
            actorDeviceId: deviceId,
            scope: requiredScope,
            reason: cause.code,
          });
        }
        throw cause;
      }
      const operation = start(context);
      void operation.completion.catch(() => undefined);
      await operation.acceptance;
      return { completion: operation.completion };
    });
    return admitted.then(({ completion }) => completion);
  }

  private publishRevocation(deviceId: DeviceId): void {
    for (const listener of this.revocationListeners) listener(deviceId);
  }

  private requiredSnapshot(deviceId: DeviceId): RemoteDeviceAuthoritySnapshot {
    const snapshot = this.snapshot(deviceId);
    if (snapshot === undefined) throw new Error("Remote authority mutation lost its device record");
    return snapshot;
  }

  private async appendAuditLocked(event: RemoteAuthorityAuditDraft): Promise<void> {
    if (this.audit.length >= MAX_AUTHORITY_AUDIT_EVENTS) {
      throw new Error("Remote authority audit capacity has been reached");
    }
    const audit = [...this.audit, { ...event, sequence: this.audit.length + 1 }];
    await writeAtomic(this.path, {
      version: AUTHORITY_FORMAT_VERSION,
      installationId: this.installationId,
      devices: [...this.devices.values()].sort((left, right) =>
        left.deviceId.localeCompare(right.deviceId),
      ),
      audit,
    });
    this.audit = audit;
  }

  private mutate(
    operation: (
      devices: Map<DeviceId, DeviceAuthorityRecord>,
    ) => Map<DeviceId, DeviceAuthorityRecord>,
    auditEvent?: (
      before: ReadonlyMap<DeviceId, DeviceAuthorityRecord>,
      after: ReadonlyMap<DeviceId, DeviceAuthorityRecord>,
    ) => RemoteAuthorityAuditDraft | undefined,
  ): Promise<void> {
    return this.serialize(async () => {
      const before = this.devices;
      const candidate = new Map(before);
      const next = operation(candidate);
      const event = auditEvent?.(before, next);
      if (event !== undefined && this.audit.length >= MAX_AUTHORITY_AUDIT_EVENTS) {
        throw new Error("Remote authority audit capacity has been reached");
      }
      const audit =
        event === undefined
          ? this.audit
          : [...this.audit, { ...event, sequence: this.audit.length + 1 }];
      const state: PersistedAuthorityState = {
        version: AUTHORITY_FORMAT_VERSION,
        installationId: this.installationId,
        devices: [...next.values()].sort((left, right) =>
          left.deviceId.localeCompare(right.deviceId),
        ),
        audit,
      };
      await writeAtomic(this.path, state);
      this.devices = next;
      this.audit = audit;
    });
  }

  private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
