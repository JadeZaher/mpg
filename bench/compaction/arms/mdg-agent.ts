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
      `BUDGET: ${task.budget_tokens} tokens (hard cap on the compaction text between the tags).\n` +
      `CORPUS: \`${corpusRoot}\` — multiple projects' conductor tracks (markdown specs + plans + JSON metadata).\n\n` +
      `THE FASTEST PATH (try this first):\n` +
      `A single mdg_search call with effort:"scan", clip_chars:30, max_tokens:${task.budget_tokens}, sort:"recent" ` +
      `against \`${corpusRoot}\` for the topic's key terms IS a compaction. mdg's lens hard-caps the budget for you — ` +
      `you can just wrap the output in <compaction>...</compaction> and stop.\n\n` +
      `If you want a tighter result, run scan first to find the relevant files, stash the result, ` +
      `then use 'from' to scope a second mdg_search with richer windows (effort:"normal") only ` +
      `on those files.\n\n` +
      `OUTPUT FORMAT (CRITICAL — read carefully):\n` +
      `When you have what you need, your FINAL response MUST be:\n\n` +
      `${COMPACTION_OPEN}\n` +
      `(the actual compaction text — file paths, identifiers, version numbers, schemes, function names, ` +
      `~${task.budget_tokens} tokens, no preamble outside the tags)\n` +
      `${COMPACTION_CLOSE}\n\n` +
      `Do NOT write "I have produced the compaction" or "Here is the compaction:" — write the COMPACTION ITSELF ` +
      `between the tags. The text inside the tags is what gets scored; an empty or status-only response fails.`;

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
