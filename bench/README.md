# mpg benchmarks

Three tiers, each answering a different question:

| Tier | Question | Cost | Status |
| :--- | :--- | :--- | :--- |
| **micro** | Do the mind-palace semantics hold? (round-trip, set ops, prune, graph) | seconds | implemented |
| **meso** | What's the recall/precision/token tradeoff across effort presets on a fixed corpus? | seconds | implemented |
| **macro** | Does an agent equipped with mpg complete more tasks and/or burn fewer tokens than one without? | hours; needs SWE-bench Lite | scaffold + methodology only |

Run everything:

```bash
npm run bench           # micro + meso, prints summary tables, writes JSON to bench/results/
npm run bench:micro     # palace semantics
npm run bench:meso      # recall-vs-budget curve
```

Each benchmark prints a markdown table to stdout AND writes a
machine-readable JSON record to `bench/results/<tier>-<timestamp>.json`
so you can diff runs over time.

## What each tier is for

### micro — semantic regression net

Beyond the smoke tests: does `compose(a,b)` actually return the
set-union? Does `intersect(a,b)` return the actual intersection? Does
prune-keep(N) leave the N **most recently updated** stashes? Does graph
traversal terminate on cycles?

These are correctness assertions, not performance. They run in seconds
and should be in CI.

### meso — recall vs budget curve

A small synthetic corpus (~20 files, ~5 known query patterns with
known ground-truth hits) is searched at `quick`, `normal`, and `deep`.
For each query × effort cell we record:

- **recall@k** — % of expected hits returned
- **precision** — % of returned nodes that are relevant
- **tokens** — mpg's reported `~tokens`
- **wall-clock ms**

The output is a small table that supports a defensible rule of thumb
like "quick recovers >90% of the recall at 1/10 the cost for this
corpus shape." Re-run on your own corpus to derive your own rule.

### macro — agent task lift (scaffold + methodology)

This is the only benchmark that tells you whether mpg actually helps
real work. It needs:

- a task set (SWE-bench Lite, or 30 curated GitHub issues from your
  own projects)
- two identical agent harnesses (same model, same tool budget) — one
  with mpg MCP tools enabled, one without
- a scorer (did the patch pass the hidden tests? — SWE-bench provides
  this)

`bench/macro/README.md` describes the methodology in detail. The
implementation is out of scope for this scaffold because it requires
external infrastructure (Docker, the SWE-bench harness, model API
keys, etc.).

## Methodology notes

- **Fix the random seed.** Benchmarks should be deterministic given
  a corpus version.
- **Re-run on every release.** Drift on the curve = a behavioral
  regression, even when tests pass.
- **Don't compare across corpora.** Recall/precision are corpus-
  dependent. Curves are interpretable only against the same fixtures.
- **Tokens are mpg's estimate.** They're approximate (`chars/4`). For
  billing-grade numbers, post-process with a real tokenizer.
- **Macro lift > meso curve > micro semantics.** A nice meso curve is
  meaningless if macro lift is zero. Macro is the only number that
  tells you whether to keep building this.
