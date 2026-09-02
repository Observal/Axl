#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  AuthError,
  AZURE_OPENAI_MODELS,
  AZURE_OPENAI_PROVIDER_ID,
  azureOpenAiAuthMethod,
  clampThinkingLevel,
  createAzureOpenAiProvider,
  dialectBoundaryPayload,
  FileCredentialStore,
  FrozenToolRoster,
  modelPortForSession,
  nodeAuthContext,
  OPENAI_CHAT_TOOL_DIALECT,
  resolveProviderAuth,
} from "@axl/ai";
import { DaemonClient, AxlDaemon } from "@axl/daemon";
import { loadMcpConfig, McpManager, mcpSecretValues } from "@axl/extension-mcp";
import { discoverSkills, makeSkillTool, skillCatalogSection } from "@axl/extension-skills";
import {
  buildStablePrompt,
  ESSENTIAL_CONSTRAINTS,
  loadAgentsInstructions,
  makeEditTool,
  makeReadTool,
  ToolRegistry,
  type WorkspacePolicy,
} from "@axl/kernel";
import type { ThinkingLevel } from "@axl/protocol";
import {
  createUnsafePlatformExecution,
  detectPlatformSandbox,
  SandboxUnavailableError,
} from "@axl/sandbox";

import { AxlApp } from "./app.ts";
import { type AxlSettings, readSettings, writeSettings } from "./settings.ts";
import { runAzureSetup } from "./setup.ts";
import { themeNames } from "./themes.ts";

interface CliArguments {
  command?: "login" | "daemon";
  sessionId?: string;
  socket?: string;
  model?: string;
  thinking?: ThinkingLevel;
  theme?: string;
  cwd: string;
  unsafe: boolean;
}

function parseArguments(argv: readonly string[]): CliArguments {
  const parsed: CliArguments = { cwd: process.cwd(), unsafe: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    const next = (): string => {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      return value;
    };
    if (argument === "--socket") parsed.socket = next();
    else if (argument === "--model") parsed.model = next();
    else if (argument === "--thinking") parsed.thinking = next() as ThinkingLevel;
    else if (argument === "--cwd") parsed.cwd = next();
    else if (argument === "--theme") parsed.theme = next();
    else if (argument === "--unsafe") parsed.unsafe = true;
    else if (argument === "login" || argument === "daemon") parsed.command = argument;
    else if (!argument.startsWith("-")) parsed.sessionId = argument;
    else throw new Error(`Unknown argument ${argument}`);
  }
  return parsed;
}

/**
 * Ensures Azure credentials exist, launching interactive setup on a fresh
 * machine instead of demanding environment exports. Non-interactive contexts
 * (pipes, CI) get the loud error instead of a hanging prompt.
 */
async function ensureCredentials(store: FileCredentialStore): Promise<void> {
  try {
    await resolveProviderAuth(
      AZURE_OPENAI_PROVIDER_ID,
      { apiKey: azureOpenAiAuthMethod },
      store,
      nodeAuthContext,
    );
  } catch (error) {
    if (error instanceof AuthError && error.code === "not_configured" && process.stdin.isTTY) {
      await runAzureSetup(process.stdin, process.stdout, store, nodeAuthContext);
      return;
    }
    throw error;
  }
}

interface ActiveConfig {
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel;
}

function thinkingPayload(config: ActiveConfig) {
  const model = AZURE_OPENAI_MODELS.find((candidate) => candidate.modelId === config.modelId);
  if (model === undefined) {
    return { requested: config.thinkingLevel, effective: config.thinkingLevel, clamped: false };
  }
  return clampThinkingLevel(model, config.thinkingLevel);
}

