// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { TerminalExtension } from "@axl/extension-api";

export interface LoungeExtensionOptions {
  readonly utcDate?: () => string;
  readonly practiceSeed?: () => number;
  readonly game2048Seed?: () => number;
  readonly minesweeperSeed?: () => number;
  readonly sudokuSeed?: () => number;
}

/** Creates a lightweight definition that loads Lounge data only after activation. */
export function createLoungeExtension(options: LoungeExtensionOptions = {}): TerminalExtension {
  return {
    manifest: {
      id: "axl.lounge",
      name: "Axl Lounge",
      capabilities: ["terminal.activities", "terminal.activity-storage"],
    },
    async activate(api) {
      const [
        { chessPuzzleActivity },
        { CHESS_PUZZLES, CHESS_PUZZLE_SET_REVISION, CHESS_PUZZLE_THEMES },
        { codewordActivity },
        { game2048Activity },
        { minesweeperActivity },
        { sudokuActivity },
      ] = await Promise.all([
        import("./chess-puzzle-activity.ts"),
        import("./chess-puzzles.generated.ts"),
        import("./codeword-activity.ts"),
        import("./game-2048-activity.ts"),
        import("./minesweeper-activity.ts"),
        import("./sudoku-activity.ts"),
      ]);
      let previousChessSeed = Date.now() - 1;
      const chessPracticeSeed =
        options.practiceSeed ??
        (() => {
          previousChessSeed = Math.max(Date.now(), previousChessSeed + 1);
          return previousChessSeed;
        });
      api.registerActivity(
        chessPuzzleActivity({
          catalog: Object.freeze({
            revision: CHESS_PUZZLE_SET_REVISION,
            puzzles: CHESS_PUZZLES,
          }),
          themes: CHESS_PUZZLE_THEMES,
          utcDate: options.utcDate ?? (() => new Date().toISOString().slice(0, 10)),
          practiceSeed: chessPracticeSeed,
        }),
      );
      api.registerActivity(codewordActivity(options));
      api.registerActivity(
        game2048Activity(options.game2048Seed === undefined ? {} : { seed: options.game2048Seed }),
      );
      api.registerActivity(
        minesweeperActivity(
          options.minesweeperSeed === undefined ? {} : { seed: options.minesweeperSeed },
        ),
      );
      api.registerActivity(
        sudokuActivity(options.sudokuSeed === undefined ? {} : { seed: options.sudokuSeed }),
      );
    },
  };
}

export const loungeExtension = createLoungeExtension();
