// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DiscoveryError } from "./errors.ts";
import {
  type BoundedFileSystem,
  type FileStat,
  nodeFileSystem,
  snapshotTree,
  type TreeSnapshot,
} from "./filesystem.ts";
import { sha256 } from "./identity.ts";
import { DEFAULT_INSPECTION_LIMITS, type InspectionLimits } from "./limits.ts";
import type { ImmutableSourceLock } from "./source-locator.ts";
import { isUnsupportedNativeSourcePath, sensitiveSourceReason } from "./source-security.ts";

export interface ImmutableFileInventoryEntry {
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly executable: boolean;
}

export interface PublishedLocalSnapshot {
  readonly sourceDirectory: string;
  readonly lock: Extract<ImmutableSourceLock, { readonly kind: "local-snapshot" }>;
  readonly inventory: readonly ImmutableFileInventoryEntry[];
  readonly alreadyPresent: boolean;
}

function sameSourceStat(left: FileStat, right: FileStat): boolean {
  return (
    left.kind === right.kind &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ino === right.ino &&
    left.dev === right.dev
  );
}

/** Takes a bounded stable snapshot of either one regular file or a directory tree. */
export async function snapshotSourcePath(
  root: string,
  fileSystem: BoundedFileSystem,
  limits: InspectionLimits,
): Promise<TreeSnapshot> {
  const canonical = await fileSystem.realpath(resolve(root));
  const rootStat = await fileSystem.lstat(canonical);
  if (rootStat.kind === "directory") return snapshotTree(canonical, fileSystem, limits);
  if (rootStat.kind !== "file" || rootStat.nlink > 1) {
    throw new DiscoveryError(
      "adoption_source_unavailable",
      "local source must be a regular file or directory",
    );
  }
  const name = basename(canonical).normalize("NFC");
  if (
    Buffer.byteLength(canonical, "utf8") > limits.maxPathBytes ||
    Buffer.byteLength(name, "utf8") > limits.maxNameBytes ||
    rootStat.size > limits.maxFileBytes ||
    rootStat.size > limits.maxTotalBytes ||
    limits.maxFiles < 1 ||
    limits.maxEntries < 1
  ) {
    throw new DiscoveryError("adoption_scan_limit_exceeded", "local source file exceeds limits");
  }
  const bytes = await fileSystem.readStableFile(canonical, limits.maxFileBytes, canonical);
  const finalStat = await fileSystem.lstat(canonical);
  if (!sameSourceStat(rootStat, finalStat) || bytes.byteLength !== finalStat.size) {
    throw new DiscoveryError(
      "adoption_source_changed",
      "local source file changed during snapshot",
    );
  }
  return {
    canonicalRoot: canonical,
    files: [{ relativePath: name, absolutePath: canonical, bytes, stat: finalStat }],
    diagnostics: [],
    entryCount: 1,
    totalBytes: bytes.byteLength,
  };
}

function assertSnapshotContainsNoSensitiveFiles(snapshot: TreeSnapshot): void {
  for (const file of snapshot.files) {
    if (
      sensitiveSourceReason(file.relativePath, file.bytes) !== undefined ||
      isUnsupportedNativeSourcePath(file.relativePath)
    ) {
      throw new DiscoveryError(
        "adoption_source_unavailable",
        "local source contains a blocked, secret-bearing, or native-add-on file",
        file.relativePath,
      );
    }
  }
}

function canonicalInventory(snapshot: TreeSnapshot): readonly ImmutableFileInventoryEntry[] {
  return Object.freeze(
    snapshot.files.map((file) =>
      Object.freeze({
        relativePath: file.relativePath.normalize("NFC"),
        sha256: sha256(file.bytes),
        sizeBytes: file.bytes.byteLength,
        executable: (file.stat.mode & 0o111) !== 0,
      }),
    ),
  );
}

