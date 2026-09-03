// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { AxlClient } from "@axl/sdk";
import {
  type BlobReference,
  parseBlobReadResult,
  parseBlobReference,
  type SessionId,
} from "@axl/protocol";

import type { Component } from "./render.ts";
import { sanitizeTerminalText, truncateToWidth } from "./render.ts";
import type { Palette } from "./transcript.ts";

export type ImageProtocol = "kitty" | "iterm2" | null;
export type ImageDisplay = "auto" | "inline" | "metadata";

export interface TerminalMediaCapabilities {
  readonly images: ImageProtocol;
}

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

const MAX_RENDER_BYTES = 2 * 1024 * 1024;
const READ_CHUNK_BYTES = 384 * 1024;
const UPLOAD_CHUNK_BYTES = 384 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

export function detectTerminalMedia(
  env: NodeJS.ProcessEnv = process.env,
): TerminalMediaCapabilities {
  const override = env.AXL_IMAGE_PROTOCOL?.toLowerCase();
  if (override === "none" || override === "0") return { images: null };
  if (override === "kitty" || override === "iterm2") return { images: override };
  if (env.TMUX || env.TERM?.toLowerCase().startsWith("screen")) return { images: null };
  const program = env.TERM_PROGRAM?.toLowerCase();
  if (
    env.KITTY_WINDOW_ID ||
    env.WEZTERM_PANE ||
    env.GHOSTTY_RESOURCES_DIR ||
    program === "kitty" ||
    program === "wezterm" ||
    program === "ghostty"
  ) {
    return { images: "kitty" };
  }
  if (env.ITERM_SESSION_ID || program === "iterm.app") return { images: "iterm2" };
  return { images: null };
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function uint16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
    offset,
    littleEndian,
  );
}

function uint32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    littleEndian,
  );
}

