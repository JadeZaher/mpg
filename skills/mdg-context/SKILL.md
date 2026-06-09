---
name: mdg-context
description: >
  Token-budgeted codebase search with composable short-term memory.
  Search files, command output, and URLs for regex patterns; results
  return as context nodes sized in tokens (not lines) with file:line
  attribution. Persistent "mind palace" of named stashes can be
  composed, intersected, linked into a graph, pruned by age/tag/count,
  and traversed. Three integration paths: MCP server (Claude Desktop,
  Claude Code, Cline, Windsurf), CLI shell-out (any agent), and
  programmatic import (Anthropic / Google SDKs).
  Use for codebase exploration, multi-step investigation, finding
  references, and building cross-invocation working memory.
tools:
  - mdg_search
  - mdg_stash
  - mdg_list_stashes
  - mdg_get_stash
  - mdg_drop_stash
install:
  npm: npm install -g mdg-cli
  source: git clone https://github.com/JadeZaher/mdg && cd mdg && npm install && npm run build && npm link
  verify: mdg --version
---

# mdg-context — Codebase Context Retrieval Skill

## The lens mental model

mdg is a single **lens over the corpus**, not a separate tool you reach
for after grep and read. There are no boundaries between files — you
dial the lens to fit the task:

- **Focal points** = matches (set by the pattern + sort + fuzzy).
- **Depth at each focal point** = the window (`effort` / `clip_chars` /
  `before` / `after` / `window_curve`).
- **Surface** = where the lens looks (`in`, `from`, `compose`, `page`).

With the right flags, one `mdg_search` call replaces what would
otherwise be 1–N `grep` + `read` combos:

| Job | Lens setting |
| :--- | :--- |
| "List file:line hits, like grep" | `effort: "scan", clip_chars: 30` (3.2× cheaper than rg on bench corpora) |
| "Read this one file for what it says about X" | `in: ["file.md"], effort: "deep"` |
| "Browse recent memory for X" | `effort: "scan", sort: "recent", page: 1, page_size: 10` |
| "Compact a topic to N tokens" | `effort: "scan", clip_chars: 30, max_tokens: N` |
| "Catch a typo'd term" | `fuzzy: true` |
| "Search only files I already touched" | `from: "<stash-name>"` |

The mind palace (`mdg_stash`) is just persistent state for the lens:
stash a result and the next search can be scoped to those files
across the entire corpus without re-scanning.

## Quick start

```bash
npm install -g mdg-cli && mdg --version
```

If running through an MCP-capable host (Claude Desktop, Claude Code,
Cline, Windsurf, Continue.dev), the five tools below register
automatically once the `mdg` MCP server is configured.

## When to use

The lens table above is the short answer. Below is the same advice
indexed by situation.

| Situation | Tool |
| :--- | :--- |
| "Browse my recent memory — what just changed about X?" | `mdg_search` (`effort: "scan", sort: "recent", clip_chars: 30`) |
| "Where is X referenced?" | `mdg_search` (`effort: "scan", clip_chars: 30`) — cheapest hit list |
| "Need context around a match" | `mdg_search` (`effort: "quick"`) — small windows around top 10 hits |
| "Deep context for one targeted answer" | `mdg_search` (`effort: "deep"`) — 100 nodes × 2k tokens each |
| "User typed a typo — find anyway" | `mdg_search` (`fuzzy: true`) — edit distance ≤ 2 |
| "Compact a topic into a token budget" | `mdg_search` (`effort: "scan", clip_chars: 30, max_tokens: N`) |
| "I'll need these hits again later" | `mdg_stash` |
| "Search only files I previously stashed" | `mdg_search` (`from` or `compose`) |
| "What stashes do I have?" | `mdg_list_stashes` |
| "Forget this stash" | `mdg_drop_stash` |
| "Just read one file" | use the host's read tool — mdg is for *searching* |
| "Search a URL or command output" | `mdg_search` (`url` or `cmd`) — see `references/sources.md` |

## Effort presets and shape knobs

