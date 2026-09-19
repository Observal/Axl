// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  applyChessMove,
  chessFen,
  chessStatus,
  parseChessFen,
  parseUciMove,
} from "../src/chess.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../../..");
const DATA_ROOT = resolve(PACKAGE_ROOT, "data/chess");
const PROVENANCE_PATH = resolve(DATA_ROOT, "provenance.json");
const PUZZLES_PATH = resolve(DATA_ROOT, "puzzles.csv");
const REVIEW_PATH = resolve(DATA_ROOT, "review.csv");
const TARGET_PATH = resolve(PACKAGE_ROOT, "src/chess-puzzles.generated.ts");
const CHECK_FLAG = `-${"-"}check`;
const IMPORT_FLAG = `-${"-"}import`;
const EXPECTED_SHA_FLAG = `-${"-"}expected-sha256`;
const MAX_ARCHIVE_BYTES = 1_000_000_000;
const MAX_LINE_LENGTH = 4_096;
const GENERAL_POOL_LIMIT = 2_500;
const THEME_POOL_LIMIT = 300;
const REQUIRED_HEADER = [
  "PuzzleId",
  "FEN",
  "Moves",
  "Rating",
  "RatingDeviation",
  "Popularity",
  "NbPlays",
  "Themes",
  "GameUrl",
  "OpeningTags",
  "DailyDate",
] as const;
const PUZZLE_HEADER = [
  "sourceId",
  "sourceFen",
  "setupMove",
  "playableFen",
  "solutionMoves",
  "rating",
  "difficulty",
  "popularity",
  "ratingDeviation",
  "numberOfPlays",
  "themes",
  "reviewStatus",
  "inclusionReason",
] as const;
const REVIEW_HEADER = [
  "sourceId",
  "difficulty",
  "primaryTheme",
  "reviewStatus",
  "legalSetup",
  "legalSolution",
  "lineEndsOnPlayerMove",
  "noPrematureTerminal",
  "uniquePositionAndLine",
  "qualityBounds",
  "inclusionReason",
] as const;
const DIFFICULTIES = ["easy", "medium", "hard"] as const;
const TARGET_COUNTS: Readonly<Record<Difficulty, number>> = Object.freeze({
  easy: 334,
  medium: 333,
  hard: 333,
});
const EXPOSED_THEMES = [
  "fork",
  "pin",
  "skewer",
  "discoveredAttack",
  "deflection",
  "sacrifice",
  "promotion",
  "mate",
  "advancedPawn",
] as const;
const THEME_LABELS: Readonly<Record<ExposedTheme, string>> = Object.freeze({
  fork: "Fork",
  pin: "Pin",
  skewer: "Skewer",
  discoveredAttack: "Discovered attack",
  deflection: "Deflection",
  sacrifice: "Sacrifice",
  promotion: "Promotion",
  mate: "Mate",
  advancedPawn: "Advanced pawn tactics",
});
const THEME_DESCRIPTIONS: Readonly<Record<ExposedTheme, string>> = Object.freeze({
  fork: "Attack two or more targets with one move.",
  pin: "Restrict a piece that shields something more valuable.",
  skewer: "Attack a valuable piece and capture what stands behind it.",
  discoveredAttack: "Move one piece to uncover an attack by another.",
  deflection: "Drive a defender away from its critical duty.",
  sacrifice: "Give up material to unlock a stronger tactical result.",
  promotion: "Turn an advanced pawn into a decisive new piece.",
  mate: "Force checkmate through a precise sequence.",
  advancedPawn: "Use a far-advanced pawn to create a tactical threat.",
});

type Difficulty = (typeof DIFFICULTIES)[number];
type ExposedTheme = (typeof EXPOSED_THEMES)[number];

interface FileRecord {
  readonly path: string;
  readonly count?: number;
  readonly sha256: string;
}

