/**
 * Shared corpus discovery for the memory-system benchmarks.
 *
 * mdg's pitch is "memory-system-independent retrieval over the kind of
 * content a memory system actually stores": markdown notes, JSON
 * metadata, specifications, plans, code snippets. Conductor tracks
 * across user projects are exactly that shape, so we use them as the
 * canonical bench corpus instead of raw conversation transcripts.
 *
 * Default corpus: oasis-sleek (34 tracks; web + blockchain themes).
 * Override via `MDG_BENCH_CORPUS_ROOT=<path>` to point at a different
 * conductor/tracks parent.
 *
 * macro and multi-turn use FractalEngine via their own constants —
 * keep them on a different corpus so the conv-style tiers don't share
 * data with the agent-task tiers (avoids overfitting the bench to one
 * project).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Pointing at the project root would cause mdg's `--in` walker (via
 * fs.glob) to descend into node_modules and other build artifacts.
 * Point at the conductor/tracks subdir directly — that's where the
 * memory-system content lives.
 */
export const DEFAULT_CORPUS_ROOT =
  process.env.MDG_BENCH_CORPUS_ROOT ??
  "C:/Users/atooz/Programming/Projects/oasis-sleek/conductor/tracks";

export interface CorpusDoc {
  /** Absolute path; canonical id for a doc. */
  path: string;
  /** Relative path under the corpus root, with forward slashes. */
  rel: string;
  /** UTF-8 content. */
  content: string;
  /** Number of lines in the file. */
  lines: number;
}

/**
 * Discover the conductor tracks under `corpusRoot`. Each track dir
 * typically holds `spec.md`, `plan.md`, and `metadata.json`. We pull
 * all three plus any extra markdown/JSON files we find.
 */
export function discoverCorpus(corpusRoot: string = DEFAULT_CORPUS_ROOT): CorpusDoc[] {
  if (!existsSync(corpusRoot)) {
    throw new Error(
      `Corpus not found at ${corpusRoot}. ` +
      `Set MDG_BENCH_CORPUS_ROOT to a directory containing conductor/tracks/, or update DEFAULT_CORPUS_ROOT.`,
    );
  }
  // If the caller pointed us at a project root, walk into conductor/tracks.
  // If they already pointed at conductor/tracks (the default), use directly.
  let tracksDir = corpusRoot;
  if (!corpusRoot.endsWith("tracks") && existsSync(join(corpusRoot, "conductor", "tracks"))) {
    tracksDir = join(corpusRoot, "conductor", "tracks");
  } else if (!existsSync(tracksDir)) {
    throw new Error(`No conductor/tracks dir under ${corpusRoot}.`);
  }
  const docs: CorpusDoc[] = [];
  // Recursive walk to support tracks with nested docs/ subdirs.
  function walk(absDir: string): void {
    let entries: string[] = [];
    try { entries = readdirSync(absDir); } catch { return; }
    for (const name of entries) {
      const abs = join(absDir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!st.isFile()) continue;
      if (!/\.(md|json)$/i.test(name)) continue;
      try {
        const content = readFileSync(abs, "utf8");
        const lines = content.split(/\r?\n/).length;
        // rel is relative to the SEARCH root (tracksDir), matching what rg
        // emits when run with `rg ... <tracksDir>`. Without this, embed
        // file ids would diverge from ground-truth file ids.
        const rel = abs.slice(tracksDir.length + 1).replace(/\\/g, "/");
        docs.push({ path: abs, rel, content, lines });
      } catch { /* skip unreadable */ }
    }
  }
  walk(tracksDir);
  return docs;
}

/** Sum of total lines across all docs. */
export function totalLines(docs: CorpusDoc[]): number {
  return docs.reduce((s, d) => s + d.lines, 0);
}

/** Sum of total bytes across all docs. */
export function totalBytes(docs: CorpusDoc[]): number {
  return docs.reduce((s, d) => s + Buffer.byteLength(d.content, "utf8"), 0);
}
