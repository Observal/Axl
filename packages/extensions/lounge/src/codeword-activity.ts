// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  type ActivityFrame,
  type ActivityInput,
  type ActivityPresentationPreferences,
  type ActivitySpan,
  ActivityStorageError,
  type ActivityViewport,
  type TerminalActivity,
} from "@axl/extension-api";

import {
  CODEWORD_LENGTH,
  CODEWORD_MAX_ATTEMPTS,
  type CodewordDifficulty,
  type CodewordIssue,
  type CodewordScore,
  type CodewordSelection,
  type CodewordState,
  createCodewordGame,
  reduceCodeword,
} from "./codeword.ts";
import {
  CODEWORD_STORAGE_SCHEMA_VERSION,
  type CodewordPreferences,
  type CodewordSaveDocument,
  CodewordSaveError,
  codewordSaveJson,
  codewordStatistics,
  createEmptyCodewordSave,
  mergeCodewordCompletions,
  parseCodewordSave,
  updateCodewordSave,
} from "./codeword-state.ts";

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"] as const;
const SCORE_STRENGTH: Readonly<Record<CodewordScore, number>> = {
  absent: 1,
  present: 2,
  exact: 3,
};

export interface CodewordActivityOptions {
  readonly selection?: CodewordSelection;
  readonly difficulty?: CodewordDifficulty;
  readonly utcDate?: () => string;
  readonly practiceSeed?: () => number;
}

type LocalPanel = "loading" | "picker" | "game" | "help" | "restart" | "storage-error";

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

function textLine(text: string, width: number, style: ActivitySpan["style"] = "text") {
  return line(span(text.slice(0, Math.max(0, width)), style));
}

function centered(text: string, width: number, style: ActivitySpan["style"] = "text") {
  const clipped = text.slice(0, Math.max(0, width));
  const padding = " ".repeat(Math.max(0, Math.floor((width - clipped.length) / 2)));
  return line(span(padding), span(clipped, style));
}

function scoreStyle(score: CodewordScore | undefined): ActivitySpan["style"] {
  return score === "exact"
    ? "success"
    : score === "present"
      ? "warning"
      : score === "absent"
        ? "muted"
        : "text";
}

function scoreSymbol(score: CodewordScore | undefined): string {
  return score === "exact" ? "✓" : score === "present" ? "~" : score === "absent" ? "·" : " ";
}

function issueText(issue: CodewordIssue | undefined): string {
  if (issue === undefined) return "Type a five-letter word.";
  if (issue.code === "invalid-letter") return "Use letters A-Z.";
  if (issue.code === "row-full") return "The current row already has five letters.";
  if (issue.code === "incomplete-guess") return "Enter five letters.";
  if (issue.code === "invalid-guess") return "Not in the accepted word list.";
  if (issue.code === "game-complete") return "This puzzle is complete.";
  if (issue.code === "hard-exact") {
    return `Hard mode: keep ${issue.letter.toUpperCase()} in position ${issue.position + 1}.`;
  }
  return `Hard mode: include at least ${issue.required} ${issue.letter.toUpperCase()}${issue.required === 1 ? "" : "s"}.`;
}

function evidence(
  state: CodewordState,
  reveal?: { readonly row: number; readonly visibleTiles: number },
): ReadonlyMap<string, CodewordScore> {
  const result = new Map<string, CodewordScore>();
  for (let row = 0; row < state.guesses.length; row += 1) {
    const guess = state.guesses[row] as CodewordState["guesses"][number];
    const visibleTiles = reveal?.row === row ? reveal.visibleTiles : CODEWORD_LENGTH;
    for (let index = 0; index < visibleTiles; index += 1) {
      const letter = guess.word[index] as string;
      const score = guess.score[index] as CodewordScore;
      const current = result.get(letter);
      if (current === undefined || SCORE_STRENGTH[score] > SCORE_STRENGTH[current]) {
        result.set(letter, score);
      }
    }
  }
  return result;
}

function tileAppearance(
  score: CodewordScore | undefined,
  active: boolean,
): {
  readonly style: ActivitySpan["style"];
  readonly emphasis: ActivitySpan["emphasis"];
  readonly top: string;
  readonly bottom: string;
  readonly sides: readonly [string, string];
} {
  if (score === "exact") {
    return {
      style: "success",
      emphasis: "strong",
      top: "┏━━━┓",
      bottom: "┗━━━┛",
      sides: ["┃", "┃"],
    };
  }
  if (score === "present") {
    return {
      style: "warning",
      emphasis: "strong",
      top: "╔═══╗",
      bottom: "╚═══╝",
      sides: ["║", "║"],
    };
  }
  if (score === "absent") {
    return {
      style: "muted",
      emphasis: "none",
      top: "┌───┐",
      bottom: "└───┘",
      sides: ["│", "│"],
    };
  }
  return {
    style: active ? "text" : "muted",
    emphasis: active ? "strong" : "none",
    top: "╭───╮",
    bottom: "╰───╯",
    sides: ["│", "│"],
  };
}