interface Provenance {
  readonly schemaVersion: number;
  readonly puzzleSetRevision: string;
  readonly transformationVersion: number;
  readonly selectionAlgorithmVersion: number;
  readonly upstream: {
    readonly name: string;
    readonly url: string;
    readonly reportedUpdateDate: string;
    readonly retrievedAt: string;
    readonly recordCount: number;
    readonly archiveBytes: number;
    readonly archiveSha256: string;
    readonly archiveLastModified: string;
    readonly archiveEtag: string;
  };
  readonly license: {
    readonly expression: string;
    readonly databaseEvidenceUrl: string;
    readonly legalCodeUrl: string;
    readonly evidenceRetrievedAt: string;
    readonly legalTextPath: string;
    readonly legalTextSha256: string;
  };
  readonly qualityBounds: {
    readonly minimumPopularity: number;
    readonly minimumPlays: number;
    readonly maximumRatingDeviation: number;
    readonly allowedSourcePlyCounts: readonly number[];
    readonly excludedThemes: readonly string[];
    readonly minimumThemePuzzlesPerDifficulty: number;
  };
  readonly difficultyBands: Readonly<Record<Difficulty, readonly [number, number]>>;
  readonly exposedThemes: Readonly<Record<ExposedTheme, string>>;
  readonly files: {
    readonly puzzles: FileRecord & { readonly count: number };
    readonly review: FileRecord & { readonly count: number };
    readonly generated: FileRecord & { readonly count: number };
  };
  readonly sourceIds: readonly string[];
}

interface SourceCandidate {
  readonly sourceId: string;
  readonly sourceFen: string;
  readonly moves: readonly string[];
  readonly rating: number;
  readonly difficulty: Difficulty;
  readonly popularity: number;
  readonly ratingDeviation: number;
  readonly numberOfPlays: number;
  readonly themes: readonly string[];
}

interface ReviewedPuzzle extends SourceCandidate {
  readonly setupMove: string;
  readonly playableFen: string;
  readonly solutionMoves: readonly string[];
  readonly primaryTheme: ExposedTheme;
  readonly reviewStatus: "approved";
  readonly inclusionReason: string;
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readProvenance(): Provenance {
  const text = readFileSync(PROVENANCE_PATH, "utf8");
  const value = JSON.parse(text) as Provenance;
  if (!text.endsWith("\n") || text.includes("\r"))
    throw new Error("Chess provenance must be LF-terminated JSON");
  if (
    value.schemaVersion !== 1 ||
    value.transformationVersion !== 1 ||
    value.selectionAlgorithmVersion !== 1 ||
    value.puzzleSetRevision !== "lichess-2026-09-10-axl-chess-v1"
  ) {
    throw new Error("Unsupported Chess puzzle provenance version");
  }
  return value;
}

function parseCsvLine(line: string): readonly string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] as string;
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === ",") {
      fields.push(field);
      field = "";
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV line contains an unterminated quoted field");
  fields.push(field);
  return fields;
}

