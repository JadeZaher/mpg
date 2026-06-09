/**
 * Node construction.
 *
 * Given a match and the full content of its source, build a "node":
 * the matched line plus a pre/post context window sized in tokens.
 *
 * The pre/post windows are built greedily outward from the match line,
 * so they fit exactly within the budget. This is what makes mpg
 * different from `rg -C N`: we budget in *tokens*, not lines.
 */

import { readFileSync } from "node:fs";
import { defaultTokens, type TokenModel } from "./tokens.js";
import type { Match, Node, Source } from "./types.js";

export interface BuildNodeOptions {
  beforeTokens: number;
  afterTokens: number;
  tokens?: TokenModel;
  /**
   * Optional sub-line clip mode. When set, the node's match_text is
   * trimmed to `line.slice(match_start - clipChars, match_end + clipChars)`
   * (with ellipsis markers if anything was dropped). Pre/post context
   * lines are also dropped entirely — clip mode means "just this
   * snippet, nothing else." Use for the cheapest possible recall
   * when you only need to disambiguate the match itself.
   */
  clipChars?: number;
}

/** Load the full content of a source. */
export function loadSourceContent(source: Source, content: string | null): string {
  if (content !== null) return content;
  if (source.type === "file") {
    return readFileSync(source.id, "utf8");
  }
  throw new Error(`Cannot load content for source type: ${source.type}`);
}

/**
 * Build a single context node from a match.
 *
 * If the source has fewer lines than the budget would allow, the node
 * is just the available lines. If the match line is near the start
 * or end of the file, the window is one-sided.
 */
export function buildNode(
  match: Match,
  content: string,
  options: BuildNodeOptions,
): Node {
  const model = options.tokens ?? defaultTokens;

  // Sub-line clip mode: skip line-context entirely; clip the match line
  // itself to a small window around the matched span. Cheapest possible
  // node — used when the agent just needs to disambiguate matches, not
  // read surrounding code.
  if (typeof options.clipChars === "number" && options.clipChars >= 0) {
    const N = options.clipChars;
    const startChar = Math.max(0, match.match_start - N);
    const endChar = Math.min(match.text.length, match.match_end + N);
    const head = startChar > 0 ? "…" : "";
    const tail = endChar < match.text.length ? "…" : "";
    const clipped = head + match.text.slice(startChar, endChar) + tail;
    // Re-anchor the match span to the clipped string.
    const newStart = head.length + (match.match_start - startChar);
    const newEnd = newStart + (match.match_end - match.match_start);
    return {
      id: 0,
      source: match.source,
      match_line: match.line,
      start_line: match.line,
      end_line: match.line,
      context_before: [],
      match_text: clipped,
      context_after: [],
      match_spans: [[newStart, newEnd]],
      tokens: model.estimate(clipped),
    };
  }

  const allLines = content.split("\n");

  // Convert 1-indexed match line to 0-indexed array index.
  const matchIndex = Math.max(0, Math.min(allLines.length - 1, match.line - 1));

  // Pre-context: lines before the match. We pass them in reverse so
  // that the line nearest the match is at index 0 of `lines`.
  const beforeLines = allLines.slice(0, matchIndex);
  const beforeTrim = trimAnchoredAtStart(beforeLines, options.beforeTokens, model);

  // Post-context: lines after the match. The line nearest the match
  // is at index 0.
  const afterLines = allLines.slice(matchIndex + 1);
  const afterTrim = trimAnchoredAtStart(afterLines, options.afterTokens, model);

  // Compute the line range covered by this node (1-indexed).
  const startLine = matchIndex - beforeTrim.kept.length + 1;
  const endLine = matchIndex + afterTrim.kept.length + 1;

  const tokens = beforeTrim.spent + model.estimate(match.text) + afterTrim.spent;

  return {
    id: 0, // assigned by caller
    source: match.source,
    match_line: match.line,
    start_line: Math.max(1, startLine),
    end_line: endLine,
    context_before: beforeTrim.kept,
    match_text: match.text,
    context_after: afterTrim.kept,
    match_spans: [[match.match_start, match.match_end]],
    tokens,
  };
}

/**
 * Trim a list of lines to fit a token budget, anchored at index 0
 * (i.e. the line nearest the match) and growing outward.
 *
 * The kept lines are returned in their original order.
 */
