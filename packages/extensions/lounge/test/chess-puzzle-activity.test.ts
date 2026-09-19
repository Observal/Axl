// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type ActivityContext,
  type ActivityFrame,
  type ActivityInput,
  type ActivityStorage,
  ActivityStorageError,
  type ActivityStoredValue,
  type JsonValue,
} from "@axl/extension-api";
import { renderChessBoardRaster } from "../src/chess-puzzle-art.ts";
import {
  CHESS_PUZZLE_SET_REVISION,
  CHESS_PUZZLE_THEMES,
  CHESS_PUZZLES,
} from "../src/chess-puzzles.generated.ts";
import {
  type ChessPuzzleCatalog,
  type ChessPuzzleDifficulty,
  type ChessPuzzleState,
  chessPuzzleActivity,
  chessPuzzleExpectedMove,
  chessPuzzleSaveJson,
  createChessPuzzle,
  createEmptyChessPuzzleSave,
  createPracticeChessPuzzleSelection,
  legalChessMoves,
  parseChessPuzzleSave,
  reduceChessPuzzle,
  submitChessPuzzleMove,
  updateChessPuzzleSave,
} from "../src/index.ts";

const catalog: ChessPuzzleCatalog = Object.freeze({
  revision: CHESS_PUZZLE_SET_REVISION,
  puzzles: CHESS_PUZZLES,
});

class MemoryStorage implements ActivityStorage {
  stored: ActivityStoredValue | undefined;

  read(): Promise<ActivityStoredValue | undefined> {
    return Promise.resolve(this.stored);
  }

  write(
    expectedRevision: number | null,
    schemaVersion: number,
    value: JsonValue,
  ): Promise<ActivityStoredValue> {
    if ((this.stored?.revision ?? null) !== expectedRevision)
      throw new ActivityStorageError("conflict", "stale revision");
    this.stored = Object.freeze({
      revision: (this.stored?.revision ?? 0) + 1,
      schemaVersion,
      value,
    });
    return Promise.resolve(this.stored);
  }

  reset(expectedRevision: number): Promise<void> {
    if (this.stored?.revision !== expectedRevision)
      throw new ActivityStorageError("conflict", "stale revision");
    this.stored = undefined;
    return Promise.resolve();
  }
}

class DeferredReadStorage extends MemoryStorage {
  writes = 0;
  private resolveRead: ((value: ActivityStoredValue | undefined) => void) | undefined;

  override read(): Promise<ActivityStoredValue | undefined> {
    return new Promise((resolve) => {
      this.resolveRead = resolve;
    });
  }

  override write(
    expectedRevision: number | null,
    schemaVersion: number,
    value: JsonValue,
  ): Promise<ActivityStoredValue> {
    this.writes += 1;
    return super.write(expectedRevision, schemaVersion, value);
  }

  release(value?: ActivityStoredValue): void {
    this.resolveRead?.(value);
  }
}

interface Scheduled {
  active: boolean;
  readonly delay: number;
  readonly callback: (elapsedMs: number) => void;
}

function fixture(
  options: {
    readonly storage?: ActivityStorage;
    readonly textOnly?: boolean;
    readonly reducedMotion?: boolean;
  } = {},
) {
  let presentation = {
    textOnly: options.textOnly ?? false,
    reducedMotion: options.reducedMotion ?? false,
  };
  const scheduled: Scheduled[] = [];
  let invalidations = 0;
  const value: ActivityContext = {
    signal: new AbortController().signal,
    now: () => 100,
    status: () => ({
      operation: "idle",
      activeToolCount: 0,
      queuedInput: { steer: 0, followUp: 0, interrupt: 0 },
    }),
    presentation: () => presentation,
    invalidate: () => {
      invalidations += 1;
    },
    schedule: (delay, callback) => {
      const item = { active: true, delay, callback };
      scheduled.push(item);
      return () => {
        item.active = false;
      };
    },
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  };
  return {
    value,
    scheduled,
    setPresentation(next: { readonly textOnly: boolean; readonly reducedMotion: boolean }) {
      presentation = next;
    },
    get invalidations() {
      return invalidations;
    },
  };
}

function activity(
  context: ActivityContext,
  options: {
    readonly activityCatalog?: ChessPuzzleCatalog;
    readonly date?: string;
    readonly seed?: number;
  } = {},
) {
  let seed = options.seed ?? 41;
  return chessPuzzleActivity({
    catalog: options.activityCatalog ?? catalog,
    themes: CHESS_PUZZLE_THEMES,
    utcDate: () => options.date ?? "2026-09-12",
    practiceSeed: () => seed++,
    replyDelayMs: 420,
  }).create(context);
}

