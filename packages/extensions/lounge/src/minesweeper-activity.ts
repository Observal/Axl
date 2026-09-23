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
  adjacentMineCount,
  createMinesweeper,
  type MinesweeperDirection,
  type MinesweeperPreset,
  type MinesweeperState,
  minesweeperCoordinates,
  minesweeperNeighbors,
  reduceMinesweeper,
  remainingMineEstimate,
} from "./minesweeper.ts";
import {
  MINESWEEPER_STORAGE_SCHEMA_VERSION,
  type MinesweeperSaveDocument,
  MinesweeperSaveError,
  minesweeperSaveJson,
  parseMinesweeperSave,
  updateMinesweeperSave,
} from "./minesweeper-state.ts";

export interface MinesweeperActivityOptions {
  readonly seed?: () => number;
}

type Panel = "loading" | "game" | "help" | "restart" | "preset" | "storage-error";

const HELP_CHOICE_ROW = 10;

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

function presetName(preset: MinesweeperPreset): string {
  return preset === "beginner" ? "BEGINNER" : preset === "intermediate" ? "INTERMEDIATE" : "EXPERT";
}

function formatTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function coordinate(state: MinesweeperState, index = state.cursor): string {
  const { row, column } = minesweeperCoordinates(state, index);
  return `${columnLabel(column)}${row + 1}`;
}

interface CellPresentation {
  readonly glyph: string;
  readonly style: ActivitySpan["style"];
  readonly strong?: boolean;
}

function cellPresentation(
  state: MinesweeperState,
  index: number,
  textOnly: boolean,
): CellPresentation {
  if (state.status === "won" && state.mines[index]) {
    return { glyph: textOnly ? "M" : "◆", style: "success", strong: true };
  }
  if (state.status === "lost") {
    if (state.exploded === index) return { glyph: "!", style: "error", strong: true };
    if (state.flagged[index] && !state.mines[index])
      return { glyph: "x", style: "error", strong: true };
    if (state.flagged[index]) return { glyph: "F", style: "warning", strong: true };
    if (state.mines[index]) return { glyph: "*", style: "error", strong: true };
  }
  if (state.flagged[index]) return { glyph: "F", style: "warning", strong: true };
  if (!state.revealed[index]) return { glyph: textOnly ? "#" : "□", style: "muted" };
  const count = adjacentMineCount(state, index);
  if (count === 0) return { glyph: textOnly ? "." : "·", style: "muted" };
  if (count <= 2) return { glyph: String(count), style: "accent", strong: true };
  if (count <= 4) return { glyph: String(count), style: "warning", strong: true };
  return { glyph: String(count), style: "error", strong: true };
}

interface BoardFrame {
  readonly lines: readonly (readonly ActivitySpan[])[];
  readonly originRow: number;
  readonly originColumn: number;
  readonly visibleRows: number;
  readonly visibleColumns: number;
  readonly pitch: number;
  readonly cellRow: number;
  readonly cellColumn: number;
}

function columnLabel(column: number): string {
  return column < 26
    ? String.fromCharCode(65 + column)
    : `${String.fromCharCode(64 + Math.floor((column + 1) / 26))}${String.fromCharCode(65 + (column % 26))}`;
}

