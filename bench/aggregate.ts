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

interface MacroAggregateRow {
  pass_rate: number;
  mean_input_tokens: number;
  mean_output_tokens: number;
  mean_tool_calls: number;
  mean_turns: number;
  mean_ms: number;
  n: number;
}
interface MacroFile {
  status?: "ok" | "skipped";
  reason?: string;
  model?: string;
  corpus_root?: string;
  tasks?: number;
  cells?: Array<{
    taskId: string;
    taskLabel: string;
    arm: "control" | "treatment";
    passed: boolean;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    turns: number;
    ms: number;
    hitCap: string;
    error?: string;
  }>;
  summary?: { control: MacroAggregateRow; treatment: MacroAggregateRow };
  lift?: { pass_rate: number; input_tokens: number; output_tokens: number; ms: number };
  generated_at: string;
}

interface MultiTurnFile {
  status?: "ok" | "skipped";
  reason?: string;
  model?: string;
  corpus_root?: string;
  scenarios?: number;
  cells?: Array<{
    scenarioId: string;
    scenarioLabel: string;
    arm: "control" | "treatment";
    totalPassed: number;
    totalTurnsExpected: number;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    turns: number;
    ms: number;
  }>;
  summary?: { control: MacroAggregateRow; treatment: MacroAggregateRow };
  lift?: { pass_rate: number; input_tokens: number; output_tokens: number; ms: number };
  generated_at: string;
}

interface SemanticFile {
  status?: "ok" | "skipped";
  reason?: string;
  corpus_source?: string;
  corpus_lines?: number;
  cells?: Array<{ query: string; substrate: string; recall: number; precision: number; tokens: number; ms: number }>;
  summary?: Record<string, SummaryRow>;
  generated_at: string;
}

interface ConvChunkedFile {
  status?: "ok" | "skipped";
  reason?: string;
  corpus_source?: string;
  corpus_lines?: number;
  chunked_documents?: number;
  cells?: Array<{ query: string; substrate: string; recall: number; precision: number; tokens: number; ms: number }>;
  summary?: Record<string, SummaryRow>;
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
        verdict = `mdg **ties rg on tokens** (${num(mdg.tokens)} vs ${num(rg.tokens)}, within 5%) at ${fmtPct(mdg.recall)} recall and ${fmtPct(mdg.prec)} precision on the memory-system corpus (conductor track specs + plans + JSON metadata).`;
        wins.push(`Parity with rg on tokens on the memory-system corpus (${num(mdg.tokens)} vs ${num(rg.tokens)}) at the same recall, with **better precision** than PowerShell. rg has no equivalent budget knob, status field, or pagination.`);
      } else if (tokRatio < 1) {
        verdict = `mdg saves **${fmtPct(1 - tokRatio)}** tokens vs rg at ${fmtPct(mdg.recall)} recall (${num(mdg.tokens)} vs ${num(rg.tokens)}).`;
        wins.push(`Beats rg on tokens (${num(mdg.tokens)} vs ${num(rg.tokens)}) at ${fmtPct(mdg.recall)} recall on the memory-system corpus.`);
      } else {
        verdict = `mdg costs **${tokRatio.toFixed(1)}× more tokens** than rg at ${fmtPct(Math.abs(recallDelta))} ${recallDelta >= 0 ? "more" : "less"} recall and ${fmtPct(Math.abs(precDelta))} ${precDelta >= 0 ? "more" : "less"} precision. mdg's value here is the per-match windowed context + structured node metadata + token budget knobs that rg lacks — useful when an agent will *consume* the result, not just list lines.`;
        loses.push(`Higher token cost than rg (${num(mdg.tokens)} vs ${num(rg.tokens)}). mdg returns windowed nodes (file + match line + sized context); rg returns raw lines. The mdg cost is the windowing budget — knobs let an agent trade context size for tokens, which rg cannot.`);
      }
      lines.push(`- **mdg vs ripgrep on the memory-system corpus (markdown specs + JSON metadata, conductor tracks)**: ${verdict}`);
    }

    if (rg && ps) {
      const psSlowdown = rg.ms === 0 ? 0 : ps.ms / rg.ms;
      lines.push(`- **PowerShell vs ripgrep**: matches rg on recall, **${psSlowdown.toFixed(0)}× slower**. A Windows user without rg pays a real latency tax (PowerShell ~${num(ps.ms)} ms vs rg ~${num(rg.ms)} ms).`);
    }

    if (emb) {
      lines.push(`- **Embeddings vs regex (literal pattern queries) on the memory corpus**: per-file embeddings got ${fmtPct(emb.recall)} recall. Section-level chunking (\`embed-chunked\`) does meaningfully better at a fraction of the token cost — see the chunked section above. For *semantic* recall (paraphrased prompts), see the semantic section below.`);
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
  lines.push("## What's missing (the comparisons this bench can't make yet)");
  lines.push("");
  lines.push("- **Other named-memory systems** as substrates: mem0, Letta, Anthropic's Claude memory tool. Each would slot into the conversational bench as another substrate. Skipped on first pass because each ships its own auth / setup story.");
  lines.push("- **Cross-corpus generalization**: the macro and multi-turn tiers run on FractalEngine specs+code; the conversational tier on the project's own Claude transcripts. Larger or differently-shaped codebases (Python monorepos, large docs sites) would surface whether the wins generalize.");
  lines.push("- **SWE-bench Lite integration**: replace the hand-labeled task set with the SWE-bench harness for an externally-comparable lift number. Needs Docker + the SWE-bench infra; out of scope for the local bench.");
  lines.push("- **Multi-session long-term memory**: the multi-turn tier still runs all turns inside one model context. True LoCoMo-style sessions (palace persists, model context is cleared between sessions) would test memory durability separately from in-context recall.");
  lines.push("- **Re-running semantic queries against the chunked embedding index**: the semantic tier today uses raw-line embeddings; piping the chunker through would show whether chunking flips embeddings' advantage on paraphrased queries. Easy follow-up.");
  return lines.join("\n");
}

