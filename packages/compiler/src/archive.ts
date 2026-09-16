// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { immutableTreeSha256 } from "./local-snapshot.ts";
import { AcquisitionError } from "./remote-errors.ts";

export interface ArchiveLimits {
  readonly maxEntries: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
  readonly maxPathBytes: number;
  readonly maxDepth: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  maxEntries: 50_000,
  maxFiles: 20_000,
  maxTotalBytes: 67_108_864,
  maxFileBytes: 8_388_608,
  maxPathBytes: 4_096,
  maxDepth: 32,
});

export interface ExtractedArchiveFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly executable: boolean;
}

export interface ExtractedArchive {
  readonly files: readonly ExtractedArchiveFile[];
  readonly fileCount: number;
  readonly sizeBytes: number;
  readonly treeSha256: string;
}

function parseOctal(field: Uint8Array, name: string): number {
  const text = Buffer.from(field).toString("ascii").replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new AcquisitionError("archive_invalid", `${name} is invalid`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value))
    throw new AcquisitionError("archive_invalid", `${name} is too large`);
  return value;
}

function tarString(field: Uint8Array): string {
  const end = field.indexOf(0);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      end < 0 ? field : field.subarray(0, end),
    );
  } catch {
    throw new AcquisitionError("archive_invalid", "archive path is not valid UTF-8");
  }
}

function safeRelativePath(
  input: string,
  stripPackagePrefix: boolean,
  limits: ArchiveLimits,
): string | undefined {
  if (
    input.includes("\\") ||
    input.includes("\0") ||
    input.startsWith("/") ||
    [...input].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new AcquisitionError("archive_path_invalid", "archive entry path is not relative");
  }
  const normalized = input.normalize("NFC");
  if (normalized.includes("//"))
    throw new AcquisitionError("archive_path_invalid", "archive entry path is not canonical");
  let parts = normalized.split("/").filter((part) => part !== "");
  if (stripPackagePrefix && parts[0] === "package") parts = parts.slice(1);
  if (parts.length === 0) return undefined;
  if (parts.length > limits.maxDepth || parts.some((part) => part === "." || part === "..")) {
    throw new AcquisitionError("archive_path_invalid", "archive entry escapes its destination");
  }
  const path = parts.join("/");
  if (Buffer.byteLength(path, "utf8") > limits.maxPathBytes) {
    throw new AcquisitionError("archive_limit_exceeded", "archive path exceeds its byte limit");
  }
  return path;
}

function checksum(block: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < block.length; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
  }
  return sum;
}