function renderBoard(
  state: MinesweeperState,
  viewport: ActivityViewport,
  textOnly: boolean,
): BoardFrame {
  const boardHeight = Math.max(1, viewport.height - 8);
  const pitch = 3;
  const gutterWidth = 7;
  const visibleColumns = Math.max(
    1,
    Math.min(state.width, Math.floor((viewport.width - gutterWidth - 1) / pitch)),
  );
  const visibleRows = Math.max(1, Math.min(state.height, boardHeight));
  const cursor = minesweeperCoordinates(state, state.cursor);
  const originColumn = Math.max(
    0,
    Math.min(state.width - visibleColumns, cursor.column - Math.floor(visibleColumns / 2)),
  );
  const originRow = Math.max(
    0,
    Math.min(state.height - visibleRows, cursor.row - Math.floor(visibleRows / 2)),
  );
  const boardWidth = gutterWidth + visibleColumns * pitch + 1;
  const padding = Math.max(0, Math.floor((viewport.width - boardWidth) / 2));
  const cellRow = 2;
  const cellColumn = padding + gutterWidth;
  const rows: Array<readonly ActivitySpan[]> = [];
  const leftMore = originColumn > 0 ? "‹" : " ";
  const rightMore = originColumn + visibleColumns < state.width ? "›" : " ";
  const labels: ActivitySpan[] = [
    span(" ".repeat(padding)),
    span(textOnly ? "COLS" : "    ", "muted"),
    span(`${leftMore}│ `, "muted"),
  ];
  for (let visibleColumn = 0; visibleColumn < visibleColumns; visibleColumn += 1) {
    labels.push(
      span(
        columnLabel(originColumn + visibleColumn)
          .padStart(2, " ")
          .padEnd(3, " "),
        "muted",
      ),
    );
  }
  labels.push(span(rightMore, "muted"));
  rows.push(line(...labels));
  rows.push(
    line(
      span(" ".repeat(padding)),
      span(textOnly ? "-----+-" : "─────┼─", "muted"),
      span((textOnly ? "-" : "─").repeat(visibleColumns * pitch + 1), "muted"),
    ),
  );

  for (let visibleRow = 0; visibleRow < visibleRows; visibleRow += 1) {
    const row = originRow + visibleRow;
    const vertical =
      visibleRow === 0 && originRow > 0
        ? "↑"
        : visibleRow === visibleRows - 1 && originRow + visibleRows < state.height
          ? "↓"
          : " ";
    const spans: ActivitySpan[] = [
      span(" ".repeat(padding)),
      span(vertical, "muted"),
      span(String(row + 1).padStart(2, "0"), "muted"),
      span("  │ ", "muted"),
    ];
    for (let visibleColumn = 0; visibleColumn < visibleColumns; visibleColumn += 1) {
      const column = originColumn + visibleColumn;
      const index = row * state.width + column;
      const cell = cellPresentation(state, index, textOnly);
      const selected = index === state.cursor;
      spans.push(
        span(selected ? "[" : " ", selected ? "selection" : "text", selected ? "strong" : "none"),
        span(cell.glyph, cell.style, cell.strong ? "strong" : "none"),
        span(selected ? "]" : " ", selected ? "selection" : "text", selected ? "strong" : "none"),
      );
    }
    spans.push(span(rightMore, "muted"));
    rows.push(line(...spans));
  }
  return Object.freeze({
    lines: Object.freeze(rows),
    originRow,
    originColumn,
    visibleRows,
    visibleColumns,
    pitch,
    cellRow,
    cellColumn,
  });
}

function header(state: MinesweeperState, width: number): string {
  const flags = state.flagged.filter(Boolean).length;
  const mineLabel =
    state.status === "won" || state.status === "lost"
      ? `MINES ${state.mineCount}`
      : `MINES EST ${remainingMineEstimate(state)}`;
  const full = `${presetName(state.preset)}   ${mineLabel}   FLAGS ${flags}   TIME ${formatTime(state.elapsedMs)}`;
  const compact = `${presetName(state.preset)} · ${mineLabel} · ${formatTime(state.elapsedMs)}`;
  return (full.length <= width ? full : compact).slice(0, width);
}

type LocalAction =
  | "primary"
  | "flag"
  | "chord"
  | "restart"
  | "help"
  | "beginner"
  | "intermediate"
  | "expert";

interface ActionButton {
  readonly action: LocalAction;
  readonly label: string;
}

function actionButtons(state: MinesweeperState, width: number): readonly ActionButton[] {
  if (state.status === "won" || state.status === "lost") {
    return width < 60
      ? [
          { action: "restart", label: "[Enter/R New]" },
          { action: "help", label: "[? Help]" },
        ]
      : [
          { action: "restart", label: "[Enter/R New game]" },
          { action: "help", label: "[? Help]" },
        ];
  }
  return width < 60
    ? [
        { action: "primary", label: "[Enter Open]" },
        { action: "flag", label: "[F Flag]" },
        { action: "restart", label: "[R New]" },
        { action: "help", label: "[? Help]" },
      ]
    : [
        { action: "primary", label: "[Enter Open/Chord]" },
        { action: "flag", label: "[F Flag]" },
        { action: "restart", label: "[R New]" },
        { action: "help", label: "[? Help]" },
      ];
}

