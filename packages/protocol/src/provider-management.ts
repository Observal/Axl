// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { type JsonObject, ProtocolValidationError } from "./event-envelope.ts";
import type { ThinkingLevel } from "./events.ts";
import { THINKING_LEVELS } from "./model-stream.ts";

export type ProviderAuthMethod = "environment" | "file" | "oauth" | "ambient" | "keyless";
export type ProviderLoginMethod = "api_key" | "oauth";
export type ProviderAuthenticationPhase =
  | "idle"
  | "authorizing"
  | "authenticated"
  | "reauthentication_required"
  | "logged_out";

export interface ProviderAuthenticationStatus {
  readonly providerId: string;
  readonly phase: ProviderAuthenticationPhase;
  readonly method?: ProviderLoginMethod;
  readonly source?: string;
}

export interface ProviderCatalogStatus {
  readonly refreshable: boolean;
  readonly generation?: number;
  readonly checkedAt?: number;
  readonly updatedAt?: number;
  readonly source?: {
    readonly id: string;
    readonly kind: "provider_api" | "entitlement" | "gateway";
    readonly revision?: string;
  };
}

export interface ProviderModelCost {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly cacheReadUsdPerMTok?: number;
  readonly cacheWriteUsdPerMTok?: number;
}

export interface ProviderTextModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly apiDialect: string;
  readonly capabilities: {
    readonly toolUse: boolean;
    readonly structuredOutput: boolean;
    readonly imageInput: boolean;
  };
  readonly reasoning: boolean;
  readonly supportedThinkingLevels: readonly ThinkingLevel[];
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly cost?: ProviderModelCost;
  readonly availability: {
    readonly status: "available" | "preview" | "deprecated" | "unavailable";
    readonly reason?: string;
  };
}

export interface ProviderInventoryGroup {
  readonly providerId: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly regionFamily?: string;
  readonly region?: string;
  readonly authMethods: readonly ProviderAuthMethod[];
  readonly loginMethods: readonly ProviderLoginMethod[];
  readonly authentication: ProviderAuthenticationStatus;
  readonly catalog: ProviderCatalogStatus;
  readonly models: readonly ProviderTextModel[];
  readonly catalogError?: {
    readonly code: "catalog_failure";
    readonly message: string;
    readonly action: "refresh_catalog" | "configure_provider";
  };
}

export interface ProviderListParams {
  readonly providerId?: string;
}

export interface ProviderListResult {
  readonly providers: readonly ProviderInventoryGroup[];
}

export interface ProviderCatalogRefreshParams {
  readonly providerId?: string;
}

export interface ProviderCatalogRefreshResult {
  readonly providers: readonly {
    readonly providerId: string;
    readonly status: "refreshed" | "not_modified" | "superseded" | "unsupported" | "failed";
    readonly modelCount: number;
    readonly error?: {
      readonly code:
        | "catalog_refresh_failed"
        | "authentication_required"
        | "entitlement_required"
        | "entitlement_exhausted";
      readonly message: string;
      readonly action: "retry" | "login" | "configure_provider";
    };
  }[];
}

export interface ProviderAuthenticationStatusParams {
  readonly providerId?: string;
}

export interface ProviderAuthenticationStatusResult {
  readonly providers: readonly ProviderAuthenticationStatus[];
}

export interface ProviderLoginParams {
  readonly providerId: string;
  readonly method: ProviderLoginMethod;
}

export interface ProviderLogoutParams {
  readonly providerId: string;
}

export type ProviderLoginResult = ProviderAuthenticationStatus;
export type ProviderLogoutResult = ProviderAuthenticationStatus;

export const PROVIDER_RPC_ERROR_CODES = [
  "provider_not_found",
  "provider_disabled",
  "model_not_found",
  "model_unavailable",
  "authentication_required",
  "authentication_failed",
  "authentication_unavailable",
  "catalog_refresh_unsupported",
  "catalog_refresh_failed",
  "entitlement_required",
  "entitlement_exhausted",
  "region_required",
  "region_unsupported",
  "provider_configuration_required",
] as const;

export type ProviderRpcErrorCode = (typeof PROVIDER_RPC_ERROR_CODES)[number];

export type ProviderErrorCategory =
  | "provider"
  | "model"
  | "authentication"
  | "catalog"
  | "entitlement"
  | "region"
  | "configuration";

