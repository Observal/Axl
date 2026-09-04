// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface LocalAttachment {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly name: string;
}

export function detectImageMediaType(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const prefix = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "image/gif";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

async function attachment(bytes: Uint8Array, name: string): Promise<LocalAttachment> {
  if (bytes.byteLength === 0) throw new Error("Attachment is empty");
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit`);
  }
  const mediaType = detectImageMediaType(bytes);
  if (mediaType === undefined) {
    throw new Error("Only PNG, JPEG, GIF, and WebP images are supported");
  }
  return { bytes, mediaType, name: basename(name) };
}

export async function readImageFile(path: string): Promise<LocalAttachment> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Attachment is not a regular file: ${path}`);
  if (info.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit`);
  }
  return attachment(await readFile(path), basename(path));
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Reads images only when the whole paste consists of existing image files. */
export async function droppedImages(
  value: string,
  cwd: string,
): Promise<readonly LocalAttachment[]> {
  const candidates = value
    .trim()
    .split(/\r?\n/)
    .map((part) => unquote(part.trim()))
    .filter(Boolean)
    .map((part) => {
      try {
        return part.startsWith("file://") ? fileURLToPath(part) : resolve(cwd, part);
      } catch {
        return "";
      }
    });
  if (candidates.length === 0 || candidates.some((path) => !path)) return [];
  try {
    return await Promise.all(candidates.map(readImageFile));
  } catch {
    return [];
  }
}
