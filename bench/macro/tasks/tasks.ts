/**
 * Macro benchmark tasks.
 *
 * Corpus: the FractalEngine workspace at
 *   C:/Users/atooz/Programming/fractalengine-workspace/fractalengine
 *
 * Each task asks the agent to FIND A SPECIFIC CHUNK OF CONTENT in the
 * specs (conductor/tracks/<track>/spec.md, plan.md) or code (fe-*\/src\/**\/*.rs).
 * Success is checked by substring match against the agent's final answer:
 * the model must produce text containing the expected_phrases.
 *
 * This is the workload where mdg's pitch matters: small node budgets +
 * pagination + stashing give the agent finer-grained context than
 * read-whole-file-then-grep. On JSONL corpora rg wins; on code+specs,
 * agent-task-lift is what we measure.
 */

import { existsSync } from "node:fs";

export const FRACTAL_ROOT = "C:/Users/atooz/Programming/fractalengine-workspace/fractalengine";

export interface TaskSpec {
  id: string;
  label: string;
  prompt: string;
  /**
   * Substrings (or regexes) the final answer must contain. Each entry
   * is OR'd within an array (any match = credit for that group), groups
   * are AND'd (all groups must match).
   */
  expected_phrases: Array<string[]>;
  /** Free-form note for the human reading results. */
  rationale?: string;
}

export const TASKS: TaskSpec[] = [
  {
    id: "T1-bloom-hierarchy",
    label: "entity hierarchy from bloom_stage spec",
    prompt:
      "In the FractalEngine codebase at " + FRACTAL_ROOT + ", look at the bloom_stage_20260322 conductor track. " +
      "What is the entity hierarchy described in its spec? Name each level.",
    expected_phrases: [
      ["Fractal"],
      ["Node"],
      ["Petal"],
      ["Room"],
      ["Model"],
      ["BrowserInteraction"],
    ],
    rationale: "Single-track spec lookup. Treatment should mdg_search the track dir and read a small node; control reads spec.md.",
  },
  {
    id: "T2-blake3-asset",
    label: "asset addressing scheme",
    prompt:
      "In the FractalEngine repo at " + FRACTAL_ROOT + ", what hashing/addressing scheme does the asset pipeline use? " +
      "Answer in one sentence with the name of the scheme.",
    expected_phrases: [["BLAKE3"]],
    rationale: "Single keyword answer; the inefficient agent reads entire spec.md to confirm.",
  },
  {
    id: "T3-load-to-bevy",
    label: "function name that loads assets into Bevy",
    prompt:
      "In the FractalEngine repo at " + FRACTAL_ROOT + ", what Rust function loads an asset into Bevy by asset_id? " +
      "Give just the function name.",
    expected_phrases: [["load_to_bevy"]],
    rationale: "Function-name lookup. Treatment uses mdg_search with effort:quick and max_nodes:3.",
  },
  {
    id: "T4-camera-type",
    label: "previous camera type before bloom_stage",
    prompt:
      "In the FractalEngine repo at " + FRACTAL_ROOT + ", what camera type is currently used (before the bloom_stage track changes it)? " +
      "Answer in one short phrase.",
    expected_phrases: [["Camera2d", "Camera2D"]],
    rationale: "Specific keyword from context section of a spec.",
  },
  {
    id: "T5-code-review-tracks",
    label: "code-review tracks from 2026-04-30",
    prompt:
      "In the FractalEngine repo at " + FRACTAL_ROOT + ", list at least two conductor tracks dated 2026-04-30 " +
      "that are code reviews. Give their full directory names.",
    expected_phrases: [
      [
        "code_review_20260430_channel_errors",
        "code_review_20260430_clippy_quality",
        "code_review_20260430_db_graceful",
        "code_review_20260430_egui_deprecation",
        "code_review_20260430_mega_function",
        "code_review_20260430_performance_hotpaths",
      ],
      [
        "code_review_20260430_channel_errors",
        "code_review_20260430_clippy_quality",
        "code_review_20260430_db_graceful",
        "code_review_20260430_egui_deprecation",
        "code_review_20260430_mega_function",
        "code_review_20260430_performance_hotpaths",
      ],
    ],
    rationale: "Directory listing task. Treatment's bash/ls overlap; mdg_search on directory names can also surface them. Tests at-least-N matches by requiring 2 different OR-groups (the model must mention 2 names).",
  },
];

/** Sanity check: bail early if the corpus isn't on disk. */
export function ensureCorpus(): void {
  if (!existsSync(FRACTAL_ROOT)) {
    throw new Error(
      `Macro bench corpus not found at ${FRACTAL_ROOT}. ` +
      `Set the FRACTAL_ROOT env var or update bench/macro/tasks/tasks.ts to point at your fractalengine checkout.`,
    );
  }
}

/**
 * Score a task's final answer against its expected_phrases.
 * Returns true iff every group has at least one substring match.
 */
export function scoreAnswer(answer: string, spec: TaskSpec): { passed: boolean; matched_groups: number; total_groups: number } {
  const lower = answer.toLowerCase();
  let matched = 0;
  for (const group of spec.expected_phrases) {
    if (group.some((phrase) => lower.includes(phrase.toLowerCase()))) matched++;
  }
  return {
    passed: matched === spec.expected_phrases.length,
    matched_groups: matched,
    total_groups: spec.expected_phrases.length,
  };
}