function key(value: string): Extract<ActivityInput, { readonly type: "key" }> {
  return { type: "key", key: value, ctrl: false, alt: false, shift: false, repeat: false };
}

function text(frame: ActivityFrame): string {
  return frame.lines.map((row) => row.map(({ text: value }) => value).join("")).join("\n");
}

function displayWidth(value: string): number {
  return value.replace(/[\uFE0E\uFE0F]/gu, "").length;
}

function widths(frame: ActivityFrame): readonly number[] {
  return frame.lines.map((row) => displayWidth(row.map(({ text: value }) => value).join("")));
}

function markerLocation(
  frame: ActivityFrame,
  marker: string,
): { readonly row: number; readonly column: number } {
  for (const [row, spans] of frame.lines.entries()) {
    let column = 0;
    for (const item of spans) {
      const markerOffset = item.text.indexOf(marker);
      if (markerOffset >= 0)
        return { row, column: column + displayWidth(item.text.slice(0, markerOffset)) };
      column += displayWidth(item.text);
    }
  }
  throw new Error(`Missing board marker ${marker}`);
}

function assertVisualBoardGeometry(frame: ActivityFrame, width: number, height: number): void {
  const rows = frame.lines.map((row) => row.map(({ text: value }) => value).join(""));
  assert.equal(frame.lines.length, height, "frame must fill its allocation");
  assert.equal(frame.images?.length, 1, "visual mode must expose one generic raster");
  const image = frame.images?.[0];
  assert.ok(image);
  assert.equal(image.format, "indexed");
  assert.equal(image.width, 384);
  assert.equal(image.height, 384);
  assert.equal(image.width, image.height, "board pixels must be strictly square");
  assert.equal(image.pixels.length, image.width * image.height);
  assert.deepEqual(image.placement, {
    row: height === 28 ? 6 : 3,
    column: Math.round((width - 32) / 2),
    columns: 32,
    rows: 16,
  });
  const boardRows = frame.lines.slice(
    image.placement.row,
    image.placement.row + image.placement.rows,
  );
  assert.equal(boardRows.length, 16, "text fallback must reserve every image row");
  for (const row of boardRows) {
    const cells = row.filter(({ background }) => background !== undefined);
    assert.equal(
      cells.reduce((total, item) => total + displayWidth(item.text), 0),
      32,
    );
    assert.equal(cells.length, 8);
    assert.ok(
      cells.every(
        ({ background }) => background === "surface" || background === "surfaceAlternate",
      ),
      "transient states must preserve the checkerboard fallback",
    );
  }
  const boardBottom = image.placement.row + image.placement.rows - 1;
  for (const pattern of [/to move/u, /DAILY/u]) {
    const row = rows.findIndex((value) => pattern.test(value));
    assert.ok(
      row >= 0 && row < image.placement.row,
      `${pattern.source} guidance must be above board`,
    );
  }
  assert.ok(
    rows.findIndex((row) => /Arrows/u.test(row)) > boardBottom,
    "controls must stay directly below the board",
  );
  const boardText = boardRows.flatMap((row) => row.map(({ text: value }) => value)).join("\n");
  assert.match(boardText, /w[KQRBNP]/u);
  assert.match(boardText, /b[KQRBNP]/u);
  assert.doesNotMatch(boardText, /[░▓▄█▖▗▙▟▜▌♔♕♖♗♘♙♚♛♜♝♞♟]/u);
  assert.ok(image.pixels.includes(3), "white piece fill must be present");
  assert.ok(image.pixels.includes(5), "black piece fill must be present");
}

async function settle(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}

function onePuzzle(id: string): ChessPuzzleCatalog {
  const puzzle = CHESS_PUZZLES.find((candidate) => candidate.id === id);
  const easy = CHESS_PUZZLES.find((candidate) => candidate.id === "0bg6I");
  if (puzzle === undefined || easy === undefined) throw new Error(`Missing fixture puzzle ${id}`);
  return Object.freeze({
    revision: CHESS_PUZZLE_SET_REVISION,
    puzzles: Object.freeze(puzzle.difficulty === "easy" ? [puzzle] : [easy, puzzle]),
  });
}

function savedState(state: ChessPuzzleState, difficulty: ChessPuzzleDifficulty): MemoryStorage {
  const storage = new MemoryStorage();
  const preferences = Object.freeze({
    mode: "practice" as const,
    difficulty,
    theme: "any" as const,
    orientation: state.orientation,
  });
  const document = updateChessPuzzleSave(createEmptyChessPuzzleSave(), state, preferences).document;
  storage.stored = Object.freeze({
    revision: 1,
    schemaVersion: 1,
    value: chessPuzzleSaveJson(document),
  });
  return storage;
}

