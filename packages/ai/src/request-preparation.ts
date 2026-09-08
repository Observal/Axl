// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { BlobReference, JsonObject, ThinkingLevel } from "@axl/protocol";

import { assertModelSupports } from "./capabilities.ts";
import {
  FrozenToolRoster,
  GENERIC_TOOL_DIALECT,
  OPENAI_CHAT_TOOL_DIALECT,
  renderToolName,
  type ToolDialectData,
} from "./dialect.ts";
import type {
  ApiDialect,
  CacheRetention,
  ModelInfo,
  ModelRequest,
  ProviderContinuationMetadata,
  ProviderModelIdentity,
  ProviderSignature,
  RequestAssistantContent,
  RequestModelMessage,
  RequestToolCall,
  RequestToolDeclaration,
  SamplingOptionName,
  SamplingOptions,
} from "./model.ts";
import { clampThinkingLevel, fitThinkingBudget } from "./thinking.ts";

const FORBIDDEN_METADATA_KEYS = [
  "authorization",
  "cookie",
  "credential",
  "password",
  "secret",
  "token",
  "apikey",
] as const;
const PORTABLE_TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MISTRAL_TOOL_CALL_ID = /^[A-Za-z0-9]{9}$/;

export class RequestPreparationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path} ${message}`);
    this.name = "RequestPreparationError";
    this.path = path;
  }
}

export interface PreparedBlob {
  readonly reference: BlobReference;
  readonly bytes: Uint8Array;
}

export type PreparedToolConstraint =
  | { readonly type: "json-schema"; readonly strict: boolean }
  | {
      readonly type: "grammar";
      readonly format: "lark" | "regex";
      readonly definition: string;
      readonly inputProperty: string;
    };

export interface PreparedToolDeclaration extends RequestToolDeclaration {
  readonly canonicalName: string;
  readonly preparedConstraint?: PreparedToolConstraint;
}

export interface PreparedToolCall extends RequestToolCall {
  readonly canonicalCallId: string;
  readonly canonicalName: string;
}

export type PreparedRequestMessage =
  | Extract<RequestModelMessage, { role: "user" }>
  | (Omit<Extract<RequestModelMessage, { role: "assistant" }>, "toolCalls"> & {
      readonly toolCalls?: readonly PreparedToolCall[];
    })
  | (Extract<RequestModelMessage, { role: "tool" }> & {
      readonly canonicalCallId: string;
      readonly canonicalName: string;
    });

export interface CachePlacement {
  readonly target: "system" | "tool" | "message-content";
  readonly toolIndex?: number;
  readonly messageIndex?: number;
  readonly contentIndex?: number;
}

export interface PreparedReasoning {
  readonly requested: ThinkingLevel;
  readonly effective: ThinkingLevel;
  readonly clamped: boolean;
  readonly providerValue?: string;
  readonly tokenBudget?: number;
  readonly maxTokens?: number;
}

export interface RequestSanitization {
  readonly path: string;
  readonly reason: "foreign-provider-signature" | "foreign-provider-continuation";
}

export interface RequestPreparation {
  readonly blobs: ReadonlyMap<string, PreparedBlob>;
  readonly tools: readonly PreparedToolDeclaration[];
  readonly reasoning?: PreparedReasoning;
  readonly cache: {
    readonly retention: CacheRetention;
    readonly sessionId?: string;
    readonly placements: readonly CachePlacement[];
  };
  readonly sanitizations: readonly RequestSanitization[];
}

export interface PreparedModelRequest extends Omit<ModelRequest, "messages" | "tools"> {
  readonly messages: readonly PreparedRequestMessage[];
  readonly tools?: readonly PreparedToolDeclaration[];
  readonly preparation: RequestPreparation;
}

function fail(path: string, message: string): never {
  throw new RequestPreparationError(path, message);
}

function exactKeys(value: object, allowed: readonly string[], path: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) fail(`${path}.${key}`, "is not supported");
  }
}

function nonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0)
    fail(path, "must be a non-empty string");
}

function finite(value: number | undefined, path: string, minimum: number, maximum: number): void {
  if (value !== undefined && (!Number.isFinite(value) || value < minimum || value > maximum)) {
    fail(path, `must be between ${minimum} and ${maximum}`);
  }
}

function forbiddenMetadataKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return FORBIDDEN_METADATA_KEYS.some(
    (forbidden) => normalized === forbidden || normalized.endsWith(forbidden),
  );
}

function validateJson(
  value: unknown,
  path: string,
  ancestors = new Set<object>(),
  rejectAuthorizationData = false,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") fail(path, "must be JSON-compatible");
  if (ancestors.has(value)) fail(path, "must not contain cycles");
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateJson(item, `${path}[${index}]`, next, rejectAuthorizationData);
    });
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "must be a plain object");
  for (const [key, item] of Object.entries(value)) {
    if (rejectAuthorizationData && forbiddenMetadataKey(key)) {
      fail(`${path}.${key}`, "must not contain authorization data");
    }
    validateJson(item, `${path}.${key}`, next, rejectAuthorizationData);
  }
}

function validateMetadata(metadata: ModelRequest["metadata"]): void {
  if (metadata === undefined) return;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    fail("request.metadata", "must be an object");
  }
  validateJson(metadata, "request.metadata", new Set(), true);
}

const GOOGLE_SAFETY_CATEGORIES = new Set([
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
]);
const GOOGLE_SAFETY_THRESHOLDS = new Set([
  "BLOCK_NONE",
  "BLOCK_LOW_AND_ABOVE",
  "BLOCK_MEDIUM_AND_ABOVE",
  "BLOCK_ONLY_HIGH",
  "OFF",
]);

function prepareSafetySettings(
  model: ModelInfo,
  settings: ModelRequest["safetySettings"],
): ModelRequest["safetySettings"] {
  if (settings === undefined) return undefined;
  if (model.apiDialect !== "google-generative-ai") {
    fail("request.safetySettings", "is unsupported by this model dialect");
  }
  if (!Array.isArray(settings)) fail("request.safetySettings", "must be an array");
  const categories = new Set<string>();
  return Object.freeze(
    settings.map((setting, index) => {
      const path = `request.safetySettings[${index}]`;
      if (typeof setting !== "object" || setting === null || Array.isArray(setting)) {
        fail(path, "must be an object");
      }
      exactKeys(setting, ["category", "threshold"], path);
      if (!GOOGLE_SAFETY_CATEGORIES.has(setting.category)) {
        fail(`${path}.category`, "is not recognized");
      }
      if (!GOOGLE_SAFETY_THRESHOLDS.has(setting.threshold)) {
        fail(`${path}.threshold`, "is not recognized");
      }
      if (categories.has(setting.category)) fail(`${path}.category`, "is duplicated");
      categories.add(setting.category);
      return Object.freeze({ category: setting.category, threshold: setting.threshold });
    }),
  );
}

const DEFAULT_SAMPLING_SUPPORT: Readonly<Record<string, readonly SamplingOptionName[]>> = {
  "openai-chat": ["temperature", "topP", "frequencyPenalty", "presencePenalty", "seed"],
  "openai-responses": ["temperature", "topP"],
  "azure-openai-responses": ["temperature", "topP"],
  "openai-codex-responses": ["temperature", "topP"],
  "anthropic-messages": ["temperature", "topP", "topK"],
  "google-generative-ai": ["temperature", "topP", "topK", "seed"],
  "google-vertex": ["temperature", "topP", "topK", "seed"],
  "bedrock-converse-stream": ["temperature", "topP"],
  "mistral-conversations": ["temperature", "topP", "frequencyPenalty", "presencePenalty", "seed"],
  "gateway-messages": [],
  fake: [
    "temperature",
    "topP",
    "topK",
    "minP",
    "frequencyPenalty",
    "presencePenalty",
    "repetitionPenalty",
    "seed",
  ],
};

function prepareSampling(
  model: ModelInfo,
  sampling: SamplingOptions | undefined,
): SamplingOptions | undefined {
  if (sampling === undefined) return undefined;
  if (typeof sampling !== "object" || sampling === null || Array.isArray(sampling)) {
    fail("request.sampling", "must be an object");
  }
  exactKeys(
    sampling,
    [
      "temperature",
      "topP",
      "topK",
      "minP",
      "frequencyPenalty",
      "presencePenalty",
      "repetitionPenalty",
      "seed",
      "custom",
    ],
    "request.sampling",
  );
  finite(sampling.temperature, "request.sampling.temperature", 0, 2);
  finite(sampling.topP, "request.sampling.topP", 0, 1);
  finite(sampling.minP, "request.sampling.minP", 0, 1);
  finite(sampling.frequencyPenalty, "request.sampling.frequencyPenalty", -2, 2);
  finite(sampling.presencePenalty, "request.sampling.presencePenalty", -2, 2);
  finite(sampling.repetitionPenalty, "request.sampling.repetitionPenalty", 0, Number.MAX_VALUE);
  if (sampling.topK !== undefined && (!Number.isSafeInteger(sampling.topK) || sampling.topK < 1)) {
    fail("request.sampling.topK", "must be a positive safe integer");
  }
  if (sampling.seed !== undefined && !Number.isSafeInteger(sampling.seed)) {
    fail("request.sampling.seed", "must be a safe integer");
  }
  if (sampling.custom !== undefined) {
    validateJson(sampling.custom, "request.sampling.custom", new Set(), true);
  }
  const supported = new Set(
    model.sampling?.supported ?? DEFAULT_SAMPLING_SUPPORT[model.apiDialect] ?? [],
  );
  for (const option of [
    "temperature",
    "topP",
    "topK",
    "minP",
    "frequencyPenalty",
    "presencePenalty",
    "repetitionPenalty",
    "seed",
  ] as const) {
    if (sampling[option] !== undefined && !supported.has(option)) {
      fail(`request.sampling.${option}`, "is unsupported by this model");
    }
  }
  if (sampling.custom !== undefined) {
    const customFields = new Set(model.sampling?.customFields ?? []);
    for (const field of Object.keys(sampling.custom)) {
      if (!customFields.has(field))
        fail(`request.sampling.custom.${field}`, "is unsupported by this model");
    }
  }
  return Object.freeze({
    ...sampling,
    ...(sampling.custom === undefined ? {} : { custom: structuredClone(sampling.custom) }),
  });
}

function targetIdentity(model: ModelInfo): ProviderModelIdentity {
  return { providerId: model.providerId, apiDialect: model.apiDialect, modelId: model.modelId };
}

function matchesTarget(metadata: ProviderModelIdentity, target: ProviderModelIdentity): boolean {
  return (
    metadata.providerId === target.providerId &&
    metadata.apiDialect === target.apiDialect &&
    metadata.modelId === target.modelId
  );
}

function validateIdentity(value: ProviderModelIdentity, path: string): void {
  exactKeys(value, ["providerId", "apiDialect", "modelId"], path);
  nonEmpty(value.providerId, `${path}.providerId`);
  nonEmpty(value.apiDialect, `${path}.apiDialect`);
  nonEmpty(value.modelId, `${path}.modelId`);
}

function keepSignature(
  signature: ProviderSignature | undefined,
  target: ProviderModelIdentity,
  path: string,
  sanitizations: RequestSanitization[],
): ProviderSignature | undefined {
  if (signature === undefined) return undefined;
  exactKeys(signature, ["providerId", "apiDialect", "modelId", "value"], path);
  nonEmpty(signature.providerId, `${path}.providerId`);
  nonEmpty(signature.apiDialect, `${path}.apiDialect`);
  nonEmpty(signature.modelId, `${path}.modelId`);
  nonEmpty(signature.value, `${path}.value`);
  if (matchesTarget(signature, target)) return Object.freeze({ ...signature });
  sanitizations.push({ path, reason: "foreign-provider-signature" });
  return undefined;
}

function keepContinuation(
  continuation: ProviderContinuationMetadata | undefined,
  target: ProviderModelIdentity,
  path: string,
  sanitizations: RequestSanitization[],
): ProviderContinuationMetadata | undefined {
  if (continuation === undefined) return undefined;
  exactKeys(
    continuation,
    ["providerId", "apiDialect", "modelId", "responseId", "itemId", "namespace"],
    path,
  );
  nonEmpty(continuation.providerId, `${path}.providerId`);
  nonEmpty(continuation.apiDialect, `${path}.apiDialect`);
  nonEmpty(continuation.modelId, `${path}.modelId`);
  for (const [key, value] of Object.entries(continuation)) {
    if (key === "providerId" || key === "apiDialect" || key === "modelId") continue;
    if (value !== undefined) nonEmpty(value, `${path}.${key}`);
  }
  if (matchesTarget(continuation, target)) return Object.freeze({ ...continuation });
  sanitizations.push({ path, reason: "foreign-provider-continuation" });
  return undefined;
}

function toolCallIdRule(apiDialect: ApiDialect): RegExp {
  return apiDialect === "mistral-conversations" ? MISTRAL_TOOL_CALL_ID : PORTABLE_TOOL_CALL_ID;
}

function normalizedToolCallId(id: string, apiDialect: ApiDialect, occupied: Set<string>): string {
  const rule = toolCallIdRule(apiDialect);
  if (rule.test(id) && !occupied.has(id)) return id;
  const digest = createHash("sha256").update(id).digest("hex");
  const prefix = apiDialect === "mistral-conversations" ? "" : "call_";
  const length = apiDialect === "mistral-conversations" ? 9 : 64;
  for (let counter = 0; counter < 1000; counter += 1) {
    const candidateDigest =
      counter === 0 ? digest : createHash("sha256").update(`${id}:${counter}`).digest("hex");
    const candidate = `${prefix}${candidateDigest}`.slice(0, length);
    if (!occupied.has(candidate)) return candidate;
  }
  return fail("request.messages", "contains too many colliding tool call identifiers");
}

function toolDialectFor(apiDialect: ApiDialect): ToolDialectData {
  if (
    apiDialect === "openai-chat" ||
    apiDialect === "openai-responses" ||
    apiDialect === "azure-openai-responses" ||
    apiDialect === "openai-codex-responses" ||
    apiDialect === "anthropic-messages" ||
    apiDialect === "bedrock-converse-stream"
  ) {
    return { ...OPENAI_CHAT_TOOL_DIALECT, id: apiDialect };
  }
  return { ...GENERIC_TOOL_DIALECT, id: apiDialect };
}

interface JsonSchemaNode {
  [key: string]: unknown;
  type?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  required?: unknown;
}

const UNSUPPORTED_STRICT_KEYS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "allOf",
  "oneOf",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "prefixItems",
  "not",
  "if",
  "then",
  "else",
]);

function schemaObject(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structuredSchema(schema: unknown): boolean {
  if (!schemaObject(schema)) return false;
  const types =
    typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
  return (
    types.includes("object") ||
    types.includes("array") ||
    schema.properties !== undefined ||
    schema.items !== undefined
  );
}

function schemaAllowsNull(schema: unknown): boolean {
  if (!schemaObject(schema)) return false;
  if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null")))
    return true;
  if (schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null)))
    return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.some(schemaAllowsNull);
}

function makeStrictNode(schema: unknown, path: string): void {
  if (!schemaObject(schema)) fail(path, "uses an unsupported boolean schema");
  for (const key of Object.keys(schema)) {
    if (UNSUPPORTED_STRICT_KEYS.has(key))
      fail(`${path}.${key}`, "is unsupported in strict schemas");
  }
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0)
      fail(`${path}.anyOf`, "must not be empty");
    schema.anyOf.forEach((variant, index) => {
      if (structuredSchema(variant)) {
        fail(`${path}.anyOf[${index}]`, "uses an unsupported structured union");
      }
      makeStrictNode(variant, `${path}.anyOf[${index}]`);
    });
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items))
      fail(`${path}.items`, "tuple schemas are unsupported in strict mode");
    makeStrictNode(schema.items, `${path}.items`);
  }
  if (schema.type !== "object") {
    if (schema.properties !== undefined) fail(`${path}.properties`, "requires type object");
    return;
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    fail(`${path}.additionalProperties`, "must be false in strict mode");
  }
  if (schema.properties !== undefined && !schemaObject(schema.properties)) {
    fail(`${path}.properties`, "must be a schema map");
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))
  ) {
    fail(`${path}.required`, "must be a string array");
  }
  const properties = schema.properties ?? {};
  const names = Object.keys(properties);
  const requiredValues = Array.isArray(schema.required) ? schema.required : [];
  const required = new Set(requiredValues);
  if (required.size !== requiredValues.length)
    fail(`${path}.required`, "must not contain duplicates");
  for (const name of required) {
    if (!names.includes(name))
      fail(`${path}.required`, `contains unknown property ${String(name)}`);
  }
  for (const [name, property] of Object.entries(properties)) {
    makeStrictNode(property, `${path}.properties.${name}`);
    if (!required.has(name) && !schemaAllowsNull(property)) {
      properties[name] = { anyOf: [property, { type: "null" }] };
    }
  }
  schema.required = names;
  schema.additionalProperties = false;
}

function strictSchema(schema: JsonObject, path: string): JsonObject {
  validateJson(schema, path);
  const clone = structuredClone(schema) as JsonObject;
  makeStrictNode(clone, path);
  if (clone.type !== "object") fail(path, "must have object at its root for strict mode");
  return clone;
}

function strictToolSupport(model: ModelInfo): boolean {
  const compatibility = model.compatibility;
  if (compatibility === undefined) return false;
  if (
    compatibility.dialect === "openai-chat" ||
    compatibility.dialect === "openai-responses" ||
    compatibility.dialect === "azure-openai-responses" ||
    compatibility.dialect === "openai-codex-responses" ||
    compatibility.dialect === "anthropic-messages" ||
    compatibility.dialect === "google-generative-ai" ||
    compatibility.dialect === "google-vertex" ||
    compatibility.dialect === "bedrock-converse-stream" ||
    compatibility.dialect === "mistral-conversations" ||
    compatibility.dialect === "gateway-messages"
  ) {
    return compatibility.supportsStrictTools === true;
  }
  return false;
}

function grammarToolSupport(model: ModelInfo): boolean {
  const compatibility = model.compatibility;
  return (
    compatibility !== undefined &&
    (compatibility.dialect === "openai-chat" ||
      compatibility.dialect === "openai-responses" ||
      compatibility.dialect === "azure-openai-responses" ||
      compatibility.dialect === "openai-codex-responses") &&
    compatibility.supportsGrammarTools === true
  );
}

function grammarInputProperty(schema: JsonObject, path: string): string {
  if (schema.type !== "object") fail(path, "requires an object schema");
  if (!Array.isArray(schema.required) || schema.required.length !== 1) {
    fail(path, "requires exactly one required string property");
  }
  const property = schema.required[0];
  if (typeof property !== "string") fail(`${path}.required[0]`, "must be a string");
  const properties = schema.properties;
  if (!schemaObject(properties) || !schemaObject(properties[property])) {
    fail(path, `requires a schema for property ${property}`);
  }
  if (properties[property].type !== "string") fail(path, `requires ${property} to be a string`);
  return property;
}

function prepareTools(
  model: ModelInfo,
  requestTools: readonly RequestToolDeclaration[] | undefined,
  dialect?: ToolDialectData,
): readonly PreparedToolDeclaration[] {
  if (requestTools === undefined || requestTools.length === 0) return Object.freeze([]);
  const roster = new FrozenToolRoster(dialect ?? toolDialectFor(model.apiDialect), requestTools);
  return Object.freeze(
    roster.tools.map((visible, index) => {
      const source = requestTools[index];
      if (source === undefined) return fail(`request.tools[${index}]`, "is missing");
      const path = `request.tools[${index}]`;
      exactKeys(source, ["name", "description", "inputSchema", "constraint"], path);
      nonEmpty(source.name, `${path}.name`);
      nonEmpty(source.description, `${path}.description`);
      if (source.constraint !== undefined) {
        if (source.constraint.type !== "grammar" && source.constraint.type !== "json-schema") {
          fail(`${path}.constraint.type`, "is not recognized");
        }
        exactKeys(
          source.constraint,
          source.constraint.type === "grammar" ? ["type", "variants"] : ["type", "strict"],
          `${path}.constraint`,
        );
        if (source.constraint.type === "grammar") {
          if (
            typeof source.constraint.variants !== "object" ||
            source.constraint.variants === null ||
            Array.isArray(source.constraint.variants)
          ) {
            fail(`${path}.constraint.variants`, "must be an object");
          }
          exactKeys(source.constraint.variants, ["lark", "regex"], `${path}.constraint.variants`);
          for (const [format, definition] of Object.entries(source.constraint.variants)) {
            if (typeof definition !== "string") {
              fail(`${path}.constraint.variants.${format}`, "must be a string");
            }
          }
        } else if (
          source.constraint.strict !== "prefer" &&
          source.constraint.strict !== "require"
        ) {
          fail(`${path}.constraint.strict`, "must be prefer or require");
        }
      }
      validateJson(visible.inputSchema, `${path}.inputSchema`);
      let inputSchema = structuredClone(visible.inputSchema);
      let constraint: PreparedToolConstraint | undefined;
      if (source.constraint?.type === "json-schema") {
        if (!strictToolSupport(model)) {
          if (source.constraint.strict === "require") {
            fail(
              `request.tools[${index}].constraint`,
              "requires strict schemas unsupported by this model",
            );
          }
          constraint = { type: "json-schema", strict: false };
        } else {
          try {
            inputSchema = strictSchema(inputSchema, `request.tools[${index}].inputSchema`);
            constraint = { type: "json-schema", strict: true };
          } catch (error) {
            if (source.constraint.strict === "require") throw error;
            constraint = { type: "json-schema", strict: false };
          }
        }
      } else if (source.constraint?.type === "grammar") {
        if (!grammarToolSupport(model)) {
          fail(
            `request.tools[${index}].constraint`,
            "requires grammar tools unsupported by this model",
          );
        }
        const lark = source.constraint.variants.lark?.trim();
        const regex = source.constraint.variants.regex?.trim();
        if (!lark && !regex)
          fail(`request.tools[${index}].constraint`, "has no usable grammar variant");
        constraint = {
          type: "grammar",
          format: lark ? "lark" : "regex",
          definition: lark ?? (regex as string),
          inputProperty: grammarInputProperty(inputSchema, `request.tools[${index}].inputSchema`),
        };
      }
      return Object.freeze({
        name: visible.name,
        canonicalName: visible.canonicalName,
        description: visible.description,
        inputSchema,
        ...(source.constraint === undefined
          ? {}
          : { constraint: structuredClone(source.constraint) }),
        ...(constraint === undefined ? {} : { preparedConstraint: constraint }),
      });
    }),
  );
}

function prepareReasoning(model: ModelInfo, request: ModelRequest): PreparedReasoning | undefined {
  if (request.thinkingLevel === undefined) return undefined;
  const clamp = clampThinkingLevel(model, request.thinkingLevel);
  if (clamp.effective === "off") return Object.freeze(clamp);
  const providerValue = model.thinkingLevelMap?.[clamp.effective];
  const compatibility = model.compatibility;
  const googleBudget =
    compatibility?.dialect === "google-generative-ai" &&
    typeof providerValue === "string" &&
    /^\d+$/.test(providerValue)
      ? Number.parseInt(providerValue, 10)
      : undefined;
  const usesBudget =
    (compatibility?.dialect === "openai-chat" &&
      compatibility.thinkingTokenBudgetField !== undefined) ||
    (compatibility?.dialect === "anthropic-messages" &&
      compatibility.forceAdaptiveThinking !== true) ||
    (compatibility?.dialect === "bedrock-converse-stream" &&
      compatibility.supportsThinkingSignatures === true &&
      compatibility.forceAdaptiveThinking !== true) ||
    googleBudget !== undefined;
  if (!usesBudget) {
    return Object.freeze({
      ...clamp,
      ...(providerValue === undefined || providerValue === null ? {} : { providerValue }),
    });
  }
  const budgetLevel =
    clamp.effective === "xhigh" || clamp.effective === "max" ? "high" : clamp.effective;
  const budgets =
    googleBudget === undefined
      ? request.thinkingBudgets
      : {
          ...request.thinkingBudgets,
          [budgetLevel]: request.thinkingBudgets?.[budgetLevel] ?? googleBudget,
        };
  const fitted = fitThinkingBudget({
    level: clamp.effective,
    modelMaxTokens: model.maxOutputTokens,
    ...(request.maxOutputTokens === undefined
      ? {}
      : { requestedMaxTokens: request.maxOutputTokens }),
    ...(budgets === undefined ? {} : { budgets }),
  });
  const prepared = {
    ...clamp,
    ...(compatibility?.dialect !== "google-generative-ai" ||
    providerValue === undefined ||
    providerValue === null
      ? {}
      : { providerValue }),
    tokenBudget: fitted.thinkingBudget,
  };
  Object.defineProperty(prepared, "maxTokens", {
    value: fitted.maxTokens,
    enumerable: false,
  });
  return Object.freeze(prepared);
}

function resolvedMaxOutputTokens(
  model: ModelInfo,
  request: ModelRequest,
  reasoning: PreparedReasoning | undefined,
): number | undefined {
  const requested = request.maxOutputTokens;
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) {
    fail("request.maxOutputTokens", "must be a positive safe integer");
  }
  if (requested !== undefined && requested > model.maxOutputTokens) {
    fail("request.maxOutputTokens", `exceeds model limit ${model.maxOutputTokens}`);
  }
  if (reasoning?.tokenBudget === undefined) return requested;
  return reasoning.maxTokens ?? model.maxOutputTokens;
}

function prepareCache(
  model: ModelInfo,
  request: ModelRequest,
  tools: readonly PreparedToolDeclaration[],
  messages: readonly PreparedRequestMessage[],
): RequestPreparation["cache"] {
  if (request.cache !== undefined) {
    if (
      typeof request.cache !== "object" ||
      request.cache === null ||
      Array.isArray(request.cache)
    ) {
      fail("request.cache", "must be an object");
    }
    exactKeys(request.cache, ["retention", "sessionId"], "request.cache");
    if (
      request.cache.retention !== undefined &&
      request.cache.retention !== "none" &&
      request.cache.retention !== "short" &&
      request.cache.retention !== "long"
    ) {
      fail("request.cache.retention", "is not recognized");
    }
  }
  const retention = request.cache?.retention ?? model.cache?.defaultRetention ?? "none";
  if (retention !== "none") {
    if (model.cache?.supported !== true)
      fail("request.cache.retention", "is unsupported by this model");
    if (!model.cache.supportedRetentions.includes(retention)) {
      fail("request.cache.retention", `${retention} is unsupported by this model`);
    }
  }
  const sessionId = request.cache?.sessionId;
  if (sessionId !== undefined) {
    nonEmpty(sessionId, "request.cache.sessionId");
    if (retention === "none")
      fail("request.cache.sessionId", "requires prompt caching to be enabled");
    if (Array.from(sessionId).length > 256)
      fail("request.cache.sessionId", "must not exceed 256 characters");
  }
  const placements: CachePlacement[] = [];
  const compatibility = model.compatibility;
  const usesContentMarkers =
    retention !== "none" &&
    (model.apiDialect === "anthropic-messages" ||
      (compatibility?.dialect === "openai-chat" &&
        compatibility.cacheControlFormat === "anthropic") ||
      (compatibility?.dialect === "bedrock-converse-stream" &&
        compatibility.supportsPromptCacheMarkers === true));
  if (usesContentMarkers) {
    if (request.system !== undefined && request.system.length > 0)
      placements.push({ target: "system" });
    const supportsToolMarker =
      compatibility?.dialect === "openai-chat" ||
      (compatibility?.dialect === "anthropic-messages" &&
        compatibility.supportsCacheControlOnTools === true);
    if (supportsToolMarker && tools.length > 0) {
      placements.push({ target: "tool", toolIndex: tools.length - 1 });
    }
    let placedConversationMarker = false;
    for (
      let messageIndex = messages.length - 1;
      messageIndex >= 0 && !placedConversationMarker;
      messageIndex -= 1
    ) {
      const message = messages[messageIndex];
      if (message === undefined) continue;
      for (let contentIndex = message.content.length - 1; contentIndex >= 0; contentIndex -= 1) {
        const content = message.content[contentIndex];
        if (content?.type !== "text" && content?.type !== "blob") continue;
        placements.push({ target: "message-content", messageIndex, contentIndex });
        placedConversationMarker = true;
        break;
      }
    }
  }
  return Object.freeze({
    retention,
    ...(sessionId === undefined || retention === "none" ? {} : { sessionId }),
    placements: Object.freeze(placements),
  });
}

async function loadBlobs(
  model: ModelInfo,
  messages: readonly RequestModelMessage[],
  readBlob: ModelRequest["readBlob"],
): Promise<ReadonlyMap<string, PreparedBlob>> {
  const references = new Map<string, BlobReference>();
  for (const [messageIndex, message] of messages.entries()) {
    for (const [contentIndex, content] of message.content.entries()) {
      if (content.type !== "blob") continue;
      if (!model.capabilities.imageInput) {
        fail(
          `request.messages[${messageIndex}].content[${contentIndex}]`,
          "uses an image unsupported by this model",
        );
      }
      if (!content.blob.mediaType.startsWith("image/")) {
        fail(
          `request.messages[${messageIndex}].content[${contentIndex}].blob.mediaType`,
          "must be an image media type",
        );
      }
      const existing = references.get(content.blob.sha256);
      if (
        existing !== undefined &&
        (existing.mediaType !== content.blob.mediaType ||
          existing.sizeBytes !== content.blob.sizeBytes)
      ) {
        fail(
          `request.messages[${messageIndex}].content[${contentIndex}].blob`,
          "conflicts with another reference for the same digest",
        );
      }
      references.set(content.blob.sha256, content.blob);
    }
  }
  if (references.size === 0) return new Map();
  if (readBlob === undefined) fail("request.readBlob", "is required when history contains blobs");
  const loaded = new Map<string, PreparedBlob>();
  for (const [sha256, reference] of references) {
    const bytes = await readBlob(reference);
    if (!(bytes instanceof Uint8Array))
      fail(`request.blobs.${sha256}`, "loader must return Uint8Array");
    if (bytes.byteLength !== reference.sizeBytes)
      fail(`request.blobs.${sha256}`, "size does not match its reference");
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== sha256)
      fail(`request.blobs.${sha256}`, "content hash does not match its reference");
    loaded.set(
      sha256,
      Object.freeze({ reference: Object.freeze({ ...reference }), bytes: bytes.slice() }),
    );
  }
  return loaded;
}

function cloneBasicContent(
  content: Extract<RequestModelMessage, { role: "user" | "tool" }>["content"][number],
  path: string,
) {
  if (content.type === "text") {
    exactKeys(content, ["type", "text"], path);
    if (typeof content.text !== "string") fail(`${path}.text`, "must be a string");
    return Object.freeze({ type: "text" as const, text: content.text });
  }
  if (content.type !== "blob") fail(`${path}.type`, "is not supported");
  exactKeys(content, ["type", "blob"], path);
  exactKeys(content.blob, ["sha256", "mediaType", "sizeBytes", "name"], `${path}.blob`);
  if (!/^[a-f0-9]{64}$/.test(content.blob.sha256))
    fail(`${path}.blob.sha256`, "must be a SHA-256 digest");
  nonEmpty(content.blob.mediaType, `${path}.blob.mediaType`);
  if (!Number.isSafeInteger(content.blob.sizeBytes) || content.blob.sizeBytes < 0) {
    fail(`${path}.blob.sizeBytes`, "must be a non-negative safe integer");
  }
  if (content.blob.name !== undefined) nonEmpty(content.blob.name, `${path}.blob.name`);
  return Object.freeze({ type: "blob" as const, blob: Object.freeze({ ...content.blob }) });
}

function sanitizeContent(
  content: RequestAssistantContent,
  target: ProviderModelIdentity,
  path: string,
  sanitizations: RequestSanitization[],
): RequestAssistantContent {
  if (content.type === "text") {
    exactKeys(content, ["type", "text", "signature", "continuation"], path);
    if (typeof content.text !== "string") fail(`${path}.text`, "must be a string");
    const signature = keepSignature(content.signature, target, `${path}.signature`, sanitizations);
    const continuation = keepContinuation(
      content.continuation,
      target,
      `${path}.continuation`,
      sanitizations,
    );
    return Object.freeze({
      type: "text",
      text: content.text,
      ...(signature === undefined ? {} : { signature }),
      ...(continuation === undefined ? {} : { continuation }),
    });
  }
  if (content.type === "thinking") {
    exactKeys(content, ["type", "text", "signature", "redacted"], path);
    if (typeof content.text !== "string") fail(`${path}.text`, "must be a string");
    if (content.redacted !== undefined && typeof content.redacted !== "boolean") {
      fail(`${path}.redacted`, "must be a boolean");
    }
    const signature = keepSignature(content.signature, target, `${path}.signature`, sanitizations);
    if (content.redacted === true && signature === undefined) {
      fail(path, "contains redacted reasoning that cannot be replayed by the selected model");
    }
    if (content.text.length === 0 && signature === undefined) {
      fail(path, "contains empty reasoning without a replayable signature");
    }
    return Object.freeze({
      type: "thinking",
      text: content.text,
      ...(signature === undefined ? {} : { signature }),
      ...(content.redacted === true ? { redacted: true } : {}),
    });
  }
  if (content.type !== "blob") fail(`${path}.type`, "is not supported");
  return cloneBasicContent(content, path);
}

function prepareHistory(
  model: ModelInfo,
  messages: readonly RequestModelMessage[],
  tools: readonly PreparedToolDeclaration[],
  dialect: ToolDialectData,
  sanitizations: RequestSanitization[],
): readonly PreparedRequestMessage[] {
  const target = targetIdentity(model);
  const activeTools = new Map(tools.map((tool) => [tool.canonicalName, tool]));
  const callIds = new Map<string, string>();
  const pending = new Map<string, string>();
  const occupied = new Set<string>();
  const output: PreparedRequestMessage[] = [];

  for (const [messageIndex, message] of messages.entries()) {
    const path = `request.messages[${messageIndex}]`;
    if (!Array.isArray(message.content)) fail(`${path}.content`, "must be an array");
    if (
      message.content.length === 0 &&
      (message.role !== "assistant" ||
        !Array.isArray(message.toolCalls) ||
        message.toolCalls.length === 0)
    ) {
      fail(`${path}.content`, "must not be empty without an assistant tool call");
    }
    if (message.role === "user") {
      exactKeys(message, ["role", "content"], path);
      if (pending.size > 0) fail(path, "appears before all preceding tool calls have results");
      output.push(
        Object.freeze({
          role: "user",
          content: Object.freeze(
            message.content.map((item, contentIndex) =>
              cloneBasicContent(item, `${path}.content[${contentIndex}]`),
            ),
          ),
        }),
      );
      continue;
    }
    if (message.role === "assistant") {
      exactKeys(message, ["role", "content", "toolCalls", "origin", "continuation"], path);
      if (pending.size > 0) fail(path, "appears before all preceding tool calls have results");
      const origin = message.origin;
      if (origin !== undefined) validateIdentity(origin, `${path}.origin`);
      const continuation = keepContinuation(
        message.continuation,
        target,
        `${path}.continuation`,
        sanitizations,
      );
      const content = Object.freeze(
        message.content.map((item, contentIndex) =>
          sanitizeContent(item, target, `${path}.content[${contentIndex}]`, sanitizations),
        ),
      );
      const preparedCalls = message.toolCalls?.map((call, callIndex) => {
        const callPath = `${path}.toolCalls[${callIndex}]`;
        exactKeys(call, ["callId", "name", "input", "signature", "continuation"], callPath);
        nonEmpty(call.callId, `${callPath}.callId`);
        nonEmpty(call.name, `${callPath}.name`);
        validateJson(call.input, `${callPath}.input`, new Set(), true);
        if (callIds.has(call.callId))
          fail(`${callPath}.callId`, "is duplicated in request history");
        const normalized = normalizedToolCallId(call.callId, model.apiDialect, occupied);
        callIds.set(call.callId, normalized);
        occupied.add(normalized);
        pending.set(call.callId, call.name);
        const visibleName = activeTools.get(call.name)?.name ?? renderToolName(dialect, call.name);
        const signature = keepSignature(
          call.signature,
          target,
          `${callPath}.signature`,
          sanitizations,
        );
        const callContinuation = keepContinuation(
          call.continuation,
          target,
          `${callPath}.continuation`,
          sanitizations,
        );
        return Object.freeze({
          callId: normalized,
          canonicalCallId: call.callId,
          name: visibleName,
          canonicalName: call.name,
          input: structuredClone(call.input),
          ...(signature === undefined ? {} : { signature }),
          ...(callContinuation === undefined ? {} : { continuation: callContinuation }),
        });
      });
      output.push(
        Object.freeze({
          role: "assistant",
          content,
          ...(preparedCalls === undefined ? {} : { toolCalls: Object.freeze(preparedCalls) }),
          ...(origin === undefined ? {} : { origin: Object.freeze({ ...origin }) }),
          ...(continuation === undefined ? {} : { continuation }),
        }),
      );
      continue;
    }
    if (message.role !== "tool") fail(`${path}.role`, "is not supported");
    exactKeys(message, ["role", "callId", "name", "content", "isError"], path);
    nonEmpty(message.callId, `${path}.callId`);
    nonEmpty(message.name, `${path}.name`);
    if (typeof message.isError !== "boolean") fail(`${path}.isError`, "must be a boolean");
    const expectedName = pending.get(message.callId);
    if (expectedName === undefined)
      fail(`${path}.callId`, "does not match a preceding unresolved tool call");
    if (expectedName !== message.name)
      fail(`${path}.name`, `does not match tool call ${expectedName}`);
    const normalized = callIds.get(message.callId);
    if (normalized === undefined) fail(`${path}.callId`, "has no normalized tool call identifier");
    pending.delete(message.callId);
    output.push(
      Object.freeze({
        role: "tool",
        callId: normalized,
        canonicalCallId: message.callId,
        name: activeTools.get(message.name)?.name ?? renderToolName(dialect, message.name),
        canonicalName: message.name,
        content: Object.freeze(
          message.content.map((item, contentIndex) =>
            cloneBasicContent(item, `${path}.content[${contentIndex}]`),
          ),
        ),
        isError: message.isError,
      }),
    );
  }
  if (pending.size > 0) fail("request.messages", "ends with unresolved tool calls");
  return Object.freeze(output);
}

/**
 * Validates and normalizes one canonical request before a native adapter renders it.
 * The returned request contains no authentication material and records every removal
 * of provider-bound replay metadata.
 */
export async function prepareModelRequest(
  model: ModelInfo,
  request: ModelRequest,
  options: { readonly toolDialect?: ToolDialectData } = {},
): Promise<PreparedModelRequest> {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    fail("request", "must be an object");
  }
  exactKeys(
    request,
    [
      "modelId",
      "system",
      "messages",
      "tools",
      "thinkingLevel",
      "thinkingBudgets",
      "maxOutputTokens",
      "httpIdleTimeoutMs",
      "estimatedInputTokens",
      "toolChoice",
      "sampling",
      "cache",
      "safetySettings",
      "metadata",
      "readBlob",
      "signal",
      "timeoutMs",
      "maxRetries",
      "maxRetryDelayMs",
    ],
    "request",
  );
  nonEmpty(request.modelId, "request.modelId");
  if (request.modelId !== model.modelId) fail("request.modelId", `does not match ${model.modelId}`);
  if (request.system !== undefined && typeof request.system !== "string") {
    fail("request.system", "must be a string");
  }
  if (!Array.isArray(request.messages)) fail("request.messages", "must be an array");
  if (request.tools !== undefined && !Array.isArray(request.tools))
    fail("request.tools", "must be an array");
  if (
    request.toolChoice !== undefined &&
    request.toolChoice !== "auto" &&
    request.toolChoice !== "required" &&
    request.toolChoice !== "none"
  ) {
    fail("request.toolChoice", "is not recognized");
  }
  if (
    request.thinkingLevel !== undefined &&
    !new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).has(request.thinkingLevel)
  ) {
    fail("request.thinkingLevel", "is not recognized");
  }
  if (request.thinkingBudgets !== undefined) {
    if (
      typeof request.thinkingBudgets !== "object" ||
      request.thinkingBudgets === null ||
      Array.isArray(request.thinkingBudgets)
    ) {
      fail("request.thinkingBudgets", "must be an object");
    }
    exactKeys(
      request.thinkingBudgets,
      ["minimal", "low", "medium", "high"],
      "request.thinkingBudgets",
    );
    for (const [level, budget] of Object.entries(request.thinkingBudgets)) {
      if (!Number.isSafeInteger(budget) || (budget as number) < 0) {
        fail(`request.thinkingBudgets.${level}`, "must be a non-negative safe integer");
      }
    }
  }
  for (const [field, value] of [
    ["timeoutMs", request.timeoutMs],
    ["httpIdleTimeoutMs", request.httpIdleTimeoutMs],
    ["estimatedInputTokens", request.estimatedInputTokens],
    ["maxRetries", request.maxRetries],
    ["maxRetryDelayMs", request.maxRetryDelayMs],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      fail(`request.${field}`, "must be a non-negative safe integer");
    }
  }
  if (request.readBlob !== undefined && typeof request.readBlob !== "function") {
    fail("request.readBlob", "must be a function");
  }
  assertModelSupports(model, request);
  validateMetadata(request.metadata);
  const safetySettings = prepareSafetySettings(model, request.safetySettings);
  const sampling = prepareSampling(model, request.sampling);
  const sanitizations: RequestSanitization[] = [];
  const dialect = options.toolDialect ?? toolDialectFor(model.apiDialect);
  const tools = prepareTools(model, request.tools, dialect);
  if (request.toolChoice === "required" && tools.length === 0) {
    fail("request.toolChoice", "requires at least one tool");
  }
  const messages = prepareHistory(model, request.messages, tools, dialect, sanitizations);
  const blobs = await loadBlobs(model, messages, request.readBlob);
  const reasoning = prepareReasoning(model, request);
  if (
    sampling?.temperature !== undefined &&
    model.compatibility?.dialect === "anthropic-messages" &&
    model.compatibility.supportsTemperature !== true
  ) {
    fail("request.sampling.temperature", "is unsupported by this model");
  }
  if (
    sampling?.temperature !== undefined &&
    model.apiDialect === "anthropic-messages" &&
    reasoning !== undefined &&
    reasoning.effective !== "off"
  ) {
    fail("request.sampling.temperature", "cannot be combined with Anthropic reasoning");
  }
  const maxOutputTokens = resolvedMaxOutputTokens(model, request, reasoning);
  const cache = prepareCache(model, request, tools, messages);
  const readBlob =
    blobs.size === 0
      ? request.readBlob
      : async (reference: BlobReference): Promise<Uint8Array> => {
          const blob = blobs.get(reference.sha256);
          if (blob === undefined) fail(`request.blobs.${reference.sha256}`, "was not prepared");
          return blob.bytes.slice();
        };
  const preparation: RequestPreparation = Object.freeze({
    blobs,
    tools,
    ...(reasoning === undefined ? {} : { reasoning }),
    cache,
    sanitizations: Object.freeze(sanitizations),
  });
  return Object.freeze({
    modelId: request.modelId,
    ...(request.system === undefined ? {} : { system: request.system }),
    messages,
    ...(tools.length === 0 && request.tools === undefined ? {} : { tools }),
    ...(reasoning === undefined ? {} : { thinkingLevel: reasoning.effective }),
    ...(request.thinkingBudgets === undefined
      ? {}
      : { thinkingBudgets: Object.freeze({ ...request.thinkingBudgets }) }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(request.httpIdleTimeoutMs === undefined
      ? {}
      : { httpIdleTimeoutMs: request.httpIdleTimeoutMs }),
    ...(request.estimatedInputTokens === undefined
      ? {}
      : { estimatedInputTokens: request.estimatedInputTokens }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    ...(sampling === undefined ? {} : { sampling }),
    cache,
    ...(safetySettings === undefined ? {} : { safetySettings }),
    ...(request.metadata === undefined ? {} : { metadata: Object.freeze({ ...request.metadata }) }),
    ...(readBlob === undefined ? {} : { readBlob }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.maxRetries === undefined ? {} : { maxRetries: request.maxRetries }),
    ...(request.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: request.maxRetryDelayMs }),
    preparation,
  });
}

export function preparedBlobDataUrl(blob: PreparedBlob): string {
  return `data:${blob.reference.mediaType};base64,${Buffer.from(blob.bytes).toString("base64")}`;
}

export function isPreparedModelRequest(request: ModelRequest): request is PreparedModelRequest {
  return "preparation" in request;
}
