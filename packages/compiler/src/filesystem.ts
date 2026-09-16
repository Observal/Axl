// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { DiscoveryError } from "./errors.ts";
import { DEFAULT_INSPECTION_LIMITS, type InspectionLimits } from "./limits.ts";
import type { DiscoveryDiagnostic } from "./types.ts";

export interface FileStat {
  readonly kind: "file" | "directory" | "symlink" | "socket" | "fifo" | "device" | "other";
  readonly size: number;
  readonly nlink: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly dev: number;
}

export interface DirectoryEntry {
  readonly name: string;
}

export interface BoundedFileSystem {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<readonly DirectoryEntry[]>;
  readStableFile(path: string, maximumBytes: number, canonicalRoot?: string): Promise<Uint8Array>;
}

function toFileStat(value: Stats): FileStat {
  let kind: FileStat["kind"] = "other";
  if (value.isFile()) kind = "file";
  else if (value.isDirectory()) kind = "directory";
  else if (value.isSymbolicLink()) kind = "symlink";
  else if (value.isSocket()) kind = "socket";
  else if (value.isFIFO()) kind = "fifo";
  else if (value.isBlockDevice() || value.isCharacterDevice()) kind = "device";
  return {
    kind,
    size: value.size,
    nlink: value.nlink,
    mode: value.mode,
    mtimeMs: value.mtimeMs,
    ino: value.ino,
    dev: value.dev,
  };
}

function sameFile(left: FileStat, right: FileStat): boolean {
  return (
    left.kind === right.kind &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ino === right.ino &&
    left.dev === right.dev
  );
}

export const nodeFileSystem: BoundedFileSystem = {
  realpath,
  async lstat(path) {
    return toFileStat(await lstat(path));
  },
  async readdir(path) {
    return (await readdir(path, { withFileTypes: true })).map((entry: Dirent) => ({
      name: entry.name,
    }));
  },
  async readStableFile(path, maximumBytes, canonicalRoot) {
    const resolvedBefore = await realpath(path);
    if (
      canonicalRoot !== undefined &&
      (!within(resolvedBefore, canonicalRoot) || resolvedBefore !== resolve(path))
    ) {
      throw new DiscoveryError(
        "adoption_source_unavailable",
        "file resolves outside its canonical location",
      );
    }
    const before = toFileStat(await lstat(path));
    if (before.kind !== "file") throw new DiscoveryError("adoption_source_changed", "not a file");
    if (before.nlink > 1)
      throw new DiscoveryError("adoption_source_unavailable", "hard-linked file");
    if (before.size > maximumBytes) {
      throw new DiscoveryError("adoption_scan_limit_exceeded", "file exceeds byte limit");
    }
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const opened = toFileStat(await handle.stat());
      if (!sameFile(before, opened)) {
        throw new DiscoveryError("adoption_source_changed", "file changed while opening");
      }
      const bytes = await handle.readFile();
      const after = toFileStat(await handle.stat());
      const resolvedAfter = await realpath(path);
      if (
        !sameFile(opened, after) ||
        bytes.byteLength !== after.size ||
        resolvedAfter !== resolvedBefore
      ) {
        throw new DiscoveryError("adoption_source_changed", "file changed while reading");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  },
};

export interface SnapshotFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly bytes: Uint8Array;
  readonly stat: FileStat;
}

export interface TreeSnapshot {
  readonly canonicalRoot: string;
  readonly files: readonly SnapshotFile[];
  readonly diagnostics: readonly DiscoveryDiagnostic[];
  readonly entryCount: number;
  readonly totalBytes: number;
}