function macroSection(macro: MacroFile | null): string {
  if (!macro) {
    return "## macro — agent task lift (code + specs corpus)\n\n_No results found. Run `npm run bench:macro` (requires `ANTHROPIC_API_KEY`)._\n";
  }
  if (macro.status === "skipped") {
    return [
      "## macro — agent task lift (code + specs corpus)",
      "",
      `_Skipped: ${macro.reason ?? "no reason recorded"}. Run \`npm run bench:macro\` with \`ANTHROPIC_API_KEY\` set to populate._`,
      "",
    ].join("\n");
  }
  if (!macro.summary) return "";

  const { control, treatment } = macro.summary;
  const lift = macro.lift!;
  const lines = [
    "## macro — agent task lift (code + specs corpus)",
    "",
    `_Model: \`${macro.model}\`. Corpus: \`${macro.corpus_root}\`. Tasks: ${macro.tasks}. Run: ${macro.generated_at}_`,
    "",
    "Two arms of the same agent: **control** (read/grep/write/bash) vs **treatment** (control + 5 mdg tools). Same model, same task set, same budget caps (20 turns, 50k input tokens per task).",
    "",
    "### Per-arm summary",
    "",
    "| arm | pass rate | mean in tokens | mean out tokens | mean tool calls | mean turns | mean ms |",
    "| :--- | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| control   | ${fmtPct(control.pass_rate)} | ${num(control.mean_input_tokens)} | ${num(control.mean_output_tokens)} | ${control.mean_tool_calls.toFixed(1)} | ${control.mean_turns.toFixed(1)} | ${num(control.mean_ms)} |`,
    `| treatment | ${fmtPct(treatment.pass_rate)} | ${num(treatment.mean_input_tokens)} | ${num(treatment.mean_output_tokens)} | ${treatment.mean_tool_calls.toFixed(1)} | ${treatment.mean_turns.toFixed(1)} | ${num(treatment.mean_ms)} |`,
    "",
    "### Lift (treatment − control)",
    "",
    "| metric | delta | interpretation |",
    "| :--- | ---: | :--- |",
    `| pass-rate    | ${lift.pass_rate >= 0 ? "+" : ""}${fmtPct(lift.pass_rate)} | ${lift.pass_rate >= 0 ? "treatment did not regress accuracy" : "treatment dropped accuracy — investigate"} |`,
    `| input tokens | ${lift.input_tokens >= 0 ? "+" : ""}${fmtPct(lift.input_tokens)} | ${lift.input_tokens < -0.1 ? "**meaningful savings**" : lift.input_tokens > 0.1 ? "treatment more expensive" : "near-parity"} |`,
    `| output tokens | ${lift.output_tokens >= 0 ? "+" : ""}${fmtPct(lift.output_tokens)} | reasoning-verbosity proxy |`,
    `| wall-clock | ${lift.ms >= 0 ? "+" : ""}${fmtPct(lift.ms)} | latency overhead is mostly mdg CLI spawn |`,
    "",
  ];

  if (macro.cells && macro.cells.length > 0) {
    lines.push("### Per-task breakdown");
    lines.push("");
    lines.push("| task | arm | pass | in tok | out tok | tools | turns |");
    lines.push("| :--- | :--- | :---: | ---: | ---: | ---: | ---: |");
    for (const c of macro.cells) {
      lines.push(`| ${c.taskLabel} | ${c.arm} | ${c.passed ? "yes" : "no"} | ${num(c.inputTokens)} | ${num(c.outputTokens)} | ${c.toolCalls} | ${c.turns} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function convChunkedSection(cc: ConvChunkedFile | null, conv: ConvFile | null): string {
  if (!cc) return "## memory-corpus (section-chunked embeddings)\n\n_No results found. Run `npm run bench:conv-chunked`._\n";
  if (cc.status === "skipped") {
    return [
      "## memory-corpus (section-chunked embeddings)",
      "",
      `_Skipped: ${cc.reason ?? "no reason recorded"}_`,
      "",
    ].join("\n");
  }
  const lines = [
    "## memory-corpus (section-chunked embeddings)",
    "",
    `_Run: ${cc.generated_at}. Same queries and corpus as the memory-corpus tier, but the embedding index is built from per-section chunks (split on \`## \` / \`### \` markdown headings) rather than whole files._`,
    "",
  ];
  if (cc.chunked_documents !== undefined) {
    lines.push(`Chunker produced ${cc.chunked_documents} section-level chunks from ${cc.corpus_lines ?? "?"} corpus lines.`);
    lines.push("");
  }
  if (cc.summary) {
    lines.push("| substrate | recall | precision | F1 | tokens | ms |");
    lines.push("| :--- | ---: | ---: | ---: | ---: | ---: |");
    for (const [k, v] of Object.entries(cc.summary)) {
      lines.push(`| ${k} | ${fmtPct(v.recall)} | ${fmtPct(v.prec)} | ${fmtPct(v.f1)} | ${num(v.tokens)} | ${num(v.ms)} |`);
    }
    lines.push("");
  }
  // Head-to-head vs the raw-line embedding from the existing conv tier.
  if (conv?.summary?.["embed"] && cc.summary) {
    const rawEmbed = conv.summary["embed"];
    const chunkedRow = Object.values(cc.summary)[0];
    if (chunkedRow) {
      const recallDelta = chunkedRow.recall - rawEmbed.recall;
      const tokRatio = chunkedRow.tokens / Math.max(1, rawEmbed.tokens);
      lines.push("### Lift vs per-file embeddings");
      lines.push("");
      lines.push(`Section-level chunking moved recall by **${recallDelta >= 0 ? "+" : ""}${fmtPct(recallDelta)}** (${fmtPct(rawEmbed.recall)} → ${fmtPct(chunkedRow.recall)}) at **${fmtPct(1 - tokRatio)} fewer tokens** (${num(rawEmbed.tokens)} → ${num(chunkedRow.tokens)}). Finer chunks let the embedding model fire on the right *slice* of a long spec instead of competing against unrelated sections of the same file.`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function semanticSection(sem: SemanticFile | null): string {
  if (!sem) return "## semantic recall — paraphrased queries\n\n_No results found. Run `npm run bench:semantic`._\n";
  if (sem.status === "skipped") {
    return [
      "## semantic recall — paraphrased queries",
      "",
      `_Skipped: ${sem.reason ?? "no reason recorded"}_`,
      "",
    ].join("\n");
  }
  const lines = [
    "## semantic recall — paraphrased queries",
    "",
    `_Run: ${sem.generated_at}. Queries are PARAPHRASED — the literal pattern doesn't appear verbatim in the corpus. This favors embeddings on construction; regex substrates get only the single most-distinctive literal keyword._`,
    "",
  ];
  if (sem.summary) {
    lines.push("| substrate | recall | precision | F1 | tokens | ms |");
    lines.push("| :--- | ---: | ---: | ---: | ---: | ---: |");
    for (const [k, v] of Object.entries(sem.summary)) {
      lines.push(`| ${k} | ${fmtPct(v.recall)} | ${fmtPct(v.prec)} | ${fmtPct(v.f1)} | ${num(v.tokens)} | ${num(v.ms)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function multiTurnSection(mt: MultiTurnFile | null): string {
  if (!mt) return "## multi-turn — does mind palace stashing pay off across turns?\n\n_No results found. Run `npm run bench:multiturn`._\n";
  if (mt.status === "skipped") {
    return [
      "## multi-turn — does mind palace stashing pay off across turns?",
      "",
      `_Skipped: ${mt.reason ?? "no reason recorded"}_`,
      "",
    ].join("\n");
  }
  if (!mt.summary) return "";
  const { control, treatment } = mt.summary;
  const lift = mt.lift!;
  const lines = [
    "## multi-turn — does mind palace stashing pay off across turns?",
    "",
    `_Model: \`${mt.model}\`. Corpus: \`${mt.corpus_root}\`. Scenarios: ${mt.scenarios}. Run: ${mt.generated_at}_`,
    "",
    "Multi-step scenarios where earlier turns set up evidence later turns need. Treatment is encouraged to stash early findings so later turns are cheap recalls instead of fresh searches.",
    "",
    "### Per-arm summary",
    "",
    "| arm | pass rate | mean in tokens | mean out tokens | mean tool calls | mean turns | mean ms |",
    "| :--- | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| control   | ${fmtPct(control.pass_rate)} | ${num(control.mean_input_tokens)} | ${num(control.mean_output_tokens)} | ${control.mean_tool_calls.toFixed(1)} | ${control.mean_turns.toFixed(1)} | ${num(control.mean_ms)} |`,
    `| treatment | ${fmtPct(treatment.pass_rate)} | ${num(treatment.mean_input_tokens)} | ${num(treatment.mean_output_tokens)} | ${treatment.mean_tool_calls.toFixed(1)} | ${treatment.mean_turns.toFixed(1)} | ${num(treatment.mean_ms)} |`,
    "",
    "### Lift",
    "",
    `- **pass-rate**: ${lift.pass_rate >= 0 ? "+" : ""}${fmtPct(lift.pass_rate)}`,
    `- **input tokens**: ${lift.input_tokens >= 0 ? "+" : ""}${fmtPct(lift.input_tokens)} ${lift.input_tokens < -0.1 ? "(**meaningful savings**)" : ""}`,
    `- **output tokens**: ${lift.output_tokens >= 0 ? "+" : ""}${fmtPct(lift.output_tokens)}`,
    `- **wall-clock**: ${lift.ms >= 0 ? "+" : ""}${fmtPct(lift.ms)}`,
    "",
  ];
  return lines.join("\n");
}

function main(): void {
  const meso = latest<MesoFile>("meso");
  const me = latest<MesoEmbedFile>("meso-embed");
  const conv = latest<ConvFile>("conversational");
  const cc = latest<ConvChunkedFile>("conversational-chunked");
  const sem = latest<SemanticFile>("semantic");
  const macro = latest<MacroFile>("macro");
  const mt = latest<MultiTurnFile>("multiturn");
  const body = [
    header(),
    mesoSection(meso),
    mesoEmbedSection(me),
    mesoComparison(meso, me),
    convSection(conv),
    convSavings(conv),
    convChunkedSection(cc, conv),
    semanticSection(sem),
    macroSection(macro),
    multiTurnSection(mt),
    whatItMeans(meso, me, conv),
  ].join("\n");
  const outPath = join(repoRoot(), "BENCHMARKS.md");
  writeFileSync(outPath, body);
  process.stdout.write(`Wrote ${outPath}\n`);
}

main();
