/**
 * Compaction benchmark driver.
 *
 * For each task × each arm:
 *   1. Run the arm to produce a compaction (text) within the budget.
 *   2. Score the compaction by asking the LLM each task question with
 *      ONLY the compaction as context. Substring-match the answer.
 *   3. Record arm cost (tokens, ms), compaction size, answer-quality.
 *
 * Arms:
 *   truncation     no-LLM, most-recent files until budget hits
 *   mdg-scan       no-LLM, one mdg call (scan + sort recent + log curve)
 *   summarization  LLM baseline: rg-retrieve, single-pass summarize
 *   mdg-agent      LLM + mdg tools, reuses macro agent harness
 *
 * Without ANTHROPIC_API_KEY: skips LLM arms AND scoring; writes a
 * status=skipped record. Without the corpus: writes status=skipped.
 */

import { loadEnvFile } from "../lib/env.js";
loadEnvFile();

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeResult } from "../lib/runner.js";
import { discoverMegaCorpus, MEGA_CORPUS_ROOTS, type CorpusDoc } from "../lib/corpus.js";
import { TASKS, ensureMegaCorpus, type CompactionTask } from "./tasks.js";
import { runTruncation } from "./arms/truncation.js";
import { runMdgScan } from "./arms/mdg-scan.js";
import { runSummarization } from "./arms/summarization.js";
import { runMdgAgent } from "./arms/mdg-agent.js";
import { scoreCompaction, type ScoringResult } from "./scoring.js";

interface Cell {
  taskId: string;
  taskLabel: string;
  arm: string;
  compaction_tokens: number;
  budget_tokens: number;
  input_tokens: number;
  output_tokens: number;
  scoring_input_tokens: number;
  scoring_output_tokens: number;
  pass_rate: number;
  ms: number;
  error?: string;
  /** Density = pass_rate / (compaction_tokens / 1000). Higher is better. */
  density: number;
  qa_results: Array<{ question: string; passed: boolean; matched_phrase?: string }>;
}

interface AggregateRow {
  arm: string;
  mean_pass_rate: number;
  mean_compaction_tokens: number;
  mean_input_tokens: number;
  mean_output_tokens: number;
  mean_density: number;
  mean_ms: number;
  n: number;
}

function fmtPct(x: number): string { return `${(x * 100).toFixed(0).padStart(3)}%`; }
function num(x: number): string { return Math.round(x).toString(); }

async function runOneTask(task: CompactionTask, docs: CorpusDoc[], hasApi: boolean): Promise<Cell[]> {
  const corpusRoot = MEGA_CORPUS_ROOTS.find((r) => existsSync(r))!;
  const cells: Cell[] = [];
  process.stdout.write(`\n--- ${task.id}: ${task.label} (budget=${task.budget_tokens} tok) ---\n`);

  // 1. truncation — no LLM
  process.stdout.write(`  truncation... `);
  {
    const r = await runTruncation(task, docs);
    let scoring: ScoringResult = { qas: [], pass_rate: 0, total_input_tokens: 0, total_output_tokens: 0 };
    if (hasApi) scoring = await scoreCompaction(r.compaction, task.questions);
    process.stdout.write(`pass=${fmtPct(scoring.pass_rate)} comp=${r.compaction_tokens}t\n`);
    cells.push(makeCell(task, r, scoring));
  }

  // 2. mdg-scan — no LLM
  process.stdout.write(`  mdg-scan... `);
  {
    const r = await runMdgScan(task, corpusRoot);
    let scoring: ScoringResult = { qas: [], pass_rate: 0, total_input_tokens: 0, total_output_tokens: 0 };
    if (hasApi) scoring = await scoreCompaction(r.compaction, task.questions);
    process.stdout.write(`pass=${fmtPct(scoring.pass_rate)} comp=${r.compaction_tokens}t\n`);
    cells.push(makeCell(task, r, scoring));
  }

  if (!hasApi) return cells;

  // 3. summarization — LLM
  process.stdout.write(`  summarization... `);
  {
    const r = await runSummarization(task, corpusRoot);
    const scoring = await scoreCompaction(r.compaction, task.questions);
    process.stdout.write(`pass=${fmtPct(scoring.pass_rate)} comp=${r.compaction_tokens}t in=${r.input_tokens}\n`);
    cells.push(makeCell(task, r, scoring));
  }

  // 4. mdg-agent — LLM + mdg
  process.stdout.write(`  mdg-agent... `);
  {
    const r = await runMdgAgent(task, corpusRoot);
    const scoring = await scoreCompaction(r.compaction, task.questions);
    process.stdout.write(`pass=${fmtPct(scoring.pass_rate)} comp=${r.compaction_tokens}t in=${r.input_tokens}\n`);
    cells.push(makeCell(task, r, scoring));
  }

  return cells;
}

