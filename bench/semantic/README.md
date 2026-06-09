# Semantic Recall Bench

This tier answers a different question than the conversational bench:

> **Can an embedding model find the right lines when the query is paraphrased and the literal keywords are absent from the prompt?**

## Why this tier exists

The `bench/conversational/` tier benchmarks **literal-recall**: every query has a pattern that appears verbatim in the corpus, so `rg`, PowerShell, and `mpg` all achieve 100% recall by construction. Embeddings get a fair shake only when queried with a *different* phrasing from the pattern, but even there the conversational bench uses rg matches as the ground truth, which biases toward regex.

The semantic tier fixes both problems:

1. **No literal overlap.** The `prompt` sent to all substrates is a paraphrase — none of its words appear verbatim in the relevant corpus lines. The concepts are present in the corpus; the vocabulary is not.
2. **Hand-labeled ground truth.** `expected_lines` are manually identified by reading the corpus. Ground truth does not depend on any regex match, so rg cannot get 100% recall by tautology.

## What "success" looks like for embeddings

| Outcome | Meaning |
| :--- | :--- |
| embed recall **>** rg/PowerShell/mpg | Embedding generalization works: the model matches concept-aligned lines that regex cannot find with a single keyword heuristic. |
| embed recall **≈** rg recall | The rg_keyword is an unusually distinctive concept word that happens to appear in the relevant lines, partially bridging the vocabulary gap. |
| embed recall **<** rg recall | The corpus is too small / too noisy for meaningful vector similarity, or the embedding model fails to connect the paraphrased prompt to the relevant concept. This is a meaningful negative result. |

On a typical conversational corpus (Claude project archive JSONL), embeddings should win or tie on 3–5 out of 5 queries because the paraphrased prompts are far from the literal vocabulary in the corpus lines.

## Query design

Each `SemanticQuerySpec` in `queries.ts` has:

```ts
{
  label: string;                 // human-readable name
  prompt: string;                // PARAPHRASED query — no literal overlap with ground truth
  expected_concepts: string[];   // documentation only — what the relevant lines discuss
  rg_keyword: string;            // ONE concept keyword; used as the regex for rg/PowerShell/mpg
  expected_lines: number[];      // HAND-LABELED 1-indexed lines in the corpus snapshot
}
```

### Why only one keyword for regex substrates?

A real agent receiving a paraphrased prompt would have to *guess* which keyword to search for. We simulate this by giving rg/PowerShell/mpg a single distinctive concept word (`rg_keyword`). In practice an agent might pick a better or worse word — this single-keyword approach is a reasonable middle ground. It is not a crippled strawman: the keyword is chosen to be the *most distinctive* concept word, giving regex the best realistic chance.

### The five hand-labeled queries

| # | Label | Prompt summary | Concept keywords | GT lines |
| --: | :--- | :--- | :--- | :--- |
| 1 | LLM memory taxonomy | how does mpg fit into agent memory systems | vector-DB, episodic, archival, MemGPT | 841–842 |
| 2 | benchmark design for agent task lift | what evaluation was suggested for measuring mpg value | SWE-bench, agent, task lift, macro | 422–423 |
| 3 | SKILL.md restructuring advice | how was the skill doc recommended to be reorganized | references, split, integration, sources | 118, 423 |
| 4 | patch version bump and rebuild | when was the package version incremented to fix the shebang | version, 0.2.1, bump, build | 350, 354, 359 |
| 5 | mind palace stash lifecycle | recommended practices for managing memory across turns | stash, compose, prune, TTL, tag | 116, 118 |

Ground truth was established by reading the first ~850 lines of the largest JSONL in the Claude project archive for this repository.

## Running

```sh
# From repo root:
npx tsx bench/semantic/run.ts

# Or once the package.json script is wired:
npm run bench:semantic
```

The runner:
1. Locates the largest `.jsonl` in `~/.claude/projects/C--Users-atooz-Programming-ai-utils-memory-mind-palace-graph/`.
2. Snapshots it to a temp file (corpus is frozen for the run duration).
3. Builds a local embedding index with `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`). First run downloads ~80 MB; subsequent runs use the `.transformers-cache/` in the repo root.
4. For each query runs all four substrates and scores against `expected_lines`.
5. Writes `bench/results/semantic-<timestamp>.json`.

If the archive directory is not found the runner exits with `status: "skipped"` and code 0 (safe in CI).

## Output format

```json
{
  "corpus_source": "...",
  "corpus_lines": 1234,
  "corpus_bytes": 5678901,
  "queries": [...],
  "cells": [
    {
      "query": "LLM memory taxonomy comparison",
      "substrate": "embed",
      "recall": 0.5,
      "precision": 0.1,
      "f1": 0.167,
      "tokens": 2048,
      "ms": 42,
      "returned": 10,
      "expected": 2
    },
    ...
  ],
  "summary": {
    "embed": { "recall": 0.4, "prec": 0.08, "f1": 0.13, "tokens": 1800, "ms": 38 },
    "ripgrep": { ... },
    ...
  },
  "generated_at": "2026-06-07T..."
}
```

## Relationship to other bench tiers

| Tier | What it measures | Ground truth source |
| :--- | :--- | :--- |
| `micro/` | mpg CLI semantics (set ops, graph, prune) | assertions in code |
| `meso/` | recall-vs-token-budget on fixed corpus | rg matches |
| `conversational/` | literal recall — all substrates vs verbatim patterns | rg matches (rg = 100% by definition) |
| **`semantic/`** | **paraphrased recall — embeddings vs keyword-regex** | **hand-labeled line numbers** |
| `macro/` | agent task completion rate end-to-end | pass/fail on tasks |

The semantic tier is the tier where embeddings have a genuine structural advantage over regex, and where the numbers should be interpreted in light of that design intent.
