// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Ajv, type ValidateFunction } from "ajv";

import type {
  DaemonCommandHandler,
  DaemonExtensionApi,
  DaemonExtensionFactory,
  DaemonSessionEventHandler,
  DaemonToolCallHandler,
  DaemonToolDefinition,
  DaemonToolResult,
  ExtensionDisposer,
} from "@axl/extension-api";
import {
  type CapabilitySource,
  type CommandDecision,
  type CommandInterception,
  type ExtensionHost,
  ExtensionHostError,
  type KernelTool,
  type ToolCallDecision,
  type ToolCallInterception,
  ToolCapabilityService,
  ToolInputError,
  type ToolRegistry,
} from "@axl/kernel";
import type { CanonicalEvent, CapabilityRecord, JsonObject } from "@axl/protocol";

export const DAEMON_EXTENSION_AUTHORITY = "extensions.tool";

const EXTENSION_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const ENTRY_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);
const MAX_TEXT_BYTES = 1_000_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const JSON_SCHEMA_VALIDATOR = new Ajv({ allErrors: true, strict: false });

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
}

export interface DaemonExtensionFailure {
  readonly extensionId: string;
  readonly event: "tool.call" | "command" | "session.event" | "dispose";
  readonly error: Error;
}

export interface LoadDaemonExtensionsOptions {
  /** Directory holding user extensions, normally `~/.axl/extensions`. */
  readonly directory: string;
  readonly cwd: string;
  readonly tools: ToolRegistry;
  readonly grantedAuthorities: ReadonlySet<string>;
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
  let validateInput: ValidateFunction;
  try {
    validateInput = JSON_SCHEMA_VALIDATOR.compile(definition.inputSchema);
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
    async execute(input, signal) {
      if (!validateInput(input)) {
        throw new ToolInputError(
          `${definition.name}: input does not match schema: ${JSON_SCHEMA_VALIDATOR.errorsText(validateInput.errors, { separator: "; " })}`,
        );
      }
      const result = validateToolResult(
        await definition.execute(structuredClone(input), signal),
        definition.name,
      );
      return { content: result.content, isError: result.isError ?? false };
    },
  };
}

interface LoadedExtensionState {
  readonly id: string;
  readonly path: string;
  readonly toolCallHandlers: DaemonToolCallHandler[];
  readonly commandHandlers: DaemonCommandHandler[];
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
  const discovered = await discoverDaemonExtensions(options.directory);
  const states: LoadedExtensionState[] = [];
  const records: CapabilityRecord[] = [];
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
      const factory = await importFactory(extension.path);
      const state: LoadedExtensionState = {
        id: extension.id,
        path: extension.path,
        toolCallHandlers: [],
        commandHandlers: [],
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
        cwd: options.cwd,
        registerTool(definition) {
          assertLoading("registerTool");
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
          return own(unregister);
        },
        on(event: "tool.call" | "command" | "session.event", handler: unknown) {
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
          if (event === "command") {
            const list = state.commandHandlers;
            list.push(handler as DaemonCommandHandler);
            return own(() => {
              const index = list.indexOf(handler as DaemonCommandHandler);
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

  const gates = states.filter((state) => state.toolCallHandlers.length > 0);
  const commandGates = states.filter((state) => state.commandHandlers.length > 0);
  const observers = states.filter((state) => state.sessionEventHandlers.length > 0);
  let disposed = false;

  const host: ExtensionHost = {
    activate: () => undefined,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await disposeStates([...states].reverse());
    },
    ...(gates.length === 0
      ? {}
      : {
          async beforeToolCall(
            call: ToolCallInterception,
            signal: AbortSignal,
          ): Promise<ToolCallDecision> {
            for (const state of gates) {
              for (const handler of [...state.toolCallHandlers]) {
                let decision: Awaited<ReturnType<DaemonToolCallHandler>>;
                try {
                  decision = await handler({
                    callId: call.callId,
                    name: call.name,
                    input: structuredClone(call.input),
                    signal,
                  });
                } catch (cause) {
                  throw new DaemonExtensionError(
                    state.path,
                    `tool.call handler failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                    { cause },
                  );
                }
                if (decision !== undefined) {
                  if (
                    typeof decision !== "object" ||
                    decision.block !== true ||
                    typeof decision.reason !== "string"
                  ) {
                    throw new DaemonExtensionError(
                      state.path,
                      "tool.call handler must return undefined or { block: true, reason }",
                    );
                  }
                  return { block: true, reason: `${state.id}: ${decision.reason}` };
                }
              }
            }
            return undefined;
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
                    signal,
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
    ...(observers.length === 0
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
