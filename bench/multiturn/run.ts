/**
 * bench/multiturn/run.ts
 *
 * Multi-turn memory benchmark driver.
 *
 * Measures whether mdg's mind-palace stashing pays off ACROSS TURNS.
 * The macro bench measures single-turn lift; this bench measures:
 *   "given a multi-step task where the agent must remember earlier findings,
 *    does stashing in turn N produce a real benefit in turn N+k?"
 *
 * Approach — concatenated multi-Q format:
 *   All turns of a scenario are concatenated into a single big prompt as
 *   labelled questions (Q1 / Q2 / Q3 / Q4) and the agent is asked to produce
 *   correspondingly labelled answers (A1 / A2 / A3 / A4).  This lets the
 *   treatment arm stash early findings in mdg and retrieve them when answering
 *   later questions, while the control arm must re-search from scratch.
 *
 * Arms:
 *   control   — read / grep / write / bash.  No mdg.
 *   treatment — same tools + 5 mdg tools (search / stash / list / get / drop).
 *               System prompt explicitly encourages stashing early answers.
 *
 * Scoring:
 *   The final answer text is split on "A1:" / "A2:" markers to extract each
 *   turn's answer, then scored with substring OR-groups per TurnSpec.
 *   A scenario "passes" a turn if every expected group has at least one match.
 *
 * Budget: 30 turns / 100 000 input tokens per run (larger than macro because
 *   multi-Q prompts are longer).
 *
 * Output: bench/results/multiturn-<ISO>.json
 *
 * If ANTHROPIC_API_KEY is missing, emits a "skipped" record and exits 0.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeResult } from "../lib/runner.js";
import { loadEnvFile } from "../lib/env.js";
import {
  SCENARIOS,
  FRACTAL_ROOT,
  scoreTurn,
  type ScenarioSpec,
} from "./scenarios.js";

loadEnvFile();

// ─── Types ───────────────────────────────────────────────────────────────────

interface Cell {
  scenarioId: string;
  scenarioLabel: string;
  arm: "control" | "treatment";
  /** Passed / total per turn, e.g. [true, false, true, true] */
  turnResults: boolean[];
  totalPassed: number;
  totalTurnsExpected: number;
  /** Proportion of turns passed in this cell. */
  pass_rate: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  turns: number;
  ms: number;
  hitCap: "turns" | "input_tokens" | "none";
  finalText: string;
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

// ─── System prompts ──────────────────────────────────────────────────────────

const CONTROL_SYSTEM_PROMPT = `You are a precise engineering assistant running inside an automated multi-turn benchmark.
You will receive a prompt containing several numbered questions (Q1, Q2, Q3, …).
Answer each question in order using the available tools (read, grep, write, bash).
Format your final answer with clearly labelled sections: A1:, A2:, A3:, and so on.
Be concise — write only what each question asks for.
Do not add explanations or commentary beyond what is required.`;

const TREATMENT_SYSTEM_PROMPT = `You are a precise engineering assistant running inside an automated multi-turn benchmark.
You will receive a prompt containing several numbered questions (Q1, Q2, Q3, …).

You have read/grep/write/bash tools PLUS five mdg tools that give you token-budgeted, stashable context:
  - mdg_search: returns match nodes with sized pre/post windows. Supports effort (quick|normal|deep), max_nodes, pagination, and scoping via from/compose.
  - mdg_stash: saves a search result under a name + tags. Future searches can scope to a stash.
  - mdg_list_stashes / mdg_get_stash / mdg_drop_stash: inspect and manage stashes.

MULTI-TURN STASHING STRATEGY — THIS IS CRITICAL:
1. When you answer Q1, immediately mdg_stash the key facts under a descriptive name (e.g. "q1-entity-hierarchy").
2. When answering Q2 and beyond, first call mdg_get_stash or scope mdg_search via from:"<stash-name>" to reuse earlier findings instead of re-searching.
3. This is the ENTIRE POINT of the bench: early stashes should make later answers cheaper and faster.
4. Use small budgets: max_nodes=5, effort="quick" for the first probe. Paginate to stop early.
5. Reserve "read" for very short files or when you genuinely need more context than mdg returns.

Format your final answer with clearly labelled sections: A1:, A2:, A3:, and so on.
Be concise — write only what each question asks for.`;

