/**
 * Macro benchmark driver.
 *
 * Runs each task in TASKS through both arms (control and treatment),
 * scores the agent's final answer against expected_phrases, and emits
 * a result JSON under bench/results/macro-<ISO>.json.
 *
 * Treatment arm: agent has read/grep/write/bash + 5 mdg tools.
 * Control arm:   agent has read/grep/write/bash only.
 *
 * The agent harness is in bench/macro/agent (Worker 1's owned module).
 * This driver imports the runAgent contract and is corpus-agnostic.
 *
 * If ANTHROPIC_API_KEY is not set, exits 0 with a "skipped" record so
 * CI doesn't fail. The aggregator handles that case.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeResult } from "../lib/runner.js";
import { loadEnvFile } from "../lib/env.js";
import { TASKS, FRACTAL_ROOT, ensureCorpus, scoreAnswer, type TaskSpec } from "./tasks/tasks.js";

loadEnvFile();

interface Cell {
  taskId: string;
  taskLabel: string;
  arm: "control" | "treatment";
  passed: boolean;
  matched_groups: number;
  total_groups: number;
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  turns: number;
  ms: number;
  hitCap: "turns" | "input_tokens" | "none";
  error?: string;
}

interface AggregateRow {
  pass_rate: number;
  mean_input_tokens: number;
  mean_output_tokens: number;
  mean_tool_calls: number;
  mean_turns: number;
  mean_ms: number;
  n: number;
}

function fmtPct(x: number): string { return `${(x * 100).toFixed(0)}%`; }
function num(x: number): string { return Math.round(x).toString(); }

async function runOne(task: TaskSpec, arm: "control" | "treatment"): Promise<Cell> {
  const t0 = Date.now();
  try {
    // Per-task isolated palace for treatment arm.
    const palacePath = arm === "treatment"
      ? join(mkdtempSync(join(tmpdir(), `mdg-macro-${task.id}-`)), "palace.json")
      : undefined;

    // Dynamic import so the driver compiles before W1 has finished.
    const agent = await import("./agent/index.js" as string).catch((err) => {
      throw new Error(`bench/macro/agent not built yet (worker 1 in flight): ${err.message}`);
    });

    const result = await agent.runAgent({
      taskPrompt: task.prompt,
      arm,
      maxTurns: 20,
      maxInputTokens: 50_000,
      // Let runAgent pick the default for the active provider
      // (deepseek/deepseek-v4-pro for openrouter, haiku for anthropic).
      // Only override with MDG_BENCH_MODEL if explicitly set.
      modelId: process.env.MDG_BENCH_MODEL,
      palacePath,
      cwd: FRACTAL_ROOT,
      interTurnDelayMs: 500,
      maxRetries: 5,
      onProgress: (p: { input: number; output: number; turn: number }) => {
        process.stderr.write(`  [${task.id}/${arm}] turn ${p.turn} | in=${p.input} out=${p.output}\n`);
      },
    });

    const score = scoreAnswer(result.finalText, task);
    return {
      taskId: task.id,
      taskLabel: task.label,
      arm,
      passed: score.passed,
      matched_groups: score.matched_groups,
      total_groups: score.total_groups,
      finalText: result.finalText.slice(0, 2000),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      toolCalls: result.toolCalls,
      turns: result.turns,
      ms: result.ms,
      hitCap: result.hitCap,
    };
  } catch (err) {
    return {
      taskId: task.id,
      taskLabel: task.label,
      arm,
      passed: false,
      matched_groups: 0,
      total_groups: task.expected_phrases.length,
      finalText: "",
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      turns: 0,
      ms: Date.now() - t0,
      hitCap: "none",
      error: (err as Error).message,
    };
  }
}

function aggregate(arm: "control" | "treatment", cells: Cell[]): AggregateRow {
  const g = cells.filter((c) => c.arm === arm);
  if (g.length === 0) {
    return { pass_rate: 0, mean_input_tokens: 0, mean_output_tokens: 0, mean_tool_calls: 0, mean_turns: 0, mean_ms: 0, n: 0 };
  }
  const mean = (k: keyof Cell) => g.reduce((a, c) => a + (Number(c[k]) || 0), 0) / g.length;
  return {
    pass_rate: g.filter((c) => c.passed).length / g.length,
    mean_input_tokens: mean("inputTokens"),
    mean_output_tokens: mean("outputTokens"),
    mean_tool_calls: mean("toolCalls"),
    mean_turns: mean("turns"),
    mean_ms: mean("ms"),
    n: g.length,
  };
}

async function main(): Promise<void> {
  // Gating: no API key, no data corpus -> emit "skipped" stub.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stdout.write("ANTHROPIC_API_KEY not set — skipping macro bench.\n");
    const path = writeResult("macro", {
      status: "skipped",
      reason: "ANTHROPIC_API_KEY not set",
      generated_at: new Date().toISOString(),
    });
    process.stdout.write(`Wrote ${path}\n`);
    return;
  }
  try {
    ensureCorpus();
  } catch (err) {
    process.stdout.write(`Corpus check failed: ${(err as Error).message}\n`);
    const path = writeResult("macro", {
      status: "skipped",
      reason: (err as Error).message,
      generated_at: new Date().toISOString(),
    });
    process.stdout.write(`Wrote ${path}\n`);
    return;
  }

  const explicitModel = process.env.MDG_BENCH_MODEL;
  const provider = (process.env.MDG_BENCH_PROVIDER ?? "anthropic").toLowerCase();
  const displayModel =
    explicitModel ?? (provider === "openrouter" ? "deepseek/deepseek-v4-pro (OpenRouter default)" : "claude-haiku-4-5-20251001 (Anthropic default)");
  process.stdout.write(`\nMacro bench — ${TASKS.length} tasks × 2 arms = ${TASKS.length * 2} runs\n`);
  process.stdout.write(`Provider: ${provider}\nModel: ${displayModel}\n`);
  process.stdout.write(`Corpus: ${FRACTAL_ROOT}\n`);
  process.stdout.write(`Budget per run: 20 turns, 50k input tokens\n\n`);

  const cells: Cell[] = [];
  for (const task of TASKS) {
    process.stdout.write(`\n--- ${task.id} | ${task.label} ---\n`);
    // Run control first (cheaper if it caps faster), then treatment.
    cells.push(await runOne(task, "control"));
    cells.push(await runOne(task, "treatment"));
  }

  const control = aggregate("control", cells);
  const treatment = aggregate("treatment", cells);

  // Lift: treatment minus control. Positive lift on pass_rate is good;
  // negative lift on tokens is good (treatment uses fewer).
  const lift = {
    pass_rate: treatment.pass_rate - control.pass_rate,
    input_tokens: control.mean_input_tokens === 0 ? 0 : (treatment.mean_input_tokens / control.mean_input_tokens) - 1,
    output_tokens: control.mean_output_tokens === 0 ? 0 : (treatment.mean_output_tokens / control.mean_output_tokens) - 1,
    ms: control.mean_ms === 0 ? 0 : (treatment.mean_ms / control.mean_ms) - 1,
  };

  // Per-task table.
  process.stdout.write("\n## Per-task results\n\n");
  process.stdout.write("| task | arm | passed | in tokens | out tokens | tools | turns | ms |\n");
  process.stdout.write("| :--- | :--- | :---: | ---: | ---: | ---: | ---: | ---: |\n");
  for (const c of cells) {
    const pass = c.passed ? "yes" : "no";
    process.stdout.write(
      `| ${c.taskLabel} | ${c.arm} | ${pass} | ${num(c.inputTokens)} | ${num(c.outputTokens)} | ${c.toolCalls} | ${c.turns} | ${num(c.ms)} |\n`,
    );
  }

  // Per-arm summary + lift.
  process.stdout.write("\n## Per-arm summary\n\n");
  process.stdout.write("| arm | pass rate | mean in tokens | mean out tokens | mean tool calls | mean turns | mean ms |\n");
  process.stdout.write("| :--- | ---: | ---: | ---: | ---: | ---: | ---: |\n");
  for (const [arm, row] of [["control", control], ["treatment", treatment]] as Array<[string, AggregateRow]>) {
    process.stdout.write(
      `| ${arm} | ${fmtPct(row.pass_rate)} | ${num(row.mean_input_tokens)} | ${num(row.mean_output_tokens)} | ${row.mean_tool_calls.toFixed(1)} | ${row.mean_turns.toFixed(1)} | ${num(row.mean_ms)} |\n`,
    );
  }

  process.stdout.write("\n## Lift (treatment vs control)\n\n");
  process.stdout.write(`- **pass-rate lift**:  ${(lift.pass_rate >= 0 ? "+" : "")}${fmtPct(lift.pass_rate)}\n`);
  process.stdout.write(`- **input tokens**:    ${(lift.input_tokens >= 0 ? "+" : "")}${fmtPct(lift.input_tokens)}\n`);
  process.stdout.write(`- **output tokens**:   ${(lift.output_tokens >= 0 ? "+" : "")}${fmtPct(lift.output_tokens)}\n`);
  process.stdout.write(`- **wall-clock**:      ${(lift.ms >= 0 ? "+" : "")}${fmtPct(lift.ms)}\n`);

  const path = writeResult("macro", {
    status: "ok",
    model: displayModel,
    provider,
    corpus_root: FRACTAL_ROOT,
    tasks: TASKS.length,
    cells,
    summary: { control, treatment },
    lift,
    generated_at: new Date().toISOString(),
  });
  process.stdout.write(`\nWrote ${path}\n`);
}

main().catch((err) => {
  process.stderr.write(`macro bench failed: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