function presetButtons(width: number): readonly ActionButton[] {
  return width < 60
    ? [
        { action: "beginner", label: "[1 Beginner]" },
        { action: "intermediate", label: "[2 Inter.]" },
        { action: "expert", label: "[3 Expert]" },
      ]
    : [
        { action: "beginner", label: "[1 Beginner]" },
        { action: "intermediate", label: "[2 Intermediate]" },
        { action: "expert", label: "[3 Expert]" },
      ];
}

function buttonLine(buttons: readonly ActionButton[], width: number): readonly ActivitySpan[] {
  const textWidth =
    buttons.reduce((total, button) => total + button.label.length, 0) +
    Math.max(0, buttons.length - 1);
  const spans: ActivitySpan[] = [
    span(" ".repeat(Math.max(0, Math.floor((width - textWidth) / 2)))),
  ];
  buttons.forEach((button, index) => {
    spans.push(
      span(
        button.label,
        button.action === "restart" && buttons.length <= 3 ? "accent" : "muted",
        button.action === "restart" && buttons.length <= 3 ? "strong" : "none",
      ),
    );
    if (index + 1 < buttons.length) spans.push(span(" "));
  });
  return line(...spans);
}

function actionAt(
  buttons: readonly ActionButton[],
  width: number,
  column: number,
): LocalAction | undefined {
  const textWidth =
    buttons.reduce((total, button) => total + button.label.length, 0) +
    Math.max(0, buttons.length - 1);
  let offset = Math.max(0, Math.floor((width - textWidth) / 2));
  for (const button of buttons) {
    if (column >= offset && column < offset + button.label.length) return button.action;
    offset += button.label.length + 1;
  }
  return undefined;
}

function choiceLine(labels: readonly string[], width: number): readonly ActivitySpan[] {
  const textWidth =
    labels.reduce((total, label) => total + label.length, 0) + Math.max(0, labels.length - 1);
  const spans: ActivitySpan[] = [
    span(" ".repeat(Math.max(0, Math.floor((width - textWidth) / 2)))),
  ];
  labels.forEach((label, index) => {
    spans.push(span(label, "accent", "strong"));
    if (index + 1 < labels.length) spans.push(span(" "));
  });
  return line(...spans);
}

function choiceAt(labels: readonly string[], width: number, column: number): number | undefined {
  const textWidth =
    labels.reduce((total, label) => total + label.length, 0) + Math.max(0, labels.length - 1);
  let offset = Math.max(0, Math.floor((width - textWidth) / 2));
  for (const [index, label] of labels.entries()) {
    if (column >= offset && column < offset + label.length) return index;
    offset += label.length + 1;
  }
  return undefined;
}

