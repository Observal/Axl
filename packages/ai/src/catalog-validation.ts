// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { supportedThinkingLevels, THINKING_LEVELS as THINKING_LEVEL_LIST } from "@axl/protocol";
import type {
  EndpointPolicy,
  ModelCachePolicy,
  ModelCompatibility,
  ModelInfo,
  ModelSamplingPolicy,
} from "./model.ts";
import { safeEndpoint } from "./transport-safety.ts";

const IDENTIFIER = /^[a-z0-9@](?:[a-z0-9._:/@-]*[a-z0-9])?$/i;
const PROVIDER_IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SETTING_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/;
const SECRET_NAME = /(?:authorization|api[-_]?key|credential|password|secret|token)/i;
const FORBIDDEN_HEADER = /^(?:authorization|cookie|proxy-authorization|set-cookie|x-api-key)$/i;
const THINKING_LEVELS = new Set(THINKING_LEVEL_LIST);
const API_DIALECTS = new Set([
  "openai-chat",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
  "mistral-conversations",
  "gateway-messages",
  "fake",
]);
const AVAILABILITY_STATUSES = new Set(["available", "preview", "deprecated", "unavailable"]);
const RETENTIONS = new Set(["none", "short", "long"]);
const SAMPLING_OPTIONS = new Set([
  "temperature",
  "topP",
  "topK",
  "minP",
  "frequencyPenalty",
  "presencePenalty",
  "repetitionPenalty",
  "seed",
]);
const MODEL_FIELDS = new Set([
  "providerId",
  "modelId",
  "displayName",
  "apiDialect",
  "capabilities",
  "reasoning",
  "thinkingLevelMap",
  "contextWindow",
  "maxOutputTokens",
  "cost",
  "cache",
  "sampling",
  "endpoint",
  "availability",
  "headers",
  "compatibility",
]);
const CAPABILITY_FIELDS = new Set(["toolUse", "structuredOutput", "imageInput"]);
const COST_FIELDS = new Set([
  "inputUsdPerMTok",
  "outputUsdPerMTok",
  "cacheReadUsdPerMTok",
  "cacheWriteUsdPerMTok",
  "tiers",
]);
const COST_TIER_FIELDS = new Set(
  [...COST_FIELDS].filter((field) => field !== "tiers").concat("inputTokensAbove"),
);
const CACHE_FIELDS = new Set(["supported", "defaultRetention", "supportedRetentions"]);
const SAMPLING_FIELDS = new Set(["supported", "customFields"]);
const AVAILABILITY_FIELDS = new Set(["status", "reason"]);
const ENDPOINT_FIELDS = {
  fixed: new Set(["type", "baseUrl"]),
  configured: new Set(["type", "baseUrlSetting", "defaultBaseUrl"]),
  template: new Set(["type", "template", "variables"]),
} as const;
const ENDPOINT_VARIABLE_FIELDS = new Set(["name", "setting", "required", "defaultValue"]);
const COMPATIBILITY_FIELDS = new Set([
  "dialect",
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "supportsFinishReason",
  "maxTokensField",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "thinkingFormat",
  "thinkingTokenBudgetField",
  "supportsGrammarTools",
  "supportsStrictTools",
  "cacheControlFormat",
  "sessionAffinityFormat",
  "supportsLongCacheRetention",
  "supportsMaxOutputTokens",
  "routing",
  "supportsCacheControlOnTools",
  "supportsTemperature",
  "forceAdaptiveThinking",
  "allowEmptyThinkingSignature",
  "supportsPromptCacheMarkers",
  "supportsThinkingSignatures",
]);
const ROUTING_FIELDS = new Set([
  "only",
  "order",
  "ignore",
  "allowFallbacks",
  "requireParameters",
  "dataCollection",
  "zeroDataRetention",
  "sort",
]);

