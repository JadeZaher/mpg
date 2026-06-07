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

const SYSTEM_PROMPT_SUFFIX =
  "\n\nYOU ARE PRODUCING A MEMORY COMPACTION.\n" +
  "You have read/grep/write/bash + five mdg tools (search, stash, list, get, drop).\n\n" +
  "GUIDANCE for using mdg efficiently when compacting:\n" +
  "1. Start with mdg_search at effort: 'scan' to get a time-ordered index of every hit on " +
  "the topic — many small nodes, ~60 tokens each, sorted recent-first.\n" +
  "2. Stash the index, then drill into specific files with mdg_search at effort: 'quick' or 'normal' " +
  "for richer context only where you actually need it.\n" +
  "3. Multiple targeted parallel searches beat one huge deep search.\n" +
  "4. Your FINAL response IS the compaction. It must fit within the requested token budget. " +
  "Do not include preamble or explanation outside the compaction. Preserve concrete facts " +
  "(file paths, identifiers, version numbers, hashing schemes, function names).";

export async function runMdgAgent(task: CompactionTask, corpusRoot: string): Promise<ArmResult> {
  const t0 = Date.now();
  try {
    const taskPrompt =
      `Produce a memory compaction about the following topic.\n\n` +
      `TOPIC: ${task.topic}\n\n` +
      `BUDGET: ${task.budget_tokens} tokens (hard cap on your final response).\n` +
      `CORPUS: search the contents of \`${corpusRoot}\` using your tools. ` +
      `The corpus spans multiple projects' conductor tracks (markdown specs + plans + JSON metadata).\n\n` +
      `When you have gathered what you need, produce the compaction as your final response and stop.\n` +
      SYSTEM_PROMPT_SUFFIX;

    const result = await runAgent({
      taskPrompt,
      arm: "treatment",
      maxTurns: 20,
      maxInputTokens: 50_000,
      cwd: corpusRoot,
    });
    return {
      arm: "mdg-agent",
      compaction: result.finalText,
      compaction_tokens: approxTokens(result.finalText),
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
