/**
 * Chunked embedding substrate for the conversational benchmark.
 *
 * Instead of embedding raw JSONL lines (which contain UUID noise, base64,
 * session metadata, etc.), this module:
 *   1. Runs each line through extractContent() from chunking.ts.
 *   2. Embeds only the extracted human-readable text.
 *   3. Records a lineMap so that a vector hit can be mapped back to its
 *      original 1-indexed line number for recall scoring.
 *
 * Exposes the same topK interface shape as bench/lib/embed.ts so the driver
 * can swap substrates without any scoring-layer changes.
 */

import { buildIndex, topK as libTopK, type VectorIndex } from "../lib/embed.js";
import { chunkCorpus, type Chunk } from "./chunking.js";

export interface ChunkedIndex {
  /** Chunk ids (= "1"-indexed original line numbers as strings). */
  ids: string[];
  /** Corresponding embedding vectors. */
  vectors: Float32Array[];
  /**
   * Maps chunk id → original 1-indexed line number.
   * For this substrate the id IS the line number string, so this is trivial,
   * but it's exposed explicitly so callers don't need to assume that.
   */
  lineMap: Map<string, number>;
}

/**
 * Build a vector index over the extracted content of each non-empty,
 * non-noise line in rawLines.
 */
export async function buildChunkedIndex(rawLines: string[]): Promise<ChunkedIndex> {
  const chunks: Chunk[] = chunkCorpus(rawLines);

  const docs = chunks.map((c) => ({ id: c.id, text: c.text }));
  const inner: VectorIndex = await buildIndex(docs);

  const lineMap = new Map<string, number>();
  for (const c of chunks) {
    lineMap.set(c.id, c.originalLineNumber);
  }

  return {
    ids: inner.ids,
    vectors: inner.vectors,
    lineMap,
  };
}

/**
 * Return the top-k results as { lineNumber, score } pairs so the bench driver
 * can compute recall against the ground-truth line numbers from rg.
 */
export async function chunkedTopK(
  index: ChunkedIndex,
  query: string,
  k: number,
): Promise<Array<{ lineNumber: number; score: number }>> {
  // Re-use the existing cosine topK from the lib against our vectors.
  const inner: VectorIndex = { ids: index.ids, vectors: index.vectors };
  const hits = await libTopK(inner, query, k);

  return hits.map((h) => ({
    lineNumber: index.lineMap.get(h.id) ?? parseInt(h.id, 10),
    score: h.score,
  }));
}
