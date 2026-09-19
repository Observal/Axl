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
  createSudoku,
  reduceSudoku,
  sudokuConflicts,
  type SudokuDifficulty,
  type SudokuDirection,
  sudokuGivenValues,
  sudokuPeers,
  type SudokuState,
} from "./sudoku.ts";
import {
  parseSudokuSave,
  SUDOKU_STORAGE_SCHEMA_VERSION,
  SudokuSaveError,
  sudokuSaveJson,
  type SudokuSaveDocument,
  updateSudokuSave,
} from "./sudoku-state.ts";

export interface SudokuActivityOptions {
  readonly seed?: () => number;
}

type Panel = "loading" | "game" | "help" | "restart" | "difficulty" | "hint" | "storage-error";

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
): readonly ActivitySpan[] {
  const clipped = text.slice(0, Math.max(0, width));
  return line(
    span(" ".repeat(Math.max(0, Math.floor((width - clipped.length) / 2)))),
    span(clipped, style, emphasis),
  );
}

function difficultyName(difficulty: SudokuDifficulty): string {
  return difficulty === "easy" ? "EASY" : difficulty === "medium" ? "MEDIUM" : "HARD";
}

function notesText(mask: number): string {
  const digits: string[] = [];
  for (let digit = 1; digit <= 9; digit += 1)
    if ((mask & (1 << digit)) !== 0) digits.push(String(digit));
  return digits.join(" ");
}

function cellSpans(
  state: SudokuState,
  index: number,
  conflicts: ReadonlySet<number>,
  peers: ReadonlySet<number>,
  textOnly: boolean,
): readonly ActivitySpan[] {
  const givens = sudokuGivenValues(state);
  const value = state.values[index] as number;
  const selected = index === state.selected;
  const conflict = conflicts.has(index);
  const hinted = state.hinted[index] as boolean;
  const given = (givens[index] as number) !== 0;
  const note = value === 0 && (state.notes[index] as number) !== 0;
  const peer = peers.has(index);
  const glyph = value === 0 ? (note ? (textOnly ? "n" : "⁙") : " ") : String(value);
  const style: ActivitySpan["style"] = conflict
    ? "error"
    : hinted
      ? "success"
      : note
        ? "warning"
        : given
          ? "text"
          : value !== 0
            ? "accent"
            : peer
              ? "muted"
              : "text";
  const emphasis: ActivitySpan["emphasis"] =
    selected || conflict || hinted || given ? "strong" : "none";
  if (selected)
    return line(
      span("[", conflict ? "error" : "selection", "strong"),
      span(glyph, style, emphasis),
      span("]", conflict ? "error" : "selection", "strong"),
    );
  if (conflict)
    return line(
      span("!", "error", "strong"),
      span(glyph, "error", "strong"),
      span("!", "error", "strong"),
    );
  if (hinted)
    return line(
      span("+", "success", "strong"),
      span(glyph, "success", "strong"),
      span("+", "success", "strong"),
    );
  if (peer) return line(span("░", "muted"), span(glyph, style, emphasis), span("░", "muted"));
  if (!given && value !== 0)
    return line(span("·", "accent"), span(glyph, "accent", "strong"), span("·", "accent"));
  return line(span(" "), span(glyph, style, emphasis), span(" "));
}

function border(
  kind: "top" | "thin" | "strong" | "bottom",
  padding: number,
  cellWidth: number,
): readonly ActivitySpan[] {
  const [left, light, heavy, right, rule] =
    kind === "top"
      ? ["┏", "┯", "┳", "┓", "━"]
      : kind === "thin"
        ? ["┠", "┼", "╂", "┨", "─"]
        : kind === "strong"
          ? ["┣", "┿", "╋", "┫", "━"]
          : ["┗", "┷", "┻", "┛", "━"];
  const parts: ActivitySpan[] = [span(" ".repeat(padding)), span(left, "accent", "strong")];
  for (let column = 0; column < 9; column += 1) {
    parts.push(span(rule.repeat(cellWidth), "accent", kind === "thin" ? "none" : "strong"));
    if (column < 8)
      parts.push(
        span(
          (column + 1) % 3 === 0 ? heavy : light,
          "accent",
          (column + 1) % 3 === 0 ? "strong" : "none",
        ),
      );
  }
  parts.push(span(right, "accent", "strong"));
  return line(...parts);
}

