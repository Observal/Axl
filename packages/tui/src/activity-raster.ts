// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { ActivityRasterImage } from "@axl/extension-api";

export type ActivityRasterProtocol = "sixel" | null;

export interface TerminalCellPixels {
  readonly width: number;
  readonly height: number;
}

export interface PreparedActivityRaster {
  readonly image: ActivityRasterImage;
  /** Cell position relative to the activity frame. */
  readonly row: number;
  readonly column: number;
  /** Exact encoded image dimensions in terminal pixels. */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly cellPixels: TerminalCellPixels;
  readonly placement: ActivityRasterImage["placement"];
}

const MAX_RENDERED_PIXELS = 1_048_576;

function percent(channel: number): number {
  return Math.round((channel * 100) / 255);
}

function appendRun(output: string[], value: number, length: number): void {
  const character = String.fromCharCode(63 + value);
  if (length >= 4) output.push(`!${length}${character}`);
  else output.push(character.repeat(length));
}

export function validTerminalCellPixels(
  value: TerminalCellPixels | undefined,
): value is TerminalCellPixels {
  return (
    value !== undefined &&
    Number.isSafeInteger(value.width) &&
    value.width > 0 &&
    value.width <= 4_096 &&
    Number.isSafeInteger(value.height) &&
    value.height > 0 &&
    value.height <= 4_096
  );
}

/** Nearest-neighbor scaling keeps indexed artwork and its bounded palette deterministic. */
export function scaleActivityRaster(
  image: ActivityRasterImage,
  width: number,
  height: number,
): ActivityRasterImage {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0)
    throw new RangeError("Activity raster output dimensions must be positive safe integers");
  if (width * height > MAX_RENDERED_PIXELS)
    throw new RangeError("Activity raster output exceeds the pixel bound");
  if (width === image.width && height === image.height) return image;

  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      pixels[y * width + x] = image.pixels[sourceY * image.width + sourceX] as number;
    }
  }
  return Object.freeze({ ...image, width, height, pixels });
}

/** Fits an image to its declared cell region while preserving its pixel aspect ratio. */
export function prepareActivityRaster(
  image: ActivityRasterImage,
  cellPixels: TerminalCellPixels,
): PreparedActivityRaster {
  if (!validTerminalCellPixels(cellPixels))
    throw new RangeError("Invalid terminal cell dimensions");
  const availableWidth = image.placement.columns * cellPixels.width;
  const availableHeight = image.placement.rows * cellPixels.height;
  const boundedScale = Math.sqrt(MAX_RENDERED_PIXELS / (image.width * image.height));
  const scale = Math.min(
    availableWidth / image.width,
    availableHeight / image.height,
    boundedScale,
  );
  let pixelWidth = Math.max(1, Math.floor(image.width * scale));
  let pixelHeight = Math.max(1, Math.floor(image.height * scale));
  if (image.width === image.height) {
    const maximumSide = Math.min(pixelWidth, pixelHeight);
    const alignedSide = Math.floor(maximumSide / 8) * 8;
    if (alignedSide > 0) {
      pixelWidth = alignedSide;
      pixelHeight = alignedSide;
    }
  }
  const occupiedColumns = Math.ceil(pixelWidth / cellPixels.width);
  const occupiedRows = Math.ceil(pixelHeight / cellPixels.height);
  const column =
    image.placement.column + Math.floor((image.placement.columns - occupiedColumns) / 2);
  const row = image.placement.row + Math.floor((image.placement.rows - occupiedRows) / 2);
  return Object.freeze({
    image: scaleActivityRaster(image, pixelWidth, pixelHeight),
    row,
    column,
    pixelWidth,
    pixelHeight,
    cellPixels: Object.freeze({ ...cellPixels }),
    placement: image.placement,
  });
}

export type NormalizedRasterPointer =
  | { readonly kind: "outside" }
  | { readonly kind: "margin" }
  | { readonly kind: "image"; readonly row: number; readonly column: number };

/** Maps cell-granularity mouse input through the same fitted image rectangle used for output. */
export function normalizeActivityRasterPointer(
  raster: PreparedActivityRaster,
  row: number,
  column: number,
): NormalizedRasterPointer {
  const reserved = raster.placement;
  if (
    row < reserved.row ||
    row >= reserved.row + reserved.rows ||
    column < reserved.column ||
    column >= reserved.column + reserved.columns
  )
    return { kind: "outside" };

  const cellLeft = (column - raster.column) * raster.cellPixels.width;
  const cellTop = (row - raster.row) * raster.cellPixels.height;
  const cellRight = cellLeft + raster.cellPixels.width;
  const cellBottom = cellTop + raster.cellPixels.height;
  if (
    cellRight <= 0 ||
    cellLeft >= raster.pixelWidth ||
    cellBottom <= 0 ||
    cellTop >= raster.pixelHeight
  )
    return { kind: "margin" };
  const pixelX = Math.max(
    0,
    Math.min(raster.pixelWidth - 1, cellLeft + raster.cellPixels.width / 2),
  );
  const pixelY = Math.max(
    0,
    Math.min(raster.pixelHeight - 1, cellTop + raster.cellPixels.height / 2),
  );

  return {
    kind: "image",
    column:
      reserved.column +
      Math.min(reserved.columns - 1, Math.floor((pixelX * reserved.columns) / raster.pixelWidth)),
    row:
      reserved.row +
      Math.min(reserved.rows - 1, Math.floor((pixelY * reserved.rows) / raster.pixelHeight)),
  };
}

/** Encodes a validated indexed activity image without accepting terminal controls from extensions. */
export function encodeSixel(image: ActivityRasterImage): string {
  const output = ["\x1bPq", `"1;1;${image.width};${image.height}`];
  for (const [index, color] of image.palette.entries()) {
    output.push(`#${index};2;${percent(color.red)};${percent(color.green)};${percent(color.blue)}`);
  }
  for (let top = 0; top < image.height; top += 6) {
    for (let color = 0; color < image.palette.length; color += 1) {
      const columns: number[] = [];
      let lastVisible = -1;
      for (let x = 0; x < image.width; x += 1) {
        let bits = 0;
        for (let offset = 0; offset < 6; offset += 1) {
          const y = top + offset;
          if (y < image.height && image.pixels[y * image.width + x] === color) bits |= 1 << offset;
        }
        columns.push(bits);
        if (bits !== 0) lastVisible = x;
      }
      if (lastVisible < 0) continue;
      output.push(`#${color}`);
      let start = 0;
      while (start <= lastVisible) {
        let end = start + 1;
        while (end <= lastVisible && columns[end] === columns[start]) end += 1;
        appendRun(output, columns[start] as number, end - start);
        start = end;
      }
      output.push("$");
    }
    output.push("-");
  }
  output.push("\x1b\\");
  return output.join("");
}

/**
 * Anchors an image after an already padded row. Saving and restoring the cursor
 * keeps the ordinary line compositor authoritative for subsequent rows.
 */
export function activityRasterSequence(
  image: ActivityRasterImage,
  rowsUp: number,
  terminalColumn: number,
  protocol: ActivityRasterProtocol,
): string {
  if (protocol === null) return "";
  const moveUp = Math.max(0, rowsUp);
  const column = Math.max(0, terminalColumn);
  return `\x1b7${moveUp > 0 ? `\x1b[${moveUp}A` : ""}\x1b[${column + 1}G${encodeSixel(image)}\x1b8`;
}
