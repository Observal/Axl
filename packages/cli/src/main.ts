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
  FileCredentialStore,
  nodeAuthContext,
  resolveProviderAuth,
} from "@axl/ai";
import { DaemonClient } from "@axl/daemon";
import type { ThinkingLevel } from "@axl/protocol";
import { startLocalDaemon } from "@axl/runtime";
import { AxlApp, runAzureSetup, themeNames } from "@axl/tui";

import { type AxlSettings, readSettings, writeSettings } from "./settings.ts";

const AXL_VERSION = process.env.AXL_BUILD_VERSION ?? "0.0.0-dev";

const HELP = `Usage: axl [session-id] [options]
       axl login
       axl daemon [options]

Options:
  --cwd <path>       Set the workspace directory
  --model <id>       Select the initial model
  --thinking <level> Select the initial reasoning effort
  --theme <name>     Select the terminal theme
  --socket <path>    Use a custom daemon socket
  --unsafe           Disable operating-system isolation
  --help             Show this help
  --version          Show the installed version
`;

interface CliArguments {
  command?: "login" | "daemon";
  sessionId?: string;
  socket?: string;
  model?: string;
  thinking?: ThinkingLevel;
  theme?: string;
  cwd: string;
  unsafe: boolean;
  showHelp: boolean;
  showVersion: boolean;
}

function parseArguments(argv: readonly string[]): CliArguments {
  const parsed: CliArguments = {
    cwd: process.cwd(),
    unsafe: false,
    showHelp: false,
    showVersion: false,
  };
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
    else if (argument === "--help" || argument === "-h") parsed.showHelp = true;
    else if (argument === "--version" || argument === "-v") parsed.showVersion = true;
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
  if (cli.showHelp) {
    process.stdout.write(HELP);
    return;
  }
  if (cli.showVersion) {
    process.stdout.write(`axl ${AXL_VERSION}\n`);
    return;
  }

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
    const daemon = await startLocalDaemon({
      axlHome,
      stateDirectory,
      socketPath,
      defaults: active,
      store,
      unsafe: cli.unsafe,
    });
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
