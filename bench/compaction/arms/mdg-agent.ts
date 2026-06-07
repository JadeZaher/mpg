/**
 * mdg-agent arm — LLM-driven mdg use.
 *
 * Reuses the macro tier's runAgent with a system prompt focused on
 * compaction. The agent has mdg + read/grep/write/bash and is told
 * to assemble a compaction within a token budget. The agent's final
 * text output IS the compaction (no separate output step).
 *
 * This is the headline arm for the compaction bench — it tests
 * whether mdg's index-then-detail pattern with scan + sort + window
 * curve produces a better compaction than naive summarization for
 * the same token budget.
 */

import { runAgent } from "../../macro/agent/index.js";
import type { CompactionTask } from "../tasks.js";

function approxTokens(s: string): number { return Math.ceil(s.length / 4); }

export interface ArmResult {
  arm: string;
  compaction: string;
  compaction_tokens: number;
  input_tokens: number;
  output_tokens: number;
  ms: number;
  error?: string;
}

// Explicit delimiters so we can robustly extract the compaction from
// whatever preamble the model emits. Previously the model produced
// 15-token "compaction generated" status messages and the bench
// scored those as the "compaction." Delimiters + system prompt
// requirements that match the macro harness's new ANSWER_FORMAT_BLOCK
// make the agent emit the actual content.
const COMPACTION_OPEN = "<compaction>";
const COMPACTION_CLOSE = "</compaction>";

export function extractCompaction(text: string): string {
  const openIdx = text.indexOf(COMPACTION_OPEN);
  const closeIdx = text.indexOf(COMPACTION_CLOSE);
  if (openIdx >= 0 && closeIdx > openIdx) {
    return text.slice(openIdx + COMPACTION_OPEN.length, closeIdx).trim();
  }
  // Fall back to raw final text if no delimiters present.
  return text.trim();
}

export async function runMdgAgent(task: CompactionTask, corpusRoot: string): Promise<ArmResult> {
  const t0 = Date.now();
  try {
    const taskPrompt =
      `Produce a memory compaction about the following topic.\n\n` +
      `TOPIC: ${task.topic}\n\n` +
      `BUDGET: ${task.budget_tokens} tokens (hard cap on the compaction text).\n` +
      `CORPUS: search the contents of \`${corpusRoot}\` using your tools. ` +
      `The corpus spans multiple projects' conductor tracks (markdown specs + plans + JSON metadata).\n\n` +
      `OUTPUT FORMAT (critical):\n` +
      `When you have gathered what you need, write your FINAL response as a single tagged block:\n\n` +
      `${COMPACTION_OPEN}\n` +
      `(the compaction text here — about ${task.budget_tokens} tokens; preserve concrete facts like file paths, identifiers, version numbers, function names; no preamble outside the tags)\n` +
      `${COMPACTION_CLOSE}\n\n` +
      `Do NOT write things like "I have produced the compaction" instead of the compaction. ` +
      `The text between ${COMPACTION_OPEN} and ${COMPACTION_CLOSE} is what gets scored — it must contain the actual content.\n\n` +
      `GUIDANCE for using mdg efficiently:\n` +
      `1. Start with mdg_search at effort: 'scan' (with clip_chars: 30 if available) to get a time-ordered index of every hit on the topic.\n` +
      `2. Stash the index, then drill into specific files with mdg_search at effort: 'quick' or 'normal' for richer context only where you actually need it.\n` +
      `3. Multiple targeted parallel searches beat one huge deep search.`;

    const result = await runAgent({
      taskPrompt,
      arm: "treatment",
      maxTurns: 20,
      maxInputTokens: 50_000,
      cwd: corpusRoot,
      interTurnDelayMs: 500,
      maxRetries: 5,
    });
    // Extract from the tagged block; falls back to full text if untagged.
    const compaction = extractCompaction(result.finalText);
    return {
      arm: "mdg-agent",
      compaction,
      compaction_tokens: approxTokens(compaction),
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      ms: Date.now() - t0,
    };
  } catch (err) {
    return {
      arm: "mdg-agent",
      compaction: "",
      compaction_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      ms: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}
