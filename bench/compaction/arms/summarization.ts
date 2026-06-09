/**
 * Summarization arm — LLM baseline.
 *
 * Find topic-relevant content (rg over retrieval_keywords), feed it to
 * an LLM in one pass, ask for a compaction within the budget. This
 * mirrors the "naive" LLM compaction pattern: retrieve, then
 * summarize.
 *
 * The retrieval step is rg — it's the strongest non-mpg baseline.
 * If retrieved content exceeds an input cap, it is truncated to the
 * cap. The single LLM call produces the compaction.
 */

import { spawnSync } from "node:child_process";
import { getClient } from "../../macro/agent/client.js";
import { getOpenRouterClient, DEFAULT_OPENROUTER_MODEL } from "../../macro/agent/openrouter-client.js";
import type { CompactionTask } from "../tasks.js";

const PROVIDER = ((process.env.MPG_BENCH_PROVIDER ?? "anthropic").toLowerCase() === "openrouter") ? "openrouter" : "anthropic";
const MAX_INPUT_CHARS = 200_000; // ~50k tokens worth of retrieved context
const MODEL =
  process.env.MPG_BENCH_MODEL ??
  (PROVIDER === "openrouter" ? DEFAULT_OPENROUTER_MODEL : "claude-haiku-4-5-20251001");

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
    const maxOut = Math.min(8192, Math.ceil(task.budget_tokens * 1.2));

    let text = "", inTok = 0, outTok = 0;
    if (PROVIDER === "openrouter") {
      const openai = await getOpenRouterClient();
      const resp = await withRetry(() => openai.chat.completions.create({
        model: MODEL,
        max_tokens: maxOut,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }));
      text = (resp.choices?.[0]?.message?.content ?? "").trim();
      inTok = resp.usage?.prompt_tokens ?? 0;
      outTok = resp.usage?.completion_tokens ?? 0;
    } else {
      const anthropic = await getClient();
      const resp = await withRetry(() => anthropic.messages.create({
        model: MODEL,
        system: sys,
        max_tokens: maxOut,
        messages: [{ role: "user", content: user }],
      }));
      text = resp.content
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { type: string; text?: string }) => b.text ?? "")
        .join("\n");
      inTok = resp.usage.input_tokens;
      outTok = resp.usage.output_tokens;
    }
    return {
      arm: "summarization",
      compaction: text,
      compaction_tokens: approxTokens(text),
      input_tokens: inTok,
      output_tokens: outTok,
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
