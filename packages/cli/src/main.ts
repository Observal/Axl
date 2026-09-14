#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import type { CredentialStore } from "@axl/ai";
import {
  type CanonicalEvent,
  DEFAULT_MODEL_REQUEST_SETTINGS,
  encodeCanonicalEvent,
  MAX_WIRE_MESSAGE_BYTES,
  type ModelRequestSettings,
  type ProviderLoginMethod,
  parseModelRequestSettings,
  type SessionId,
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
  loginProviderFromTrustedHost,
  startLocalDaemon,
} from "@axl/runtime";
import {
  type AxlClient,
  AxlClientError,
  subscribeSession,
  type TrustedProviderHost,
} from "@axl/sdk";
import { connectUnixClient, createUnixDaemonHost } from "@axl/sdk/unix";

import { launchBrowser } from "./browser-launch.ts";
import { inspectLegacyDaemon, type LegacyDaemonStatus, stopLegacyDaemon } from "./legacy-daemon.ts";
import { createTerminalProviderLoginAdapter } from "./provider-auth-ui.ts";
import { providerErrorMessage, runProviderCommand, usageLine } from "./provider-cli.ts";
import { loadTuiSettings, saveTuiSettings, type TuiSettings } from "./settings.ts";

const AXL_VERSION = process.env.AXL_BUILD_VERSION ?? "0.0.0-dev";
const WEB_ASSET_RELATIVE_PATH = process.env.AXL_WEB_ASSET_PATH ?? "../../web/dist";

const HELP = `Usage: axl [session-id] [options]
       axl web [session-id] [--no-open] [--print-url]
       axl providers [provider-id]
       axl models [provider-id]
       axl login <provider-id> [api_key|oauth]
       axl logout <provider-id>
       axl refresh [provider-id]
       axl doctor
       axl daemon [status|stop|restart] [options]
       axl print [prompt] [options]
       axl json [prompt] [options]
       axl rpc [options]
       axl session export <session-id> --raw [--output <directory>]
       axl session migrate-events <session-id> [--confirm-prefix]

Options:
  --cwd <path>       Set the workspace directory
  --provider <id>    Select the initial provider
  --model <id>       Select the initial model
  --thinking <level> Select the initial reasoning effort
  --max-output-tokens <n|model>  Set an output ceiling or use the model maximum
  --http-idle-timeout <ms>       Header/body idle timeout; 0 disables it
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
  --web-tools         Enable web_fetch and web_search (default)
  --no-web-tools      Disable web_fetch and web_search
  --web-fetch         Enable web_fetch
  --no-web-fetch      Disable web_fetch
  --web-search        Enable web_search
  --no-web-search     Disable web_search
  --output <path>    Set the raw session export directory
  --confirm-prefix   Recover only events before an unsupported oversized event
  --interrupt        Authorize cancellation for daemon stop/restart
  --yes              Confirm disconnecting other daemon clients
  --force            Force a previously requested shutdown (daemon stop --yes)
  --no-open          Do not open a browser for axl web
  --print-url        Print the one-use axl web launch URL for manual opening
  --help             Show this help
  --version          Show the installed version
`;

type SandboxChoice = "native" | "podman" | "docker";

interface CliArguments {
  command?:
    | "providers"
    | "models"
    | "login"
    | "logout"
    | "refresh"
    | "daemon"
    | "doctor"
    | "json"
    | "print"
    | "rpc"
    | "web"
    | "session-export"
    | "session-migrate-events";
  daemonAction?: "status" | "stop" | "restart";
  interrupt: boolean;
  yes: boolean;
  force: boolean;
  sessionId?: string;
  providerTarget?: string;
  loginMethod?: ProviderLoginMethod;
  prompt: string[];
  output?: string;
  raw: boolean;
  confirmPrefix: boolean;
  socket?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  maxOutputTokens?: number | null;
  httpIdleTimeoutMs?: number;
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
  noOpen: boolean;
  printUrl: boolean;
  showHelp: boolean;
  showVersion: boolean;
}