function trimAnchoredAtStart(
  lines: string[],
  budget: number,
  model: TokenModel,
): { kept: string[]; spent: number } {
  if (budget <= 0 || lines.length === 0) {
    return { kept: [], spent: 0 };
  }

  const kept: (string | null)[] = new Array(lines.length).fill(null);
  kept[0] = lines[0];
  let spent = model.estimate(lines[0]);

  let left = 0;
  let right = 1;
  // Track next direction to try. Alternate starting with right (further from anchor).
  let tryRightFirst = true;

  while (left >= 0 || right < lines.length) {
    const canL = left >= 0;
    const canR = right < lines.length;
    if (!canL && !canR) break;

    let takeRight: boolean;
    if (!canL) takeRight = true;
    else if (!canR) takeRight = false;
    else takeRight = tryRightFirst;

    if (takeRight) {
      const cost = model.estimate(lines[right]);
      if (spent + cost > budget) {
        right = lines.length; // stop expanding
      } else {
        kept[right] = lines[right];
        spent += cost;
        right++;
      }
    } else {
      const cost = model.estimate(lines[left]);
      if (spent + cost > budget) {
        left = -1; // stop expanding
      } else {
        kept[left] = lines[left];
        spent += cost;
        left--;
      }
    }
    tryRightFirst = !tryRightFirst;
  }

  const result: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    if (kept[i] !== null) result.push(kept[i] as string);
  }
  return { kept: result, spent };
}

/**
 * Apply a total token budget to a set of nodes.
 *
 * - "fill": prefer more nodes, each with its configured before/after.
 *           If total exceeds budget, drop nodes from the end.
 * - "deep": prefer fewer, deeper nodes. For v1 we still trim from the
 *           end; full deep mode would re-build nodes with scaled
 *           per-node budgets (left as a future enhancement).
 */
/**
 * Apply a per-node window-decay curve to a list of nodes in place.
 * Nodes earlier in the list keep more context; later nodes get
 * progressively less. Pairs with sort modes — e.g. `sort=recent` plus
 * `windowCurve=linear` means recent files have rich context and older
 * files get a tighter disambiguating window.
 */
export function applyWindowCurve(
  nodes: Node[],
  mode: "flat" | "linear" | "log",
  baseBefore: number,
  baseAfter: number,
  tokenModel: TokenModel = defaultTokens,
): void {
  if (mode === "flat" || nodes.length === 0) return;
  const N = nodes.length;
  for (let i = 0; i < N; i++) {
    const ratio = curveRatio(i, N, mode);
    const targetBefore = Math.max(0, Math.floor(baseBefore * ratio));
    const targetAfter  = Math.max(0, Math.floor(baseAfter  * ratio));
    trimNodeContext(nodes[i], targetBefore, targetAfter, tokenModel);
  }
}

function curveRatio(rank: number, total: number, mode: "linear" | "log"): number {
  if (mode === "linear") {
    if (total <= 1) return 1;
    return Math.max(0.1, 1 - (rank / (total - 1)) * 0.9);
  }
  // log
  return 1 / Math.log2(rank + 2);
}

/** Drop lines from the outer edges of a node's context until under target tokens. */
function trimNodeContext(
  node: Node,
  targetBeforeTokens: number,
  targetAfterTokens: number,
  tokens: TokenModel,
): void {
  // Trim context_before from the start (oldest first) until under budget.
  while (node.context_before.length > 0 && tokens.estimateMany(node.context_before) > targetBeforeTokens) {
    node.context_before.shift();
    node.start_line = Math.min(node.match_line, node.start_line + 1);
  }
  // Trim context_after from the end until under budget.
  while (node.context_after.length > 0 && tokens.estimateMany(node.context_after) > targetAfterTokens) {
    node.context_after.pop();
    node.end_line = Math.max(node.match_line, node.end_line - 1);
  }
  // Recompute total tokens.
  node.tokens =
    tokens.estimateMany(node.context_before) +
    tokens.estimate(node.match_text) +
    tokens.estimateMany(node.context_after);
}

export function applyTotalBudget(
  nodes: Node[],
  maxTokens: number | undefined,
  strategy: "fill" | "deep",
): { nodes: Node[]; truncated: boolean } {
  if (!maxTokens || maxTokens <= 0) {
    return { nodes, truncated: false };
  }

  const total = nodes.reduce((s, n) => s + n.tokens, 0);
  if (total <= maxTokens) {
    return { nodes, truncated: false };
  }

  // Greedy: keep adding nodes until budget exhausted.
  void strategy; // both strategies use the same trim in v1
  const kept: Node[] = [];
  let spent = 0;
  for (const n of nodes) {
    if (spent + n.tokens > maxTokens) break;
    kept.push(n);
    spent += n.tokens;
  }
  return { nodes: kept, truncated: kept.length < nodes.length };
}
