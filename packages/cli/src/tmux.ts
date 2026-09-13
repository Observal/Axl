// SPDX-FileCopyrightText: 2026 Shaan Narendran
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_SOCKET_PATH_LENGTH = 4_096;
const MAX_TITLE_LENGTH = 72;

export type SubagentPaneMode = "off" | "auto" | "tmux";

export interface TmuxEnvironment {
  readonly TMUX?: string;
  readonly TMUX_PANE?: string;
  readonly PATH?: string;
}

export interface TmuxCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type TmuxCommandRunner = (
  executable: string,
  arguments_: readonly string[],
) => Promise<TmuxCommandResult>;

export interface TmuxDiagnostic {
  readonly installed: boolean;
  readonly active: boolean;
  readonly usable: boolean;
  readonly version?: string;
  readonly serverSocket?: string;
  readonly sessionId?: string;
  readonly windowId?: string;
  readonly paneId?: string;
  readonly reason?: string;
}

export interface TmuxChildPaneRequest {
  readonly childSessionId: string;
  readonly childName: string;
  readonly cwd: string;
  readonly socketPath: string;
  readonly serverSocket: string;
  readonly windowId: string;
  readonly parentPaneId: string;
  readonly executable: string;
  readonly executableArguments?: readonly string[];
}

export interface TmuxChildPane {
  readonly multiplexer: "tmux";
  readonly paneId: string;
  readonly title: string;
}