function stateFor(
  activityCatalog: ChessPuzzleCatalog,
  difficulty: ChessPuzzleDifficulty,
): ChessPuzzleState {
  return createChessPuzzle(
    activityCatalog,
    createPracticeChessPuzzleSelection(activityCatalog.revision, 1, difficulty, "any"),
  );
}

function restoredState(
  instance: ReturnType<typeof activity>,
  activityCatalog = catalog,
): ChessPuzzleState {
  const parsed = parseChessPuzzleSave(instance.serialize() as JsonValue, activityCatalog).state;
  if (parsed === undefined) throw new Error("Expected saved Chess state");
  return parsed;
}

test("Chess uses calm fixed tiles in actual compact, standard, and wide-shell allocations", () => {
  for (const viewport of [
    { width: 40, height: 22 },
    { width: 80, height: 22 },
    { width: 54, height: 28 },
  ]) {
    const instance = activity(fixture().value);
    const frame = instance.render(viewport);
    const rendered = text(frame);
    assert.ok(frame.lines.length <= viewport.height);
    assert.ok(widths(frame).every((lineWidth) => lineWidth <= viewport.width));
    assertVisualBoardGeometry(frame, viewport.width, viewport.height);
    assert.match(rendered, /Black/);
    assert.match(rendered, /DAILY · EASY · DEFLECTION/);
    assert.match(rendered, /Black · (?:Move )?1\/4 · (?:YOUR )?MOVE/);
    assert.match(rendered, /Black to move · find (?:the )?(?:best )?tactic/);
    assert.match(rendered, /Select one of your pieces to begin/);
    const state = restoredState(instance);
    const expected = chessPuzzleExpectedMove(catalog, state);
    assert.ok(expected);
    const file = expected.from % 8;
    const rank = Math.floor(expected.from / 8);
    const visualColumn = state.orientation === "white" ? file : 7 - file;
    const visualRow = state.orientation === "white" ? 7 - rank : rank;
    const boardImage = frame.images?.[0];
    assert.ok(boardImage);
    const sourceRow = frame.lines[boardImage.placement.row + visualRow * 2 + 1];
    const sourceText = sourceRow?.map(({ text: value }) => value).join("") ?? "";
    const sourceMarker = sourceText[Math.round((viewport.width - 32) / 2) + visualColumn * 4];
    assert.notEqual(sourceMarker, ">", "the solution source must not receive the startup cursor");
    assert.match(rendered, /D difficulty|D level|D Lv|D\/T\/M\/R/iu);
    assert.match(rendered, /M mode|D\/T\/M\/R/iu);
  }
});

test("Chess renders both orientations, setup markers, selection, quiet and capture targets", async () => {
  const targetCatalog = onePuzzle("0Ozbu");
  let state = stateFor(targetCatalog, "hard");
  state = reduceChessPuzzle(targetCatalog, state, { type: "activate" });
  const storage = savedState(state, "hard");
  const instance = activity(fixture({ storage }).value, { activityCatalog: targetCatalog });
  await settle();
  let frame = instance.render({ width: 80, height: 24 });
  let rendered = text(frame);
  assert.ok(frame.lines.flat().some(({ text: value }) => value.includes("*")));
  assert.ok(frame.lines.flat().some(({ text: value }) => value.includes("·")));
  assert.ok(frame.lines.flat().some(({ text: value }) => value.includes("x")));
  assert.equal(frame.images?.length, 1);
  assert.ok(
    (frame.images?.[0]?.pixels.filter((pixel) => pixel === 6).length ?? 0) > 100,
    "selected border and legal move dots must be prominent",
  );
  assert.ok(
    (frame.images?.[0]?.pixels.filter((pixel) => pixel === 7).length ?? 0) > 100,
    "capture corners must be prominent",
  );
  assert.match(rendered, /<|>/u);
  assert.match(rendered, /White Knight f6 selected/);
  assert.match(rendered, /Selected/);
  assert.match(rendered, /Last c7→c6/);
  assert.equal(
    frame.lines
      .flat()
      .some(
        ({ background }) =>
          background !== undefined && background !== "surface" && background !== "surfaceAlternate",
      ),
    false,
  );
  const whiteOrientation = frame.images?.[0]?.pixels;
  instance.handleInput(key("b"));
  frame = instance.render({ width: 80, height: 24 });
  rendered = text(frame);
  assert.notDeepEqual(frame.images?.[0]?.pixels, whiteOrientation);
  assert.equal(restoredState(instance, targetCatalog).orientation, "black");
  await instance.dispose();
});

