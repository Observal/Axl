#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AuthContext, CredentialStore } from "@axl/ai";
import { AZURE_OPENAI_MODELS } from "@axl/ai/models";
import { DaemonClient, WireClientError } from "@axl/daemon/client";
import type { ThinkingLevel } from "@axl/protocol";
import {
  diagnoseLocalSandboxes,
  type LocalSandboxSelection,
  localSandboxStateKey,
  startLocalDaemon,
} from "@axl/runtime";

import { loadTuiSettings, saveTuiSettings, type TuiSettings } from "./settings.ts";

const AXL_VERSION = process.env.AXL_BUILD_VERSION ?? "0.0.0-dev";

const HELP = `Usage: axl [session-id] [options]
       axl login
       axl doctor
       axl daemon [options]

Options:
  --cwd <path>       Set the workspace directory
  --model <id>       Select the initial model
  --thinking <level> Select the initial reasoning effort
  --theme <name>     Select the terminal theme
  --tui-mode <mode>  Use regular or fullscreen terminal mode
  --socket <path>    Use a custom daemon socket
  --sandbox <kind>   Use native, podman, or docker isolation
  --image <digest>   Use a locally available digest-pinned OCI image
  --unsafe           Disable operating-system isolation
  --help             Show this help
  --version          Show the installed version
`;

type SandboxChoice = "native" | "podman" | "docker";

interface CliArguments {
  command?: "login" | "daemon" | "doctor";
  sessionId?: string;
  socket?: string;
  model?: string;
  thinking?: ThinkingLevel;
  theme?: string;
  tuiMode?: "regular" | "fullscreen";
  image?: string;
  sandbox: SandboxChoice;
  cwd: string;
  unsafe: boolean;
  showHelp: boolean;
  showVersion: boolean;
}

