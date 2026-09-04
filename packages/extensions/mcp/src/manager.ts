// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  CallToolResult,
  ClientNotification,
  ClientRequest,
  ContentBlock,
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
  ElicitRequest,
  ElicitResult,
  Notification,
  Request,
  Result,
  Root,
  SamplingMessage,
  SamplingMessageContentBlock,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolResultSchema,
  CreateMessageRequestSchema,
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
  ErrorCode,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  McpError,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  TaskStatusNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { redactJsonValue } from "@axl/kernel";
import type { ExtensionHost, KernelTool, ModelTurnRequest, ToolExecutionResult } from "@axl/kernel";
import type { JsonObject, JsonValue, ModelMessage, UserContent } from "@axl/protocol";

import type { McpServerConfig, NamedMcpServerConfig } from "./config.ts";
import { createOAuthSession, type OAuthSession } from "./oauth.ts";
import { FileTaskStore } from "./task-store.ts";
import type { McpManagerOptions } from "./types.ts";

const MAX_BLOB_BYTES = 25_000_000;
const MAX_JSON_BYTES = 200_000;
const MAX_LOG_ENTRIES = 100;
const SAFE_ENVIRONMENT = ["PATH", "HOME", "TERM", "LANG", "USER", "SHELL"] as const;
const SENSITIVE_FIELD = /(?:password|passwd|secret|token|api[_-]?key|credit[_-]?card|cvv)/i;

type AnyClient = Client<Request, Notification, Result>;

type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;

interface Connection {
  readonly client: AnyClient;
  readonly transport: McpTransport;
  readonly oauth?: OAuthSession;
  readonly cleanup?: () => Promise<void>;
  readonly taskStore: TaskStore;
  readonly logs: JsonValue[];
}

function toJson(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("MCP value is not JSON serializable");
  if (Buffer.byteLength(encoded) > MAX_JSON_BYTES) {
    throw new Error(`MCP value exceeds ${MAX_JSON_BYTES} bytes`);
  }
  return JSON.parse(encoded) as JsonValue;
}

function asObject(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as JsonObject;
}

