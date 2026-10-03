// SPDX-FileCopyrightText: 2026 Dheirav
// SPDX-License-Identifier: Apache-2.0

/**
 * Draws the mascot with sixel graphics, for terminals that have them and not
 * the Kitty protocol: Windows Terminal from 1.22, WezTerm, foot, Konsole,
 * mlterm, xterm as a VT340.
 *
 * A Kitty placement floats above the text; a sixel image is written into the
 * text grid like characters, so every frame is drawn afresh. The atlas is an
 * indexed PNG, and sixel draws with a colour table too, so the frames are
 * decoded once to palette indices and each colour is only a different table.
 */

import { inflateSync } from "node:zlib";

import type { MascotManifest } from "@axl/sdk";

export class MascotSixelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MascotSixelError";
  }
}

export interface IndexedImage {
  readonly width: number;
  readonly height: number;
  /** One palette index per pixel, row by row. */
  readonly pixels: Uint8Array;
  readonly palette: readonly (readonly [number, number, number])[];
  /** Indices drawn as nothing. */
  readonly transparent: ReadonlySet<number>;
}

/** An 8-bit indexed PNG to its pixels, palette and transparent indices. */
export function decodeIndexedPng(png: Uint8Array): IndexedImage {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let palette: (readonly [number, number, number])[] = [];
  const transparent = new Set<number>();
  const data: Uint8Array[] = [];
  for (let offset = 8; offset + 12 <= png.length; ) {
    const length = view.getUint32(offset);
    const type = Buffer.from(png.subarray(offset + 4, offset + 8)).toString("latin1");
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const [depth, colourType, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || colourType !== 3 || interlace !== 0) {
        throw new MascotSixelError("the atlas is not an 8-bit indexed, non-interlaced PNG");
      }
    } else if (type === "PLTE") {
      palette = [];
      for (let i = 0; i + 2 < body.length; i += 3) {
        palette.push([body[i] as number, body[i + 1] as number, body[i + 2] as number]);
      }
    } else if (type === "tRNS") {
      body.forEach((alpha, index) => {
        if (alpha === 0) transparent.add(index);
      });
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || palette.length === 0) throw new MascotSixelError("the atlas has no image");
  const raw = inflateSync(Buffer.concat(data));
  const pixels = new Uint8Array(width * height);
  // Undo each row's filter; one byte a pixel, so the left neighbour is one back.
  let previous = new Uint8Array(width);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (width + 1)];
    const row = raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1));
    const out = new Uint8Array(width);
    for (let x = 0; x < width; x += 1) {
      const left = x > 0 ? (out[x - 1] as number) : 0;
      const up = previous[x] as number;
      const upLeft = x > 0 ? (previous[x - 1] as number) : 0;
      const value = row[x] as number;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) {
        throw new MascotSixelError(`unknown PNG filter ${filter}`);
      }
      out[x] = (value + predicted) & 0xff;
    }
    pixels.set(out, y * width);
    previous = out;
  }
  return { width, height, pixels, palette, transparent };
}

/**
 * Pixels of palette indices to a sixel image, transparent where nothing is
 * drawn. `colours` is the table to draw with, index for index.
 */
export function encodeMascotSixel(
  width: number,
  height: number,
  at: (x: number, y: number) => number | undefined,
  colours: readonly (readonly [number, number, number])[],
): string {
  const used = new Set<number>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = at(x, y);
      if (index !== undefined) used.add(index);
    }
  }
  const registers = [...used].sort((a, b) => a - b);
  let out = `\x1bP0;1;0q"1;1;${width};${height}`;
  for (const index of registers) {
    const [r, g, b] = colours[index] ?? [0, 0, 0];
    out += `#${index};2;${Math.round((r * 100) / 255)};${Math.round((g * 100) / 255)};${Math.round((b * 100) / 255)}`;
  }
  const run = (char: string, count: number) =>
    count > 3 ? `!${count}${char}` : char.repeat(count);
  for (let band = 0; band < height; band += 6) {
    const rows: string[] = [];
    for (const index of registers) {
      let line = "";
      let last = "";
      let count = 0;
      let any = false;
      for (let x = 0; x < width; x += 1) {
        let bits = 0;
        for (let k = 0; k < 6 && band + k < height; k += 1) {
          if (at(x, band + k) === index) bits |= 1 << k;
        }
        any ||= bits !== 0;
        const char = String.fromCharCode(63 + bits);
        if (char === last) count += 1;
        else {
          if (count > 0) line += run(last, count);
          last = char;
          count = 1;
        }
      }
      if (!any) continue;
      if (last !== "?") line += run(last, count);
      rows.push(`#${index}${line}`);
    }
    out += `${rows.join("$")}-`;
  }
  return `${out}\x1b\\`;
}

