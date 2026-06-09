---
name: mpg-context
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
  DO NOT use mpg for: a single known file path (use Read); a single
  symbol grep on a small tree where you expect ≤ ~30 hits (use Grep);
  files under ~200 lines you'll fully consume (the budgeting overhead
  is only worth it for >1KB result sets or persistent recall). The
  decision tree under "When NOT to use mpg" makes the cutoff concrete.
tools:
  - mpg_search
  - mpg_stash
  - mpg_list_stashes
  - mpg_get_stash
  - mpg_drop_stash
install:
  npm: npm install -g mpg-cli
  source: git clone https://github.com/JadeZaher/mind-palace-graph && cd mind-palace-graph && npm install && npm run build && npm link
  verify: mpg --version
---

# mpg-context — Codebase Context Retrieval Skill

## The lens mental model

mpg is a single **lens over the corpus**, not a separate tool you reach
for after grep and read. There are no boundaries between files — you
dial the lens to fit the task:

- **Focal points** = matches (set by the pattern + sort + fuzzy).
- **Depth at each focal point** = the window (`effort` / `clip_chars` /
  `before` / `after` / `window_curve`).
- **Surface** = where the lens looks (`in`, `from`, `compose`, `page`).

With the right flags, one `mpg_search` call replaces what would
otherwise be 1–N `grep` + `read` combos:

| Job | Lens setting |
| :--- | :--- |
| "List file:line hits, like grep" | `effort: "scan", clip_chars: 30` (3.2× cheaper than rg on bench corpora) |
| "Read this one file for what it says about X" | `in: ["file.md"], effort: "deep"` |
| "Browse recent memory for X" | `effort: "scan", sort: "recent", page: 1, page_size: 10` |
| "Compact a topic to N tokens" | `effort: "scan", clip_chars: 30, max_tokens: N` |
| "Catch a typo'd term" | `fuzzy: true` |
| "Search only files I already touched" | `from: "<stash-name>"` |

The mind palace (`mpg_stash`) is just persistent state for the lens:
stash a result and the next search can be scoped to those files
across the entire corpus without re-scanning.

## When NOT to use mpg

mpg has a real startup cost (~200ms cold) and the budgeting machinery
only pays off above a certain payload size. Use the wrong tool for the
job and you pay overhead for no win. The cutoffs in plain terms:

```
mpg vs alternative?
├─ Known file path, you want to read it       → host's Read tool
├─ Single symbol grep, ≤ ~30 hits expected    → host's Grep / rg
├─ One file < 200 lines, you'll read it all   → Read it directly
├─ One-word "does X exist?" answer            → rg / grep is cheaper
├─ Multi-file scan, results > ~1KB total      → mpg_search
├─ Need persistent recall across turns        → mpg_search + mpg_stash
├─ Cross-cutting investigation, 2+ threads    → mpg_search --mp-compose
├─ Already stashed the file set you want      → --mp-from (skip re-scan)
└─ Opaque tool output > ~3KB you want to filter → mpg --cmd or --url
```

Hard rule: **if you can name the file and you're going to consume the
whole thing, do not route through mpg**. The token budgeter assumes you
want a *subset* of a *larger* payload. When the payload is small, the
overhead (~200ms cold start, plus token-counting work) buys nothing.

## Palace lifecycle (one cycle = one task)

The palace is **working memory**, not an archive. Plan stash usage along
this cycle — it's the difference between "I have 47 stashes and no idea
which ones matter" and "I have 8 stashes that map to the open threads."

```
                  ┌─────────────────────────────────────┐
                  ↓                                     │
  CAPTURE  →  TAG  →  LINK  →  REUSE  →  PRUNE  →  CLOSE
  (--mp-stash)        (--mp-link)   (--mp-from)   (--mp-prune-*)
                                    (--mp-compose)
```

