// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { JsonObject } from "@axl/protocol";

import { assertWriteAllowed, type WorkspacePolicy } from "../path-policy.ts";
import type { KernelTool, ToolExecutionResult } from "../tools.ts";
import { rejectUnknownFields, requiredString, ToolInputError } from "./validate.ts";

export interface WriteToolOptions {
  readonly cwd: string;
  readonly policy?: WorkspacePolicy;
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1_000_000;

/** Canonical `write` tool. Creates or atomically replaces one UTF-8 text file. */
export function makeWriteTool(options: WriteToolOptions): KernelTool {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return {
    name: "write",
    description: "Create or overwrite a UTF-8 text file. Parent directories are created as needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or workspace-relative" },
        content: { type: "string", description: "Complete file content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(input: JsonObject): Promise<ToolExecutionResult> {
      rejectUnknownFields(input, "write", ["path", "content"]);
      let path = resolve(options.cwd, requiredString(input, "write", "path"));
      if (options.policy !== undefined) path = await assertWriteAllowed(options.policy, path);
      const content = input.content;
      if (typeof content !== "string") throw new ToolInputError("write: content must be a string");
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > maxBytes) {
        throw new ToolInputError(`write: content is ${bytes} bytes; maximum is ${maxBytes}`);
      }

      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.axl-tmp`;
      try {
        const mode = await stat(path).then(
          (value) => value.mode & 0o777,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return 0o644;
            throw error;
          },
        );
        await writeFile(temporary, content, { encoding: "utf8", mode, flag: "wx" });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }

      return {
        content: [{ type: "text", text: `Wrote ${bytes} bytes to ${path}` }],
        isError: false,
        details: { path, bytes },
      };
    },
  };
}
