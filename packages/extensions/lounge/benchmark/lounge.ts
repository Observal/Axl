// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  type ActivityContext,
  type ActivityHostServices,
  type ActivityInput,
  TerminalExtensionHost,
} from "@axl/extension-api";

import { chessPuzzleActivity } from "../src/chess-puzzle-activity.ts";
import {
  CHESS_PUZZLES,
  CHESS_PUZZLE_SET_REVISION,
  CHESS_PUZZLE_THEMES,
} from "../src/chess-puzzles.generated.ts";
import { codewordActivity } from "../src/codeword-activity.ts";
import { createLoungeExtension } from "../src/extension.ts";
import { game2048Activity } from "../src/game-2048-activity.ts";
import { minesweeperActivity } from "../src/minesweeper-activity.ts";
import { sudokuActivity } from "../src/sudoku-activity.ts";

const WIDTHS = [40, 80, 120] as const;
const RENDER_SAMPLES = 1_000;
const INPUT_SAMPLES = 10_000;
const CLEANUP_CYCLES = 1_000;
const CLEANUP_WARMUP_CYCLES = 1_000;
const DISABLED_SAMPLES = 30;

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * quantile) - 1);
  return ordered[Math.min(index, ordered.length - 1)] ?? 0;
}

function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

function key(value: string): ActivityInput {
  return {
    type: "key",
    key: value,
    ctrl: false,
    alt: false,
    shift: false,
    repeat: false,
  };
}

function directContext(): ActivityContext {
  return {
    signal: new AbortController().signal,
    now: () => performance.now(),
    status: () => ({
      operation: "working",
      elapsedMs: 42_000,
      activeToolCount: 1,
      queuedInput: { steer: 0, followUp: 1, interrupt: 0 },
    }),
    presentation: () => ({ reducedMotion: true, textOnly: false }),
    invalidate: () => undefined,
    schedule: () => () => undefined,
  };
}

const activity = codewordActivity({
  selection: { kind: "practice", algorithmVersion: 1, seed: 6699 },
});
const renderResults = WIDTHS.map((width) => {
  const instance = activity.create(directContext());
  const height = width === 40 ? 15 : 22;
  instance.render({ width, height });
  const samples: number[] = [];
  for (let index = 0; index < RENDER_SAMPLES; index += 1) {
    const started = performance.now();
    instance.render({ width, height });
    samples.push(performance.now() - started);
  }
  return { width, p95Ms: percentile(samples, 0.95) };
});

const inputInstance = activity.create(directContext());
inputInstance.render({ width: 80, height: 22 });
const inputSamples: number[] = [];
for (let index = 0; index < INPUT_SAMPLES; index += 1) {
  const started = performance.now();
  inputInstance.handleInput(key(index % 2 === 0 ? "a" : "backspace"));
  inputSamples.push(performance.now() - started);
}
const inputP95Ms = percentile(inputSamples, 0.95);
const activeStateBytes = Buffer.byteLength(JSON.stringify(inputInstance.serialize()));
await inputInstance.dispose();

const activity2048 = game2048Activity({ seed: () => 42 });
const render2048Results = WIDTHS.map((width) => {
  const instance = activity2048.create(directContext());
  const height = width === 40 ? 15 : 24;
  instance.render({ width, height });
  const samples: number[] = [];
  for (let index = 0; index < RENDER_SAMPLES; index += 1) {
    const started = performance.now();
    instance.render({ width, height });
    samples.push(performance.now() - started);
  }
  return { width, p95Ms: percentile(samples, 0.95) };
});
const input2048Instance = activity2048.create(directContext());
input2048Instance.render({ width: 80, height: 24 });
const input2048Samples: number[] = [];
const movementKeys = ["left", "up", "right", "down"] as const;
for (let index = 0; index < INPUT_SAMPLES; index += 1) {
  const started = performance.now();
  input2048Instance.handleInput(key(movementKeys[index % movementKeys.length] as string));
  input2048Samples.push(performance.now() - started);
}
const input2048P95Ms = percentile(input2048Samples, 0.95);
const active2048StateBytes = Buffer.byteLength(JSON.stringify(input2048Instance.serialize()));
await input2048Instance.dispose();

