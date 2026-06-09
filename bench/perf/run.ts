/**
 * Perf bench — measure end-to-end CLI wall-clock on representative
 * workloads. Intentionally narrow: we want signal on the changes that
 * matter for agent-harness latency (cold start, single-file, small
 * dir, full repo).
 *
 * Each workload runs N+1 times; the first is discarded (warm-up for
 * the file-system cache) and the remaining N are aggregated.
 *
 *   npm run bench:perf                # uses the locally-built dist/
 *   MDG_BIN=/path/to/other/mdg npm run bench:perf
 *
 * Prints a table and writes JSON to bench/results/perf-<ISO>.json.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..", "..");
const DIST = resolvePath(REPO_ROOT, "dist", "index.js");
const MDG = process.env.MDG_BIN ?? DIST;
const RUNS = parseInt(process.env.RUNS ?? "5", 10);

interface Workload {
  id: string;
  label: string;
  args: string[];
}

const WORKLOADS: Workload[] = [
  {
    id: "noop",
    label: "node startup (no work)",
    // --help exits 0 with no work; isolates Node + module load cost.
    args: ["--help"],
  },
  {
    id: "single-file",
    label: "single file (1 path, ~225 lines)",
    args: ["TODO", "--in", "src/rg.ts", "--format", "json"],
  },
  {
    id: "small-dir",
    label: "small dir (src/, ~15 files)",
    args: ["function", "--in", "src/", "--format", "json"],
  },
  {
    id: "small-dir-alternation",
    label: "small dir (src/) alternation pattern",
    args: ["(TODO|FIXME|HACK|XXX)", "--in", "src/", "--format", "json"],
  },
  {
    id: "repo-root",
    label: "repo root (mixed)",
    args: ["function", "--in", ".", "--format", "json"],
  },
  {
    id: "repo-root-many",
    label: "repo root + node_modules-style scan (effort=scan)",
    args: ["import", "--in", ".", "--effort", "scan", "--format", "json"],
  },
];

function runOnce(workload: Workload): { ms: number; bytes: number; nodes: number | null } {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [MDG, ...workload.args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // 30s ceiling — anything longer is a regression worth a crash.
    timeout: 30_000,
  });
  const ms = Date.now() - t0;
  const bytes = (res.stdout?.length ?? 0) + (res.stderr?.length ?? 0);
  let nodes: number | null = null;
  if (workload.id !== "noop" && res.stdout) {
    const m = res.stdout.match(/"total_nodes"\s*:\s*(\d+)/);
    if (m) nodes = parseInt(m[1], 10);
  }
  return { ms, bytes, nodes };
}

interface Stat {
  workload: Workload;
  runs: number[];
  bytes: number;
  nodes: number | null;
  min: number;
  median: number;
  max: number;
  mean: number;
}

function stat(workload: Workload, runs: { ms: number; bytes: number; nodes: number | null }[]): Stat {
  const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
  const sum = ms.reduce((a, b) => a + b, 0);
  return {
    workload,
    runs: ms,
    bytes: runs[runs.length - 1].bytes,
    nodes: runs[runs.length - 1].nodes,
    min: ms[0],
    median: ms[Math.floor(ms.length / 2)],
    max: ms[ms.length - 1],
    mean: Math.round(sum / ms.length),
  };
}

function fmt(n: number): string {
  return `${n.toString().padStart(5)}ms`;
}

function main() {
  if (!existsSync(MDG)) {
    console.error(`mdg binary not found at ${MDG}`);
    process.exit(2);
  }
  console.log(`mdg perf bench`);
  console.log(`  binary: ${MDG}`);
  console.log(`  runs:   ${RUNS} per workload (plus 1 discarded warm-up)`);
  console.log(`  cwd:    ${REPO_ROOT}`);
  console.log("");

  const results: Stat[] = [];
  for (const w of WORKLOADS) {
    // Discard warm-up.
    runOnce(w);
    const runs: Array<{ ms: number; bytes: number; nodes: number | null }> = [];
    for (let i = 0; i < RUNS; i++) runs.push(runOnce(w));
    const s = stat(w, runs);
    results.push(s);
    console.log(
      `  ${w.id.padEnd(28)} min=${fmt(s.min)} median=${fmt(s.median)} max=${fmt(s.max)} mean=${fmt(s.mean)}` +
      (s.nodes !== null ? ` nodes=${s.nodes}` : ""),
    );
  }

  const outDir = resolvePath(REPO_ROOT, "bench", "results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = resolvePath(outDir, `perf-${iso}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        binary: MDG,
        runs_per_workload: RUNS,
        results: results.map((s) => ({
          id: s.workload.id,
          label: s.workload.label,
          args: s.workload.args,
          ms: { min: s.min, median: s.median, max: s.max, mean: s.mean, runs: s.runs },
          bytes_out: s.bytes,
          nodes: s.nodes,
        })),
      },
      null,
      2,
    ),
  );
  console.log("");
  console.log(`  wrote ${outPath}`);
}

main();
