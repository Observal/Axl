// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * A sandbox policy violation. Tools throw it before touching the filesystem;
 * the agent loop records it as an explicit `sandbox.violation` event plus an
 * error tool result.
 */
export class SandboxViolationError extends Error {
  readonly capability: string;
  readonly reason: string;

  constructor(capability: string, reason: string) {
    super(`${capability}: ${reason}`);
    this.name = "SandboxViolationError";
    this.capability = capability;
    this.reason = reason;
  }
}

/** Filesystem policy for tools: explicit readable roots and workspace-only writes. */
export interface WorkspacePolicy {
  /** Canonical workspace root; the only writable subtree. */
  readonly workspace: string;
  /** The only subtrees visible to file tools. The workspace must be listed explicitly. */
  readonly readableRoots: readonly string[];
  /** Subtrees invisible to tools in both directions, e.g. `~/.axl`. Denials win. */
  readonly protectedPaths: readonly string[];
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Canonicalizes a path before any policy decision: the deepest existing
 * ancestor is resolved through every symlink, so a link pointing outside the
 * workspace canonicalizes to its target and fails the policy check instead of
 * smuggling access through the link.
 */
export async function canonicalizeForPolicy(path: string): Promise<string> {
  let existing = resolve(path);
  let remainder = "";
  for (;;) {
    try {
      const real = await realpath(existing);
      return remainder === "" ? real : real + remainder;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) return existing + remainder; // filesystem root
      remainder = sep + existing.slice(parent.length + 1) + remainder;
      existing = parent;
    }
  }
}

async function canonicalPolicy(policy: WorkspacePolicy): Promise<{
  workspace: string;
  readableRoots: readonly string[];
  protectedPaths: readonly string[];
}> {
  if (policy.readableRoots.length === 0) {
    throw new TypeError("WorkspacePolicy.readableRoots must not be empty");
  }
  return {
    workspace: await canonicalizeForPolicy(policy.workspace),
    readableRoots: await Promise.all(policy.readableRoots.map(canonicalizeForPolicy)),
    protectedPaths: await Promise.all(policy.protectedPaths.map(canonicalizeForPolicy)),
  };
}

/** Reads are allowed only inside an explicit readable root and never in a protected subtree. */
export async function assertReadAllowed(policy: WorkspacePolicy, path: string): Promise<string> {
  const canonical = await canonicalizeForPolicy(path);
  const resolved = await canonicalPolicy(policy);
  for (const protectedPath of resolved.protectedPaths) {
    if (isWithin(canonical, protectedPath)) {
      throw new SandboxViolationError(
        "filesystem.read",
        `${canonical} is inside the protected path ${protectedPath}`,
      );
    }
  }
  if (!resolved.readableRoots.some((root) => isWithin(canonical, root))) {
    throw new SandboxViolationError(
      "filesystem.read",
      `${canonical} is outside the readable roots ${resolved.readableRoots.join(", ")}`,
    );
  }
  return canonical;
}

/** Writes are allowed only inside the workspace and never in protected subtrees. */
export async function assertWriteAllowed(policy: WorkspacePolicy, path: string): Promise<string> {
  const canonical = await canonicalizeForPolicy(path);
  const resolved = await canonicalPolicy(policy);
  for (const protectedPath of resolved.protectedPaths) {
    if (isWithin(canonical, protectedPath)) {
      throw new SandboxViolationError(
        "filesystem.write",
        `${canonical} is inside the protected path ${protectedPath}`,
      );
    }
  }
  if (!isWithin(canonical, resolved.workspace)) {
    throw new SandboxViolationError(
      "filesystem.write",
      `${canonical} is outside the workspace ${resolved.workspace}`,
    );
  }
  if (!resolved.readableRoots.some((root) => isWithin(canonical, root))) {
    throw new TypeError("WorkspacePolicy.workspace must be inside a readable root");
  }
  return canonical;
}
