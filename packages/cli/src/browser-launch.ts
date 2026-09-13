// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { release } from "node:os";

export interface BrowserLaunchCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export interface BrowserLaunchEnvironment {
  readonly platform: NodeJS.Platform;
  readonly osRelease: string;
  readonly variables: Readonly<Record<string, string | undefined>>;
}

export type BrowserSpawner = (
  command: BrowserLaunchCommand,
  handlers: {
    readonly error: (error: Error) => void;
    readonly exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  },
) => void;

export interface BrowserLaunchOptions {
  readonly environment?: BrowserLaunchEnvironment;
  readonly spawn?: BrowserSpawner;
}

function currentEnvironment(): BrowserLaunchEnvironment {
  return {
    platform: process.platform,
    osRelease: release(),
    variables: process.env,
  };
}

export function isWindowsSubsystemForLinux(environment: BrowserLaunchEnvironment): boolean {
  return (
    environment.platform === "linux" &&
    (environment.variables.WSL_INTEROP !== undefined ||
      environment.variables.WSL_DISTRO_NAME !== undefined ||
      environment.osRelease.toLowerCase().includes("microsoft"))
  );
}

export function browserLaunchCommand(
  url: string,
  environment: BrowserLaunchEnvironment = currentEnvironment(),
): BrowserLaunchCommand {
  if (environment.platform === "darwin") return { file: "open", args: [url] };
  if (environment.platform === "win32") {
    return { file: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (isWindowsSubsystemForLinux(environment)) {
    return { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { file: "xdg-open", args: [url] };
}

const spawnBrowser: BrowserSpawner = (command, handlers) => {
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
  child.once("error", handlers.error);
  child.once("exit", handlers.exit);
  child.unref();
};

export function launchBrowser(url: string, options: BrowserLaunchOptions = {}): Promise<void> {
  const command = browserLaunchCommand(url, options.environment);
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => reject(error);
    const exit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (code === 0) {
        resolve();
        return;
      }
      const status = signal === null ? `code ${code ?? "unknown"}` : `signal ${signal}`;
      reject(new Error(`Browser launcher ${command.file} exited with ${status}`));
    };
    try {
      (options.spawn ?? spawnBrowser)(command, { error: fail, exit });
    } catch (cause) {
      reject(cause);
    }
  });
}