test("every piece type uses the bounded square raster with a stable text fallback", async () => {
  const defaultInstance = activity(fixture().value);
  const defaultFrame = defaultInstance.render({ width: 54, height: 28 });
  const targetCatalog = onePuzzle("0Ozbu");
  const targetInstance = activity(
    fixture({ storage: savedState(stateFor(targetCatalog, "hard"), "hard") }).value,
    { activityCatalog: targetCatalog },
  );
  await settle();
  const targetFrame = targetInstance.render({ width: 54, height: 28 });
  const knightCatalog = onePuzzle("09IGa");
  const knightInstance = activity(
    fixture({ storage: savedState(stateFor(knightCatalog, "hard"), "hard") }).value,
    { activityCatalog: knightCatalog },
  );
  await settle();
  const knightFrame = knightInstance.render({ width: 54, height: 28 });
  const frames = [defaultFrame, targetFrame, knightFrame];
  const rendered = frames.map(text).join("\n");
  for (const label of ["wK", "wQ", "wR", "wB", "wN", "wP", "bK", "bQ", "bR", "bB", "bN", "bP"]) {
    assert.match(rendered, new RegExp(label), label);
  }
  for (const frame of frames) {
    const image = frame.images?.[0];
    assert.ok(image);
    assert.equal(image.width, image.height);
    assert.ok(image.palette.length <= 16);
    assert.ok(image.pixels.every((pixel) => pixel < image.palette.length));
  }

  const compactInstance = activity(fixture().value);
  const compact = compactInstance.render({ width: 40, height: 22 });
  assert.equal(compact.images?.[0]?.placement.columns, 32);

  const textOnlyInstance = activity(fixture({ textOnly: true }).value);
  const textOnlyFrame = textOnlyInstance.render({ width: 54, height: 28 });
  const textOnly = text(textOnlyFrame);
  assert.equal(textOnlyFrame.images, undefined);
  assert.match(textOnly, /[wb][KQRBNP]/u);

  await defaultInstance.dispose();
  await targetInstance.dispose();
  await knightInstance.dispose();
  await compactInstance.dispose();
  await textOnlyInstance.dispose();
});

test("original piece artwork is large, centered, and distinct for every piece", () => {
  const pieces = ["K", "Q", "R", "B", "N", "P", "k", "q", "r", "b", "n", "p"] as const;
  const image = renderChessBoardRaster(
    {
      squares: Array.from({ length: 64 }, (_, index) => ({ piece: pieces[index] ?? null })),
      orientation: "white",
    },
    { row: 0, column: 0, columns: 32, rows: 16 },
  );
  const signatures = new Set<string>();
  for (const [index, piece] of pieces.entries()) {
    const row = Math.floor(index / 8);
    const column = index % 8;
    const fill = piece === piece.toUpperCase() ? 3 : 5;
    const points: Array<readonly [number, number]> = [];
    for (let y = 0; y < 48; y += 1) {
      for (let x = 0; x < 48; x += 1) {
        if (image.pixels[(row * 48 + y) * 384 + column * 48 + x] === fill) points.push([x, y]);
      }
    }
    assert.ok(points.length > 280, `${piece} must fill a substantial part of its square`);
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    assert.ok(right - left >= 18, `${piece} must be visibly wide`);
    assert.ok(bottom - top >= 29, `${piece} must be visibly tall`);
    assert.ok(Math.abs((left + right) / 2 - 23.5) <= 2, `${piece} must be centered`);
    signatures.add(`${fill}:${points.map(([x, y]) => `${x},${y}`).join(";")}`);
  }
  assert.equal(signatures.size, 12, "every side and piece must have a stable rendered form");

  const coordinates = renderChessBoardRaster(
    { squares: Array.from({ length: 64 }, () => ({ piece: null })), orientation: "white" },
    { row: 0, column: 0, columns: 32, rows: 16 },
  );
  let rankInk = 0;
  for (let y = 2; y < 10; y += 1) {
    for (let x = 2; x < 10; x += 1) {
      if (coordinates.pixels[y * 384 + x] === 2) rankInk += 1;
    }
  }
  assert.ok(rankInk >= 16, "rank labels must remain slightly enlarged and readable");
});

