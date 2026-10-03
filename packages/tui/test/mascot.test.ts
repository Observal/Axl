// SPDX-FileCopyrightText: 2026 Dheirav
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { crc32 } from "node:zlib";

import type { CanonicalEvent } from "@axl/protocol";
import { decodeOneKey } from "../src/editor.ts";
import {
  loadMascotAssets,
  loadMascotAtlas,
  loadMascotAtlasMirrored,
  MascotActor,
  MascotComponent,
  MascotDirector,
  MascotManifestError,
  MascotPackError,
  MascotPlayer,
  packSegmentRows,
  parseMascotManifest,
  parseMascotPack,
} from "../src/index.ts";
import {
  MascotAtlasRenderer,
  nearest256,
  packTo256,
  recolourPng,
  recolourText,
} from "../src/mascot-render.ts";
import { decodeIndexedPng, encodeMascotSixel, MascotSixelRenderer } from "../src/mascot-sixel.ts";
import { detectTruecolour } from "../src/media.ts";
import { stripAnsi } from "../src/render.ts";

// Keep a developer's own ~/.axl/mascot atlases out of these tests: point the
// override directory at an empty one for the whole file.
let emptyAssets = "";
let previousAssets: string | undefined;
before(async () => {
  previousAssets = process.env.AXL_MASCOT_ASSETS;
  emptyAssets = await mkdtemp(join(tmpdir(), "axl-mascot-empty-"));
  process.env.AXL_MASCOT_ASSETS = emptyAssets;
});
after(async () => {
  if (previousAssets === undefined) delete process.env.AXL_MASCOT_ASSETS;
  else process.env.AXL_MASCOT_ASSETS = previousAssets;
  await rm(emptyAssets, { recursive: true, force: true });
});

const MANIFEST = parseMascotManifest({
  frame_size: [32, 32],
  atlas_columns: 12,
  atlas: "atlas-{colour}.png",
  colours: ["Pink", "Blue"],
  states: {
    waiting: {
      kind: "loop",
      next: null,
      segments: { loop: { frames: [10, 11], durations: [100, 100] } },
    },
    idle: { kind: "loop", next: null, segments: { loop: { frames: [20], durations: [100] } } },
    typing: {
      kind: "loop",
      next: null,
      segments: { loop: { frames: [30, 31], durations: [100, 100] } },
    },
    working: {
      kind: "loop",
      next: null,
      segments: {
        in: { frames: [40], durations: [100] },
        loop: { frames: [41, 42], durations: [100, 100] },
      },
    },
    compact: {
      kind: "loop",
      next: null,
      segments: {
        in: { frames: [50], durations: [100] },
        loop: { frames: [51], durations: [100] },
        out: { frames: [52], durations: [100] },
      },
    },
    waking: {
      kind: "transition",
      next: "waiting",
      segments: { in: { frames: [60], durations: [100] } },
    },
    success: {
      kind: "oneshot",
      next: "waiting",
      segments: { in: { frames: [70], durations: [100] } },
    },
    file_change: {
      kind: "oneshot",
      next: "working",
      segments: { in: { frames: [80], durations: [100] } },
    },
    error: {
      kind: "transition",
      next: "severed",
      segments: { in: { frames: [90], durations: [100] } },
    },
    severed: { kind: "loop", next: null, segments: { loop: { frames: [91], durations: [100] } } },
    dead: { kind: "loop", next: null, segments: { loop: { frames: [92], durations: [100] } } },
    ask: {
      kind: "loop",
      next: null,
      segments: {
        in: { frames: [100], durations: [100] },
        loop: { frames: [101], durations: [100] },
      },
    },
    blocked: {
      kind: "oneshot",
      next: "waiting",
      segments: { in: { frames: [110], durations: [100] } },
    },
    nod: {
      kind: "oneshot",
      next: "working",
      segments: { in: { frames: [120], durations: [100] } },
    },
  },
});

function player(): MascotPlayer {
  return new MascotPlayer(MANIFEST);
}

function event<Type extends CanonicalEvent["type"]>(type: Type, payload: unknown): CanonicalEvent {
  return { type, payload } as unknown as CanonicalEvent;
}

test("plays in once and then holds the loop", () => {
  const mascot = player();
  mascot.play("working");
  assert.equal(mascot.frameId(), 40);
  assert.equal(mascot.segment, "in");

  assert.equal(mascot.tick(0), false, "the first tick starts the frame");
  assert.equal(mascot.tick(100), true);
  assert.equal(mascot.segment, "loop");
  assert.equal(mascot.frameId(), 41);

  mascot.tick(200);
  assert.equal(mascot.frameId(), 42);
  mascot.tick(300);
  assert.equal(mascot.frameId(), 41, "loop repeats rather than ending");
});