function boardLines(
  state: SudokuState,
  width: number,
  height: number,
  textOnly: boolean,
): readonly (readonly ActivitySpan[])[] {
  const detailed = height >= 22;
  const cellWidth = width >= 46 ? 4 : 3;
  const boardWidth = 2 + cellWidth * 9 + 8;
  const padding = Math.max(0, Math.floor((width - boardWidth) / 2));
  const conflicts = sudokuConflicts(state.values);
  const peers = new Set(sudokuPeers(state.selected));
  const rows: Array<readonly ActivitySpan[]> = [border("top", padding, cellWidth)];
  for (let row = 0; row < 9; row += 1) {
    const parts: ActivitySpan[] = [span(" ".repeat(padding)), span("┃", "accent", "strong")];
    for (let column = 0; column < 9; column += 1) {
      parts.push(...cellSpans(state, row * 9 + column, conflicts, peers, textOnly));
      if (cellWidth > 3) parts.push(span(" "));
      if (column < 8)
        parts.push(
          span(
            (column + 1) % 3 === 0 ? "┃" : "│",
            "accent",
            (column + 1) % 3 === 0 ? "strong" : "none",
          ),
        );
    }
    parts.push(span("┃", "accent", "strong"));
    rows.push(line(...parts));
    if (row < 8) {
      if ((row + 1) % 3 === 0) rows.push(border("strong", padding, cellWidth));
      else if (detailed) rows.push(border("thin", padding, cellWidth));
    }
  }
  rows.push(border("bottom", padding, cellWidth));
  return Object.freeze(rows);
}

function selectedStatus(
  state: SudokuState,
  feedback: string,
  width: number,
): readonly ActivitySpan[] {
  const row = Math.floor(state.selected / 9) + 1;
  const column = (state.selected % 9) + 1;
  const givens = sudokuGivenValues(state);
  const conflicts = sudokuConflicts(state.values);
  const value = state.values[state.selected] as number;
  const notes = state.notes[state.selected] as number;
  const kind =
    givens[state.selected] !== 0
      ? "GIVEN"
      : state.hinted[state.selected]
        ? "HINT"
        : conflicts.has(state.selected)
          ? "CONFLICT"
          : value !== 0
            ? "ENTERED"
            : notes !== 0
              ? `NOTES ${notesText(notes)}`
              : "EMPTY";
  const detail =
    width < 60
      ? givens[state.selected] !== 0
        ? "locked"
        : conflicts.has(state.selected)
          ? "fix duplicate"
          : state.notesMode
            ? "1–9 toggles notes"
            : "enter 1–9"
      : feedback;
  const message = `R${row}C${column} · ${kind} · ${detail}`;
  return centered(
    message,
    width,
    conflicts.has(state.selected) ? "error" : "muted",
    conflicts.has(state.selected) ? "strong" : "none",
  );
}

function controls(state: SudokuState, width: number): readonly ActivitySpan[] {
  if (state.status === "won")
    return centered(
      width < 60
        ? "Enter/R New · D Level · Ctrl+P Games"
        : "Enter or R New puzzle · D Difficulty · Ctrl+P Games",
      width,
      "success",
      "strong",
    );
  const undo = state.history.length > 0 ? " · U Undo" : "";
  const full = `1–9 ${state.notesMode ? "note" : "enter"} · N Notes ${state.notesMode ? "ON" : "OFF"}${undo} · G Hint · R New · D Level · ? Help`;
  const compact = `1–9 · N ${state.notesMode ? "ON" : "notes"}${state.history.length > 0 ? " · U" : ""} · G Hint · R New · D · ?`;
  return centered(full.length <= width ? full : compact, width, "muted");
}

function difficultyControls(state: SudokuState, width: number): readonly ActivitySpan[] {
  return centered(
    width < 60
      ? `[D ${difficultyName(state.difficulty)}] · Ctrl+P Games`
      : `[D Difficulty: ${difficultyName(state.difficulty)}]  ·  Ctrl+P Games`,
    width,
    "muted",
  );
}

