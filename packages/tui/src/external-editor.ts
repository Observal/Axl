// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  for (const match of command.matchAll(pattern)) parts.push(match[1] ?? match[2] ?? match[3] ?? "");
  return parts;
}

export async function editPromptExternally(content: string, command?: string): Promise<string> {
  const configured = command?.trim() || process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (!configured) throw new Error("Set VISUAL or EDITOR before opening the external editor");
  const [file, ...args] = splitCommand(configured);
  if (!file) throw new Error("External editor command is empty");

  const directory = await mkdtemp(join(tmpdir(), "axl-editor-"));
  const promptPath = join(directory, "prompt.md");
  try {
    await writeFile(promptPath, content, "utf8");
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(file, [...args, promptPath], { stdio: "inherit" });
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0) throw new Error(`External editor exited with code ${code ?? "unknown"}`);
    const edited = await readFile(promptPath, "utf8");
    return edited.replace(/^\uFEFF/, "").replace(/\n$/, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
