/**
 * Small, dependency-free fuzzy matcher used to resolve spoken names
 * ("downloads", "visual studio code", "local disk d") against real folder,
 * window and UI element names. Speech-to-text output is imperfect, so exact
 * comparison is not enough, and a loose matcher would click the wrong thing.
 * Scores are therefore conservative and callers also check the margin between
 * the best and second-best candidate before acting.
 */

export function normalizeName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

export function editDistance(left: string, right: string): number {
  return levenshtein(left, right);
}

function ratio(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 1 : 1 - levenshtein(left, right) / longest;
}

function stem(token: string): string {
  return token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
}

/** Similarity between a spoken query and a candidate name, from 0 (unrelated) to 1 (identical). */
export function scoreMatch(query: string, candidate: string): number {
  const q = normalizeName(query);
  const c = normalizeName(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;

  const queryTokens = q.split(' ').map(stem);
  const candidateTokens = c.split(' ').map(stem);
  const queryCompact = queryTokens.join('');
  const candidateCompact = candidateTokens.join('');
  if (queryCompact === candidateCompact) return 0.98;

  let found = 0;
  for (const token of queryTokens) {
    let best = 0;
    for (const other of candidateTokens) {
      let value = ratio(token, other);
      if (token === other) value = 1;
      else if (token.length >= 3 && other.startsWith(token)) value = Math.max(value, 0.9);
      if (value > best) best = value;
    }
    found += best;
  }
  const recall = found / queryTokens.length;
  const explained = candidateTokens.filter((other) => queryTokens.some((token) => token === other || ratio(token, other) >= 0.8)).length / candidateTokens.length;
  const tokenScore = recall * (0.75 + 0.25 * explained);
  const compactScore = ratio(queryCompact, candidateCompact) * 0.95;
  return Math.max(tokenScore, compactScore);
}

export interface Ranked<T> {
  item: T;
  score: number;
}

export function rankMatches<T>(query: string, items: readonly T[], getName: (item: T) => string, minimumScore = 0.6): Ranked<T>[] {
  const ranked: Ranked<T>[] = [];
  for (const item of items) {
    const score = scoreMatch(query, getName(item));
    if (score >= minimumScore) ranked.push({ item, score });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

export interface Pick<T> {
  best?: Ranked<T>;
  /** Another candidate scored close enough that picking the best one would be a guess. */
  ambiguous: boolean;
  runnerUp?: Ranked<T>;
}

export function pickConfident<T>(ranked: readonly Ranked<T>[], options: { minimum?: number; margin?: number } = {}): Pick<T> {
  const minimum = options.minimum ?? 0.8;
  const margin = options.margin ?? 0.06;
  const best = ranked[0];
  if (!best || best.score < minimum) return { ambiguous: false };
  const runnerUp = ranked[1];
  const ambiguous = Boolean(runnerUp && runnerUp.score >= minimum && best.score - runnerUp.score < margin && best.score < 0.995);
  return { best, ambiguous, ...(runnerUp ? { runnerUp } : {}) };
}