function statusLines(
  state: MinesweeperState,
  feedback: string,
  width: number,
): readonly (readonly ActivitySpan[])[] {
  if (state.status === "won") {
    return Object.freeze([
      centered(`╭── CLEARED! · ${formatTime(state.elapsedMs)} ──╮`, width, "success", "strong"),
      centered(
        width < 60
          ? "Enter/R new · Ctrl+P Games"
          : "Enter or R starts a fresh board · Ctrl+P opens Games",
        width,
        "success",
      ),
      centered("All safe cells are open · cleared mines marked ◆", width, "muted"),
    ]);
  }
  if (state.status === "lost") {
    const wrong = state.flagged.filter((flagged, index) => flagged && !state.mines[index]).length;
    return Object.freeze([
      centered(
        `╭── BOOM! · MINE AT ${coordinate(state, state.exploded)} ──╮`,
        width,
        "error",
        "strong",
      ),
      centered(
        `${wrong} wrong flag${wrong === 1 ? "" : "s"} · ${width < 60 ? "Enter/R new" : "Enter or R starts a fresh board"}`,
        width,
        "error",
      ),
      centered("! exploded · * mine · F correct flag · x wrong flag", width, "muted"),
    ]);
  }
  const nearby = state.minesPlaced ? adjacentMineCount(state, state.cursor) : undefined;
  const neighbors = minesweeperNeighbors(state, state.cursor);
  const flags = neighbors.filter((index) => state.flagged[index]).length;
  const hidden = neighbors.filter(
    (index) => !state.flagged[index] && !state.revealed[index],
  ).length;
  const selected = state.flagged[state.cursor]
    ? `${coordinate(state)} · FLAGGED · F removes flag`
    : !state.revealed[state.cursor]
      ? `${coordinate(state)} · HIDDEN · Enter open · F flag`
      : nearby === 0
        ? `${coordinate(state)} · CLEAR · find the numbered edge`
        : flags === nearby && hidden > 0
          ? width < 60
            ? `${coordinate(state)} · ${flags}/${nearby} flags · ENTER CHORD READY`
            : `${coordinate(state)} · ${nearby} nearby · ${flags}/${nearby} flagged · ENTER/C CHORD READY`
          : `${coordinate(state)} · ${nearby} nearby · ${flags}/${nearby} flagged · ${hidden} hidden`;
  const safeLeft =
    state.width * state.height - state.mineCount - state.revealed.filter(Boolean).length;
  return Object.freeze([
    centered(
      selected,
      width,
      flags === nearby && hidden > 0 ? "success" : "accent",
      flags === nearby && hidden > 0 ? "strong" : "none",
    ),
    centered(
      width < 60 ? `${safeLeft} safe · ${feedback}` : `SAFE LEFT ${safeLeft} · ${feedback}`,
      width,
      "muted",
    ),
    centered(
      width < 60
        ? "Mouse*: L open · R flag · M chord"
        : "Mouse/touch*: left open/chord · right flag · middle chord",
      width,
      "muted",
    ),
  ]);
}

function renderGame(
  viewport: ActivityViewport,
  state: MinesweeperState,
  panel: Panel,
  feedback: string,
  pendingPreset: MinesweeperPreset | undefined,
  storageReset: boolean,
  textOnly: boolean,
  renderedBoard?: BoardFrame,
): ActivityFrame {
  if (panel === "loading") {
    return Object.freeze({
      lines: Object.freeze([centered("Loading Minesweeper…", viewport.width, "muted")]),
    });
  }
  if (panel === "storage-error") {
    return Object.freeze({
      lines: Object.freeze(
        [
          centered("MINESWEEPER SAVE UNAVAILABLE", viewport.width, "error", "strong"),
          centered(feedback, viewport.width, "warning"),
          storageReset
            ? choiceLine(["[R Reset save]", "[Esc Close]"], viewport.width)
            : choiceLine(["[Esc Close]"], viewport.width),
        ].slice(0, viewport.height),
      ),
    });
  }
  if (panel === "help") {
    return Object.freeze({
      lines: Object.freeze(
        [
          centered("MINESWEEPER · HOW TO PLAY", viewport.width, "accent", "strong"),
          centered("Reveal every safe cell. Numbers count adjacent mines.", viewport.width),
          centered("Keyboard: arrows/HJKL move", viewport.width),
          centered("Space/Enter reveal or chord · F flag", viewport.width),
          centered("C chord a revealed number", viewport.width),
          centered(
            "# hidden · F flag · . clear · * mine · ! exploded · x wrong · ◆ cleared mine",
            viewport.width,
            "muted",
          ),
          centered("Mouse: left reveal/chord · right flag", viewport.width, "muted"),
          centered("Middle-click chord", viewport.width, "muted"),
          centered("Touch*: terminal must translate taps", viewport.width, "muted"),
          centered("No native touch gestures", viewport.width, "muted"),
          choiceLine(["[? Back]", "[R New]"], viewport.width),
        ].slice(0, viewport.height),
      ),
    });
  }
  if (panel === "restart" || panel === "preset") {
    const target = pendingPreset ?? state.preset;
    return Object.freeze({
      lines: Object.freeze(
        [
          centered(
            panel === "preset" ? `START ${presetName(target)}?` : "NEW MINESWEEPER BOARD?",
            viewport.width,
            "warning",
            "strong",
          ),
          centered("Reveals, flags, and elapsed time will be replaced.", viewport.width),
          choiceLine(["[Y Replace]", "[N Continue]"], viewport.width),
        ].slice(0, viewport.height),
      ),
    });
  }

  const board = renderedBoard ?? renderBoard(state, viewport, textOnly);
  return Object.freeze({
    lines: Object.freeze(
      [
        centered(header(state, viewport.width), viewport.width, "text", "strong"),
        ...statusLines(state, feedback, viewport.width),
        ...board.lines,
        buttonLine(presetButtons(viewport.width), viewport.width),
        buttonLine(actionButtons(state, viewport.width), viewport.width),
      ].slice(0, viewport.height),
    ),
    ...(state.status === "won"
      ? { announcement: "Minesweeper cleared" }
      : state.status === "lost"
        ? { announcement: `Game over. Mine at ${coordinate(state, state.exploded)}` }
        : {}),
  });
}