const activityMinesweeper = minesweeperActivity({ seed: () => 42 });
const renderMinesweeperResults = WIDTHS.map((width) => {
  const instance = activityMinesweeper.create(directContext());
  const height = width === 40 ? 15 : 24;
  instance.render({ width, height });
  const samples: number[] = [];
  for (let index = 0; index < RENDER_SAMPLES; index += 1) {
    const started = performance.now();
    instance.render({ width, height });
    samples.push(performance.now() - started);
  }
  return { width, p95Ms: percentile(samples, 0.95) };
});
const inputMinesweeperInstance = activityMinesweeper.create(directContext());
inputMinesweeperInstance.render({ width: 80, height: 24 });
const inputMinesweeperSamples: number[] = [];
const minesweeperKeys = ["right", "down", "left", "up", "f", " "] as const;
for (let index = 0; index < INPUT_SAMPLES; index += 1) {
  const started = performance.now();
  inputMinesweeperInstance.handleInput(
    key(minesweeperKeys[index % minesweeperKeys.length] as string),
  );
  inputMinesweeperSamples.push(performance.now() - started);
}
const inputMinesweeperP95Ms = percentile(inputMinesweeperSamples, 0.95);
const activeMinesweeperStateBytes = Buffer.byteLength(
  JSON.stringify(inputMinesweeperInstance.serialize()),
);
await inputMinesweeperInstance.dispose();

const activitySudoku = sudokuActivity({ seed: () => 42 });
const renderSudokuResults = WIDTHS.map((width) => {
  const instance = activitySudoku.create(directContext());
  const height = width === 40 ? 18 : 24;
  instance.render({ width, height });
  const samples: number[] = [];
  for (let index = 0; index < RENDER_SAMPLES; index += 1) {
    const started = performance.now();
    instance.render({ width, height });
    samples.push(performance.now() - started);
  }
  return { width, p95Ms: percentile(samples, 0.95) };
});
const inputSudokuInstance = activitySudoku.create(directContext());
inputSudokuInstance.render({ width: 80, height: 24 });
const inputSudokuSamples: number[] = [];
const sudokuKeys = ["right", "down", "left", "up", "n", "4", "n", "backspace"] as const;
for (let index = 0; index < INPUT_SAMPLES; index += 1) {
  const started = performance.now();
  inputSudokuInstance.handleInput(key(sudokuKeys[index % sudokuKeys.length] as string));
  inputSudokuSamples.push(performance.now() - started);
}
const inputSudokuP95Ms = percentile(inputSudokuSamples, 0.95);
const activeSudokuStateBytes = Buffer.byteLength(JSON.stringify(inputSudokuInstance.serialize()));
await inputSudokuInstance.dispose();

const activityChess = chessPuzzleActivity({
  catalog: Object.freeze({ revision: CHESS_PUZZLE_SET_REVISION, puzzles: CHESS_PUZZLES }),
  themes: CHESS_PUZZLE_THEMES,
  utcDate: () => "2026-09-12",
  practiceSeed: () => 42,
});
const renderChessResults = WIDTHS.map((width) => {
  const instance = activityChess.create(directContext());
  const viewport =
    width === 40
      ? { width: 40, height: 22 }
      : width === 80
        ? { width: 80, height: 22 }
        : { width: 54, height: 28 };
  instance.render(viewport);
  const samples: number[] = [];
  for (let index = 0; index < RENDER_SAMPLES; index += 1) {
    const started = performance.now();
    instance.render(viewport);
    samples.push(performance.now() - started);
  }
  return { width, activityWidth: viewport.width, p95Ms: percentile(samples, 0.95) };
});
const inputChessInstance = activityChess.create(directContext());
inputChessInstance.render({ width: 54, height: 28 });
const inputChessSamples: number[] = [];
const chessKeys = ["left", "up", "right", "down", "h", "j", "k", "l"] as const;
for (let index = 0; index < INPUT_SAMPLES; index += 1) {
  const started = performance.now();
  inputChessInstance.handleInput(key(chessKeys[index % chessKeys.length] as string));
  inputChessSamples.push(performance.now() - started);
}
const inputChessP95Ms = percentile(inputChessSamples, 0.95);
const activeChessStateBytes = Buffer.byteLength(JSON.stringify(inputChessInstance.serialize()));
await inputChessInstance.dispose();

