/**
 * Typo-tolerance bench.
 *
 * For each query: derive ground truth from the CORRECT pattern via rg,
 * then run each substrate with the TYPO'd input. Which substrates still
 * find the answer?
 *
 *   rg                  expected: ~0% recall (literal mismatch)
 *   mpg (no fuzzy)      expected: ~0% recall (uses rg under the hood)
 *   mpg --fuzzy         expected: ≥ rg's correct-pattern recall
 *   embed               variable — semantic embedding may or may not bridge
 */

import { loadEnvFile } from "../lib/env.js";
loadEnvFile();

import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { QUERIES, type TypoQuery } from "./queries.js";
import { writeResult, repoRoot } from "../lib/runner.js";
import { buildIndex, topK } from "../lib/embed.js";
import { discoverCorpus, DEFAULT_CORPUS_ROOT, totalLines, totalBytes, type CorpusDoc } from "../lib/corpus.js";

function approxTokens(s: string): number { return Math.ceil(s.length / 4); }
function normRel(corpusRoot: string, abs: string): string { return relative(corpusRoot, abs).replace(/\\/g, "/"); }

function rgFileHits(corpusRoot: string, pattern: string): Set<string> {
  const r = spawnSync(
    "rg",
    ["--line-number", "--no-heading", "--color", "never", pattern, corpusRoot],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024 },
  );
  const files = new Set<string>();
  for (const ln of (r.stdout ?? "").split(/\r?\n/)) {
    const m = ln.match(/^(.+?):(\d+):/);
    if (m) files.add(normRel(corpusRoot, m[1]));
  }
  return files;
}

interface SubResult { files: Set<string>; tokens: number; ms: number; }

function runRgSub(corpusRoot: string, pattern: string): SubResult {
  const t0 = Date.now();
  const r = spawnSync("rg", ["--line-number", "--no-heading", "--color", "never", pattern, corpusRoot], { encoding: "utf8" });
  const files = new Set<string>();
  for (const ln of (r.stdout ?? "").split(/\r?\n/)) {
    const m = ln.match(/^(.+?):(\d+):/);
    if (m) files.add(normRel(corpusRoot, m[1]));
  }
  return { files, tokens: approxTokens(r.stdout ?? ""), ms: Date.now() - t0 };
}

