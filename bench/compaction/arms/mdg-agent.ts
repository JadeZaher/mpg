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

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // Force the agent through the file-system to defeat the "I'm done"
    // failure mode. Models trained to be terse interpret "your final
    // message IS the compaction" as "say done" no matter how the prompt
    // tries to override it. The write tool, by contrast, is a concrete
    // action: file content cannot be summarized away. After the agent
    // signals completion we read the file as the compaction.
    const outDir = mkdtempSync(join(tmpdir(), `mdg-compaction-${task.id}-`));
    const compactionPath = join(outDir, "compaction.md").replace(/\\/g, "/");

    const taskPrompt =
      `Produce a memory compaction about the following topic and save it to a file using the \`write\` tool.\n\n` +
      `TOPIC: ${task.topic}\n\n` +
      `BUDGET: ${task.budget_tokens} tokens (approximate, hard cap on the file content).\n` +
      `CORPUS: \`${corpusRoot}\` — multiple projects' conductor tracks (markdown specs + plans + JSON metadata).\n` +
      `OUTPUT FILE: \`${compactionPath}\` (must exist when you finish — the bench reads this file)\n\n` +
      `THE FASTEST PATH:\n` +
      `1. Call mdg_search with effort:"scan", clip_chars:30, max_tokens:${task.budget_tokens}, sort:"recent" ` +
      `against \`${corpusRoot}\` for the topic's key terms (OR'd in the regex).\n` +
      `2. Take the formatted output as your compaction. mdg's lens hard-caps the budget for you.\n` +
      `3. Call the \`write\` tool with path:"${compactionPath}" and content:(the mdg output).\n` +
      `4. Reply with a brief "done" — the bench reads the file, not your message.\n\n` +
      `ALTERNATIVE (if you want a tighter, synthesized compaction):\n` +
      `- Run scan first to find the files, stash them with stash_name, ` +
      `then use mdg_search with from:"<stash>" + effort:"normal" to get richer windows.\n` +
      `- Compose the relevant parts yourself, then write the result to ${compactionPath}.\n\n` +
      `CRITICAL: the file ${compactionPath} MUST exist and be non-empty when you finish. ` +
      `If you don't write the file, the bench scores 0% — no exceptions. ` +
      `Preserve concrete facts: file paths, identifiers, version numbers, hashing schemes, function names.`;

    const result = await runAgent({
      taskPrompt,
      arm: "treatment",
      maxTurns: 20,
      maxInputTokens: 50_000,
      cwd: corpusRoot,
      interTurnDelayMs: 500,
      maxRetries: 5,
    });

    // Prefer the written file. Fall back to extractCompaction(finalText)
    // if the agent ignored the instruction (so we at least record what
    // it did emit).
    let compaction = "";
    if (existsSync(compactionPath)) {
      try {
        compaction = readFileSync(compactionPath, "utf8").trim();
      } catch { /* fall through */ }
    }
    if (!compaction || compaction.length < 50) {
      compaction = extractCompaction(result.finalText);
    }
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
