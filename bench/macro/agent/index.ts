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

const CONTROL_SYSTEM_PROMPT = `You are a precise engineering assistant running inside an automated benchmark.
Complete the task described by the user using the available tools (read, grep, write, bash).
Be concise — write only what the task requires.
Do not add explanations or commentary unless specifically asked.
When you have finished the task, reply with your result and nothing else.`;

const TREATMENT_SYSTEM_PROMPT = `You are a precise engineering assistant running inside an automated benchmark.
Complete the task described by the user efficiently. You have read/grep/write/bash tools PLUS five mdg tools that give you token-budgeted, paginated, stashable context:
  - mdg_search: returns nodes (match + sized pre/post window), not whole files. Supports effort (quick|normal|deep), max_nodes, pagination (page/page_size), and scoping via from/compose.
  - mdg_stash: saves a search result under a name + tags. Future searches can scope to a stash with from: "<name>".
  - mdg_list_stashes / mdg_get_stash / mdg_drop_stash: inspect and clean up.

HOW TO BEAT A BARE READ+GREP SETUP ON TOKEN COST:
1. Prefer mdg_search over read+grep when you need context around a match. mdg gives you the match plus N tokens on either side — usually enough to answer without reading the whole file.
2. Use small budgets: max_nodes=5, effort="quick" for the first probe. Bump only when the small node didn't carry enough context.
3. Use pagination: page=1, page_size=3 so you can stop early when you have what you need. Check pagination.has_next before paging further.
4. Stash relevant hits with mdg_stash before reading more. Future searches scoped via from: "<name>" are much cheaper than re-searching the whole tree.
5. Reserve "read" for very short files or when you genuinely need surrounding code beyond what mdg returns.

Be concise — write only what the task requires. Do not add explanations or commentary unless specifically asked. When you have finished the task, reply with your result and nothing else.`;

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