/** The local runtime. Operating-system isolation is skipped only after explicit `--unsafe`. */
async function makeLocalDaemon(
  axlHome: string,
  stateDirectory: string,
  socketPath: string,
  defaults: ActiveConfig,
  store: FileCredentialStore,
  unsafe: boolean,
) {
  const sandbox = unsafe ? createUnsafePlatformExecution() : await detectPlatformSandbox();
  if (!sandbox.available) {
    throw new SandboxUnavailableError(sandbox.reason ?? "unknown");
  }
  const provider = createAzureOpenAiProvider({ store, context: nodeAuthContext });
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: stateDirectory,
    securityMode: unsafe ? "unsafe" : "sandboxed",
    runtime: async ({ sessionId, cwd, boundary, selection, interact }) => {
      // Resolve once here so the session log can redact every secret value.
      const resolved = await resolveProviderAuth(
        AZURE_OPENAI_PROVIDER_ID,
        { apiKey: azureOpenAiAuthMethod },
        store,
        nodeAuthContext,
      );
      const active: ActiveConfig = {
        modelId: selection.modelId ?? defaults.modelId,
        thinkingLevel: selection.thinkingLevel ?? defaults.thinkingLevel,
      };
      if (!AZURE_OPENAI_MODELS.some((model) => model.modelId === active.modelId)) {
        throw new Error(`Unknown Azure OpenAI model ${active.modelId}`);
      }
      const policy: WorkspacePolicy = {
        workspace: cwd,
        readableRoots: [cwd],
        protectedPaths: [axlHome],
      };
      const model = modelPortForSession(provider, {
        modelId: active.modelId,
        thinkingLevel: thinkingPayload(active).effective,
      });
      const tools = new ToolRegistry();
      const overflowDirectory = join(stateDirectory, "tool-output");
      tools.register(sandbox.makeShellTool({ cwd, overflowDirectory, policy }));
      tools.register(makeReadTool({ cwd, ...(unsafe ? {} : { policy }) }));
      tools.register(makeEditTool({ cwd, ...(unsafe ? {} : { policy }) }));

      const skills = await discoverSkills({
        cwd,
        globalDirectory: join(axlHome, "skills"),
      });
      if (skills.length > 0) tools.register(makeSkillTool(skills));

      const mcpServers = await loadMcpConfig({ cwd, globalDirectory: axlHome });
      const mcpSecrets = mcpSecretValues(mcpServers);
      const mcp =
        mcpServers.length === 0
          ? undefined
          : new McpManager({
              servers: mcpServers,
              cwd,
              sessionId,
              stateDirectory: join(stateDirectory, "mcp"),
              blobDirectory: join(stateDirectory, "blobs"),
              model,
              modelId: active.modelId,
              secretValues: mcpSecrets,
              interact,
              wrapStdio: (input) => sandbox.wrapProcess({ policy, ...input }),
            });
      if (mcp) tools.register(mcp.makeTool());

      const skillSection = skillCatalogSection(skills);
      const prompt = buildStablePrompt({
        cwd,
        tools: tools.declarations().map(({ name, description }) => ({ name, description })),
        ...(unsafe
          ? {
              constraints: [
                ...ESSENTIAL_CONSTRAINTS,
                "No operating-system sandbox is active. Commands and file tools have the user's full host access.",
              ],
            }
          : {}),
        instructions: [
          ...(await loadAgentsInstructions({
            cwd,
            globalPath: join(axlHome, "AGENTS.md"),
          })),
          ...(skillSection === undefined ? [] : [skillSection]),
        ],
      });
      return {
        model,
        tools,
        ...(mcp === undefined ? {} : { extensionHost: mcp }),
        prompt,
        log: { secretValues: [...resolved.secretValues, ...mcpSecrets] },
        sandbox: sandbox.configuredPayload(),
        configModel: { modelId: active.modelId },
        configThinking: thinkingPayload(active),
        // Thinking-only changes do not alter the provider tool dialect.
        ...(boundary === "config_change"
          ? {}
          : {
              configDialect: dialectBoundaryPayload(
                new FrozenToolRoster(OPENAI_CHAT_TOOL_DIALECT, tools.declarations()),
                boundary,
              ),
            }),
      };
    },
  });
  await daemon.start();
  return daemon;
}

class SecurityModeMismatchError extends Error {
  constructor(requested: "sandboxed" | "unsafe", actual: string) {
    super(`Daemon security mode is ${actual}; ${requested} was requested`);
    this.name = "SecurityModeMismatchError";
  }
}