test("Chess check and progressive hints have explicit non-color cues", async () => {
  const checkedCatalog = onePuzzle("0Jalw");
  let state = stateFor(checkedCatalog, "medium");
  state = reduceChessPuzzle(checkedCatalog, state, { type: "hint" });
  state = reduceChessPuzzle(checkedCatalog, state, { type: "hint" });
  state = reduceChessPuzzle(checkedCatalog, state, { type: "hint" });
  const storage = savedState(state, "medium");
  const instance = activity(fixture({ storage }).value, { activityCatalog: checkedCatalog });
  await settle();
  const frame = instance.render({ width: 80, height: 24 });
  const rendered = text(frame);
  assert.ok(frame.lines.flat().some(({ text: value }) => value.includes("!")));
  assert.equal(frame.images?.length, 1);
  assert.ok(
    (frame.images?.[0]?.pixels.filter((pixel) => pixel === 8).length ?? 0) > 100,
    "check border must be prominent",
  );
  assert.match(rendered, /Check/);
  assert.match(rendered, /Hint source/);
  assert.ok(frame.lines.flat().some(({ text: value }) => value.includes("2")));
  assert.match(rendered, /Hint 3\/3/);
  assert.match(rendered, /King g1 → g2/);
  assert.ok(
    frame.lines.flat().some(({ style, background }) => style === "error" || background === "error"),
  );
  assert.equal(
    frame.lines
      .flat()
      .some(
        ({ background }) =>
          background !== undefined && background !== "surface" && background !== "surfaceAlternate",
      ),
    false,
  );
  await instance.dispose();
});

test("every hint level is connected to its board square and instruction", async () => {
  const hintCatalog = onePuzzle("0Ozbu");
  for (const level of [1, 2, 3] as const) {
    let state = stateFor(hintCatalog, "hard");
    for (let index = 0; index < level; index += 1)
      state = reduceChessPuzzle(hintCatalog, state, { type: "hint" });
    const instance = activity(fixture({ storage: savedState(state, "hard") }).value, {
      activityCatalog: hintCatalog,
    });
    await settle();
    const rendered = text(instance.render({ width: 54, height: 28 }));
    assert.match(rendered, new RegExp(`Hint ${level}/3`));
    assert.match(rendered, /Hint source/);
    if (level >= 2) assert.match(rendered, /Hint target|2\s/u);
    if (level === 3) assert.match(rendered, /[A-Z][a-z]+ [a-h][1-8] → [a-h][1-8]/u);
    await instance.dispose();
  }
});

test("incorrect attempts stay on the board with explicit retry cues", async () => {
  let state = stateFor(catalog, "easy");
  const expected = chessPuzzleExpectedMove(catalog, state);
  const wrong = legalChessMoves(state.position).find(
    (move) => move.from !== expected.from || move.to !== expected.to,
  );
  assert.ok(wrong);
  state = submitChessPuzzleMove(catalog, state, wrong);
  const instance = activity(fixture({ storage: savedState(state, "easy") }).value);
  await settle();
  const rendered = text(instance.render({ width: 54, height: 28 }));
  assert.match(rendered, /legal, not the tactic · retry or G for hint/);
  assert.match(rendered, /[?!]/u);
  assert.match(rendered, /Error [a-h][1-8]→[a-h][1-8]/u);
  assert.match(rendered, /1 wrong/);
  await instance.dispose();
});

test("Chess promotion keeps the board visible and requires an explicit piece choice", async () => {
  const promotionCatalog = onePuzzle("0bg6I");
  const instance = activity(fixture().value, { activityCatalog: promotionCatalog });
  instance.render({ width: 80, height: 24 });
  instance.handleInput(key("enter"));
  instance.handleInput(key("up"));
  instance.handleInput(key("enter"));
  const rendered = text(instance.render({ width: 80, height: 24 }));
  assert.match(rendered, /Promote pawn on g8/);
  assert.match(rendered, /\[ Queen \].*Rook.*Bishop.*Knight/);
  assert.equal(instance.render({ width: 80, height: 24 }).images?.length, 1);
  instance.handleInput(key("right"));
  assert.equal(restoredState(instance, promotionCatalog).promotionChooser?.selected, "rook");
  assert.equal(instance.handleInput(key("escape")), true);
  assert.equal(restoredState(instance, promotionCatalog).promotionChooser, undefined);
  assert.notEqual(restoredState(instance, promotionCatalog).selectedSource, undefined);
  instance.handleInput(key("enter"));
  const chooserFrame = instance.render({ width: 80, height: 24 });
  const chooserText = text(chooserFrame);
  const row = chooserFrame.lines.findIndex((line) =>
    line
      .map(({ text: value }) => value)
      .join("")
      .includes("[ Queen ]"),
  );
  const column = chooserText.split("\n")[row]?.indexOf("[ Queen ]") ?? -1;
  assert.ok(row >= 0 && column >= 0);
  instance.handleInput({
    type: "mouse",
    phase: "press",
    button: "left",
    row,
    column,
    ctrl: false,
    alt: false,
    shift: false,
  });
  assert.equal(restoredState(instance, promotionCatalog).status, "reply-pending");
});

