// SPDX-FileCopyrightText: 2026 Dheirav
// SPDX-License-Identifier: Apache-2.0

/**
 * Mascot rendering: the glyph pack contract and the terminal component.
 *
 * A pack holds every frame already encoded as terminal rows, so drawing a
 * frame is a lookup rather than image work. The atlas and the inline-image
 * path are not used here; this is the glyph rung of the ladder in
 * `docs/terminal-compatibility.md`, which is what every terminal without an
 * image protocol gets.
 */

import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { type MascotManifest, type MascotPlayer, parseMascotManifest } from "@axl/sdk";
import { MascotSixelRenderer } from "./mascot-sixel.ts";
import { type Component, stripAnsi } from "./render.ts";

/** Inclusive first and last row that a state actually paints. */
export type MascotCrop = readonly [number, number];

export interface MascotPack {
  /** Cell footprint of one frame: columns, rows. */
  readonly cell: readonly [number, number];
  readonly encoding: string;
  /** Source art size in pixels. */
  readonly pixels: number;
  /** Pre-encoded rows per atlas slot. */
  readonly frames: readonly (readonly string[])[];
  /** Painted rows per state, keyed `state`. */
  readonly crop: { readonly [state: string]: MascotCrop };
  /** Painted rows per segment, keyed `state.segment`. */
  readonly cropSegment: { readonly [key: string]: MascotCrop };
}

export class MascotPackError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "MascotPackError";
  }
}

function crops(value: unknown, path: string): { [key: string]: MascotCrop } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MascotPackError(path, "expected an object");
  }
  const parsed: { [key: string]: MascotCrop } = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !entry.every((row) => Number.isSafeInteger(row) && (row as number) >= 0)
    ) {
      throw new MascotPackError(`${path}.${key}`, "expected [firstRow, lastRow]");
    }
    parsed[key] = [entry[0] as number, entry[1] as number];
  }
  return parsed;
}

/** Validates a glyph pack read from disk. A malformed pack fails here. */
export function parseMascotPack(value: unknown): MascotPack {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MascotPackError("pack", "expected an object");
  }
  const pack = value as Record<string, unknown>;
  const cell = pack.cell;
  if (!Array.isArray(cell) || cell.length !== 2 || !cell.every((n) => Number.isSafeInteger(n))) {
    throw new MascotPackError("pack.cell", "expected [columns, rows]");
  }
  const frames = pack.frames;
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new MascotPackError("pack.frames", "expected a non-empty array");
  }
  const rows = cell[1] as number;
  const parsedFrames = frames.map((frame, index) => {
    if (!Array.isArray(frame) || frame.length !== rows) {
      throw new MascotPackError(`pack.frames[${index}]`, `expected ${rows} rows`);
    }
    return frame.map((row, rowIndex) => {
      if (typeof row !== "string") {
        throw new MascotPackError(`pack.frames[${index}][${rowIndex}]`, "expected a string");
      }
      return row;
    });
  });
  if (typeof pack.encoding !== "string" || pack.encoding.length === 0) {
    throw new MascotPackError("pack.encoding", "expected a non-empty string");
  }
  return {
    cell: [cell[0] as number, rows],
    encoding: pack.encoding,
    pixels: Number.isSafeInteger(pack.pixels) ? (pack.pixels as number) : 0,
    frames: parsedFrames,
    crop: crops(pack.crop, "pack.crop"),
    cropSegment: crops(pack.crop_seg, "pack.crop_seg"),
  };
}

/**
 * The rows each segment actually paints, measured from the pack.
 *
 * Per segment rather than per state: `working` holds both the tall dive-in
 * poses and the small swim loop, so a state-wide band covers the whole frame
 * and leaves the swimming sprite floating well above the bar.
 *
 * The pack's crop table counts transparent cells as painted, so it reports a
 * full-height band for states that sit well clear of the bottom. Measuring per
 * state lets every state be bottom-aligned in a fixed strip: the mascot sits
 * flush against whatever is below it, and because the band is per state rather
 * than per frame, the art still moves within its own animation.
 */
