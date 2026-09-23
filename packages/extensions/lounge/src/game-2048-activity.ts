// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  type ActivityFrame,
  type ActivityInput,
  type ActivitySpan,
  ActivityStorageError,
  type ActivityViewport,
  type TerminalActivity,
} from "@axl/extension-api";

import {
  createGame2048,
  type Game2048Direction,
  type Game2048MoveTrace,
  type Game2048State,
  moveGame2048,
  reduceGame2048,
} from "./game-2048.ts";
import {
  GAME_2048_STORAGE_SCHEMA_VERSION,
  type Game2048SaveDocument,
  Game2048SaveError,
  game2048SaveJson,
  parseGame2048Save,
  updateGame2048Save,
} from "./game-2048-state.ts";

export interface Game2048ActivityOptions {
  readonly seed?: () => number;
}

type Panel = "loading" | "game" | "help" | "restart" | "storage-error";
type AnimationPhase = "motion" | "settle";

interface Animation {
  readonly phase: AnimationPhase;
  readonly trace: Game2048MoveTrace;
}

function span(
  text: string,
  style: ActivitySpan["style"] = "text",
  emphasis: ActivitySpan["emphasis"] = "none",
): ActivitySpan {
  return Object.freeze({ text, style, emphasis });
}

function line(...spans: readonly ActivitySpan[]): readonly ActivitySpan[] {
  return Object.freeze(spans);
}

function centered(
  text: string,
  width: number,
  style: ActivitySpan["style"] = "text",
  emphasis: ActivitySpan["emphasis"] = "none",
) {
  const clipped = text.slice(0, Math.max(0, width));
  return line(
    span(" ".repeat(Math.max(0, Math.floor((width - clipped.length) / 2)))),
    span(clipped, style, emphasis),
  );
}

type TileKind = "empty" | "low" | "medium" | "high" | "target" | "beyond";

function tileKind(value: number): TileKind {
  if (value === 0) return "empty";
  if (value < 16) return "low";
  if (value < 256) return "medium";
  if (value < 2048) return "high";
  if (value === 2048) return "target";
  return "beyond";
}

function tileStyle(kind: TileKind): ActivitySpan["style"] {
  if (kind === "empty") return "muted";
  if (kind === "medium") return "accent";
  if (kind === "high") return "warning";
  if (kind === "target") return "success";
  if (kind === "beyond") return "error";
  return "text";
}

type TileCue = "merge" | "spawn";

interface TileBox {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
}

function tileBox(kind: TileKind, cue?: TileCue): TileBox {
  if (cue === "spawn") {
    return {
      topLeft: "╭",
      topRight: "╮",
      bottomLeft: "╰",
      bottomRight: "╯",
      horizontal: "┈",
      vertical: "┊",
    };
  }
  if (cue === "merge" || kind === "target") {
    return {
      topLeft: "┏",
      topRight: "┓",
      bottomLeft: "┗",
      bottomRight: "┛",
      horizontal: "━",
      vertical: "┃",
    };
  }
  if (kind === "high" || kind === "beyond") {
    return {
      topLeft: "╔",
      topRight: "╗",
      bottomLeft: "╚",
      bottomRight: "╝",
      horizontal: "═",
      vertical: "║",
    };
  }
  if (kind === "medium") {
    return {
      topLeft: "┌",
      topRight: "┐",
      bottomLeft: "└",
      bottomRight: "┘",
      horizontal: "─",
      vertical: "│",
    };
  }
  return {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
  };
}

function directionGlyph(direction: Game2048Direction): string {
  if (direction === "left") return "←";
  if (direction === "right") return "→";
  if (direction === "up") return "↑";
  return "↓";
}

function tileCue(
  index: number,
  animation: Animation | undefined,
  settledTrace: Game2048MoveTrace | undefined,
): TileCue | undefined {
  const trace = animation?.trace ?? settledTrace;
  if (trace === undefined) return undefined;
  if (animation?.phase !== "motion" && trace.spawn?.index === index) return "spawn";
  if (trace.merges.some((merge) => merge.destination === index)) return "merge";
  return undefined;
}

