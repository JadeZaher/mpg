/**
 * Token estimation.
 *
 * We use a simple chars/4 heuristic as the default. It's an approximation:
 * - English prose averages ~4 chars/token
 * - Code averages ~3.5 chars/token (more symbols)
 * - JSON averages ~3 chars/token
 *
 * This is intentionally dependency-free. For higher fidelity, callers
 * can plug in tiktoken or gpt-tokenizer at the integration boundary.
 *
 * The heuristic is good enough to make *budgeting* decisions (sizing
 * context windows, capping output) which is what mdg is for. It's not
 * a substitute for a real tokenizer when billing accuracy matters.
 */

const DEFAULT_CHARS_PER_TOKEN = 4;

export interface TokenModel {
  /** Estimate tokens for a single string. */
  estimate(text: string): number;
  /** Estimate tokens across an array of strings (slightly faster, no array alloc). */
  estimateMany(texts: string[]): number;
}

class HeuristicTokenModel implements TokenModel {
  constructor(private charsPerToken: number = DEFAULT_CHARS_PER_TOKEN) {}

  estimate(text: string): number {
    if (!text) return 0;
    // Round up so empty/single-char strings get 1 token, not 0.
    return Math.max(1, Math.ceil(text.length / this.charsPerToken));
  }

  estimateMany(texts: string[]): number {
    let total = 0;
    for (const t of texts) total += this.estimate(t);
    return total;
  }
}

export const defaultTokens: TokenModel = new HeuristicTokenModel();

/**
 * Trim a list of lines to fit within a token budget, preferring the
 * lines closest to a target index.
 *
 * This is the workhorse used to build the pre/post context windows of
 * a node. It walks outward from the match line, accumulating lines
 * until the budget is exhausted, then returns the kept lines in
 * original order.
 */
export function trimLinesToBudget(
  lines: string[],
  targetIndex: number,
  budget: number,
  model: TokenModel = defaultTokens,
): { kept: string[]; spent: number } {
  if (budget <= 0 || lines.length === 0) {
    return { kept: [], spent: 0 };
  }

  // Greedy outward expansion: keep a window of lines around targetIndex
  // that fits in `budget` tokens.
  const kept = new Array<string | null>(lines.length).fill(null);
  kept[targetIndex] = lines[targetIndex];
  let spent = model.estimate(lines[targetIndex]);

  let lo = targetIndex - 1;
  let hi = targetIndex + 1;

  // Alternate between expanding above and below, preferring whichever
  // side has more remaining lines. This produces a balanced window.
  while (lo >= 0 || hi < lines.length) {
    const canLo = lo >= 0;
    const canHi = hi < lines.length;

    if (!canLo && !canHi) break;

    // Prefer the side with more remaining lines (balanced growth).
    const takeLo =
      canLo && (!canHi || (targetIndex - lo) <= (hi - targetIndex));

    if (takeLo) {
      const cost = model.estimate(lines[lo]);
      if (spent + cost > budget) {
        lo = -1; // stop expanding up
      } else {
        kept[lo] = lines[lo];
        spent += cost;
        lo--;
      }
    } else {
      const cost = model.estimate(lines[hi]);
      if (spent + cost > budget) {
        hi = lines.length; // stop expanding down
      } else {
        kept[hi] = lines[hi];
        spent += cost;
        hi++;
      }
    }
  }

  const result: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    if (kept[i] !== null) result.push(kept[i] as string);
  }
  return { kept: result, spent };
}