export function packSegmentRows(
  pack: MascotPack,
  manifest: MascotManifest,
): ReadonlyMap<string, readonly [number, number]> {
  const bounds = new Map<string, readonly [number, number]>();
  for (const [name, state] of Object.entries(manifest.states)) {
    for (const [segmentName, segment] of Object.entries(state.segments)) {
      let first = pack.cell[1] - 1;
      let last = 0;
      let painted = false;
      for (const id of segment.frames) {
        const frame = pack.frames[id];
        if (frame === undefined) continue;
        for (let row = 0; row < frame.length; row += 1) {
          if (stripAnsi(frame[row] as string).trim() === "") continue;
          painted = true;
          if (row < first) first = row;
          if (row > last) last = row;
        }
      }
      bounds.set(`${name}.${segmentName}`, painted ? [first, last] : [0, pack.cell[1] - 1]);
    }
  }
  return bounds;
}

export interface MascotAssets {
  readonly manifest: MascotManifest;
  readonly pack: MascotPack;
}

/** Where the committed assets live, relative to this module. */
const ASSET_DIRECTORY = new URL("../assets/mascot/", import.meta.url);

/**
 * Where a user's own atlases live, taking precedence over the bundled ones.
 * AXL_MASCOT_ASSETS overrides the location.
 *
 * Accessories are baked into the pixels rather than drawn as a second image:
 * the terminal stretches the sprite's source rectangle to a cell box at a
 * scale that changes with the state, so a separate placement cannot be kept
 * aligned to it. An atlas here is how a dressed or redrawn mascot reaches the
 * harness, and it is an ordinary atlas the renderer already knows how to draw.
 */
function userAssetDirectory(): string {
  return process.env.AXL_MASCOT_ASSETS ?? join(homedir(), ".axl", "mascot");
}

/**
 * Loads the manifest and one colour's glyph pack. Colour is presentation
 * preference only; it carries no meaning about the session.
 */
export async function loadMascotAssets(colour: string): Promise<MascotAssets> {
  if (!/^[A-Za-z_]+$/.test(colour)) {
    throw new MascotPackError("colour", `unsupported colour ${JSON.stringify(colour)}`);
  }
  const manifest = parseMascotManifest(
    JSON.parse(await readFile(new URL("axolotl.json", ASSET_DIRECTORY), "utf8")),
  );
  if (!manifest.colours.includes(colour)) {
    throw new MascotPackError("colour", `${colour} is not in the manifest`);
  }
  const own = await readBundled(`small-${colour}.json`);
  if (own !== undefined) {
    return { manifest, pack: parseMascotPack(JSON.parse(Buffer.from(own).toString("utf8"))) };
  }
  // A colour drawn by palette: the first colour's pack, its colours swapped.
  const base = manifest.colours[0] as string;
  const text = await readFile(new URL(`small-${base}.json`, ASSET_DIRECTORY), "utf8");
  const pack = parseMascotPack(JSON.parse(recolourText(text, paletteSwap(manifest, colour))));
  return { manifest, pack };
}