function paddedLabel(
  label: string,
  width: number,
  style: ActivitySpan["style"],
  emphasis: ActivitySpan["emphasis"],
): readonly ActivitySpan[] {
  const clipped = label.slice(0, width);
  const left = Math.max(0, Math.floor((width - clipped.length) / 2));
  const right = Math.max(0, width - clipped.length - left);
  return [span(" ".repeat(left)), span(clipped, style, emphasis), span(" ".repeat(right))];
}

function renderBoard(
  state: Game2048State,
  viewport: ActivityViewport,
  animation: Animation | undefined,
  settledTrace: Game2048MoveTrace | undefined,
): readonly (readonly ActivitySpan[])[] {
  const gap = 1;
  const tileHeight = viewport.height >= 23 ? 5 : viewport.height >= 19 ? 4 : 3;
  const desiredCellWidth = tileHeight === 5 ? 11 : 9;
  const cellWidth = Math.max(
    9,
    Math.min(desiredCellWidth, Math.floor((viewport.width - gap * 3) / 4)),
  );
  const boardWidth = cellWidth * 4 + gap * 3;
  const padding = " ".repeat(Math.max(0, Math.floor((viewport.width - boardWidth) / 2)));
  const board = animation?.phase === "motion" ? animation.trace.landedBoard : state.board;
  const rows: Array<readonly ActivitySpan[]> = [];
  for (let row = 0; row < 4; row += 1) {
    const values = board.slice(row * 4, row * 4 + 4);
    const top: ActivitySpan[] = [span(padding)];
    const interior = Array.from(
      { length: tileHeight - 2 },
      () => [span(padding)] as ActivitySpan[],
    );
    const bottom: ActivitySpan[] = [span(padding)];
    values.forEach((value, column) => {
      const index = row * 4 + column;
      const kind = tileKind(value as number);
      const cue = tileCue(index, animation, settledTrace);
      const box = tileBox(kind, cue);
      const style = cue === "merge" ? "success" : cue === "spawn" ? "accent" : tileStyle(kind);
      top.push(
        span(box.topLeft, style),
        span(box.horizontal.repeat(cellWidth - 2), style),
        span(box.topRight, style),
      );
      interior.forEach((content, contentRow) => {
        content.push(span(box.vertical, style));
        content.push(
          ...paddedLabel(
            contentRow === Math.floor(interior.length / 2) && value !== 0 ? String(value) : "",
            cellWidth - 2,
            style,
            cue !== undefined || kind === "target" || kind === "beyond" ? "strong" : "none",
          ),
        );
        content.push(span(box.vertical, style));
      });
      bottom.push(
        span(box.bottomLeft, style),
        span(box.horizontal.repeat(cellWidth - 2), style),
        span(box.bottomRight, style),
      );
      if (column < 3) {
        top.push(span(" "));
        for (const content of interior) content.push(span(" "));
        bottom.push(span(" "));
      }
    });
    rows.push(line(...top), ...interior.map((content) => line(...content)), line(...bottom));
  }
  return rows;
}

function statusText(
  state: Game2048State,
  animation: Animation | undefined,
  settledTrace: Game2048MoveTrace | undefined,
  warning: string | undefined,
  queuedMove: Game2048Direction | undefined,
): { readonly text: string; readonly style: ActivitySpan["style"]; readonly strong: boolean } {
  if (warning !== undefined) return { text: warning, style: "error", strong: false };
  if (state.status === "won") {
    return { text: "◆ 2048 REACHED · KEEP GOING? ◆", style: "success", strong: true };
  }
  if (state.status === "lost") {
    return { text: "! GAME OVER · NO MOVES LEFT !", style: "error", strong: true };
  }
  if (animation?.phase === "motion") {
    const gained = animation.trace.merges.reduce((total, merge) => total + merge.value, 0);
    const queued =
      queuedMove === undefined
        ? ""
        : `  ·  ${directionGlyph(queuedMove)} ${queuedMove.toUpperCase()} NEXT`;
    return {
      text: `${directionGlyph(animation.trace.direction)} ${animation.trace.direction.toUpperCase()}${gained === 0 ? "" : `  ·  MERGE +${gained}`}${queued}`,
      style: gained === 0 ? "accent" : "success",
      strong: gained > 0,
    };
  }
  const trace = animation?.trace ?? settledTrace;
  if (trace?.spawn !== undefined) {
    const undo = state.undo === undefined ? "" : "  ·  U UNDO";
    return {
      text: `NEW ${trace.spawn.value}${undo}`,
      style: "accent",
      strong: false,
    };
  }
  return {
    text: "Slide with ← ↑ ↓ → or WASD / HJKL",
    style: "muted",
    strong: false,
  };
}

