// SPDX-FileCopyrightText: 2026 Dheirav
// SPDX-License-Identifier: Apache-2.0

/**
 * Mascot playback: the manifest contract and the frame player.
 *
 * Every state is up to three segments. `in` plays once, `loop` holds for as
 * long as the state lasts, `out` plays on the way out. No asset encodes how
 * long a state lasts, so a 200 ms tool call and a 20 minute build both use
 * `working`.
 *
 * The player never sleeps and never draws. It is advanced by `tick(now)` and
 * reports the atlas slot to draw, so it drops into the existing render
 * scheduler without owning a timer.
 */

export type MascotSegmentName = "in" | "loop" | "out";
export type MascotStateKind = "loop" | "oneshot" | "transition";

const SEGMENT_ORDER = ["in", "loop", "out"] as const satisfies readonly MascotSegmentName[];
const STATE_KINDS = ["loop", "oneshot", "transition"] as const satisfies readonly MascotStateKind[];

export interface MascotSegment {
  /** Atlas slot per frame. */
  readonly frames: readonly number[];
  /** Milliseconds each frame is held. Same length as `frames`. */
  readonly durations: readonly number[];
  /**
   * Transparent rows under the lowest pixel any of the segment's frames paint,
   * measured from the atlas at build time. The renderer sets that pixel on the
   * composer's line. Absent from older manifests, which then fall back to the
   * text pack's coarser rows.
   */
  readonly bottomMargin?: number;
}

export interface MascotState {
  readonly kind: MascotStateKind;
  /** State to hand off to when this one finishes, or null if it holds. */
  readonly next: string | null;
  /**
   * Transparent rows above the pose, measured from the atlas at build time.
   *
   * The room a state's art has to be raised inside its own frame, which is
   * where a lift now lives (the renderer draws every state at one scale and
   * cannot move art within a cell). Absent from older manifests, which read
   * as 0.
   */
  readonly topMargin: number;
  readonly segments: { readonly [Name in MascotSegmentName]?: MascotSegment };
}

export interface MascotManifest {
  readonly frameSize: readonly [number, number];
  readonly atlasColumns: number;
  readonly atlas: string;
  readonly colours: readonly string[];
  /**
   * Each colour's palette for the indexed atlas, index for index, when the
   * colours are drawn by swapping the atlas's palette rather than shipped as
   * atlases of their own. The first colour's is the one the atlas holds.
   */
  readonly palettes?: Readonly<Record<string, readonly (readonly [number, number, number])[]>>;
  readonly states: { readonly [name: string]: MascotState };
}

export class MascotManifestError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "MascotManifestError";
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MascotManifestError(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new MascotManifestError(path, "expected a positive integer");
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new MascotManifestError(path, "expected a non-negative integer");
  }
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MascotManifestError(path, "expected a non-empty string");
  }
  return value;
}

function parseSegment(value: unknown, path: string): MascotSegment {
  const segment = object(value, path);
  const frames = segment.frames;
  const durations = segment.durations;
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new MascotManifestError(`${path}.frames`, "expected a non-empty array");
  }
  if (!Array.isArray(durations) || durations.length !== frames.length) {
    throw new MascotManifestError(
      `${path}.durations`,
      `expected ${frames.length} durations, found ${Array.isArray(durations) ? durations.length : "none"}`,
    );
  }
  return {
    frames: frames.map((frame, index) => {
      if (typeof frame !== "number" || !Number.isSafeInteger(frame) || frame < 0) {
        throw new MascotManifestError(`${path}.frames[${index}]`, "expected an atlas slot");
      }
      return frame;
    }),
    durations: durations.map((duration, index) =>
      positiveInteger(duration, `${path}.durations[${index}]`),
    ),
    ...(segment.bottom_margin === undefined
      ? {}
      : { bottomMargin: nonNegativeInteger(segment.bottom_margin, `${path}.bottom_margin`) }),
  };
}

