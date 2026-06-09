/**
 * Meso benchmark: recall / precision / token cost across effort presets.
 *
 * For each (query, effort) cell in the matrix:
 *   - run mpg with --format json on the synthetic corpus
 *   - compare returned (file, line) tuples to ground truth
 *   - record recall, precision, F1, tokens, wall-clock
 *
 * Output: a per-query table + a per-effort aggregate, plus a JSON
 * record under bench/results/ for diffing across runs.
 */

import { relative } from "node:path";
import { search, writeResult } from "../lib/runner.js";
import { GROUND_TRUTH, makeCorpus, destroyCorpus, type GroundTruth } from "../lib/fixtures.js";

interface Cell {
  query: string;
  effort: string;
  status: string;
  recall: number;
  precision: number;
  f1: number;
  tokens: number;
  ms: number;
  returned: number;
  expected: number;
}

function evaluate(gt: GroundTruth, effort: string, corpusRoot: string): Cell {
  const r = search(
    [gt.pattern, "--in", corpusRoot, "--effort", effort],
  );
  if (!r.json || r.json.status === "error") {
    return {
      query: gt.label,
      effort,
      status: r.json?.status ?? "error",
      recall: 0,
      precision: 0,
      f1: 0,
      tokens: 0,
      ms: r.ms,
      returned: 0,
      expected: gt.expected.length,
    };
  }
  const returnedSet = new Set(
    r.json.nodes.map((n) => `${relative(corpusRoot, n.source.id).replace(/\\/g, "/")}:${n.match_line}`),
  );
  const expectedSet = new Set(gt.expected.map((e) => `${e.file}:${e.line}`));
  let tp = 0;
  for (const e of expectedSet) if (returnedSet.has(e)) tp++;
  const recall = expectedSet.size === 0 ? 1 : tp / expectedSet.size;
  const precision = returnedSet.size === 0 ? 0 : tp / returnedSet.size;
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  return {
    query: gt.label,
    effort,
    status: r.json.status,
    recall,
    precision,
    f1,
    tokens: r.json.total_tokens ?? 0,
    ms: r.ms,
    returned: returnedSet.size,
    expected: expectedSet.size,
  };
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0).padStart(3)}%`;
}

function main(): void {
  const corpus = makeCorpus();
  const cells: Cell[] = [];

  try {
    for (const gt of GROUND_TRUTH) {
      for (const effort of gt.efforts) {
        cells.push(evaluate(gt, effort, corpus));
      }
    }
  } finally {
    destroyCorpus(corpus);
  }

  // Per-query table
  process.stdout.write("\n## Per-query results\n\n");
  process.stdout.write("| query | effort | recall | prec | F1 | tokens | ms | ret/exp |\n");
  process.stdout.write("| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |\n");
  for (const c of cells) {
    process.stdout.write(
      `| ${c.query} | ${c.effort} | ${fmtPct(c.recall)} | ${fmtPct(c.precision)} | ${fmtPct(c.f1)} | ${c.tokens} | ${c.ms} | ${c.returned}/${c.expected} |\n`,
    );
  }

  // Per-effort aggregate
  process.stdout.write("\n## Per-effort aggregate (mean across queries)\n\n");
  process.stdout.write("| effort | mean recall | mean prec | mean F1 | mean tokens | mean ms |\n");
  process.stdout.write("| :--- | ---: | ---: | ---: | ---: | ---: |\n");
  const efforts = [...new Set(cells.map((c) => c.effort))];
  const summary: Record<string, { recall: number; prec: number; f1: number; tokens: number; ms: number }> = {};
  for (const e of efforts) {
    const group = cells.filter((c) => c.effort === e);
    const mean = (k: keyof Cell) =>
      group.reduce((a, c) => a + (c[k] as number), 0) / group.length;
    const m = {
      recall: mean("recall"),
      prec: mean("precision"),
      f1: mean("f1"),
      tokens: mean("tokens"),
      ms: mean("ms"),
    };
    summary[e] = m;
    process.stdout.write(
      `| ${e} | ${fmtPct(m.recall)} | ${fmtPct(m.prec)} | ${fmtPct(m.f1)} | ${m.tokens.toFixed(0)} | ${m.ms.toFixed(0)} |\n`,
    );
  }

  const path = writeResult("meso", { cells, summary, generated_at: new Date().toISOString() });
  process.stdout.write(`\nWrote ${path}\n`);
}

main();
