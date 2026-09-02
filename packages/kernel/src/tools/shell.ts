// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { JsonObject } from "@axl/protocol";

import { assertReadAllowed, type WorkspacePolicy } from "../path-policy.ts";
import type { KernelTool, ToolExecutionResult } from "../tools.ts";
import {
  optionalPositiveInteger,
  optionalString,
  rejectUnknownFields,
  requiredString,
} from "./validate.ts";

export interface ShellToolOptions {
  /** Default working directory for commands. */
  readonly cwd: string;
  /** Where complete outputs are preserved when the model surface is truncated. */
  readonly overflowDirectory: string;
  /** Optional policy used to reject protected working directories before spawn. */
  readonly policy?: WorkspacePolicy;
  /**
   * Wraps the command into the argv actually spawned — the sandbox seam. The
   * default runs `bash -c` directly; a sandbox provider substitutes its own
   * confinement wrapper. Overflow preservation stays harness-side either way.
   */
  readonly wrapCommand?: (command: string, cwd: string) => readonly string[];
  /** Bytes of output the model sees before truncation. */
  readonly maxOutputBytes?: number;
  readonly defaultTimeoutMs?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 48_000;
const DEFAULT_TIMEOUT_MS = 120_000;
/** Hard cap on captured bytes so a firehose command cannot exhaust memory. */
const CAPTURE_LIMIT_BYTES = 10_000_000;
const KILL_GRACE_MS = 2_000;

interface CommandCapture {
  readonly output: Buffer;
  readonly truncatedCapture: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly endedBy: "exit" | "timeout" | "abort";
}

function runCommand(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CommandCapture> {
  return new Promise((resolvePromise, rejectPromise) => {
    const [executable, ...args] = argv as [string, ...string[]];
    const detached = process.platform !== "win32";
    const child = spawn(executable, args, {
      cwd,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let captured = 0;
    let truncatedCapture = false;
    let endedBy: CommandCapture["endedBy"] = "exit";
    let killTimer: NodeJS.Timeout | undefined;

    const collect = (chunk: Buffer): void => {
      if (captured >= CAPTURE_LIMIT_BYTES) {
        truncatedCapture = true;
        return;
      }
      const room = CAPTURE_LIMIT_BYTES - captured;
      const kept = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      if (kept.byteLength < chunk.byteLength) truncatedCapture = true;
      chunks.push(kept);
      captured += kept.byteLength;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const signalProcessTree = (signalName: NodeJS.Signals): void => {
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signalName);
          return;
        } catch {
          // The group may already be gone or group signaling may be unavailable.
        }
      }
      child.kill(signalName);
    };
    const kill = (reason: CommandCapture["endedBy"]): void => {
      if (endedBy !== "exit") return;
      endedBy = reason;
      signalProcessTree("SIGTERM");
      killTimer = setTimeout(() => signalProcessTree("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const timeout = setTimeout(() => kill("timeout"), timeoutMs);
    timeout.unref();
    const onAbort = (): void => kill("abort");
    signal.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      rejectPromise(error);
    });
    child.once("close", (exitCode, exitSignal) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      resolvePromise({
        output: Buffer.concat(chunks),
        truncatedCapture,
        exitCode,
        signal: exitSignal,
        endedBy,
      });
    });
  });
}

async function preserveOverflow(directory: string, output: Buffer): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `shell-${randomUUID()}.log`);
  await writeFile(path, output, { mode: 0o600 });
  return path;
}

/** Canonical `shell` tool: run one command, bounded output, prompt cancellation. */
export function makeShellTool(options: ShellToolOptions): KernelTool {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return {
    name: "shell",
    description:
      "Run a shell command in the workspace and return its combined output and exit status.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        cwd: { type: "string", description: "Working directory, defaults to the workspace" },
        timeoutMs: { type: "integer", description: "Timeout in milliseconds" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(input: JsonObject, signal: AbortSignal): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "shell", ["command", "cwd", "timeoutMs"]);
      const command = requiredString(input, "shell", "command");
      signal.throwIfAborted();
      let cwd = resolve(options.cwd, optionalString(input, "shell", "cwd") ?? ".");
      if (options.policy !== undefined) cwd = await assertReadAllowed(options.policy, cwd);
      const timeoutMs =
        optionalPositiveInteger(input, "shell", "timeoutMs") ??
        options.defaultTimeoutMs ??
        DEFAULT_TIMEOUT_MS;

      const argv = options.wrapCommand?.(command, cwd) ?? ["bash", "-c", command];
      const started = Date.now();
      const capture = await runCommand(argv, cwd, timeoutMs, signal);
      const durationMs = Date.now() - started;

      let visible = capture.output.toString("utf8");
      let overflowPath: string | undefined;
      const truncated = capture.output.byteLength > maxOutputBytes || capture.truncatedCapture;
      if (truncated) {
        overflowPath = await preserveOverflow(options.overflowDirectory, capture.output);
        const head = capture.output.subarray(0, Math.floor(maxOutputBytes * 0.7)).toString("utf8");
        const tail = capture.output
          .subarray(capture.output.byteLength - Math.floor(maxOutputBytes * 0.3))
          .toString("utf8");
        const hidden = capture.output.byteLength - maxOutputBytes;
        visible = `${head}\n[... ${hidden} bytes truncated; complete output preserved at ${overflowPath}]\n${tail}`;
      }

      const lines: string[] = [visible.length > 0 ? visible : "(no output)"];
      if (capture.endedBy === "timeout") lines.push(`[timed out after ${timeoutMs}ms]`);
      if (capture.endedBy === "abort") lines.push(`[aborted after ${durationMs}ms]`);
      if (capture.exitCode !== null && capture.exitCode !== 0) {
        lines.push(`[exit code ${capture.exitCode}]`);
      }
      if (capture.signal !== null) lines.push(`[terminated by ${capture.signal}]`);

      const isError = capture.exitCode !== 0 || capture.endedBy !== "exit";
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        isError,
        details: {
          exitCode: capture.exitCode,
          signal: capture.signal,
          durationMs,
          endedBy: capture.endedBy,
          outputBytes: capture.output.byteLength,
          ...(overflowPath === undefined ? {} : { overflowPath }),
        },
      };
    },
  };
}