| Verb | When | Flag |
| :--- | :--- | :--- |
| **Capture** | Anything you might reference more than once. Cheap. | `--mp-stash <name> <note> --mp-ttl 4h` |
| **Tag** | At capture time. Repeat the flag for multiple tags. | `--mp-stash-tag scan --mp-stash-tag topic` (NOT comma-separated — that becomes one literal tag named `scan,topic`) |
| **Link** | The moment you notice a relationship — three sessions later you won't remember why two stashes mattered together. | `--mp-link <from> <to> <type> [note]` |
| **Reuse** | Re-scope a deeper search to a stash's file list. 3× cheaper than re-scanning the whole tree. | `--mp-from <name>` (one), `--mp-compose <a> <b>` (union), `--mp-intersect` (both) |
| **Prune** | At session open AND between major phases. The palace should shrink between sessions, not grow. | `--mp-prune-expired` (free), `--mp-prune-tag scan` (drop scratch), `--mp-prune-keep 20` (cap) |
| **Close** | At session close, drop scratch tags; keep findings. | `--mp-prune-tag scan` |

Three rules of thumb for the lifecycle:

1. **Always TTL scratch.** `--mp-ttl 4h` on exploratory scans, `--mp-ttl 24h` on findings, no TTL on canonical context. Auto-prune on `--mp-list`/`--mp-get` will clean up the rest.
2. **One palace per task.** Set `MPG_MIND_PALACE=.mpg/<task>.json` or pass `--mp-path` per invocation. Today there is one *active* palace per call — there is no cross-palace federation; isolation is the path you point at. Don't mix unrelated tasks in one palace.
3. **`--mp-list` is the palace overview; `--mp-get` is the per-stash card view; `--mp-get --with-nodes` is the full read.** `--mp-list` is one line of metadata per stash — best for "what's in my palace?". `--mp-get <name>` is the **card view by default**: note, tags, relations, sources, and counts (5–6× cheaper than the old full dump — the synthesized intel without the captured bodies). Add `--with-nodes` (or its synonym `--full`) only when you actually need the captured node context. Pagination only applies in `--with-nodes` mode; use `--page 1 --page-size 5` when a stash is large.

## Quick start

```bash
npm install -g mpg-cli && mpg --version
```

If running through an MCP-capable host (Claude Desktop, Claude Code,
Cline, Windsurf, Continue.dev), the five tools below register
automatically once the `mpg` MCP server is configured.

## When to use

The lens table above is the short answer. Below is the same advice
indexed by situation.