export type ProviderErrorAction =
  | "login"
  | "logout_then_login"
  | "refresh_catalog"
  | "configure_provider"
  | "select_model"
  | "select_region"
  | "retry";

export interface ProviderRpcErrorDetails extends JsonObject {
  readonly category: ProviderErrorCategory;
  readonly action: ProviderErrorAction;
  readonly providerId?: string;
  readonly modelId?: string;
}

const PROVIDER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROTOCOL_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const AUTH_METHODS: readonly ProviderAuthMethod[] = [
  "environment",
  "file",
  "oauth",
  "ambient",
  "keyless",
];
const LOGIN_METHODS: readonly ProviderLoginMethod[] = ["api_key", "oauth"];
const AUTH_PHASES: readonly ProviderAuthenticationPhase[] = [
  "idle",
  "authorizing",
  "authenticated",
  "reauthentication_required",
  "logged_out",
];
function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, path: string, keys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new ProtocolValidationError(`${path}.${key}`, "is not allowed");
  }
}

function text(value: unknown, path: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new ProtocolValidationError(path, "must be a non-empty string");
  }
  if (new TextEncoder().encode(value).byteLength > maximum) {
    throw new ProtocolValidationError(path, `must not exceed ${maximum} UTF-8 bytes`);
  }
  return value;
}

function providerId(value: unknown, path: string): string {
  const result = text(value, path, 128);
  if (!PROVIDER_ID.test(result)) throw new ProtocolValidationError(path, "must be a provider ID");
  return result;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolValidationError(path, "must be a non-negative safe integer");
  }
  return value as number;
}

function finiteNonNegative(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ProtocolValidationError(path, "must be a finite non-negative number");
  }
  return value;
}

function uniqueEnumArray<Value extends string>(
  value: unknown,
  path: string,
  allowed: readonly Value[],
): readonly Value[] {
  if (!Array.isArray(value) || value.length > allowed.length) {
    throw new ProtocolValidationError(path, `must contain at most ${allowed.length} values`);
  }
  const result = value.map((item, index) => {
    if (!allowed.includes(item as Value)) {
      throw new ProtocolValidationError(`${path}[${index}]`, "is not supported");
    }
    return item as Value;
  });
  if (new Set(result).size !== result.length) {
    throw new ProtocolValidationError(path, "must not contain duplicates");
  }
  return result;
}

export function parseProviderAuthenticationStatus(
  value: unknown,
  path = "providerAuthenticationStatus",
): ProviderAuthenticationStatus {
  const status = object(value, path);
  exact(status, path, ["providerId", "phase", "method", "source"]);
  if (!AUTH_PHASES.includes(status.phase as ProviderAuthenticationPhase)) {
    throw new ProtocolValidationError(`${path}.phase`, "is not a valid authentication phase");
  }
  if (
    status.method !== undefined &&
    !LOGIN_METHODS.includes(status.method as ProviderLoginMethod)
  ) {
    throw new ProtocolValidationError(`${path}.method`, "is not a valid login method");
  }
  return {
    providerId: providerId(status.providerId, `${path}.providerId`),
    phase: status.phase as ProviderAuthenticationPhase,
    ...(status.method === undefined ? {} : { method: status.method as ProviderLoginMethod }),
    ...(status.source === undefined ? {} : { source: text(status.source, `${path}.source`, 256) }),
  };
}

