/**
 * Local embedding helper for the meso embedding baseline and the
 * conversational benchmark.
 *
 * Uses @xenova/transformers (pure JS, runs in Node). On first call,
 * downloads the model to a local cache (~80 MB, ~1 minute). Subsequent
 * calls are fast (single-digit ms per short text).
 *
 * Model: Xenova/all-MiniLM-L6-v2 — 384-dim embeddings, fast,
 * MIT-licensed, the standard small-encoder baseline.
 */

import { pipeline, env } from "@xenova/transformers";

// Cache models inside the project so cold-start is per-machine, not per-clone.
env.cacheDir = ".transformers-cache";

type Pipe = (text: string | string[], opts?: { pooling?: "mean"; normalize?: boolean }) => Promise<{ data: Float32Array }>;
let pipePromise: Promise<Pipe> | null = null;

function getPipe(): Promise<Pipe> {
  if (!pipePromise) {
    pipePromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2") as unknown as Promise<Pipe>;
  }
  return pipePromise;
}

export async function embed(text: string): Promise<Float32Array> {
  const pipe = await getPipe();
  const out = await pipe(text, { pooling: "mean", normalize: true });
  return out.data;
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  // Sequential to keep memory bounded; tiny corpora don't need batching.
  const out: Float32Array[] = [];
  for (const t of texts) out.push(await embed(t));
  return out;
}

/** Cosine similarity for normalized vectors is just dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export interface VectorIndex {
  ids: string[];
  vectors: Float32Array[];
}

export async function buildIndex(docs: Array<{ id: string; text: string }>): Promise<VectorIndex> {
  const ids = docs.map((d) => d.id);
  const vectors = await embedBatch(docs.map((d) => d.text));
  return { ids, vectors };
}

export async function topK(
  index: VectorIndex,
  query: string,
  k: number,
): Promise<Array<{ id: string; score: number }>> {
  const q = await embed(query);
  const scores = index.vectors.map((v, i) => ({ id: index.ids[i], score: cosine(q, v) }));
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, k);
}
