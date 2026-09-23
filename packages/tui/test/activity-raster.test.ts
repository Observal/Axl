// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type ActivityInput,
  type ActivityRasterImage,
  TerminalExtensionHost,
} from "@axl/extension-api";

import { decodeOneKey } from "../src/editor.ts";
import {
  ActivitySurfaceHost,
  encodeSixel,
  normalizeActivityRasterPointer,
  PLAIN_PALETTE,
  prepareActivityRaster,
  scaleActivityRaster,
} from "../src/index.ts";

const image: ActivityRasterImage = {
  format: "indexed",
  width: 2,
  height: 6,
  palette: [
    { red: 0, green: 0, blue: 0 },
    { red: 255, green: 128, blue: 0 },
  ],
  pixels: Uint8Array.of(0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0),
  placement: { row: 1, column: 2, columns: 2, rows: 2 },
  description: "two-color fixture",
};

function monitor() {
  return {
    status: {
      operation: "idle" as const,
      activeToolCount: 0,
      queuedInput: { steer: 0, followUp: 0, interrupt: 0 },
    },
    connection: "connected" as const,
    recent: [],
    changes: [],
    changesAuthoritative: true,
  };
}

async function rendered(
  protocol: "sixel" | null,
  textOnly = false,
  cellPixels: { readonly width: number; readonly height: number } | null = {
    width: 1,
    height: 1,
  },
): Promise<readonly string[]> {
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.raster", name: "Raster", capabilities: ["terminal.activities"] },
      activate(api) {
        api.registerActivity({
          id: "test.raster.game",
          name: "Raster game",
          description: "Generic raster fixture",
          category: "game",
          create: () => ({
            render: () => ({
              lines: [
                [{ text: "header", style: "text" }],
                [{ text: "fallback", style: "text" }],
                [],
              ],
              images: [image],
            }),
            handleInput: () => false,
            pause: () => undefined,
            resume: () => undefined,
            serialize: () => undefined,
            dispose: () => undefined,
          }),
        });
      },
    },
  ]);
  await host.activate();
  const surface = new ActivitySurfaceHost({
    host,
    palette: () => PLAIN_PALETTE,
    invalidate: () => undefined,
    monitor,
    presentation: () => ({ reducedMotion: false, textOnly }),
    rasterProtocol: protocol,
    terminalCellPixels: () => cellPixels ?? undefined,
    returnToTranscript: () => undefined,
    returnToEditor: () => undefined,
    openWorkspaceReview: () => undefined,
    reportError: (error) => {
      throw error;
    },
  });
  surface.open("test.raster.game");
  const lines = surface.render(40, 24).lines;
  await surface.dispose();
  await host.dispose();
  return lines;
}

