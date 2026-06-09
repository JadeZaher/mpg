# Compaction bench — the real memory-system test

## What this measures

The honest test of mpg as a memory-system primitive is **not** "can it
find a literal pattern" — rg wins that. It's:

> Given a large memory corpus and a target token budget, can mpg
> assemble a compaction that lets a downstream LLM answer questions
> the original corpus could answer?

This is the workflow behind every real use case:

- **Context-window trimming**: when an agent's context approaches its
  limit, mpg picks what to keep so the remaining context still answers
  the agent's needs.
- **Memory compaction**: turn 50k tokens of session history into 5k
  tokens that preserve the load-bearing facts.
- **Memory generation**: produce a new memory file (e.g. SKILL.md,
  CLAUDE.md, AGENTS.md) that captures key insights from a longer
  body of work.

In all three cases, the question is: **at a fixed output budget, how
well does the compaction preserve the answer-readiness of the original?**

## Corpus

The memory mega-corpus from `bench/lib/corpus.ts`:

| Project | Files |
| :--- | ---: |
| oasis-sleek | 77 |
| fractalengine | 100 |
| plantcommerce | 47 |
| NEOS | 30 |
| **Total** | **254** |

44k lines, ~2.3 MB across 4 different domains (web/blockchain,
graphics engine, e-commerce, operating system). The agent has no
prior knowledge of which project a topic might live in — that's the
realistic memory-search case.

## The task

For each row in `tasks.ts`:

1. Give the agent a **topic** (e.g. "authentication patterns",
   "asset addressing"), a **target token budget** (e.g. 2000), and a
   set of **ground-truth questions** the original corpus can answer
   about that topic.
2. The agent has up to 20 tool-loop turns to assemble a compaction
   that fits in the budget.
3. After the agent stops, we score the compaction by feeding it (plus
   the questions) to a fresh stateless LLM and checking whether the
   answers contain the expected phrases.

## Arms

- **control**: read / grep / write / bash only. The agent has to grep
  for the topic, read promising files, and stitch a compaction by hand.
- **treatment**: control tools + 5 mpg tools. The agent can use
  `mpg_search` with `effort: scan` + `sort: recent` for the index, then
  drill into chosen files with `quick`/`normal`/`deep`, stash partial
  findings, and compose them.

## Metrics

| Metric | What it tells us |
| :--- | :--- |
| **answer_quality** (% of ground-truth questions answered correctly from the compaction) | The headline. |
| **input tokens consumed** | Cost of building the compaction. |
| **turns to convergence** | Tool-loop efficiency. |
| **compaction size** (tokens) | Did the agent stay under budget? |
| **density** (answer_quality / compaction_size) | Answer-quality per token preserved. |

Treatment **wins** if it achieves equal-or-better `answer_quality` at
equal-or-lower input tokens than control. That's the moment mpg's
design is empirically justified as a memory-system primitive.

## What's NOT included on first pass

- **Multi-session compaction lift**: producing a compaction now, then
  asking questions from a stateless LLM 10 turns later. Adds another
  context-staleness axis.
- **Adversarial questions**: the ground-truth questions here are
  factual ("what hashing scheme does X use?"). A separate run with
  inferential questions would test compaction quality on harder
  recall.
- **Comparison to embedding-based RAG**: would slot in as a third arm.

## Status

**Scaffolded; not yet runnable end-to-end.** Reuses the macro tier's
agent harness (`bench/macro/agent/`) — that already handles the tool
loop, both control and treatment tool sets, system prompts, and the
20-turn / 50k-input-token cap. What's pending:

- `tasks.ts` — hand-labeled topic + questions + ground-truth phrases
- `run.ts` — driver that runs each task × each arm and writes
  `bench/results/compaction-<ts>.json`
- A scoring step that feeds compaction + questions to a stateless LLM
  and substring-matches the answer against ground-truth phrases
- `npm run bench:compaction` script

The bench is intentionally scoped to be runnable with the same
`ANTHROPIC_API_KEY` setup as the macro tier.
