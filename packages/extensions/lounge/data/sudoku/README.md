<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sudoku fixture data

Axl's Sudoku puzzles are generated inside this repository. No external puzzle collection, application, website, or reference implementation supplies grids, clues, solutions, seeds, or difficulty labels.

`provenance.json` pins fixture-set, generator, solver, and difficulty algorithm versions. It also records reviewed seeds and SHA-256 digests for every generated puzzle and solution. The generator starts from a canonical valid 3×3 Sudoku pattern, applies deterministic seeded permutations, removes clues in deterministic order, and retains a removal only when an exact bounded solution counter proves uniqueness.

Difficulty is reproducible:

- Easy puzzles have 38–45 clues and solve with naked singles only.
- Medium puzzles have 32–39 clues, require a hidden single, and need no branch.
- Hard puzzles have 24–32 clues and require deterministic branching after singles are exhausted.

The generator, metadata, and generated fixture module are Apache-2.0 licensed. The fixtures are independently generated Axl assets.

To regenerate the reviewed TypeScript fixture module:

```bash
node packages/extensions/lounge/scripts/generate-sudoku-fixtures.ts
```

`pnpm check:generated` reruns the generator in check mode and compares its exact output. Updating a fixture requires reviewing the generated board, changing the fixture-set revision when puzzle bytes or algorithms change, and updating the pinned hashes in `provenance.json`.
