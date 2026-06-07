/**
 * Memory-corpus benchmark driver (formerly "conversational").
 *
 * Pivoted off JSONL conversation transcripts to a "real memory system
 * shape" corpus: markdown specs, JSON metadata, and supporting docs
 * from another project's `conductor/tracks/`. This is what mdg
 * actually browses when integrated into a memory system (mem0, Letta,
 * Anthropic memory tool, or a bespoke setup).
 *
 * Default corpus: oasis-sleek (34 tracks). Override with
 * MDG_BENCH_CORPUS_ROOT=<other project root>.
 *
 * Pipeline (unchanged from JSONL version):
 *   1. Discover the corpus.
 *   2. For each query:
 *      a. Derive ground-truth (file, line) tuples via literal rg on
 *         the corpus root.
 *      b. Run each substrate (mdg, rg, PowerShell, embed).
 *      c. Score recall / precision / token cost / wall-clock.
 *   3. Aggregate per-substrate means.
 *   4. Write bench/results/conversational-<ts>.json.
 */

import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { QUERIES, type QuerySpec } from "./queries.js";
import { writeResult, repoRoot } from "../lib/runner.js";
import { buildIndex, topK, type VectorIndex } from "../lib/embed.js";
import { discoverCorpus, DEFAULT_CORPUS_ROOT, totalLines, totalBytes, type CorpusDoc } from "../lib/corpus.js";
import { loadEnvFile } from "../lib/env.js";

loadEnvFile();

function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function normRel(corpusRoot: string, abs: string): string {
  return relative(corpusRoot, abs).replace(/\\/g, "/");
}

// ─── Ground truth: literal rg matches on the corpus root ─────────────

/**
 * File-level recall on a memory-system-style corpus. Each substrate
 * returns the SET OF FILES it considers relevant for the query.
 * Embedding is per-file (each spec/plan is a coherent memory unit);
 * this matches how mem0/Letta would store and retrieve documents.
 */
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

interface SubResult {
  /** Set of relative file paths the substrate considers relevant. */
  files: Set<string>;
  /** Approximate token cost of the returned context. */
  tokens: number;
  /** Wall-clock ms. */
  ms: number;
}