function boardRows(
  state: CodewordState,
  width: number,
  large: boolean,
  reveal?: { readonly row: number; readonly visibleTiles: number },
): readonly (readonly ActivitySpan[])[] {
  const rows: Array<readonly ActivitySpan[]> = [];
  const boardWidth = 2 + CODEWORD_LENGTH * 5 + (CODEWORD_LENGTH - 1);
  const indent = span(" ".repeat(Math.max(0, Math.floor((width - boardWidth) / 2))));
  for (let row = 0; row < CODEWORD_MAX_ATTEMPTS; row += 1) {
    const submitted = state.guesses[row];
    const active =
      submitted === undefined && row === state.guesses.length && state.status === "active";
    const word = submitted?.word ?? (active ? state.currentGuess : "");
    const appearances = Array.from({ length: CODEWORD_LENGTH }, (_, column) => {
      const score =
        submitted === undefined ||
        (reveal !== undefined && reveal.row === row && column >= reveal.visibleTiles)
          ? undefined
          : submitted.score[column];
      return tileAppearance(score, active);
    });
    if (large) {
      const top: ActivitySpan[] = [
        indent,
        span(active ? "▶ " : "  ", active ? "selection" : "muted"),
      ];
      const middle: ActivitySpan[] = [indent, span("  ")];
      const bottom: ActivitySpan[] = [indent, span("  ")];
      for (let column = 0; column < CODEWORD_LENGTH; column += 1) {
        const appearance = appearances[column] as (typeof appearances)[number];
        const letter = word[column]?.toUpperCase() ?? " ";
        top.push(span(appearance.top, appearance.style, appearance.emphasis));
        middle.push(
          span(
            `${appearance.sides[0]} ${letter} ${appearance.sides[1]}`,
            appearance.style,
            appearance.emphasis,
          ),
        );
        bottom.push(span(appearance.bottom, appearance.style, appearance.emphasis));
        if (column < CODEWORD_LENGTH - 1) {
          top.push(span(" "));
          middle.push(span(" "));
          bottom.push(span(" "));
        }
      }
      rows.push(line(...top), line(...middle), line(...bottom));
    } else {
      const cells: ActivitySpan[] = [
        indent,
        span(active ? "▶ " : "  ", active ? "selection" : "muted"),
      ];
      for (let column = 0; column < CODEWORD_LENGTH; column += 1) {
        const appearance = appearances[column] as (typeof appearances)[number];
        const letter = word[column]?.toUpperCase() ?? " ";
        cells.push(
          span(
            `${appearance.sides[0]} ${letter} ${appearance.sides[1]}`,
            appearance.style,
            appearance.emphasis,
          ),
        );
        if (column < CODEWORD_LENGTH - 1) cells.push(span(" "));
      }
      rows.push(line(...cells));
    }
  }
  return rows;
}

function keyboardRows(
  state: CodewordState,
  width: number,
  reveal?: { readonly row: number; readonly visibleTiles: number },
): readonly (readonly ActivitySpan[])[] {
  const known = evidence(state, reveal);
  const rows: readonly (readonly string[])[] = [
    [...KEYBOARD_ROWS[0]],
    [...KEYBOARD_ROWS[1]],
    ["ENTER", ...KEYBOARD_ROWS[2], "⌫"],
  ];
  return rows.map((keys) => {
    const rendered = keys.map((key) => {
      const score = key.length === 1 ? known.get(key) : undefined;
      const label = key === "ENTER" ? "ENTER" : key === "⌫" ? " ⌫ " : ` ${key.toUpperCase()} `;
      return span(
        label,
        score === undefined ? (key.length === 1 ? "text" : "muted") : scoreStyle(score),
        score === undefined ? "none" : "strong",
      );
    });
    const rowWidth =
      rendered.reduce((total, item) => total + item.text.length, 0) + rendered.length - 1;
    const cells: ActivitySpan[] = [
      span(" ".repeat(Math.max(0, Math.floor((width - rowWidth) / 2)))),
    ];
    for (const [index, key] of rendered.entries()) {
      cells.push(key);
      if (index < rendered.length - 1) cells.push(span(" "));
    }
    return line(...cells);
  });
}

