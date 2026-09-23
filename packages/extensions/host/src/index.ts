// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Ajv, type ValidateFunction } from "ajv";

import type {
  DaemonCommandDefinition,
  DaemonCommandHandler,
  DaemonContextHandler,
  DaemonExtensionApi,
  DaemonExtensionFactory,
  DaemonExtensionSession,
  DaemonInputHandler,
  DaemonInterceptionEventName,
  DaemonLifecycleEventHandler,
  DaemonLifecycleEventName,
  DaemonProviderHeadersHandler,
  DaemonProviderRequestHandler,
  DaemonProviderResponseHandler,
  DaemonResourceDiscoveryHandler,
  DaemonSessionEventHandler,
  DaemonToolCallHandler,
  DaemonToolDefinition,
  DaemonToolResult,
  DaemonToolResultHandler,
  ExtensionDisposer,
} from "@axl/extension-api";
import {
  type CapabilitySource,
  type CommandDecision,
  type CommandInterception,
  type ExtensionContextContribution,
  type ExtensionHost,
  type ExtensionSessionBinding,
  ExtensionHostError,
  type KernelTool,
  type ProviderHeadersInterception,
  type ProviderRequestInterception,
  type ProviderResponseObservation,
  type ToolCallDecision,
  type ToolCallInterception,
  ToolCapabilityService,
  type ToolResultDecision,
  type ToolResultInterception,
  ToolInputError,
  type ToolRegistry,
} from "@axl/kernel";
import type {
  CanonicalEvent,
  CapabilityRecord,
  ContextResource,
  JsonObject,
  JsonValue,
  UserContent,
} from "@axl/protocol";
import { parseUserContent } from "@axl/protocol";

export const DAEMON_EXTENSION_AUTHORITY = "extensions.tool";
export { DaemonExtensionRegistry } from "./registry.ts";

const EXTENSION_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;
const RESOURCE_NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const STATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENTRY_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);
const MAX_TEXT_BYTES = 1_000_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const LIFECYCLE_EVENTS = new Set<DaemonLifecycleEventName>([
  "session_start",
  "session_info_changed",
  "session_compact",
  "session_compact_failed",
  "session_shutdown",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "model_select",
  "thinking_level_select",
  "extension_event",
]);

export class DaemonExtensionError extends ExtensionHostError {
  readonly path: string;

  constructor(
    path: string,
    message: string,
    options?: ErrorOptions & { readonly extensionId?: string; readonly phase?: string },
  ) {
    super(
      `${path}: ${message}`,
      {
        path,
        phase: options?.phase ?? "load",
        ...(options?.extensionId === undefined ? {} : { extensionId: options.extensionId }),
      },
      options,
    );
    this.name = "DaemonExtensionError";
    this.path = path;
  }
}

export interface DiscoveredDaemonExtension {
  /** Identity derived from the file or directory name. */
  readonly id: string;
  /** Canonical path of the module to import. */
  readonly path: string;
  readonly source?: "builtin" | "global" | "explicit" | "project" | "package";
  readonly factory?: DaemonExtensionFactory;
}

export interface DaemonExtensionFailure {
  readonly extensionId: string;
  readonly event:
    | "tool.call"
    | "tool.result"
    | "command"
    | "session.event"
    | "lifecycle"
    | "dispose";
  readonly error: Error;
}

type BoundSessionMethod = "sendExtensionMessage" | "getEntryLabel" | "setEntryLabel" | "shutdown";
type HostSessionControls = Omit<DaemonExtensionSession, BoundSessionMethod> &
  Partial<Pick<DaemonExtensionSession, BoundSessionMethod>>;

export interface LoadDaemonExtensionsOptions {
  /** Directory holding user extensions, normally `~/.axl/extensions`. */
  readonly directory: string;
  readonly cwd: string;
  readonly reason?: string;
  readonly tools: ToolRegistry;
  readonly grantedAuthorities: ReadonlySet<string>;
  /** Pre-resolved extension entries. Defaults to discovery in `directory`. */
  readonly extensions?: readonly DiscoveredDaemonExtension[];
  readonly builtinExtensions?: readonly DiscoveredDaemonExtension[];
  /** Extension IDs excluded before their modules are imported. */
  readonly disabledExtensionIds?: ReadonlySet<string>;
  /** Owning daemon operation. Aborting it cancels extension activation. */
  readonly signal?: AbortSignal;
  readonly session?: HostSessionControls;
  readonly shutdown?: () => Promise<void>;
  readonly registerProvider?: (extensionId: string, provider: object) => ExtensionDisposer;
  readonly reservedCommandNames?: ReadonlySet<string>;
  readonly cleanupTimeoutMs?: number;
  /** Receives handler failures that must not interrupt the session. */
  readonly onFailure: (failure: DaemonExtensionFailure) => void;
}

export interface LoadedDaemonExtension {
  readonly id: string;
  readonly path: string;
  readonly tools: readonly string[];
}

export interface LoadedDaemonExtensions {
  readonly host: ExtensionHost;
  readonly source: CapabilitySource;
  readonly extensions: readonly LoadedDaemonExtension[];
}

function idOf(name: string, path: string): string {
  if (!EXTENSION_ID.test(name)) {
    throw new DaemonExtensionError(
      path,
      "extension name must contain lowercase letters, digits, dots, and hyphens only",
    );
  }
  return name;
}

