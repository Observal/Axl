// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { DiscoveryError } from "./errors.ts";
import { mergeLimits, nodeFileSystem, type BoundedFileSystem } from "./filesystem.ts";
import type { SourceAdapter } from "./source-adapter.ts";
import type { DiscoveryCandidate, DiscoveryContext, DiscoveryResult, Ecosystem } from "./types.ts";
import { claudeCodeAdapter, dshAdapter, openCodeAdapter } from "./ecosystems/declarative.ts";
import { piAdapter } from "./ecosystems/pi.ts";

export const sourceAdapters: readonly SourceAdapter[] = Object.freeze([
  openCodeAdapter,
  dshAdapter,
  claudeCodeAdapter,
  piAdapter,
]);

const ecosystemOrder: Readonly<Record<Ecosystem, number>> = {
  opencode: 0,
  dsh: 1,
  "claude-code": 2,
  pi: 3,
};

function lexical(left: string, right: string): number {
  const normalizedLeft = left.normalize("NFC");
  const normalizedRight = right.normalize("NFC");
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function compareCandidates(left: DiscoveryCandidate, right: DiscoveryCandidate): number {
  return (
    ecosystemOrder[left.ecosystem] - ecosystemOrder[right.ecosystem] ||
    (left.scope === right.scope ? 0 : left.scope === "global" ? -1 : 1) ||
    lexical(left.displayName, right.displayName) ||
    lexical(left.kind, right.kind) ||
    lexical(left.candidateId, right.candidateId)
  );
}

export interface DiscoverOptions {
  readonly ecosystems?: readonly Ecosystem[];
  readonly fileSystem?: BoundedFileSystem;
  readonly adapters?: readonly SourceAdapter[];
  readonly signal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException("Discovery was cancelled", "AbortError");
}

function cancellableFileSystem(
  fileSystem: BoundedFileSystem,
  signal: AbortSignal | undefined,
): BoundedFileSystem {
  if (signal === undefined) return fileSystem;
  return {
    async realpath(path) {
      throwIfAborted(signal);
      const value = await fileSystem.realpath(path);
      throwIfAborted(signal);
      return value;
    },
    async lstat(path) {
      throwIfAborted(signal);
      const value = await fileSystem.lstat(path);
      throwIfAborted(signal);
      return value;
    },
    async readdir(path) {
      throwIfAborted(signal);
      const value = await fileSystem.readdir(path);
      throwIfAborted(signal);
      return value;
    },
    async readStableFile(path, maximumBytes, canonicalRoot) {
      throwIfAborted(signal);
      const value = await fileSystem.readStableFile(path, maximumBytes, canonicalRoot);
      throwIfAborted(signal);
      return value;
    },
  };
}

export async function discover(
  context: DiscoveryContext,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const limits = mergeLimits(context.limits);
  const requested = new Set(
    options.ecosystems ?? sourceAdapters.map((adapter) => adapter.ecosystem),
  );
  const adapters = (options.adapters ?? sourceAdapters).filter((adapter) =>
    requested.has(adapter.ecosystem),
  );
  throwIfAborted(options.signal);
  const fileSystem = cancellableFileSystem(options.fileSystem ?? nodeFileSystem, options.signal);
  const results = await Promise.all(
    adapters.map((adapter) => adapter.discover({ ...context, limits }, fileSystem)),
  );
  throwIfAborted(options.signal);
  const candidates = results.flatMap((result) => result.candidates).sort(compareCandidates);
  if (candidates.length > limits.maxCandidates) {
    throw new DiscoveryError("adoption_scan_limit_exceeded", "candidate count exceeded");
  }
  if (candidates.some((candidate) => candidate.surfaces.length > limits.maxSurfacesPerCandidate)) {
    throw new DiscoveryError("adoption_scan_limit_exceeded", "surface count exceeded");
  }
  if (candidates.some((candidate) => candidate.diagnostics.length > limits.maxDiagnostics)) {
    throw new DiscoveryError("adoption_scan_limit_exceeded", "candidate diagnostic count exceeded");
  }
  const diagnostics = results.flatMap((result) => result.diagnostics);
  if (diagnostics.length > limits.maxDiagnostics) {
    throw new DiscoveryError("adoption_scan_limit_exceeded", "diagnostic count exceeded");
  }
  return {
    candidates,
    diagnostics,
    appliedLimits: limits,
  };
}

export async function inspectCandidate(
  context: DiscoveryContext,
  candidateId: string,
  expectedDiscoveryFingerprint: string,
  options: DiscoverOptions = {},
): Promise<DiscoveryCandidate> {
  const result = await discover(context, options);
  const candidate = result.candidates.find((entry) => entry.candidateId === candidateId);
  if (candidate === undefined)
    throw new DiscoveryError("adoption_source_unavailable", "candidate was not found");
  if (candidate.discoveryFingerprint !== expectedDiscoveryFingerprint) {
    throw new DiscoveryError("adoption_source_changed", "candidate changed after discovery");
  }
  return candidate;
}
