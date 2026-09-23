// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import {
  type CommandDescriptor,
  type CommandListResult,
  type EventId,
  type ModelRequestSettings,
  type ProviderAuthenticationStatus,
  type ProviderCatalogRefreshResult,
  parseCommandListResult,
  parseModelRequestSettings,
  type SessionConfiguration,
  type SessionForkResult,
  type SessionId,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@axl/protocol";

import { type AxlClient, AxlClientError } from "./client.ts";

export interface PresentationCommand {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly extensionId?: string;
  readonly description: string;
  readonly argument?: { readonly required: boolean; readonly hint?: string };
  readonly run: (argument?: string) => void | Promise<void>;
}

export interface EffectiveCommand extends CommandDescriptor {
  readonly source: "daemon" | "presentation";
}

export type PresentationCommandSource = () => readonly PresentationCommand[];

export type CommandSurface =
  | "model"
  | "thinking"
  | "providers"
  | "mcp"
  | "login"
  | "logout"
  | "request"
  | "resume"
  | "fork"
  | "requeue"
  | "review"
  | "attach"
  | "import"
  | "export"
  | "dispose"
  | "delete";

export interface CommandInvocationOptions {
  readonly signal?: AbortSignal;
  readonly requestSettings?: ModelRequestSettings;
}

export type CommandOutcome =
  | { readonly state: "completed"; readonly command: string; readonly content?: string }
  | { readonly state: "queued"; readonly command: string }
  | {
      readonly state: "session-configured";
      readonly command: "model" | "thinking" | "request";
      readonly update: Partial<SessionConfiguration>;
    }
  | {
      readonly state: "provider-catalog-refreshed";
      readonly command: "refresh";
      readonly result: ProviderCatalogRefreshResult;
    }
  | {
      readonly state: "provider-logged-out";
      readonly command: "logout";
      readonly result: ProviderAuthenticationStatus;
    }
  | { readonly state: "focus"; readonly surface: CommandSurface; readonly argument?: string }
  | { readonly state: "open-session"; readonly session: SessionForkResult };

