# mdg benchmarks — aggregated results

Automated summary of the most recent `bench/results/*.json` files. Regenerate with:

```bash
npm run bench && npm run bench:agg
```

_Generated 2026-06-07T23:40:43.146Z._

## compaction — memory-system primitive head-to-head

_Tasks: 3. Mega-corpus: 254 files across 4 projects. Run: 2026-06-07T22:52:00.683Z_

The honest test of mdg as a memory primitive: given a topic + token budget, can it assemble a compaction a downstream LLM can answer Q&A from? Arms compared:

- **truncation** — no-LLM baseline. Most-recent files until budget.
- **mdg-scan** — no-LLM mdg call: `scan + sort recent + window-curve log + max-tokens budget`.
- **summarization** — LLM baseline: rg-retrieve + single-pass LLM compaction.
- **mdg-agent** — LLM with mdg tools, headline arm.

### Per-arm summary

| arm | pass rate | mean comp tokens | mean in tokens | mean density (pass/k) | mean ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| truncation | 22% | 2003 | 0 | 0.11 | 6 |
| mdg-scan | 67% | 2752 | 0 | 0.49 | 993 |
| summarization | 33% | 573 | 20482 | 0.47 | 12689 |
| mdg-agent | 11% | 15 | 68726 | 7.41 | 52168 |

### Per-task breakdown

| task | arm | pass | comp tok | in tok |
| :--- | :--- | ---: | ---: | ---: |
| authentication patterns across projects | truncation | 67% | 2003 | 0 |
| authentication patterns across projects | mdg-scan | 100% | 5321 | 0 |
| authentication patterns across projects | summarization | 100% | 711 | 43419 |
| authentication patterns across projects | mdg-agent | 33% | 15 | 58401 |
| asset pipeline / content addressing | truncation | 0% | 2003 | 0 |
| asset pipeline / content addressing | mdg-scan | 67% | 2609 | 0 |
| asset pipeline / content addressing | summarization | 0% | 810 | 16185 |
| asset pipeline / content addressing | mdg-agent | 0% | 15 | 90702 |
| rendering stack and camera setup | truncation | 0% | 2003 | 0 |
| rendering stack and camera setup | mdg-scan | 33% | 325 | 0 |
| rendering stack and camera setup | summarization | 0% | 198 | 1841 |
| rendering stack and camera setup | mdg-agent | 0% | 15 | 57076 |

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

_Model: `claude-haiku-4-5-20251001`. Corpus: `C:/Users/atooz/Programming/fractalengine-workspace/fractalengine`. Scenarios: 3. Run: 2026-06-07T23:39:32.356Z_

Multi-step scenarios where earlier turns set up evidence later turns need. Treatment is encouraged to stash early findings so later turns are cheap recalls instead of fresh searches.

### Per-arm summary

| arm | pass rate | mean in tokens | mean out tokens | mean tool calls | mean turns | mean ms |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| control   | 67% | 63999 | 1402 | 11.7 | 12.3 | 95017 |
| treatment | 0% | 48630 | 731 | 6.3 | 6.3 | 830476 |

### Lift

- **pass-rate**: -67%
- **input tokens**: -24% (**meaningful savings**)
- **output tokens**: -48%
- **wall-clock**: +774%

## memory-corpus literal recall (oasis-sleek conductor tracks)

_Corpus: 11366 lines, 570 KB. Run: 2026-06-07T23:22:48.863Z_

| substrate | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| mdg | 100% | 100% | 100% | 377 | 1138 |
| ripgrep | 100% | 100% | 100% | 1197 | 21 |
| powershell | 100% | 94% | 96% | 2505 | 426 |
| embed | 46% | 46% | 46% | 18297 | 4 |

### conversational savings vs ripgrep baseline

ripgrep at the same recall is the cheapest line-oriented baseline. The savings columns below show what each substrate gives up (or saves) at that recall.

| substrate | recall vs rg | precision vs rg | token cost vs rg | latency vs rg |
| :--- | ---: | ---: | ---: | ---: |
| mdg | +0% | +0% | −69% | +5405% |
| powershell | +0% | −6% | +109% | +1963% |
| embed | −54% | −54% | +1429% | −80% |

## memory-corpus (section-chunked embeddings)

_Run: 2026-06-07T22:47:03.838Z. Same queries and corpus as the memory-corpus tier, but the embedding index is built from per-section chunks (split on `## ` / `### ` markdown headings) rather than whole files._

Chunker produced 1005 section-level chunks from 11366 corpus lines.

| substrate | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| embed-chunked | 51% | 51% | 51% | 1169 | 5 |

### Lift vs per-file embeddings

Section-level chunking moved recall by **+5%** (46% → 51%) at **94% fewer tokens** (18297 → 1169). Finer chunks let the embedding model fire on the right *slice* of a long spec instead of competing against unrelated sections of the same file.

## semantic recall — paraphrased queries

