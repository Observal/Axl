// SPDX-FileCopyrightText: 2026 SHAURYA JAIN
// SPDX-License-Identifier: Apache-2.0

/**
 * Computes the Levenshtein edit distance between two strings.
 * Returns the minimum number of single-character insertions, deletions,
 * or substitutions required to transform `a` into `b`.
 */
function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/**
 * Returns the closest candidate to `input` by Levenshtein edit distance,
 * provided the distance is within `maxDistance`. Candidates whose length
 * difference alone exceeds `maxDistance` are skipped without allocating a
 * matrix. Returns `undefined` when no candidate is close enough or the
 * candidate list is empty.
 */
export function closestMatch(
  input: string,
  candidates: readonly string[],
  maxDistance = 2,
): string | undefined {
  if (candidates.length === 0) return undefined;
  let best: string | undefined;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    if (Math.abs(input.length - candidate.length) > maxDistance) continue;
    const dist = levenshtein(input, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return bestDist <= maxDistance ? best : undefined;
}