function direction(
  input: Extract<ActivityInput, { readonly type: "key" }>,
): MinesweeperDirection | undefined {
  if (input.ctrl || input.alt) return undefined;
  const key = input.key.toLowerCase();
  if (key === "left" || key === "h") return "left";
  if (key === "right" || key === "l") return "right";
  if (key === "up" || key === "k") return "up";
  if (key === "down" || key === "j") return "down";
  return undefined;
}

function presetForKey(key: string): MinesweeperPreset | undefined {
  return key === "1"
    ? "beginner"
    : key === "2"
      ? "intermediate"
      : key === "3"
        ? "expert"
        : undefined;
}

function hasProgress(state: MinesweeperState): boolean {
  return state.minesPlaced || state.flagged.some(Boolean) || state.elapsedMs > 0;
}

function chordFeedback(state: MinesweeperState): string {
  if (!state.revealed[state.cursor]) return "Reveal a numbered cell before chording";
  const count = adjacentMineCount(state, state.cursor);
  if (count === 0) return "This cell has no adjacent mines to chord";
  const flags = minesweeperNeighbors(state, state.cursor).filter(
    (index) => state.flagged[index],
  ).length;
  return flags === count
    ? "No hidden adjacent cells to reveal"
    : `Need ${count} adjacent flags to chord · ${flags} placed`;
}

