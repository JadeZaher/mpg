/**
 * Compaction tasks.
 *
 * Each task is a (topic, budget, question set) tuple. An arm produces
 * a compaction at most `budget_tokens` long; the scorer feeds the
 * compaction + each question to a stateless LLM and substring-matches
 * the answer against expected phrases. Treatment wins when
 * answer-quality per token is highest.
 *
 * Topics are CROSS-PROJECT — they intentionally span multiple
 * projects in the mega-corpus so the bench tests "search a large
 * memory space," not "browse one repo."
 */

import { existsSync } from "node:fs";

export interface CompactionQA {
  question: string;
  /** Substrings (case-insensitive). Answer passes if it contains ANY of these. */
  expected_phrases: string[];
}

export interface CompactionTask {
  id: string;
  label: string;
  /** What the agent is compacting about. Free-form prose. */
  topic: string;
  /** Hand-picked literal keywords for non-LLM retrieval baselines (rg/mdg-scan/summarization). */
  retrieval_keywords: string[];
  /** Hard cap on the compaction output, in approximate tokens. */
  budget_tokens: number;
  /** 3-5 ground-truth questions. The scorer pings each one against the compaction. */
  questions: CompactionQA[];
}

export const TASKS: CompactionTask[] = [
  {
    id: "T1-authentication",
    label: "authentication patterns across projects",
    topic:
      "How do the projects in this corpus authenticate users and API requests? " +
      "Include the schemes used (JWT, OAuth, etc), where they're implemented, " +
      "and any cross-cutting middleware or context objects involved.",
    retrieval_keywords: ["JWT", "Bearer", "Authorize", "authentication", "ProviderContext"],
    budget_tokens: 2000,
    questions: [
      {
        question: "What authentication scheme does the avatar API use?",
        expected_phrases: ["JWT", "Bearer", "JSON Web Token"],
      },
      {
        question: "Which ambient context object carries provider configuration through the call stack?",
        expected_phrases: ["ProviderContext", "Provider Context"],
      },
      {
        question: "Are register and login endpoints authenticated?",
        expected_phrases: ["anonymous", "without", "not", "no auth", "unauthenticated", "without authentication"],
      },
    ],
  },
  {
    id: "T2-asset-pipeline",
    label: "asset pipeline / content addressing",
    topic:
      "How does the asset / content addressing layer work in this corpus? " +
      "Include hashing schemes, how assets are loaded into runtime engines, " +
      "and any caching or content-addressed storage approaches.",
    retrieval_keywords: ["BLAKE3", "asset_id", "load_to_bevy", "asset", "content-addressed"],
    budget_tokens: 2000,
    questions: [
      {
        question: "What hashing scheme is used for content addressing in the FractalEngine asset pipeline?",
        expected_phrases: ["BLAKE3"],
      },
      {
        question: "What Rust function loads an asset into Bevy given an asset id?",
        expected_phrases: ["load_to_bevy"],
      },
      {
        question: "What is the asset id parameter type in the loader function?",
        expected_phrases: ["str", "&str", "asset_id", "string"],
      },
    ],
  },
  {
    id: "T3-rendering-stack",
    label: "rendering stack and camera setup",
    topic:
      "What does the rendering stack look like in the FractalEngine project? " +
      "Include the rendering library/version, current camera setup, and any " +
      "planned entity hierarchy or scene graph the renderer must support.",
    retrieval_keywords: ["Bevy", "Camera", "Camera2d", "renderer", "Petal", "BrowserInteraction"],
    budget_tokens: 2000,
    questions: [
      {
        question: "What rendering library does FractalEngine use, and which version?",
        expected_phrases: ["Bevy 0.18", "Bevy", "0.18"],
      },
      {
        question: "What is the current camera type before any planned changes?",
        expected_phrases: ["Camera2d", "Camera2D"],
      },
      {
        question: "Name three levels of the proposed entity hierarchy.",
        expected_phrases: ["Fractal", "Node", "Petal", "Room", "Model", "BrowserInteraction"],
      },
    ],
  },
];

/** Verify the mega-corpus is on disk. Returns true if at least one root exists. */
export function ensureMegaCorpus(roots: string[]): boolean {
  return roots.some((r) => existsSync(r));
}