function parseState(value: unknown, path: string): MascotState {
  const state = object(value, path);
  const kind = state.kind;
  if (typeof kind !== "string" || !STATE_KINDS.includes(kind as MascotStateKind)) {
    throw new MascotManifestError(`${path}.kind`, `expected one of ${STATE_KINDS.join(", ")}`);
  }
  const next = state.next ?? null;
  if (next !== null && typeof next !== "string") {
    throw new MascotManifestError(`${path}.next`, "expected a state name or null");
  }
  const segments = object(state.segments, `${path}.segments`);
  const parsed: { [Name in MascotSegmentName]?: MascotSegment } = {};
  for (const name of SEGMENT_ORDER) {
    if (segments[name] !== undefined)
      parsed[name] = parseSegment(segments[name], `${path}.${name}`);
  }
  if (Object.keys(parsed).length === 0) {
    throw new MascotManifestError(`${path}.segments`, "expected at least one of in, loop, out");
  }
  const topMargin =
    state.top_margin === undefined ? 0 : nonNegativeInteger(state.top_margin, `${path}.top_margin`);
  return { kind: kind as MascotStateKind, next, topMargin, segments: parsed };
}

/**
 * Validates a manifest read from disk. The manifest is a trust boundary, so a
 * malformed one fails here rather than producing a player that silently draws
 * the wrong frame.
 */
export function parseMascotManifest(value: unknown): MascotManifest {
  const manifest = object(value, "manifest");
  const frameSize = manifest.frame_size;
  if (!Array.isArray(frameSize) || frameSize.length !== 2) {
    throw new MascotManifestError("manifest.frame_size", "expected [width, height]");
  }
  const colours = manifest.colours;
  if (!Array.isArray(colours) || colours.length === 0) {
    throw new MascotManifestError("manifest.colours", "expected a non-empty array");
  }
  const states = object(manifest.states, "manifest.states");
  const parsedStates: Record<string, MascotState> = {};
  for (const [name, state] of Object.entries(states)) {
    parsedStates[name] = parseState(state, `manifest.states.${name}`);
  }
  if (Object.keys(parsedStates).length === 0) {
    throw new MascotManifestError("manifest.states", "expected at least one state");
  }
  for (const [name, state] of Object.entries(parsedStates)) {
    if (state.next !== null && parsedStates[state.next] === undefined) {
      throw new MascotManifestError(
        `manifest.states.${name}.next`,
        `unknown state ${JSON.stringify(state.next)}`,
      );
    }
  }
  const names = colours.map((colour, index) =>
    nonEmptyString(colour, `manifest.colours[${index}]`),
  );
  const palettes =
    manifest.palettes === undefined ? undefined : parsePalettes(manifest.palettes, names);
  return {
    frameSize: [
      positiveInteger(frameSize[0], "manifest.frame_size[0]"),
      positiveInteger(frameSize[1], "manifest.frame_size[1]"),
    ],
    atlasColumns: positiveInteger(manifest.atlas_columns, "manifest.atlas_columns"),
    atlas: nonEmptyString(manifest.atlas, "manifest.atlas"),
    colours: names,
    ...(palettes === undefined ? {} : { palettes }),
    states: parsedStates,
  };
}

function parsePalettes(
  value: unknown,
  colours: readonly string[],
): Record<string, readonly (readonly [number, number, number])[]> {
  const raw = object(value, "manifest.palettes");
  const parsed: Record<string, readonly (readonly [number, number, number])[]> = {};
  let length: number | undefined;
  for (const [colour, palette] of Object.entries(raw)) {
    const path = `manifest.palettes.${colour}`;
    if (!colours.includes(colour)) throw new MascotManifestError(path, "not in manifest.colours");
    if (!Array.isArray(palette) || palette.length === 0 || palette.length > 256) {
      throw new MascotManifestError(path, "expected 1 to 256 colours");
    }
    if (length !== undefined && palette.length !== length) {
      throw new MascotManifestError(path, `expected ${length} colours, like the others`);
    }
    length = palette.length;
    parsed[colour] = palette.map((entry, index) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 3 ||
        entry.some(
          (part) => typeof part !== "number" || !Number.isInteger(part) || part < 0 || part > 255,
        )
      ) {
        throw new MascotManifestError(`${path}[${index}]`, "expected [r, g, b], each 0 to 255");
      }
      return [entry[0], entry[1], entry[2]] as const;
    });
  }
  return parsed;
}

export interface MascotPlayOptions {
  /**
   * Finish the current loop cycle and play `out` before switching. Use it when
   * leaving a held state cleanly. Never use it for an interrupt: every
   * transition carries an impact frame so a hard cut is masked, and waiting
   * for a loop adds up to 1.2 s of latency exactly when it is unacceptable.
   */
  readonly graceful?: boolean;
}

/**
 * Plays one state at a time from the manifest. Port of the reference player;
 * the segment order, the graceful handoff, and the boundary clock reset match
 * it frame for frame.
 */
