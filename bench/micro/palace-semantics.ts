/**
 * Micro benchmark: mind palace semantic regressions.
 *
 * These go beyond the smoke tests by exercising compositional
 * semantics: does compose(a,b) really return the union? Does
 * intersect(a,b) really return the intersection? Does prune-keep(N)
 * keep the N most recently updated stashes? Does the graph terminate
 * on cycles?
 *
 * Correctness assertions; no performance claims.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMpg, assert, reportAndExit, search } from "../lib/runner.js";

function makeTinyCorpus(): string {
  const root = mkdtempSync(join(tmpdir(), "mpg-micro-"));
  const write = (rel: string, content: string) => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  };
  // Files chosen so we can verify set operations:
  //   a.ts contains only "alpha"
  //   b.ts contains only "beta"
  //   ab.ts contains both
  write("a.ts", "const alpha = 1;\n");
  write("b.ts", "const beta = 2;\n");
  write("ab.ts", "const alpha = 1;\nconst beta = 2;\n");
  return root;
}

function palacePath(root: string): string {
  return join(root, ".mpg", "palace.json");
}

function stash(root: string, pattern: string, name: string, note = "n"): void {
  const r = runMpg({
    args: [pattern, "--in", root, "--mp-stash", name, note, "--mp-path", palacePath(root), "--no-color"],
    cwd: root,
  });
  if (r.code > 1) {
    process.stderr.write(`stash ${name} failed: ${r.stderr}\n`);
  }
}

interface SearchJson {
  status: string;
  total_nodes: number;
  nodes: Array<{ source: { id: string; type: string }; match_line: number }>;
}

function searchScoped(
  root: string,
  pattern: string,
  scopeFlag: string,
  scopeArgs: string[],
): SearchJson | null {
  const r = search([pattern, scopeFlag, ...scopeArgs, "--mp-path", palacePath(root)], { cwd: root });
  return r.json as SearchJson | null;
}

function sourceNames(json: SearchJson | null): Set<string> {
  if (!json) return new Set();
  return new Set(json.nodes.map((n) => n.source.id.replace(/\\/g, "/").split("/").pop() ?? ""));
}

function main(): void {
  const root = makeTinyCorpus();
  try {
    // Build two stashes:
    //   alpha-stash covers a.ts + ab.ts (files where alpha appears)
    //   beta-stash  covers b.ts + ab.ts (files where beta appears)
    stash(root, "alpha", "alpha-stash");
    stash(root, "beta", "beta-stash");

    process.stdout.write("\n## compose = union\n");
    {
      // Search for either alpha or beta across the UNION (a.ts, b.ts, ab.ts)
      const j = searchScoped(root, "alpha|beta", "--mp-compose", ["alpha-stash", "beta-stash"]);
      const files = sourceNames(j);
      assert(files.has("a.ts"), "compose includes a.ts (only in alpha-stash)");
      assert(files.has("b.ts"), "compose includes b.ts (only in beta-stash)");
      assert(files.has("ab.ts"), "compose includes ab.ts (in both)");
    }

    process.stdout.write("\n## intersect = intersection\n");
    {
      // Files in BOTH stashes: only ab.ts
      const j = searchScoped(root, "alpha|beta", "--mp-intersect", ["alpha-stash", "beta-stash"]);
      const files = sourceNames(j);
      assert(files.has("ab.ts"), "intersect includes ab.ts");
      assert(!files.has("a.ts"), "intersect excludes a.ts (not in beta-stash)");
      assert(!files.has("b.ts"), "intersect excludes b.ts (not in alpha-stash)");
    }

    process.stdout.write("\n## except = set difference\n");
    {
      // Files in alpha-stash but NOT in beta-stash: only a.ts
      // (alpha-stash contains a.ts + ab.ts; subtract beta-stash {b.ts, ab.ts})
      // --mp-except takes the COMPLEMENT relative to alpha-stash's file set
      // when used with --mp-from alpha-stash.
      const r = search(
        ["alpha", "--mp-from", "alpha-stash", "--mp-except", "beta-stash", "--mp-path", palacePath(root)],
        { cwd: root },
      );
      const files = sourceNames(r.json as SearchJson | null);
      assert(files.has("a.ts"), "except keeps a.ts (in alpha-stash, not in beta-stash)");
      assert(!files.has("ab.ts"), "except removes ab.ts (in both)");
    }

    process.stdout.write("\n## mp-from = scope to stash files\n");
    {
      const j = searchScoped(root, "alpha", "--mp-from", ["alpha-stash"]);
      const files = sourceNames(j);
      assert(files.has("a.ts") && files.has("ab.ts"), "mp-from sees alpha-stash files");
      assert(!files.has("b.ts"), "mp-from does not see beta-only files");
    }

    process.stdout.write("\n## prune-keep N preserves N most recent\n");
    {
      // Create 4 stashes in order; keep the 2 most recent.
      stash(root, "alpha", "k1");
      stash(root, "alpha", "k2");
      stash(root, "alpha", "k3");
      stash(root, "alpha", "k4");
      const pruneR = runMpg({
        args: ["--mp-prune-keep", "2", "--mp-path", palacePath(root), "--no-color"],
        cwd: root,
      });
      assert(pruneR.code === 0, "prune-keep exits cleanly");
      const listR = runMpg({
        args: ["--mp-list", "--mp-path", palacePath(root), "--no-color"],
        cwd: root,
      });
      const out = listR.stdout;
      // The original two alpha-stash + beta-stash should still be among
      // the most recent, but k3 and k4 are the freshest. Bench is asserting
      // we kept exactly 2 stashes and they're the newest.
      assert(/STASH k4/.test(out), "kept k4 (most recent)");
      assert(/STASH k3/.test(out), "kept k3 (second most recent)");
      assert(!/STASH k1/.test(out), "dropped k1");
      assert(!/STASH alpha-stash/.test(out), "dropped older alpha-stash");
    }

    process.stdout.write("\n## graph terminates on cycles\n");
    {
      // Rebuild a fresh small palace for clean cycle test
      const cyclePalace = join(root, ".mpg", "cycle.json");
      runMpg({ args: ["alpha", "--in", root, "--mp-stash", "x", "x", "--mp-path", cyclePalace, "--no-color"], cwd: root });
      runMpg({ args: ["alpha", "--in", root, "--mp-stash", "y", "y", "--mp-path", cyclePalace, "--no-color"], cwd: root });
      runMpg({ args: ["--mp-link", "x", "y", "depends-on", "--mp-path", cyclePalace, "--no-color"], cwd: root });
      runMpg({ args: ["--mp-link", "y", "x", "depends-on", "--mp-path", cyclePalace, "--no-color"], cwd: root });
      // Walk depth 5 — should not hang. We just assert it completes within a generous budget.
      const t0 = Date.now();
      const gr = runMpg({
        args: ["--mp-graph", "x", "5", "--mp-path", cyclePalace, "--no-color"],
        cwd: root,
      });
      const elapsed = Date.now() - t0;
      assert(gr.code === 0, "graph traversal exits cleanly on cycle");
      assert(elapsed < 5000, `graph traversal terminates quickly on cycle (${elapsed}ms)`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  reportAndExit();
}

main();