export function imageDimensions(bytes: Uint8Array, mediaType: string): ImageDimensions | undefined {
  try {
    if (mediaType === "image/png" && bytes.length >= 24 && ascii(bytes, 1, 4) === "PNG") {
      return { width: uint32(bytes, 16, false), height: uint32(bytes, 20, false) };
    }
    if (
      mediaType === "image/gif" &&
      bytes.length >= 10 &&
      (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")
    ) {
      return { width: uint16(bytes, 6, true), height: uint16(bytes, 8, true) };
    }
    if (mediaType === "image/jpeg" && bytes.length >= 4) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1] ?? 0;
        if (marker >= 0xc0 && marker <= 0xc3) {
          return {
            width: uint16(bytes, offset + 7, false),
            height: uint16(bytes, offset + 5, false),
          };
        }
        const length = uint16(bytes, offset + 2, false);
        if (length < 2) return undefined;
        offset += length + 2;
      }
    }
    if (
      mediaType === "image/webp" &&
      bytes.length >= 30 &&
      ascii(bytes, 0, 4) === "RIFF" &&
      ascii(bytes, 8, 12) === "WEBP"
    ) {
      const kind = ascii(bytes, 12, 16);
      if (kind === "VP8X") {
        return {
          width: 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16),
          height: 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16),
        };
      }
      if (kind === "VP8 ") {
        return {
          width: uint16(bytes, 26, true) & 0x3fff,
          height: uint16(bytes, 28, true) & 0x3fff,
        };
      }
      if (kind === "VP8L" && bytes.length >= 25) {
        const bits = uint32(bytes, 21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function cellSize(
  dimensions: ImageDimensions | undefined,
  width: number,
): { columns: number; rows: number } {
  const columns = Math.max(1, Math.min(60, width - 2));
  if (dimensions === undefined || dimensions.width <= 0 || dimensions.height <= 0) {
    return { columns, rows: Math.min(12, Math.max(1, Math.ceil(columns / 2))) };
  }
  const rows = Math.ceil((dimensions.height / dimensions.width) * columns * 0.5);
  return { columns, rows: Math.max(1, Math.min(12, rows)) };
}

function kittyImage(base64: string, columns: number, rows: number): string {
  const size = 4096;
  const chunks: string[] = [];
  for (let offset = 0; offset < base64.length; offset += size) {
    const first = offset === 0;
    const final = offset + size >= base64.length;
    const controls = first
      ? `a=T,f=100,q=2,C=1,c=${columns},r=${rows},m=${final ? 0 : 1}`
      : `m=${final ? 0 : 1}`;
    chunks.push(`\x1b_G${controls};${base64.slice(offset, offset + size)}\x1b\\`);
  }
  return chunks.join("");
}

function itermImage(
  base64: string,
  columns: number,
  name: string | undefined,
  sizeBytes: number,
): string {
  const encodedName = name ? `;name=${Buffer.from(name).toString("base64")}` : "";
  return `\x1b]1337;File=inline=1;width=${columns};height=auto;preserveAspectRatio=1;size=${sizeBytes}${encodedName}:${base64}\x07`;
}

function fallback(reference: BlobReference, dimensions?: ImageDimensions, suffix = ""): string {
  const label = sanitizeTerminalText(reference.name ?? "attachment");
  const size =
    reference.sizeBytes < 1024
      ? `${reference.sizeBytes} B`
      : `${(reference.sizeBytes / 1024).toFixed(reference.sizeBytes < 10240 ? 1 : 0)} KiB`;
  const shape = dimensions ? ` · ${dimensions.width}×${dimensions.height}` : "";
  return `[Image · ${label} · ${reference.mediaType}${shape} · ${size}${suffix}]`;
}

export function renderInlineImage(
  bytes: Uint8Array,
  reference: BlobReference,
  protocol: ImageProtocol,
  width: number,
): readonly string[] {
  const dimensions = imageDimensions(bytes, reference.mediaType);
  const { columns, rows } = cellSize(dimensions, width);
  if (bytes.byteLength > MAX_RENDER_BYTES)
    return [fallback(reference, dimensions, " · preview too large")];
  if (protocol === "kitty" && reference.mediaType !== "image/png") {
    return [fallback(reference, dimensions, " · inline preview requires PNG")];
  }
  if (protocol === null) return [fallback(reference, dimensions)];
  const base64 = Buffer.from(bytes).toString("base64");
  const sequence =
    protocol === "kitty"
      ? kittyImage(base64, columns, rows)
      : itermImage(base64, columns, reference.name, reference.sizeBytes);
  if (protocol === "kitty") return [sequence, ...Array.from({ length: rows - 1 }, () => "")];
  const blank = Array.from({ length: rows - 1 }, () => "");
  return [...blank, `${rows > 1 ? `\x1b[${rows - 1}A` : ""}${sequence}`];
}

export async function uploadBlob(
  client: AxlClient,
  sessionId: SessionId,
  bytes: Uint8Array,
  mediaType: string,
  name?: string,
): Promise<BlobReference> {
  const started = await client.request("session.blob.start", {
    sessionId,
    mediaType,
    sizeBytes: bytes.byteLength,
    ...(name === undefined ? {} : { name }),
  });
  const chunkBytes = Math.min(UPLOAD_CHUNK_BYTES, started.chunkBytes);
  if (!started.uploadId || !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error("Daemon returned an invalid blob upload contract");
  }
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes));
      const response = await client.request("session.blob.chunk", {
        sessionId,
        uploadId: started.uploadId,
        offset,
        data: Buffer.from(chunk).toString("base64"),
      });
      if (response.nextOffset !== offset + chunk.byteLength) {
        throw new Error("Daemon returned an invalid blob upload offset");
      }
    }
    const reference = parseBlobReference(
      await client.request("session.blob.commit", {
        sessionId,
        uploadId: started.uploadId,
      }),
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (
      reference.sha256 !== digest ||
      reference.sizeBytes !== bytes.byteLength ||
      reference.mediaType !== mediaType
    ) {
      throw new Error("Daemon returned a blob reference that does not match the upload");
    }
    return reference;
  } catch (error) {
    try {
      await client.request("session.blob.abort", { sessionId, uploadId: started.uploadId });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Blob upload and cleanup failed");
    }
    throw error;
  }
}

export class AttachmentBarComponent implements Component {
  private readonly palette: () => Palette;
  private attachments: readonly BlobReference[] = [];

  constructor(palette: () => Palette) {
    this.palette = palette;
  }

  update(attachments: readonly BlobReference[]): void {
    this.attachments = attachments;
  }

  render(width: number): string[] {
    if (this.attachments.length === 0) return [];
    const palette = this.palette();
    return this.attachments.map((reference, index) =>
      palette.dim(
        truncateToWidth(
          `  ${index === 0 ? "◇" : "·"} attached ${sanitizeTerminalText(reference.name ?? reference.mediaType)} · ${(reference.sizeBytes / 1024).toFixed(reference.sizeBytes < 10240 ? 1 : 0)} KiB`,
          width,
          "…",
        ),
      ),
    );
  }
}

export class MediaCache {
  private readonly client: () => AxlClient;
  private sessionId: SessionId;
  private readonly capabilities: TerminalMediaCapabilities;
  private readonly display: () => ImageDisplay;
  private readonly loaded: () => void;
  private readonly values = new Map<string, Uint8Array>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, string>();
  private readonly evicted = new Set<string>();
  private totalBytes = 0;
  private generation = 0;