function runMdgSub(corpusRoot: string, pattern: string): SubResult {
  const t0 = Date.now();
  const r = spawnSync(
    "node",
    // Use --effort scan: index mode (200 nodes / 20 token windows).
    // This is the "first turn" mode an agent should call for a hit
    // list across the search space. Recall should match rg when hits
    // fit under max_nodes; cost scales O(hits).
    [join(repoRoot(), "dist", "index.js"), pattern, "--in", corpusRoot, "--effort", "scan", "--format", "json", "--no-color"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  const ms = Date.now() - t0;
  let json: { nodes?: Array<{ source: { id: string }; match_line: number }>; total_tokens?: number } | null = null;
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

function buildEmbedDocsFromCorpus(docs: CorpusDoc[]): EmbedDoc[] {
  // Per-FILE documents — each spec/plan/metadata is one coherent
  // memory unit. Embedding model handles up to ~512 tokens well; we
  // pass the first ~3KB which covers the title + intro + first sections
  // of most specs.
  return docs.map((d) => ({
    id: d.rel,
    text: d.content.slice(0, 3000),
    tokens: approxTokens(d.content),
  }));
}

async function runEmbedSub(
  index: VectorIndex,
  embedDocs: EmbedDoc[],
  prompt: string,
  k: number,
): Promise<SubResult> {
  const t0 = Date.now();
  const topHits = await topK(index, prompt, k);
  const ms = Date.now() - t0;
  const files = new Set<string>();
  let tokens = 0;
  const byId = new Map(embedDocs.map((d) => [d.id, d.tokens]));
  for (const h of topHits) {
    files.add(h.id);
    tokens += byId.get(h.id) ?? 0;
  }
  return { files, tokens, ms };
}

// ─── Scoring ────────────────────────────────────────────────────────

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
    query,
    substrate,
    recall,
    precision,
    f1,
    tokens: sub.tokens,
    ms: sub.ms,
    returned: sub.files.size,
    expected: gt.size,
  };
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0).padStart(3)}%`;
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let docs: CorpusDoc[];
  try {
    docs = discoverCorpus(DEFAULT_CORPUS_ROOT);
  } catch (err) {
    process.stdout.write(`Corpus check failed: ${(err as Error).message}\n`);
    const path = writeResult("conversational", {
      status: "skipped",
      reason: (err as Error).message,
      generated_at: new Date().toISOString(),
    });
    process.stdout.write(`Wrote ${path}\n`);
    return;
  }
  const corpusRoot = DEFAULT_CORPUS_ROOT;
  process.stdout.write(`Corpus root: ${corpusRoot}\n`);
  process.stdout.write(`Files: ${docs.length} (${totalLines(docs)} total lines, ${(totalBytes(docs) / 1024).toFixed(0)} KB)\n\n`);

  // Build embedding index (per-line documents).
  const embedDocs = buildEmbedDocsFromCorpus(docs);
  process.stdout.write(`Building embedding index over ${embedDocs.length} files (per-file granularity)...\n`);
  const tIdx = Date.now();
  const index = await buildIndex(embedDocs);
  process.stdout.write(`Index built in ${Date.now() - tIdx} ms.\n\n`);

  const cells: Cell[] = [];

  for (const q of QUERIES) {
    const gt = rgFileHits(corpusRoot, q.pattern).files;
    if (gt.size === 0) {
      process.stdout.write(`[warn] no ground truth for "${q.label}" — skipping\n`);
      continue;
    }
    process.stdout.write(`  [${q.label}] gt=${gt.size}\n`);
    const mdgR = runMdgSub(corpusRoot, q.pattern);
    process.stdout.write(`    mdg done in ${mdgR.ms}ms\n`);
    const rgR  = runRgSub(corpusRoot, q.pattern);
    process.stdout.write(`    rg done in ${rgR.ms}ms\n`);
    const psR  = runPowerShellSub(corpusRoot, q.pattern);
    process.stdout.write(`    powershell done in ${psR.ms}ms\n`);
    const embR = await runEmbedSub(index, embedDocs, q.prompt, gt.size);
    process.stdout.write(`    embed done in ${embR.ms}ms\n`);

    cells.push(score(gt, mdgR, q.label, "mdg"));
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

  process.stdout.write("\n## Per-substrate aggregate (mean across queries)\n\n");
  process.stdout.write("| substrate | mean recall | mean prec | mean F1 | mean tokens | mean ms |\n");
  process.stdout.write("| :--- | ---: | ---: | ---: | ---: | ---: |\n");
  const subs = [...new Set(cells.map((c) => c.substrate))];
  const summary: Record<string, { recall: number; prec: number; f1: number; tokens: number; ms: number }> = {};
  for (const s of subs) {
    const g = cells.filter((c) => c.substrate === s);
    const mean = (k: keyof Cell) => g.reduce((a, c) => a + (c[k] as number), 0) / g.length;
    const m = {
      recall: mean("recall"),
      prec: mean("precision"),
      f1: mean("f1"),
      tokens: mean("tokens"),
      ms: mean("ms"),
    };
    summary[s] = m;
    process.stdout.write(
      `| ${s} | ${fmtPct(m.recall)} | ${fmtPct(m.prec)} | ${fmtPct(m.f1)} | ${m.tokens.toFixed(0)} | ${m.ms.toFixed(0)} |\n`,
    );
  }

  const path = writeResult("conversational", {
    corpus_source: corpusRoot,
    corpus_lines: totalLines(docs),
    corpus_bytes: totalBytes(docs),
    corpus_files: docs.length,
    cells,
    summary,
    generated_at: new Date().toISOString(),
  });
  process.stdout.write(`\nWrote ${path}\n`);
}

main().catch((err) => {
  process.stderr.write(`benchmark failed: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