| effort | before | after | max_nodes | use case |
| :--- | ---: | ---: | ---: | :--- |
| **scan**  |  20  |  20 |   uncapped | **Index mode.** Every hit gets a tiny disambiguating window. Recall AND precision match rg regardless of hit count; tokens scale O(hits). Combine with `clip_chars: 30` and `sort: "recent"` for the cheapest first-touch index. |
| **quick** | 200 | 200 |     10 | **DEFAULT.** Small windows, small cap. First touch of a topic. |
| normal | 500 | 500 |     30 | Bump when quick was ambiguous. |
| deep   | 2000 | 2000 |   100 | Final answer grounding — for one targeted query you commit to. |

Shape knobs (mix with any effort):

| flag | what it does | when it wins |
| :--- | :--- | :--- |
| `clip_chars: N` | Sub-line snippet around the matched span (N chars each side, ellipsis-marked). Drops per-line context entirely. | **Memory-corpus literal recall**: scan + clip_chars=30 is 3.2× cheaper than ripgrep (377 vs 1197 tokens) at 100% recall + 100% precision on the same corpus. |
| `fuzzy: true` | Trigram-union driver + Levenshtein post-filter (edit distance ≤ 2). Handles drop / insert / substitute / swap typos. | **Typo recovery**: 100% recall on typo'd input vs rg's 0%. 12× cheaper than per-file embeddings. |
| `sort: "recent"` | Order returned nodes by source-file mtime, newest first. | **Time-ordered memory index**: combine with scan and pagination to browse "what just changed" first; dig deeper into history on demand. |
| `window_curve: "log"` | Per-node window decays as `full / log2(rank+2)`. Rank 0 keeps full context; later ranks shrink. | **Recency-weighted context**: saves ~53% tokens vs flat windows while keeping the top hit's full context. Pairs with sort:recent. |

### Recommended patterns (bench-driven)

**1. Cheapest first-touch index — "browse my memory"**

```ts
mdg_search({
  pattern: "JWT Bearer",          // or any concept keyword
  in: ["./conductor/tracks"],
  effort: "scan",
  clip_chars: 30,
  sort: "recent",
  page: 1,
  page_size: 10
})
```

What you get: file:line hits with a 30-char snippet on each side, sorted by recency, paginated. Empirically **3.2× cheaper than rg** (377 vs 1197 tokens) at 100/100 recall/precision on memory-system content. Skip to deeper modes only when this isn't enough.

**2. Typo-tolerant search**

```ts
mdg_search({ pattern: "PrvderiContext", in: [...], fuzzy: true })
```

`fuzzy: true` catches all four common typo modes (drop / insert / substitute / swap). Use when the user's input is uncertain.

**3. Scan → stash → drill-down across turns**

```ts
// Turn 1: scan + stash
const scan = await mdg_search({ pattern: "...", effort: "scan", clip_chars: 30, sort: "recent" });
await mdg_stash({ name: "topic-index", note: "...", tags: ["topic"] });

// Turn 2+: drill into ONE file from the index
await mdg_search({ pattern: "...", effort: "normal", from: "topic-index" });
```

The mind palace makes the index addressable across turns. Re-scoping to a stash is cheaper than re-searching the whole tree.

**4. Compaction at zero LLM cost**

```ts
// Produces a topic-focused compaction in one tool call.
mdg_search({
  pattern: "auth|JWT|Bearer|ProviderContext",  // OR your topic keywords
  in: ["..."],
  effort: "scan",
  clip_chars: 30,
  sort: "recent",
  window_curve: "log",
  max_tokens: 2000               // hard cap the compaction size
})
```

On the compaction bench, this single CLI call beats LLM-driven summarization (67% pass vs 33%) at **zero LLM input tokens**. Use when you'd otherwise spend a 50k-token summarization round-trip.

**5. Whole-repo scan ("does X appear anywhere?")**

```ts
mdg_search({ pattern: "ProviderContext", in: ["."], effort: "scan", clip_chars: 20 })
```

