# Multi-Turn Memory Bench

**Tier:** `multiturn`
**Driver:** `bench/multiturn/run.ts`
**Scenarios:** `bench/multiturn/scenarios.ts`

---

## What This Bench Measures

The macro bench measures single-turn lift: "does mpg help the agent answer _one_ question more cheaply?"

This bench measures **cross-turn memory lift**: given a multi-step task where the agent must remember earlier findings, does stashing in turn N produce a real benefit in turn N+k?

Hypothesis: when an agent uses `mpg_stash` to persist key facts from an early question, later questions in the same scenario can retrieve those facts via `mpg_get_stash` or a scoped `mpg_search from:"<stash-name>"` — spending far fewer tokens than re-grepping or re-reading files from scratch.

---

## Design

### Format

Each scenario contains 3-4 related turns. All turns are combined into a single prompt using numbered question markers (`Q1:`, `Q2:`, …). The agent is asked to produce labelled answer sections (`A1:`, `A2:`, …). The driver extracts each answer section and scores it independently.

**Why concatenated rather than truly sequential API calls?** It keeps the harness stateless (one `runAgent` call per arm per scenario) while still requiring the model to plan ahead and use stashing. The treatment system prompt explicitly tells the agent to stash after Q1 so later questions are cheap.

### Arms

| Arm | Tools |
|---|---|
| control | read, grep, write, bash |
| treatment | read, grep, write, bash + mpg_search, mpg_stash, mpg_list_stashes, mpg_get_stash, mpg_drop_stash |

The treatment arm system prompt includes the **MULTI-TURN STASHING STRATEGY** block that instructs the agent to stash early answers immediately and retrieve them when answering later questions.

### Scoring

A turn passes if every expected group has at least one substring match in the corresponding answer section. Groups are AND'd; within a group, phrases are OR'd. Scenario pass rate = turns passed / turns total.

### Budget

`maxTurns: 30`, `maxInputTokens: 100_000` — larger than macro because multi-Q prompts are longer.

---

## Scenarios

### S1 — bloom_stage deep dive (4 turns)

Investigates the bloom_stage_20260322 conductor track, then traces the renderer implementation.

| Turn | Question | Key expected fact |
|---|---|---|
| Q1 | Entity hierarchy in bloom_stage spec | Fractal → Node → Petal → Room → Model → BrowserInteraction |
| Q2 | Which Rust crate implements the renderer? | `fe-renderer` |
| Q3 | Which function loads an asset into Bevy? | `load_to_bevy` |
| Q4 | What camera type does bloom_stage replace? | `Camera2d` |

**Stash opportunity:** Q1 reads the bloom_stage spec. Stashing it lets Q4 reuse it without re-reading. Stashing `fe-renderer` from Q2 scopes Q3's search cheaply.

### S2 — drag_drop_placement prerequisites (4 turns)

Traces the drag_drop_placement_20260402 track's declared dependencies, then drills into the shared ingestion pipeline.

| Turn | Question | Key expected fact |
|---|---|---|
| Q1 | Which two tracks does drag_drop depend on? | `bloom_stage_20260322`, `petal_seed_20260322` |
| Q2 | Maximum GLB file size in the ingestion pipeline? | 256 MB |
| Q3 | What hash algorithm for content addressing? | BLAKE3 |
| Q4 | Which file contains GltfIngester? | `fe-renderer/src/ingester.rs` |

**Stash opportunity:** Q1's spec background section contains the size limit (Q2) and hash algorithm (Q3). Stashing that section lets the agent answer Q2-Q3 without re-reading. Q4 is answerable from the same stash or a quick grep.

### S3 — Mycelium P2P cross-crate trace (4 turns)

Traces the mycelium_live spec intent through to actual source code, then identifies P2P deps.

| Turn | Question | Key expected fact |
|---|---|---|
| Q1 | FR-1 listen address format from mycelium_live spec | `/ip4/0.0.0.0/udp/0/quic-v1` |
| Q2 | Which file contains spawn_network_thread? | `fe-network/src/lib.rs` |
| Q3 | Tokio runtime flavor used in that function? | `current_thread` |
| Q4 | Two iroh-* crates from p2p_mycelium background? | `iroh-blobs`, `iroh-docs` |

**Stash opportunity:** Q2's file content answers Q3. Stashing `fe-network/src/lib.rs` after Q2 lets Q3 retrieve the runtime flavor without re-reading. Q4 requires the p2p_mycelium spec — an agent that pre-read both specs can answer it from a stash.

---

## What Success Looks Like

| Signal | Interpretation |
|---|---|
| `lift.pass_rate > 0` | Treatment arm correctly answers more turns — stashing improved recall |
| `lift.input_tokens < 0` | Treatment arm used fewer input tokens — stashing reduced re-reading |
| Treatment toolCalls < Control toolCalls | Agent retrieved stashes rather than re-grepping |
| Both arms near 100% pass rate | Scenarios are too easy; tighten expected phrases |
| Both arms near 0% pass rate | Corpus lookup is broken or prompts are malformed |

A meaningful result is: treatment pass rate higher than control AND input tokens lower — demonstrating that early stashing both improves accuracy and reduces cost.

---

## Running

```sh
# With API key in .env or environment:
npx tsx bench/multiturn/run.ts

# Different model:
MPG_BENCH_MODEL=claude-sonnet-4-5 npx tsx bench/multiturn/run.ts

# Without API key: writes a skipped record and exits 0.
npx tsx bench/multiturn/run.ts
```

Results are written to `bench/results/multiturn-<ISO>.json`.

---

## Output Shape

```json
{
  "status": "ok",
  "model": "claude-haiku-4-5-20251001",
  "corpus_root": "C:/Users/.../fractalengine",
  "scenarios": 3,
  "cells": [
    {
      "scenarioId": "S1-bloom-then-renderer",
      "scenarioLabel": "...",
      "arm": "control",
      "totalPassed": 3,
      "totalTurnsExpected": 4,
      "pass_rate": 0.75,
      "inputTokens": 42000,
      "outputTokens": 800,
      "toolCalls": 12,
      "turns": 8,
      "ms": 14200,
      "hitCap": "none"
    }
  ],
  "summary": {
    "control":   { "pass_rate": 0.67, "mean_input_tokens": 38000, ... },
    "treatment": { "pass_rate": 0.83, "mean_input_tokens": 22000, ... }
  },
  "lift": {
    "pass_rate":     0.16,
    "input_tokens":  -0.42,
    "output_tokens": -0.15,
    "ms":            -0.20
  },
  "generated_at": "2026-06-07T20:00:00.000Z"
}
```

Lift signs: positive `pass_rate` lift is good (treatment more accurate). Negative `input_tokens` lift is good (treatment cheaper).