function makeCell(
  task: CompactionTask,
  armResult: { arm: string; compaction_tokens: number; input_tokens: number; output_tokens: number; ms: number; error?: string },
  scoring: ScoringResult,
): Cell {
  const ct = armResult.compaction_tokens;
  const density = ct === 0 ? 0 : scoring.pass_rate / (ct / 1000);
  return {
    taskId: task.id,
    taskLabel: task.label,
    arm: armResult.arm,
    compaction_tokens: ct,
    budget_tokens: task.budget_tokens,
    input_tokens: armResult.input_tokens,
    output_tokens: armResult.output_tokens,
    scoring_input_tokens: scoring.total_input_tokens,
    scoring_output_tokens: scoring.total_output_tokens,
    pass_rate: scoring.pass_rate,
    ms: armResult.ms,
    error: armResult.error,
    density,
    qa_results: scoring.qas.map((q) => ({ question: q.question, passed: q.passed, matched_phrase: q.matched_phrase })),
  };
}

function aggregate(arm: string, cells: Cell[]): AggregateRow {
  const g = cells.filter((c) => c.arm === arm);
  if (g.length === 0) {
    return { arm, mean_pass_rate: 0, mean_compaction_tokens: 0, mean_input_tokens: 0, mean_output_tokens: 0, mean_density: 0, mean_ms: 0, n: 0 };
  }
  const mean = (k: keyof Cell) => g.reduce((a, c) => a + (Number(c[k]) || 0), 0) / g.length;
  return {
    arm,
    mean_pass_rate: mean("pass_rate"),
    mean_compaction_tokens: mean("compaction_tokens"),
    mean_input_tokens: mean("input_tokens"),
    mean_output_tokens: mean("output_tokens"),
    mean_density: mean("density"),
    mean_ms: mean("ms"),
    n: g.length,
  };
}

async function main(): Promise<void> {
  const hasApi = !!process.env.ANTHROPIC_API_KEY;
  if (!ensureMegaCorpus(MEGA_CORPUS_ROOTS)) {
    process.stdout.write(`No mega-corpus root found. Tried: ${MEGA_CORPUS_ROOTS.join(", ")}\n`);
    const path = writeResult("compaction", {
      status: "skipped",
      reason: "mega-corpus not found on disk",
      generated_at: new Date().toISOString(),
    });
    process.stdout.write(`Wrote ${path}\n`);
    return;
  }
  const docs = discoverMegaCorpus();
  process.stdout.write(`Mega-corpus: ${docs.length} files\n`);
  if (!hasApi) {
    process.stdout.write(`ANTHROPIC_API_KEY not set — running no-LLM arms only (truncation, mdg-scan).\n` +
      `Scoring requires the API key; the no-LLM arms will be recorded with pass_rate=0 and skip flag set.\n`);
  }

  const allCells: Cell[] = [];
  for (const task of TASKS) {
    const cells = await runOneTask(task, docs, hasApi);
    allCells.push(...cells);
  }

  const arms = [...new Set(allCells.map((c) => c.arm))];
  const summary: Record<string, AggregateRow> = {};
  for (const arm of arms) summary[arm] = aggregate(arm, allCells);

  process.stdout.write("\n## Per-arm summary\n\n");
  process.stdout.write("| arm | pass rate | mean comp tokens | mean in tokens | mean density | mean ms |\n");
  process.stdout.write("| :--- | ---: | ---: | ---: | ---: | ---: |\n");
  for (const arm of arms) {
    const r = summary[arm];
    process.stdout.write(
      `| ${arm} | ${fmtPct(r.mean_pass_rate)} | ${num(r.mean_compaction_tokens)} | ${num(r.mean_input_tokens)} | ${r.mean_density.toFixed(2)} | ${num(r.mean_ms)} |\n`,
    );
  }

  const path = writeResult("compaction", {
    status: hasApi ? "ok" : "partial",
    has_api_key: hasApi,
    tasks: TASKS.length,
    corpus_files: docs.length,
    corpus_roots: MEGA_CORPUS_ROOTS.filter((r) => existsSync(r)),
    cells: allCells,
    summary,
    generated_at: new Date().toISOString(),
  });
  process.stdout.write(`\nWrote ${path}\n`);
}

main().catch((err) => {
  process.stderr.write(`compaction bench failed: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