  constructor(
    client: () => AxlClient,
    sessionId: SessionId,
    capabilities: TerminalMediaCapabilities,
    display: () => ImageDisplay,
    loaded: () => void,
  ) {
    this.client = client;
    this.sessionId = sessionId;
    this.capabilities = capabilities;
    this.display = display;
    this.loaded = loaded;
  }

  setSession(sessionId: SessionId): void {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.generation += 1;
    this.values.clear();
    this.pending.clear();
    this.errors.clear();
    this.evicted.clear();
    this.totalBytes = 0;
  }

  rows(
    reference: BlobReference,
    width: number,
    fullscreen: boolean,
    palette: Palette,
  ): readonly string[] {
    const bytes = this.values.get(reference.sha256);
    if (bytes === undefined) {
      const error = this.errors.get(reference.sha256);
      const evicted = this.evicted.has(reference.sha256);
      if (error === undefined && !evicted) void this.ensure(reference);
      const suffix = evicted
        ? " · preview evicted"
        : error === undefined
          ? " · loading"
          : ` · unavailable: ${error}`;
      return [palette.dim(truncateToWidth(fallback(reference, undefined, suffix), width, "…"))];
    }
    const inline =
      !fullscreen &&
      this.display() !== "metadata" &&
      (this.display() === "inline" || this.capabilities.images !== null);
    const rows = inline
      ? renderInlineImage(bytes, reference, this.capabilities.images, width)
      : [fallback(reference, imageDimensions(bytes, reference.mediaType))];
    return rows.map((row) => truncateToWidth(row, width, ""));
  }

  put(reference: BlobReference, bytes: Uint8Array): void {
    this.store(reference, bytes);
    this.errors.delete(reference.sha256);
    this.evicted.delete(reference.sha256);
  }

  retryFailures(): void {
    this.errors.clear();
  }

  ensure(reference: BlobReference): Promise<void> {
    if (
      this.values.has(reference.sha256) ||
      this.errors.has(reference.sha256) ||
      this.evicted.has(reference.sha256)
    ) {
      return Promise.resolve();
    }
    const existing = this.pending.get(reference.sha256);
    if (existing !== undefined) return existing;
    const generation = this.generation;
    const sessionId = this.sessionId;
    const promise = this.read(reference, sessionId)
      .then((bytes) => {
        if (generation !== this.generation) return;
        this.errors.delete(reference.sha256);
        this.store(reference, bytes);
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.errors.set(
          reference.sha256,
          sanitizeTerminalText(error instanceof Error ? error.message : "blob read failed"),
        );
      })
      .finally(() => {
        if (this.pending.get(reference.sha256) === promise) {
          this.pending.delete(reference.sha256);
        }
        if (generation === this.generation) this.loaded();
      });
    this.pending.set(reference.sha256, promise);
    return promise;
  }

  private store(reference: BlobReference, bytes: Uint8Array): void {
    const previous = this.values.get(reference.sha256);
    if (previous !== undefined) this.totalBytes -= previous.byteLength;
    while (this.values.size > 0 && this.totalBytes + bytes.byteLength > MAX_CACHE_BYTES) {
      const first = this.values.entries().next().value as [string, Uint8Array] | undefined;
      if (first === undefined) break;
      this.values.delete(first[0]);
      this.evicted.add(first[0]);
      this.totalBytes -= first[1].byteLength;
    }
    if (bytes.byteLength <= MAX_CACHE_BYTES) {
      this.values.set(reference.sha256, bytes);
      this.evicted.delete(reference.sha256);
      this.totalBytes += bytes.byteLength;
    }
  }

  private async read(
    reference: BlobReference,
    sessionId: SessionId = this.sessionId,
  ): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < reference.sizeBytes) {
      const result = parseBlobReadResult(
        await this.client().request("session.blob.read", {
          sessionId,
          sha256: reference.sha256,
          offset,
          length: Math.min(READ_CHUNK_BYTES, reference.sizeBytes - offset),
        }),
      );
      if (
        result.offset !== offset ||
        result.nextOffset <= offset ||
        result.nextOffset > reference.sizeBytes
      ) {
        throw new Error("Daemon returned an invalid blob read range");
      }
      const bytes = Buffer.from(result.data, "base64");
      if (bytes.byteLength !== result.nextOffset - offset) {
        throw new Error("Daemon returned an invalid blob read payload");
      }
      chunks.push(bytes);
      offset = result.nextOffset;
      if (result.eof !== (offset === reference.sizeBytes)) {
        throw new Error("Daemon returned an inconsistent blob end marker");
      }
    }
    const bytes = Buffer.concat(chunks);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== reference.sha256) throw new Error("blob digest verification failed");
    return bytes;
  }
}
