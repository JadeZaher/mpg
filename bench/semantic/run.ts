/**
 * Semantic-recall benchmark driver.
 *
 * Same corpus as conversational (oasis-sleek conductor tracks). The
 * twist: regex substrates receive a literal `rg_keyword`, embedding
 * receives a paraphrased `prompt` whose words do NOT appear verbatim
 * in the target files. We measure whether embeddings can find the
 * right files from a semantically-equivalent-but-lexically-different
 * query.
 *
 * Granularity: file-level. Each substrate returns a set of files it
 * considers relevant. Ground truth = files that contain rg_keyword.
 */

import { loadEnvFile } from "../lib/env.js";
loadEnvFile();

import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { QUERIES, type SemanticQuerySpec } from "./queries.js";
import { writeResult, repoRoot } from "../lib/runner.js";
import { buildIndex, topK } from "../lib/embed.js";
import { discoverCorpus, DEFAULT_CORPUS_ROOT, totalLines, totalBytes, type CorpusDoc } from "../lib/corpus.js";

function approxTokens(s: string): number { return Math.ceil(s.length / 4); }

function normRel(corpusRoot: string, abs: string): string {
  return relative(corpusRoot, abs).replace(/\\/g, "/");
}

// ─── Ground truth: files containing rg_keyword ──────────────────────

function rgFileHits(corpusRoot: string, pattern: string): { files: Set<string>; ms: number; stdout: string } {
  const t0 = Date.now();
  const r = spawnSync(
    "rg",
    ["--line-number", "--no-heading", "--color", "never", pattern, corpusRoot],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024 },
  );
  const ms = Date.now() - t0;
  const stdout = r.stdout ?? "";
  const files = new Set<string>();
  for (const ln of stdout.split(/\r?\n/)) {
    if (!ln) continue;
    const m = ln.match(/^(.+?):(\d+):/);
    if (!m) continue;
    files.add(normRel(corpusRoot, m[1]));
  }
  return { files, ms, stdout };
}

// ─── Substrate runners ──────────────────────────────────────────────

interface SubResult { files: Set<string>; tokens: number; ms: number; }