function parseCatalogStatus(value: unknown, path: string): ProviderCatalogStatus {
  const catalog = object(value, path);
  exact(catalog, path, ["refreshable", "generation", "checkedAt", "updatedAt", "source"]);
  if (typeof catalog.refreshable !== "boolean") {
    throw new ProtocolValidationError(`${path}.refreshable`, "must be a boolean");
  }
  let source: ProviderCatalogStatus["source"];
  if (catalog.source !== undefined) {
    const candidate = object(catalog.source, `${path}.source`);
    exact(candidate, `${path}.source`, ["id", "kind", "revision"]);
    if (
      candidate.kind !== "provider_api" &&
      candidate.kind !== "entitlement" &&
      candidate.kind !== "gateway"
    ) {
      throw new ProtocolValidationError(`${path}.source.kind`, "is not a valid source kind");
    }
    const id = text(candidate.id, `${path}.source.id`, 512);
    if (!PROTOCOL_ID.test(id)) {
      throw new ProtocolValidationError(`${path}.source.id`, "must be a protocol identifier");
    }
    source = {
      id,
      kind: candidate.kind,
      ...(candidate.revision === undefined
        ? {}
        : { revision: text(candidate.revision, `${path}.source.revision`, 512) }),
    };
  }
  return {
    refreshable: catalog.refreshable,
    ...(catalog.generation === undefined
      ? {}
      : { generation: nonNegativeInteger(catalog.generation, `${path}.generation`) }),
    ...(catalog.checkedAt === undefined
      ? {}
      : { checkedAt: nonNegativeInteger(catalog.checkedAt, `${path}.checkedAt`) }),
    ...(catalog.updatedAt === undefined
      ? {}
      : { updatedAt: nonNegativeInteger(catalog.updatedAt, `${path}.updatedAt`) }),
    ...(source === undefined ? {} : { source }),
  };
}

function parseCost(value: unknown, path: string): ProviderModelCost {
  const cost = object(value, path);
  exact(cost, path, [
    "inputUsdPerMTok",
    "outputUsdPerMTok",
    "cacheReadUsdPerMTok",
    "cacheWriteUsdPerMTok",
  ]);
  return {
    inputUsdPerMTok: finiteNonNegative(cost.inputUsdPerMTok, `${path}.inputUsdPerMTok`),
    outputUsdPerMTok: finiteNonNegative(cost.outputUsdPerMTok, `${path}.outputUsdPerMTok`),
    ...(cost.cacheReadUsdPerMTok === undefined
      ? {}
      : {
          cacheReadUsdPerMTok: finiteNonNegative(
            cost.cacheReadUsdPerMTok,
            `${path}.cacheReadUsdPerMTok`,
          ),
        }),
    ...(cost.cacheWriteUsdPerMTok === undefined
      ? {}
      : {
          cacheWriteUsdPerMTok: finiteNonNegative(
            cost.cacheWriteUsdPerMTok,
            `${path}.cacheWriteUsdPerMTok`,
          ),
        }),
  };
}

function parseTextModel(value: unknown, path: string): ProviderTextModel {
  const model = object(value, path);
  exact(model, path, [
    "providerId",
    "modelId",
    "displayName",
    "apiDialect",
    "capabilities",
    "reasoning",
    "supportedThinkingLevels",
    "contextWindow",
    "maxOutputTokens",
    "cost",
    "availability",
  ]);
  const capabilities = object(model.capabilities, `${path}.capabilities`);
  exact(capabilities, `${path}.capabilities`, ["toolUse", "structuredOutput", "imageInput"]);
  for (const field of ["toolUse", "structuredOutput", "imageInput"] as const) {
    if (typeof capabilities[field] !== "boolean") {
      throw new ProtocolValidationError(`${path}.capabilities.${field}`, "must be a boolean");
    }
  }
  if (typeof model.reasoning !== "boolean") {
    throw new ProtocolValidationError(`${path}.reasoning`, "must be a boolean");
  }
  const availability = object(model.availability, `${path}.availability`);
  exact(availability, `${path}.availability`, ["status", "reason"]);
  if (
    availability.status !== "available" &&
    availability.status !== "preview" &&
    availability.status !== "deprecated" &&
    availability.status !== "unavailable"
  ) {
    throw new ProtocolValidationError(`${path}.availability.status`, "is not valid");
  }
  return {
    providerId: providerId(model.providerId, `${path}.providerId`),
    modelId: text(model.modelId, `${path}.modelId`, 512),
    displayName: text(model.displayName, `${path}.displayName`, 512),
    apiDialect: text(model.apiDialect, `${path}.apiDialect`, 128),
    capabilities: {
      toolUse: capabilities.toolUse as boolean,
      structuredOutput: capabilities.structuredOutput as boolean,
      imageInput: capabilities.imageInput as boolean,
    },
    reasoning: model.reasoning,
    supportedThinkingLevels: uniqueEnumArray(
      model.supportedThinkingLevels,
      `${path}.supportedThinkingLevels`,
      THINKING_LEVELS,
    ),
    contextWindow: nonNegativeInteger(model.contextWindow, `${path}.contextWindow`),
    maxOutputTokens: nonNegativeInteger(model.maxOutputTokens, `${path}.maxOutputTokens`),
    ...(model.cost === undefined ? {} : { cost: parseCost(model.cost, `${path}.cost`) }),
    availability: {
      status: availability.status,
      ...(availability.reason === undefined
        ? {}
        : { reason: text(availability.reason, `${path}.availability.reason`, 2_000) }),
    },
  };
}

