# Memory-corpus benchmark (formerly "conversational")

## What this measures

Real memory-system content. Markdown specifications, JSON metadata,
and supporting design docs — exactly what mem0, Letta, Anthropic's
Claude memory tool, or a bespoke memory layer would actually store.

mdg is **memory-system-independent**: it doesn't care which system
holds the content, only that the content is markdown/JSON/code-like.
So we test on what a memory system would store, not on the noisy raw
transcripts a system has to filter first.

## Corpus

Default: `C:/Users/atooz/Programming/Projects/oasis-sleek/conductor/tracks/`

- 34 conductor tracks
- Each track has `spec.md`, `plan.md`, sometimes `metadata.json` plus
  supplementary docs (RUNBOOK, CATALOG, etc.)
- 72 total content files, ~9.6k lines, ~515 KB

Override with `MDG_BENCH_CORPUS_ROOT=<path>` to point at a different
conductor-style project. The macro and multi-turn tiers use a
different project (FractalEngine) so we're not over-fitting bench
findings to one codebase.

## Granularity

**File-level recall.** Each substrate returns the set of files it
considers relevant for a query. This matches how a memory system
exposes content (one "memory" = one document, not one line). It also
makes the embedding substrate honest: per-file embeddings are cheap
and natural for spec-sized documents.

The chunked variant (`run-chunked.ts`) splits markdown by `## ` /
`### ` headings, producing finer-grained embeddings, and projects
back to file-level recall for the metric.

## Substrates

| Substrate | Why include it |
| :--- | :--- |
| **mdg** | The system under test. Returns nodes (file + match line + token-windowed context). |
| **ripgrep** (raw) | The fastest plain regex baseline. Returns whole matching lines from each file. |
| **PowerShell `Select-String`** | The Windows-native baseline an agent would use if `rg` isn't installed. |
| **vector embeddings** (`Xenova/all-MiniLM-L6-v2`) | Semantic baseline. Per-file cosine. |

## Queries

`queries.ts` defines 6 patterns chosen so they exist verbatim in the
corpus — ground truth is then well-defined (the set of files where rg
matches). The interesting axes become:
- **Precision** (does the substrate return only relevant files?)
- **Token cost** (how much would an agent pay to consume the result?)
- **For embeddings specifically**: can it recover the rg files when
  given a SEMANTIC prompt instead of the literal pattern? The
  semantic tier (`bench/semantic/`) tests that case explicitly.

## Metrics

| Metric | Definition |
| :--- | :--- |
| `recall` | `\|expected_files ∩ returned_files\| / \|expected_files\|` |
| `precision` | `\|expected_files ∩ returned_files\| / \|returned_files\|` |
| `F1` | Harmonic mean. |
| `tokens` | Approximate token cost of the returned content. |
| `ms` | Wall-clock. |

## What this bench does NOT measure

- **Multi-turn memory recall**. See `bench/multiturn/`.
- **Agent task lift**. See `bench/macro/`.
- **Different memory systems' retrieval policies** (mem0 / Letta /
  Claude memory tool). Adding those would require each system's
  retrieval layer as a substrate. Out of scope for the first pass.
