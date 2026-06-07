/**
 * Q&A scorer.
 *
 * Given a compaction (text) and a set of (question, expected_phrases)
 * pairs, ask a stateless LLM each question with ONLY the compaction
 * as context. Substring-match the LLM's answer against expected_phrases.
 *
 * The scorer LLM is stateless and fresh per question — there's no
 * conversation memory, no prior context. The only knowledge is the
 * compaction. This is the load-bearing test for compaction quality.
 */

import { getClient } from "../macro/agent/client.js";
import type { CompactionQA } from "./tasks.js";

const SCORER_MODEL = process.env.MDG_BENCH_SCORER_MODEL ?? "claude-haiku-4-5-20251001";

export interface QAResult {
  question: string;
  answer: string;
  passed: boolean;
  matched_phrase?: string;
  input_tokens: number;
  output_tokens: number;
  error?: string;
}

export interface ScoringResult {
  qas: QAResult[];
  pass_rate: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

const SYS = "You answer questions strictly from the provided context. " +
  "If the context does not contain enough information to answer, say so plainly. " +
  "Be concise: one sentence answers. Quote exact identifiers and version numbers when they appear.";

function matchExpected(answer: string, expected: string[]): string | undefined {
  const lower = answer.toLowerCase();
  for (const phrase of expected) {
    if (lower.includes(phrase.toLowerCase())) return phrase;
  }
  return undefined;
}

export async function scoreCompaction(compaction: string, qas: CompactionQA[]): Promise<ScoringResult> {
  const client = await getClient();
  const results: QAResult[] = [];
  for (const qa of qas) {
    try {
      const resp = await client.messages.create({
        model: SCORER_MODEL,
        system: SYS,
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content:
              `CONTEXT:\n\n${compaction}\n\n---\n\nQUESTION: ${qa.question}\n\nAnswer based ONLY on the context above.`,
          },
        ],
      });
      const answer = resp.content
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { type: string; text?: string }) => b.text ?? "")
        .join(" ")
        .trim();
      const matched = matchExpected(answer, qa.expected_phrases);
      results.push({
        question: qa.question,
        answer,
        passed: matched !== undefined,
        matched_phrase: matched,
        input_tokens: resp.usage.input_tokens,
        output_tokens: resp.usage.output_tokens,
      });
    } catch (err) {
      results.push({
        question: qa.question,
        answer: "",
        passed: false,
        input_tokens: 0,
        output_tokens: 0,
        error: (err as Error).message,
      });
    }
  }
  const pass_rate = results.filter((r) => r.passed).length / Math.max(1, results.length);
  return {
    qas: results,
    pass_rate,
    total_input_tokens: results.reduce((s, r) => s + r.input_tokens, 0),
    total_output_tokens: results.reduce((s, r) => s + r.output_tokens, 0),
  };
}