function actionText(state: Game2048State): string {
  if (state.status === "won") return "Enter/C Continue · R New · Ctrl+P Games";
  if (state.status === "lost") {
    return state.undo === undefined
      ? "Enter/R New game · ? Help · Ctrl+P Games"
      : "Enter/R New · U Undo · Ctrl+P Games";
  }
  return state.undo === undefined
    ? "R New game · ? Help · Ctrl+P Games"
    : "U Undo · R New · ? Help · Ctrl+P Games";
}

function renderGame(
  viewport: ActivityViewport,
  state: Game2048State,
  bestScore: number,
  panel: Panel,
  animation: Animation | undefined,
  settledTrace: Game2048MoveTrace | undefined,
  warning: string | undefined,
  queuedMove: Game2048Direction | undefined,
): ActivityFrame {
  if (panel === "help") {
    return Object.freeze({
      lines: Object.freeze(
        [
          centered("2048 · HOW TO PLAY", viewport.width, "accent", "strong"),
          centered("Join equal tiles to reach 2048.", viewport.width),
          centered("Arrows · WASD · HJKL move", viewport.width),
          centered("A dotted box marks the new tile.", viewport.width, "muted"),
          centered("A heavy box marks a merge.", viewport.width, "muted"),
          centered("U undo when available · R restart · C continue", viewport.width, "muted"),
          centered("? resume · Tab agent · Esc close", viewport.width, "muted"),
        ].slice(0, viewport.height),
      ),
    });
  }
  if (panel === "restart") {
    return Object.freeze({
      lines: Object.freeze(
        [
          centered("RESTART 2048?", viewport.width, "warning", "strong"),
          centered(`Score ${state.score} and current progress will be replaced.`, viewport.width),
          centered("y restart · n continue · Esc close Lounge", viewport.width, "muted"),
        ].slice(0, viewport.height),
      ),
    });
  }
  const status = statusText(state, animation, settledTrace, warning, queuedMove);
  const tileHeight = viewport.height >= 23 ? 5 : viewport.height >= 19 ? 4 : 3;
  const spacious = viewport.height >= tileHeight * 4 + 5;
  return Object.freeze({
    lines: Object.freeze(
      [
        centered(`SCORE  ${state.score}     BEST  ${bestScore}`, viewport.width, "text", "strong"),
        ...(spacious ? [line()] : []),
        ...renderBoard(state, viewport, animation, settledTrace),
        ...(spacious ? [line()] : []),
        centered(status.text, viewport.width, status.style, status.strong ? "strong" : "none"),
        centered(actionText(state), viewport.width, "muted"),
      ].slice(0, viewport.height),
    ),
    ...(state.status === "won"
      ? { announcement: "2048 reached" }
      : state.status === "lost"
        ? { announcement: "Game over" }
        : {}),
  });
}

function direction(
  input: Extract<ActivityInput, { readonly type: "key" }>,
): Game2048Direction | undefined {
  if (input.ctrl || input.alt) return undefined;
  const key = input.key.toLowerCase();
  if (key === "left" || key === "a" || key === "h") return "left";
  if (key === "right" || key === "d" || key === "l") return "right";
  if (key === "up" || key === "w" || key === "k") return "up";
  if (key === "down" || key === "s" || key === "j") return "down";
  return undefined;
}

