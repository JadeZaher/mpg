/**
 * bench/macro/agent/index.ts
 *
 * Public API for the macro benchmark agent harness.
 *
 * Two arms:
 *   control   — read / grep / write / bash
 *   treatment — control tools + mpg_search / mpg_stash / mpg_list_stashes /
 *               mpg_get_stash / mpg_drop_stash
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
import { getOpenRouterClient, DEFAULT_OPENROUTER_MODEL } from "./openrouter-client.js";
import { runLoopOpenAI } from "./loop-openai.js";
import { CONTROL_TOOL_DEFS, buildControlDispatch } from "./tools-control.js";
import {
  ALL_TREATMENT_SCHEMAS,
  buildTreatmentDispatch,
} from "./tools-treatment.js";

/**
 * Provider selection:
 *   MPG_BENCH_PROVIDER=anthropic (default) — uses Anthropic SDK + Haiku 4.5.
 *   MPG_BENCH_PROVIDER=openrouter         — uses OpenAI SDK against OpenRouter,
 *                                            default model DeepSeek V4 Pro.
 *
 * OpenRouter avoids our Anthropic org rate limit (50k input tokens/min
 * shared across parallel benches) and lets us run multiple LLM-driven
 * tiers concurrently without contention.
 */
type Provider = "anthropic" | "openrouter";
function pickProvider(): Provider {
  const v = (process.env.MPG_BENCH_PROVIDER ?? "anthropic").toLowerCase();
  return v === "openrouter" ? "openrouter" : "anthropic";
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type Arm = "control" | "treatment";

export interface RunOptions {
  /** The task prompt sent as the first user message. */
  taskPrompt: string;
  /** Which arm to run: control (baseline) or treatment (+ mpg tools). */
  arm: Arm;
  /** Maximum conversation turns before stopping. Default: 20. */
  maxTurns?: number;
  /** Stop if cumulative input tokens reach this limit. Default: 50 000. */
  maxInputTokens?: number;
  /**
   * Model ID to use. Default: process.env.MPG_BENCH_MODEL ?? "claude-haiku-4-5-20251001".
   */
  modelId?: string;
  /**
   * Treatment arm only: path to an isolated mind-palace file for this task.
   * Pass a unique tmp path per task to prevent cross-task pollution.
   * If omitted, mpg uses its default palace path.
   */
  palacePath?: string;
  /**
   * Working directory for tool execution (read/grep/write/bash and mpg CLI).
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
  process.env["MPG_BENCH_MODEL"] ?? "claude-haiku-4-5-20251001";

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
// turns with mpg. Compaction's mpg-agent arm hit the same wall (15-
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

THE LENS MENTAL MODEL
mpg is a single LENS over the corpus with no boundaries between files. You set:
  - the matches (focal points) via the pattern,
  - the depth at each focal point (effort / clip_chars / before / after / window_curve),
  - and the surface (in: paths, sort by recency, paginate).

You don't pick between "grep this" and "read that" — you adjust the lens. With the right flags, one mpg_search call replaces what would otherwise be 1-N grep + read combos.

WHEN mpg IS THE RIGHT LENS SETTING
  - You need windowed context around matches (effort: "quick" / "normal" / "deep").
  - You're investigating a topic across multiple files and want results sorted/sized by mtime, recency, or a token budget (sort, max_tokens, window_curve).
  - The term might be misspelled (fuzzy: true).
  - You want to remember a result for later turns (mpg_stash, then mpg_search with from: "<name>").
  - You want one tool call that replaces grep-then-read-then-grep again.

WHEN bash/grep/read ARE FINE
  - A single-word lookup where you just need file:line — bash 'grep -rn TERM .' is cheaper than mpg's CLI cold-start.
  - You already know the exact file and want to read it end-to-end — use 'read'.
  - You need to write a file or run a shell command — use 'write' or 'bash'.

MPG TOOLS
  - mpg_search: read the schema. effort / clip_chars / sort / window_curve / fuzzy / max_tokens / page / page_size / from / compose are how you shape the lens.
  - mpg_stash: save a search's results under a name+tags for re-use this turn or later.
  - mpg_list_stashes / mpg_get_stash / mpg_drop_stash: inspect/manage stashes.

Pick the tool that fits the question. Don't pre-stash if you won't reuse. Don't reach for mpg if grep is one line and you only need one match.

${ANSWER_FORMAT_BLOCK}`;

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run the agent harness for a single task.
 *
 * Throws `Error("ANTHROPIC_API_KEY not set")` when the key is absent —
 * the benchmark driver should catch this and skip the run.
 */
export async function runAgent(opts: RunOptions): Promise<RunOutput> {
  const provider = pickProvider();
  if (provider === "anthropic") {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  }

  const arm = opts.arm;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxInputTokens = opts.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  const modelId =
    opts.modelId ??
    (provider === "openrouter" ? DEFAULT_OPENROUTER_MODEL : DEFAULT_MODEL);
  const cwd = opts.cwd ?? REPO_ROOT;
  const palacePath = opts.palacePath;
  const onProgress = opts.onProgress;
  const systemPrompt = arm === "treatment" ? TREATMENT_SYSTEM_PROMPT : CONTROL_SYSTEM_PROMPT;

  // Tool schemas + dispatch map for the chosen arm.
  const tools =
    arm === "control"
      ? CONTROL_TOOL_DEFS.map((d) => d.schema)
      : ALL_TREATMENT_SCHEMAS;

  const dispatch =
    arm === "control"
      ? buildControlDispatch(cwd)
      : buildTreatmentDispatch(cwd, palacePath);

  const t0 = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let turns = 0;
  let finalText = "";
  let hitCap: "turns" | "input_tokens" | "none" = "none";

  if (provider === "openrouter") {
    const client = await getOpenRouterClient();
    const r = await runLoopOpenAI({
      client,
      modelId,
      tools,
      dispatch,
      systemPrompt,
      taskPrompt: opts.taskPrompt,
      maxTurns,
      maxInputTokens,
      interTurnDelayMs: opts.interTurnDelayMs ?? 0,
      maxRetries: opts.maxRetries ?? 5,
      onProgress,
    });
    finalText = r.finalText;
    inputTokens = r.inputTokens;
    outputTokens = r.outputTokens;
    toolCalls = r.toolCalls;
    turns = r.turns;
    hitCap = r.hitCap;
  } else {
    const client = await getClient();
    const r = await runLoop({
      client,
      modelId,
      tools,
      dispatch,
      systemPrompt,
      taskPrompt: opts.taskPrompt,
      maxTurns,
      interTurnDelayMs: opts.interTurnDelayMs ?? 0,
      maxRetries: opts.maxRetries ?? 5,
      maxInputTokens,
      onProgress,
    });
    finalText = r.finalText;
    inputTokens = r.inputTokens;
    outputTokens = r.outputTokens;
    toolCalls = r.toolCalls;
    turns = r.turns;
    hitCap = r.hitCap;
  }

  const ms = Date.now() - t0;
  return {
    arm,
    modelId,
    finalText,
    inputTokens,
    outputTokens,
    toolCalls,
    turns,
    ms,
    hitCap,
  };
}
