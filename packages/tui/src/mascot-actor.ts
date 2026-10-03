// SPDX-FileCopyrightText: 2026 Dheirav
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the mascot sits in its strip.
 *
 * Placement is client logic, not part of the animation: the player decides
 * which frame, this decides where it is drawn. Positions are in terminal
 * cells, and the actor eases toward a target rather than jumping, so a state
 * change reads as movement.
 */

/** States that rest on the composer bar rather than floating above it. */
const FLOOR_STATES = new Set(["severed", "dead", "idle", "waking", "error"]);

export interface MascotActorTarget {
  /** The state now playing. */
  readonly state: string | null;
  /** The segment of that state now playing. */
  readonly segment: string | null;
  /** Terminal width in cells. */
  readonly width: number;
  /** Sprite width in cells. */
  readonly spriteWidth: number;
  /** Strip height in cells. */
  readonly stripHeight: number;
  /** Column of the composer cursor, when the user is typing into it. */
  readonly cursorColumn: number;
}

export interface MascotPlacement {
  readonly column: number;
  readonly sink: number;
  /** True while still travelling toward the composer cursor. */
  readonly travelling: boolean;
  /** True when the sprite should face against the way the art is drawn. */
  readonly mirrored: boolean;
}

/** Columns travelled per second while patrolling during `working`. */
const PATROL_COLUMNS_PER_SECOND = 9;
/** Columns travelled per second when gliding to the composer. */
const GLIDE_COLUMNS_PER_SECOND = 70;
/** Rows sunk per second when settling beside the cursor. */
const SINK_ROWS_PER_SECOND = 6;

/** Rows sunk per second while diving under the bar or surfacing from it. */
const DIVE_ROWS_PER_SECOND = 16;
/**
 * Rows the sprite sinks while typing.
 *
 * Zero keeps it at the surface beside the cursor, with only the tail tip on
 * the bar. One row hid the typing arms behind the composer, which left just
 * the head showing, and the arms are the point of the state.
 */
const TYPING_SINK_ROWS = 0;

/** Left margin the sprite keeps. */
const HOME_COLUMN = 2;

function toward(value: number, target: number, rate: number, seconds: number): number {
  const distance = target - value;
  if (Math.abs(distance) < 0.02) return target;
  const step = rate * seconds;
  return distance > 0 ? Math.min(target, value + step) : Math.max(target, value - step);
}

export class MascotActor {
  private column = HOME_COLUMN;
  private sink = 0;
  private patrolDirection = 1;
  private mirrored = false;
  private travelling = false;
  private dive: "idle" | "under" | "up" = "idle";

  /** Current placement, rounded to whole cells. */
  placement(): MascotPlacement {
    return {
      column: Math.round(this.column),
      sink: Math.round(this.sink),
      mirrored: this.mirrored,
      travelling: this.travelling,
    };
  }

  /**
   * Advances placement by `elapsedMs`. Returns true when the rounded placement
   * changed, so the caller can skip a repaint.
   */
  step(elapsedMs: number, target: MascotActorTarget): boolean {
    const before = this.placement();
    const travelledFrom = this.column;
    const seconds = Math.max(0, elapsedMs) / 1000;
    const rightmost = Math.max(HOME_COLUMN, target.width - target.spriteWidth - HOME_COLUMN);

    if (target.state === "typing") {
      // Glide to the composer cursor and sink so the tail is behind the bar.
      // The art keeps head, gills, and hands above the waterline.
      // Dive under the bar, cross while hidden, surface at the cursor. Swimming
      // the distance in view cannot keep up with typing, and the sprite spends
      // the whole trip in the wrong place.
      const wanted = Math.max(HOME_COLUMN, Math.min(rightmost, target.cursorColumn - 1));
      const settled = Math.min(TYPING_SINK_ROWS, Math.max(0, target.stripHeight - 1));
      const under = target.stripHeight;
      if (this.dive === "idle" && Math.abs(wanted - this.column) > 1) this.dive = "under";
      if (this.dive === "under") {
        this.sink = toward(this.sink, under, DIVE_ROWS_PER_SECOND, seconds);
        if (this.sink >= under - 0.01) {
          // Out of sight: move in one step rather than travelling in view.
          this.column = wanted;
          this.dive = "up";
        }
      } else if (this.dive === "up") {
        this.sink = toward(this.sink, settled, DIVE_ROWS_PER_SECOND, seconds);
        if (this.sink <= settled + 0.01) this.dive = "idle";
      } else {
        this.column = toward(this.column, wanted, GLIDE_COLUMNS_PER_SECOND, seconds);
        this.sink = toward(this.sink, settled, SINK_ROWS_PER_SECOND, seconds);
      }
      this.travelling = this.dive !== "idle";
    } else if (target.state === "working" || target.state === "swim") {
      // Patrol the strip end to end while the harness works. Working opens
      // with a coil wind-up drawn in place, and its loop is the swim stroke,
      // so it only travels once it swims: sliding while curled up in a ball
      // read as being dragged.
      this.travelling = false;
      this.dive = "idle";
      this.sink = toward(this.sink, 0, SINK_ROWS_PER_SECOND, seconds);
      const swimming = target.state === "swim" || target.segment === "loop";
      if (swimming) this.column += this.patrolDirection * PATROL_COLUMNS_PER_SECOND * seconds;
      if (this.column >= rightmost) {
        this.column = rightmost;
        this.patrolDirection = -1;
      } else if (this.column <= HOME_COLUMN) {
        this.column = HOME_COLUMN;
        this.patrolDirection = 1;
      }
    } else {
      this.travelling = false;
      this.dive = "idle";
      this.sink = toward(this.sink, 0, SINK_ROWS_PER_SECOND, seconds);
      if (target.state !== null && FLOOR_STATES.has(target.state)) {
        this.column = toward(this.column, HOME_COLUMN, GLIDE_COLUMNS_PER_SECOND, seconds);
      }
    }

    // The art is drawn facing one way, so travelling the other way mirrors it.
    // Deriving this from the movement actually made, rather than per state,
    // stops the mascot swimming backwards on its way to the cursor.
    const travelled = this.column - travelledFrom;
    if (Math.abs(travelled) > 0.01) this.mirrored = travelled > 0;

    const after = this.placement();
    return (
      before.column !== after.column ||
      before.sink !== after.sink ||
      before.mirrored !== after.mirrored ||
      before.travelling !== after.travelling
    );
  }
}
