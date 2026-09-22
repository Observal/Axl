// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { EventId, SessionId } from "./event-envelope.ts";
import { ProtocolValidationError, parseEventId, parseSessionId } from "./event-envelope.ts";

export type ExtensionSourceKind = "global" | "explicit" | "project" | "package";

export interface ExtensionRecord {
  readonly id: string;
  readonly path: string;
  readonly source: ExtensionSourceKind;
  readonly enabled: boolean;
  readonly version?: string;
  readonly packageName?: string;
  readonly error?: string;
}

export interface ExtensionListParams {
  readonly sessionId: SessionId;
}

export interface ExtensionListResult {
  readonly configPath: string;
  readonly project: { readonly root: string; readonly trusted: boolean };
  readonly extensions: readonly ExtensionRecord[];
}

export interface ExtensionSetEnabledParams extends ExtensionListParams {
  readonly extensionId: string;
  readonly enabled: boolean;
}

export interface ExtensionReloadParams extends ExtensionListParams {
  readonly extensionId: string;
}

export type ExtensionInstallSource =
  | { readonly type: "path"; readonly path: string }
  | { readonly type: "npm"; readonly spec: string }
  | { readonly type: "git"; readonly url: string; readonly ref: string };

export interface ExtensionInstallParams extends ExtensionListParams {
  readonly source: ExtensionInstallSource;
}

export interface ExtensionIdParams extends ExtensionListParams {
  readonly extensionId: string;
}

export interface ExtensionTrustParams extends ExtensionListParams {
  readonly trusted: boolean;
}

export interface ExtensionMutationResult extends ExtensionListResult {
  readonly changedExtensionId?: string;
  readonly boundaryEventIds: readonly EventId[];
}

const EXTENSION_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new ProtocolValidationError(`${path}.${key}`, "is not allowed");
  }
}

function text(value: unknown, path: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new ProtocolValidationError(
      path,
      `must be a non-empty string of at most ${maximum} characters`,
    );
  }
  return value;
}

export function parseExtensionId(value: unknown, path: string): string {
  const id = text(value, path, 128);
  if (!EXTENSION_ID.test(id)) {
    throw new ProtocolValidationError(
      path,
      "must contain lowercase letters, digits, dots, and hyphens only",
    );
  }
  return id;
}

export function parseExtensionListParams(value: unknown): ExtensionListParams {
  const input = object(value, "request.params");
  exact(input, "request.params", ["sessionId"]);
  return { sessionId: parseSessionId(input.sessionId, "request.params.sessionId") };
}

export function parseExtensionSetEnabledParams(value: unknown): ExtensionSetEnabledParams {
  const input = object(value, "request.params");
  exact(input, "request.params", ["sessionId", "extensionId", "enabled"]);
  if (typeof input.enabled !== "boolean") {
    throw new ProtocolValidationError("request.params.enabled", "must be a boolean");
  }
  return {
    sessionId: parseSessionId(input.sessionId, "request.params.sessionId"),
    extensionId: parseExtensionId(input.extensionId, "request.params.extensionId"),
    enabled: input.enabled,
  };
}

export function parseExtensionIdParams(value: unknown): ExtensionIdParams {
  const input = object(value, "request.params");
  exact(input, "request.params", ["sessionId", "extensionId"]);
  return {
    sessionId: parseSessionId(input.sessionId, "request.params.sessionId"),
    extensionId: parseExtensionId(input.extensionId, "request.params.extensionId"),
  };
}