function runMpgSub(corpusRoot: string, pattern: string, fuzzy: boolean): SubResult {
  const t0 = Date.now();
  const args = [join(repoRoot(), "dist", "index.js"), pattern, "--in", corpusRoot, "--effort", "scan", "--clip", "30", "--format", "json", "--no-color"];
  if (fuzzy) args.push("--fuzzy");
  const r = spawnSync("node", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  let json: { nodes?: Array<{ source: { id: string } }>; total_tokens?: number } | null = null;
  try { json = JSON.parse(r.stdout); } catch { /* */ }
  const files = new Set<string>();
  for (const n of json?.nodes ?? []) files.add(normRel(corpusRoot, n.source.id));
  return { files, tokens: json?.total_tokens ?? 0, ms: Date.now() - t0 };
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

function score(gt: Set<string>, sub: SubResult, query: string, substrate: string): Cell {
  let tp = 0;
  for (const f of gt) if (sub.files.has(f)) tp++;
  const recall = gt.size === 0 ? 1 : tp / gt.size;
  const precision = sub.files.size === 0 ? 0 : tp / sub.files.size;
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  return { query, substrate, recall, precision, f1, tokens: sub.tokens, ms: sub.ms, returned: sub.files.size, expected: gt.size };
}

function fmtPct(x: number): string { return `${(x * 100).toFixed(0).padStart(3)}%`; }

async function main(): Promise<void> {
  let docs: CorpusDoc[];
  try { docs = discoverCorpus(DEFAULT_CORPUS_ROOT); }
  catch (err) {
    const path = writeResult("typo", { status: "skipped", reason: (err as Error).message, generated_at: new Date().toISOString() });
    process.stdout.write(`Corpus check failed: ${(err as Error).message}\nWrote ${path}\n`);
    return;
  }
  const corpusRoot = DEFAULT_CORPUS_ROOT;
  process.stdout.write(`Corpus: ${corpusRoot} (${docs.length} files, ${totalLines(docs)} lines, ${(totalBytes(docs)/1024).toFixed(0)} KB)\n\n`);

  // Embedding index over per-file docs (paraphrased prompt query).
  const embedDocs = docs.map((d) => ({ id: d.rel, text: d.content.slice(0, 3000), tokens: approxTokens(d.content) }));
  process.stdout.write(`Building per-file embedding index...\n`);
  const t0 = Date.now();
  const index = await buildIndex(embedDocs);
  process.stdout.write(`Index built in ${Date.now() - t0} ms.\n\n`);

  const cells: Cell[] = [];

  for (const q of QUERIES) {
    const gt = rgFileHits(corpusRoot, q.correct);
    if (gt.size === 0) {
      process.stdout.write(`[warn] no ground truth for "${q.label}" (correct: ${q.correct}) — skipping\n`);
      continue;
    }

    // rg with TYPO'd pattern — expected to mostly miss.
    const rgR = runRgSub(corpusRoot, q.typo);
    // mpg without fuzzy with TYPO'd pattern — uses rg under the hood, same miss.
    const mpgPlain = runMpgSub(corpusRoot, q.typo, false);
    // mpg --fuzzy with TYPO'd pattern — should recover.
    const mpgFuzzy = runMpgSub(corpusRoot, q.typo, true);
    // embed with the typo'd query as a prompt.
    const k = gt.size;
    const tEmb = Date.now();
    const hits = await topK(index, q.typo, k);
    const embedFiles = new Set(hits.map((h) => h.id));
    const byId = new Map(embedDocs.map((d) => [d.id, d.tokens]));
    let embTokens = 0;
    for (const id of embedFiles) embTokens += byId.get(id) ?? 0;
    const embR: SubResult = { files: embedFiles, tokens: embTokens, ms: Date.now() - tEmb };

    cells.push(score(gt, rgR,      q.label, "rg"));
    cells.push(score(gt, mpgPlain, q.label, "mpg"));
    cells.push(score(gt, mpgFuzzy, q.label, "mpg-fuzzy"));
    cells.push(score(gt, embR,     q.label, "embed"));
  }

  process.stdout.write("\n## Per-query results\n\n");
  process.stdout.write("| query | substrate | recall | prec | F1 | tokens | ms | ret/exp |\n");
  process.stdout.write("| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |\n");
  for (const c of cells) {
    process.stdout.write(
      `| ${c.query} | ${c.substrate} | ${fmtPct(c.recall)} | ${fmtPct(c.precision)} | ${fmtPct(c.f1)} | ${c.tokens} | ${c.ms} | ${c.returned}/${c.expected} |\n`,
    );
  }

  process.stdout.write("\n## Per-substrate aggregate\n\n");
  process.stdout.write("| substrate | mean recall | mean prec | mean F1 | mean tokens | mean ms |\n");
  process.stdout.write("| :--- | ---: | ---: | ---: | ---: | ---: |\n");
  const subs = [...new Set(cells.map((c) => c.substrate))];
  const summary: Record<string, { recall: number; prec: number; f1: number; tokens: number; ms: number }> = {};
  for (const s of subs) {
    const g = cells.filter((c) => c.substrate === s);
    const mean = (k: keyof Cell) => g.reduce((a, c) => a + (c[k] as number), 0) / g.length;
    const m = { recall: mean("recall"), prec: mean("precision"), f1: mean("f1"), tokens: mean("tokens"), ms: mean("ms") };
    summary[s] = m;
    process.stdout.write(`| ${s} | ${fmtPct(m.recall)} | ${fmtPct(m.prec)} | ${fmtPct(m.f1)} | ${m.tokens.toFixed(0)} | ${m.ms.toFixed(0)} |\n`);
  }

  const path = writeResult("typo", { corpus_source: corpusRoot, cells, summary, generated_at: new Date().toISOString() });
  process.stdout.write(`\nWrote ${path}\n`);
}

main().catch((err) => { process.stderr.write(`typo bench failed: ${err.message}\n${err.stack}\n`); process.exit(1); });