test("a graceful switch finishes the loop, plays out, then enters the pending state", () => {
  const mascot = player();
  mascot.play("compact");
  mascot.tick(0);
  mascot.tick(100);
  assert.equal(mascot.segment, "loop");

  mascot.play("waiting", { graceful: true });
  assert.equal(mascot.state, "compact", "the switch waits for the loop to finish");
  assert.equal(mascot.queued, "waiting");

  mascot.tick(200);
  assert.equal(mascot.segment, "out", "out plays before leaving");
  assert.equal(mascot.frameId(), 52);

  mascot.tick(300);
  assert.equal(mascot.state, "waiting");
  assert.equal(mascot.queued, null);
});

test("an interrupt cuts immediately instead of waiting for the loop", () => {
  const mascot = player();
  mascot.play("working");
  mascot.tick(0);
  mascot.tick(100);
  mascot.play("error");
  assert.equal(mascot.state, "error", "a hard cut does not wait for the loop cycle");
  assert.equal(mascot.frameId(), 90);
});

test("a transition hands off to its next state", () => {
  const mascot = player();
  mascot.play("waking");
  assert.equal(mascot.frameId(), 60);
  mascot.tick(0);
  mascot.tick(100);
  assert.equal(mascot.state, "waiting");
});

test("a oneshot hands off to its next state", () => {
  const mascot = player();
  mascot.play("success");
  mascot.tick(0);
  mascot.tick(100);
  assert.equal(mascot.state, "waiting");
});

const withState = (state: unknown) => ({
  frame_size: [32, 32],
  atlas_columns: 12,
  atlas: "a.png",
  colours: ["Pink"],
  states: { a: state },
});

test("a user's own atlas replaces the bundled one, and a missing one falls through", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axl-mascot-"));
  const previous = process.env.AXL_MASCOT_ASSETS;
  process.env.AXL_MASCOT_ASSETS = dir;
  try {
    const { manifest } = await loadMascotAssets("Pink");
    // Nothing there yet: the bundled art answers, recoloured for Albino.
    const bundled = await loadMascotAtlas("Albino", manifest);
    assert.ok(bundled.length > 0);

    await writeFile(join(dir, "atlas-Albino.png"), Buffer.from([1, 2, 3, 4]));
    const own = await loadMascotAtlas("Albino", manifest);
    assert.equal(own.length, 4, "the user's file, not the bundled atlas");
    assert.deepEqual(Array.from(own), [1, 2, 3, 4]);

    // Only the overridden colour is redirected.
    const other = await loadMascotAtlas("Pink", manifest);
    assert.ok(other.length > 4);

    // Its facing is not taken from the bundled mirror, which is other art.
    // Compared by length first: a failing deepEqual on a whole atlas builds a
    // diff of every byte, which ran a test process out of memory.
    const noMirror = await loadMascotAtlasMirrored("Albino", manifest);
    assert.ok(noMirror === undefined, `no mirror, got ${noMirror?.length} bytes`);
    await writeFile(join(dir, "atlas-Albino-mirrored.png"), Buffer.from([5, 6]));
    const ownMirror = await loadMascotAtlasMirrored("Albino", manifest);
    assert.equal(ownMirror?.length, 2);
    assert.deepEqual(Array.from(ownMirror ?? []), [5, 6]);
    assert.ok(((await loadMascotAtlasMirrored("Pink", manifest)) ?? []).length > 4);
  } finally {
    if (previous === undefined) delete process.env.AXL_MASCOT_ASSETS;
    else process.env.AXL_MASCOT_ASSETS = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the glyph strip keeps its height at every sink, so the composer never moves", async () => {
  const { manifest, pack } = await loadMascotAssets("Pink");
  const bands = packSegmentRows(pack, manifest);
  for (const state of Object.keys(manifest.states)) {
    const mascot = new MascotPlayer(manifest);
    mascot.play(state);
    mascot.tick(0);
    const component = new MascotComponent(mascot, pack, {
      column: 2,
      bands,
      totalRows: pack.cell[1],
    });
    for (let sink = 0; sink <= component.height; sink += 1) {
      component.setSink(sink);
      assert.equal(component.render(100).length, component.height, `${state} sunk ${sink} rows`);
    }
  }
});

