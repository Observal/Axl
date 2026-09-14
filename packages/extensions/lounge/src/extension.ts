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

/** Creates a lightweight definition that loads Codeword data only after activation. */
export function createLoungeExtension(options: LoungeExtensionOptions = {}): TerminalExtension {
  return {
    manifest: {
      id: "axl.lounge",
      name: "Axl Lounge",
      capabilities: ["terminal.activities", "terminal.activity-storage"],
    },
    async activate(api) {
      const [
        { codewordActivity },
        { game2048Activity },
        { minesweeperActivity },
        { sudokuActivity },
      ] = await Promise.all([
        import("./codeword-activity.ts"),
        import("./game-2048-activity.ts"),
        import("./minesweeper-activity.ts"),
        import("./sudoku-activity.ts"),
      ]);
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
