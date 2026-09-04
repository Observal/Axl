// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";

function commandForRead(): { file: string; args: string[] } {
  if (process.platform === "darwin") return { file: "pbpaste", args: [] };
  if (process.platform === "win32" || process.env.WSL_DISTRO_NAME) {
    return {
      file:
        process.platform === "win32"
          ? "powershell.exe"
          : "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Get-Clipboard -Raw",
      ],
    };
  }
  return { file: "wl-paste", args: ["-n"] };
}

function commandForWrite(): { file: string; args: string[] } {
  if (process.platform === "darwin") return { file: "pbcopy", args: [] };
  if (process.platform === "win32" || process.env.WSL_DISTRO_NAME) {
    return { file: "clip.exe", args: [] };
  }
  return { file: "wl-copy", args: [] };
}

export function readClipboardText(): Promise<string> {
  const command = commandForRead();
  return new Promise((resolve, reject) => {
    execFile(
      command.file,
      command.args,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Clipboard read failed: ${error.message}`, { cause: error }));
          return;
        }
        resolve(stdout.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
      },
    );
  });
}

export function writeClipboardText(text: string): Promise<void> {
  const command = commandForWrite();
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      reject(new Error(`Clipboard write failed: ${error.message}`, { cause: error }));
    });
    child.stdin.once("error", (error) => {
      reject(new Error(`Clipboard write failed: ${error.message}`, { cause: error }));
    });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Clipboard write failed with exit code ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(text);
  });
}
