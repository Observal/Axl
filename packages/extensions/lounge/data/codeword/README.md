<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Codeword dictionary data

The Codeword dictionaries are transformed from the English Speller Database (ESDB, formerly SCOWLv2) release `rel-2026.02.25`, commit `7e99edab8e32f9f9ea2b15f249ca8d4d67237410`.

`provenance.json` records the upstream identity, retrieval time, transformation commands, review criteria, exclusions, decoded word counts, and decoded SHA-256 digests. The accepted guesses use the upstream size-80 American English list. The answers use the size-35 subset after additional answer-suitability review. Both lists exclude special categories and retain only five-letter lowercase ASCII words after deaccenting.

The canonical `.frontcoded` files store each sorted word as one decimal prefix-length digit from 0 through 4 followed by the suffix that differs from the previous word. Newlines split the encoded stream into fixed-width chunks for review and do not delimit records. A decoder reads one prefix digit and exactly `5 - prefix` suffix letters per record. This representation is deterministic, bounded, and directly reversible without a dependency. The generator reconstructs the original LF-terminated lists before checking the recorded counts and SHA-256 digests.

The dictionary data is licensed under `LicenseRef-ESDB`. See `LICENSES/LicenseRef-ESDB.txt` and `NOTICE`. The transformation script and this documentation are Apache-2.0 licensed.

To regenerate the compact runtime module after intentionally updating and reviewing the canonical data:

```bash
node packages/extensions/lounge/scripts/generate-codeword-dictionary.ts
```

The generator does not fetch data. It decodes and validates the checked-in canonical data, checks ordering and membership invariants, and emits bounded encoded chunks plus a small pure decoder in `src/codeword-dictionary.generated.ts`. Repository generated-file checks rerun it in check mode.