function parseInventoryGroup(value: unknown, path: string): ProviderInventoryGroup {
  const group = object(value, path);
  exact(group, path, [
    "providerId",
    "displayName",
    "enabled",
    "regionFamily",
    "region",
    "authMethods",
    "loginMethods",
    "authentication",
    "catalog",
    "models",
    "catalogError",
  ]);
  if (typeof group.enabled !== "boolean") {
    throw new ProtocolValidationError(`${path}.enabled`, "must be a boolean");
  }
  if (!Array.isArray(group.models) || group.models.length > 5_000) {
    throw new ProtocolValidationError(`${path}.models`, "must contain at most 5000 models");
  }
  const id = providerId(group.providerId, `${path}.providerId`);
  const models = group.models.map((model, index) =>
    parseTextModel(model, `${path}.models[${index}]`),
  );
  if (models.some((model) => model.providerId !== id)) {
    throw new ProtocolValidationError(`${path}.models`, "must belong to the provider group");
  }
  let catalogError: ProviderInventoryGroup["catalogError"];
  if (group.catalogError !== undefined) {
    const error = object(group.catalogError, `${path}.catalogError`);
    exact(error, `${path}.catalogError`, ["code", "message", "action"]);
    if (error.code !== "catalog_failure") {
      throw new ProtocolValidationError(`${path}.catalogError.code`, "must be catalog_failure");
    }
    if (error.action !== "refresh_catalog" && error.action !== "configure_provider") {
      throw new ProtocolValidationError(`${path}.catalogError.action`, "is not valid");
    }
    catalogError = {
      code: error.code,
      message: text(error.message, `${path}.catalogError.message`, 2_000),
      action: error.action,
    };
  }
  return {
    providerId: id,
    displayName: text(group.displayName, `${path}.displayName`, 256),
    enabled: group.enabled,
    ...(group.regionFamily === undefined
      ? {}
      : { regionFamily: text(group.regionFamily, `${path}.regionFamily`, 128) }),
    ...(group.region === undefined ? {} : { region: text(group.region, `${path}.region`, 128) }),
    authMethods: uniqueEnumArray(group.authMethods, `${path}.authMethods`, AUTH_METHODS),
    loginMethods: uniqueEnumArray(group.loginMethods, `${path}.loginMethods`, LOGIN_METHODS),
    authentication: parseProviderAuthenticationStatus(
      group.authentication,
      `${path}.authentication`,
    ),
    catalog: parseCatalogStatus(group.catalog, `${path}.catalog`),
    models,
    ...(catalogError === undefined ? {} : { catalogError }),
  };
}

export function parseProviderListResult(value: unknown): ProviderListResult {
  const result = object(value, "providerList");
  exact(result, "providerList", ["providers"]);
  if (!Array.isArray(result.providers) || result.providers.length > 256) {
    throw new ProtocolValidationError(
      "providerList.providers",
      "must contain at most 256 providers",
    );
  }
  const providers = result.providers.map((provider, index) =>
    parseInventoryGroup(provider, `providerList.providers[${index}]`),
  );
  if (new Set(providers.map((provider) => provider.providerId)).size !== providers.length) {
    throw new ProtocolValidationError(
      "providerList.providers",
      "must not contain duplicate providers",
    );
  }
  return { providers };
}

