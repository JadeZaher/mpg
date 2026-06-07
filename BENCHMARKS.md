# mdg benchmarks — aggregated results

Automated summary of the most recent `bench/results/*.json` files. Regenerate with:

```bash
npm run bench && npm run bench:agg
```

_Generated 2026-06-07T22:17:06.006Z._

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

_Corpus: 11366 lines, 570 KB. Run: 2026-06-07T22:13:13.185Z_

| substrate | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| mdg | 100% | 100% | 100% | 1528 | 1037 |
| ripgrep | 100% | 100% | 100% | 1197 | 22 |
| powershell | 100% | 94% | 96% | 2505 | 412 |
| embed | 46% | 46% | 46% | 18297 | 4 |

### conversational savings vs ripgrep baseline

ripgrep at the same recall is the cheapest line-oriented baseline. The savings columns below show what each substrate gives up (or saves) at that recall.

| substrate | recall vs rg | precision vs rg | token cost vs rg | latency vs rg |
| :--- | ---: | ---: | ---: | ---: |
| mdg | +0% | +0% | +28% | +4577% |
| powershell | +0% | −6% | +109% | +1759% |
| embed | −54% | −54% | +1429% | −83% |

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

_Model: `claude-haiku-4-5-20251001`. Corpus: `C:/Users/atooz/Programming/fractalengine-workspace/fractalengine`. Tasks: 5. Run: 2026-06-07T22:16:18.681Z_

Two arms of the same agent: **control** (read/grep/write/bash) vs **treatment** (control + 5 mdg tools). Same model, same task set, same budget caps (20 turns, 50k input tokens per task).

### Per-arm summary

| arm | pass rate | mean in tokens | mean out tokens | mean tool calls | mean turns | mean ms |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| control   | 100% | 15430 | 573 | 4.8 | 5.8 | 12459 |
| treatment | 100% | 17541 | 478 | 3.8 | 4.6 | 22653 |

### Lift (treatment − control)

| metric | delta | interpretation |
| :--- | ---: | :--- |
| pass-rate    | +0% | treatment did not regress accuracy |
| input tokens | +14% | treatment more expensive |
| output tokens | -17% | reasoning-verbosity proxy |
| wall-clock | +82% | latency overhead is mostly mdg CLI spawn |

### Per-task breakdown

| task | arm | pass | in tok | out tok | tools | turns |
| :--- | :--- | :---: | ---: | ---: | ---: | ---: |
| entity hierarchy from bloom_stage spec | control | yes | 19276 | 675 | 6 | 7 |
| entity hierarchy from bloom_stage spec | treatment | yes | 14296 | 421 | 3 | 4 |
| asset addressing scheme | control | yes | 4262 | 219 | 2 | 3 |
| asset addressing scheme | treatment | yes | 19301 | 483 | 4 | 4 |
| function name that loads assets into Bevy | control | yes | 6433 | 347 | 3 | 4 |
| function name that loads assets into Bevy | treatment | yes | 12048 | 367 | 3 | 4 |
| previous camera type before bloom_stage | control | yes | 30654 | 914 | 8 | 9 |
| previous camera type before bloom_stage | treatment | yes | 17231 | 272 | 2 | 3 |
| code-review tracks from 2026-04-30 | control | yes | 16523 | 712 | 5 | 6 |
| code-review tracks from 2026-04-30 | treatment | yes | 24829 | 849 | 7 | 8 |

## multi-turn — does mind palace stashing pay off across turns?

_Skipped: ANTHROPIC_API_KEY not set_

## What the numbers mean

- **mdg vs ripgrep on the memory-system corpus (markdown specs + JSON metadata, conductor tracks)**: mdg costs **1.3× more tokens** than rg at 0% more recall and 0% more precision. mdg's value here is the per-match windowed context + structured node metadata + token budget knobs that rg lacks — useful when an agent will *consume* the result, not just list lines.
- **PowerShell vs ripgrep**: matches rg on recall, **19× slower**. A Windows user without rg pays a real latency tax (PowerShell ~412 ms vs rg ~22 ms).
- **Embeddings vs regex (literal pattern queries) on the memory corpus**: per-file embeddings got 46% recall. Section-level chunking (`embed-chunked`) does meaningfully better at a fraction of the token cost — see the chunked section above. For *semantic* recall (paraphrased prompts), see the semantic section below.
- **Meso (small synthetic code corpus)**: mdg quick → 100% recall, 257 tokens. Embedding k=5 → 92% recall, 218 tokens. mdg wins on recall by 8%, costs 18% tokens. **Caveat**: the meso corpus is too small (8 files) to be load-bearing — expanding fixtures is in the backlog.

## Where mdg wins and loses

Auto-generated from the latest run.

**Wins:**
- Mind palace set semantics hold (micro: compose=union, intersect=intersection, prune-keep by recency, graph terminates on cycles). rg has no equivalent of any of these — and mdg's actual pitch is **stash, recall, compose across turns**, which rg structurally cannot do.

**Loses:**
- Higher token cost than rg (1528 vs 1197). mdg returns windowed nodes (file + match line + sized context); rg returns raw lines. The mdg cost is the windowing budget — knobs let an agent trade context size for tokens, which rg cannot.
- Cold-start latency vs rg (1037ms vs 22ms, ~47× slower). Node startup + JSON formatter overhead matters in tight agent loops; MCP server warm-call is closer to rg.
- One semantic anomaly in `--mp-except` (micro: 1/17). Logged for investigation.

## What's missing (the comparisons this bench can't make yet)

- **Other named-memory systems** as substrates: mem0, Letta, Anthropic's Claude memory tool. Each would slot into the conversational bench as another substrate. Skipped on first pass because each ships its own auth / setup story.
- **Cross-corpus generalization**: the macro and multi-turn tiers run on FractalEngine specs+code; the conversational tier on the project's own Claude transcripts. Larger or differently-shaped codebases (Python monorepos, large docs sites) would surface whether the wins generalize.
- **SWE-bench Lite integration**: replace the hand-labeled task set with the SWE-bench harness for an externally-comparable lift number. Needs Docker + the SWE-bench infra; out of scope for the local bench.
- **Multi-session long-term memory**: the multi-turn tier still runs all turns inside one model context. True LoCoMo-style sessions (palace persists, model context is cleared between sessions) would test memory durability separately from in-context recall.
- **Re-running semantic queries against the chunked embedding index**: the semantic tier today uses raw-line embeddings; piping the chunker through would show whether chunking flips embeddings' advantage on paraphrased queries. Easy follow-up.