test("the text pack is half blocks, drawable in any font", async () => {
  const { pack } = await loadMascotAssets("Pink");
  assert.equal(pack.encoding, "halfblock");
  const glyphs = new Set(pack.frames.flatMap((rows) => rows.flatMap((row) => [...stripAnsi(row)])));
  assert.deepEqual([...glyphs].sort(), [" ", "▀", "▄"].sort(), "only spaces and half blocks");
});

test("without 24-bit colour the pack is drawn in the nearest of the 256 colours", async () => {
  assert.equal(nearest256(255, 0, 0), 196);
  assert.equal(nearest256(255, 255, 255), 231);
  assert.equal(nearest256(0, 0, 0), 16);
  assert.equal(nearest256(128, 128, 128), 244, "a grey takes the grey ramp");
  const { pack } = await loadMascotAssets("Pink");
  const reduced = packTo256(pack);
  const text = reduced.frames.flat().join("");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pack is escape sequences
  assert.doesNotMatch(text, /\x1b\[(38|48);2;/, "no 24-bit colour left");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pack is escape sequences
  assert.match(text, /\x1b\[38;5;\d+m/);
  assert.deepEqual(
    reduced.frames.map((rows) => rows.map((row) => stripAnsi(row))),
    pack.frames.map((rows) => rows.map((row) => stripAnsi(row))),
    "the same glyphs, only the colours change",
  );

  assert.equal(detectTruecolour({ COLORTERM: "truecolor" }), true);
  assert.equal(detectTruecolour({ WT_SESSION: "1" }), true);
  assert.equal(detectTruecolour({ TERM_PROGRAM: "vscode" }), true);
  assert.equal(detectTruecolour({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }), false);
  assert.equal(detectTruecolour({}), false);
});

test("the terminal's answers about sixel are read as reports, not typed", () => {
  assert.deepEqual(decodeOneKey("\x1b[?61;4;6;7;14c", 0), {
    key: { kind: "device-attributes", features: [61, 4, 6, 7, 14] },
    next: 15,
  });
  assert.deepEqual(decodeOneKey("\x1b[6;20;10t", 0), {
    key: { kind: "cell-size", height: 20, width: 10 },
    next: 10,
  });
});

test("sixel draws the atlas's own pixels in the atlas's palette", async () => {
  const { manifest } = await loadMascotAssets("Pink");
  const png = await loadMascotAtlas("Pink", manifest);
  const atlas = decodeIndexedPng(png);
  assert.deepEqual([atlas.width, atlas.height], [1752, 5850]);
  assert.ok(atlas.transparent.has(0), "index 0 is the transparent one");

  // a 2 by 7 image: one colour on the top row, another in the band below
  const tiny = encodeMascotSixel(
    2,
    7,
    (x, y) => (y === 0 ? 1 : y === 6 && x === 1 ? 2 : undefined),
    [
      [0, 0, 0],
      [255, 0, 0],
      [0, 0, 255],
    ],
  );
  assert.equal(tiny, '\x1bP0;1;0q"1;1;2;7#1;2;100;0;0#2;2;0;0;100#1@@-#2?@-\x1b\\');

  const purple = await loadMascotAtlas("Purple", manifest);
  const renderer = new MascotSixelRenderer(purple, manifest, { width: 10, height: 20 });
  assert.equal(renderer.width, 12, "four rows of 20 px, at the frame's aspect, in 10 px columns");
  const frame = manifest.states.waiting?.segments.loop?.frames[0] as number;
  assert.ok(
    renderer.frame(frame).startsWith('\x1bP0;1;0q"1;1;117;80#'),
    "80 px tall, at its aspect",
  );
  assert.match(renderer.frame(frame, 1), /"1;1;117;60#/, "sunk a row, its bottom is cropped");
  assert.equal(renderer.frame(frame, 4), "", "sunk out of sight, nothing is drawn");
  assert.notEqual(renderer.frame(frame, 0, true), renderer.frame(frame));
  const moved = renderer.frame(frame, 0, false, 30);
  assert.ok(moved.startsWith('\x1bP0;1;0q"1;1;117;80#'), "moved down inside the same strip");
  assert.notEqual(moved, renderer.frame(frame), "the art sits lower by its clear space");
  // every colour register it sets is Purple's entry at that index
  const registers = [...renderer.frame(frame).matchAll(/#(\d+);2;(\d+);(\d+);(\d+)/g)];
  assert.ok(registers.length > 3);
  for (const [, index, ...rgb] of registers) {
    const entry = manifest.palettes?.Purple?.[Number(index)] as readonly number[];
    assert.deepEqual(
      rgb.map(Number),
      entry.map((part) => Math.round((part * 100) / 255)),
      `register ${index}`,
    );
  }

  // A user's own atlas keeps its own colours, as the Kitty path draws it.
  const own = recolourPng(
    png,
    (manifest.palettes?.Pink ?? []).map(() => [1, 2, 3] as const),
  );
  const ownFrame = new MascotSixelRenderer(own, manifest, { width: 10, height: 20 }).frame(frame);
  for (const [, , ...rgb] of ownFrame.matchAll(/#(\d+);2;(\d+);(\d+);(\d+)/g)) {
    assert.deepEqual(rgb.map(Number), [0, 1, 1], "the atlas's colour, not the manifest's");
  }

  const mascot = new MascotPlayer(manifest);
  mascot.play("waiting");
  mascot.tick(0);
  const component = new MascotComponent(mascot, renderer, { column: 3 });
  const lines = component.render(100);
  assert.equal(lines.length, 4, "the strip is the sixel's four rows");
  assert.deepEqual(lines.slice(0, 3), ["", "", ""]);
  const last = lines[3] as string;
  assert.ok(last.startsWith("\x1b7") && last.endsWith("\x1b8"), "the cursor is put back");
  assert.equal(last.split("\x1b[1A\r\x1b[2K").length - 1, 3, "the rows above are cleared first");
  assert.ok(last.includes("\x1b[4G\x1bP"), "then the frame is drawn at its column");
});

test("every colour is drawn from one atlas by swapping its palette", async () => {
  const { manifest, pack: base } = await loadMascotAssets("Pink");
  assert.deepEqual(manifest.colours, ["Pink", "Albino", "Purple", "Deep_Sea"]);
  const pink = await loadMascotAtlas("Pink", manifest);
  const chunk = (png: Uint8Array, wanted: string) => {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    for (let offset = 8; offset + 12 <= png.length; ) {
      const length = view.getUint32(offset);
      const type = Buffer.from(png.subarray(offset + 4, offset + 8)).toString("latin1");
      if (type === wanted) {
        return {
          data: png.subarray(offset + 8, offset + 8 + length),
          crc: view.getUint32(offset + 8 + length),
          whole: png.subarray(offset + 4, offset + 8 + length),
        };
      }
      offset += 12 + length;
    }
    return undefined;
  };
  for (const colour of manifest.colours) {
    const png = await loadMascotAtlas(colour, manifest);
    const { pack } = await loadMascotAssets(colour);
    assert.equal(pack.frames.length, base.frames.length, `${colour}: the same frames`);
    assert.equal(png.length, pink.length, `${colour}: only the palette differs`);
    const palette = chunk(png, "PLTE");
    assert.ok(palette !== undefined, `${colour}: an indexed PNG`);
    assert.equal(palette.crc, crc32(palette.whole), `${colour}: the palette's checksum is right`);
    assert.deepEqual(Array.from(palette.data), manifest.palettes?.[colour]?.flat(), colour);
    assert.deepEqual(
      chunk(png, "tRNS")?.data,
      chunk(pink, "tRNS")?.data,
      `${colour}: transparency kept`,
    );
    assert.deepEqual(
      chunk(png, "IDAT")?.data,
      chunk(pink, "IDAT")?.data,
      `${colour}: pixels untouched`,
    );
  }
  const purple = await loadMascotAtlas("Purple", manifest);
  assert.notDeepEqual(
    Array.from(chunk(purple, "PLTE")?.data ?? []),
    Array.from(chunk(pink, "PLTE")?.data ?? []),
  );

  const swap = new Map([["1;2;3", "9;8;7"]]);
  assert.equal(
    recolourText('"\\u001b[38;2;1;2;3m\\u001b[48;2;1;2;3m\\u001b[38;2;4;5;6m"', swap),
    '"\\u001b[38;2;9;8;7m\\u001b[48;2;9;8;7m\\u001b[38;2;4;5;6m"',
  );
  await assert.rejects(loadMascotAtlas("Purple"), /no atlas and no palette/);
  assert.throws(() => recolourPng(new Uint8Array(16), [[0, 0, 0]]), /not an indexed PNG/);
  for (const [palettes, field] of [
    [{ Teal: [[0, 0, 0]] }, /palettes.Teal/],
    [{ Pink: [[0, 0, 256]] }, /palettes.Pink\[0\]/],
    [
      {
        Pink: [[0, 0, 0]],
        Blue: [
          [0, 0, 0],
          [1, 1, 1],
        ],
      },
      /palettes.Blue/,
    ],
  ] as const) {
    assert.throws(
      () =>
        parseMascotManifest({
          ...withState({
            kind: "loop",
            next: null,
            segments: { loop: { frames: [0], durations: [100] } },
          }),
          colours: ["Pink", "Blue"],
          palettes,
        }),
      field,
    );
  }
});

test("a state's top margin is read from the manifest, not transcribed in the renderer", () => {
  const segments = { loop: { frames: [1], durations: [100] } };
  const parsed = parseMascotManifest(
    withState({ kind: "loop", next: null, top_margin: 3, segments }),
  );
  assert.equal(parsed.states.a?.topMargin, 3);

  // Manifests built before the pipeline measured this have no margin at all,
  // which is the safe reading: it clamps every lift to zero rather than
  // cropping a pose by guessing.
  const older = parseMascotManifest(withState({ kind: "loop", next: null, segments }));
  assert.equal(older.states.a?.topMargin, 0);

  for (const bad of [-1, 1.5, "3", null]) {
    assert.throws(
      () => parseMascotManifest(withState({ kind: "loop", next: null, top_margin: bad, segments })),
      MascotManifestError,
      `top_margin ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("every state is drawn at one scale, however many rows its pose spans", () => {
  const renderer = new MascotAtlasRenderer(
    new Uint8Array(),
    parseMascotManifest({
      ...withState({
        kind: "loop",
        next: null,
        segments: { loop: { frames: [0], durations: [100] } },
      }),
      frame_size: [219, 150],
    }),
  );
  const scale = (band: readonly [number, number, number], sink = 0) => {
    const m = /h=(\d+),c=(\d+),r=(\d+)/.exec(renderer.place(0, band, sink)) as RegExpExecArray;
    const [h, c, r] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return { rowsPerPixel: r / h, columnsPerPixel: c / 219, rows: r };
  };
  const full = scale([0, 7, 8]);
  // Shares of 7/8, 5/8 and 4/8 used to round to rows the source did not fill,
  // which stretched those poses. Every band now keeps the full frame's scale.
  for (const band of [
    [1, 7, 8],
    [3, 7, 8],
    [2, 7, 8],
    [4, 7, 8],
  ] as const) {
    const s = scale(band);
    assert.ok(Math.abs(s.rowsPerPixel / full.rowsPerPixel - 1) < 0.02, `band ${band} rows`);
    assert.ok(Math.abs(s.columnsPerPixel / full.columnsPerPixel - 1) < 0.1, `band ${band} columns`);
  }
  // Rounding goes up, so a pose is never cropped to fit its rows.
  assert.equal(scale([3, 7, 8]).rows, 3);
  // Diving under the bar drops rows without changing the scale either.
  const sunk = scale([0, 7, 8], 2);
  assert.equal(sunk.rows, 2);
  assert.ok(Math.abs(sunk.rowsPerPixel / full.rowsPerPixel - 1) < 0.02);
});

test("a pose's lowest pixel lands on the composer's line", () => {
  const manifest = parseMascotManifest({
    ...withState({
      kind: "loop",
      next: null,
      segments: { loop: { frames: [0], durations: [100], bottom_margin: 20 } },
    }),
    frame_size: [64, 64],
  });
  assert.equal(manifest.states.a?.segments.loop?.bottomMargin, 20);
  const renderer = new MascotAtlasRenderer(new Uint8Array(), manifest);
  const placed = (sink: number, bottomMargin?: number) => {
    const m = /y=(\d+),w=\d+,h=(\d+),c=\d+,r=(\d+),z=(-?\d+)/.exec(
      renderer.place(0, [2, 5, 8], sink, false, bottomMargin),
    ) as RegExpExecArray;
    return { y: Number(m[1]), h: Number(m[2]), rows: Number(m[3]), z: Number(m[4]) };
  };
  // 16 px rows. The pose ends at 44, so the window ends half a row lower, at
  // 52, which puts 44 in the middle of the last row: the border's line.
  const onLine = placed(0, 20);
  assert.deepEqual([onLine.y + onLine.h, onLine.rows], [52, 3]);
  assert.ok(onLine.z > -1073741824, "drawn over the border's background, under its text");
  assert.ok(placed(1, 20).z < -1073741824, "diving, the border hides it again");
  // Without a measured margin it ends where the text pack says, as before.
  const unmeasured = placed(0);
  assert.equal(unmeasured.y + unmeasured.h, 48);
  assert.ok(unmeasured.z < -1073741824);
  assert.throws(
    () =>
      parseMascotManifest({
        ...withState({
          kind: "loop",
          next: null,
          segments: { loop: { frames: [0], durations: [100], bottom_margin: -1 } },
        }),
      }),
    /bottom_margin/,
  );
});

test("the manifest rejects malformed input rather than drawing the wrong frame", () => {
  assert.throws(
    () =>
      parseMascotManifest({
        ...MANIFEST,
        states: { bad: { kind: "spin", next: null, segments: {} } },
      }),
    MascotManifestError,
  );
  assert.throws(
    () =>
      parseMascotManifest({
        frame_size: [32, 32],
        atlas_columns: 12,
        atlas: "a.png",
        colours: ["Pink"],
        states: {
          a: { kind: "loop", next: null, segments: { loop: { frames: [1, 2], durations: [100] } } },
        },
      }),
    MascotManifestError,
    "a duration per frame is required",
  );
  assert.throws(
    () =>
      parseMascotManifest({
        frame_size: [32, 32],
        atlas_columns: 12,
        atlas: "a.png",
        colours: ["Pink"],
        states: {
          a: {
            kind: "oneshot",
            next: "nowhere",
            segments: { in: { frames: [1], durations: [100] } },
          },
        },
      }),
    MascotManifestError,
    "next must name a real state",
  );
});

test("typing takes over an idle mascot but never takes over running work", () => {
  const mascot = player();
  const director = new MascotDirector(mascot);
  mascot.play("waiting");
  director.keystroke(0);
  assert.equal(mascot.state, "typing");

  mascot.play("working");
  director.keystroke(100);
  assert.equal(
    mascot.state,
    "working",
    "what the harness is doing outranks what the user is doing",
  );
});

test("typing releases after the last keystroke", () => {
  const mascot = player();
  const director = new MascotDirector(mascot);
  mascot.play("waiting");
  director.keystroke(0);

  assert.equal(director.tick(500), false);
  assert.equal(mascot.state, "typing");
  assert.equal(director.tick(600), true);
  assert.equal(mascot.state, "waiting");
});

test("a burst of edits fires one file_change", () => {
  const mascot = player();
  const director = new MascotDirector(mascot);
  const write = event("tool.call", { callId: "1", name: "write", input: {} });

  director.handleEvent(write, 0);
  assert.equal(mascot.state, "file_change");
  mascot.play("working");

  director.handleEvent(write, 300);
  assert.equal(mascot.state, "working", "edits inside the burst window are coalesced");
  director.handleEvent(write, 800);
  assert.equal(mascot.state, "file_change", "a later edit starts a new burst");
});

test("assistant stop reasons choose the ending", () => {
  const cases: readonly [string, string][] = [
    ["stop", "success"],
    ["error", "error"],
    ["aborted", "dead"],
    ["tool_use", "working"],
  ];
  for (const [stopReason, expected] of cases) {
    const mascot = player();
    const director = new MascotDirector(mascot);
    mascot.play("waiting");
    director.handleEvent(event("assistant.message", { content: [], stopReason }), 0);
    assert.equal(mascot.state, expected, `${stopReason} should show ${expected}`);
  }
});

test("a request for the user holds ask until it is answered", () => {
  for (const [requested, resolved] of [
    ["permission.requested", "permission.resolved"],
    ["interaction.requested", "interaction.resolved"],
  ] as const) {
    const mascot = player();
    const director = new MascotDirector(mascot);
    mascot.play("working");
    director.handleEvent(event(requested, {}), 0);
    assert.equal(mascot.state, "ask");
    mascot.tick(0);
    mascot.tick(1000);
    assert.equal(mascot.state, "ask", `${requested} holds until answered`);
    director.handleEvent(event(resolved, {}), 1000);
    assert.equal(mascot.state, "working", `${resolved} goes back to the work`);
  }
});

test("compaction ending late leaves a state that took over in the meantime", () => {
  const mascot = player();
  const director = new MascotDirector(mascot);
  director.compactionStarted();
  assert.equal(mascot.state, "compact");
  director.handleEvent(event("session.error", {}), 0);
  const during = mascot.state;
  assert.notEqual(during, "compact");
  director.compactionFinished();
  assert.equal(mascot.state, during, "the error is not replaced by waiting");

  director.compactionStarted();
  director.compactionFinished();
  for (let now = 0; now <= 5_000; now += 50) mascot.tick(now);
  assert.equal(mascot.state, "waiting", "a compaction still showing leaves to waiting");
});

test("an answer only ends ask, it does not interrupt anything else", () => {
  const mascot = player();
  const director = new MascotDirector(mascot);
  mascot.play("file_change");
  director.handleEvent(event("permission.resolved", {}), 0);
  assert.equal(mascot.state, "file_change");
});

test("a sandbox violation plays blocked and a queued message plays nod", () => {
  const mascot = player();
  const director = new MascotDirector(mascot);
  mascot.play("working");
  director.handleEvent(event("sandbox.violation", { capability: "fs.write", reason: "denied" }), 0);
  assert.equal(mascot.state, "blocked");
  director.handleEvent(event("queue.enqueued", {}), 0);
  assert.equal(mascot.state, "nod");
});

const PACK = parseMascotPack({
  cell: [4, 3],
  encoding: "sextant",
  pixels: 24,
  frames: [
    ["a", "b", "c"],
    ["d", "e", "f"],
    ["g", "h", "i"],
    ...Array.from({ length: 90 }, () => ["x", "y", "z"]),
  ],
  crop: { waiting: [1, 2] },
  crop_seg: { "waiting.loop": [1, 2] },
});

test("the pack rejects a frame whose row count does not match the cell", () => {
  assert.throws(
    () =>
      parseMascotPack({
        cell: [4, 3],
        encoding: "sextant",
        pixels: 24,
        frames: [["a", "b"]],
        crop: {},
        crop_seg: {},
      }),
    MascotPackError,
  );
});

test("the strip height is fixed so the mascot never resizes the layout", () => {
  const mascot = player();
  const view = new MascotComponent(mascot, PACK, { column: 1 });
  assert.equal(view.height, 3, "the strip is the pack's full height");

  mascot.play("waiting");
  const waiting = view.render(40);
  mascot.play("working");
  const working = view.render(40);
  assert.equal(waiting.length, working.length, "every state occupies the same rows");
  assert.equal(waiting.length, view.height);
});

test("a state that paints no low rows is pushed down so it rests on the bar", () => {
  // `short` paints only its top row; without bottom alignment that leaves dead
  // space between the sprite and whatever sits below the strip.
  const short = parseMascotPack({
    cell: [4, 3],
    encoding: "sextant",
    pixels: 24,
    frames: Array.from({ length: 93 }, () => ["a", "", ""]),
    crop: {},
    crop_seg: {},
  });
  const mascot = player();
  const view = new MascotComponent(mascot, short, {
    bands: new Map([["waiting", [0, 0] as const]]),
    totalRows: 3,
  });
  mascot.play("waiting");
  const rows = view.render(40);
  assert.equal(rows.length, 3, "the strip keeps its height");
  assert.deepEqual(rows.slice(0, 2), ["", ""], "the blank rows move above the sprite");
  assert.match(rows[2] as string, /a/, "the sprite sits on the last row of the strip");
});

test("the component indents by its column and declines a terminal too narrow to hold it", () => {
  const mascot = player();
  const view = new MascotComponent(mascot, PACK, { column: 3 });
  mascot.play("waiting");
  assert.match(view.render(40)[0] as string, /^ {3}\S/, "indented by the requested column");
  assert.deepEqual(view.render(3), [], "declines rather than wrapping a too-narrow terminal");
  assert.equal(view.render(0).length, 0);
});

test("nothing is drawn before a state is playing", () => {
  const view = new MascotComponent(player(), PACK);
  assert.deepEqual(view.render(40), []);
});

test("a state's opening frame survives the first tick", () => {
  // The player takes its time only from tick(), so a play() from an event
  // handler cannot start a segment on a different clock and skip it.
  const mascot = player();
  mascot.play("success");
  assert.equal(mascot.frameId(), 70);
  assert.equal(
    mascot.tick(Date.now()),
    false,
    "the first tick starts the frame, it does not end it",
  );
  assert.equal(mascot.frameId(), 70);
  assert.equal(mascot.state, "success", "a oneshot is not skipped before it is seen");
});

test("typing dives under the bar, crosses hidden, and surfaces at the cursor", () => {
  const actor = new MascotActor();
  const context = { width: 80, spriteWidth: 8, stripHeight: 3, cursorColumn: 40, segment: "loop" };
  const start = actor.placement().column;

  // It goes under before it moves: crossing in view cannot keep up with typing.
  let hidden = false;
  let movedWhileVisible = false;
  let previous = start;
  for (let step = 0; step < 40; step += 1) {
    actor.step(50, { ...context, state: "typing" });
    const { column, sink } = actor.placement();
    if (sink >= context.stripHeight) hidden = true;
    else if (column !== previous && !hidden) movedWhileVisible = true;
    previous = column;
  }
  assert.ok(hidden, "it submerges completely at some point");
  assert.equal(movedWhileVisible, false, "it never travels in view");

  const settled = actor.placement();
  assert.ok(settled.column > start, "it surfaces beside the cursor");
  assert.equal(settled.sink, 0, "it surfaces fully, so the typing arms show above the bar");
});

test("the actor patrols during working and turns at the edges", () => {
  const actor = new MascotActor();
  const context = {
    state: "working",
    segment: "loop",
    width: 40,
    spriteWidth: 8,
    stripHeight: 4,
    cursorColumn: 0,
  };
  const columns = new Set<number>();
  for (let step = 0; step < 200; step += 1) {
    actor.step(50, context);
    columns.add(actor.placement().column);
  }
  assert.ok(columns.size > 4, "the sprite moves across the strip");
  assert.ok(Math.max(...columns) <= 40 - 8 - 2, "it never runs past the right edge");
  assert.ok(Math.min(...columns) >= 2, "it never runs past the left edge");
});

test("working coils in place and only travels once it swims", () => {
  const actor = new MascotActor();
  const context = { width: 40, spriteWidth: 8, stripHeight: 4, cursorColumn: 0 };
  const start = actor.placement().column;
  for (let step = 0; step < 20; step += 1) {
    actor.step(50, { ...context, state: "working", segment: "in" });
  }
  assert.equal(actor.placement().column, start, "the coil wind-up is drawn in place");
  for (let step = 0; step < 20; step += 1) {
    actor.step(50, { ...context, state: "working", segment: "loop" });
  }
  assert.ok(actor.placement().column > start, "the swim stroke carries it along");
  const swimming = actor.placement().column;
  actor.step(500, { ...context, state: "swim", segment: "loop" });
  assert.ok(actor.placement().column > swimming, "swim on its own patrols too");
});

test("sinking keeps the strip height constant", () => {
  const mascot = player();
  const view = new MascotComponent(mascot, PACK, { column: 1 });
  mascot.play("waiting");
  const floating = view.render(40);
  view.setSink(1);
  const sunk = view.render(40);
  assert.equal(sunk.length, floating.length, "the strip does not resize when the sprite sinks");
  assert.equal(sunk[0], "", "the sprite moves down inside the strip");
});

test("the mascot faces the way it swims", () => {
  const actor = new MascotActor();
  const context = {
    state: "working",
    segment: "loop",
    width: 40,
    spriteWidth: 8,
    stripHeight: 3,
    cursorColumn: 0,
  };
  const seen = new Set<string>();
  let previous = actor.placement().column;
  let reversed = false;
  for (let step = 0; step < 300; step += 1) {
    actor.step(50, context);
    const { column, mirrored } = actor.placement();
    if (column !== previous) {
      seen.add(`${column > previous ? "right" : "left"}:${mirrored}`);
      if (column < previous) reversed = true;
      previous = column;
    }
  }
  assert.ok(reversed, "the patrol turns around");
  assert.ok(seen.has("right:true"), "swimming right mirrors the art");
  assert.ok(seen.has("left:false"), "swimming left uses the art as drawn");
});

test("a short pose is never half-hidden by the bar it rests on", () => {
  // A fixed one-row dip costs a two-row swim pose half its height while a
  // four-row upright pose loses a quarter, so short poses do not dip.
  const short = parseMascotPack({
    cell: [4, 8],
    encoding: "sextant",
    pixels: 24,
    frames: Array.from({ length: 93 }, () => ["a", "", "", "", "", "", "", ""]),
    crop: {},
    crop_seg: {},
  });
  const mascot = player();
  const view = new MascotComponent(mascot, short, {
    bands: new Map([["waiting.loop", [0, 0] as const]]),
    totalRows: 8,
  });
  mascot.play("waiting");
  const rows = view.render(40);
  const painted = rows.filter((row) => row !== "").length;
  assert.equal(painted, 1, "the pose is drawn");
  assert.ok(
    rows.indexOf(rows.find((r) => r !== "") as string) < rows.length,
    "it stays in the strip",
  );
});

test("a failed session plays dead, a completed one does not", () => {
  const cases: readonly [string, string][] = [
    ["failed", "dead"],
    ["completed", "waiting"],
    ["disposed", "waiting"],
  ];
  for (const [reason, expected] of cases) {
    const mascot = player();
    const director = new MascotDirector(mascot);
    mascot.play("waiting");
    director.handleEvent(event("session.closed", { reason }), 0);
    assert.equal(mascot.state, expected, `${reason} should leave the mascot in ${expected}`);
  }
});