export function minesweeperActivity(options: MinesweeperActivityOptions = {}): TerminalActivity {
  return {
    id: "axl.lounge.minesweeper",
    name: "Minesweeper",
    description: "Clear a minefield with logic and careful flags",
    category: "game",
    mouse: true,
    minimumViewport: Object.freeze({ width: 40, height: 15 }),
    create(context) {
      const nextSeed = options.seed ?? (() => Date.now());
      let state = createMinesweeper("beginner", nextSeed());
      let revision: number | null = null;
      let panel: Panel = context.storage === undefined ? "game" : "loading";
      let panelBeforeHelp: Exclude<Panel, "help"> = "game";
      let pendingPreset: MinesweeperPreset | undefined;
      let feedback = "First reveal: neighbors safe";
      let active = true;
      let focused = true;
      let inputEnabled = true;
      let canReset = false;
      let writeQueue = Promise.resolve();
      let timerStartedAt: number | undefined;
      let cancelTimer: (() => void) | undefined;
      let lastViewport: ActivityViewport | undefined;
      let lastBoard: BoardFrame | undefined;

      const invalidate = (): void => {
        if (active) context.invalidate();
      };
      const document = (): MinesweeperSaveDocument => updateMinesweeperSave(state);
      const persist = (): void => {
        const storage = context.storage;
        if (storage === undefined) return;
        const saved = document();
        writeQueue = writeQueue
          .then(async () => {
            const stored = await storage.write(
              revision,
              MINESWEEPER_STORAGE_SCHEMA_VERSION,
              minesweeperSaveJson(saved),
            );
            revision = stored.revision;
          })
          .catch((error: unknown) => {
            if (error instanceof ActivityStorageError && error.code === "aborted") return;
            feedback = error instanceof Error ? error.message : "Minesweeper save failed";
            invalidate();
          });
      };
      const timerShouldRun = (): boolean =>
        active && focused && inputEnabled && panel === "game" && state.status === "active";
      const stopTimer = (): void => {
        cancelTimer?.();
        cancelTimer = undefined;
        timerStartedAt = undefined;
      };
      const scheduleTimer = (): void => {
        if (!timerShouldRun() || cancelTimer !== undefined) return;
        timerStartedAt = context.now();
        const delay = Math.max(1, 1_000 - (state.elapsedMs % 1_000));
        cancelTimer = context.schedule(delay, (elapsed) => {
          cancelTimer = undefined;
          timerStartedAt = undefined;
          if (!timerShouldRun()) return;
          state = reduceMinesweeper(state, {
            type: "elapsed",
            elapsedMs: state.elapsedMs + Math.max(1, Math.floor(elapsed)),
          });
          persist();
          context.invalidate();
          scheduleTimer();
        });
      };
      const accrueTimer = (): void => {
        if (timerStartedAt === undefined || state.status !== "active") return;
        const now = context.now();
        const elapsed = Math.max(0, Math.floor(now - timerStartedAt));
        stopTimer();
        state = reduceMinesweeper(state, { type: "elapsed", elapsedMs: state.elapsedMs + elapsed });
        persist();
      };
      const suspendTimer = (): void => {
        if (active && focused) accrueTimer();
        else stopTimer();
      };
      const restart = (preset = state.preset): void => {
        stopTimer();
        lastBoard = undefined;
        state = createMinesweeper(preset, nextSeed());
        pendingPreset = undefined;
        panel = "game";
        feedback = "First reveal: neighbors safe";
        persist();
        context.invalidate();
      };
      const openPanel = (next: Panel): void => {
        suspendTimer();
        lastBoard = undefined;
        panel = next;
        context.invalidate();
      };
      const apply = (action: Parameters<typeof reduceMinesweeper>[1], message: string): boolean => {
        const previous = state;
        state = reduceMinesweeper(state, action);
        if (state === previous) return false;
        feedback = message;
        if (state.status === "won") feedback = "Board cleared";
        else if (state.status === "lost")
          feedback = `Mine exploded at ${coordinate(state, state.exploded)}`;
        persist();
        if (state.status === "active") scheduleTimer();
        else stopTimer();
        context.invalidate();
        return true;
      };
      const primaryAction = (): void => {
        if (state.status === "won" || state.status === "lost") {
          restart();
          return;
        }
        if (state.flagged[state.cursor]) {
          feedback = "Flagged cells stay closed · F removes the flag";
          context.invalidate();
          return;
        }
        if (state.revealed[state.cursor]) {
          if (!apply({ type: "chord" }, "Chord opened adjacent cells")) {
            feedback = chordFeedback(state);
            context.invalidate();
          }
          return;
        }
        const first = !state.minesPlaced;
        apply({ type: "reveal" }, first ? "Safe opening" : "Safe cell revealed");
      };
      const flagAction = (): void => {
        if (state.status === "won" || state.status === "lost") {
          feedback = "Game complete · Enter or R starts a new board";
          context.invalidate();
          return;
        }
        if (state.revealed[state.cursor]) {
          feedback = "Open cells cannot be flagged";
          context.invalidate();
          return;
        }
        const wasFlagged = state.flagged[state.cursor] as boolean;
        apply({ type: "flag" }, wasFlagged ? "Flag removed" : "Flag placed");
      };
      const chordAction = (): void => {
        if (!apply({ type: "chord" }, "Chord opened adjacent cells")) {
          feedback = chordFeedback(state);
          context.invalidate();
        }
      };
      const requestRestart = (): void => {
        if (hasProgress(state) && state.status !== "won" && state.status !== "lost")
          openPanel("restart");
        else restart();
      };
      const requestPreset = (preset: MinesweeperPreset): void => {
        if (preset === state.preset && !hasProgress(state)) {
          feedback = `${presetName(preset)} already selected`;
          context.invalidate();
        } else if (hasProgress(state) && state.status !== "won" && state.status !== "lost") {
          pendingPreset = preset;
          openPanel("preset");
        } else restart(preset);
      };
      const toggleHelp = (): void => {
        if (panel === "help") {
          panel = panelBeforeHelp;
          scheduleTimer();
        } else {
          panelBeforeHelp = panel;
          openPanel("help");
        }
        context.invalidate();
      };
      const runLocalAction = (action: LocalAction): void => {
        if (action === "primary") primaryAction();
        else if (action === "flag") flagAction();
        else if (action === "chord") chordAction();
        else if (action === "restart") requestRestart();
        else if (action === "help") toggleHelp();
        else requestPreset(action);
      };
      const handleMouse = (input: Extract<ActivityInput, { readonly type: "mouse" }>): void => {
        if (input.phase !== "press" || lastViewport === undefined) return;
        if (panel === "help") {
          if (input.button !== "left" || input.row !== HELP_CHOICE_ROW) return;
          const choice = choiceAt(["[? Back]", "[R New]"], lastViewport.width, input.column);
          if (choice === 0) toggleHelp();
          else if (choice === 1) requestRestart();
          return;
        }
        if (panel === "restart" || panel === "preset") {
          if (input.button !== "left" || input.row !== 2) return;
          const choice = choiceAt(
            ["[Y Replace]", "[N Continue]"],
            lastViewport.width,
            input.column,
          );
          if (choice === 0) restart(pendingPreset ?? state.preset);
          else if (choice === 1) {
            pendingPreset = undefined;
            panel = "game";
            scheduleTimer();
            context.invalidate();
          }
          return;
        }
        if (panel === "storage-error") {
          const choice = choiceAt(
            canReset ? ["[R Reset save]", "[Esc Close]"] : ["[Esc Close]"],
            lastViewport.width,
            input.column,
          );
          if (
            input.button === "left" &&
            input.row === 2 &&
            choice === 0 &&
            canReset &&
            revision !== null
          ) {
            void context.storage
              ?.reset(revision)
              .then(() => {
                revision = null;
                canReset = false;
                restart();
              })
              .catch((error: unknown) => {
                if (error instanceof ActivityStorageError && error.code === "aborted") return;
                feedback = error instanceof Error ? error.message : "Minesweeper reset failed";
                invalidate();
              });
          }
          return;
        }
        const board = lastBoard;
        if (panel !== "game" || board === undefined) return;
        const gameBoardRow = 4;
        const cellRow = input.row - gameBoardRow - board.cellRow;
        const cellOffset = input.column - board.cellColumn;
        if (
          cellRow >= 0 &&
          cellRow < board.visibleRows &&
          cellOffset >= 0 &&
          cellOffset < board.visibleColumns * board.pitch
        ) {
          const visibleColumn = Math.floor(cellOffset / board.pitch);
          const index =
            (board.originRow + cellRow) * state.width + board.originColumn + visibleColumn;
          apply({ type: "cursor", index }, `Cursor ${coordinate({ ...state, cursor: index })}`);
          if (input.button === "right") flagAction();
          else if (input.button === "middle") chordAction();
          else primaryAction();
          return;
        }
        const presetRow = gameBoardRow + board.lines.length;
        if (input.button === "left" && input.row === presetRow) {
          const action = actionAt(
            presetButtons(lastViewport.width),
            lastViewport.width,
            input.column,
          );
          if (action === "beginner" || action === "intermediate" || action === "expert")
            runLocalAction(action);
          return;
        }
        if (input.button === "left" && input.row === presetRow + 1) {
          const action = actionAt(
            actionButtons(state, lastViewport.width),
            lastViewport.width,
            input.column,
          );
          if (action !== undefined) runLocalAction(action);
        }
      };

      if (context.storage !== undefined) {
        writeQueue = context.storage
          .read(context.signal)
          .then((stored) => {
            if (stored !== undefined) {
              revision = stored.revision;
              if (stored.schemaVersion !== MINESWEEPER_STORAGE_SCHEMA_VERSION) {
                throw new MinesweeperSaveError(
                  stored.schemaVersion > MINESWEEPER_STORAGE_SCHEMA_VERSION
                    ? "future-version"
                    : "corrupt",
                  `Unsupported Minesweeper storage schema ${stored.schemaVersion}`,
                );
              }
              state = parseMinesweeperSave(stored.value).game;
              feedback =
                state.status === "ready" ? "First reveal: neighbors safe" : "Saved board restored";
            }
            panel = "game";
            if (stored === undefined) persist();
            scheduleTimer();
            invalidate();
          })
          .catch((error: unknown) => {
            if (error instanceof ActivityStorageError && error.code === "aborted") return;
            feedback = error instanceof Error ? error.message : "Minesweeper save cannot be read";
            canReset = revision !== null;
            panel = "storage-error";
            invalidate();
          });
      }

      return {
        render(viewport) {
          inputEnabled = viewport.width >= 40 && viewport.height >= 15;
          lastViewport = Object.freeze({ ...viewport });
          const textOnly = context.presentation().textOnly;
          lastBoard = panel === "game" ? renderBoard(state, viewport, textOnly) : undefined;
          return renderGame(
            viewport,
            state,
            panel,
            feedback,
            pendingPreset,
            canReset,
            textOnly,
            lastBoard,
          );
        },
        handleInput(input) {
          if (input.type === "focus") {
            if (!input.focused) suspendTimer();
            focused = input.focused;
            if (focused) scheduleTimer();
            return;
          }
          if (input.type === "mouse") {
            if (active && focused && inputEnabled && panel !== "loading") handleMouse(input);
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
            if (canReset && key === "r" && revision !== null) {
              void context.storage
                ?.reset(revision)
                .then(() => {
                  revision = null;
                  canReset = false;
                  restart();
                })
                .catch((error: unknown) => {
                  if (error instanceof ActivityStorageError && error.code === "aborted") return;
                  feedback = error instanceof Error ? error.message : "Minesweeper reset failed";
                  invalidate();
                });
            }
            return;
          }
          if (input.key === "?" && !input.ctrl && !input.alt) {
            toggleHelp();
            return;
          }
          if (panel === "help") return;
          if (panel === "restart" || panel === "preset") {
            if (!input.ctrl && !input.alt && key === "y") restart(pendingPreset ?? state.preset);
            else if (!input.ctrl && !input.alt && key === "n") {
              pendingPreset = undefined;
              panel = "game";
              scheduleTimer();
              context.invalidate();
            }
            return;
          }
          if (input.ctrl || input.alt) return;
          if ((state.status === "won" || state.status === "lost") && input.key === "enter") {
            primaryAction();
            return;
          }
          const selectedPreset = presetForKey(key);
          if (selectedPreset !== undefined) {
            requestPreset(selectedPreset);
            return;
          }
          if (key === "r") {
            requestRestart();
            return;
          }
          const move = direction(input);
          if (move !== undefined) {
            if (
              !apply(
                { type: "move", direction: move },
                `Cursor ${coordinate(reduceMinesweeper(state, { type: "move", direction: move }))}`,
              )
            ) {
              feedback = "Board edge";
              context.invalidate();
            }
            return;
          }
          if (key === "f") {
            flagAction();
            return;
          }
          if (key === "c") {
            chordAction();
            return;
          }
          if (input.key === "enter" || input.key === " ") primaryAction();
        },
        presentationChanged: () => {
          accrueTimer();
          scheduleTimer();
          context.invalidate();
        },
        pause: () => {
          active = false;
          focused = false;
          stopTimer();
        },
        resume: () => {
          active = true;
          focused = true;
          scheduleTimer();
        },
        serialize: () => minesweeperSaveJson(document()),
        dispose: () => {
          active = false;
          focused = false;
          stopTimer();
          return writeQueue;
        },
      };
    },
  };
}