function requiredString(input: JsonObject, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`mcp.${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(input: JsonObject, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`mcp.${name} must be a non-empty string`);
  }
  return value;
}

function rejectUnknown(input: JsonObject): void {
  const allowed = [
    "action",
    "server",
    "name",
    "arguments",
    "uri",
    "cursor",
    "taskTtl",
    "taskId",
    "level",
    "ref",
    "argument",
    "context",
  ];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new TypeError(`mcp.${key} is not allowed`);
  }
}

function errorResult(message: string): ToolExecutionResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function rejected(action: "decline" | "cancel"): string {
  return action === "cancel" ? "cancelled" : "declined";
}

function safeEnvironment(
  configured: Readonly<Record<string, string>>,
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of SAFE_ENVIRONMENT) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  for (const [target, sourceName] of Object.entries(configured)) {
    const value = source[sourceName];
    if (value === undefined) {
      throw new Error(`MCP environment source ${sourceName} is not set for ${target}`);
    }
    result[target] = value;
  }
  return result;
}

function httpHeaders(
  configured: Readonly<Record<string, string>>,
  source: Readonly<Record<string, string | undefined>>,
): Headers {
  const headers = new Headers();
  for (const [header, sourceName] of Object.entries(configured)) {
    const value = source[sourceName];
    if (value === undefined) throw new Error(`MCP header source ${sourceName} is not set`);
    headers.set(header, value);
  }
  return headers;
}

function isInside(path: string, parent: string): boolean {
  const fromParent = relative(parent, path);
  return fromParent === "" || (!fromParent.startsWith(`..${sep}`) && fromParent !== "..");
}

function blocks(value: SamplingMessage["content"]): readonly SamplingMessageContentBlock[] {
  return Array.isArray(value) ? value : [value];
}

function contentText(content: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "text") parts.push(item.text);
    else if (item.type === "resource_link") parts.push(`[resource ${item.uri}]`);
    else if (item.type === "resource") {
      parts.push(
        "text" in item.resource
          ? `[resource ${item.resource.uri}]\n${item.resource.text}`
          : `[binary resource ${item.resource.uri}]`,
      );
    } else {
      parts.push(`[${item.type} ${item.mimeType}]`);
    }
  }
  return parts.join("\n");
}

function samplingMessages(messages: readonly SamplingMessage[]): ModelMessage[] {
  const output: ModelMessage[] = [];
  for (const message of messages) {
    const items = blocks(message.content);
    const toolResults = items.filter((item) => item.type === "tool_result");
    if (toolResults.length > 0) {
      if (message.role !== "user" || toolResults.length !== items.length) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Tool results must be in a user message containing only tool results",
        );
      }
      for (const item of toolResults) {
        output.push({
          role: "tool",
          callId: item.toolUseId,
          name: "mcp-sampling-tool",
          content: [{ type: "text", text: contentText(item.content) }],
          isError: item.isError ?? false,
        });
      }
      continue;
    }

    const unsupported = items.find((item) => item.type === "image" || item.type === "audio");
    if (unsupported) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `The active Axl model cannot accept MCP ${unsupported.type} sampling content`,
      );
    }
    const text = items
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
    if (message.role === "user") {
      output.push({ role: "user", content: [{ type: "text", text }] });
    } else {
      const toolCalls = items
        .filter((item) => item.type === "tool_use")
        .map((item) => ({ callId: item.id, name: item.name, input: item.input as JsonObject }));
      output.push({
        role: "assistant",
        content: text ? [{ type: "text", text }] : [],
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
      });
    }
  }
  return output;
}

async function sampleModel(
  model: McpManagerOptions["model"],
  modelId: string,
  params: CreateMessageRequest["params"],
  signal: AbortSignal,
  secretValues: readonly string[],
): Promise<CreateMessageResult | CreateMessageResultWithTools> {
  const safeParams = redactJsonValue(
    toJson(params),
    secretValues,
    false,
  ) as unknown as CreateMessageRequest["params"];
  if (safeParams.maxTokens < 16) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "The active Axl provider requires maxTokens to be at least 16",
    );
  }
  const request: ModelTurnRequest = {
    ...(safeParams.systemPrompt === undefined ? {} : { system: safeParams.systemPrompt }),
    messages: samplingMessages(safeParams.messages),
    tools: (safeParams.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.title ?? tool.name,
      inputSchema: toJson(tool.inputSchema) as JsonObject,
    })),
    maxOutputTokens: safeParams.maxTokens,
    toolChoice: safeParams.toolChoice?.mode ?? "auto",
    signal,
  };
  let text = "";
  const toolUses: Array<{
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }> = [];
  let stopReason = "endTurn";
  for await (const event of model.stream(request)) {
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "tool_call") {
      toolUses.push({ type: "tool_use", id: event.callId, name: event.name, input: event.input });
    } else if (event.type === "error") {
      throw new McpError(ErrorCode.InternalError, event.message);
    } else if (event.type === "aborted") {
      throw new DOMException("MCP sampling aborted", "AbortError");
    } else if (event.type === "completed") {
      stopReason =
        event.stopReason === "tool_use"
          ? "toolUse"
          : event.stopReason === "length"
            ? "maxTokens"
            : "endTurn";
    }
  }
  const content: SamplingMessageContentBlock[] = [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...toolUses,
  ];
  return {
    role: "assistant",
    content: content.length === 1 ? (content[0] as SamplingMessageContentBlock) : content,
    model: modelId,
    stopReason,
  };
}

function hasSensitiveFormField(request: ElicitRequest): boolean {
  if (request.params.mode === "url") return false;
  if (SENSITIVE_FIELD.test(request.params.message)) return true;
  return Object.entries(request.params.requestedSchema.properties).some(([name, schema]) =>
    SENSITIVE_FIELD.test(`${name} ${schema.title ?? ""} ${schema.description ?? ""}`),
  );
}

export class McpManager implements ExtensionHost {
  private readonly options: McpManagerOptions;
  private readonly configurations: ReadonlyMap<string, NamedMcpServerConfig>;
  private readonly connections = new Map<string, Promise<Connection>>();
  private readonly schemaValidator = new AjvJsonSchemaValidator();
  private readonly secretValues: Set<string>;
  private disposed = false;

  constructor(options: McpManagerOptions) {
    this.options = options;
    this.configurations = new Map(options.servers.map((server) => [server.name, server]));
    this.secretValues = new Set(options.secretValues ?? []);
  }

  activate(): void {
    // Connections are deliberately lazy. Disabled or unused servers do no work.
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const settled = await Promise.allSettled(this.connections.values());
    await Promise.all(
      settled.flatMap((result) =>
        result.status === "fulfilled" ? [this.closeConnection(result.value)] : [],
      ),
    );
    this.connections.clear();
  }

  makeTool(): KernelTool {
    return {
      name: "mcp",
      description:
        "Use configured Model Context Protocol servers. Supports server discovery, tools, resources, prompts, completions, logging, tasks, progress, and cancellation.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "list_servers",
              "ping",
              "server_info",
              "list_tools",
              "call_tool",
              "list_resources",
              "list_resource_templates",
              "read_resource",
              "subscribe_resource",
              "unsubscribe_resource",
              "list_prompts",
              "get_prompt",
              "complete",
              "set_log_level",
              "logs",
              "list_tasks",
              "get_task",
              "get_task_result",
              "cancel_task",
            ],
          },
          server: { type: "string" },
          name: { type: "string" },
          arguments: { type: "object" },
          uri: { type: "string" },
          cursor: { type: "string" },
          taskTtl: { type: "integer", minimum: 1 },
          taskId: { type: "string" },
          level: { type: "string" },
          ref: { type: "object" },
          argument: { type: "object" },
          context: { type: "object" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (input, signal) => {
        try {
          return await this.execute(input, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          return errorResult(
            this.redactedText(error instanceof Error ? error.message : String(error)),
          );
        }
      },
    };
  }

  private async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
    rejectUnknown(input);
    const action = requiredString(input, "action");
    if (action === "list_servers") {
      return this.jsonResult(
        this.options.servers.map((server) => ({
          name: server.name,
          transport: server.config.transport,
          source: server.source,
        })),
      );
    }
    const serverName = requiredString(input, "server");
    const server = this.configurations.get(serverName);
    if (!server) return errorResult(`Unknown MCP server ${serverName}`);
    const connection = await this.connection(server, signal);
    const options = this.requestOptions(server.config, signal, connection.logs);

    switch (action) {
      case "ping":
        return this.jsonResult(await connection.client.ping(options));
      case "server_info":
        return this.jsonResult({
          implementation: connection.client.getServerVersion(),
          capabilities: connection.client.getServerCapabilities(),
          instructions: connection.client.getInstructions(),
        });
      case "list_tools":
        return this.jsonResult(
          await connection.client.listTools(
            optionalString(input, "cursor") ? { cursor: optionalString(input, "cursor") } : {},
            options,
          ),
        );
      case "call_tool":
        return this.callTool(connection, server, input, signal);
      case "list_resources":
        return this.jsonResult(
          await connection.client.listResources(
            optionalString(input, "cursor") ? { cursor: optionalString(input, "cursor") } : {},
            options,
          ),
        );
      case "list_resource_templates":
        return this.jsonResult(
          await connection.client.listResourceTemplates(
            optionalString(input, "cursor") ? { cursor: optionalString(input, "cursor") } : {},
            options,
          ),
        );
      case "read_resource":
        return this.resourceResult(
          await connection.client.readResource({ uri: requiredString(input, "uri") }, options),
        );
      case "subscribe_resource":
        return this.jsonResult(
          await connection.client.subscribeResource({ uri: requiredString(input, "uri") }, options),
        );
      case "unsubscribe_resource":
        return this.jsonResult(
          await connection.client.unsubscribeResource(
            { uri: requiredString(input, "uri") },
            options,
          ),
        );
      case "list_prompts":
        return this.jsonResult(
          await connection.client.listPrompts(
            optionalString(input, "cursor") ? { cursor: optionalString(input, "cursor") } : {},
            options,
          ),
        );
      case "get_prompt":
        return this.jsonResult(
          await connection.client.getPrompt(
            {
              name: requiredString(input, "name"),
              ...(input.arguments === undefined
                ? {}
                : {
                    arguments: asObject(input.arguments, "mcp.arguments") as Record<string, string>,
                  }),
            },
            options,
          ),
        );
      case "complete":
        return this.jsonResult(
          await connection.client.complete(
            {
              ref: asObject(input.ref, "mcp.ref") as never,
              argument: asObject(input.argument, "mcp.argument") as never,
              ...(input.context === undefined
                ? {}
                : { context: asObject(input.context, "mcp.context") as never }),
            },
            options,
          ),
        );
      case "set_log_level":
        return this.jsonResult(
          await connection.client.setLoggingLevel(requiredString(input, "level") as never, options),
        );
      case "logs":
        return this.jsonResult(connection.logs);
      case "list_tasks":
        return this.jsonResult(
          await connection.client.experimental.tasks.listTasks(
            optionalString(input, "cursor"),
            options,
          ),
        );
      case "get_task":
        return this.jsonResult(
          await connection.client.experimental.tasks.getTask(
            requiredString(input, "taskId"),
            options,
          ),
        );
      case "get_task_result":
        return this.jsonResult(
          await connection.client.experimental.tasks.getTaskResult(
            requiredString(input, "taskId"),
            CallToolResultSchema,
            options,
          ),
        );
      case "cancel_task":
        return this.jsonResult(
          await connection.client.experimental.tasks.cancelTask(
            requiredString(input, "taskId"),
            options,
          ),
        );
      default:
        return errorResult(`Unknown MCP action ${action}`);
    }
  }

  private requestOptions(config: McpServerConfig, signal: AbortSignal, logs?: JsonValue[]) {
    return {
      signal,
      timeout: config.requestTimeoutMs,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: config.requestTimeoutMs * 5,
      ...(logs === undefined
        ? {}
        : {
            onprogress: (progress: unknown) => this.pushLog(logs, { type: "progress", progress }),
          }),
    };
  }

  private async callTool(
    connection: Connection,
    server: NamedMcpServerConfig,
    input: JsonObject,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const name = requiredString(input, "name");
    const arguments_ =
      input.arguments === undefined ? {} : asObject(input.arguments, "mcp.arguments");
    const tools = await connection.client.listTools(
      {},
      this.requestOptions(server.config, signal, connection.logs),
    );
    const metadata = tools.tools.find((tool) => tool.name === name);
    if (!metadata) return errorResult(`MCP server ${server.name} has no tool ${name}`);

    const consent = await this.options.interact(
      {
        kind: "mcp_tool",
        source: `mcp:${server.name}`,
        message: `Allow MCP tool ${name}?`,
        data: {
          name,
          arguments: this.redacted(arguments_) as JsonObject,
          annotations: this.redacted(metadata.annotations ?? {}),
        },
      },
      signal,
    );
    if (consent.action !== "accept") {
      return errorResult(`User ${rejected(consent.action)} MCP tool ${name}`);
    }

    const taskTtl = input.taskTtl;
    if (
      taskTtl !== undefined &&
      (typeof taskTtl !== "number" || !Number.isSafeInteger(taskTtl) || taskTtl < 1)
    ) {
      throw new TypeError("mcp.taskTtl must be a positive safe integer");
    }
    const useTask = metadata.execution?.taskSupport === "required" || taskTtl !== undefined;
    if (useTask) {
      const messages: JsonValue[] = [];
      let final: CallToolResult | undefined;
      for await (const message of connection.client.experimental.tasks.callToolStream(
        { name, arguments: arguments_ },
        CallToolResultSchema,
        {
          ...this.requestOptions(server.config, signal, connection.logs),
          task: { ttl: typeof taskTtl === "number" ? taskTtl : server.config.requestTimeoutMs * 5 },
        },
      )) {
        messages.push(this.redacted(message));
        if (message.type === "result") final = message.result;
        else if (message.type === "error") throw message.error;
      }
      if (!final) throw new Error(`MCP task tool ${name} ended without a result`);
      return this.callResult(final, { taskMessages: messages });
    }
    const result = await connection.client.callTool(
      { name, arguments: arguments_ },
      CallToolResultSchema,
      this.requestOptions(server.config, signal, connection.logs),
    );
    if (!("content" in result) || !Array.isArray(result.content)) {
      throw new Error(`MCP tool ${name} returned a legacy result`);
    }
    return this.callResult(result as CallToolResult);
  }

  private async connection(server: NamedMcpServerConfig, signal: AbortSignal): Promise<Connection> {
    if (this.disposed) throw new Error("MCP manager is disposed");
    const existing = this.connections.get(server.name);
    if (existing) return existing;
    const opening = this.open(server, signal);
    this.connections.set(server.name, opening);
    try {
      return await opening;
    } catch (error) {
      if (this.connections.get(server.name) === opening) this.connections.delete(server.name);
      throw error;
    }
  }

  private async open(server: NamedMcpServerConfig, signal: AbortSignal): Promise<Connection> {
    const logs: JsonValue[] = [];
    const taskStore = new FileTaskStore(
      join(this.options.stateDirectory, "tasks", `${server.name}-${this.options.sessionId}.json`),
      { secretValues: () => [...this.secretValues] },
    );
    const client = new Client(
      { name: "axl", title: "Axl", version: "0.0.0" },
      {
        capabilities: {
          roots: { listChanged: false },
          sampling: { tools: {} },
          elicitation: { form: {}, url: {} },
          tasks: {
            list: {},
            cancel: {},
            requests: {
              sampling: { createMessage: {} },
              elicitation: { create: {} },
            },
          },
        },
        taskStore,
        maxTaskQueueSize: 100,
      },
    );
    let oauthForClose: OAuthSession | undefined;
    let cleanupForClose: (() => Promise<void>) | undefined;
    client.onerror = (error) => this.pushLog(logs, { level: "error", data: error.message });
    client.onclose = () => {
      this.pushLog(logs, { level: "info", data: "connection closed" });
      if (!this.disposed) this.connections.delete(server.name);
      void oauthForClose
        ?.close()
        .catch((error: unknown) => this.pushLog(logs, { level: "error", data: String(error) }));
      void cleanupForClose?.().catch((error: unknown) =>
        this.pushLog(logs, { level: "error", data: String(error) }),
      );
    };
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: await this.roots(server.config),
    }));
    client.setRequestHandler(CreateMessageRequestSchema, (request, extra) =>
      this.taskAware(request, extra, () => this.handleSampling(server.name, request, extra.signal)),
    );
    client.setRequestHandler(ElicitRequestSchema, (request, extra) =>
      this.taskAware(request, extra, () =>
        this.handleElicitation(server.name, request, extra.signal),
      ),
    );
    client.setNotificationHandler(LoggingMessageNotificationSchema, (message) =>
      this.pushLog(logs, message.params),
    );
    for (const schema of [
      ToolListChangedNotificationSchema,
      PromptListChangedNotificationSchema,
      ResourceListChangedNotificationSchema,
      ResourceUpdatedNotificationSchema,
      ElicitationCompleteNotificationSchema,
      TaskStatusNotificationSchema,
    ]) {
      client.setNotificationHandler(schema, (message) => this.pushLog(logs, message));
    }

    const opened = await this.transport(server, signal);
    oauthForClose = opened.oauth;
    cleanupForClose = opened.cleanup;
    try {
      await client.connect(
        opened.transport as unknown as Transport,
        this.requestOptions(server.config, signal, logs),
      );
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || !opened.oauth) {
        await opened.oauth?.close();
        await opened.cleanup?.();
        throw error;
      }
      const code = opened.oauth.provider.takeAuthorizationCode();
      if (!code) {
        await opened.oauth.close();
        throw new Error(`MCP server ${server.name} requires authorization`);
      }
      if (!(opened.transport instanceof StreamableHTTPClientTransport)) {
        throw new Error("OAuth is only valid for Streamable HTTP transports");
      }
      await opened.transport.finishAuth(code);
      const retried = await this.transport(server, signal, opened.oauth);
      await client.connect(
        retried.transport as unknown as Transport,
        this.requestOptions(server.config, signal, logs),
      );
      return {
        client,
        transport: retried.transport,
        oauth: opened.oauth,
        ...(retried.cleanup === undefined ? {} : { cleanup: retried.cleanup }),
        taskStore,
        logs,
      };
    }
    return {
      client,
      transport: opened.transport,
      ...(opened.oauth ? { oauth: opened.oauth } : {}),
      ...(opened.cleanup === undefined ? {} : { cleanup: opened.cleanup }),
      taskStore,
      logs,
    };
  }

  private async transport(
    server: NamedMcpServerConfig,
    signal: AbortSignal,
    existingOAuth?: OAuthSession,
  ): Promise<{
    transport: McpTransport;
    oauth?: OAuthSession;
    cleanup?: () => Promise<void>;
  }> {
    const env = this.options.env ?? process.env;
    if (server.config.transport === "stdio") {
      const wrapped = this.options.wrapStdio({
        command: server.config.command,
        args: server.config.args,
        cwd: server.config.cwd ?? this.options.cwd,
        env: safeEnvironment(server.config.env, env),
      });
      let cleanupPromise: Promise<void> | undefined;
      const cleanupOperation = wrapped.cleanup;
      const cleanup =
        cleanupOperation === undefined
          ? undefined
          : () => {
              cleanupPromise ??= cleanupOperation();
              return cleanupPromise;
            };
      return {
        transport: new StdioClientTransport({
          command: wrapped.command,
          args: [...wrapped.args],
          cwd: wrapped.cwd,
          env: { ...wrapped.env },
          stderr: "ignore",
          maxBufferSize: MAX_BLOB_BYTES * 2,
        }),
        ...(cleanup === undefined ? {} : { cleanup }),
      };
    }

    const headers = httpHeaders(server.config.headers, env);
    const oauth =
      existingOAuth ??
      (server.config.oauth
        ? await createOAuthSession({
            path: join(this.options.stateDirectory, `${server.name}.json`),
            config: server.config.oauth,
            source: `mcp:${server.name}`,
            interact: this.options.interact,
            signal,
            env,
            onSecrets: (values) => {
              for (const value of values) this.secretValues.add(value);
            },
          })
        : undefined);
    const options: StreamableHTTPClientTransportOptions = {
      requestInit: { headers },
      ...(oauth ? { authProvider: oauth.provider } : {}),
    };
    return {
      transport: new StreamableHTTPClientTransport(new URL(server.config.url), options),
      ...(oauth ? { oauth } : {}),
    };
  }

  private async roots(config: McpServerConfig): Promise<Root[]> {
    const workspace = await realpath(this.options.cwd);
    const roots: Root[] = [];
    for (const configured of config.roots) {
      const path = await realpath(configured);
      if (!isInside(path, workspace)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `MCP root ${path} is outside workspace ${workspace}`,
        );
      }
      roots.push({ uri: pathToFileURL(path).href, name: basename(path) || path });
    }
    return roots;
  }

  private async handleSampling(
    serverName: string,
    request: CreateMessageRequest,
    signal: AbortSignal,
  ): Promise<CreateMessageResult | CreateMessageResultWithTools> {
    const approved = await this.options.interact(
      {
        kind: "mcp_sampling_request",
        source: `mcp:${serverName}`,
        message: "Allow this MCP server to request a model completion?",
        data: { request: this.redacted(request.params) },
      },
      signal,
    );
    if (approved.action !== "accept") {
      throw new McpError(-1, `User ${rejected(approved.action)} sampling request`);
    }
    const result = await sampleModel(
      this.options.model,
      this.options.modelId,
      request.params,
      signal,
      this.options.secretValues ?? [],
    );
    const released = await this.options.interact(
      {
        kind: "mcp_sampling_response",
        source: `mcp:${serverName}`,
        message: "Share this sampled response with the MCP server?",
        data: { response: this.redacted(result) },
      },
      signal,
    );
    if (released.action !== "accept") {
      throw new McpError(-1, `User ${rejected(released.action)} sampled response`);
    }
    return result;
  }

  private async handleElicitation(
    serverName: string,
    request: ElicitRequest,
    signal: AbortSignal,
  ): Promise<ElicitResult> {
    if (hasSensitiveFormField(request)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Form elicitation may not request credentials or payment secrets",
      );
    }
    if (request.params.mode === "url") {
      const url = new URL(request.params.url);
      if (
        url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      ) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "URL elicitation must use HTTPS except on loopback",
        );
      }
    }
    const response = await this.options.interact(
      {
        kind: request.params.mode === "url" ? "mcp_elicitation_url" : "mcp_elicitation_form",
        source: `mcp:${serverName}`,
        message: request.params.message,
        data: { request: this.redacted(request.params) },
      },
      signal,
    );
    if (response.action !== "accept") return { action: response.action };
    if (request.params.mode === "url") return { action: "accept" };
    const content = response.content ?? {};
    const validate = this.schemaValidator.getValidator(request.params.requestedSchema as never);
    const result = validate(content);
    if (!result.valid) {
      throw new McpError(
        ErrorCode.InvalidParams,
        result.errorMessage ?? "Elicitation response is invalid",
      );
    }
    return { action: "accept", content: content as ElicitResult["content"] };
  }

  private async taskAware<T extends CreateMessageRequest | ElicitRequest>(
    request: T,
    extra: RequestHandlerExtra<ClientRequest | Request, ClientNotification | Notification>,
    execute: () => Promise<CreateMessageResult | CreateMessageResultWithTools | ElicitResult>,
  ): Promise<CreateMessageResult | CreateMessageResultWithTools | ElicitResult | Result> {
    if (!request.params.task || !extra.taskStore) return execute();
    const result = await execute();
    const task = await extra.taskStore.createTask({
      ttl: extra.taskRequestedTtl ?? null,
    });
    await extra.taskStore.storeTaskResult(task.taskId, "completed", result);
    return { task };
  }

  private redacted(value: unknown): JsonValue {
    return redactJsonValue(toJson(value), [...this.secretValues]);
  }

  private redactedText(value: string): string {
    return this.redacted(value) as string;
  }

  private pushLog(logs: JsonValue[], value: unknown): void {
    logs.push(this.redacted(value));
    if (logs.length > MAX_LOG_ENTRIES) logs.shift();
  }

  private jsonResult(value: unknown): ToolExecutionResult {
    const json = this.redacted(value);
    return {
      content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
      isError: false,
      details: json,
    };
  }

  private async resourceResult(
    value: Awaited<ReturnType<AnyClient["readResource"]>>,
  ): Promise<ToolExecutionResult> {
    const content: UserContent[] = [];
    for (const item of value.contents) {
      if ("text" in item) content.push({ type: "text", text: this.redactedText(item.text) });
      else
        content.push(await this.storeBlob(item.blob, item.mimeType ?? "application/octet-stream"));
    }
    toJson(content);
    return { content, isError: false, details: { itemCount: value.contents.length } };
  }

  private async callResult(
    value: CallToolResult,
    extraDetails: JsonObject = {},
  ): Promise<ToolExecutionResult> {
    const content: UserContent[] = [];
    for (const item of value.content) {
      if (item.type === "text") {
        content.push({ type: "text", text: this.redactedText(item.text) });
      } else if (item.type === "image" || item.type === "audio") {
        content.push(await this.storeBlob(item.data, item.mimeType));
      } else if (item.type === "resource_link") {
        content.push({ type: "text", text: this.redactedText(`[resource ${item.uri}]`) });
      } else if ("text" in item.resource) {
        content.push({
          type: "text",
          text: this.redactedText(`[resource ${item.resource.uri}]\n${item.resource.text}`),
        });
      } else {
        content.push(
          await this.storeBlob(
            item.resource.blob,
            item.resource.mimeType ?? "application/octet-stream",
          ),
        );
      }
    }
    if (value.structuredContent) {
      content.push({
        type: "text",
        text: `Structured result:\n${JSON.stringify(this.redacted(value.structuredContent))}`,
      });
    }
    if (content.length === 0) content.push({ type: "text", text: "(no content)" });
    toJson(content);
    return {
      content,
      isError: value.isError ?? false,
      ...(Object.keys(extraDetails).length === 0 ? {} : { details: extraDetails }),
    };
  }

  private async storeBlob(base64: string, mediaType: string): Promise<UserContent> {
    if (base64.length > Math.ceil(MAX_BLOB_BYTES / 3) * 4) {
      throw new Error(`MCP blob exceeds ${MAX_BLOB_BYTES} bytes`);
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
      throw new Error("MCP server returned invalid base64 content");
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength > MAX_BLOB_BYTES) {
      throw new Error(`MCP blob exceeds ${MAX_BLOB_BYTES} bytes`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await mkdir(this.options.blobDirectory, { recursive: true, mode: 0o700 });
    const path = join(this.options.blobDirectory, sha256);
    try {
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return { type: "blob", blob: { sha256, mediaType, sizeBytes: bytes.byteLength } };
  }

  private async closeConnection(connection: Connection): Promise<void> {
    const errors: unknown[] = [];
    if (connection.transport instanceof StreamableHTTPClientTransport) {
      try {
        await connection.transport.terminateSession();
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("405")) errors.push(error);
      }
    }
    try {
      await connection.client.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await connection.oauth?.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await connection.cleanup?.();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close MCP connection");
  }
}
