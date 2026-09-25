// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * QR Code Model 2 encoder (ISO/IEC 18004) for printing pairing links in the terminal.
 *
 * Byte mode only, which covers any URL. The encoder picks the smallest version that fits the
 * requested error correction level, then the mask with the lowest standard penalty.
 */

export type QrErrorCorrection = "L" | "M" | "Q" | "H";

/** A square grid of modules; `true` is dark. */
export interface QrCode {
  readonly version: number;
  readonly size: number;
  readonly errorCorrection: QrErrorCorrection;
  readonly mask: number;
  readonly modules: readonly (readonly boolean[])[];
}

const LEVELS: readonly QrErrorCorrection[] = ["L", "M", "Q", "H"];

/** Format-information bits for each level. */
const FORMAT_BITS: Readonly<Record<QrErrorCorrection, number>> = { L: 1, M: 0, Q: 3, H: 2 };

// Per version 1..40 (index 0 unused), from the standard's error correction tables.
const ECC_CODEWORDS_PER_BLOCK: Readonly<Record<QrErrorCorrection, readonly number[]>> = {
  L: [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30,
    30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  M: [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  Q: [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30,
    30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  H: [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
};

const ERROR_CORRECTION_BLOCKS: Readonly<Record<QrErrorCorrection, readonly number[]>> = {
  L: [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
    15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  M: [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23,
    25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  Q: [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34,
    34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  H: [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35,
    37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
};

/** Modules available for data and error correction codewords, excluding function patterns. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, level: QrErrorCorrection): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    (ECC_CODEWORDS_PER_BLOCK[level][version] ?? 0) * (ERROR_CORRECTION_BLOCKS[level][version] ?? 0)
  );
}

/** Bits needed for byte-mode data of this length in this version. */
function byteModeBits(version: number, length: number): number {
  return 4 + (version <= 9 ? 8 : 16) + length * 8;
}

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1. */
function multiply(x: number, y: number): number {
  let product = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((y >>> bit) & 1) * x;
  }
  return product & 0xff;
}

/** Coefficients of the Reed-Solomon generator polynomial, highest degree first, leading 1 omitted. */
export function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let term = 0; term < degree; term += 1) {
      result[term] = multiply(result[term] ?? 0, root);
      if (term + 1 < degree) result[term] = (result[term] ?? 0) ^ (result[term + 1] ?? 0);
    }
    root = multiply(root, 0x02);
  }
  return result;
}

export function reedSolomonRemainder(
  data: readonly number[],
  divisor: readonly number[],
): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    for (let index = 0; index < divisor.length; index += 1) {
      result[index] = (result[index] ?? 0) ^ multiply(divisor[index] ?? 0, factor);
    }
  }
  return result;
}

/** Split data into blocks, append each block's error correction, and interleave. */
function withErrorCorrection(
  data: readonly number[],
  version: number,
  level: QrErrorCorrection,
): number[] {
  const blockCount = ERROR_CORRECTION_BLOCKS[level][version] ?? 1;
  const eccLength = ECC_CODEWORDS_PER_BLOCK[level][version] ?? 0;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortBlockLength = Math.floor(rawCodewords / blockCount);
  const divisor = reedSolomonDivisor(eccLength);
  const blocks: number[][] = [];
  let offset = 0;
  for (let index = 0; index < blockCount; index += 1) {
    const length = shortBlockLength - eccLength + (index < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    const ecc = reedSolomonRemainder(block, divisor);
    // Short blocks get a placeholder so every block has the same shape while interleaving.
    if (index < shortBlocks) block.push(0);
    blocks.push([...block, ...ecc]);
  }
  const result: number[] = [];
  const width = blocks[0]?.length ?? 0;
  for (let column = 0; column < width; column += 1) {
    for (let row = 0; row < blocks.length; row += 1) {
      if (column === shortBlockLength - eccLength && row < shortBlocks) continue;
      result.push(blocks[row]?.[column] ?? 0);
    }
  }
  return result;
}

function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step) {
    result.splice(1, 0, position);
  }
  return result;
}

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    const row = this.modules[y];
    const reserved = this.reserved[y];
    if (row === undefined || reserved === undefined || x < 0 || x >= this.size) return;
    row[x] = dark;
    reserved[x] = true;
  }
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  const { size } = grid;
  for (let index = 0; index < size; index += 1) {
    grid.set(6, index, index % 2 === 0);
    grid.set(index, 6, index % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size)
          grid.set(x, y, distance !== 2 && distance !== 4);
      }
    }
  }
  const positions = alignmentPositions(version, size);
  const last = positions.length - 1;
  for (const [i, x] of positions.entries()) {
    for (const [j, y] of positions.entries()) {
      // The three corners already hold finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          grid.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // Reserve the format areas now; the real bits are written once the mask is chosen.
  drawFormatBits(grid, "L", 0);
  if (version >= 7) {
    let remainder = version;
    for (let index = 0; index < 12; index += 1) {
      remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    }
    const bits = (version << 12) | remainder;
    for (let index = 0; index < 18; index += 1) {
      const dark = ((bits >>> index) & 1) === 1;
      const a = size - 11 + (index % 3);
      const b = Math.floor(index / 3);
      grid.set(a, b, dark);
      grid.set(b, a, dark);
    }
  }
}

function drawFormatBits(grid: Grid, level: QrErrorCorrection, mask: number): void {
  const data = (FORMAT_BITS[level] << 3) | mask;
  let remainder = data;
  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bit = (index: number) => ((bits >>> index) & 1) === 1;
  const { size } = grid;
  for (let index = 0; index <= 5; index += 1) grid.set(8, index, bit(index));
  grid.set(8, 7, bit(6));
  grid.set(8, 8, bit(7));
  grid.set(7, 8, bit(8));
  for (let index = 9; index < 15; index += 1) grid.set(14 - index, 8, bit(index));
  for (let index = 0; index < 8; index += 1) grid.set(size - 1 - index, 8, bit(index));
  for (let index = 8; index < 15; index += 1) grid.set(8, size - 15 + index, bit(index));
  grid.set(8, size - 8, true);
}

/** Place codewords in the standard two-column zigzag, skipping function modules. */
function drawCodewords(grid: Grid, codewords: readonly number[]): void {
  const { size } = grid;
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step += 1) {
      const y = upward ? size - 1 - step : step;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (grid.reserved[y]?.[x] === true || bitIndex >= totalBits) continue;
        const byte = codewords[bitIndex >>> 3] ?? 0;
        const row = grid.modules[y];
        if (row !== undefined) row[x] = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
        bitIndex += 1;
      }
    }
  }
}

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(grid: Grid, mask: number): void {
  for (let y = 0; y < grid.size; y += 1) {
    const row = grid.modules[y];
    const reserved = grid.reserved[y];
    if (row === undefined || reserved === undefined) continue;
    for (let x = 0; x < grid.size; x += 1) {
      if (!reserved[x] && maskApplies(mask, x, y)) row[x] = !row[x];
    }
  }
}

