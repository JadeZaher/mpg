/**
 * Truncation arm — naive baseline.
 *
 * Takes the most-recent-edited files in the corpus, concatenates them
 * in mtime-descending order until the token budget is hit. Zero LLM
 * cost; no topic-awareness. The "what if you just kept the recent
 * stuff" floor.
 */

import type { CompactionTask } from "../tasks.js";
import type { CorpusDoc } from "../../lib/corpus.js";
import { statSync } from "node:fs";

function approxTokens(s: string): number { return Math.ceil(s.length / 4); }

export interface ArmResult {
  arm: string;
  compaction: string;
  compaction_tokens: number;
  input_tokens: number;
  output_tokens: number;
  ms: number;
}

export async function runTruncation(task: CompactionTask, docs: CorpusDoc[]): Promise<ArmResult> {
  const t0 = Date.now();
  // Sort docs by mtime descending.
  const withMtime = docs.map((d) => {
    let mt = 0;
    try { mt = statSync(d.path).mtimeMs; } catch { /* ignore */ }
    return { ...d, mtime: mt };
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);

  const parts: string[] = [];
  let used = 0;
  for (const d of withMtime) {
    const header = `\n# ${d.rel}\n`;
    const tokens = approxTokens(header + d.content);
    if (used + tokens > task.budget_tokens) {
      // Try truncating this file to fit the remaining budget.
      const remaining = task.budget_tokens - used - approxTokens(header);
      if (remaining < 50) break;
      const charBudget = remaining * 4;
      parts.push(header + d.content.slice(0, charBudget) + "\n[truncated]");
      used += approxTokens(header) + remaining;
      break;
    }
    parts.push(header + d.content);
    used += tokens;
  }
  const compaction = parts.join("\n");
  return {
    arm: "truncation",
    compaction,
    compaction_tokens: approxTokens(compaction),
    input_tokens: 0,
    output_tokens: 0,
    ms: Date.now() - t0,
  };
}