async function entryOf(directory: string): Promise<string | undefined> {
  for (const candidate of ["index.ts", "index.mts", "index.js", "index.mjs"]) {
    const path = join(directory, candidate);
    try {
      if ((await stat(path)).isFile()) return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

/**
 * Lists extension modules one level below `directory`: `<name>.ts|js` files
 * and `<name>/index.ts|js` directories, sorted by name. A missing directory
 * yields no extensions. Anything else that is not a valid entry fails.
 */
export async function discoverDaemonExtensions(
  directory: string,
): Promise<readonly DiscoveredDaemonExtension[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const discovered: DiscoveredDaemonExtension[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue;
    const requested = join(directory, entry.name);
    const path = await realpath(requested).catch((cause: unknown) => {
      throw new DaemonExtensionError(requested, `cannot resolve extension: ${String(cause)}`);
    });
    const metadata = await stat(path);
    if (metadata.isFile()) {
      const extension = extname(entry.name);
      if (!ENTRY_EXTENSIONS.has(extension)) continue;
      discovered.push({ id: idOf(basename(entry.name, extension), requested), path });
      continue;
    }
    if (metadata.isDirectory()) {
      try {
        await stat(join(path, "package.json"));
        continue; // Package manifests are resolved by the registry, not as index modules.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const entryPath = await entryOf(path);
      if (entryPath === undefined) {
        throw new DaemonExtensionError(
          requested,
          "extension directory has no index.ts or index.js",
        );
      }
      discovered.push({ id: idOf(entry.name, requested), path: entryPath });
    }
  }
  const seen = new Set<string>();
  for (const extension of discovered) {
    if (seen.has(extension.id)) {
      throw new DaemonExtensionError(directory, `duplicate extension id ${extension.id}`);
    }
    seen.add(extension.id);
  }
  return discovered;
}

async function importFactory(path: string): Promise<DaemonExtensionFactory> {
  let module: unknown;
  try {
    const url = pathToFileURL(path);
    url.searchParams.set(
      "source",
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    );
    module = await import(url.href);
  } catch (cause) {
    throw new DaemonExtensionError(path, `cannot import extension: ${String(cause)}`, { cause });
  }
  const factory = (module as { default?: unknown }).default;
  if (typeof factory !== "function") {
    throw new DaemonExtensionError(path, "default export must be a function (api) => void");
  }
  return factory as DaemonExtensionFactory;
}

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function stateKey(value: string): string {
  if (!STATE_KEY.test(value)) throw new TypeError("Extension state key is invalid");
  return value;
}

function unavailableSession(): DaemonExtensionSession {
  const fail = (): never => {
    throw new Error("Daemon session controls are unavailable in this host");
  };
  return {
    send: fail,
    sendExtensionMessage: fail,
    compact: fail,
    reload: fail,
    abort: fail,
    shutdown: fail,
    rename: fail,
    setModel: fail,
    setThinkingLevel: fail,
    activateTools: fail,
    newSession: fail,
    fork: fail,
    clone: fail,
    extensions: fail,
    info: fail,
    getEntryLabel: fail,
    setEntryLabel: fail,
  };
}

function stateValue(value: unknown): JsonValue {
  if (value === undefined) throw new TypeError("Extension state value must be JSON");
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded) > MAX_TEXT_BYTES) {
      throw new TypeError("Extension state value must be bounded JSON");
    }
    return JSON.parse(encoded) as JsonValue;
  } catch (cause) {
    if (cause instanceof TypeError && cause.message.startsWith("Extension state")) throw cause;
    throw new TypeError("Extension state value must be JSON", { cause });
  }
}

async function withinCleanupBudget(tasks: readonly Promise<void>[], milliseconds: number) {
  if (tasks.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Extension cleanup exceeded ${milliseconds}ms`)),
      milliseconds,
    );
  });
  try {
    await Promise.race([Promise.all(tasks), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validateToolDefinition(definition: unknown, path: string): DaemonToolDefinition {
  if (typeof definition !== "object" || definition === null) {
    throw new DaemonExtensionError(path, "registerTool requires a definition object");
  }
  const { name, description, inputSchema, execute } = definition as Partial<DaemonToolDefinition>;
  if (typeof name !== "string" || !TOOL_NAME.test(name)) {
    throw new DaemonExtensionError(path, "tool name must match ^[a-z][a-z0-9_]*$");
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new DaemonExtensionError(path, `tool ${name} requires a non-empty description`);
  }
  if (typeof inputSchema !== "object" || inputSchema === null || Array.isArray(inputSchema)) {
    throw new DaemonExtensionError(path, `tool ${name} requires an object inputSchema`);
  }
  if (typeof execute !== "function") {
    throw new DaemonExtensionError(path, `tool ${name} requires an execute function`);
  }
  return definition as DaemonToolDefinition;
}

function validateToolResultPatch(
  value: unknown,
  path: string,
): {
  readonly content?: readonly UserContent[];
  readonly isError?: boolean;
  readonly details?: JsonValue;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DaemonExtensionError(path, "tool.result handler must return a result patch");
  }
  const patch = value as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    if (!["content", "isError", "details"].includes(key)) {
      throw new DaemonExtensionError(path, `tool.result patch field ${key} is not allowed`);
    }
  }
  if (patch.isError !== undefined && typeof patch.isError !== "boolean") {
    throw new DaemonExtensionError(path, "tool.result patch isError must be a boolean");
  }
  return {
    ...(patch.content === undefined
      ? {}
      : { content: parseUserContent(patch.content, "extension.tool.result.content") }),
    ...(patch.isError === undefined ? {} : { isError: patch.isError }),
    ...(patch.details === undefined ? {} : { details: stateValue(patch.details) }),
  };
}

function validateToolResult(value: unknown, toolName: string): DaemonToolResult {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Tool ${toolName} returned a non-object result`);
  }
  const { content, isError } = value as Partial<DaemonToolResult>;
  if (!Array.isArray(content)) {
    throw new TypeError(`Tool ${toolName} result.content must be an array`);
  }
  for (const item of content) {
    if (
      typeof item !== "object" ||
      item === null ||
      item.type !== "text" ||
      typeof item.text !== "string"
    ) {
      throw new TypeError(`Tool ${toolName} result.content items must be { type: "text", text }`);
    }
    if (textBytes(item.text) > MAX_TEXT_BYTES) {
      throw new TypeError(`Tool ${toolName} result text exceeds ${MAX_TEXT_BYTES} bytes`);
    }
  }
  if (isError !== undefined && typeof isError !== "boolean") {
    throw new TypeError(`Tool ${toolName} result.isError must be a boolean`);
  }
  return { content, ...(isError === undefined ? {} : { isError }) };
}

