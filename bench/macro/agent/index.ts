/**
 * bench/macro/agent/index.ts
 *
 * Public API for the macro benchmark agent harness.
 *
 * Two arms:
 *   control   — read / grep / write / bash
 *   treatment — control tools + mdg_search / mdg_stash / mdg_list_stashes /
 *               mdg_get_stash / mdg_drop_stash
 *
 * Usage:
 *   import { runAgent, type RunOptions, type RunOutput } from "./agent/index.js";
 *   const result = await runAgent({ taskPrompt: "...", arm: "control" });
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getClient } from "./client.js";
import { runLoop } from "./loop.js";
import { CONTROL_TOOL_DEFS, buildControlDispatch } from "./tools-control.js";
import {
  ALL_TREATMENT_SCHEMAS,
  buildTreatmentDispatch,
} from "./tools-treatment.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type Arm = "control" | "treatment";

export interface RunOptions {
  /** The task prompt sent as the first user message. */
  taskPrompt: string;
  /** Which arm to run: control (baseline) or treatment (+ mdg tools). */
  arm: Arm;
  /** Maximum conversation turns before stopping. Default: 20. */
  maxTurns?: number;
  /** Stop if cumulative input tokens reach this limit. Default: 50 000. */
  maxInputTokens?: number;
  /**
   * Model ID to use. Default: process.env.MDG_BENCH_MODEL ?? "claude-haiku-4-5-20251001".
   */
  modelId?: string;
  /**
   * Treatment arm only: path to an isolated mind-palace file for this task.
   * Pass a unique tmp path per task to prevent cross-task pollution.
   * If omitted, mdg uses its default palace path.
   */
  palacePath?: string;
  /**
   * Working directory for tool execution (read/grep/write/bash and mdg CLI).
   * Default: repo root (resolved from this file's location).
   */
  cwd?: string;
  /** Called after each turn with cumulative token totals. */
  onProgress?: (p: { input: number; output: number; turn: number }) => void;
  /**
   * Sleep N ms between turns to stay under Anthropic rate limits.
   * Default 0 for macro (small tasks); multi-turn driver bumps to 750.
   */
  interTurnDelayMs?: number;
  /** Max retries on 429/529/transient errors. Default 5. */
  maxRetries?: number;
}

export interface RunOutput {
  arm: Arm;
  modelId: string;
  /** Last assistant text block, or "[stopped: ...]" if a cap was hit. */
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  turns: number;
  ms: number;
  hitCap: "turns" | "input_tokens" | "none";
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_INPUT_TOKENS = 50_000;
const DEFAULT_MODEL =
  process.env["MDG_BENCH_MODEL"] ?? "claude-haiku-4-5-20251001";

const __filename = fileURLToPath(import.meta.url);
// bench/macro/agent -> bench/macro -> bench -> repo root
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");

// ─── System prompts ──────────────────────────────────────────────────────────
//
// Critical: these prompts MUST yield to format requirements in the
// task prompt. The previous version said "be concise — reply with your
// result and nothing else" which the model interpreted as "skip
// structured output and just say done." That collision dropped multi-
// turn pass-rate to 0% even though the agent converged in half the
// turns with mdg. Compaction's mdg-agent arm hit the same wall (15-
// token "compaction generated" instead of the actual compaction).
//
// New rule: brevity applies to PROSE around the answer, not to the
// answer itself. If the task specifies a format, the model must
// produce it in full.

const ANSWER_FORMAT_BLOCK = `OUTPUT REQUIREMENTS (read carefully — your benchmark score depends on this):
- If the task prompt specifies an output format (e.g. "respond with A1: ... A2: ..." or "your final response IS the compaction"), your FINAL message MUST contain that format in full. Do not summarize, abbreviate, or say "done" — produce the actual output the task asks for.
- Do not include preamble like "Here is my answer:" or "I have completed the task:" — start directly with the required output.
- Be concise WITHIN the format. Skip ornamental commentary, but do not skip required sections.
- After your final message you cannot continue. Make sure every required answer section is present before you stop.`;

const CONTROL_SYSTEM_PROMPT = `You are a precise engineering assistant running inside an automated benchmark.
Complete the task using the available tools (read, grep, write, bash).

${ANSWER_FORMAT_BLOCK}`;

const TREATMENT_SYSTEM_PROMPT = `You are a precise engineering assistant running inside an automated benchmark.
You have read/grep/write/bash tools PLUS five mdg tools that give you token-budgeted, paginated, stashable context:
  - mdg_search: returns nodes (match + sized pre/post window), not whole files. Supports effort (scan|quick|normal|deep), max_nodes, --clip <N> for sub-line snippets, --sort recent|oldest, pagination (page/page_size), and scoping via from/compose.
  - mdg_stash: saves a search result under a name + tags. Future searches can scope to a stash with from: "<name>".
  - mdg_list_stashes / mdg_get_stash / mdg_drop_stash: inspect and clean up.

HOW TO USE MDG EFFICIENTLY:
1. Start with mdg_search at effort: "scan" (and clip_chars: 30 if available) to get a cheap hit-list. Most questions need just an index, not deep context.
2. If the scan looks ambiguous, bump to effort: "quick" or "normal" on the SPECIFIC files that matter — not the whole tree.
3. Stash relevant hits with mdg_stash before reading more. Subsequent mdg_search with from: "<stash-name>" is cheaper than re-searching.
4. Reserve "read" for short files or when you genuinely need surrounding code beyond what mdg returns.
5. Use grep for one-word lookups where you only need a file:line list; use mdg when you need context.

${ANSWER_FORMAT_BLOCK}`;

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run the agent harness for a single task.
 *
 * Throws `Error("ANTHROPIC_API_KEY not set")` when the key is absent —
 * the benchmark driver should catch this and skip the run.
 */
export async function runAgent(opts: RunOptions): Promise<RunOutput> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const arm = opts.arm;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxInputTokens = opts.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  const modelId = opts.modelId ?? DEFAULT_MODEL;
  const cwd = opts.cwd ?? REPO_ROOT;
  const palacePath = opts.palacePath;
  const onProgress = opts.onProgress;

  // Build tool schemas + dispatch map for the chosen arm.
  const tools =
    arm === "control"
      ? CONTROL_TOOL_DEFS.map((d) => d.schema)
      : ALL_TREATMENT_SCHEMAS;

  const dispatch =
    arm === "control"
      ? buildControlDispatch(cwd)
      : buildTreatmentDispatch(cwd, palacePath);

  const client = await getClient();

  const t0 = Date.now();

  const loopResult = await runLoop({
    client,
    modelId,
    tools,
    dispatch,
    systemPrompt: arm === "treatment" ? TREATMENT_SYSTEM_PROMPT : CONTROL_SYSTEM_PROMPT,
    taskPrompt: opts.taskPrompt,
    maxTurns,
    interTurnDelayMs: opts.interTurnDelayMs ?? 0,
    maxRetries: opts.maxRetries ?? 5,
    maxInputTokens,
    onProgress,
  });

  const ms = Date.now() - t0;

  return {
    arm,
    modelId,
    finalText: loopResult.finalText,
    inputTokens: loopResult.inputTokens,
    outputTokens: loopResult.outputTokens,
    toolCalls: loopResult.toolCalls,
    turns: loopResult.turns,
    ms,
    hitCap: loopResult.hitCap,
  };
}
