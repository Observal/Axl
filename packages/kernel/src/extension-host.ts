// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type {
  CanonicalEvent,
  ContextResource,
  JsonObject,
  JsonValue,
  SessionActivityFrame,
  UserContent,
} from "@axl/protocol";

export interface ToolCallInterception {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonObject;
}

export type ToolCallDecision =
  | { readonly block: true; readonly reason: string }
  | { readonly input: JsonObject }
  | undefined;

export interface ToolResultInterception extends ToolCallInterception {
  readonly content: readonly UserContent[];
  readonly isError: boolean;
  readonly details?: JsonValue;
}

export interface ToolResultDecision {
  readonly content?: readonly UserContent[];
  readonly isError?: boolean;
  readonly details?: JsonValue;
}

export type CommandSource = "client" | "model" | "automatic";

export interface ExtensionContextContribution {
  readonly extensionId: string;
  readonly source: string;
  readonly content: string;
}

export interface ModelContextInterception {
  readonly phase: "agent" | "request";
  readonly systemPrompt: string;
  readonly messages: readonly unknown[];
}

export interface ExtensionCommandDescriptor {
  readonly extensionId: string;
  readonly name: string;
  readonly description: string;
}

export interface ExtensionSessionBinding {
  getState(extensionId: string, key: string): JsonValue | undefined;
  setState(extensionId: string, key: string, value: JsonValue | null): Promise<void>;
  sendExtensionMessage(extensionId: string, source: string, content: string): Promise<void>;
  getEntryLabel(extensionId: string, eventId: string): string | undefined;
  setEntryLabel(extensionId: string, eventId: string, label: string | null): Promise<void>;
  emit(extensionId: string, channel: string, value: JsonValue): Promise<void>;
}

export interface ProviderHeadersInterception {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ProviderRequestInterception {
  readonly url: string;
  readonly payload: unknown;
}

export interface ProviderResponseObservation {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface InputInterception {
  readonly source: "client" | "extension";
  readonly content: readonly UserContent[];
}

export type InputDecision =
  | { readonly action: "transform"; readonly content: readonly UserContent[] }
  | { readonly action: "handled" }
  | undefined;

export interface CommandInterception {
  readonly name: string;
  readonly source: CommandSource;
  readonly args: JsonObject;
}

export type CommandDecision =
  | { readonly args: JsonObject }
  | { readonly block: true; readonly reason: string }
  | undefined;

/** A safe extension failure that may cross the daemon RPC boundary. */
export class ExtensionHostError extends Error {
  readonly code = "extension_failed";
  readonly details: JsonObject;

  constructor(message: string, details: JsonObject = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExtensionHostError";
    this.details = details;
  }
}

/** A built-in command refused by an extension. */
export class CommandBlockedError extends Error {
  readonly command: string;
  readonly reason: string;

