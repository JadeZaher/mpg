/**
 * Memory-corpus benchmark driver — section-level chunked embeddings.
 *
 * Same corpus + queries as the new conversational tier (oasis-sleek
 * conductor tracks). The only difference: instead of one embedding
 * per file, we split markdown by `## ` / `### ` headings so a long
 * spec contributes multiple section-level chunks. A query "hit" still
 * credits the FILE — we just measure whether finer chunking helps
 * surface the right files in top-k.
 */

import { loadEnvFile } from "../lib/env.js";
loadEnvFile();

import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { QUERIES, type QuerySpec } from "./queries.js";
import { writeResult } from "../lib/runner.js";
import { buildIndex, topK } from "../lib/embed.js";
import { discoverCorpus, DEFAULT_CORPUS_ROOT, totalLines, totalBytes, type CorpusDoc } from "../lib/corpus.js";
import { chunkCorpus, chunkStats, type Chunk } from "./chunking.js";

function approxTokens(s: string): number { return Math.ceil(s.length / 4); }
function normRel(corpusRoot: string, abs: string): string { return relative(corpusRoot, abs).replace(/\\/g, "/"); }

function rgFileHits(corpusRoot: string, pattern: string): Set<string> {
  const r = spawnSync(
    "rg",
    ["--line-number", "--no-heading", "--color", "never", pattern, corpusRoot],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024 },
  );
  const stdout = r.stdout ?? "";
  const files = new Set<string>();
  for (const ln of stdout.split(/\r?\n/)) {
    if (!ln) continue;
    const m = ln.match(/^(.+?):(\d+):/);
    if (!m) continue;
    files.add(normRel(corpusRoot, m[1]));
  }
  return files;
}

interface Cell {
  query: string;
  substrate: string;
  recall: number;
  precision: number;
  f1: number;
  tokens: number;
  ms: number;
  returned: number;
  expected: number;
}

function fmtPct(x: number): string { return `${(x * 100).toFixed(0).padStart(3)}%`; }

async function main(): Promise<void> {
  let docs: CorpusDoc[];
  try {
    docs = discoverCorpus(DEFAULT_CORPUS_ROOT);
  } catch (err) {
    process.stdout.write(`Corpus check failed: ${(err as Error).message}\n`);
    const path = writeResult("conversational-chunked", {
      status: "skipped",
      reason: (err as Error).message,
      generated_at: new Date().toISOString(),
    });
    process.stdout.write(`Wrote ${path}\n`);
    return;
  }
  const corpusRoot = DEFAULT_CORPUS_ROOT;
  process.stdout.write(`Corpus: ${corpusRoot}\n`);
  process.stdout.write(`Files: ${docs.length} (${totalLines(docs)} lines, ${(totalBytes(docs) / 1024).toFixed(0)} KB)\n`);

  const chunks = chunkCorpus(docs);
  const stats = chunkStats(docs, chunks);
  process.stdout.write(
    `Chunks: ${stats.total_chunks} (${stats.mean_chunks_per_file.toFixed(1)} per file; ` +
    `${stats.files_without_headings} markdown files had no headings)\n\n`,
  );

  // Build embedding index over chunks.
  const embedDocs = chunks.map((c) => ({ id: c.id, text: c.text }));
  process.stdout.write(`Building section-level embedding index over ${embedDocs.length} chunks...\n`);
  const tIdx = Date.now();
  const index = await buildIndex(embedDocs);
  process.stdout.write(`Index built in ${Date.now() - tIdx} ms.\n\n`);

  // Pre-compute per-chunk token cost (so we can sum the top-k cost honestly).
  const chunkTokens = new Map<string, number>();
  for (const c of chunks) chunkTokens.set(c.id, approxTokens(c.text));
  const chunkFile = new Map<string, string>();
  for (const c of chunks) chunkFile.set(c.id, c.file);

  const cells: Cell[] = [];
  for (const q of QUERIES) {
    const gt = rgFileHits(corpusRoot, q.pattern);
    if (gt.size === 0) {
      process.stdout.write(`[warn] no ground truth for "${q.label}" — skipping\n`);
      continue;
    }
    // k = number of expected ground-truth files. We then de-dup the
    // returned chunks to files for the recall metric.
    const t0 = Date.now();
    // Ask for more chunks than files because chunks-per-file expand the
    // top-k space; the de-dup keeps the cell small.
    const topHits = await topK(index, q.prompt, Math.max(gt.size * 3, 5));
    const ms = Date.now() - t0;
    const files = new Set<string>();
    let tokens = 0;
    for (const h of topHits) {
      const f = chunkFile.get(h.id);
      if (!f) continue;
      // Stop once we have enough distinct files.
      if (files.size >= gt.size) break;
      files.add(f);
      tokens += chunkTokens.get(h.id) ?? 0;
    }
    let tp = 0;
    for (const e of gt) if (files.has(e)) tp++;
    const recall = gt.size === 0 ? 1 : tp / gt.size;
    const precision = files.size === 0 ? 0 : tp / files.size;
    const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
    cells.push({
      query: q.label,
      substrate: "embed-chunked",
      recall,
      precision,
      f1,
      tokens,
      ms,
      returned: files.size,
      expected: gt.size,
    });
  }

  process.stdout.write("\n## Per-query results (chunked embeddings)\n\n");
  process.stdout.write("| query | recall | prec | F1 | tokens | ms | files/exp |\n");
  process.stdout.write("| :--- | ---: | ---: | ---: | ---: | ---: | ---: |\n");
  for (const c of cells) {
    process.stdout.write(
      `| ${c.query} | ${fmtPct(c.recall)} | ${fmtPct(c.precision)} | ${fmtPct(c.f1)} | ${c.tokens} | ${c.ms} | ${c.returned}/${c.expected} |\n`,
    );
  }

  process.stdout.write("\n## Aggregate\n\n");
  const mean = (k: keyof Cell) => cells.reduce((a, c) => a + (c[k] as number), 0) / Math.max(1, cells.length);
  const m = { recall: mean("recall"), prec: mean("precision"), f1: mean("f1"), tokens: mean("tokens"), ms: mean("ms") };
  process.stdout.write("| substrate | mean recall | mean prec | mean F1 | mean tokens | mean ms |\n");
  process.stdout.write("| :--- | ---: | ---: | ---: | ---: | ---: |\n");
  process.stdout.write(`| embed-chunked | ${fmtPct(m.recall)} | ${fmtPct(m.prec)} | ${fmtPct(m.f1)} | ${m.tokens.toFixed(0)} | ${m.ms.toFixed(0)} |\n`);

  const path = writeResult("conversational-chunked", {
    corpus_source: corpusRoot,
    corpus_files: docs.length,
    corpus_lines: totalLines(docs),
    chunked_documents: chunks.length,
    cells,
    summary: { "embed-chunked": m },
    generated_at: new Date().toISOString(),
  });
  process.stdout.write(`\nWrote ${path}\n`);
}

main().catch((err) => {
  process.stderr.write(`chunked benchmark failed: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
