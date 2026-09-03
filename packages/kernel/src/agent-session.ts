// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import {
  type AssistantContent,
  type AssistantStopReason,
  type CanonicalEvent,
  EVENT_FORMAT_VERSION,
  type EventId,
  type EventPayloadMap,
  type EventType,
  isTerminalModelStreamEvent,
  type ModelMessage,
  type OperationId,
  parseEvent,
  parseOperationId,
  type SessionActivityFrame,
  type TerminalModelStreamEvent,
  type ToolCallRequest,
  type Usage,
  type UserContent,
} from "@axl/protocol";

import { type ExtensionHost, NOOP_EXTENSION_HOST } from "./extension-host.ts";
import { type EventLogOptions, JsonlEventLog } from "./jsonl-event-log.ts";
import type { ModelPort } from "./model-port.ts";
import { SandboxViolationError } from "./path-policy.ts";
import type { StablePrompt } from "./prompt.ts";
import { ReplayError, verifyToolCallIntegrity } from "./replay.ts";
import { SessionTree } from "./session-tree.ts";
import type { ToolExecutionResult, ToolRegistry } from "./tools.ts";

export class OperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationConflictError";
  }
}

/** The maximum model calls one turn may make before the kernel stops loudly. */
const DEFAULT_MAX_MODEL_CALLS_PER_TURN = 50;

function unansweredToolCalls(events: readonly CanonicalEvent[]): CanonicalEvent<"tool.call">[] {
  const pending = new Map<string, CanonicalEvent<"tool.call">>();
  for (const event of events) {
    if (event.type === "tool.call") pending.set(event.payload.callId, event);
    else if (event.type === "tool.result") pending.delete(event.payload.callId);
  }
  return [...pending.values()];
}

function unansweredInteractions(
  events: readonly CanonicalEvent[],
): CanonicalEvent<"interaction.requested">[] {
  const pending = new Map<string, CanonicalEvent<"interaction.requested">>();
  for (const event of events) {
    if (event.type === "interaction.requested") pending.set(event.payload.interactionId, event);
    else if (event.type === "interaction.resolved") pending.delete(event.payload.interactionId);
  }
  return [...pending.values()];
}

export interface AgentSessionOptions {
  readonly model: ModelPort;
  readonly tools: ToolRegistry;
  /**
   * The stable prompt, frozen for the life of the session. A fresh log records
   * its sections as `prompt.section` events. Takes precedence over `system`.
   */
  readonly prompt?: StablePrompt;
  readonly system?: string;
  readonly cwd: string;
  readonly extensionHost?: ExtensionHost;
  readonly maxModelCallsPerTurn?: number;
  readonly log?: EventLogOptions;
  /** Sandbox state announced at every open as a `sandbox.configured` event. */
  readonly sandbox?: EventPayloadMap["sandbox.configured"];
  /** Model configuration announced at every open as a `config.model` event. */
  readonly configModel?: EventPayloadMap["config.model"];
  /** Thinking configuration announced at every open as a `config.thinking` event. */
  readonly configThinking?: EventPayloadMap["config.thinking"];
  /** Optional web-tool configuration announced at every open. */
  readonly configTools?: EventPayloadMap["config.tools"];
  /** Dialect boundary announced at open; the payload carries its own reason. */
  readonly configDialect?: EventPayloadMap["config.dialect"];
  /** Live tail: invoked after each event is durably appended, in append order. */
  readonly onEvent?: (event: CanonicalEvent) => void;
  /** Non-durable model deltas for responsive attached clients. */
  readonly onActivity?: (frame: SessionActivityFrame) => void;
}

export interface TurnResult {
  /** Every event this turn appended, in order. */
  readonly events: readonly CanonicalEvent[];
  readonly stopReason: AssistantStopReason;
}