function rejectUnknownFields(
  value: object,
  allowed: ReadonlySet<string>,
  label: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} has unknown field ${JSON.stringify(key)}`);
  }
}

export interface BuiltinCatalogProvider {
  readonly id: string;
  readonly displayName: string;
  readonly catalogKind: "static" | "dynamic" | "configured";
  readonly regionFamily?: string;
  readonly region?: string;
}

export interface CatalogProvenance {
  readonly generatedAt: string;
  readonly sources: readonly {
    readonly name: string;
    readonly location: string;
    readonly retrievedAt: string;
    readonly sha256?: string;
    readonly revision?: string;
    readonly license: string;
  }[];
}

export class ModelCatalogValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`Invalid model catalog:\n${errors.map((error) => `  * ${error}`).join("\n")}`);
    this.name = "ModelCatalogValidationError";
    this.errors = errors;
  }
}

function validUrl(value: string, label: string, errors: string[]): void {
  try {
    safeEndpoint(value, { label, allowLoopbackHttp: true });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : `${label} is not a valid URL`);
  }
}

function collectEndpointErrors(endpoint: EndpointPolicy, label: string, errors: string[]): void {
  rejectUnknownFields(endpoint, ENDPOINT_FIELDS[endpoint.type], `${label} endpoint`, errors);
  if (endpoint.type === "fixed") {
    validUrl(endpoint.baseUrl, `${label} endpoint`, errors);
    return;
  }
  if (endpoint.type === "configured") {
    if (!SETTING_IDENTIFIER.test(endpoint.baseUrlSetting)) {
      errors.push(`${label} has an invalid endpoint setting`);
    }
    if (SECRET_NAME.test(endpoint.baseUrlSetting)) {
      errors.push(`${label} endpoint setting must not name a credential`);
    }
    if (endpoint.defaultBaseUrl !== undefined) {
      validUrl(endpoint.defaultBaseUrl, `${label} default endpoint`, errors);
    }
    return;
  }

  const names = new Set<string>();
  for (const variable of endpoint.variables) {
    rejectUnknownFields(variable, ENDPOINT_VARIABLE_FIELDS, `${label} endpoint variable`, errors);
    if (!PROVIDER_IDENTIFIER.test(variable.name) || names.has(variable.name)) {
      errors.push(`${label} has an invalid or duplicate endpoint variable ${variable.name}`);
    }
    names.add(variable.name);
    if (!SETTING_IDENTIFIER.test(variable.setting) || SECRET_NAME.test(variable.setting)) {
      errors.push(`${label} endpoint variable ${variable.name} has an unsafe setting`);
    }
    const occurrences = endpoint.template.split(`{${variable.name}}`).length - 1;
    if (occurrences === 0) errors.push(`${label} endpoint does not use variable ${variable.name}`);
    if (!variable.required && variable.defaultValue === undefined) {
      errors.push(`${label} optional endpoint variable ${variable.name} needs a default`);
    }
  }
  const placeholders = [...endpoint.template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
  if (placeholders.some((name) => name === undefined || !names.has(name))) {
    errors.push(`${label} endpoint contains an undeclared variable`);
  }
  validUrl(
    endpoint.template.replaceAll(/\{[^{}]+\}/g, "catalog-value"),
    `${label} endpoint template`,
    errors,
  );
}

export function validateEndpointPolicy(endpoint: EndpointPolicy, label = "catalog"): void {
  const errors: string[] = [];
  collectEndpointErrors(endpoint, label, errors);
  if (errors.length > 0) throw new ModelCatalogValidationError(errors);
}

function validateCost(model: ModelInfo, label: string, errors: string[]): void {
  if (model.cost === undefined) return;
  rejectUnknownFields(model.cost, COST_FIELDS, `${label} cost`, errors);
  const rates = [
    model.cost.inputUsdPerMTok,
    model.cost.outputUsdPerMTok,
    model.cost.cacheReadUsdPerMTok,
    model.cost.cacheWriteUsdPerMTok,
  ];
  if (rates.some((rate) => rate !== undefined && (!Number.isFinite(rate) || rate < 0))) {
    errors.push(`${label} has invalid pricing`);
  }
  let threshold = -1;
  for (const tier of model.cost.tiers ?? []) {
    rejectUnknownFields(tier, COST_TIER_FIELDS, `${label} cost tier`, errors);
    if (!Number.isSafeInteger(tier.inputTokensAbove) || tier.inputTokensAbove <= threshold) {
      errors.push(`${label} has unsorted or invalid price tiers`);
    }
    threshold = tier.inputTokensAbove;
    if (
      [
        tier.inputUsdPerMTok,
        tier.outputUsdPerMTok,
        tier.cacheReadUsdPerMTok,
        tier.cacheWriteUsdPerMTok,
      ].some((rate) => rate !== undefined && (!Number.isFinite(rate) || rate < 0))
    ) {
      errors.push(`${label} has invalid tier pricing`);
    }
  }
}

function validateCache(cache: ModelCachePolicy, label: string, errors: string[]): void {
  rejectUnknownFields(cache, CACHE_FIELDS, `${label} cache`, errors);
  if (!RETENTIONS.has(cache.defaultRetention) || cache.supportedRetentions.length === 0) {
    errors.push(`${label} has invalid cache retention metadata`);
    return;
  }
  const retentions = new Set(cache.supportedRetentions);
  if (
    retentions.size !== cache.supportedRetentions.length ||
    !retentions.has(cache.defaultRetention)
  ) {
    errors.push(`${label} has inconsistent cache retentions`);
  }
  if (cache.supported && !retentions.has("none")) {
    errors.push(`${label} cache policy must allow no retention`);
  }
  if (!cache.supported && (cache.defaultRetention !== "none" || retentions.size !== 1)) {
    errors.push(`${label} unsupported cache policy must contain only none`);
  }
}

function validateSampling(sampling: ModelSamplingPolicy, label: string, errors: string[]): void {
  if (typeof sampling !== "object" || sampling === null || Array.isArray(sampling)) {
    errors.push(`${label} has invalid sampling support`);
    return;
  }
  rejectUnknownFields(sampling, SAMPLING_FIELDS, `${label} sampling`, errors);
  if (!Array.isArray(sampling.supported)) {
    errors.push(`${label} has invalid sampling support`);
    return;
  }
  const supported = new Set(sampling.supported);
  if (
    supported.size !== sampling.supported.length ||
    sampling.supported.some((option) => !SAMPLING_OPTIONS.has(option))
  ) {
    errors.push(`${label} has invalid sampling support`);
  }
  if (
    sampling.customFields !== undefined &&
    (!Array.isArray(sampling.customFields) ||
      new Set(sampling.customFields).size !== sampling.customFields.length ||
      sampling.customFields.some(
        (field) =>
          typeof field !== "string" || field.trim().length === 0 || forbiddenMetadataName(field),
      ))
  ) {
    errors.push(`${label} has invalid custom sampling fields`);
  }
}

function forbiddenMetadataName(name: string): boolean {
  const normalized = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return ["authorization", "cookie", "credential", "password", "secret", "token", "apikey"].some(
    (forbidden) => normalized === forbidden || normalized.endsWith(forbidden),
  );
}

function validateCompatibility(
  compatibility: ModelCompatibility,
  model: ModelInfo,
  label: string,
  errors: string[],
): void {
  rejectUnknownFields(compatibility, COMPATIBILITY_FIELDS, `${label} compatibility`, errors);
  if (compatibility.dialect !== model.apiDialect) {
    errors.push(`${label} compatibility dialect does not match its API dialect`);
  }
  if ("routing" in compatibility && compatibility.routing !== undefined) {
    rejectUnknownFields(compatibility.routing, ROUTING_FIELDS, `${label} routing`, errors);
  }
}

export function validateModelCatalog(models: readonly ModelInfo[]): readonly ModelInfo[] {
  const errors: string[] = [];
  const identities = new Set<string>();
  for (const model of models) {
    const label = `${model.providerId}/${model.modelId}`;
    rejectUnknownFields(model, MODEL_FIELDS, label, errors);
    rejectUnknownFields(model.capabilities, CAPABILITY_FIELDS, `${label} capabilities`, errors);
    if (!PROVIDER_IDENTIFIER.test(model.providerId))
      errors.push(`${label} has an invalid provider ID`);
    if (!IDENTIFIER.test(model.modelId) || model.modelId.length > 256) {
      errors.push(`${label} has an invalid model ID`);
    }
    if (identities.has(label)) errors.push(`${label} is duplicated`);
    identities.add(label);
    if (model.displayName.trim().length === 0 || model.displayName !== model.displayName.trim()) {
      errors.push(`${label} has an invalid display name`);
    }
    const legacyCompatibility =
      model.compatibility !== undefined &&
      !("dialect" in model.compatibility && typeof model.compatibility.dialect === "string");
    if (!API_DIALECTS.has(model.apiDialect) && !legacyCompatibility)
      errors.push(`${label} has an invalid API dialect`);
    if (
      typeof model.capabilities.toolUse !== "boolean" ||
      typeof model.capabilities.structuredOutput !== "boolean" ||
      typeof model.capabilities.imageInput !== "boolean"
    ) {
      errors.push(`${label} has invalid capabilities`);
    }
    if (typeof model.reasoning !== "boolean")
      errors.push(`${label} has invalid reasoning metadata`);
    if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) {
      errors.push(`${label} has an invalid context window`);
    }
    if (
      !Number.isSafeInteger(model.maxOutputTokens) ||
      model.maxOutputTokens <= 0 ||
      model.maxOutputTokens > model.contextWindow
    ) {
      errors.push(`${label} has an invalid output limit`);
    }
    if (!model.reasoning && model.thinkingLevelMap !== undefined) {
      errors.push(`${label} has a reasoning map but no reasoning capability`);
    }
    if (model.thinkingLevelMap !== undefined) {
      const map = model.thinkingLevelMap;
      if (typeof map !== "object" || map === null || Array.isArray(map)) {
        errors.push(`${label} has an invalid reasoning map`);
      } else {
        for (const [level, value] of Object.entries(map)) {
          if (
            !THINKING_LEVELS.has(level) ||
            (value !== null && (typeof value !== "string" || value.trim().length === 0))
          ) {
            errors.push(`${label} has an invalid reasoning map`);
          }
        }
        if (supportedThinkingLevels(model).length === 0) {
          errors.push(`${label} has no supported thinking level`);
        }
      }
    }
    validateCost(model, label, errors);
    if (model.cache !== undefined) {
      validateCache(model.cache, label, errors);
      if (
        !model.cache.supported &&
        ((model.cost?.cacheReadUsdPerMTok ?? 0) > 0 || (model.cost?.cacheWriteUsdPerMTok ?? 0) > 0)
      ) {
        errors.push(`${label} has cache pricing but caching is unsupported`);
      }
    }
    if (model.sampling !== undefined) validateSampling(model.sampling, label, errors);
    if (model.availability !== undefined) {
      rejectUnknownFields(model.availability, AVAILABILITY_FIELDS, `${label} availability`, errors);
    }
    if (
      model.availability !== undefined &&
      (!AVAILABILITY_STATUSES.has(model.availability.status) ||
        (model.availability.reason !== undefined && model.availability.reason.trim().length === 0))
    ) {
      errors.push(`${label} has invalid availability metadata`);
    }
    if (model.endpoint !== undefined) collectEndpointErrors(model.endpoint, label, errors);
    if (model.compatibility !== undefined) {
      if ("dialect" in model.compatibility && typeof model.compatibility.dialect === "string") {
        validateCompatibility(model.compatibility as ModelCompatibility, model, label, errors);
      } else if (
        Object.entries(model.compatibility).some(
          ([name, value]) => forbiddenMetadataName(name) || typeof value !== "boolean",
        )
      ) {
        errors.push(`${label} has invalid legacy compatibility metadata`);
      }
    }
    for (const [name, value] of Object.entries(model.headers ?? {})) {
      if (
        FORBIDDEN_HEADER.test(name) ||
        forbiddenMetadataName(name) ||
        /[\r\n]/.test(name) ||
        /[\r\n]/.test(value)
      ) {
        errors.push(`${label} contains an unsafe static header`);
      }
    }
  }
  if (errors.length > 0) throw new ModelCatalogValidationError(errors);
  return models;
}
