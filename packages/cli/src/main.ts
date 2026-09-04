#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import type { AuthContext, CredentialStore } from "@axl/ai";
import { AZURE_OPENAI_MODELS } from "@axl/ai/models";
import {
  type CanonicalEvent,
  encodeCanonicalEvent,
  MAX_WIRE_MESSAGE_BYTES,
  type SessionProfile,
  type ThinkingLevel,
} from "@axl/protocol";
import {
  diagnoseLocalSandboxes,
  type LocalSandboxSelection,
  type LocalSessionDescriptor,
  type LocalSessionPlacement,
  listLocalSessions,
  localSandboxStateKey,
  startLocalDaemon,
} from "@axl/runtime";
import { type AxlClient, AxlClientError, subscribeSession } from "@axl/sdk";
import { connectUnixClient } from "@axl/sdk/unix";

import { azureLoginDialog, runAzureSetup } from "./azure-auth-ui.ts";
import { loadTuiSettings, saveTuiSettings, type TuiSettings } from "./settings.ts";

const AXL_VERSION = process.env.AXL_BUILD_VERSION ?? "0.0.0-dev";

const HELP = `Usage: axl [session-id] [options]
       axl login
       axl doctor
       axl daemon [options]
       axl print [prompt] [options]
       axl json [prompt] [options]
       axl rpc [options]
       axl session export <session-id> --raw [--output <directory>]
       axl session migrate-events <session-id> [--confirm-prefix]

Options:
  --cwd <path>       Set the workspace directory
  --model <id>       Select the initial model
  --thinking <level> Select the initial reasoning effort
  --profile <name>   Select the standard or Bash-only exec profile
  --theme <name>     Select the terminal theme
  --tui-mode <mode>  Use regular or fullscreen terminal mode
  --socket <path>    Use a custom daemon socket
  --sandbox <kind>   Use native, podman, or docker isolation
  -p, --print        Print one response and exit
  --json              Emit canonical events as JSONL and exit
  -r, --resume       Open the all-session resume picker
  --image <digest>   Use a locally available digest-pinned OCI image
  --unsafe           Disable operating-system isolation
  --web               Enable web_fetch and web_search (default)
  --no-web            Disable web_fetch and web_search
  --web-fetch         Enable web_fetch
  --no-web-fetch      Disable web_fetch
  --web-search        Enable web_search
  --no-web-search     Disable web_search
  --output <path>    Set the raw session export directory
  --confirm-prefix   Recover only events before an unsupported oversized event
  --help             Show this help
  --version          Show the installed version
`;

type SandboxChoice = "native" | "podman" | "docker";

interface CliArguments {
  command?:
    | "login"
    | "daemon"
    | "doctor"
    | "json"
    | "print"
    | "rpc"
    | "session-export"
    | "session-migrate-events";
  sessionId?: string;
  prompt: string[];
  output?: string;
  raw: boolean;
  confirmPrefix: boolean;
  socket?: string;
  model?: string;
  thinking?: ThinkingLevel;
  profile?: SessionProfile;
  webFetch?: boolean;
  webSearch?: boolean;
  theme?: string;
  tuiMode?: "regular" | "fullscreen";
  image?: string;
  sandbox: SandboxChoice;
  cwd: string;
  unsafe: boolean;
  resume: boolean;
  showHelp: boolean;
  showVersion: boolean;
}