test("encodes indexed pixels as a bounded Sixel payload", () => {
  const encoded = encodeSixel(image);
  assert.ok(encoded.startsWith('\x1bPq"1;1;2;6'));
  assert.ok(encoded.endsWith("\x1b\\"));
  assert.match(encoded, /#0;2;0;0;0/);
  assert.match(encoded, /#1;2;100;50;0/);
  assert.equal(encoded.includes(image.description), false);
});

test("scales indexed pixels and normalizes pointers through the fitted image", () => {
  const square: ActivityRasterImage = {
    ...image,
    width: 4,
    height: 4,
    pixels: Uint8Array.of(0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0),
    placement: { row: 3, column: 5, columns: 8, rows: 4 },
  };
  const scaled = scaleActivityRaster(square, 8, 8);
  assert.equal(scaled.pixels.length, 64);
  assert.deepEqual([...scaled.pixels.slice(0, 8)], [0, 0, 0, 0, 1, 1, 1, 1]);

  for (const cellPixels of [
    { width: 10, height: 20 },
    { width: 12, height: 24 },
    { width: 9, height: 21 },
  ]) {
    const prepared = prepareActivityRaster(square, cellPixels);
    assert.equal(prepared.pixelWidth, prepared.pixelHeight, "square source must stay square");
    const topLeft = normalizeActivityRasterPointer(prepared, prepared.row, prepared.column);
    const bottomRight = normalizeActivityRasterPointer(
      prepared,
      prepared.row + Math.ceil(prepared.pixelHeight / cellPixels.height) - 1,
      prepared.column + Math.ceil(prepared.pixelWidth / cellPixels.width) - 1,
    );
    assert.deepEqual(topLeft, { kind: "image", row: 3, column: 5 });
    assert.deepEqual(bottomRight, { kind: "image", row: 6, column: 12 });
  }

  const windowsTerminalBoard = prepareActivityRaster(
    {
      ...square,
      width: 384,
      height: 384,
      pixels: new Uint8Array(384 * 384),
      placement: { row: 0, column: 0, columns: 32, rows: 16 },
    },
    { width: 10, height: 20 },
  );
  assert.equal(windowsTerminalBoard.pixelWidth, 320);
  assert.equal(windowsTerminalBoard.pixelHeight, 320);

  const inset = prepareActivityRaster(
    { ...square, placement: { row: 0, column: 0, columns: 12, rows: 4 } },
    { width: 10, height: 20 },
  );
  assert.equal(normalizeActivityRasterPointer(inset, 0, 0).kind, "margin");
  assert.equal(normalizeActivityRasterPointer(inset, 0, inset.column).kind, "image");
  assert.equal(normalizeActivityRasterPointer(inset, 5, 0).kind, "outside");
});

test("activity surface forwards clicks through its rendered raster geometry", async () => {
  const inputs: ActivityInput[] = [];
  const square: ActivityRasterImage = {
    format: "indexed",
    width: 8,
    height: 8,
    palette: [{ red: 0, green: 0, blue: 0 }],
    pixels: new Uint8Array(64),
    placement: { row: 4, column: 2, columns: 10, rows: 4 },
    description: "pointer fixture",
  };
  const host = new TerminalExtensionHost([
    {
      manifest: { id: "test.pointer", name: "Pointer", capabilities: ["terminal.activities"] },
      activate(api) {
        api.registerActivity({
          id: "test.pointer.game",
          name: "Pointer game",
          description: "Pointer fixture",
          category: "game",
          mouse: true,
          create: () => ({
            render: () => ({
              lines: Array.from({ length: 22 }, () => [{ text: "", style: "text" as const }]),
              images: [square],
            }),
            handleInput: (input) => {
              inputs.push(input);
              return true;
            },
            pause: () => undefined,
            resume: () => undefined,
            serialize: () => undefined,
            dispose: () => undefined,
          }),
        });
      },
    },
  ]);
  await host.activate();
  const surface = new ActivitySurfaceHost({
    host,
    palette: () => PLAIN_PALETTE,
    invalidate: () => undefined,
    monitor,
    presentation: () => ({ reducedMotion: false, textOnly: false }),
    rasterProtocol: "sixel",
    terminalCellPixels: () => ({ width: 9, height: 21 }),
    returnToTranscript: () => undefined,
    returnToEditor: () => undefined,
    openWorkspaceReview: () => undefined,
    reportError: (error) => assert.fail(error.message),
  });
  surface.open("test.pointer.game");
  surface.render(40, 24);
  const click = (localRow: number, localColumn: number): void => {
    surface.handleInput(`\x1b[<0;${localColumn + 1};${localRow + 2}M`, decodeOneKey);
  };

  click(4, 2);
  click(7, 10);
  click(4, 11);
  assert.deepEqual(
    inputs
      .filter((input): input is Extract<ActivityInput, { type: "mouse" }> => input.type === "mouse")
      .map(({ row, column }) => ({ row, column })),
    [
      { row: 4, column: 2 },
      { row: 7, column: 11 },
    ],
    "right-side fitted-image margin must not leak through to the activity",
  );
  await surface.dispose();
  await host.dispose();
});

test("activity surface overlays Sixel only with protocol and cell metrics", async () => {
  const sixel = await rendered("sixel");
  assert.equal(sixel.filter((line) => line.includes("\x1bPq")).length, 1);
  assert.ok(sixel.some((line) => line.includes("fallback")));
  assert.ok(sixel.at(-1)?.includes("\x1bPq"), "image must be emitted after every text row");
  assert.ok(sixel.at(-1)?.includes("A\x1b["));
  assert.ok(sixel.at(-1)?.includes("G\x1bPq"));
  for (const unsupported of [await rendered(null), await rendered("sixel", false, null)]) {
    assert.equal(
      unsupported.some((line) => line.includes("\x1bPq")),
      false,
    );
    assert.ok(unsupported.some((line) => line.includes("fallback")));
  }
  const textOnly = await rendered("sixel", true);
  assert.equal(
    textOnly.some((line) => line.includes("\x1bPq")),
    false,
  );
});
