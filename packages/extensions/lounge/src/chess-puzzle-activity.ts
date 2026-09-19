// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  type ActivityFrame,
  type ActivityInput,
  type ActivityRasterImage,
  type ActivitySpan,
  ActivityStorageError,
  type ActivityViewport,
  type ExtensionDisposer,
  type TerminalActivity,
} from "@axl/extension-api";
import {
  type ChessColor,
  type ChessPiece,
  type ChessPromotion,
  chessSquareName,
  isChessInCheck,
} from "./chess.ts";
import {
  type ChessPuzzleCatalog,
  type ChessPuzzleDifficulty,
  type ChessPuzzleDirection,
  type ChessPuzzleMode,
  type ChessPuzzleState,
  type ChessPuzzleTheme,
  chessPuzzleById,
  chessPuzzleExpectedMove,
  chessPuzzleHintText,
  createChessPuzzle,
  createDailyChessPuzzleSelection,
  createPracticeChessPuzzleSelection,
  reduceChessPuzzle,
} from "./chess-puzzle.ts";
import {
  CHESS_BOARD_COLUMNS,
  CHESS_BOARD_ROWS,
  type ChessBoardArtScene,
  type ChessBoardMarker,
  renderChessBoardRaster,
} from "./chess-puzzle-art.ts";
import {
  CHESS_PUZZLE_STORAGE_SCHEMA_VERSION,
  type ChessPuzzlePreferences,
  type ChessPuzzleSaveDocument,
  ChessPuzzleSaveError,
  chessPuzzleSaveJson,
  chessPuzzleStatistics,
  createChessPuzzleSaveWriter,
  createEmptyChessPuzzleSave,
  parseChessPuzzleSave,
  updateChessPuzzleSave,
} from "./chess-puzzle-state.ts";

export interface ChessPuzzleThemeOption {
  readonly id: Exclude<ChessPuzzleTheme, "any">;
  readonly label: string;
  readonly description: string;
}

export interface ChessPuzzleActivityOptions {
  readonly catalog: ChessPuzzleCatalog;
  readonly themes: readonly ChessPuzzleThemeOption[];
  readonly utcDate: () => string;
  readonly practiceSeed: () => number;
  readonly replyDelayMs?: number;
}

type MenuKind = "difficulty" | "theme" | "mode";
type Panel = "game" | "loading" | "help" | "restart" | "storage-error" | MenuKind;

interface PendingNewPuzzle {
  readonly preferences: ChessPuzzlePreferences;
  readonly reason: "difficulty" | "theme" | "mode" | "restart";
}

interface BoardLayout {
  readonly top: number;
  readonly left: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly orientation: ChessColor;
}

interface PromotionLayout {
  readonly row: number;
  readonly cards: readonly {
    readonly promotion: ChessPromotion;
    readonly left: number;
    readonly width: number;
  }[];
}

interface ClickLayout {
  readonly row: number;
  readonly left: number;
  readonly width: number;
}

const DIFFICULTIES: readonly ChessPuzzleDifficulty[] = Object.freeze(["easy", "medium", "hard"]);
const MODES: readonly ChessPuzzleMode[] = Object.freeze(["daily", "practice"]);
const DEFAULT_REPLY_DELAY_MS = 420;

const PIECE_LABELS: Readonly<Record<ChessPiece, string>> = Object.freeze({
  K: "wK",
  Q: "wQ",
  R: "wR",
  B: "wB",
  N: "wN",
  P: "wP",
  k: "bK",
  q: "bQ",
  r: "bR",
  b: "bB",
  n: "bN",
  p: "bP",
});

const PIECE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  p: "Pawn",
  n: "Knight",
  b: "Bishop",
  r: "Rook",
  q: "Queen",
  k: "King",
});

function span(
  text: string,
  style: ActivitySpan["style"] = "text",
  emphasis: ActivitySpan["emphasis"] = "none",
  background?: ActivitySpan["background"],
): ActivitySpan {
  return Object.freeze({
    text,
    style,
    emphasis,
    ...(background === undefined ? {} : { background }),
  });
}

function line(...spans: readonly ActivitySpan[]): readonly ActivitySpan[] {
  return Object.freeze(spans);
}

function clipped(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, Math.max(0, width));
  return `${value.slice(0, width - 1)}…`;
}

