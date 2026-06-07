# mdg benchmarks — aggregated results

Automated summary of the most recent `bench/results/*.json` files. Regenerate with:

```bash
npm run bench && npm run bench:agg
```

_Generated 2026-06-07T19:57:00.601Z._

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

_Corpus: 1420 lines, 2315 KB. Run: 2026-06-07T19:41:31.872Z_

| substrate | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| mdg | 100% | 100% | 100% | 17051 | 258 |
| ripgrep | 100% | 100% | 100% | 17064 | 16 |
| powershell | 100% | 96% | 97% | 17416 | 381 |
| embed | 21% | 21% | 21% | 10384 | 6 |

### conversational savings vs ripgrep baseline

ripgrep at the same recall is the cheapest line-oriented baseline. The savings columns below show what each substrate gives up (or saves) at that recall.

| substrate | recall vs rg | precision vs rg | token cost vs rg | latency vs rg |
| :--- | ---: | ---: | ---: | ---: |
| mdg | +0% | +0% | −0% | +1515% |
| powershell | +0% | −4% | +2% | +2279% |
| embed | −79% | −79% | −39% | −66% |

## macro — agent task lift (code + specs corpus)

_Skipped: ANTHROPIC_API_KEY not set. Run `npm run bench:macro` with `ANTHROPIC_API_KEY` set to populate._

## What the numbers mean

- **mdg vs ripgrep (conversational corpus, wide-record JSONL)**: mdg **ties rg on tokens** (17051 vs 17064, within 5%) at 100% recall and 100% precision. The wide-record auto-tune (drop before/after to 0 when median line length > 500 chars) plus per-line dedup eliminates the windowing penalty on JSONL.
- **PowerShell vs ripgrep**: matches rg on recall, **24× slower**. A Windows user without rg pays a real latency tax (PowerShell ~381 ms vs rg ~16 ms).
- **Embeddings vs regex (literal pattern queries)**: 21% recall — the embedding substrate is **not** a substitute for regex when the agent knows the literal. Per-line cosine over JSONL events drowns in noise. For *semantic* recall ("agent remembers we discussed X but not the exact words"), this bench's query design doesn't measure it.
- **Meso (small synthetic code corpus)**: mdg quick → 100% recall, 257 tokens. Embedding k=5 → 92% recall, 218 tokens. mdg wins on recall by 8%, costs 18% tokens. **Caveat**: the meso corpus is too small (8 files) to be load-bearing — expanding fixtures is in the backlog.

## Where mdg wins and loses

Auto-generated from the latest run.

**Wins:**
- Parity with rg on tokens on the conversational JSONL corpus (17051 vs 17064) at the same recall, with **better precision** than PowerShell. rg has no equivalent budget knob, status field, or pagination.
- Mind palace set semantics hold (micro: compose=union, intersect=intersection, prune-keep by recency, graph terminates on cycles). rg has no equivalent of any of these — and mdg's actual pitch is **stash, recall, compose across turns**, which rg structurally cannot do.

**Loses:**
- Cold-start latency vs rg (258ms vs 16ms, ~16× slower). Node startup + JSON formatter overhead matters in tight agent loops; MCP server warm-call is closer to rg.
- One semantic anomaly in `--mp-except` (micro: 1/17). Logged for investigation.

## What's missing (the comparison this bench can't make yet)

- **Macro task lift**: does an agent with mdg solve more SWE-bench tasks at the same token budget? `bench/macro/README.md` describes the methodology; running it requires Docker + the SWE-bench harness + model credits.
- **Multi-turn conversational lift**: this bench measures single-query recall against a known-good answer set. It doesn't measure whether mdg's mind-palace stashing pays off **across turns**. Adapting LoCoMo / LongMemEval is the right next step and is what would actually validate the memory positioning.
- **Semantic-recall queries** (where the agent doesn't know the literal). The conversational bench uses regex-matchable patterns; this favors regex by construction. A separate bench with paraphrased queries would surface embedding strengths honestly.
- **Other named-memory systems**: mem0, Letta, Anthropic's Claude memory tool. Each would slot into the conversational bench as another substrate.
- **Different chunking strategies for embeddings**: per-event content extraction (parse the JSON, embed only `.message.content`) instead of per-line raw embedding would likely double embedding recall. Easy follow-up.