// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { MascotManifest } from "@axl/sdk";

type Rgb = readonly [number, number, number];

/** Where one frame sits in the atlas grid. */
export function frameRect(
  manifest: MascotManifest,
  frameId: number,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const [width, height] = manifest.frameSize;
  return {
    x: (frameId % manifest.atlasColumns) * width,
    y: Math.floor(frameId / manifest.atlasColumns) * height,
    width,
    height,
  };
}

/**
 * Moves RGBA pixels from the first colour's palette to another colour's,
 * entry for entry. Alpha is left alone, so the atlas's transparency survives.
 * Entries that share an RGB in the first palette cannot be told apart once
 * decoded, so the later entry's replacement wins.
 */
export function recolourPixels(
  pixels: Uint8ClampedArray,
  manifest: MascotManifest,
  colour: string,
): void {
  const base = manifest.palettes?.[manifest.colours[0] as string];
  const target = manifest.palettes?.[colour];
  if (!manifest.colours.includes(colour)) {
    throw new Error(`${colour} is not a mascot colour (${manifest.colours.join(", ")})`);
  }
  if (base === undefined || target === undefined) {
    throw new Error(`${colour} has no palette to draw it with`);
  }
  const swap = new Map<number, Rgb>();
  base.forEach((entry, index) => {
    swap.set((entry[0] << 16) | (entry[1] << 8) | entry[2], target[index] as Rgb);
  });
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const replacement = swap.get(
      ((pixels[offset] as number) << 16) |
        ((pixels[offset + 1] as number) << 8) |
        (pixels[offset + 2] as number),
    );
    if (replacement === undefined) continue;
    pixels[offset] = replacement[0];
    pixels[offset + 1] = replacement[1];
    pixels[offset + 2] = replacement[2];
  }
}