function within(path: string, root: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Extracts a tar or gzip-compressed tar without accepting links or special files. */
export async function extractBoundedTar(
  archive: Uint8Array,
  destination: string,
  options: { readonly limits?: ArchiveLimits; readonly stripPackagePrefix?: boolean } = {},
): Promise<ExtractedArchive> {
  const limits = options.limits ?? DEFAULT_ARCHIVE_LIMITS;
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new AcquisitionError("archive_limit_exceeded", `${name} must be a positive integer`);
  }
  const maximumTarBytes = limits.maxTotalBytes + limits.maxEntries * 1024;
  if (!Number.isSafeInteger(maximumTarBytes))
    throw new AcquisitionError("archive_limit_exceeded", "archive limits exceed safe arithmetic");
  let tar: Uint8Array;
  try {
    tar =
      archive[0] === 0x1f && archive[1] === 0x8b
        ? gunzipSync(archive, { maxOutputLength: maximumTarBytes })
        : archive;
  } catch {
    throw new AcquisitionError(
      "archive_invalid",
      "archive compression is invalid or exceeds limits",
    );
  }
  if (tar.byteLength > maximumTarBytes) {
    throw new AcquisitionError("archive_limit_exceeded", "archive expands beyond its byte limit");
  }

  await mkdir(destination, { recursive: false, mode: 0o700 });
  try {
    const canonicalDestination = await realpath(destination);
    const seen = new Set<string>();
    const files: ExtractedArchiveFile[] = [];
    let offset = 0;
    let entryCount = 0;
    let totalBytes = 0;
    let ended = false;

    while (offset + 512 <= tar.byteLength) {
      const header = tar.subarray(offset, offset + 512);
      offset += 512;
      if (header.every((byte) => byte === 0)) {
        if (!tar.subarray(offset).every((byte) => byte === 0))
          throw new AcquisitionError("archive_invalid", "archive has data after its end marker");
        ended = true;
        break;
      }
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        throw new AcquisitionError("archive_limit_exceeded", "archive entry count exceeded");
      }
      const expectedChecksum = parseOctal(header.subarray(148, 156), "tar checksum");
      if (checksum(header) !== expectedChecksum) {
        throw new AcquisitionError("archive_invalid", "archive header checksum mismatch");
      }
      const name = tarString(header.subarray(0, 100));
      const prefix = tarString(header.subarray(345, 500));
      const rawPath = prefix === "" ? name : `${prefix}/${name}`;
      const relativePath = safeRelativePath(rawPath, options.stripPackagePrefix === true, limits);
      const size = parseOctal(header.subarray(124, 136), "tar entry size");
      const mode = parseOctal(header.subarray(100, 108), "tar entry mode");
      const type = String.fromCharCode(header[156] ?? 0);
      const dataEnd = offset + size;
      if (dataEnd > tar.byteLength)
        throw new AcquisitionError("archive_invalid", "archive entry is truncated");
      const data = tar.subarray(offset, dataEnd);
      offset += Math.ceil(size / 512) * 512;
      if (offset > tar.byteLength)
        throw new AcquisitionError("archive_invalid", "archive entry padding is truncated");

      if (relativePath === undefined) continue;
      if (seen.has(relativePath))
        throw new AcquisitionError("archive_path_invalid", "archive has duplicate paths");
      seen.add(relativePath);
      if (type === "5") {
        if (size !== 0)
          throw new AcquisitionError("archive_invalid", "directory entry contains data");
        const directory = resolve(canonicalDestination, relativePath);
        if (!within(directory, canonicalDestination))
          throw new AcquisitionError("archive_path_invalid", "archive path escaped");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        continue;
      }
      if (type !== "0" && type !== "\0") {
        throw new AcquisitionError(
          "archive_entry_unsupported",
          `archive entry type ${type || "NUL"} is unsupported`,
        );
      }
      if (
        size > limits.maxFileBytes ||
        files.length >= limits.maxFiles ||
        totalBytes + size > limits.maxTotalBytes
      ) {
        throw new AcquisitionError("archive_limit_exceeded", "archive file or byte limit exceeded");
      }
      const target = resolve(canonicalDestination, relativePath);
      if (!within(target, canonicalDestination))
        throw new AcquisitionError("archive_path_invalid", "archive path escaped");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const executable = (mode & 0o111) !== 0;
      const handle = await open(
        target,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
        executable ? 0o700 : 0o600,
      );
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(target, executable ? 0o700 : 0o600);
      totalBytes += size;
      files.push({
        relativePath,
        sha256: createHash("sha256").update(data).digest("hex"),
        sizeBytes: size,
        executable,
      });
    }

    if (!ended) throw new AcquisitionError("archive_invalid", "archive omits its end marker");

    files.sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
    );
    const directories = new Set<string>([canonicalDestination]);
    for (const file of files) {
      let directory = dirname(resolve(canonicalDestination, file.relativePath));
      while (within(directory, canonicalDestination)) {
        directories.add(directory);
        if (directory === canonicalDestination) break;
        directory = dirname(directory);
      }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length))
      await syncDirectory(directory);
    return Object.freeze({
      files: Object.freeze(files),
      fileCount: files.length,
      sizeBytes: totalBytes,
      treeSha256: immutableTreeSha256(files),
    });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
