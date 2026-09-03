// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { KernelTool } from "./tools.ts";
import { makeEditTool } from "./tools/edit.ts";
import { makeShellTool, type ShellToolOptions } from "./tools/shell.ts";

export interface MinimalProfileOptions {
  readonly cwd: string;
  readonly overflowDirectory: string;
  readonly shell?: Omit<ShellToolOptions, "cwd" | "overflowDirectory">;
}

/**
 * The minimal profile: Bash and file editing, the base prompt, nothing else.
 * The smallest thing that is still Axl. No subagent, planning, or task tools
 * exist here — or anywhere — by default.
 */
export function makeMinimalProfileTools(options: MinimalProfileOptions): readonly KernelTool[] {
  return [
    makeShellTool({
      cwd: options.cwd,
      overflowDirectory: options.overflowDirectory,
      ...options.shell,
    }),
    makeEditTool({ cwd: options.cwd }),
  ];
}
