// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";

import type { BlobReadResult, BlobReference, SessionId } from "@axl/protocol";

const MAX_BLOB_BYTES = 20 * 1024 * 1024;
const MAX_CHUNK_BYTES = 384 * 1024;
const MAX_READ_BYTES = 384 * 1024;
const MAX_ACTIVE_UPLOADS = 16;

interface Upload {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly name?: string;
  offset: number;
}

export class BlobStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BlobStoreError";
    this.code = code;
  }
}

function cleanMediaType(value: string): string {
  const mediaType = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)) {
    throw new BlobStoreError("invalid_media_type", `Invalid media type ${JSON.stringify(value)}`);
  }
  return mediaType;
}

function cleanName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const name = [...basename(value)]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();
  if (!name) throw new BlobStoreError("invalid_blob_name", "Attachment name is empty");
  return name.slice(0, 255);
}

function decodeBase64(value: string): Buffer {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new BlobStoreError("invalid_blob_chunk", "Blob chunk is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_BYTES) {
    throw new BlobStoreError(
      "invalid_blob_chunk",
      `Blob chunks must contain between 1 and ${MAX_CHUNK_BYTES} bytes`,
    );
  }
  if (bytes.toString("base64") !== value) {
    throw new BlobStoreError("invalid_blob_chunk", "Blob chunk is not canonical base64");
  }
  return bytes;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function detectedImageType(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[12] === 0x49 &&
    bytes[13] === 0x48 &&
    bytes[14] === 0x44 &&
    bytes[15] === 0x52
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

/** Bounded content-addressed storage. JSONL records references, never blob bytes. */
export class BlobStore {
  private readonly directory: string;
  private readonly uploadDirectory: string;
  private readonly uploads = new Map<string, Upload>();
  private readonly uploadOperations = new Map<string, Promise<unknown>>();
  private uploadInitialization: Promise<void> | undefined;
  private startingUploads = 0;
  private readonly owned = new Map<SessionId, Map<string, BlobReference>>();

  constructor(dataDirectory: string) {
    this.directory = resolve(dataDirectory, "blobs");
    this.uploadDirectory = join(this.directory, "uploads");
  }

  authorize(sessionId: SessionId, references: readonly BlobReference[]): void {
    const owned = this.owned.get(sessionId) ?? new Map<string, BlobReference>();
    for (const reference of references) owned.set(reference.sha256, reference);
    this.owned.set(sessionId, owned);
  }

  async assertOwned(sessionId: SessionId, reference: BlobReference): Promise<void> {
    const owned = this.owned.get(sessionId)?.get(reference.sha256);
    if (
      owned === undefined ||
      owned.mediaType !== reference.mediaType ||
      owned.sizeBytes !== reference.sizeBytes
    ) {
      throw new BlobStoreError("blob_not_owned", "Attachment is not owned by this session");
    }
    const info = await stat(join(this.directory, reference.sha256)).catch((cause: unknown) => {
      throw new BlobStoreError("blob_missing", `Blob ${reference.sha256} is unavailable`, {
        cause,
      });
    });
    if (info.size !== reference.sizeBytes) {
      throw new BlobStoreError("blob_corrupt", `Blob ${reference.sha256} has an invalid size`);
    }
  }

  async start(
    sessionId: SessionId,
    input: { readonly mediaType: string; readonly sizeBytes: number; readonly name?: string },
  ): Promise<{ uploadId: string; chunkBytes: number }> {
    await this.initializeUploads();
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes <= 0 ||
      input.sizeBytes > MAX_BLOB_BYTES
    ) {
      throw new BlobStoreError(
        "blob_too_large",
        `Attachments must contain between 1 and ${MAX_BLOB_BYTES} bytes`,
      );
    }
    const mediaType = cleanMediaType(input.mediaType);
    const name = cleanName(input.name);
    if (this.uploads.size + this.startingUploads >= MAX_ACTIVE_UPLOADS) {
      throw new BlobStoreError("too_many_uploads", "Too many attachment uploads are active");
    }
    this.startingUploads += 1;
    const uploadId = randomUUID();
    const path = join(this.uploadDirectory, uploadId);
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      this.uploads.set(uploadId, {
        id: uploadId,
        sessionId,
        path,
        mediaType,
        sizeBytes: input.sizeBytes,
        ...(name === undefined ? {} : { name }),
        offset: 0,
      });
      return { uploadId, chunkBytes: MAX_CHUNK_BYTES };
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    } finally {
      this.startingUploads -= 1;
    }
  }

  append(
    sessionId: SessionId,
    uploadId: string,
    offset: number,
    data: string,
  ): Promise<{ nextOffset: number }> {
    return this.serialized(uploadId, async () => {
      const upload = this.upload(uploadId, sessionId);
      if (offset !== upload.offset) {
        throw new BlobStoreError(
          "blob_offset_mismatch",
          `Expected blob offset ${upload.offset}, received ${offset}`,
        );
      }
      const bytes = decodeBase64(data);
      if (upload.offset + bytes.byteLength > upload.sizeBytes) {
        throw new BlobStoreError("blob_size_mismatch", "Blob data exceeds its declared size");
      }
      const handle = await open(upload.path, "r+");
      try {
        const result = await handle.write(bytes, 0, bytes.byteLength, upload.offset);
        if (result.bytesWritten !== bytes.byteLength) {
          throw new BlobStoreError("blob_write_failed", "Blob chunk was not written completely");
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      upload.offset += bytes.byteLength;
      return { nextOffset: upload.offset };
    });
  }

  commit(sessionId: SessionId, uploadId: string): Promise<BlobReference> {
    return this.serialized(uploadId, async () => {
      const upload = this.upload(uploadId, sessionId);
      this.uploads.delete(uploadId);
      try {
        if (upload.offset !== upload.sizeBytes) {
          throw new BlobStoreError(
            "blob_size_mismatch",
            `Blob upload contains ${upload.offset} of ${upload.sizeBytes} declared bytes`,
          );
        }
        const bytes = await readFile(upload.path);
        if (upload.mediaType.startsWith("image/")) {
          const detected = detectedImageType(bytes);
          if (detected === undefined || detected !== upload.mediaType) {
            throw new BlobStoreError(
              "invalid_image",
              `Attachment bytes do not match declared media type ${upload.mediaType}`,
            );
          }
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const destination = join(this.directory, sha256);
        try {
          await rename(upload.path, destination);
          await chmod(destination, 0o600);
          await syncDirectory(this.directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await rm(upload.path, { force: true });
        }
        const stored = await readFile(destination);
        if (
          stored.byteLength !== upload.sizeBytes ||
          createHash("sha256").update(stored).digest("hex") !== sha256
        ) {
          throw new BlobStoreError("blob_corrupt", `Blob ${sha256} failed durable verification`);
        }
        const reference: BlobReference = {
          sha256,
          mediaType: upload.mediaType,
          sizeBytes: upload.sizeBytes,
          ...(upload.name === undefined ? {} : { name: upload.name }),
        };
        this.authorize(sessionId, [reference]);
        return reference;
      } catch (error) {
        await rm(upload.path, { force: true });
        throw error;
      }
    });
  }

  async storeText(sessionId: SessionId, text: string): Promise<BlobReference> {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BLOB_BYTES) {
      throw new BlobStoreError(
        "blob_too_large",
        `Text attachments must contain between 1 and ${MAX_BLOB_BYTES} bytes`,
      );
    }
    const upload = await this.start(sessionId, {
      mediaType: "text/plain",
      sizeBytes: bytes.byteLength,
    });
    try {
      for (let offset = 0; offset < bytes.byteLength; offset += MAX_CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, Math.min(offset + MAX_CHUNK_BYTES, bytes.byteLength));
        await this.append(sessionId, upload.uploadId, offset, chunk.toString("base64"));
      }
      return await this.commit(sessionId, upload.uploadId);
    } catch (error) {
      await this.abort(sessionId, upload.uploadId);
      throw error;
    }
  }

  abort(sessionId: SessionId, uploadId: string): Promise<{ aborted: boolean }> {
    return this.serialized(uploadId, async () => {
      const upload = this.uploads.get(uploadId);
      if (upload === undefined) return { aborted: false };
      if (upload.sessionId !== sessionId) {
        throw new BlobStoreError("unknown_blob_upload", `Blob upload ${uploadId} is not active`);
      }
      await rm(upload.path, { force: true });
      this.uploads.delete(uploadId);
      return { aborted: true };
    });
  }

  async readAll(sessionId: SessionId, reference: BlobReference): Promise<Uint8Array> {
    await this.assertOwned(sessionId, reference);
    const bytes = await readFile(join(this.directory, reference.sha256));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== reference.sha256) {
      throw new BlobStoreError(
        "blob_corrupt",
        `Blob ${reference.sha256} failed digest verification`,
      );
    }
    return bytes;
  }

  async read(
    sessionId: SessionId,
    digest: string,
    offset: number,
    length: number,
  ): Promise<BlobReadResult> {
    if (!this.owned.get(sessionId)?.has(digest)) {
      throw new BlobStoreError("blob_not_owned", "Blob is not referenced by this session");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new BlobStoreError("invalid_blob_range", "Blob offset must be non-negative");
    }
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_READ_BYTES) {
      throw new BlobStoreError(
        "invalid_blob_range",
        `Blob reads must request between 1 and ${MAX_READ_BYTES} bytes`,
      );
    }
    const path = join(this.directory, digest);
    const info = await stat(path).catch((cause: unknown) => {
      throw new BlobStoreError("blob_missing", `Blob ${digest} is unavailable`, { cause });
    });
    if (offset > info.size) {
      throw new BlobStoreError("invalid_blob_range", "Blob offset exceeds its size");
    }
    const size = Math.min(length, info.size - offset);
    const bytes = Buffer.alloc(size);
    if (size > 0) {
      const handle = await open(path, "r");
      try {
        const result = await handle.read(bytes, 0, size, offset);
        if (result.bytesRead !== size) {
          throw new BlobStoreError("blob_read_failed", "Blob range was not read completely");
        }
      } finally {
        await handle.close();
      }
    }
    return {
      data: bytes.toString("base64"),
      offset,
      nextOffset: offset + size,
      eof: offset + size >= info.size,
    };
  }

  async disposeSession(sessionId: SessionId): Promise<void> {
    this.owned.delete(sessionId);
    const stale = [...this.uploads.values()].filter((upload) => upload.sessionId === sessionId);
    for (const upload of stale) {
      this.uploads.delete(upload.id);
      await rm(upload.path, { force: true });
    }
  }

  private initializeUploads(): Promise<void> {
    this.uploadInitialization ??= rm(this.uploadDirectory, { recursive: true, force: true }).then(
      async () => {
        await mkdir(this.uploadDirectory, { recursive: true, mode: 0o700 });
      },
    );
    return this.uploadInitialization;
  }

  private async serialized<Result>(
    uploadId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.uploadOperations.get(uploadId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.uploadOperations.set(uploadId, current);
    try {
      return await current;
    } finally {
      if (this.uploadOperations.get(uploadId) === current) this.uploadOperations.delete(uploadId);
    }
  }

  private upload(uploadId: string, sessionId: SessionId): Upload {
    const upload = this.uploads.get(uploadId);
    if (upload === undefined || upload.sessionId !== sessionId) {
      throw new BlobStoreError("unknown_blob_upload", `Blob upload ${uploadId} is not active`);
    }
    return upload;
  }
}