export function parseExtensionInstallParams(value: unknown): ExtensionInstallParams {
  const input = object(value, "request.params");
  exact(input, "request.params", ["sessionId", "source"]);
  const source = object(input.source, "request.params.source");
  if (source.type === "path") {
    exact(source, "request.params.source", ["type", "path"]);
    return {
      sessionId: parseSessionId(input.sessionId, "request.params.sessionId"),
      source: { type: "path", path: text(source.path, "request.params.source.path") },
    };
  }
  if (source.type === "npm") {
    exact(source, "request.params.source", ["type", "spec"]);
    return {
      sessionId: parseSessionId(input.sessionId, "request.params.sessionId"),
      source: { type: "npm", spec: text(source.spec, "request.params.source.spec", 512) },
    };
  }
  if (source.type === "git") {
    exact(source, "request.params.source", ["type", "url", "ref"]);
    return {
      sessionId: parseSessionId(input.sessionId, "request.params.sessionId"),
      source: {
        type: "git",
        url: text(source.url, "request.params.source.url"),
        ref: text(source.ref, "request.params.source.ref", 64),
      },
    };
  }
  throw new ProtocolValidationError("request.params.source.type", "must be path, npm, or git");
}

export function parseExtensionTrustParams(value: unknown): ExtensionTrustParams {
  const input = object(value, "request.params");
  exact(input, "request.params", ["sessionId", "trusted"]);
  if (typeof input.trusted !== "boolean") {
    throw new ProtocolValidationError("request.params.trusted", "must be a boolean");
  }
  return {
    sessionId: parseSessionId(input.sessionId, "request.params.sessionId"),
    trusted: input.trusted,
  };
}

function parseExtensionRecord(value: unknown, path: string): ExtensionRecord {
  const input = object(value, path);
  exact(input, path, ["id", "path", "source", "enabled", "version", "packageName", "error"]);
  if (!["global", "explicit", "project", "package"].includes(input.source as string)) {
    throw new ProtocolValidationError(`${path}.source`, "must be a known extension source");
  }
  if (typeof input.enabled !== "boolean") {
    throw new ProtocolValidationError(`${path}.enabled`, "must be a boolean");
  }
  return {
    id: parseExtensionId(input.id, `${path}.id`),
    path: text(input.path, `${path}.path`),
    source: input.source as ExtensionSourceKind,
    enabled: input.enabled,
    ...(input.version === undefined
      ? {}
      : { version: text(input.version, `${path}.version`, 256) }),
    ...(input.packageName === undefined
      ? {}
      : { packageName: text(input.packageName, `${path}.packageName`, 256) }),
    ...(input.error === undefined ? {} : { error: text(input.error, `${path}.error`, 2_000) }),
  };
}

export function parseExtensionListResult(value: unknown): ExtensionListResult {
  const input = object(value, "result");
  exact(input, "result", ["configPath", "project", "extensions"]);
  const project = object(input.project, "result.project");
  exact(project, "result.project", ["root", "trusted"]);
  if (typeof project.trusted !== "boolean") {
    throw new ProtocolValidationError("result.project.trusted", "must be a boolean");
  }
  if (!Array.isArray(input.extensions) || input.extensions.length > 1_000) {
    throw new ProtocolValidationError(
      "result.extensions",
      "must be an array of at most 1000 extensions",
    );
  }
  return {
    configPath: text(input.configPath, "result.configPath"),
    project: { root: text(project.root, "result.project.root"), trusted: project.trusted },
    extensions: input.extensions.map((item, index) =>
      parseExtensionRecord(item, `result.extensions[${index}]`),
    ),
  };
}

export function parseExtensionMutationResult(value: unknown): ExtensionMutationResult {
  const input = object(value, "result");
  exact(input, "result", [
    "configPath",
    "project",
    "extensions",
    "changedExtensionId",
    "boundaryEventIds",
  ]);
  const listed = parseExtensionListResult({
    configPath: input.configPath,
    project: input.project,
    extensions: input.extensions,
  });
  if (
    !Array.isArray(input.boundaryEventIds) ||
    input.boundaryEventIds.some((id) => typeof id !== "string")
  ) {
    throw new ProtocolValidationError("result.boundaryEventIds", "must be an array of event IDs");
  }
  return {
    ...listed,
    ...(input.changedExtensionId === undefined
      ? {}
      : {
          changedExtensionId: parseExtensionId(
            input.changedExtensionId,
            "result.changedExtensionId",
          ),
        }),
    boundaryEventIds: input.boundaryEventIds.map((id, index) =>
      parseEventId(id, `result.boundaryEventIds[${index}]`),
    ),
  };
}