function commandKey(value: string): string {
  return value.trim().replace(/^\//, "").toLowerCase();
}

export function mergeCommandDirectory(
  daemon: CommandListResult,
  presentation: readonly PresentationCommand[] = [],
): readonly EffectiveCommand[] {
  const names = new Set<string>();
  const addNames = (name: string, aliases: readonly string[]): void => {
    for (const candidate of [name, ...aliases]) {
      if (names.has(candidate)) throw new Error(`Command name collision: /${candidate}`);
      names.add(candidate);
    }
  };
  const commands: EffectiveCommand[] = daemon.commands.map((command) => {
    addNames(command.name, command.aliases);
    return { ...command, source: "daemon" };
  });
  const local = parseCommandListResult({
    generation: "presentation",
    commands: presentation.map((command) => ({
      id: command.id,
      name: command.name,
      aliases: command.aliases ?? [],
      description: command.description,
      context: "either",
      argument: command.argument ?? { required: false },
      requiredCapabilities: [],
      availability: { state: "available" },
      ...(command.extensionId === undefined ? {} : { extensionId: command.extensionId }),
    })),
  });
  for (const command of local.commands) {
    addNames(command.name, command.aliases);
    commands.push({ ...command, source: "presentation" });
  }
  return commands.sort((left, right) =>
    left.name < right.name
      ? -1
      : left.name > right.name
        ? 1
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0,
  );
}

export class CommandController {
  private catalog: CommandListResult = { generation: "unloaded", commands: [] };
  private readonly client: AxlClient;
  private readonly presentation: PresentationCommandSource;

  constructor(client: AxlClient, presentation: PresentationCommandSource = () => []) {
    this.client = client;
    this.presentation = presentation;
  }

  get generation(): string {
    return this.catalog.generation;
  }

  get commands(): readonly EffectiveCommand[] {
    return mergeCommandDirectory(this.catalog, this.presentation());
  }

  async refresh(sessionId?: SessionId): Promise<readonly EffectiveCommand[]> {
    this.catalog = await this.client.request(
      "command.list",
      sessionId === undefined ? {} : { sessionId },
    );
    return this.commands;
  }

  search(query: string): readonly EffectiveCommand[] {
    const term = commandKey(query);
    if (!term) return this.commands;
    return this.commands.filter(
      (command) =>
        command.name.includes(term) ||
        command.aliases.some((alias) => alias.includes(term)) ||
        command.description.toLowerCase().includes(term),
    );
  }

  resolve(input: string): EffectiveCommand | undefined {
    const name = commandKey(input.split(/\s/u, 1)[0] ?? "");
    return this.commands.find((command) => command.name === name || command.aliases.includes(name));
  }

  async invoke(
    input: string,
    sessionId?: SessionId,
    options: CommandInvocationOptions = {},
  ): Promise<CommandOutcome> {
    const text = input.trim();
    if (text.includes("\n") || text.includes("\r")) {
      throw new AxlClientError("invalid_command", "Invalid command syntax");
    }
    const invocation = text.startsWith("/") ? text.slice(1) : text;
    const separator = invocation.search(/\s/u);
    const name = separator < 0 ? invocation : invocation.slice(0, separator);
    if (!/^[a-z][a-z0-9-]*$/u.test(name) || name.endsWith("-") || name.includes("--")) {
      throw new AxlClientError("invalid_command", "Invalid command syntax");
    }
    const argument = separator < 0 ? undefined : invocation.slice(separator).trim() || undefined;
    const command = this.commands.find(
      (candidate) => candidate.name === name || candidate.aliases.includes(name),
    );
    if (command === undefined)
      throw new AxlClientError("unknown_command", `Unknown command /${name}`);
    if (command.availability.state === "unavailable") {
      throw new AxlClientError("command_unavailable", command.availability.reason);
    }
    if (command.argument.required && !argument) {
      throw new AxlClientError(
        "missing_command_argument",
        `/${command.name} requires ${command.argument.hint ?? "an argument"}`,
      );
    }
    if (command.source === "presentation") {
      const handler = this.presentation().find((candidate) => candidate.id === command.id);
      if (handler === undefined) {
        throw new AxlClientError("unsupported_command", `Command /${command.name} has no handler`);
      }
      await handler.run(argument);
      return { state: "completed", command: command.name };
    }
    if (command.context === "session" && sessionId === undefined) {
      throw new AxlClientError("command_unavailable", "Open a session first");
    }
    if (command.extensionId !== undefined) {
      const result = await this.client.invokeExtensionCommand(
        {
          sessionId: sessionId as SessionId,
          name: command.name,
          args: { ...(argument === undefined ? {} : { argument }) },
        },
        options,
      );
      return {
        state: "completed",
        command: command.name,
        ...(result.content === undefined ? {} : { content: result.content }),
      };
    }

    switch (command.name) {
      case "model": {
        if (!argument) return { state: "focus", surface: "model" };
        const separator = argument.indexOf("/");
        if (separator <= 0 || separator === argument.length - 1) {
          throw new AxlClientError("invalid_command_argument", "Use /model provider/model");
        }
        const update = {
          providerId: argument.slice(0, separator),
          modelId: argument.slice(separator + 1),
        };
        await this.client.request("session.configure", {
          sessionId: sessionId as SessionId,
          ...update,
        });
        return { state: "session-configured", command: "model", update };
      }
      case "thinking": {
        if (!argument) return { state: "focus", surface: "thinking" };
        if (!THINKING_LEVELS.includes(argument as ThinkingLevel)) {
          throw new AxlClientError(
            "invalid_command_argument",
            `Thinking level must be ${THINKING_LEVELS.join(", ")}`,
          );
        }
        const update = { thinkingLevel: argument as ThinkingLevel };
        await this.client.request("session.configure", {
          sessionId: sessionId as SessionId,
          ...update,
        });
        return { state: "session-configured", command: "thinking", update };
      }
      case "providers":
      case "mcp":
      case "login":
        return {
          state: "focus",
          surface: command.name,
          ...(argument === undefined ? {} : { argument }),
        };
      case "resume":
        if (!argument) return { state: "focus", surface: "resume" };
        return {
          state: "open-session",
          session: await this.client.request("session.resume", {
            sessionId: argument as SessionId,
          }),
        };
      case "fork":
        if (!argument) return { state: "focus", surface: "fork" };
        return {
          state: "open-session",
          session: await this.client.request("session.fork", {
            sessionId: sessionId as SessionId,
            fromEventId: argument as EventId,
          }),
        };
      case "requeue":
        if (!argument) return { state: "focus", surface: "requeue" };
        await this.client.request("session.queue.requeue", {
          sessionId: sessionId as SessionId,
          queueItemId: argument as EventId,
          priority: "back",
        });
        return { state: "completed", command: command.name };
      case "attach":
        return {
          state: "focus",
          surface: "attach",
          ...(argument === undefined ? {} : { argument }),
        };
      case "review":
        if (
          argument !== undefined &&
          argument !== "working" &&
          argument !== "last-turn" &&
          argument !== "off"
        ) {
          throw new AxlClientError(
            "invalid_command_argument",
            "Use /review working, /review last-turn, or /review off",
          );
        }
        return {
          state: "focus",
          surface: "review",
          ...(argument === undefined ? {} : { argument }),
        };
      case "refresh":
        return {
          state: "provider-catalog-refreshed",
          command: "refresh",
          result: await this.client.refreshProviderCatalogs(
            argument ? { providerId: argument } : {},
            options,
          ),
        };
      case "logout":
        if (!argument) return { state: "focus", surface: "logout" };
        return {
          state: "provider-logged-out",
          command: "logout",
          result: await this.client.logoutProvider({ providerId: argument }, options),
        };
      case "request": {
        if (!argument) return { state: "focus", surface: "request" };
        if (options.requestSettings === undefined) {
          throw new AxlClientError(
            "command_unavailable",
            "Request settings are unavailable for this runtime",
          );
        }
        const [field, value, extra] = argument.split(/\s+/u);
        if (
          extra !== undefined ||
          value === undefined ||
          (field !== "output" && field !== "idle")
        ) {
          throw new AxlClientError(
            "invalid_command_argument",
            "Use /request output <tokens|model> or /request idle <milliseconds|disabled>",
          );
        }
        const requestSettings = parseModelRequestSettings({
          ...options.requestSettings,
          ...(field === "output"
            ? { maxOutputTokens: value === "model" ? null : Number(value) }
            : { httpIdleTimeoutMs: value === "disabled" ? 0 : Number(value) }),
        });
        await this.client.request("session.configure", {
          sessionId: sessionId as SessionId,
          requestSettings,
        });
        return {
          state: "session-configured",
          command: "request",
          update: { requestSettings },
        };
      }
      case "reload":
        if (argument) throw new AxlClientError("invalid_command_argument", "Use /reload");
        await this.client.request("session.reload", { sessionId: sessionId as SessionId });
        return { state: "completed", command: command.name };
      case "compact": {
        const result = await this.client.request("session.compact", {
          sessionId: sessionId as SessionId,
          ...(argument === undefined ? {} : { instructions: argument }),
        });
        return { state: result.state, command: command.name };
      }
      case "clone": {
        if (argument) throw new AxlClientError("invalid_command_argument", "Use /clone");
        const session = await this.client.request("session.clone", {
          sessionId: sessionId as SessionId,
        });
        return { state: "open-session", session };
      }
      case "rename": {
        await this.client.request("session.rename", {
          sessionId: sessionId as SessionId,
          title: argument as string,
        });
        return { state: "completed", command: command.name };
      }
      case "import":
      case "export":
        return {
          state: "focus",
          surface: command.name,
          ...(argument === undefined ? {} : { argument }),
        };
      case "dispose":
      case "delete":
        if (argument) {
          throw new AxlClientError("invalid_command_argument", `Use /${command.name}`);
        }
        return { state: "focus", surface: command.name };
      default:
        throw new AxlClientError(
          "unsupported_command",
          `Command /${command.name} is not supported`,
        );
    }
  }
}