/** A bundled asset, or undefined when there is none by that name. */
async function readBundled(name: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(new URL(name, ASSET_DIRECTORY)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Each of the first colour's palette entries, as `r;g;b`, to the colour's own. */
function paletteSwap(manifest: MascotManifest, colour: string): ReadonlyMap<string, string> {
  const base = manifest.palettes?.[manifest.colours[0] as string];
  const target = manifest.palettes?.[colour];
  if (base === undefined || target === undefined) {
    throw new MascotPackError("colour", `${colour} has no art and no palette to draw it with`);
  }
  return new Map(
    base.map((entry, index) => [entry.join(";"), (target[index] as readonly number[]).join(";")]),
  );
}

/** The pack's truecolour escapes moved onto another palette. */
export function recolourText(text: string, swap: ReadonlyMap<string, string>): string {
  // JSON keeps the escape character as \u001b, so match the colour after it.
  return text.replace(/\[(38|48);2;(\d+;\d+;\d+)m/g, (whole, layer: string, rgb: string) => {
    const to = swap.get(rgb);
    return to === undefined ? whole : `[${layer};2;${to}m`;
  });
}

/** The xterm 256-colour index nearest a colour: the 6x6x6 cube or the grey ramp. */
export function nearest256(r: number, g: number, b: number): number {
  const levels = [0, 95, 135, 175, 215, 255];
  const step = (v: number) =>
    levels.reduce(
      (best, level, index) =>
        Math.abs(level - v) < Math.abs((levels[best] as number) - v) ? index : best,
      0,
    );
  const [cr, cg, cb] = [step(r), step(g), step(b)];
  const cube: [number, number, number] = [
    levels[cr] as number,
    levels[cg] as number,
    levels[cb] as number,
  ];
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const greyValue = 8 + grey * 10;
  const distance = ([xr, xg, xb]: readonly [number, number, number]) =>
    (xr - r) ** 2 + (xg - g) ** 2 + (xb - b) ** 2;
  return distance([greyValue, greyValue, greyValue]) < distance(cube)
    ? 232 + grey
    : 16 + 36 * cr + 6 * cg + cb;
}

/** The pack's truecolour escapes as 256-colour ones, for terminals without 24-bit colour. */
export function packTo256(pack: MascotPack): MascotPack {
  const cache = new Map<string, string>();
  const convert = (row: string) =>
    row.replace(
      // from the [ on, as in recolourText; the escape before it is unchanged
      /\[(38|48);2;(\d+);(\d+);(\d+)m/g,
      (whole, layer: string, r: string, g: string, b: string) => {
        let code = cache.get(whole);
        if (code === undefined) {
          code = `[${layer};5;${nearest256(Number(r), Number(g), Number(b))}m`;
          cache.set(whole, code);
        }
        return code;
      },
    );
  return { ...pack, frames: pack.frames.map((rows) => rows.map(convert)) };
}

/**
 * An indexed PNG with its palette replaced, entry for entry. Only the PLTE
 * chunk and its checksum change: the pixels, and the transparency that is
 * keyed on index, stay as they are, so no image is decoded or encoded.
 */
export function recolourPng(
  png: Uint8Array,
  palette: readonly (readonly [number, number, number])[],
): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let offset = 8; offset + 12 <= png.length; ) {
    const length = view.getUint32(offset);
    const type = Buffer.from(png.subarray(offset + 4, offset + 8)).toString("latin1");
    if (type === "PLTE") {
      if (length !== palette.length * 3) {
        throw new MascotPackError(
          "atlas",
          `palette has ${length / 3} colours, the manifest ${palette.length}`,
        );
      }
      const out = new Uint8Array(png);
      out.set(palette.flat(), offset + 8);
      const crc = crc32(out.subarray(offset + 4, offset + 8 + length));
      new DataView(out.buffer).setUint32(offset + 8 + length, crc);
      return out;
    }
    if (type === "IDAT" || type === "IEND") break;
    offset += 12 + length;
  }
  throw new MascotPackError("atlas", "not an indexed PNG, so its colours cannot be swapped");
}

/**
 * Draws atlas frames with the Kitty graphics protocol.
 *
 * The atlas is transmitted once and every frame is a placement of a source
 * rectangle inside it, so animating costs one short escape per frame and no
 * image decoding. Terminals without the protocol use the glyph pack instead.
 */
/**
 * Sprite box in terminal cells: columns, then rows.
 *
 * The terminal scales the image into this box preserving aspect, anchored to
 * the top left. A cell is roughly two and a half times taller than it is
 * wide, so a box that is not about that much wider than it is tall leaves
 * empty rows underneath the sprite. Columns follow the frame's own aspect,
 * so a wide frame reserves a wide box instead of overlapping the text.
 */
const CELL_ASPECT = 2.0;
const DEFAULT_CELL_ROWS = 4;

function defaultCellColumns(frameSize: readonly [number, number]): number {
  const [width, height] = frameSize;
  return Math.max(1, Math.round((DEFAULT_CELL_ROWS * CELL_ASPECT * width) / height));
}

/**
 * Placement id. Reusing it replaces the previous placement in place, which the
 * protocol defines as flicker-free, so no delete is needed between frames.
 */
const PLACEMENT_ID = 1;

/**
 * Smallest number of rows a placement may span.
 *
 * The escape has to be emitted on a row the strip owns, and the sprite's last
 * row has to reach the composer's border one row below the strip, so a
 * placement shorter than this could not be anchored at all.
 */
const MINIMUM_PLACEMENT_ROWS = 2;

/**
 * Stacking order of the sprite.
 *
 * Below the cell backgrounds, so the composer's opaque border row hides the
 * overlapping part of the sprite outright while its glyphs stay legible. The
 * terminal treats z below INT32_MIN/2 as the below-background band and the
 * comparison is strict, so -1073741824 would not be low enough.
 */
const PLACEMENT_Z_INDEX = -1073741825;

/**
 * Stacking order while the pose ends on the composer's line and is not
 * sinking: above cell backgrounds, still below text. The line is drawn through
 * the middle of the border row, so a sprite hidden by that row's background
 * stops half a row short of it. With nothing of the pose below the line there
 * is nothing for the border to hide.
 */
const PLACEMENT_Z_ON_LINE = -1;

/** Source pixels a pose may end below the line and still count as on it. */
const ON_LINE_TOLERANCE = 4;

export class MascotAtlasRenderer {
  private readonly base64: string;
  private readonly mirroredBase64: string | undefined;
  private readonly frameSize: readonly [number, number];
  private readonly columns: number;
  private readonly imageId: number;
  private readonly cellColumns: number;
  private readonly cellRows: number;
  private readonly transmitted = new Set<number>();

  constructor(
    atlas: Uint8Array,
    manifest: MascotManifest,
    options: {
      readonly imageId?: number;
      readonly cells?: readonly [number, number];
      /** The same atlas with each frame mirrored, for the other facing. */
      readonly mirrored?: Uint8Array;
    } = {},
  ) {
    this.base64 = Buffer.from(atlas).toString("base64");
    this.mirroredBase64 =
      options.mirrored === undefined ? undefined : Buffer.from(options.mirrored).toString("base64");
    this.frameSize = manifest.frameSize;
    this.columns = manifest.atlasColumns;
    this.imageId = options.imageId ?? 0x4158_4c00;
    this.cellColumns = options.cells?.[0] ?? defaultCellColumns(manifest.frameSize);
    this.cellRows = options.cells?.[1] ?? DEFAULT_CELL_ROWS;
  }

  get height(): number {
    return this.cellRows;
  }

  get width(): number {
    return this.cellColumns;
  }

  /** Sends the atlas once. Later calls return nothing. */
  private transmit(id: number, data: string): string {
    if (this.transmitted.has(id)) return "";
    this.transmitted.add(id);
    const chunkSize = 4096;
    const chunks: string[] = [];
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const first = offset === 0;
      const final = offset + chunkSize >= data.length;
      const controls = first
        ? `a=t,f=100,t=d,i=${id},q=2,m=${final ? 0 : 1}`
        : `m=${final ? 0 : 1}`;
      chunks.push(`\x1b_G${controls};${data.slice(offset, offset + chunkSize)}\x1b\\`);
    }
    return chunks.join("");
  }

  /** True when a mirrored atlas is available for the other facing. */
  get canMirror(): boolean {
    return this.mirroredBase64 !== undefined;
  }

  /**
   * Replaces the on-screen placement with one frame of the atlas. `visibleRows`
   * below the full height crops the bottom of the art, which is how the sprite
   * sinks behind the composer bar.
   */
  /**
   * Rows this band occupies in the box, before sinking. The band is the part
   * of the frame the current segment actually paints, so a small pose uses
   * fewer rows and can be pushed to the bottom of the strip.
   */
  rowsFor(band?: readonly [number, number, number], bottomMargin?: number): number {
    return this.window(band, bottomMargin).rows;
  }

  /**
   * The source window for a pose: the rows it spans and the source row it ends
   * on. It ends half a row below the pose's lowest pixel, so that pixel lands
   * in the middle of the placement's last row, which is the composer's top
   * border where the line is drawn. It cannot end past the frame, so a pose
   * less than half a row from its frame's bottom sits that much lower.
   */
  private window(
    band?: readonly [number, number, number],
    bottomMargin?: number,
  ): { readonly rows: number; readonly bottom: number; readonly lowest: number } {
    const frameHeight = this.frameSize[1];
    const perRow = frameHeight / this.cellRows;
    if (band === undefined)
      return { rows: this.cellRows, bottom: frameHeight, lowest: frameHeight };
    const poseTop = (frameHeight * band[0]) / band[2];
    // Without a measured margin the text pack's rows are too coarse to find the
    // line with, so the window ends where they say the pose does, as before.
    const lowest =
      bottomMargin === undefined
        ? (frameHeight * (band[1] + 1)) / band[2]
        : frameHeight - bottomMargin;
    const wanted = bottomMargin === undefined ? lowest : Math.min(frameHeight, lowest + perRow / 2);
    // Up, not to nearest: the window is sized from the rows at a fixed scale,
    // so rounding down would crop the top of the pose.
    const rows = Math.max(
      MINIMUM_PLACEMENT_ROWS,
      Math.min(this.cellRows, Math.ceil((wanted - poseTop) / perRow - 1e-9)),
    );
    // A window taller than the room above its end would start above the frame.
    const bottom = Math.max(wanted, Math.min(frameHeight, rows * perRow));
    return { rows, bottom, lowest };
  }

  /**
   * Replaces the on-screen placement with one frame of the atlas. `sink` hides
   * rows from the bottom, which is how the sprite dives behind the composer.
   */
  place(
    frameId: number,
    band?: readonly [number, number, number],
    sink = 0,
    mirrored = false,
    bottomMargin?: number,
  ): string {
    const [frameWidth, frameHeight] = this.frameSize;
    const { rows: bandRows, bottom, lowest } = this.window(band, bottomMargin);
    const rows = Math.max(1, bandRows - Math.max(0, Math.round(sink)));
    // One scale for every state: a row always shows the same number of source
    // pixels. The terminal stretches the source rectangle to fill the box, so
    // a window sized from the band instead, whose height is not a whole number
    // of rows, drew each state at its own scale; typing came out 27% larger
    // than waiting. The window is bottom-aligned to the pose, and the rows it
    // gains from rounding up are transparent space above it.
    const perRow = frameHeight / this.cellRows;
    const top = Math.max(0, Math.round(bottom - bandRows * perRow));
    // Sinking drops rows from the bottom of the box and the same share of
    // source from the bottom of the window, so the scale holds while diving.
    const height = Math.max(1, Math.min(frameHeight - top, Math.round(rows * perRow)));
    // Columns follow the source rectangle, so the aspect holds as well.
    const columns = Math.max(1, Math.round(rows * CELL_ASPECT * (frameWidth / height)));
    const x = (frameId % this.columns) * frameWidth;
    const y = Math.floor(frameId / this.columns) * frameHeight + top;
    const flipped = mirrored && this.mirroredBase64 !== undefined;
    const id = flipped ? this.imageId + 1 : this.imageId;
    const data = flipped ? (this.mirroredBase64 as string) : this.base64;
    // Both facings are separate images, so switching direction must also
    // replace the placement of the facing that is leaving the screen.
    const drop = `\x1b_Ga=d,d=i,i=${flipped ? this.imageId : this.imageId + 1},q=2\x1b\\`;
    // Over the border only while the pose ends on its line and is not diving:
    // anything lower would show through below the line.
    const onLine =
      bottomMargin !== undefined && sink <= 0 && lowest <= bottom - perRow / 2 + ON_LINE_TOLERANCE;
    const z = onLine ? PLACEMENT_Z_ON_LINE : PLACEMENT_Z_INDEX;
    const put =
      `\x1b_Ga=p,i=${id},p=${PLACEMENT_ID},x=${x},y=${y},w=${frameWidth},h=${height},` +
      `c=${columns},r=${rows},z=${z},C=1,q=2\x1b\\`;
    return `${this.transmit(id, data)}${drop}${put}`;
  }

  /** Removes the placement, for teardown. */
  clear(): string {
    return (
      `\x1b_Ga=d,d=i,i=${this.imageId},q=2\x1b\\` + `\x1b_Ga=d,d=i,i=${this.imageId + 1},q=2\x1b\\`
    );
  }
}

/**
 * Reads one colour's atlas for the image path: the user's own if they have
 * one, else a bundled atlas for that colour, else the bundled first colour's
 * atlas with its palette swapped for this colour's.
 */
export async function loadMascotAtlas(
  colour: string,
  manifest?: MascotManifest,
): Promise<Uint8Array> {
  return loadColouredAtlas(colour, "", manifest);
}

/**
 * The same atlas with every frame mirrored in place.
 *
 * The art is drawn facing one way only, and the terminal cannot mirror an
 * image, so the flipped frames have to exist as pixels. Mirroring each frame
 * within its own cell keeps the grid identical, so a frame's source rectangle
 * is the same in both atlases.
 *
 * A user's own atlas without its own mirrored copy has none: the bundled
 * mirror is different art, and the sprite would turn into the stock mascot
 * every time it faced the other way. It is then drawn facing one way.
 */
export async function loadMascotAtlasMirrored(
  colour: string,
  manifest?: MascotManifest,
): Promise<Uint8Array | undefined> {
  checkColour(colour);
  const own = join(userAssetDirectory(), `atlas-${colour}.png`);
  const ownMirrored = join(userAssetDirectory(), `atlas-${colour}-mirrored.png`);
  if ((await exists(own)) && !(await exists(ownMirrored))) return undefined;
  return loadColouredAtlas(colour, "-mirrored", manifest);
}

function checkColour(colour: string): void {
  if (!/^[A-Za-z_]+$/.test(colour)) {
    throw new MascotPackError("colour", `unsupported colour ${JSON.stringify(colour)}`);
  }
}

/** Whether a file is there; any error but a missing file is raised. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function loadColouredAtlas(
  colour: string,
  suffix: string,
  manifest: MascotManifest | undefined,
): Promise<Uint8Array> {
  checkColour(colour);
  const name = `atlas-${colour}${suffix}.png`;
  // A missing override is the common case, so only ENOENT falls through: an
  // unreadable or corrupt override is a mistake the user should be told about,
  // not something to paper over with the bundled art.
  try {
    return new Uint8Array(await readFile(join(userAssetDirectory(), name)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const bundled = await readBundled(name);
  if (bundled !== undefined) return bundled;
  const palette = manifest?.palettes?.[colour];
  if (manifest === undefined || palette === undefined) {
    throw new MascotPackError("colour", `${colour} has no atlas and no palette to draw it with`);
  }
  const base = await readFile(
    new URL(`atlas-${manifest.colours[0]}${suffix}.png`, ASSET_DIRECTORY),
  );
  return recolourPng(new Uint8Array(base), palette);
}

export interface MascotComponentOptions {
  /** Columns of indent from the left edge. */
  readonly column?: number;
  /** Painted rows per state, from `packStateRows`. Enables bottom alignment. */
  readonly bands?: ReadonlyMap<string, readonly [number, number]>;
  /** Row count the bands are expressed in. */
  readonly totalRows?: number;
}