// ─── Task prompt builder ──────────────────────────────────────────────────────

function buildTaskPrompt(scenario: ScenarioSpec): string {
  const lines: string[] = [
    `You are investigating the FractalEngine codebase at: ${FRACTAL_ROOT}`,
    ``,
    `Answer the following ${scenario.turns.length} related questions IN ORDER.`,
    `After finishing all tool use, write your final answer with sections A1:, A2:, etc.`,
    ``,
  ];
  for (let i = 0; i < scenario.turns.length; i++) {
    lines.push(`Q${i + 1}: ${scenario.turns[i].prompt}`);
    lines.push(``);
  }
  return lines.join("\n");
}

// ─── Answer section extractor ────────────────────────────────────────────────

/**
 * Split the final answer text into per-turn sections.
 * Looks for "A1:", "A2:", … markers (case-insensitive).
 * Returns an array aligned with turns; missing sections are empty strings.
 */
function extractAnswerSections(text: string, numTurns: number): string[] {
  const sections: string[] = Array(numTurns).fill("");
  for (let i = 1; i <= numTurns; i++) {
    // Match "A1:" markers (case-insensitive).  The regex captures everything
    // after the colon so we get a clean section start.
    const currRe = new RegExp(`[Aa]${i}:`, "i");
    const nextRe = new RegExp(`[Aa]${i + 1}:`, "i");
    const start = text.search(currRe);
    if (start === -1) continue;
    // Skip past "A<n>:" to the actual content.
    const colonPos = text.indexOf(":", start);
    const sectionStart = colonPos + 1;
    if (i < numTurns) {
      const end = text.search(nextRe);
      sections[i - 1] =
        end === -1 ? text.slice(sectionStart).trim() : text.slice(sectionStart, end).trim();
    } else {
      sections[i - 1] = text.slice(sectionStart).trim();
    }
  }
  return sections;
}

// ─── Single-scenario runner ───────────────────────────────────────────────────

async function runOne(
  scenario: ScenarioSpec,
  arm: "control" | "treatment",
  modelId: string,
): Promise<Cell> {
  const t0 = Date.now();

  try {
    // Per-scenario isolated palace for treatment arm.
    const palacePath =
      arm === "treatment"
        ? join(
            mkdtempSync(join(tmpdir(), `mdg-mt-${scenario.id}-`)),
            "palace.json",
          )
        : undefined;

    // Reuse the macro agent harness — it's the same SDK contract.
    const agent = await import("../macro/agent/index.js" as string).catch(
      (err) => {
        throw new Error(
          `bench/macro/agent not available (check build): ${(err as Error).message}`,
        );
      },
    );

    const taskPrompt = buildTaskPrompt(scenario);

    const result = await agent.runAgent({
      taskPrompt,
      arm,
      maxTurns: 30,
      maxInputTokens: 100_000,
      modelId,
      palacePath,
      cwd: FRACTAL_ROOT,
      onProgress: (p: { input: number; output: number; turn: number }) => {
        process.stderr.write(
          `  [${scenario.id}/${arm}] turn ${p.turn} | in=${p.input} out=${p.output}\n`,
        );
      },
    });

    // Score each turn.
    const sections = extractAnswerSections(
      result.finalText,
      scenario.turns.length,
    );
    const turnResults: boolean[] = scenario.turns.map((turn, idx) => {
      const section = sections[idx] ?? "";
      // Fall back to searching the entire final text if the marker wasn't found.
      const haystack = section.length > 0 ? section : result.finalText;
      return scoreTurn(haystack, turn.expected).passed;
    });

    const totalPassed = turnResults.filter(Boolean).length;
    const totalTurnsExpected = scenario.turns.length;

    return {
      scenarioId: scenario.id,
      scenarioLabel: scenario.label,
      arm,
      turnResults,
      totalPassed,
      totalTurnsExpected,
      pass_rate: totalPassed / totalTurnsExpected,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      toolCalls: result.toolCalls,
      turns: result.turns,
      ms: Date.now() - t0,
      hitCap: result.hitCap,
      finalText: result.finalText.slice(0, 3000),
    };
  } catch (err) {
    const totalTurnsExpected = scenario.turns.length;
    return {
      scenarioId: scenario.id,
      scenarioLabel: scenario.label,
      arm,
      turnResults: Array(totalTurnsExpected).fill(false),
      totalPassed: 0,
      totalTurnsExpected,
      pass_rate: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      turns: 0,
      ms: Date.now() - t0,
      hitCap: "none",
      finalText: "",
      error: (err as Error).message,
    };
  }
}

