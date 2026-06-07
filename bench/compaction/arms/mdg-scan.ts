/**
 * mdg-scan arm — no-LLM mdg path.
 *
 * One mdg CLI call per retrieval_keyword (OR'd into a single regex),
 * using effort=scan + sort=recent + window-curve=log + --max-tokens
 * capped at the budget. The compaction is the formatted text output.
 *
 * This is what an agent COULD do with one tool call before even
 * thinking. Tests whether mdg's "given a topic, return the right
 * nodes in budget" is itself a useful compaction primitive.
 */

import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../../lib/runner.js";
import type { CompactionTask } from "../tasks.js";

function approxTokens(s: string): number { return Math.ceil(s.length / 4); }

export interface ArmResult {
  arm: string;
  compaction: string;
  compaction_tokens: number;
  input_tokens: number;
  output_tokens: number;
  ms: number;
}

export async function runMdgScan(task: CompactionTask, corpusRoot: string): Promise<ArmResult> {
  const t0 = Date.now();
  // OR the topic keywords into one regex.
  const pattern = task.retrieval_keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const r = spawnSync(
    "node",
    [
      join(repoRoot(), "dist", "index.js"),
      pattern,
      "--in", corpusRoot,
      "--effort", "scan",
      "--sort", "recent",
      "--window-curve", "log",
      "--max-tokens", String(task.budget_tokens),
      "--format", "llm",
      "--no-color",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  const compaction = r.stdout ?? "";
  return {
    arm: "mdg-scan",
    compaction,
    compaction_tokens: approxTokens(compaction),
    input_tokens: 0,
    output_tokens: 0,
    ms: Date.now() - t0,
  };
}
