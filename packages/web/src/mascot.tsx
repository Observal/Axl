// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import {
  MascotActor,
  MascotDirector,
  type MascotManifest,
  MascotPlayer,
  parseMascotManifest,
} from "@axl/sdk";
import { type RefObject, useEffect, useRef } from "react";

import { frameRect, recolourPixels } from "./mascot-atlas.ts";

const MANIFEST_URL = new URL("./mascot/axolotl.json", import.meta.url).href;
const ATLAS_URL = new URL("./mascot/atlas-Pink.png", import.meta.url).href;

/** One terminal cell in CSS pixels. The actor thinks in cells, as in the TUI. */
const CELL_WIDTH = 9;
const CELL_HEIGHT = 18;
/** Sprite box in cells, the same as the TUI's image path. */
const SPRITE_COLUMNS = 12;
const STRIP_ROWS = 4;
/** Rough width of a typed character in cells, so the mascot can follow the caret. */
const CHARACTER_CELLS = 0.8;
const TICK_MS = 50;

/** What the app drives: session events and keystrokes go to the director, `/mascot sas` to the player. */
export interface MascotControl {
  readonly director: MascotDirector;
  readonly player: MascotPlayer;
}

async function loadAtlas(manifest: MascotManifest, colour: string): Promise<ImageBitmap> {
  const response = await fetch(ATLAS_URL);
  if (!response.ok) throw new Error(`Mascot atlas request failed (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("This browser cannot draw the mascot");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  recolourPixels(image.data, manifest, colour);
  context.putImageData(image, 0, 0);
  return createImageBitmap(canvas);
}

/**
 * The axolotl above the composer. Presentation only: it reads canonical events
 * and keystrokes through `control` and never sends anything to the daemon.
 */
export function Mascot({
  colour,
  draft,
  control,
  onError,
}: {
  readonly colour: string;
  readonly draft: string;
  readonly control: RefObject<MascotControl | null>;
  readonly onError: (message: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cursorColumn = useRef(2);
  const lastLine = draft.slice(draft.lastIndexOf("\n") + 1);
  cursorColumn.current = 2 + lastLine.length * CHARACTER_CELLS;

  useEffect(() => {
    const stripElement = strip.current;
    const canvasElement = canvas.current;
    if (stripElement === null || canvasElement === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let observer: ResizeObserver | undefined;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    void (async () => {
      const manifest = parseMascotManifest(
        await fetch(MANIFEST_URL).then((response) => {
          if (!response.ok) throw new Error(`Mascot manifest request failed (${response.status})`);
          return response.json();
        }),
      );
      const atlas = await loadAtlas(manifest, colour);
      if (stopped) {
        atlas.close();
        return;
      }
      const context = canvasElement.getContext("2d");
      if (context === null) throw new Error("This browser cannot draw the mascot");
      const player = new MascotPlayer(manifest);
      const director = new MascotDirector(player);
      const actor = new MascotActor();
      control.current = { director, player };
      director.attach();

      const [frameWidth, frameHeight] = manifest.frameSize;
      const scale = (SPRITE_COLUMNS * CELL_WIDTH) / frameWidth;
      let width = 0;
      const resize = (): void => {
        width = stripElement.clientWidth;
        const ratio = window.devicePixelRatio || 1;
        canvasElement.width = Math.max(1, Math.round(width * ratio));
        canvasElement.height = Math.round(STRIP_ROWS * CELL_HEIGHT * ratio);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
      };
      resize();
      observer = new ResizeObserver(() => {
        resize();
        draw();
      });
      observer.observe(stripElement);

      const draw = (): void => {
        if (player.state === null) return;
        const { column, sink, mirrored } = actor.placement();
        const source = frameRect(manifest, player.frameId());
        // The pose's lowest pixel rests on the composer's top edge.
        const lowest = (frameHeight - (player.bottomMargin ?? 0)) * scale;
        const top = STRIP_ROWS * CELL_HEIGHT - lowest + sink * CELL_HEIGHT;
        const left = column * CELL_WIDTH;
        context.clearRect(0, 0, width, STRIP_ROWS * CELL_HEIGHT);
        context.save();
        if (mirrored) {
          context.translate(left + frameWidth * scale, 0);
          context.scale(-1, 1);
        } else {
          context.translate(left, 0);
        }
        context.drawImage(
          atlas,
          source.x,
          source.y,
          source.width,
          source.height,
          0,
          top,
          frameWidth * scale,
          frameHeight * scale,
        );
        context.restore();
      };

      let steppedAt = Date.now();
      timer = setInterval(() => {
        const now = Date.now();
        const elapsed = now - steppedAt;
        steppedAt = now;
        let changed = player.tick(now);
        if (director.tick(now)) changed = true;
        if (!reduced) {
          const moved = actor.step(elapsed, {
            state: player.state,
            segment: player.segment,
            width: Math.floor(width / CELL_WIDTH),
            spriteWidth: SPRITE_COLUMNS,
            stripHeight: STRIP_ROWS,
            cursorColumn: cursorColumn.current,
          });
          if (moved) changed = true;
        }
        if (changed) draw();
      }, TICK_MS);
    })().catch((cause: unknown) => {
      if (!stopped) onError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      observer?.disconnect();
      control.current = null;
    };
  }, [colour, control, onError]);

  return (
    <div ref={strip} className="mascot-strip" aria-hidden="true">
      <canvas ref={canvas} style={{ width: "100%", height: `${STRIP_ROWS * CELL_HEIGHT}px` }} />
    </div>
  );
}
