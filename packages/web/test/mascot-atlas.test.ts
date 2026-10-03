// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseMascotManifest } from "@axl/sdk";

import { webPresentationCommands } from "../src/commands.ts";
import { frameRect, MASCOT_COLOURS, recolourPixels } from "../src/mascot-atlas.ts";

const manifestUrl = new URL("../src/mascot/axolotl.json", import.meta.url);
const manifest = parseMascotManifest(JSON.parse(await readFile(manifestUrl, "utf8")));

test("the web mascot assets are the terminal's assets", async () => {
  for (const name of ["axolotl.json", "atlas-Pink.png"]) {
    const web = await readFile(new URL(`../src/mascot/${name}`, import.meta.url));
    const tui = await readFile(new URL(`../../tui/assets/mascot/${name}`, import.meta.url));
    assert.ok(web.equals(tui), `${name} has drifted from packages/tui/assets/mascot`);
  }
});

test("the colours the web offers are the manifest's", () => {
  assert.deepEqual(MASCOT_COLOURS, manifest.colours);
});

test("a frame id picks its cell in the atlas grid", () => {
  const [width, height] = manifest.frameSize;
  assert.deepEqual(frameRect(manifest, 0), { x: 0, y: 0, width, height });
  const id = manifest.atlasColumns + 2;
  assert.deepEqual(frameRect(manifest, id), { x: 2 * width, y: height, width, height });
});

test("recolouring swaps the first palette for another colour's and keeps alpha", () => {
  const base = manifest.palettes?.[manifest.colours[0] as string] as readonly number[][];
  const purple = manifest.palettes?.Purple as readonly number[][];
  // The first entry whose colour differs between the two palettes.
  const index = base.findIndex(
    (entry, at) => entry.join() !== (purple[at] as number[]).join() && entry.join() !== "0,0,0",
  );
  const from = base[index] as number[];
  const to = purple[index] as number[];
  const pixels = new Uint8ClampedArray([from[0], from[1], from[2], 77, 1, 2, 3, 255] as number[]);
  recolourPixels(pixels, manifest, "Purple");
  assert.deepEqual([...pixels], [to[0], to[1], to[2], 77, 1, 2, 3, 255]);
  assert.throws(() => recolourPixels(pixels, manifest, "Green"), /not a mascot colour/);
});

test("/mascot is a presentation command that hands its argument to the app", () => {
  const seen: (string | undefined)[] = [];
  const commands = webPresentationCommands({
    canLogin: false,
    openNewSession: () => undefined,
    openProviders: () => undefined,
    openTheme: () => undefined,
    setTheme: () => undefined,
    toggleMascot: (argument) => seen.push(argument),
  });
  const mascot = commands.find((command) => command.name === "mascot");
  assert.ok(mascot);
  mascot.run();
  mascot.run("Purple");
  assert.deepEqual(seen, [undefined, "Purple"]);
});