/** Projects a branch lineage onto the model-facing message history. */
export function messagesFromLineage(events: readonly CanonicalEvent[]): readonly ModelMessage[] {
  const messages: ModelMessage[] = [];
  let toolCallingAssistant: Extract<ModelMessage, { role: "assistant" }> | undefined;
  for (const event of events) {
    if (event.type === "user.message") {
      toolCallingAssistant = undefined;
      messages.push({ role: "user", content: event.payload.content });
    } else if (event.type === "user.shell") {
      toolCallingAssistant = undefined;
      if (!event.payload.excluded) {
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `[shell]\n$ ${event.payload.command}\n${event.payload.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("")}`,
            },
          ],
        });
      }
    } else if (event.type === "assistant.message") {
      toolCallingAssistant = { role: "assistant", content: event.payload.content, toolCalls: [] };
      messages.push(toolCallingAssistant);
    } else if (event.type === "tool.call") {
      if (toolCallingAssistant === undefined) {
        throw new ReplayError(`Tool call ${event.id} has no preceding assistant turn`);
      }
      (toolCallingAssistant.toolCalls as ToolCallRequest[]).push({
        callId: event.payload.callId,
        name: event.payload.name === "shell" ? "bash" : event.payload.name,
        input: event.payload.input,
      });
    } else if (event.type === "tool.result") {
      messages.push({
        role: "tool",
        callId: event.payload.callId,
        name: event.payload.name === "shell" ? "bash" : event.payload.name,
        content: event.payload.content,
        isError: event.payload.isError,
      });
    } else if (event.type === "context.injected") {
      toolCallingAssistant = undefined;
      messages.push({
        role: "user",
        content: [{ type: "text", text: `[${event.payload.source}]\n${event.payload.content}` }],
      });
    }
    // Configuration, prompt, sandbox, and error events are not model messages.
  }
  return messages;
}

interface TurnOutcome {
  readonly content: readonly AssistantContent[];
  readonly toolCalls: readonly ToolCallRequest[];
  readonly stopReason: AssistantStopReason;
  readonly usage?: Usage;
  readonly errorMessage?: string;
}

/**
 * A live session over one event-log branch: the agent loop, tool dispatch,
 * cancellation, and operation ownership. Exactly one operation may mutate the
 * branch at a time; a second `runTurn` while one is active fails loudly.
 */
export class AgentSession {
  readonly log: JsonlEventLog;
  private readonly model: ModelPort;
  private readonly tools: ToolRegistry;
  private readonly host: ExtensionHost;
  private readonly onEvent: ((event: CanonicalEvent) => void) | undefined;
  private readonly onActivity: ((frame: SessionActivityFrame) => void) | undefined;
  private readonly system: string | undefined;
  private readonly maxModelCalls: number;
  private tip: EventId | null;
  private messages: ModelMessage[];
  private activeOperation: OperationId | null = null;

  private constructor(
    log: JsonlEventLog,
    events: readonly CanonicalEvent[],
    options: AgentSessionOptions,
  ) {
    this.log = log;
    this.model = options.model;
    this.tools = options.tools;
    this.host = options.extensionHost ?? NOOP_EXTENSION_HOST;
    this.onEvent = options.onEvent;
    this.onActivity = options.onActivity;
    this.system = options.prompt?.text ?? options.system;
    this.maxModelCalls = options.maxModelCallsPerTurn ?? DEFAULT_MAX_MODEL_CALLS_PER_TURN;
    if (!Number.isSafeInteger(this.maxModelCalls) || this.maxModelCalls < 1) {
      throw new TypeError("maxModelCallsPerTurn must be a positive safe integer");
    }
    this.tip = events.at(-1)?.id ?? null;
    this.messages = [...messagesFromLineage(events)];
  }

