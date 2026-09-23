<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Chess puzzle data

Axl Lounge ships a reviewed offline subset of 1,000 standard-chess puzzles from the official [Lichess puzzle database](https://database.lichess.org/#puzzles). Lichess publishes its database exports under CC0. The retained puzzle data and generated payload use `CC0-1.0`; the generator, tests, and this documentation use `Apache-2.0`.

The complete source archive is not committed. [`provenance.json`](provenance.json) pins its URL, reported update date, retrieval metadata, compressed byte size, SHA-256, transformation version, quality bounds, exact source IDs, and hashes for every retained artifact. The official CC0 1.0 legal text is stored at [`../../../../../LICENSES/CC0-1.0.txt`](../../../../../LICENSES/CC0-1.0.txt).

## Retained files

- `puzzles.csv` is the canonical readable subset. Each row keeps the source ID and FEN, opponent setup move, calculated playable FEN, exact remaining solution, rating metadata, sorted themes, review status, and inclusion reason.
- `review.csv` is the complete one-row-per-puzzle review manifest. It records legal replay, line shape, terminal-state, uniqueness, and quality-bound approval.
- `../../src/chess-puzzles.generated.ts` is the runtime payload. Do not edit it directly.

No player name, account data, game URL, opening tag, or daily-puzzle timestamp is retained.

## Selection contract

Revision `lichess-2026-09-10-axl-chess-v1` contains:

- 334 Easy puzzles rated 800 through 1399
- 333 Medium puzzles rated 1400 through 1999
- 333 Hard puzzles rated 2000 through 2600
- popularity of at least 95
- at least 1,000 recorded plays
- rating deviation of at most 80
- two through four player moves after the setup move
- no `mateIn1` puzzles
- at least 24 puzzles for every exposed theme at every difficulty

Selection first fills the reviewed theme floor, starting with the rarest eligible theme, then fills each difficulty by deterministic quality order. Quality order prefers popularity, number of plays, lower rating deviation, shorter lines, and byte-ordered source IDs. Every selected setup and solution move is replayed through Axl's legal Chess engine. Duplicate IDs and duplicate playable-position plus solution-line pairs are rejected.

The exposed themes are Fork, Pin, Skewer, Discovered attack, Deflection, Sacrifice, Promotion, Mate, and Advanced pawn tactics. Their short descriptions were written for Axl and are not copied from Lichess application source.

## Reproduction

Import requires an explicit local archive, its approved digest, and a `zstd` executable. The generator invokes `zstd` directly without a shell and streams bounded records. It performs no network access.

```bash
PATH=/path/containing/zstd:$PATH node packages/extensions/lounge/scripts/generate-chess-puzzles.ts \
  --import /absolute/path/lichess_db_puzzle.csv.zst \
  --expected-sha256 95fd454bec9efe8f940d5863d5db4c57474f281a865834997bd8cb5d6a149bb9
```

Normal generation reads only the checked-in canonical subset:

```bash
node packages/extensions/lounge/scripts/generate-chess-puzzles.ts
node packages/extensions/lounge/scripts/generate-chess-puzzles.ts --check
```

An update is a new reviewed data revision. Record the new immutable archive identity and license evidence, regenerate candidates, inspect the complete review manifest, verify all distributions and replays, and review the generated diff before replacing this revision.
