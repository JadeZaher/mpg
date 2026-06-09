/**
 * Meso embedding baseline.
 *
 * Same ground-truth queries as recall-vs-budget.ts, but retrieval is
 * vector cosine over file-level embeddings instead of mpg regex search.
 *
 * For each query we ask "which files should be in the answer set?"
 * (file-level granularity, since embeddings don't natively give a
 * line-number). Ground truth is reduced from (file, line) tuples to
 * the set of unique files.
 *
 * Output mirrors recall-vs-budget.ts so the aggregator can diff
 * head-to-head.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndex, topK } from "../lib/embed.js";
import { writeResult } from "../lib/runner.js";
import { GROUND_TRUTH, makeCorpus, destroyCorpus, FIXTURES } from "../lib/fixtures.js";

interface Cell {
  query: string;
  k: number;
  recall: number;
  precision: number;
  f1: number;
  tokens: number;
  ms: number;
  returned: number;
  expected: number;
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0).padStart(3)}%`;
}

function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

async function main(): Promise<void> {
  const corpus = makeCorpus();
  const cells: Cell[] = [];

  try {
    // Build a file-level vector index. Each file is one document.
    const docs = FIXTURES.map((f) => ({
      id: f.path,
      text: readFileSync(join(corpus, f.path), "utf8"),
    }));
    process.stdout.write(`Building embedding index over ${docs.length} files (first run downloads ~80 MB model)...\n`);
    const t0 = Date.now();
    const index = await buildIndex(docs);
    process.stdout.write(`Index built in ${Date.now() - t0} ms.\n`);

    // For each query, compare top-k retrieved files to the
    // ground-truth unique files. We evaluate at k = 3, 5, and 10
    // so we can see how recall scales with how much we retrieve.
    const KS = [3, 5, 10];

    for (const gt of GROUND_TRUTH) {
      const expectedFiles = new Set(gt.expected.map((e) => e.file));
      for (const k of KS) {
        const tq = Date.now();
        const hits = await topK(index, gt.label + " " + gt.pattern, k);
        const ms = Date.now() - tq;
        const returnedFiles = new Set(hits.map((h) => h.id));
        let tp = 0;
        for (const e of expectedFiles) if (returnedFiles.has(e)) tp++;
        const recall = expectedFiles.size === 0 ? 1 : tp / expectedFiles.size;
        const precision = returnedFiles.size === 0 ? 0 : tp / returnedFiles.size;
        const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
        // "Tokens" for embedding retrieval = the tokens of the docs we'd
        // load into context (the top-k files' raw content). This is the
        // honest comparable to mpg's --max-tokens budget.
        const tokens = hits.reduce((acc, h) => {
          const text = readFileSync(join(corpus, h.id), "utf8");
          return acc + approxTokens(text);
        }, 0);
        cells.push({
          query: gt.label,
          k,
          recall,
          precision,
          f1,
          tokens,
          ms,
          returned: returnedFiles.size,
          expected: expectedFiles.size,
        });
      }
    }
  } finally {
    destroyCorpus(corpus);
  }

  process.stdout.write("\n## Per-query results (vector cosine top-k)\n\n");
  process.stdout.write("| query | k | recall | prec | F1 | tokens | ms | ret/exp |\n");
  process.stdout.write("| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n");
  for (const c of cells) {
    process.stdout.write(
      `| ${c.query} | ${c.k} | ${fmtPct(c.recall)} | ${fmtPct(c.precision)} | ${fmtPct(c.f1)} | ${c.tokens} | ${c.ms} | ${c.returned}/${c.expected} |\n`,
    );
  }

  process.stdout.write("\n## Per-k aggregate (mean across queries)\n\n");
  process.stdout.write("| k | mean recall | mean prec | mean F1 | mean tokens | mean ms |\n");
  process.stdout.write("| ---: | ---: | ---: | ---: | ---: | ---: |\n");
  const ks = [...new Set(cells.map((c) => c.k))];
  const summary: Record<string, { recall: number; prec: number; f1: number; tokens: number; ms: number }> = {};
  for (const k of ks) {
    const group = cells.filter((c) => c.k === k);
    const mean = (key: keyof Cell) => group.reduce((a, c) => a + (c[key] as number), 0) / group.length;
    const m = {
      recall: mean("recall"),
      prec: mean("precision"),
      f1: mean("f1"),
      tokens: mean("tokens"),
      ms: mean("ms"),
    };
    summary[String(k)] = m;
    process.stdout.write(
      `| ${k} | ${fmtPct(m.recall)} | ${fmtPct(m.prec)} | ${fmtPct(m.f1)} | ${m.tokens.toFixed(0)} | ${m.ms.toFixed(0)} |\n`,
    );
  }

  const path = writeResult("meso-embed", { cells, summary, generated_at: new Date().toISOString() });
  process.stdout.write(`\nWrote ${path}\n`);
}

main().catch((err) => {
  process.stderr.write(`embedding-baseline failed: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