test("keyboard and left click share selection behavior with reselection, clearing, and invalid retry", () => {
  const instance = activity(fixture().value);
  instance.render({ width: 40, height: 24 });
  instance.handleInput(key("enter"));
  const selected = restoredState(instance);
  assert.notEqual(selected.selectedSource, undefined);
  instance.handleInput(key("left"));
  instance.handleInput(key("left"));
  instance.handleInput(key("enter"));
  assert.equal(restoredState(instance).selectedSource, 26);
  assert.equal(instance.handleInput(key("escape")), true);
  assert.equal(restoredState(instance).selectedSource, undefined);

  const cursor = markerLocation(instance.render({ width: 40, height: 22 }), ">");
  instance.handleInput({
    type: "mouse",
    phase: "press",
    button: "left",
    row: cursor.row,
    column: cursor.column,
    ctrl: false,
    alt: false,
    shift: false,
  });
  assert.notEqual(restoredState(instance).selectedSource, undefined);
  const source = restoredState(instance).selectedSource;
  instance.handleInput(key("left"));
  instance.handleInput(key("down"));
  instance.handleInput(key("down"));
  instance.handleInput(key("enter"));
  const retried = restoredState(instance);
  assert.equal(retried.selectedSource, source);
  assert.match(text(instance.render({ width: 40, height: 22 })), /has no legal moves/);

  instance.handleInput(key("up"));
  instance.handleInput(key("up"));
  instance.handleInput(key("right"));
  instance.handleInput(key("enter"));
  assert.equal(restoredState(instance).selectedSource, undefined);
});

test("mouse mapping reaches every visual corner and center at each raster allocation", async () => {
  const viewports = [
    { width: 40, height: 22 },
    { width: 80, height: 22 },
    { width: 54, height: 28 },
  ] as const;
  const targets = [
    { row: 0, column: 0 },
    { row: 0, column: 7 },
    { row: 7, column: 0 },
    { row: 7, column: 7 },
    { row: 3, column: 3 },
    { row: 4, column: 4 },
  ] as const;
  for (const viewport of viewports) {
    for (const target of targets) {
      const instance = activity(fixture().value);
      const placement = instance.render(viewport).images?.[0]?.placement;
      assert.ok(placement);
      instance.handleInput({
        type: "mouse",
        phase: "press",
        button: "left",
        row: placement.row + target.row * 2,
        column: placement.column + target.column * 4,
        ctrl: false,
        alt: false,
        shift: false,
      });
      const orientation = restoredState(instance).orientation;
      const file = orientation === "white" ? target.column : 7 - target.column;
      const rank = orientation === "white" ? 7 - target.row : target.row;
      assert.equal(
        restoredState(instance).cursor,
        rank * 8 + file,
        `${viewport.width}×${viewport.height} row ${target.row} column ${target.column}`,
      );
      await instance.dispose();
    }
  }
});

test("mouse mapping follows visual and text-only tile geometry at every allocation", () => {
  for (const presentation of [
    { textOnly: false, reducedMotion: false },
    { textOnly: true, reducedMotion: false },
  ]) {
    for (const viewport of [
      { width: 40, height: 22 },
      { width: 80, height: 22 },
      { width: 54, height: 28 },
    ]) {
      const instance = activity(fixture(presentation).value);
      instance.handleInput(key("right"));
      const before = restoredState(instance);
      const cursor = markerLocation(instance.render(viewport), ">");
      instance.handleInput({
        type: "mouse",
        phase: "press",
        button: "left",
        row: cursor.row,
        column: cursor.column,
        ctrl: false,
        alt: false,
        shift: false,
      });
      assert.equal(restoredState(instance).selectedSource, before.cursor);
      instance.handleInput({
        type: "mouse",
        phase: "release",
        button: "left",
        row: cursor.row,
        column: cursor.column,
        ctrl: false,
        alt: false,
        shift: false,
      });
      assert.equal(restoredState(instance).selectedSource, before.cursor);
    }
  }
});