async function connectExpectedDaemon(socketPath: string, unsafe: boolean): Promise<DaemonClient> {
  const client = await DaemonClient.connect(socketPath);
  try {
    const info = (await client.request("daemon.info", {})) as { securityMode?: string };
    const expected = unsafe ? "unsafe" : "sandboxed";
    if (info.securityMode !== expected) {
      throw new SecurityModeMismatchError(expected, info.securityMode ?? "unknown");
    }
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

async function connectOrStartDaemon(input: {
  readonly socketPath: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly unsafe: boolean;
}): Promise<DaemonClient> {
  try {
    return await connectExpectedDaemon(input.socketPath, input.unsafe);
  } catch (error) {
    if (error instanceof SecurityModeMismatchError) throw error;
    const entry = process.argv[1];
    if (entry === undefined) throw new Error("Cannot locate the Axl executable");
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        entry,
        "daemon",
        "--socket",
        input.socketPath,
        "--model",
        input.model,
        "--thinking",
        input.thinking,
        ...(input.unsafe ? ["--unsafe"] : []),
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  }

  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connectExpectedDaemon(input.socketPath, input.unsafe);
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  throw new Error("Axl daemon did not start", { cause: lastError });
}

async function main(): Promise<void> {
  const cli = parseArguments(process.argv.slice(2));
  const axlHome = join(homedir(), ".axl");
  const stateDirectory = cli.unsafe ? join(axlHome, "unsafe") : axlHome;
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const socketPath = cli.socket ?? join(stateDirectory, "axl.sock");
  const store = new FileCredentialStore(join(axlHome, "credentials.json"));

  if (cli.command === "login") {
    await runAzureSetup(process.stdin, process.stdout, store, nodeAuthContext);
    process.exit(0);
  }

  const settingsPath = join(axlHome, "settings.json");
  let settings = await readSettings(settingsPath);
  const active: ActiveConfig = {
    modelId: cli.model ?? settings.model ?? "gpt-5",
    thinkingLevel: cli.thinking ?? settings.thinking ?? "medium",
  };
  const selectedTheme = cli.theme ?? settings.theme;
  if (selectedTheme !== undefined && !themeNames().includes(selectedTheme)) {
    throw new Error(`Unknown theme ${selectedTheme} in ${settingsPath}`);
  }
  let settingsWrite = Promise.resolve();
  const saveSettings = (update: AxlSettings): Promise<void> => {
    settings = { ...settings, ...update };
    const snapshot = settings;
    const write = settingsWrite.then(() => writeSettings(settingsPath, snapshot));
    settingsWrite = write.catch(() => undefined);
    return write;
  };

  if (cli.command === "daemon") {
    await ensureCredentials(store);
    if (cli.unsafe) {
      process.stderr.write(
        "WARNING: --unsafe disables operating-system isolation and gives tools full host access.\n",
      );
    }
    const daemon = await makeLocalDaemon(
      axlHome,
      stateDirectory,
      socketPath,
      active,
      store,
      cli.unsafe,
    );
    const stop = (): void => {
      void daemon.stop().finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise(() => undefined);
    return;
  }

  let client: DaemonClient;
  try {
    client = await connectExpectedDaemon(socketPath, cli.unsafe);
  } catch (error) {
    if (error instanceof SecurityModeMismatchError) throw error;
    await ensureCredentials(store);
    client = await connectOrStartDaemon({
      socketPath,
      model: active.modelId,
      thinking: active.thinkingLevel,
      unsafe: cli.unsafe,
    });
  }

  await AxlApp.start({
    client,
    input: process.stdin,
    output: process.stdout,
    cwd: cli.cwd,
    ...(selectedTheme === undefined ? {} : { theme: selectedTheme }),
    models: AZURE_OPENAI_MODELS.map((model) => model.modelId),
    modelCatalog: AZURE_OPENAI_MODELS,
    currentModel: active.modelId,
    currentThinking: active.thinkingLevel,
    credentials: { store, context: nodeAuthContext },
    onModelChange: (model) => saveSettings({ model }),
    onThinkingChange: (thinking) => saveSettings({ thinking }),
    onThemeChange: (theme) => saveSettings({ theme }),
    ...(cli.sessionId === undefined ? {} : { sessionId: cli.sessionId }),
    onExit: () => process.exit(0),
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`axl: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