  /**
   * Opens a session over a log file. A fresh log gets a `session.created`
   * root; an existing log is integrity-checked and its linear history
   * projected into the model surface.
   */
  static async open(
    path: string,
    sessionId: unknown,
    options: AgentSessionOptions,
  ): Promise<AgentSession> {
    const opened = await JsonlEventLog.open(path, sessionId, options.log ?? {});
    const tree = SessionTree.fromEvents(opened.log.sessionId, opened.events);
    verifyToolCallIntegrity(tree);
    const tip = opened.events.at(-1)?.id;
    const lineage = tip === undefined ? [] : tree.lineage(tip);
    const session = new AgentSession(opened.log, lineage, options);
    for (const interaction of unansweredInteractions(lineage)) {
      await session.append(interaction.operationId, "interaction.resolved", {
        interactionId: interaction.payload.interactionId,
        action: "cancel",
      });
    }
    for (const call of unansweredToolCalls(lineage)) {
      const result = await session.append(call.operationId, "tool.result", {
        callId: call.payload.callId,
        name: call.payload.name,
        content: [
          {
            type: "text",
            text: "Tool execution was aborted because the daemon stopped before recording a result.",
          },
        ],
        isError: true,
        details: { endedBy: "abort", reason: "daemon_restart" },
      });
      session.messages.push({
        role: "tool",
        callId: call.payload.callId,
        name: call.payload.name === "shell" ? "bash" : call.payload.name,
        content: result.payload.content,
        isError: true,
      });
    }
    if (opened.events.length === 0) {
      await session.append(undefined, "session.created", { cwd: options.cwd });
      // The stable prompt freezes at session start; its sections are logged once.
      for (const section of options.prompt?.sections ?? []) {
        await session.append(undefined, "prompt.section", section);
      }
    }
    // Tool schemas are model-visible configuration, so every runtime boundary
    // records the exact current roster before the next model request.
    for (const tool of options.tools.declarations()) {
      await session.append(undefined, "tool.schema", tool);
    }
    // Sandbox and configuration are announced at every open so a resumed
    // session reflects what it is actually running under now.
    if (options.sandbox !== undefined) {
      await session.append(undefined, "sandbox.configured", options.sandbox);
    }
    if (options.configModel !== undefined) {
      await session.append(undefined, "config.model", options.configModel);
    }
    if (options.configThinking !== undefined) {
      await session.append(undefined, "config.thinking", options.configThinking);
    }
    if (options.configTools !== undefined) {
      await session.append(undefined, "config.tools", options.configTools);
    }
    if (options.configDialect !== undefined) {
      await session.append(undefined, "config.dialect", options.configDialect);
    }
    await session.host.activate();
    return session;
  }

  /**
   * Appends context — a skill body, steering, an injected instruction — to the
   * conversation surface. Prior content is never rewritten, reordered, or
   * timestamped; the prompt-cache prefix survives every injection.
   */
  async requestInteraction(
    payload: EventPayloadMap["interaction.requested"],
  ): Promise<CanonicalEvent> {
    if (this.activeOperation === null) {
      throw new OperationConflictError("Interactions require an active session operation");
    }
    return this.append(this.activeOperation, "interaction.requested", payload);
  }

  async resolveInteraction(
    payload: EventPayloadMap["interaction.resolved"],
  ): Promise<CanonicalEvent> {
    if (this.activeOperation === null) {
      throw new OperationConflictError("No active operation can receive this interaction response");
    }
    return this.append(this.activeOperation, "interaction.resolved", payload);
  }