export function immutableTreeSha256(inventory: readonly ImmutableFileInventoryEntry[]): string {
  const hash = createHash("sha256");
  hash.update("axl-local-source-tree-v1\0");
  for (const file of inventory) {
    const path = Buffer.from(file.relativePath.normalize("NFC"), "utf8");
    const descriptor = Buffer.from(
      JSON.stringify({
        executable: file.executable,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      }),
      "utf8",
    );
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(path.byteLength);
    const descriptorLength = Buffer.alloc(4);
    descriptorLength.writeUInt32BE(descriptor.byteLength);
    hash.update(pathLength).update(path).update(descriptorLength).update(descriptor);
  }
  return hash.digest("hex");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function collectDirectories(root: string): Promise<string[]> {
  const directories: string[] = [root];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index];
    if (directory === undefined) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(directory, entry.name));
    }
  }
  return directories;
}

async function syncTreeDirectories(root: string): Promise<void> {
  for (const directory of (await collectDirectories(root)).reverse())
    await syncDirectory(directory);
}

async function makeTreeReadOnly(root: string): Promise<void> {
  for (const directory of (await collectDirectories(root)).reverse()) await chmod(directory, 0o500);
}

async function removeStagingTree(root: string): Promise<void> {
  try {
    const directories = await collectDirectories(root);
    for (const directory of directories) await chmod(directory, 0o700);
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function within(path: string, root: string): boolean {
  const value = relative(root, path);
  return (
    value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.startsWith("/"))
  );
}

async function verifyPublishedTree(
  directory: string,
  expectedTree: string,
  limits: InspectionLimits,
): Promise<readonly ImmutableFileInventoryEntry[]> {
  const snapshot = await snapshotTree(directory, nodeFileSystem, limits);
  if (snapshot.diagnostics.length > 0)
    throw new DiscoveryError(
      "adoption_source_unavailable",
      "published source contains unsupported entries",
    );
  for (const file of snapshot.files) {
    const expectedMode = (file.stat.mode & 0o111) !== 0 ? 0o500 : 0o400;
    if ((file.stat.mode & 0o777) !== expectedMode) {
      throw new DiscoveryError(
        "adoption_source_changed",
        "published immutable source has mutable file permissions",
        file.relativePath,
      );
    }
  }
  for (const path of await collectDirectories(directory)) {
    const directoryStat = await nodeFileSystem.lstat(path);
    if ((directoryStat.mode & 0o777) !== 0o500)
      throw new DiscoveryError(
        "adoption_source_changed",
        "published immutable source has mutable directory permissions",
      );
  }
  const inventory = canonicalInventory(snapshot);
  if (immutableTreeSha256(inventory) !== expectedTree) {
    throw new DiscoveryError(
      "adoption_source_changed",
      "published immutable source failed tree verification",
    );
  }
  return inventory;
}

export interface PublishLocalSnapshotOptions {
  readonly storeRoot: string;
  readonly sourceRoot: string;
  readonly fileSystem?: BoundedFileSystem;
  readonly limits?: InspectionLimits;
}

/** Publishes a content-addressed source tree. The mutable source is never modified. */
export async function publishLocalSnapshot(
  options: PublishLocalSnapshotOptions,
): Promise<PublishedLocalSnapshot> {
  const limits = options.limits ?? DEFAULT_INSPECTION_LIMITS;
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const storeRoot = resolve(options.storeRoot);
  await mkdir(storeRoot, { recursive: true, mode: 0o700 });
  const canonicalStore = await nodeFileSystem.realpath(storeRoot);
  const sourcesRoot = join(canonicalStore, "sources");
  await mkdir(sourcesRoot, { recursive: true, mode: 0o700 });
  await chmod(sourcesRoot, 0o700);

  const source = await snapshotSourcePath(options.sourceRoot, fileSystem, limits);
  if (source.diagnostics.length > 0) {
    throw new DiscoveryError(
      "adoption_source_unavailable",
      "source contains links or unsupported special entries",
    );
  }
  if (
    within(canonicalStore, source.canonicalRoot) ||
    within(source.canonicalRoot, canonicalStore)
  ) {
    throw new DiscoveryError(
      "adoption_source_unavailable",
      "source and adoption store must be separate trees",
    );
  }
  assertSnapshotContainsNoSensitiveFiles(source);
  const inventory = canonicalInventory(source);
  const treeSha256 = immutableTreeSha256(inventory);
  const destination = join(sourcesRoot, treeSha256);
  const staging = join(sourcesRoot, `.source-staging-${randomBytes(16).toString("hex")}`);
  await mkdir(staging, { mode: 0o700 });

  try {
    for (let index = 0; index < source.files.length; index += 1) {
      const file = source.files[index];
      const item = inventory[index];
      if (file === undefined || item === undefined) throw new Error("snapshot inventory mismatch");
      const current = await fileSystem.lstat(file.absolutePath);
      if (!sameSourceStat(file.stat, current))
        throw new DiscoveryError(
          "adoption_source_changed",
          "source changed before copy",
          file.relativePath,
        );
      const target = join(staging, ...file.relativePath.split("/"));
      if (!within(target, staging))
        throw new DiscoveryError(
          "adoption_source_unavailable",
          "snapshot path escapes staging",
          file.relativePath,
        );
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(
        target,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        item.executable ? 0o500 : 0o400,
      );
      try {
        const copiedSha256 = createHash("sha256").update(file.bytes).digest("hex");
        if (copiedSha256 !== item.sha256) {
          throw new DiscoveryError(
            "adoption_source_changed",
            "source bytes changed while hashing the copy",
            file.relativePath,
          );
        }
        await handle.writeFile(file.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(target, item.executable ? 0o500 : 0o400);
      const after = await fileSystem.lstat(file.absolutePath);
      if (!sameSourceStat(file.stat, after))
        throw new DiscoveryError(
          "adoption_source_changed",
          "source changed while copying",
          file.relativePath,
        );
    }
    const sourceAfterCopy = await snapshotSourcePath(options.sourceRoot, fileSystem, limits);
    if (
      sourceAfterCopy.diagnostics.length > 0 ||
      immutableTreeSha256(canonicalInventory(sourceAfterCopy)) !== treeSha256
    ) {
      throw new DiscoveryError(
        "adoption_source_changed",
        "source changed before snapshot publication",
      );
    }
    await makeTreeReadOnly(staging);
    await syncTreeDirectories(staging);
    await verifyPublishedTree(staging, treeSha256, limits);
    await syncDirectory(sourcesRoot);
    try {
      await rename(staging, destination);
      await syncDirectory(sourcesRoot);
      await verifyPublishedTree(destination, treeSha256, limits);
      return {
        sourceDirectory: destination,
        lock: {
          kind: "local-snapshot",
          treeSha256,
          fileCount: inventory.length,
          sizeBytes: source.totalBytes,
        },
        inventory,
        alreadyPresent: false,
      };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" &&
        (error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
      )
        throw error;
      const existing = await verifyPublishedTree(destination, treeSha256, limits);
      return {
        sourceDirectory: destination,
        lock: {
          kind: "local-snapshot",
          treeSha256,
          fileCount: existing.length,
          sizeBytes: existing.reduce((sum, file) => sum + file.sizeBytes, 0),
        },
        inventory: existing,
        alreadyPresent: true,
      };
    }
  } finally {
    await removeStagingTree(staging);
    await syncDirectory(canonicalStore);
  }
}

export async function verifyImmutableLocalSnapshot(
  published: PublishedLocalSnapshot,
  limits: InspectionLimits = DEFAULT_INSPECTION_LIMITS,
): Promise<void> {
  const information = await stat(published.sourceDirectory);
  if (!information.isDirectory())
    throw new DiscoveryError(
      "adoption_source_unavailable",
      "immutable source directory is missing",
    );
  const inventory = await verifyPublishedTree(
    published.sourceDirectory,
    published.lock.treeSha256,
    limits,
  );
  if (
    inventory.length !== published.lock.fileCount ||
    inventory.reduce((sum, file) => sum + file.sizeBytes, 0) !== published.lock.sizeBytes
  ) {
    throw new DiscoveryError(
      "adoption_source_changed",
      "immutable source lock metadata does not match tree",
    );
  }
}
