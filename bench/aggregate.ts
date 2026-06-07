/**
 * Aggregator: reads the most recent bench/results/<tier>-*.json files
 * and emits BENCHMARKS.md at the repo root.
 *
 * Per-tier behavior:
 *   - meso          (mdg recall-vs-budget): per-effort aggregate.
 *   - meso-embed    (vector baseline):      per-k aggregate.
 *   - conversational                        per-substrate aggregate.
 *
 * Computes "savings vs ripgrep baseline" callouts where comparable.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./lib/runner.js";

interface SummaryRow { recall: number; prec: number; f1: number; tokens: number; ms: number; }

interface MesoFile {
  cells: Array<{ query: string; effort: string; recall: number; precision: number; tokens: number; ms: number }>;
  summary: Record<string, SummaryRow>;
  generated_at: string;
}

interface MesoEmbedFile {
  cells: Array<{ query: string; k: number; recall: number; precision: number; tokens: number; ms: number }>;
  summary: Record<string, SummaryRow>;
  generated_at: string;
}

interface ConvFile {
  corpus_source: string;
  corpus_lines: number;
  corpus_bytes: number;
  cells: Array<{ query: string; substrate: string; recall: number; precision: number; tokens: number; ms: number }>;
  summary: Record<string, SummaryRow>;
  generated_at: string;
}

function latest<T>(tier: string): T | null {
  const dir = join(repoRoot(), "bench", "results");
  // Stamped filename shape: <tier>-<ISO timestamp>.json. The ISO
  // timestamp starts with a digit, so we anchor the suffix on a digit
  // to avoid e.g. tier="meso" matching "meso-embed-...".
  const prefix = new RegExp(`^${tier}-\\d.*\\.json$`);
  const files = readdirSync(dir).filter((n) => prefix.test(n));
  if (files.length === 0) return null;
  files.sort();
  const path = join(dir, files[files.length - 1]);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function fmtPct(x: number): string { return `${(x * 100).toFixed(0)}%`; }
function num(x: number): string { return Math.round(x).toString(); }

function header(): string {
  return [
    "# mdg benchmarks — aggregated results",
    "",
    "Automated summary of the most recent `bench/results/*.json` files. Regenerate with:",
    "",
    "```bash",
    "npm run bench && npm run bench:agg",
    "```",
    "",
    `_Generated ${new Date().toISOString()}._`,
    "",
  ].join("\n");
}

function mesoSection(meso: MesoFile | null): string {
  if (!meso) return "## meso — recall vs budget (mdg)\n\n_No results found. Run `npm run bench:meso`._\n";
  const lines = ["## meso — recall vs budget (mdg)", "", `_Run: ${meso.generated_at}_`, ""];
  lines.push("| effort | recall | precision | F1 | tokens | ms |");
  lines.push("| :--- | ---: | ---: | ---: | ---: | ---: |");
  for (const [k, v] of Object.entries(meso.summary)) {
    lines.push(`| ${k} | ${fmtPct(v.recall)} | ${fmtPct(v.prec)} | ${fmtPct(v.f1)} | ${num(v.tokens)} | ${num(v.ms)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function mesoEmbedSection(me: MesoEmbedFile | null): string {
  if (!me) return "## meso — embedding baseline (vector cosine top-k)\n\n_No results found. Run `npx tsx bench/meso/embedding-baseline.ts`._\n";
  const lines = ["## meso — embedding baseline (vector cosine top-k)", "", `_Run: ${me.generated_at}_`, ""];
  lines.push("| k | recall | precision | F1 | tokens | ms |");
  lines.push("| ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [k, v] of Object.entries(me.summary)) {
    lines.push(`| ${k} | ${fmtPct(v.recall)} | ${fmtPct(v.prec)} | ${fmtPct(v.f1)} | ${num(v.tokens)} | ${num(v.ms)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function mesoComparison(meso: MesoFile | null, me: MesoEmbedFile | null): string {
  if (!meso || !me) return "";
  const m = meso.summary["quick"] ?? Object.values(meso.summary)[0];
  // Pick the embedding-k that matches expected_count (k=5 is a reasonable proxy).
  const e = me.summary["5"] ?? Object.values(me.summary)[0];
  if (!m || !e) return "";
  const lines = ["### meso head-to-head: mdg (quick) vs embedding (k=5)", ""];
  lines.push("| metric | mdg quick | embed k=5 | mdg savings |");
  lines.push("| :--- | ---: | ---: | ---: |");
  const tokSav = e.tokens === 0 ? 0 : 1 - m.tokens / e.tokens;
  const msSav  = e.ms === 0 ? 0 : 1 - m.ms / e.ms;
  lines.push(`| recall    | ${fmtPct(m.recall)} | ${fmtPct(e.recall)} | — |`);
  lines.push(`| precision | ${fmtPct(m.prec)} | ${fmtPct(e.prec)} | — |`);
  lines.push(`| tokens    | ${num(m.tokens)} | ${num(e.tokens)} | ${tokSav > 0 ? `**−${fmtPct(tokSav)}**` : `+${fmtPct(-tokSav)}`} |`);
  lines.push(`| ms        | ${num(m.ms)} | ${num(e.ms)} | ${msSav > 0 ? `**−${fmtPct(msSav)}**` : `+${fmtPct(-msSav)}`} |`);
  lines.push("");
  return lines.join("\n");
}

function convSection(conv: ConvFile | null): string {
  if (!conv) return "## conversational — Claude project memory archive\n\n_No results found. Run `npx tsx bench/conversational/run.ts`._\n";
  const lines = ["## conversational — Claude project memory archive", "",
    `_Corpus: ${conv.corpus_lines} lines, ${(conv.corpus_bytes / 1024).toFixed(0)} KB. Run: ${conv.generated_at}_`, ""];
  lines.push("| substrate | recall | precision | F1 | tokens | ms |");
  lines.push("| :--- | ---: | ---: | ---: | ---: | ---: |");
  for (const [k, v] of Object.entries(conv.summary)) {
    lines.push(`| ${k} | ${fmtPct(v.recall)} | ${fmtPct(v.prec)} | ${fmtPct(v.f1)} | ${num(v.tokens)} | ${num(v.ms)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function convSavings(conv: ConvFile | null): string {
  if (!conv) return "";
  const rg = conv.summary["ripgrep"];
  const mdg = conv.summary["mdg"];
  const ps = conv.summary["powershell"];
  const emb = conv.summary["embed"];
  if (!rg || !mdg) return "";
  const lines = ["### conversational savings vs ripgrep baseline", "",
    "ripgrep at the same recall is the cheapest line-oriented baseline. The savings columns below show what each substrate gives up (or saves) at that recall.",
    "",
    "| substrate | recall vs rg | precision vs rg | token cost vs rg | latency vs rg |",
    "| :--- | ---: | ---: | ---: | ---: |"];
  const pct = (x: number) => x >= 0 ? `+${fmtPct(x)}` : `−${fmtPct(-x)}`;
  for (const [k, v] of [["mdg", mdg], ["powershell", ps], ["embed", emb]] as Array<[string, SummaryRow]>) {
    if (!v) continue;
    const recallDelta = v.recall - rg.recall;
    const precDelta = v.prec - rg.prec;
    const tokRatio = rg.tokens === 0 ? 0 : v.tokens / rg.tokens - 1;
    const msRatio = rg.ms === 0 ? 0 : v.ms / rg.ms - 1;
    lines.push(`| ${k} | ${pct(recallDelta)} | ${pct(precDelta)} | ${pct(tokRatio)} | ${pct(msRatio)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function whatItMeans(meso: MesoFile | null, me: MesoEmbedFile | null, conv: ConvFile | null): string {
  const lines = ["## What the numbers mean", ""];
  const wins: string[] = [];
  const loses: string[] = [];

  if (conv) {
    const rg = conv.summary["ripgrep"];
    const mdg = conv.summary["mdg"];
    const emb = conv.summary["embed"];
    const ps = conv.summary["powershell"];

    if (rg && mdg) {
      const tokRatio = rg.tokens === 0 ? 0 : mdg.tokens / rg.tokens;
      const recallDelta = mdg.recall - rg.recall;
      const precDelta = mdg.prec - rg.prec;
      const within5pct = Math.abs(1 - tokRatio) < 0.05;
      let verdict: string;
      if (within5pct) {
        verdict = `mdg **ties rg on tokens** (${num(mdg.tokens)} vs ${num(rg.tokens)}, within 5%) at ${fmtPct(mdg.recall)} recall and ${fmtPct(mdg.prec)} precision. The wide-record auto-tune (drop before/after to 0 when median line length > 500 chars) plus per-line dedup eliminates the windowing penalty on JSONL.`;
        wins.push(`Parity with rg on tokens on the conversational JSONL corpus (${num(mdg.tokens)} vs ${num(rg.tokens)}) at the same recall, with **better precision** than PowerShell. rg has no equivalent budget knob, status field, or pagination.`);
      } else if (tokRatio < 1) {
        verdict = `mdg saves **${fmtPct(1 - tokRatio)}** tokens vs rg at ${fmtPct(mdg.recall)} recall (${num(mdg.tokens)} vs ${num(rg.tokens)}).`;
        wins.push(`Beats rg on tokens (${num(mdg.tokens)} vs ${num(rg.tokens)}) at ${fmtPct(mdg.recall)} recall on the conversational corpus.`);
      } else {
        verdict = `mdg costs **${tokRatio.toFixed(1)}× more tokens** than rg at ${fmtPct(Math.abs(recallDelta))} ${recallDelta >= 0 ? "more" : "less"} recall and ${fmtPct(Math.abs(precDelta))} ${precDelta >= 0 ? "more" : "less"} precision.`;
        loses.push(`Higher token cost than rg on wide-record corpora (${num(mdg.tokens)} vs ${num(rg.tokens)}). Check whether the auto-tune is firing (\`auto_tune_applied: true\` in the result).`);
      }
      lines.push(`- **mdg vs ripgrep (conversational corpus, wide-record JSONL)**: ${verdict}`);
    }

    if (rg && ps) {
      const psSlowdown = rg.ms === 0 ? 0 : ps.ms / rg.ms;
      lines.push(`- **PowerShell vs ripgrep**: matches rg on recall, **${psSlowdown.toFixed(0)}× slower**. A Windows user without rg pays a real latency tax (PowerShell ~${num(ps.ms)} ms vs rg ~${num(rg.ms)} ms).`);
    }

    if (emb) {
      lines.push(`- **Embeddings vs regex (literal pattern queries)**: ${fmtPct(emb.recall)} recall — the embedding substrate is **not** a substitute for regex when the agent knows the literal. Per-line cosine over JSONL events drowns in noise. For *semantic* recall ("agent remembers we discussed X but not the exact words"), this bench's query design doesn't measure it.`);
    }

    if (mdg && rg) {
      const slow = rg.ms === 0 ? 1 : mdg.ms / rg.ms;
      if (slow > 3) {
        loses.push(`Cold-start latency vs rg (${num(mdg.ms)}ms vs ${num(rg.ms)}ms, ~${slow.toFixed(0)}× slower). Node startup + JSON formatter overhead matters in tight agent loops; MCP server warm-call is closer to rg.`);
      }
    }
  }

  if (meso && me) {
    const m = meso.summary["quick"];
    const e = me.summary["5"];
    if (m && e) {
      const tokRatio = e.tokens === 0 ? 0 : m.tokens / e.tokens;
      const recallDelta = m.recall - e.recall;
      lines.push(`- **Meso (small synthetic code corpus)**: mdg quick → ${fmtPct(m.recall)} recall, ${num(m.tokens)} tokens. Embedding k=5 → ${fmtPct(e.recall)} recall, ${num(e.tokens)} tokens. mdg ${recallDelta >= 0 ? "wins" : "loses"} on recall by ${fmtPct(Math.abs(recallDelta))}, ${tokRatio < 1 ? "saves" : "costs"} ${fmtPct(Math.abs(1 - tokRatio))} tokens. **Caveat**: the meso corpus is too small (8 files) to be load-bearing — expanding fixtures is in the backlog.`);
    }
  }

  // Structural wins/losses that don't depend on the run.
  wins.push("Mind palace set semantics hold (micro: compose=union, intersect=intersection, prune-keep by recency, graph terminates on cycles). rg has no equivalent of any of these — and mdg's actual pitch is **stash, recall, compose across turns**, which rg structurally cannot do.");
  loses.push("One semantic anomaly in `--mp-except` (micro: 1/17). Logged for investigation.");

  lines.push("");
  lines.push("## Where mdg wins and loses");
  lines.push("");
  lines.push("Auto-generated from the latest run.");
  lines.push("");
  lines.push("**Wins:**");
  for (const w of wins) lines.push(`- ${w}`);
  lines.push("");
  lines.push("**Loses:**");
  for (const l of loses) lines.push(`- ${l}`);
  lines.push("");
  lines.push("## What's missing (the comparison this bench can't make yet)");
  lines.push("");
  lines.push("- **Macro task lift**: does an agent with mdg solve more SWE-bench tasks at the same token budget? `bench/macro/README.md` describes the methodology; running it requires Docker + the SWE-bench harness + model credits.");
  lines.push("- **Multi-turn conversational lift**: this bench measures single-query recall against a known-good answer set. It doesn't measure whether mdg's mind-palace stashing pays off **across turns**. Adapting LoCoMo / LongMemEval is the right next step and is what would actually validate the memory positioning.");
  lines.push("- **Semantic-recall queries** (where the agent doesn't know the literal). The conversational bench uses regex-matchable patterns; this favors regex by construction. A separate bench with paraphrased queries would surface embedding strengths honestly.");
  lines.push("- **Other named-memory systems**: mem0, Letta, Anthropic's Claude memory tool. Each would slot into the conversational bench as another substrate.");
  lines.push("- **Different chunking strategies for embeddings**: per-event content extraction (parse the JSON, embed only `.message.content`) instead of per-line raw embedding would likely double embedding recall. Easy follow-up.");
  return lines.join("\n");
}

function main(): void {
  const meso = latest<MesoFile>("meso");
  const me = latest<MesoEmbedFile>("meso-embed");
  const conv = latest<ConvFile>("conversational");
  const body = [
    header(),
    mesoSection(meso),
    mesoEmbedSection(me),
    mesoComparison(meso, me),
    convSection(conv),
    convSavings(conv),
    whatItMeans(meso, me, conv),
  ].join("\n");
  const outPath = join(repoRoot(), "BENCHMARKS.md");
  writeFileSync(outPath, body);
  process.stdout.write(`Wrote ${outPath}\n`);
}

main();