/**
 * Draws the player's current frame as terminal rows.
 *
 * The strip height is fixed to the rows any state can paint, computed once
 * from the pack's crop table. A strip that resized per state made the mascot
 * jump, so the height is constant and the art moves inside it.
 */
export class MascotComponent implements Component {
  private readonly player: MascotPlayer;
  private readonly pack: MascotPack | null;
  private readonly atlas: MascotAtlasRenderer | null;
  private readonly sixel: MascotSixelRenderer | null;
  private readonly firstRow: number;
  private readonly lastRow: number;
  private readonly bands: ReadonlyMap<string, readonly [number, number]>;
  private readonly totalRows: number;
  private column: number;
  private sink = 0;
  private mirrored = false;

  constructor(
    player: MascotPlayer,
    source: MascotPack | MascotAtlasRenderer | MascotSixelRenderer,
    options: MascotComponentOptions = {},
  ) {
    this.player = player;
    this.column = Math.max(0, options.column ?? 0);
    this.bands = options.bands ?? new Map();
    this.totalRows = options.totalRows ?? 8;
    if (source instanceof MascotSixelRenderer) {
      this.sixel = source;
      this.atlas = null;
      this.pack = null;
      this.firstRow = 0;
      this.lastRow = source.rows - 1;
      return;
    }
    this.sixel = null;
    if (source instanceof MascotAtlasRenderer) {
      this.atlas = source;
      this.pack = null;
      this.firstRow = 0;
      this.lastRow = source.height - 1;
      return;
    }
    this.atlas = null;
    this.pack = source;
    this.firstRow = 0;
    this.lastRow = source.cell[1] - 1;
  }