function parseArguments(argv: readonly string[]): CliArguments {
  const parsed: CliArguments = {
    cwd: process.cwd(),
    sandbox: "native",
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
    else if (argument === "--tui-mode") {
      const mode = next();
      if (mode !== "regular" && mode !== "fullscreen") {
        throw new Error("--tui-mode requires regular or fullscreen");
      }
      parsed.tuiMode = mode;
    } else if (argument === "--image") parsed.image = next();
    else if (argument === "--sandbox") {
      const sandbox = next();
      if (!(["native", "podman", "docker"] as const).includes(sandbox as SandboxChoice)) {
        throw new Error(`Unknown sandbox ${sandbox}; expected native, podman, or docker`);
      }
      parsed.sandbox = sandbox as SandboxChoice;
    } else if (argument === "--unsafe") parsed.unsafe = true;
    else if (argument === "--help" || argument === "-h") parsed.showHelp = true;
    else if (argument === "--version" || argument === "-v") parsed.showVersion = true;
    else if (argument === "login" || argument === "daemon" || argument === "doctor") {
      parsed.command = argument;
    } else if (!argument.startsWith("-")) parsed.sessionId = argument;
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (parsed.unsafe && parsed.sandbox !== "native") {
    throw new Error("--unsafe cannot be combined with --sandbox podman or docker");
  }
  if (parsed.sandbox === "native" && parsed.image !== undefined) {
    throw new Error("--image requires --sandbox podman or docker");
  }
  if (parsed.sandbox !== "native" && parsed.image === undefined && parsed.command !== "doctor") {
    throw new Error(`--sandbox ${parsed.sandbox} requires --image with a sha256 digest`);
  }
  return parsed;
}

async function ensureCredentials(store: CredentialStore): Promise<void> {
  const {
    AuthError,
    AZURE_OPENAI_PROVIDER_ID,
    azureOpenAiAuthMethod,
    nodeAuthContext,
    resolveProviderAuth,
  } = await import("@axl/ai");
  try {
    await resolveProviderAuth(
      AZURE_OPENAI_PROVIDER_ID,
      { apiKey: azureOpenAiAuthMethod },
      store,
      nodeAuthContext,
    );
  } catch (error) {
    if (error instanceof AuthError && error.code === "not_configured" && process.stdin.isTTY) {
      const { runAzureSetup } = await import("@axl/tui");
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
  constructor(requested: string, actual: string) {
    super(`Daemon security mode is ${actual}; ${requested} was requested`);
    this.name = "SecurityModeMismatchError";
  }
}

async function connectExpectedDaemon(
  socketPath: string,
  unsafe: boolean,
  sandbox: SandboxChoice,
  image?: string,
): Promise<DaemonClient> {
  const client = await DaemonClient.connect(socketPath);
  try {
    const info = (await client.request("daemon.info", {})) as {
      securityMode?: string;
      sandboxProvider?: string;
      sandboxImage?: string;
    };
    const expectedMode = unsafe ? "unsafe" : "sandboxed";
    if (info.securityMode !== expectedMode) {
      throw new SecurityModeMismatchError(expectedMode, info.securityMode ?? "unknown");
    }
    const providers = unsafe
      ? ["none", "unknown"]
      : sandbox === "native"
        ? ["bubblewrap", "seatbelt", "unknown"]
        : [sandbox];
    if (!providers.includes(info.sandboxProvider ?? "unknown")) {
      throw new SecurityModeMismatchError(
        `${expectedMode}/${sandbox}`,
        `${info.securityMode ?? "unknown"}/${info.sandboxProvider ?? "unknown"}`,
      );
    }
    if (image !== undefined && info.sandboxImage !== image) {
      throw new SecurityModeMismatchError(
        `${expectedMode}/${sandbox}/${image}`,
        `${info.securityMode ?? "unknown"}/${info.sandboxProvider ?? "unknown"}/${info.sandboxImage ?? "unknown"}`,
      );
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
  readonly sandbox: SandboxChoice;
  readonly image?: string;
}): Promise<DaemonClient> {
  try {
    return await connectExpectedDaemon(input.socketPath, input.unsafe, input.sandbox, input.image);
  } catch (error) {
    if (error instanceof SecurityModeMismatchError) throw error;
    if (error instanceof WireClientError && error.code !== "connection_error") throw error;
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
        ...(input.sandbox === "native" ? [] : ["--sandbox", input.sandbox]),
        ...(input.image === undefined ? [] : ["--image", input.image]),
      ],
      { detached: true, stdio: "ignore" },
    );
    let childFailure: Error | undefined;
    child.once("error", (cause) => {
      childFailure = new Error(`Axl daemon process failed: ${cause.message}`, { cause });
    });
    child.once("exit", (code, signal) => {
      childFailure =
        signal === null
          ? new Error(`Axl daemon exited before accepting connections with code ${code}`)
          : new Error(`Axl daemon exited from signal ${signal}`);
    });
    child.unref();

    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (childFailure !== undefined) throw childFailure;
      try {
        return await connectExpectedDaemon(
          input.socketPath,
          input.unsafe,
          input.sandbox,
          input.image,
        );
      } catch (retryError) {
        if (retryError instanceof SecurityModeMismatchError) throw retryError;
        lastError = retryError;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    throw new Error("Axl daemon did not start within 30 seconds", { cause: lastError });
  }
}

class StartupTimer {
  private readonly enabled = process.env.AXL_STARTUP_TIMING === "1";
  private readonly phases: Array<{ name: string; elapsedMs: number }> = [];

  mark(name: string): void {
    if (this.enabled) this.phases.push({ name, elapsedMs: process.uptime() * 1_000 });
  }

  summary(): string | undefined {
    if (!this.enabled || this.phases.length === 0) return undefined;
    let previous = 0;
    const phases = this.phases.map((phase) => {
      const duration = Math.max(0, Math.round(phase.elapsedMs - previous));
      previous = phase.elapsedMs;
      return `${phase.name} ${duration}ms`;
    });
    return `startup timing · ${phases.join(" · ")} · total ${Math.round(previous)}ms`;
  }
}

function showStartupIndicator(message: string): boolean {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false;
  process.stdout.write(`\r\x1b[2K◆ Axl · ${message}`);
  return true;
}

async function main(): Promise<void> {
  const timing = new StartupTimer();
  timing.mark("module load");
  const cli = parseArguments(process.argv.slice(2));
  if (cli.showHelp) {
    process.stdout.write(HELP);
    return;
  }
  if (cli.showVersion) {
    process.stdout.write(`axl ${AXL_VERSION}\n`);
    return;
  }

  const startupIndicator = cli.command === undefined && showStartupIndicator("starting…");
  const tuiModule = cli.command === undefined ? import("@axl/tui") : undefined;
  const axlHome = join(homedir(), ".axl");
  if (cli.command === "doctor") {
    process.stdout.write(`${JSON.stringify(await diagnoseLocalSandboxes(), null, 2)}\n`);
    return;
  }
  const sandbox: LocalSandboxSelection =
    cli.sandbox === "native"
      ? { type: "native" }
      : { type: "oci", engine: cli.sandbox, image: cli.image as string };
  const sandboxStateKey = localSandboxStateKey(sandbox);
  const stateDirectory = cli.unsafe
    ? join(axlHome, "unsafe")
    : sandboxStateKey === undefined
      ? axlHome
      : join(axlHome, sandboxStateKey);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const socketPath = cli.socket ?? join(stateDirectory, "axl.sock");
  const settingsPath = join(axlHome, "settings.json");
  let settings = await loadTuiSettings(settingsPath);
  timing.mark("settings");

  let credentialsPromise: Promise<{ store: CredentialStore; context: AuthContext }> | undefined;
  const credentials = () => {
    credentialsPromise ??= import("@axl/ai").then(({ FileCredentialStore, nodeAuthContext }) => ({
      store: new FileCredentialStore(join(axlHome, "credentials.json")),
      context: nodeAuthContext,
    }));
    return credentialsPromise;
  };

  if (cli.command === "login") {
    const [{ store, context }, { assertInteractiveTerminal, runAzureSetup }] = await Promise.all([
      credentials(),
      import("@axl/tui"),
    ]);
    assertInteractiveTerminal(process.stdin, process.stdout);
    await runAzureSetup(process.stdin, process.stdout, store, context);
    process.exit(0);
  }

  const active: ActiveConfig = {
    modelId: cli.model ?? settings.modelId ?? "gpt-5",
    thinkingLevel: cli.thinking ?? settings.thinkingLevel ?? "medium",
  };

  if (cli.command === "daemon") {
    const { store } = await credentials();
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
      sandbox,
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
    client = await connectExpectedDaemon(socketPath, cli.unsafe, cli.sandbox, cli.image);
    timing.mark("daemon connect");
  } catch (error) {
    if (error instanceof SecurityModeMismatchError) throw error;
    const { store } = await credentials();
    timing.mark("credential load");
    await ensureCredentials(store);
    client = await connectOrStartDaemon({
      socketPath,
      model: active.modelId,
      thinking: active.thinkingLevel,
      unsafe: cli.unsafe,
      sandbox: cli.sandbox,
      ...(cli.image === undefined ? {} : { image: cli.image }),
    });
    timing.mark("daemon start");
  }

  let settingsWrite: Promise<void> = Promise.resolve();
  const persistSettings = (update: Partial<Omit<TuiSettings, "version">>): Promise<void> => {
    settings = { ...settings, ...update, version: 1 };
    const snapshot = settings;
    settingsWrite = settingsWrite
      .catch(() => undefined)
      .then(() => saveTuiSettings(settingsPath, snapshot));
    return settingsWrite;
  };

  const [{ AxlApp }, { mcpTerminalExtension }, { skillTerminalExtension }] = await Promise.all([
    tuiModule ?? import("@axl/tui"),
    import("@axl/extension-mcp"),
    import("@axl/extension-skills"),
  ]);
  timing.mark("TUI modules");
  const app = await AxlApp.start({
    client,
    input: process.stdin,
    output: process.stdout,
    cwd: cli.cwd,
    ...((cli.theme ?? settings.theme) === undefined ? {} : { theme: cli.theme ?? settings.theme }),
    ...(settings.toolOutputDisplay === undefined
      ? {}
      : { toolOutputDisplay: settings.toolOutputDisplay }),
    ...(settings.thinkingDisplay === undefined
      ? {}
      : { thinkingDisplay: settings.thinkingDisplay }),
    tuiMode: cli.tuiMode ?? settings.tuiMode ?? "regular",
    fullscreenExitOutput: settings.fullscreenExitOutput ?? "transcript",
    fullscreenScrollbar: settings.fullscreenScrollbar ?? "auto",
    fullscreenMouse: settings.fullscreenMouse ?? "capture",
    attention: settings.attention ?? "off",
    editorMode: settings.editorMode ?? "standard",
    modelFavorites: settings.modelFavorites ?? [],
    refocusRecap: settings.refocusRecap ?? false,
    developerPanel: settings.developerPanel ?? false,
    diffLayout: settings.diffLayout ?? "unified",
    workspaceReview: settings.workspaceReview ?? false,
    imageDisplay: settings.imageDisplay ?? "auto",
    extensions: [mcpTerminalExtension, skillTerminalExtension],
    clearStartupLine: startupIndicator,
    reconnectClient: () =>
      connectOrStartDaemon({
        socketPath,
        model: active.modelId,
        thinking: active.thinkingLevel,
        unsafe: cli.unsafe,
        sandbox: cli.sandbox,
        ...(cli.image === undefined ? {} : { image: cli.image }),
      }),
    onPreferenceChange: persistSettings,
    models: AZURE_OPENAI_MODELS.map((model) => model.modelId),
    modelCatalog: AZURE_OPENAI_MODELS,
    currentModel: active.modelId,
    currentThinking: active.thinkingLevel,
    loadCredentials: credentials,
    ...(cli.sessionId === undefined ? {} : { sessionId: cli.sessionId }),
    onExit: () => {
      void settingsWrite.finally(() => process.exit(0));
    },
  });
  timing.mark("first paint");
  const timingSummary = timing.summary();
  if (timingSummary !== undefined) app.showLocalNotice(timingSummary);
}

main().catch((error: unknown) => {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
  process.stderr.write(`axl: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
