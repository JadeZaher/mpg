/**
 * Section-level chunking for the memory-corpus (markdown / JSON).
 *
 * The original JSONL chunker is preserved at the bottom of the file
 * for reference. The active export `chunkCorpus` is the new
 * markdown-aware version.
 *
 * Strategy:
 *   - For markdown (.md) files: split on `^#{1,3} ` headings. Each
 *     section becomes a chunk tagged with its source file and the
 *     line number where the heading starts. If the file has no
 *     headings, treat the whole file as one chunk.
 *   - For JSON (.json) files: emit the whole file as one chunk.
 *
 * The point: per-file embeddings can miss when a long spec covers
 * many topics. Per-section embeddings let an embedding model surface
 * the relevant SLICE of a file. We still report at file granularity
 * (a query hit is credited if ANY chunk from a target file shows up
 * in the top-k).
 */

import type { CorpusDoc } from "../lib/corpus.js";

export interface Chunk {
  /** Unique chunk id: "<relPath>#<sectionStartLine>" */
  id: string;
  /** Relative path of the source file. */
  file: string;
  /** Section heading text (or "" for whole-file chunks). */
  heading: string;
  /** Starting line number (1-indexed). */
  startLine: number;
  /** Chunk content (capped to MAX_CHUNK_CHARS). */
  text: string;
}

const MAX_CHUNK_CHARS = 3000;

/** Split a markdown file into chunks by `## ` and `### ` headings. */
function chunkMarkdown(doc: CorpusDoc): Chunk[] {
  const lines = doc.content.split(/\r?\n/);
  const chunks: Chunk[] = [];
  let currentStart = 1;
  let currentHeading = "";
  let buf: string[] = [];

  const flush = (endLine: number) => {
    if (buf.length === 0) return;
    const text = buf.join("\n").slice(0, MAX_CHUNK_CHARS);
    if (text.trim()) {
      chunks.push({
        id: `${doc.rel}#${currentStart}`,
        file: doc.rel,
        heading: currentHeading,
        startLine: currentStart,
        text,
      });
    }
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const headingMatch = ln.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (headingMatch) {
      // Flush previous section.
      flush(i);
      currentStart = i + 1;
      currentHeading = headingMatch[2];
    }
    buf.push(ln);
  }
  flush(lines.length);

  // If file has no headings, the whole-file chunk is fine.
  if (chunks.length === 0 && doc.content.trim()) {
    chunks.push({
      id: `${doc.rel}#1`,
      file: doc.rel,
      heading: "",
      startLine: 1,
      text: doc.content.slice(0, MAX_CHUNK_CHARS),
    });
  }
  return chunks;
}

/** JSON files become one chunk each. */
function chunkJson(doc: CorpusDoc): Chunk[] {
  return [{
    id: `${doc.rel}#1`,
    file: doc.rel,
    heading: "(json)",
    startLine: 1,
    text: doc.content.slice(0, MAX_CHUNK_CHARS),
  }];
}

export function chunkCorpus(docs: CorpusDoc[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const d of docs) {
    if (d.rel.endsWith(".md")) chunks.push(...chunkMarkdown(d));
    else if (d.rel.endsWith(".json")) chunks.push(...chunkJson(d));
    // skip other extensions
  }
  return chunks;
}

/**
 * Stats: how many chunks per file, total chunks, etc. Useful for the
 * driver's diagnostic output.
 */
export function chunkStats(docs: CorpusDoc[], chunks: Chunk[]): {
  total_files: number;
  total_chunks: number;
  mean_chunks_per_file: number;
  files_without_headings: number;
} {
  const perFile = new Map<string, number>();
  for (const c of chunks) perFile.set(c.file, (perFile.get(c.file) ?? 0) + 1);
  const withHeadings = new Set<string>();
  for (const c of chunks) if (c.heading && c.heading !== "(json)") withHeadings.add(c.file);
  return {
    total_files: docs.length,
    total_chunks: chunks.length,
    mean_chunks_per_file: chunks.length / Math.max(1, docs.length),
    files_without_headings: docs.filter((d) => d.rel.endsWith(".md") && !withHeadings.has(d.rel)).length,
  };
}