function bounded(
  value: string | undefined,
  field: string,
  maximum = MAX_IDENTIFIER_LENGTH,
): string {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > maximum ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function paneId(value: string): string {
  const id = value.trim();
  if (!/^%\d+$/u.test(id))
    throw new Error(`tmux returned an invalid pane ID: ${JSON.stringify(id)}`);
  return id;
}

function sessionId(value: string): string {
  const id = value.trim();
  if (!/^\$\d+$/u.test(id)) {
    throw new Error(`tmux returned an invalid session ID: ${JSON.stringify(id)}`);
  }
  return id;
}

function windowId(value: string): string {
  const id = value.trim();
  if (!/^@\d+$/u.test(id)) {
    throw new Error(`tmux returned an invalid window ID: ${JSON.stringify(id)}`);
  }
  return id;
}

function title(value: string): string {
  const sanitized = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if (sanitized.length === 0) throw new Error("Child pane name must not be empty");
  return [...sanitized].slice(0, MAX_TITLE_LENGTH).join("");
}

export const runTmuxCommand: TmuxCommandRunner = async (executable, arguments_) => {
  const result = await execFileAsync(executable, [...arguments_], {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

async function invokeTmux(
  run: TmuxCommandRunner,
  arguments_: readonly string[],
): Promise<TmuxCommandResult> {
  try {
    return await run("tmux", arguments_);
  } catch (error) {
    const failure = error as Error & { readonly stderr?: string };
    const detail = failure.stderr?.trim();
    throw new Error(
      detail === undefined || detail.length === 0
        ? failure.message
        : `tmux command failed: ${detail.slice(0, 2_048)}`,
      { cause: error },
    );
  }
}

export async function diagnoseTmux(
  environment: TmuxEnvironment = process.env,
  run: TmuxCommandRunner = runTmuxCommand,
): Promise<TmuxDiagnostic> {
  const active = Boolean(environment.TMUX && environment.TMUX_PANE);
  let version: string | undefined;
  try {
    const result = await invokeTmux(run, ["-V"]);
    version = result.stdout.trim().slice(0, 128) || undefined;
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    const missing = [error, cause].some(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        "code" in candidate &&
        candidate.code === "ENOENT",
    );
    return {
      installed: !missing,
      active,
      usable: false,
      reason: error instanceof Error ? error.message : "tmux executable is unavailable",
    };
  }
  if (!active) {
    return {
      installed: true,
      active: false,
      usable: false,
      ...(version === undefined ? {} : { version }),
      reason: "the current terminal is not inside an identifiable tmux session",
    };
  }
  try {
    const currentPaneId = paneId(bounded(environment.TMUX_PANE, "TMUX_PANE"));
    const details = await invokeTmux(run, [
      "display-message",
      "-p",
      "-t",
      currentPaneId,
      "#{socket_path}\t#{session_id}\t#{window_id}\t#{pane_id}",
    ]);
    const fields = details.stdout.trim().split("\t");
    if (fields.length !== 4) throw new Error("tmux returned invalid pane metadata");
    const serverSocket = bounded(fields[0], "tmux socket path", MAX_SOCKET_PATH_LENGTH);
    const currentSessionId = sessionId(bounded(fields[1], "tmux session ID"));
    const currentWindowId = windowId(bounded(fields[2], "tmux window ID"));
    const verifiedPaneId = paneId(bounded(fields[3], "tmux pane ID"));
    if (verifiedPaneId !== currentPaneId) throw new Error("tmux reported a different current pane");
    return {
      installed: true,
      active: true,
      usable: true,
      ...(version === undefined ? {} : { version }),
      serverSocket,
      sessionId: currentSessionId,
      windowId: currentWindowId,
      paneId: verifiedPaneId,
    };
  } catch (error) {
    return {
      installed: true,
      active: true,
      usable: false,
      ...(version === undefined ? {} : { version }),
      reason: error instanceof Error ? error.message : "tmux session query failed",
    };
  }
}

async function verifyTmuxPane(
  serverSocket: string,
  targetPane: string,
  run: TmuxCommandRunner,
  expectedTitle?: string,
  expectedWindow?: string,
): Promise<void> {
  const details = await invokeTmux(run, [
    "-S",
    bounded(serverSocket, "tmux socket path", MAX_SOCKET_PATH_LENGTH),
    "display-message",
    "-p",
    "-t",
    paneId(targetPane),
    "#{window_id}\t#{pane_id}\t#{pane_title}",
  ]);
  const [actualWindow, actualPane, actualTitle, ...extra] = details.stdout.trim().split("\t");
  if (extra.length > 0 || actualPane !== paneId(targetPane)) {
    throw new Error(`tmux pane ${targetPane} no longer exists`);
  }
  if (expectedWindow !== undefined && actualWindow !== windowId(expectedWindow)) {
    throw new Error(`tmux pane ${targetPane} moved to another window`);
  }
  if (expectedTitle !== undefined && actualTitle !== expectedTitle) {
    throw new Error(`tmux pane ${targetPane} is not the expected managed Axl pane`);
  }
}

async function rebalanceTmuxWindow(
  serverSocket: string,
  targetWindow: string,
  run: TmuxCommandRunner,
): Promise<void> {
  await invokeTmux(run, [
    "-S",
    bounded(serverSocket, "tmux socket path", MAX_SOCKET_PATH_LENGTH),
    "select-layout",
    "-t",
    windowId(targetWindow),
    "tiled",
  ]);
}

export async function createTmuxChildPane(
  request: TmuxChildPaneRequest,
  run: TmuxCommandRunner = runTmuxCommand,
): Promise<TmuxChildPane> {
  const childSessionId = bounded(request.childSessionId, "childSessionId");
  const serverSocket = bounded(request.serverSocket, "tmux socket path", MAX_SOCKET_PATH_LENGTH);
  const targetWindow = windowId(request.windowId);
  const parentPane = paneId(request.parentPaneId);
  const childTitle = title(`axl:${request.childName}`);
  await verifyTmuxPane(serverSocket, parentPane, run, undefined, targetWindow);
  const priorRemainOnExit = await invokeTmux(run, [
    "-S",
    serverSocket,
    "show-options",
    "-w",
    "-v",
    "-t",
    targetWindow,
    "remain-on-exit",
  ]);
  const priorSetting = priorRemainOnExit.stdout.trim();
  if (priorSetting !== "" && priorSetting !== "on" && priorSetting !== "off") {
    throw new Error("tmux returned an invalid remain-on-exit setting");
  }
  await invokeTmux(run, [
    "-S",
    serverSocket,
    "set-option",
    "-w",
    "-t",
    targetWindow,
    "remain-on-exit",
    "on",
  ]);
  let createdPaneId: string | undefined;
  try {
    const result = await invokeTmux(run, [
      "-S",
      serverSocket,
      "split-window",
      "-h",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      targetWindow,
      "-c",
      request.cwd,
      "--",
      request.executable,
      ...(request.executableArguments ?? []),
      childSessionId,
      "--socket",
      request.socketPath,
    ]);
    createdPaneId = paneId(result.stdout);
    await invokeTmux(run, [
      "-S",
      serverSocket,
      "set-option",
      "-p",
      "-t",
      createdPaneId,
      "remain-on-exit",
      "on",
    ]);
    await invokeTmux(run, [
      "-S",
      serverSocket,
      "set-option",
      "-p",
      "-t",
      createdPaneId,
      "@axl_child_session",
      childSessionId,
    ]);
  } finally {
    await invokeTmux(
      run,
      priorSetting === ""
        ? ["-S", serverSocket, "set-option", "-w", "-u", "-t", targetWindow, "remain-on-exit"]
        : [
            "-S",
            serverSocket,
            "set-option",
            "-w",
            "-t",
            targetWindow,
            "remain-on-exit",
            priorSetting,
          ],
    );
  }
  if (createdPaneId === undefined) throw new Error("tmux did not create a child pane");
  await invokeTmux(run, ["-S", serverSocket, "select-pane", "-t", createdPaneId, "-T", childTitle]);
  await rebalanceTmuxWindow(serverSocket, targetWindow, run);
  return { multiplexer: "tmux", paneId: createdPaneId, title: childTitle };
}

export async function focusTmuxPane(
  id: string,
  serverSocket: string,
  run: TmuxCommandRunner = runTmuxCommand,
  expectedTitle?: string,
  expectedWindow?: string,
): Promise<void> {
  await verifyTmuxPane(serverSocket, id, run, expectedTitle, expectedWindow);
  await invokeTmux(run, [
    "-S",
    bounded(serverSocket, "tmux socket path", MAX_SOCKET_PATH_LENGTH),
    "select-pane",
    "-t",
    paneId(id),
  ]);
}

export async function closeTmuxManagedPanes(
  serverSocket: string,
  targetWindow: string,
  parentPaneId: string,
  run: TmuxCommandRunner = runTmuxCommand,
): Promise<void> {
  const socket = bounded(serverSocket, "tmux socket path", MAX_SOCKET_PATH_LENGTH);
  const window = windowId(targetWindow);
  const parent = paneId(parentPaneId);
  const listed = await invokeTmux(run, [
    "-S",
    socket,
    "list-panes",
    "-t",
    window,
    "-F",
    "#{pane_id}\t#{pane_title}\t#{@axl_child_session}",
  ]);
  const managed: string[] = [];
  for (const [index, line] of listed.stdout.split("\n").entries()) {
    if (line.length === 0) continue;
    const fields = line.split("\t");
    if (fields.length !== 3)
      throw new Error(`tmux returned invalid pane metadata at line ${index}`);
    const [rawPane, paneTitle, childSessionId] = fields as [string, string, string];
    const candidate = paneId(rawPane);
    if (candidate === parent || childSessionId.length === 0) continue;
    if (
      !paneTitle.startsWith("axl:") ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(childSessionId)
    ) {
      throw new Error(`Refusing to close unverified tmux pane ${candidate}`);
    }
    managed.push(candidate);
  }
  for (const candidate of managed) {
    await invokeTmux(run, ["-S", socket, "kill-pane", "-t", candidate]);
  }
  if (managed.length > 0) await rebalanceTmuxWindow(socket, window, run);
}

export async function closeTmuxPane(
  id: string,
  serverSocket: string,
  run: TmuxCommandRunner = runTmuxCommand,
  parentPaneId?: string,
  targetWindow?: string,
  expectedTitle?: string,
): Promise<void> {
  const target = paneId(id);
  if (parentPaneId !== undefined && target === paneId(parentPaneId)) {
    throw new Error("Refusing to close the parent tmux pane");
  }
  const socket = bounded(serverSocket, "tmux socket path", MAX_SOCKET_PATH_LENGTH);
  await verifyTmuxPane(socket, target, run, expectedTitle, targetWindow);
  await invokeTmux(run, ["-S", socket, "kill-pane", "-t", target]);
  if (targetWindow !== undefined) await rebalanceTmuxWindow(socket, targetWindow, run);
}