function render(
  viewport: ActivityViewport,
  state: SudokuState,
  panel: Panel,
  feedback: string,
  pendingDifficulty: SudokuDifficulty | undefined,
  canReset: boolean,
  textOnly: boolean,
): ActivityFrame {
  if (panel === "loading")
    return Object.freeze({
      lines: Object.freeze([centered("Loading Sudoku…", viewport.width, "muted")]),
    });
  if (panel === "storage-error")
    return Object.freeze({
      lines: Object.freeze([
        centered("SUDOKU SAVE UNAVAILABLE", viewport.width, "error", "strong"),
        centered(feedback, viewport.width, "warning"),
        centered(
          canReset ? "R Reset local save · Esc Close" : "Esc Close",
          viewport.width,
          "muted",
        ),
      ]),
    });
  if (panel === "help")
    return Object.freeze({
      lines: Object.freeze(
        [
          centered("SUDOKU · HOW TO PLAY", viewport.width, "accent", "strong"),
          centered("Fill every row, column, and 3×3 box with 1–9.", viewport.width),
          centered("Arrows/HJKL move · 1–9 enter", viewport.width),
          centered("Backspace/Delete erase · N notes · U undo", viewport.width),
          centered("G asks before filling the first empty cell", viewport.width),
          centered(
            "[ ] selected · ░ ░ peer · bold given · ·digit· entered",
            viewport.width,
            "muted",
          ),
          centered("⁙ notes · +digit+ hint · !digit! conflict", viewport.width, "muted"),
          centered("D changes difficulty · R new · Ctrl+P Games", viewport.width, "muted"),
          centered("? Back", viewport.width, "accent", "strong"),
        ].slice(0, viewport.height),
      ),
    });
  if (panel === "restart" || panel === "difficulty")
    return Object.freeze({
      lines: Object.freeze([
        centered(
          panel === "difficulty"
            ? `START ${difficultyName(pendingDifficulty ?? state.difficulty)} SUDOKU?`
            : "START A NEW SUDOKU?",
          viewport.width,
          "warning",
          "strong",
        ),
        centered("Entries, notes, hints, and undo history will be replaced.", viewport.width),
        centered("Y Replace · N Continue", viewport.width, "accent", "strong"),
      ]),
    });
  if (panel === "hint") {
    const empty = state.values.indexOf(0);
    const location =
      empty < 0
        ? "No empty cell is available."
        : `Fill R${Math.floor(empty / 9) + 1}C${(empty % 9) + 1} from the verified solution?`;
    return Object.freeze({
      lines: Object.freeze([
        centered("CONFIRM HINT", viewport.width, "warning", "strong"),
        centered(location, viewport.width),
        centered("Y Fill · N Continue", viewport.width, "accent", "strong"),
      ]),
    });
  }
  const fixture = state.fixtureId.toUpperCase();
  const header = `${difficultyName(state.difficulty)} · ${fixture} · NOTES ${state.notesMode ? "ON" : "OFF"} · HINTS ${state.hintCount}`;
  const result =
    state.status === "won"
      ? [centered("◆ SUDOKU COMPLETE ◆", viewport.width, "success", "strong")]
      : [];
  const detailedBoard = viewport.height >= 22;
  return Object.freeze({
    lines: Object.freeze(
      [
        centered(header, viewport.width, "text", "strong"),
        ...(state.status === "won" ? result : [selectedStatus(state, feedback, viewport.width)]),
        ...boardLines(state, viewport.width, viewport.height, textOnly),
        ...(detailedBoard ? [] : [difficultyControls(state, viewport.width)]),
        controls(state, viewport.width),
      ].slice(0, viewport.height),
    ),
    ...(state.status === "won"
      ? { announcement: `Sudoku complete with ${state.hintCount} hints` }
      : {}),
  });
}

function direction(
  input: Extract<ActivityInput, { readonly type: "key" }>,
): SudokuDirection | undefined {
  if (input.ctrl || input.alt) return undefined;
  const key = input.key.toLowerCase();
  if (key === "left" || key === "h") return "left";
  if (key === "right" || key === "l") return "right";
  if (key === "up" || key === "k") return "up";
  if (key === "down" || key === "j") return "down";
  return undefined;
}

