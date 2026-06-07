/**
 * Node construction.
 *
 * Given a match and the full content of its source, build a "node":
 * the matched line plus a pre/post context window sized in tokens.
 *
 * The pre/post windows are built greedily outward from the match line,
 * so they fit exactly within the budget. This is what makes mdg
 * different from `rg -C N`: we budget in *tokens*, not lines.
 */

import { readFileSync } from "node:fs";
import { defaultTokens, type TokenModel } from "./tokens.js";
import type { Match, Node, Source } from "./types.js";

export interface BuildNodeOptions {
  beforeTokens: number;
  afterTokens: number;
  tokens?: TokenModel;
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
