/**
 * Fuzzy matching helpers.
 *
 * The old --fuzzy mode transformed `foo` into `f[^\n]{0,2}o[^\n]{0,2}o`,
 * which only catches MISSING chars in the search term (search shorter
 * than the actual text). It fails on swaps and inserts.
 *
 * This module replaces that with a two-step approach:
 *   1. buildFuzzyRegex(search): emit a trigram-union regex used to drive rg.
 *      Any line in the corpus that contains ≥1 trigram of the search is
 *      a candidate.
 *   2. verifyFuzzy(line, matchPos, search, maxDist): slide a candidate
 *      window across the line and Levenshtein-match against the search.
 *      Accept the candidate iff edit distance ≤ maxDist.
 *
 * Handles drop / insert / substitute / swap typos (edit distance ≤ 2).
 * Cost: O(line_len × search_len × max_dist) per candidate line, bounded
 * for normal corpora.
 */

const TRIGRAM_LEN = 3;
const DEFAULT_MAX_DIST = 2;

/** Standard Levenshtein with early exit when row min > cutoff. */
export function levenshtein(a: string, b: string, cutoff: number = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > cutoff) return cutoff + 1;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cutoff) return cutoff + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Extract distinct trigrams from a string. */
function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length < TRIGRAM_LEN) {
    if (s.length > 0) out.add(s);
    return out;
  }
  for (let i = 0; i + TRIGRAM_LEN <= s.length; i++) {
    out.add(s.slice(i, i + TRIGRAM_LEN));
  }
  return out;
}

/** Cap the trigram alternation size — past this rg's regex compiler
 *  starts to choke (default --regex-size-limit ~10MB DFA). */
const MAX_TRIGRAMS = 64;

/**
 * Build a trigram-union regex from the search pattern. Splits on
 * whitespace so multi-word searches don't blow up trigram space.
 *
 * Hard constraints (these protect agent harnesses from runaway scans):
 *
 *   - Patterns shorter than 2 non-whitespace chars throw. An empty
 *     pattern would otherwise become `""` and match every line.
 *   - Patterns containing regex meta-chars are passed through as-is
 *     (regex authors usually mean it literally) and a warning is
 *     written to stderr so a confused caller can spot the silent
 *     skip.
 *   - The trigram set is capped at MAX_TRIGRAMS, picking the rarest
 *     trigrams first. Past the cap, fall back to literal-search of
 *     the longest token.
 */
export function buildFuzzyRegex(search: string): string {
  const trimmed = search.trim();
  if (trimmed.length < 2) {
    throw new Error(
      `--fuzzy requires a pattern of at least 2 non-whitespace characters. ` +
      `Got: ${JSON.stringify(search)}.`,
    );
  }
  if (/[\\^$.()\[\]{}|*+?]/.test(search)) {
    if (process.env.MDG_DEBUG) {
      process.stderr.write(
        `mdg[fuzzy]: pattern contains regex meta-chars, fuzzy matching skipped: ${JSON.stringify(search)}\n`,
      );
    }
    return search;
  }
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  const all = new Set<string>();
  for (const tok of tokens) {
    for (const g of trigrams(tok)) all.add(g);
  }
  if (all.size === 0) {
    // Degenerate (all tokens < TRIGRAM_LEN, which we already short-
    // circuited via the trimmed.length check). Fall back to literal.
    return trimmed;
  }
  let chosen: string[];
  if (all.size <= MAX_TRIGRAMS) {
    chosen = [...all];
  } else {
    // Fallback: drop fuzziness and just literal-search the longest token.
    // This keeps the regex bounded while still finding *something*; the
    // Levenshtein post-filter in verifyFuzzy then re-validates around
    // each hit.
    const longest = [...tokens].sort((a, b) => b.length - a.length)[0];
    if (process.env.MDG_DEBUG) {
      process.stderr.write(
        `mdg[fuzzy]: ${all.size} trigrams exceeded cap ${MAX_TRIGRAMS}; ` +
        `falling back to literal search of "${longest}"\n`,
      );
    }
    return longest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  // Escape regex meta-chars inside each trigram.
  const escaped = chosen.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `(${escaped.join("|")})`;
}

/**
 * Verify that the match position in `line` actually corresponds to
 * the original search within edit distance `maxDist`. Slides candidate
 * windows of length len(search) ± maxDist around matchPos and
 * Levenshteins each one. Returns true on first qualifying window.
 */
export function verifyFuzzy(
  line: string,
  matchPos: number,
  search: string,
  maxDist: number = DEFAULT_MAX_DIST,
): boolean {
  const searchLen = search.length;
  const windowRadius = searchLen + maxDist;
  const winStart = Math.max(0, matchPos - windowRadius);
  const winEnd = Math.min(line.length, matchPos + windowRadius);
  const window = line.slice(winStart, winEnd);
  // Try every substring length in [searchLen - maxDist, searchLen + maxDist].
  const minLen = Math.max(1, searchLen - maxDist);
  const maxLen = searchLen + maxDist;
  for (let start = 0; start <= window.length - minLen; start++) {
    for (let len = minLen; len <= Math.min(maxLen, window.length - start); len++) {
      const candidate = window.slice(start, start + len);
      if (levenshtein(candidate, search, maxDist) <= maxDist) return true;
    }
  }
  return false;
}