/**
 * Frames of the atlas as sixel images, `rows` text rows tall at the terminal's
 * cell size, in the atlas's palette. Each frame is encoded the first time it is drawn.
 */
export class MascotSixelRenderer {
  readonly rows: number;
  /** Columns the sprite spans. */
  readonly width: number;
  private readonly atlas: IndexedImage;
  private readonly frameSize: readonly [number, number];
  private readonly atlasColumns: number;
  private readonly cell: { readonly width: number; readonly height: number };
  private readonly colours: readonly (readonly [number, number, number])[];
  private readonly cache = new Map<string, string>();
  private readonly spriteWidth: number;
  private readonly spriteHeight: number;

  constructor(
    atlasPng: Uint8Array,
    manifest: MascotManifest,
    cell: { readonly width: number; readonly height: number },
    rows = 4,
  ) {
    this.atlas = decodeIndexedPng(atlasPng);
    this.frameSize = manifest.frameSize;
    this.atlasColumns = manifest.atlasColumns;
    this.cell = cell;
    this.rows = rows;
    // The atlas's own palette: loadMascotAtlas has already swapped in the
    // colour's, and a user's own atlas carries theirs, as the Kitty path draws it.
    this.colours = this.atlas.palette;
    this.spriteHeight = rows * cell.height;
    this.spriteWidth = Math.round((this.frameSize[0] * this.spriteHeight) / this.frameSize[1]);
    this.width = Math.ceil(this.spriteWidth / cell.width);
  }

  /**
   * One frame, sunk `sink` rows (its bottom cropped by as many), facing the
   * other way when `mirrored`. Empty when it has sunk out of sight.
   *
   * `bottomMargin` is the clear space under the segment's art, in frame
   * pixels, as the build measured it: the art is moved down by that much so
   * its lowest pixel sits on the bottom of the strip, just above the
   * composer, instead of floating a row above it. What moves out below is
   * empty, and the frame's top margin has room for the shift.
   */
  frame(frameId: number, sink = 0, mirrored = false, bottomMargin = 0): string {
    const visibleRows = this.rows - Math.max(0, Math.round(sink));
    if (visibleRows <= 0) return "";
    const shift = Math.round((Math.max(0, bottomMargin) * this.spriteHeight) / this.frameSize[1]);
    const key = `${frameId}:${visibleRows}:${mirrored ? 1 : 0}:${shift}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const [frameWidth, frameHeight] = this.frameSize;
    const originX = (frameId % this.atlasColumns) * frameWidth;
    const originY = Math.floor(frameId / this.atlasColumns) * frameHeight;
    const width = this.spriteWidth;
    const height = visibleRows * this.cell.height;
    const { pixels, transparent } = this.atlas;
    const atlasWidth = this.atlas.width;
    const encoded = encodeMascotSixel(
      width,
      height,
      (x, y) => {
        const sx = Math.min(frameWidth - 1, Math.floor((x * frameWidth) / width));
        if (y < shift) return undefined;
        const sy = Math.min(
          frameHeight - 1,
          Math.floor(((y - shift) * frameHeight) / this.spriteHeight),
        );
        const index = pixels[
          (originY + sy) * atlasWidth + originX + (mirrored ? frameWidth - 1 - sx : sx)
        ] as number;
        return transparent.has(index) ? undefined : index;
      },
      this.colours,
    );
    this.cache.set(key, encoded);
    return encoded;
  }
}