export class MascotPlayer {
  private readonly manifest: MascotManifest;
  private stateName: string | null = null;
  private segmentName: MascotSegmentName | null = null;
  private pending: string | null = null;
  private order: MascotSegmentName[] = [];
  private orderIndex = -1;
  private frameIndex = 0;
  /** Start of the current frame, or null until the next tick supplies the time. */
  private since: number | null = null;
  private held = false;

  constructor(manifest: MascotManifest) {
    this.manifest = manifest;
  }

  /** The state now playing, or null before the first `play`. */
  get state(): string | null {
    return this.stateName;
  }

  /** The segment now playing, or null before the first `play`. */
  get segment(): MascotSegmentName | null {
    return this.segmentName;
  }

  /** Transparent rows under the playing segment's art, when the manifest measured them. */
  get bottomMargin(): number | undefined {
    return this.stateName === null || this.segmentName === null
      ? undefined
      : this.currentSegment().bottomMargin;
  }

  /** The state queued by a graceful `play`, or null. */
  get queued(): string | null {
    return this.pending;
  }

  /**
   * Switches state. Cuts immediately unless `graceful` is set and the current
   * state has a loop to finish.
   */
  play(name: string, options: MascotPlayOptions = {}): void {
    const current = this.stateName === null ? undefined : this.manifest.states[this.stateName];
    if (options.graceful === true && current?.segments.loop !== undefined) {
      if (this.manifest.states[name] === undefined) {
        throw new MascotManifestError("play", `unknown state ${JSON.stringify(name)}`);
      }
      this.pending = name;
      return;
    }
    this.enter(name, null);
  }

  /** Advances playback to `now`. Returns true when the visible frame changed. */
  tick(now: number): boolean {
    if (this.stateName === null || this.segmentName === null || this.held) return false;
    if (this.since === null) this.since = now;
    let changed = false;
    for (;;) {
      const segment = this.currentSegment();
      const duration = segment.durations[this.frameIndex] as number;
      if (now - (this.since as number) < duration) return changed;
      this.since = (this.since as number) + duration;
      this.frameIndex += 1;
      changed = true;
      if (this.frameIndex < segment.frames.length) continue;
      if (this.segmentName !== "loop") {
        this.advance(now);
      } else if (this.pending === null) {
        this.frameIndex = 0;
      } else if (this.manifest.states[this.stateName]?.segments.out !== undefined) {
        this.selectSegment("out", now);
      } else {
        this.enter(this.pending, now);
      }
      if (this.held) return changed;
      this.since = now;
    }
  }

  /** The atlas slot to draw. */
  frameId(): number {
    return this.currentSegment().frames[this.frameIndex] as number;
  }

  private currentSegment(): MascotSegment {
    if (this.stateName === null || this.segmentName === null) {
      throw new MascotManifestError("player", "no state is playing");
    }
    const segment = this.manifest.states[this.stateName]?.segments[this.segmentName];
    if (segment === undefined) {
      throw new MascotManifestError("player", `state ${this.stateName} lost its segment`);
    }
    return segment;
  }

  private enter(name: string, now: number | null): void {
    const state = this.manifest.states[name];
    if (state === undefined) {
      throw new MascotManifestError("play", `unknown state ${JSON.stringify(name)}`);
    }
    this.stateName = name;
    this.pending = null;
    this.held = false;
    this.order = SEGMENT_ORDER.filter((segment) => state.segments[segment] !== undefined);
    this.orderIndex = -1;
    this.advance(now);
  }

  private selectSegment(name: MascotSegmentName, now: number | null): void {
    this.orderIndex = this.order.indexOf(name);
    this.segmentName = name;
    this.frameIndex = 0;
    this.since = now;
  }

  private advance(now: number | null): void {
    this.orderIndex += 1;
    const next = this.order[this.orderIndex];
    if (next !== undefined) {
      this.selectSegment(next, now);
      return;
    }
    if (this.pending !== null) {
      this.enter(this.pending, now);
      return;
    }
    const state = this.manifest.states[this.stateName as string] as MascotState;
    if (state.segments.loop !== undefined) {
      this.selectSegment("loop", now);
      return;
    }
    if (state.next !== null) {
      this.enter(state.next, now);
      return;
    }
    this.frameIndex = this.currentSegment().frames.length - 1;
    this.held = true;
  }
}
