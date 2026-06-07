# mdg benchmarks — aggregated results

Automated summary of the most recent `bench/results/*.json` files. Regenerate with:

```bash
npm run bench && npm run bench:agg
```

_Generated 2026-06-07T21:43:26.808Z._

## meso — recall vs budget (mdg)

_Run: 2026-06-07T19:41:57.052Z_

| effort | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| quick | 100% | 79% | 85% | 257 | 256 |
| normal | 100% | 79% | 85% | 257 | 229 |
| deep | 100% | 79% | 85% | 257 | 217 |

## meso — embedding baseline (vector cosine top-k)

_Run: 2026-06-07T19:16:07.166Z_

| k | recall | precision | F1 | tokens | ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 54% | 27% | 33% | 109 | 3 |
| 5 | 92% | 36% | 48% | 218 | 4 |
| 10 | 100% | 28% | 40% | 320 | 3 |

### meso head-to-head: mdg (quick) vs embedding (k=5)

| metric | mdg quick | embed k=5 | mdg savings |
| :--- | ---: | ---: | ---: |
| recall    | 100% | 92% | — |
| precision | 79% | 36% | — |
| tokens    | 257 | 218 | +18% |
| ms        | 256 | 4 | +6637% |

## conversational — Claude project memory archive

_Corpus: 11366 lines, 570 KB. Run: 2026-06-07T21:39:20.869Z_

| substrate | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| mdg | 93% | 100% | 96% | 12798 | 1227 |
| ripgrep | 100% | 100% | 100% | 1197 | 24 |
| powershell | 100% | 94% | 96% | 2505 | 386 |
| embed | 46% | 46% | 46% | 18297 | 4 |

### conversational savings vs ripgrep baseline

ripgrep at the same recall is the cheapest line-oriented baseline. The savings columns below show what each substrate gives up (or saves) at that recall.

| substrate | recall vs rg | precision vs rg | token cost vs rg | latency vs rg |
| :--- | ---: | ---: | ---: | ---: |
| mdg | −7% | +0% | +970% | +5085% |
| powershell | +0% | −6% | +109% | +1530% |
| embed | −54% | −54% | +1429% | −84% |

## memory-corpus (section-chunked embeddings)

_Run: 2026-06-07T21:40:46.208Z. Same queries and corpus as the memory-corpus tier, but the embedding index is built from per-section chunks (split on `## ` / `### ` markdown headings) rather than whole files._

Chunker produced 1005 section-level chunks from 11366 corpus lines.

| substrate | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| embed-chunked | 51% | 51% | 51% | 1169 | 5 |

### Lift vs per-file embeddings

Section-level chunking moved recall by **+5%** (46% → 51%) at **94% fewer tokens** (18297 → 1169). Finer chunks let the embedding model fire on the right *slice* of a long spec instead of competing against unrelated sections of the same file.

## semantic recall — paraphrased queries

_Run: 2026-06-07T21:40:20.037Z. Queries are PARAPHRASED — the literal pattern doesn't appear verbatim in the corpus. This favors embeddings on construction; regex substrates get only the single most-distinctive literal keyword._

| substrate | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| mdg | 92% | 100% | 95% | 12844 | 1824 |
| ripgrep | 100% | 100% | 100% | 1236 | 33 |
| powershell | 100% | 92% | 95% | 2792 | 569 |
| embed | 50% | 50% | 50% | 17243 | 0 |

## macro — agent task lift (code + specs corpus)

_Skipped: ANTHROPIC_API_KEY not set. Run `npm run bench:macro` with `ANTHROPIC_API_KEY` set to populate._

## multi-turn — does mind palace stashing pay off across turns?

_Skipped: ANTHROPIC_API_KEY not set_

## What the numbers mean

- **mdg vs ripgrep on the memory-system corpus (markdown specs + JSON metadata, conductor tracks)**: mdg costs **10.7× more tokens** than rg at 7% less recall and 0% more precision. mdg's value here is the per-match windowed context + structured node metadata + token budget knobs that rg lacks — useful when an agent will *consume* the result, not just list lines.
- **PowerShell vs ripgrep**: matches rg on recall, **16× slower**. A Windows user without rg pays a real latency tax (PowerShell ~386 ms vs rg ~24 ms).
- **Embeddings vs regex (literal pattern queries) on the memory corpus**: per-file embeddings got 46% recall. Section-level chunking (`embed-chunked`) does meaningfully better at a fraction of the token cost — see the chunked section above. For *semantic* recall (paraphrased prompts), see the semantic section below.
- **Meso (small synthetic code corpus)**: mdg quick → 100% recall, 257 tokens. Embedding k=5 → 92% recall, 218 tokens. mdg wins on recall by 8%, costs 18% tokens. **Caveat**: the meso corpus is too small (8 files) to be load-bearing — expanding fixtures is in the backlog.

## Where mdg wins and loses

Auto-generated from the latest run.

**Wins:**
- Mind palace set semantics hold (micro: compose=union, intersect=intersection, prune-keep by recency, graph terminates on cycles). rg has no equivalent of any of these — and mdg's actual pitch is **stash, recall, compose across turns**, which rg structurally cannot do.

**Loses:**
- Higher token cost than rg (12798 vs 1197). mdg returns windowed nodes (file + match line + sized context); rg returns raw lines. The mdg cost is the windowing budget — knobs let an agent trade context size for tokens, which rg cannot.
- Cold-start latency vs rg (1227ms vs 24ms, ~52× slower). Node startup + JSON formatter overhead matters in tight agent loops; MCP server warm-call is closer to rg.
- One semantic anomaly in `--mp-except` (micro: 1/17). Logged for investigation.

## What's missing (the comparisons this bench can't make yet)

- **Other named-memory systems** as substrates: mem0, Letta, Anthropic's Claude memory tool. Each would slot into the conversational bench as another substrate. Skipped on first pass because each ships its own auth / setup story.
- **Cross-corpus generalization**: the macro and multi-turn tiers run on FractalEngine specs+code; the conversational tier on the project's own Claude transcripts. Larger or differently-shaped codebases (Python monorepos, large docs sites) would surface whether the wins generalize.
- **SWE-bench Lite integration**: replace the hand-labeled task set with the SWE-bench harness for an externally-comparable lift number. Needs Docker + the SWE-bench infra; out of scope for the local bench.
- **Multi-session long-term memory**: the multi-turn tier still runs all turns inside one model context. True LoCoMo-style sessions (palace persists, model context is cleared between sessions) would test memory durability separately from in-context recall.
- **Re-running semantic queries against the chunked embedding index**: the semantic tier today uses raw-line embeddings; piping the chunker through would show whether chunking flips embeddings' advantage on paraphrased queries. Easy follow-up.