  /** True when frames are drawn as sixel images in the text grid. */
  get drawsSixel(): boolean {
    return this.sixel !== null;
  }

  /** True when this component draws real pixels rather than glyphs. */
  get usesImages(): boolean {
    return this.atlas !== null;
  }

  /** Escape that removes the on-screen placement, for teardown. */
  clearImage(): string {
    return this.atlas === null ? "" : this.atlas.clear();
  }

  /**
   * Rows this component reserves in the layout. For the image path that is one
   * row fewer than the sprite occupies, so it overlaps what sits below it.
   */
  get height(): number {
    const rows = this.lastRow - this.firstRow + 1;
    // One row fewer than the sprite box: the composer's border sits directly
    // below the strip, and the placement's last row is anchored onto it.
    // A sixel image is written into the grid, so it cannot overlap the border.
    return this.atlas === null ? rows : Math.max(1, rows - 1);
  }

  /** Columns the sprite occupies. */
  get width(): number {
    if (this.sixel !== null) return this.sixel.width;
    return this.atlas === null ? (this.pack as MascotPack).cell[0] : this.atlas.width;
  }

  /** Moves the sprite horizontally. */
  setColumn(column: number): void {
    this.column = Math.max(0, column);
  }

  /**
   * Hides `rows` from the bottom of the sprite so it sits behind the composer
   * bar. The strip keeps its height; the art moves down inside it.
   */
  /** Faces the sprite the other way, for travel against the drawn direction. */
  setMirrored(mirrored: boolean): void {
    this.mirrored = mirrored;
  }