function renderHelp(viewport: ActivityViewport): ActivityFrame {
  const lines = [
    centered("WORDLE · HOW TO PLAY", viewport.width, "accent"),
    textLine("Guess a five-letter word in six attempts.", viewport.width),
    textLine("Green: correct spot · Yellow: wrong spot · Dim: absent", viewport.width, "muted"),
    textLine("A-Z type · Backspace erase · Enter submit", viewport.width),
    textLine("Tab agent · Ctrl+P menu · Ctrl+R restart", viewport.width, "muted"),
    textLine("Ctrl+T transcript · ? resume · Esc close", viewport.width, "muted"),
  ];
  return Object.freeze({ lines: Object.freeze(lines.slice(0, viewport.height)) });
}

function renderRestart(viewport: ActivityViewport, state: CodewordState): ActivityFrame {
  const label = state.selection.kind === "daily" ? "Daily" : "Practice";
  const lines = [
    centered("RESTART WORDLE?", viewport.width, "warning"),
    centered(`Replace ${label} attempt ${state.guesses.length + 1}/6?`, viewport.width),
    centered("Progress remains until you press y.", viewport.width, "muted"),
    centered("y restart · n continue · Esc close Lounge", viewport.width, "muted"),
  ];
  return Object.freeze({ lines: Object.freeze(lines.slice(0, viewport.height)) });
}

function renderPicker(
  viewport: ActivityViewport,
  preferences: CodewordPreferences,
  selectedRow: number,
  saved: CodewordState | undefined,
  utcDate: string,
): ActivityFrame {
  const puzzle = preferences.puzzle === "daily" ? `Daily UTC · ${utcDate}` : "Practice";
  const difficulty = preferences.difficulty === "hard" ? "Hard" : "Normal";
  const resumable =
    saved?.status === "active" &&
    saved.selection.kind === preferences.puzzle &&
    saved.difficulty === preferences.difficulty;
  const currentDailyResult =
    saved !== undefined &&
    saved.status !== "active" &&
    saved.selection.kind === "daily" &&
    saved.selection.utcDate === utcDate &&
    preferences.puzzle === "daily";
  const completedPractice =
    saved !== undefined &&
    saved.status !== "active" &&
    saved.selection.kind === "practice" &&
    preferences.puzzle === "practice";
  const primaryAction = resumable
    ? `[ CONTINUE · ATTEMPT ${saved.guesses.length + 1}/6 ]`
    : currentDailyResult
      ? saved.status === "won"
        ? `[ TODAY SOLVED · ${saved.guesses.length}/6 ]`
        : `[ TODAY MISSED · ANSWER ${saved.answer.toUpperCase()} ]`
      : completedPractice
        ? "[ PRACTICE COMPLETE · NEW GAME AVAILABLE ]"
        : preferences.puzzle === "daily"
          ? "[ START TODAY'S WORDLE ]"
          : "[ START NEW PRACTICE ]";
  const rows = [
    centered("W O R D L E", viewport.width, "accent"),
    centered("Five letters. Six tries. Just play.", viewport.width, "muted"),
    line(),
    centered("PUZZLE", viewport.width, selectedRow === 0 ? "selection" : "muted"),
    centered(
      `${preferences.puzzle === "daily" ? "● DAILY" : "○ DAILY"}     ${preferences.puzzle === "practice" ? "● PRACTICE" : "○ PRACTICE"}`,
      viewport.width,
      selectedRow === 0 ? "selection" : "text",
    ),
    line(),
    centered("DIFFICULTY", viewport.width, selectedRow === 1 ? "selection" : "muted"),
    centered(
      `${preferences.difficulty === "normal" ? "● NORMAL" : "○ NORMAL"}       ${preferences.difficulty === "hard" ? "● HARD" : "○ HARD"}`,
      viewport.width,
      selectedRow === 1 ? "selection" : "text",
    ),
    line(),
    centered(primaryAction, viewport.width, "accent"),
    centered(`Selected: ${puzzle} · ${difficulty}`, viewport.width, "muted"),
    centered("↑↓ select · ←→ change · Enter play", viewport.width, "muted"),
    centered(
      `D/P puzzle · N/H difficulty · ? help${saved === undefined ? "" : " · M back"}`,
      viewport.width,
      "muted",
    ),
  ];
  return Object.freeze({ lines: Object.freeze(rows.slice(0, viewport.height)) });
}