  async injectContext(source: string, content: string): Promise<CanonicalEvent> {
    if (this.activeOperation !== null) {
      throw new OperationConflictError(
        `Operation ${this.activeOperation} owns this branch; steering lands after it`,
      );
    }
    const event = await this.append(undefined, "context.injected", { source, content });
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: `[${source}]\n${content}` }],
    });
    return event;
  }

  async dispose(): Promise<void> {
    await this.host.dispose();
    await this.log.drain();
  }

  /** Runs a user-requested shell command through the registered sandboxed shell tool. */
  async runShell(
    command: string,
    excluded: boolean,
    signal?: AbortSignal,
  ): Promise<CanonicalEvent<"user.shell">> {
    if (this.activeOperation !== null) {
      throw new OperationConflictError(
        `Operation ${this.activeOperation} already owns this branch`,
      );
    }
    const shell = this.tools.get("bash");
    if (!shell) throw new Error("The bash tool is unavailable in this session");
    const operationId = parseOperationId(randomUUID(), "operationId");
    this.activeOperation = operationId;
    try {
      const result = await shell.execute({ command }, signal ?? new AbortController().signal);
      const event = await this.append(operationId, "user.shell", {
        command,
        content: result.content,
        isError: result.isError,
        excluded,
      });
      if (!excluded) {
        const output = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("");
        this.messages.push({
          role: "user",
          content: [{ type: "text", text: `[shell]\n$ ${command}\n${output}` }],
        });
      }
      return event;
    } finally {
      this.activeOperation = null;
    }
  }

  /** Runs one user turn: model calls and tool executions until a final stop. */
  async runTurn(content: readonly UserContent[], signal?: AbortSignal): Promise<TurnResult> {
    if (this.activeOperation !== null) {
      throw new OperationConflictError(
        `Operation ${this.activeOperation} already owns this branch`,
      );
    }
    const operationId = parseOperationId(randomUUID(), "operationId");
    this.activeOperation = operationId;
    const appended: CanonicalEvent[] = [];
    try {
      appended.push(await this.append(operationId, "user.message", { content }));
      this.messages.push({ role: "user", content });

      const activity = { sequence: 0 };
      for (let call = 0; ; call += 1) {
        if (call >= this.maxModelCalls) {
          appended.push(
            await this.append(operationId, "session.error", {
              code: "turn_model_call_limit",
              message: `Turn exceeded ${this.maxModelCalls} model calls`,
              retryable: false,
            }),
          );
          return { events: appended, stopReason: "error" };
        }

        const outcome = await this.modelTurn(operationId, activity, signal);
        appended.push(
          await this.append(operationId, "assistant.message", {
            content: outcome.content,
            stopReason: outcome.stopReason,
            ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
            ...(outcome.errorMessage === undefined ? {} : { errorMessage: outcome.errorMessage }),
          }),
        );
        this.messages.push({
          role: "assistant",
          content: outcome.content,
          toolCalls: outcome.toolCalls,
        });
        this.onActivity?.({
          operationId,
          sequence: ++activity.sequence,
          type: "clear",
        });

        if (outcome.stopReason !== "tool_use") {
          return { events: appended, stopReason: outcome.stopReason };
        }
        if (outcome.toolCalls.length === 0) {
          appended.push(
            await this.append(operationId, "session.error", {
              code: "missing_tool_call",
              message: "Model ended with tool_use but supplied no tool call",
              retryable: false,
            }),
          );
          return { events: appended, stopReason: "error" };
        }
        const aborted = await this.executeToolCalls(
          operationId,
          outcome.toolCalls,
          appended,
          signal,
        );
        if (aborted) return { events: appended, stopReason: "aborted" };
      }
    } finally {
      this.activeOperation = null;
    }
  }

  private async modelTurn(
    operationId: OperationId,
    activity: { sequence: number },
    signal: AbortSignal | undefined,
  ): Promise<TurnOutcome> {
    let thinking = "";
    let text = "";
    const toolCalls: ToolCallRequest[] = [];
    let terminal: TerminalModelStreamEvent | undefined;

    try {
      // Snapshot: the port must never observe the turn mutating history under it.
      for await (const event of this.model.stream({
        system: this.system,
        messages: [...this.messages],
        tools: this.tools.declarations(),
        signal,
      })) {
        if (event.type === "text_delta") {
          text += event.text;
          this.onActivity?.({
            operationId,
            sequence: ++activity.sequence,
            type: "text_delta",
            text: event.text,
          });
        } else if (event.type === "thinking_delta") {
          thinking += event.text;
          this.onActivity?.({
            operationId,
            sequence: ++activity.sequence,
            type: "thinking_delta",
            text: event.text,
          });
        } else if (event.type === "tool_call") {
          toolCalls.push({ callId: event.callId, name: event.name, input: event.input });
          this.onActivity?.({
            operationId,
            sequence: ++activity.sequence,
            type: "tool_call",
            call: { callId: event.callId, name: event.name },
          });
        }
        if (isTerminalModelStreamEvent(event)) {
          terminal = event;
          break;
        }
      }
    } catch (error) {
      terminal = signal?.aborted
        ? { type: "aborted" }
        : {
            type: "error",
            code: "model_port_failure",
            message: error instanceof Error ? error.message : "model port threw a non-Error value",
            retryable: false,
          };
    }
    if (terminal === undefined) {
      terminal = signal?.aborted
        ? { type: "aborted" }
        : {
            type: "error",
            code: "model_stream_truncated",
            message: "model stream ended without a terminal event",
            retryable: false,
          };
    }

    const content: AssistantContent[] = [];
    if (thinking.length > 0) content.push({ type: "thinking", text: thinking });
    if (text.length > 0) content.push({ type: "text", text });

    if (terminal.type === "completed") {
      return { content, toolCalls, stopReason: terminal.stopReason, usage: terminal.usage };
    }
    if (terminal.type === "aborted") {
      return { content, toolCalls: [], stopReason: "aborted" };
    }
    return {
      content,
      toolCalls: [],
      stopReason: "error",
      errorMessage: `${terminal.code}: ${terminal.message}`,
    };
  }

  /** Executes each call, appending paired call/result events. Returns true when aborted. */
  private async executeToolCalls(
    operationId: OperationId,
    toolCalls: readonly ToolCallRequest[],
    appended: CanonicalEvent[],
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    for (const call of toolCalls) {
      appended.push(
        await this.append(operationId, "tool.call", {
          callId: call.callId,
          name: call.name,
          input: call.input,
        }),
      );
      const { result, violation } = await this.executeTool(call, signal);
      if (violation !== undefined) {
        appended.push(
          await this.append(operationId, "sandbox.violation", {
            capability: violation.capability,
            reason: violation.reason,
          }),
        );
      }
      appended.push(
        await this.append(operationId, "tool.result", {
          callId: call.callId,
          name: call.name,
          content: result.content,
          isError: result.isError,
          ...(result.details === undefined ? {} : { details: result.details }),
        }),
      );
      this.messages.push({
        role: "tool",
        callId: call.callId,
        name: call.name,
        content: result.content,
        isError: result.isError,
      });
      if (signal?.aborted) return true;
    }
    return false;
  }

  private async executeTool(
    call: ToolCallRequest,
    signal: AbortSignal | undefined,
  ): Promise<{ result: ToolExecutionResult; violation?: SandboxViolationError }> {
    const tool = this.tools.get(call.name);
    if (tool === undefined) {
      // Authority is registry membership: an unregistered name is not executable.
      return {
        result: {
          content: [{ type: "text", text: `Tool ${call.name} is not registered` }],
          isError: true,
        },
      };
    }
    try {
      return { result: await tool.execute(call.input, signal ?? new AbortController().signal) };
    } catch (error) {
      const failure = {
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : "tool execution failed",
          },
        ],
        isError: true,
      };
      if (error instanceof SandboxViolationError) return { result: failure, violation: error };
      return { result: failure };
    }
  }

  private async append<Type extends EventType>(
    operationId: OperationId | undefined,
    type: Type,
    payload: EventPayloadMap[Type],
  ): Promise<CanonicalEvent<Type>> {
    const event = parseEvent({
      version: EVENT_FORMAT_VERSION,
      id: randomUUID(),
      sessionId: this.log.sessionId,
      ...(operationId === undefined ? {} : { operationId }),
      parentId: this.tip,
      timestamp: Date.now(),
      type,
      payload,
    });
    const stored = await this.log.append(event);
    this.tip = stored.id;
    this.onEvent?.(stored);
    return stored as CanonicalEvent<Type>;
  }
}