function kernelTool(definition: DaemonToolDefinition, path: string): KernelTool {
  const validator = new Ajv({ allErrors: true, strict: false });
  let validateInput: ValidateFunction;
  try {
    validateInput = validator.compile(definition.inputSchema);
  } catch (cause) {
    throw new DaemonExtensionError(
      path,
      `tool ${definition.name} has invalid inputSchema: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema as JsonObject,
    async execute(input, signal, context) {
      if (!validateInput(input)) {
        throw new ToolInputError(
          `${definition.name}: input does not match schema: ${validator.errorsText(validateInput.errors, { separator: "; " })}`,
        );
      }
      const result = validateToolResult(
        await definition.execute(structuredClone(input), signal, {
          reportProgress: (progress) => context?.reportProgress?.(stateValue(progress)),
        }),
        definition.name,
      );
      return { content: result.content, isError: result.isError ?? false };
    },
  };
}

interface LoadedExtensionState {
  readonly id: string;
  readonly path: string;
  readonly source?: DiscoveredDaemonExtension["source"];
  readonly toolCallHandlers: DaemonToolCallHandler[];
  readonly toolResultHandlers: DaemonToolResultHandler[];
  readonly commandHandlers: DaemonCommandHandler[];
  readonly commands: DaemonCommandDefinition[];
  readonly providerIds: string[];
  readonly lifecycleHandlers: Map<DaemonLifecycleEventName, DaemonLifecycleEventHandler[]>;
  readonly resourceHandlers: DaemonResourceDiscoveryHandler[];
  readonly contextHandlers: Map<"agent" | "request", DaemonContextHandler[]>;
  readonly providerHeaderHandlers: DaemonProviderHeadersHandler[];
  readonly providerRequestHandlers: DaemonProviderRequestHandler[];
  readonly providerResponseHandlers: DaemonProviderResponseHandler[];
  readonly inputHandlers: DaemonInputHandler[];
  readonly sessionEventHandlers: DaemonSessionEventHandler[];
  readonly lifecycle: AbortController;
  readonly pendingEvents: Set<Promise<void>>;
  readonly disposers: ExtensionDisposer[];
  readonly tools: string[];
}

/**
 * Imports every extension in `directory`, runs its factory, and returns one
 * kernel extension host plus the capability source for its registered tools.
 * Any invalid extension fails the whole load; nothing is skipped silently.
 */
export async function loadDaemonExtensions(
  options: LoadDaemonExtensionsOptions,
): Promise<LoadedDaemonExtensions> {
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1) {
    throw new DaemonExtensionError(
      options.directory,
      "cleanupTimeoutMs must be a positive integer",
    );
  }
  const discovered = [
    ...(options.builtinExtensions ?? []),
    ...(options.extensions ?? (await discoverDaemonExtensions(options.directory))),
  ].filter((extension) => !options.disabledExtensionIds?.has(extension.id));
  const discoveredIds = new Set<string>();
  for (const extension of discovered) {
    if (discoveredIds.has(extension.id)) {
      throw new DaemonExtensionError(extension.path, `duplicate extension id ${extension.id}`);
    }
    discoveredIds.add(extension.id);
  }
  const states: LoadedExtensionState[] = [];
  const records: CapabilityRecord[] = [];
  let sessionBinding: ExtensionSessionBinding | undefined;
  const disposeStates = async (selected: readonly LoadedExtensionState[]) => {
    const failures: DaemonExtensionFailure[] = [];
    for (const state of selected) state.lifecycle.abort();
    for (const state of selected) {
      try {
        await withinCleanupBudget([...state.pendingEvents], cleanupTimeoutMs);
      } catch (cause) {
        failures.push({
          extensionId: state.id,
          event: "dispose",
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      }
      const pending: Promise<void>[] = [];
      for (const dispose of [...state.disposers].reverse()) {
        try {
          const result = dispose();
          if (result !== undefined) {
            pending.push(
              Promise.resolve(result).catch((cause: unknown) => {
                failures.push({
                  extensionId: state.id,
                  event: "dispose",
                  error: cause instanceof Error ? cause : new Error(String(cause)),
                });
              }),
            );
          }
        } catch (cause) {
          failures.push({
            extensionId: state.id,
            event: "dispose",
            error: cause instanceof Error ? cause : new Error(String(cause)),
          });
        }
      }
      try {
        await withinCleanupBudget(pending, cleanupTimeoutMs);
      } catch (cause) {
        failures.push({
          extensionId: state.id,
          event: "dispose",
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      }
    }
    for (const failure of failures) options.onFailure(failure);
  };
  try {
    for (const extension of discovered) {
      options.signal?.throwIfAborted();
      const factory = extension.factory ?? (await importFactory(extension.path));
      options.signal?.throwIfAborted();
      const state: LoadedExtensionState = {
        id: extension.id,
        path: extension.path,
        ...(extension.source === undefined ? {} : { source: extension.source }),
        toolCallHandlers: [],
        toolResultHandlers: [],
        commandHandlers: [],
        commands: [],
        providerIds: [],
        lifecycleHandlers: new Map(),
        resourceHandlers: [],
        contextHandlers: new Map(),
        providerHeaderHandlers: [],
        providerRequestHandlers: [],
        providerResponseHandlers: [],
        inputHandlers: [],
        sessionEventHandlers: [],
        lifecycle: new AbortController(),
        pendingEvents: new Set(),
        disposers: [],
        tools: [],
      };
      states.push(state);
      let loading = true;
      const assertLoading = (operation: string) => {
        if (!loading) {
          throw new DaemonExtensionError(
            extension.path,
            `${operation} is only allowed while the extension factory runs`,
          );
        }
      };
      const own = (dispose: ExtensionDisposer): ExtensionDisposer => {
        state.disposers.push(dispose);
        return dispose;
      };
      const api: DaemonExtensionApi = {
        extensionId: extension.id,
        mode: "daemon",
        uiAvailable: false,
        cwd: options.cwd,
        signal:
          options.signal === undefined
            ? state.lifecycle.signal
            : AbortSignal.any([options.signal, state.lifecycle.signal]),
        async emit(channel, value) {
          if (sessionBinding === undefined) {
            throw new Error("Extension events are unavailable before session binding");
          }
          await sessionBinding.emit(extension.id, stateKey(channel), stateValue(value));
        },
        session: {
          ...(options.session ?? unavailableSession()),
          shutdown: options.shutdown ?? unavailableSession().shutdown,
          async sendExtensionMessage(source, content) {
            if (sessionBinding === undefined) {
              throw new Error("Extension messages are unavailable before session binding");
            }
            if (
              typeof source !== "string" ||
              source.length === 0 ||
              typeof content !== "string" ||
              textBytes(content) > MAX_TEXT_BYTES
            ) {
              throw new TypeError("Extension message requires bounded source and content strings");
            }
            await sessionBinding.sendExtensionMessage(extension.id, source, content);
          },
          async getEntryLabel(eventId) {
            if (sessionBinding === undefined) {
              throw new Error("Extension labels are unavailable before session binding");
            }
            return sessionBinding.getEntryLabel(extension.id, eventId);
          },
          async setEntryLabel(eventId, label) {
            if (sessionBinding === undefined) {
              throw new Error("Extension labels are unavailable before session binding");
            }
            if (label !== undefined && (typeof label !== "string" || label.length > 512)) {
              throw new TypeError("Extension label must be at most 512 characters");
            }
            await sessionBinding.setEntryLabel(extension.id, eventId, label ?? null);
          },
        },
        state: {
          get(key) {
            return sessionBinding?.getState(extension.id, stateKey(key));
          },
          async set(key, value) {
            if (sessionBinding === undefined) {
              throw new Error("Extension state is unavailable before session binding");
            }
            await sessionBinding.setState(extension.id, stateKey(key), stateValue(value));
          },
          async delete(key) {
            if (sessionBinding === undefined) {
              throw new Error("Extension state is unavailable before session binding");
            }
            await sessionBinding.setState(extension.id, stateKey(key), null);
          },
        },
        registerTool(definition) {
          if (state.lifecycle.signal.aborted) {
            throw new DaemonExtensionError(
              extension.path,
              "registerTool is unavailable after disposal",
            );
          }
          const valid = validateToolDefinition(definition, extension.path);
          const identity = `extension:${extension.id}/${valid.name}`;
          const tool = kernelTool(valid, extension.path);
          const unregister = options.tools.registerCapability(identity, tool);
          records.push({
            identity,
            kind: "tool",
            name: valid.name,
            description: valid.description,
            aliases: [extension.id],
            path: extension.path,
            scope: "global",
            provenance: `extension:${extension.id}`,
            enabled: true,
            trust: "trusted",
            available: true,
            requiredAuthority: [DAEMON_EXTENSION_AUTHORITY],
          });
          state.tools.push(valid.name);
          return own(() => {
            unregister();
            const recordIndex = records.findIndex((record) => record.identity === identity);
            if (recordIndex >= 0) records.splice(recordIndex, 1);
            const toolIndex = state.tools.indexOf(valid.name);
            if (toolIndex >= 0) state.tools.splice(toolIndex, 1);
          });
        },
        registerProvider(provider) {
          if (state.lifecycle.signal.aborted) {
            throw new DaemonExtensionError(
              extension.path,
              "registerProvider is unavailable after disposal",
            );
          }
          if (options.registerProvider === undefined) {
            throw new DaemonExtensionError(extension.path, "provider registration is unavailable");
          }
          if (
            typeof provider !== "object" ||
            provider === null ||
            typeof (provider as { id?: unknown }).id !== "string"
          ) {
            throw new DaemonExtensionError(extension.path, "provider must expose a string id");
          }
          const providerId = (provider as { id: string }).id;
          if (state.providerIds.includes(providerId)) {
            throw new DaemonExtensionError(
              extension.path,
              `provider ${providerId} is already registered`,
            );
          }
          const unregister = options.registerProvider(extension.id, provider);
          state.providerIds.push(providerId);
          return own(async () => {
            await unregister();
            const index = state.providerIds.indexOf(providerId);
            if (index >= 0) state.providerIds.splice(index, 1);
          });
        },
        registerCommand(definition) {
          if (state.lifecycle.signal.aborted) {
            throw new DaemonExtensionError(
              extension.path,
              "registerCommand is unavailable after disposal",
            );
          }
          if (
            typeof definition !== "object" ||
            definition === null ||
            typeof definition.name !== "string" ||
            !COMMAND_NAME.test(definition.name) ||
            typeof definition.description !== "string" ||
            definition.description.trim().length === 0 ||
            typeof definition.execute !== "function"
          ) {
            throw new DaemonExtensionError(
              extension.path,
              "registerCommand received an invalid definition",
            );
          }
          if (
            options.reservedCommandNames?.has(definition.name) ||
            states.some((candidate) =>
              candidate.commands.some((command) => command.name === definition.name),
            )
          ) {
            throw new DaemonExtensionError(
              extension.path,
              `command ${definition.name} is already registered`,
            );
          }
          state.commands.push(definition);
          return own(() => {
            const index = state.commands.indexOf(definition);
            if (index >= 0) state.commands.splice(index, 1);
          });
        },
        on(
          event:
            | "tool.call"
            | "tool.result"
            | "command"
            | "session.event"
            | "resources_discover"
            | "before_agent_start"
            | "context"
            | "input"
            | "before_provider_headers"
            | "before_provider_request"
            | "after_provider_response"
            | DaemonInterceptionEventName
            | DaemonLifecycleEventName,
          handler: unknown,
        ) {
          assertLoading("on");
          if (typeof handler !== "function") {
            throw new DaemonExtensionError(extension.path, `on(${event}) requires a function`);
          }
          if (event === "tool.call") {
            const list = state.toolCallHandlers;
            list.push(handler as DaemonToolCallHandler);
            return own(() => {
              const index = list.indexOf(handler as DaemonToolCallHandler);
              if (index >= 0) list.splice(index, 1);
            });
          }
          if (event === "tool.result") {
            const list = state.toolResultHandlers;
            list.push(handler as DaemonToolResultHandler);
            return own(() => {
              const index = list.indexOf(handler as DaemonToolResultHandler);
              if (index >= 0) list.splice(index, 1);
            });
          }
          if (
            event === "command" ||
            event === "project_trust" ||
            event === "session_before_fork" ||
            event === "session_before_compact" ||
            event === "user_bash"
          ) {
            const names: Partial<Record<DaemonInterceptionEventName, string>> = {
              project_trust: "project_trust",
              session_before_fork: "fork",
              session_before_compact: "compact",
              user_bash: "user_bash",
            };
            const expected = event === "command" ? undefined : names[event];
            const registered = handler as DaemonCommandHandler;
            const wrapped: DaemonCommandHandler = (input) =>
              expected === undefined || input.name === expected
                ? registered({ ...input, name: expected === undefined ? input.name : event })
                : undefined;
            const list = state.commandHandlers;
            list.push(wrapped);
            return own(() => {
              const index = list.indexOf(wrapped);
              if (index >= 0) list.splice(index, 1);
            });
          }
          if (event === "before_provider_headers") {
            const list = state.providerHeaderHandlers;
            list.push(handler as DaemonProviderHeadersHandler);
            return own(() => {
              const index = list.indexOf(handler as DaemonProviderHeadersHandler);
              if (index >= 0) list.splice(index, 1);
            });
          }
          if (event === "before_provider_request") {
            const list = state.providerRequestHandlers;
            list.push(handler as DaemonProviderRequestHandler);
            return own(() => {
              const index = list.indexOf(handler as DaemonProviderRequestHandler);
              if (index >= 0) list.splice(index, 1);
            });
          }
          if (event === "after_provider_response") {
            const list = state.providerResponseHandlers;
            list.push(handler as DaemonProviderResponseHandler);
            return own(() => {
              const index = list.indexOf(handler as DaemonProviderResponseHandler);
              if (index >= 0) list.splice(index, 1);
            });
          }
          if (event === "before_agent_start" || event === "context") {
            const phase = event === "before_agent_start" ? "agent" : "request";
            const list = state.contextHandlers.get(phase) ?? [];
            list.push(handler as DaemonContextHandler);
            state.contextHandlers.set(phase, list);
            return own(() => {
              const index = list.indexOf(handler as DaemonContextHandler);
              if (index >= 0) list.splice(index, 1);
            });
          }
          if (event === "input") {
            const list = state.inputHandlers;
            list.push(handler as DaemonInputHandler);
            return own(() => {
              const index = list.indexOf(handler as DaemonInputHandler);
              if (index >= 0) list.splice(index, 1);
            });
          }
          if (event === "resources_discover") {
            const list = state.resourceHandlers;
            list.push(handler as DaemonResourceDiscoveryHandler);
            return own(() => {
              const index = list.indexOf(handler as DaemonResourceDiscoveryHandler);
              if (index >= 0) list.splice(index, 1);
            });
          }
          if (event === "session.event") {
            const list = state.sessionEventHandlers;
            list.push(handler as DaemonSessionEventHandler);
            return own(() => {
              const index = list.indexOf(handler as DaemonSessionEventHandler);
              if (index >= 0) list.splice(index, 1);
            });
          }
          if (LIFECYCLE_EVENTS.has(event as DaemonLifecycleEventName)) {
            const name = event as DaemonLifecycleEventName;
            const list = state.lifecycleHandlers.get(name) ?? [];
            list.push(handler as DaemonLifecycleEventHandler);
            state.lifecycleHandlers.set(name, list);
            return own(() => {
              const index = list.indexOf(handler as DaemonLifecycleEventHandler);
              if (index >= 0) list.splice(index, 1);
            });
          }
          throw new DaemonExtensionError(extension.path, `unknown event ${String(event)}`);
        },
        track(dispose) {
          assertLoading("track");
          if (typeof dispose !== "function") {
            throw new DaemonExtensionError(extension.path, "track requires a function");
          }
          return own(dispose);
        },
      };
      try {
        await factory(api);
        options.signal?.throwIfAborted();
      } catch (cause) {
        if (cause instanceof DaemonExtensionError) throw cause;
        throw new DaemonExtensionError(
          extension.path,
          `extension factory failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause, extensionId: state.id, phase: "activate" },
        );
      } finally {
        loading = false;
      }
    }
  } catch (error) {
    await disposeStates([...states].reverse());
    throw error;
  }

  const resourceStates = states.filter((state) => state.resourceHandlers.length > 0);
  const gates = states.filter((state) => state.toolCallHandlers.length > 0);
  const resultHandlers = states.filter((state) => state.toolResultHandlers.length > 0);
  const contextStates = states.filter((state) => state.contextHandlers.size > 0);
  const providerHeaderStates = states.filter((state) => state.providerHeaderHandlers.length > 0);
  const providerRequestStates = states.filter((state) => state.providerRequestHandlers.length > 0);
  const providerResponseStates = states.filter(
    (state) => state.providerResponseHandlers.length > 0,
  );
  const inputStates = states.filter((state) => state.inputHandlers.length > 0);
  const commandGates = states.filter((state) => state.commandHandlers.length > 0);
  const observers = states.filter((state) => state.sessionEventHandlers.length > 0);
  const lifecycleStates = states.filter((state) => state.lifecycleHandlers.size > 0);
  const activeMessages = new Set<string>();
  let disposed = false;

  const runLifecycle = async (
    state: LoadedExtensionState,
    type: DaemonLifecycleEventName,
    payload: unknown,
    signal: AbortSignal,
  ) => {
    for (const handler of [...(state.lifecycleHandlers.get(type) ?? [])]) {
      await handler({ type, payload: structuredClone(payload), signal });
    }
  };
  const scheduleLifecycle = (
    state: LoadedExtensionState,
    type: DaemonLifecycleEventName,
    payload: unknown,
  ) => {
    if (!state.lifecycleHandlers.has(type)) return;
    const task = runLifecycle(state, type, payload, state.lifecycle.signal).catch(
      (cause: unknown) => {
        options.onFailure({
          extensionId: state.id,
          event: "lifecycle",
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      },
    );
    state.pendingEvents.add(task);
    void task.finally(() => state.pendingEvents.delete(task));
  };
  const notifyLifecycle = (type: DaemonLifecycleEventName, payload: unknown) => {
    for (const state of lifecycleStates) scheduleLifecycle(state, type, payload);
  };

  const host: ExtensionHost = {
    bindSession(binding) {
      sessionBinding = binding;
    },
    commands() {
      return states.flatMap((state) =>
        state.commands.map((command) => ({
          extensionId: state.id,
          name: command.name,
          description: command.description,
        })),
      );
    },
    async invokeCommand(name, args, signal) {
      for (const state of states) {
        const command = state.commands.find((candidate) => candidate.name === name);
        if (command === undefined) continue;
        try {
          const result = await command.execute(structuredClone(args), {
            signal: AbortSignal.any([signal, state.lifecycle.signal]),
          });
          if (result !== undefined && typeof result !== "string") {
            throw new TypeError("command result must be a string or undefined");
          }
          if (result !== undefined && textBytes(result) > MAX_TEXT_BYTES) {
            throw new TypeError(`command result exceeds ${MAX_TEXT_BYTES} bytes`);
          }
          return typeof result === "string" ? result : undefined;
        } catch (cause) {
          throw new DaemonExtensionError(
            state.path,
            `command ${name} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause, extensionId: state.id, phase: "command" },
          );
        }
      }
      throw new DaemonExtensionError(options.directory, `unknown extension command ${name}`);
    },
    async activate(signal) {
      const activationSignal = signal ?? new AbortController().signal;
      for (const state of lifecycleStates) {
        try {
          await runLifecycle(
            state,
            "session_start",
            { cwd: options.cwd, reason: options.reason ?? "session_start" },
            activationSignal,
          );
        } catch (cause) {
          throw new DaemonExtensionError(
            state.path,
            `session_start handler failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause, extensionId: state.id, phase: "activate" },
          );
        }
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of [...lifecycleStates].reverse()) {
        try {
          await withinCleanupBudget(
            [runLifecycle(state, "session_shutdown", {}, state.lifecycle.signal)],
            cleanupTimeoutMs,
          );
        } catch (cause) {
          options.onFailure({
            extensionId: state.id,
            event: "lifecycle",
            error: cause instanceof Error ? cause : new Error(String(cause)),
          });
        }
      }
      await disposeStates([...states].reverse());
    },
    ...(resourceStates.length === 0
      ? {}
      : {
          async discoverResources(signal: AbortSignal) {
            const resources: ContextResource[] = [];
            for (const state of resourceStates) {
              for (const handler of [...state.resourceHandlers]) {
                let discovered: Awaited<ReturnType<DaemonResourceDiscoveryHandler>>;
                try {
                  discovered = await handler({
                    cwd: options.cwd,
                    signal: AbortSignal.any([signal, state.lifecycle.signal]),
                  });
                } catch (cause) {
                  throw new DaemonExtensionError(
                    state.path,
                    `resources_discover handler failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                    { cause, extensionId: state.id, phase: "resources_discover" },
                  );
                }
                if (!Array.isArray(discovered) || discovered.length > 32) {
                  throw new DaemonExtensionError(
                    state.path,
                    "resources_discover must return at most 32 resources",
                  );
                }
                for (const resource of discovered) {
                  if (
                    typeof resource !== "object" ||
                    resource === null ||
                    typeof resource.name !== "string" ||
                    !RESOURCE_NAME.test(resource.name) ||
                    typeof resource.content !== "string" ||
                    textBytes(resource.content) > MAX_TEXT_BYTES
                  ) {
                    throw new DaemonExtensionError(
                      state.path,
                      "resource requires a valid name and bounded string content",
                    );
                  }
                  resources.push({
                    kind: "extension" as const,
                    scope: state.source === "project" ? ("project" as const) : ("global" as const),
                    path: `extension:${state.id}/${resource.name}`,
                    content: resource.content,
                  });
                }
              }
            }
            return resources;
          },
        }),
    ...(gates.length === 0
      ? {}
      : {
          async beforeToolCall(
            call: ToolCallInterception,
            signal: AbortSignal,
          ): Promise<ToolCallDecision> {
            let input = call.input;
            let replaced = false;
            for (const state of gates) {
              for (const handler of [...state.toolCallHandlers]) {
                let decision: Awaited<ReturnType<DaemonToolCallHandler>>;
                try {
                  decision = await handler({
                    callId: call.callId,
                    name: call.name,
                    input: structuredClone(input),
                    signal: AbortSignal.any([signal, state.lifecycle.signal]),
                  });
                } catch (cause) {
                  throw new DaemonExtensionError(
                    state.path,
                    `tool.call handler failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                    { cause },
                  );
                }
                if (decision === undefined) continue;
                if (typeof decision !== "object" || decision === null) {
                  throw new DaemonExtensionError(
                    state.path,
                    "tool.call handler must return undefined, { input }, or { block: true, reason }",
                  );
                }
                if ("block" in decision) {
                  if (decision.block !== true || typeof decision.reason !== "string") {
                    throw new DaemonExtensionError(
                      state.path,
                      "tool.call block decision requires { block: true, reason }",
                    );
                  }
                  return { block: true, reason: `${state.id}: ${decision.reason}` };
                }
                if (
                  typeof decision.input !== "object" ||
                  decision.input === null ||
                  Array.isArray(decision.input)
                ) {
                  throw new DaemonExtensionError(
                    state.path,
                    "tool.call input replacement must be an object",
                  );
                }
                input = structuredClone(decision.input) as JsonObject;
                replaced = true;
              }
            }
            return replaced ? { input } : undefined;
          },
        }),
    ...(resultHandlers.length === 0
      ? {}
      : {
          async afterToolCall(
            result: ToolResultInterception,
            signal: AbortSignal,
          ): Promise<ToolResultDecision | undefined> {
            let current = result;
            let changed = false;
            for (const state of resultHandlers) {
              for (const handler of [...state.toolResultHandlers]) {
                let decision: Awaited<ReturnType<DaemonToolResultHandler>>;
                try {
                  decision = await handler({
                    ...structuredClone(current),
                    signal: AbortSignal.any([signal, state.lifecycle.signal]),
                  });
                } catch (cause) {
                  throw new DaemonExtensionError(
                    state.path,
                    `tool.result handler failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                    { cause },
                  );
                }
                if (decision === undefined) continue;
                current = {
                  ...current,
                  ...validateToolResultPatch(decision, state.path),
                } as ToolResultInterception;
                changed = true;
              }
            }
            if (!changed) return undefined;
            return {
              content: current.content,
              isError: current.isError,
              ...(current.details === undefined ? {} : { details: current.details }),
            };
          },
        }),
    ...(contextStates.length === 0
      ? {}
      : {
          async contributeContext(input, signal) {
            const contributions: ExtensionContextContribution[] = [];
            for (const state of contextStates) {
              for (const handler of [...(state.contextHandlers.get(input.phase) ?? [])]) {
                let values: Awaited<ReturnType<DaemonContextHandler>>;
                try {
                  values = await handler({
                    systemPrompt: input.systemPrompt,
                    messages: structuredClone(input.messages),
                    signal: AbortSignal.any([signal, state.lifecycle.signal]),
                  });
                } catch (cause) {
                  throw new DaemonExtensionError(
                    state.path,
                    `${input.phase === "agent" ? "before_agent_start" : "context"} handler failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                    { cause },
                  );
                }
                if (!Array.isArray(values) || values.length > 32) {
                  throw new DaemonExtensionError(
                    state.path,
                    "context handler returned too many values",
                  );
                }
                for (const value of values) {
                  if (
                    typeof value !== "object" ||
                    value === null ||
                    typeof value.source !== "string" ||
                    value.source.length === 0 ||
                    typeof value.content !== "string" ||
                    textBytes(value.content) > MAX_TEXT_BYTES ||
                    (value.target !== undefined &&
                      value.target !== "message" &&
                      value.target !== "system")
                  ) {
                    throw new DaemonExtensionError(
                      state.path,
                      "context contribution requires bounded source and content strings",
                    );
                  }
                  contributions.push({
                    extensionId: state.id,
                    source: value.source,
                    content: value.content,
                    ...(value.target === undefined ? {} : { target: value.target }),
                  });
                }
              }
            }
            return contributions;
          },
        }),
    ...(providerHeaderStates.length === 0
      ? {}
      : {
          async beforeProviderHeaders(input: ProviderHeadersInterception, signal: AbortSignal) {
            let headers = input.headers;
            for (const state of providerHeaderStates) {
              for (const handler of [...state.providerHeaderHandlers]) {
                const replacement = await handler({
                  ...input,
                  headers: structuredClone(headers),
                  signal: AbortSignal.any([signal, state.lifecycle.signal]),
                });
                if (replacement === undefined) continue;
                if (
                  typeof replacement !== "object" ||
                  replacement === null ||
                  Array.isArray(replacement) ||
                  Object.values(replacement).some((value) => typeof value !== "string")
                ) {
                  throw new DaemonExtensionError(state.path, "provider headers must be strings");
                }
                headers = structuredClone(replacement);
              }
            }
            return headers;
          },
        }),
    ...(providerRequestStates.length === 0
      ? {}
      : {
          async beforeProviderRequest(input: ProviderRequestInterception, signal: AbortSignal) {
            let payload = input.payload;
            for (const state of providerRequestStates) {
              for (const handler of [...state.providerRequestHandlers]) {
                const replacement = await handler({
                  ...input,
                  payload: structuredClone(payload),
                  signal: AbortSignal.any([signal, state.lifecycle.signal]),
                });
                if (replacement !== undefined) payload = stateValue(replacement);
              }
            }
            return payload;
          },
        }),
    ...(providerResponseStates.length === 0
      ? {}
      : {
          async afterProviderResponse(input: ProviderResponseObservation, signal: AbortSignal) {
            for (const state of providerResponseStates) {
              for (const handler of [...state.providerResponseHandlers]) {
                await handler({
                  ...structuredClone(input),
                  signal: AbortSignal.any([signal, state.lifecycle.signal]),
                });
              }
            }
          },
        }),
    ...(inputStates.length === 0
      ? {}
      : {
          async beforeInput(input, signal) {
            let content = input.content;
            for (const state of inputStates) {
              for (const handler of [...state.inputHandlers]) {
                let decision: Awaited<ReturnType<DaemonInputHandler>>;
                try {
                  decision = await handler({
                    source: input.source,
                    content: structuredClone(content),
                    signal: AbortSignal.any([signal, state.lifecycle.signal]),
                  });
                } catch (cause) {
                  throw new DaemonExtensionError(
                    state.path,
                    `input handler failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                    { cause },
                  );
                }
                if (decision === undefined) continue;
                if (typeof decision !== "object" || decision === null) {
                  throw new DaemonExtensionError(
                    state.path,
                    "input handler must return undefined, transform, or handled",
                  );
                }
                if (decision.action === "handled") return { action: "handled" as const };
                if (decision.action !== "transform") {
                  throw new DaemonExtensionError(state.path, "input handler action is invalid");
                }
                content = parseUserContent(decision.content, "extension.input.content");
              }
            }
            return content === input.content
              ? undefined
              : { action: "transform" as const, content: content as readonly UserContent[] };
          },
        }),
    ...(commandGates.length === 0
      ? {}
      : {
          async beforeCommand(
            command: CommandInterception,
            signal: AbortSignal,
          ): Promise<CommandDecision> {
            let args = command.args;
            let replaced = false;
            for (const state of commandGates) {
              for (const handler of [...state.commandHandlers]) {
                let decision: Awaited<ReturnType<DaemonCommandHandler>>;
                try {
                  decision = await handler({
                    name: command.name,
                    source: command.source,
                    args: structuredClone(args),
                    signal: AbortSignal.any([signal, state.lifecycle.signal]),
                  });
                } catch (cause) {
                  throw new DaemonExtensionError(
                    state.path,
                    `command handler failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                    { cause },
                  );
                }
                if (decision === undefined) continue;
                if (typeof decision !== "object" || decision === null) {
                  throw new DaemonExtensionError(
                    state.path,
                    "command handler must return undefined, { args }, or { block: true, reason }",
                  );
                }
                if ("block" in decision) {
                  if (decision.block !== true || typeof decision.reason !== "string") {
                    throw new DaemonExtensionError(
                      state.path,
                      "command handler block decision requires { block: true, reason }",
                    );
                  }
                  return { block: true, reason: `${state.id}: ${decision.reason}` };
                }
                if (
                  typeof decision.args !== "object" ||
                  decision.args === null ||
                  Array.isArray(decision.args)
                ) {
                  throw new DaemonExtensionError(
                    state.path,
                    "command handler args replacement must be an object",
                  );
                }
                args = structuredClone(decision.args) as JsonObject;
                replaced = true;
              }
            }
            return replaced ? { args } : undefined;
          },
        }),
    ...(observers.length === 0 && lifecycleStates.length === 0
      ? {}
      : {
          observe(event: CanonicalEvent) {
            if (disposed) return;
            const projected = {
              id: event.id,
              type: event.type,
              timestamp: event.timestamp,
              payload: structuredClone(event.payload),
            };
            for (const state of observers) {
              for (const handler of [...state.sessionEventHandlers]) {
                const report = (cause: unknown) =>
                  options.onFailure({
                    extensionId: state.id,
                    event: "session.event",
                    error: cause instanceof Error ? cause : new Error(String(cause)),
                  });
                try {
                  const outcome = handler({ ...projected, signal: state.lifecycle.signal });
                  if (outcome instanceof Promise) {
                    const task = outcome.then(
                      () => undefined,
                      (cause: unknown) => report(cause),
                    );
                    state.pendingEvents.add(task);
                    void task.finally(() => state.pendingEvents.delete(task));
                  }
                } catch (cause) {
                  report(cause);
                }
              }
            }
            if (event.type === "session.renamed" || event.type.startsWith("config.")) {
              notifyLifecycle("session_info_changed", projected);
            }
            if (event.type === "context.compacted") notifyLifecycle("session_compact", projected);
            if (event.type === "compaction.failed") {
              notifyLifecycle("session_compact_failed", projected);
            }
            if (event.type === "user.message") {
              notifyLifecycle("agent_start", projected);
              notifyLifecycle("turn_start", projected);
            }
            if (event.type === "assistant.message") {
              notifyLifecycle("message_end", projected);
              if (event.payload.stopReason !== "tool_use") {
                notifyLifecycle("turn_end", projected);
                notifyLifecycle("agent_end", projected);
              }
            }
            if (event.type === "tool.call") notifyLifecycle("tool_execution_start", projected);
            if (event.type === "tool.result") notifyLifecycle("tool_execution_end", projected);
            if (event.type === "config.model") notifyLifecycle("model_select", projected);
            if (event.type === "config.thinking") {
              notifyLifecycle("thinking_level_select", projected);
            }
            if (event.type === "extension.event") notifyLifecycle("extension_event", projected);
          },
        }),
    ...(lifecycleStates.length === 0
      ? {}
      : {
          observeActivity(frame) {
            if (disposed) return;
            if (frame.type !== "clear" && !activeMessages.has(frame.operationId)) {
              activeMessages.add(frame.operationId);
              notifyLifecycle("message_start", frame);
            }
            if (frame.type === "clear") activeMessages.delete(frame.operationId);
            else notifyLifecycle("message_update", frame);
            if (frame.type === "tool_call" || frame.type === "tool_progress") {
              notifyLifecycle("tool_execution_update", frame);
            }
          },
        }),
    ...(lifecycleStates.length === 0
      ? {}
      : {
          settled(operationId) {
            if (!disposed) notifyLifecycle("agent_settled", { operationId });
          },
        }),
  };

  return {
    host,
    source: {
      records,
      service: new ToolCapabilityService(records, options.grantedAuthorities),
    },
    extensions: states.map((state) => ({ id: state.id, path: state.path, tools: state.tools })),
  };
}