function renderStorageError(
  viewport: ActivityViewport,
  message: string,
  canReset: boolean,
): ActivityFrame {
  return Object.freeze({
    lines: Object.freeze(
      [
        centered("WORDLE SAVE UNAVAILABLE", viewport.width, "error"),
        centered(message, viewport.width, "warning"),
        centered(
          canReset ? "R reset saved state · Esc return" : "Esc return",
          viewport.width,
          "muted",
        ),
      ].slice(0, viewport.height),
    ),
    announcement: message,
  });
}

function renderTextOnlyGame(
  viewport: ActivityViewport,
  state: CodewordState,
  document: CodewordSaveDocument,
  result: string,
  resultStyle: ActivitySpan["style"],
): ActivityFrame {
  const mode = state.selection.kind === "daily" ? `Daily · ${state.selection.utcDate}` : "Practice";
  const difficulty = state.difficulty === "hard" ? "Hard" : "Normal";
  const attempt =
    state.status === "active" ? Math.min(state.guesses.length + 1, 6) : state.guesses.length;
  const known = evidence(state);
  const evidenceGroup = (score: CodewordScore): string =>
    [...known]
      .filter(([, value]) => value === score)
      .map(([letter]) => letter.toUpperCase())
      .sort()
      .join(" ") || "none";
  const board = Array.from({ length: CODEWORD_MAX_ATTEMPTS }, (_, row) => {
    const submitted = state.guesses[row];
    const active =
      submitted === undefined && row === state.guesses.length && state.status === "active";
    const word =
      submitted?.word ?? (active ? state.currentGuess.padEnd(CODEWORD_LENGTH, "_") : "_____");
    const cells = [...word].map((letter, column) => {
      const score = submitted?.score[column];
      return `${letter.toUpperCase()}${scoreSymbol(score).trim()}`;
    });
    return textLine(
      `Row ${row + 1}: ${cells.join(" ")}`,
      viewport.width,
      active ? "selection" : "text",
    );
  });
  const statistics = codewordStatistics(document);
  return Object.freeze({
    lines: Object.freeze(
      [
        textLine(`${mode} · ${difficulty} · Attempt ${attempt}/6`, viewport.width, "accent"),
        textLine(result, viewport.width, resultStyle),
        ...board,
        textLine(`Keyboard exact: ${evidenceGroup("exact")}`, viewport.width, "success"),
        textLine(`Keyboard present: ${evidenceGroup("present")}`, viewport.width, "warning"),
        textLine(`Keyboard absent: ${evidenceGroup("absent")}`, viewport.width, "muted"),
        ...(state.status === "active"
          ? []
          : [
              textLine("Enter or R: new Practice · M: menu · Ctrl+T: exit game", viewport.width),
              textLine(
                `Played ${statistics.played} · Win ${statistics.winRate}% · Streak ${statistics.currentStreak} · Best ${statistics.maximumStreak}`,
                viewport.width,
                "accent",
              ),
            ]),
      ].slice(0, viewport.height),
    ),
    announcement: result,
  });
}

function completionPanel(
  state: CodewordState,
  width: number,
  winEmphasis: boolean,
): readonly (readonly ActivitySpan[])[] {
  const innerWidth = Math.min(31, Math.max(20, width - 6));
  const border = "─".repeat(innerWidth);
  const title = state.status === "won" ? "SOLVED!" : "GAME OVER";
  const detail =
    state.status === "won"
      ? `${state.guesses.length} ${state.guesses.length === 1 ? "GUESS" : "GUESSES"}`
      : `ANSWER: ${state.answer.toUpperCase()}`;
  const style: ActivitySpan["style"] = state.status === "won" ? "success" : "error";
  const centerInside = (value: string) => {
    const available = innerWidth;
    const clipped = value.slice(0, available);
    const left = Math.floor((available - clipped.length) / 2);
    return `${" ".repeat(left)}${clipped}${" ".repeat(available - clipped.length - left)}`;
  };
  const prefix = " ".repeat(Math.max(0, Math.floor((width - innerWidth - 2) / 2)));
  return [
    line(span(prefix), span(`╭${border}╮`, style, "strong")),
    line(
      span(prefix),
      span(`│${centerInside(`${title} · ${detail}`)}│`, style, winEmphasis ? "reverse" : "strong"),
    ),
    line(span(prefix), span(`╰${border}╯`, style, "strong")),
  ];
}