function parseArguments(argv: readonly string[]): CliArguments {
  const parsed: CliArguments = {
    cwd: process.cwd(),
    prompt: [],
    sandbox: "native",
    unsafe: false,
    resume: false,
    raw: false,
    confirmPrefix: false,
    showHelp: false,
    showVersion: false,
  };
  let startIndex = 0;
  if (argv[0] === "session") {
    const operation = argv[1];
    if (operation !== "export" && operation !== "migrate-events") {
      throw new Error("session requires export or migrate-events");
    }
    const sessionId = argv[2];
    if (sessionId === undefined || sessionId.startsWith("-")) {
      throw new Error(`session ${operation} requires a session ID`);
    }
    parsed.command = operation === "export" ? "session-export" : "session-migrate-events";
    parsed.sessionId = sessionId;
    startIndex = 3;
  }
  for (let index = startIndex; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    const next = (): string => {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      return value;
    };
    if (argument === "--" && (parsed.command === "print" || parsed.command === "json")) {
      parsed.prompt.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "--socket") parsed.socket = next();
    else if (argument === "--output") parsed.output = next();
    else if (argument === "--raw") parsed.raw = true;
    else if (argument === "--confirm-prefix") parsed.confirmPrefix = true;
    else if (argument === "--model") parsed.model = next();
    else if (argument === "--thinking") parsed.thinking = next() as ThinkingLevel;
    else if (argument === "--profile") {
      const profile = next();
      if (profile !== "standard" && profile !== "exec") {
        throw new Error(`Unknown profile ${profile}; expected standard or exec`);
      }
      parsed.profile = profile;
    } else if (argument === "--web") {
      parsed.webFetch = true;
      parsed.webSearch = true;
    } else if (argument === "--no-web") {
      parsed.webFetch = false;
      parsed.webSearch = false;
    } else if (argument === "--web-fetch") parsed.webFetch = true;
    else if (argument === "--no-web-fetch") parsed.webFetch = false;
    else if (argument === "--web-search") parsed.webSearch = true;
    else if (argument === "--no-web-search") parsed.webSearch = false;
    else if (argument === "--cwd") parsed.cwd = next();
    else if (argument === "--theme") parsed.theme = next();
    else if (argument === "--tui-mode") {
      const mode = next();
      if (mode !== "regular" && mode !== "fullscreen") {
        throw new Error("--tui-mode requires regular or fullscreen");
      }
      parsed.tuiMode = mode;
    } else if (argument === "--image") parsed.image = next();
    else if (argument === "--resume" || argument === "-r") parsed.resume = true;
    else if (argument === "--sandbox") {
      const sandbox = next();
      if (!(["native", "podman", "docker"] as const).includes(sandbox as SandboxChoice)) {
        throw new Error(`Unknown sandbox ${sandbox}; expected native, podman, or docker`);
      }
      parsed.sandbox = sandbox as SandboxChoice;
    } else if (argument === "--unsafe") parsed.unsafe = true;
    else if (argument === "--help" || argument === "-h") parsed.showHelp = true;
    else if (argument === "--version" || argument === "-v") parsed.showVersion = true;
    else if (argument === "print" || argument === "--print" || argument === "-p") {
      parsed.command = "print";
    } else if (argument === "json" || argument === "--json") {
      parsed.command = "json";
    } else if (
      (parsed.command === "print" || parsed.command === "json") &&
      !argument.startsWith("-")
    ) {
      parsed.prompt.push(argument);
    } else if (
      argument === "login" ||
      argument === "daemon" ||
      argument === "doctor" ||
      argument === "rpc"
    ) {
      parsed.command = argument;
    } else if (!argument.startsWith("-") && !parsed.command?.startsWith("session-")) {
      parsed.sessionId = argument;
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (parsed.resume && parsed.sessionId !== undefined) {
    throw new Error("--resume cannot be combined with a session ID");
  }
  if (parsed.resume && parsed.command !== undefined) {
    throw new Error("--resume cannot be combined with a command");
  }
  if (
    (parsed.command === "json" || parsed.command === "print" || parsed.command === "rpc") &&
    parsed.sessionId !== undefined
  ) {
    throw new Error(`${parsed.command} does not accept a session ID`);
  }
  if (parsed.command === "session-export" && !parsed.raw) {
    throw new Error("session export requires --raw");
  }
  if (parsed.command !== "session-export" && parsed.raw) {
    throw new Error("--raw is only valid with session export");
  }
  if (parsed.command !== "session-migrate-events" && parsed.confirmPrefix) {
    throw new Error("--confirm-prefix is only valid with session migrate-events");
  }
  if (parsed.command !== "session-export" && parsed.output !== undefined) {
    throw new Error("--output is only valid with session export");
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

interface LocalDaemonTarget {
  readonly stateDirectory: string;
  readonly socketPath: string;
  readonly unsafe: boolean;
  readonly sandbox: SandboxChoice;
  readonly image?: string;
}

function targetForPlacement(axlHome: string, placement: LocalSessionPlacement): LocalDaemonTarget {
  if (placement.type === "unsafe") {
    const stateDirectory = join(axlHome, "unsafe");
    return {
      stateDirectory,
      socketPath: join(stateDirectory, "axl.sock"),
      unsafe: true,
      sandbox: "native",
    };
  }
  const sandbox: LocalSandboxSelection =
    placement.type === "native"
      ? { type: "native" }
      : { type: "oci", engine: placement.engine, image: placement.image };
  const key = localSandboxStateKey(sandbox);
  const stateDirectory = key === undefined ? axlHome : join(axlHome, key);
  return {
    stateDirectory,
    socketPath: join(stateDirectory, "axl.sock"),
    unsafe: false,
    sandbox: placement.type === "native" ? "native" : placement.engine,
    ...(placement.type === "oci" ? { image: placement.image } : {}),
  };
}

function sessionResumeKey(session: LocalSessionDescriptor): string {
  if (session.placement.type === "unsafe") return `unsafe:${session.sessionId}`;
  if (session.placement.type === "native") return `native:${session.sessionId}`;
  return `${session.placement.engine}:${session.placement.image}:${session.sessionId}`;
}

function samePlacement(left: LocalSessionPlacement, right: LocalSessionPlacement): boolean {
  if (left.type !== right.type) return false;
  if (left.type !== "oci" || right.type !== "oci") return true;
  return left.engine === right.engine && left.image === right.image;
}

async function ensureCredentials(
  store: CredentialStore,
  allowInteractiveSetup = true,
): Promise<void> {
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
    if (
      error instanceof AuthError &&
      error.code === "not_configured" &&
      allowInteractiveSetup &&
      process.stdin.isTTY
    ) {
      await runAzureSetup(process.stdin, process.stdout, store, nodeAuthContext);
      return;
    }
    throw error;
  }
}

interface ActiveConfig {
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly webFetch: boolean;
  readonly webSearch: boolean;
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
  clientKind = "tui",
): Promise<AxlClient> {
  const client = await connectUnixClient(socketPath, {
    identity: { kind: clientKind, version: AXL_VERSION, instanceId: crypto.randomUUID() },
  });
  try {
    const info = await client.request("daemon.info", {});
    const expectedMode = unsafe ? "unsafe" : "sandboxed";
    if (info.securityMode !== expectedMode) {
      throw new SecurityModeMismatchError(expectedMode, info.securityMode);
    }
    const providers = unsafe
      ? ["none", "unknown"]
      : sandbox === "native"
        ? ["bubblewrap", "seatbelt", "unknown"]
        : [sandbox];
    if (!providers.includes(info.sandboxProvider)) {
      throw new SecurityModeMismatchError(
        `${expectedMode}/${sandbox}`,
        `${info.securityMode}/${info.sandboxProvider}`,
      );
    }
    if (image !== undefined && info.sandboxImage !== image) {
      throw new SecurityModeMismatchError(
        `${expectedMode}/${sandbox}/${image}`,
        `${info.securityMode}/${info.sandboxProvider}/${info.sandboxImage ?? "unknown"}`,
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
  readonly webFetch: boolean;
  readonly webSearch: boolean;
  readonly clientKind: string;
}): Promise<AxlClient> {
  try {
    return await connectExpectedDaemon(
      input.socketPath,
      input.unsafe,
      input.sandbox,
      input.image,
      input.clientKind,
    );
  } catch (error) {
    if (error instanceof SecurityModeMismatchError) throw error;
    if (error instanceof AxlClientError && error.code !== "connection_error") throw error;
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
        ...(input.webFetch ? [] : ["--no-web-fetch"]),
        ...(input.webSearch ? [] : ["--no-web-search"]),
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
          input.clientKind,
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

async function readHeadlessPrompt(
  parts: readonly string[],
  mode: "json" | "print",
): Promise<string> {
  const argument = parts.join(" ");
  const chunks: Buffer[] = [];
  let bytes = Buffer.byteLength(argument);
  if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.byteLength;
      if (bytes > MAX_WIRE_MESSAGE_BYTES) {
        throw new Error(`${mode} prompt exceeds ${MAX_WIRE_MESSAGE_BYTES} bytes`);
      }
      chunks.push(buffer);
    }
  }
  let piped = "";
  try {
    piped = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (cause) {
    throw new Error(`${mode} input must be valid UTF-8`, { cause });
  }
  const prompt = [argument, piped].filter((part) => part.trim().length > 0).join("\n\n");
  if (prompt.length === 0) throw new Error(`${mode} requires a prompt argument or piped stdin`);
  if (Buffer.byteLength(prompt) > MAX_WIRE_MESSAGE_BYTES) {
    throw new Error(`${mode} prompt exceeds ${MAX_WIRE_MESSAGE_BYTES} bytes`);
  }
  return prompt;
}

type AssistantMessageEvent = Extract<CanonicalEvent, { readonly type: "assistant.message" }>;

type HeadlessInput = {
  readonly cwd: string;
  readonly prompt: string;
  readonly active: ActiveConfig;
  readonly profile?: SessionProfile;
};

async function runHeadless(
  client: AxlClient,
  input: HeadlessInput,
  onEvent: (event: CanonicalEvent) => void | Promise<void> = () => undefined,
): Promise<AssistantMessageEvent> {
  const opened = await client.request("session.create", {
    cwd: input.cwd,
    modelId: input.active.modelId,
    thinkingLevel: input.active.thinkingLevel,
    webFetch: input.active.webFetch,
    webSearch: input.active.webSearch,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
  });
  let terminal: AssistantMessageEvent | undefined;
  let finishDelivery: (event: AssistantMessageEvent | undefined) => void = () => undefined;
  const terminalDelivery = new Promise<AssistantMessageEvent | undefined>((resolvePromise) => {
    finishDelivery = resolvePromise;
  });
  let interaction: string | undefined;
  let interactionError: Error | undefined;
  let deliveryError: Error | undefined;
  const subscription = await subscribeSession(client, opened.sessionId, {
    onEvent: async (event) => {
      await onEvent(event);
      if (event.type === "assistant.message" && event.payload.stopReason !== "tool_use") {
        terminal = event;
        finishDelivery(event);
      } else if (event.type === "interaction.requested") {
        interaction ??= event.payload.message;
        try {
          await client.request("session.interaction.respond", {
            sessionId: opened.sessionId,
            interactionId: event.payload.interactionId,
            action: "cancel",
          });
        } catch (error) {
          interactionError = error instanceof Error ? error : new Error(String(error));
          await client.request("session.interrupt", { sessionId: opened.sessionId });
        }
      }
    },
    onResyncRequired: (error) => {
      deliveryError = error;
      finishDelivery(undefined);
    },
  });
  try {
    const result = await client.request("session.send", {
      sessionId: opened.sessionId,
      content: [{ type: "text", text: input.prompt }],
      delivery: "prompt",
    });
    if (terminal === undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      terminal = await Promise.race([
        terminalDelivery,
        new Promise<undefined>((resolvePromise) => {
          timer = setTimeout(resolvePromise, 5_000, undefined);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    }
    if (deliveryError !== undefined) throw deliveryError;
    if (interactionError !== undefined) throw interactionError;
    if (interaction !== undefined) {
      throw new Error(`Headless mode cannot answer interaction: ${interaction}`);
    }
    if (
      terminal === undefined ||
      terminal.operationId !== result.operationId ||
      terminal.payload.stopReason !== result.stopReason
    ) {
      throw new Error("Headless response completed without a matching canonical assistant event");
    }
    if (terminal.payload.stopReason === "error") {
      throw new Error(terminal.payload.errorMessage ?? "The model request failed");
    }
    if (terminal.payload.stopReason === "aborted") throw new Error("The model request was aborted");
    return terminal;
  } finally {
    await subscription.close();
  }
}

async function runPrint(client: AxlClient, input: HeadlessInput): Promise<void> {
  const terminal = await runHeadless(client, input);
  const text = terminal.payload.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

async function writeJsonEvent(event: CanonicalEvent): Promise<void> {
  const encoded = encodeCanonicalEvent(event);
  const line = Buffer.allocUnsafe(encoded.byteLength + 1);
  line.set(encoded);
  line[encoded.byteLength] = 0x0a;
  await new Promise<void>((resolvePromise, reject) => {
    process.stdout.write(line, (error) => (error ? reject(error) : resolvePromise()));
  });
}

async function runJson(client: AxlClient, input: HeadlessInput): Promise<void> {
  await runHeadless(client, input, writeJsonEvent);
}

function bridgeRpc(socketPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath);
    let failure: Error | undefined;
    let inputEnded = process.stdin.readableEnded;
    const fail = (error: Error): void => {
      failure ??= error;
      socket.destroy();
    };
    const markInputEnded = (): void => {
      inputEnded = true;
    };
    socket.on("error", (error) => {
      failure ??= error;
    });
    process.stdin.once("end", markInputEnded);
    process.stdin.once("error", fail);
    process.stdout.once("error", fail);
    socket.once("connect", () => {
      process.stdin.pipe(socket);
      socket.pipe(process.stdout, { end: false });
    });
    socket.once("close", () => {
      process.stdin.unpipe(socket);
      socket.unpipe(process.stdout);
      process.stdin.off("end", markInputEnded);
      process.stdin.off("error", fail);
      process.stdout.off("error", fail);
      if (failure !== undefined) reject(failure);
      else if (!inputEnded) reject(new Error("Daemon RPC connection closed unexpectedly"));
      else resolvePromise();
    });
  });
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
  if (cli.profile !== undefined && (cli.command === "daemon" || cli.command === "rpc")) {
    throw new Error(
      `--profile selects a session and cannot be used with the ${cli.command} command`,
    );
  }
  if (cli.profile !== undefined && cli.sessionId !== undefined) {
    throw new Error("--profile cannot replace the recorded profile of a resumed session");
  }
  if (cli.profile !== undefined && cli.resume) {
    throw new Error("--profile cannot be combined with --resume");
  }

  const headlessMode = cli.command === "json" || cli.command === "print" ? cli.command : undefined;
  const headlessPrompt =
    headlessMode === undefined ? undefined : await readHeadlessPrompt(cli.prompt, headlessMode);
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
  if (cli.command === "session-export") {
    const { exportSessionRaw } = await import("@axl/daemon");
    const sessionId = cli.sessionId as string;
    const result = await exportSessionRaw({
      dataDirectory: stateDirectory,
      sessionId,
      outputDirectory: cli.output ?? join(cli.cwd, `axl-session-${sessionId}-raw`),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (cli.command === "session-migrate-events") {
    const { migrateSessionEvents } = await import("@axl/daemon");
    const result = await migrateSessionEvents({
      dataDirectory: stateDirectory,
      sessionId: cli.sessionId as string,
      toolVersion: AXL_VERSION,
      confirmPrefix: cli.confirmPrefix,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
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
    const [{ store, context }, { assertInteractiveTerminal }] = await Promise.all([
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
    webFetch: cli.webFetch ?? settings.webFetch ?? true,
    webSearch: cli.webSearch ?? settings.webSearch ?? true,
  };

  if (cli.unsafe && ["daemon", "json", "print", "rpc"].includes(cli.command ?? "")) {
    process.stderr.write(
      "WARNING: --unsafe disables operating-system isolation and gives tools full host access.\n",
    );
  }
  if (cli.command === "daemon") {
    const { store } = await credentials();
    await ensureCredentials(store);
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

  const clientKind =
    cli.command === "json" || cli.command === "print"
      ? cli.command
      : cli.command === "rpc"
        ? "rpc_probe"
        : "tui";
  const connectTarget = async (target: LocalDaemonTarget): Promise<AxlClient> => {
    await mkdir(target.stateDirectory, { recursive: true, mode: 0o700 });
    try {
      return await connectExpectedDaemon(
        target.socketPath,
        target.unsafe,
        target.sandbox,
        target.image,
        clientKind,
      );
    } catch (error) {
      if (error instanceof SecurityModeMismatchError) throw error;
      const { store } = await credentials();
      await ensureCredentials(store, cli.command === undefined);
      return connectOrStartDaemon({
        socketPath: target.socketPath,
        model: active.modelId,
        thinking: active.thinkingLevel,
        unsafe: target.unsafe,
        sandbox: target.sandbox,
        ...(target.image === undefined ? {} : { image: target.image }),
        webFetch: active.webFetch,
        webSearch: active.webSearch,
        clientKind,
      });
    }
  };
  const currentPlacement: LocalSessionPlacement = cli.unsafe
    ? { type: "unsafe" }
    : sandbox.type === "native"
      ? { type: "native" }
      : { type: "oci", engine: sandbox.engine, image: sandbox.image };
  const currentTarget: LocalDaemonTarget = {
    stateDirectory,
    socketPath,
    unsafe: cli.unsafe,
    sandbox: cli.sandbox,
    ...(cli.image === undefined ? {} : { image: cli.image }),
  };
  const client = await connectTarget(currentTarget);
  timing.mark("daemon connect");
  if (cli.command === "rpc") {
    client.close();
    await bridgeRpc(socketPath);
    return;
  }
  if (cli.command === "json" || cli.command === "print") {
    if (headlessPrompt === undefined) throw new Error("Headless prompt was not loaded");
    const input = {
      cwd: cli.cwd,
      prompt: headlessPrompt,
      active,
      ...(cli.profile === undefined ? {} : { profile: cli.profile }),
    };
    try {
      if (cli.command === "json") await runJson(client, input);
      else await runPrint(client, input);
    } finally {
      client.close();
    }
    return;
  }

  let resumeCatalog = new Map<string, LocalSessionDescriptor>();
  const loadResumeSessions = async () => {
    const sessions = await listLocalSessions(axlHome);
    resumeCatalog = new Map(sessions.map((session) => [sessionResumeKey(session), session]));
    return sessions.map((session) => ({
      ...session,
      resumeKey: sessionResumeKey(session),
      unsafe: session.placement.type === "unsafe",
    }));
  };
  const openResumeSession = async (entry: { readonly resumeKey: string }) => {
    let session = resumeCatalog.get(entry.resumeKey);
    if (session === undefined) {
      await loadResumeSessions();
      session = resumeCatalog.get(entry.resumeKey);
    }
    if (session === undefined) throw new Error("Selected session is no longer available");
    const target = samePlacement(session.placement, currentPlacement)
      ? currentTarget
      : targetForPlacement(axlHome, session.placement);
    return {
      client: await connectTarget(target),
      reconnectClient: () => connectTarget(target),
    };
  };

  let settingsWrite: Promise<void> = Promise.resolve();
  const persistSettings = (update: Partial<Omit<TuiSettings, "version">>): Promise<void> => {
    settings = { ...settings, ...update, version: 1 };
    const snapshot = settings;
    settingsWrite = settingsWrite
      .catch(() => undefined)
      .then(() => saveTuiSettings(settingsPath, snapshot));
    return settingsWrite;
  };

  const [
    { AxlApp },
    { mcpTerminalExtension },
    { promptTemplatesExtension },
    { skillTerminalExtension },
  ] = await Promise.all([
    tuiModule ?? import("@axl/tui"),
    import("@axl/extension-mcp"),
    import("@axl/extension-prompts"),
    import("@axl/extension-skills"),
  ]);
  timing.mark("TUI modules");
  const app = await AxlApp.start({
    client,
    input: process.stdin,
    output: process.stdout,
    cwd: cli.cwd,
    listResumeSessions: loadResumeSessions,
    openResumeSession,
    initialResume: cli.resume,
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
    globalThemeDirectory: join(axlHome, "themes"),
    extensions: [
      mcpTerminalExtension,
      promptTemplatesExtension({ cwd: cli.cwd, globalDirectory: join(axlHome, "prompts") }),
      skillTerminalExtension,
    ],
    clearStartupLine: startupIndicator,
    reconnectClient: () => connectTarget(currentTarget),
    onPreferenceChange: persistSettings,
    models: AZURE_OPENAI_MODELS.map((model) => model.modelId),
    modelCatalog: AZURE_OPENAI_MODELS,
    currentModel: active.modelId,
    currentThinking: active.thinkingLevel,
    ...(cli.profile === undefined ? {} : { profile: cli.profile }),
    webFetch: active.webFetch,
    webSearch: active.webSearch,
    loadLogin: async () => {
      const { store, context } = await credentials();
      return azureLoginDialog(store, context);
    },
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