function centered(
  value: string,
  width: number,
  style: ActivitySpan["style"] = "text",
  emphasis: ActivitySpan["emphasis"] = "none",
): readonly ActivitySpan[] {
  const text = clipped(value, Math.max(0, width));
  return line(
    span(" ".repeat(Math.max(0, Math.round((width - text.length) / 2)))),
    span(text, style, emphasis),
  );
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function difficultyLabel(value: ChessPuzzleDifficulty): string {
  return value.toUpperCase();
}

function modeLabel(value: ChessPuzzleMode): string {
  return value === "daily" ? "DAILY" : "PRACTICE";
}

function themeLabel(theme: ChessPuzzleTheme, themes: readonly ChessPuzzleThemeOption[]): string {
  if (theme === "any") return "Any theme";
  return themes.find(({ id }) => id === theme)?.label ?? theme;
}

function colorLabel(color: ChessColor): string {
  return color === "white" ? "White" : "Black";
}

function pieceColor(piece: ChessPiece | null | undefined): ChessColor | undefined {
  if (piece === null || piece === undefined) return undefined;
  return piece === piece.toUpperCase() ? "white" : "black";
}

function pieceName(piece: ChessPiece | null | undefined): string {
  if (piece === null || piece === undefined) return "Empty square";
  return `${colorLabel(pieceColor(piece) as ChessColor)} ${PIECE_NAMES[piece.toLowerCase()] as string}`;
}

function visualSquare(state: ChessPuzzleState, row: number, column: number): number {
  const white = state.orientation === "white";
  const file = white ? column : 7 - column;
  const rank = white ? 7 - row : row;
  return rank * 8 + file;
}

interface SquarePresentation {
  readonly marker: string;
  readonly markerStyle: ActivitySpan["style"];
  readonly artMarker?: ChessBoardMarker;
  readonly background: NonNullable<ActivitySpan["background"]>;
}

function padCell(value: string, width: number, fill = " "): string {
  const characters = [...value];
  let visibleLength = 0;
  let clipped = "";
  for (const character of characters) {
    if (character === "\uFE0E" || character === "\uFE0F") {
      clipped += character;
    } else if (visibleLength < width) {
      clipped += character;
      visibleLength += 1;
    }
  }
  const left = Math.floor((width - visibleLength) / 2);
  return `${fill.repeat(left)}${clipped}${fill.repeat(width - visibleLength - left)}`;
}

function squarePresentation(
  state: ChessPuzzleState,
  square: number,
  hints: { readonly from?: number; readonly to?: number },
  cursorVisible: boolean,
): SquarePresentation {
  const piece = state.position.board[square] as ChessPiece | null;
  const light = (Math.floor(square / 8) + (square % 8)) % 2 !== 0;
  const background: NonNullable<ActivitySpan["background"]> = light
    ? "surface"
    : "surfaceAlternate";
  const checked =
    piece !== null &&
    piece.toLowerCase() === "k" &&
    isChessInCheck(state.position, pieceColor(piece) as ChessColor);
  const selected = state.selectedSource === square;
  const cursor = cursorVisible && state.cursor === square;
  const legal = state.legalTargets.includes(square);
  const capture = legal && piece !== null;
  const attempted = state.incorrectMoves.at(-1);
  const wrongFrom =
    state.issue === "incorrect-move" && attempted?.slice(0, 2) === chessSquareName(square);
  const wrongTo =
    state.issue === "incorrect-move" && attempted?.slice(2, 4) === chessSquareName(square);
  const lastFrom = state.lastMove.move.from === square;
  const lastTo = state.lastMove.move.to === square;

  let marker = " ";
  let markerStyle: ActivitySpan["style"] = "text";
  let artMarker: ChessBoardMarker | undefined;
  if (checked || wrongTo) {
    marker = "!";
    markerStyle = "error";
    artMarker = checked ? "check" : "error";
  } else if (wrongFrom) {
    marker = "?";
    markerStyle = "error";
    artMarker = selected ? "selected-error" : "error";
  } else if (hints.from === square) {
    marker = "1";
    markerStyle = "warning";
    artMarker = "hint-from";
  } else if (hints.to === square) {
    marker = "2";
    markerStyle = "warning";
    artMarker = "hint-to";
  } else if (selected) {
    marker = "*";
    markerStyle = "accent";
    artMarker = "selected";
  } else if (cursor) {
    marker = ">";
    markerStyle = "accent";
    artMarker = "cursor";
  } else if (capture) {
    marker = "x";
    markerStyle = "warning";
    artMarker = "capture";
  } else if (legal) {
    marker = "·";
    markerStyle = "accent";
    artMarker = "move";
  } else if (lastFrom) {
    marker = "<";
    markerStyle = "accent";
    artMarker = "last-from";
  } else if (lastTo) {
    marker = ">";
    markerStyle = "accent";
    artMarker = "last-to";
  }

  return {
    marker,
    markerStyle,
    ...(artMarker === undefined ? {} : { artMarker }),
    background,
  };
}

function textSquare(
  state: ChessPuzzleState,
  square: number,
  hints: { readonly from?: number; readonly to?: number },
  cursorVisible: boolean,
): { readonly text: string; readonly style: ActivitySpan["style"] } {
  const piece = state.position.board[square] as ChessPiece | null;
  const label = piece === null ? "--" : PIECE_LABELS[piece];
  const checked =
    piece !== null &&
    piece.toLowerCase() === "k" &&
    isChessInCheck(state.position, pieceColor(piece) as ChessColor);
  const attempted = state.incorrectMoves.at(-1);
  let marker = " ";
  let style: ActivitySpan["style"] = piece === null ? "muted" : "text";
  if (
    checked ||
    (state.issue === "incorrect-move" && attempted?.slice(2, 4) === chessSquareName(square))
  ) {
    marker = "!";
    style = "error";
  } else if (
    state.issue === "incorrect-move" &&
    attempted?.slice(0, 2) === chessSquareName(square)
  ) {
    marker = "?";
    style = "error";
  } else if (hints.from === square) {
    marker = "1";
    style = "warning";
  } else if (hints.to === square) {
    marker = "2";
    style = "warning";
  } else if (state.selectedSource === square) {
    marker = "*";
    style = "selection";
  } else if (cursorVisible && state.cursor === square) {
    marker = ">";
    style = "selection";
  } else if (state.legalTargets.includes(square)) {
    marker = piece === null ? "·" : "x";
    style = piece === null ? "accent" : "warning";
  } else if (state.lastMove.move.from === square) {
    marker = "<";
    style = "accent";
  } else if (state.lastMove.move.to === square) {
    marker = ">";
    style = "accent";
  }
  return { text: `${marker}${label} `, style };
}

function boardLines(
  state: ChessPuzzleState,
  width: number,
  textOnly: boolean,
  hints: { readonly from?: number; readonly to?: number },
  cursorVisible: boolean,
): {
  readonly lines: readonly (readonly ActivitySpan[])[];
  readonly layout: BoardLayout;
  readonly image?: ActivityRasterImage;
} {
  const cellWidth = 4;
  const cellHeight = textOnly ? 1 : 2;
  const boardWidth = cellWidth * 8;
  const padding = Math.max(0, Math.round((width - boardWidth) / 2));
  const files = state.orientation === "white" ? "abcdefgh" : "hgfedcba";
  const rows: Array<readonly ActivitySpan[]> = [];
  if (textOnly) {
    rows.push(
      line(
        span(" ".repeat(padding)),
        span([...files].map((file) => padCell(file, cellWidth)).join(""), "muted", "strong"),
      ),
    );
  }
  const artSquares: Array<ChessBoardArtScene["squares"][number]> = [];
  for (let row = 0; row < 8; row += 1) {
    const pieces: ActivitySpan[] = [span(" ".repeat(padding))];
    const markers: ActivitySpan[] = [span(" ".repeat(padding))];
    for (let column = 0; column < 8; column += 1) {
      const square = visualSquare(state, row, column);
      const piece = state.position.board[square] as ChessPiece | null;
      const presentation = squarePresentation(state, square, hints, cursorVisible);
      const fallback = textSquare(state, square, hints, cursorVisible);
      pieces.push(
        span(
          padCell(piece === null ? "" : PIECE_LABELS[piece], cellWidth),
          piece === null ? "muted" : "text",
          piece === null ? "none" : "strong",
          presentation.background,
        ),
      );
      markers.push(
        span(
          padCell(presentation.marker, cellWidth),
          presentation.markerStyle,
          "strong",
          presentation.background,
        ),
      );
      artSquares.push(
        Object.freeze({
          piece,
          ...(presentation.artMarker === undefined ? {} : { marker: presentation.artMarker }),
        }),
      );
      if (textOnly) pieces[pieces.length - 1] = span(fallback.text, fallback.style, "strong");
    }
    rows.push(line(...pieces));
    if (!textOnly) rows.push(line(...markers));
  }
  const image = textOnly
    ? undefined
    : renderChessBoardRaster(
        Object.freeze({ squares: Object.freeze(artSquares), orientation: state.orientation }),
        Object.freeze({
          row: 0,
          column: padding,
          columns: CHESS_BOARD_COLUMNS,
          rows: CHESS_BOARD_ROWS,
        }),
      );
  return Object.freeze({
    lines: Object.freeze(rows),
    layout: Object.freeze({
      top: textOnly ? 1 : 0,
      left: padding,
      cellWidth,
      cellHeight,
      orientation: state.orientation,
    }),
    ...(image === undefined ? {} : { image }),
  });
}

function hintSquares(
  catalog: ChessPuzzleCatalog,
  state: ChessPuzzleState,
): { readonly from?: number; readonly to?: number } {
  if (state.status !== "active" || state.hintLevel === 0) return {};
  const expected = chessPuzzleExpectedMove(catalog, state);
  return {
    from: expected.from,
    ...(state.hintLevel >= 2 ? { to: expected.to } : {}),
  };
}

function boardWithHints(
  catalog: ChessPuzzleCatalog,
  state: ChessPuzzleState,
  width: number,
  textOnly: boolean,
  cursorVisible: boolean,
): {
  readonly lines: readonly (readonly ActivitySpan[])[];
  readonly layout: BoardLayout;
  readonly image?: ActivityRasterImage;
} {
  return boardLines(state, width, textOnly, hintSquares(catalog, state), cursorVisible);
}

function issueText(state: ChessPuzzleState): string | undefined {
  if (state.issue === "not-your-piece")
    return `${colorLabel(state.playerColor)} to move · select a ${state.playerColor} piece`;
  if (state.issue === "invalid-destination")
    return `${chessSquareName(state.cursor)} is not legal for this piece · choose a highlighted square`;
  if (state.issue === "incorrect-move")
    return "That move is legal, but not the puzzle solution · retry or press G for a hint";
  if (state.issue === "reply-pending") return "Wait for the exact opponent reply";
  if (state.issue === "puzzle-solved") return "Puzzle solved · start another when ready";
  return undefined;
}

function taskLine(
  catalog: ChessPuzzleCatalog,
  state: ChessPuzzleState,
  feedback: string,
  width: number,
): readonly ActivitySpan[] {
  const move = `${chessSquareName(state.lastMove.move.from)}→${chessSquareName(state.lastMove.move.to)}`;
  const hintedMove =
    state.status === "active" && state.hintLevel > 0
      ? chessPuzzleExpectedMove(catalog, state)
      : undefined;
  const hint = chessPuzzleHintText(catalog, state);
  let text: string;
  let style: ActivitySpan["style"] = "accent";
  if (state.status === "solved") {
    text = "◆ PUZZLE SOLVED ◆ · final position";
    style = "success";
  } else if (state.status === "reply-pending") {
    text = `Correct: ${move} · opponent replying…`;
    style = "warning";
  } else if (state.promotionChooser !== undefined) {
    text = `Promote pawn on ${chessSquareName(state.promotionChooser.to)} · choose a piece below`;
    style = "warning";
  } else if (state.issue === "incorrect-move") {
    const attempt = state.incorrectMoves.at(-1);
    const move =
      attempt === undefined ? "That move" : `${attempt.slice(0, 2)}→${attempt.slice(2, 4)}`;
    text =
      width < 45
        ? `${move} wrong tactic · retry or G hint`
        : width < 64
          ? `${move} legal, not the tactic · retry or G for hint`
          : `${move} is legal, but not the puzzle solution · retry or press G for a hint`;
    style = "error";
  } else if (hintedMove !== undefined) {
    text =
      state.hintLevel === 1
        ? `Hint 1/3 · FROM ${chessSquareName(hintedMove.from)}`
        : state.hintLevel === 2
          ? `Hint 2/3 · FROM ${chessSquareName(hintedMove.from)} · TO ${chessSquareName(hintedMove.to)}`
          : `Hint 3/3 · ${hint ?? "Follow the marked move"}`;
    style = "warning";
  } else if (state.selectedSource !== undefined) {
    const source = chessSquareName(state.selectedSource);
    const piece = state.position.board[state.selectedSource] as ChessPiece | null;
    text =
      state.legalTargets.length === 0
        ? `${pieceName(piece)} ${source} has no legal moves · select another piece`
        : width < 45
          ? `${pieceName(piece).replace(/^(White|Black) /u, "")} ${source} · choose highlighted square`
          : `${pieceName(piece)} ${source} selected · choose one of ${state.legalTargets.length} highlighted squares`;
    style = "accent";
  } else if (state.issue !== undefined) {
    text = issueText(state) ?? feedback;
    style = "error";
  } else {
    const actor = state.lastMove.actor === "setup" ? "Opponent" : titleCase(state.lastMove.actor);
    text =
      width < 45
        ? `${colorLabel(state.playerColor)} to move · find tactic · ${move}`
        : width < 64
          ? `${actor} ${move} · ${colorLabel(state.playerColor)} to move · find best tactic`
          : `${actor} ${move} · ${colorLabel(state.playerColor)} to move · find the best tactic`;
  }
  return centered(text, width, style, "strong");
}

function boardDetailLine(
  catalog: ChessPuzzleCatalog,
  state: ChessPuzzleState,
  width: number,
  textOnly: boolean,
  cursorVisible: boolean,
): readonly ActivitySpan[] {
  if (
    !cursorVisible &&
    state.selectedSource === undefined &&
    state.hintLevel === 0 &&
    state.issue === undefined &&
    state.status === "active"
  )
    return centered("Select one of your pieces to begin", width, "muted");
  const square = chessSquareName(state.cursor);
  const piece = state.position.board[state.cursor] as ChessPiece | null;
  const hints = hintSquares(catalog, state);
  const attempted = state.incorrectMoves.at(-1);
  const states: string[] = [];
  if (state.selectedSource === state.cursor) states.push("Selected");
  else if (state.legalTargets.includes(state.cursor))
    states.push(piece === null ? "Quiet move" : "Capture");
  if (state.lastMove.move.from === state.cursor) states.push("Last from");
  if (state.lastMove.move.to === state.cursor) states.push("Last to");
  if (hints.from === state.cursor) states.push("Hint source");
  if (hints.to === state.cursor) states.push("Hint target");
  if (state.issue === "incorrect-move") {
    const move =
      attempted === undefined ? undefined : `${attempted.slice(0, 2)}→${attempted.slice(2, 4)}`;
    states.push(move === undefined ? "Error" : `Error ${move}`);
  }
  if (
    piece !== null &&
    piece.toLowerCase() === "k" &&
    isChessInCheck(state.position, pieceColor(piece) as ChessColor)
  )
    states.push("Check");
  if (states.length === 0) states.push("Cursor");
  if (state.status === "reply-pending") states.push("Reply pending");
  if (state.status === "solved") states.push("Solved");
  const lastMove = `${chessSquareName(state.lastMove.move.from)}→${chessSquareName(state.lastMove.move.to)}`;
  const identity = textOnly ? ` · ${pieceName(piece).replace(" square", "")}` : "";
  const targets = state.legalTargets.length > 0 ? ` · ${state.legalTargets.length} targets` : "";
  const detail =
    width < 45
      ? `${square}${identity} · ${states.join(" · ")}${targets} · ${lastMove}`
      : `${square}${identity} · ${states.join(" · ")}${targets} · Last ${lastMove}`;
  const error = states.some((value) => value === "Check" || value.startsWith("Error"));
  return centered(detail, width, error ? "error" : "muted", error ? "strong" : "none");
}

function selectionLine<T extends string>(
  title: string,
  options: readonly T[],
  selected: T,
  label: (value: T) => string,
  width: number,
): readonly ActivitySpan[] {
  const content = options
    .map((option) => (option === selected ? `[${label(option)}]` : label(option)))
    .join("  ");
  return centered(`${title}: ${content}`, width, "accent", "strong");
}

function panelLines(
  panel: Panel,
  state: ChessPuzzleState,
  pending: PendingNewPuzzle | undefined,
  preferences: ChessPuzzlePreferences,
  themes: readonly ChessPuzzleThemeOption[],
  width: number,
  canReset: boolean,
): readonly (readonly ActivitySpan[])[] {
  if (state.promotionChooser !== undefined) {
    const labels = state.promotionChooser.choices
      .map((choice) =>
        choice === state.promotionChooser?.selected
          ? `[ ${titleCase(choice)} ]`
          : titleCase(choice),
      )
      .join("  ");
    return Object.freeze([
      centered(
        `Promote pawn on ${chessSquareName(state.promotionChooser.to)}`,
        width,
        "warning",
        "strong",
      ),
      centered(labels, width, "selection", "strong"),
      centered("←→ choose · Enter confirm · Esc cancel", width, "muted"),
    ]);
  }
  if (panel === "help")
    return Object.freeze([
      centered("CHESS PUZZLES · HELP", width, "accent", "strong"),
      centered("Select piece → highlighted square · dot move · corners capture", width, "muted"),
      centered("Best tactic only · other legal moves count as mistakes", width),
      centered(
        width < 54
          ? "B Flip · G Hint · D/T/M · R New · ? Back"
          : "B flip · G hint · D level · T theme · M mode · R new · ? back",
        width,
        "muted",
      ),
    ]);
  if (panel === "difficulty")
    return Object.freeze([
      selectionLine(
        "DIFFICULTY",
        DIFFICULTIES,
        pending?.preferences.difficulty ?? preferences.difficulty,
        difficultyLabel,
        width,
      ),
      centered("←→ choose · Enter start · Esc cancel", width, "muted"),
    ]);
  if (panel === "mode")
    return Object.freeze([
      selectionLine(
        "MODE",
        MODES,
        pending?.preferences.mode ?? preferences.mode,
        (value) => titleCase(value),
        width,
      ),
      centered("Daily is fixed by UTC date · Practice uses a fresh seed", width, "muted"),
      centered("←→ choose · Enter start · Esc cancel", width, "muted"),
    ]);
  if (panel === "theme") {
    const choices: readonly ChessPuzzleTheme[] = ["any", ...themes.map(({ id }) => id)];
    const selected = pending?.preferences.theme ?? preferences.theme;
    const index = choices.indexOf(selected);
    const description =
      selected === "any"
        ? "Draw from every reviewed tactical theme."
        : (themes.find(({ id }) => id === selected)?.description ?? "Reviewed tactical theme.");
    return Object.freeze([
      centered(
        `THEME ${index + 1}/${choices.length} · [ ${themeLabel(selected, themes)} ]`,
        width,
        "accent",
        "strong",
      ),
      centered(description, width),
      centered("←→ choose · Enter start · Esc cancel", width, "muted"),
    ]);
  }
  if (panel === "restart")
    return Object.freeze([
      centered("START A NEW PUZZLE?", width, "warning", "strong"),
      centered(`${titleCase(pending?.reason ?? "restart")} will replace current progress.`, width),
      centered("Y replace · N/Esc continue", width, "accent", "strong"),
    ]);
  if (panel === "storage-error")
    return Object.freeze([
      centered("CHESS SAVE UNAVAILABLE", width, "error", "strong"),
      centered(canReset ? "R reset local Chess save · Esc close" : "Esc close", width, "muted"),
    ]);
  return Object.freeze([]);
}

function controls(state: ChessPuzzleState, width: number): readonly (readonly ActivitySpan[])[] {
  if (width < 45) {
    const compact =
      state.status === "reply-pending"
        ? "Opponent replying… · input paused"
        : "Arrows/HJKL · Enter · B/G · D/T/M/R/?";
    return Object.freeze([
      centered(
        compact,
        width,
        state.status === "reply-pending" ? "warning" : "muted",
        state.status === "reply-pending" ? "strong" : "none",
      ),
    ]);
  }
  const first =
    state.status === "reply-pending"
      ? "Opponent replying… · board input paused"
      : width < 60
        ? "Arrows/HJKL · Enter/Space · B flip · G hint"
        : "Arrows/HJKL move · Enter/Space select · B flip · G hint";
  const second =
    width < 60
      ? "D Lv · T Theme · M Mode · R New · ? Help"
      : "D difficulty · T theme · M mode · R new · ? help";
  return Object.freeze([
    centered(
      first,
      width,
      state.status === "reply-pending" ? "warning" : "muted",
      state.status === "reply-pending" ? "strong" : "none",
    ),
    centered(second, width, "muted"),
  ]);
}

function renderFrame(
  viewport: ActivityViewport,
  catalog: ChessPuzzleCatalog,
  themes: readonly ChessPuzzleThemeOption[],
  state: ChessPuzzleState,
  document: ChessPuzzleSaveDocument,
  preferences: ChessPuzzlePreferences,
  panel: Panel,
  pending: PendingNewPuzzle | undefined,
  feedback: string,
  textOnly: boolean,
  reducedMotion: boolean,
  canReset: boolean,
  cursorVisible: boolean,
): {
  readonly frame: ActivityFrame;
  readonly board?: BoardLayout;
  readonly promotion?: PromotionLayout;
  readonly nextPuzzle?: ClickLayout;
} {
  if (panel === "loading")
    return {
      frame: Object.freeze({
        lines: Object.freeze([centered("Loading Chess Puzzles…", viewport.width, "muted")]),
      }),
    };
  const puzzle = chessPuzzleById(catalog, state.puzzleId);
  const primaryTheme = themes.find(({ id }) => puzzle.themes.includes(id))?.id ?? preferences.theme;
  const playerMove = Math.min(
    state.totalPlayerMoves,
    Math.floor(state.expectedSolutionPly / 2) + 1,
  );
  const phase =
    state.status === "solved"
      ? "SOLVED"
      : state.status === "reply-pending"
        ? "OPPONENT"
        : "YOUR MOVE";
  const presentation = textOnly ? " · TEXT" : reducedMotion ? " · CALM" : "";
  const filters = `${modeLabel(preferences.mode)} · ${difficultyLabel(preferences.difficulty)} · ${themeLabel(primaryTheme, themes).toUpperCase()}`;
  const compactPresentation = textOnly ? " TEXT" : reducedMotion ? " CALM" : "";
  const meta =
    viewport.width < 45
      ? `${colorLabel(state.playerColor)} · ${playerMove}/${state.totalPlayerMoves} · ${phase === "YOUR MOVE" ? "MOVE" : phase} · ${state.mistakes} wrong · H${state.hintLevel}${compactPresentation}`
      : viewport.width <= 64
        ? `${colorLabel(state.playerColor)} · ${playerMove}/${state.totalPlayerMoves} · ${phase === "YOUR MOVE" ? "YOUR MOVE" : phase} · ${state.mistakes} wrong · Hint ${state.hintLevel}/3${compactPresentation}`
        : `${colorLabel(state.playerColor)} · Move ${playerMove}/${state.totalPlayerMoves} · ${phase} · ${state.mistakes} wrong · Hint ${state.hintLevel}/3${presentation} | ${filters}`;
  const board = boardWithHints(catalog, state, viewport.width, textOnly, cursorVisible);
  const statusStyle =
    state.status === "solved" ? "success" : state.status === "reply-pending" ? "warning" : "muted";
  const information: readonly (readonly ActivitySpan[])[] = [
    taskLine(catalog, state, feedback, viewport.width),
    ...(viewport.width <= 64
      ? [centered(filters, viewport.width, "muted"), centered(meta, viewport.width, statusStyle)]
      : [centered(meta, viewport.width, statusStyle)]),
  ];
  let footer: readonly (readonly ActivitySpan[])[];
  const nextLabel =
    state.selection.kind === "daily"
      ? viewport.width < 54
        ? "[ Practice ]"
        : "[ Next practice ]"
      : viewport.width < 54
        ? "[ Next ]"
        : "[ Next puzzle ]";
  if (state.promotionChooser !== undefined) {
    footer = panelLines(panel, state, pending, preferences, themes, viewport.width, canReset).slice(
      1,
    );
  } else if (panel !== "game") {
    const rows = panelLines(panel, state, pending, preferences, themes, viewport.width, canReset);
    const maximum = Math.max(0, viewport.height - information.length - board.lines.length);
    footer =
      rows.length <= maximum
        ? rows
        : Object.freeze([
            rows[0] as readonly ActivitySpan[],
            ...(maximum > 2 && rows.length > 2 ? [rows[2] as readonly ActivitySpan[]] : []),
            rows.at(-1) as readonly ActivitySpan[],
          ]).slice(0, maximum);
  } else if (state.status === "solved") {
    const statistics = chessPuzzleStatistics(document);
    const streak =
      state.selection.kind === "daily" ? ` · Streak ${statistics.currentDailyStreak}` : "";
    footer = [
      boardDetailLine(catalog, state, viewport.width, textOnly, cursorVisible),
      centered(
        `${puzzle.rating} · ${themeLabel(primaryTheme, themes)} · ${state.mistakes} wrong · ${state.hintLevel} hints${streak}`,
        viewport.width,
        "success",
      ),
      centered(`${nextLabel} · Enter/R · Ctrl+P games`, viewport.width, "accent", "strong"),
    ];
  } else {
    footer = [
      boardDetailLine(catalog, state, viewport.width, textOnly, cursorVisible),
      ...controls(state, viewport.width),
    ];
  }
  const centeredBoardTop = Math.max(0, Math.floor((viewport.height - board.lines.length) / 2));
  const beforeInformation = Math.max(0, centeredBoardTop - information.length);
  const boardTop = beforeInformation + information.length;
  const afterFooter = Math.max(0, viewport.height - boardTop - board.lines.length - footer.length);
  const blanks = (count: number): readonly (readonly ActivitySpan[])[] =>
    Array.from({ length: count }, () => line());
  const lines = [
    ...blanks(beforeInformation),
    ...information,
    ...board.lines,
    ...footer,
    ...blanks(afterFooter),
  ].slice(0, viewport.height);
  while (lines.length < viewport.height) lines.push(line());
  const nextPuzzle =
    state.status !== "solved"
      ? undefined
      : (() => {
          const row = lines.findIndex((candidate) =>
            candidate
              .map(({ text }) => text)
              .join("")
              .includes(nextLabel),
          );
          if (row < 0) return undefined;
          const rendered = lines[row]?.map(({ text }) => text).join("") ?? "";
          return Object.freeze({ row, left: rendered.indexOf(nextLabel), width: nextLabel.length });
        })();
  const promotion =
    state.promotionChooser === undefined
      ? undefined
      : (() => {
          const labels = state.promotionChooser.choices.map((choice) =>
            choice === state.promotionChooser?.selected
              ? `[ ${titleCase(choice)} ]`
              : titleCase(choice),
          );
          const joined = labels.join("  ");
          const row = lines.findIndex((candidate) =>
            candidate
              .map(({ text }) => text)
              .join("")
              .includes(joined),
          );
          let left = Math.max(0, Math.round((viewport.width - joined.length) / 2));
          const cards = labels.map((label, index) => {
            const card = {
              promotion: state.promotionChooser?.choices[index] as ChessPromotion,
              left,
              width: label.length,
            };
            left += label.length + 2;
            return Object.freeze(card);
          });
          return Object.freeze({ row, cards: Object.freeze(cards) });
        })();
  return {
    frame: Object.freeze({
      lines: Object.freeze(lines),
      ...(board.image === undefined
        ? {}
        : {
            images: Object.freeze([
              Object.freeze({
                ...board.image,
                placement: Object.freeze({
                  ...board.image.placement,
                  row: boardTop,
                }),
              }),
            ]),
          }),
      ...(state.status === "solved"
        ? {
            announcement: `Puzzle solved with ${state.mistakes} mistakes and ${state.hintLevel} hints`,
          }
        : {}),
    }),
    board: Object.freeze({
      ...board.layout,
      top: boardTop + board.layout.top,
    }),
    ...(promotion === undefined || promotion.row < 0 ? {} : { promotion }),
    ...(nextPuzzle === undefined ? {} : { nextPuzzle }),
  };
}

function direction(
  input: Extract<ActivityInput, { readonly type: "key" }>,
): ChessPuzzleDirection | undefined {
  if (input.ctrl || input.alt) return undefined;
  const key = input.key.toLowerCase();
  if (key === "left" || key === "h") return "left";
  if (key === "right" || key === "l") return "right";
  if (key === "up" || key === "k") return "up";
  if (key === "down" || key === "j") return "down";
  return undefined;
}

function withPreference(
  preferences: ChessPuzzlePreferences,
  update: Partial<ChessPuzzlePreferences>,
): ChessPuzzlePreferences {
  return Object.freeze({ ...preferences, ...update });
}

function hasProgress(state: ChessPuzzleState): boolean {
  return (
    state.submittedMoves.length > 0 ||
    state.mistakes > 0 ||
    state.hintLevel > 0 ||
    state.selectedSource !== undefined
  );
}

export function chessPuzzleActivity(options: ChessPuzzleActivityOptions): TerminalActivity {
  if (options.themes.length !== 9)
    throw new Error("Chess puzzle activity requires nine reviewed themes");
  const replyDelayMs = options.replyDelayMs ?? DEFAULT_REPLY_DELAY_MS;
  if (!Number.isSafeInteger(replyDelayMs) || replyDelayMs < 0)
    throw new RangeError("Chess reply delay must be a non-negative integer");
  return {
    id: "axl.lounge.chess-puzzles",
    name: "Chess Puzzles",
    description: "Exact offline tactics with hints, filters, and board flipping",
    category: "game",
    mouse: true,
    minimumViewport: Object.freeze({ width: 40, height: 22 }),
    create(context) {
      let document = createEmptyChessPuzzleSave();
      let preferences = document.preferences;
      const selection = createDailyChessPuzzleSelection(
        options.catalog.revision,
        options.utcDate(),
        preferences.difficulty,
        preferences.theme,
      );
      let state = createChessPuzzle(options.catalog, selection);
      preferences = withPreference(preferences, { orientation: state.orientation });
      let panel: Panel = context.storage === undefined ? "game" : "loading";
      let panelBeforeHelp: Exclude<Panel, "help"> = "game";
      let pending: PendingNewPuzzle | undefined;
      let feedback = "Select one of your pieces, then choose its destination";
      let active = true;
      let focused = true;
      let inputEnabled = true;
      let canReset = false;
      let revision: number | null = null;
      let writer: ReturnType<typeof createChessPuzzleSaveWriter> | undefined;
      let pendingReply: ExtensionDisposer | undefined;
      let boardLayout: BoardLayout | undefined;
      let promotionLayout: PromotionLayout | undefined;
      let nextPuzzleLayout: ClickLayout | undefined;
      let cursorVisible = false;

      const invalidate = (): void => {
        if (active) context.invalidate();
      };
      const cancelReply = (): void => {
        pendingReply?.();
        pendingReply = undefined;
      };
      const save = (): void => {
        const updated = updateChessPuzzleSave(document, state, preferences);
        document = updated.document;
        try {
          writer?.enqueue(document, updated.completionAdded);
        } catch (error) {
          feedback = error instanceof Error ? error.message : "Chess save failed";
          panel = "storage-error";
        }
      };
      const applyReply = (): void => {
        if (state.status !== "reply-pending") return;
        state = reduceChessPuzzle(options.catalog, state, { type: "apply-opponent-reply" });
        feedback = "Opponent replied · find the next move";
        save();
        invalidate();
      };
      const scheduleReply = (): void => {
        cancelReply();
        if (!active || !focused || !inputEnabled || state.status !== "reply-pending") return;
        const presentation = context.presentation();
        if (presentation.reducedMotion || presentation.textOnly) {
          applyReply();
          return;
        }
        pendingReply = context.schedule(replyDelayMs, () => {
          pendingReply = undefined;
          applyReply();
        });
      };
      const apply = (action: Parameters<typeof reduceChessPuzzle>[2], message: string): boolean => {
        const previous = state;
        state = reduceChessPuzzle(options.catalog, state, action);
        if (state === previous) return false;
        feedback = issueText(state) ?? message;
        save();
        if (state.status === "reply-pending") scheduleReply();
        invalidate();
        return true;
      };
      const newSelection = (next: ChessPuzzlePreferences) =>
        next.mode === "daily"
          ? createDailyChessPuzzleSelection(
              options.catalog.revision,
              options.utcDate(),
              next.difficulty,
              next.theme,
            )
          : createPracticeChessPuzzleSelection(
              options.catalog.revision,
              options.practiceSeed(),
              next.difficulty,
              next.theme,
            );
      const startPuzzle = (next = preferences): void => {
        cancelReply();
        preferences = next;
        state = createChessPuzzle(options.catalog, newSelection(next));
        cursorVisible = false;
        if (state.orientation !== next.orientation)
          state = reduceChessPuzzle(options.catalog, state, { type: "flip-board" });
        panel = "game";
        pending = undefined;
        feedback = "New puzzle · select one of your pieces";
        save();
        invalidate();
      };
      const requestNew = (
        next: ChessPuzzlePreferences,
        reason: PendingNewPuzzle["reason"],
      ): void => {
        pending = Object.freeze({ preferences: next, reason });
        if (hasProgress(state) && state.status !== "solved") panel = "restart";
        else startPuzzle(next);
        invalidate();
      };
      const startNextPuzzle = (): void => {
        startPuzzle(
          state.selection.kind === "daily"
            ? withPreference(preferences, { mode: "practice" })
            : preferences,
        );
      };
      const openMenu = (kind: MenuKind): void => {
        pending = Object.freeze({ preferences, reason: kind });
        panel = kind;
        invalidate();
      };
      const menuMove = (delta: number): void => {
        if (pending === undefined) return;
        if (panel === "difficulty") {
          const index = DIFFICULTIES.indexOf(pending.preferences.difficulty);
          pending = Object.freeze({
            ...pending,
            preferences: withPreference(pending.preferences, {
              difficulty: DIFFICULTIES[
                (index + delta + DIFFICULTIES.length) % DIFFICULTIES.length
              ] as ChessPuzzleDifficulty,
            }),
          });
        } else if (panel === "mode") {
          const index = MODES.indexOf(pending.preferences.mode);
          pending = Object.freeze({
            ...pending,
            preferences: withPreference(pending.preferences, {
              mode: MODES[(index + delta + MODES.length) % MODES.length] as ChessPuzzleMode,
            }),
          });
        } else if (panel === "theme") {
          const choices: readonly ChessPuzzleTheme[] = [
            "any",
            ...options.themes.map(({ id }) => id),
          ];
          const index = choices.indexOf(pending.preferences.theme);
          pending = Object.freeze({
            ...pending,
            preferences: withPreference(pending.preferences, {
              theme: choices[(index + delta + choices.length) % choices.length] as ChessPuzzleTheme,
            }),
          });
        }
        invalidate();
      };
      const choosePromotion = (delta: number): void => {
        const chooser = state.promotionChooser;
        if (chooser === undefined) return;
        const index = chooser.choices.indexOf(chooser.selected);
        apply(
          {
            type: "choose-promotion",
            promotion: chooser.choices[
              (index + delta + chooser.choices.length) % chooser.choices.length
            ] as ChessPromotion,
          },
          "Promotion choice changed",
        );
      };
      const activateSquare = (): void => {
        const previousStatus = state.status;
        apply({ type: "activate" }, "Selection updated");
        if (previousStatus === "active" && state.status === "solved")
          feedback = "Exact line complete";
      };
      const closeLocal = (): boolean => {
        if (state.promotionChooser !== undefined) {
          apply({ type: "clear-selection" }, "Promotion cancelled · source kept");
          return true;
        }
        if (panel === "storage-error" || panel === "loading") return false;
        if (panel !== "game") {
          panel = panel === "help" ? panelBeforeHelp : "game";
          pending = undefined;
          invalidate();
          return true;
        }
        if (state.selectedSource !== undefined) {
          apply({ type: "clear-selection" }, "Selection cleared");
          return true;
        }
        return false;
      };

      if (context.storage !== undefined) {
        void context.storage
          .read(context.signal)
          .then((stored) => {
            if (!active) return;
            if (stored !== undefined) {
              revision = stored.revision;
              if (stored.schemaVersion !== CHESS_PUZZLE_STORAGE_SCHEMA_VERSION)
                throw new ChessPuzzleSaveError(
                  stored.schemaVersion > CHESS_PUZZLE_STORAGE_SCHEMA_VERSION
                    ? "future-version"
                    : "corrupt",
                  `Unsupported Chess puzzle storage schema ${stored.schemaVersion}`,
                );
              const restored = parseChessPuzzleSave(stored.value, options.catalog);
              document = restored.document;
              preferences = document.preferences;
              if (restored.state !== undefined) {
                state = restored.state;
                cursorVisible = state.selectedSource !== undefined;
              } else state = createChessPuzzle(options.catalog, newSelection(preferences));
              feedback =
                restored.state === undefined
                  ? "Ready for a new puzzle"
                  : "Saved puzzle restored exactly";
            }
            writer = createChessPuzzleSaveWriter(
              context.storage as NonNullable<typeof context.storage>,
              options.catalog,
              revision,
            );
            panel = "game";
            if (stored === undefined) save();
            scheduleReply();
            invalidate();
          })
          .catch((error: unknown) => {
            if (!active || (error instanceof ActivityStorageError && error.code === "aborted"))
              return;
            feedback = error instanceof Error ? error.message : "Chess save cannot be read";
            canReset = revision !== null;
            panel = "storage-error";
            invalidate();
          });
      }

      return {
        render(viewport) {
          inputEnabled = viewport.width >= 40 && viewport.height >= 22;
          const presentation = context.presentation();
          const rendered = renderFrame(
            viewport,
            options.catalog,
            options.themes,
            state,
            document,
            preferences,
            panel,
            pending,
            feedback,
            presentation.textOnly,
            presentation.reducedMotion,
            canReset,
            cursorVisible,
          );
          boardLayout = rendered.board;
          promotionLayout = rendered.promotion;
          nextPuzzleLayout = rendered.nextPuzzle;
          return rendered.frame;
        },
        handleInput(input) {
          if (input.type === "focus") {
            focused = input.focused;
            if (focused) scheduleReply();
            else cancelReply();
            return false;
          }
          if (!active || !focused || !inputEnabled || panel === "loading") return false;
          if (input.type === "mouse") {
            if (input.phase !== "press" || input.button !== "left") return false;
            if (
              state.status === "solved" &&
              nextPuzzleLayout !== undefined &&
              input.row === nextPuzzleLayout.row &&
              input.column >= nextPuzzleLayout.left &&
              input.column < nextPuzzleLayout.left + nextPuzzleLayout.width
            ) {
              startNextPuzzle();
              return true;
            }
            if (
              state.promotionChooser !== undefined &&
              promotionLayout !== undefined &&
              input.row === promotionLayout.row
            ) {
              const card = promotionLayout.cards.find(
                ({ left, width }) => input.column >= left && input.column < left + width,
              );
              if (card !== undefined) {
                apply(
                  { type: "choose-promotion", promotion: card.promotion },
                  "Promotion choice changed",
                );
                apply({ type: "confirm-promotion" }, `Promoted to ${card.promotion}`);
                return true;
              }
            }
            const layout = boardLayout;
            if (
              panel !== "game" ||
              layout === undefined ||
              input.row < layout.top ||
              input.row >= layout.top + layout.cellHeight * 8 ||
              input.column < layout.left ||
              input.column >= layout.left + layout.cellWidth * 8
            )
              return false;
            const row = Math.floor((input.row - layout.top) / layout.cellHeight);
            const localColumn = input.column - layout.left;
            const column = Math.floor(localColumn / layout.cellWidth);
            cursorVisible = true;
            const square = visualSquare(state, row, column);
            apply({ type: "set-cursor", square }, "Cursor moved");
            activateSquare();
            return true;
          }
          if (input.type !== "key" || input.repeat) return false;
          if (input.key === "escape") return closeLocal();
          if (input.ctrl || input.alt) return false;
          const key = input.key.toLowerCase();
          if (input.key === "?") {
            if (panel === "help") panel = panelBeforeHelp;
            else {
              panelBeforeHelp = panel;
              panel = "help";
            }
            invalidate();
            return true;
          }
          if (panel === "storage-error") {
            if (key === "r" && canReset && revision !== null) {
              void context.storage
                ?.reset(revision)
                .then(() => {
                  revision = null;
                  canReset = false;
                  document = createEmptyChessPuzzleSave();
                  preferences = document.preferences;
                  writer = createChessPuzzleSaveWriter(
                    context.storage as NonNullable<typeof context.storage>,
                    options.catalog,
                    null,
                  );
                  startPuzzle();
                })
                .catch((error: unknown) => {
                  feedback = error instanceof Error ? error.message : "Chess reset failed";
                  invalidate();
                });
              return true;
            }
            return false;
          }
          if (panel === "help") return true;
          if (panel === "restart") {
            if (key === "y") startPuzzle(pending?.preferences ?? preferences);
            else if (key === "n") {
              panel = "game";
              pending = undefined;
              feedback = "Current puzzle kept";
              invalidate();
            }
            return true;
          }
          if (panel === "difficulty" || panel === "theme" || panel === "mode") {
            const move = direction(input);
            if (move === "left" || move === "up") menuMove(-1);
            else if (move === "right" || move === "down") menuMove(1);
            else if (input.key === "enter" || input.key === " ")
              requestNew(pending?.preferences ?? preferences, panel);
            else if (panel === "theme" && /^[1-9]$/u.test(key)) {
              const choices: readonly ChessPuzzleTheme[] = [
                "any",
                ...options.themes.map(({ id }) => id),
              ];
              const selected = choices[Number(key) - 1];
              if (selected !== undefined && pending !== undefined) {
                pending = Object.freeze({
                  ...pending,
                  preferences: withPreference(pending.preferences, { theme: selected }),
                });
                invalidate();
              }
            } else if (panel === "theme" && key === "0" && pending !== undefined) {
              pending = Object.freeze({
                ...pending,
                preferences: withPreference(pending.preferences, {
                  theme: options.themes.at(-1)?.id ?? "any",
                }),
              });
              invalidate();
            }
            return true;
          }
          if (state.promotionChooser !== undefined) {
            const move = direction(input);
            if (move === "left" || move === "up") choosePromotion(-1);
            else if (move === "right" || move === "down") choosePromotion(1);
            else if (input.key === "enter" || input.key === " ")
              apply(
                { type: "confirm-promotion" },
                `Promoted to ${state.promotionChooser.selected}`,
              );
            else {
              const promotion = ({ q: "queen", r: "rook", b: "bishop", n: "knight" } as const)[
                key as "q" | "r" | "b" | "n"
              ];
              if (promotion !== undefined)
                apply({ type: "choose-promotion", promotion }, "Promotion choice changed");
            }
            return true;
          }
          if (
            state.status === "solved" &&
            (input.key === "enter" || input.key === " " || key === "n" || key === "r")
          ) {
            startNextPuzzle();
            return true;
          }
          if (key === "b") {
            apply({ type: "flip-board" }, "Board flipped");
            preferences = withPreference(preferences, { orientation: state.orientation });
            save();
            return true;
          }
          if (key === "g") {
            if (!apply({ type: "hint" }, "Hint advanced")) {
              feedback =
                state.hintLevel === 3
                  ? "All hint levels are already visible"
                  : "Hints are unavailable now";
              invalidate();
            }
            return true;
          }
          if (key === "d") {
            openMenu("difficulty");
            return true;
          }
          if (key === "t") {
            openMenu("theme");
            return true;
          }
          if (key === "m") {
            openMenu("mode");
            return true;
          }
          if (key === "r") {
            requestNew(preferences, "restart");
            return true;
          }
          const move = direction(input);
          if (move !== undefined) {
            cursorVisible = true;
            apply({ type: "move-cursor", direction: move }, "Cursor moved");
            return true;
          }
          if (input.key === "enter" || input.key === " ") {
            cursorVisible = true;
            activateSquare();
            return true;
          }
          return false;
        },
        presentationChanged() {
          cancelReply();
          scheduleReply();
          invalidate();
        },
        pause: () => {
          active = false;
          focused = false;
          cancelReply();
        },
        resume: () => {
          active = true;
          focused = true;
          scheduleReply();
          invalidate();
        },
        serialize: () =>
          chessPuzzleSaveJson(updateChessPuzzleSave(document, state, preferences).document),
        async dispose() {
          active = false;
          focused = false;
          cancelReply();
          const updated = updateChessPuzzleSave(document, state, preferences);
          document = updated.document;
          await writer?.dispose(document, updated.completionAdded);
        },
      };
    },
  };
}