const FINDER_LIKE = [true, false, true, true, true, false, true];

/** The standard's four penalty rules; lower is easier to scan. */
function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  const at = (x: number, y: number) => modules[y]?.[x] === true;
  let score = 0;
  for (const horizontal of [true, false]) {
    for (let line = 0; line < size; line += 1) {
      const cell = (index: number) => (horizontal ? at(index, line) : at(line, index));
      let run = 1;
      for (let index = 1; index <= size; index += 1) {
        if (index < size && cell(index) === cell(index - 1)) {
          run += 1;
          continue;
        }
        if (run >= 5) score += run - 2;
        run = 1;
      }
      // Finder-like runs with four light modules on either side; outside the grid is light.
      for (let start = -4; start + 7 <= size + 4; start += 1) {
        const matches = FINDER_LIKE.every((dark, offset) => {
          const index = start + offset;
          return (index >= 0 && index < size && cell(index)) === dark;
        });
        if (!matches) continue;
        const light = (from: number) =>
          [0, 1, 2, 3].every((offset) => {
            const index = from + offset;
            return index < 0 || index >= size || !cell(index);
          });
        if (light(start - 4) || light(start + 7)) score += 40;
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (at(x, y)) dark += 1;
      if (
        x + 1 < size &&
        y + 1 < size &&
        at(x, y) === at(x + 1, y) &&
        at(x, y) === at(x, y + 1) &&
        at(x, y) === at(x + 1, y + 1)
      ) {
        score += 3;
      }
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encode `text` as UTF-8 bytes at the smallest version that fits `errorCorrection`. */
export function encodeQrCode(text: string, errorCorrection: QrErrorCorrection = "M"): QrCode {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (
    version <= 40 &&
    byteModeBits(version, bytes.length) > dataCodewords(version, errorCorrection) * 8
  ) {
    version += 1;
  }
  if (version > 40) throw new RangeError("Text is too long for a QR code");
  // Use a stronger level when it fits in the same version.
  let level = errorCorrection;
  for (const candidate of LEVELS.slice(LEVELS.indexOf(errorCorrection) + 1)) {
    if (byteModeBits(version, bytes.length) <= dataCodewords(version, candidate) * 8)
      level = candidate;
  }

  const capacityBits = dataCodewords(version, level) * 8;
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let index = length - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, capacityBits - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    data.push(bits.slice(index, index + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  for (let pad = 0xec; data.length < capacityBits / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  const size = version * 4 + 17;
  const base = new Grid(size);
  drawFunctionPatterns(base, version);
  drawCodewords(base, withErrorCorrection(data, version, level));

  let best: { mask: number; modules: boolean[][]; score: number } | undefined;
  for (let mask = 0; mask < 8; mask += 1) {
    const grid = new Grid(size);
    for (let y = 0; y < size; y += 1) {
      grid.modules[y] = [...(base.modules[y] ?? [])];
      grid.reserved[y] = [...(base.reserved[y] ?? [])];
    }
    applyMask(grid, mask);
    drawFormatBits(grid, level, mask);
    const score = penalty(grid.modules);
    if (best === undefined || score < best.score) best = { mask, modules: grid.modules, score };
  }
  if (best === undefined) throw new Error("No QR mask was evaluated");
  return { version, size, errorCorrection: level, mask: best.mask, modules: best.modules };
}

/** The standard quiet zone; two modules still scan on most phones when space is short. */
export const QR_QUIET_ZONE = 4;
const DARK_ON_LIGHT = "[38;5;16;48;5;231m";
const RESET = "[0m";

export interface QrRenderOptions {
  readonly quietZone?: number;
  /** Paint modules dark on light explicitly; without it the terminal's own colors are used. */
  readonly color?: boolean;
}

/** Terminal columns a rendered code occupies, quiet zone included. */
export function qrTerminalWidth(code: QrCode, quietZone = QR_QUIET_ZONE): number {
  return code.size + quietZone * 2;
}

/**
 * Render with half blocks, two module rows per text row. With color the code is dark on light
 * whatever the terminal theme, which is what phone cameras expect.
 */
export function renderQrCode(code: QrCode, options: QrRenderOptions = {}): string[] {
  const quiet = options.quietZone ?? QR_QUIET_ZONE;
  const span = code.size + quiet * 2;
  const dark = (x: number, y: number) => code.modules[y - quiet]?.[x - quiet] === true;
  const lines: string[] = [];
  for (let y = 0; y < span; y += 2) {
    let line = "";
    for (let x = 0; x < span; x += 1) {
      const top = dark(x, y);
      const bottom = y + 1 < span && dark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(options.color === false ? line : `${DARK_ON_LIGHT}${line}${RESET}`);
  }
  return lines;
}
