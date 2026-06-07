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

## Quick start

```bash
npm install -g mdg-cli && mdg --version
```

If running through an MCP-capable host (Claude Desktop, Claude Code,
Cline, Windsurf, Continue.dev), the five tools below register
automatically once the `mdg` MCP server is configured.

## When to use

| Situation | Tool |
| :--- | :--- |
| "Where is X referenced?" | `mdg_search` |
| "Need context around a match" | `mdg_search` (`before`/`after`) |
| "Quick scan — is this term here at all?" | `mdg_search` (`effort: "quick"`) |
| "Deep context for a final answer" | `mdg_search` (`effort: "deep"`) |
| "I'll need these hits again later" | `mdg_stash` |
| "Search only files I previously stashed" | `mdg_search` (`from` or `compose`) |
| "What stashes do I have?" | `mdg_list_stashes` |
| "Forget this stash" | `mdg_drop_stash` |
| "Just read one file" | use the host's read tool — mdg is for *searching* |
| "Search a URL or command output" | `mdg_search` (`url` or `cmd`) — see `references/sources.md` |

## Effort presets

| effort | before | after | max_nodes | use case |
| :--- | ---: | ---: | ---: | :--- |
| **scan**  |  20  |  20 |    200 | **Index mode.** Many hits with tiny disambiguating windows. Recall ~= rg; tokens scale O(hits). Use first to find what's relevant, then pick which file/page to dig into. |
| **quick** | 200 | 200 |     10 | **DEFAULT.** Small windows, small cap. First touch of a topic. |
| normal | 500 | 500 |     30 | Bump to this when quick was ambiguous. |
| deep   | 2000 | 2000 |   100 | Final answer grounding — for one targeted query you commit to. |
| auto   |  500 |  500 |    30 | Reserved (future heuristic sizing). |

### Recommended pattern: scan first, dig deeper on demand

mdg is designed for "less is more on the first turn, with intelligent
follow-up." Use it that way:

1. **Start with `scan`** when you don't yet know what's relevant —
   200 node cap with no padding gives you the *list* of file:line
   hits across the whole search space at ~50 tokens per hit.
2. **Stash the scan result** (`mdg_stash`) so subsequent searches
   can scope to those files (`from: <stash-name>`).
3. **Run small targeted `quick` or `normal` queries in parallel** on
   the specific files you care about, instead of one huge `deep`
   query across everything.

This trades token cost for round-trip — perfect for tool-loop agents
that can run multiple tool calls per turn. It's much cheaper than
"`deep` first, hope you got everything."

## The five MCP tools (signatures only)

| Tool | Required params | Optional |
| :--- | :--- | :--- |
| `mdg_search` | `pattern` | `in[]`, `cmd`, `url`, `before`, `after`, `max_nodes`, `max_tokens`, `effort`, `strategy`, `from`, `compose[]`, `page`, `page_size`, `all` |
| `mdg_stash` | `name` | `note`, `tags[]`, `replace` |
| `mdg_list_stashes` | — | `tag_filter[]`, `page`, `page_size` |
| `mdg_get_stash` | `name` | `page`, `page_size` |
| `mdg_drop_stash` | `name` | — |

The mind palace has a *wider* surface than the five MCP tools above
(relationships, pruning, TTL, intersect/except, isolated palaces).
Those are CLI-only today — see `references/mind-palace.md`.

## Golden rules

1. **Stash by default.** Even if you think you won't reuse it. Stashes are cheap.
2. **Tag every stash.** `auth`, `p0`, `temp`, `perf`, `review` — pays off at >10 stashes.
3. **Compose before concluding.** Set-union across two stashes catches cross-cutting evidence one search would miss.
4. **One palace per task.** Pass `--mp-path` or set `MDG_MIND_PALACE` per task to keep contexts isolated.
5. **Always dry-run prunes.** `--mp-prune-dry-run` first, commit second.
6. **Page large results.** Pass `page: 1, page_size: 5` for searches with >10 expected hits; check `pagination.has_next`.

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
| `status: "error"` | Check stderr. Common: unknown stash name (`mdg_list_stashes`), rg not installed, bad regex. |
| Unknown stash | Run `mdg_list_stashes` to discover. |
| `pagination.has_next` | More data exists. Decide if current page is enough. |
| `--mp-from` returns nothing | Stashed files may have moved or been deleted. Re-stash fresh. |

## Read further (load on demand)

When you need depth on one of these areas, read the matching file:

- `references/integration.md` — MCP server vs CLI vs programmatic SDK import; when to prefer each.
- `references/mind-palace.md` — full mind palace surface: relationships, pruning, TTL, set ops (`compose`/`except`/`intersect`), graph traversal, multi-palace isolation.
- `references/sources.md` — search files, dirs, globs, command stdout (`--cmd`), URLs (`--url`), stdin (`--stdin`); `--include`/`--exclude`/`--type` filters.
- `references/multi-agent.md` — palace sharing across agents, write-write race caveats, recommended layouts.
- `references/anti-patterns.md` — full list of what NOT to do and why.