test("correct moves render pending replies separately and lifecycle permits at most one resume timer", () => {
  const scheduledFixture = fixture();
  const instance = activity(scheduledFixture.value);
  instance.render({ width: 80, height: 24 });
  instance.handleInput(key("enter"));
  instance.handleInput(key("up"));
  instance.handleInput(key("up"));
  instance.handleInput(key("up"));
  instance.handleInput(key("enter"));
  assert.equal(restoredState(instance).status, "reply-pending");
  assert.match(text(instance.render({ width: 80, height: 24 })), /Opponent replying…/);
  assert.equal(scheduledFixture.scheduled.filter(({ active }) => active).length, 1);
  const pendingPosition = restoredState(instance).position;
  instance.pause("hidden");
  assert.equal(scheduledFixture.scheduled.filter(({ active }) => active).length, 0);
  assert.deepEqual(restoredState(instance).position, pendingPosition);
  instance.resume();
  instance.resume();
  assert.equal(scheduledFixture.scheduled.filter(({ active }) => active).length, 1);
  const reply = scheduledFixture.scheduled.find(({ active }) => active);
  reply?.callback(420);
  assert.equal(restoredState(instance).status, "active");
  assert.match(text(instance.render({ width: 80, height: 24 })), /Opponent c1→d2/);
});

test("every pause reason, focus loss, and disposal cancel a pending reply", async () => {
  const moveToPending = (instance: ReturnType<typeof activity>): void => {
    instance.render({ width: 80, height: 24 });
    instance.handleInput(key("enter"));
    instance.handleInput(key("up"));
    instance.handleInput(key("up"));
    instance.handleInput(key("up"));
    instance.handleInput(key("enter"));
    assert.equal(restoredState(instance).status, "reply-pending");
  };
  for (const reason of [
    "attention",
    "hidden",
    "unfocused",
    "monitor-focused",
    "unsupported-size",
    "disconnect",
    "completion",
    "failure",
    "session-switch",
    "reload",
  ] as const) {
    const pausedFixture = fixture();
    const instance = activity(pausedFixture.value);
    moveToPending(instance);
    instance.pause(reason);
    assert.equal(pausedFixture.scheduled.filter(({ active }) => active).length, 0, reason);
    await instance.dispose();
  }

  const focusFixture = fixture();
  const focused = activity(focusFixture.value);
  moveToPending(focused);
  focused.handleInput({ type: "focus", focused: false });
  assert.equal(focusFixture.scheduled.filter(({ active }) => active).length, 0);
  focused.handleInput({ type: "focus", focused: true });
  assert.equal(focusFixture.scheduled.filter(({ active }) => active).length, 1);
  await focused.dispose();
  assert.equal(focusFixture.scheduled.filter(({ active }) => active).length, 0);
});

test("text-only and reduced-motion frames apply replies immediately without scheduling", () => {
  for (const presentation of [
    { textOnly: true, reducedMotion: false },
    { textOnly: false, reducedMotion: true },
  ]) {
    const immediate = fixture(presentation);
    const instance = activity(immediate.value);
    instance.render({ width: 80, height: 24 });
    instance.handleInput(key("enter"));
    instance.handleInput(key("up"));
    instance.handleInput(key("up"));
    instance.handleInput(key("up"));
    instance.handleInput(key("enter"));
    assert.equal(restoredState(instance).status, "active");
    assert.equal(immediate.scheduled.length, 0);
    const rendered = text(instance.render({ width: 80, height: 24 }));
    assert.match(rendered, presentation.textOnly ? /TEXT/ : /CALM/);
    if (presentation.textOnly) {
      const frame = instance.render({ width: 80, height: 24 });
      assert.doesNotMatch(rendered, /[♔♕♖♗♘♙♚♛♜♝♞♟]|[▄█▖▗▙▟▜▌]/u);
      assert.match(rendered, /[wb][KQRBNP]/u);
      assert.equal(
        frame.lines.flat().some(({ background }) => background !== undefined),
        false,
      );
      assert.match(rendered, /Opponent c1→d2/);
    }
  }
});

