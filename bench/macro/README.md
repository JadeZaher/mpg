# Macro — agent task lift

The only tier that measures the actual product question: **does an agent
with mpg tools complete tasks at lower token cost than the same agent
without them?** On the workload that matches mpg's pitch.

## The workload (matters)

The conversational tier showed mpg ties rg on JSONL. That's a fair
result on rg's home turf. The macro tier instead runs on a **code +
specs** corpus — the workload mpg was actually designed for:

- Long-form source code (line-based, where context windows matter)
- Long-form design docs / specs (where matches need surrounding prose to answer)
- Plans, READMEs, AGENTS.md guides

Concretely: the **FractalEngine workspace** at
`C:/Users/atooz/Programming/fractalengine-workspace/fractalengine`,
which contains:

- 42 conductor tracks (each with `spec.md`, `plan.md`, `metadata.json`)
- ~267 Rust source files under `fe-*/src/**`
- Docs, AGENTS.md, BUILDING.md

This is the kind of corpus an agent actually browses to answer
questions like "what does the bloom_stage track propose?" or "where is
the asset pipeline hashing scheme defined?"

## The hypothesis

The treatment-arm agent uses mpg to retrieve small, paginated,
token-budgeted nodes. The control-arm agent has only `read`, `grep`,
`write`, `bash`. On the same code+specs corpus, treatment should:

- Answer at least as many tasks correctly (pass-rate at parity or better)
- Spend **fewer input tokens** doing it (mpg's budget caps prevent
  the "read whole 940-line plan to answer one keyword question" pattern)

If treatment matches control on pass-rate at meaningfully lower input
tokens, mpg's value proposition is validated.

## What's measured

| Metric | Why |
| :--- | :--- |
| `pass_rate` per arm | Did the answer contain the expected phrases? |
| `mean_input_tokens` | The dominant cost in agent runs |
| `mean_output_tokens` | Secondary cost; reveals reasoning verbosity |
| `mean_tool_calls` | Did mpg let the agent ask fewer, sharper questions? |
| `mean_turns` | Did the agent converge faster? |
| `mean_ms` | Wall-clock, mostly informational |
| **lift** = treatment − control | The headline number |

## Tasks

`bench/macro/tasks/tasks.ts` defines 5 hand-labeled goal-content tasks
where the agent must find and synthesize specific chunks of content:

1. **T1**: Entity hierarchy from the bloom_stage spec
2. **T2**: Asset addressing scheme (one keyword)
3. **T3**: Function name that loads assets into Bevy
4. **T4**: Camera type used before bloom_stage
5. **T5**: Names of code-review tracks dated 2026-04-30

Each task's success is checked by substring match against the agent's
final answer text (`scoreAnswer` in `tasks.ts`). Pass = every required
phrase group matched.

## Running

```bash
export ANTHROPIC_API_KEY=...
npm run bench:macro
```

Without an API key, the bench writes a `status: "skipped"` record and
exits 0 — safe to keep in `npm run bench`.

Budget guards per run: ≤20 turns, ≤50,000 input tokens, model defaults
to `claude-haiku-4-5-20251001` (override via `MPG_BENCH_MODEL`).

## What success looks like

A defensible pass-rate parity with negative input-token lift, e.g.:

```
| arm       | pass rate | mean in tokens | mean tool calls |
| control   | 100%      | 8,400          | 4.2             |
| treatment | 100%      | 3,100          | 3.1             |
lift: pass-rate +0%, input tokens −63%
```

That's the number that justifies adopting mpg as default working memory
for code-browsing agents.

## What this bench does NOT measure (and what would)

- **Multi-session memory recall**: tasks are single-turn. mpg's mind
  palace persists, but here we don't validate that an agent that
  stashed during turn N benefits in turn N+10. Adapting LoCoMo /
  LongMemEval is the right next step.
- **Pre-existing palace**: tasks start with an empty palace. The real
  pitch of named memory is reusing prior work; that's a separate bench.
- **Semantic recall**: every task here has a keyword that exists
  verbatim in the corpus. A "what was the design intent behind X"
  task that has no literal keyword would surface embedding strengths
  more cleanly.