  setSink(rows: number): void {
    // Full strip height means fully under: the sprite is not drawn at all.
    this.sink = Math.max(0, Math.min(this.height, Math.round(rows)));
  }

  render(width: number): string[] {
    if (this.player.state === null) return [];
    if (width < this.width) return [];
    const indentColumns = Math.min(this.column, Math.max(0, width - this.width));
    const state = this.player.state as string;
    const band = this.bands.get(`${state}.${this.player.segment}`) ?? this.bands.get(state);
    if (this.sixel !== null) {
      // Sixel pixels are written into the text grid, so the whole strip is
      // cleared and the frame drawn in one write, from the strip's last line:
      // the renderer writes lines top to bottom, so this runs after the lines
      // above it and nothing it draws is cleared again. The cursor is put back
      // where the renderer expects it.
      const lines: string[] = Array.from({ length: this.height }, () => "");
      let draw = "\x1b7";
      for (let row = 1; row < this.height; row += 1) draw += "\x1b[1A\r\x1b[2K";
      const image = this.sixel.frame(
        this.player.frameId(),
        this.sink,
        this.mirrored,
        this.player.bottomMargin ?? 0,
      );
      if (image !== "") {
        draw += `${this.sink > 0 ? `\x1b[${this.sink}B` : ""}\x1b[${indentColumns + 1}G${image}`;
      }
      lines[this.height - 1] = `${draw}\x1b8`;
      return lines;
    }
    if (this.atlas !== null) {
      const triple =
        band === undefined
          ? undefined
          : ([band[0], band[1], this.totalRows] as readonly [number, number, number]);
      if (this.sink >= this.height) {
        // Fully submerged. The placement has to be removed, not merely skipped,
        // or the terminal keeps drawing the last frame where it was.
        return [this.atlas.clear(), ...Array.from({ length: this.height - 1 }, () => "")];
      }
      const poseRows = this.atlas.rowsFor(triple, this.player.bottomMargin);
      // Bottom-aligned in the strip, then pushed down by the sink. A pose that
      // fits rests wholly on the bar; one taller than the strip dips into it by
      // exactly its excess; sinking moves the whole sprite down rather than
      // shortening it in place, which would read as shrinking, not diving.
      // With the pose's margin measured, its window ends half a row under it,
      // so the last row goes on the border row, where the line runs through
      // the middle; without it, the pose rests on the border's top edge.
      const onBorder = this.player.bottomMargin === undefined ? 0 : 1;
      const top = Math.min(
        this.height - 1,
        Math.max(0, this.height + onBorder - poseRows) + this.sink,
      );
      const lines = Array.from({ length: this.height }, () => "");
      lines[top] =
        `${" ".repeat(indentColumns)}${this.atlas.place(this.player.frameId(), triple, this.sink, this.mirrored, this.player.bottomMargin)}`;
      return lines;
    }
    const pack = this.pack as MascotPack;
    const frame = pack.frames[this.player.frameId()];
    if (frame === undefined) return [];
    const indent = " ".repeat(indentColumns);
    const first = band?.[0] ?? this.firstRow;
    const last = band?.[1] ?? this.lastRow;
    // Sinking hides rows from the bottom and pushes the rest down, and the
    // strip keeps its height whatever the sink: padding by the sink as well
    // as the pose's own room overran the strip once a pose sank further than
    // it was tall, and the composer below jumped down while it dove.
    const shownLast = last - this.sink;
    const shown = Math.max(0, shownLast - first + 1);
    const rows: string[] = Array.from({ length: Math.max(0, this.height - shown) }, () => "");
    for (let row = first; row <= shownLast; row += 1) {
      const painted = frame[row];
      rows.push(painted === undefined ? "" : `${indent}${painted}\x1b[0m`);
    }
    return rows.slice(-this.height);
  }
}