test("solved frame retains the final board and presents a strong result with next actions", () => {
  const source = CHESS_PUZZLES.find(({ id }) => id === "0bg6I");
  if (source === undefined) throw new Error("Missing solved fixture");
  const solvedCatalog: ChessPuzzleCatalog = Object.freeze({
    revision: CHESS_PUZZLE_SET_REVISION,
    puzzles: Object.freeze([
      Object.freeze({
        ...source,
        solutionMoves: Object.freeze([source.solutionMoves[0] as string]),
      }),
    ]),
  });
  const instance = activity(fixture({ reducedMotion: true }).value, {
    activityCatalog: solvedCatalog,
  });
  instance.render({ width: 80, height: 24 });
  instance.handleInput(key("enter"));
  instance.handleInput(key("up"));
  instance.handleInput(key("enter"));
  instance.handleInput(key("enter"));
  const frame = instance.render({ width: 80, height: 24 });
  const rendered = text(frame);
  assert.equal(restoredState(instance, solvedCatalog).status, "solved");
  assert.match(rendered, /PUZZLE SOLVED/);
  assert.match(rendered, /\[ Next practice \] · Enter\/R · Ctrl\+P games/);
  assert.equal(frame.images?.length, 1);
  assert.match(frame.announcement ?? "", /Puzzle solved/);

  instance.handleInput(key("d"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /DIFFICULTY:/);
  assert.equal(instance.handleInput(key("escape")), true);

  const next = markerLocation(instance.render({ width: 80, height: 24 }), "[ Next practice ]");
  assert.equal(
    instance.handleInput({
      type: "mouse",
      phase: "press",
      button: "left",
      row: next.row,
      column: next.column + 2,
      ctrl: false,
      alt: false,
      shift: false,
    }),
    true,
  );
  assert.equal(restoredState(instance, solvedCatalog).status, "active");
  assert.equal(restoredState(instance, solvedCatalog).selection.kind, "practice");
  assert.match(text(instance.render({ width: 80, height: 24 })), /find the best tactic/);

  instance.handleInput(key("enter"));
  instance.handleInput(key("up"));
  instance.handleInput(key("enter"));
  instance.handleInput(key("enter"));
  assert.equal(restoredState(instance, solvedCatalog).status, "solved");
  assert.equal(instance.handleInput(key("enter")), true);
  assert.equal(restoredState(instance, solvedCatalog).status, "active");
});

test("difficulty, theme, mode, help, flip, and restart controls remain in-pane", () => {
  const instance = activity(fixture().value);
  instance.render({ width: 80, height: 24 });
  instance.handleInput(key("?"));
  const help = text(instance.render({ width: 80, height: 24 }));
  assert.match(help, /CHESS PUZZLES · HELP/);
  assert.match(help, /other legal moves count as mistakes/);
  assert.match(help, /highlighted square/);
  assert.equal(instance.handleInput(key("escape")), true);
  instance.handleInput(key("d"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /DIFFICULTY:.*EASY.*MEDIUM.*HARD/);
  instance.handleInput(key("right"));
  instance.handleInput(key("enter"));
  assert.equal(restoredState(instance).selection.difficulty, "medium");
  instance.handleInput(key("t"));
  for (const label of [
    "Any theme",
    "Fork",
    "Pin",
    "Skewer",
    "Discovered attack",
    "Deflection",
    "Sacrifice",
    "Promotion",
    "Mate",
    "Advanced pawn tactics",
  ]) {
    assert.match(text(instance.render({ width: 80, height: 24 })), new RegExp(label));
    instance.handleInput(key("right"));
  }
  instance.handleInput(key("right"));
  instance.handleInput(key("enter"));
  assert.equal(restoredState(instance).selection.theme, "fork");
  instance.handleInput(key("m"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /MODE:.*Daily.*Practice/);
  instance.handleInput(key("right"));
  instance.handleInput(key("enter"));
  assert.equal(restoredState(instance).selection.kind, "practice");
  instance.handleInput(key("g"));
  instance.handleInput(key("r"));
  assert.match(text(instance.render({ width: 80, height: 24 })), /START A NEW PUZZLE/);
  instance.handleInput(key("n"));
  assert.equal(instance.handleInput(key("escape")), false);
});

test("disposal prevents a late storage read from reviving activity work", async () => {
  const storage = new DeferredReadStorage();
  const context = fixture({ storage });
  const instance = activity(context.value);

  await instance.dispose();
  storage.release();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(storage.writes, 0);
  assert.equal(context.scheduled.length, 0);
  assert.equal(context.invalidations, 0);
});

test("presentation changes cancel pending work and apply an exact immediate reply", () => {
  const changing = fixture();
  const instance = activity(changing.value);
  instance.render({ width: 80, height: 24 });
  instance.handleInput(key("enter"));
  instance.handleInput(key("up"));
  instance.handleInput(key("up"));
  instance.handleInput(key("up"));
  instance.handleInput(key("enter"));
  assert.equal(changing.scheduled.filter(({ active }) => active).length, 1);
  changing.setPresentation({ textOnly: false, reducedMotion: true });
  instance.presentationChanged?.();
  assert.equal(changing.scheduled.filter(({ active }) => active).length, 0);
  assert.equal(restoredState(instance).status, "active");
});