function renderGame(
  viewport: ActivityViewport,
  state: CodewordState,
  document: CodewordSaveDocument,
  preferences: ActivityPresentationPreferences,
  reveal?: { readonly row: number; readonly visibleTiles: number },
  winEmphasis = false,
  saveWarning?: string,
): ActivityFrame {
  if (viewport.width < 40 || viewport.height < 15) {
    return Object.freeze({
      lines: Object.freeze(
        [
          centered("WORDLE NEEDS MORE ROOM", viewport.width, "warning"),
          centered("Keep Lounge open or press Esc to return.", viewport.width, "muted"),
        ].slice(0, viewport.height),
      ),
      announcement: "Codeword needs more room",
    });
  }
  const mode = state.selection.kind === "daily" ? `Daily · ${state.selection.utcDate}` : "Practice";
  const difficulty = state.difficulty === "hard" ? "Hard" : "Normal";
  const attempt =
    state.status === "active" ? Math.min(state.guesses.length + 1, 6) : state.guesses.length;
  const result =
    saveWarning ??
    (reveal !== undefined
      ? "Revealing result…"
      : state.status === "won"
        ? `Solved in ${state.guesses.length}/6.`
        : state.status === "lost"
          ? `Not solved · Answer ${state.answer.toUpperCase()}.`
          : state.issue !== undefined
            ? issueText(state.issue)
            : viewport.width < 60
              ? "Type · ↵ submit · ? help · ^R restart"
              : "Type a five-letter word · Enter submit · ? help · Ctrl+R restart");
  const resultStyle: ActivitySpan["style"] =
    saveWarning !== undefined || state.status === "lost" || state.issue !== undefined
      ? "warning"
      : state.status === "won"
        ? "success"
        : "muted";
  if (preferences.textOnly) {
    return renderTextOnlyGame(viewport, state, document, result, resultStyle);
  }
  const statistics = codewordStatistics(document);
  const distribution = statistics.guessDistribution
    .map((count, index) => `${index + 1}:${count}`)
    .join(" ");
  const large = viewport.height >= 22;
  const roomy = viewport.height >= 25;
  const playing = state.status === "active" || reveal !== undefined;
  const condensedResult =
    saveWarning ??
    (reveal !== undefined
      ? "Revealing…"
      : state.issue === undefined
        ? "Type a word · Enter submit"
        : issueText(state.issue));
  const rows = [
    centered(
      large && !roomy && playing
        ? `${mode} · ${difficulty} · ${attempt}/6 · ${condensedResult}`
        : `${mode} · ${difficulty} · Attempt ${attempt}/6`,
      viewport.width,
      large && !roomy && playing ? resultStyle : "muted",
    ),
    ...(roomy ? [line()] : []),
    ...boardRows(state, viewport.width, large && playing, reveal),
    ...(large && !roomy ? [] : [line()]),
    ...(playing
      ? [
          ...keyboardRows(state, viewport.width, reveal),
          ...(large && !roomy ? [] : [centered(result, viewport.width, resultStyle)]),
        ]
      : [
          ...completionPanel(state, viewport.width, winEmphasis),
          centered("[ Enter ] New practice", viewport.width, "accent"),
          centered("[ M ] Menu   [ Tab ] Agent   [ Ctrl+T ] Exit game", viewport.width, "muted"),
          ...(saveWarning === undefined ? [] : [centered(saveWarning, viewport.width, "warning")]),
          ...(!large || roomy
            ? [
                centered(
                  `Played ${statistics.played}   Win ${statistics.winRate}%   Streak ${statistics.currentStreak}   Best ${statistics.maximumStreak}`,
                  viewport.width,
                  "accent",
                ),
                centered(`Guess distribution · ${distribution}`, viewport.width, "muted"),
              ]
            : []),
        ]),
  ];
  const visible = rows;
  return Object.freeze({
    lines: Object.freeze(visible.slice(0, viewport.height)),
    announcement: result,
  });
}

function selectedPuzzle(selection: CodewordSelection): CodewordPreferences["puzzle"] {
  return selection.kind;
}