// ─── Aggregate helper ─────────────────────────────────────────────────────────

function aggregate(arm: "control" | "treatment", cells: Cell[]): AggregateRow {
  const g = cells.filter((c) => c.arm === arm);
  if (g.length === 0) {
    return {
      pass_rate: 0,
      mean_input_tokens: 0,
      mean_output_tokens: 0,
      mean_tool_calls: 0,
      mean_turns: 0,
      mean_ms: 0,
      n: 0,
    };
  }
  const mean = (fn: (c: Cell) => number) =>
    g.reduce((a, c) => a + fn(c), 0) / g.length;
  return {
    pass_rate: mean((c) => c.pass_rate),
    mean_input_tokens: mean((c) => c.inputTokens),
    mean_output_tokens: mean((c) => c.outputTokens),
    mean_tool_calls: mean((c) => c.toolCalls),
    mean_turns: mean((c) => c.turns),
    mean_ms: mean((c) => c.ms),
    n: g.length,
  };
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
function num(x: number): string {
  return Math.round(x).toString();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Guard: no API key.
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    process.stdout.write("ANTHROPIC_API_KEY not set — skipping multiturn bench.\n");
    const path = writeResult("multiturn", {
      status: "skipped",
      reason: "ANTHROPIC_API_KEY not set",
      generated_at: new Date().toISOString(),
    });
    process.stdout.write(`Wrote ${path}\n`);
    return;
  }

  // Guard: corpus must exist.
  if (!existsSync(FRACTAL_ROOT)) {
    process.stdout.write(`Corpus not found at ${FRACTAL_ROOT} — skipping.\n`);
    const path = writeResult("multiturn", {
      status: "skipped",
      reason: `Corpus not found at ${FRACTAL_ROOT}`,
      generated_at: new Date().toISOString(),
    });
    process.stdout.write(`Wrote ${path}\n`);
    return;
  }

  const modelId =
    process.env["MDG_BENCH_MODEL"] ?? "claude-haiku-4-5-20251001";

  process.stdout.write(
    `\nMulti-turn bench — ${SCENARIOS.length} scenarios × 2 arms = ${SCENARIOS.length * 2} runs\n`,
  );
  process.stdout.write(`Model: ${modelId}\n`);
  process.stdout.write(`Corpus: ${FRACTAL_ROOT}\n`);
  process.stdout.write(`Budget per run: 30 turns, 100k input tokens\n\n`);

  const cells: Cell[] = [];

  for (const scenario of SCENARIOS) {
    const turnCount = scenario.turns.length;
    process.stdout.write(
      `\n--- ${scenario.id} | ${scenario.label} (${turnCount} turns) ---\n`,
    );

    // Control first (likely cheaper), then treatment.
    process.stdout.write(`  Running control arm...\n`);
    const ctrlCell = await runOne(scenario, "control", modelId);
    cells.push(ctrlCell);
    process.stdout.write(
      `  control: ${ctrlCell.totalPassed}/${ctrlCell.totalTurnsExpected} turns passed\n`,
    );

    process.stdout.write(`  Running treatment arm...\n`);
    const trtCell = await runOne(scenario, "treatment", modelId);
    cells.push(trtCell);
    process.stdout.write(
      `  treatment: ${trtCell.totalPassed}/${trtCell.totalTurnsExpected} turns passed\n`,
    );
  }

  const control = aggregate("control", cells);
  const treatment = aggregate("treatment", cells);

  const lift = {
    pass_rate: treatment.pass_rate - control.pass_rate,
    input_tokens:
      control.mean_input_tokens === 0
        ? 0
        : treatment.mean_input_tokens / control.mean_input_tokens - 1,
    output_tokens:
      control.mean_output_tokens === 0
        ? 0
        : treatment.mean_output_tokens / control.mean_output_tokens - 1,
    ms:
      control.mean_ms === 0
        ? 0
        : treatment.mean_ms / control.mean_ms - 1,
  };

  // Per-scenario table.
  process.stdout.write("\n## Per-scenario results\n\n");
  process.stdout.write(
    "| scenario | arm | pass rate | in tokens | out tokens | tools | turns | ms |\n",
  );
  process.stdout.write(
    "| :--- | :--- | :---: | ---: | ---: | ---: | ---: | ---: |\n",
  );
  for (const c of cells) {
    process.stdout.write(
      `| ${c.scenarioLabel} | ${c.arm} | ${fmtPct(c.pass_rate)} | ${num(c.inputTokens)} | ${num(c.outputTokens)} | ${c.toolCalls} | ${c.turns} | ${num(c.ms)} |\n`,
    );
  }

  // Per-arm summary.
  process.stdout.write("\n## Per-arm summary\n\n");
  process.stdout.write(
    "| arm | pass rate | mean in tokens | mean out tokens | mean tool calls | mean turns | mean ms |\n",
  );
  process.stdout.write(
    "| :--- | ---: | ---: | ---: | ---: | ---: | ---: |\n",
  );
  for (const [arm, row] of [
    ["control", control],
    ["treatment", treatment],
  ] as Array<[string, AggregateRow]>) {
    process.stdout.write(
      `| ${arm} | ${fmtPct(row.pass_rate)} | ${num(row.mean_input_tokens)} | ${num(row.mean_output_tokens)} | ${row.mean_tool_calls.toFixed(1)} | ${row.mean_turns.toFixed(1)} | ${num(row.mean_ms)} |\n`,
    );
  }

  // Lift table.
  process.stdout.write("\n## Lift (treatment vs control)\n\n");
  process.stdout.write(
    `- **pass-rate lift**:  ${lift.pass_rate >= 0 ? "+" : ""}${fmtPct(lift.pass_rate)}\n`,
  );
  process.stdout.write(
    `- **input tokens**:    ${lift.input_tokens >= 0 ? "+" : ""}${fmtPct(lift.input_tokens)}\n`,
  );
  process.stdout.write(
    `- **output tokens**:   ${lift.output_tokens >= 0 ? "+" : ""}${fmtPct(lift.output_tokens)}\n`,
  );
  process.stdout.write(
    `- **wall-clock**:      ${lift.ms >= 0 ? "+" : ""}${fmtPct(lift.ms)}\n`,
  );

  const outputCells = cells.map((c) => ({
    scenarioId: c.scenarioId,
    scenarioLabel: c.scenarioLabel,
    arm: c.arm,
    totalPassed: c.totalPassed,
    totalTurnsExpected: c.totalTurnsExpected,
    pass_rate: c.pass_rate,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    toolCalls: c.toolCalls,
    turns: c.turns,
    ms: c.ms,
    hitCap: c.hitCap,
    ...(c.error ? { error: c.error } : {}),
  }));

  const path = writeResult("multiturn", {
    status: "ok",
    model: modelId,
    corpus_root: FRACTAL_ROOT,
    scenarios: SCENARIOS.length,
    cells: outputCells,
    summary: { control, treatment },
    lift,
    generated_at: new Date().toISOString(),
  });

  process.stdout.write(`\nWrote ${path}\n`);
}

main().catch((err) => {
  process.stderr.write(
    `multiturn bench failed: ${(err as Error).message}\n${(err as Error).stack}\n`,
  );
  process.exit(1);
});