function nextDifficulty(difficulty: SudokuDifficulty): SudokuDifficulty {
  return difficulty === "easy" ? "medium" : difficulty === "medium" ? "hard" : "easy";
}

function hasProgress(state: SudokuState): boolean {
  const givens = sudokuGivenValues(state);
  return (
    state.values.some((digit, index) => digit !== givens[index]) ||
    state.notes.some((notes) => notes !== 0) ||
    state.hintCount > 0
  );
}

export function sudokuActivity(options: SudokuActivityOptions = {}): TerminalActivity {
  return {
    id: "axl.lounge.sudoku",
    name: "Sudoku",
    description: "A precise logic grid with notes, hints, and undo",
    category: "game",
    minimumViewport: Object.freeze({ width: 40, height: 18 }),
    create(context) {
      const nextSeed = options.seed ?? (() => Date.now());
      let state = createSudoku("easy", nextSeed());
      let revision: number | null = null;
      let panel: Panel = context.storage === undefined ? "game" : "loading";
      let panelBeforeHelp: Exclude<Panel, "help"> = "game";
      let pendingDifficulty: SudokuDifficulty | undefined;
      let feedback = "Select an empty cell and enter 1–9";
      let active = true;
      let focused = true;
      let inputEnabled = true;
      let canReset = false;
      let writeQueue = Promise.resolve();

      const invalidate = (): void => {
        if (active) context.invalidate();
      };
      const document = (): SudokuSaveDocument => updateSudokuSave(state);
      const persist = (): void => {
        const storage = context.storage;
        if (storage === undefined) return;
        const saved = document();
        writeQueue = writeQueue
          .then(async () => {
            const stored = await storage.write(
              revision,
              SUDOKU_STORAGE_SCHEMA_VERSION,
              sudokuSaveJson(saved),
            );
            revision = stored.revision;
          })
          .catch((error: unknown) => {
            if (error instanceof ActivityStorageError && error.code === "aborted") return;
            feedback = error instanceof Error ? error.message : "Sudoku save failed";
            panel = "storage-error";
            invalidate();
          });
      };
      const restart = (difficulty = state.difficulty): void => {
        state = createSudoku(difficulty, nextSeed());
        pendingDifficulty = undefined;
        panel = "game";
        feedback = "New puzzle · select an empty cell";
        persist();
        invalidate();
      };
      const apply = (action: Parameters<typeof reduceSudoku>[1], message: string): boolean => {
        const previous = state;
        state = reduceSudoku(state, action);
        if (state === previous) return false;
        feedback = state.status === "won" ? `Completed with ${state.hintCount} hints` : message;
        persist();
        invalidate();
        return true;
      };
      const requestRestart = (): void => {
        if (hasProgress(state) && state.status !== "won") panel = "restart";
        else restart();
        invalidate();
      };
      const requestDifficulty = (difficulty: SudokuDifficulty): void => {
        if (difficulty === state.difficulty && !hasProgress(state)) {
          feedback = `${difficultyName(difficulty)} already selected`;
        } else if (hasProgress(state) && state.status !== "won") {
          pendingDifficulty = difficulty;
          panel = "difficulty";
        } else restart(difficulty);
        invalidate();
      };
      const toggleHelp = (): void => {
        if (panel === "help") panel = panelBeforeHelp;
        else {
          panelBeforeHelp = panel;
          panel = "help";
        }
        invalidate();
      };

      if (context.storage !== undefined) {
        writeQueue = context.storage
          .read(context.signal)
          .then((stored) => {
            if (stored !== undefined) {
              revision = stored.revision;
              if (stored.schemaVersion !== SUDOKU_STORAGE_SCHEMA_VERSION)
                throw new SudokuSaveError(
                  stored.schemaVersion > SUDOKU_STORAGE_SCHEMA_VERSION
                    ? "future-version"
                    : "corrupt",
                  `Unsupported Sudoku storage schema ${stored.schemaVersion}`,
                );
              state = parseSudokuSave(stored.value).game;
              feedback = "Saved puzzle restored exactly";
            }
            panel = "game";
            if (stored === undefined) persist();
            invalidate();
          })
          .catch((error: unknown) => {
            if (error instanceof ActivityStorageError && error.code === "aborted") return;
            feedback = error instanceof Error ? error.message : "Sudoku save cannot be read";
            canReset = revision !== null;
            panel = "storage-error";
            invalidate();
          });
      }

      return {
        render(viewport) {
          inputEnabled = viewport.width >= 40 && viewport.height >= 18;
          return render(
            viewport,
            state,
            panel,
            feedback,
            pendingDifficulty,
            canReset,
            context.presentation().textOnly,
          );
        },
        handleInput(input) {
          if (input.type === "focus") {
            focused = input.focused;
            return;
          }
          if (
            !active ||
            !focused ||
            !inputEnabled ||
            input.type !== "key" ||
            input.repeat ||
            panel === "loading"
          )
            return;
          const key = input.key.toLowerCase();
          if (panel === "storage-error") {
            if (canReset && key === "r" && revision !== null)
              void context.storage
                ?.reset(revision)
                .then(() => {
                  revision = null;
                  canReset = false;
                  restart();
                })
                .catch((error: unknown) => {
                  feedback = error instanceof Error ? error.message : "Sudoku reset failed";
                  invalidate();
                });
            return;
          }
          if (input.key === "?" && !input.ctrl && !input.alt) {
            toggleHelp();
            return;
          }
          if (panel === "help") return;
          if (panel === "restart" || panel === "difficulty") {
            if (!input.ctrl && !input.alt && key === "y")
              restart(pendingDifficulty ?? state.difficulty);
            else if (!input.ctrl && !input.alt && key === "n") {
              pendingDifficulty = undefined;
              panel = "game";
              invalidate();
            }
            return;
          }
          if (panel === "hint") {
            if (!input.ctrl && !input.alt && key === "y") {
              panel = "game";
              apply({ type: "hint" }, "Hint filled and marked · U undoes");
            } else if (!input.ctrl && !input.alt && key === "n") {
              panel = "game";
              feedback = "Hint cancelled";
              invalidate();
            }
            return;
          }
          if (input.ctrl || input.alt) return;
          if (state.status === "won" && input.key === "enter") {
            restart();
            return;
          }
          if (key === "d") {
            requestDifficulty(nextDifficulty(state.difficulty));
            return;
          }
          const move = direction(input);
          if (move !== undefined) {
            if (!apply({ type: "move", direction: move }, "Selection moved")) {
              feedback = "Board edge";
              invalidate();
            }
            return;
          }
          if (key === "n") {
            apply({ type: "toggle-notes" }, state.notesMode ? "Notes mode off" : "Notes mode on");
            return;
          }
          if (key === "u") {
            if (!apply({ type: "undo" }, "Last change undone")) {
              feedback = "Nothing to undo in this puzzle";
              invalidate();
            }
            return;
          }
          if (key === "g") {
            if (state.values.some((digit) => digit === 0)) panel = "hint";
            else feedback = "No empty cell is available for a hint";
            invalidate();
            return;
          }
          if (key === "r") {
            requestRestart();
            return;
          }
          if (input.key === "backspace" || input.key === "delete") {
            if (!apply({ type: "erase" }, "Cell erased")) {
              feedback =
                sudokuGivenValues(state)[state.selected] !== 0
                  ? "Given cells cannot be edited"
                  : "Cell is already empty";
              invalidate();
            }
            return;
          }
          if (/^[1-9]$/u.test(input.key)) {
            const digit = Number(input.key);
            if (
              !apply(
                { type: "digit", digit },
                state.notesMode ? `Note ${digit} toggled` : `Entered ${digit}`,
              )
            ) {
              feedback =
                sudokuGivenValues(state)[state.selected] !== 0
                  ? "Given cells cannot be edited"
                  : "Select an empty cell for notes";
              invalidate();
            }
          }
        },
        presentationChanged: invalidate,
        pause: () => {
          active = false;
          focused = false;
        },
        resume: () => {
          active = true;
          focused = true;
          invalidate();
        },
        serialize: () => sudokuSaveJson(document()),
        dispose: () => {
          active = false;
          focused = false;
          return writeQueue;
        },
      };
    },
  };
}
