// SPDX-FileCopyrightText: 2026 Dheirav
// SPDX-License-Identifier: Apache-2.0

/**
 * Maps session events onto mascot states.
 *
 * The priority rules live here rather than in the player, because they are
 * decisions about what the harness is doing, not about how a frame is drawn.
 * The player stays a pure frame clock.
 */

import type { CanonicalEvent } from "@axl/protocol";

import type { MascotPlayer } from "./mascot.ts";

/** Milliseconds after the last keystroke before `typing` releases. */
export const TYPING_RELEASE_MS = 600;
/** Milliseconds of edits coalesced into one `file_change`. */
export const FILE_CHANGE_BURST_MS = 750;

/** States `typing` may take over from. While the harness works, its work wins. */
const TYPING_YIELDS_FROM = new Set(["waiting", "idle"]);
/** Tool names that mean a file was written. */
const FILE_TOOLS = new Set(["write", "edit"]);

export interface MascotDirectorOptions {
  readonly typingReleaseMs?: number;
  readonly fileChangeBurstMs?: number;
}

/**
 * Drives one player from session events and local input. Owns no timer: the
 * caller advances it with `tick(now)` alongside the player.
 */
export class MascotDirector {
  private readonly player: MascotPlayer;
  private readonly typingReleaseMs: number;
  private readonly fileChangeBurstMs: number;
  private lastKeystroke: number | null = null;
  private lastFileChange: number | null = null;
  private compacting = false;

  constructor(player: MascotPlayer, options: MascotDirectorOptions = {}) {
    this.player = player;
    this.typingReleaseMs = options.typingReleaseMs ?? TYPING_RELEASE_MS;
    this.fileChangeBurstMs = options.fileChangeBurstMs ?? FILE_CHANGE_BURST_MS;
  }

  /** Session attached. `waking` hands off to `waiting` on its own. */
  attach(): void {
    this.player.play("waking");
  }

  /**
   * A keystroke in the composer. Only takes over an idle mascot, so a running
   * turn keeps showing its own work.
   */
  keystroke(now: number): void {
    this.lastKeystroke = now;
    const state = this.player.state;
    if (state !== null && TYPING_YIELDS_FROM.has(state)) this.player.play("typing");
  }

  /** Compaction has no start event, so the client reports it directly. */
  compactionStarted(): void {
    this.compacting = true;
    this.player.play("compact");
  }

  /** Leaves `compact` gracefully so the spring-out plays. */
  compactionFinished(): void {
    if (!this.compacting) return;
    this.compacting = false;
    // Something else may have taken over while it compacted, an error or a
    // new prompt; that state stays.
    if (this.player.state === "compact") this.player.play("waiting", { graceful: true });
  }

  /** `/clear` ran. */
  cleared(): void {
    this.player.play("clear");
  }

  /** Applies one canonical event. Unmapped events leave the mascot alone. */
  handleEvent(event: CanonicalEvent, now: number): void {
    switch (event.type) {
      case "session.created":
      case "session.resumed":
        this.player.play("waking");
        return;
      case "user.message":
        this.lastKeystroke = null;
        this.player.play("thinking");
        return;
      case "tool.call":
        if (FILE_TOOLS.has(event.payload.name)) {
          this.fileChanged(now);
          return;
        }
        if (this.player.state !== "working") this.player.play("working");
        return;
      case "permission.requested":
      case "interaction.requested":
        // The session is stopped on the user, so this holds until they answer.
        this.player.play("ask");
        return;
      case "permission.resolved":
      case "interaction.resolved":
        if (this.player.state === "ask") this.player.play("working");
        return;
      case "sandbox.violation":
        this.player.play("blocked");
        return;
      case "queue.enqueued":
        this.player.play("nod");
        return;
      case "model.retry_scheduled":
        this.player.play("resume");
        return;
      case "context.compacted":
        this.compactionFinished();
        return;
      case "session.error":
        this.player.play("error");
        return;
      case "session.closed":
        // Only a failure is giving up. A completed or disposed session is the
        // client going away, and the mascot goes with it.
        if (event.payload.reason === "failed") this.player.play("dead");
        return;
      case "assistant.message":
        this.assistantStopped(event.payload.stopReason);
        return;
      default:
        return;
    }
  }

  /**
   * Advances the states the director owns. Returns true when it changed the
   * mascot, so the caller can skip a redraw when nothing moved.
   */
  tick(now: number): boolean {
    if (this.lastKeystroke === null) return false;
    if (now - this.lastKeystroke < this.typingReleaseMs) return false;
    this.lastKeystroke = null;
    if (this.player.state !== "typing") return false;
    this.player.play("waiting");
    return true;
  }

  private fileChanged(now: number): void {
    if (this.lastFileChange !== null && now - this.lastFileChange < this.fileChangeBurstMs) return;
    this.lastFileChange = now;
    this.player.play("file_change");
  }

  private assistantStopped(stopReason: string): void {
    if (stopReason === "tool_use") {
      if (this.player.state !== "working") this.player.play("working");
      return;
    }
    // An interrupt (Esc) ends the turn as aborted. That is the run being
    // killed, which is what dead is drawn for; error is for the turn failing.
    if (stopReason === "aborted") {
      this.player.play("dead");
      return;
    }
    if (stopReason === "error") {
      this.player.play("error");
      return;
    }
    this.player.play("success");
  }
}
