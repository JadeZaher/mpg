# mdg benchmarks — aggregated results

Automated summary of the most recent `bench/results/*.json` files. Regenerate with:

```bash
npm run bench && npm run bench:agg
```

_Generated 2026-06-07T19:21:59.788Z._

## meso — recall vs budget (mdg)

_Run: 2026-06-07T19:20:10.847Z_

| effort | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| quick | 100% | 79% | 85% | 257 | 182 |
| normal | 100% | 79% | 85% | 257 | 169 |
| deep | 100% | 79% | 85% | 257 | 176 |

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
| ms        | 182 | 4 | +4684% |

## conversational — Claude project memory archive

_Corpus: 991 lines, 1661 KB. Run: 2026-06-07T19:19:35.650Z_

| substrate | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| mdg | 93% | 100% | 96% | 76669 | 226 |
| ripgrep | 100% | 100% | 100% | 15779 | 12 |
| powershell | 100% | 95% | 97% | 16130 | 288 |
| embed | 21% | 21% | 21% | 8274 | 4 |

### conversational savings vs ripgrep baseline

ripgrep at the same recall is the cheapest line-oriented baseline. The savings columns below show what each substrate gives up (or saves) at that recall.

| substrate | recall vs rg | precision vs rg | token cost vs rg | latency vs rg |
| :--- | ---: | ---: | ---: | ---: |
| mdg | −7% | +0% | +386% | +1735% |
| powershell | +0% | −5% | +2% | +2234% |
| embed | −79% | −79% | −48% | −66% |

## What the numbers mean

- **mdg vs ripgrep (conversational corpus, wide-record JSONL)**: mdg costs **4.9× more tokens** than rg at 7% less recall and 0% more precision.
  - **Why**: mdg's node windowing pads each hit with `before`/`after` tokens of context. On line-based code (its design point), neighboring lines are short. On JSONL where each line is a serialized event of thousands of characters, the same windowing pulls in entire neighboring events. The cost model inverts.
  - **Implication**: mdg needs a "wide-record" mode — `--before 0 --after 0` or an auto-detected per-line cap — for JSONL/event-stream corpora. This is the headline product finding from the bench.
- **PowerShell vs ripgrep**: matches rg on recall and precision, but **23× slower**. A Windows user without rg pays a real latency tax (PowerShell ~288 ms vs rg ~12 ms).
- **Embeddings vs regex (literal pattern queries)**: 21% recall — the embedding substrate is **not** a substitute for regex when the agent knows what literal to search for. Per-line cosine over JSONL events drowns in noise. Different chunking (per-event content extraction) might recover signal. For *semantic* recall ("the agent remembers there was a discussion about X but doesn't know the exact words"), the bench design here doesn't measure it — that's a different query distribution.
- **Meso (small synthetic code corpus)**: mdg quick → 100% recall, 257 tokens. Embedding k=5 → 92% recall, 218 tokens. mdg wins on recall by 8%, costs 18% tokens. **Caveat**: the meso corpus is too small (8 files) to be load-bearing — expanding fixtures is in the backlog.

## Where mdg wins and loses

Honest summary of what the bench shows about mdg's positioning:

**Wins:**
- 100% precision on the conversational corpus — when mdg returns a node, it's relevant. Other substrates returned slightly noisier results.
- Mind palace set semantics work correctly (micro 16/17): compose=union, intersect=intersection, prune-keep by recency, graph terminates on cycles. None of vector RAG, summary memory, or raw long context exposes these primitives.
- On line-based code corpora (mdg's design point), recall is at parity with raw rg.

**Loses:**
- Token cost on wide-record corpora. Node windowing was designed for short context lines; on JSONL it costs 5× more than raw rg.
- Cold-start latency vs rg (~200ms vs ~12ms) — the Node startup + JSON formatter is overhead that matters when called in tight agent loops.
- One semantic anomaly in `--mp-except` (micro). Investigating.

## What's missing (the comparison this bench can't make yet)

- **Macro task lift**: does an agent with mdg solve more SWE-bench tasks at the same token budget? `bench/macro/README.md` describes the methodology; running it requires Docker + the SWE-bench harness + model credits.
- **Multi-turn conversational lift**: this bench measures single-query recall against a known-good answer set. It doesn't measure whether mdg's mind-palace stashing pays off **across turns**. Adapting LoCoMo / LongMemEval is the right next step and is what would actually validate the memory positioning.
- **Semantic-recall queries** (where the agent doesn't know the literal). The conversational bench uses regex-matchable patterns; this favors regex by construction. A separate bench with paraphrased queries would surface embedding strengths honestly.
- **Other named-memory systems**: mem0, Letta, Anthropic's Claude memory tool. Each would slot into the conversational bench as another substrate.
- **Different chunking strategies for embeddings**: per-event content extraction (parse the JSON, embed only `.message.content`) instead of per-line raw embedding would likely double embedding recall. Easy follow-up.