Pass directories — including `.` — directly. The dir spec goes straight to ripgrep's parallel ignore-aware walk, so a full-repo scan is comparable to running `rg` itself rather than fanning out per file. Don't pre-expand to a file list in your harness; that's strictly slower.

**6. Cross-cutting set-ops on stashed evidence**

```bash
# union: files matching either thread
mdg_search({ pattern: "Redis", compose: ["rate-limit-impl", "rate-limit-docs"] })
# intersection: files mentioned in BOTH threads (CLI only)
mdg --mp-intersect rate-limit-impl rate-limit-docs
# subtraction: in A but not in B (CLI only)
mdg --mp-except rate-limit-impl --mp-except-name rate-limit-archived
```

Use this instead of "let me list both stashes and diff in my head." The set operations are O(stash count), not O(corpus).

**7. Filter opaque tool output / web pages without reading the whole body**

The job mdg does best is **token-budgeting a payload you don't want
to read in full**. WebFetch on a long doc page, `gh pr view --json`,
`kubectl describe`, `terraform plan`, `npm ls`, a CI log — these are
all the same shape: many KB of mostly-irrelevant text wrapping the few
lines that actually answer the question. Route the source through
`mdg --cmd "..."` or `mdg --url "..."` instead of dumping the full
body into context.

```ts
// WebFetch a doc page, only see the auth section
mdg_search({
  pattern: "authentication|auth|token",
  url: "https://example.com/api/docs",
  effort: "scan", clip_chars: 50, max_tokens: 1500
})

// Pull just the failing tests from a verbose CI log
mdg_search({
  pattern: "FAIL|✗|error TS",
  cmd: "gh run view --log 12345",
  effort: "scan", clip_chars: 80, max_tokens: 2000
})

// Filter `kubectl describe` to just events / errors
mdg_search({
  pattern: "Warning|Error|Failed",
  cmd: "kubectl describe pod my-pod",
  effort: "scan", clip_chars: 100
})
```

Three rules of thumb:

1. **If a tool output is >3 KB and you only care about 1–2 patterns,
   route it through mdg.** The wins compound — every avoided
   full-body read is tokens you can spend on reasoning.
2. **Stash the filtered result if you'll reference it again.**
   Filtered tool output is often the cheapest stash you'll ever make.
   Next turn's `--mp-get` is free.
3. **Set `max_tokens` explicitly when filtering opaque payloads.**
   Tool output can spike (thousands of ERROR lines in a log) and the
   default node caps are sized for code, not for runaway streams.

Hard caps you can rely on so a hostile or runaway source can't drain
context: `url` is capped at 16 MB and 30 s with a content-type guard;
`cmd` is capped at 64 MB and 60 s. Past those, mdg returns truncated
output with a marker — not a hung agent.

### Behavior you can rely on

These are the load-bearing guarantees worth quoting at yourself before
deciding whether to re-search vs recall:

- **Directory scans are cheap.** `--in <dir>` passes through to rg's
  parallel walk. You don't need to pre-expand a dir to a file list.
- **Parallel `--mp-stash` calls don't lose data.** Two processes
  stashing different findings at the same moment both land cleanly —
  a tmp-file + rename plus a sibling `.lock` serialize the write step,
  and a diff-based merge means each writer's intent (added X, modified
  Y, removed Z) is replayed on top of fresh on-disk state.
- **`--mp-drop` persists.** When drop reports success, the entry is
  gone from disk and stays gone — even if a follow-up stash from
  another process commits afterwards. Treat the exit code as truth.
- **Pathological lines won't crash you.** Alternation patterns
  (`(TODO|FIXME|HACK)`) over minified assets complete in tens of ms;
  per-match text is hard-capped at 16 KB with a `…[clipped]` marker.
- **Result status is honest.** `partial` means some sources errored;
  `result.errors[]` is structured. A quiet `no_matches` is reliable;
  a quiet `partial` is not — always inspect `errors[]` before
  concluding "nothing here."
- **Empty / whitespace-only fuzzy patterns throw**, instead of
  silently matching every line and exploding the token budget.