export function game2048Activity(options: Game2048ActivityOptions = {}): TerminalActivity {
  return {
    id: "axl.lounge.2048",
    name: "2048",
    description: "Slide and merge tiles to reach 2048",
    category: "game",
    minimumViewport: Object.freeze({ width: 40, height: 15 }),
    create(context) {
      const nextSeed = options.seed ?? (() => Date.now());
      let state = createGame2048(nextSeed());
      let bestScore = 0;
      let revision: number | null = null;
      let panel: Panel = context.storage === undefined ? "game" : "loading";
      let panelBeforeHelp: Exclude<Panel, "help"> = "game";
      let inputEnabled = true;
      let active = true;
      let focused = true;
      let warning: string | undefined;
      let canReset = false;
      let writeQueue = Promise.resolve();
      let animation: Animation | undefined;
      let settledTrace: Game2048MoveTrace | undefined;
      let queuedMove: Game2048Direction | undefined;
      let cancelAnimation: (() => void) | undefined;

      const invalidate = (): void => {
        if (active) context.invalidate();
      };
      const clearAnimation = (retainLanding = true): void => {
        cancelAnimation?.();
        cancelAnimation = undefined;
        if (retainLanding && animation?.phase === "settle") settledTrace = animation.trace;
        animation = undefined;
        queuedMove = undefined;
      };
      const document = (): Game2048SaveDocument => updateGame2048Save(state, bestScore);
      const persist = (): void => {
        const storage = context.storage;
        if (storage === undefined) return;
        const saved = document();
        bestScore = saved.bestScore;
        writeQueue = writeQueue
          .then(async () => {
            const stored = await storage.write(
              revision,
              GAME_2048_STORAGE_SCHEMA_VERSION,
              game2048SaveJson(saved),
            );
            revision = stored.revision;
          })
          .catch((error: unknown) => {
            if (error instanceof ActivityStorageError && error.code === "aborted") return;
            warning = error instanceof Error ? error.message : "2048 save failed";
            invalidate();
          });
      };
      const restart = (): void => {
        clearAnimation(false);
        settledTrace = undefined;
        state = createGame2048(nextSeed());
        bestScore = Math.max(bestScore, state.score);
        panel = "game";
        warning = undefined;
        persist();
        context.invalidate();
      };
      const motionEnabled = (): boolean => {
        const presentation = context.presentation();
        return !presentation.reducedMotion && !presentation.textOnly;
      };

      const runQueuedMove = (): void => {
        cancelAnimation = undefined;
        if (!active || !focused || panel !== "game") {
          animation = undefined;
          queuedMove = undefined;
          return;
        }
        const queued = queuedMove;
        queuedMove = undefined;
        animation = undefined;
        if (queued !== undefined) performMove(queued);
      };
      const scheduleQueuedMove = (): void => {
        if (queuedMove !== undefined && cancelAnimation === undefined) {
          cancelAnimation = context.schedule(67, runQueuedMove);
        }
      };

      const performMove = (move: Game2048Direction): void => {
        const result = moveGame2048(state, move);
        if (!result.trace.changed) {
          clearAnimation(false);
          settledTrace = undefined;
          warning = `No move ${move}`;
          context.invalidate();
          return;
        }
        clearAnimation(false);
        state = result.state;
        bestScore = Math.max(bestScore, state.score);
        warning = undefined;
        settledTrace = result.trace;
        persist();
        if (motionEnabled()) {
          animation = { phase: "motion", trace: result.trace };
          cancelAnimation = context.schedule(67, () => {
            cancelAnimation = undefined;
            if (!active || !focused || panel !== "game") {
              animation = undefined;
              queuedMove = undefined;
              return;
            }
            animation = { phase: "settle", trace: result.trace };
            context.invalidate();
            scheduleQueuedMove();
          });
        }
        context.invalidate();
      };

      if (context.storage !== undefined) {
        writeQueue = context.storage
          .read(context.signal)
          .then((stored) => {
            if (stored !== undefined) {
              revision = stored.revision;
              if (stored.schemaVersion !== GAME_2048_STORAGE_SCHEMA_VERSION) {
                throw new Game2048SaveError(
                  stored.schemaVersion > GAME_2048_STORAGE_SCHEMA_VERSION
                    ? "future-version"
                    : "corrupt",
                  `Unsupported 2048 storage schema ${stored.schemaVersion}`,
                );
              }
              const restored = parseGame2048Save(stored.value);
              state = restored.game;
              bestScore = restored.bestScore;
            }
            panel = "game";
            if (stored === undefined) persist();
            invalidate();
          })
          .catch((error: unknown) => {
            if (error instanceof ActivityStorageError && error.code === "aborted") return;
            warning = error instanceof Error ? error.message : "2048 save cannot be read";
            canReset = revision !== null;
            panel = "storage-error";
            invalidate();
          });
      }

      return {
        render(viewport) {
          inputEnabled = viewport.width >= 40 && viewport.height >= 15;
          if (panel === "loading") {
            return Object.freeze({
              lines: Object.freeze([centered("Loading 2048…", viewport.width, "muted")]),
            });
          }
          if (panel === "storage-error") {
            return Object.freeze({
              lines: Object.freeze(
                [
                  centered("2048 SAVE UNAVAILABLE", viewport.width, "error", "strong"),
                  centered(warning ?? "Saved game cannot be read", viewport.width, "warning"),
                  centered(
                    canReset ? "R reset saved state · Esc return" : "Esc return",
                    viewport.width,
                    "muted",
                  ),
                ].slice(0, viewport.height),
              ),
            });
          }
          return renderGame(
            viewport,
            state,
            bestScore,
            panel,
            animation,
            settledTrace,
            warning,
            queuedMove,
          );
        },
        handleInput(input) {
          if (input.type === "focus") {
            focused = input.focused;
            if (!focused) clearAnimation();
            return;
          }
          if (
            !active ||
            !focused ||
            input.type !== "key" ||
            input.repeat ||
            !inputEnabled ||
            panel === "loading"
          ) {
            return;
          }
          if (panel === "storage-error") {
            if (canReset && input.key.toLowerCase() === "r" && revision !== null) {
              void context.storage
                ?.reset(revision)
                .then(() => {
                  revision = null;
                  canReset = false;
                  restart();
                })
                .catch((error: unknown) => {
                  if (error instanceof ActivityStorageError && error.code === "aborted") return;
                  warning = error instanceof Error ? error.message : "2048 reset failed";
                  invalidate();
                });
            }
            return;
          }
          if (input.key === "?" && !input.ctrl && !input.alt) {
            clearAnimation();
            if (panel === "help") panel = panelBeforeHelp;
            else {
              panelBeforeHelp = panel;
              panel = "help";
            }
            context.invalidate();
            return;
          }
          if (panel === "help") return;
          if (panel === "restart") {
            if (!input.ctrl && !input.alt && input.key.toLowerCase() === "y") restart();
            else if (!input.ctrl && !input.alt && input.key.toLowerCase() === "n") {
              panel = "game";
              context.invalidate();
            }
            return;
          }
          if (input.ctrl || input.alt) return;
          const key = input.key.toLowerCase();
          const move = direction(input);
          if (state.status === "won" && (key === "enter" || key === "c")) {
            clearAnimation(false);
            settledTrace = undefined;
            state = reduceGame2048(state, { type: "continue" });
            warning = state.status === "lost" ? undefined : "Continue beyond 2048";
            persist();
            context.invalidate();
            return;
          }
          if (state.status === "lost" && (key === "enter" || key === "r" || key === "n")) {
            restart();
            return;
          }
          if (move !== undefined && state.status !== "active") return;
          if (move !== undefined && animation !== undefined) {
            if (queuedMove === undefined) {
              queuedMove = move;
              scheduleQueuedMove();
              context.invalidate();
            }
            return;
          }
          if (key === "r" || key === "n") {
            clearAnimation();
            if (state.status === "active" && state.undo !== undefined) {
              panel = "restart";
              context.invalidate();
            } else restart();
            return;
          }
          if (move !== undefined) {
            performMove(move);
            return;
          }
          const previous = state;
          if (key === "u" && state.undo !== undefined) {
            clearAnimation(false);
            settledTrace = undefined;
            state = reduceGame2048(state, { type: "undo" });
            warning = "Move undone";
          }
          if (state !== previous) {
            persist();
            context.invalidate();
          }
        },
        presentationChanged: () => {
          if (context.presentation().reducedMotion || context.presentation().textOnly) {
            clearAnimation();
          }
          context.invalidate();
        },
        pause: () => {
          active = false;
          focused = false;
          clearAnimation();
        },
        resume: () => {
          active = true;
          focused = true;
        },
        serialize: () => game2048SaveJson(document()),
        dispose: () => {
          active = false;
          focused = false;
          clearAnimation();
          return writeQueue;
        },
      };
    },
  };
}
