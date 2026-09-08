// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WIRE_PROTOCOL_VERSION } from "../packages/protocol/src/version.ts";
import { createUnixDaemonHost } from "../packages/sdk/src/unix.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(repoRoot, "packages", "cli", "dist", "main.js");
const binDirectory = join(homedir(), ".local", "bin");
const link = join(binDirectory, "axl");

export function daemonRestartNotice(status: {
  readonly wireVersion: number;
  readonly busy: boolean;
  readonly confirmationRequired: boolean;
}): string | undefined {
  if (status.wireVersion === WIRE_PROTOCOL_VERSION) return undefined;
  const flags = `${status.busy ? " --interrupt" : ""}${status.confirmationRequired ? " --yes" : ""}`;
  return [
    `Warning: running Axl daemon uses wire version ${status.wireVersion}; installed CLI requires ${WIRE_PROTOCOL_VERSION}.`,
    status.busy || status.confirmationRequired
      ? "Inspect active work before restarting:"
      : "Restart it before starting Axl:",
    ...(status.busy || status.confirmationRequired ? ["  axl daemon status"] : []),
    `  axl daemon restart${flags}`,
  ].join("\n");
}

function missingDaemon(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "connection_error" &&
    "cause" in error &&
    error.cause instanceof Error &&
    "code" in error.cause &&
    ["ENOENT", "ECONNREFUSED"].includes(String(error.cause.code))
  );
}

async function reportRunningDaemon(): Promise<void> {
  try {
    const status = await createUnixDaemonHost(join(homedir(), ".axl", "axl.sock")).status();
    const notice = daemonRestartNotice(status);
    if (notice !== undefined) console.warn(notice);
  } catch (error) {
    if (missingDaemon(error)) return;
    console.warn(
      `Warning: installed CLI could not inspect the running daemon: ${error instanceof Error ? error.message : String(error)}. Run axl daemon status before starting Axl.`,
    );
  }
}

async function installCli(): Promise<void> {
  chmodSync(target, 0o755);
  mkdirSync(binDirectory, { recursive: true });
  try {
    const existing = lstatSync(link);
    if (!existing.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink ${link}`);
    unlinkSync(link);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  symlinkSync(target, link);
  console.log(`Installed: ${link} -> ${target}`);

  if (!(process.env.PATH ?? "").split(delimiter).includes(binDirectory)) {
    console.log(`Note: add ${binDirectory} to your PATH to run \`axl\` directly.`);
  }
  await reportRunningDaemon();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await installCli();