- **`--json` is an alias for `--format json`** (matches `rg`, `gh`,
  `jq`). Either works; `--json` is shorter.

## The five MCP tools (signatures only)

| Tool | Required params | Optional |
| :--- | :--- | :--- |
| `mdg_search` | `pattern` | `in[]`, `cmd`, `url`, `before`, `after`, `max_nodes`, `max_tokens`, `effort` (scan/quick/normal/deep), `strategy`, `from`, `compose[]`, `page`, `page_size`, `all`, **`clip_chars`** (sub-line snippet N), **`fuzzy`** (typo-tolerant), **`sort`** ("recent"/"oldest"/"default"), **`window_curve`** ("flat"/"linear"/"log") |
| `mdg_stash` | `name` | `note`, `tags[]`, `replace` |
| `mdg_list_stashes` | — | `tag_filter[]`, `page`, `page_size` |
| `mdg_get_stash` | `name` | `page`, `page_size` |
| `mdg_drop_stash` | `name` | — |

The mind palace has a *wider* surface than the five MCP tools above
(relationships, pruning, TTL, intersect/except, isolated palaces).
Those are CLI-only today — see `references/mind-palace.md`.

## Golden rules

1. **Stash by default, with a TTL.** Even if you think you won't reuse it. Stashes are cheap; an unbounded palace is not. `--mp-ttl 4h` on scratch, `--mp-ttl 24h` on findings, no TTL on canonical context.
2. **Tag every stash.** `auth`, `p0`, `scan`, `finding`, `review` — pays off at >10 stashes and makes `--mp-prune-tag` trivial.
3. **Compose before concluding.** Set-union across two stashes catches cross-cutting evidence one search would miss. Re-reading is ~3× more expensive than `--mp-from` over the same files.
4. **Prune actively, not eventually.** Run `--mp-prune-expired` at session start and `--mp-prune-tag scan` (or `--mp-prune-keep 30`) between major phases. Always `--mp-prune-dry-run` first.
5. **One palace per task.** Pass `--mp-path` or set `MDG_MIND_PALACE` per task to keep contexts isolated. Cross-task palaces bleed and waste tokens.
6. **Page large results.** Pass `page: 1, page_size: 5` for searches with >10 expected hits; check `pagination.has_next`.
7. **Read `errors[]` even when `status === "ok"`.** A `"partial"` status means some sources errored — the result is real but incomplete. Decide if the missing sources mattered before concluding.

## Pagination pattern

```
Start:  mdg_search(pattern, page: 1, page_size: 5)
Check:  result.pagination.has_next
If yes: mdg_search(pattern, page: 2, page_size: 5)
Stop when has_next is false or you have enough context.
```

Same pattern for `mdg_list_stashes` and `mdg_get_stash`.

## Error recovery

| Condition | What to do |
| :--- | :--- |
| `status: "no_matches"` | Broaden pattern, drop `-w`, add `-I` (case-insensitive). |
| `status: "truncated"` | Hit `--max-tokens`. Narrow pattern OR increase budget. |
| `status: "partial"` | Some sources errored, others returned matches. Inspect `result.errors[]` — decide whether the missing sources mattered. Common cause: a single pathological file (minified asset) that you can `--exclude`. |
| `status: "error"` | All sources errored. Check `result.errors[]` and stderr. Common: unknown stash name (`mdg_list_stashes`), rg not installed, bad regex. |
| Unknown stash | Run `mdg_list_stashes` to discover. |
| `pagination.has_next` | More data exists. Decide if current page is enough. |
| `--mp-from` returns nothing | Stashed files may have moved or been deleted. Re-stash fresh. |
| `WARNING — mind palace is corrupt` on stderr | mdg copied the bad file aside as `<palace>.corrupt.<ts>` and is refusing to save. Inspect the backup, then either fix it by hand or set `MDG_FORCE_RESET=1` to start fresh. **Do not** plow on without reading the backup — you will lose every stash. |

## Long-context backoff workflow

This is the part that's underused. The mind palace is not just
storage; it's a **token budget** for the conversation. Treat it
like working memory with a budget, and prune actively.