  constructor(command: string, reason: string, options?: ErrorOptions) {
    super(`Command ${command} was blocked: ${reason}`, options);
    this.name = "CommandBlockedError";
    this.command = command;
    this.reason = reason;
  }
}

/**
 * Extension-host lifecycle seam. The kernel owns when hosts start and stop;
 * extension behavior stays behind this boundary. The host may gate tool and
 * command execution, while each registered tool retains its owner's policy.
 */
export interface ExtensionHost {
  bindSession?(binding: ExtensionSessionBinding): void;
  commands?(): readonly ExtensionCommandDescriptor[];
  invokeCommand?(name: string, args: JsonObject, signal: AbortSignal): Promise<string | undefined>;
  activate(signal?: AbortSignal): void | Promise<void>;
  dispose(): void | Promise<void>;
  /**
   * Runs before a registered tool executes. Fails closed: a rejected promise
   * blocks the call with the error message as the reason.
   */
  beforeToolCall?(
    call: ToolCallInterception,
    signal: AbortSignal,
  ): ToolCallDecision | Promise<ToolCallDecision>;
  /** Contributes bounded, canonical context resources before prompt construction. */
  discoverResources?(signal: AbortSignal): Promise<readonly ContextResource[]>;
  /** Runs after tool execution and may replace canonical result fields. */
  afterToolCall?(
    result: ToolResultInterception,
    signal: AbortSignal,
  ): ToolResultDecision | undefined | Promise<ToolResultDecision | undefined>;
  /** Appends canonical extension context before an agent or provider request. */
  contributeContext?(
    input: ModelContextInterception,
    signal: AbortSignal,
  ): readonly ExtensionContextContribution[] | Promise<readonly ExtensionContextContribution[]>;
  beforeProviderHeaders?(
    input: ProviderHeadersInterception,
    signal: AbortSignal,
  ): Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  beforeProviderRequest?(
    input: ProviderRequestInterception,
    signal: AbortSignal,
  ): unknown | Promise<unknown>;
  afterProviderResponse?(
    input: ProviderResponseObservation,
    signal: AbortSignal,
  ): void | Promise<void>;
  /** Runs before user or extension input is admitted to the agent loop. */
  beforeInput?(
    input: InputInterception,
    signal: AbortSignal,
  ): InputDecision | Promise<InputDecision>;
  /**
   * Runs before a built-in command executes. May replace the arguments or
   * refuse the command. Fails closed: a rejected promise refuses the command.
   */
  beforeCommand?(
    command: CommandInterception,
    signal: AbortSignal,
  ): CommandDecision | Promise<CommandDecision>;
  /** Receives every canonical event after it is durable. Must not throw. */
  observe?(event: CanonicalEvent): void;
  /** Receives bounded non-durable model activity. Must not throw. */
  observeActivity?(frame: SessionActivityFrame): void;
}

/**
 * Applies `host.beforeCommand` and returns the arguments the built-in must
 * run with. Throws `CommandBlockedError` on refusal or handler failure.
 */
export async function interceptCommand(
  host: ExtensionHost,
  command: CommandInterception,
  signal: AbortSignal,
): Promise<JsonObject> {
  if (host.beforeCommand === undefined) return command.args;
  let decision: CommandDecision;
  try {
    decision = await host.beforeCommand(command, signal);
  } catch (error) {
    throw new CommandBlockedError(
      command.name,
      error instanceof Error ? error.message : "extension command gate failed",
      { cause: error },
    );
  }
  if (decision === undefined) return command.args;
  if ("block" in decision) throw new CommandBlockedError(command.name, decision.reason);
  return decision.args;
}

export const NOOP_EXTENSION_HOST: ExtensionHost = {
  activate: () => undefined,
  dispose: () => undefined,
};

/**
 * Runs several hosts as one. Activation and observation follow list order;
 * disposal runs in reverse. The first blocking decision wins.
 */
export function composeExtensionHosts(hosts: readonly ExtensionHost[]): ExtensionHost {
  if (hosts.length === 1) return hosts[0] as ExtensionHost;
  const commandHosts = hosts.filter((host) => host.commands !== undefined);
  const resourceHosts = hosts.filter((host) => host.discoverResources !== undefined);
  const gates = hosts.filter((host) => host.beforeToolCall !== undefined);
  const resultHandlers = hosts.filter((host) => host.afterToolCall !== undefined);
  const contextHosts = hosts.filter((host) => host.contributeContext !== undefined);
  const headerHosts = hosts.filter((host) => host.beforeProviderHeaders !== undefined);
  const requestHosts = hosts.filter((host) => host.beforeProviderRequest !== undefined);
  const responseHosts = hosts.filter((host) => host.afterProviderResponse !== undefined);
  const inputHandlers = hosts.filter((host) => host.beforeInput !== undefined);
  const commandGates = hosts.filter((host) => host.beforeCommand !== undefined);
  const observers = hosts.filter((host) => host.observe !== undefined);
  const activityObservers = hosts.filter((host) => host.observeActivity !== undefined);
  return {
    bindSession(binding) {
      for (const host of hosts) host.bindSession?.(binding);
    },
    ...(commandHosts.length === 0
      ? {}
      : {
          commands() {
            return commandHosts.flatMap((host) => host.commands?.() ?? []);
          },
          async invokeCommand(name, args, signal) {
            for (const host of commandHosts) {
              if (host.commands?.().some((command) => command.name === name)) {
                return host.invokeCommand?.(name, args, signal);
              }
            }
            throw new Error(`Unknown extension command ${name}`);
          },
        }),
    async activate(signal) {
      for (const host of hosts) await host.activate(signal);
    },
    async dispose() {
      for (const host of [...hosts].reverse()) await host.dispose();
    },
    ...(resourceHosts.length === 0
      ? {}
      : {
          async discoverResources(signal) {
            const resources: ContextResource[] = [];
            for (const host of resourceHosts) {
              resources.push(...((await host.discoverResources?.(signal)) ?? []));
            }
            return resources;
          },
        }),
    ...(gates.length === 0
      ? {}
      : {
          async beforeToolCall(call, signal) {
            let input = call.input;
            let replaced = false;
            for (const host of gates) {
              const decision = await host.beforeToolCall?.({ ...call, input }, signal);
              if (decision === undefined) continue;
              if ("block" in decision) return decision;
              input = decision.input;
              replaced = true;
            }
            return replaced ? { input } : undefined;
          },
        }),
    ...(resultHandlers.length === 0
      ? {}
      : {
          async afterToolCall(result, signal) {
            let current = result;
            let changed = false;
            for (const host of resultHandlers) {
              const decision = await host.afterToolCall?.(current, signal);
              if (decision === undefined) continue;
              current = { ...current, ...decision };
              changed = true;
            }
            if (!changed) return undefined;
            return {
              content: current.content,
              isError: current.isError,
              ...(current.details === undefined ? {} : { details: current.details }),
            };
          },
        }),
    ...(contextHosts.length === 0
      ? {}
      : {
          async contributeContext(input, signal) {
            const contributions: ExtensionContextContribution[] = [];
            for (const host of contextHosts) {
              contributions.push(...((await host.contributeContext?.(input, signal)) ?? []));
            }
            return contributions;
          },
        }),
    ...(headerHosts.length === 0
      ? {}
      : {
          async beforeProviderHeaders(input, signal) {
            let headers = input.headers;
            for (const host of headerHosts) {
              headers =
                (await host.beforeProviderHeaders?.({ ...input, headers }, signal)) ?? headers;
            }
            return headers;
          },
        }),
    ...(requestHosts.length === 0
      ? {}
      : {
          async beforeProviderRequest(input, signal) {
            let payload = input.payload;
            for (const host of requestHosts) {
              payload =
                (await host.beforeProviderRequest?.({ ...input, payload }, signal)) ?? payload;
            }
            return payload;
          },
        }),
    ...(responseHosts.length === 0
      ? {}
      : {
          async afterProviderResponse(input, signal) {
            for (const host of responseHosts) await host.afterProviderResponse?.(input, signal);
          },
        }),
    ...(inputHandlers.length === 0
      ? {}
      : {
          async beforeInput(input, signal) {
            let content = input.content;
            let changed = false;
            for (const host of inputHandlers) {
              const decision = await host.beforeInput?.({ ...input, content }, signal);
              if (decision === undefined) continue;
              if (decision.action === "handled") return decision;
              content = decision.content;
              changed = true;
            }
            return changed ? { action: "transform", content } : undefined;
          },
        }),
    ...(commandGates.length === 0
      ? {}
      : {
          async beforeCommand(command, signal) {
            let args = command.args;
            let replaced = false;
            for (const host of commandGates) {
              const decision = await host.beforeCommand?.({ ...command, args }, signal);
              if (decision === undefined) continue;
              if ("block" in decision) return decision;
              args = decision.args;
              replaced = true;
            }
            return replaced ? { args } : undefined;
          },
        }),
    ...(observers.length === 0
      ? {}
      : {
          observe(event) {
            for (const host of observers) host.observe?.(event);
          },
        }),
    ...(activityObservers.length === 0
      ? {}
      : {
          observeActivity(frame) {
            for (const host of activityObservers) host.observeActivity?.(frame);
          },
        }),
  };
}
