/**
 * Summarization arm — LLM baseline.
 *
 * Find topic-relevant content (rg over retrieval_keywords), feed it to
 * an LLM in one pass, ask for a compaction within the budget. This
 * mirrors the "naive" LLM compaction pattern: retrieve, then
 * summarize.
 *
 * The retrieval step is rg — it's the strongest non-mdg baseline.
 * If retrieved content exceeds an input cap, it is truncated to the
 * cap. The single LLM call produces the compaction.
 */

import { spawnSync } from "node:child_process";
import { getClient } from "../../macro/agent/client.js";
import type { CompactionTask } from "../tasks.js";

const MAX_INPUT_CHARS = 200_000; // ~50k tokens worth of retrieved context
const MODEL = process.env.MDG_BENCH_MODEL ?? "claude-haiku-4-5-20251001";

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function isRetryable(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 529 || status === 503) return true;
  return /rate.?limit|overload|ECONNRESET|ETIMEDOUT|temporar/i.test(msg);
}
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  let backoff = 2000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (err) {
      if (attempt < maxRetries && isRetryable(err)) {
        process.stderr.write(`  [summarization retry ${attempt + 1}] sleeping ${backoff}ms\n`);
        await sleep(backoff); backoff *= 2; continue;
      }
      throw err;
    }
  }
  throw new Error("withRetry exhausted");
}

function approxTokens(s: string): number { return Math.ceil(s.length / 4); }

export interface ArmResult {
  arm: string;
  compaction: string;
  compaction_tokens: number;
  input_tokens: number;
  output_tokens: number;
  ms: number;
  error?: string;
}

function retrieveRelevant(corpusRoot: string, keywords: string[]): string {
  const pattern = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const r = spawnSync(
    "rg",
    ["--no-heading", "--line-number", "--color", "never", "-C", "5", pattern, corpusRoot],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  return r.stdout ?? "";
}

export async function runSummarization(task: CompactionTask, corpusRoot: string): Promise<ArmResult> {
  const t0 = Date.now();
  try {
    let retrieved = retrieveRelevant(corpusRoot, task.retrieval_keywords);
    if (retrieved.length > MAX_INPUT_CHARS) {
      retrieved = retrieved.slice(0, MAX_INPUT_CHARS) + "\n[truncated]";
    }
    const client = await getClient();
    const sys =
      "You produce concise memory compactions from retrieved code+spec excerpts. " +
      "Stay strictly within the requested token budget. Preserve concrete facts " +
      "(file paths, identifiers, version numbers, hashing schemes, function names). " +
      "Do not add commentary outside the compaction.";
    const user =
      `TOPIC: ${task.topic}\n\n` +
      `BUDGET: ${task.budget_tokens} tokens (hard cap).\n\n` +
      `RETRIEVED CONTENT (file:line:text from ripgrep):\n\n${retrieved}\n\n` +
      `Produce the compaction now. Output ONLY the compaction text.`;
    const resp = await withRetry(() => client.messages.create({
      model: MODEL,
      system: sys,
      max_tokens: Math.min(8192, Math.ceil(task.budget_tokens * 1.2)),
      messages: [{ role: "user", content: user }],
    }));
    const text = resp.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { type: string; text?: string }) => b.text ?? "")
      .join("\n");
    return {
      arm: "summarization",
      compaction: text,
      compaction_tokens: approxTokens(text),
      input_tokens: resp.usage.input_tokens,
      output_tokens: resp.usage.output_tokens,
      ms: Date.now() - t0,
    };
  } catch (err) {
    return {
      arm: "summarization",
      compaction: "",
      compaction_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      ms: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}