The shape of a long-horizon task:

| Phase | What to do |
| :--- | :--- |
| **Open** | At session start, `mdg --mp-prune-expired` to clear stashes whose TTL passed. Optional `--mp-prune-older-than 24h` if the previous session left scratch. |
| **Explore** | Use `effort: "scan", clip_chars: 30, sort: "recent"` to build a cheap first-touch index. **Always** stash these scan results with a TTL: `--mp-ttl 4h`, tags like `scan` and the topic. The TTL is the auto-cleanup; without it, scan-stashes accumulate. |
| **Drill** | `--mp-from <scan-stash>` to re-scope a deeper search to just the files the scan flagged. Stash these too, but with a longer TTL (`--mp-ttl 24h`) and an unambiguous topic tag — these are findings, not scratch. |
| **Synthesize** | Before answering, `--mp-compose <finding-a> <finding-b>` to feed the union back as the search target. Saves you re-reading the source — the stashed nodes are already token-budgeted. For "what's the intersection of two threads?" use `--mp-intersect`. |
| **Close** | `--mp-prune-tag scan` (or whatever scratch tag you used) to drop exploratory clutter. Keep findings. The palace should shrink between sessions, not grow. |

Concrete budget targets that work:

- ≤20 active stashes in a single palace before retrieval becomes
  noisy.
- TTLs that match the work cadence: `4h` for scan-and-discard scratch,
  `24h` for findings you might revisit tomorrow, no TTL for
  cross-session canonical context.
- One palace per major task (`MDG_MIND_PALACE=.mdg/<task-id>.json`).
  Don't mix unrelated tasks — context bleed wastes more tokens than
  isolated palaces save.

Token math you can quote at the LLM:

> Recomputing a scan is ~1200 rg tokens. Reading the same stash via
> `--mp-from` is ~377 tokens (3.2× cheaper). Pruning is free.

That ratio is why **prune + compose** beats **re-search** every time
at the synthesis step.

## What the bench data says (informs the patterns above)

Headline numbers from `BENCHMARKS.md` (oasis-sleek conductor tracks corpus — markdown specs + JSON metadata):

| comparison | mdg config | result |
| :--- | :--- | :--- |
| Literal recall vs **ripgrep** | `scan + clip_chars: 30` | 100% / 100% / **377 tokens** vs rg's 1197 — **3.2× cheaper than rg** |
| Typo recovery | `fuzzy: true` | 100% recall vs rg's 0%, 89% precision, ~1900 tokens. Embeddings get 45% at 23,610 tokens. |
| Compaction at fixed budget | `scan + clip + max_tokens` (no LLM) | 67% pass beats LLM summarization (33%) at zero LLM cost |
| Multi-turn convergence | treatment uses mdg + stash | 24% fewer input tokens, **half the tool calls and turns** vs control |
| Mind palace set semantics | `compose` / `intersect` / `except` / graph | 17/17 micro assertions pass |

Where mdg loses on the bench (worth knowing):
- **Single-keyword lookups** where you only need a file:line list (T2 BLAKE3, T3 load_to_bevy in macro): rg is cheaper. Use `bash`/`grep` for one-word answers.
- **Cold-start wall-clock**: ~200ms per CLI call. MCP server / programmatic import avoid this (the cost is paid once at boot).

## Read further (load on demand)

When you need depth on one of these areas, read the matching file:

- `references/integration.md` — MCP server vs CLI vs programmatic SDK import; when to prefer each.
- `references/mind-palace.md` — full mind palace surface: relationships, pruning, TTL, set ops (`compose`/`except`/`intersect`), graph traversal, multi-palace isolation.
- `references/sources.md` — search files, dirs, globs, command stdout (`--cmd`), URLs (`--url`), stdin (`--stdin`); `--include`/`--exclude`/`--type` filters.
- `references/multi-agent.md` — palace sharing across agents, write-write race caveats, recommended layouts.
- `references/anti-patterns.md` — full list of what NOT to do and why.
