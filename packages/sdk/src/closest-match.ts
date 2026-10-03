// SPDX-FileCopyrightText: 2026 SHAURYA JAIN
// SPDX-License-Identifier: Apache-2.0

/**
 * Computes the optimal string alignment distance between two strings: the
 * minimum number of insertions, deletions, substitutions, or adjacent
 * transpositions needed to turn `a` into `b`.
 */
function levenshtein(a: string, b: string): number {
  let older: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, (older[j - 2] ?? 0) + 1);
      }
      row.push(d);
    }
    older = prev;
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/**
 * Returns the candidate closest to `input` by case-insensitive Levenshtein
 * distance, or `undefined` when none is within `maxDistance`. Inputs shorter
 * than 5 characters allow a distance of at most 1 so short typos do not match
 * unrelated names.
 */
export function closestMatch(
  input: string,
  candidates: readonly string[],
  maxDistance = 2,
): string | undefined {
  const needle = input.toLowerCase();
  const limit = needle.length < 5 ? Math.min(maxDistance, 1) : maxDistance;
  let best: string | undefined;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const hay = candidate.toLowerCase();
    if (Math.abs(needle.length - hay.length) > limit) continue;
    const dist = levenshtein(needle, hay);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return bestDist <= limit ? best : undefined;
}

/** Formats an "unknown <kind>" message with a did-you-mean hint when one is close. */
export function unknownNotice(
  kind: "command" | "theme",
  input: string,
  candidates: readonly string[],
): string {
  const suggestion = closestMatch(input, candidates);
  return suggestion === undefined
    ? `unknown ${kind} ${input}`
    : `unknown ${kind} ${input} · did you mean ${suggestion}?`;
}
