// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { CanonicalEvent, JsonObject } from "@axl/protocol";

export interface ToolCallInterception {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonObject;
}

export type ToolCallDecision = { readonly block: true; readonly reason: string } | undefined;

export type CommandSource = "client" | "model" | "automatic";

export interface CommandInterception {
  readonly name: string;
  readonly source: CommandSource;
  readonly args: JsonObject;
}

export type CommandDecision =
  | { readonly args: JsonObject }
  | { readonly block: true; readonly reason: string }
  | undefined;

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
 * extension behavior stays behind this boundary. Hosts may narrow what a tool
 * call does; they can never widen policy or sandbox limits.
 */
export interface ExtensionHost {
  activate(): void | Promise<void>;
  dispose(): void | Promise<void>;
  /**
   * Runs before a registered tool executes. Fails closed: a rejected promise
   * blocks the call with the error message as the reason.
   */
  beforeToolCall?(
    call: ToolCallInterception,
    signal: AbortSignal,
  ): ToolCallDecision | Promise<ToolCallDecision>;
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
  const gates = hosts.filter((host) => host.beforeToolCall !== undefined);
  const commandGates = hosts.filter((host) => host.beforeCommand !== undefined);
  const observers = hosts.filter((host) => host.observe !== undefined);
  return {
    async activate() {
      for (const host of hosts) await host.activate();
    },
    async dispose() {
      for (const host of [...hosts].reverse()) await host.dispose();
    },
    ...(gates.length === 0
      ? {}
      : {
          async beforeToolCall(call, signal) {
            for (const host of gates) {
              const decision = await host.beforeToolCall?.(call, signal);
              if (decision?.block) return decision;
            }
            return undefined;
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
  };
}