function csvField(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvLine(values: readonly (string | number | boolean)[]): string {
  return `${values.map((value) => csvField(String(value))).join(",")}\n`;
}

function parseInteger(value: string, label: string): number {
  if (!/^(0|[1-9]\d*)$/u.test(value)) throw new Error(`${label} must be a non-negative integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the safe integer range`);
  return result;
}

function difficultyFor(rating: number, provenance: Provenance): Difficulty | undefined {
  return DIFFICULTIES.find((difficulty) => {
    const [minimum, maximum] = provenance.difficultyBands[difficulty];
    return rating >= minimum && rating <= maximum;
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareQuality(left: SourceCandidate, right: SourceCandidate): number {
  return (
    right.popularity - left.popularity ||
    right.numberOfPlays - left.numberOfPlays ||
    left.ratingDeviation - right.ratingDeviation ||
    left.moves.length - right.moves.length ||
    compareText(left.sourceId, right.sourceId)
  );
}

function retainBest(pool: SourceCandidate[], candidate: SourceCandidate, limit: number): void {
  pool.push(candidate);
  if (pool.length >= limit * 2) {
    pool.sort(compareQuality);
    pool.length = limit;
  }
}

function finishPool(pool: SourceCandidate[], limit: number): readonly SourceCandidate[] {
  return Object.freeze(pool.sort(compareQuality).slice(0, limit));
}

function sourceCandidate(
  fields: readonly string[],
  provenance: Provenance,
): SourceCandidate | undefined {
  if (fields.length !== REQUIRED_HEADER.length)
    throw new Error("Lichess row has an unexpected field count");
  const [
    sourceId,
    sourceFen,
    movesText,
    ratingText,
    deviationText,
    popularityText,
    playsText,
    themesText,
  ] = fields as readonly string[];
  if (!/^[A-Za-z0-9]{5}$/u.test(sourceId as string))
    throw new Error("Lichess puzzle ID is invalid");
  const rating = parseInteger(ratingText as string, "Puzzle rating");
  const difficulty = difficultyFor(rating, provenance);
  if (difficulty === undefined) return undefined;
  const ratingDeviation = parseInteger(deviationText as string, "Rating deviation");
  const popularity = Number(popularityText);
  const numberOfPlays = parseInteger(playsText as string, "Number of plays");
  if (!Number.isSafeInteger(popularity) || popularity < -100 || popularity > 100)
    throw new Error("Puzzle popularity is invalid");
  const moves = (movesText as string).split(" ");
  const themes = [...new Set((themesText as string).split(" ").filter(Boolean))].sort();
  const bounds = provenance.qualityBounds;
  if (
    popularity < bounds.minimumPopularity ||
    numberOfPlays < bounds.minimumPlays ||
    ratingDeviation > bounds.maximumRatingDeviation ||
    !bounds.allowedSourcePlyCounts.includes(moves.length) ||
    bounds.excludedThemes.some((theme) => themes.includes(theme)) ||
    !EXPOSED_THEMES.some((theme) => themes.includes(theme))
  ) {
    return undefined;
  }
  if (moves.some((move) => !/^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(move)))
    throw new Error(`Puzzle ${sourceId} contains an invalid UCI move`);
  return Object.freeze({
    sourceId: sourceId as string,
    sourceFen: sourceFen as string,
    moves: Object.freeze(moves),
    rating,
    difficulty,
    popularity,
    ratingDeviation,
    numberOfPlays,
    themes: Object.freeze(themes),
  });
}

async function readArchiveCandidates(
  archivePath: string,
  provenance: Provenance,
): Promise<readonly SourceCandidate[]> {
  const general = new Map<Difficulty, SourceCandidate[]>(DIFFICULTIES.map((value) => [value, []]));
  const themed = new Map<string, SourceCandidate[]>();
  for (const difficulty of DIFFICULTIES)
    for (const theme of EXPOSED_THEMES) themed.set(`${difficulty}:${theme}`, []);

  const child = spawn("zstd", ["-dc", "--", archivePath], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  const closed = new Promise<void>((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code, signal) => {
      if (code === 0) resolveClose();
      else rejectClose(new Error(`zstd failed (${String(code ?? signal)}): ${stderr.trim()}`));
    });
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.length === 0 || line.length > MAX_LINE_LENGTH)
        throw new Error(`Archive line ${lineNumber} has an invalid length`);
      const fields = parseCsvLine(line);
      if (lineNumber === 1) {
        if (
          fields.length !== REQUIRED_HEADER.length ||
          fields.some((field, index) => field !== REQUIRED_HEADER[index])
        )
          throw new Error("Lichess archive header does not match the documented schema");
        continue;
      }
      const candidate = sourceCandidate(fields, provenance);
      if (candidate === undefined) continue;
      retainBest(
        general.get(candidate.difficulty) as SourceCandidate[],
        candidate,
        GENERAL_POOL_LIMIT,
      );
      for (const theme of EXPOSED_THEMES) {
        if (candidate.themes.includes(theme))
          retainBest(
            themed.get(`${candidate.difficulty}:${theme}`) as SourceCandidate[],
            candidate,
            THEME_POOL_LIMIT,
          );
      }
    }
    await closed;
  } catch (error) {
    child.kill("SIGKILL");
    await closed.catch(() => undefined);
    throw error;
  }
  if (lineNumber - 1 !== provenance.upstream.recordCount)
    throw new Error(
      `Lichess archive contains ${lineNumber - 1} records instead of ${provenance.upstream.recordCount}`,
    );

  const merged = new Map<string, SourceCandidate>();
  for (const difficulty of DIFFICULTIES)
    for (const candidate of finishPool(
      general.get(difficulty) as SourceCandidate[],
      GENERAL_POOL_LIMIT,
    ))
      merged.set(candidate.sourceId, candidate);
  for (const difficulty of DIFFICULTIES)
    for (const theme of EXPOSED_THEMES)
      for (const candidate of finishPool(
        themed.get(`${difficulty}:${theme}`) as SourceCandidate[],
        THEME_POOL_LIMIT,
      ))
        merged.set(candidate.sourceId, candidate);
  return Object.freeze([...merged.values()]);
}

function reviewCandidate(candidate: SourceCandidate): ReviewedPuzzle {
  let position = parseChessFen(candidate.sourceFen);
  const [setupMove, ...solutionMoves] = candidate.moves;
  if (setupMove === undefined || solutionMoves.length === 0 || solutionMoves.length % 2 === 0)
    throw new Error(`Puzzle ${candidate.sourceId} does not end on a player move`);
  if (chessStatus(position) !== "active")
    throw new Error(`Puzzle ${candidate.sourceId} starts terminal`);
  position = applyChessMove(position, parseUciMove(setupMove));
  const playableFen = chessFen(position);
  for (const [index, move] of solutionMoves.entries()) {
    if (chessStatus(position) !== "active")
      throw new Error(
        `Puzzle ${candidate.sourceId} becomes terminal before solution ply ${index + 1}`,
      );
    position = applyChessMove(position, parseUciMove(move));
  }
  const primaryTheme = EXPOSED_THEMES.find((theme) => candidate.themes.includes(theme));
  if (primaryTheme === undefined)
    throw new Error(`Puzzle ${candidate.sourceId} has no exposed theme`);
  const inclusionReason = `Approved ${candidate.difficulty} ${THEME_LABELS[primaryTheme]} puzzle with popularity ${candidate.popularity}, ${candidate.numberOfPlays} plays, and rating deviation ${candidate.ratingDeviation}`;
  return Object.freeze({
    ...candidate,
    setupMove,
    playableFen,
    solutionMoves: Object.freeze(solutionMoves),
    primaryTheme,
    reviewStatus: "approved",
    inclusionReason,
  });
}

function selectReviewedPuzzles(
  candidates: readonly SourceCandidate[],
  provenance: Provenance,
): readonly ReviewedPuzzle[] {
  const reviewed = [...candidates].sort(compareQuality).map(reviewCandidate);
  const selected: ReviewedPuzzle[] = [];
  const selectedIds = new Set<string>();
  const positionLines = new Set<string>();
  const add = (candidate: ReviewedPuzzle): boolean => {
    if (selectedIds.has(candidate.sourceId)) return false;
    const key = `${candidate.playableFen}\n${candidate.solutionMoves.join(" ")}`;
    if (positionLines.has(key)) return false;
    selectedIds.add(candidate.sourceId);
    positionLines.add(key);
    selected.push(candidate);
    return true;
  };

  for (const difficulty of DIFFICULTIES) {
    const available = reviewed
      .filter((candidate) => candidate.difficulty === difficulty)
      .sort(compareQuality);
    const themeOrder = [...EXPOSED_THEMES].sort((left, right) => {
      const leftCount = available.filter((candidate) => candidate.themes.includes(left)).length;
      const rightCount = available.filter((candidate) => candidate.themes.includes(right)).length;
      return leftCount - rightCount || compareText(left, right);
    });
    for (const theme of themeOrder) {
      let count = selected.filter(
        (candidate) => candidate.difficulty === difficulty && candidate.themes.includes(theme),
      ).length;
      for (const candidate of available) {
        if (count >= provenance.qualityBounds.minimumThemePuzzlesPerDifficulty) break;
        if (candidate.themes.includes(theme) && add(candidate)) count += 1;
      }
      if (count < provenance.qualityBounds.minimumThemePuzzlesPerDifficulty)
        throw new Error(`${difficulty}/${theme} lacks enough reviewed candidates`);
    }
    for (const candidate of available) {
      const current = selected.filter((entry) => entry.difficulty === difficulty).length;
      if (current >= TARGET_COUNTS[difficulty]) break;
      add(candidate);
    }
    const finalCount = selected.filter((candidate) => candidate.difficulty === difficulty).length;
    if (finalCount !== TARGET_COUNTS[difficulty])
      throw new Error(
        `${difficulty} selected ${finalCount} puzzles instead of ${TARGET_COUNTS[difficulty]}`,
      );
  }
  return Object.freeze(selected.sort((left, right) => compareText(left.sourceId, right.sourceId)));
}

function puzzlesCsv(puzzles: readonly ReviewedPuzzle[]): string {
  let result = csvLine(PUZZLE_HEADER);
  for (const puzzle of puzzles) {
    result += csvLine([
      puzzle.sourceId,
      puzzle.sourceFen,
      puzzle.setupMove,
      puzzle.playableFen,
      puzzle.solutionMoves.join(" "),
      puzzle.rating,
      puzzle.difficulty,
      puzzle.popularity,
      puzzle.ratingDeviation,
      puzzle.numberOfPlays,
      puzzle.themes.join(" "),
      puzzle.reviewStatus,
      puzzle.inclusionReason,
    ]);
  }
  return result;
}

function reviewCsv(puzzles: readonly ReviewedPuzzle[]): string {
  let result = csvLine(REVIEW_HEADER);
  for (const puzzle of puzzles) {
    result += csvLine([
      puzzle.sourceId,
      puzzle.difficulty,
      puzzle.primaryTheme,
      puzzle.reviewStatus,
      true,
      true,
      true,
      true,
      true,
      true,
      puzzle.inclusionReason,
    ]);
  }
  return result;
}

function generatedSource(provenance: Provenance, puzzles: readonly ReviewedPuzzle[]): string {
  const themeType = EXPOSED_THEMES.map((theme) => `  | ${JSON.stringify(theme)}`).join("\n");
  const themes = EXPOSED_THEMES.map(
    (theme) =>
      `  Object.freeze({\n    id: ${JSON.stringify(theme)},\n    label: ${JSON.stringify(THEME_LABELS[theme])},\n    description: ${JSON.stringify(THEME_DESCRIPTIONS[theme])},\n  }),`,
  ).join("\n");
  const records = puzzles
    .map((puzzle) =>
      JSON.stringify([
        puzzle.sourceId,
        puzzle.sourceFen,
        puzzle.setupMove,
        puzzle.playableFen,
        puzzle.solutionMoves.join(" "),
        puzzle.rating,
        puzzle.difficulty,
        puzzle.popularity,
        puzzle.ratingDeviation,
        puzzle.numberOfPlays,
        puzzle.themes.join(" "),
      ]),
    )
    .join(",\n");
  return `// SPDX-FileCopyrightText: 2026 Lichess contributors\n// SPDX-License-Identifier: CC0-1.0\n// @generated by packages/extensions/lounge/scripts/generate-chess-puzzles.ts; do not edit.\n\nexport const CHESS_PUZZLE_SET_REVISION = ${JSON.stringify(provenance.puzzleSetRevision)} as const;\n\nexport type ChessPuzzleDifficulty = "easy" | "medium" | "hard";\nexport type ChessPuzzleThemeId =\n${themeType};\n\nexport interface ChessPuzzleTheme {\n  readonly id: ChessPuzzleThemeId;\n  readonly label: string;\n  readonly description: string;\n}\n\nexport const CHESS_PUZZLE_THEMES: readonly ChessPuzzleTheme[] = Object.freeze([\n${themes}\n]);\n\nexport interface ChessPuzzleRecord {\n  readonly id: string;\n  readonly sourceFen: string;\n  readonly setupMove: string;\n  readonly playableFen: string;\n  readonly solutionMoves: readonly string[];\n  readonly rating: number;\n  readonly difficulty: ChessPuzzleDifficulty;\n  readonly popularity: number;\n  readonly ratingDeviation: number;\n  readonly numberOfPlays: number;\n  readonly themes: readonly string[];\n}\n\ntype ChessPuzzleRow = readonly [\n  id: string,\n  sourceFen: string,\n  setupMove: string,\n  playableFen: string,\n  solutionMoves: string,\n  rating: number,\n  difficulty: ChessPuzzleDifficulty,\n  popularity: number,\n  ratingDeviation: number,\n  numberOfPlays: number,\n  themes: string,\n];\n\nconst CHESS_PUZZLE_ROWS: readonly ChessPuzzleRow[] = [\n${records}\n];\n\nexport const CHESS_PUZZLES: readonly ChessPuzzleRecord[] = Object.freeze(\n  CHESS_PUZZLE_ROWS.map(\n    ([id, sourceFen, setupMove, playableFen, solutionMoves, rating, difficulty, popularity, ratingDeviation, numberOfPlays, themes]) =>\n      Object.freeze({\n        id,\n        sourceFen,\n        setupMove,\n        playableFen,\n        solutionMoves: Object.freeze(solutionMoves.split(" ")),\n        rating,\n        difficulty,\n        popularity,\n        ratingDeviation,\n        numberOfPlays,\n        themes: Object.freeze(themes.split(" ")),\n      }),\n  ),\n);\n`;
}

function parseCanonicalPuzzles(text: string, provenance: Provenance): readonly ReviewedPuzzle[] {
  if (!text.endsWith("\n") || text.includes("\r"))
    throw new Error("Chess puzzles CSV must be LF-terminated");
  const lines = text.trimEnd().split("\n");
  const header = parseCsvLine(lines[0] as string);
  if (
    header.length !== PUZZLE_HEADER.length ||
    header.some((field, index) => field !== PUZZLE_HEADER[index])
  )
    throw new Error("Chess puzzles CSV header is invalid");
  const puzzles = lines.slice(1).map((line) => {
    const fields = parseCsvLine(line);
    if (fields.length !== PUZZLE_HEADER.length)
      throw new Error("Chess puzzle row has an invalid field count");
    const [
      sourceId,
      sourceFen,
      setupMove,
      playableFen,
      solutionText,
      rating,
      difficulty,
      popularity,
      deviation,
      plays,
      themesText,
      reviewStatus,
      inclusionReason,
    ] = fields as readonly string[];
    if (!DIFFICULTIES.includes(difficulty as Difficulty) || reviewStatus !== "approved")
      throw new Error(`Chess puzzle ${sourceId} has invalid review metadata`);
    const moves = [setupMove as string, ...(solutionText as string).split(" ")];
    const themes = (themesText as string).split(" ");
    const candidate: SourceCandidate = Object.freeze({
      sourceId: sourceId as string,
      sourceFen: sourceFen as string,
      moves: Object.freeze(moves),
      rating: parseInteger(rating as string, "Puzzle rating"),
      difficulty: difficulty as Difficulty,
      popularity: parseInteger(popularity as string, "Puzzle popularity"),
      ratingDeviation: parseInteger(deviation as string, "Rating deviation"),
      numberOfPlays: parseInteger(plays as string, "Number of plays"),
      themes: Object.freeze(themes),
    });
    const bounds = provenance.qualityBounds;
    if (
      !/^[A-Za-z0-9]{5}$/u.test(candidate.sourceId) ||
      difficultyFor(candidate.rating, provenance) !== candidate.difficulty ||
      candidate.popularity < bounds.minimumPopularity ||
      candidate.popularity > 100 ||
      candidate.ratingDeviation > bounds.maximumRatingDeviation ||
      candidate.numberOfPlays < bounds.minimumPlays ||
      !bounds.allowedSourcePlyCounts.includes(candidate.moves.length) ||
      bounds.excludedThemes.some((theme) => candidate.themes.includes(theme)) ||
      !EXPOSED_THEMES.some((theme) => candidate.themes.includes(theme)) ||
      candidate.moves.some((move) => !/^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(move)) ||
      themes.some((theme, themeIndex) => theme.length === 0 || theme === themes[themeIndex - 1]) ||
      themes.some(
        (theme, themeIndex) =>
          themeIndex > 0 && compareText(themes[themeIndex - 1] as string, theme) >= 0,
      )
    ) {
      throw new Error(`Chess puzzle ${candidate.sourceId} violates canonical quality bounds`);
    }
    const reviewed = reviewCandidate(candidate);
    if (reviewed.playableFen !== playableFen || reviewed.inclusionReason !== inclusionReason)
      throw new Error(`Chess puzzle ${sourceId} does not match its canonical derivation`);
    return reviewed;
  });
  validatePuzzleSet(puzzles, provenance);
  return Object.freeze(puzzles);
}

function validatePuzzleSet(puzzles: readonly ReviewedPuzzle[], provenance: Provenance): void {
  if (puzzles.length !== 1_000)
    throw new Error("Chess puzzle set must contain exactly 1,000 records");
  const ids = new Set<string>();
  const pairs = new Set<string>();
  for (const puzzle of puzzles) {
    if (ids.has(puzzle.sourceId)) throw new Error(`Duplicate Chess puzzle ID ${puzzle.sourceId}`);
    ids.add(puzzle.sourceId);
    const pair = `${puzzle.playableFen}\n${puzzle.solutionMoves.join(" ")}`;
    if (pairs.has(pair)) throw new Error(`Duplicate Chess position and line ${puzzle.sourceId}`);
    pairs.add(pair);
  }
  for (const difficulty of DIFFICULTIES) {
    const matching = puzzles.filter((puzzle) => puzzle.difficulty === difficulty);
    if (matching.length !== TARGET_COUNTS[difficulty])
      throw new Error(`Chess ${difficulty} distribution does not match`);
    for (const theme of EXPOSED_THEMES) {
      const count = matching.filter((puzzle) => puzzle.themes.includes(theme)).length;
      if (count < provenance.qualityBounds.minimumThemePuzzlesPerDifficulty)
        throw new Error(`Chess ${difficulty}/${theme} has only ${count} puzzles`);
    }
  }
}

function validateReview(text: string, puzzles: readonly ReviewedPuzzle[]): void {
  if (!text.endsWith("\n") || text.includes("\r"))
    throw new Error("Chess review CSV must be LF-terminated");
  const lines = text.trimEnd().split("\n");
  const header = parseCsvLine(lines[0] as string);
  if (
    header.length !== REVIEW_HEADER.length ||
    header.some((field, index) => field !== REVIEW_HEADER[index])
  )
    throw new Error("Chess review CSV header is invalid");
  if (lines.length !== puzzles.length + 1)
    throw new Error("Chess review manifest count does not match");
  for (const [index, puzzle] of puzzles.entries()) {
    const fields = parseCsvLine(lines[index + 1] as string);
    const expected = parseCsvLine(reviewCsv([puzzle]).trimEnd().split("\n")[1] as string);
    if (
      fields.length !== expected.length ||
      fields.some((field, fieldIndex) => field !== expected[fieldIndex])
    )
      throw new Error(`Chess review manifest differs for ${puzzle.sourceId}`);
  }
}

function verifiedOutputs(
  provenance: Provenance,
  verifyGeneratedHash = true,
): {
  readonly puzzles: readonly ReviewedPuzzle[];
  readonly generated: string;
} {
  if (
    provenance.files.puzzles.path !== "data/chess/puzzles.csv" ||
    provenance.files.review.path !== "data/chess/review.csv" ||
    provenance.files.generated.path !== "src/chess-puzzles.generated.ts"
  ) {
    throw new Error("Chess provenance contains an unexpected artifact path");
  }
  if (
    provenance.license.expression !== "CC0-1.0" ||
    provenance.license.databaseEvidenceUrl !== "https://database.lichess.org/#puzzles" ||
    provenance.license.legalCodeUrl !==
      "https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt"
  ) {
    throw new Error("Chess provenance license evidence is invalid");
  }
  const legalText = readFileSync(
    resolve(REPOSITORY_ROOT, provenance.license.legalTextPath),
    "utf8",
  );
  if (sha256(legalText) !== provenance.license.legalTextSha256)
    throw new Error("Chess CC0 legal text checksum mismatch");
  for (const theme of EXPOSED_THEMES)
    if (provenance.exposedThemes[theme] !== THEME_LABELS[theme])
      throw new Error(`Chess provenance theme metadata differs for ${theme}`);
  const puzzleText = readFileSync(PUZZLES_PATH, "utf8");
  const reviewText = readFileSync(REVIEW_PATH, "utf8");
  if (sha256(puzzleText) !== provenance.files.puzzles.sha256)
    throw new Error("Chess puzzles checksum mismatch");
  if (sha256(reviewText) !== provenance.files.review.sha256)
    throw new Error("Chess review checksum mismatch");
  const puzzles = parseCanonicalPuzzles(puzzleText, provenance);
  validateReview(reviewText, puzzles);
  if (
    puzzles.length !== provenance.files.puzzles.count ||
    puzzles.length !== provenance.files.review.count
  )
    throw new Error("Chess provenance file counts do not match");
  if (puzzles.map((puzzle) => puzzle.sourceId).join("\n") !== provenance.sourceIds.join("\n"))
    throw new Error("Chess provenance source IDs do not match canonical data");
  const generated = generatedSource(provenance, puzzles);
  if (
    (verifyGeneratedHash && sha256(generated) !== provenance.files.generated.sha256) ||
    puzzles.length !== provenance.files.generated.count
  )
    throw new Error("Chess generated payload does not match provenance");
  return { puzzles, generated };
}

async function importArchive(archivePath: string, expectedSha256: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256))
    throw new Error("Expected archive SHA-256 is invalid");
  const provenance = readProvenance();
  const archive = statSync(archivePath);
  if (!archive.isFile() || archive.size <= 0 || archive.size > MAX_ARCHIVE_BYTES)
    throw new Error("Puzzle archive size is invalid");
  if (archive.size !== provenance.upstream.archiveBytes)
    throw new Error("Puzzle archive byte size differs from provenance");
  if (expectedSha256 !== provenance.upstream.archiveSha256)
    throw new Error("Expected archive SHA-256 differs from provenance");
  const actualSha256 = await sha256File(archivePath);
  if (actualSha256 !== expectedSha256) throw new Error("Puzzle archive SHA-256 does not match");
  const candidates = await readArchiveCandidates(archivePath, provenance);
  const puzzles = selectReviewedPuzzles(candidates, provenance);
  validatePuzzleSet(puzzles, provenance);
  const puzzleText = puzzlesCsv(puzzles);
  const reviewText = reviewCsv(puzzles);
  const generated = generatedSource(provenance, puzzles);
  const updated: Provenance = {
    ...provenance,
    files: {
      puzzles: {
        path: "data/chess/puzzles.csv",
        count: puzzles.length,
        sha256: sha256(puzzleText),
      },
      review: { path: "data/chess/review.csv", count: puzzles.length, sha256: sha256(reviewText) },
      generated: {
        path: "src/chess-puzzles.generated.ts",
        count: puzzles.length,
        sha256: sha256(generated),
      },
    },
    sourceIds: puzzles.map((puzzle) => puzzle.sourceId),
  };
  writeFileSync(PUZZLES_PATH, puzzleText);
  writeFileSync(REVIEW_PATH, reviewText);
  writeFileSync(TARGET_PATH, generated);
  writeFileSync(PROVENANCE_PATH, canonicalJson(updated));
}

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const importPath = argumentValue(IMPORT_FLAG);
  if (importPath !== undefined) {
    const expectedSha256 = argumentValue(EXPECTED_SHA_FLAG);
    if (expectedSha256 === undefined)
      throw new Error(`${EXPECTED_SHA_FLAG} is required with ${IMPORT_FLAG}`);
    await importArchive(resolve(importPath), expectedSha256);
  } else {
    const provenance = readProvenance();
    const checking = process.argv.includes(CHECK_FLAG);
    const { generated } = verifiedOutputs(provenance, checking);
    if (checking) {
      const targetArgument = process.argv[process.argv.indexOf(CHECK_FLAG) + 1];
      const target = resolve(process.cwd(), targetArgument ?? TARGET_PATH);
      if (target !== TARGET_PATH)
        throw new Error(`No Chess puzzle output exists for ${relative(process.cwd(), target)}`);
      if (readFileSync(TARGET_PATH, "utf8") !== generated) process.exitCode = 1;
    } else {
      writeFileSync(TARGET_PATH, generated);
      writeFileSync(
        PROVENANCE_PATH,
        canonicalJson({
          ...provenance,
          files: {
            ...provenance.files,
            generated: {
              ...provenance.files.generated,
              sha256: sha256(generated),
            },
          },
        }),
      );
    }
  }
}