function runMpgSub(corpusRoot: string, pattern: string): SubResult {
  const t0 = Date.now();
  const r = spawnSync(
    "node",
    [join(repoRoot(), "dist", "index.js"), pattern, "--in", corpusRoot, "--effort", "normal", "--format", "json", "--no-color"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  const ms = Date.now() - t0;
  let json: { nodes?: Array<{ source: { id: string } }>; total_tokens?: number } | null = null;
  try { json = JSON.parse(r.stdout); } catch { /* ignore */ }
  const files = new Set<string>();
  for (const n of json?.nodes ?? []) files.add(normRel(corpusRoot, n.source.id));
  return { files, tokens: json?.total_tokens ?? 0, ms };
}

function runRgSub(corpusRoot: string, pattern: string): SubResult {
  const { files, ms, stdout } = rgFileHits(corpusRoot, pattern);
  return { files, tokens: approxTokens(stdout), ms };
}

function runPowerShellSub(corpusRoot: string, pattern: string): SubResult {
  const t0 = Date.now();
  const tracksDir = corpusRoot.replace(/\\/g, "/");
  const ps = [
    "$ErrorActionPreference='Stop';",
    `$files = Get-ChildItem -Path '${tracksDir.replace(/'/g, "''")}' -Recurse -Include '*.md','*.json' -File;`,
    `$m = $files | Select-String -Pattern '${pattern.replace(/'/g, "''")}';`,
    "$m | ForEach-Object { \"$($_.Path):$($_.LineNumber):$($_.Line)\" }",
  ].join(" ");
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  const ms = Date.now() - t0;
  const stdout = r.stdout ?? "";
  const files = new Set<string>();
  for (const ln of stdout.split(/\r?\n/)) {
    const m = ln.match(/^(.+?):(\d+):/);
    if (!m) continue;
    files.add(normRel(corpusRoot, m[1]));
  }
  return { files, tokens: approxTokens(stdout), ms };
}

interface EmbedDoc { id: string; text: string; tokens: number; }

function buildEmbedDocs(docs: CorpusDoc[]): EmbedDoc[] {
  return docs.map((d) => ({
    id: d.rel,
    text: d.content.slice(0, 3000),
    tokens: approxTokens(d.content),
  }));
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
  for (const e of gt) if (sub.files.has(e)) tp++;
  const recall = gt.size === 0 ? 1 : tp / gt.size;
  const precision = sub.files.size === 0 ? 0 : tp / sub.files.size;
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  return {
    query, substrate, recall, precision, f1,
    tokens: sub.tokens, ms: sub.ms,
    returned: sub.files.size, expected: gt.size,
  };
}

function fmtPct(x: number): string { return `${(x * 100).toFixed(0).padStart(3)}%`; }

async function main(): Promise<void> {
  let docs: CorpusDoc[];
  try {
    docs = discoverCorpus(DEFAULT_CORPUS_ROOT);
  } catch (err) {
    process.stdout.write(`Corpus check failed: ${(err as Error).message}\n`);
    const path = writeResult("semantic", {
      status: "skipped",
      reason: (err as Error).message,
      generated_at: new Date().toISOString(),
    });
    process.stdout.write(`Wrote ${path}\n`);
    return;
  }
  const corpusRoot = DEFAULT_CORPUS_ROOT;
  process.stdout.write(`Corpus: ${corpusRoot}\n`);
  process.stdout.write(`Files: ${docs.length} (${totalLines(docs)} lines, ${(totalBytes(docs) / 1024).toFixed(0)} KB)\n\n`);

  const embedDocs = buildEmbedDocs(docs);
  process.stdout.write(`Building per-file embedding index over ${embedDocs.length} files...\n`);
  const tIdx = Date.now();
  const index = await buildIndex(embedDocs);
  process.stdout.write(`Index built in ${Date.now() - tIdx} ms.\n\n`);

  const cells: Cell[] = [];
  for (const q of QUERIES) {
    const gt = rgFileHits(corpusRoot, q.rg_keyword).files;
    if (gt.size === 0) {
      process.stdout.write(`[warn] no ground truth for "${q.label}" (keyword ${q.rg_keyword}) — skipping\n`);
      continue;
    }
    const mpgR = runMpgSub(corpusRoot, q.rg_keyword);
    const rgR  = runRgSub(corpusRoot, q.rg_keyword);
    const psR  = runPowerShellSub(corpusRoot, q.rg_keyword);

    // Embedding gets the PARAPHRASED prompt — no literal overlap.
    const embTopK = await topK(index, q.prompt, gt.size);
    const embFiles = new Set(embTopK.map((h) => h.id));
    const byId = new Map(embedDocs.map((d) => [d.id, d.tokens]));
    let embTokens = 0;
    for (const id of embFiles) embTokens += byId.get(id) ?? 0;
    const embR: SubResult = { files: embFiles, tokens: embTokens, ms: 0 };

    cells.push(score(gt, mpgR, q.label, "mpg"));
    cells.push(score(gt, rgR,  q.label, "ripgrep"));
    cells.push(score(gt, psR,  q.label, "powershell"));
    cells.push(score(gt, embR, q.label, "embed"));
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
    process.stdout.write(
      `| ${s} | ${fmtPct(m.recall)} | ${fmtPct(m.prec)} | ${fmtPct(m.f1)} | ${m.tokens.toFixed(0)} | ${m.ms.toFixed(0)} |\n`,
    );
  }

  const path = writeResult("semantic", {
    corpus_source: corpusRoot,
    corpus_files: docs.length,
    corpus_lines: totalLines(docs),
    cells,
    summary,
    generated_at: new Date().toISOString(),
  });
  process.stdout.write(`\nWrote ${path}\n`);
}

main().catch((err) => {
  process.stderr.write(`semantic benchmark failed: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