function within(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function mergeLimits(overrides: Partial<InspectionLimits> | undefined): InspectionLimits {
  const merged = { ...DEFAULT_INSPECTION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  return Object.freeze(merged);
}

export interface SnapshotOptions {
  readonly exclude?: (relativePath: string, stat: FileStat) => boolean;
}

export async function snapshotTree(
  root: string,
  fileSystem: BoundedFileSystem,
  limits: InspectionLimits,
  options: SnapshotOptions = {},
): Promise<TreeSnapshot> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await fileSystem.realpath(resolve(root));
  } catch (error) {
    throw new DiscoveryError(
      "adoption_source_unavailable",
      `cannot canonicalize discovery root: ${String(error)}`,
    );
  }
  if (utf8Bytes(canonicalRoot) > limits.maxPathBytes) {
    throw new DiscoveryError("adoption_scan_limit_exceeded", "canonical root exceeds path limit");
  }

  const rootStat = await fileSystem.lstat(canonicalRoot);
  if (rootStat.kind !== "directory") {
    throw new DiscoveryError("adoption_source_unavailable", "discovery root is not a directory");
  }

  const files: SnapshotFile[] = [];
  const diagnostics: DiscoveryDiagnostic[] = [];
  let entryCount = 0;
  let totalBytes = 0;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) {
      throw new DiscoveryError("adoption_scan_limit_exceeded", "traversal depth exceeded");
    }
    const directoryBefore = await fileSystem.lstat(directory);
    if (
      directoryBefore.kind !== "directory" ||
      (await fileSystem.realpath(directory)) !== directory
    ) {
      throw new DiscoveryError("adoption_source_changed", "directory changed before traversal");
    }
    const entries = [...(await fileSystem.readdir(directory))].sort((a, b) => {
      const left = a.name.normalize("NFC");
      const right = b.name.normalize("NFC");
      return left < right ? -1 : left > right ? 1 : 0;
    });
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        throw new DiscoveryError("adoption_scan_limit_exceeded", "entry count exceeded");
      }
      if (
        entry.name === "" ||
        entry.name === "." ||
        entry.name === ".." ||
        entry.name.includes("/") ||
        entry.name.includes("\\")
      ) {
        throw new DiscoveryError("adoption_source_unavailable", "invalid directory entry name");
      }
      if (utf8Bytes(entry.name) > limits.maxNameBytes) {
        throw new DiscoveryError("adoption_scan_limit_exceeded", "filename exceeds limit");
      }
      const absolutePath = resolve(directory, entry.name);
      if (!within(absolutePath, canonicalRoot) || utf8Bytes(absolutePath) > limits.maxPathBytes) {
        throw new DiscoveryError("adoption_scan_limit_exceeded", "path exceeds discovery boundary");
      }
      const relativePath = relative(canonicalRoot, absolutePath).split(sep).join("/");
      const stat = await fileSystem.lstat(absolutePath);
      if (options.exclude?.(relativePath, stat) === true) continue;
      if (stat.kind === "symlink") {
        let escaped = true;
        try {
          escaped = !within(await fileSystem.realpath(absolutePath), canonicalRoot);
        } catch {
          escaped = true;
        }
        diagnostics.push({
          code: escaped ? "symlink-escape" : "symlink-unsupported",
          severity: "error",
          message: escaped
            ? "symlink resolves outside the discovery root"
            : "symlinks are not followed",
          relativePath,
        });
        continue;
      }
      if (stat.kind === "directory") {
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (stat.kind !== "file") {
        diagnostics.push({
          code: "special-file-unsupported",
          severity: "error",
          message: `${stat.kind} entries are not read`,
          relativePath,
        });
        continue;
      }
      if (stat.nlink > 1) {
        diagnostics.push({
          code: "hard-link-unsupported",
          severity: "error",
          message: "hard-linked files are not read",
          relativePath,
        });
        continue;
      }
      if (stat.size > limits.maxFileBytes) {
        throw new DiscoveryError(
          "adoption_scan_limit_exceeded",
          "per-file byte limit exceeded",
          relativePath,
        );
      }
      if (files.length >= limits.maxFiles || totalBytes + stat.size > limits.maxTotalBytes) {
        throw new DiscoveryError(
          "adoption_scan_limit_exceeded",
          "scan file or byte limit exceeded",
          relativePath,
        );
      }
      const bytes = await fileSystem.readStableFile(
        absolutePath,
        limits.maxFileBytes,
        canonicalRoot,
      );
      const finalStat = await fileSystem.lstat(absolutePath);
      if (!sameFile(stat, finalStat) || bytes.byteLength !== finalStat.size) {
        throw new DiscoveryError(
          "adoption_source_changed",
          "source changed during snapshot",
          relativePath,
        );
      }
      totalBytes += bytes.byteLength;
      files.push({ relativePath, absolutePath, bytes, stat: finalStat });
    }
    const directoryAfter = await fileSystem.lstat(directory);
    if (!sameFile(directoryBefore, directoryAfter)) {
      throw new DiscoveryError(
        "adoption_source_changed",
        "directory changed during snapshot",
        relative(canonicalRoot, directory).split(sep).join("/"),
      );
    }
  };

  await visit(canonicalRoot, 0);
  return { canonicalRoot, files, diagnostics, entryCount, totalBytes };
}

export function decodeUtf8(file: SnapshotFile): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    throw new DiscoveryError(
      "adoption_manifest_invalid",
      "file is not valid UTF-8",
      file.relativePath,
    );
  }
}

export function findFile(snapshot: TreeSnapshot, relativePath: string): SnapshotFile | undefined {
  return snapshot.files.find((file) => file.relativePath === relativePath);
}

export function pathDisplayName(relativePath: string): string {
  const name = basename(relativePath);
  const extension = name.lastIndexOf(".");
  return extension > 0 ? name.slice(0, extension) : name;
}
