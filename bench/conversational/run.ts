/**
 * Conversational benchmark driver.
 *
 * Pipeline:
 *   1. Snapshot the Claude project archive .jsonl for this project to
 *      a tmp file so the corpus is frozen for the duration of the run.
 *   2. For each query:
 *      a. derive ground-truth lines via literal rg on the snapshot.
 *      b. run each substrate (mdg, rg, PowerShell Select-String, embeddings)
 *      c. record recall / precision / token cost / wall-clock.
 *   3. Aggregate per-substrate means.
 *   4. Write the result JSON to bench/results/conversational-<ts>.json.
 */

import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { QUERIES, type QuerySpec } from "./queries.js";
import { writeResult, repoRoot } from "../lib/runner.js";
import { buildIndex, topK, type VectorIndex } from "../lib/embed.js";

// ─── Corpus discovery ───────────────────────────────────────────────

const PROJECT_ARCHIVE = join(
  homedir(),
  ".claude",
  "projects",
  "C--Users-atooz-Programming-ai-utils-memory-markdowngraphcli",
);

function findCorpus(): string {
  if (!existsSync(PROJECT_ARCHIVE)) {
    throw new Error(`Claude project archive not found at ${PROJECT_ARCHIVE}`);
  }
  // Pick the largest .jsonl file (most history).
  const entries = readdirSync(PROJECT_ARCHIVE).filter((n) => n.endsWith(".jsonl"));
  let best = "";
  let bestSize = -1;
  for (const e of entries) {
    const abs = join(PROJECT_ARCHIVE, e);
    const s = statSync(abs).size;
    if (s > bestSize) {
      best = abs;
      bestSize = s;
    }
  }
  if (!best) throw new Error("No .jsonl found in archive");
  return best;
}

function snapshotCorpus(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mdg-conv-bench-"));
  const dst = join(dir, "corpus.jsonl");
  copyFileSync(src, dst);
  return dst;
}

function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// ─── Ground truth: literal rg matches on snapshot ───────────────────