const hostServices: ActivityHostServices = {
  now: () => performance.now(),
  schedule: () => () => undefined,
  invalidate: () => undefined,
  status: () => ({
    operation: "idle",
    activeToolCount: 0,
    queuedInput: { steer: 0, followUp: 0, interrupt: 0 },
  }),
  presentation: () => ({ reducedMotion: true, textOnly: false }),
  storage: {
    read: () => Promise.resolve(undefined),
    write: (_scope, expectedRevision, schemaVersion, value) =>
      Promise.resolve({ revision: (expectedRevision ?? 0) + 1, schemaVersion, value }),
    reset: () => Promise.resolve(),
  },
};
const cleanupHost = new TerminalExtensionHost([createLoungeExtension()]);
await cleanupHost.activate();
for (let index = 0; index < CLEANUP_WARMUP_CYCLES; index += 1) {
  await cleanupHost.createActivity("axl.lounge.codeword", hostServices).dispose();
  await cleanupHost.createActivity("axl.lounge.2048", hostServices).dispose();
  await cleanupHost.createActivity("axl.lounge.minesweeper", hostServices).dispose();
  await cleanupHost.createActivity("axl.lounge.sudoku", hostServices).dispose();
  await cleanupHost.createActivity("axl.lounge.chess-puzzles", hostServices).dispose();
}
globalThis.gc?.();
const heapBaselineBytes = process.memoryUsage().heapUsed;
const cleanupStarted = performance.now();
for (let index = 0; index < CLEANUP_CYCLES; index += 1) {
  for (const activityId of [
    "axl.lounge.codeword",
    "axl.lounge.2048",
    "axl.lounge.minesweeper",
    "axl.lounge.sudoku",
    "axl.lounge.chess-puzzles",
  ] as const) {
    const instance = cleanupHost.createActivity(activityId, hostServices);
    instance.pause(instance.epoch, "hidden");
    instance.resume(instance.epoch);
    await instance.dispose();
  }
}
const cleanupMs = performance.now() - cleanupStarted;
globalThis.gc?.();
const retainedHeapBytes = Math.max(0, process.memoryUsage().heapUsed - heapBaselineBytes);
await cleanupHost.dispose();

const enabledDefinition = createLoungeExtension();
const emptySamples: number[] = [];
const disabledSamples: number[] = [];
for (let index = 0; index < DISABLED_SAMPLES; index += 1) {
  let started = performance.now();
  const empty = new TerminalExtensionHost();
  await empty.activate();
  await empty.dispose();
  emptySamples.push(performance.now() - started);

  started = performance.now();
  const disabled = new TerminalExtensionHost([enabledDefinition], {
    initiallyInactiveExtensionIds: [enabledDefinition.manifest.id],
  });
  await disabled.activate();
  await disabled.dispose();
  disabledSamples.push(performance.now() - started);
}
const disabledHostBaselineMedianMs = median(emptySamples);
const disabledHostMedianMs = median(disabledSamples);
const disabledHostRegressionMs = disabledHostMedianMs - disabledHostBaselineMedianMs;

const cliDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../cli");
const cliBaselineSamples: number[] = [];
const cliDisabledSamples: number[] = [];
const measureImport = (source: string): number => {
  const started = performance.now();
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: cliDirectory,
    encoding: "utf8",
  });
  if (child.status !== 0) {
    throw new Error(
      `Startup sample failed: ${child.stderr.trim() || `exit ${String(child.status)}`}`,
    );
  }
  return performance.now() - started;
};
for (let index = 0; index < DISABLED_SAMPLES; index += 1) {
  cliBaselineSamples.push(measureImport('await import("@axl/extension-api")'));
  cliDisabledSamples.push(
    measureImport(
      'await Promise.all([import("@axl/extension-api"), import("@axl/extension-lounge/terminal")])',
    ),
  );
}
const cliBaselineMedianMs = median(cliBaselineSamples);
const cliDisabledMedianMs = median(cliDisabledSamples);
const cliDisabledRegressionMs = cliDisabledMedianMs - cliBaselineMedianMs;
const disabledBudgetMs = Math.max(5, cliBaselineMedianMs * 0.02);

const result = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  fixture: {
    widths: WIDTHS,
    renderSamples: RENDER_SAMPLES,
    inputSamples: INPUT_SAMPLES,
    cleanupCycles: CLEANUP_CYCLES,
    cleanupWarmupCycles: CLEANUP_WARMUP_CYCLES,
    disabledSamples: DISABLED_SAMPLES,
    forcedGc: globalThis.gc !== undefined,
  },
  budgets: {
    renderP95Ms: 8,
    inputP95Ms: 4,
    retainedHeapBytes: 1024 * 1024,
    activeStateBytes: 1024 * 1024,
    disabledRegressionMs: disabledBudgetMs,
  },
  results: {
    render: renderResults,
    inputP95Ms,
    activeStateBytes,
    game2048: {
      render: render2048Results,
      inputP95Ms: input2048P95Ms,
      activeStateBytes: active2048StateBytes,
    },
    minesweeper: {
      render: renderMinesweeperResults,
      inputP95Ms: inputMinesweeperP95Ms,
      activeStateBytes: activeMinesweeperStateBytes,
    },
    sudoku: {
      render: renderSudokuResults,
      inputP95Ms: inputSudokuP95Ms,
      activeStateBytes: activeSudokuStateBytes,
    },
    chess: {
      render: renderChessResults,
      inputP95Ms: inputChessP95Ms,
      activeStateBytes: activeChessStateBytes,
    },
    cleanupMs,
    retainedHeapBytes,
    disabledHostBaselineMedianMs,
    disabledHostMedianMs,
    disabledHostRegressionMs,
    cliBaselineMedianMs,
    cliDisabledMedianMs,
    cliDisabledRegressionMs,
  },
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (
  renderResults.some(({ p95Ms }) => p95Ms >= 8) ||
  render2048Results.some(({ p95Ms }) => p95Ms >= 8) ||
  renderMinesweeperResults.some(({ p95Ms }) => p95Ms >= 8) ||
  renderSudokuResults.some(({ p95Ms }) => p95Ms >= 8) ||
  renderChessResults.some(({ p95Ms }) => p95Ms >= 8) ||
  inputP95Ms >= 4 ||
  input2048P95Ms >= 4 ||
  inputMinesweeperP95Ms >= 4 ||
  inputSudokuP95Ms >= 4 ||
  inputChessP95Ms >= 4 ||
  retainedHeapBytes >= 1024 * 1024 ||
  activeStateBytes >= 1024 * 1024 ||
  active2048StateBytes >= 1024 * 1024 ||
  activeMinesweeperStateBytes >= 1024 * 1024 ||
  activeSudokuStateBytes >= 1024 * 1024 ||
  activeChessStateBytes >= 1024 * 1024 ||
  cliDisabledRegressionMs >= disabledBudgetMs
) {
  throw new Error("Lounge performance benchmark exceeded its deterministic budget");
}