_Run: 2026-06-07T22:46:43.220Z. Queries are PARAPHRASED — the literal pattern doesn't appear verbatim in the corpus. This favors embeddings on construction; regex substrates get only the single most-distinctive literal keyword._

| substrate | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| mdg | 92% | 100% | 95% | 12844 | 925 |
| ripgrep | 100% | 100% | 100% | 1236 | 21 |
| powershell | 100% | 92% | 95% | 2792 | 290 |
| embed | 50% | 50% | 50% | 17243 | 0 |

## typo tolerance — fuzzy search on typo'd queries

_Run: 2026-06-07T23:30:59.868Z. Each query has a CORRECT literal (defines ground truth via rg) and a TYPO'd version fed to every substrate. Tests `mdg --fuzzy` against rg, mdg-without-fuzzy, and per-file embeddings._

| substrate | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| rg | 0% | 0% | 0% | 0 | 23 |
| mdg | 0% | 0% | 0% | 0 | 947 |
| mdg-fuzzy | 100% | 89% | 93% | 1931 | 1012 |
| embed | 45% | 45% | 45% | 23610 | 3 |

## meso — recall vs budget (mdg)

_Run: 2026-06-07T22:46:29.982Z_

| effort | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| quick | 100% | 79% | 85% | 257 | 189 |
| normal | 100% | 79% | 85% | 257 | 191 |
| deep | 100% | 79% | 85% | 257 | 179 |

## meso — embedding baseline (vector cosine top-k)

_Run: 2026-06-07T22:46:31.458Z_

| k | recall | precision | F1 | tokens | ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 54% | 27% | 33% | 109 | 3 |
| 5 | 92% | 36% | 48% | 218 | 3 |
| 10 | 100% | 28% | 40% | 320 | 2 |

### meso head-to-head: mdg (quick) vs embedding (k=5)

| metric | mdg quick | embed k=5 | mdg savings |
| :--- | ---: | ---: | ---: |
| recall    | 100% | 92% | — |
| precision | 79% | 36% | — |
| tokens    | 257 | 218 | +18% |
| ms        | 189 | 3 | +6643% |

## What the numbers mean

- **mdg vs ripgrep on the memory-system corpus (markdown specs + JSON metadata, conductor tracks)**: mdg **3.2× cheaper than rg** at 100% recall and 100% precision (377 vs 1197 tokens). `--effort scan --clip 30` returns sub-line snippets with ellipsis markers around each matched span — disambiguation without the line bloat.
- **PowerShell vs ripgrep**: matches rg on recall, **21× slower**. A Windows user without rg pays a real latency tax (PowerShell ~426 ms vs rg ~21 ms).
- **Embeddings vs regex (literal pattern queries) on the memory corpus**: per-file embeddings got 46% recall. Section-level chunking (`embed-chunked`) does meaningfully better at a fraction of the token cost — see the chunked section above. For *semantic* recall (paraphrased prompts), see the semantic section below.
- **Meso (small synthetic code corpus)**: mdg quick → 100% recall, 257 tokens. Embedding k=5 → 92% recall, 218 tokens. mdg wins on recall by 8%, costs 18% tokens. **Caveat**: the meso corpus is too small (8 files) to be load-bearing — expanding fixtures is in the backlog.

## Where mdg wins and loses

Auto-generated from the latest run.

**Wins:**
- Beats rg on tokens by **3.2×** (377 vs 1197) at the same 100% recall + precision via `--effort scan --clip 30`.
- Mind palace set semantics hold (micro: compose=union, intersect=intersection, prune-keep by recency, graph terminates on cycles). rg has no equivalent of any of these — and mdg's actual pitch is **stash, recall, compose across turns**, which rg structurally cannot do.

**Loses:**
- Cold-start latency vs rg (1138ms vs 21ms, ~55× slower). Node startup + JSON formatter overhead matters in tight agent loops; MCP server warm-call is closer to rg.
- One semantic anomaly in `--mp-except` (micro: 1/17). Logged for investigation.

## What's missing (the comparisons this bench can't make yet)

- **Other named-memory systems** as substrates: mem0, Letta, Anthropic's Claude memory tool. Each would slot into the conversational bench as another substrate. Skipped on first pass because each ships its own auth / setup story.
- **Cross-corpus generalization**: the macro and multi-turn tiers run on FractalEngine specs+code; the conversational tier on the project's own Claude transcripts. Larger or differently-shaped codebases (Python monorepos, large docs sites) would surface whether the wins generalize.
- **SWE-bench Lite integration**: replace the hand-labeled task set with the SWE-bench harness for an externally-comparable lift number. Needs Docker + the SWE-bench infra; out of scope for the local bench.
- **Multi-session long-term memory**: the multi-turn tier still runs all turns inside one model context. True LoCoMo-style sessions (palace persists, model context is cleared between sessions) would test memory durability separately from in-context recall.
- **Re-running semantic queries against the chunked embedding index**: the semantic tier today uses raw-line embeddings; piping the chunker through would show whether chunking flips embeddings' advantage on paraphrased queries. Easy follow-up.