export function codewordActivity(options: CodewordActivityOptions = {}): TerminalActivity {
  return {
    id: "axl.lounge.codeword",
    name: "Wordle",
    description: "The familiar five-letter daily word game",
    category: "game",
    minimumViewport: Object.freeze({ width: 40, height: 15 }),
    create(context) {
      let document = createEmptyCodewordSave();
      let revision: number | null = null;
      let state =
        options.selection === undefined
          ? undefined
          : createCodewordGame(options.selection, options.difficulty ?? "normal");
      let preferences: CodewordPreferences = Object.freeze({
        puzzle: options.selection === undefined ? "daily" : selectedPuzzle(options.selection),
        difficulty: options.difficulty ?? "normal",
      });
      if (state !== undefined) {
        document = updateCodewordSave(document, state, preferences).document;
      }
      let panel: LocalPanel =
        options.selection === undefined && context.storage ? "loading" : state ? "game" : "picker";
      let pickerRow = 0;
      let panelBeforeHelp: Exclude<LocalPanel, "help"> = panel;
      let inputEnabled = true;
      let saveWarning: string | undefined;
      let storageError: { readonly message: string; readonly canReset: boolean } | undefined;
      let pendingSelection: CodewordSelection | undefined;
      let writeQueue = Promise.resolve();
      let storageBlocked = false;
      let reveal: { readonly row: number; readonly visibleTiles: number } | undefined;
      let winEmphasis = false;
      let cancelDecorative: (() => void) | undefined;
      let activityActive = true;

      const safeInvalidate = (): void => {
        if (activityActive) context.invalidate();
      };
      const storageAborted = (error: unknown): boolean =>
        error instanceof ActivityStorageError && error.code === "aborted";

      const stopDecorative = (completeReveal: boolean): void => {
        cancelDecorative?.();
        cancelDecorative = undefined;
        if (completeReveal) reveal = undefined;
        winEmphasis = false;
      };

      const beginWinEmphasis = (): void => {
        if (state?.status !== "won") return;
        winEmphasis = true;
        cancelDecorative = context.schedule(300, () => {
          cancelDecorative = undefined;
          winEmphasis = false;
          context.invalidate();
        });
      };

      const scheduleReveal = (): void => {
        cancelDecorative = context.schedule(80, () => {
          cancelDecorative = undefined;
          if (reveal === undefined) return;
          const visibleTiles = reveal.visibleTiles + 1;
          if (visibleTiles >= CODEWORD_LENGTH) {
            reveal = undefined;
            beginWinEmphasis();
          } else {
            reveal = Object.freeze({ row: reveal.row, visibleTiles });
            scheduleReveal();
          }
          context.invalidate();
        });
      };

      const beginReveal = (row: number): void => {
        stopDecorative(true);
        const presentation = context.presentation();
        if (presentation.reducedMotion || presentation.textOnly) return;
        reveal = Object.freeze({ row, visibleTiles: 0 });
        scheduleReveal();
      };

      const utcDate = options.utcDate ?? (() => new Date().toISOString().slice(0, 10));
      const practiceSeed = options.practiceSeed ?? (() => Date.now());
      const selectionForPreferences = (): CodewordSelection =>
        preferences.puzzle === "daily"
          ? { kind: "daily", algorithmVersion: 1, utcDate: utcDate() }
          : { kind: "practice", algorithmVersion: 1, seed: practiceSeed() };

      const queueWrite = (snapshot: CodewordSaveDocument, completionAdded: boolean): void => {
        const storage = context.storage;
        if (storage === undefined) return;
        const mergeCompletion = async (): Promise<void> => {
          const latest = await storage.read();
          if (latest === undefined) return;
          if (latest.schemaVersion !== CODEWORD_STORAGE_SCHEMA_VERSION) {
            throw new CodewordSaveError(
              latest.schemaVersion > CODEWORD_STORAGE_SCHEMA_VERSION ? "future-version" : "corrupt",
              `Unsupported Codeword storage schema ${latest.schemaVersion}`,
            );
          }
          const parsed = parseCodewordSave(latest.value);
          const merged = mergeCodewordCompletions(parsed.document, snapshot);
          const stored = await storage.write(
            latest.revision,
            CODEWORD_STORAGE_SCHEMA_VERSION,
            codewordSaveJson(merged),
          );
          revision = stored.revision;
        };
        writeQueue = writeQueue
          .then(async () => {
            if (storageBlocked) {
              if (completionAdded) await mergeCompletion();
              return;
            }
            try {
              const stored = await storage.write(
                revision,
                CODEWORD_STORAGE_SCHEMA_VERSION,
                codewordSaveJson(snapshot),
              );
              revision = stored.revision;
            } catch (error) {
              if (error instanceof ActivityStorageError && error.code === "conflict") {
                storageBlocked = true;
                if (completionAdded) await mergeCompletion();
                saveWarning = "Save conflict · newer board kept on disk";
              } else if (!storageAborted(error)) {
                saveWarning = error instanceof Error ? error.message : "Codeword save failed";
              }
              safeInvalidate();
            }
          })
          .catch((error: unknown) => {
            if (storageAborted(error)) return;
            storageBlocked = true;
            saveWarning = error instanceof Error ? error.message : "Codeword save failed";
            safeInvalidate();
          });
      };

      const persist = (): void => {
        if (state === undefined) return;
        const updated = updateCodewordSave(document, state, preferences);
        document = updated.document;
        queueWrite(document, updated.completionAdded);
      };

      const persistPreferences = (): void => {
        document = Object.freeze({ ...document, preferences: Object.freeze({ ...preferences }) });
        queueWrite(document, false);
      };

      const start = (selection: CodewordSelection): void => {
        stopDecorative(true);
        state = createCodewordGame(selection, preferences.difficulty);
        pendingSelection = undefined;
        panel = "game";
        saveWarning = undefined;
        persist();
        context.invalidate();
      };

      const startFreshPractice = (): void => {
        preferences = Object.freeze({ ...preferences, puzzle: "practice" });
        start({ kind: "practice", algorithmVersion: 1, seed: practiceSeed() });
      };

      if (panel === "loading") {
        const loadSignal = context.signal;
        writeQueue = (async () => {
          const stored = await context.storage?.read(loadSignal);
          if (stored !== undefined) {
            revision = stored.revision;
            if (stored.schemaVersion !== CODEWORD_STORAGE_SCHEMA_VERSION) {
              throw new CodewordSaveError(
                stored.schemaVersion > CODEWORD_STORAGE_SCHEMA_VERSION
                  ? "future-version"
                  : "corrupt",
                `Unsupported Codeword storage schema ${stored.schemaVersion}`,
              );
            }
            const parsed = parseCodewordSave(stored.value);
            document = parsed.document;
            state = parsed.state;
            preferences = parsed.document.preferences;
          }
          panel = "picker";
          context.invalidate();
        })().catch((error: unknown) => {
          if (loadSignal.aborted) return;
          storageError = {
            message: error instanceof Error ? error.message : "Codeword save cannot be read",
            canReset: revision !== null,
          };
          panel = "storage-error";
          context.invalidate();
        });
      }

      return {
        render(viewport) {
          inputEnabled = viewport.width >= 40 && viewport.height >= 15;
          const presentation = context.presentation();
          if (!inputEnabled && state !== undefined) {
            return renderGame(viewport, state, document, presentation);
          }
          if (panel === "loading") {
            return Object.freeze({
              lines: Object.freeze([centered("Loading Wordle…", viewport.width, "muted")]),
            });
          }
          if (panel === "storage-error" && storageError !== undefined) {
            return renderStorageError(viewport, storageError.message, storageError.canReset);
          }
          if (panel === "help") return renderHelp(viewport);
          if (panel === "picker")
            return renderPicker(viewport, preferences, pickerRow, state, utcDate());
          if (state === undefined)
            return renderPicker(viewport, preferences, pickerRow, state, utcDate());
          if (panel === "restart") return renderRestart(viewport, state);
          return renderGame(
            viewport,
            state,
            document,
            presentation,
            reveal,
            winEmphasis,
            saveWarning,
          );
        },
        handleInput(input: ActivityInput) {
          if (input.type !== "key" || input.repeat || !inputEnabled || panel === "loading") return;
          if (panel === "storage-error") {
            if (storageError?.canReset && input.key.toLowerCase() === "r" && revision !== null) {
              void context.storage
                ?.reset(revision)
                .then(() => {
                  revision = null;
                  document = createEmptyCodewordSave();
                  state = undefined;
                  storageError = undefined;
                  storageBlocked = false;
                  panel = "picker";
                  safeInvalidate();
                })
                .catch((error: unknown) => {
                  if (storageAborted(error)) return;
                  storageError = {
                    message: error instanceof Error ? error.message : "Codeword reset failed",
                    canReset: true,
                  };
                  safeInvalidate();
                });
            }
            return;
          }
          if (input.ctrl && input.key.toLowerCase() === "p") {
            panel = "picker";
            pendingSelection = undefined;
            context.invalidate();
            return;
          }
          if (
            !input.ctrl &&
            !input.alt &&
            input.key.toLowerCase() === "m" &&
            (panel !== "game" || state?.status !== "active")
          ) {
            panel = panel === "picker" && state !== undefined ? "game" : "picker";
            pendingSelection = undefined;
            context.invalidate();
            return;
          }
          if (input.key === "?" && !input.ctrl && !input.alt) {
            if (panel === "help") panel = panelBeforeHelp;
            else {
              panelBeforeHelp = panel;
              panel = "help";
            }
            context.invalidate();
            return;
          }
          if (panel === "help") return;
          if (panel === "picker") {
            let nextPreferences: CodewordPreferences | undefined;
            if (
              input.key === "up" ||
              input.key === "down" ||
              ["j", "k"].includes(input.key.toLowerCase())
            ) {
              pickerRow = pickerRow === 0 ? 1 : 0;
            } else if (input.key === "left" || input.key === "right") {
              nextPreferences =
                pickerRow === 0
                  ? {
                      ...preferences,
                      puzzle: preferences.puzzle === "daily" ? "practice" : "daily",
                    }
                  : {
                      ...preferences,
                      difficulty: preferences.difficulty === "normal" ? "hard" : "normal",
                    };
            } else if (!input.ctrl && !input.alt && input.key.toLowerCase() === "d") {
              nextPreferences = { ...preferences, puzzle: "daily" };
              pickerRow = 0;
            } else if (!input.ctrl && !input.alt && input.key.toLowerCase() === "p") {
              nextPreferences = { ...preferences, puzzle: "practice" };
              pickerRow = 0;
            } else if (!input.ctrl && !input.alt && input.key.toLowerCase() === "n") {
              nextPreferences = { ...preferences, difficulty: "normal" };
              pickerRow = 1;
            } else if (!input.ctrl && !input.alt && input.key.toLowerCase() === "h") {
              nextPreferences = { ...preferences, difficulty: "hard" };
              pickerRow = 1;
            } else if (input.key === "enter") {
              const resumable =
                state?.status === "active" &&
                state.selection.kind === preferences.puzzle &&
                state.difficulty === preferences.difficulty;
              const currentDailyResult =
                state !== undefined &&
                state.status !== "active" &&
                state.selection.kind === "daily" &&
                state.selection.utcDate === utcDate() &&
                preferences.puzzle === "daily";
              if (resumable || currentDailyResult) panel = "game";
              else if (
                state !== undefined &&
                state.status !== "active" &&
                preferences.puzzle === "practice"
              ) {
                startFreshPractice();
              } else {
                const next = selectionForPreferences();
                if (
                  state !== undefined &&
                  state.status === "active" &&
                  (state.guesses.length > 0 || state.currentGuess.length > 0)
                ) {
                  pendingSelection = next;
                  panel = "restart";
                } else start(next);
              }
            }
            if (nextPreferences !== undefined) {
              preferences = Object.freeze(nextPreferences);
              persistPreferences();
            }
            context.invalidate();
            return;
          }
          if (state === undefined) return;
          if (
            panel === "game" &&
            state.status !== "active" &&
            (input.key === "enter" || (!input.alt && input.key.toLowerCase() === "r"))
          ) {
            startFreshPractice();
            return;
          }
          if (panel === "restart") {
            if (!input.ctrl && !input.alt && input.key.toLowerCase() === "y") {
              const restart =
                pendingSelection ??
                (state.selection.kind === "daily" && state.status !== "active"
                  ? {
                      kind: "practice" as const,
                      algorithmVersion: 1 as const,
                      seed: practiceSeed(),
                    }
                  : state.selection);
              start(restart);
            } else if (!input.ctrl && !input.alt && input.key.toLowerCase() === "n") {
              pendingSelection = undefined;
              panel = "game";
              context.invalidate();
            }
            return;
          }
          if (input.ctrl && input.key.toLowerCase() === "r") {
            panel = "restart";
            context.invalidate();
          } else {
            const previous = state;
            if (input.key === "backspace" && !input.ctrl && !input.alt) {
              state = reduceCodeword(state, { type: "erase" });
            } else if (input.key === "enter" && !input.ctrl && !input.alt) {
              state = reduceCodeword(state, { type: "submit" });
            } else if (!input.ctrl && !input.alt && /^[a-z]$/iu.test(input.key)) {
              state = reduceCodeword(state, { type: "enter", letter: input.key });
            }
            if (state !== previous) {
              persist();
              if (state.guesses.length > previous.guesses.length) {
                beginReveal(state.guesses.length - 1);
              }
            }
            context.invalidate();
          }
        },
        presentationChanged: () => {
          const presentation = context.presentation();
          if (presentation.reducedMotion || presentation.textOnly) stopDecorative(true);
        },
        pause: () => {
          activityActive = false;
          stopDecorative(true);
        },
        resume: () => {
          activityActive = true;
        },
        serialize: () => codewordSaveJson(document),
        dispose: () => {
          activityActive = false;
          stopDecorative(true);
          return writeQueue;
        },
      };
    },
  };
}