function rgLines(snapshot: string, pattern: string): { lines: number[]; ms: number; stdout: string } {
  const t0 = Date.now();
  const r = spawnSync("rg", ["--line-number", "--no-heading", "--color", "never", pattern, snapshot], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 128 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const stdout = r.stdout ?? "";
  const lines: number[] = [];
  for (const ln of stdout.split(/\r?\n/)) {
    if (!ln) continue;
    const m = ln.match(/^(\d+):/);
    if (m) lines.push(parseInt(m[1], 10));
  }
  return { lines, ms, stdout };
}

// ─── Substrate runners ──────────────────────────────────────────────

interface SubResult {
  /** 1-indexed line numbers the substrate returned. */
  lines: number[];
  /** Approximate token cost of the returned context. */
  tokens: number;
  /** Wall-clock ms. */
  ms: number;
}

function runMdgSub(snapshot: string, pattern: string): SubResult {
  const t0 = Date.now();
  const r = spawnSync(
    "node",
    [join(repoRoot(), "dist", "index.js"), pattern, "--in", snapshot, "--effort", "normal", "--format", "json", "--no-color"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  const ms = Date.now() - t0;
  let json: { nodes?: Array<{ match_line: number; tokens_approx?: number }>; total_tokens?: number } | null = null;
  try { json = JSON.parse(r.stdout); } catch { /* ignore */ }
  const lines = (json?.nodes ?? []).map((n) => n.match_line);
  return { lines, tokens: json?.total_tokens ?? 0, ms };
}

function runRgSub(snapshot: string, pattern: string): SubResult {
  const { lines, ms, stdout } = rgLines(snapshot, pattern);
  return { lines, tokens: approxTokens(stdout), ms };
}

function runPowerShellSub(snapshot: string, pattern: string): SubResult {
  const t0 = Date.now();
  // -SimpleMatch off (default), -CaseSensitive on by default; we use the
  // regex behavior. -List=false returns all matches. We capture
  // LineNumber + Line.
  const ps = [
    "$ErrorActionPreference='Stop';",
    `$m = Select-String -Path '${snapshot.replace(/'/g, "''")}' -Pattern '${pattern.replace(/'/g, "''")}';`,
    "$m | ForEach-Object { \"$($_.LineNumber):$($_.Line)\" }",
  ].join(" ");
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  const ms = Date.now() - t0;
  const stdout = r.stdout ?? "";
  const lines: number[] = [];
  for (const ln of stdout.split(/\r?\n/)) {
    const m = ln.match(/^(\d+):/);
    if (m) lines.push(parseInt(m[1], 10));
  }
  return { lines, tokens: approxTokens(stdout), ms };
}

async function runEmbedSub(
  index: VectorIndex,
  rawLines: string[],
  prompt: string,
  k: number,
): Promise<SubResult> {
  const t0 = Date.now();
  const hits = await topK(index, prompt, k);
  const ms = Date.now() - t0;
  const lines = hits
    .map((h) => parseInt(h.id, 10))
    .filter((n) => Number.isFinite(n));
  // Tokens = approx sum of the top-k JSONL line bodies the agent would load.
  let tokens = 0;
  for (const ln of lines) {
    const idx = ln - 1;
    if (idx >= 0 && idx < rawLines.length) tokens += approxTokens(rawLines[idx]);
  }
  return { lines, tokens, ms };
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

function score(gt: number[], sub: SubResult, query: string, substrate: string): Cell {
  const exp = new Set(gt);
  const ret = new Set(sub.lines);
  let tp = 0;
  for (const e of exp) if (ret.has(e)) tp++;
  const recall = exp.size === 0 ? 1 : tp / exp.size;
  const precision = ret.size === 0 ? 0 : tp / ret.size;
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  return {
    query,
    substrate,
    recall,
    precision,
    f1,
    tokens: sub.tokens,
    ms: sub.ms,
    returned: ret.size,
    expected: exp.size,
  };
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0).padStart(3)}%`;
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const src = findCorpus();
  const snapshot = snapshotCorpus(src);
  const corpusSize = statSync(snapshot).size;
  const rawLines = readFileSync(snapshot, "utf8").split(/\r?\n/);
  process.stdout.write(`Corpus: ${src}\n`);
  process.stdout.write(`Snapshot: ${snapshot} (${corpusSize} bytes, ${rawLines.length} lines)\n\n`);

  // Build vector index over per-line documents.
  // Skip empty lines (they have no signal).
  const docs: Array<{ id: string; text: string }> = [];
  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i].trim();
    if (!t) continue;
    // Truncate very long lines so the embed call is bounded.
    docs.push({ id: String(i + 1), text: t.slice(0, 1024) });
  }
  process.stdout.write(`Building embedding index over ${docs.length} non-empty lines (first run downloads model)...\n`);
  const tIdx = Date.now();
  const index = await buildIndex(docs);
  process.stdout.write(`Index built in ${Date.now() - tIdx} ms.\n\n`);

  const cells: Cell[] = [];

  for (const q of QUERIES) {
    const gt = rgLines(snapshot, q.pattern).lines;
    if (gt.length === 0) {
      process.stdout.write(`[warn] no ground truth for "${q.label}" — skipping\n`);
      continue;
    }
    const mdgR = runMdgSub(snapshot, q.pattern);
    const rgR = runRgSub(snapshot, q.pattern);
    const psR = runPowerShellSub(snapshot, q.pattern);
    // For embeddings, k = |ground truth| so it gets a fair shot.
    const embR = await runEmbedSub(index, rawLines, q.prompt, gt.length);

    cells.push(score(gt, mdgR, q.label, "mdg"));
    cells.push(score(gt, rgR, q.label, "ripgrep"));
    cells.push(score(gt, psR, q.label, "powershell"));
    cells.push(score(gt, embR, q.label, "embed"));
  }

  // Per-query, per-substrate table
  process.stdout.write("\n## Per-query results\n\n");
  process.stdout.write("| query | substrate | recall | prec | F1 | tokens | ms | ret/exp |\n");
  process.stdout.write("| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |\n");
  for (const c of cells) {
    process.stdout.write(
      `| ${c.query} | ${c.substrate} | ${fmtPct(c.recall)} | ${fmtPct(c.precision)} | ${fmtPct(c.f1)} | ${c.tokens} | ${c.ms} | ${c.returned}/${c.expected} |\n`,
    );
  }

  // Per-substrate aggregate
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
    corpus_source: src,
    corpus_lines: rawLines.length,
    corpus_bytes: corpusSize,
    cells,
    summary,
    generated_at: new Date().toISOString(),
  });
  process.stdout.write(`\nWrote ${path}\n`);
}

main().catch((err) => {
  process.stderr.write(`conversational benchmark failed: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