function parseArguments(argv: readonly string[]): CliArguments {
  const parsed: CliArguments = {
    interrupt: false,
    yes: false,
    force: false,
    cwd: process.cwd(),
    prompt: [],
    sandbox: "native",
    unsafe: false,
    resume: false,
    noOpen: false,
    printUrl: false,
    raw: false,
    confirmPrefix: false,
    showHelp: false,
    showVersion: false,
  };
  if (argv[0] === "daemon" && ["--status", "--stop", "--restart"].includes(argv[1] ?? "")) {
    throw new Error(`Use axl daemon ${argv[1]?.slice(2)} (a subcommand, without the leading --)`);
  }
  let startIndex = 0;
  if (argv[0] === "web") {
    parsed.command = "web";
    startIndex = 1;
  }
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
  if (argv[0] === "daemon" && argv[1] !== undefined && !argv[1].startsWith("-")) {
    const action = argv[1];
    if (action !== "status" && action !== "stop" && action !== "restart")
      throw new Error("daemon requires status, stop, or restart");
    parsed.command = "daemon";
    parsed.daemonAction = action;
    startIndex = 2;
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
    if (argument === "--no-open") parsed.noOpen = true;
    else if (argument === "--print-url") parsed.printUrl = true;
    else if (argument === "--interrupt") parsed.interrupt = true;
    else if (argument === "--yes") parsed.yes = true;
    else if (argument === "--force") parsed.force = true;
    else if (argument === "--socket") parsed.socket = next();
    else if (argument === "--provider") parsed.provider = next();
    else if (argument === "--output") parsed.output = next();
    else if (argument === "--raw") parsed.raw = true;
    else if (argument === "--confirm-prefix") parsed.confirmPrefix = true;
    else if (argument === "--model") parsed.model = next();
    else if (argument === "--max-output-tokens") {
      const value = next();
      parsed.maxOutputTokens = value === "model" ? null : Number(value);
      parseModelRequestSettings({
        ...DEFAULT_MODEL_REQUEST_SETTINGS,
        maxOutputTokens: parsed.maxOutputTokens,
      });
    } else if (argument === "--http-idle-timeout") {
      parsed.httpIdleTimeoutMs = Number(next());
      parseModelRequestSettings({
        ...DEFAULT_MODEL_REQUEST_SETTINGS,
        httpIdleTimeoutMs: parsed.httpIdleTimeoutMs,
      });
    } else if (argument === "--thinking") parsed.thinking = next() as ThinkingLevel;
    else if (argument === "--profile") {
      const profile = next();
      if (profile !== "standard" && profile !== "exec") {
        throw new Error(`Unknown profile ${profile}; expected standard or exec`);
      }
      parsed.profile = profile;
    } else if (argument === "--web-tools") {
      parsed.webFetch = true;
      parsed.webSearch = true;
    } else if (argument === "--no-web-tools") {
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
      argument === "providers" ||
      argument === "models" ||
      argument === "login" ||
      argument === "logout" ||
      argument === "refresh" ||
      argument === "daemon" ||
      argument === "doctor" ||
      argument === "rpc"
    ) {
      parsed.command = argument;
    } else if (
      !argument.startsWith("-") &&
      ["providers", "models", "login", "logout", "refresh"].includes(parsed.command ?? "")
    ) {
      if (parsed.providerTarget === undefined) parsed.providerTarget = argument;
      else if (
        parsed.command === "login" &&
        parsed.loginMethod === undefined &&
        (argument === "api_key" || argument === "oauth")
      ) {
        parsed.loginMethod = argument;
      } else throw new Error(`Unexpected ${parsed.command} argument ${argument}`);
    } else if (!argument.startsWith("-") && !parsed.command?.startsWith("session-")) {
      parsed.sessionId = argument;
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (parsed.command === "login" || parsed.command === "logout") {
    if (parsed.providerTarget === undefined)
      throw new Error(`${parsed.command} requires a provider ID`);
  }
  if (
    (parsed.interrupt || parsed.yes || parsed.force) &&
    parsed.daemonAction !== "stop" &&
    parsed.daemonAction !== "restart"
  )
    throw new Error("--interrupt, --yes, and --force require daemon stop or restart");
  if (parsed.force && (parsed.daemonAction !== "stop" || !parsed.yes))
    throw new Error("--force requires daemon stop --yes after graceful shutdown was requested");
  if (parsed.command === "daemon" && parsed.sessionId !== undefined)
    throw new Error("Unexpected daemon argument");
  if (
    (parsed.maxOutputTokens !== undefined || parsed.httpIdleTimeoutMs !== undefined) &&
    (parsed.resume || parsed.sessionId !== undefined)
  )
    throw new Error(
      "Request settings flags select new sessions; use /request to configure a resumed session",
    );
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
  if (parsed.noOpen && parsed.command !== "web") throw new Error("--no-open requires axl web");
  if (parsed.printUrl && parsed.command !== "web") throw new Error("--print-url requires axl web");
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

interface ActiveConfig {
  readonly providerId: string;
  readonly requestSettings: ModelRequestSettings;
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly webFetch: boolean;
  readonly webSearch: boolean;
}

function missingDaemon(error: unknown): boolean {
  return (
    error instanceof AxlClientError &&
    error.code === "connection_error" &&
    error.cause instanceof Error &&
    "code" in error.cause &&
    ["ENOENT", "ECONNREFUSED"].includes(String(error.cause.code))
  );
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
  }).catch((error: unknown) => {
    if (error instanceof AxlClientError && error.code === "version_mismatch") {
      const target = `--socket '${socketPath.replaceAll("'", "'\\''")}'${unsafe ? " --unsafe" : ""}${sandbox === "native" ? "" : ` --sandbox ${sandbox} --image '${image?.replaceAll("'", "'\\''")}'`}`;
      throw new AxlClientError(
        error.code,
        `${error.message}. No daemon was replaced. Inspect with axl daemon status ${target}, then explicitly stop or restart it. To authorize interruption and client disconnection, use axl daemon restart ${target} --interrupt --yes. Older daemons require verified OS recovery; see SETUP.md.`,
        { cause: error },
      );
    }
    throw error;
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
  readonly requestSettings: ModelRequestSettings;
  readonly socketPath: string;
  readonly provider: string;
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
    if (!missingDaemon(error)) throw error;
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
        "--provider",
        input.provider,
        "--model",
        input.model,
        "--thinking",
        input.thinking,
        "--http-idle-timeout",
        String(input.requestSettings.httpIdleTimeoutMs),
        "--max-output-tokens",
        input.requestSettings.maxOutputTokens === null
          ? "model"
          : String(input.requestSettings.maxOutputTokens),
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
        if (!missingDaemon(retryError)) throw retryError;
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
    providerId: input.active.providerId,
    requestSettings: input.active.requestSettings,
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
  if (terminal.payload.usage !== undefined) {
    process.stderr.write(`${usageLine(terminal.payload.usage)}\n`);
  }
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
  if (cli.command === "login") {
    const { assertInteractiveTerminal } = await import("@axl/tui");
    assertInteractiveTerminal(process.stdin, process.stdout);
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
  if (cli.daemonAction !== undefined) {
    const host = createUnixDaemonHost(socketPath);
    try {
      const status = await host.status();
      if (cli.daemonAction === "status") {
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return;
      }
      if (
        cli.daemonAction === "restart" &&
        status.dataDirectory !== (await realpath(stateDirectory))
      ) {
        throw new Error(
          "Restart would change the daemon data directory. Select its original --unsafe or --sandbox placement; no daemon was stopped.",
        );
      }
      if (cli.force) {
        await host.force(status.instanceId);
        process.stdout.write(
          `Force termination requested for daemon ${status.instanceId}. Unflushed data may be lost.\n`,
        );
        return;
      }
      if ((status.busy && !cli.interrupt) || (status.confirmationRequired && !cli.yes)) {
        process.stderr.write(`${JSON.stringify(status, null, 2)}\n`);
        throw new AxlClientError(
          "confirmation_required",
          "Daemon was not stopped. Use --interrupt to cancel accepted work and --yes to confirm disconnecting clients.",
        );
      }
      await host.shutdown(status, { interrupt: cli.interrupt, confirmed: cli.yes });
      process.stdout.write(`Stopped daemon ${status.instanceId}. Session histories preserved.\n`);
    } catch (error) {
      if (error instanceof AxlClientError && error.code === "host_unavailable" && !cli.force) {
        const entryPath = process.argv[1];
        if (entryPath === undefined)
          throw new Error("Cannot locate the Axl entry point for recovery");
        const target = {
          entryPath,
          socketPath,
          stateDirectory,
          unsafe: cli.unsafe,
          sandbox: cli.sandbox,
          ...(cli.image === undefined ? {} : { image: cli.image }),
        };
        let legacy: LegacyDaemonStatus;
        try {
          legacy = await inspectLegacyDaemon(target);
        } catch (cause) {
          throw new AxlClientError(
            "host_unavailable",
            `${error.message} OS verification failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
            { cause },
          );
        }
        if (cli.daemonAction === "status") {
          process.stdout.write(`${JSON.stringify(legacy, null, 2)}\n`);
          return;
        }
        if (!cli.interrupt || !cli.yes) {
          throw new AxlClientError(
            "confirmation_required",
            `Verified legacy daemon ${legacy.processIdentity} speaks wire ${legacy.wireVersion} and has no host-control channel. Active work and clients are unknown. Use daemon ${cli.daemonAction} with --interrupt --yes to authorize graceful OS recovery; no process was stopped.`,
          );
        }
        process.stdout.write(
          `Legacy daemon has no host control. Sending SIGTERM to verified process ${legacy.processIdentity}.\n`,
        );
        await stopLegacyDaemon(target, legacy);
        process.stdout.write("Stopped legacy daemon. Session histories preserved.\n");
      } else {
        if (!missingDaemon(error)) throw error;
        if (cli.daemonAction !== "restart") {
          process.stdout.write("Daemon is not running at the selected socket.\n");
          process.exitCode = 3;
          return;
        }
      }
    }
    if (cli.daemonAction === "stop") return;
  }
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

  let credentialsPromise: Promise<{ store: CredentialStore }> | undefined;
  const credentials = () => {
    credentialsPromise ??= import("@axl/ai").then(({ FileCredentialStore }) => ({
      store: new FileCredentialStore(join(axlHome, "credentials.json")),
    }));
    return credentialsPromise;
  };

  const active: ActiveConfig = {
    providerId: cli.provider ?? settings.providerId ?? "azure-openai-responses",
    requestSettings: parseModelRequestSettings({
      maxOutputTokens:
        cli.maxOutputTokens === undefined
          ? (settings.requestSettings?.maxOutputTokens ?? null)
          : cli.maxOutputTokens,
      httpIdleTimeoutMs:
        cli.httpIdleTimeoutMs ??
        settings.requestSettings?.httpIdleTimeoutMs ??
        DEFAULT_MODEL_REQUEST_SETTINGS.httpIdleTimeoutMs,
    }),
    modelId: cli.model ?? settings.modelId ?? "gpt-5",
    thinkingLevel: cli.thinking ?? settings.thinkingLevel ?? "medium",
    ...(settings.compaction === undefined ? {} : { compaction: settings.compaction }),
    webFetch: cli.webFetch ?? settings.webFetch ?? true,
    webSearch: cli.webSearch ?? settings.webSearch ?? true,
  };

  if (cli.unsafe && ["daemon", "json", "print", "rpc"].includes(cli.command ?? "")) {
    process.stderr.write(
      "WARNING: --unsafe disables operating-system isolation and gives tools full host access.\n",
    );
  }
  if (cli.command === "daemon" && cli.daemonAction === undefined) {
    const { store } = await credentials();
    const daemon = await startLocalDaemon({
      buildVersion: AXL_VERSION,
      onStopped: () => process.exit(0),
      forceTerminate: () => process.exit(1),
      axlHome,
      stateDirectory,
      socketPath,
      defaults: active,
      store,
      unsafe: cli.unsafe,
      sandbox,
    });
    const stop = (): void => {
      void daemon.stop().catch((error: unknown) => {
        process.stderr.write(
          `Daemon shutdown failed: ${error instanceof Error ? error.message : String(error)}. Inspect axl daemon status; use daemon stop --force --yes only if cleanup cannot complete.\n`,
        );
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise(() => undefined);
    return;
  }

  const loginFromThisHost = async (
    providerId: string,
    method: ProviderLoginMethod,
    signal?: AbortSignal,
    presentation?: import("@axl/tui").ProviderLoginPresentation,
  ) => {
    const { store } = await credentials();
    return loginProviderFromTrustedHost({
      store,
      axlHome,
      adapter: createTerminalProviderLoginAdapter(process.stdin, process.stdout, presentation),
      providerId,
      method,
      ...(signal === undefined ? {} : { signal }),
    });
  };

  const clientKind =
    cli.command === "json" || cli.command === "print"
      ? cli.command
      : cli.command === "rpc"
        ? "rpc_probe"
        : ["providers", "models", "login", "logout", "refresh"].includes(cli.command ?? "")
          ? "cli"
          : cli.command === "web"
            ? "web_host"
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
      if (error instanceof SecurityModeMismatchError || !missingDaemon(error)) throw error;
      return connectOrStartDaemon({
        requestSettings: active.requestSettings,
        socketPath: target.socketPath,
        provider: active.providerId,
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
  const webGateways = new Set<{ readonly close: () => Promise<void> }>();
  const openWebForTarget =
    (target: LocalDaemonTarget) =>
    async (
      sessionId: SessionId,
      cwd: string,
      providerHost: TrustedProviderHost,
    ): Promise<string> => {
      const { startWebGateway } = await import("./web-gateway.ts");
      const gateway = await startWebGateway({
        socketPath: target.socketPath,
        stateDirectory: target.stateDirectory,
        cwd,
        assetDirectory: resolve(dirname(fileURLToPath(import.meta.url)), WEB_ASSET_RELATIVE_PATH),
        packageVersion: AXL_VERSION,
        providerHost,
      });
      try {
        await launchBrowser(`${gateway.launchUrl}&session=${encodeURIComponent(sessionId)}`);
      } catch (error) {
        await gateway.close();
        throw error;
      }
      webGateways.add(gateway);
      return gateway.origin;
    };
  const client = await connectTarget(currentTarget);
  timing.mark("daemon connect");
  if (cli.daemonAction === "restart") {
    client.close();
    process.stdout.write(`Started daemon at ${socketPath}.\n`);
    return;
  }
  if (cli.command === "rpc") {
    client.close();
    await bridgeRpc(socketPath);
    return;
  }
  if (cli.command === "web") {
    client.close();
    const { startWebGateway } = await import("./web-gateway.ts");
    const gateway = await startWebGateway({
      socketPath,
      stateDirectory,
      cwd: cli.cwd,
      assetDirectory: resolve(dirname(fileURLToPath(import.meta.url)), WEB_ASSET_RELATIVE_PATH),
      packageVersion: AXL_VERSION,
      ...(process.stdin.isTTY === true && process.stdout.isTTY === true
        ? {
            providerHost: {
              loginProvider: (
                { providerId, method }: { providerId: string; method: ProviderLoginMethod },
                options: { readonly signal?: AbortSignal } = {},
              ) => loginFromThisHost(providerId, method, options.signal),
            },
          }
        : {}),
    });
    process.stdout.write(`Axl web: ${gateway.origin}\n`);
    const launchUrl =
      cli.sessionId === undefined
        ? gateway.launchUrl
        : `${gateway.launchUrl}&session=${encodeURIComponent(cli.sessionId)}`;
    if (cli.printUrl) {
      // Explicitly requested token-bearing URL: one use, expires in 60 seconds.
      process.stdout.write(`Open within 60 seconds (one use): ${launchUrl}\n`);
    }
    if (!cli.noOpen) {
      try {
        await launchBrowser(launchUrl);
      } catch (cause) {
        await gateway.close();
        throw new Error(
          `Could not open the authenticated web client automatically: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    const stop = (): void => {
      void gateway.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise(() => undefined);
    return;
  }
  if (["providers", "models", "login", "logout", "refresh"].includes(cli.command ?? "")) {
    try {
      await runProviderCommand({
        client,
        command: cli.command as "providers" | "models" | "login" | "logout" | "refresh",
        ...(cli.providerTarget === undefined ? {} : { providerId: cli.providerTarget }),
        ...(cli.loginMethod === undefined ? {} : { loginMethod: cli.loginMethod }),
        ...(cli.command === "login" ? { login: loginFromThisHost } : {}),
        write: (value) => process.stdout.write(value),
      });
    } finally {
      client.close();
    }
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
      daemonHost: createUnixDaemonHost(target.socketPath),
      openWeb: openWebForTarget(target),
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
    daemonHost: createUnixDaemonHost(socketPath),
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
    openWeb: openWebForTarget(currentTarget),
    loginProvider: (providerId, method, signal, presentation) =>
      loginFromThisHost(providerId, method, signal, presentation),
    onPreferenceChange: persistSettings,
    currentProvider: active.providerId,
    requestSettings: active.requestSettings,
    currentModel: active.modelId,
    currentThinking: active.thinkingLevel,
    ...(cli.profile === undefined ? {} : { profile: cli.profile }),
    webFetch: active.webFetch,
    webSearch: active.webSearch,
    ...(cli.sessionId === undefined ? {} : { sessionId: cli.sessionId }),
    onExit: () => {
      void Promise.allSettled([...webGateways].map((gateway) => gateway.close())).finally(() =>
        settingsWrite.finally(() => process.exit(0)),
      );
    },
  });
  timing.mark("first paint");
  const timingSummary = timing.summary();
  if (timingSummary !== undefined) app.showLocalNotice(timingSummary);
}

main().catch((error: unknown) => {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
  process.stderr.write(`axl: ${providerErrorMessage(error)}\n`);
  process.exit(
    error instanceof AxlClientError &&
      ["busy", "confirmation_required", "state_changed"].includes(error.code)
      ? 2
      : 1,
  );
});