| Situation | Tool |
| :--- | :--- |
| "Browse my recent memory — what just changed about X?" | `mpg_search` (`effort: "scan", sort: "recent", clip_chars: 30`) |
| "Where is X referenced?" | `mpg_search` (`effort: "scan", clip_chars: 30`) — cheapest hit list |
| "Need context around a match" | `mpg_search` (`effort: "quick"`) — small windows around top 10 hits |
| "Deep context for one targeted answer" | `mpg_search` (`effort: "deep"`) — 100 nodes × 2k tokens each |
| "User typed a typo — find anyway" | `mpg_search` (`fuzzy: true`) — edit distance ≤ 2 |
| "Compact a topic into a token budget" | `mpg_search` (`effort: "scan", clip_chars: 30, max_tokens: N`) |
| "I'll need these hits again later" | `mpg_stash` |
| "Search only files I previously stashed" | `mpg_search` (`from` or `compose`) |
| "What stashes do I have?" | `mpg_list_stashes` |
| "Forget this stash" | `mpg_drop_stash` |
| "Just read one file" | use the host's read tool — mpg is for *searching* |
| "Search a URL or command output" | `mpg_search` (`url` or `cmd`) — see `references/sources.md` |

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
mpg_search({
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
mpg_search({ pattern: "PrvderiContext", in: [...], fuzzy: true })
```

`fuzzy: true` catches all four common typo modes (drop / insert / substitute / swap). Use when the user's input is uncertain.

**3. Scan → stash → drill-down across turns**

```ts
// Turn 1: scan + stash
const scan = await mpg_search({ pattern: "...", effort: "scan", clip_chars: 30, sort: "recent" });
await mpg_stash({ name: "topic-index", note: "...", tags: ["topic"] });

// Turn 2+: drill into ONE file from the index
await mpg_search({ pattern: "...", effort: "normal", from: "topic-index" });
```

The mind palace makes the index addressable across turns. Re-scoping to a stash is cheaper than re-searching the whole tree.

**4. Compaction at zero LLM cost**

```ts
// Produces a topic-focused compaction in one tool call.
mpg_search({
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
mpg_search({ pattern: "ProviderContext", in: ["."], effort: "scan", clip_chars: 20 })
```

Pass directories — including `.` — directly. The dir spec goes straight to ripgrep's parallel ignore-aware walk, so a full-repo scan is comparable to running `rg` itself rather than fanning out per file. Don't pre-expand to a file list in your harness; that's strictly slower.

**6. Cross-cutting set-ops on stashed evidence**

```bash
# union: files matching either thread
mpg_search({ pattern: "Redis", compose: ["rate-limit-impl", "rate-limit-docs"] })
# intersection: files mentioned in BOTH threads (CLI only)
mpg --mp-intersect rate-limit-impl rate-limit-docs
# subtraction: in A but not in B (CLI only)
mpg --mp-except rate-limit-impl --mp-except-name rate-limit-archived
```

Use this instead of "let me list both stashes and diff in my head." The set operations are O(stash count), not O(corpus).

**7. Filter opaque tool output / web pages without reading the whole body**

The job mpg does best is **token-budgeting a payload you don't want
to read in full**. WebFetch on a long doc page, `gh pr view --json`,
`kubectl describe`, `terraform plan`, `npm ls`, a CI log — these are
all the same shape: many KB of mostly-irrelevant text wrapping the few
lines that actually answer the question. Route the source through
`mpg --cmd "..."` or `mpg --url "..."` instead of dumping the full
body into context.

```ts
// WebFetch a doc page, only see the auth section
mpg_search({
  pattern: "authentication|auth|token",
  url: "https://example.com/api/docs",
  effort: "scan", clip_chars: 50, max_tokens: 1500
})

// Pull just the failing tests from a verbose CI log
mpg_search({
  pattern: "FAIL|✗|error TS",
  cmd: "gh run view --log 12345",
  effort: "scan", clip_chars: 80, max_tokens: 2000
})

// Filter `kubectl describe` to just events / errors
mpg_search({
  pattern: "Warning|Error|Failed",
  cmd: "kubectl describe pod my-pod",
  effort: "scan", clip_chars: 100
})
```

Three rules of thumb:

1. **If a tool output is >3 KB and you only care about 1–2 patterns,
   route it through mpg.** The wins compound — every avoided
   full-body read is tokens you can spend on reasoning.
2. **Stash the filtered result if you'll reference it again.**
   Filtered tool output is often the cheapest stash you'll ever make.
   Next turn's `--mp-get` is free.
3. **Set `max_tokens` explicitly when filtering opaque payloads.**
   Tool output can spike (thousands of ERROR lines in a log) and the
   default node caps are sized for code, not for runaway streams.

Hard caps you can rely on so a hostile or runaway source can't drain
context: `url` is capped at 16 MB and 30 s with a content-type guard;
`cmd` is capped at 64 MB and 60 s. Past those, mpg returns truncated
output with a marker — not a hung agent.

**8. `window_curve` — token sculpting across ranked results**

`window_curve` decides how aggressively per-node windows shrink as you
go down the ranked list. It's the single biggest lever for making one
search call match the *shape* of how an LLM actually consumes results:
the first hit usually needs full context, the tenth probably just
needs a line and a half. Saving tokens past the first few ranks frees
budget for more nodes overall.

Three curves, each with a specific use case:

| Curve | Shape | Use when |
| :--- | :--- | :--- |
| `flat` (default) | Every node gets the full `before`/`after` window. | You need uniform context across all hits. Fine when `max_nodes` is tight (≤5). |
| `linear` | Window shrinks linearly from 100% at rank 0 to ~10% at the last rank. | **"What just changed?" browsing.** Pair with `sort: "recent"` — newest file gets full context, older files get a one-liner each. Roughly 40-50% token savings vs `flat` at the same `max_nodes`. |
| `log` | Window decays as `full / log2(rank + 2)`. Gentler — rank 5 keeps ~38% of full context, not ~50% like linear. | **Multi-hit synthesis.** When ranks 2–10 still carry signal you'd hate to truncate. Used by the compaction pattern. ~53% token savings vs flat. |

Concrete invocations:

```ts
// "What changed in auth recently?" — newest file gets a full read,
// older ones get disambiguating snippets.
mpg_search({
  pattern: "session|token|auth",
  in: ["src/auth/"],
  effort: "deep",
  sort: "recent",
  window_curve: "linear",
})

// Compaction — the canonical 0-LLM-cost summary pattern. log curve
// keeps the top 3 hits substantial while letting the long tail shrink.
mpg_search({
  pattern: "auth|JWT|Bearer|ProviderContext",
  in: ["."],
  effort: "scan",
  clip_chars: 30,
  sort: "recent",
  window_curve: "log",
  max_tokens: 2000,
})

// Use flat when you genuinely need all hits with equal weight (e.g.
// reviewing every TODO before a release).
mpg_search({
  pattern: "TODO|FIXME",
  in: ["src/"],
  effort: "normal",
  window_curve: "flat",  // default; named for clarity
})
```

Rule of thumb: if you're using `sort: "recent"` or `"oldest"`, you
almost always want a non-flat curve. Flat + sort wastes tokens on the
ranks that already lost the prioritization battle. The two go
together.

**9. Linked palace nodes — building a graph of investigation threads**

Stashes are powerful by themselves, but the real win on a multi-day
investigation is when you can **traverse between them by intent**, not
by remembering names. `--mp-link` makes a directed edge between two
stashes; `--mp-related` lists everything connected to a stash;
`--mp-graph` walks the graph N levels deep.

When to link (and what edge types to use):

| Edge type | Meaning | Example |
| :--- | :--- | :--- |
| `depends-on` | "B is a precondition for understanding A" | `mpg --mp-link auth-rewrite db-schema depends-on "new tables back the migration"` |
| `supersedes` | "A is the current view; B is the old one" | `mpg --mp-link auth-v2 auth-v1 supersedes "post-rewrite, ignore v1"` |
| `see-also` | "B is a related thread you'll want when reading A" | `mpg --mp-link rate-limit-impl rate-limit-docs see-also "implementation ↔ design"` |
| `parent-of` / `child-of` | Subtopics of a larger investigation | `mpg --mp-link epic-payments stripe-webhooks parent-of "webhook handling is part of payments"` |
| `blocks` | "A can't ship without resolving B" | `mpg --mp-link release-v3 schema-migration blocks "must run migration first"` |
| `contradicts` | "A and B disagree — needs reconciliation" | `mpg --mp-link spec-claim impl-reality contradicts "spec says X, code does Y"` |

Edge types are conventional strings, not enforced — pick any
vocabulary, but stay consistent within one investigation.

Typical workflow:

```bash
# 1. Build stashes as you investigate, with consistent tags
mpg "JWT" --in src/auth/  --mp-stash auth-jwt   --mp-tag rewrite --mp-ttl 24h
mpg "JWT" --in docs/spec/ --mp-stash spec-jwt   --mp-tag rewrite --mp-ttl 24h
mpg "JWT" --in src/legacy/ --mp-stash legacy-jwt --mp-tag rewrite --mp-ttl 24h

# 2. Link them as you discover relationships
mpg --mp-link auth-jwt spec-jwt see-also "implementation of the spec"
mpg --mp-link auth-jwt legacy-jwt supersedes "post-rewrite, legacy goes away"

# 3. Next session: navigate by intent, not by name
mpg --mp-related auth-jwt           # show neighbors + edge labels
mpg --mp-graph auth-jwt 2           # BFS two hops out
```

Rules of thumb:

1. **Only link what you'll traverse.** Edges are cheap, but a graph
   nobody walks is just noise on `--mp-related`. If you wouldn't run
   `--mp-graph` later, don't link.
2. **Link when discovery is fresh.** The right time to add an edge is
   the moment you notice the relationship — three sessions later you
   won't remember why two stashes mattered together.
3. **One vocabulary per investigation.** Mixing `depends-on` and
   `requires` for the same concept makes traversal noisy. Pick one
   and stick to it; rename via unlink/relink if you change your mind.
4. **`--mp-graph` is your "context resurrection" tool.** When a
   conversation gets compacted away and you need to rebuild the
   thread, `mpg --mp-graph <root> 3` reconstructs the investigation
   topology in one CLI call.
5. **Don't link across unrelated tasks.** If you're disciplined about
   one palace per task (`MPG_MIND_PALACE=.mpg/<task>.json`), this is
   automatic — cross-task links can't even be expressed.

The full set of graph operations is CLI-only (not MCP yet) —
`--mp-link`, `--mp-unlink`, `--mp-related`, `--mp-graph`. See
`references/mind-palace.md` for the storage format.

**Traversal semantics worth knowing:**

- `--mp-related <name>` — shows direct neighbors in **both directions**
  (inbound and outbound). Use this for a single-hop "what's connected to
  X" view.
- `--mp-graph <name> [depth]` — BFS from `<name>`. Depth 1 is
  **bidirectional** (both outbound edges from `<name>` and inbound edges
  pointing at `<name>`). Depth ≥ 2 follows **outbound only**. A leaf-to-leaf
  edge (e.g. `a → c` and `b → c` from a root that points at both `a` and
  `b`) shows up exactly once via the first BFS path that reaches `c`; the
  second edge is hidden by visited-deduplication.
- If you suspect a relationship the graph isn't surfacing, fall back to
  `--mp-related` on the *target* of the suspected edge — that view is
  always bidirectional.

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
| `mpg_search` | `pattern` | `in[]`, `cmd`, `url`, `before`, `after`, `max_nodes`, `max_tokens`, `effort` (scan/quick/normal/deep), `strategy`, `from`, `compose[]`, `page`, `page_size`, `all`, **`clip_chars`** (sub-line snippet N), **`fuzzy`** (typo-tolerant), **`sort`** ("recent"/"oldest"/"default"), **`window_curve`** ("flat"/"linear"/"log") |
| `mpg_stash` | `name` | `note`, `tags[]`, `replace` |
| `mpg_list_stashes` | — | `tag_filter[]`, `page`, `page_size` |
| `mpg_get_stash` | `name` | `with_nodes` (default false — card view; pass `true` for full nodes), `page`, `page_size` (only honored with `with_nodes: true`) |
| `mpg_drop_stash` | `name` | — |

The mind palace has a *wider* surface than the five MCP tools above
(relationships, pruning, TTL, intersect/except, isolated palaces).
Those are CLI-only today — see `references/mind-palace.md`.

## Golden rules

1. **Stash by default, with a TTL.** Even if you think you won't reuse it. Stashes are cheap; an unbounded palace is not. `--mp-ttl 4h` on scratch, `--mp-ttl 24h` on findings, no TTL on canonical context.
2. **Tag every stash.** `auth`, `p0`, `scan`, `finding`, `review` — pays off at >10 stashes and makes `--mp-prune-tag` trivial.
3. **Compose before concluding.** Set-union across two stashes catches cross-cutting evidence one search would miss. Re-reading is ~3× more expensive than `--mp-from` over the same files.
4. **Prune actively, not eventually.** Run `--mp-prune-expired` at session start and `--mp-prune-tag scan` (or `--mp-prune-keep 30`) between major phases. Always `--mp-prune-dry-run` first.
5. **One palace per task.** Pass `--mp-path` or set `MPG_MIND_PALACE` per task to keep contexts isolated. Cross-task palaces bleed and waste tokens.
6. **Page large results.** Pass `page: 1, page_size: 5` for searches with >10 expected hits; check `pagination.has_next`.
7. **Read `errors[]` even when `status === "ok"`.** A `"partial"` status means some sources errored — the result is real but incomplete. Decide if the missing sources mattered before concluding.

## Pagination pattern

```
Start:  mpg_search(pattern, page: 1, page_size: 5)
Check:  result.pagination.has_next
If yes: mpg_search(pattern, page: 2, page_size: 5)
Stop when has_next is false or you have enough context.
```

Same pattern for `mpg_list_stashes` and `mpg_get_stash`.

## Error recovery

| Condition | What to do |
| :--- | :--- |
| `status: "no_matches"` | Broaden pattern, drop `-w`, add `-I` (case-insensitive). |
| `status: "truncated"` | Hit `--max-tokens`. Narrow pattern OR increase budget. If you stash truncated results, the stash inherits the same partial node set — the search-level truncation marker is the only signal, and the `mpg: created stash …` line does not restate it. When stashing for archival purposes, drop `--max-tokens` or raise it well above the expected hit count so the stash is complete. |
| `status: "partial"` | Some sources errored, others returned matches. Inspect `result.errors[]` — decide whether the missing sources mattered. Common cause: a single pathological file (minified asset) that you can `--exclude`. |
| `status: "error"` | All sources errored. Check `result.errors[]` and stderr. Common: unknown stash name (`mpg_list_stashes`), rg not installed, bad regex. |
| Unknown stash | Run `mpg_list_stashes` to discover. |
| `pagination.has_next` | More data exists. Decide if current page is enough. |
| `--mp-from` returns nothing | Stashed files may have moved or been deleted. Re-stash fresh. |
| `WARNING — mind palace is corrupt` on stderr | mpg copied the bad file aside as `<palace>.corrupt.<ts>` and is refusing to save. Inspect the backup, then either fix it by hand or set `MPG_FORCE_RESET=1` to start fresh. **Do not** plow on without reading the backup — you will lose every stash. |

## Long-context backoff workflow

This is the part that's underused. The mind palace is not just
storage; it's a **token budget** for the conversation. Treat it
like working memory with a budget, and prune actively.

The shape of a long-horizon task:

| Phase | What to do |
| :--- | :--- |
| **Open** | At session start, `mpg --mp-prune-expired` to clear stashes whose TTL passed. Optional `--mp-prune-older-than 24h` if the previous session left scratch. |
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
- One palace per major task (`MPG_MIND_PALACE=.mpg/<task-id>.json`).
  Don't mix unrelated tasks — context bleed wastes more tokens than
  isolated palaces save.

Token math you can quote at the LLM:

> Recomputing a scan is ~1200 rg tokens. Reading the same stash via
> `--mp-from` is ~377 tokens (3.2× cheaper). Pruning is free.

That ratio is why **prune + compose** beats **re-search** every time
at the synthesis step.

## What the bench data says (informs the patterns above)

Headline numbers from `BENCHMARKS.md` (oasis-sleek conductor tracks corpus — markdown specs + JSON metadata):

| comparison | mpg config | result |
| :--- | :--- | :--- |
| Literal recall vs **ripgrep** | `scan + clip_chars: 30` | 100% / 100% / **377 tokens** vs rg's 1197 — **3.2× cheaper than rg** |
| Typo recovery | `fuzzy: true` | 100% recall vs rg's 0%, 89% precision, ~1900 tokens. Embeddings get 45% at 23,610 tokens. |
| Compaction at fixed budget | `scan + clip + max_tokens` (no LLM) | 67% pass beats LLM summarization (33%) at zero LLM cost |
| Multi-turn convergence | treatment uses mpg + stash | 24% fewer input tokens, **half the tool calls and turns** vs control |
| Mind palace set semantics | `compose` / `intersect` / `except` / graph | 17/17 micro assertions pass |

Where mpg loses on the bench (worth knowing):
- **Single-keyword lookups** where you only need a file:line list (T2 BLAKE3, T3 load_to_bevy in macro): rg is cheaper. Use `bash`/`grep` for one-word answers.
- **Cold-start wall-clock**: ~200ms per CLI call. MCP server / programmatic import avoid this (the cost is paid once at boot).

## Read further (load on demand)

When you need depth on one of these areas, read the matching file:

- `references/integration.md` — MCP server vs CLI vs programmatic SDK import; when to prefer each.
- `references/mind-palace.md` — full mind palace surface: relationships, pruning, TTL, set ops (`compose`/`except`/`intersect`), graph traversal, multi-palace isolation.
- `references/sources.md` — search files, dirs, globs, command stdout (`--cmd`), URLs (`--url`), stdin (`--stdin`); `--include`/`--exclude`/`--type` filters.
- `references/multi-agent.md` — palace sharing across agents, write-write race caveats, recommended layouts.
- `references/anti-patterns.md` — full list of what NOT to do and why.
