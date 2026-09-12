// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  parseDeviceId,
  parseInstallationId,
  parseRemoteDeviceScopes,
  type DeviceId,
  type InstallationId,
  type RemoteDeviceScope,
} from "@axl/protocol";

const AUTHORITY_FORMAT_VERSION = 1 as const;
const AUTHORITY_FILE_NAME = "remote-authority.json";
const MAX_REMOTE_AUTHORITY_BYTES = 1024 * 1024;
const MAX_REMOTE_DEVICES = 256;

interface GrantState {
  readonly generation: number;
  readonly scopes: readonly RemoteDeviceScope[];
  readonly revokedAt?: number;
}

interface DeviceAuthorityRecord {
  readonly deviceId: DeviceId;
  readonly createdAt: number;
  readonly local: GrantState;
  readonly hosted?: GrantState;
}

interface PersistedAuthorityState {
  readonly version: typeof AUTHORITY_FORMAT_VERSION;
  readonly installationId: InstallationId;
  readonly devices: readonly DeviceAuthorityRecord[];
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
      : { revokedAt: nonNegativeInteger(grant.revokedAt, `${path}.revokedAt`) }),
  };
}

function parseAuthorityState(value: unknown): PersistedAuthorityState {
  const state = object(value, "remote authority");
  exact(state, "remote authority", ["version", "installationId", "devices"]);
  if (state.version !== AUTHORITY_FORMAT_VERSION) {
    throw new Error(`remote authority.version must be ${AUTHORITY_FORMAT_VERSION}`);
  }
  if (!Array.isArray(state.devices)) throw new Error("remote authority.devices must be an array");
  if (state.devices.length > MAX_REMOTE_DEVICES) {
    throw new Error(`remote authority.devices must not exceed ${MAX_REMOTE_DEVICES} entries`);
  }
  const seen = new Set<string>();
  const devices = state.devices.map((value, index): DeviceAuthorityRecord => {
    const path = `remote authority.devices[${index}]`;
    const device = object(value, path);
    exact(device, path, ["deviceId", "createdAt", "local"], ["hosted"]);
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
    };
  });
  return {
    version: AUTHORITY_FORMAT_VERSION,
    installationId: parseInstallationId(state.installationId, "remote authority.installationId"),
    devices,
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
  private readonly revocationListeners = new Set<(deviceId: DeviceId) => void>();
  private tail: Promise<void> = Promise.resolve();

  private constructor(path: string, state: PersistedAuthorityState) {
    this.path = path;
    this.installationId = state.installationId;
    this.devices = new Map(state.devices.map((record) => [record.deviceId, record]));
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
    };
  }

  registerLocalDevice(
    deviceId: DeviceId,
    scopes: readonly RemoteDeviceScope[],
    now = Date.now(),
  ): Promise<RemoteDeviceAuthoritySnapshot> {
    return this.mutate((devices) => {
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
        createdAt: nonNegativeInteger(now, "now"),
        local: { generation: 1, scopes: normalizedScopes },
      });
      return devices;
    }).then(() => this.requiredSnapshot(deviceId));
  }

  narrowLocalGrant(
    deviceId: DeviceId,
    scopes: readonly RemoteDeviceScope[],
  ): Promise<RemoteDeviceAuthoritySnapshot> {
    return this.mutate((devices) => {
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
    }).then(() => this.requiredSnapshot(deviceId));
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
    return this.mutate((devices) => {
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
    }).then(() => {
      const snapshot = this.requiredSnapshot(deviceId);
      if (snapshot.hostedRevoked) this.publishRevocation(deviceId);
      return snapshot;
    });
  }

  revokeLocalDevice(deviceId: DeviceId, now = Date.now()): Promise<RemoteDeviceAuthoritySnapshot> {
    return this.mutate((devices) => {
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
          revokedAt: nonNegativeInteger(now, "now"),
        },
      });
      return devices;
    }).then(() => {
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

  runAuthorizedUntilAccepted<Result>(
    deviceId: DeviceId,
    requiredScope: RemoteDeviceScope,
    start: (context: RemoteAuthorizationContext) => StartedAuthorizedOperation<Result>,
  ): Promise<Result> {
    const admitted = this.serialize(async () => {
      const context = this.authorize(deviceId, requiredScope);
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

  private mutate(
    operation: (
      devices: Map<DeviceId, DeviceAuthorityRecord>,
    ) => Map<DeviceId, DeviceAuthorityRecord>,
  ): Promise<void> {
    return this.serialize(async () => {
      const candidate = new Map(this.devices);
      const next = operation(candidate);
      const state: PersistedAuthorityState = {
        version: AUTHORITY_FORMAT_VERSION,
        installationId: this.installationId,
        devices: [...next.values()].sort((left, right) =>
          left.deviceId.localeCompare(right.deviceId),
        ),
      };
      await writeAtomic(this.path, state);
      this.devices = next;
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