export function parseProviderCatalogRefreshResult(value: unknown): ProviderCatalogRefreshResult {
  const result = object(value, "providerCatalogRefresh");
  exact(result, "providerCatalogRefresh", ["providers"]);
  if (!Array.isArray(result.providers) || result.providers.length > 256) {
    throw new ProtocolValidationError(
      "providerCatalogRefresh.providers",
      "must contain at most 256 providers",
    );
  }
  const providers = result.providers.map((value, index) => {
    const path = `providerCatalogRefresh.providers[${index}]`;
    const provider = object(value, path);
    exact(provider, path, ["providerId", "status", "modelCount", "error"]);
    if (
      provider.status !== "refreshed" &&
      provider.status !== "not_modified" &&
      provider.status !== "superseded" &&
      provider.status !== "unsupported" &&
      provider.status !== "failed"
    ) {
      throw new ProtocolValidationError(`${path}.status`, "is not valid");
    }
    let error: ProviderCatalogRefreshResult["providers"][number]["error"];
    if (provider.error !== undefined) {
      const candidate = object(provider.error, `${path}.error`);
      exact(candidate, `${path}.error`, ["code", "message", "action"]);
      if (
        candidate.code !== "catalog_refresh_failed" &&
        candidate.code !== "authentication_required" &&
        candidate.code !== "entitlement_required" &&
        candidate.code !== "entitlement_exhausted"
      ) {
        throw new ProtocolValidationError(`${path}.error.code`, "is not valid");
      }
      if (
        candidate.action !== "retry" &&
        candidate.action !== "login" &&
        candidate.action !== "configure_provider"
      ) {
        throw new ProtocolValidationError(`${path}.error.action`, "is not valid");
      }
      error = {
        code: candidate.code,
        message: text(candidate.message, `${path}.error.message`, 2_000),
        action: candidate.action,
      };
    }
    if ((provider.status === "failed") !== (error !== undefined)) {
      throw new ProtocolValidationError(
        `${path}.error`,
        "must be present only for failed refreshes",
      );
    }
    return {
      providerId: providerId(provider.providerId, `${path}.providerId`),
      status: provider.status as ProviderCatalogRefreshResult["providers"][number]["status"],
      modelCount: nonNegativeInteger(provider.modelCount, `${path}.modelCount`),
      ...(error === undefined ? {} : { error }),
    };
  });
  return { providers };
}

export function parseProviderAuthenticationStatusResult(
  value: unknown,
): ProviderAuthenticationStatusResult {
  const result = object(value, "providerAuthenticationStatusResult");
  exact(result, "providerAuthenticationStatusResult", ["providers"]);
  if (!Array.isArray(result.providers) || result.providers.length > 256) {
    throw new ProtocolValidationError(
      "providerAuthenticationStatusResult.providers",
      "must contain at most 256 providers",
    );
  }
  return {
    providers: result.providers.map((provider, index) =>
      parseProviderAuthenticationStatus(
        provider,
        `providerAuthenticationStatusResult.providers[${index}]`,
      ),
    ),
  };
}

export function parseProviderIdParam(value: unknown, path: string): string {
  return providerId(value, path);
}

export function parseProviderLoginMethod(value: unknown, path: string): ProviderLoginMethod {
  if (!LOGIN_METHODS.includes(value as ProviderLoginMethod)) {
    throw new ProtocolValidationError(path, "must be api_key or oauth");
  }
  return value as ProviderLoginMethod;
}

export function isProviderRpcErrorCode(value: string): value is ProviderRpcErrorCode {
  return (PROVIDER_RPC_ERROR_CODES as readonly string[]).includes(value);
}

export function parseProviderRpcErrorDetails(
  value: unknown,
  path: string,
): ProviderRpcErrorDetails {
  const details = object(value, path);
  exact(details, path, ["category", "action", "providerId", "modelId"]);
  const categories: readonly ProviderErrorCategory[] = [
    "provider",
    "model",
    "authentication",
    "catalog",
    "entitlement",
    "region",
    "configuration",
  ];
  const actions: readonly ProviderErrorAction[] = [
    "login",
    "logout_then_login",
    "refresh_catalog",
    "configure_provider",
    "select_model",
    "select_region",
    "retry",
  ];
  if (!categories.includes(details.category as ProviderErrorCategory)) {
    throw new ProtocolValidationError(`${path}.category`, "is not valid");
  }
  if (!actions.includes(details.action as ProviderErrorAction)) {
    throw new ProtocolValidationError(`${path}.action`, "is not valid");
  }
  return {
    category: details.category as ProviderErrorCategory,
    action: details.action as ProviderErrorAction,
    ...(details.providerId === undefined
      ? {}
      : { providerId: providerId(details.providerId, `${path}.providerId`) }),
    ...(details.modelId === undefined
      ? {}
      : { modelId: text(details.modelId, `${path}.modelId`, 512) }),
  };
}
